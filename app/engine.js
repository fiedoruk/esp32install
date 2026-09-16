/**
 * Install engine. The only module that touches Web Serial and esptool-js; both come in
 * through `createInstaller(deps)` so the whole flow runs against a fake in tests.
 *
 * Factory profile: connect → detect → match → security state → download + verify every part →
 * layout check → boot-image check → (optional backup) → (erase) → write with MD5 → hard reset.
 * Nothing is erased or written until every verification step has passed.
 * Preserve profile: see preserve.js; it shares connect/pick/download and never erases.
 */
import { InstallError } from './errors.js';
import { compatibleBuilds, mismatchReasons } from './match.js';
import { checkFetchedPart, checkLayout, checkBootImage, checkImageParts, sha256Hex } from './verify.js';
import { md5Hex } from './md5.js';
import { runPreserve } from './preserve.js';
import { checkSecurity } from './security.js';
import { readWholeFlash, backupFilename } from './backup.js';
import { etaSeconds } from './progress.js';

const BAUD = 460800;
const PART_MAX = 32 * 1024 * 1024;

/** An error's parameters for the technical log: offsets in hex, objects as JSON, bytes left out. */
function paramText(params) {
  const hexKeys = new Set(['offset', 'a', 'b', 'end', 'flashBytes', 'max']);
  const pairs = Object.entries(params ?? {})
    .filter(([, v]) => v !== undefined && !(v instanceof Uint8Array))
    .map(([k, v]) => `${k}=${typeof v === 'number' && hexKeys.has(k) ? '0x' + v.toString(16) : typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  return pairs.length ? ' (' + pairs.join(' ') + ')' : '';
}

/**
 * Turns whatever Web Serial or esptool-js throws into an InstallError with a known code.
 * An unrecognised error becomes `flash.write` only once a write has started; before that
 * the device is untouched, so it is reported as `engine.unexpected`.
 */
export function mapSerialError(err, { writing = false } = {}) {
  if (err instanceof InstallError) return err;
  const msg = String(err?.message ?? err ?? '');
  if (err?.name === 'NotFoundError' || /no port selected/i.test(msg)) return new InstallError('serial.cancelled', {}, err);
  if (err?.name === 'SecurityError') return new InstallError('serial.blocked', {}, err);
  if (/already open|failed to open|in use|access denied/i.test(msg)) return new InstallError('serial.busy', {}, err);
  if (/failed to connect|timed out waiting for packet|sync/i.test(msg)) return new InstallError('serial.connect', {}, err);
  if (/MD5 of file does not match|md5|hash of data/i.test(msg)) return new InstallError('flash.verify', {}, err);
  if (/device lost|disconnected|the device has been lost/i.test(msg)) return new InstallError('serial.lost', {}, err);
  return new InstallError(writing ? 'flash.write' : 'engine.unexpected', { detail: msg }, err);
}

/** Flash size in MB from the JEDEC id. Fails closed: no table entry means unknown, never 4 MB. */
export function flashSizeFromId(loader, id) {
  if (!Number.isInteger(id) || id === 0 || id === 0xffffff) throw new InstallError('device.flashUnknown', { id: (id ?? 0).toString(16) });
  const code = (id >> 16) & 0xff;
  const label = loader.DETECTED_FLASH_SIZES?.[code];
  const m = /^(\d+)MB$/.exec(label ?? '');
  if (!m) throw new InstallError('device.flashUnknown', { id: id.toString(16) });
  return Number(m[1]);
}

/**
 * Downloads one part. Network failures become `manifest.fetch` with status 0. Redirects are
 * followed, but the final response must stay on the origin the manifest layer validated.
 */
export async function fetchBytes(fetchFn, url, max) {
  let res;
  try {
    res = await fetchFn(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'follow' });
  } catch (err) {
    throw new InstallError('manifest.fetch', { status: 0, url }, err);
  }
  if (!res.ok) throw new InstallError('manifest.fetch', { status: res.status, url });
  const origin = new URL(res.url || url).origin; // a hand-built Response has url === ''
  if (origin !== new URL(url).origin) throw new InstallError('manifest.origin', { origin });
  let buf;
  try {
    buf = await res.arrayBuffer();
  } catch (err) {
    throw new InstallError('manifest.fetch', { status: 0, url }, err);
  }
  if (buf.byteLength > max) throw new InstallError('verify.tooLarge', { path: url, bytes: buf.byteLength, max });
  return new Uint8Array(buf);
}

/**
 * The own-file path by address: one URL the user typed, fetched with the same size limit as a
 * part and the same final-origin rule. The origin policy here is the user's own decision and the
 * page's `connect-src` decides what the browser will read; a fetch the browser refused (policy,
 * CORS, no network) is reported as `own.blocked`, an HTTP error stays `manifest.fetch`. The
 * bytes then go through `localManifest` and the identical check chain.
 */
export async function fetchOwnFile(fetchFn, address, base, max = PART_MAX) {
  let url;
  try { url = new URL(String(address ?? '').trim(), base); } catch (err) { throw new InstallError('own.blocked', {}, err); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new InstallError('own.blocked', {});
  url.username = '';
  url.password = '';
  let bytes;
  try {
    bytes = await fetchBytes(fetchFn, url.href, max);
  } catch (err) {
    if (err instanceof InstallError && err.code === 'manifest.fetch' && err.params.status === 0) throw new InstallError('own.blocked', {}, err);
    throw err;
  }
  let name = url.pathname.split('/').pop() || '';
  try { name = decodeURIComponent(name); } catch { /* keep as written */ }
  name ||= url.hostname;
  if (bytes.length === 0) throw new InstallError('verify.empty', { path: name });
  return { name, url: url.href, bytes };
}

export function createInstaller(deps) {
  const { esptool, requestPort, fetchFn, onEvent, chooseBuild, confirmErase, saveBackup } = deps;
  const now = deps.now ?? Date.now; // injectable clock, so a test can see an ETA without waiting
  // `changed` flips the moment an erase or a write begins: from then on the flash is no longer what
  // it was, and the page must not tell the person their device is unchanged.
  let busy = false, transport = null, loader = null, cancelled = false, lost = false, writing = false, changed = false;
  const emit = (e) => { try { onEvent?.(e); } catch { /* UI errors must not break the flow */ } };
  const stage = (s, percent, params = {}, eta) => emit({ type: 'stage', stage: s, percent, params, eta });
  const log = (line) => emit({ type: 'log', line: String(line) });
  const terminal = { clean() {}, write: log, writeLine: log };
  const check = () => { if (cancelled) throw new InstallError('serial.cancelled'); if (lost) throw new InstallError('serial.lost'); };

  async function cleanup() {
    if (transport) { try { await transport.disconnect(); } catch (e) { log('disconnect: ' + (e?.message ?? e)); } }
    transport = null; loader = null;
  }

  async function connect(build) {
    stage('connecting', 2);
    const filters = build?.usbVendorId !== undefined
      ? [{ usbVendorId: build.usbVendorId, ...(build.usbProductId !== undefined ? { usbProductId: build.usbProductId } : {}) }]
      : [];
    const port = await requestPort(filters);
    check(); // a cancel during the port picker must not reset the device
    transport = new esptool.Transport(port, false, true);
    transport.setDeviceLostCallback?.(() => { lost = true; log('device lost'); });
    loader = new esptool.ESPLoader({ transport, baudrate: BAUD, terminal, debugLogging: false });
    const description = await loader.main('default_reset');
    check();
    stage('detecting', 8);
    const chipFamily = String(loader.chip?.CHIP_NAME ?? '').trim();
    if (!chipFamily) throw new InstallError('device.chipUnknown');
    let features = [];
    try { features = (await loader.chip.getChipFeatures?.(loader)) ?? []; } catch (e) { log('features: ' + (e?.message ?? e)); }
    let chipDescription = String(description ?? chipFamily);
    try { chipDescription = String(await loader.chip.getChipDescription?.(loader) ?? chipDescription); } catch { /* keep description */ }
    const flashSizeMB = flashSizeFromId(loader, await loader.readFlashId());
    const info = port.getInfo?.() ?? {};
    const hw = { chipFamily, chipDescription, features, flashSizeMB, usbVendorId: info.usbVendorId, usbProductId: info.usbProductId };
    emit({ type: 'hardware', hw });
    log(`chip ${chipDescription}; flash ${flashSizeMB} MB; usb ${info.usbVendorId?.toString(16) ?? '-'}:${info.usbProductId?.toString(16) ?? '-'}`);
    return hw;
  }

  async function pick(manifest, hw) {
    stage('matching', 10);
    const fits = compatibleBuilds(manifest.builds, hw);
    if (fits.length === 0) {
      throw new InstallError('device.noMatch', { chip: hw.chipFamily, flash: hw.flashSizeMB + ' MB', reasons: mismatchReasons(manifest.builds, hw) });
    }
    const build = fits.length === 1 ? fits[0] : await chooseBuild(fits, hw);
    check();
    if (!build) throw new InstallError('serial.cancelled');
    emit({ type: 'build', build });
    return build;
  }

  /**
   * Downloads every part and verifies it in a fixed order: per part `checkFetchedPart`,
   * then `checkLayout` against the detected flash size, then `checkBootImage` and
   * `checkImageParts` against the chip esptool-js reported (`loader.chip.CHIP_NAME`,
   * never the description string). Both profiles come through here. A part that carries
   * `bytes` (the own-file path, see `localManifest`) is taken from memory: there is nothing
   * to fetch and no origin to hold it to, and every check after that point is the same.
   */
  async function download(build, hw) {
    const parts = [];
    const local = build.parts.every((p) => p.bytes instanceof Uint8Array);
    for (let i = 0; i < build.parts.length; i++) {
      const p = build.parts[i];
      stage('downloading', 12 + (i / build.parts.length) * 18, { name: p.path, local });
      const data = p.bytes instanceof Uint8Array ? p.bytes : await fetchBytes(fetchFn, p.url, PART_MAX);
      check();
      const { sha256 } = await checkFetchedPart(p, data);
      if (p.sha256 === undefined) log(`no checksum declared for ${p.path}; downloaded sha256 ${sha256}`);
      parts.push({ offset: p.offset, data, path: p.path, sha256 });
    }
    stage('verifying', 32, { local });
    checkLayout(parts, hw.flashSizeMB * 1024 * 1024);
    checkBootImage(parts, hw.chipFamily);
    checkImageParts(parts, hw.chipFamily);
    return parts;
  }

  async function erase() {
    stage('erasing', 35);
    changed = true;
    try {
      await loader.eraseFlash();
    } catch (err) {
      if (err instanceof InstallError) throw err;
      throw new InstallError('flash.erase', { detail: String(err?.message ?? err ?? '') }, err);
    }
  }

  /** Writes the verified parts. Erase is a separate step, so `eraseAll` is always false here. */
  async function write(parts) {
    const total = parts.reduce((n, p) => n + p.data.length, 0);
    let done = 0, startedAt = 0;
    writing = true;
    changed = true;
    await loader.writeFlash({
      fileArray: parts.map((p) => ({ data: p.data, address: p.offset })),
      flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep', eraseAll: false, compress: true,
      calculateMD5Hash: (image) => md5Hex(image),
      // esptool-js reports `written`/`partTotal` in compressed bytes; scale the per-part
      // fraction to the uncompressed size so the overall ratio stays in uncompressed bytes.
      reportProgress: (i, written, partTotal) => {
        startedAt ||= now();
        const before = parts.slice(0, i).reduce((n, p) => n + p.data.length, 0);
        const frac = partTotal > 0 ? Math.min(written / partTotal, 1) : 0;
        done = before + frac * parts[i].data.length;
        stage('writing', 40 + (done / total) * 50, { n: i + 1, total: parts.length, written, partTotal }, etaSeconds(startedAt, done, total, now));
      },
    });
  }

  async function runFactory(job) {
    const { manifest, mode } = job;
    const hw = await connect(manifest.builds.length === 1 ? manifest.builds[0] : null);
    const build = await pick(manifest, hw);
    // Before the erase and before the write: a board with secure boot or flash encryption would
    // take these plaintext bytes and stop booting. A chip that cannot say is not blocked here —
    // that is every ESP8266 and every classic ESP32 whose efuses did not read — and the reason
    // goes into the log.
    stage('checkingDevice', 11);
    await checkSecurity(loader, hw.chipFamily, log, { unknownIsLocked: false });
    check();
    const parts = await download(build, hw);
    check();
    // Optional keepsake copy (D-04): one read, saved, not re-verified and never a gate.
    if (job.options?.backup) {
      stage('backup', 33);
      const flashBytes = hw.flashSizeMB * 1024 * 1024;
      const startedAt = now();
      const bytes = await readWholeFlash(loader, flashBytes, (done, total) => stage('backup', 33 + (done / total) * 2, {}, etaSeconds(startedAt, done, total, now)));
      stage('backup', 35, { phase: 'save' }); // the page shows the save button on this event
      await saveBackup(bytes, backupFilename(manifest.name, await sha256Hex(bytes)));
      check();
    }
    // Nothing is erased without the dialog. A build with `eraseAll` erases whatever door the
    // person came through, including Update, where the door promised the settings could stay;
    // so that build gets a dialog that says the settings cannot be kept, and a No stops the
    // install rather than quietly installing without the erase the release asked for.
    let eraseFirst = false;
    if (build.eraseAll) {
      if (!await confirmErase(build, mode, { required: true })) throw new InstallError('serial.cancelled');
      eraseFirst = true;
    } else if (manifest.promptErase) {
      eraseFirst = await confirmErase(build, mode, { required: false });
    }
    check();
    // Last cancellation point. Once the erase has started the flash is already blank, so
    // stopping here would leave a dead device; the write runs to completion regardless.
    if (eraseFirst) await erase();
    await write(parts);
    stage('md5', 92);
    // The image is written and MD5-verified by now; a failed reset is not a failed install.
    try {
      await loader.after('hard_reset');
    } catch (e) {
      log('reset: ' + (e?.message ?? e) + '; press the reset button or unplug and replug the device');
    }
    stage('done', 100);
    return {
      verified: true,
      version: manifest.version,
      build: build.boardKey,
      parts: parts.map((p) => ({ path: p.path, offset: p.offset, sha256: p.sha256 })),
    };
  }

  return {
    async run(job) {
      if (busy) throw new InstallError('engine.busy');
      busy = true; cancelled = false; lost = false; writing = false; changed = false;
      try {
        const profile = job.manifest.profile;
        const result = profile === 'preserve'
          ? await runPreserve({ job, connect, pick, download, loader: () => loader, stage, log, emit, check, deps, now, setWriting: () => { writing = true; changed = true; } })
          : await runFactory(job);
        await cleanup();
        emit({ type: 'done', result });
        return result;
      } catch (err) {
        const error = mapSerialError(err, { writing });
        log('ERROR ' + error.code + paramText(error.params) + (error.cause?.message ? ': ' + error.cause.message : ''));
        await cleanup();
        emit({ type: 'error', error, changed });
        throw error;
      } finally { busy = false; }
    },
    cancel() { cancelled = true; },
  };
}
