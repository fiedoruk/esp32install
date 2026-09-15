#!/usr/bin/env python3
"""Ask a site whether everything the installer page will fetch is really there.

Point it at a live installation or at a directory before you upload one:

    python3 tools/check.py https://example.com/install/
    python3 tools/check.py .

It reads catalog.json, then every manifest it names, then every part every manifest
names, and reports one line per check. A part is fetched in full, not merely probed,
because the point is to compare the bytes the browser would get against the size and
the SHA-256 the manifest promises. It also looks at the two things that make the page
safe to serve at all: the Content-Security-Policy in index.html and the checksum of
the vendored esptool-js bundle.

Exit codes: 0 nothing failed, 1 at least one FAIL, 2 the command was wrong.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

if __package__:
    from .manifest import CHIPS, boot_image_problem, covering, overlaps
else:  # run as a script: tools/ is already on sys.path
    from manifest import CHIPS, boot_image_problem, covering, overlaps

OK = 'OK'
WARN = 'WARN'
FAIL = 'FAIL'
EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2

USER_AGENT = 'esp32install-check/1.0'
TIMEOUT = 30
HEX64 = re.compile(r'^[0-9a-f]{64}$')
BOARD_KEY = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$')
META_TAG = re.compile(r'<meta\b[^>]*>', re.IGNORECASE)
META_ATTR = re.compile(r'([A-Za-z-]+)\s*=\s*("[^"]*"|\'[^\']*\'|[^\s">]+)')
VERSION = re.compile(r'^[vV]?(\d+(?:\.\d+)*)(.*)$')
SUMS_LINE = re.compile(r'^([0-9a-fA-F]{64})\s+\*?(\S.*)$')
# A merged image is one part at offset 0 whose bootloader header sits further in, so keep
# enough of every part to reach the deepest bootloader offset any chip declares.
HEAD_SAMPLE = 64 * 1024
SELF = "'self'"
# What each directive may name. Everything else in them is a finding.
CSP_ALLOWED = {'default-src': (SELF,), 'script-src': (SELF, 'https://skad.click')}
CATALOG = 'catalog.json'
INDEX = 'index.html'
VENDOR_SUMS = 'vendor/esptool-js/SHA256SUMS'


@dataclass(frozen=True)
class Finding:
    """One answered question. `what` is the token to grep for, `detail` the context."""

    level: str
    what: str
    detail: str

    def __str__(self) -> str:
        return '%s %s %s' % (self.level, self.what, self.detail)


# --------------------------------------------------------------------------- #
# Reading a site, whether it is a URL or a directory
# --------------------------------------------------------------------------- #

class UsageError(Exception):
    """The thing we were pointed at cannot be checked at all. Exit 2."""


class SourceError(Exception):
    """Something could not be read. `what` becomes the token of the finding."""

    what = 'missing'


class Missing(SourceError):
    what = 'missing'


class Unreachable(SourceError):
    what = 'http'


class BadPath(SourceError):
    what = 'path'


class ForeignOrigin(SourceError):
    what = 'origin'


class CrossOriginRedirect(SourceError):
    what = 'origin'


@dataclass(frozen=True)
class Fetched:
    data: bytes
    declared_length: Optional[int] = None


def origin(url: str) -> Tuple[str, str]:
    """Scheme and host:port, the part the browser compares."""
    parts = urllib.parse.urlsplit(url)
    return parts.scheme.lower(), parts.netloc.lower()


class NoCrossOriginRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect to another host would move the download out of the site being checked."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102 - urllib contract
        if origin(newurl) != origin(req.full_url):
            raise CrossOriginRedirect('%s redirects to another origin: %s' % (req.full_url, newurl))
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class HttpSource:
    """A live site, read over HTTP."""

    def __init__(self, base: str, timeout: int = TIMEOUT) -> None:
        self.base = base if base.endswith('/') else base + '/'
        self.timeout = timeout
        self.opener = urllib.request.build_opener(NoCrossOriginRedirect())

    def root(self) -> str:
        return self.base

    def join(self, ref: str, relative: str) -> str:
        target = urllib.parse.urljoin(ref, relative)
        if origin(target) != origin(self.base):
            raise ForeignOrigin('%s is on another origin than the site' % target)
        return target

    def label(self, ref: str) -> str:
        return ref

    def read(self, ref: str) -> Fetched:
        request = urllib.request.Request(ref, headers={'User-Agent': USER_AGENT})
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                status = getattr(response, 'status', response.getcode())
                if status != 200:
                    raise Unreachable('%s answered %s' % (ref, status))
                declared = response.headers.get('Content-Length')
                data = response.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise Missing('%s answered 404' % ref)
            raise Unreachable('%s answered %s' % (ref, exc.code))
        except urllib.error.URLError as exc:
            raise Unreachable('%s could not be reached: %s' % (ref, exc.reason))
        try:
            length = int(declared) if declared is not None else None
        except ValueError:
            length = None
        return Fetched(data, length)


class DirSource:
    """A directory on disk, read as the browser would read the site rooted there."""

    def __init__(self, base: Path) -> None:
        self.base = Path(base).resolve()
        if not self.base.is_dir():
            raise UsageError('%s is not a directory' % base)

    def root(self) -> Path:
        return self.base

    def join(self, ref: Path, relative: str) -> Path:
        cleaned = relative.replace('\\', '/')
        if urllib.parse.urlsplit(cleaned).scheme:
            raise BadPath('%s is an absolute URL; check the live site instead' % relative)
        if cleaned.startswith('/') or Path(ref) == self.base:
            start = self.base  # the site root is a directory, everything else is a file
        else:
            start = Path(ref).parent
        target = (start / cleaned.lstrip('/')).resolve()
        if target != self.base and self.base not in target.parents:
            raise BadPath('%s resolves outside the site root' % relative)
        return target

    def label(self, ref: Path) -> str:
        try:
            return Path(ref).resolve().relative_to(self.base).as_posix()
        except ValueError:
            return str(ref)

    def read(self, ref: Path) -> Fetched:
        try:
            return Fetched(Path(ref).read_bytes())
        except FileNotFoundError:
            raise Missing('%s is not there' % self.label(ref))
        except IsADirectoryError:
            raise Missing('%s is a directory, not a file' % self.label(ref))
        except PermissionError:
            raise Unreachable('%s cannot be read' % self.label(ref))


Source = Any  # HttpSource or DirSource


def make_source(base: str) -> Source:
    text = str(base)
    if re.match(r'^https?://', text, re.IGNORECASE):
        return HttpSource(text)
    return DirSource(Path(text))


# --------------------------------------------------------------------------- #
# Versions
# --------------------------------------------------------------------------- #

def version_key(text: str) -> Optional[Tuple[Tuple[int, ...], int]]:
    """Dotted numbers plus a flag: a pre-release suffix sorts below the bare version."""
    match = VERSION.match(str(text).strip())
    if not match:
        return None
    numbers = tuple(int(part) for part in match.group(1).split('.'))
    suffix = match.group(2).strip(' .-_')
    return numbers, 0 if suffix else 1


def newer(left: str, right: str) -> bool:
    """True when `left` is strictly newer than `right`; False when we cannot tell."""
    a, b = version_key(left), version_key(right)
    if a is None or b is None:
        return False
    width = max(len(a[0]), len(b[0]))

    def pad(numbers):
        return numbers + (0,) * (width - len(numbers))

    if pad(a[0]) != pad(b[0]):
        return pad(a[0]) > pad(b[0])
    return a[1] > b[1]


# --------------------------------------------------------------------------- #
# The checks
# --------------------------------------------------------------------------- #

def read_or_report(source: Source, ref: Any, subject: str) -> Tuple[Optional[Fetched], List[Finding]]:
    try:
        return source.read(ref), []
    except SourceError as exc:
        return None, [Finding(FAIL, exc.what, '%s: %s' % (subject, exc))]


def meta_attributes(tag: str) -> Dict[str, str]:
    found = {}
    for name, value in META_ATTR.findall(tag):
        found[name.lower()] = value.strip('"\'')
    return found


def csp_directives(policy: str) -> Dict[str, List[str]]:
    """The policy as {directive: sources}. The browser keeps the first of a repeated directive."""
    found: Dict[str, List[str]] = {}
    for clause in policy.split(';'):
        tokens = clause.split()
        if tokens:
            found.setdefault(tokens[0].lower(), tokens[1:])
    return found


def csp_problem(policy: str) -> Optional[str]:
    """Why this policy does not lock the page down, or None if it does.

    default-src must be exactly 'self'. script-src, if present, may name only 'self' and the
    download counter at https://skad.click. Anything else is a way for another origin's code
    to reach a page that is about to write to a device over USB.
    """
    directives = csp_directives(policy)
    if 'default-src' not in directives:
        return 'no default-src'
    for directive, allowed in CSP_ALLOWED.items():
        if directive not in directives:
            continue
        sources = directives[directive]
        extra = [s for s in sources if s not in allowed]
        if extra:
            return '%s also allows %s' % (directive, ' '.join(extra))
        if SELF not in sources:
            return '%s does not allow %s' % (directive, SELF)
    return None


def check_index(source: Source) -> List[Finding]:
    ref = source.join(source.root(), INDEX)
    fetched, problems = read_or_report(source, ref, INDEX)
    if fetched is None:
        return problems
    text = fetched.data.decode('utf-8', 'replace')
    policies = [meta_attributes(tag).get('content', '') for tag in META_TAG.findall(text)
                if meta_attributes(tag).get('http-equiv', '').lower() == 'content-security-policy']
    if not policies:
        return [Finding(FAIL, 'csp', '%s has no Content-Security-Policy meta tag' % INDEX)]
    for policy in policies:
        problem = csp_problem(policy)
        if problem is not None:
            return [Finding(FAIL, 'csp', '%s: %s' % (INDEX, problem))]
    return [Finding(OK, 'csp', "%s pins default-src to %s" % (INDEX, SELF))]


def check_vendor(source: Source) -> List[Finding]:
    ref = source.join(source.root(), VENDOR_SUMS)
    fetched, problems = read_or_report(source, ref, VENDOR_SUMS)
    if fetched is None:
        return problems
    entries = [SUMS_LINE.match(line.strip()) for line in fetched.data.decode('utf-8', 'replace').splitlines()]
    entries = [m for m in entries if m]
    if not entries:
        return [Finding(FAIL, 'vendor', '%s lists no checksums' % VENDOR_SUMS)]
    findings: List[Finding] = []
    for entry in entries:
        recorded, name = entry.group(1).lower(), entry.group(2).strip()
        try:
            bundle_ref = source.join(ref, name)
        except SourceError as exc:
            findings.append(Finding(FAIL, exc.what, '%s: %s' % (name, exc)))
            continue
        bundle, problems = read_or_report(source, bundle_ref, name)
        if bundle is None:
            findings.extend(problems)
            continue
        actual = hashlib.sha256(bundle.data).hexdigest()
        if actual != recorded:
            findings.append(Finding(FAIL, 'vendor', '%s is not the pinned build (%s, pinned %s)'
                                    % (name, actual[:16], recorded[:16])))
        else:
            findings.append(Finding(OK, 'vendor', '%s matches the pinned checksum' % name))
    return findings


def check_part(source: Source, manifest_ref: Any, part: Any,
               board: str) -> Tuple[List[Finding], Dict[str, Any]]:
    """Fetch one part and compare it with what the manifest declares about it."""
    findings: List[Finding] = []
    blank = {'offset': None, 'size': None, 'head': b''}
    if not isinstance(part, dict) or not isinstance(part.get('path'), str) or not part['path'].strip():
        return [Finding(FAIL, 'manifest', '%s: a part has no path' % board)], blank
    path = part['path']
    offset = part.get('offset')
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        return [Finding(FAIL, 'manifest', '%s: %s has no usable offset' % (board, path))], blank
    try:
        ref = source.join(manifest_ref, path)
    except SourceError as exc:
        return [Finding(FAIL, exc.what, '%s: %s' % (board, exc))], blank
    fetched, problems = read_or_report(source, ref, '%s: %s' % (board, path))
    if fetched is None:
        return problems, blank

    size = len(fetched.data)
    declared = part.get('size')
    if isinstance(declared, int) and not isinstance(declared, bool):
        if fetched.declared_length is not None and fetched.declared_length != declared:
            findings.append(Finding(FAIL, 'size', '%s: %s is served as %d bytes, manifest says %d'
                                    % (board, path, fetched.declared_length, declared)))
        elif size != declared:
            findings.append(Finding(FAIL, 'size', '%s: %s is %d bytes, manifest says %d'
                                    % (board, path, size, declared)))
        else:
            findings.append(Finding(OK, 'size', '%s: %s is %d bytes' % (board, path, size)))
    else:
        findings.append(Finding(WARN, 'size', '%s: %s declares no size' % (board, path)))

    digest = hashlib.sha256(fetched.data).hexdigest()
    declared_sum = part.get('sha256')
    if isinstance(declared_sum, str) and HEX64.match(declared_sum.lower()):
        if digest != declared_sum.lower():
            findings.append(Finding(FAIL, 'sha256', '%s: %s is %s, manifest says %s'
                                    % (board, path, digest, declared_sum.lower())))
        else:
            findings.append(Finding(OK, 'sha256', '%s: %s' % (board, path)))
    elif declared_sum is None:
        findings.append(Finding(WARN, 'checksum', '%s: %s no checksum declared' % (board, path)))
    else:
        findings.append(Finding(FAIL, 'sha256', '%s: %s declares a malformed checksum' % (board, path)))

    return findings, {'offset': offset, 'size': size, 'head': fetched.data[:HEAD_SAMPLE], 'path': path}


def preserve_problems(build: Dict[str, Any], parts: Sequence[Any], board: str) -> List[Finding]:
    """What the page refuses about a preserve build: it has to know what it is keeping.

    Without a region to compare, the page cannot tell whether the flash it is about to preserve is
    ours at all; without a size and a checksum per part it cannot tell what it just wrote.
    """
    findings: List[Finding] = []
    compat = build.get('compatibility')
    compat = compat if isinstance(compat, dict) else {}
    first = compat.get('firstInstall')
    first = first if isinstance(first, dict) else {}
    regions = [r for key in (compat.get('regions'), first.get('regions'))
               if isinstance(key, list) for r in key]
    if not regions:
        findings.append(Finding(FAIL, 'manifest', '%s: the preserve profile needs compatibility with at '
                                'least one region, in regions or firstInstall.regions' % board))
    for part in parts:
        if not isinstance(part, dict):
            continue
        absent = [key for key in ('size', 'sha256') if part.get(key) is None]
        if absent:
            findings.append(Finding(FAIL, 'manifest', '%s: %s declares no %s; the preserve profile needs both'
                                    % (board, part.get('path', 'a part'), ' or '.join(absent))))
    return findings


def check_build(source: Source, manifest_ref: Any, build: Dict[str, Any], board: str,
                profile: str) -> List[Finding]:
    family = build.get('chipFamily')
    findings: List[Finding] = []
    if family not in CHIPS:
        findings.append(Finding(FAIL, 'chipFamily', '%s: %r is not a chip family the page knows'
                                % (board, family)))
        family = None
    parts = build.get('parts')
    if not isinstance(parts, list) or not parts:
        return findings + [Finding(FAIL, 'manifest', '%s: no parts' % board)]

    if profile == 'preserve':
        findings.extend(preserve_problems(build, parts, board))

    measured: List[Dict[str, Any]] = []
    for part in parts:
        part_findings, info = check_part(source, manifest_ref, part, board)
        findings.extend(part_findings)
        if info['offset'] is not None:
            measured.append(info)
    if not measured:
        return findings

    spans = [(m['offset'], m['size']) for m in measured]
    if any(spans[i][0] > spans[i + 1][0] for i in range(len(spans) - 1)):
        findings.append(Finding(WARN, 'order', '%s: parts are not listed by rising offset' % board))
    collision = overlaps(spans)
    if collision is not None:
        findings.append(Finding(FAIL, 'overlap', '%s: parts at 0x%x and 0x%x overlap in flash'
                                % ((board,) + collision)))
    else:
        findings.append(Finding(OK, 'layout', '%s: %d part%s, no overlap'
                                % (board, len(spans), '' if len(spans) == 1 else 's')))

    if family is not None and len(measured) == len(parts):
        boot = CHIPS[family].bootloader_offset
        if boot is None:
            findings.append(Finding(OK, 'chip', '%s: %s declares no bootloader offset, header not checked'
                                    % (board, family)))
        else:
            hit = covering(spans, boot)
            if hit is None:
                findings.append(Finding(OK, 'chip', '%s: nothing is written at the bootloader offset'
                                        % board))
            else:
                problem = boot_image_problem(family, measured[hit]['head'], boot - measured[hit]['offset'])
                if problem is not None:
                    findings.append(Finding(FAIL, 'chip', '%s: %s %s'
                                            % (board, measured[hit]['path'], problem)))
                else:
                    findings.append(Finding(OK, 'chip', '%s: %s is an %s image'
                                            % (board, measured[hit]['path'], family)))
    return findings


def check_manifest(source: Source, ref: Any, subject: str) -> List[Finding]:
    fetched, problems = read_or_report(source, ref, subject)
    if fetched is None:
        return problems
    try:
        data = json.loads(fetched.data.decode('utf-8'))
    except (ValueError, UnicodeDecodeError) as exc:
        return [Finding(FAIL, 'json', '%s is not valid JSON: %s' % (subject, exc))]
    if not isinstance(data, dict):
        return [Finding(FAIL, 'manifest', '%s is not an object' % subject)]
    findings: List[Finding] = []
    schema = data.get('schema', 1)
    if schema not in (1, 2):
        findings.append(Finding(FAIL, 'manifest', '%s declares schema %r; the page accepts 1 and 2'
                                % (subject, schema)))
    for key in ('name', 'version'):
        value = data.get(key)
        if not (isinstance(value, (str, int, float)) and str(value).strip()):
            findings.append(Finding(FAIL, 'manifest', '%s has no %s' % (subject, key)))
    profile = data.get('profile', 'factory')
    if profile not in ('factory', 'preserve'):
        findings.append(Finding(FAIL, 'manifest', '%s declares profile %r; the page accepts '
                                'factory and preserve' % (subject, profile)))
    builds = data.get('builds')
    if not isinstance(builds, list) or not builds:
        return findings + [Finding(FAIL, 'manifest', '%s has no builds' % subject)]

    seen = set()
    for index, build in enumerate(builds):
        if not isinstance(build, dict):
            findings.append(Finding(FAIL, 'manifest', '%s: build %d is not an object' % (subject, index + 1)))
            continue
        board, problem = board_key(build, index)
        if problem is not None:
            findings.append(Finding(FAIL, 'manifest', '%s: %s' % (subject, problem)))
        if board in seen:
            findings.append(Finding(FAIL, 'manifest', '%s: two builds share the boardKey %r; the page '
                                    'keeps only one of them' % (subject, board)))
        seen.add(board)
        findings.extend(check_build(source, ref, build, board, build.get('profile', profile)))
    return findings


def board_key(build: Dict[str, Any], index: int) -> Tuple[str, Optional[str]]:
    """The key the page will use for this build, and why it would refuse it."""
    raw = build.get('boardKey')
    if raw is None:
        return 'build-%d' % (index + 1), None
    key = str(raw)
    if not BOARD_KEY.match(key):
        return key, ('boardKey %r must start with a letter or digit and hold only letters, '
                     'digits, dot, dash or underscore' % key)
    return key, None


def check_release_order(system_id: str, releases: Sequence[Any]) -> List[Finding]:
    findings: List[Finding] = []
    for first, second in zip(releases, releases[1:]):
        if not isinstance(first, dict) or not isinstance(second, dict):
            continue
        earlier, later = str(first.get('version', '')), str(second.get('version', ''))
        if newer(later, earlier):
            findings.append(Finding(WARN, 'order', '%s: %s is listed after %s but is newer; '
                                    'the page takes the first match' % (system_id, later, earlier)))
    return findings


def check_catalog(source: Source) -> List[Finding]:
    ref = source.join(source.root(), CATALOG)
    fetched, problems = read_or_report(source, ref, CATALOG)
    if fetched is None:
        return problems
    try:
        catalog = json.loads(fetched.data.decode('utf-8'))
    except (ValueError, UnicodeDecodeError) as exc:
        return [Finding(FAIL, 'json', '%s is not valid JSON: %s' % (CATALOG, exc))]
    systems = catalog.get('systems') if isinstance(catalog, dict) else None
    if not isinstance(systems, list) or not systems:
        return [Finding(FAIL, 'catalog', '%s lists no systems' % CATALOG)]

    findings = [Finding(OK, 'catalog', '%s lists %d system%s'
                        % (CATALOG, len(systems), '' if len(systems) == 1 else 's'))]
    for system in systems:
        if not isinstance(system, dict):
            findings.append(Finding(FAIL, 'catalog', 'a system is not an object'))
            continue
        system_id = str(system.get('id', '?'))
        releases = system.get('releases')
        if not isinstance(releases, list) or not releases:
            findings.append(Finding(FAIL, 'catalog', '%s lists no releases' % system_id))
            continue
        findings.extend(check_release_order(system_id, releases))
        for release in releases:
            path = release.get('manifest') if isinstance(release, dict) else None
            version = str(release.get('version', '?')) if isinstance(release, dict) else '?'
            subject = '%s %s' % (system_id, version)
            if not isinstance(path, str) or not path.strip():
                findings.append(Finding(FAIL, 'catalog', '%s names no manifest' % subject))
                continue
            try:
                manifest_ref = source.join(ref, path)
            except SourceError as exc:
                findings.append(Finding(FAIL, exc.what, '%s: %s' % (subject, exc)))
                continue
            findings.extend(check_manifest(source, manifest_ref, subject))
    return findings


def check_site(base: str) -> List[Finding]:
    """Every check, in the order a reader wants to see them.

    Raises UsageError when the base itself cannot be checked, for example a directory that is
    not there: that is a mistake in the command, not a finding about a site.
    """
    source = make_source(base)
    findings: List[Finding] = []
    findings.extend(check_index(source))
    findings.extend(check_vendor(source))
    findings.extend(check_catalog(source))
    return findings


# --------------------------------------------------------------------------- #
# Command line
# --------------------------------------------------------------------------- #

def summarise(findings: Sequence[Finding]) -> str:
    counts = {level: sum(1 for f in findings if f.level == level) for level in (OK, WARN, FAIL)}
    return 'SUMMARY %d OK, %d WARN, %d FAIL' % (counts[OK], counts[WARN], counts[FAIL])


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog='check.py',
        description='Check that an esp32install site serves everything the page will fetch.')
    parser.add_argument('base', metavar='URL-OR-DIRECTORY',
                        help='https://example.com/install/ or a path to the site directory')
    args = parser.parse_args(argv)
    try:
        findings = check_site(args.base)
    except UsageError as exc:
        print('check.py: %s' % exc, file=sys.stderr)
        return EXIT_USAGE
    for finding in findings:
        print(finding)
    print(summarise(findings))
    return EXIT_FAIL if any(f.level == FAIL for f in findings) else EXIT_OK


if __name__ == '__main__':
    sys.exit(main())
