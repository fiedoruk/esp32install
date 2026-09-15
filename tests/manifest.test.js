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
