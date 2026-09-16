/**
 * The Improv session against a fake device that speaks the real packet format (built from the
 * vendored const.js). The client under test is the vendored one, not a stand-in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImprovSession, mapImprovError, safeNextUrl } from '../app/improv.js';
import { InstallError } from '../app/errors.js';
import { makeFakeImprovDevice } from './helpers/fakeImprovDevice.js';

const loadClient = () => import('../vendor/improv-wifi/serial.js');
const session = (device, extra = {}) => {
  const lines = [];
  const s = createImprovSession({ port: device.port, loadClient, log: (l) => lines.push(l), ...extra });
  return { s, lines };
};

test('a device that answers is offered: state, info, and the port opened at 115200', async () => {
  const dev = makeFakeImprovDevice();
  const { s, lines } = session(dev);
  const r = await s.probe(500);
  assert.equal(r.offered, true);
  assert.equal(r.provisioned, false);
  assert.equal(r.nextUrl, '');
  assert.equal(r.info.firmware, 'Demo firmware');
  assert.deepEqual(dev.port.opened, [115200]);
  assert.ok(dev.seen.some((rpc) => rpc.command === 2), 'asked for the current state');
  assert.ok(dev.seen.some((rpc) => rpc.command === 3), 'asked for the device info');
  assert.ok(lines.some((l) => /offered by Demo firmware/.test(l)));
  await s.close();
  assert.equal(dev.port.closes, 1);
  assert.equal(dev.port.readable, null, 'the port is closed after close()');
});

test('scan lists the networks the device sees, then provisioning succeeds with the next URL', async () => {
  const dev = makeFakeImprovDevice({ nextUrl: 'http://192.168.1.23/' });
  const { s, lines } = session(dev);
  await s.probe(500);
  const nets = await s.scan();
  assert.deepEqual(nets.map((n) => [n.name, n.rssi, n.secured]), [['Cafe', -70, false], ['Home', -55, true]]);
  const url = await s.provision('Home', 'hunter2');
  assert.equal(url, 'http://192.168.1.23/');
  assert.deepEqual(dev.attempts, [{ ssid: 'Home', password: 'hunter2' }]);
  assert.equal(dev.state, 4, 'the device reports PROVISIONED');
  assert.ok(lines.some((l) => /on the network/.test(l)));
  await s.close();
  assert.equal(dev.port.closes, 1);
});

test('a non-ASCII network name and password reach the device intact', async () => {
  const dev = makeFakeImprovDevice();
  const { s } = session(dev);
  await s.probe(500);
  await s.provision('Zażółć gęślą', 'jaźń-2026');
  assert.deepEqual(dev.attempts, [{ ssid: 'Zażółć gęślą', password: 'jaźń-2026' }]);
  await s.close();
});

test('a silent device is not offered, nothing is thrown, and the port is closed again', async () => {
  const dev = makeFakeImprovDevice({ answers: false });
  const { s, lines } = session(dev);
  const r = await s.probe(300);
  assert.deepEqual(r, { offered: false });
  assert.ok(lines.some((l) => /does not offer Wi-Fi setup here/.test(l)), lines.join('\n'));
  assert.equal(dev.port.closes, 1);
  assert.equal(dev.port.readable, null);
  assert.ok(dev.seen.length >= 1, 'the question was asked');
  await s.close(); // a second close is a no-op
  assert.equal(dev.port.closes, 1);
});

test('a port that cannot be reopened is not offered and does not throw', async () => {
  const dev = makeFakeImprovDevice();
  dev.port.open = async () => { throw new DOMException('Failed to open serial port.', 'NetworkError'); };
  const { s, lines } = session(dev);
  assert.deepEqual(await s.probe(300), { offered: false });
  assert.ok(lines.some((l) => /could not be reopened/.test(l)));
  assert.equal(dev.port.closes, 0);
});

test('a missing client module is not offered and the port is released', async () => {
  const dev = makeFakeImprovDevice();
  const { s, lines } = session(dev, { loadClient: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')) });
  assert.deepEqual(await s.probe(300), { offered: false });
  assert.ok(lines.some((l) => /client not available/.test(l)));
  assert.equal(dev.port.closes, 1);
});

test('the device returns an error code: improv.rejected, and the session stays usable', async () => {
  const dev = makeFakeImprovDevice({ join: () => 'rejected' });
  const { s } = session(dev);
  await s.probe(500);
  await assert.rejects(s.provision('Home', 'x'), (e) => e instanceof InstallError && e.code === 'improv.rejected');
  dev.attempts.length = 0;
  await s.close();
});

test('wrong password: improv.wifi, and a second attempt with the right one succeeds', async () => {
  const dev = makeFakeImprovDevice({ join: (ssid, pw) => (pw === 'right' ? 'ok' : 'wifi') });
  const { s } = session(dev);
  await s.probe(500);
  await assert.rejects(s.provision('Home', 'wrong'), (e) => e instanceof InstallError && e.code === 'improv.wifi');
  assert.equal(await s.provision('Home', 'right'), 'http://192.168.1.23/');
  await s.close();
});

test('the device answers nothing to the credentials: improv.timeout after the given time', async () => {
  const dev = makeFakeImprovDevice({ join: () => 'silent' });
  const { s } = session(dev);
  await s.probe(500);
  await assert.rejects(s.provision('Home', 'x', 200), (e) => e instanceof InstallError && e.code === 'improv.timeout');
  await s.close();
});

test('an already provisioned device reports it and its URL on the probe', async () => {
  const dev = makeFakeImprovDevice({ provisioned: true, nextUrl: 'http://demo.local/' });
  const { s } = session(dev);
  const r = await s.probe(500);
  assert.equal(r.offered, true);
  assert.equal(r.provisioned, true);
  assert.equal(r.nextUrl, 'http://demo.local/');
  await s.close();
});

test('a device that cannot scan gives an empty list, and provisioning still works', async () => {
  const dev = makeFakeImprovDevice({ networks: null });
  const { s, lines } = session(dev);
  await s.probe(500);
  assert.deepEqual(await s.scan(), []);
  assert.ok(lines.some((l) => /scan not available/.test(l)));
  assert.equal(await s.provision('Hidden', 'pw'), 'http://192.168.1.23/');
  await s.close();
});

test('close() waits for a probe in flight, then the session refuses further work', async () => {
  const dev = makeFakeImprovDevice({ answers: false });
  const { s } = session(dev);
  const probing = s.probe(300);
  await new Promise((r) => setTimeout(r, 50));
  assert.notEqual(dev.port.readable, null, 'the port is open while the probe waits');
  const closing = s.close();
  assert.equal(s.closed, true);
  assert.equal(dev.port.closes, 0, 'close() has not cut in yet');
  assert.deepEqual(await probing, { offered: false });
  await closing;
  assert.equal(dev.port.closes, 1);
  assert.deepEqual(await s.probe(100), { offered: false }, 'a closed session opens nothing');
  assert.deepEqual(dev.port.opened, [115200]);
  assert.equal(dev.port.closes, 1);
});

test('close() queued behind a probe that is about to start makes it a no-op', async () => {
  const dev = makeFakeImprovDevice();
  const { s } = session(dev);
  const probing = s.probe(300);
  await s.close();
  assert.deepEqual(await probing, { offered: false });
  assert.deepEqual(dev.port.opened, [], 'nothing was opened');
});

test('provision before a probe, or after close, is improv.timeout rather than a crash', async () => {
  const dev = makeFakeImprovDevice();
  const { s } = session(dev);
  await assert.rejects(s.provision('Home', 'x'), (e) => e.code === 'improv.timeout');
  await s.probe(500);
  await s.close();
  await assert.rejects(s.provision('Home', 'x'), (e) => e.code === 'improv.timeout');
});

test('mapImprovError: the client rejects with plain strings, and they land on three codes', () => {
  assert.equal(mapImprovError('UNABLE_TO_CONNECT').code, 'improv.wifi');
  assert.equal(mapImprovError('TIMEOUT').code, 'improv.timeout');
  assert.equal(mapImprovError(new Error('Improv Wi-Fi Serial not detected')).code, 'improv.timeout');
  assert.equal(mapImprovError('INVALID_RPC_PACKET').code, 'improv.rejected');
  assert.equal(mapImprovError('UNKNOWN_ERROR (7)').code, 'improv.rejected');
  assert.equal(mapImprovError(undefined).code, 'improv.rejected');
  const own = new InstallError('improv.wifi');
  assert.equal(mapImprovError(own), own);
});

test('safeNextUrl: only http and https become a link', () => {
  assert.equal(safeNextUrl('http://192.168.1.23/'), 'http://192.168.1.23/');
  assert.equal(safeNextUrl(' https://demo.local/setup '), 'https://demo.local/setup');
  assert.equal(safeNextUrl('javascript:alert(1)'), '');
  assert.equal(safeNextUrl('demo.local'), '');
  assert.equal(safeNextUrl(''), '');
  assert.equal(safeNextUrl(undefined), '');
});
