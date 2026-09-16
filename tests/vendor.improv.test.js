/**
 * The Improv Wi-Fi client is vendored from improv-wifi-serial-sdk 2.8.1 (Apache-2.0). Two of
 * its import specifiers had no `.js` extension, which neither a browser nor Node resolves, so
 * the shipped copies carry a three-byte patch each. The pins below are of what ships; the last
 * test reverses the patch and proves the upstream bytes are what they claim to be.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const at = (p) => new URL('../vendor/improv-wifi/' + p, import.meta.url);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const SHIPPED = {
  'serial.js': 'ab4a7eadd9c03f13f1d7fdc36d64b8b7466d194e3c84f037f64c495ca912a5c6',
  'const.js': '350499f3d5b19dd3e473f95fb31a0226c4df5000e4742761963a6e79d07fda1b',
  'util/hex-formatter.js': 'd9212496c7fcbc967c5419f0fcb866727e5eb35abe0f5ab8ba661a03392ce015',
  'util/to-hex.js': '4fb4eab465268c38bf9e1efb05b378acdefdf2ffb8768ec3d4c753da063f1ca1',
  'LICENSE': 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
};

/** SHA-256 of the same files inside the npm tarball, before the extension patch. */
const UPSTREAM = {
  'serial.js': '25dce28ec070c0c7f52b47bca8461dded996441b0d827c77fd6d16902061ab13',
  'util/hex-formatter.js': '8b0d3ce97173814c4effac0218a3b326110e0678add1e26f99a0f24c39596d4c',
};

test('every vendored Improv file matches its pinned SHA-256 and SHA256SUMS records it', () => {
  const recorded = readFileSync(at('SHA256SUMS'), 'utf8');
  for (const [name, pin] of Object.entries(SHIPPED)) {
    assert.equal(sha(readFileSync(at(name))), pin, name);
    assert.match(recorded, new RegExp('^' + pin + '  ' + name.replace('.', '\\.') + '$', 'm'), name + ' in SHA256SUMS');
  }
  assert.equal(recorded.trim().split('\n').length, Object.keys(SHIPPED).length, 'SHA256SUMS lists exactly the shipped files');
});

test('the only change from upstream is the .js extension on two import specifiers', () => {
  const serial = readFileSync(at('serial.js'), 'utf8');
  const hex = readFileSync(at('util/hex-formatter.js'), 'utf8');
  assert.equal(sha(serial.replace('from "./util/hex-formatter.js";', 'from "./util/hex-formatter";')), UPSTREAM['serial.js']);
  assert.equal(sha(hex.replace('from "./to-hex.js";', 'from "./to-hex";')), UPSTREAM['util/hex-formatter.js']);
});

test('the client imports nothing outside its own directory and exports ImprovSerial', () => {
  for (const name of ['serial.js', 'const.js', 'util/hex-formatter.js', 'util/to-hex.js']) {
    const src = readFileSync(at(name), 'utf8');
    for (const m of src.matchAll(/from\s+"([^"]+)"/g)) {
      assert.match(m[1], /^\.\/[a-z/-]+\.js$/, `${name} imports ${m[1]}`);
    }
    assert.doesNotMatch(src, /\bimport\s*\(/, name + ' has no dynamic import');
  }
  assert.match(readFileSync(at('serial.js'), 'utf8'), /export class ImprovSerial extends EventTarget/);
});

test('positive control: a tampered copy fails the pin', () => {
  const bytes = Buffer.concat([readFileSync(at('serial.js')), Buffer.from('\n')]);
  assert.notEqual(sha(bytes), SHIPPED['serial.js']);
});
