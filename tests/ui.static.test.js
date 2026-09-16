/**
 * Static invariants of the installer page. No browser here: the page is plain text, and every
 * rule below is one a strict CSP or a nervous beginner would notice the moment it broke.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const html = read('index.html');
const theme = read('theme.css');
const style = read('style.css');
const en = JSON.parse(read('locales/en.json'));

test('no inline scripts, no inline styles, strict CSP meta, module entry, no CDN', () => {
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /\sstyle="/i);
  assert.doesNotMatch(html, /\son[a-z]+="/i, 'no inline event handlers');
  assert.match(html, /http-equiv="Content-Security-Policy"[^>]*default-src 'self'/);
  assert.match(html, /script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'/);
  // frame-ancestors is ignored in a <meta> policy and logs a console error; it belongs in the host's HTTP headers.
  assert.doesNotMatch(html, /frame-ancestors/);
  assert.match(html, /<meta name="description" content="[^"]{40,}">/);
  assert.doesNotMatch(html, /unsafe-inline|https?:\/\/(unpkg|cdn\.jsdelivr|esm\.sh)/);
  assert.match(html, /<script type="module" src="app\/main\.js"><\/script>/);
  assert.match(html, /<html lang="en"/);
});

test('no emoji glyphs in UI markup', () => {
  assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
});

test('no bare e-mail or mailto', () => {
  assert.doesNotMatch(html, /mailto:|[\w.-]+@[\w-]+\.[a-z]{2,}/i);
});

test('no remote images', () => {
  assert.doesNotMatch(html, /<img[^>]*\bsrc="http/i);
});

test('three screens, each switched by is-active, plus the two allowed dialogs', () => {
  for (const id of ['screen-prepare', 'screen-install', 'screen-done']) {
    assert.match(html, new RegExp(`<section[^>]*\\bid="${id}"`), id);
  }
  assert.equal((html.match(/<dialog\b/g) ?? []).length, 3, 'board, erase and backup-file dialogs only');
  assert.match(html, /<details[^>]*\bid="tech"/);
  assert.match(html, /<details[^>]*\bclass="log"/);
});

const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? flat(v, p + k + '.') : [[p + k, v]]));
const keys = new Set(flat(en).map(([k]) => k));

test('every data-i18n key in index.html exists in locales/en.json', () => {
  const used = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  const attrs = [...html.matchAll(/data-i18n-attr="[^:"]+:([^"]+)"/g)].map((m) => m[1]);
  assert.ok(used.length > 10, 'the page is translated through data-i18n');
  const missing = [...used, ...attrs].filter((k) => !keys.has(k));
  assert.deepEqual(missing, []);
});

test('every button has visible text or an aria-label', () => {
  const ui = read('app/ui.js');
  const filledByUi = (id) => new RegExp(`\\$\\('${id}'\\)\\.textContent =`).test(ui);
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  assert.ok(buttons.length > 3);
  const mute = buttons.filter(([, attrs, inner]) => {
    const labelled = /aria-label="[^"]+"|data-i18n-attr="aria-label:/.test(attrs);
    const text = inner.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
    const i18nInside = /data-i18n="/.test(inner) || /data-i18n="/.test(attrs);
    const ids = [...(attrs + inner).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    return !labelled && !text && !i18nInside && !ids.some(filledByUi);
  });
  assert.deepEqual(mute.map(([m]) => m.slice(0, 80)), []);
});

test('every dialog has an accessible name from its heading', () => {
  const dialogs = [...html.matchAll(/<dialog\b([^>]*)>/g)].map((m) => m[1]);
  assert.equal(dialogs.length, 3);
  for (const attrs of dialogs) {
    const m = /aria-labelledby="([^"]+)"/.exec(attrs);
    assert.ok(m, 'dialog without aria-labelledby: ' + attrs);
    assert.match(html, new RegExp(`<h2[^>]*\\bid="${m[1]}"`), 'heading ' + m[1] + ' must exist');
  }
});

test('every input has a <label for> or an aria-label', () => {
  const inputs = [...html.matchAll(/<input\b([^>]*)>/g)].map((m) => m[1]);
  assert.ok(inputs.length >= 4);
  const unlabelled = inputs.filter((attrs) => {
    if (/aria-label="[^"]+"/.test(attrs)) return false;
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    return !id || !new RegExp(`<label[^>]*\\bfor="${id}"`).test(html);
  });
  assert.deepEqual(unlabelled, []);
});

test('no theme toggle: the system colour scheme decides', () => {
  assert.doesNotMatch(html, /theme-toggle|data-theme=/);
  assert.match(theme, /--backdrop:/);
});

test('dialog backdrop resolves on browsers that do not inherit tokens into ::backdrop', () => {
  assert.match(style, /dialog::backdrop\s*\{\s*background:\s*var\(--backdrop,\s*rgb\([^)]*\)\);\s*\}/);
  assert.match(theme, /dialog::backdrop\s*\{\s*--backdrop:/);
});

test('theme.css vendors Figtree and Source Sans 3 locally and never reaches the network', () => {
  assert.match(theme, /@font-face\s*\{[^}]*font-family:\s*"Figtree"/);
  assert.match(theme, /@font-face\s*\{[^}]*font-family:\s*"Source Sans 3"/);
  assert.match(theme, /@font-face\s*\{[^}]*font-family:\s*"Recursive Mono Casual"/);
  assert.doesNotMatch(theme, /https?:/);
  assert.doesNotMatch(style, /https?:/);
  assert.doesNotMatch(theme, /@import/);
  assert.doesNotMatch(style, /@import/);
});

test('theme tokens contract: every token style.css relies on is defined for light and dark', () => {
  for (const tok of ['--bg', '--bg-2', '--ink', '--dim', '--line', '--accent', '--accent-ink', '--warn', '--stop', '--done', '--font-display', '--font-body', '--font-mono', '--radius', '--gap', '--maxw']) {
    assert.match(theme, new RegExp(`${tok}:`), tok);
  }
  assert.match(theme, /prefers-color-scheme:\s*dark/);
  assert.match(theme, /\[data-theme="dark"\]/);
  assert.match(theme, /\[data-theme="light"\]/);
});

test('no gradients, no oversized shadows, motion is switched off on request', () => {
  assert.doesNotMatch(style, /gradient\(/);
  assert.doesNotMatch(style, /box-shadow:\s*[^;]*\b(1[0-9]|[2-9][0-9])px/);
  assert.match(style, /prefers-reduced-motion/);
});

test('the backup dialog has a hint line that ui.js fills with the saved file name (D-06)', () => {
  assert.match(html, /<dialog id="backup-dialog"[\s\S]*?<p id="backup-hint"><\/p>[\s\S]*?<\/dialog>/);
  const ui = read('app/ui.js');
  assert.match(ui, /requestBackupFile\(filename\)/);
  assert.match(ui, /\$\('backup-hint'\)\.textContent = t\('action\.chooseBackupHint', \{ file: /);
  assert.match(read('app/preserve.js'), /deps\.requestBackupFile\(filename\)/);
  assert.match(read('app/main.js'), /requestBackupFile: \(filename\) => ui\.requestBackupFile\(filename\)/);
});
