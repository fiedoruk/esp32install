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
// Tab, newline and carriage return are removed from an href wherever they appear while the URL is
// parsed, so a scheme spelled with one inside it is still that scheme by the time the anchor has
// one. They come out before the scheme is looked for, or it hides behind them.
const STRIPPED = /[\u0009\u000a\u000d]/g;
// Anything else in that range the parser keeps, and no address we would offer carries one. Such a
// value is refused rather than repaired: deleting characters out of the middle of a URL would
// hand back an address nobody wrote.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A `guide` link out of the catalog, ready for an `href`, or `''` when it is not one we will
 * offer. Only `https:` and a path relative to this page are kept. A scheme of any other kind is
 * dropped — `javascript:` and `data:` would run in this page, `http:` would be a downgrade from
 * the page the visitor is on — and so is a protocol-relative address. The catalog is the host's
 * own file, so this is not a defence against the host; it is one against a typo or a pasted link
 * in a catalog that several people edit.
 *
 * The value is read the way the browser will read it: tab, newline and carriage return come out
 * first, wherever they sit, because the URL parser takes them out too. Spelled `java<TAB>script:`,
 * a scheme that is dropped here would otherwise not look like a scheme at all, and the anchor's
 * `protocol` would come back `javascript:`. Any other control character left in the value is not
 * an address we would offer, and is refused rather than quietly deleted.
 */
export function safeHref(value) {
  const href = typeof value === 'string' ? value.trim().replace(STRIPPED, '') : '';
  if (!href || CONTROL.test(href) || OTHER_ORIGIN.test(href)) return '';
  if (HAS_SCHEME.test(href)) return /^https:/i.test(href) ? href : '';
  return href;
}
