import { InstallError } from './errors.js';

export const CHIP_FAMILIES = new Set(['ESP8266', 'ESP32', 'ESP32-S2', 'ESP32-S3', 'ESP32-C2', 'ESP32-C3',
  'ESP32-C5', 'ESP32-C6', 'ESP32-C61', 'ESP32-H2', 'ESP32-P4']);
const HEX64 = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

const isInt = (v) => Number.isSafeInteger(v);
const fail = (code, params) => { throw new InstallError(code, params); };
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function resolveUrl(path, base, allowOrigins) {
  if (typeof path !== 'string' || !path.trim()) fail('manifest.path', {});
  let url;
  try {
    url = new URL(path, base);
  } catch {
    fail('manifest.path', {});
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail('manifest.origin', { origin: url.origin });
  if (url.origin !== base.origin && !allowOrigins.includes(url.origin)) fail('manifest.origin', { origin: url.origin });
  url.username = '';
  url.password = '';
  return url.href;
}

function normalizeCompatibility(raw, boardKey, profile) {
  if (raw == null) {
    if (profile === 'preserve') fail('manifest.compatibility', { boardKey });
    return undefined;
  }
  if (!isPlainObject(raw)) fail('manifest.compatibility', { boardKey });
  const region = (r) => {
    if (!isPlainObject(r) || !isInt(r.offset) || r.offset < 0 || !isInt(r.size) || r.size <= 0) fail('manifest.compatibility', { boardKey });
    if (r.sha256 !== undefined && !HEX64.test(String(r.sha256).toLowerCase())) fail('manifest.compatibility', { boardKey });
    return { offset: r.offset, size: r.size, ...(r.sha256 ? { sha256: String(r.sha256).toLowerCase() } : {}) };
  };
  const list = (v) => (Array.isArray(v) ? v.map(region) : []);
  const tableOffset = raw.update?.tableOffset;
  if (tableOffset !== undefined && (!isInt(tableOffset) || tableOffset < 0)) fail('manifest.compatibility', { boardKey });
  const out = {
    regions: list(raw.regions),
    firstInstall: { regions: list(raw.firstInstall?.regions), empty: list(raw.firstInstall?.empty) },
    update: { tableOffset },
  };
  if (profile === 'preserve' && out.regions.length + out.firstInstall.regions.length === 0) {
    fail('manifest.compatibility', { boardKey });
  }
  return out;
}

function normalizePart(p, i, boardKey, base, allowOrigins, profile) {
  if (!p || typeof p !== 'object') fail('manifest.part', { boardKey, index: i + 1 });
  const url = resolveUrl(p.path, base, allowOrigins);
  if (!isInt(p.offset) || p.offset < 0) fail('manifest.offset', { boardKey, index: i + 1 });
  const part = { path: p.path, url, offset: p.offset };
  if (p.size !== undefined) {
    if (!isInt(p.size) || p.size <= 0) fail('manifest.size', { boardKey, index: i + 1 });
    part.size = p.size;
  }
  if (p.sha256 !== undefined) {
    const h = String(p.sha256).toLowerCase();
    if (!HEX64.test(h)) fail('manifest.sha256', { boardKey, index: i + 1 });
    part.sha256 = h;
  }
  if (profile === 'preserve' && (part.size === undefined || part.sha256 === undefined)) {
    fail('manifest.preserveNeedsSize', { boardKey, index: i + 1 });
  }
  return part;
}

function normalizeBuild(b, i, manifest, base, allowOrigins) {
  if (!b || typeof b !== 'object') fail('manifest.build', { index: i + 1 });
  const boardKey = b.boardKey === undefined ? `build-${i + 1}` : String(b.boardKey);
  if (!KEY.test(boardKey)) fail('manifest.boardKey', { index: i + 1 });
  if (!CHIP_FAMILIES.has(b.chipFamily)) fail('manifest.chipFamily', { boardKey, chipFamily: String(b.chipFamily) });
  const profile = b.profile ?? manifest.profile;
  if (profile !== 'factory' && profile !== 'preserve') fail('manifest.profile', { boardKey });
  const eraseAll = Boolean(b.eraseAll ?? manifest.eraseAll);
  if (profile === 'preserve' && eraseAll) fail('manifest.preserveNoErase', { boardKey });
  const optInt = (v, code, max) => {
    if (v === undefined || v === null) return undefined;
    if (!isInt(v) || v < 0 || v > max) fail(code, { boardKey });
    return v;
  };
  const strList = (v, code) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) fail(code, { boardKey });
    return [...v];
  };
  if (!Array.isArray(b.parts) || b.parts.length === 0) fail('manifest.noParts', { boardKey });
  return {
    boardKey,
    board: typeof b.board === 'string' && b.board.trim() ? b.board : (typeof b.name === 'string' ? b.name : boardKey),
    chipFamily: b.chipFamily,
    flashSizeMB: optInt(b.flashSizeMB, 'manifest.flashSizeMB', 1024),
    usbVendorId: optInt(b.usbVendorId, 'manifest.usb', 0xffff),
    usbProductId: optInt(b.usbProductId, 'manifest.usb', 0xffff),
    chipDescriptionIncludes: strList(b.chipDescriptionIncludes, 'manifest.filters'),
    featuresAll: strList(b.featuresAll, 'manifest.filters'),
    profile,
    eraseAll,
    compatibility: normalizeCompatibility(b.compatibility, boardKey, profile),
    parts: b.parts.map((p, j) => normalizePart(p, j, boardKey, base, allowOrigins, profile)),
  };
}

/**
 * Accepts an esp-web-tools manifest (schema 1) or the esp32install superset (schema 2)
 * and returns one normalized shape. Throws InstallError with code `manifest.*`.
 */
export function normalizeManifest(raw, manifestUrl, policy = {}) {
  const allowOrigins = Array.isArray(policy.allowOrigins) ? policy.allowOrigins.filter((o) => typeof o === 'string') : [];
  let base;
  try {
    base = new URL(manifestUrl);
  } catch {
    fail('manifest.url', { url: String(manifestUrl) });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('manifest.notObject', {});
  const schema = raw.schema === undefined ? 1 : raw.schema;
  if (schema !== 1 && schema !== 2) fail('manifest.schema', { schema: String(schema) });
  if (typeof raw.name !== 'string' || !raw.name.trim()) fail('manifest.name', {});
  const version = typeof raw.version === 'number' && Number.isFinite(raw.version) ? String(raw.version) : raw.version;
  if (typeof version !== 'string' || !version.trim()) fail('manifest.version', {});
  if (!Array.isArray(raw.builds) || raw.builds.length === 0) fail('manifest.noBuilds', {});
  const manifest = {
    name: raw.name, version, schema,
    profile: raw.profile ?? 'factory',
    promptErase: Boolean(raw.new_install_prompt_erase),
    eraseAll: Boolean(raw.eraseAll),
    builds: [],
  };
  if (manifest.profile !== 'factory' && manifest.profile !== 'preserve') fail('manifest.profile', { boardKey: '*' });
  const seen = new Set();
  manifest.builds = raw.builds.map((b, i) => {
    const nb = normalizeBuild(b, i, manifest, base, allowOrigins);
    if (seen.has(nb.boardKey)) fail('manifest.duplicateBoardKey', { boardKey: nb.boardKey });
    seen.add(nb.boardKey);
    return nb;
  });
  return manifest;
}
