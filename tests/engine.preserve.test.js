import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstaller } from '../app/engine.js';
import { runPreserve } from '../app/preserve.js';
import { normalizeManifest } from '../app/manifest.js';
import { makeFakeEsptool } from './helpers/fakeEsptool.js';
import { sha256Hex } from '../app/verify.js';
import { md5Hex } from '../app/md5.js';
import { saveBackupWithHandle } from '../app/backup.js';
import { table, DEFAULT_ENTRIES } from './helpers/partitionTable.js';

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

async function manifestFor(img, { minimal = false, app = APP } = {}) {
  const page = (off, size) => sha256Hex(img.slice(off, off + size));
  if (minimal) {
    // Only the bootloader region and the table offset: the table page alone must stretch the header.
    return normalizeManifest({
      schema: 2, name: 'Home', version: '0.4.4', profile: 'preserve',
      builds: [{ boardKey: 'note4c', chipFamily: 'ESP32-S3', flashSizeMB: 16,
        compatibility: { regions: [{ offset: 0, size: 0x8000, sha256: await page(0, 0x8000) }], update: { tableOffset: 0x8000 } },
        parts: [{ path: 'app.bin', offset: 0x20000, size: app.length, sha256: await sha256Hex(app) },
                { path: 'table.bin', offset: 0x8000, size: TABLE.length, sha256: await sha256Hex(TABLE) }] }],
    }, 'https://h/install/manifests/home.json');
  }
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
        { path: 'app.bin', offset: 0x20000, size: app.length, sha256: await sha256Hex(app) },
        { path: 'table.bin', offset: 0x8000, size: TABLE.length, sha256: await sha256Hex(TABLE) },
      ],
    }],
  }, 'https://h/install/manifests/home.json');
}

const fakes = [];
const called = (fake, name) => fake.calls.some((c) => c[0] === name);
const firstDiff = (a, b) => { if (a.length !== b.length) return -2; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i; return -1; };
/** What the chip holds after writing `parts` into `img`: each touched 4 KiB sector erased, then the part programmed. */
function afterWrite(img, parts) {
  const out = img.slice();
  for (const [data, offset] of parts) {
    out.fill(0xff, Math.floor(offset / 0x1000) * 0x1000, Math.ceil((offset + data.length) / 0x1000) * 0x1000);
    out.set(data, offset);
  }
  return out;
}
const fileOf = (bytes) => ({ size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });

/** Wires the installer with a device image; the saved backup is what `requestBackupFile` hands back unless overridden. */
async function setup({ img = deviceImage(), fakeOptions = {}, fake, manifest, backupFile, app = APP, now, saveBackup } = {}) {
  fake ??= makeFakeEsptool({ chipName: 'ESP32-S3', flashImage: img, ...fakeOptions });
  fakes.push(fake);
  manifest ??= await manifestFor(img, { app });
  const events = [];
  const saved = [];
  const port = { getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }) };
  const inst = createInstaller({
    esptool: fake,
    requestPort: async () => port,
    fetchFn: async (url) => ({ ok: true, status: 200, arrayBuffer: async () => (url.endsWith('app.bin') ? app : TABLE).buffer.slice(0) }),
    onEvent: (e) => events.push(e),
    chooseBuild: async (builds) => builds[0],
    confirmErase: async () => { throw new Error('preserve must never ask about erasing'); },
    saveBackup: async (bytes, name) => { fake.calls.push(['saveBackup', name]); saved.push(bytes); return saveBackup ? saveBackup(bytes, name) : null; },
    requestBackupFile: async (filename) => { fake.calls.push(['requestBackupFile', filename]); return backupFile ?? fileOf(saved.at(-1)); },
    ...(now ? { now } : {}),
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
  assert.ok(idx('command') < idx('readFlash'), 'security state before any flash read');
  assert.ok(idx('saveBackup') > idx('readFlash') && idx('requestBackupFile') > idx('saveBackup'));
  assert.ok(idx('writeFlash') > idx('requestBackupFile'), 'nothing is written before the backup is on disk');
  assert.equal(names.at(-2), 'after'); assert.equal(names.at(-1), 'disconnect');
  const sec = fake.calls.find((c) => c[0] === 'command');
  assert.deepEqual(sec.slice(1), [0x14, 5000], 'the ROM is asked for its security info, and the reply is read at whatever length it comes');
  // Parts go in manifest order, one writeFlash each, eraseAll false, each MD5-checked on the chip.
  const writes = fake.calls.filter((c) => c[0] === 'writeFlash');
  assert.deepEqual(writes.map((w) => w[1]), [[[0x20000, APP.length]], [[0x8000, TABLE.length]]]);
  assert.ok(writes.every((w) => w[2] === false && w[3] === true));
  assert.deepEqual(fake.calls.filter((c) => c[0] === 'flashMd5sum').map((c) => c.slice(1)), [[0x20000, APP.length], [0x8000, TABLE.length]]);
  assert.ok(!called(fake, 'eraseFlash'));
  // The backup handed to the user is the whole original flash; the device ends up as original + parts.
  assert.equal(saved.length, 1);
  assert.equal(firstDiff(saved[0], img), -1, 'the saved backup is the original flash');
  assert.equal(firstDiff(fake.flash, afterWrite(img, [[APP, 0x20000], [TABLE, 0x8000]])), -1, 'device = original with the touched sectors erased and the parts programmed');
  assert.ok(events.some((e) => e.type === 'stage' && e.stage === 'checkingDevice'));
  assert.ok(events.some((e) => e.type === 'stage' && e.stage === 'backup'));
  assert.equal(events.at(-1).type, 'done');
});

test('the backup dialog is asked for the file by name, and the name is the one in the result', async () => {
  const { inst, manifest, fake } = await setup();
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  const ask = fake.calls.find((c) => c[0] === 'requestBackupFile');
  assert.match(ask[1], /^Home-backup-[0-9a-f]{8}\.bin$/);
  assert.equal(ask[1], r.backup.filename);
  assert.equal(ask[1].slice(12, 20), r.backup.sha256.slice(0, 8));
});

test('an application built for another chip → verify.wrongChip before any backup or write (nothing covers the S3 bootloader offset)', async () => {
  const foreign = APP.slice();
  foreign[0] = 0xe9; foreign[12] = 0; foreign[13] = 0; // ESP32 image chip id 0, at 0x20000 on an ESP32-S3 manifest
  const { inst, manifest, fake, events } = await setup({ app: foreign });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }),
    (e) => e.code === 'verify.wrongChip' && e.params.expected === 'ESP32-S3' && e.params.found === 'ESP32' && e.params.offset === 0x20000);
  assert.ok(!called(fake, 'saveBackup')); assert.ok(!called(fake, 'requestBackupFile')); assert.ok(!called(fake, 'writeFlash'));
  assert.ok(fake.calls.filter((c) => c[0] === 'readFlash').every((c) => c[1] + c[2] <= HEADER), 'only the header was read');
  assert.equal(events.at(-1).type, 'error');
  // Positive control: the same bytes with the S3 chip id install.
  const own = APP.slice(); own[0] = 0xe9; own[12] = 9; own[13] = 0;
  const s2 = await setup({ app: own });
  assert.equal((await s2.inst.run({ manifest: s2.manifest, mode: 'first', options: {} })).verified, true);
});

test('backup stage events carry a numeric time estimate after the first chunk, in seconds, falling to 0 at the end', async () => {
  let t = 0;
  const { inst, manifest, events } = await setup({ now: () => (t += 1500) }); // every look at the clock is 1.5 s later
  await inst.run({ manifest, mode: 'first', options: {} });
  // The save and read-back announcements carry a phase and no estimate; the chunk reads carry neither phase nor, at first, an estimate.
  const backup = events.filter((e) => e.type === 'stage' && e.stage === 'backup' && e.params?.phase === undefined);
  assert.equal(backup[0].eta, undefined, 'the bare stage announcement has no estimate yet');
  const measured = backup.slice(1);
  assert.equal(measured.length, 128, 'two 16 MiB reads in 256 KiB chunks');
  assert.ok(events.filter((e) => e.type === 'stage' && e.stage === 'backup' && e.params?.phase).every((e) => e.eta === undefined), 'no stale estimate beside the save button');
  assert.ok(measured.every((e) => Number.isFinite(e.eta) && e.eta >= 0), `eta values: ${measured.slice(0, 3).map((e) => e.eta)}`);
  assert.ok(measured[0].eta > measured.at(-2).eta, 'the estimate falls as the read progresses');
  assert.equal(measured.at(-1).eta, 0);
  assert.ok(measured.every((e, i) => i === 0 || e.percent >= measured[i - 1].percent), 'percent never goes backwards');
  const writing = events.filter((e) => e.type === 'stage' && e.stage === 'writing');
  assert.ok(writing.some((e) => Number.isFinite(e.eta)), 'the write stage uses the same clock');
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

test('classic ESP32: no security-info command, so the efuses decide whether preserve may run', async () => {
  for (const { efuse, locked } of [
    { efuse: { 0: 0, 6: 0 }, locked: false },
    { efuse: { 0: 1 << 20, 6: 0 }, locked: true },
    { efuse: { 0: 0, 6: 1 << 4 }, locked: true },
  ]) {
    const img = deviceImage();
    const manifest = await manifestFor(img);
    manifest.builds[0].chipFamily = 'ESP32'; // a Core2-class board: the ROM has no command 0x14
    const { inst, fake } = await setup({ img, manifest, fakeOptions: { chipName: 'ESP32', securityRejects: true, efuse } });
    const run = inst.run({ manifest, mode: 'first', options: {} });
    if (locked) {
      await assert.rejects(run, (e) => e.code === 'device.secured' && e.params.source === 'efuse');
      assert.ok(!called(fake, 'readFlash')); assert.ok(!called(fake, 'writeFlash'));
    } else {
      assert.equal((await run).verified, true, 'an unlocked classic ESP32 is no longer refused outright');
      assert.ok(called(fake, 'writeFlash'));
    }
  }
});

/**
 * The strict profile believes a short answer. An ESP32-S2 tells the truth about secure boot and
 * flash encryption in 12 bytes; before this round every such reply was an exception, and on
 * `preserve` — which refuses to guess — the whole family was refused whatever its real state.
 * NOT MEASURED on hardware.
 */
test('preserve: a 12-byte security answer is an answer, and a locked one still refuses', async () => {
  for (const { info, locked } of [
    { info: new Uint8Array(12), locked: false },
    { info: Uint8Array.from([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]), locked: true },
  ]) {
    const img = deviceImage();
    const manifest = await manifestFor(img);
    const { inst, fake } = await setup({ img, manifest, fakeOptions: { chipName: 'ESP32-S3', securityInfo: info } });
    const run = inst.run({ manifest, mode: 'first', options: {} });
    if (locked) {
      await assert.rejects(run, (e) => e.code === 'device.secured');
      assert.ok(!called(fake, 'readFlash')); assert.ok(!called(fake, 'writeFlash'));
    } else {
      assert.equal((await run).verified, true);
      assert.ok(called(fake, 'writeFlash'));
    }
  }
});

test('preserve still refuses a device whose security state cannot be read at all', async () => {
  const img = deviceImage();
  const manifest = await manifestFor(img);
  manifest.builds[0].chipFamily = 'ESP32';
  const { inst, fake } = await setup({ img, manifest, fakeOptions: { chipName: 'ESP32', securityRejects: true } });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'device.secured' && e.params.reason === 'unsupported');
  assert.ok(!called(fake, 'readFlash')); assert.ok(!called(fake, 'writeFlash'));
});

test('header mismatch (different bootloader) → device.layout, no backup, no write', async () => {
  const known = deviceImage();
  const manifest = await manifestFor(known);
  const { inst, fake } = await setup({ img: deviceImage({ bootloader: pattern(0x8000, 29) }), manifest });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'device.layout');
  assert.ok(fake.calls.filter((c) => c[0] === 'readFlash').every((c) => c[1] + c[2] <= HEADER), 'only the header was read');
  assert.ok(!called(fake, 'saveBackup')); assert.ok(!called(fake, 'requestBackupFile')); assert.ok(!called(fake, 'writeFlash'));
});

test('an unreadable table makes the stop say so, and never invents a layout it did not see', async () => {
  // The device in these tests carries no partition table at 0x8000, only a page of pattern bytes.
  const known = deviceImage();
  const manifest = await manifestFor(known);
  const { inst } = await setup({ img: deviceImage({ bootloader: pattern(0x8000, 29) }), manifest });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => {
    assert.equal(e.code, 'device.layout');
    assert.equal(e.params.layout, 'unreadable');
    assert.equal(e.params.settingsOffset, undefined);
    return true;
  });
});

test('a device with a real table refuses just the same, and the stop names where its settings are', async () => {
  // Same refusal as above — a bootloader that is not the one the release pinned — but this
  // device has an ESP-IDF table on it, so the person can be told what it actually has.
  const known = deviceImage();
  const manifest = await manifestFor(known);
  const img = deviceImage({ bootloader: pattern(0x8000, 29) });
  img.set(table(DEFAULT_ENTRIES), 0x8000);
  const { inst, fake, events } = await setup({ img, manifest });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => {
    assert.equal(e.code, 'device.layout');
    assert.equal(e.params.settingsOffset, 0x9000);
    assert.equal(e.params.settingsSize, 0x6000);
    return true;
  });
  assert.ok(!called(fake, 'saveBackup'), 'the refusal is the one it always was');
  assert.ok(!called(fake, 'writeFlash'));
  const layout = events.find((e) => e.type === 'layout');
  assert.deepEqual(layout.layout.entries.map((e) => e.label), ['nvs', 'phy_init', 'app0', 'app1']);
});

test('the table is read once, after the security check, and a device that answers it still installs', async () => {
  const { inst, manifest, fake, events } = await setup({ img: (() => { const i = deviceImage(); i.set(table(DEFAULT_ENTRIES), 0x8000); return i; })() });
  // The table page sits where firstInstall pins the factory table, so this device is refused —
  // what matters here is the order and the count of the diagnostic read itself.
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'device.layout');
  const names = fake.calls.map((c) => c[0]);
  assert.ok(names.indexOf('command') < names.indexOf('readFlash'), 'security state before any flash read, still');
  const tableReads = fake.calls.filter((c) => c[0] === 'readFlash' && c[1] === 0x8000 && c[2] === 0xc00);
  assert.equal(tableReads.length, 1, 'read once, not once per check');
  assert.equal(events.filter((e) => e.type === 'layout').length, 1);
});

test('a table the chip will not give up is logged and changes nothing: the install runs to the end', async () => {
  const img = deviceImage();
  const fake = makeFakeEsptool({ chipName: 'ESP32-S3', flashImage: img });
  const Base = fake.ESPLoader;
  // Only the table page fails; every other read is the fake's own, so the backup still works.
  fake.ESPLoader = class extends Base {
    async readFlash(addr, n) {
      if (addr === 0x8000 && n === 0xc00) { fake.calls.push(['readFlash', addr, n]); throw new Error('timed out waiting for packet header'); }
      return super.readFlash(addr, n);
    }
  };
  const { inst, manifest, events } = await setup({ img, fake });
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true, 'a failed diagnostic read must never turn a working install into a failed one');
  assert.deepEqual(events.filter((e) => e.type === 'layout').map((e) => e.layout), [null]);
  assert.ok(events.some((e) => e.type === 'log' && /partitions: could not be read/.test(e.line)));
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

/* --- The backup saved through a file handle (File System Access API) ------ */

/**
 * A fake `showSaveFilePicker` for the engine tests: the handle keeps what was written and
 * hands it back from `getFile()`, unless `readBack` replaces the bytes or `abort` cancels.
 */
function fakePicker({ name = 'Home-copy.bin', abort = false, readBack = null } = {}) {
  const log = { written: [], options: null, reads: 0 };
  const handle = {
    name,
    async createWritable() { return { async write(b) { log.written.push(new Uint8Array(b)); }, async close() {}, async abort() {} }; },
    async getFile() {
      log.reads++;
      const bytes = readBack ?? log.written.at(-1);
      return { size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
    },
  };
  const picker = async (options) => {
    log.options = options;
    if (abort) { const e = new Error('The user aborted a request.'); e.name = 'AbortError'; throw e; }
    return handle;
  };
  return { picker, handle, log };
}

test('handle path: the copy is written through the picked handle, read back and verified; the file dialog is never opened', async () => {
  const { picker, log } = fakePicker({ name: 'my-device.bin' });
  const { inst, manifest, fake, img, events } = await setup({ saveBackup: (bytes, name) => saveBackupWithHandle(bytes, name, { picker }) });
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
  assert.ok(called(fake, 'saveBackup'));
  assert.ok(!called(fake, 'requestBackupFile'), 'no re-selection dialog when the handle path was used');
  assert.equal(log.written.length, 1);
  assert.equal(firstDiff(log.written[0], img), -1, 'the bytes on disk are the whole original flash');
  assert.equal(log.reads, 1, 'read back exactly once');
  assert.match(log.options.suggestedName, /^Home-backup-[0-9a-f]{8}\.bin$/);
  assert.equal(r.backup.filename, 'my-device.bin', 'the result names the file as the user saved it');
  assert.equal(r.backup.sha256, await sha256Hex(img));
  const names = fake.calls.map((c) => c[0]);
  assert.ok(names.indexOf('writeFlash') > names.indexOf('saveBackup'), 'nothing is written before the copy is verified on disk');
  // The read-back announces itself on the first layer with the name the user sees.
  const readBack = events.find((e) => e.type === 'stage' && e.stage === 'backup' && e.params?.phase === 'readBack');
  assert.ok(readBack, 'a backup stage event marks the read-back');
  assert.equal(readBack.params.file, 'my-device.bin');
  const save = events.find((e) => e.type === 'stage' && e.stage === 'backup' && e.params?.phase === 'save');
  assert.ok(save, 'a backup stage event marks the moment the copy is ready to be saved');
  assert.ok(events.indexOf(save) < events.indexOf(readBack));
  assert.ok(events.some((e) => e.type === 'log' && e.line.includes('my-device.bin')));
});

test('handle path: what comes back from disk differs from the copy → backup.file, nothing written', async () => {
  const img = deviceImage();
  const other = img.slice(); other[0x400000] ^= 0x01;
  const { picker, log } = fakePicker({ readBack: other });
  const { inst, manifest, fake } = await setup({ img, saveBackup: (bytes, name) => saveBackupWithHandle(bytes, name, { picker }) });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'backup.file' && e.params.filename === 'Home-copy.bin');
  assert.equal(log.written.length, 1, 'the copy was written');
  assert.ok(!called(fake, 'requestBackupFile'));
  assert.ok(!called(fake, 'writeFlash'));
  assert.ok(called(fake, 'disconnect'));
  // A short file is caught by its length alone.
  const short = fakePicker({ readBack: img.slice(0, FLASH - 1) });
  const s2 = await setup({ img, saveBackup: (bytes, name) => saveBackupWithHandle(bytes, name, { picker: short.picker }) });
  await assert.rejects(s2.inst.run({ manifest: s2.manifest, mode: 'first', options: {} }), (e) => e.code === 'backup.file');
  assert.ok(!called(s2.fake, 'writeFlash'));
});

test('handle path: the user cancels the save picker → serial.cancelled, nothing written, no file dialog', async () => {
  const { picker, log } = fakePicker({ abort: true });
  const { inst, manifest, fake, events } = await setup({ saveBackup: (bytes, name) => saveBackupWithHandle(bytes, name, { picker }) });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'serial.cancelled');
  assert.equal(log.written.length, 0);
  assert.ok(!called(fake, 'requestBackupFile'));
  assert.ok(!called(fake, 'writeFlash'));
  assert.ok(called(fake, 'disconnect'));
  assert.equal(events.at(-1).type, 'error');
});

test('no save picker in this browser: saveBackup yields null and the download + re-selection path runs end to end', async () => {
  const { inst, manifest, fake, img, saved } = await setup({ saveBackup: (bytes, name) => saveBackupWithHandle(bytes, name, { picker: undefined }) });
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
  assert.ok(called(fake, 'saveBackup'));
  assert.ok(called(fake, 'requestBackupFile'), 'the fallback still asks for the file');
  assert.equal(firstDiff(saved[0], img), -1);
  assert.match(r.backup.filename, /^Home-backup-[0-9a-f]{8}\.bin$/);
});

test('a handle result without a handle object is treated as the fallback, never as a verified copy', async () => {
  const { inst, manifest, fake } = await setup({ saveBackup: async () => ({ name: 'nothing-behind-it.bin' }) });
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
  assert.ok(called(fake, 'requestBackupFile'), 'without a handle the file must be handed back');
  assert.match(r.backup.filename, /^Home-backup-/);
});

test('bytes outside written parts are unchanged after write (positive control: a fake that corrupts 0x9000 fails flash.verify)', async () => {
  const { inst, manifest, fake, events } = await setup({ fakeOptions: { corruptAt: 0x9000 } });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'flash.verify');
  assert.equal(fake.calls.filter((c) => c[0] === 'writeFlash').length, 2, 'both parts were written and MD5-checked before the read-back caught it');
  assert.ok(!called(fake, 'after'), 'no reset after a failed verification');
  assert.equal(events.at(-1).type, 'error');
  assert.ok(called(fake, 'disconnect'));
});

test('sector padding: bytes the write erases beside the table (0x8C00-0x9000) read back 0xff and the install verifies', async () => {
  const img = deviceImage();
  assert.ok(img.subarray(0x8c00, 0x9000).some((b) => b !== 0xff), 'the factory table page is not blank there before the write');
  const { inst, manifest, fake } = await setup({ img });
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
  assert.ok(fake.flash.subarray(0x8c00, 0x9000).every((b) => b === 0xff), 'the write erased the rest of the sector');
  assert.equal(firstDiff(fake.flash.subarray(0x9000, 0x20000), img.subarray(0x9000, 0x20000)), -1, 'nothing else in the header moved');
});

test('positive control: a non-0xff byte left in the sector padding after the write → flash.verify', async () => {
  // 0x8F00 lies in the table's sector but outside the 3072-byte part; the chip must have erased it.
  const { inst, manifest, fake } = await setup({ fakeOptions: { corruptAt: 0x8f00 } });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'flash.verify' && e.params.offset === '0x8f00');
  assert.equal(fake.calls.filter((c) => c[0] === 'writeFlash').length, 2);
  assert.ok(!called(fake, 'after'));
});

test('first mode: the header read covers the table page (0x9000) even when no other range reaches it', async () => {
  const img = deviceImage();
  const { inst, manifest, fake } = await setup({ img, manifest: await manifestFor(img, { minimal: true }) });
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
  const headerReads = fake.calls.filter((c) => c[0] === 'readFlash' && c[1] === 0 && c[2] !== 256 * 1024);
  assert.ok(headerReads.length >= 2);
  assert.ok(headerReads.every((c) => c[2] === 0x9000), `header reads are 0x9000 bytes: ${headerReads.map((c) => c[2].toString(16))}`);
});

test('runPreserve rejects before any write when ctx has no setWriting', async () => {
  const img = deviceImage();
  const fake = makeFakeEsptool({ chipName: 'ESP32-S3', flashImage: img });
  fakes.push(fake);
  const manifest = await manifestFor(img);
  const loader = new fake.ESPLoader({});
  await loader.main();
  const build = manifest.builds[0];
  const parts = [{ offset: 0x20000, data: APP, path: 'app.bin', sha256: build.parts[0].sha256 }, { offset: 0x8000, data: TABLE, path: 'table.bin', sha256: build.parts[1].sha256 }];
  let saved;
  const ctx = {
    job: { manifest, mode: 'first', options: {} },
    connect: async () => ({ chipFamily: 'ESP32-S3', chipDescription: 'x', features: [], flashSizeMB: 16 }),
    pick: async () => build, download: async () => parts, loader: () => loader,
    stage() {}, log() {}, emit() {}, check() {},
    deps: { saveBackup: async (b) => { saved = b; }, requestBackupFile: async () => fileOf(saved) },
  };
  await assert.rejects(runPreserve(ctx));
  assert.ok(saved, 'the flow got as far as the backup');
  assert.ok(!called(fake, 'writeFlash'));
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
  assert.ok(fakes.length >= 24, `expected the preserve scenarios above to have run (${fakes.length})`);
  for (const fake of fakes) assert.ok(!called(fake, 'eraseFlash'));
});

/* --- the release's own MD5, on top of the read-back that was always here ----- */

/** The same manifest with `md5` on every part, which is what `tools/manifest.py` now writes. */
async function manifestWithMd5(img, { app = APP, wrong = null } = {}) {
  const m = await manifestFor(img, { app });
  const bytes = { 'app.bin': app, 'table.bin': TABLE };
  for (const p of m.builds[0].parts) p.md5 = wrong === p.path ? 'a'.repeat(32) : md5Hex(bytes[p.path]);
  return m;
}

test('preserve asks the chip twice per part: once for what it sent, once for what the release declares', async () => {
  const img = deviceImage();
  const { inst, manifest, events, fake } = await setup({ img, manifest: await manifestWithMd5(img) });
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
  assert.deepEqual(fake.calls.filter((c) => c[0] === 'flashMd5sum').map((c) => c.slice(1)),
    [[0x20000, APP.length], [0x8000, TABLE.length], [0x20000, APP.length], [0x8000, TABLE.length]],
    'the per-part read-back during the write, then the release cross-check after it');
  const log = events.filter((e) => e.type === 'log').map((e) => e.line).join('\n');
  assert.match(log, /md5 app\.bin: the chip reports the value the release declares/);
  assert.match(log, /md5 table\.bin: the chip reports the value the release declares/);
});

test('a preserve part whose declared md5 is wrong never reaches the device', async () => {
  const img = deviceImage();
  const { inst, manifest, fake } = await setup({ img, manifest: await manifestWithMd5(img, { wrong: 'app.bin' }) });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'verify.md5');
  assert.ok(!called(fake, 'writeFlash'), 'the download check comes long before the first write');
});
