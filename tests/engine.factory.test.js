import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstaller, mapSerialError, flashSizeFromId, fetchOwnFile } from '../app/engine.js';
import { normalizeManifest, localManifest } from '../app/manifest.js';
import { makeFakeEsptool } from './helpers/fakeEsptool.js';

/** One bare loader, for the tests that drive a single command instead of a whole install. */
const ESPLoaderFor = class { constructor(o) { return new (makeFakeEsptool(o).ESPLoader)({}); } };
import { sha256Hex } from '../app/verify.js';

function image(chipId) { const d = new Uint8Array(0x3000).fill(0xff); d[0x1000] = 0xe9; d[0x1000 + 12] = chipId; d[0x1000 + 13] = 0; return d; }

async function setup({ fake = makeFakeEsptool(), img = image(0), sha, confirm = true, choose, fetch, confirmFn, saveBackup, now, over = {} } = {}) {
  const manifest = normalizeManifest({ name: 'Demo', version: '1.0', new_install_prompt_erase: true,
    builds: [{ chipFamily: 'ESP32', parts: [{ path: 'demo.bin', offset: 0, size: img.length, ...(sha ? { sha256: sha } : {}) }] }], ...over },
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
  // The one readFlash is the partition table, read after the security check for the record: it
  // is between 'command' and 'eraseFlash' because nothing is read off a chip whose state is unknown.
  assert.deepEqual(names, ['transport', 'main', 'readFlashId', 'command', 'readFlash', 'eraseFlash', 'writeFlash', 'after', 'disconnect']);
  assert.deepEqual(fake.calls.find((c) => c[0] === 'readFlash').slice(1), [0x8000, 0xc00]);
  assert.ok(events.some((e) => e.type === 'layout'), 'and it is reported to the page');
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

/* --- the secure-boot and flash-encryption gate ------------------------------- */

test('a locked device stops a factory install before anything is downloaded, erased or written', async () => {
  const flagged = new Uint8Array(20); flagged[0] = 0x01;
  const encrypted = new Uint8Array(20); encrypted[4] = 0x01;
  for (const fakeOptions of [{ securityInfo: flagged }, { securityInfo: encrypted }, { securityInfo: new Uint8Array(4) }]) {
    const fake = makeFakeEsptool(fakeOptions);
    const fetches = [];
    const { inst, manifest, events } = await setup({ fake, fetch: async (u) => { fetches.push(u); throw new Error('nothing may be fetched'); } });
    await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'device.secured');
    assert.deepEqual(fetches, []);
    assert.ok(!called(fake, 'eraseFlash'));
    assert.ok(!called(fake, 'writeFlash'));
    assert.ok(called(fake, 'disconnect'));
    assert.equal(events.at(-1).type, 'error');
  }
});

test('a chip whose ROM has no security-info command is not blocked from a factory install', async () => {
  const fake = makeFakeEsptool({ securityRejects: true }); // classic ESP32, no efuses to read either
  const { inst, manifest, events } = await setup({ fake });
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
  assert.ok(called(fake, 'writeFlash'));
  const log = events.filter((e) => e.type === 'log').map((e) => e.line).join('\n');
  assert.match(log, /security info:/, 'the reason is in the log, not in a stop');
  assert.match(log, /could not be read/);
});

test('classic ESP32: the efuses answer when the command does not, and a locked one still stops the install', async () => {
  const cases = [
    { efuse: { 0: 1 << 20, 6: 0 }, locked: true, why: 'FLASH_CRYPT_CNT with one bit blown means encrypted' },
    { efuse: { 0: 0, 6: 1 << 4 }, locked: true, why: 'ABS_DONE_0: secure boot v1' },
    { efuse: { 0: 0, 6: 1 << 5 }, locked: true, why: 'ABS_DONE_1: secure boot v2' },
    { efuse: { 0: 3 << 20, 6: 0 }, locked: false, why: 'two bits blown is an even count: encryption off' },
    { efuse: { 0: 0, 6: 0 }, locked: false, why: 'a blank board' },
  ];
  for (const { efuse, locked, why } of cases) {
    const fake = makeFakeEsptool({ securityRejects: true, efuse });
    const { inst, manifest } = await setup({ fake });
    const run = inst.run({ manifest, mode: 'first', options: {} });
    if (locked) {
      await assert.rejects(run, (e) => e.code === 'device.secured' && e.params.source === 'efuse', why);
      assert.ok(!called(fake, 'eraseFlash'), why);
      assert.ok(!called(fake, 'writeFlash'), why);
    } else {
      assert.equal((await run).verified, true, why);
      assert.ok(called(fake, 'writeFlash'), why);
    }
    assert.deepEqual(fake.calls.filter((c) => c[0] === 'readEfuse').map((c) => c[1]), [0, 6], 'the two block-0 words esptool reads');
  }
});

/**
 * The shape of the answer, not just its contents. An ESP32-S2 replies to command 0x14 with 12
 * bytes where an ESP32-S3 replies with 20, and the gate used to demand 20 through the vendored
 * `checkCommand` — whose exception it then read as "this ROM has no such command". An S2 with
 * flash encryption on therefore fell through to an efuse path that only understands the classic
 * ESP32, ended at `unknown`, and `factory` wrote plaintext over an encrypted layout.
 * NOT MEASURED on hardware: there is no ESP32-S2 here.
 */
test('ESP32-S2: the 12-byte security answer is read, and an encrypted board stops the factory install', async () => {
  const s2 = { chipFamily: 'ESP32-S2', parts: [{ path: 'demo.bin', offset: 0, size: 0x3000 }] };
  const cases = [
    { byte: 4, value: 1, locked: true, why: 'flash encryption on' },
    { byte: 0, value: 1, locked: true, why: 'a secure-boot flag in the flags word' },
    { byte: 0, value: 0, locked: false, why: 'a blank S2 installs as before' },
  ];
  for (const { byte, value, locked, why } of cases) {
    const info = new Uint8Array(12); info[byte] = value;
    const fake = makeFakeEsptool({ chipName: 'ESP32-S2', securityInfo: info });
    const { inst, manifest } = await setup({ fake, img: image(2), over: { builds: [s2] } });
    const run = inst.run({ manifest, mode: 'first', options: {} });
    if (locked) {
      await assert.rejects(run, (e) => e.code === 'device.secured', why);
      assert.ok(!called(fake, 'eraseFlash'), why);
      assert.ok(!called(fake, 'writeFlash'), why);
    } else {
      assert.equal((await run).verified, true, why);
      assert.ok(called(fake, 'writeFlash'), why);
    }
    assert.ok(!called(fake, 'readEfuse'), 'the ROM answered, so the efuses are not consulted');
  }
});

test('a reply too short to carry the two fields is a hard stop, not a shrug', async () => {
  const fake = makeFakeEsptool({ securityInfo: new Uint8Array(11) });
  const { inst, manifest } = await setup({ fake });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }),
    (e) => e.code === 'device.secured' && e.params.reason === 'malformed');
  assert.ok(!called(fake, 'writeFlash'));
});

test('a timeout or a serial error on 0x14 is not an absent command: the install stops on both profiles', async () => {
  for (const message of ['Timed out waiting for packet header', 'invalid response', 'The device has been lost.']) {
    const fake = makeFakeEsptool({ chipName: 'ESP32-S3', securityFails: message, efuse: { 0: 0, 6: 0 } });
    const s3 = { chipFamily: 'ESP32-S3', parts: [{ path: 'demo.bin', offset: 0, size: 0x3000 }] };
    const { inst, manifest } = await setup({ fake, img: image(9), over: { builds: [s3] } });
    await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }),
      (e) => e.code === 'device.secured' && e.params.reason === 'unreadable', message);
    assert.ok(!called(fake, 'eraseFlash'), message);
    assert.ok(!called(fake, 'writeFlash'), message);
  }
});

test('ESP8266 is answered without asking: the command it has no answer for is never sent', async () => {
  const fake = makeFakeEsptool({ chipName: 'ESP8266' });
  const boot = new Uint8Array(0x3000).fill(0xff); boot[0] = 0xe9;
  const { inst, manifest, events } = await setup({
    fake, img: boot,
    over: { builds: [{ chipFamily: 'ESP8266', parts: [{ path: 'demo.bin', offset: 0, size: 0x3000 }] }] },
  });
  assert.equal((await inst.run({ manifest, mode: 'first', options: {} })).verified, true);
  assert.ok(!called(fake, 'command'), 'no five-second timeout to wait out');
  const log = events.filter((e) => e.type === 'log').map((e) => e.line).join('\n');
  assert.match(log, /neither secure boot nor flash encryption/);
});

/**
 * Why the gate stopped using the vendored helper. This drives `checkCommand` directly, so the
 * reason is pinned to the library's own rule rather than to a sentence in a comment: a 12-byte
 * answer cannot satisfy `resplen 20`, and `resplen 12` would read the status bytes out of the
 * middle of a 20-byte answer.
 */
test('the vendored checkCommand cannot ask this question at either length', async () => {
  const s2 = new ESPLoaderFor({ securityInfo: new Uint8Array(12) });
  await assert.rejects(() => s2.checkCommand('security info', 0x14, new Uint8Array(0), 0, 20, 5000),
    /Only got 14 bytes of data/, 'the old call, against an ESP32-S2');
  assert.equal((await s2.checkCommand('security info', 0x14, new Uint8Array(0), 0, 12, 5000)).length, 12);
  const s3info = new Uint8Array(20); s3info[12] = 9; // the chip id an ESP32-S3 puts there
  const s3 = new ESPLoaderFor({ securityInfo: s3info });
  await assert.rejects(() => s3.checkCommand('security info', 0x14, new Uint8Array(0), 0, 12, 5000),
    /failed with status 9,0/, 'asking for 12 reads the chip id as a failure status');
  assert.equal((await s3.checkCommand('security info', 0x14, new Uint8Array(0), 0, 20, 5000)).length, 20);
});

/* --- a build that always erases still asks, and tells the truth --------------- */

test('eraseAll asks before erasing, in update mode too, and says the settings cannot be kept', async () => {
  for (const mode of ['update', 'first']) {
    const asked = [];
    const { inst, manifest, fake } = await setup({
      over: { eraseAll: true, new_install_prompt_erase: false },
      confirmFn: async (build, m, options) => { asked.push({ mode: m, options }); return true; },
    });
    assert.equal(manifest.builds[0].eraseAll, true);
    await inst.run({ manifest, mode, options: {} });
    assert.deepEqual(asked, [{ mode, options: { required: true } }], `the ${mode} door still gets the dialog`);
    assert.ok(called(fake, 'eraseFlash'));
    assert.ok(called(fake, 'writeFlash'));
  }
});

test('declining that dialog stops the install: nothing is erased and nothing is written', async () => {
  const { inst, manifest, fake, events } = await setup({
    over: { eraseAll: true, new_install_prompt_erase: false },
    confirmFn: async () => false,
  });
  await assert.rejects(inst.run({ manifest, mode: 'update', options: {} }), (e) => e.code === 'serial.cancelled');
  assert.ok(!called(fake, 'eraseFlash'));
  assert.ok(!called(fake, 'writeFlash'));
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).changed, false, 'the device is untouched, and the page may say so');
});

test('a build with eraseAll and new_install_prompt_erase asks exactly once', async () => {
  const asked = [];
  const { inst, manifest, fake } = await setup({
    over: { eraseAll: true, new_install_prompt_erase: true },
    confirmFn: async (build, mode, options) => { asked.push(options); return true; },
  });
  await inst.run({ manifest, mode: 'update', options: {} });
  assert.deepEqual(asked, [{ required: true }]);
  assert.equal(fake.calls.filter((c) => c[0] === 'eraseFlash').length, 1);
});

test('positive control: without eraseAll the update door may still keep the settings', async () => {
  const asked = [];
  const { inst, manifest, fake } = await setup({ confirmFn: async (build, mode, options) => { asked.push(options); return false; } });
  await inst.run({ manifest, mode: 'update', options: {} });
  assert.deepEqual(asked, [{ required: false }]);
  assert.ok(!called(fake, 'eraseFlash'), 'declining keeps the settings and installs anyway');
  assert.ok(called(fake, 'writeFlash'));
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

test('factory with options.backup: true saves a verified whole-flash copy before the erase; false never calls saveBackup', async () => {
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
  // Two read passes that had to agree: the page promises a copy that puts the device back.
  // The table page is read too, once; it is the diagnostic read and belongs to neither pass.
  const reads = fake.calls.filter((c) => c[0] === 'readFlash').map((c) => c.slice(1));
  assert.deepEqual(reads.filter(([, n]) => n === 0xc00), [[0x8000, 0xc00]]);
  assert.equal(reads.filter(([, n]) => n !== 0xc00).length, 128);

  const s2 = await setup();
  await s2.inst.run({ manifest: s2.manifest, mode: 'first', options: { backup: false } });
  assert.ok(!called(s2.fake, 'saveBackup'));
  assert.deepEqual(s2.fake.calls.filter((c) => c[0] === 'readFlash').map((c) => c.slice(1)), [[0x8000, 0xc00]], 'without a copy, the table page is the only thing read');
  const s3 = await setup();
  await s3.inst.run({ manifest: s3.manifest, mode: 'first', options: {} });
  assert.ok(!called(s3.fake, 'saveBackup'));
});

test('the factory copy is read twice: two reads that disagree stop the install before the erase', async () => {
  // The page offers the copy as a way to put the device back exactly as it was, so a copy it
  // cannot vouch for is a stop, not a shrug. Nothing has been erased or written at this point.
  const fake = makeFakeEsptool({ tamperRead: (addr, n, index, data) => { if (index === 70) data[0] ^= 0xff; } });
  const saved = [];
  const { inst, manifest, events } = await setup({ fake, saveBackup: async (bytes, name) => { saved.push(name); } });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: { backup: true } }), (e) => e.code === 'backup.mismatch');
  assert.deepEqual(saved, [], 'a copy that failed its own check is never offered');
  assert.ok(!called(fake, 'eraseFlash'));
  assert.ok(!called(fake, 'writeFlash'));
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).changed, false);
});

test('the optional factory backup reports a time estimate after the first chunk', async () => {
  let t = 0;
  const { inst, manifest, events } = await setup({ saveBackup: async () => {}, now: () => (t += 1500) });
  await inst.run({ manifest, mode: 'first', options: { backup: true } });
  const backup = events.filter((e) => e.type === 'stage' && e.stage === 'backup' && e.params?.phase === undefined);
  assert.equal(backup[0].eta, undefined);
  const measured = backup.slice(1);
  assert.equal(measured.length, 128, 'two 16 MiB reads in 256 KiB chunks');
  assert.ok(measured.every((e) => Number.isFinite(e.eta) && e.eta >= 0));
  assert.equal(measured.at(-1).eta, 0);
  // The save button is announced after the read, without a stale estimate beside it.
  const save = events.find((e) => e.type === 'stage' && e.stage === 'backup' && e.params?.phase === 'save');
  assert.ok(save && save.eta === undefined);
  assert.ok(events.indexOf(save) > events.indexOf(backup.at(-1)));
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

/* --- the own-file path: bytes from memory, never a fetch ------------------- */

async function setupLocal({ fake = makeFakeEsptool(), img = image(0), chipFamily = 'ESP32', offset = 0, confirm = true } = {}) {
  const manifest = await localManifest({ name: 'mine.bin', chipFamily, parts: [{ path: 'mine.bin', offset, bytes: img }] });
  const events = [], fetches = [];
  const inst = createInstaller({
    esptool: fake,
    requestPort: async () => ({ getInfo: () => ({}) }),
    fetchFn: async (url) => { fetches.push(url); throw new Error('fetchFn must not be called for a local file'); },
    onEvent: (e) => events.push(e),
    chooseBuild: async (builds) => builds[0],
    confirmErase: async () => confirm,
    saveBackup: async () => {},
  });
  return { inst, manifest, events, fake, fetches };
}

test('own file: installs from memory with no fetch at all, the full check chain, an MD5-verified write and a reset', async () => {
  const img = image(0);
  const { inst, manifest, events, fake, fetches } = await setupLocal({ img });
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
  assert.equal(r.build, 'local');
  assert.deepEqual(fetches, [], 'nothing was fetched');
  assert.deepEqual(fake.calls.map((c) => c[0]), ['transport', 'main', 'readFlashId', 'command', 'readFlash', 'eraseFlash', 'writeFlash', 'after', 'disconnect']);
  const w = fake.calls.find((c) => c[0] === 'writeFlash');
  assert.deepEqual(w[1], [[0, 0x3000]]);
  assert.equal(w[2], false, 'erase is its own step, never eraseAll');
  assert.equal(r.parts[0].sha256, await sha256Hex(img));
  assert.ok(fake.flash.subarray(0, 0x3000).every((b, i) => b === img[i]), 'the bytes on the device are the file');
  const local = events.filter((e) => e.type === 'stage' && (e.stage === 'downloading' || e.stage === 'verifying'));
  assert.ok(local.length >= 2 && local.every((e) => e.params.local === true), 'the page can say it is checking a file, not downloading');
  assert.equal(events.at(-1).type, 'done');
});

test('own file: an image built for another chip is refused before any erase or write', async () => {
  const { inst, manifest, fake, fetches } = await setupLocal({ img: image(9) }); // an ESP32-S3 image on an ESP32 install
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }),
    (e) => e.code === 'verify.wrongChip' && e.params.expected === 'ESP32' && e.params.found === 'ESP32-S3');
  assert.ok(!called(fake, 'eraseFlash'));
  assert.ok(!called(fake, 'writeFlash'));
  assert.deepEqual(fetches, []);
  assert.ok(called(fake, 'disconnect'));
});

test('own file: the chip the user chose is not the one plugged in → device.noMatch, nothing written', async () => {
  const fake = makeFakeEsptool({ chipName: 'ESP32-S3' });
  const { inst, manifest } = await setupLocal({ fake, img: image(0), chipFamily: 'ESP32' });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'device.noMatch' && e.params.chip === 'ESP32-S3');
  assert.ok(!called(fake, 'eraseFlash'));
  assert.ok(!called(fake, 'writeFlash'));
});

test('own file: an application at 0x10000 is written without any erase prompt and without erasing', async () => {
  const app = new Uint8Array(0x200).fill(0xff); app[0] = 0xe9; app[12] = 0; app[13] = 0;
  const { inst, manifest, fake, events } = await setupLocal({ img: app, offset: 0x10000 });
  assert.equal(manifest.promptErase, false);
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
  assert.ok(!called(fake, 'eraseFlash'));
  assert.deepEqual(fake.calls.find((c) => c[0] === 'writeFlash')[1], [[0x10000, 0x200]]);
  assert.equal(events.at(-1).type, 'done');
});

test('own file: a whole-system image with the erase declined still writes', async () => {
  const { inst, manifest, fake } = await setupLocal({ confirm: false });
  await inst.run({ manifest, mode: 'update', options: {} });
  assert.ok(!called(fake, 'eraseFlash'));
  assert.ok(called(fake, 'writeFlash'));
});

test('own file: bytes changed after the file was read are caught by the measured sha256 before any write', async () => {
  const img = image(0);
  const { inst, manifest, fake } = await setupLocal({ img });
  img[0x2000] ^= 0xff;
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'verify.sha256' && e.params.path === 'mine.bin');
  assert.ok(!called(fake, 'eraseFlash'));
  assert.ok(!called(fake, 'writeFlash'));
});

test('own file: a part larger than the device stops at the layout check', async () => {
  const fake = makeFakeEsptool({ flashId: 0x001440c8 }); // 1 MB
  const big = new Uint8Array(0x101000).fill(0xff); big[0x1000] = 0xe9;
  const { inst, manifest } = await setupLocal({ fake, img: big });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'verify.beyondFlash');
  assert.ok(!called(fake, 'writeFlash'));
});

test('own file: the optional backup runs for a local install exactly as for a release', async () => {
  const saved = [];
  const { inst, manifest, fake } = await setupLocal();
  const inst2 = createInstaller({ esptool: fake, requestPort: async () => ({ getInfo: () => ({}) }),
    fetchFn: async () => { throw new Error('no fetch'); }, chooseBuild: async (b) => b[0], confirmErase: async () => true,
    saveBackup: async (bytes, name) => { fake.calls.push(['saveBackup', name]); saved.push(name); } });
  void inst;
  await inst2.run({ manifest, mode: 'first', options: { backup: true } });
  const names = fake.calls.map((c) => c[0]);
  assert.ok(names.indexOf('saveBackup') < names.indexOf('eraseFlash'));
  assert.match(saved[0], /^mine\.bin-backup-[0-9a-f]{8}\.bin$/);
});

/* --- the own-file path by address --------------------------------------- */

const okResponse = (img, url = '') => async (u) => ({ ok: true, status: 200, url: url || u, arrayBuffer: async () => img.buffer.slice(0) });

test('own file by address: a relative same-origin address is fetched once, then installs from memory through the full chain', async () => {
  const img = image(0);
  const seen = [];
  const fetchFn = async (url, opts) => { seen.push([url, opts]); return okResponse(img)(url); };
  const got = await fetchOwnFile(fetchFn, '/os/emini-home/0.4.4/emini-home-0.4.4-note4c.bin', 'https://h/install/');
  assert.equal(got.name, 'emini-home-0.4.4-note4c.bin');
  assert.equal(got.url, 'https://h/os/emini-home/0.4.4/emini-home-0.4.4-note4c.bin');
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], got.url);
  assert.equal(seen[0][1].credentials, 'same-origin');
  assert.equal(seen[0][1].cache, 'no-store');
  assert.equal(got.bytes.length, img.length);
  const manifest = await localManifest({ name: got.name, chipFamily: 'ESP32', parts: [{ path: got.name, offset: 0, bytes: got.bytes }] });
  assert.equal(manifest.builds[0].parts[0].sha256, await sha256Hex(img));
  const fake = makeFakeEsptool();
  const inst = createInstaller({ esptool: fake, requestPort: async () => ({ getInfo: () => ({}) }),
    fetchFn: async () => { throw new Error('the engine must not fetch again'); },
    chooseBuild: async (b) => b[0], confirmErase: async () => true, saveBackup: async () => {} });
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
  assert.deepEqual(fake.calls.map((c) => c[0]), ['transport', 'main', 'readFlashId', 'command', 'readFlash', 'eraseFlash', 'writeFlash', 'after', 'disconnect']);
  assert.ok(fake.flash.subarray(0, img.length).every((b, i) => b === img[i]));
});

test('own file by address: bytes fetched by address go through the same image checks as a local file', async () => {
  const got = await fetchOwnFile(okResponse(image(9)), 'other.bin', 'https://h/install/'); // an ESP32-S3 image
  const manifest = await localManifest({ name: got.name, chipFamily: 'ESP32', parts: [{ path: got.name, offset: 0, bytes: got.bytes }] });
  const fake = makeFakeEsptool();
  const inst = createInstaller({ esptool: fake, requestPort: async () => ({ getInfo: () => ({}) }),
    fetchFn: async () => { throw new Error('no'); }, chooseBuild: async (b) => b[0], confirmErase: async () => true, saveBackup: async () => {} });
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'verify.wrongChip' && e.params.found === 'ESP32-S3');
  assert.ok(!called(fake, 'eraseFlash'));
  assert.ok(!called(fake, 'writeFlash'));
  // and the measured sha256 is held to, exactly like a file from disk
  const got2 = await fetchOwnFile(okResponse(image(0)), 'a.bin', 'https://h/');
  const m2 = await localManifest({ name: 'a.bin', chipFamily: 'ESP32', parts: [{ offset: 0, bytes: got2.bytes }] });
  got2.bytes[0x2000] ^= 0xff;
  const fake2 = makeFakeEsptool();
  const inst2 = createInstaller({ esptool: fake2, requestPort: async () => ({ getInfo: () => ({}) }),
    fetchFn: async () => { throw new Error('no'); }, chooseBuild: async (b) => b[0], confirmErase: async () => true, saveBackup: async () => {} });
  await assert.rejects(inst2.run({ manifest: m2, mode: 'first', options: {} }), (e) => e.code === 'verify.sha256');
  assert.ok(!called(fake2, 'writeFlash'));
});

test('own file by address: an HTTP error is manifest.fetch with its status; a fetch the browser refused is own.blocked', async () => {
  await assert.rejects(fetchOwnFile(async () => ({ ok: false, status: 404 }), '/missing.bin', 'https://h/'),
    (e) => e.code === 'manifest.fetch' && e.params.status === 404);
  await assert.rejects(fetchOwnFile(async () => ({ ok: false, status: 500 }), '/broken.bin', 'https://h/'),
    (e) => e.code === 'manifest.fetch' && e.params.status === 500);
  const refused = new TypeError('Failed to fetch'); // what Chrome throws for a CSP or CORS block, and offline
  await assert.rejects(fetchOwnFile(async () => { throw refused; }, 'https://other.example/fw.bin', 'https://h/'),
    (e) => e.code === 'own.blocked' && e.cause?.cause === refused);
  await assert.rejects(fetchOwnFile(async () => { throw refused; }, '/same-origin.bin', 'https://h/'), (e) => e.code === 'own.blocked');
});

test('own file by address: only http(s) addresses are tried, credentials are stripped, and the empty, oversized and redirected cases fail as parts do', async () => {
  const seen = [];
  await assert.rejects(fetchOwnFile(async (u) => { seen.push(u); }, 'ftp://x/y.bin', 'https://h/'), (e) => e.code === 'own.blocked');
  await assert.rejects(fetchOwnFile(async (u) => { seen.push(u); }, 'file:///etc/passwd', 'https://h/'), (e) => e.code === 'own.blocked');
  await assert.rejects(fetchOwnFile(async (u) => { seen.push(u); return { ok: false, status: 404 }; }, '', 'https://h/install/'), (e) => e.code === 'manifest.fetch' && e.params.status === 404, 'an empty address is the page itself, reported like any HTTP miss');
  assert.deepEqual(seen.filter((u) => /^(ftp|file):/.test(u)), [], 'nothing but http(s) reaches fetch');
  const img = image(0);
  const got = await fetchOwnFile(okResponse(img), 'https://user:pw@other.example/fw%20v1.bin', 'https://h/');
  assert.equal(got.url, 'https://other.example/fw%20v1.bin');
  assert.equal(got.name, 'fw v1.bin');
  await assert.rejects(fetchOwnFile(okResponse(new Uint8Array(0)), '/empty.bin', 'https://h/'), (e) => e.code === 'verify.empty' && e.params.path === 'empty.bin');
  await assert.rejects(fetchOwnFile(okResponse(img), '/big.bin', 'https://h/', 0x100), (e) => e.code === 'verify.tooLarge');
  await assert.rejects(fetchOwnFile(okResponse(img, 'https://cdn.example/fw.bin'), '/fw.bin', 'https://h/'), (e) => e.code === 'manifest.origin', 'a redirect to another origin is refused as for a part');
  const hostOnly = await fetchOwnFile(okResponse(img), 'https://other.example', 'https://h/');
  assert.equal(hostOnly.name, 'other.example', 'no path segment: the host names the file');
});

/* --- the point of no return: the error event says whether the flash was touched -------- */

test('an error before any erase or write reports changed: false; once the erase or the write has begun it reports changed: true', async () => {
  const before = await setup({ sha: 'f'.repeat(64) });
  await assert.rejects(before.inst.run({ manifest: before.manifest, mode: 'first', options: {} }), (e) => e.code === 'verify.sha256');
  assert.equal(before.events.at(-1).type, 'error');
  assert.equal(before.events.at(-1).changed, false, 'nothing was erased or written');

  const erase = await setup({ fake: makeFakeEsptool({ failErase: true }) });
  await assert.rejects(erase.inst.run({ manifest: erase.manifest, mode: 'first', options: {} }), (e) => e.code === 'flash.erase');
  assert.equal(erase.events.at(-1).changed, true, 'the erase had begun');

  const write = await setup({ fake: makeFakeEsptool({ md5Mismatch: true }) });
  await assert.rejects(write.inst.run({ manifest: write.manifest, mode: 'first', options: {} }), (e) => e.code === 'flash.verify');
  assert.equal(write.events.at(-1).changed, true, 'the write had begun');

  // A second run on the same installer starts clean.
  const again = await setup({ fake: makeFakeEsptool({ md5Mismatch: true }) });
  await assert.rejects(again.inst.run({ manifest: again.manifest, mode: 'first', options: {} }));
  const cancelled = await setup({ confirmFn: async () => { throw new Error('ui exploded'); } });
  await assert.rejects(cancelled.inst.run({ manifest: cancelled.manifest, mode: 'first', options: {} }), (e) => e.code === 'engine.unexpected');
  assert.equal(cancelled.events.at(-1).changed, false);
});

/* --- the own-file path with several parts: a PlatformIO or Arduino build ------------------ */

const partImage = (chipId, length = 0x200) => { const d = new Uint8Array(length).fill(0xff); d[0] = 0xe9; d[12] = chipId; d[13] = 0; return d; };
const partTable = () => { const d = new Uint8Array(0xc00).fill(0xff); d[0] = 0xaa; d[1] = 0x50; return d; };

async function setupLocalSet(parts, { fake = makeFakeEsptool({ chipName: 'ESP32-S3' }), chipFamily = 'ESP32-S3', confirm = true } = {}) {
  const manifest = await localManifest({ name: parts.map((p) => p.path).join(', '), chipFamily, parts });
  const events = [];
  const inst = createInstaller({
    esptool: fake, requestPort: async () => ({ getInfo: () => ({}) }),
    fetchFn: async () => { throw new Error('fetchFn must not be called for a local file'); },
    onEvent: (e) => events.push(e), chooseBuild: async (b) => b[0], confirmErase: async () => confirm, saveBackup: async () => {},
  });
  return { inst, manifest, events, fake };
}

test('own files: two parts (partition table + application) are written in one call, in order, without an erase prompt', async () => {
  const table = partTable(), app = partImage(9);
  const { inst, manifest, fake, events } = await setupLocalSet([{ path: 'partitions.bin', offset: 0x8000, bytes: table }, { path: 'firmware.bin', offset: 0x10000, bytes: app }]);
  assert.equal(manifest.promptErase, false, 'nothing covers the bootloader: the one on the device stays');
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
  assert.deepEqual(fake.calls.map((c) => c[0]), ['transport', 'main', 'readFlashId', 'command', 'readFlash', 'writeFlash', 'after', 'disconnect']);
  assert.deepEqual(fake.calls.find((c) => c[0] === 'writeFlash')[1], [[0x8000, 0xc00], [0x10000, 0x200]]);
  assert.ok(fake.flash.subarray(0x8000, 0x8c00).every((b, i) => b === table[i]));
  assert.ok(fake.flash.subarray(0x10000, 0x10200).every((b, i) => b === app[i]));
  assert.equal(r.parts.length, 2);
  assert.equal(events.at(-1).type, 'done');
});

test('own files: three parts with the bootloader at 0 on an S3 ask about erasing, and all three land', async () => {
  const boot = partImage(9, 0x5000);
  const { inst, manifest, fake } = await setupLocalSet([{ path: 'bootloader.bin', offset: 0x0, bytes: boot }, { path: 'partitions.bin', offset: 0x8000, bytes: partTable() }, { path: 'firmware.bin', offset: 0x10000, bytes: partImage(9) }]);
  assert.equal(manifest.promptErase, true);
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
  assert.deepEqual(fake.calls.map((c) => c[0]), ['transport', 'main', 'readFlashId', 'command', 'readFlash', 'eraseFlash', 'writeFlash', 'after', 'disconnect']);
  assert.deepEqual(fake.calls.find((c) => c[0] === 'writeFlash')[1], [[0x0, 0x5000], [0x8000, 0xc00], [0x10000, 0x200]]);
  assert.ok(fake.flash.subarray(0, 0x5000).every((b, i) => b === boot[i]));
});

test('own files: the classic four-file ESP32 build (bootloader at 0x1000) asks about erasing because it brings its own bootloader', async () => {
  const fake = makeFakeEsptool({ chipName: 'ESP32' });
  const parts = [{ path: 'bootloader.bin', offset: 0x1000, bytes: partImage(0, 0x5000) }, { path: 'partitions.bin', offset: 0x8000, bytes: partTable() }, { path: 'boot_app0.bin', offset: 0xe000, bytes: new Uint8Array(0x2000).fill(0xff) }, { path: 'firmware.bin', offset: 0x10000, bytes: partImage(0) }];
  const { inst, manifest } = await setupLocalSet(parts, { fake, chipFamily: 'ESP32' });
  assert.equal(manifest.promptErase, true);
  const r = await inst.run({ manifest, mode: 'first', options: {} });
  assert.equal(r.verified, true);
  assert.deepEqual(fake.calls.find((c) => c[0] === 'writeFlash')[1], [[0x1000, 0x5000], [0x8000, 0xc00], [0xe000, 0x2000], [0x10000, 0x200]]);
  assert.equal(r.parts.length, 4);
  assert.ok(called(fake, 'eraseFlash'));
});

test('own files: two parts on the same place stop at the layout check, nothing erased or written', async () => {
  const { inst, manifest, fake } = await setupLocalSet([{ path: 'a.bin', offset: 0x10000, bytes: partImage(9, 0x2000) }, { path: 'b.bin', offset: 0x11000, bytes: partImage(9) }]);
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'verify.overlap');
  assert.ok(!called(fake, 'eraseFlash'));
  assert.ok(!called(fake, 'writeFlash'));
});

test('own files: one part whose chip id contradicts the others stops before any write, wherever it is written', async () => {
  const { inst, manifest, fake } = await setupLocalSet([{ path: 'bootloader.bin', offset: 0x0, bytes: partImage(9, 0x5000) }, { path: 'partitions.bin', offset: 0x8000, bytes: partTable() }, { path: 'firmware.bin', offset: 0x10000, bytes: partImage(0) }]);
  await assert.rejects(inst.run({ manifest, mode: 'first', options: {} }), (e) => e.code === 'verify.wrongChip' && e.params.found === 'ESP32' && e.params.offset === 0x10000);
  assert.ok(!called(fake, 'eraseFlash'));
  assert.ok(!called(fake, 'writeFlash'));
  assert.ok(called(fake, 'disconnect'));
});
