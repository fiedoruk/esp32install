import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRelease } from '../app/catalog.js';
const C = { site: 'x', systems: [
  { id: 'radio', name: 'Open Radio', device: 'Core2', releases: [
    { version: '0.5.0-rc1', manifest: 'manifests/radio-0-5-0-rc1.json', channel: 'pre' },
    { version: '0.4.1', manifest: 'manifests/radio-0-4-1.json', channel: 'stable' } ] },
  { id: 'radbox', name: 'RADBOX', device: 'Core2', releases: [ { version: '0.1.0-rc15', manifest: 'm.json', channel: 'stable' } ] } ] };
test('no fw → list of systems', () => { assert.deepEqual(pickRelease(C, {}).systems.map((s) => s.id), ['radio', 'radbox']); });
test('fw → newest stable', () => { assert.equal(pickRelease(C, { fw: 'radio' }).release.version, '0.4.1'); });
test('channel=pre → newest of any channel', () => { assert.equal(pickRelease(C, { fw: 'radio', channel: 'pre' }).release.version, '0.5.0-rc1'); });
test('v pins a version', () => { assert.equal(pickRelease(C, { fw: 'radio', v: '0.5.0-rc1' }).release.channel, 'pre'); });
test('a system with only pre-releases opens on its newest one by default', () => {
  const P = { systems: [{ id: 'lab', name: 'Lab', device: 'x', releases: [{ version: '0.1.0-rc2', manifest: 'a.json', channel: 'pre' }, { version: '0.1.0-rc1', manifest: 'b.json', channel: 'pre' }] }] };
  assert.equal(pickRelease(P, { fw: 'lab' }).release.version, '0.1.0-rc2');
});
test('a stable listed after a pre-release still wins by default', () => {
  assert.equal(pickRelease(C, { fw: 'radio' }).release.channel, 'stable');
  const S = { systems: [{ id: 's', name: 'S', device: 'x', releases: [{ version: '2.0.0-rc1', manifest: 'a.json', channel: 'pre' }, { version: '1.9.0', manifest: 'b.json', channel: 'stable' }, { version: '1.8.0', manifest: 'c.json', channel: 'stable' }] }] };
  assert.equal(pickRelease(S, { fw: 's' }).release.version, '1.9.0');
});
test('errors are coded', () => {
  assert.throws(() => pickRelease(C, { fw: 'nope' }), (e) => e.code === 'catalog.unknownSystem');
  assert.throws(() => pickRelease(C, { fw: 'radio', v: '9' }), (e) => e.code === 'catalog.unknownVersion');
});
