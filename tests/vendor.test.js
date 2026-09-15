import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PINNED = 'ef7d5a237d3f273ecf546bcee65dddad90bd82cf02f22a980d1537e0cd79a152';

test('vendored esptool-js bundle matches the pinned SHA-256', () => {
  const bytes = readFileSync(new URL('../vendor/esptool-js/esptool-js-0.6.1.js', import.meta.url));
  const sum = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sum, PINNED);
  const recorded = readFileSync(new URL('../vendor/esptool-js/SHA256SUMS', import.meta.url), 'utf8');
  assert.match(recorded, new RegExp('^' + PINNED + '  esptool-js-0.6.1.js'));
});

test('bundle is an ES module exporting ESPLoader and Transport', () => {
  const src = readFileSync(new URL('../vendor/esptool-js/esptool-js-0.6.1.js', import.meta.url), 'utf8');
  assert.match(src, /export\{[^}]*\bESPLoader\b[^}]*\}/);
  assert.match(src, /export\{[^}]*\bTransport\b[^}]*\}/);
});

test('positive control: a tampered copy fails the pin', () => {
  const bytes = Buffer.concat([readFileSync(new URL('../vendor/esptool-js/esptool-js-0.6.1.js', import.meta.url)), Buffer.from('\n')]);
  assert.notEqual(createHash('sha256').update(bytes).digest('hex'), PINNED);
});
