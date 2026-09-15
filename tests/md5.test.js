import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { md5Hex } from '../app/md5.js';

const enc = (s) => new TextEncoder().encode(s);
test('RFC 1321 vectors', () => {
  assert.equal(md5Hex(enc('')), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5Hex(enc('abc')), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(md5Hex(enc('12345678901234567890123456789012345678901234567890123456789012345678901234567890')), '57edf4a22be3c955ac49da2e2107b67a');
});
test('agrees with node:crypto on sizes around block boundaries and a 3 MB image', () => {
  for (const n of [55, 56, 63, 64, 65, 119, 120, 1000, 3 * 1024 * 1024 + 7]) {
    const d = randomBytes(n);
    assert.equal(md5Hex(new Uint8Array(d)), createHash('md5').update(d).digest('hex'), `n=${n}`);
  }
});
