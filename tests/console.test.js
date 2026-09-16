/**
 * The serial console against a fake port: lines are complete, the lock is released, the cap
 * holds, and stop() is safe to call twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsole, createLineSplitter, createLineBuffer, cleanLine, MAX_LINE, MAX_LINES } from '../app/console.js';
import { makeFakePort } from './helpers/fakeSerialPort.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('a line split across reads arrives once, complete, and partial input is held back', async () => {
  const port = makeFakePort();
  const lines = [];
  const c = createConsole({ port, onLine: (l) => lines.push(l) });
  await c.start();
  assert.deepEqual(port.opened, [115200]);
  assert.equal(c.running, true);
  port.emit('boot: ok\r\nwifi: conn');
  await tick();
  assert.deepEqual(lines, ['boot: ok']);
  port.emit('ecting\n');
  await tick();
  assert.deepEqual(lines, ['boot: ok', 'wifi: connecting']);
  port.emit('two\nlines\nand a tail');
  await tick();
  assert.deepEqual(lines, ['boot: ok', 'wifi: connecting', 'two', 'lines']);
  await c.stop();
  assert.deepEqual(lines, ['boot: ok', 'wifi: connecting', 'two', 'lines', 'and a tail'], 'stop() flushes the tail');
});

test('a multi-byte character split across two reads is decoded whole', async () => {
  const port = makeFakePort();
  const lines = [];
  const c = createConsole({ port, onLine: (l) => lines.push(l) });
  await c.start();
  const bytes = new TextEncoder().encode('żółw\n'); // ż = c5 bc
  port.emit(bytes.subarray(0, 1));
  await tick();
  port.emit(bytes.subarray(1));
  await tick();
  assert.deepEqual(lines, ['żółw']);
  await c.stop();
});

test('stop() releases the lock, closes the port, and can be called twice', async () => {
  const port = makeFakePort();
  const c = createConsole({ port, onLine: () => {} });
  await c.start();
  assert.equal(port.readable.locked, true, 'the reader holds the lock while running');
  await c.stop();
  assert.equal(c.running, false);
  assert.equal(port.cancelled, 1);
  assert.equal(port.closes, 1);
  assert.equal(port.readable, null, 'the port is closed');
  await c.stop();
  assert.equal(port.closes, 1, 'a second stop is a no-op');
  await c.start(); // and the port can be used again afterwards
  assert.deepEqual(port.opened, [115200, 115200]);
  await c.stop();
});

test('start() twice is one reader; stop() before start() is a no-op', async () => {
  const port = makeFakePort();
  const c = createConsole({ port, onLine: () => {} });
  await c.stop();
  assert.equal(port.closes, 0);
  await c.start();
  await c.start();
  assert.equal(port.opened.length, 1);
  await c.stop();
});

test('a port that is already open is used as it is and left open by stop()', async () => {
  const port = makeFakePort();
  await port.open({ baudRate: 9600 });
  const lines = [];
  const c = createConsole({ port, onLine: (l) => lines.push(l) });
  await c.start();
  port.emit('hi\n');
  await tick();
  assert.deepEqual(lines, ['hi']);
  await c.stop();
  assert.equal(port.closes, 0, 'the console closes only what it opened');
  assert.notEqual(port.readable, null);
  assert.equal(port.readable.locked, false);
});

test('the device going away ends the stream, releases the port and reports it once', async () => {
  const port = makeFakePort();
  const ends = [];
  const c = createConsole({ port, onLine: () => {}, onEnd: (e) => ends.push(e) });
  await c.start();
  port.emit('last words');
  port.end();
  await tick();
  assert.equal(c.running, false);
  assert.deepEqual(ends, [undefined]);
  assert.equal(port.closes, 1);
  await c.stop();
  assert.equal(port.closes, 1);
  assert.deepEqual(ends, [undefined], 'stop() after the end does not report again');
});

test('a read error is reported through onEnd and the lock is still released', async () => {
  const port = makeFakePort();
  await port.open({ baudRate: 115200 });
  const boom = new Error('The device has been lost.');
  port.readable = new ReadableStream({ pull() { throw boom; } });
  const ends = [];
  const c = createConsole({ port, onLine: () => {}, onEnd: (e) => ends.push(e) });
  await c.start();
  await tick();
  assert.deepEqual(ends, [boom]);
  assert.equal(c.running, false);
  assert.equal(port.readable.locked, false);
});

test('a listener that throws does not stop the stream', async () => {
  const port = makeFakePort();
  const got = [];
  const c = createConsole({ port, onLine: (l) => { got.push(l); if (got.length === 1) throw new Error('ui'); } });
  await c.start();
  port.emit('a\nb\n');
  await tick();
  assert.deepEqual(got, ['a', 'b']);
  await c.stop();
});

test('splitter: a line longer than MAX_LINE is cut there instead of growing without bound', () => {
  const out = [];
  const s = createLineSplitter((l) => out.push(l.length));
  s.push('x'.repeat(MAX_LINE * 2 + 10));
  assert.deepEqual(out, [MAX_LINE, MAX_LINE]);
  s.flush();
  assert.deepEqual(out, [MAX_LINE, MAX_LINE, 10]);
});

test('cleanLine strips terminal colours and control characters but keeps tabs and text', () => {
  assert.equal(cleanLine('\x1b[0;32mI (312) wifi:\x1b[0m connected\r'), 'I (312) wifi: connected');
  assert.equal(cleanLine('a\tb\x07\x00c'), 'a\tbc');
  assert.equal(cleanLine('\x1b]0;title\x07plain'), '0;titleplain');
  assert.equal(cleanLine('ok'), 'ok');
});

test('the line buffer keeps the last MAX_LINES lines and renders them for a <pre>', () => {
  const b = createLineBuffer();
  for (let i = 1; i <= MAX_LINES + 100; i++) b.push('line ' + i);
  assert.equal(b.size, MAX_LINES);
  const text = b.text();
  assert.ok(text.startsWith('line 101\n'));
  assert.ok(text.endsWith('line ' + (MAX_LINES + 100) + '\n'));
  assert.equal(text.split('\n').length - 1, MAX_LINES);
  b.clear();
  assert.equal(b.text(), '');
  const small = createLineBuffer(2);
  small.push('a'); small.push('b'); small.push('c');
  assert.equal(small.text(), 'b\nc\n');
});

test('the cap holds against a chatty device end to end', async () => {
  const port = makeFakePort();
  const buf = createLineBuffer(50);
  const c = createConsole({ port, onLine: (l) => buf.push(l) });
  await c.start();
  for (let i = 0; i < 20; i++) port.emit(Array.from({ length: 10 }, (_, j) => `n${i * 10 + j}`).join('\n') + '\n');
  await tick();
  await c.stop();
  assert.equal(buf.size, 50);
  assert.ok(buf.text().endsWith('n199\n'));
  assert.ok(buf.text().startsWith('n150\n'));
});
