/**
 * Whole-flash backup. The preserve profile requires a verified copy before it writes
 * anything (D-04); the factory profile offers the same read as an optional keepsake.
 * Reads go through `loader.readFlash` in 256 KiB chunks so progress can be reported.
 */
import { InstallError } from './errors.js';
import { sha256Hex } from './verify.js';

export const CHUNK = 256 * 1024;

/** Reads `[start, start + length)` chunk by chunk. A short read is an error, never a truncated copy. */
export async function readRange(loader, start, length, onProgress) {
  const out = new Uint8Array(length);
  for (let done = 0; done < length; done += CHUNK) {
    const n = Math.min(CHUNK, length - done);
    const chunk = await loader.readFlash(start + done, n);
    if (!(chunk instanceof Uint8Array) || chunk.length !== n) {
      throw new InstallError('backup.mismatch', { offset: start + done, expected: n, got: chunk?.length ?? 0 });
    }
    out.set(chunk, done);
    onProgress?.(done + n, length);
  }
  return out;
}

export function readWholeFlash(loader, flashBytes, onProgress) {
  return readRange(loader, 0, flashBytes, onProgress);
}

/** Two full reads that must agree byte for byte. Returns the copy and its sha256. */
export async function verifiedBackup(loader, flashBytes, onProgress) {
  const total = flashBytes * 2;
  const first = await readRange(loader, 0, flashBytes, (done) => onProgress?.(done, total));
  const second = await readRange(loader, 0, flashBytes, (done) => onProgress?.(flashBytes + done, total));
  for (let i = 0; i < flashBytes; i++) {
    if (first[i] !== second[i]) throw new InstallError('backup.mismatch', { offset: i });
  }
  return { bytes: first, sha256: await sha256Hex(first) };
}

/** `<name>-backup-<first 8 hex of sha256>.bin`, with characters a file system would reject replaced. */
export function backupFilename(name, sha256) {
  return `${String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')}-backup-${sha256.slice(0, 8)}.bin`;
}

/** True when the file the user picked is byte-identical to the backup we saved (by size, then sha256). */
export async function matchesBackup(file, sha256, size) {
  if (size !== undefined && file.size !== size) return false;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (size !== undefined && bytes.length !== size) return false;
  return (await sha256Hex(bytes)) === sha256;
}

/**
 * Browser helper for `deps.saveBackup` on browsers with the File System Access API: the user
 * picks where the copy goes, the bytes are written through the handle, and the same handle is
 * returned so the caller can read the file back and prove it landed. `picker` defaults to
 * `showSaveFilePicker`; without one (Firefox, Brave, Safari) this returns `null` and the caller
 * falls back to `saveBlob`. Cancelling the picker is `serial.cancelled`, not a crash.
 * Needs a user gesture: call it from a click handler.
 */
export async function saveBackupWithHandle(bytes, filename, { picker = defaultPicker() } = {}) {
  if (typeof picker !== 'function') return null;
  let handle;
  try {
    handle = await picker({ suggestedName: filename, types: [{ description: 'Device backup', accept: { 'application/octet-stream': ['.bin'] } }] });
  } catch (err) {
    if (err?.name === 'AbortError') throw new InstallError('serial.cancelled', {}, err);
    throw err;
  }
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
  } catch (err) {
    try { await writable.abort(); } catch { /* the write error is the one to report */ }
    throw err;
  }
  await writable.close();
  return { handle, name: String(handle.name ?? filename) };
}

function defaultPicker() {
  const g = globalThis;
  return typeof g.showSaveFilePicker === 'function' ? (options) => g.showSaveFilePicker(options) : null;
}

/** The bytes the file behind `handle` holds now, read fresh from disk. */
export async function readBackHandle(handle) {
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

/** Browser helper for `deps.saveBackup`: offers `bytes` as a download named `filename`. */
export async function saveBlob(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
