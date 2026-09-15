import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHIPS, sha256Hex, checkFetchedPart, checkLayout, checkBootImage, esptoolCommand } from '../app/verify.js';

const bytes = (n, fill = 0) => new Uint8Array(n).fill(fill);

test('chip table carries offsets and image chip ids measured from esptool-js 0.6.1', () => {
  assert.equal(CHIPS['ESP32'].bootloaderOffset, 0x1000);
  assert.equal(CHIPS['ESP32'].imageChipId, 0);
  assert.equal(CHIPS['ESP32-S3'].bootloaderOffset, 0x0);
  assert.equal(CHIPS['ESP32-S3'].imageChipId, 9);
  assert.equal(CHIPS['ESP32-C6'].bootloaderOffset, 0x0);
  assert.equal(CHIPS['ESP32-C6'].imageChipId, 13);
  assert.equal(CHIPS['ESP32-P4'].bootloaderOffset, 0x2000);
  assert.equal(CHIPS['ESP32-C5'].bootloaderOffset, 0x2000);
  assert.equal(CHIPS['ESP32-C61'].bootloaderOffset, null);
});

test('sha256Hex matches a known vector', async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('checkFetchedPart verifies size and sha256 when declared, warns-free when not', async () => {
  const data = new TextEncoder().encode('abc');
  const ok = await checkFetchedPart({ path: 'a', url: 'u', offset: 0, size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }, data);
  assert.equal(ok.sha256.length, 64);
  await assert.rejects(checkFetchedPart({ path: 'a', url: 'u', offset: 0, size: 4 }, data), (e) => e.code === 'verify.size');
  await assert.rejects(checkFetchedPart({ path: 'a', url: 'u', offset: 0, sha256: 'f'.repeat(64) }, data), (e) => e.code === 'verify.sha256');
  await assert.rejects(checkFetchedPart({ path: 'a', url: 'u', offset: 0 }, bytes(0)), (e) => e.code === 'verify.empty');
  await assert.rejects(checkFetchedPart({ path: 'a', url: 'u', offset: 0 }, bytes(10), { maxPart: 5 }), (e) => e.code === 'verify.tooLarge');
});

test('checkLayout rejects overlap, out-of-flash and oversized totals', () => {
  checkLayout([{ offset: 0, data: bytes(10) }, { offset: 10, data: bytes(5) }], 16);
  assert.throws(() => checkLayout([{ offset: 0, data: bytes(10) }, { offset: 9, data: bytes(5) }], 64), (e) => e.code === 'verify.overlap');
  assert.throws(() => checkLayout([{ offset: 60, data: bytes(10) }], 64), (e) => e.code === 'verify.beyondFlash');
  assert.throws(() => checkLayout([{ offset: 0, data: bytes(10) }], 64, { maxTotal: 5 }), (e) => e.code === 'verify.totalTooLarge');
});

test('checkLayout rejects a malformed part before doing any arithmetic', () => {
  const isPart = (e) => e.code === 'verify.part';
  assert.throws(() => checkLayout([{ offset: -1, data: bytes(4) }], 64), isPart);
  assert.throws(() => checkLayout([{ offset: 1.5, data: bytes(4) }], 64), isPart);
  assert.throws(() => checkLayout([{ offset: NaN, data: bytes(4) }], 64), isPart);
  assert.throws(() => checkLayout([{ offset: '0', data: bytes(4) }], 64), isPart);
  assert.throws(() => checkLayout([{ offset: Number.MAX_SAFE_INTEGER + 2, data: bytes(4) }], 64), isPart);
  assert.throws(() => checkLayout([{ offset: 0, data: [0, 1, 2] }], 64), isPart);
  assert.throws(() => checkLayout([{ offset: 0, data: new ArrayBuffer(4) }], 64), isPart);
  assert.throws(() => checkLayout([{ offset: 0 }], 64), isPart);
  assert.throws(() => checkLayout([null], 64), isPart);
});

function imageWithHeader(chipId, magic = 0xe9) {
  const d = bytes(0x2000, 0xff);
  d[0x1000] = magic; d[0x1000 + 12] = chipId & 0xff; d[0x1000 + 13] = chipId >> 8;
  return d;
}

test('checkBootImage validates magic and chip id at the chip bootloader offset', () => {
  checkBootImage([{ offset: 0, data: imageWithHeader(0) }], 'ESP32');
  assert.throws(() => checkBootImage([{ offset: 0, data: imageWithHeader(9) }], 'ESP32'), (e) => e.code === 'verify.wrongChip');
  assert.throws(() => checkBootImage([{ offset: 0, data: imageWithHeader(0, 0x00) }], 'ESP32'), (e) => e.code === 'verify.notAnImage');
  // Chip id is 16-bit little-endian at bytes 12-13, so byte 13 must be 0 on a 0xff-filled buffer.
  const s3 = bytes(64, 0xff); s3[0] = 0xe9; s3[12] = 9; s3[13] = 0;
  checkBootImage([{ offset: 0, data: s3 }], 'ESP32-S3');
  // No part covers the bootloader offset (app-only update): nothing to check.
  checkBootImage([{ offset: 0x20000, data: bytes(16) }], 'ESP32-S3');
  // Unknown offset (C61 in 0.6.1): skip rather than guess.
  checkBootImage([{ offset: 0, data: bytes(16) }], 'ESP32-C61');
});

test('esptoolCommand renders offsets and file names in order', () => {
  const parts = [{ path: 'x/app.bin', url: 'u', offset: 0x20000 }, { path: 'x/table.bin', url: 'u', offset: 0x8000 }];
  const cmd = esptoolCommand('ESP32-S3', parts, ['app.bin', 'table.bin']);
  assert.equal(cmd, 'python -m esptool --chip esp32s3 --port PORT --baud 460800 write_flash 0x8000 table.bin 0x20000 app.bin');
  // Positive control: a family missing from CHIPS still renders a lowercase chip name instead of throwing.
  const unknown = esptoolCommand('ESP32-XX', [{ path: 'a.bin', url: 'u', offset: 0 }], ['a.bin']);
  assert.equal(unknown, 'python -m esptool --chip esp32xx --port PORT --baud 460800 write_flash 0x0 a.bin');
});
