/**
 * What the page weighs. There is no build step here: the two stylesheets are shipped as written,
 * and nothing else in the repo watches their size.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

/**
 * The two sheets are the whole of the page's styling — there is no build step to shrink them — so
 * a ceiling here is the only thing standing between a working page and a slow one. The numbers are
 * a little above what the sheets weigh today (2026-09-16: style 25 541 B, theme 4 927 B; 6.7 and
 * 1.6 KB gzipped) and they are meant to be raised deliberately, with a reason, not drifted past.
 */
const CEILING = { 'style.css': 27000, 'theme.css': 5200 };

test('neither stylesheet has grown past its ceiling', () => {
  const over = Object.entries(CEILING)
    .map(([name, max]) => [name, Buffer.byteLength(read(name)), max])
    .filter(([, size, max]) => size > max);
  assert.deepEqual(over, [], 'raise the ceiling in this test and write down why, or take weight out');
});
