import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeManifest } from '../app/manifest.js';
import { InstallError } from '../app/errors.js';

const load = (n) => JSON.parse(readFileSync(new URL('./fixtures/' + n, import.meta.url), 'utf8'));
const URL_M = 'https://esp32ai.me/os/manifest-0-4-1.json';

test('esp-web-tools manifest is accepted unchanged', () => {
  const m = normalizeManifest(load('manifest-radio-ewt.json'), URL_M);
  assert.equal(m.schema, 1);
  assert.equal(m.profile, 'factory');
  assert.equal(m.promptErase, true);
  assert.equal(m.builds.length, 1);
  const b = m.builds[0];
  assert.equal(b.chipFamily, 'ESP32');
  assert.equal(b.boardKey, 'build-1');
  assert.equal(b.parts[0].url, 'https://esp32ai.me/os/open-radio-0-4-1.bin');
  assert.equal(b.parts[0].offset, 0);
  assert.equal(b.parts[0].sha256, undefined);
});

test('relative paths resolve against the manifest URL, including ../', () => {
  const raw = load('manifest-v2-factory.json');
  raw.builds[1].parts[0].sha256 = 'a'.repeat(64);
  const m = normalizeManifest(raw, 'https://host.example/install/manifests/demo.json');
  assert.equal(m.builds[0].parts[0].url, 'https://host.example/os/demo-1-2-3.bin');
  assert.equal(m.builds[1].parts[0].url, 'https://host.example/install/manifests/demo-4mb.bin');
});

test('v2 build metadata is carried through', () => {
  const raw = load('manifest-v2-factory.json');
  raw.builds[1].parts[0].sha256 = 'a'.repeat(64);
  const b = normalizeManifest(raw, URL_M).builds[0];
  assert.equal(b.boardKey, 'core2');
  assert.equal(b.flashSizeMB, 16);
  assert.equal(b.usbVendorId, 0x1a86);
  assert.equal(b.usbProductId, 0x55d4);
  assert.equal(b.parts[0].size, 2447808);
});

test('malformed sha256 is rejected with a coded error', () => {
  assert.throws(() => normalizeManifest(load('manifest-v2-factory.json'), URL_M),
    (e) => e instanceof InstallError && e.code === 'manifest.sha256' && e.params.boardKey === 'generic-4mb');
});

test('preserve profile requires size and sha256 on every part and forbids eraseAll', () => {
  const raw = load('manifest-v2-preserve.json');
  const m = normalizeManifest(raw, URL_M);
  assert.equal(m.profile, 'preserve');
  assert.equal(m.builds[0].compatibility.regions.length, 2);
  delete raw.builds[0].parts[1].size;
  assert.throws(() => normalizeManifest(raw, URL_M), (e) => e.code === 'manifest.preserveNeedsSize');
  const raw2 = load('manifest-v2-preserve.json');
  raw2.eraseAll = true;
  assert.throws(() => normalizeManifest(raw2, URL_M), (e) => e.code === 'manifest.preserveNoErase');
});

test('cross-origin part is rejected unless allowed by policy', () => {
  const raw = load('manifest-radio-ewt.json');
  raw.builds[0].parts[0].path = 'https://cdn.example/x.bin';
  assert.throws(() => normalizeManifest(raw, URL_M), (e) => e.code === 'manifest.origin');
  const m = normalizeManifest(raw, URL_M, { allowOrigins: ['https://cdn.example'] });
  assert.equal(m.builds[0].parts[0].url, 'https://cdn.example/x.bin');
});

test('structural errors: no builds, unknown chipFamily, negative offset, duplicate boardKey', () => {
  assert.throws(() => normalizeManifest({ name: 'x', version: '1', builds: [] }, URL_M), (e) => e.code === 'manifest.noBuilds');
  assert.throws(() => normalizeManifest({ name: 'x', version: '1', builds: [{ chipFamily: 'ESP99', parts: [{ path: 'a.bin', offset: 0 }] }] }, URL_M), (e) => e.code === 'manifest.chipFamily');
  assert.throws(() => normalizeManifest({ name: 'x', version: '1', builds: [{ chipFamily: 'ESP32', parts: [{ path: 'a.bin', offset: -1 }] }] }, URL_M), (e) => e.code === 'manifest.offset');
  assert.throws(() => normalizeManifest({ name: 'x', version: '1', builds: [
    { boardKey: 'a', chipFamily: 'ESP32', parts: [{ path: 'a.bin', offset: 0 }] },
    { boardKey: 'a', chipFamily: 'ESP32', parts: [{ path: 'b.bin', offset: 0 }] } ] }, URL_M), (e) => e.code === 'manifest.duplicateBoardKey');
});

const mini = (over = {}) => ({ name: 'x', version: '1', builds: [{ chipFamily: 'ESP32', parts: [{ path: 'a.bin', offset: 0 }] }], ...over });
const oneBuild = (b) => ({ name: 'x', version: '1', builds: [{ chipFamily: 'ESP32', parts: [{ path: 'a.bin', offset: 0 }], ...b }] });
const code = (c) => (e) => e instanceof InstallError && e.code === c;

test('an unparseable manifest URL is a coded error, not a TypeError', () => {
  assert.throws(() => normalizeManifest(mini(), 'not a url'),
    (e) => e instanceof InstallError && e.code === 'manifest.url' && e.params.url === 'not a url');
  assert.throws(() => normalizeManifest(mini(), undefined), code('manifest.url'));
  assert.throws(() => normalizeManifest(mini(), ''), code('manifest.url'));
});

test('the manifest itself must be a plain object', () => {
  for (const bad of [null, undefined, [], 'x', 42]) {
    assert.throws(() => normalizeManifest(bad, URL_M), code('manifest.notObject'));
  }
});

test('schema, name and version are validated', () => {
  assert.throws(() => normalizeManifest(mini({ schema: 3 }), URL_M), code('manifest.schema'));
  assert.throws(() => normalizeManifest(mini({ schema: '2' }), URL_M), code('manifest.schema'));
  assert.throws(() => normalizeManifest(mini({ name: '   ' }), URL_M), code('manifest.name'));
  assert.throws(() => normalizeManifest(mini({ name: 42 }), URL_M), code('manifest.name'));
  assert.throws(() => normalizeManifest(mini({ version: '' }), URL_M), code('manifest.version'));
  assert.throws(() => normalizeManifest(mini({ version: {} }), URL_M), code('manifest.version'));
  assert.throws(() => normalizeManifest(mini({ version: Number.NaN }), URL_M), code('manifest.version'));
});

test('a numeric version is coerced to a string for esp-web-tools compatibility', () => {
  assert.equal(normalizeManifest(mini({ version: 1 }), URL_M).version, '1');
  assert.equal(normalizeManifest(mini({ version: 0 }), URL_M).version, '0');
});

test('part path and parts list are validated', () => {
  assert.throws(() => normalizeManifest(oneBuild({ parts: [{ path: '', offset: 0 }] }), URL_M), code('manifest.path'));
  assert.throws(() => normalizeManifest(oneBuild({ parts: [{ offset: 0 }] }), URL_M), code('manifest.path'));
  assert.throws(() => normalizeManifest(oneBuild({ parts: [{ path: 42, offset: 0 }] }), URL_M), code('manifest.path'));
  assert.throws(() => normalizeManifest(oneBuild({ parts: [] }), URL_M), code('manifest.noParts'));
  assert.throws(() => normalizeManifest(oneBuild({ parts: undefined }), URL_M), code('manifest.noParts'));
  assert.throws(() => normalizeManifest(oneBuild({ parts: [{ path: 'a.bin', offset: 0, size: 0 }] }), URL_M), code('manifest.size'));
  assert.throws(() => normalizeManifest(oneBuild({ parts: [{ path: 'a.bin', offset: 0, size: -1 }] }), URL_M), code('manifest.size'));
  assert.throws(() => normalizeManifest(oneBuild({ parts: [{ path: 'a.bin', offset: 0, size: 1.5 }] }), URL_M), code('manifest.size'));
});

test('boardKey, profile, usb ids and filter lists are validated', () => {
  assert.throws(() => normalizeManifest(oneBuild({ boardKey: '-bad' }), URL_M), code('manifest.boardKey'));
  assert.throws(() => normalizeManifest(oneBuild({ boardKey: 'a b' }), URL_M), code('manifest.boardKey'));
  assert.throws(() => normalizeManifest(oneBuild({ boardKey: '' }), URL_M), code('manifest.boardKey'));
  assert.throws(() => normalizeManifest(oneBuild({ boardKey: 'a'.repeat(81) }), URL_M), code('manifest.boardKey'));
  assert.throws(() => normalizeManifest(mini({ profile: 'weird' }), URL_M),
    (e) => e.code === 'manifest.profile' && e.params.boardKey === '*');
  assert.throws(() => normalizeManifest(oneBuild({ boardKey: 'k', profile: 'weird' }), URL_M),
    (e) => e.code === 'manifest.profile' && e.params.boardKey === 'k');
  assert.throws(() => normalizeManifest(oneBuild({ usbVendorId: 0x10000 }), URL_M), code('manifest.usb'));
  assert.throws(() => normalizeManifest(oneBuild({ usbProductId: -1 }), URL_M), code('manifest.usb'));
  assert.throws(() => normalizeManifest(oneBuild({ chipDescriptionIncludes: 'ESP32' }), URL_M), code('manifest.filters'));
  assert.throws(() => normalizeManifest(oneBuild({ featuresAll: [1] }), URL_M), code('manifest.filters'));
});

test('board falls back from board to name to boardKey', () => {
  assert.equal(normalizeManifest(oneBuild({ boardKey: 'k', board: 'Board', name: 'Name' }), URL_M).builds[0].board, 'Board');
  assert.equal(normalizeManifest(oneBuild({ boardKey: 'k', board: '  ', name: 'Name' }), URL_M).builds[0].board, 'Name');
  assert.equal(normalizeManifest(oneBuild({ boardKey: 'k' }), URL_M).builds[0].board, 'k');
});

test('filter lists are copied, so mutating the raw manifest cannot reach the normalized one', () => {
  const raw = oneBuild({ chipDescriptionIncludes: ['ESP32-D0WD'], featuresAll: ['WiFi'] });
  const b = normalizeManifest(raw, URL_M).builds[0];
  raw.builds[0].chipDescriptionIncludes.push('injected');
  raw.builds[0].featuresAll.push('injected');
  assert.deepEqual(b.chipDescriptionIncludes, ['ESP32-D0WD']);
  assert.deepEqual(b.featuresAll, ['WiFi']);
});

test('compatibility must be a plain object, and preserve needs at least one region', () => {
  assert.throws(() => normalizeManifest(oneBuild({ compatibility: [] }), URL_M), code('manifest.compatibility'));
  assert.throws(() => normalizeManifest(oneBuild({ compatibility: 'x' }), URL_M), code('manifest.compatibility'));
  const noRegions = load('manifest-v2-preserve.json');
  noRegions.builds[0].compatibility.regions = [];
  noRegions.builds[0].compatibility.firstInstall.regions = [];
  assert.throws(() => normalizeManifest(noRegions, URL_M), code('manifest.compatibility'));
  const absent = load('manifest-v2-preserve.json');
  delete absent.builds[0].compatibility;
  assert.throws(() => normalizeManifest(absent, URL_M), code('manifest.compatibility'));
});

test('update.tableOffset is validated rather than silently dropped', () => {
  for (const bad of [-1, 1.5, '32768', null]) {
    const raw = load('manifest-v2-preserve.json');
    raw.builds[0].compatibility.update.tableOffset = bad;
    assert.throws(() => normalizeManifest(raw, URL_M), code('manifest.compatibility'));
  }
});

test('the preserve fixture carries firstInstall regions, empty ranges and the table offset', () => {
  const c = normalizeManifest(load('manifest-v2-preserve.json'), URL_M).builds[0].compatibility;
  assert.equal(c.firstInstall.regions[0].sha256, 'ce40cfe75056ef74bc052942f8a9ee3dce8e5e14ba17a6f63685a8fa0d11a23d');
  assert.equal(c.firstInstall.empty[0].size, 65536);
  assert.equal(c.update.tableOffset, 32768);
});

test('allowOrigins that is not an array of strings fails closed', () => {
  const raw = load('manifest-radio-ewt.json');
  raw.builds[0].parts[0].path = 'https://cdn.example/x.bin';
  assert.throws(() => normalizeManifest(raw, URL_M, { allowOrigins: 'https://cdn.example' }), code('manifest.origin'));
  assert.throws(() => normalizeManifest(raw, URL_M, { allowOrigins: 'https://cdn.example.attacker.test' }), code('manifest.origin'));
  assert.throws(() => normalizeManifest(raw, URL_M, { allowOrigins: [42] }), code('manifest.origin'));
});

test('credentials are stripped from a resolved part URL', () => {
  const raw = load('manifest-radio-ewt.json');
  raw.builds[0].parts[0].path = 'https://user:secret@esp32ai.me/os/x.bin';
  const url = normalizeManifest(raw, URL_M).builds[0].parts[0].url;
  assert.equal(url, 'https://esp32ai.me/os/x.bin');
});
