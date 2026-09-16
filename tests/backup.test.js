import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWholeFlash, verifiedBackup, matchesBackup, saveBackupWithHandle, readBackHandle } from '../app/backup.js';
import { sha256Hex } from '../app/verify.js';

const MiB = 1024 * 1024;

/** A loader whose flash is `image`; `tamper(addr, index, out)` may alter what a read returns. */
function loaderOf(image, tamper) {
  const reads = [];
  let index = 0;
  return {
    reads,
    async readFlash(addr, n) {
      reads.push([addr, n]);
      const out = image.slice(addr, addr + n);
      tamper?.(addr, index++, out);
      return out;
    },
  };
}
function image(bytes) { const d = new Uint8Array(bytes); for (let i = 0; i < d.length; i++) d[i] = (i * 7 + (i >> 8)) & 0xff; return d; }

test('readWholeFlash reads the whole device in 256 KiB chunks and reports progress', async () => {
  const img = image(1 * MiB);
  const loader = loaderOf(img);
  const progress = [];
  const bytes = await readWholeFlash(loader, img.length, (done, total) => progress.push([done, total]));
  assert.deepEqual(bytes, img);
  assert.equal(loader.reads.length, 4);
  assert.deepEqual(loader.reads[0], [0, 256 * 1024]);
  assert.deepEqual(loader.reads.at(-1), [3 * 256 * 1024, 256 * 1024]);
  assert.deepEqual(progress.at(-1), [img.length, img.length]);
});

test('readWholeFlash: a short read is an error, never a silently truncated copy', async () => {
  const img = image(512 * 1024);
  const loader = { async readFlash(addr, n) { return img.slice(addr, addr + n - 1); } };
  await assert.rejects(readWholeFlash(loader, img.length), (e) => e.code === 'backup.mismatch');
});

test('verifiedBackup reads twice, returns the bytes and their sha256', async () => {
  const img = image(512 * 1024);
  const loader = loaderOf(img);
  const { bytes, sha256 } = await verifiedBackup(loader, img.length);
  assert.deepEqual(bytes, img);
  assert.equal(sha256, await sha256Hex(img));
  assert.equal(loader.reads.length, 4, 'two full passes of two chunks each');
});

test('verifiedBackup: a byte that differs between the two reads → backup.mismatch', async () => {
  const img = image(512 * 1024);
  const loader = loaderOf(img, (addr, index, out) => { if (index === 3) out[100] ^= 0x01; });
  await assert.rejects(verifiedBackup(loader, img.length), (e) => e.code === 'backup.mismatch');
});

test('matchesBackup: same bytes → true; wrong size → false without reading; wrong hash → false', async () => {
  const img = image(64 * 1024);
  const sha = await sha256Hex(img);
  let read = 0;
  const file = (bytes) => ({ size: bytes.length, arrayBuffer: async () => { read++; return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); } });
  assert.equal(await matchesBackup(file(img), sha), true);
  assert.equal(await matchesBackup(file(img), sha, img.length), true);
  read = 0;
  assert.equal(await matchesBackup(file(img.slice(0, 1000)), sha, img.length), false);
  assert.equal(read, 0, 'size mismatch must not read the file');
  const other = img.slice(); other[5] ^= 0xff;
  assert.equal(await matchesBackup(file(other), sha, img.length), false);
  assert.equal(await matchesBackup(file(img), 'f'.repeat(64)), false);
});

/* --- Saving through a file handle ---------------------------------------- */

/** A fake `showSaveFilePicker`: records the options, hands out a handle that keeps what was written. */
function pickerOf({ name = 'chosen.bin', abort = false, failWrite = false } = {}) {
  const log = { options: null, written: [], closed: 0, aborted: 0 };
  const handle = {
    name,
    async createWritable() {
      return {
        async write(bytes) { if (failWrite) throw new Error('disk full'); log.written.push(new Uint8Array(bytes)); },
        async close() { log.closed++; },
        async abort() { log.aborted++; },
      };
    },
    async getFile() { const bytes = log.written.at(-1) ?? new Uint8Array(0); return { size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(0) }; },
  };
  const picker = async (options) => {
    log.options = options;
    if (abort) { const e = new Error('The user aborted a request.'); e.name = 'AbortError'; throw e; }
    return handle;
  };
  return { picker, handle, log };
}

test('saveBackupWithHandle writes the exact bytes through the picked handle and returns the handle and its name', async () => {
  const img = image(300 * 1024);
  const { picker, handle, log } = pickerOf({ name: 'renamed-by-user.bin' });
  const r = await saveBackupWithHandle(img, 'Home-backup-01234567.bin', { picker });
  assert.equal(r.handle, handle);
  assert.equal(r.name, 'renamed-by-user.bin', 'the name is the one the user ended up with, not the suggestion');
  assert.equal(log.options.suggestedName, 'Home-backup-01234567.bin');
  assert.deepEqual(log.options.types, [{ description: 'Device backup', accept: { 'application/octet-stream': ['.bin'] } }]);
  assert.equal(log.written.length, 1);
  assert.deepEqual(log.written[0], img);
  assert.equal(log.closed, 1, 'the stream is closed, so the bytes are on disk');
  assert.equal(log.aborted, 0);
});

test('saveBackupWithHandle: no picker in this browser → null, nothing else touched', async () => {
  assert.equal(await saveBackupWithHandle(image(16), 'x.bin', { picker: undefined }), null);
  assert.equal(await saveBackupWithHandle(image(16), 'x.bin', { picker: null }), null);
});

test('saveBackupWithHandle: the user cancels the picker (AbortError) → serial.cancelled, nothing written', async () => {
  const { picker, log } = pickerOf({ abort: true });
  await assert.rejects(saveBackupWithHandle(image(16), 'x.bin', { picker }), (e) => e.code === 'serial.cancelled' && e.cause?.name === 'AbortError');
  assert.equal(log.written.length, 0);
});

test('saveBackupWithHandle: a failed write aborts the stream and rethrows; a non-abort picker error is not a cancellation', async () => {
  const { picker, log } = pickerOf({ failWrite: true });
  await assert.rejects(saveBackupWithHandle(image(16), 'x.bin', { picker }), /disk full/);
  assert.equal(log.aborted, 1);
  assert.equal(log.closed, 0);
  const denied = async () => { const e = new Error('no activation'); e.name = 'NotAllowedError'; throw e; };
  await assert.rejects(saveBackupWithHandle(image(16), 'x.bin', { picker: denied }), (e) => e.name === 'NotAllowedError');
});

test('readBackHandle returns what the handle holds, as bytes', async () => {
  const img = image(70 * 1024);
  const { picker, handle } = pickerOf();
  await saveBackupWithHandle(img, 'x.bin', { picker });
  const back = await readBackHandle(handle);
  assert.ok(back instanceof Uint8Array);
  assert.deepEqual(back, img);
});
