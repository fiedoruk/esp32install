import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstaller, mapSerialError, flashSizeFromId } from '../app/engine.js';
import { normalizeManifest } from '../app/manifest.js';
import { makeFakeEsptool } from './helpers/fakeEsptool.js';
import { sha256Hex } from '../app/verify.js';

function image(chipId) { const d = new Uint8Array(0x3000).fill(0xff); d[0x1000] = 0xe9; d[0x1000 + 12] = chipId; d[0x1000 + 13] = 0; return d; }

async function setup({ fake = makeFakeEsptool(), img = image(0), sha, confirm = true, choose } = {}) {
  const manifest = normalizeManifest({ name: 'Demo', version: '1.0', new_install_prompt_erase: true,
    builds: [{ chipFamily: 'ESP32', parts: [{ path: 'demo.bin', offset: 0, size: img.length, ...(sha ? { sha256: sha } : {}) }] }] },
    'https://h/install/manifests/demo.json');
  const events = [];
  const inst = createInstaller({
    esptool: fake,
    requestPort: async () => ({ getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x55d4 }) }),
    fetchFn: async () => ({ ok: true, status: 200, arrayBuffer: async () => img.buffer.slice(0) }),
    onEvent: (e) => events.push(e),
    chooseBuild: choose ?? (async (builds) => builds[0]),
    confirmErase: async () => confirm,
  });
  return { inst, manifest, events, fake };
}

test('happy path: connect, detect, verify, erase (confirmed), write with MD5, reset', async () => {
  const { inst, manifest, events, fake } = await setup();
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
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
