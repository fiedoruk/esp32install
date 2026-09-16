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

test('theme: a synchronous init script in <head>, two named buttons, and no theme hard-coded in the markup', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /<script src="theme-init\.js"><\/script>/, 'a classic script, no defer, no module: it must run before the first paint');
  assert.doesNotMatch(html, /data-theme=/, 'only the script sets data-theme; theme.css follows the system until then');
  const init = read('theme-init.js');
  assert.match(init, /try\s*\{[^}]*localStorage\.getItem\('theme'\)[\s\S]*?\}\s*catch/, 'storage is read inside try/catch');
  assert.match(init, /setAttribute\('data-theme', theme\)/);
  assert.doesNotMatch(init, /\b(import|export)\b/, 'not a module');
  assert.match(html, /<div class="theme" role="group" data-i18n-attr="aria-label:action\.theme">/);
  for (const name of ['light', 'dark']) {
    const cap = name[0].toUpperCase() + name.slice(1);
    assert.match(html, new RegExp(`<button type="button" id="theme-${name}" aria-pressed="false" data-i18n-attr="aria-label:action\\.theme${cap}">`), name);
  }
  assert.match(read('app/main.js'), /mountThemeToggle\(\{ buttons: \{ light: document\.getElementById\('theme-light'\), dark: document\.getElementById\('theme-dark'\) \} \}\)/);
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

test('the save button lives on the install screen, is hidden until the copy is ready, and main.js saves inside its click', () => {
  assert.match(html, /<section class="screen" id="screen-install"[\s\S]*?<button class="cta" id="save-backup" type="button" hidden data-i18n="action\.saveBackup"><\/button>[\s\S]*?<\/section>/);
  const ui = read('app/ui.js');
  assert.match(ui, /requestBackupSave\(\)/);
  assert.match(ui, /\$\('save-backup'\)\.hidden = true/, 'startInstall hides the button again');
  const main = read('app/main.js');
  assert.match(main, /await ui\.requestBackupSave\(\);\s*const saved = await saveBackupWithHandle\(bytes, filename\);\s*if \(!saved\) await saveBlob\(bytes, filename\);\s*return saved;/);
  assert.match(read('app/preserve.js'), /readBackHandle\(saved\.handle\)/);
});

test('the own-file path: an entry under the list, a block on the prepare screen with labelled controls, and a way back from a catalogued install', () => {
  assert.match(html, /<a class="own-card" id="own-entry">\s*<b data-i18n="simple\.own\.title"><\/b>\s*<small data-i18n="simple\.own\.hint"><\/small>\s*<\/a>/);
  assert.match(html, /<section class="screen" id="screen-prepare"[\s\S]*?<div class="own" id="own" hidden>[\s\S]*?<\/section>/, 'the block lives on the prepare screen');
  assert.match(html, /<label class="file" for="own-file"><span data-i18n="simple\.own\.choose"><\/span><input type="file" id="own-file" accept="\.bin,application\/octet-stream"><\/label>/);
  assert.match(html, /<div class="own-read" id="own-read" hidden>/, 'what was read stays hidden until a file is chosen');
  assert.match(html, /<div class="own-url">\s*<label class="field" for="own-url"><span data-i18n="simple\.own\.url"><\/span><input type="text" id="own-url" spellcheck="false" autocomplete="off" autocapitalize="off"><\/label>\s*<button type="button" class="small" id="own-url-go" data-i18n="simple\.own\.urlGo"><\/button>\s*<\/div>\s*<p class="own-hint" data-i18n="simple\.own\.urlHint"><\/p>/, 'the address field sits beside the file input');
  assert.match(read('app/main.js'), /fetchOwnFile\(fetch\.bind\(window\), address, document\.baseURI\)/, 'a typed address is fetched by the page, never by a manifest');
  assert.doesNotMatch(read('app/manifest.js'), /own\.blocked|fetchOwnFile/, 'the manifest layer keeps its origin policy');
  assert.match(html, /<div class="doors" role="radiogroup" data-i18n-attr="aria-label:simple\.own\.where">/);
  for (const [id, key] of [['own-whole', 'whole'], ['own-app', 'app']]) {
    assert.match(html, new RegExp(`<label class="door" for="${id}">\\s*<input type="radio" name="own-where" id="${id}" value="${key}">[\\s\\S]*?<b data-i18n="simple\\.own\\.${key}"><\\/b><small data-i18n="simple\\.own\\.${key}Hint">`), id);
  }
  assert.match(html, /<label class="field" for="own-address"><span data-i18n="simple\.own\.address"><\/span><input type="text" id="own-address" spellcheck="false" autocomplete="off" autocapitalize="off"><\/label>/);
  assert.match(html, /<label class="field" for="own-chip"><span data-i18n="simple\.own\.device"><\/span><select id="own-chip"><\/select><\/label>/);
  assert.match(html, /<p class="hint-text" id="own-note" aria-live="polite"><\/p>/, 'the plan is spoken before the button');
  assert.match(html, /<a class="quiet" id="own-instead" hidden data-i18n="simple\.own\.instead"><\/a>/);
  assert.match(html, /<dt id="fact-release-label" data-i18n="tech\.release"><\/dt>/);
  const main = read('app/main.js');
  assert.match(main, /q\.get\('own'\) === '1'\) return startOwn\(lang\)/, '?own=1 opens the path on any copy');
  assert.match(main, /if \(systems\.length === 0\) return startOwn\(lang\)/, 'no catalog, or an empty one, opens it too');
  assert.match(main, /localManifest\(\{ name: picked\.name, chipFamily: choice\.chipFamily, parts: \[\{ path: picked\.name, offset: choice\.offset, bytes: picked\.bytes \}\] \}\)/);
  const ui = read('app/ui.js');
  assert.match(ui, /\$\('connect'\)\.disabled = !choice/, 'no install without both choices');
  assert.match(ui, /t\('simple\.own\.plan', \{ name: own\.name, address, device: chipFamily \}\)/, 'the address and the chip are shown before the install');
});

test('the simple layer of the own-file path never says .bin; only the file input and the technical layer may', () => {
  for (const [k, v] of Object.entries(en.simple.own)) assert.doesNotMatch(v, /\.bin/i, k);
  assert.equal((html.match(/\.bin/g) ?? []).length, 2, 'the two accept attributes');
});

test('the Wi-Fi step lives on the done screen, hidden until the device asks for it, with labelled fields and a masked password', () => {
  assert.match(html, /<section class="screen" id="screen-done"[\s\S]*?<section class="wifi" id="wifi" hidden aria-labelledby="wifi-title">[\s\S]*?<\/section>[\s\S]*?<\/section>/);
  assert.match(html, /<h2 id="wifi-title" data-i18n="simple\.wifi\.title"><\/h2>/);
  assert.match(html, /<label class="field" for="wifi-ssid"><span data-i18n="simple\.wifi\.network"><\/span><input type="text" id="wifi-ssid" list="wifi-list" spellcheck="false" autocomplete="off" autocapitalize="off"><\/label>/);
  assert.match(html, /<datalist id="wifi-list"><\/datalist>/, 'the scanned networks are suggestions; a hidden network can still be typed');
  assert.match(html, /<label class="field" for="wifi-pass"><span data-i18n="simple\.wifi\.password"><\/span><input type="password" id="wifi-pass" autocomplete="off"><\/label>/);
  assert.match(html, /<button class="cta" id="wifi-send" type="button" data-i18n="action\.wifiSend"><\/button>/);
  assert.match(html, /<button class="quiet-btn" id="wifi-skip" type="button" data-i18n="simple\.wifi\.skip"><\/button>/);
  assert.match(html, /<p class="lead" id="wifi-ok" hidden data-i18n="simple\.wifi\.ok"><\/p>/);
  assert.match(html, /<a id="wifi-next" class="cta" hidden rel="noopener" target="_blank"><\/a>/, 'the device address opens beside the installer, never in its place');
  assert.doesNotMatch(html, /<form\b/, 'no form: form-action is none in the policy, and Enter is handled by hand');
  const ui = read('app/ui.js');
  assert.match(ui, /\$\('wifi'\)\.hidden = true/, 'startInstall and setError hide the step');
  assert.match(ui, /a\.href = url; a\.textContent = t\('simple\.wifi\.open'\)/);
  const main = read('app/main.js');
  assert.match(main, /if \(!port \|\| build\?\.improv === false\) return;/, 'improv: false is not even asked');
  assert.match(main, /offerWifi\(\)\.catch\(/, 'nothing in the Wi-Fi step can reach the install result');
  assert.match(main, /loadClient: \(\) => import\('\.\.\/vendor\/improv-wifi\/serial\.js'\)/);
  assert.match(read('app/improv.js'), /safeNextUrl\(client\.nextUrl\)/, 'the device address is checked before it becomes a link');
});
