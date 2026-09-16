import { InstallError } from './errors.js';
import { sha256Hex } from './verify.js';

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

/**
 * `preserve` needs everything it will compare to be checkable up front: a checksum on every
 * region, and a partition-table offset that one of the parts is written at. A manifest that
 * would only be refused after the device has been opened is refused here instead.
 */
function normalizeCompatibility(raw, boardKey, profile, parts) {
  const preserve = profile === 'preserve';
  if (raw == null) {
    if (preserve) fail('manifest.compatibility', { boardKey });
    return undefined;
  }
  if (!isPlainObject(raw)) fail('manifest.compatibility', { boardKey });
  const region = (r, hashed) => {
    if (!isPlainObject(r) || !isInt(r.offset) || r.offset < 0 || !isInt(r.size) || r.size <= 0) fail('manifest.compatibility', { boardKey });
    if (r.sha256 !== undefined && !HEX64.test(String(r.sha256).toLowerCase())) fail('manifest.compatibility', { boardKey });
    if (hashed && preserve && r.sha256 === undefined) fail('manifest.compatibility', { boardKey });
    return { offset: r.offset, size: r.size, ...(r.sha256 ? { sha256: String(r.sha256).toLowerCase() } : {}) };
  };
  const list = (v, hashed) => (Array.isArray(v) ? v.map((r) => region(r, hashed)) : []);
  const tableOffset = raw.update?.tableOffset;
  if (tableOffset !== undefined && (!isInt(tableOffset) || tableOffset < 0)) fail('manifest.compatibility', { boardKey });
  const out = {
    regions: list(raw.regions, true),
    firstInstall: { regions: list(raw.firstInstall?.regions, true), empty: list(raw.firstInstall?.empty, false) },
    update: { tableOffset },
  };
  if (preserve) {
    if (out.regions.length + out.firstInstall.regions.length === 0) fail('manifest.compatibility', { boardKey });
    if (tableOffset === undefined || !parts.some((p) => p.offset === tableOffset)) fail('manifest.compatibility', { boardKey });
  }
  return out;
}

function normalizePart(p, i, boardKey, base, allowOrigins, profile) {
  if (!isPlainObject(p)) fail('manifest.part', { boardKey, index: i + 1 });
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
  if (!isPlainObject(b)) fail('manifest.build', { index: i + 1 });
  const boardKey = b.boardKey === undefined ? `build-${i + 1}` : String(b.boardKey);
  if (!KEY.test(boardKey)) fail('manifest.boardKey', { index: i + 1 });
  if (!CHIP_FAMILIES.has(b.chipFamily)) fail('manifest.chipFamily', { boardKey, chipFamily: String(b.chipFamily) });
  // The engine dispatches on the manifest's profile, so a build may repeat it but never change it:
  // a `preserve` build inside a `factory` manifest would otherwise run through the erase path.
  const profile = manifest.profile;
  if (b.profile !== undefined && b.profile !== profile) fail('manifest.profile', { boardKey });
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
  // `improv` is esp-web-tools' own key: the firmware takes Wi-Fi credentials over the cable after
  // it boots. Absent means "ask anyway"; false means "do not ask"; anything else is refused.
  if (b.improv !== undefined && b.improv !== null && typeof b.improv !== 'boolean') fail('manifest.improv', { boardKey });
  if (!Array.isArray(b.parts) || b.parts.length === 0) fail('manifest.noParts', { boardKey });
  const parts = b.parts.map((p, j) => normalizePart(p, j, boardKey, base, allowOrigins, profile));
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
    improv: typeof b.improv === 'boolean' ? b.improv : undefined,
    compatibility: normalizeCompatibility(b.compatibility, boardKey, profile, parts),
    parts,
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

const PART_MAX = 32 * 1024 * 1024;
const SECTOR = 0x1000;

/**
 * The own-file path: a file the user picked, held in memory, with no manifest, no server and no
 * download. Returns the shape `normalizeManifest` returns, always the `factory` profile with one
 * build called `local`, and `size` and `sha256` measured from the bytes so the engine holds the
 * part to them with the same checks a release gets. Each part carries `bytes` and no `url`.
 * A part written at 0 replaces the whole system and asks about erasing like a release with
 * `new_install_prompt_erase`; anything written elsewhere never erases, because the bootloader
 * and partition table it relies on are already on the device. `preserve` is refused: a local file
 * carries no compatibility data to hold the device to.
 */
export async function localManifest({ name, chipFamily, parts, profile = 'factory' } = {}) {
  if (profile !== 'factory') fail('manifest.profile', { boardKey: 'local' });
  if (typeof name !== 'string' || !name.trim()) fail('manifest.name', {});
  if (!CHIP_FAMILIES.has(chipFamily)) fail('manifest.chipFamily', { boardKey: 'local', chipFamily: String(chipFamily) });
  if (!Array.isArray(parts) || parts.length === 0) fail('manifest.noParts', { boardKey: 'local' });
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!isPlainObject(p) || !(p.bytes instanceof Uint8Array)) fail('manifest.part', { boardKey: 'local', index: i + 1 });
    const path = typeof p.path === 'string' && p.path.trim() ? p.path : name;
    if (p.bytes.length === 0) fail('verify.empty', { path });
    if (p.bytes.length > PART_MAX) fail('verify.tooLarge', { path, bytes: p.bytes.length, max: PART_MAX });
    if (!isInt(p.offset) || p.offset < 0 || p.offset % SECTOR !== 0) fail('manifest.offset', { boardKey: 'local', index: i + 1 });
    out.push({ path, offset: p.offset, size: p.bytes.length, sha256: await sha256Hex(p.bytes), bytes: p.bytes });
  }
  return {
    name, version: out[0].sha256.slice(0, 8), schema: 2,
    profile: 'factory',
    promptErase: out.some((p) => p.offset === 0),
    eraseAll: false,
    builds: [{
      boardKey: 'local', board: chipFamily, chipFamily,
      flashSizeMB: undefined, usbVendorId: undefined, usbProductId: undefined,
      chipDescriptionIncludes: [], featuresAll: [],
      profile: 'factory', eraseAll: false, improv: undefined, compatibility: undefined,
      parts: out,
    }],
  };
}
