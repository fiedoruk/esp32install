import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeManifest, localManifest } from '../app/manifest.js';
import { sha256Hex } from '../app/verify.js';
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

test('flashSizeMB must be at least 1: a build declaring 0 would match no device at all', () => {
  const raw = load('manifest-v2-factory.json');
  raw.builds[1].parts[0].sha256 = 'a'.repeat(64);
  raw.builds[0].flashSizeMB = 0;
  assert.throws(() => normalizeManifest(raw, URL_M), (e) => e.code === 'manifest.flashSizeMB' && e.params.boardKey === 'core2');
  raw.builds[0].flashSizeMB = 1;
  assert.equal(normalizeManifest(raw, URL_M).builds[0].flashSizeMB, 1);
  delete raw.builds[0].flashSizeMB;
  assert.equal(normalizeManifest(raw, URL_M).builds[0].flashSizeMB, undefined, 'absent still means "any size"');
});

test('preserve refuses a part that does not start on a 4 KiB boundary, and accepts every aligned one', () => {
  for (const offset of [0x10800, 0x8001, 0xfff, 0x20000 + 1]) {
    const raw = load('manifest-v2-preserve.json');
    raw.builds[0].parts[0].offset = offset;
    assert.throws(() => normalizeManifest(raw, URL_M), (e) => e.code === 'manifest.alignment' && e.params.offset === offset,
      `offset 0x${offset.toString(16)} must be refused`);
  }
  // Positive control: the shipped fixture is aligned everywhere and still passes.
  const ok = normalizeManifest(load('manifest-v2-preserve.json'), URL_M).builds[0];
  assert.deepEqual(ok.parts.map((p) => p.offset), [0x20000, 0x8000]);
  assert.ok(ok.parts.every((p) => p.offset % 0x1000 === 0));
});

/**
 * The other end of the same rule, and the shape it actually has. The chip erases the sector
 * holding a part's last byte, so up to 4 095 bytes after the part are blanked without being
 * written. That is what every real ESP-IDF release looks like and it is harmless while those
 * bytes are nobody's. What is refused is a blanked tail that reaches something that has to
 * survive. No offset is exempt: the table page passes because its own page is what the release
 * replaces, not because it is named by `update.tableOffset`.
 */
test('preserve accepts a ragged length whose blanked tail lands in the part\'s own space', () => {
  // The shipped fixture: 1 634 176 bytes at 0x20000, which is not a multiple of 4096.
  const raw = load('manifest-v2-preserve.json');
  assert.equal(raw.builds[0].parts[0].size % 0x1000 !== 0, true, 'the fixture really does ship a ragged length');
  assert.equal(raw.builds[0].parts[1].size % 0x1000 !== 0, true, 'and a ragged table too');
  const ok = normalizeManifest(raw, URL_M).builds[0];
  assert.deepEqual(ok.parts.map((p) => p.size), [1634176, 3072]);
  // Any other ragged length is equally fine while nothing is declared in the tail.
  for (const size of [1, 5000, 0x1001, 1634175]) {
    const one = load('manifest-v2-preserve.json');
    one.builds[0].parts[0].size = size;
    assert.equal(normalizeManifest(one, URL_M).builds[0].parts[0].size, size, `${size} bytes must be accepted`);
  }
});

test('preserve refuses a blanked tail that reaches a declared compatibility region', () => {
  const OFFSET = 0x20000, SIZE = 1634176;
  const tail = OFFSET + SIZE; // 0x1aef80: the first byte the chip blanks without writing it
  for (const at of [tail, tail + 1, tail + 0x7f]) {
    const raw = load('manifest-v2-preserve.json');
    raw.builds[0].compatibility.regions.push({ offset: at, size: 1, sha256: 'b'.repeat(64) });
    assert.throws(() => normalizeManifest(raw, URL_M),
      (e) => e.code === 'manifest.alignment' && e.params.offset === OFFSET && e.params.size === SIZE,
      `a region at 0x${at.toString(16)} must be refused`);
  }
  // firstInstall.regions and firstInstall.empty count the same.
  for (const key of ['regions', 'empty']) {
    const raw = load('manifest-v2-preserve.json');
    raw.builds[0].compatibility.firstInstall[key].push({ offset: tail, size: 16, sha256: 'b'.repeat(64) });
    assert.throws(() => normalizeManifest(raw, URL_M), (e) => e.code === 'manifest.alignment',
      `firstInstall.${key} must be refused too`);
  }
  // Control: the same region one byte past the end of the blanked sector is fine.
  const ok = load('manifest-v2-preserve.json');
  ok.builds[0].compatibility.regions.push({ offset: 0x1af000, size: 1, sha256: 'b'.repeat(64) });
  assert.equal(normalizeManifest(ok, URL_M).builds[0].compatibility.regions.length, 3);
});

/**
 * A preserve part starts on a sector boundary, so a footprint that reaches the next part is also
 * a plain overlap — and `normalizeManifest` has no overlap check of its own, so this rule is what
 * the page has before the download layer gets to `verify.overlap`.
 */
test('preserve refuses a footprint that reaches the next part', () => {
  const raw = load('manifest-v2-preserve.json');
  raw.builds[0].parts[0].size = 0x1001; // 0x20000..0x21001, so the chip erases through 0x22000
  raw.builds[0].parts.push({ path: 'extra.bin', offset: 0x21000, size: 0x100, sha256: 'c'.repeat(64) });
  assert.throws(() => normalizeManifest(raw, URL_M), (e) => e.code === 'manifest.alignment');
  // Control: the same part one sector further on is clear of the erased footprint.
  const ok = load('manifest-v2-preserve.json');
  ok.builds[0].parts[0].size = 0x1001;
  ok.builds[0].parts.push({ path: 'extra.bin', offset: 0x22000, size: 0x100, sha256: 'c'.repeat(64) });
  assert.equal(normalizeManifest(ok, URL_M).builds[0].parts.length, 3);
});

test('preserve refuses a blanked tail that runs past the end of the flash', () => {
  const raw = load('manifest-v2-preserve.json');
  raw.builds[0].flashSizeMB = 1; // the application alone needs 0x1af000 bytes
  assert.throws(() => normalizeManifest(raw, URL_M), (e) => e.code === 'manifest.alignment' && e.params.size === 1634176);
  const ok = load('manifest-v2-preserve.json');
  ok.builds[0].flashSizeMB = 2;
  assert.equal(normalizeManifest(ok, URL_M).builds[0].flashSizeMB, 2);
});

test('the table page needs no exemption: it passes wherever it is, and is refused when its tail is claimed', () => {
  // Move the table clear of the application: a 3 072-byte part at 0x1b0000, whose page is what
  // the release replaces, is accepted although nothing names it a table.
  const moved = load('manifest-v2-preserve.json');
  moved.builds[0].parts[1].offset = 0x1b0000;
  moved.builds[0].compatibility.update.tableOffset = 0x1b0000;
  moved.builds[0].compatibility.firstInstall.regions[0].offset = 0x1b0000;
  assert.equal(normalizeManifest(moved, URL_M).builds[0].parts[1].size, 3072);
  // And the page's own declared region is excused only because the part replaces it whole:
  // declare a region that covers the table's page and two sectors beyond, and it is refused.
  const claimed = load('manifest-v2-preserve.json');
  claimed.builds[0].compatibility.firstInstall.regions[0].size = 0x3000;
  assert.throws(() => normalizeManifest(claimed, URL_M),
    (e) => e.code === 'manifest.alignment' && e.params.offset === 0x8000);
});

test('an unaligned length is only a preserve rule: a factory release may write any size', () => {
  const raw = load('manifest-v2-factory.json');
  raw.builds[1].parts[0].sha256 = 'a'.repeat(64);
  raw.builds[0].parts[0].size = 1634176;
  assert.equal(normalizeManifest(raw, URL_M).builds[0].parts[0].size, 1634176);
});

test('an unaligned offset is only a preserve rule: a factory release may write anywhere', () => {
  const raw = load('manifest-v2-factory.json');
  raw.builds[1].parts[0].sha256 = 'a'.repeat(64);
  raw.builds[0].parts[0].offset = 0x10800;
  assert.equal(normalizeManifest(raw, URL_M).builds[0].parts[0].offset, 0x10800);
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

test('a build may repeat the manifest profile but never change it (a preserve build in a factory manifest would erase)', () => {
  const mixed = load('manifest-v2-factory.json');
  mixed.builds[1].parts[0].sha256 = 'a'.repeat(64);
  mixed.builds[0].profile = 'preserve';
  assert.throws(() => normalizeManifest(mixed, URL_M), (e) => e.code === 'manifest.profile' && e.params.boardKey === 'core2');
  const other = load('manifest-v2-preserve.json');
  other.builds[0].profile = 'factory';
  assert.throws(() => normalizeManifest(other, URL_M), (e) => e.code === 'manifest.profile' && e.params.boardKey === 'note4c');
  const same = load('manifest-v2-preserve.json');
  same.builds[0].profile = 'preserve';
  assert.equal(normalizeManifest(same, URL_M).builds[0].profile, 'preserve');
  const explicit = load('manifest-v2-factory.json');
  explicit.builds[1].parts[0].sha256 = 'a'.repeat(64);
  explicit.builds[0].profile = 'factory';
  assert.equal(normalizeManifest(explicit, URL_M).builds[0].profile, 'factory');
});

test('preserve requires update.tableOffset and a part written at exactly that offset', () => {
  const noTable = load('manifest-v2-preserve.json');
  delete noTable.builds[0].compatibility.update;
  assert.throws(() => normalizeManifest(noTable, URL_M), code('manifest.compatibility'));
  const noOffset = load('manifest-v2-preserve.json');
  noOffset.builds[0].compatibility.update = {};
  assert.throws(() => normalizeManifest(noOffset, URL_M), code('manifest.compatibility'));
  const noPart = load('manifest-v2-preserve.json');
  noPart.builds[0].compatibility.update.tableOffset = 0x9000;
  assert.throws(() => normalizeManifest(noPart, URL_M), code('manifest.compatibility'));
  const partRemoved = load('manifest-v2-preserve.json');
  partRemoved.builds[0].parts = partRemoved.builds[0].parts.filter((p) => p.offset !== 32768);
  assert.throws(() => normalizeManifest(partRemoved, URL_M), code('manifest.compatibility'));
  // Positive control: the fixture as shipped has both.
  assert.equal(normalizeManifest(load('manifest-v2-preserve.json'), URL_M).builds[0].compatibility.update.tableOffset, 32768);
});

test('preserve requires sha256 on every region and every firstInstall region; empty ranges carry none', () => {
  const region = load('manifest-v2-preserve.json');
  delete region.builds[0].compatibility.regions[1].sha256;
  assert.throws(() => normalizeManifest(region, URL_M), code('manifest.compatibility'));
  const first = load('manifest-v2-preserve.json');
  delete first.builds[0].compatibility.firstInstall.regions[0].sha256;
  assert.throws(() => normalizeManifest(first, URL_M), code('manifest.compatibility'));
  const ok = normalizeManifest(load('manifest-v2-preserve.json'), URL_M).builds[0].compatibility;
  assert.equal(ok.firstInstall.empty[0].sha256, undefined);
  // A factory build with a compatibility block is not held to the preserve rules.
  const factory = oneBuild({ compatibility: { regions: [{ offset: 0, size: 16 }] } });
  assert.equal(normalizeManifest(factory, URL_M).builds[0].compatibility.regions[0].sha256, undefined);
});

test('manifest.build, manifest.part and manifest.flashSizeMB are the codes for those shapes', () => {
  for (const bad of [null, 'x', 42, []]) {
    assert.throws(() => normalizeManifest(mini({ builds: [bad] }), URL_M),
      (e) => e instanceof InstallError && e.code === 'manifest.build' && e.params.index === 1, `build ${JSON.stringify(bad)}`);
  }
  for (const bad of [null, 'x', 42, []]) {
    assert.throws(() => normalizeManifest(oneBuild({ boardKey: 'k', parts: [{ path: 'a.bin', offset: 0 }, bad] }), URL_M),
      (e) => e instanceof InstallError && e.code === 'manifest.part' && e.params.boardKey === 'k' && e.params.index === 2, `part ${JSON.stringify(bad)}`);
  }
  for (const bad of [-1, 1.5, 1025, '16', NaN]) {
    assert.throws(() => normalizeManifest(oneBuild({ boardKey: 'k', flashSizeMB: bad }), URL_M),
      (e) => e instanceof InstallError && e.code === 'manifest.flashSizeMB' && e.params.boardKey === 'k', `flashSizeMB ${bad}`);
  }
  assert.equal(normalizeManifest(oneBuild({ flashSizeMB: 16 }), URL_M).builds[0].flashSizeMB, 16);
  assert.equal(normalizeManifest(oneBuild({ flashSizeMB: null }), URL_M).builds[0].flashSizeMB, undefined);
});

test('a part with a javascript:, data:, blob: or file: scheme is refused even when its origin is allowed', () => {
  for (const path of ['javascript:alert(1)', 'data:application/octet-stream;base64,6QAA', 'blob:https://esp32ai.me/x', 'file:///etc/passwd', 'ftp://esp32ai.me/x.bin']) {
    assert.throws(() => normalizeManifest(oneBuild({ parts: [{ path, offset: 0 }] }), URL_M), code('manifest.origin'), path);
    assert.throws(() => normalizeManifest(oneBuild({ parts: [{ path, offset: 0 }] }), URL_M, { allowOrigins: ['null', 'https://esp32ai.me'] }), code('manifest.origin'), path);
  }
});

/* --- the own-file path ----------------------------------------------------- */

const localImage = (chipId = 0, size = 0x3000) => { const d = new Uint8Array(size).fill(0xff); d[0x1000] = 0xe9; d[0x1000 + 12] = chipId; return d; };
const rejects = (promise, code, extra = () => true) => assert.rejects(promise, (e) => e instanceof InstallError && e.code === code && extra(e));

test('localManifest returns the normalized shape: factory, one build "local", size and sha256 measured, bytes carried, no url', async () => {
  const bytes = localImage();
  const m = await localManifest({ name: 'mine.bin', chipFamily: 'ESP32', parts: [{ path: 'mine.bin', offset: 0, bytes }] });
  const ref = normalizeManifest({ name: 'x', version: '1', builds: [{ chipFamily: 'ESP32', parts: [{ path: 'a.bin', offset: 0 }] }] }, URL_M);
  assert.deepEqual(Object.keys(m).sort(), Object.keys(ref).sort(), 'same top-level keys as a normalized manifest');
  assert.deepEqual(Object.keys(m.builds[0]).sort(), Object.keys(ref.builds[0]).sort(), 'same build keys');
  assert.equal(m.name, 'mine.bin');
  assert.equal(m.schema, 2);
  assert.equal(m.profile, 'factory');
  assert.equal(m.eraseAll, false);
  assert.equal(m.builds.length, 1);
  const b = m.builds[0];
  assert.equal(b.boardKey, 'local');
  assert.equal(b.chipFamily, 'ESP32');
  assert.equal(b.profile, 'factory');
  assert.equal(b.eraseAll, false);
  assert.equal(b.compatibility, undefined);
  assert.equal(b.flashSizeMB, undefined);
  assert.deepEqual(b.chipDescriptionIncludes, []);
  assert.deepEqual(b.featuresAll, []);
  assert.equal(b.parts.length, 1);
  const p = b.parts[0];
  assert.equal(p.path, 'mine.bin');
  assert.equal(p.offset, 0);
  assert.equal(p.size, bytes.length);
  assert.equal(p.sha256, await sha256Hex(bytes));
  assert.equal(p.bytes, bytes);
  assert.equal(p.url, undefined);
  assert.equal(m.version, p.sha256.slice(0, 8), 'the version names the file by its hash');
});

test('localManifest: a file written at 0 asks about erasing; a file written anywhere else never does', async () => {
  const whole = await localManifest({ name: 'a.bin', chipFamily: 'ESP32-S3', parts: [{ offset: 0, bytes: localImage(9) }] });
  assert.equal(whole.promptErase, true);
  assert.equal(whole.builds[0].parts[0].path, 'a.bin', 'a part without a path takes the name');
  const app = await localManifest({ name: 'a.bin', chipFamily: 'ESP32-S3', parts: [{ offset: 0x10000, bytes: localImage(9) }] });
  assert.equal(app.promptErase, false);
  assert.equal(app.builds[0].eraseAll, false);
});

test('localManifest rejects an empty file, an oversized file, a bad offset, an unknown chip, no name, no parts and a part without bytes', async () => {
  const ok = { name: 'a.bin', chipFamily: 'ESP32', parts: [{ offset: 0, bytes: localImage() }] };
  await rejects(localManifest({ ...ok, parts: [{ offset: 0, bytes: new Uint8Array(0) }] }), 'verify.empty', (e) => e.params.path === 'a.bin');
  await rejects(localManifest({ ...ok, parts: [{ offset: 0, bytes: new Uint8Array(32 * 1024 * 1024 + 1) }] }), 'verify.tooLarge');
  await rejects(localManifest({ ...ok, parts: [{ offset: 0x1234, bytes: localImage() }] }), 'manifest.offset', (e) => e.params.boardKey === 'local' && e.params.index === 1);
  await rejects(localManifest({ ...ok, parts: [{ offset: -0x1000, bytes: localImage() }] }), 'manifest.offset');
  await rejects(localManifest({ ...ok, parts: [{ offset: '0x0', bytes: localImage() }] }), 'manifest.offset');
  await rejects(localManifest({ ...ok, chipFamily: 'ESP99' }), 'manifest.chipFamily', (e) => e.params.boardKey === 'local');
  await rejects(localManifest({ ...ok, chipFamily: undefined }), 'manifest.chipFamily');
  await rejects(localManifest({ ...ok, name: '  ' }), 'manifest.name');
  await rejects(localManifest({ ...ok, parts: [] }), 'manifest.noParts');
  await rejects(localManifest({ ...ok, parts: [{ offset: 0, bytes: [0xe9, 0, 0] }] }), 'manifest.part', (e) => e.params.index === 1);
  await rejects(localManifest({ ...ok, parts: [{ offset: 0, bytes: localImage().buffer }] }), 'manifest.part');
  await rejects(localManifest(), 'manifest.name'); // no arguments at all
});

test('localManifest refuses the preserve profile: a local file has no compatibility data', async () => {
  const parts = [{ offset: 0, bytes: localImage() }];
  await rejects(localManifest({ name: 'a.bin', chipFamily: 'ESP32', parts, profile: 'preserve' }), 'manifest.profile', (e) => e.params.boardKey === 'local');
  await rejects(localManifest({ name: 'a.bin', chipFamily: 'ESP32', parts, profile: 'anything' }), 'manifest.profile');
  const m = await localManifest({ name: 'a.bin', chipFamily: 'ESP32', parts, profile: 'factory' });
  assert.equal(m.profile, 'factory');
});

test('improv: absent stays undefined, a boolean is kept, anything else is manifest.improv', () => {
  const base = () => ({ name: 'D', version: '1', builds: [{ chipFamily: 'ESP32', parts: [{ path: 'a.bin', offset: 0 }] }] });
  assert.equal(normalizeManifest(base(), URL_M).builds[0].improv, undefined);
  for (const v of [true, false]) {
    const raw = base();
    raw.builds[0].improv = v;
    assert.equal(normalizeManifest(raw, URL_M).builds[0].improv, v);
  }
  for (const v of ['yes', 1, {}, []]) {
    const raw = base();
    raw.builds[0].improv = v;
    assert.throws(() => normalizeManifest(raw, URL_M), (e) => e instanceof InstallError && e.code === 'manifest.improv' && e.params.boardKey === 'build-1');
  }
});

test('localManifest: a set that brings its own bootloader asks about erasing, even when nothing is written at 0', async () => {
  const boot = localImage(0);
  const table = new Uint8Array(0xc00).fill(0xff); table[0] = 0xaa; table[1] = 0x50;
  const classic = await localManifest({ name: 'set', chipFamily: 'ESP32', parts: [{ path: 'bootloader.bin', offset: 0x1000, bytes: boot }, { path: 'partitions.bin', offset: 0x8000, bytes: table }, { path: 'app.bin', offset: 0x10000, bytes: localImage(0) }] });
  assert.equal(classic.promptErase, true, 'the ESP32 bootloader lives at 0x1000');
  assert.equal(classic.builds[0].parts.length, 3);
  const noBoot = await localManifest({ name: 'set', chipFamily: 'ESP32', parts: [{ path: 'partitions.bin', offset: 0x8000, bytes: table }, { path: 'app.bin', offset: 0x10000, bytes: localImage(0) }] });
  assert.equal(noBoot.promptErase, false, 'the bootloader on the device stays');
  const c61 = await localManifest({ name: 'set', chipFamily: 'ESP32-C61', parts: [{ path: 'x.bin', offset: 0x2000, bytes: localImage(20) }] });
  assert.equal(c61.promptErase, false, 'no declared bootloader offset: only a part at 0 asks');
});
