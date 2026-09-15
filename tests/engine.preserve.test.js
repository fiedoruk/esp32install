import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstaller } from '../app/engine.js';
import { normalizeManifest } from '../app/manifest.js';
import { makeFakeEsptool } from './helpers/fakeEsptool.js';
import { sha256Hex } from '../app/verify.js';

const MiB = 1024 * 1024;
const FLASH = 16 * MiB;
const HEADER = 0x20000; // max(offset + size) over the compatibility ranges below

// Layout of the device this profile is written for: bootloader 0x0-0x8000, partition
// table page 0x8000-0x9000, otadata 0xD000-0xF000, settings area 0x10000-0x20000 (blank
// on a fresh device), application from 0x20000.
const pattern = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * seed + (i >> 7)) & 0xff);
const BOOT = pattern(0x8000, 3);
const FACTORY_TABLE = pattern(0x1000, 5);
const OTADATA = pattern(0x2000, 11);
const APP = pattern(0x4000, 13);
const TABLE = pattern(3072, 17);

function deviceImage({ mode = 'first', dirtySettings = false, bootloader = BOOT } = {}) {
  const img = new Uint8Array(FLASH).fill(0xff);
  img.set(bootloader, 0);
  img.set(OTADATA, 0xd000);
  if (mode === 'update') {
    img.set(TABLE, 0x8000); // the Home table already sits on the device, padded with 0xff
    img.set(pattern(0x4000, 19), 0x20000); // an older application
    img.set(pattern(0x100, 23), 0x10000); // settings in use: allowed in update mode
  } else {
    img.set(FACTORY_TABLE, 0x8000);
  }
  if (dirtySettings) img[0x10000 + 42] = 0x00;
  return img;
}

async function manifestFor(img) {
  const page = (off, size) => sha256Hex(img.slice(off, off + size));
  return normalizeManifest({
    schema: 2, name: 'Home', version: '0.4.4', profile: 'preserve',
    builds: [{
      boardKey: 'note4c', board: 'NOTE4C', chipFamily: 'ESP32-S3', flashSizeMB: 16,
      compatibility: {
        regions: [{ offset: 0, size: 0x8000, sha256: await page(0, 0x8000) }, { offset: 0xd000, size: 0x2000, sha256: await page(0xd000, 0x2000) }],
        firstInstall: { regions: [{ offset: 0x8000, size: 0x1000, sha256: await sha256Hex(FACTORY_TABLE) }], empty: [{ offset: 0x10000, size: 0x10000 }] },
        update: { tableOffset: 0x8000 },
      },
      parts: [
        { path: 'app.bin', offset: 0x20000, size: APP.length, sha256: await sha256Hex(APP) },
        { path: 'table.bin', offset: 0x8000, size: TABLE.length, sha256: await sha256Hex(TABLE) },
      ],
    }],
  }, 'https://h/install/manifests/home.json');
}

const fakes = [];
const called = (fake, name) => fake.calls.some((c) => c[0] === name);
const fileOf = (bytes) => ({ size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });

/** Wires the installer with a device image; the saved backup is what `requestBackupFile` hands back unless overridden. */
async function setup({ img = deviceImage(), fakeOptions = {}, manifest, backupFile } = {}) {
  const fake = makeFakeEsptool({ chipName: 'ESP32-S3', flashImage: img, ...fakeOptions });
  fakes.push(fake);
  manifest ??= await manifestFor(img);
  const events = [];
  const saved = [];
  const port = { getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }) };
  const inst = createInstaller({
    esptool: fake,
    requestPort: async () => port,
    fetchFn: async (url) => ({ ok: true, status: 200, arrayBuffer: async () => (url.endsWith('app.bin') ? APP : TABLE).buffer.slice(0) }),
    onEvent: (e) => events.push(e),
    chooseBuild: async (builds) => builds[0],
    confirmErase: async () => { throw new Error('preserve must never ask about erasing'); },
    saveBackup: async (bytes, name) => { fake.calls.push(['saveBackup', name]); saved.push(bytes); },
    requestBackupFile: async () => { fake.calls.push(['requestBackupFile']); return backupFile ?? fileOf(saved.at(-1)); },
  });
  return { inst, manifest, events, fake, saved, img };
}

test('first install on a matching device: security ok, header ok, backup required, both parts written and read back', async () => {
  const { inst, manifest, events, fake, saved, img } = await setup();
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
  assert.equal(r.build, 'note4c');
  assert.equal(r.backup.sha256, await sha256Hex(img));
  assert.deepEqual(r.parts.map((p) => p.offset), [0x20000, 0x8000]);
  const names = fake.calls.map((c) => c[0]);
  // Every check precedes the first write; the write follows the user's re-selected backup.
  const idx = (n) => names.indexOf(n);
  assert.ok(idx('checkCommand') < idx('readFlash'), 'security state before any flash read');
  assert.ok(idx('saveBackup') > idx('readFlash') && idx('requestBackupFile') > idx('saveBackup'));
  assert.ok(idx('writeFlash') > idx('requestBackupFile'), 'nothing is written before the backup is on disk');
  assert.equal(names.at(-2), 'after'); assert.equal(names.at(-1), 'disconnect');
  const sec = fake.calls.find((c) => c[0] === 'checkCommand');
  assert.deepEqual(sec.slice(1), ['security info', 0x14, 20, 5000]);
  // Parts go in manifest order, one writeFlash each, eraseAll false, each MD5-checked on the chip.
  const writes = fake.calls.filter((c) => c[0] === 'writeFlash');
  assert.deepEqual(writes.map((w) => w[1]), [[[0x20000, APP.length]], [[0x8000, TABLE.length]]]);
  assert.ok(writes.every((w) => w[2] === false && w[3] === true));
  assert.deepEqual(fake.calls.filter((c) => c[0] === 'flashMd5sum').map((c) => c.slice(1)), [[0x20000, APP.length], [0x8000, TABLE.length]]);
  assert.ok(!called(fake, 'eraseFlash'));
  // The backup handed to the user is the whole original flash; the device ends up as original + parts.
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], img);
  const expected = img.slice(); expected.set(APP, 0x20000); expected.set(TABLE, 0x8000);
  assert.deepEqual(fake.flash, expected);
  assert.ok(events.some((e) => e.type === 'stage' && e.stage === 'checkingDevice'));
  assert.ok(events.some((e) => e.type === 'stage' && e.stage === 'backup'));
  assert.equal(events.at(-1).type, 'done');
});

test('secured device (secure boot flag, encryption count, or no security-info command) → device.secured before any read, backup or write', async () => {
  const flagged = new Uint8Array(20); flagged[0] = 0x01;
  const encrypted = new Uint8Array(20); encrypted[4] = 0x01;
  for (const fakeOptions of [{ securityInfo: flagged }, { securityInfo: encrypted }, { securityRejects: true }, { securityInfo: new Uint8Array(4) }]) {
    const { inst, manifest, fake, events } = await setup({ fakeOptions });
    await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'device.secured');
    assert.ok(!called(fake, 'readFlash')); assert.ok(!called(fake, 'saveBackup')); assert.ok(!called(fake, 'writeFlash'));
    assert.ok(called(fake, 'disconnect'));
    assert.equal(events.at(-1).type, 'error');
  }
});

test('header mismatch (different bootloader) → device.layout, no backup, no write', async () => {
  const known = deviceImage();
  const manifest = await manifestFor(known);
  const { inst, fake } = await setup({ img: deviceImage({ bootloader: pattern(0x8000, 29) }), manifest });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'device.layout');
  assert.ok(fake.calls.filter((c) => c[0] === 'readFlash').every((c) => c[1] + c[2] <= HEADER), 'only the header was read');
  assert.ok(!called(fake, 'saveBackup')); assert.ok(!called(fake, 'requestBackupFile')); assert.ok(!called(fake, 'writeFlash'));
});

test('settings area not empty in first mode → device.notEmpty, nothing read beyond the header, nothing written', async () => {
  const { inst, manifest, fake } = await setup({ img: deviceImage({ dirtySettings: true }) });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'device.notEmpty');
  assert.ok(!called(fake, 'saveBackup')); assert.ok(!called(fake, 'writeFlash'));
});

test('update mode: the Home table already on the device passes the header check; settings in use are allowed', async () => {
  const { inst, manifest, fake } = await setup({ img: deviceImage({ mode: 'update' }), manifest: await manifestFor(deviceImage()) });
  const r = await inst.run({ manifest, mode: 'update', options: {} });
  assert.equal(r.verified, true);
  assert.equal(fake.calls.filter((c) => c[0] === 'writeFlash').length, 2);
  assert.ok(!called(fake, 'eraseFlash'));
});

test('update mode: a foreign partition table at the table offset → device.layout, nothing written', async () => {
  const { inst, manifest, fake } = await setup({ img: deviceImage(), manifest: await manifestFor(deviceImage()) });
  await assert.rejects(inst.run({ manifest, mode: 'update', options: {} }), (e) => e.code === 'device.layout');
  assert.ok(!called(fake, 'saveBackup')); assert.ok(!called(fake, 'writeFlash'));
});

test('mac changes between backup and write → device.changed, backup saved, nothing written', async () => {
  const same = '11:22:33:44:55:66';
  const { inst, manifest, fake } = await setup({ fakeOptions: { macSequence: [same, same, '11:22:33:44:55:77'] } });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'device.changed');
  assert.ok(called(fake, 'saveBackup'));
  assert.ok(!called(fake, 'writeFlash'));
});

test('mac changes before the backup → device.changed, no backup taken', async () => {
  const { inst, manifest, fake } = await setup({ fakeOptions: { macSequence: ['11:22:33:44:55:66', '11:22:33:44:55:77'] } });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'device.changed');
  assert.ok(!called(fake, 'saveBackup')); assert.ok(!called(fake, 'writeFlash'));
});

test('header changed under us after the backup (re-read differs) → device.changed, nothing written', async () => {
  let headerReads = 0;
  const tamperRead = (addr, n, index, data) => { if (addr === 0 && n === HEADER && ++headerReads === 2) data[0x9000] ^= 0x01; };
  const { inst, manifest, fake } = await setup({ fakeOptions: { tamperRead } });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'device.changed');
  assert.equal(headerReads, 2);
  assert.ok(called(fake, 'requestBackupFile'), 'the gate sits after the backup was re-selected');
  assert.ok(!called(fake, 'writeFlash'));
});

test('backup that agrees with itself but not with the header read → device.changed, nothing saved, nothing written', async () => {
  // Both backup passes see the same altered byte, so they agree; only the earlier header read differs.
  const tamperRead = (addr, n, index, data) => { if (addr === 0 && n === 256 * 1024) data[0x9000] ^= 0x01; };
  const { inst, manifest, fake } = await setup({ fakeOptions: { tamperRead } });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'device.changed');
  assert.ok(!called(fake, 'saveBackup')); assert.ok(!called(fake, 'writeFlash'));
});

test('wrong backup file chosen → backup.file, nothing written', async () => {
  const other = new Uint8Array(FLASH).fill(0x00);
  const { inst, manifest, fake } = await setup({ backupFile: fileOf(other) });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'backup.file');
  assert.ok(called(fake, 'saveBackup')); assert.ok(called(fake, 'requestBackupFile'));
  assert.ok(!called(fake, 'writeFlash'));
});

test('a backup file of the right size but different bytes → backup.file', async () => {
  const img = deviceImage();
  const other = img.slice(); other[0x400000] ^= 0x01;
  const { inst, manifest, fake } = await setup({ img, backupFile: fileOf(other) });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'backup.file');
  assert.ok(!called(fake, 'writeFlash'));
});

test('the two backup reads differ → backup.mismatch, nothing saved, nothing written', async () => {
  let hits = 0;
  const tamperRead = (addr, n, index, data) => { if (addr === 0x100000 && ++hits === 2) data[0] ^= 0x01; };
  const { inst, manifest, fake } = await setup({ fakeOptions: { tamperRead } });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'backup.mismatch');
  assert.equal(hits, 2, 'the tamper hit the second pass');
  assert.ok(!called(fake, 'saveBackup')); assert.ok(!called(fake, 'writeFlash'));
});

test('bytes outside written parts are unchanged after write (positive control: a fake that corrupts 0x9000 fails flash.verify)', async () => {
  const { inst, manifest, fake, events } = await setup({ fakeOptions: { corruptAt: 0x9000 } });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'flash.verify');
  assert.equal(fake.calls.filter((c) => c[0] === 'writeFlash').length, 2, 'both parts were written and MD5-checked before the read-back caught it');
  assert.ok(!called(fake, 'after'), 'no reset after a failed verification');
  assert.equal(events.at(-1).type, 'error');
  assert.ok(called(fake, 'disconnect'));
});

test('a part whose flash MD5 differs from the image → flash.verify right after that part', async () => {
  // The fake flips 0x8000 after every writeFlash: the table part (written second) reads back wrong.
  const { inst, manifest, fake } = await setup({ fakeOptions: { corruptAt: 0x8000 } });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'flash.verify');
  assert.equal(fake.calls.filter((c) => c[0] === 'flashMd5sum').length, 2);
  assert.ok(!called(fake, 'after'));
});

test('an unknown error thrown by writeFlash is reported as flash.write, before the write as engine.unexpected', async () => {
  const s1 = await setup();
  s1.fake.ESPLoader.prototype.writeFlash = async function () { s1.fake.calls.push(['writeFlash']); throw new Error('usb hiccup'); };
  await assert.rejects(s1.inst.run({ manifest: s1.manifest, mode: 'first', options: {} }), (e) => e.code === 'flash.write');
  assert.ok(called(s1.fake, 'writeFlash'));
  const s2 = await setup({ backupFile: { size: FLASH, arrayBuffer: async () => { throw new Error('ui exploded'); } } });
  await assert.rejects(s2.inst.run({ manifest: s2.manifest, mode: 'first', options: {} }), (e) => e.code === 'engine.unexpected');
  assert.ok(!called(s2.fake, 'writeFlash'));
});

test('cancel() while the user is picking the backup file → serial.cancelled, nothing written', async () => {
  let inst;
  const fake = makeFakeEsptool({ chipName: 'ESP32-S3', flashImage: deviceImage() });
  fakes.push(fake);
  const manifest = await manifestFor(deviceImage());
  let saved;
  inst = createInstaller({
    esptool: fake, requestPort: async () => ({ getInfo: () => ({}) }),
    fetchFn: async (url) => ({ ok: true, status: 200, arrayBuffer: async () => (url.endsWith('app.bin') ? APP : TABLE).buffer.slice(0) }),
    chooseBuild: async (b) => b[0], confirmErase: async () => true,
    saveBackup: async (bytes) => { saved = bytes; },
    requestBackupFile: async () => { inst.cancel(); return fileOf(saved); },
  });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'serial.cancelled');
  assert.ok(!called(fake, 'writeFlash'));
  assert.ok(called(fake, 'disconnect'));
});

test('reset failure after a verified preserve write still resolves with verified: true', async () => {
  const { inst, manifest, events } = await setup({ fakeOptions: { failReset: true } });
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
  assert.equal(events.at(-1).type, 'done');
  assert.ok(events.some((e) => e.type === 'log' && /^reset: /.test(e.line)));
});

test('eraseFlash is never called in preserve', () => {
  assert.ok(fakes.length >= 12, `expected the preserve scenarios above to have run (${fakes.length})`);
  for (const fake of fakes) assert.ok(!called(fake, 'eraseFlash'));
});
