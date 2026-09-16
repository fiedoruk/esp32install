/**
 * The documentation quotes the page's own words. These checks keep the quoted stop
 * conditions in docs/profiles.md in step with locales/en.json, so a new or renamed
 * code cannot go undocumented and a reworded sentence cannot drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const en = JSON.parse(read('locales/en.json'));
const profiles = read('docs/profiles.md');

test('every error.* code in en.json appears in docs/profiles.md', () => {
  const missing = Object.keys(en.error).filter((code) => !profiles.includes('`' + code + '`'));
  assert.deepEqual(missing, []);
});

test('every quoted stop-condition sentence is the one in en.json, byte for byte', () => {
  const drifted = Object.entries(en.error).filter(([code, text]) => !profiles.includes('| `' + code + '` | ' + text + ' |'));
  assert.deepEqual(drifted.map(([code]) => code), []);
});

test('docs/profiles.md documents no code that en.json does not have', () => {
  const documented = [...profiles.matchAll(/^\| `([a-z]+\.[A-Za-z0-9]+)` \|/gm)].map((m) => m[1]);
  assert.ok(documented.length >= 50, `found ${documented.length} documented codes`);
  const unknown = documented.filter((code) => !(code in en.error));
  assert.deepEqual(unknown, []);
});

test('the download-counter example keeps its log where the example says to keep it', () => {
  const replicate = read('docs/replicate.md');
  assert.doesNotMatch(replicate, /\$log = __DIR__/, 'a log beside the binary is served with the binary');
  assert.match(replicate, /\$log = '\/var\/log\/esp32install\/downloads\.log';/);
});

test('the README replication example does not overwrite the shipped schema 1 manifest', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /--out firmware\/demo-1-0-0\.json/);
  assert.match(readme, /--out firmware\/my-firmware-1-0-0\.json/);
  assert.doesNotMatch(read('docs/manifest.md'), /--out firmware\/demo-1-0-0\.json/);
});
