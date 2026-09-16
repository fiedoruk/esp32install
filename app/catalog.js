import { InstallError } from './errors.js';

/**
 * Releases are listed newest-first across all channels in catalog.json; we keep that order and do not
 * parse versions. Without `v`, `channel: 'pre'` takes the newest release whatever its channel, which
 * may be a stable one; any other channel takes the newest release whose channel is stable, or, when
 * the system has no stable release at all, its newest release (a pre-only system must still open).
 */
export function pickRelease(catalog, { fw, v, channel } = {}) {
  const systems = Array.isArray(catalog?.systems) ? catalog.systems : [];
  if (!fw) return { systems };
  const system = systems.find((s) => s.id === fw);
  if (!system) throw new InstallError('catalog.unknownSystem', { fw });
  const releases = Array.isArray(system.releases) ? system.releases : [];
  let release;
  if (v) release = releases.find((r) => r.version === v);
  else if (channel === 'pre') release = releases[0];
  else release = releases.find((r) => (r.channel ?? 'stable') === 'stable') ?? releases[0];
  if (!release) throw new InstallError('catalog.unknownVersion', { fw, v: v ?? '' });
  return { system, release };
}

// A link is another origin's when it starts with two slashes, in either direction: the URL parser
// treats a backslash like a slash for http(s), so `\\evil.example` is `//evil.example`.
const OTHER_ORIGIN = /^[/\\]{2}/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A `guide` link out of the catalog, ready for an `href`, or `''` when it is not one we will
 * offer. Only `https:` and a path relative to this page are kept. A scheme of any other kind is
 * dropped — `javascript:` and `data:` would run in this page, `http:` would be a downgrade from
 * the page the visitor is on — and so is a protocol-relative address. The catalog is the host's
 * own file, so this is not a defence against the host; it is one against a typo or a pasted link
 * in a catalog that several people edit.
 */
export function safeHref(value) {
  const href = typeof value === 'string' ? value.trim() : '';
  if (!href || OTHER_ORIGIN.test(href)) return '';
  if (HAS_SCHEME.test(href)) return /^https:/i.test(href) ? href : '';
  return href;
}
