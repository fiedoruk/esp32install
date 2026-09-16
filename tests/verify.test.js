import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHIPS, sha256Hex, checkFetchedPart, checkLayout, checkBootImage, checkImageParts, esptoolCommand, inspectImage } from '../app/verify.js';

const bytes = (n, fill = 0) => new Uint8Array(n).fill(fill);
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

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
  // ESP8266 class in the vendored bundle declares BOOTLOADER_FLASH_OFFSET=0 and no IMAGE_CHIP_ID.
  assert.equal(CHIPS['ESP8266'].bootloaderOffset, 0x0);
  assert.equal(CHIPS['ESP8266'].imageChipId, null);
});

test('chip table exposes the esptool --chip names', () => {
  assert.equal(CHIPS['ESP32'].esptoolChip, 'esp32');
  assert.equal(CHIPS['ESP32-S3'].esptoolChip, 'esp32s3');
  assert.equal(CHIPS['ESP32-C3'].esptoolChip, 'esp32c3');
  assert.equal(CHIPS['ESP32-C6'].esptoolChip, 'esp32c6');
  assert.equal(CHIPS['ESP32-P4'].esptoolChip, 'esp32p4');
});

test('chip table rows are frozen: assignment throws in strict mode', () => {
  assert.throws(() => { CHIPS.ESP32.bootloaderOffset = 0; }, TypeError);
  assert.throws(() => { CHIPS['ESP32-ZZ'] = { bootloaderOffset: 0 }; }, TypeError);
  assert.equal(CHIPS.ESP32.bootloaderOffset, 0x1000);
});

test('sha256Hex matches a known vector', async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), ABC_SHA256);
});

test('checkFetchedPart verifies size and sha256 when declared, warns-free when not', async () => {
  const data = new TextEncoder().encode('abc');
  const ok = await checkFetchedPart({ path: 'a', url: 'u', offset: 0, size: 3, sha256: ABC_SHA256 }, data);
  assert.equal(ok.sha256.length, 64);
  await assert.rejects(checkFetchedPart({ path: 'a', url: 'u', offset: 0, size: 4 }, data), (e) => e.code === 'verify.size');
  await assert.rejects(checkFetchedPart({ path: 'a', url: 'u', offset: 0, sha256: 'f'.repeat(64) }, data), (e) => e.code === 'verify.sha256');
  await assert.rejects(checkFetchedPart({ path: 'a', url: 'u', offset: 0 }, bytes(0)), (e) => e.code === 'verify.empty');
  await assert.rejects(checkFetchedPart({ path: 'a', url: 'u', offset: 0 }, bytes(10), { maxPart: 5 }), (e) => e.code === 'verify.tooLarge');
});

test('checkFetchedPart accepts an uppercase declared sha256', async () => {
  const data = new TextEncoder().encode('abc');
  const ok = await checkFetchedPart({ path: 'a', url: 'u', offset: 0, sha256: ABC_SHA256.toUpperCase() }, data);
  assert.equal(ok.sha256, ABC_SHA256);
});

test('checkLayout rejects overlap, out-of-flash and oversized totals', () => {
  checkLayout([{ offset: 0, data: bytes(10) }, { offset: 10, data: bytes(5) }], 16);
  assert.throws(() => checkLayout([{ offset: 0, data: bytes(10) }, { offset: 9, data: bytes(5) }], 64), (e) => e.code === 'verify.overlap');
  assert.throws(() => checkLayout([{ offset: 60, data: bytes(10) }], 64), (e) => e.code === 'verify.beyondFlash');
  assert.throws(() => checkLayout([{ offset: 0, data: bytes(10) }], 64, { maxTotal: 5 }), (e) => e.code === 'verify.totalTooLarge');
});

test('checkLayout accepts a part that ends exactly at the flash size', () => {
  checkLayout([{ offset: 54, data: bytes(10) }], 64);
  assert.throws(() => checkLayout([{ offset: 55, data: bytes(10) }], 64), (e) => e.code === 'verify.beyondFlash');
});

test('checkLayout rejects an unusable flash size before looking at parts', () => {
  const isFlash = (e) => e.code === 'verify.flashSize';
  const parts = [{ offset: 0, data: bytes(4) }];
  assert.throws(() => checkLayout(parts, undefined), isFlash);
  assert.throws(() => checkLayout(parts, NaN), isFlash);
  assert.throws(() => checkLayout(parts, 0), isFlash);
  assert.throws(() => checkLayout(parts, -1), isFlash);
  assert.throws(() => checkLayout(parts, '16'), isFlash);
  assert.throws(() => checkLayout(parts, undefined), (e) => e.params.flashBytes === 'undefined');
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

test('checkLayout rejects a zero-length part', () => {
  assert.throws(() => checkLayout([{ offset: 0, data: bytes(4) }, { offset: 8, data: bytes(0) }], 64),
    (e) => e.code === 'verify.empty' && e.params.offset === 8);
});

function imageWithHeader(chipId, magic = 0xe9, at = 0x1000) {
  const d = bytes(at + 0x1000, 0xff);
  d[at] = magic; d[at + 12] = chipId & 0xff; d[at + 13] = chipId >> 8;
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

test('checkBootImage rejects a chip family that is not in the table', () => {
  assert.throws(() => checkBootImage([{ offset: 0, data: bytes(64) }], 'ESP32-XX'),
    (e) => e.code === 'verify.chipUnknown' && e.params.chipFamily === 'ESP32-XX');
});

test('checkBootImage needs a full 24-byte header at the bootloader offset', () => {
  const header = (n) => { const d = bytes(n, 0xff); d[0] = 0xe9; d[12] = 9; d[13] = 0; return d; };
  assert.throws(() => checkBootImage([{ offset: 0, data: header(23) }], 'ESP32-S3'), (e) => e.code === 'verify.notAnImage');
  checkBootImage([{ offset: 0, data: header(24) }], 'ESP32-S3');
});

test('checkBootImage accepts a holder that starts exactly at the bootloader offset', () => {
  const d = bytes(64, 0xff); d[0] = 0xe9; d[12] = 0; d[13] = 0;
  checkBootImage([{ offset: 0x1000, data: d }], 'ESP32');
});

test('checkBootImage validates C5 and P4 at 0x2000', () => {
  checkBootImage([{ offset: 0, data: imageWithHeader(23, 0xe9, 0x2000) }], 'ESP32-C5');
  checkBootImage([{ offset: 0, data: imageWithHeader(18, 0xe9, 0x2000) }], 'ESP32-P4');
  assert.throws(() => checkBootImage([{ offset: 0, data: imageWithHeader(18, 0xe9, 0x2000) }], 'ESP32-C5'),
    (e) => e.code === 'verify.wrongChip' && e.params.found === 'ESP32-P4');
});

/** An image header at byte 0 of a part: the shape of an application or a partition-table-less app image. */
function appImage(chipId, length = 64) { const d = bytes(length, 0xff); d[0] = 0xe9; d[12] = chipId & 0xff; d[13] = chipId >> 8; return d; }

test('checkImageParts: an app image for another chip is refused wherever it sits, with its offset', () => {
  // An ESP32 application at 0x20000 on an ESP32-S3: nothing covers the S3 bootloader offset, so only this check sees it.
  checkBootImage([{ offset: 0x20000, data: appImage(0) }], 'ESP32-S3');
  assert.throws(() => checkImageParts([{ offset: 0x20000, data: appImage(0) }], 'ESP32-S3'),
    (e) => e.code === 'verify.wrongChip' && e.params.expected === 'ESP32-S3' && e.params.found === 'ESP32' && e.params.offset === 0x20000);
  assert.throws(() => checkImageParts([{ offset: 0x8000, data: bytes(3072, 0xaa) }, { offset: 0x10000, data: appImage(18) }], 'ESP32-C5'),
    (e) => e.code === 'verify.wrongChip' && e.params.found === 'ESP32-P4');
  assert.throws(() => checkImageParts([{ offset: 0, data: appImage(0x7fff) }], 'ESP32'), (e) => e.code === 'verify.wrongChip' && e.params.found === '32767');
});

test('checkImageParts accepts matching images, data parts, short parts, and skips families without an image chip id', () => {
  checkImageParts([{ offset: 0x20000, data: appImage(9) }, { offset: 0x8000, data: bytes(3072, 0xaa) }], 'ESP32-S3');
  checkImageParts([{ offset: 0x10000, data: bytes(4096, 0x00) }], 'ESP32'); // no 0xE9: a data part
  checkImageParts([{ offset: 0x10000, data: appImage(9, 23) }], 'ESP32'); // shorter than a header: not an image
  checkImageParts([{ offset: 0, data: appImage(9) }], 'ESP8266'); // ESP8266 images carry no chip id
  assert.throws(() => checkImageParts([{ offset: 0, data: appImage(0) }], 'ESP32-XX'), (e) => e.code === 'verify.chipUnknown');
  // Positive control: a 24-byte part is long enough to be checked.
  assert.throws(() => checkImageParts([{ offset: 0x10000, data: appImage(9, 24) }], 'ESP32'), (e) => e.code === 'verify.wrongChip');
});

test('esptoolCommand renders offsets and file names in order', () => {
  const parts = [{ path: 'x/app.bin', url: 'u', offset: 0x20000 }, { path: 'x/table.bin', url: 'u', offset: 0x8000 }];
  const cmd = esptoolCommand('ESP32-S3', parts, ['app.bin', 'table.bin']);
  assert.equal(cmd, 'python -m esptool --chip esp32s3 --port PORT --baud 460800 write_flash 0x8000 table.bin 0x20000 app.bin');
  // Positive control: a family missing from CHIPS still renders a lowercase chip name instead of throwing.
  const unknown = esptoolCommand('ESP32-XX', [{ path: 'a.bin', url: 'u', offset: 0 }], ['a.bin']);
  assert.equal(unknown, 'python -m esptool --chip esp32xx --port PORT --baud 460800 write_flash 0x0 a.bin');
});

test('esptoolCommand rejects a file name list that does not match the parts', () => {
  const parts = [{ path: 'a.bin', url: 'u', offset: 0 }, { path: 'b.bin', url: 'u', offset: 0x10000 }];
  assert.throws(() => esptoolCommand('ESP32', parts, ['a.bin']), (e) => e.code === 'verify.part' && e.params.index === 1);
  assert.throws(() => esptoolCommand('ESP32', parts, ['a.bin', 'b.bin', 'c.bin']), (e) => e.code === 'verify.part');
});

/* --- inspectImage: what a single file says about itself --------------------- */

const withHeader = (d, at, chipId) => { d[at] = 0xe9; d[at + 12] = chipId & 0xff; d[at + 13] = chipId >> 8; return d; };
const withTable = (d) => { d[0x8000] = 0xaa; d[0x8001] = 0x50; return d; };
const merged = (family) => withTable(withHeader(bytes(0x9000, 0xff), CHIPS[family].bootloaderOffset, CHIPS[family].imageChipId));
const appOnly = (chipId, size = 0x9000) => withHeader(bytes(size, 0x5a), 0, chipId);

test('inspectImage: a merged image is whole for its family, at 0x0, 0x1000 or 0x2000', () => {
  assert.deepEqual(inspectImage(merged('ESP32')), { headerOffset: 0x1000, chipFamily: 'ESP32', whole: true });
  assert.deepEqual(inspectImage(merged('ESP32-S2')), { headerOffset: 0x1000, chipFamily: 'ESP32-S2', whole: true });
  assert.deepEqual(inspectImage(merged('ESP32-S3')), { headerOffset: 0, chipFamily: 'ESP32-S3', whole: true });
  assert.deepEqual(inspectImage(merged('ESP32-C3')), { headerOffset: 0, chipFamily: 'ESP32-C3', whole: true });
  assert.deepEqual(inspectImage(merged('ESP32-P4')), { headerOffset: 0x2000, chipFamily: 'ESP32-P4', whole: true });
  assert.deepEqual(inspectImage(merged('ESP32-C5')), { headerOffset: 0x2000, chipFamily: 'ESP32-C5', whole: true });
});

test('inspectImage: an application image names its family but is never whole', () => {
  assert.deepEqual(inspectImage(appOnly(0)), { headerOffset: 0, chipFamily: 'ESP32', whole: false });
  assert.deepEqual(inspectImage(appOnly(9)), { headerOffset: 0, chipFamily: 'ESP32-S3', whole: false });
  assert.deepEqual(inspectImage(appOnly(13, 0x100)), { headerOffset: 0, chipFamily: 'ESP32-C6', whole: false }, 'shorter than a table offset');
  // An ESP32 application whose bytes at 0x8000 happen to look like a table: the header is not at the ESP32 bootloader offset.
  assert.deepEqual(inspectImage(withTable(appOnly(0))), { headerOffset: 0, chipFamily: 'ESP32', whole: false });
});

test('inspectImage: an unknown image id gives no family; a padded header still means a merged image', () => {
  assert.deepEqual(inspectImage(withTable(withHeader(bytes(0x9000, 0xff), 0x1000, 200))), { headerOffset: 0x1000, chipFamily: null, whole: true });
  assert.deepEqual(inspectImage(withTable(withHeader(bytes(0x9000, 0x5a), 0, 200))), { headerOffset: 0, chipFamily: null, whole: false });
  assert.deepEqual(inspectImage(withHeader(bytes(0x9000, 0xff), 0x1000, 200)), { headerOffset: 0x1000, chipFamily: null, whole: false }, 'no table: not whole');
});

test('inspectImage: no header, a header behind non-0xff padding, a short buffer or a non-buffer say nothing', () => {
  const none = { headerOffset: null, chipFamily: null, whole: false };
  assert.deepEqual(inspectImage(bytes(0x9000, 0x00)), none);
  const dirty = withHeader(bytes(0x9000, 0xff), 0x1000, 0); dirty[5] = 0x00;
  assert.deepEqual(inspectImage(dirty), none, 'a byte before the header that is not 0xff');
  assert.deepEqual(inspectImage(withHeader(bytes(0x1010, 0xff), 0x1000, 0)), none, 'header cut short');
  assert.deepEqual(inspectImage(bytes(10, 0xe9)), none);
  assert.deepEqual(inspectImage(bytes(0)), none);
  assert.deepEqual(inspectImage(null), none);
  assert.deepEqual(inspectImage([0xe9]), none);
});
