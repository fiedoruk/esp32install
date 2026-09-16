#!/usr/bin/env python3
"""Write an esp32install manifest (schema 2) from firmware binaries.

The installer page fetches the manifest, then every part it names, and refuses to
flash anything whose size or SHA-256 does not match what the manifest declares.
This generator is what produces those numbers, so it reads the binaries itself and
never takes a size or a checksum on trust.

    python3 tools/manifest.py firmware/demo.bin@0x1000 \
        --chip ESP32 --name "Demo firmware" --version 1.0.0 \
        --out firmware/demo-1-0-0.json

A binary without `@offset` is written at offset 0. Paths in the manifest are
resolved by the browser against the manifest URL, so by default each part is
recorded as the path from the manifest's directory to the binary; `--path-prefix`
overrides that for sites that serve binaries from somewhere else.

Each path also carries the checksum as a query, `firmware.bin?sha256=04db4a…`.
A static host serves the file and ignores the query; the browser does not, and
that is the point: the address changes with the bytes, so nobody who visited
before the release can be handed yesterday's binary out of a cache. It is the
only cache-busting move available to a publisher with no server configuration to
change, which is most of them. `--no-checksum-in-path` leaves it off.

Exit codes: 0 written, 1 the binaries did not validate, 2 the command was wrong.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2

ESP_IMAGE_MAGIC = 0xE9
ESP_IMAGE_HEADER_BYTES = 24
# How much of each part both tools keep in order to find an image header. A merged image is one
# part at offset 0 whose header sits at the chip's bootloader offset, so this has to clear the
# deepest offset in CHIPS plus a header; a test asserts that it does.
HEAD_SAMPLE = 64 * 1024
HEX64 = re.compile(r'[0-9a-fA-F]{64}')
BOARD_KEY = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}')
MAX_FLASH_MB = 1024
READ_CHUNK = 1 << 20
# One flash sector, the unit the chip erases in. Mirrors SECTOR in app/manifest.js.
SECTOR = 0x1000
# What esptool-js 0.6.1 accepts for the two image parameters, and what the page validates.
# Mirrors FLASH_MODES / FLASH_FREQS in app/manifest.js.
FLASH_MODES = ('keep', 'qio', 'qout', 'dio', 'dout')
FLASH_FREQS = ('keep', '80m', '40m', '26m', '20m')
BAUD_MIN = 9600
BAUD_MAX = 2000000


@dataclass(frozen=True)
class Chip:
    """One row of the chip table."""

    bootloader_offset: Optional[int]
    image_chip_id: Optional[int]
    esptool_chip: str


# Mirrors app/verify.js CHIPS, measured from esptool-js 0.6.1. None = the library does
# not declare it (ESP32-C61 has no bootloader offset there, ESP8266 images have no chip id).
CHIPS: Dict[str, Chip] = {
    'ESP8266': Chip(0x0, None, 'esp8266'),
    'ESP32': Chip(0x1000, 0, 'esp32'),
    'ESP32-S2': Chip(0x1000, 2, 'esp32s2'),
    'ESP32-S3': Chip(0x0, 9, 'esp32s3'),
    'ESP32-C2': Chip(0x0, 12, 'esp32c2'),
    'ESP32-C3': Chip(0x0, 5, 'esp32c3'),
    'ESP32-C5': Chip(0x2000, 23, 'esp32c5'),
    'ESP32-C6': Chip(0x0, 13, 'esp32c6'),
    'ESP32-C61': Chip(None, 20, 'esp32c61'),
    'ESP32-H2': Chip(0x0, 16, 'esp32h2'),
    'ESP32-P4': Chip(0x2000, 18, 'esp32p4'),
}
CHIP_FAMILIES: Tuple[str, ...] = tuple(CHIPS)
# esptool spells the same families in lower case without the dash (`esp32s3`), and that is what a
# publisher has in front of them when they come here from a build log. Both spellings are accepted
# and the canonical one is written into the manifest.
CHIP_ALIASES: Dict[str, str] = {name.lower().replace('-', ''): name for name in CHIPS}
PROFILES = ('factory', 'preserve')


class ManifestError(Exception):
    """The binaries do not validate. Exit 1."""


class UsageError(Exception):
    """The command line does not make sense. Exit 2."""


# --------------------------------------------------------------------------- #
# Shared with tools/check.py: the ESP image header and flash layout rules.
# --------------------------------------------------------------------------- #

def family_for_image_chip_id(chip_id: int) -> str:
    """The family name esptool-js would report for this image chip id."""
    for name, chip in CHIPS.items():
        if chip.image_chip_id == chip_id:
            return name
    return 'chip id %d' % chip_id


def boot_image_problem(chip_family: str, head: bytes, rel: int) -> Optional[str]:
    """Why `head` is not a bootloader image for `chip_family`, or None if it is.

    `head` is the start of the part that covers the chip's bootloader offset and
    `rel` is how far into it that offset falls. Mirrors checkBootImage in app/verify.js.
    """
    chip = CHIPS[chip_family]
    if len(head) < rel + ESP_IMAGE_HEADER_BYTES:
        return 'too short to hold an image header'
    if head[rel] != ESP_IMAGE_MAGIC:
        return 'no 0x%02X image magic at the bootloader offset (found 0x%02X)' % (ESP_IMAGE_MAGIC, head[rel])
    if chip.image_chip_id is None:
        return None
    found = head[rel + 12] | (head[rel + 13] << 8)
    if found != chip.image_chip_id:
        return 'image is built for %s, not %s' % (family_for_image_chip_id(found), chip_family)
    return None


def image_part_problem(chip_family: str, head: bytes, size: int) -> Optional[str]:
    """Why a part that starts like an ESP image is not one for `chip_family`, or None.

    Mirrors checkImageParts in app/verify.js: a part at least a header long whose first byte
    is the image magic must carry this family's image chip id, wherever it is written. A part
    that does not look like an image is not judged. Families without an image chip id are skipped.
    """
    chip = CHIPS[chip_family]
    if chip.image_chip_id is None or size < ESP_IMAGE_HEADER_BYTES or len(head) < ESP_IMAGE_HEADER_BYTES:
        return None
    if head[0] != ESP_IMAGE_MAGIC:
        return None
    found = head[12] | (head[13] << 8)
    if found != chip.image_chip_id:
        return 'image is built for %s, not %s' % (family_for_image_chip_id(found), chip_family)
    return None


def covering(spans: Sequence[Tuple[int, int]], at: int) -> Optional[int]:
    """Index of the (offset, size) span that contains flash address `at`."""
    for index, (offset, size) in enumerate(spans):
        if offset <= at < offset + size:
            return index
    return None


def overlaps(spans: Sequence[Tuple[int, int]]) -> Optional[Tuple[int, int]]:
    """The first pair of (offset, size) spans that collide, as a pair of offsets."""
    ordered = sorted(spans)
    for previous, current in zip(ordered, ordered[1:]):
        if previous[0] + previous[1] > current[0]:
            return previous[0], current[0]
    return None


def erase_footprint(offset: int, size: int) -> Tuple[int, int]:
    """The half-open range of flash a write of `size` bytes at `offset` blanks.

    The chip erases whole sectors, so the write costs the sector holding its first byte and the
    sector holding its last one, whole: `offset` rounded down and `offset + size` rounded up.
    """
    return offset // SECTOR * SECTOR, -(-(offset + size) // SECTOR) * SECTOR


def _touches(a_from: int, a_to: int, b_from: int, b_to: int) -> bool:
    """Whether two half-open ranges share a byte. An empty range shares none."""
    return a_from < a_to and b_from < b_to and a_from < b_to and b_from < a_to


def erase_spill(offset: int, size: int, others: Sequence[Tuple[int, int]],
                declared: Sequence[Tuple[int, int]], flash_bytes: Optional[int]) -> Optional[str]:
    """What this part's erase footprint reaches that has to survive, named, or None if nothing.

    A part is written into whole sectors, so up to SECTOR-1 bytes in front of it and up to
    SECTOR-1 bytes after it are blanked without being written. Blanking bytes nothing declares is
    the normal case and is fine: an ESP-IDF application is hardly ever a whole number of sectors,
    and its tail lands inside its own partition. The hazard is a blanked tail that reaches
    something that has to survive -- another part, a compatibility region, or the end of the chip
    -- because outside the header span the read-back never looks and nothing would notice.

    One span those blanked bytes may fall in: a declared span that lies wholly inside this part's
    own sectors *and* that the part writes into. That is a span the release replaces whole, on
    purpose -- the partition-table page is exactly that, declared in `firstInstall.regions` and
    rewritten by the table part -- and `preserve` writes and re-checks such a page whole. No
    offset is special-cased.
    """
    start, end = erase_footprint(offset, size)
    if flash_bytes is not None and end > flash_bytes:
        return 'past the end of the %d-byte flash' % flash_bytes
    for other_offset, other_size in others:
        if _touches(start, end, other_offset, other_offset + other_size):
            return 'the part written at 0x%x' % other_offset
    # The bytes this part blanks without writing them: its first sector before it, its last after.
    blanked = [(start, offset), (offset + size, end)]
    for region_offset, region_size in declared:
        region_end = region_offset + region_size
        if not any(_touches(a, b, region_offset, region_end) for a, b in blanked):
            continue
        if (region_offset >= start and region_end <= end
                and _touches(offset, offset + size, region_offset, region_end)):
            continue  # the release replaces this span whole, on purpose
        return 'the declared region at 0x%x (%d bytes)' % (region_offset, region_size)
    return None


def md5_file(path: Path) -> str:
    """MD5 of a file, read in chunks.

    Not a security claim — SHA-256 is what holds the download to the release. This is the one
    checksum the chip itself can compute: the flash's MD5 command reads it back after the write,
    so a release that declares it gets a second, independent witness that what ended up on the
    device is what was published, next to esptool-js's own comparison against the bytes the page
    sent over the cable.
    """
    digest = hashlib.md5()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(READ_CHUNK), b''):
            digest.update(block)
    return digest.hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(READ_CHUNK), b''):
            digest.update(block)
    return digest.hexdigest()


# --------------------------------------------------------------------------- #
# Inputs
# --------------------------------------------------------------------------- #

def parse_int(text: str) -> int:
    """Decimal or 0x-prefixed hexadecimal, with optional sign and underscores."""
    token = text.strip().replace('_', '')
    sign = -1 if token.startswith('-') else 1
    token = token.lstrip('+-')
    if not token:
        raise ValueError('empty number')
    value = int(token[2:], 16) if token[:2].lower() == '0x' else int(token, 10)
    return sign * value


@dataclass
class Part:
    """One binary and the flash offset it is written to."""

    file: Path
    offset: int = 0

    def __post_init__(self) -> None:
        self.file = Path(self.file)
        if not isinstance(self.offset, int) or isinstance(self.offset, bool):
            raise UsageError('offset must be a whole number, got %r' % (self.offset,))


@dataclass
class Region:
    """A flash region the preserve profile compares before it writes anything."""

    offset: int
    size: int
    sha256: Optional[str] = None

    def to_json(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {'offset': self.offset, 'size': self.size}
        if self.sha256:
            out['sha256'] = self.sha256
        return out


@dataclass
class Options:
    """Everything about the manifest that does not come out of the binaries."""

    chip: str
    name: str
    version: str
    board: Optional[str] = None
    board_key: Optional[str] = None
    flash_mb: Optional[int] = None
    usb_vendor_id: Optional[int] = None
    usb_product_id: Optional[int] = None
    profile: str = 'factory'
    flash_mode: str = 'keep'
    flash_freq: str = 'keep'
    baud_rate: Optional[int] = None
    prompt_erase: bool = False
    improv: bool = False
    path_prefix: Optional[str] = None
    checksum_in_path: bool = True
    md5: bool = True
    compat_regions: List[Region] = field(default_factory=list)
    first_regions: List[Region] = field(default_factory=list)
    first_empty: List[Region] = field(default_factory=list)
    update_table: Optional[int] = None
    out: Optional[Path] = None

    def __post_init__(self) -> None:
        if self.out is not None:
            self.out = Path(self.out)


def as_options(opts: Any) -> Options:
    if isinstance(opts, Options):
        return opts
    if isinstance(opts, dict):
        return Options(**opts)
    raise UsageError('options must be an Options or a dict')


# --------------------------------------------------------------------------- #
# Building
# --------------------------------------------------------------------------- #

MAX_CLIMB = 2


def part_path(file: Path, out: Optional[Path], prefix: Optional[str]) -> str:
    """How the manifest names this binary, as the browser will resolve it.

    A path worked out from where the binary happens to sit on this machine only holds up while
    the site mirrors that layout. Past a couple of levels up it almost never does, so rather than
    write a path that will 404 on the server we stop and ask for --path-prefix.
    """
    if prefix is not None:
        cleaned = prefix.replace('\\', '/')
        if cleaned and not cleaned.endswith('/'):
            cleaned += '/'
        return cleaned + file.name
    base = out.parent if out is not None else Path('.')
    try:
        relative = Path(os.path.relpath(file.parent.resolve(), base.resolve())).as_posix()
    except ValueError as exc:  # different drives on Windows: no relative path exists
        raise UsageError('%s is not on the same volume as the manifest (%s); '
                         'pass --path-prefix to say how the site serves it' % (file.name, exc))
    if Path(relative).is_absolute() or relative.startswith('//'):
        raise UsageError('%s cannot be named relative to the manifest; '
                         'pass --path-prefix to say how the site serves it' % file.name)
    climb = 0
    for segment in relative.split('/'):
        if segment != '..':
            break
        climb += 1
    if climb > MAX_CLIMB:
        raise UsageError('%s sits %d directories above the manifest (%s); a site rarely mirrors '
                         'that, so pass --path-prefix to say how it serves the file'
                         % (file.name, climb, relative))
    return file.name if relative == '.' else '%s/%s' % (relative, file.name)


def part_reference(path: str, digest: str, include: bool) -> str:
    """The path as the manifest records it: the file name, and the checksum as a query.

    The query is what makes a release reach somebody who visited before it. Nothing serves it and
    nothing reads it — a static host answers with the file, and the page strips it back off before
    it shows or logs a name — but the browser's cache is keyed on the whole address, so a new
    binary is a new address and yesterday's copy cannot be handed back. That is a fix a publisher
    can make with no access to the server's configuration, which is what GitHub Pages and most
    shared hosting amount to.
    """
    if not include:
        return path
    if '?' in path or '#' in path:
        raise UsageError('%s already carries a query or a fragment, so the checksum cannot be '
                         'added to it; pass --no-checksum-in-path' % path)
    return '%s?sha256=%s' % (path, digest)


def validate_options(opts: Options) -> None:
    if opts.chip not in CHIPS:
        raise UsageError('unknown chip family %r; known: %s' % (opts.chip, ', '.join(CHIP_FAMILIES)))
    if opts.profile not in PROFILES:
        raise UsageError('profile must be one of %s' % ', '.join(PROFILES))
    if not str(opts.name).strip():
        raise UsageError('--name must not be empty')
    if not str(opts.version).strip():
        raise UsageError('--version must not be empty')
    if opts.board_key is not None and not BOARD_KEY.fullmatch(opts.board_key):
        raise UsageError('--board-key %r must be letters, digits, dot, dash or underscore' % opts.board_key)
    if opts.flash_mb is not None and not 1 <= opts.flash_mb <= MAX_FLASH_MB:
        raise UsageError('--flash-mb must be between 1 and %d' % MAX_FLASH_MB)
    for label, value in (('vendor', opts.usb_vendor_id), ('product', opts.usb_product_id)):
        if value is not None and not 0 <= value <= 0xFFFF:
            raise UsageError('USB %s id must be between 0x0000 and 0xffff' % label)
    if (opts.usb_vendor_id is None) != (opts.usb_product_id is None):
        raise UsageError('--usb needs both ids, as VENDOR:PRODUCT')
    for region in list(opts.compat_regions) + list(opts.first_regions) + list(opts.first_empty):
        if region.offset < 0 or region.size <= 0:
            raise UsageError('a region needs offset >= 0 and size > 0')
        if region.sha256 is not None and not HEX64.fullmatch(region.sha256):
            raise UsageError('a region checksum must be 64 hexadecimal characters')
    if opts.update_table is not None and opts.update_table < 0:
        raise UsageError('--update-table must not be negative')
    if opts.profile == 'preserve':
        if not (opts.compat_regions or opts.first_regions):
            raise UsageError('the preserve profile needs at least one --compat-region or --first-region: '
                             'without one the page cannot tell whether the flash it is about to keep is ours')
        for region in list(opts.compat_regions) + list(opts.first_regions):
            if region.sha256 is None:
                raise UsageError('the preserve profile needs a checksum on every region (OFFSET:SIZE:SHA256): '
                                 'a region without one is a claim the page cannot check, so it refuses the manifest')
        if opts.update_table is None:
            raise UsageError('the preserve profile needs --update-table OFFSET, the partition table offset, '
                             'and a part written at exactly that offset')


def validate_flash_params(opts: Options) -> None:
    """How the chip is to read the image back, and how fast the cable runs.

    These are properties of the binary and of the board, not of the page that writes them, which
    is why they live in the manifest at all. `keep` means the image's own header is left alone,
    and that is what every release got before these existed. The preserve profile refuses them:
    it never writes at the bootloader offset, which is the only place esptool-js applies them, so
    naming one there would be a claim nothing carries out.
    """
    if opts.flash_mode not in FLASH_MODES:
        raise UsageError('--flash-mode must be one of %s' % ', '.join(FLASH_MODES))
    if opts.flash_freq not in FLASH_FREQS:
        raise UsageError('--flash-freq must be one of %s' % ', '.join(FLASH_FREQS))
    if opts.profile == 'preserve' and (opts.flash_mode != 'keep' or opts.flash_freq != 'keep'):
        raise UsageError('the preserve profile keeps the device\'s own bootloader and never writes at '
                         'the bootloader offset, which is the only image these settings reach; leave '
                         '--flash-mode and --flash-freq alone for it')
    if opts.baud_rate is not None and not (BAUD_MIN <= opts.baud_rate <= BAUD_MAX):
        raise UsageError('--baud-rate must be between %d and %d' % (BAUD_MIN, BAUD_MAX))


def measure(parts: Sequence[Part]) -> List[Dict[str, Any]]:
    """Read every binary once: size, checksum and enough head bytes for the image header."""
    measured: List[Dict[str, Any]] = []
    for part in parts:
        if part.offset < 0:
            raise ManifestError('offset of %s is negative (0x%x)' % (part.file.name, part.offset))
        if not part.file.is_file():
            raise ManifestError('no such file: %s' % part.file)
        size = part.file.stat().st_size
        if size == 0:
            raise ManifestError('file is empty: %s' % part.file)
        with part.file.open('rb') as handle:
            head = handle.read(HEAD_SAMPLE)
        measured.append({
            'file': part.file,
            'offset': part.offset,
            'size': size,
            'sha256': sha256_file(part.file),
            'md5': md5_file(part.file),
            'head': head,
        })
    return measured


def compatibility_json(opts: Options) -> Optional[Dict[str, Any]]:
    first: Dict[str, Any] = {}
    if opts.first_regions:
        first['regions'] = [r.to_json() for r in opts.first_regions]
    if opts.first_empty:
        first['empty'] = [{'offset': r.offset, 'size': r.size} for r in opts.first_empty]
    compat: Dict[str, Any] = {}
    if opts.compat_regions:
        compat['regions'] = [r.to_json() for r in opts.compat_regions]
    if first:
        compat['firstInstall'] = first
    if opts.update_table is not None:
        compat['update'] = {'tableOffset': opts.update_table}
    return compat or None


def build_manifest(parts: Sequence[Part], opts: Any) -> Dict[str, Any]:
    """The manifest as a dictionary, with every size and checksum read from disk.

    Raises UsageError for a nonsensical request and ManifestError when the binaries
    themselves do not hold up.
    """
    options = as_options(opts)
    validate_flash_params(options)
    validate_options(options)
    if not parts:
        raise UsageError('give at least one binary')
    measured = measure(parts)

    collision = overlaps([(m['offset'], m['size']) for m in measured])
    if collision is not None:
        raise ManifestError('parts overlap in flash: 0x%x and 0x%x' % collision)

    chip = CHIPS[options.chip]
    if options.profile == 'factory' and chip.bootloader_offset is not None:
        index = covering([(m['offset'], m['size']) for m in measured], chip.bootloader_offset)
        if index is not None:
            hit = measured[index]
            problem = boot_image_problem(options.chip, hit['head'], chip.bootloader_offset - hit['offset'])
            if problem is not None:
                raise ManifestError('%s at 0x%x: %s' % (hit['file'].name, hit['offset'], problem))
    # Every part that starts like an image has to be for this chip, in both profiles: a preserve
    # release writes an application that never covers the bootloader offset.
    for m in measured:
        problem = image_part_problem(options.chip, m['head'], m['size'])
        if problem is not None:
            raise ManifestError('%s at 0x%x: %s' % (m['file'].name, m['offset'], problem))
    if options.profile == 'preserve':
        # The chip erases whole sectors. A part that starts mid-sector blanks up to SECTOR-1 bytes
        # of the user data this profile exists to keep, so the manifest is never written at all.
        crooked = [m for m in measured if m['offset'] % SECTOR]
        if crooked:
            raise UsageError('the preserve profile needs every part on a %d-byte boundary, and %s '
                             'is at 0x%x: the chip erases whole sectors, so writing there would '
                             'also blank the %d bytes in front of it'
                             % (SECTOR, crooked[0]['file'].name, crooked[0]['offset'],
                                crooked[0]['offset'] % SECTOR))
        # And the other end of it. The sector holding a part's last byte is erased whole too, so a
        # ragged length blanks up to SECTOR-1 bytes of whatever sat after the part. That is normal
        # and harmless while those bytes are nobody's -- an ESP-IDF application is hardly ever a
        # whole number of sectors, and its tail stays inside its own partition. It is refused only
        # when the erased footprint reaches something declared, which the read-back would not
        # notice outside the header span.
        declared = [(r.offset, r.size) for r in
                    list(options.compat_regions) + list(options.first_regions) + list(options.first_empty)]
        flash_bytes = None if options.flash_mb is None else options.flash_mb * 1024 * 1024
        for index, m in enumerate(measured):
            others = [(o['offset'], o['size']) for j, o in enumerate(measured) if j != index]
            reaches = erase_spill(m['offset'], m['size'], others, declared, flash_bytes)
            if reaches is not None:
                start, end = erase_footprint(m['offset'], m['size'])
                raise UsageError('the preserve profile refuses %s: %d bytes at 0x%x makes the chip erase '
                                 '0x%x-0x%x, and that reaches %s. The profile may blank only bytes '
                                 'nothing declares, so move the part or correct the region'
                                 % (m['file'].name, m['size'], m['offset'], start, end, reaches))
    if options.profile == 'preserve' and all(m['offset'] != options.update_table for m in measured):
        raise UsageError('--update-table 0x%x names an offset no part is written at; the preserve '
                         'profile needs the partition table among the parts' % options.update_table)
    if options.profile == 'preserve' and measured[-1]['offset'] != options.update_table:
        # Nothing is reordered: manifest order is write order, and the caller has to mean it.
        raise UsageError('the partition table (--update-table 0x%x) must be the last binary on the command '
                         'line: parts are written in the order given, and the table has to go on the chip '
                         'after the application, so list the application first and the table last'
                         % options.update_table)

    build: Dict[str, Any] = {}
    if options.board_key:
        build['boardKey'] = options.board_key
    if options.board:
        build['board'] = options.board
    build['chipFamily'] = options.chip
    if options.flash_mb is not None:
        build['flashSizeMB'] = options.flash_mb
    if options.usb_vendor_id is not None:
        build['usbVendorId'] = options.usb_vendor_id
        build['usbProductId'] = options.usb_product_id
    if options.flash_mode != 'keep':
        build['flashMode'] = options.flash_mode
    if options.flash_freq != 'keep':
        build['flashFreq'] = options.flash_freq
    if options.improv:
        build['improv'] = True
    compat = compatibility_json(options)
    if compat is not None:
        build['compatibility'] = compat
    build['parts'] = [{
        'path': part_reference(part_path(m['file'], options.out, options.path_prefix),
                               m['sha256'], options.checksum_in_path),
        'offset': m['offset'],
        'size': m['size'],
        'sha256': m['sha256'],
        **({'md5': m['md5']} if options.md5 else {}),
    } for m in measured]

    data: Dict[str, Any] = {
        'schema': 2,
        'name': options.name,
        'version': options.version,
        'profile': options.profile,
        'new_install_prompt_erase': bool(options.prompt_erase),
    }
    if options.baud_rate is not None:
        data['baudRate'] = options.baud_rate
    data['builds'] = [build]
    return data


def write_manifest(data: Dict[str, Any], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('w', encoding='utf-8', newline='\n') as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False)
        handle.write('\n')


# --------------------------------------------------------------------------- #
# Command line
# --------------------------------------------------------------------------- #

def part_argument(text: str) -> Part:
    """`file` or `file@0x1000`. A trailing @ that is not a number stays part of the name."""
    path, at, tail = text.rpartition('@')
    if at and path:
        try:
            return Part(Path(path), parse_int(tail))
        except ValueError:
            pass
    return Part(Path(text), 0)


def region_argument(text: str, with_checksum: bool = True) -> Region:
    """OFFSET:SIZE:SHA256 for a compared region; OFFSET:SIZE for a range that must be blank.

    The checksum is not optional: a region without one is a claim the page cannot check and the
    manifest layer refuses it, so the generator refuses it here rather than writing a dead manifest.
    """
    fields = text.split(':')
    wanted = '3 fields (OFFSET:SIZE:SHA256)' if with_checksum else '2 fields (OFFSET:SIZE)'
    if len(fields) != (3 if with_checksum else 2):
        raise argparse.ArgumentTypeError('%r needs %s' % (text, wanted))
    try:
        offset, size = parse_int(fields[0]), parse_int(fields[1])
    except ValueError as exc:
        raise argparse.ArgumentTypeError('%r: %s' % (text, exc))
    if offset < 0 or size <= 0:
        raise argparse.ArgumentTypeError('%r needs offset >= 0 and size > 0' % text)
    digest = fields[2].lower() if len(fields) == 3 else None
    if digest is not None and not HEX64.fullmatch(digest):
        raise argparse.ArgumentTypeError('%r: the checksum must be 64 hexadecimal characters' % text)
    return Region(offset, size, digest)


def empty_region_argument(text: str) -> Region:
    return region_argument(text, with_checksum=False)


def usb_argument(text: str) -> Tuple[int, int]:
    fields = text.split(':')
    if len(fields) != 2:
        raise argparse.ArgumentTypeError('%r must look like VENDOR:PRODUCT, for example 1a86:55d4' % text)
    try:
        ids = tuple(int(f, 16) for f in fields)
    except ValueError:
        raise argparse.ArgumentTypeError('%r: both ids are hexadecimal' % text)
    if not all(0 <= i <= 0xFFFF for i in ids):
        raise argparse.ArgumentTypeError('%r: both ids are between 0000 and ffff' % text)
    return ids[0], ids[1]


def number_argument(text: str) -> int:
    try:
        return parse_int(text)
    except ValueError as exc:
        raise argparse.ArgumentTypeError('%r: %s' % (text, exc))


def chip_argument(text: str) -> str:
    """`ESP32-S3` or `esp32s3`, either case, with or without the dash."""
    name = CHIP_ALIASES.get(str(text).strip().lower().replace('-', '').replace('_', ''))
    if name is None:
        raise argparse.ArgumentTypeError(
            '%r is not a chip family this installer knows; known: %s' % (text, ', '.join(CHIP_FAMILIES)))
    return name


def board_key_argument(text: str) -> str:
    if not BOARD_KEY.fullmatch(text):
        raise argparse.ArgumentTypeError(
            '%r must start with a letter or digit and hold only letters, digits,'
            ' dot, dash or underscore' % text)
    return text


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='manifest.py',
        description='Write an esp32install manifest (schema 2) from firmware binaries.',
        epilog='Example: manifest.py boot.bin@0x1000 app.bin@0x10000 --chip ESP32 '
               '--name "Demo" --version 1.0.0 --out firmware/demo-1-0-0.json')
    parser.add_argument('parts', nargs='+', type=part_argument, metavar='BIN[@OFFSET]',
                        help='binary to flash; without @OFFSET it is written at offset 0')
    parser.add_argument('--chip', required=True, type=chip_argument, metavar='FAMILY',
                        help='chip family the build is for, as ESP32-S3 or as esptool spells it, esp32s3')
    parser.add_argument('--name', required=True, help='firmware name shown on the page')
    parser.add_argument('--version', required=True, help='firmware version shown on the page')
    parser.add_argument('--out', required=True, type=Path, help='manifest file to write')
    parser.add_argument('--board', help='board name shown on the page, for example "M5Stack Core2"')
    parser.add_argument('--board-key', type=board_key_argument, help='stable key for this board')
    parser.add_argument('--flash-mb', type=int, metavar='MB', help='flash size the build expects')
    parser.add_argument('--usb', type=usb_argument, metavar='VENDOR:PRODUCT',
                        help='USB ids of the board, hexadecimal, for example 1a86:55d4')
    parser.add_argument('--profile', choices=PROFILES, default='factory',
                        help='factory writes the whole layout, preserve keeps user data (default: factory)')
    parser.add_argument('--flash-mode', choices=FLASH_MODES, default='keep',
                        help='how the chip reads the image back; keep leaves the image alone (default: keep)')
    parser.add_argument('--flash-freq', choices=FLASH_FREQS, default='keep',
                        help='the memory clock the image asks for; keep leaves the image alone (default: keep)')
    parser.add_argument('--baud-rate', type=number_argument, metavar='RATE',
                        help='the speed the page opens the port at, for the whole release '
                             '(default: the page\'s own 460800)')
    parser.add_argument('--prompt-erase', action='store_true',
                        help='offer a full erase before a first install')
    parser.add_argument('--improv', action='store_true',
                        help='the firmware takes Wi-Fi credentials over Improv Serial after the install')
    parser.add_argument('--path-prefix', metavar='PREFIX',
                        help='put this in front of each file name instead of the path from the manifest')
    parser.add_argument('--no-md5', dest='md5', action='store_false',
                        help='do not write the MD5 of each part; the page then has nothing to hold '
                             'the chip\'s own MD5 to after the write except the bytes it sent itself')
    parser.add_argument('--no-checksum-in-path', dest='checksum_in_path', action='store_false',
                        help='do not append ?sha256=... to each path; the address then stops changing '
                             'with the bytes, and a visitor who came before the release can be served '
                             'the old binary out of their browser cache')
    parser.add_argument('--compat-region', dest='compat_regions', action='append', default=[],
                        type=region_argument, metavar='OFFSET:SIZE:SHA256',
                        help='flash region that must match before a preserve install (repeatable)')
    parser.add_argument('--first-region', dest='first_regions', action='append', default=[],
                        type=region_argument, metavar='OFFSET:SIZE:SHA256',
                        help='region that identifies a first install (repeatable)')
    parser.add_argument('--first-empty', dest='first_empty', action='append', default=[],
                        type=empty_region_argument, metavar='OFFSET:SIZE',
                        help='region that must be blank on a first install (repeatable)')
    parser.add_argument('--update-table', type=number_argument, metavar='OFFSET',
                        help='partition table offset; required by the preserve profile, and one part '
                             'must be written exactly there')
    return parser


def options_from_args(args: argparse.Namespace) -> Options:
    vendor, product = args.usb if args.usb else (None, None)
    return Options(
        chip=args.chip, name=args.name, version=args.version, board=args.board, board_key=args.board_key,
        flash_mb=args.flash_mb, usb_vendor_id=vendor, usb_product_id=product, profile=args.profile,
        flash_mode=args.flash_mode, flash_freq=args.flash_freq, baud_rate=args.baud_rate,
        prompt_erase=args.prompt_erase, improv=args.improv, path_prefix=args.path_prefix,
        checksum_in_path=args.checksum_in_path, md5=args.md5, compat_regions=args.compat_regions,
        first_regions=args.first_regions, first_empty=args.first_empty, update_table=args.update_table,
        out=args.out)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = make_parser()
    args = parser.parse_args(argv)
    try:
        data = build_manifest(args.parts, options_from_args(args))
    except UsageError as exc:
        print('manifest.py: %s' % exc, file=sys.stderr)
        return EXIT_USAGE
    except ManifestError as exc:
        print('manifest.py: %s' % exc, file=sys.stderr)
        return EXIT_FAIL
    write_manifest(data, args.out)
    parts = data['builds'][0]['parts']
    print('wrote %s: %s %s, %d part%s, %d bytes' % (
        args.out, data['name'], data['version'], len(parts), '' if len(parts) == 1 else 's',
        sum(p['size'] for p in parts)))
    return EXIT_OK


if __name__ == '__main__':
    sys.exit(main())
