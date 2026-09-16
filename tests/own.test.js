/**
 * The own-file model: what a file looks like, where a build tool would have put it, and whether a
 * set of files fits on one device. No DOM here; the page calls exactly these functions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePart, headerFamily, ownProblem, MAX_PARTS, PARTITION_TABLE_OFFSET, OTA_DATA_OFFSET, APP_OFFSET } from '../app/own.js';

/** An ESP image with its header at byte 0 (an application or a bootloader). */
const image = (chipId, length = 0x200) => { const d = new Uint8Array(length).fill(0xff); d[0] = 0xe9; d[12] = chipId & 0xff; d[13] = chipId >> 8; return d; };
/** A merged image for a family that boots at `headerAt`, with a partition table at 0x8000. */
const merged = (chipId, headerAt) => { const d = new Uint8Array(0x11000).fill(0xff); d[headerAt] = 0xe9; d[headerAt + 12] = chipId; d[headerAt + 13] = 0; d[0x8000] = 0xaa; d[0x8001] = 0x50; return d; };
const table = () => { const d = new Uint8Array(0xc00).fill(0xff); d[0] = 0xaa; d[1] = 0x50; return d; };
const blank = (length = 0x2000) => new Uint8Array(length).fill(0xff);

test('describePart: a merged image is the whole system at 0, whatever it is called', () => {
  assert.deepEqual(describePart('firmware.bin', merged(0, 0x1000)), { chipFamily: 'ESP32', kind: 'whole', offset: 0 });
  assert.deepEqual(describePart('bootloader.bin', merged(9, 0)), { chipFamily: 'ESP32-S3', kind: 'whole', offset: 0 });
});

test('describePart: a partition table goes to 0x8000 by its magic, boot_app0 to 0xE000 by its name', () => {
  assert.deepEqual(describePart('anything.bin', table()), { chipFamily: null, kind: 'table', offset: PARTITION_TABLE_OFFSET });
  assert.deepEqual(describePart('boot_app0.bin', blank()), { chipFamily: null, kind: 'otadata', offset: OTA_DATA_OFFSET });
  assert.deepEqual(describePart('BOOT_APP0.BIN', blank()), { chipFamily: null, kind: 'otadata', offset: OTA_DATA_OFFSET });
});

test('describePart: an image called bootloader goes to the family\'s bootloader offset; the chosen device stands in when the header names none', () => {
  assert.deepEqual(describePart('bootloader.bin', image(0)), { chipFamily: 'ESP32', kind: 'boot', offset: 0x1000 });
  assert.deepEqual(describePart('bootloader.bin', image(9)), { chipFamily: 'ESP32-S3', kind: 'boot', offset: 0x0 });
  assert.deepEqual(describePart('bootloader.bin', image(23)), { chipFamily: 'ESP32-C5', kind: 'boot', offset: 0x2000 });
  const unknown = image(999); // an id no family declares
  assert.deepEqual(describePart('bootloader.bin', unknown, 'ESP32'), { chipFamily: null, kind: 'boot', offset: 0x1000 });
  assert.deepEqual(describePart('bootloader.bin', unknown, null), { chipFamily: null, kind: 'boot', offset: null }, 'no family, no address to suggest');
  assert.deepEqual(describePart('bootloader.bin', image(20), 'ESP32-C61'), { chipFamily: 'ESP32-C61', kind: 'boot', offset: null }, 'the library declares no offset for the C61');
});

test('describePart: any other image is the application at 0x10000; anything else is data with no address', () => {
  assert.deepEqual(describePart('firmware.bin', image(9)), { chipFamily: 'ESP32-S3', kind: 'app', offset: APP_OFFSET });
  assert.deepEqual(describePart('bootloader.txt.bin', blank()), { chipFamily: null, kind: 'data', offset: null }, 'the name alone does not make a bootloader');
  assert.deepEqual(describePart('spiffs.bin', blank(0x10000)), { chipFamily: null, kind: 'data', offset: null });
  assert.deepEqual(describePart('short.bin', new Uint8Array([0xe9, 0, 0])), { chipFamily: null, kind: 'data', offset: null }, 'shorter than a header is not an image');
  assert.deepEqual(describePart('x', 'not bytes'), { chipFamily: null, kind: 'data', offset: null });
});

test('headerFamily: the first family a header names, or null', () => {
  assert.equal(headerFamily([{ chipFamily: null }, { chipFamily: 'ESP32-S3' }, { chipFamily: 'ESP32' }]), 'ESP32-S3');
  assert.equal(headerFamily([{ chipFamily: null }]), null);
  assert.equal(headerFamily([]), null);
});

test('ownProblem: two, three and four parts of a PlatformIO build fit together', () => {
  const two = [{ name: 'partitions.bin', offset: 0x8000, bytes: table() }, { name: 'firmware.bin', offset: 0x10000, bytes: image(9) }];
  assert.equal(ownProblem(two, 'ESP32-S3'), null);
  const three = [{ name: 'bootloader.bin', offset: 0x0, bytes: image(9, 0x5000) }, ...two];
  assert.equal(ownProblem(three, 'ESP32-S3'), null);
  const four = [...three, { name: 'boot_app0.bin', offset: 0xe000, bytes: blank() }];
  assert.equal(ownProblem(four, 'ESP32-S3'), null);
  const classic = [{ name: 'bootloader.bin', offset: 0x1000, bytes: image(0, 0x5000) }, { name: 'partitions.bin', offset: 0x8000, bytes: table() }, { name: 'boot_app0.bin', offset: 0xe000, bytes: blank() }, { name: 'firmware.bin', offset: 0x10000, bytes: image(0) }];
  assert.equal(ownProblem(classic, 'ESP32'), null);
});

test('ownProblem: two files on the same place are refused', () => {
  const parts = [{ name: 'a.bin', offset: 0x10000, bytes: image(9, 0x2000) }, { name: 'b.bin', offset: 0x11000, bytes: image(9) }];
  const e = ownProblem(parts, 'ESP32-S3');
  assert.equal(e.code, 'verify.overlap');
});

test('ownProblem: a part whose chip id contradicts the chosen device is refused and named', () => {
  const parts = [{ name: 'bootloader.bin', offset: 0x0, bytes: image(9, 0x5000) }, { name: 'partitions.bin', offset: 0x8000, bytes: table() }, { name: 'firmware.bin', offset: 0x10000, bytes: image(0) }];
  const e = ownProblem(parts, 'ESP32-S3');
  assert.equal(e.code, 'verify.wrongChip');
  assert.equal(e.params.name, 'firmware.bin', 'the file the person has to look at');
  assert.equal(e.params.found, 'ESP32');
  // A bootloader for another family at the S3's offset is caught by the bootloader check, and named.
  const e2 = ownProblem([{ name: 'bootloader.bin', offset: 0x0, bytes: image(0, 0x5000) }, { name: 'firmware.bin', offset: 0x10000, bytes: image(9) }], 'ESP32-S3');
  assert.equal(e2.code, 'verify.wrongChip');
  assert.equal(e2.params.name, 'bootloader.bin');
  assert.equal(e2.params.found, 'ESP32');
});

test('ownProblem: whatever sits at the bootloader offset must be an image; data there is refused', () => {
  const e = ownProblem([{ name: 'spiffs.bin', offset: 0x0, bytes: blank(0x10000) }], 'ESP32');
  assert.equal(e.code, 'verify.notAnImage');
  assert.equal(ownProblem([{ name: 'spiffs.bin', offset: 0x290000, bytes: blank(0x10000) }], 'ESP32'), null, 'data anywhere else is fine');
});

test('ownProblem: an unknown device or an absurd total is refused too', () => {
  assert.equal(ownProblem([{ name: 'a.bin', offset: 0, bytes: image(0) }], 'NOPE').code, 'verify.chipUnknown');
  const huge = [{ name: 'a.bin', offset: 0x40000000, bytes: image(9) }];
  assert.equal(ownProblem(huge, 'ESP32-S3').code, 'verify.beyondFlash', 'past the largest flash any manifest may declare');
});

test('MAX_PARTS leaves room for a four-file build plus two data images', () => {
  assert.equal(MAX_PARTS, 6);
});
