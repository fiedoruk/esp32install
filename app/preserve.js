/**
 * Preserve profile: writes the release parts into a device that keeps its factory
 * bootloader, partition table and data. Every check is a hard stop before the first
 * write, and there is no erase path: this module never calls `eraseFlash`.
 *
 * Order: connect → match → security state → identity (MAC) → header read + layout
 * checks → download + verify → mandatory verified backup, saved where the user chooses and
 * read back from disk (or, without a save picker, downloaded and re-selected by the user)
 * → identity + header re-check → write part by part with an MD5 read-back →
 * read-back of everything outside the written parts → hard reset.
 */
import { InstallError } from './errors.js';
import { sha256Hex } from './verify.js';
import { md5Hex } from './md5.js';
import { readRange, verifiedBackup, matchesBackup, backupFilename, readBackHandle } from './backup.js';
import { etaSeconds } from './progress.js';

const PAGE = 0x1000;
const fail = (code, params = {}) => { throw new InstallError(code, params); };
const hex = (n) => '0x' + n.toString(16);

/** Index of the first byte in `[from, to)` where `a` and `b` differ, or -1. */
function differs(a, b, from = 0, to = a.length) {
  for (let i = from; i < to; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/** Security info: the flags word (bytes 0-3) and the flash-encryption count (byte 4) must both be zero. */
async function assertUnlocked(loader, log) {
  let info;
  try {
    info = await loader.checkCommand('security info', 0x14, new Uint8Array(0), 0, 20, 5000);
  } catch (err) {
    log('security info: ' + (err?.message ?? err) + '; treating the device as locked');
    fail('device.secured', { reason: 'unsupported' });
  }
  if (!(info instanceof Uint8Array) || info.length !== 20) fail('device.secured', { reason: 'malformed' });
  const flags = (info[0] | (info[1] << 8) | (info[2] << 16) | (info[3] << 24)) >>> 0;
  if (flags !== 0 || info[4] !== 0) fail('device.secured', { flags: hex(flags), cryptCount: info[4] });
}

const sectorDown = (n) => Math.floor(n / PAGE) * PAGE;
const sectorUp = (n) => Math.ceil(n / PAGE) * PAGE;

/**
 * The page at `update.tableOffset`: in update mode it must hold this release's table, padded
 * with 0xff. The manifest layer already requires the offset and a part at it for `preserve`;
 * this repeats the check so the flow fails closed even on a build that skipped that layer.
 */
function tablePageOf(build) {
  const offset = build.compatibility.update.tableOffset;
  const part = offset === undefined ? undefined : build.parts.find((p) => p.offset === offset);
  if (!part) fail('manifest.compatibility', { boardKey: build.boardKey });
  return { offset, size: Math.max(PAGE, part.size), part };
}

/** The header spans every range the manifest makes a claim about, table page included, in either mode. */
function headerSizeOf(compat, tablePage) {
  const ranges = [...compat.regions, ...compat.firstInstall.regions, ...compat.firstInstall.empty];
  if (tablePage) ranges.push({ offset: tablePage.offset, size: sectorUp(tablePage.offset + tablePage.size) - tablePage.offset });
  return ranges.reduce((n, r) => Math.max(n, r.offset + r.size), 0);
}

async function checkHeader(header, build, mode, tablePage) {
  const compat = build.compatibility;
  const region = async (r) => {
    // A region without a checksum makes a claim this installer cannot check: fail closed.
    if (!r.sha256) fail('manifest.compatibility', { boardKey: build.boardKey });
    if ((await sha256Hex(header.subarray(r.offset, r.offset + r.size))) !== r.sha256) fail('device.layout', { offset: hex(r.offset), size: r.size });
  };
  for (const r of compat.regions) await region(r);
  if (mode === 'update') {
    const { offset, size, part } = tablePage;
    const page = header.subarray(offset, offset + size);
    if ((await sha256Hex(page.subarray(0, part.size))) !== part.sha256) fail('device.layout', { offset: hex(offset), size: part.size });
    if (page.subarray(part.size).some((b) => b !== 0xff)) fail('device.layout', { offset: hex(offset), size });
    return;
  }
  for (const r of compat.firstInstall.regions) await region(r);
  for (const r of compat.firstInstall.empty) {
    const i = header.subarray(r.offset, r.offset + r.size).findIndex((b) => b !== 0xff);
    if (i >= 0) fail('device.notEmpty', { offset: hex(r.offset + i) });
  }
}

/** Writes one part at a time, `eraseAll` false, and cross-checks each with the chip's own MD5. */
async function writeParts(loader, parts, stage, now) {
  const total = parts.reduce((n, p) => n + p.data.length, 0);
  let before = 0, startedAt = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    await loader.writeFlash({
      fileArray: [{ data: p.data, address: p.offset }],
      flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep', eraseAll: false, compress: true,
      calculateMD5Hash: (image) => md5Hex(image),
      reportProgress: (_, written, partTotal) => {
        startedAt ||= now();
        const done = before + (partTotal > 0 ? Math.min(written / partTotal, 1) : 0) * p.data.length;
        stage('writing', 40 + (done / total) * 50, { n: i + 1, total: parts.length, written, partTotal }, etaSeconds(startedAt, done, total, now));
      },
    });
    const onChip = String(await loader.flashMd5sum(p.offset, p.data.length)).toLowerCase();
    if (onChip !== md5Hex(p.data)) fail('flash.verify', { offset: hex(p.offset), path: p.path });
    before += p.data.length;
  }
}

/**
 * The chip erases every whole 4 KiB sector a write touches. So inside each written part's
 * sector-aligned span the bytes outside the part must read back 0xff, and every byte
 * outside all spans must read back exactly as before the write.
 */
function checkUntouched(before, after, parts) {
  const spans = parts.map((p) => ({ start: sectorDown(p.offset), end: sectorUp(p.offset + p.data.length), from: p.offset, to: p.offset + p.data.length }))
    .sort((a, b) => a.start - b.start);
  let pos = 0;
  for (const span of [...spans, { start: before.length, end: before.length, from: before.length, to: before.length }]) {
    const i = differs(before, after, pos, Math.min(span.start, before.length));
    if (i >= 0) fail('flash.verify', { offset: hex(i) });
    for (const [a, b] of [[span.start, span.from], [span.to, span.end]]) {
      for (let j = Math.max(a, pos); j < Math.min(b, before.length); j++) if (after[j] !== 0xff) fail('flash.verify', { offset: hex(j) });
    }
    pos = Math.max(pos, span.end);
  }
}

export async function runPreserve(ctx) {
  const { job, connect, pick, download, stage, log, check, deps } = ctx;
  const { manifest, mode } = job;
  const now = ctx.now ?? Date.now;
  const loader = () => ctx.loader();
  const hw = await connect(manifest.builds.length === 1 ? manifest.builds[0] : null);
  const build = await pick(manifest, hw);
  const flashBytes = hw.flashSizeMB * 1024 * 1024;

  stage('checkingDevice', 11);
  await assertUnlocked(loader(), log);
  const mac = String(await loader().chip.readMac(loader()));
  const sameDevice = async () => {
    const now = String(await loader().chip.readMac(loader()));
    if (now !== mac) fail('device.changed', { expected: mac, actual: now });
  };
  check();
  const tablePage = tablePageOf(build);
  const headerSize = headerSizeOf(build.compatibility, tablePage);
  if (headerSize > flashBytes) fail('device.layout', { offset: hex(headerSize), flashBytes });
  const header = await readRange(loader(), 0, headerSize);
  await checkHeader(header, build, mode, tablePage);
  log(`device ${mac}: the first ${headerSize} bytes match the release (${mode})`);
  check();

  const parts = await download(build, hw);
  check();

  // Mandatory backup: two reads that agree, saved, then proven to be on disk before the
  // write relies on it. With a save handle the page reads the file back itself; without
  // one the user re-selects the download and the page checks that.
  await sameDevice();
  stage('backup', 33);
  const backupStartedAt = now();
  // Two full reads of the flash: the estimate covers both, from the rate of the first chunks.
  const backup = await verifiedBackup(loader(), flashBytes, (done, total) => stage('backup', 33 + (done / total) * 6, {}, etaSeconds(backupStartedAt, done, total, now)));
  if (differs(backup.bytes, header, 0, headerSize) >= 0) fail('device.changed', { reason: 'header' });
  const suggested = backupFilename(manifest.name, backup.sha256);
  stage('backup', 39, { phase: 'save' });
  const saved = await deps.saveBackup(backup.bytes, suggested);
  const filename = saved?.handle ? saved.name : suggested;
  log(`backup ${filename} sha256 ${backup.sha256}`);
  check();
  if (saved?.handle) {
    // The same handle the bytes went through: what comes back must be the copy, whole.
    stage('backup', 39, { phase: 'readBack', file: filename });
    const back = await readBackHandle(saved.handle);
    check();
    if (back.length !== flashBytes || (await sha256Hex(back)) !== backup.sha256) fail('backup.file', { filename });
  } else {
    // The dialog names the file, so the user knows what to look for in the browser's download folder.
    const file = await deps.requestBackupFile(filename);
    check();
    if (!file) fail('serial.cancelled');
    if (!(await matchesBackup(file, backup.sha256, flashBytes))) fail('backup.file', { filename });
  }
  check();

  // Last checks before the first write, then no cancellation until the parts are on the chip.
  await sameDevice();
  const again = await readRange(loader(), 0, headerSize);
  if (differs(again, header) >= 0) fail('device.changed', { reason: 'header' });
  check();
  ctx.setWriting();
  await writeParts(loader(), parts, stage, now);
  stage('md5', 92);
  checkUntouched(header, await readRange(loader(), 0, headerSize), parts);
  // The parts are written and verified by now; a failed reset is not a failed install.
  try {
    await loader().after('hard_reset');
  } catch (e) {
    log('reset: ' + (e?.message ?? e) + '; press the reset button or unplug and replug the device');
  }
  stage('done', 100);
  return {
    verified: true,
    version: manifest.version,
    build: build.boardKey,
    parts: parts.map((p) => ({ path: p.path, offset: p.offset, sha256: p.sha256 })),
    backup: { sha256: backup.sha256, filename },
  };
}
