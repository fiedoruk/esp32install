import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstaller, mapSerialError, flashSizeFromId } from '../app/engine.js';
import { normalizeManifest } from '../app/manifest.js';
import { makeFakeEsptool } from './helpers/fakeEsptool.js';
import { sha256Hex } from '../app/verify.js';

function image(chipId) { const d = new Uint8Array(0x3000).fill(0xff); d[0x1000] = 0xe9; d[0x1000 + 12] = chipId; d[0x1000 + 13] = 0; return d; }

async function setup({ fake = makeFakeEsptool(), img = image(0), sha, confirm = true, choose, fetch, confirmFn, saveBackup, now } = {}) {
  const manifest = normalizeManifest({ name: 'Demo', version: '1.0', new_install_prompt_erase: true,
    builds: [{ chipFamily: 'ESP32', parts: [{ path: 'demo.bin', offset: 0, size: img.length, ...(sha ? { sha256: sha } : {}) }] }] },
    'https://h/install/manifests/demo.json');
  const events = [];
  const port = { getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x55d4 }) };
  const inst = createInstaller({
    esptool: fake,
    requestPort: async () => port,
    fetchFn: fetch ?? (async () => ({ ok: true, status: 200, arrayBuffer: async () => img.buffer.slice(0) })),
    onEvent: (e) => events.push(e),
    chooseBuild: choose ?? (async (builds) => builds[0]),
    confirmErase: confirmFn ?? (async () => confirm),
    saveBackup: saveBackup ?? (async () => { throw new Error('saveBackup must not be called unless options.backup is true'); }),
    ...(now ? { now } : {}),
  });
  return { inst, manifest, events, fake, port };
}
const called = (fake, name) => fake.calls.some((c) => c[0] === name);

test('happy path: connect, detect, verify, erase (confirmed), write with MD5, reset', async () => {
  const { inst, manifest, events, fake, port } = await setup();
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
  assert.equal(fake.transports.length, 1);
  assert.deepEqual(fake.transports[0].args, [port, false, true]);
  const names = fake.calls.map((c) => c[0]);
  assert.deepEqual(names, ['transport', 'main', 'readFlashId', 'eraseFlash', 'writeFlash', 'after', 'disconnect']);
  const w = fake.calls.find((c) => c[0] === 'writeFlash');
  assert.deepEqual(w[1], [[0, 0x3000]]); assert.equal(w[2], false); assert.equal(w[3], true);
  assert.ok(events.some((e) => e.type === 'hardware' && e.hw.flashSizeMB === 16));
  assert.equal(events.at(-1).type, 'done');
});

test('erase declined → no eraseFlash call, still writes', async () => {
  const { inst, manifest, fake } = await setup({ confirm: false });
  await inst.run({ manifest, mode: 'first', options: {} });
  assert.ok(!fake.calls.some((c) => c[0] === 'eraseFlash'));
  assert.ok(fake.calls.some((c) => c[0] === 'writeFlash'));
});

test('sha256 mismatch stops before erase or write', async () => {
  const { inst, manifest, fake, events } = await setup({ sha: 'f'.repeat(64) });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'verify.sha256');
  assert.ok(!fake.calls.some((c) => c[0] === 'eraseFlash' || c[0] === 'writeFlash'));
  assert.equal(events.at(-1).type, 'error');
  assert.ok(fake.calls.some((c) => c[0] === 'disconnect'));
});

test('wrong chip family → device.noMatch with reasons, nothing written', async () => {
  const fake = makeFakeEsptool({ chipName: 'ESP32-S3' });
  const { inst, manifest } = await setup({ fake });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'device.noMatch' && e.params.chip === 'ESP32-S3');
  assert.ok(!fake.calls.some((c) => c[0] === 'writeFlash'));
});

test('unknown flash size id → device.flashUnknown (never defaults to 4 MB)', async () => {
  const fake = makeFakeEsptool({ flashId: 0x00ff40c8 });
  const { inst, manifest } = await setup({ fake });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'device.flashUnknown');
});

test('MD5 mismatch reported by esptool-js → flash.verify', async () => {
  const fake = makeFakeEsptool({ md5Mismatch: true });
  const { inst, manifest, events } = await setup({ fake });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'flash.verify');
  assert.equal(events.at(-1).type, 'error');
  assert.ok(fake.calls.some((c) => c[0] === 'disconnect'));
});

test('mapSerialError maps the exact esptool-js MD5 message to flash.verify', () => {
  const e = mapSerialError(new Error('MD5 of file does not match data in flash!'));
  assert.equal(e.code, 'flash.verify');
  assert.equal(e.cause.message, 'MD5 of file does not match data in flash!');
});

test('eraseFlash failure → flash.erase, nothing written', async () => {
  const fake = makeFakeEsptool({ failErase: true });
  const { inst, manifest, events } = await setup({ fake });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'flash.erase');
  assert.ok(!fake.calls.some((c) => c[0] === 'writeFlash'));
  assert.equal(events.at(-1).type, 'error');
  assert.ok(fake.calls.some((c) => c[0] === 'disconnect'));
});

test('image built for another chip → verify.wrongChip before any write', async () => {
  const { inst, manifest, fake } = await setup({ img: image(9) });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'verify.wrongChip');
  assert.ok(!fake.calls.some((c) => c[0] === 'eraseFlash' || c[0] === 'writeFlash'));
});

test('connect failure maps to serial.connect', async () => {
  const fake = makeFakeEsptool({ failConnect: true });
  const { inst, manifest, events } = await setup({ fake });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'serial.connect');
  assert.equal(events.at(-1).type, 'error');
});

test('sha256 of the written image is reported in the result', async () => {
  const img = image(0);
  const { inst, manifest } = await setup({ img });
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.parts[0].sha256, await sha256Hex(img));
});

test('flashSizeFromId rejects dead-flash ids 0x000000 and 0xffffff', () => {
  const loader = { DETECTED_FLASH_SIZES: { 0x16: '4MB' } };
  assert.throws(() => flashSizeFromId(loader, 0), (e) => e.code === 'device.flashUnknown');
  assert.throws(() => flashSizeFromId(loader, 0xffffff), (e) => e.code === 'device.flashUnknown');
  assert.equal(flashSizeFromId(loader, 0x001640c8), 4);
});

test('a second run while one is in flight → engine.busy', async () => {
  const { inst, manifest } = await setup();
  const first = inst.run({ manifest, mode: 'first', options: {} });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'engine.busy');
  await first;
});

test('cancel() from inside confirmErase → serial.cancelled, no erase, no write, disconnect called', async () => {
  let inst;
  const s = await setup({ confirmFn: async () => { inst.cancel(); return true; } });
  inst = s.inst;
  await assert.rejects(inst.run({ manifest: s.manifest, mode: 'first', options: {} }), (e) => e.code === 'serial.cancelled');
  assert.ok(!called(s.fake, 'eraseFlash'));
  assert.ok(!called(s.fake, 'writeFlash'));
  assert.ok(called(s.fake, 'disconnect'));
  assert.equal(s.events.at(-1).type, 'error');
});

test('fetchFn rejecting (network) → manifest.fetch with status 0, nothing erased or written', async () => {
  const { inst, manifest, fake } = await setup({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'manifest.fetch' && e.params.status === 0 && e.cause instanceof TypeError);
  assert.ok(!called(fake, 'eraseFlash'));
  assert.ok(!called(fake, 'writeFlash'));
});

test('redirect to another origin → manifest.origin, nothing erased or written', async () => {
  const img = image(0);
  const { inst, manifest, fake } = await setup({ img, fetch: async () => ({ ok: true, status: 200, url: 'https://evil.example/demo.bin', arrayBuffer: async () => img.buffer.slice(0) }) });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'manifest.origin' && e.params.origin === 'https://evil.example');
  assert.ok(!called(fake, 'eraseFlash'));
  assert.ok(!called(fake, 'writeFlash'));
});

test('redirect within the same origin is accepted', async () => {
  const img = image(0);
  const { inst, manifest } = await setup({ img, fetch: async () => ({ ok: true, status: 200, url: 'https://h/cdn/demo-v1.bin', arrayBuffer: async () => img.buffer.slice(0) }) });
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
});

test('reset failure after a verified write still resolves with verified: true and a done event', async () => {
  const fake = makeFakeEsptool({ failReset: true });
  const { inst, manifest, events } = await setup({ fake });
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
  assert.ok(called(fake, 'after'));
  assert.equal(events.at(-1).type, 'done');
  assert.ok(events.some((e) => e.type === 'log' && /reset: Failed to reset device/.test(e.line)));
  assert.ok(!events.some((e) => e.type === 'error'));
  const doneIdx = events.findIndex((e) => e.type === 'stage' && e.stage === 'done');
  const resetLogIdx = events.findIndex((e) => e.type === 'log' && /^reset: /.test(e.line));
  assert.ok(resetLogIdx >= 0 && doneIdx > resetLogIdx, 'done stage must follow the reset attempt');
});

test('device lost during download → serial.lost, nothing written', async () => {
  const img = image(0);
  const fake = makeFakeEsptool();
  const { inst, manifest } = await setup({ img, fake, fetch: async () => {
    fake.transports[0].lost();
    return { ok: true, status: 200, arrayBuffer: async () => img.buffer.slice(0) };
  } });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'serial.lost');
  assert.ok(!called(fake, 'eraseFlash'));
  assert.ok(!called(fake, 'writeFlash'));
  assert.ok(called(fake, 'disconnect'));
});

test('unknown errors map to engine.unexpected before a write and flash.write during one', () => {
  const err = new Error('something odd');
  assert.equal(mapSerialError(err).code, 'engine.unexpected');
  assert.equal(mapSerialError(err, { writing: false }).code, 'engine.unexpected');
  assert.equal(mapSerialError(err, { writing: true }).code, 'flash.write');
});

test('an unknown error thrown before the write is reported as engine.unexpected by run()', async () => {
  const fake = makeFakeEsptool();
  const { inst, manifest } = await setup({ fake, choose: undefined, confirmFn: async () => { throw new Error('ui exploded'); } });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'engine.unexpected');
  assert.ok(!called(fake, 'writeFlash'));
});

test('write progress scales compressed byte counts to the uncompressed image', async () => {
  const { inst, manifest, events } = await setup();
  await inst.run({ manifest, mode: 'first', options: {} });
  const w = events.filter((e) => e.type === 'stage' && e.stage === 'writing');
  assert.ok(w.length >= 2, 'fake reports at least two progress steps');
  // The fake reports totals of data.length / 3 (compressed); the ratio must still reach the end.
  assert.ok(w.at(-1).params.partTotal < 0x3000);
  assert.ok(w.at(-1).percent >= 89, `last writing percent ${w.at(-1).percent}`);
  for (const e of w) assert.ok(e.percent <= 90 && e.percent >= 40, `percent out of range: ${e.percent}`);
  assert.ok(w[0].percent < w.at(-1).percent, 'progress is monotonic across steps');
});

test('a hand-built Response with url === "" passes the origin check', async () => {
  const img = image(0);
  const { inst, manifest } = await setup({ img, fetch: async () => ({ ok: true, status: 200, url: '', arrayBuffer: async () => img.buffer.slice(0) }) });
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
});

test('factory with options.backup: true saves one whole-flash copy before the erase; false never calls saveBackup', async () => {
  const saved = [];
  const { inst, manifest, fake } = await setup({ saveBackup: async (bytes, name) => { fake.calls.push(['saveBackup', name]); saved.push({ bytes, name }); } });
  const r = await inst.run({ manifest, mode: 'first', options: { backup: true } });
  assert.equal(r.verified, true);
  const names = fake.calls.map((c) => c[0]);
  assert.equal(names.filter((n) => n === 'saveBackup').length, 1);
  assert.ok(names.indexOf('saveBackup') < names.indexOf('eraseFlash'), 'the copy is taken before the erase');
  assert.ok(names.indexOf('saveBackup') > names.indexOf('readFlashId'));
  assert.equal(saved[0].bytes.length, 16 * 1024 * 1024);
  assert.ok(saved[0].bytes.every((b) => b === 0xff), 'the copy is the blank flash the fake started with');
  assert.match(saved[0].name, /^Demo-backup-[0-9a-f]{8}\.bin$/);
  assert.equal(saved[0].name.slice(12, 20), (await sha256Hex(saved[0].bytes)).slice(0, 8));
  // Only one read pass: a keepsake, not a gate.
  assert.equal(fake.calls.filter((c) => c[0] === 'readFlash').length, 64);

  const s2 = await setup();
  await s2.inst.run({ manifest: s2.manifest, mode: 'first', options: { backup: false } });
  assert.ok(!called(s2.fake, 'saveBackup'));
  assert.ok(!called(s2.fake, 'readFlash'));
  const s3 = await setup();
  await s3.inst.run({ manifest: s3.manifest, mode: 'first', options: {} });
  assert.ok(!called(s3.fake, 'saveBackup'));
});

test('the optional factory backup reports a time estimate after the first chunk', async () => {
  let t = 0;
  const { inst, manifest, events } = await setup({ saveBackup: async () => {}, now: () => (t += 1500) });
  await inst.run({ manifest, mode: 'first', options: { backup: true } });
  const backup = events.filter((e) => e.type === 'stage' && e.stage === 'backup');
  assert.equal(backup[0].eta, undefined);
  const measured = backup.slice(1);
  assert.equal(measured.length, 64, 'one 16 MiB read in 256 KiB chunks');
  assert.ok(measured.every((e) => Number.isFinite(e.eta) && e.eta >= 0));
  assert.equal(measured.at(-1).eta, 0);
});

test('an application image for another chip stops a factory install even when it does not cover the bootloader offset', async () => {
  const fake = makeFakeEsptool({ chipName: 'ESP32-S3' });
  const app = new Uint8Array(0x100).fill(0xff); app[0] = 0xe9; app[12] = 0; app[13] = 0; // ESP32 app image
  const manifest = normalizeManifest({ name: 'Demo', version: '1.0', builds: [{ chipFamily: 'ESP32-S3', parts: [{ path: 'app.bin', offset: 0x10000, size: app.length }] }] },
    'https://h/install/manifests/demo.json');
  const inst = createInstaller({ esptool: fake, requestPort: async () => ({ getInfo: () => ({}) }),
    fetchFn: async () => ({ ok: true, status: 200, arrayBuffer: async () => app.buffer.slice(0) }),
    chooseBuild: async (b) => b[0], confirmErase: async () => true, saveBackup: async () => {} });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'verify.wrongChip' && e.params.offset === 0x10000);
  assert.ok(!called(fake, 'eraseFlash')); assert.ok(!called(fake, 'writeFlash'));
});
