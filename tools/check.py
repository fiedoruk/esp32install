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
    from .manifest import (CHIPS, HEAD_SAMPLE, SECTOR, boot_image_problem, covering, erase_footprint,
                           erase_spill, image_part_problem, overlaps)
else:  # run as a script: tools/ is already on sys.path
    from manifest import (CHIPS, HEAD_SAMPLE, SECTOR, boot_image_problem, covering, erase_footprint,
                          erase_spill, image_part_problem, overlaps)

OK = 'OK'
WARN = 'WARN'
FAIL = 'FAIL'
EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2

USER_AGENT = 'esp32install-check/1.0'
TIMEOUT = 30
HEX64 = re.compile(r'[0-9a-f]{64}')
BOARD_KEY = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}')
META_TAG = re.compile(r'<meta\b[^>]*>', re.IGNORECASE)
META_ATTR = re.compile(r'([A-Za-z-]+)\s*=\s*("[^"]*"|\'[^\']*\'|[^\s">]+)')
VERSION = re.compile(r'^[vV]?(\d+(?:\.\d+)*)(.*)$')
SUMS_LINE = re.compile(r'^([0-9a-fA-F]{64})\s+\*?(\S.*)$')
SELF = "'self'"
# What each directive may name out of the box: the page itself and nothing else. A host widens
# this in exactly two ways, both explicit. Origins listed in catalog.json `allowOrigins` may appear
# in connect-src, because that is where the page fetches binaries from. Origins passed with
# --allow-origin (a host's own analytics, say) may appear in script-src, script-src-elem and
# connect-src. default-src and style-src never widen: styles have no reason to come from elsewhere.
CSP_ALLOWED = {
    'default-src': (SELF,),
    'script-src': (SELF,),
    'script-src-elem': (SELF,),
    'connect-src': (SELF,),
    'style-src': (SELF,),
}
SCRIPT_DIRECTIVES = ('script-src', 'script-src-elem', 'connect-src')
CONNECT_DIRECTIVES = ('connect-src',)
ORIGIN = re.compile(r'^https?://[A-Za-z0-9.-]+(?::\d{1,5})?$')
# Hosts every browser treats as a secure context over plain http, which is what makes local
# testing possible; everywhere else an allowOrigins entry has to be https.
LOCAL_HOSTS = frozenset(('localhost', '127.0.0.1'))
CATALOG = 'catalog.json'
INDEX = 'index.html'
VENDOR_SUMS = 'vendor/esptool-js/SHA256SUMS'
IMPROV_SUMS = 'vendor/improv-wifi/SHA256SUMS'


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
    # Response headers, lower-cased, or None for a directory on disk, which has none. Kept because
    # two of the things the docs tell a host to set can only be seen here.
    headers: Optional[Dict[str, str]] = None


def collect_headers(headers: Any) -> Dict[str, str]:
    """Response headers as a lower-cased dict; a header sent twice is joined, as a browser joins it."""
    collected: Dict[str, str] = {}
    items = headers.items() if hasattr(headers, 'items') else []
    for name, value in items:
        key = str(name).lower()
        collected[key] = '%s, %s' % (collected[key], value) if key in collected else str(value)
    return collected


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
                headers = collect_headers(response.headers)
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
        return Fetched(data, length, headers)


class DirSource:
    """A directory on disk, read as the browser would read the site rooted there.

    `base` is the installer directory (where index.html and catalog.json live). `site_root` is
    the directory the site's root URL corresponds to; it defaults to `base`, and is given
    separately when the installer sits in a subdirectory of the site and its manifests reach
    outside it, the way a portal keeps binaries under `/os/` next to `/install/`. A path may
    resolve anywhere under the site root and nowhere above it.
    """

    def __init__(self, base: Path, site_root: Optional[Path] = None) -> None:
        self.base = Path(base).resolve()
        if not self.base.is_dir():
            raise UsageError('%s is not a directory' % base)
        self.site_root = Path(site_root).resolve() if site_root is not None else self.base
        if not self.site_root.is_dir():
            raise UsageError('--site-root %s is not a directory' % site_root)
        if self.site_root != self.base and self.site_root not in self.base.parents:
            raise UsageError('--site-root %s does not contain %s' % (site_root, base))

    def root(self) -> Path:
        return self.base

    def join(self, ref: Path, relative: str) -> Path:
        cleaned = relative.replace('\\', '/')
        if urllib.parse.urlsplit(cleaned).scheme:
            raise BadPath('%s is an absolute URL; check the live site instead' % relative)
        if cleaned.startswith('/'):
            start = self.site_root  # an absolute path is from the site's root URL
        elif Path(ref) == self.base:
            start = self.base  # the installer root is a directory, everything else is a file
        else:
            start = Path(ref).parent
        target = (start / cleaned.lstrip('/')).resolve()
        if target != self.site_root and self.site_root not in target.parents:
            raise BadPath('%s resolves outside the site root' % relative)
        return target

    def label(self, ref: Path) -> str:
        resolved = Path(ref).resolve()
        for root in (self.base, self.site_root):
            try:
                return resolved.relative_to(root).as_posix()
            except ValueError:
                continue
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


def make_source(base: str, site_root: Optional[str] = None) -> Source:
    text = str(base)
    if re.match(r'^https?://', text, re.IGNORECASE):
        if site_root is not None:
            raise UsageError('--site-root applies to a directory; a live site already knows its root')
        return HttpSource(text)
    return DirSource(Path(text), Path(site_root) if site_root is not None else None)


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


def unquote(value: str) -> str:
    """Drop the delimiter the attribute opened with, and only that one.

    `content="default-src 'self'"` carries quotes inside its value; stripping every quote at the
    ends turns `'self'` into `'self`, which is a different CSP source.
    """
    if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
        return value[1:-1]
    return value


def meta_attributes(tag: str) -> Dict[str, str]:
    found = {}
    for name, value in META_ATTR.findall(tag):
        found[name.lower()] = unquote(value)
    return found


def csp_directives(policy: str) -> Dict[str, List[str]]:
    """The policy as {directive: sources}. The browser keeps the first of a repeated directive."""
    found: Dict[str, List[str]] = {}
    for clause in policy.split(';'):
        tokens = clause.split()
        if tokens:
            found.setdefault(tokens[0].lower(), tokens[1:])
    return found


def is_origin(value: Any) -> bool:
    """scheme://host[:port], nothing else: what the browser compares and what a CSP source names."""
    return isinstance(value, str) and ORIGIN.match(value) is not None


def is_local_origin(value: str) -> bool:
    """The one place `http:` is not a mistake: the machine the tester is sitting at."""
    host = urllib.parse.urlsplit(value).hostname or ''
    return host in LOCAL_HOSTS or host.endswith('.localhost')


def insecure_origin(value: str) -> bool:
    """An origin the page could not fetch from anyway: `http:` somewhere other than this machine.

    The installer is served over https, so the browser refuses an `http:` download as mixed
    content before the page's own origin check runs. Listing one in `allowOrigins` therefore
    cannot work; it only hides the mistake until someone tries to install.
    """
    return urllib.parse.urlsplit(value).scheme.lower() != 'https' and not is_local_origin(value)


def csp_allowed(catalog_origins: Sequence[str] = (), extra_origins: Sequence[str] = ()) -> Dict[str, Tuple[str, ...]]:
    """CSP_ALLOWED widened by exactly the origins a host has declared, and nowhere else."""
    allowed = {}
    for directive, base in CSP_ALLOWED.items():
        sources = list(base)
        if directive in SCRIPT_DIRECTIVES:
            sources.extend(o for o in extra_origins if o not in sources)
        if directive in CONNECT_DIRECTIVES:
            sources.extend(o for o in catalog_origins if o not in sources)
        allowed[directive] = tuple(sources)
    return allowed


def csp_problem(policy: str, require_default: bool = True, catalog_origins: Sequence[str] = (),
                extra_origins: Sequence[str] = ()) -> Optional[str]:
    """Why this policy does not lock the page down, or None if it does.

    default-src must be exactly 'self'. script-src, script-src-elem and connect-src may name
    'self' and the origins passed as --allow-origin; connect-src may also name the origins the
    catalog lists in allowOrigins. Anything else is a way for another origin's code or bytes to
    reach a page that is about to write to a device over USB.
    """
    directives = csp_directives(policy)
    if require_default and 'default-src' not in directives:
        return 'no default-src'
    for directive, allowed in csp_allowed(catalog_origins, extra_origins).items():
        if directive not in directives:
            continue
        sources = directives[directive]
        extra = [s for s in sources if s not in allowed]
        if extra:
            return '%s also allows %s' % (directive, ' '.join(extra))
        if SELF not in sources:
            return '%s does not allow %s' % (directive, SELF)
    return None


def unreachable_origins(policies: Sequence[str], catalog_origins: Sequence[str]) -> List[str]:
    """allowOrigins entries that connect-src does not name: the page would refuse to fetch from them."""
    directives: Dict[str, List[str]] = {}
    for policy in policies:
        for directive, sources in csp_directives(policy).items():
            directives.setdefault(directive, sources)
    connect = directives.get('connect-src', directives.get('default-src', []))
    return [o for o in catalog_origins if o not in connect]


# Powyżej tylu sekund powłoka aplikacji bez wersji w nazwie zaczyna kłamać po wdrożeniu.
MAX_SHELL_AGE = 300


def framing_problem(headers: Optional[Dict[str, str]]) -> Optional[str]:
    """Why another site could put this page in a frame and steer clicks at it, or None.

    Either header is enough: `X-Frame-Options`, or a `Content-Security-Policy` response header
    with `frame-ancestors`. Neither can come from the page itself — `frame-ancestors` is ignored
    in a `<meta>` policy — so this is the one check that only a live site can answer. A directory
    has no headers and is not judged.

    Only `DENY` and `SAMEORIGIN` count. Those are the two values browsers still act on: the old
    `ALLOW-FROM` was dropped everywhere, and anything else — `ALLOWALL`, a typo, a hostname — is
    ignored by the browser, so accepting it would mean vouching for protection nobody applies.
    """
    if headers is None:
        return None
    xfo = headers.get('x-frame-options', '').strip()
    if xfo.upper() in ('DENY', 'SAMEORIGIN'):
        return None
    if xfo:
        return ('X-Frame-Options says %r, which no current browser acts on: only DENY and '
                'SAMEORIGIN stop another site framing the page' % xfo)
    # A response may carry several policies, separated by commas; look in all of them.
    policy = headers.get('content-security-policy', '').replace(',', ';')
    if 'frame-ancestors' in csp_directives(policy):
        return None
    return ('neither X-Frame-Options nor a Content-Security-Policy with frame-ancestors is sent, '
            'so another site can put this page in a frame; the page cannot set that itself')



def stale_cache_problem(headers: Optional[Dict[str, str]]) -> Optional[str]:
    """Why a visitor could be served yesterday's page, or None.

    This project has no build step, so a file never changes its name and a browser has no way
    to tell one deployment from the next. A long `max-age` on the page or its scripts therefore
    means a visitor who came once keeps the old copy until it expires — they see an installer
    that was fixed days ago, and nothing tells either of you. Measured 16.09.2026: Safari held
    a stylesheet for a month because the host sent `max-age=2592000` to a file with no version
    in its address.

    `no-cache` is the answer, and it does not mean "do not store": it means "ask before you use
    it". With an ETag the answer is a 304 with no body, so revalidating costs almost nothing.
    A directory on disk has no headers and is not judged.

    Fonts and vendored binaries may keep a long `max-age` — their names carry a version — but
    this checks the page, which never may.
    """
    if headers is None:
        return None
    control = headers.get('cache-control', '').lower()
    if 'no-store' in control or 'no-cache' in control:
        return None
    if 'must-revalidate' in control and 'max-age=0' in control:
        return None
    match = re.search(r'max-age\s*=\s*(\d+)', control)
    age = int(match.group(1)) if match else None
    if age is not None and age <= MAX_SHELL_AGE:
        return None
    if age is not None:
        return ('the host caches it for %d seconds and the file has no version in its address, '
                'so a visitor keeps this copy until it expires even after you deploy a fix; '
                'send Cache-Control: no-cache instead — with an ETag that costs a 304, not a '
                'download' % age)
    return ('the host sends no Cache-Control, so the browser guesses how long to keep it and '
            'Safari guesses generously; send Cache-Control: no-cache so a deployment reaches '
            'people who already visited')


def check_index(source: Source, catalog_origins: Sequence[str] = (),
                extra_origins: Sequence[str] = ()) -> List[Finding]:
    ref = source.join(source.root(), INDEX)
    fetched, problems = read_or_report(source, ref, INDEX)
    if fetched is None:
        return problems
    text = fetched.data.decode('utf-8', 'replace')
    policies = [meta_attributes(tag).get('content', '') for tag in META_TAG.findall(text)
                if meta_attributes(tag).get('http-equiv', '').lower() == 'content-security-policy']
    if not policies:
        return [Finding(FAIL, 'csp', '%s has no Content-Security-Policy meta tag' % INDEX)]
    for index, policy in enumerate(policies):
        problem = csp_problem(policy, require_default=index == 0, catalog_origins=catalog_origins,
                              extra_origins=extra_origins)
        if problem is not None:
            return [Finding(FAIL, 'csp', '%s: %s' % (INDEX, problem))]
    findings = [Finding(OK, 'csp', "%s pins default-src to %s" % (INDEX, SELF))]
    problem = framing_problem(fetched.headers)
    if problem is not None:
        findings.append(Finding(WARN, 'framing', '%s: %s' % (INDEX, problem)))
    elif fetched.headers is not None:
        findings.append(Finding(OK, 'framing', '%s: the host sends a header that stops other sites '
                                'framing the page' % INDEX))
    problem = stale_cache_problem(fetched.headers)
    if problem is not None:
        findings.append(Finding(WARN, 'cache', '%s: %s' % (INDEX, problem)))
    elif fetched.headers is not None:
        findings.append(Finding(OK, 'cache', '%s: a deployment reaches people who already '
                                'visited' % INDEX))
    for origin_ in unreachable_origins(policies, catalog_origins):
        findings.append(Finding(WARN, 'csp', '%s: connect-src does not name %s, which %s lists in '
                                'allowOrigins; the page will refuse to download from there'
                                % (INDEX, origin_, CATALOG)))
    return findings


def check_vendor(source: Source) -> List[Finding]:
    """esptool-js must be there and pinned. The Improv client is optional: a replica that dropped
    it only loses the Wi-Fi step after the install, so its absence is a WARN and its presence is
    pinned like the bundle."""
    findings = check_sums(source, VENDOR_SUMS)
    improv_ref = source.join(source.root(), IMPROV_SUMS)
    fetched, _ = read_or_report(source, improv_ref, IMPROV_SUMS)
    if fetched is None:
        findings.append(Finding(WARN, 'vendor', '%s is missing; the page will not offer Wi-Fi setup '
                                'after the install' % IMPROV_SUMS))
    else:
        findings.extend(check_sums(source, IMPROV_SUMS))
    return findings


def check_sums(source: Source, sums_path: str) -> List[Finding]:
    """Every file a SHA256SUMS names must be there and match, byte for byte."""
    ref = source.join(source.root(), sums_path)
    fetched, problems = read_or_report(source, ref, sums_path)
    if fetched is None:
        return problems
    entries = [SUMS_LINE.match(line.strip()) for line in fetched.data.decode('utf-8', 'replace').splitlines()]
    entries = [m for m in entries if m]
    if not entries:
        return [Finding(FAIL, 'vendor', '%s lists no checksums' % sums_path)]
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


def check_part(source: Source, manifest_ref: Any, part: Any, board: str,
               allow_unhashed: bool = False) -> Tuple[List[Finding], Dict[str, Any]]:
    """Fetch one part and compare it with what the manifest declares about it.

    A part with no `sha256` is a FAIL: the page will write it anyway, so the only thing standing
    between the device and a damaged or swapped file is TLS and the host. `allow_unhashed` (the
    --allow-unhashed flag) lowers it to a WARN for a pipeline that genuinely cannot hash.
    """
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
    if isinstance(declared_sum, str) and HEX64.fullmatch(declared_sum.lower()):
        if digest != declared_sum.lower():
            findings.append(Finding(FAIL, 'sha256', '%s: %s is %s, manifest says %s'
                                    % (board, path, digest, declared_sum.lower())))
        else:
            findings.append(Finding(OK, 'sha256', '%s: %s' % (board, path)))
    elif declared_sum is None:
        findings.append(Finding(WARN if allow_unhashed else FAIL, 'checksum',
                                '%s: %s declares no sha256, so nothing can tell a damaged or swapped '
                                'file from the real one; add one, or pass --allow-unhashed to accept it'
                                % (board, path)))
    else:
        findings.append(Finding(FAIL, 'sha256', '%s: %s declares a malformed checksum' % (board, path)))

    return findings, {'offset': offset, 'size': size, 'head': fetched.data[:HEAD_SAMPLE], 'path': path}


def is_offset(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def table_offset(build: Dict[str, Any]) -> Optional[int]:
    """`compatibility.update.tableOffset` when it is a usable offset, else None."""
    compat = build.get('compatibility')
    update = compat.get('update') if isinstance(compat, dict) else None
    table = update.get('tableOffset') if isinstance(update, dict) else None
    return table if is_offset(table) else None


def preserve_problems(build: Dict[str, Any], parts: Sequence[Any], board: str) -> List[Finding]:
    """What the page refuses about a preserve build: it has to know what it is keeping.

    Without a region to compare, the page cannot tell whether the flash it is about to preserve is
    ours at all; without a checksum on each region it cannot check the claim; without a size and a
    checksum per part it cannot tell what it just wrote; and without a partition table offset that
    one of the parts is written at, update mode has nothing to compare the device's table with.
    Mirrors normalizeCompatibility in app/manifest.js.
    """
    findings: List[Finding] = []
    compat = build.get('compatibility')
    compat = compat if isinstance(compat, dict) else {}
    first = compat.get('firstInstall')
    first = first if isinstance(first, dict) else {}
    regions = [r for key in (compat.get('regions'), first.get('regions'))
               if isinstance(key, list) for r in key]
    empty = first.get('empty') if isinstance(first.get('empty'), list) else []
    if not regions:
        findings.append(Finding(FAIL, 'manifest', '%s: the preserve profile needs compatibility with at '
                                'least one region, in regions or firstInstall.regions' % board))
    for region in regions:
        if not (isinstance(region, dict) and is_offset(region.get('offset'))
                and isinstance(region.get('size'), int) and not isinstance(region.get('size'), bool)
                and region['size'] > 0):
            findings.append(Finding(FAIL, 'manifest', '%s: a compatibility region needs offset >= 0 and '
                                    'size > 0' % board))
        elif not (isinstance(region.get('sha256'), str) and HEX64.fullmatch(region['sha256'].lower())):
            findings.append(Finding(FAIL, 'manifest', '%s: the region at 0x%x declares no usable sha256; '
                                    'the preserve profile refuses a region it cannot check'
                                    % (board, region['offset'])))
    table = table_offset(build)
    offsets = [p.get('offset') for p in parts if isinstance(p, dict)]
    if table is None:
        findings.append(Finding(FAIL, 'manifest', '%s: the preserve profile needs update.tableOffset, '
                                'the partition table offset' % board))
    elif table not in offsets:
        findings.append(Finding(FAIL, 'manifest', '%s: update.tableOffset is 0x%x but no part is written '
                                'at that offset' % (board, table)))
    for part in parts:
        if not isinstance(part, dict):
            continue
        absent = [key for key in ('size', 'sha256') if part.get(key) is None]
        if absent:
            findings.append(Finding(FAIL, 'manifest', '%s: %s declares no %s; the preserve profile needs both'
                                    % (board, part.get('path', 'a part'), ' or '.join(absent))))
        # The chip erases whole sectors, so a part that starts mid-sector blanks the user data in
        # front of it. The page refuses such a manifest with manifest.alignment, so this is a FAIL.
        if is_offset(part.get('offset')) and part['offset'] % SECTOR:
            findings.append(Finding(FAIL, 'align', '%s: %s is written at 0x%x, which is not a multiple of '
                                    '%d; the chip erases whole sectors, so this would also blank the %d '
                                    'bytes before it, and the page refuses the release'
                                    % (board, part.get('path', 'a part'), part['offset'], SECTOR,
                                       part['offset'] % SECTOR)))
    findings.extend(erase_spill_problems(build, parts, board, list(regions) + list(empty)))
    return findings


def erase_spill_problems(build: Dict[str, Any], parts: Sequence[Any], board: str,
                         declared_regions: Sequence[Any]) -> List[Finding]:
    """The other end of the alignment rule, as the page states it (`manifest.alignment`).

    A write costs whole sectors at both ends, so up to SECTOR-1 bytes after a part are blanked
    along with it. A ragged length is the normal case -- an ESP-IDF application is hardly ever a
    whole number of sectors, and its tail lands inside its own partition, where nothing is
    declared and nothing is lost. What is refused is a footprint that reaches something the
    release makes a claim about: another part, a compatibility region, or the end of the chip.
    Outside the header span the read-back never looks, so nothing downstream would notice.
    """
    findings: List[Finding] = []
    sized = [(p.get('offset'), p.get('size'), p.get('path', 'a part')) for p in parts
             if isinstance(p, dict) and is_offset(p.get('offset'))
             and isinstance(p.get('size'), int) and not isinstance(p.get('size'), bool) and p['size'] > 0]
    declared = [(r['offset'], r['size']) for r in declared_regions
                if isinstance(r, dict) and is_offset(r.get('offset'))
                and isinstance(r.get('size'), int) and not isinstance(r.get('size'), bool) and r['size'] > 0]
    flash_mb = build.get('flashSizeMB')
    flash_bytes = (flash_mb * 1024 * 1024 if isinstance(flash_mb, int)
                   and not isinstance(flash_mb, bool) and flash_mb > 0 else None)
    for index, (offset, size, path) in enumerate(sized):
        others = [(o, s) for j, (o, s, _) in enumerate(sized) if j != index]
        reaches = erase_spill(offset, size, others, declared, flash_bytes)
        if reaches is None:
            continue
        start, end = erase_footprint(offset, size)
        findings.append(Finding(FAIL, 'align', '%s: %s is %d bytes at 0x%x, so the chip erases '
                                '0x%x-0x%x whole, and that reaches %s; the page refuses the release'
                                % (board, path, size, offset, start, end, reaches)))
    return findings


def check_build(source: Source, manifest_ref: Any, build: Dict[str, Any], board: str,
                profile: str, allow_unhashed: bool = False) -> List[Finding]:
    family = build.get('chipFamily')
    findings: List[Finding] = []
    if family not in CHIPS:
        findings.append(Finding(FAIL, 'chipFamily', '%s: %r is not a chip family the page knows'
                                % (board, family)))
        family = None
    improv = build.get('improv')
    if improv is not None and not isinstance(improv, bool):
        # The page refuses a non-boolean here (manifest.improv), so it is a FAIL, not a warning.
        findings.append(Finding(FAIL, 'manifest', '%s: improv must be true or false, not %r'
                                % (board, improv)))
    elif improv is True:
        findings.append(Finding(OK, 'improv', '%s: takes Wi-Fi credentials over Improv Serial after the install'
                                % board))
    parts = build.get('parts')
    if not isinstance(parts, list) or not parts:
        return findings + [Finding(FAIL, 'manifest', '%s: no parts' % board)]

    if profile == 'preserve':
        findings.extend(preserve_problems(build, parts, board))

    measured: List[Dict[str, Any]] = []
    for part in parts:
        part_findings, info = check_part(source, manifest_ref, part, board, allow_unhashed)
        findings.extend(part_findings)
        if info['offset'] is not None:
            measured.append(info)
    if not measured:
        return findings

    spans = [(m['offset'], m['size']) for m in measured]
    if profile == 'preserve':
        # Manifest order is write order, and the table page has to go on the chip last so a failure
        # during the application leaves the old table intact. Rising offsets are beside the point here.
        table = table_offset(build)
        if table is not None and len(measured) == len(parts) and measured[-1]['offset'] != table:
            findings.append(Finding(FAIL, 'order', '%s: the part at update.tableOffset 0x%x must be listed last; '
                                    'parts are written in manifest order and the table has to be written '
                                    'after the application' % (board, table)))
    elif any(spans[i][0] > spans[i + 1][0] for i in range(len(spans) - 1)):
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
        hit = None
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
        # Every other part that starts like an image has to be for this chip too: an application
        # written above the bootloader offset is never seen by the check above.
        for index, part in enumerate(measured):
            if index == hit:
                continue
            problem = image_part_problem(family, part['head'], part['size'])
            if problem is not None:
                findings.append(Finding(FAIL, 'chip', '%s: %s at 0x%x %s'
                                        % (board, part['path'], part['offset'], problem)))
            elif part['size'] >= 24 and part['head'][:1] == b'\xe9' and CHIPS[family].image_chip_id is not None:
                findings.append(Finding(OK, 'chip', '%s: %s at 0x%x is an %s image'
                                        % (board, part['path'], part['offset'], family)))
    return findings


def check_manifest(source: Source, ref: Any, subject: str, allow_unhashed: bool = False) -> List[Finding]:
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
        build_profile = build.get('profile', profile)
        if build_profile != profile:
            # The page installs by the manifest's profile; a build that says otherwise is refused
            # there, so it is a FAIL here rather than a silent override.
            findings.append(Finding(FAIL, 'manifest', '%s: %s declares profile %r but the manifest is %r; '
                                    'a build may repeat the profile, never change it'
                                    % (subject, board, build_profile, profile)))
        findings.extend(check_build(source, ref, build, board, profile, allow_unhashed))
    return findings


def board_key(build: Dict[str, Any], index: int) -> Tuple[str, Optional[str]]:
    """The key the page will use for this build, and why it would refuse it."""
    raw = build.get('boardKey')
    if raw is None:
        return 'build-%d' % (index + 1), None
    key = str(raw)
    if not BOARD_KEY.fullmatch(key):
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


def read_catalog(source: Source) -> Tuple[Optional[Any], List[Finding]]:
    ref = source.join(source.root(), CATALOG)
    fetched, problems = read_or_report(source, ref, CATALOG)
    if fetched is None:
        return None, problems
    try:
        return json.loads(fetched.data.decode('utf-8')), []
    except (ValueError, UnicodeDecodeError) as exc:
        return None, [Finding(FAIL, 'json', '%s is not valid JSON: %s' % (CATALOG, exc))]


def allow_origins(catalog: Any) -> Tuple[List[str], List[Finding]]:
    """The origins the catalog lets binaries come from, and what is wrong with the list.

    Only well-formed https origins (and http on this machine) are returned; a malformed or
    insecure entry is a FAIL and is not honoured, so a typo cannot widen the policy the checker
    accepts.
    """
    if not isinstance(catalog, dict) or 'allowOrigins' not in catalog:
        return [], []
    raw = catalog['allowOrigins']
    if not isinstance(raw, list):
        return [], [Finding(FAIL, 'catalog', '%s: allowOrigins must be a list of origins' % CATALOG)]
    origins, findings = [], []
    for entry in raw:
        if not is_origin(entry):
            findings.append(Finding(FAIL, 'catalog', '%s: allowOrigins entry %r is not an origin '
                                    '(scheme://host[:port], no path)' % (CATALOG, entry)))
        elif insecure_origin(entry):
            findings.append(Finding(FAIL, 'catalog', '%s: allowOrigins entry %r is not https, so the '
                                    'browser would refuse the download as mixed content on an https '
                                    'page; http://localhost and http://127.0.0.1 are the exception, '
                                    'for local testing' % (CATALOG, entry)))
        else:
            origins.append(entry)
    return origins, findings


def check_catalog(source: Source, catalog: Any, allow_unhashed: bool = False) -> List[Finding]:
    ref = source.join(source.root(), CATALOG)
    systems = catalog.get('systems') if isinstance(catalog, dict) else None
    if not isinstance(systems, list):
        return [Finding(FAIL, 'catalog', '%s has no systems list' % CATALOG)]
    if not systems:
        # A legitimate site: the page opens on the own-file path. Worth a line, not a failure.
        return [Finding(WARN, 'catalog', '%s lists no systems; the page opens on the own-file path' % CATALOG)]

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
            findings.extend(check_manifest(source, manifest_ref, subject, allow_unhashed))
    return findings


def check_site(base: str, extra_origins: Sequence[str] = (), site_root: Optional[str] = None,
               allow_unhashed: bool = False) -> List[Finding]:
    """Every check, in the order a reader wants to see them.

    `extra_origins` are the --allow-origin values: origins the host has deliberately let into
    script-src, script-src-elem and connect-src, for its own analytics. The catalog is read first
    because its allowOrigins decide what connect-src may name. `site_root` is the --site-root
    directory for a checkout whose installer is a subdirectory of the site.

    Raises UsageError when the base itself cannot be checked, for example a directory that is
    not there: that is a mistake in the command, not a finding about a site.
    """
    for origin_ in extra_origins:
        if not is_origin(origin_):
            raise UsageError('--allow-origin %r is not an origin (scheme://host[:port], no path)' % (origin_,))
    source = make_source(base, site_root)
    catalog, catalog_problems = read_catalog(source)
    catalog_origins, origin_problems = allow_origins(catalog)
    findings: List[Finding] = []
    findings.extend(check_index(source, catalog_origins, extra_origins))
    findings.extend(check_vendor(source))
    findings.extend(catalog_problems or origin_problems)
    if catalog is not None:
        findings.extend(check_catalog(source, catalog, allow_unhashed))
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
    parser.add_argument('--allow-origin', dest='allow_origins', action='append', default=[], metavar='ORIGIN',
                        help='an origin the page policy may also name in script-src, script-src-elem and '
                             'connect-src, for example the host of your own analytics script (repeatable)')
    parser.add_argument('--site-root', dest='site_root', default=None, metavar='DIRECTORY',
                        help='for a directory: the directory the site\'s root URL corresponds to, when the '
                             'installer is a subdirectory of it and its manifests reach outside (a portal that '
                             'keeps binaries under /os/ next to /install/, say); paths may then resolve anywhere '
                             'under that root and nowhere above it')
    parser.add_argument('--allow-unhashed', dest='allow_unhashed', action='store_true',
                        help='accept a part that declares no sha256 (a WARN instead of a FAIL), for a '
                             'build pipeline that cannot hash its binaries; the page will still write '
                             'such a part, with nothing but the connection vouching for it')
    args = parser.parse_args(argv)
    try:
        findings = check_site(args.base, args.allow_origins, args.site_root, args.allow_unhashed)
    except UsageError as exc:
        print('check.py: %s' % exc, file=sys.stderr)
        return EXIT_USAGE
    for finding in findings:
        print(finding)
    print(summarise(findings))
    return EXIT_FAIL if any(f.level == FAIL for f in findings) else EXIT_OK


if __name__ == '__main__':
    sys.exit(main())
