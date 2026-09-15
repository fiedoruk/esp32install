import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstaller, mapSerialError, flashSizeFromId } from '../app/engine.js';
import { normalizeManifest } from '../app/manifest.js';
import { makeFakeEsptool } from './helpers/fakeEsptool.js';
import { sha256Hex } from '../app/verify.js';

function image(chipId) { const d = new Uint8Array(0x3000).fill(0xff); d[0x1000] = 0xe9; d[0x1000 + 12] = chipId; d[0x1000 + 13] = 0; return d; }

async function setup({ fake = makeFakeEsptool(), img = image(0), sha, confirm = true, choose, fetch, confirmFn } = {}) {
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
