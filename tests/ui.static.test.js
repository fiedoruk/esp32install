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
  assert.doesNotMatch(style, /url\(\s*["']?https?:/, 'no url() may point at the network');
  // The only http in style.css is the SVG namespace inside the grain texture's data: URI, which never leaves the page.
  assert.deepEqual([...style.matchAll(/https?:[^'")\s]*/g)].map((m) => m[0]), ['http://www.w3.org/2000/svg']);
  assert.doesNotMatch(theme, /@import/);
  assert.doesNotMatch(style, /@import/);
});

test('the grain texture is one small inline SVG, under the plate content, and nothing else is a data: URI', () => {
  const uris = [...style.matchAll(/url\("(data:[^"]+)"\)/g)].map((m) => m[1]);
  assert.equal(uris.length, 1, 'one texture, on .plate::before');
  assert.ok(uris[0].length < 400, 'the texture stays under a few hundred bytes: ' + uris[0].length);
  assert.match(uris[0], /^data:image\/svg\+xml,/);
  assert.match(style, /\.plate::before\s*\{[^}]*z-index:\s*-1/, 'the grain sits under the text');
  assert.match(style, /\.plate\s*\{[^}]*isolation:\s*isolate/, 'and stays inside the plate');
});

test('theme tokens contract: every token style.css relies on is defined for light and dark', () => {
  for (const tok of ['--bg', '--bg-2', '--ink', '--dim', '--line', '--accent', '--accent-ink', '--warn', '--stop', '--done', '--font-display', '--font-body', '--font-mono', '--radius', '--radius-plate', '--radius-in', '--ring-width', '--gap', '--maxw', '--t-micro', '--t-small', '--t-body', '--t-lead', '--t-h2', '--t-h1', '--t-hero', '--s1', '--s7', '--motion-fast', '--motion-base', '--ease']) {
    assert.match(theme, new RegExp(`${tok}:`), tok);
  }
  // Every colour-bearing token has a light value and a dark value in each of the three places a theme is set.
  for (const tok of ['--bg', '--bg-2', '--ink', '--dim', '--line', '--line-2', '--accent', '--accent-2', '--accent-ink', '--accent-tint', '--warn', '--stop', '--stop-tint', '--done', '--done-tint', '--well', '--track', '--lamp-off', '--edge-hi', '--field-hi', '--shade-1', '--shade-2', '--grain', '--grain-blend']) {
    assert.equal((theme.match(new RegExp(`${tok}:`, 'g')) ?? []).length, 4, tok + ' in :root, prefers-color-scheme dark, [data-theme=dark] and [data-theme=light]');
  }
  // Every token style.css reads is one theme.css defines.
  const defined = new Set([...theme.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
  const used = new Set([...style.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  const undefinedTokens = [...used].filter((t) => !defined.has(t) && t !== '--off');
  assert.deepEqual(undefinedTokens, [], 'tokens style.css uses but theme.css never sets');
  assert.match(theme, /prefers-color-scheme:\s*dark/);
  assert.match(theme, /\[data-theme="dark"\]/);
  assert.match(theme, /\[data-theme="light"\]/);
});

test('one light spot on the field, no decorative gradients, shadows held close, motion switched off on request', () => {
  const gradients = [...style.matchAll(/[a-z-]*gradient\(/g)].map((m) => m[0]);
  assert.deepEqual(gradients, ['radial-gradient('], 'one radial spot behind the plate, nothing linear');
  assert.match(style, /body\s*\{[^}]*radial-gradient\([^)]*var\(--field-hi\)/, 'the spot is the field colour token, not a named colour');
  for (const m of style.matchAll(/box-shadow:\s*([^;]+);/g)) {
    for (const px of m[1].matchAll(/(-?\d+)px/g)) assert.ok(Math.abs(Number(px[1])) <= 40, 'shadow offset or blur over 40px: ' + m[1]);
  }
  assert.doesNotMatch(style, /box-shadow:[^;]*var\(--accent\)/, 'no glow in the accent colour');
  assert.match(style, /prefers-reduced-motion/);
  const reduced = style.slice(style.indexOf('prefers-reduced-motion'));
  for (const sel of ['.picto-link', '.ring.is-busy .ring-arc', '.lamp.is-on.is-pulse i', '.screen.is-active']) assert.match(reduced, new RegExp(sel.replace(/[.]/g, '\\.') + '[^}]*animation:\\s*none'), sel);
  assert.match(reduced, /--motion-fast:\s*0ms;\s*--motion-base:\s*0ms/);
  // The cable's dashes move only while the browser's port window is open (the mode radios are locked then).
  const link = [...style.matchAll(/^([^\n]*)\.picto-link\s*\{[^}]*animation:\s*link/gm)].map((m) => m[1]);
  assert.deepEqual(link, ['#screen-prepare:has(#mode-first:disabled) ']);
});

test('the visual upgrade kept its four structural hooks in the markup and nothing inline', () => {
  for (const cls of ['picto-pc', 'picto-link', 'picto-body', 'picto-screen', 'picto-led']) assert.match(html, new RegExp(`<svg class="picto"[\\s\\S]*?class="${cls}"[\\s\\S]*?</svg>`), cls);
  assert.match(html, /<svg class="ring" id="ring"[^>]*>\s*<circle class="ring-dial" cx="60" cy="60" r="44" aria-hidden="true"\/>\s*<circle class="ring-track"/);
  assert.match(html, /<svg class="mark" id="mark"[^>]*>\s*<circle class="mark-fill" cx="60" cy="60" r="46"\/>\s*<circle class="ring-dial" cx="60" cy="60" r="44"\/>\s*<circle class="mark-ring"/);
  assert.match(html, /<div class="hatches">\s*<details class="tech" id="tech">[\s\S]*?<details class="log" id="log-details" hidden>[\s\S]*?<details class="alt-wrap" id="alt-wrap">[\s\S]*?<\/details>\s*<\/div>\s*<\/div>/, 'the three hatches sit in one chamber, last on the plate');
  assert.match(html, /<a class="brand" href="\.\/"><svg class="signet" viewBox="0 0 32 32" aria-hidden="true">[\s\S]*?<\/svg><span class="word"><b>esp32<\/b>install<\/span><\/a>/);
  assert.match(html, /<link rel="icon" href="favicon\.svg">/);
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

test('the own-file path: an entry under the list, a row list on the prepare screen, the address field beside it, and a way back from a catalogued install', () => {
  assert.match(html, /<a class="own-card" id="own-entry">\s*<b data-i18n="simple\.own\.title"><\/b>\s*<small data-i18n="simple\.own\.hint"><\/small>\s*<\/a>/);
  assert.match(html, /<section class="screen" id="screen-prepare"[\s\S]*?<div class="own" id="own" hidden>[\s\S]*?<\/section>/, 'the block lives on the prepare screen');
  assert.match(html, /<ul class="pick-list own-parts" id="own-parts"><\/ul>\s*<button type="button" class="btn" id="own-add" hidden data-i18n="simple\.own\.addFile"><\/button>/, 'rows are built by ui.js; the add button waits for the first file');
  assert.match(html, /<div class="own-url">\s*<label class="field" for="own-url"><span data-i18n="simple\.own\.url"><\/span><input type="text" id="own-url" spellcheck="false" autocomplete="off" autocapitalize="off"><\/label>\s*<button type="button" class="btn" id="own-url-go" data-i18n="simple\.own\.urlGo"><\/button>\s*<\/div>\s*<p class="own-hint" data-i18n="simple\.own\.urlHint"><\/p>/, 'the address field sits under the rows');
  assert.match(html, /<div class="own-read" id="own-read" hidden>\s*<label class="field" for="own-chip"><span data-i18n="simple\.own\.device"><\/span><select id="own-chip"><\/select><\/label>\s*<p class="hint-text" id="own-note" aria-live="polite"><\/p>\s*<\/div>/, 'one device for the whole set, and the plan spoken before the button');
  assert.match(html, /<div class="line" id="door-line">/, 'the doors can be hidden until a file exists');
  assert.match(html, /<p class="note" id="connect-why" hidden aria-live="polite"><\/p>\s*<button class="cta" id="connect" type="button">/, 'the disabled button says why, right above it');
  assert.match(html, /<a class="quiet" id="own-instead" hidden data-i18n="simple\.own\.instead"><\/a>/);
  assert.match(html, /<dt id="fact-release-label" data-i18n="tech\.release"><\/dt>/);
  assert.doesNotMatch(html, /own-where|own-whole|own-app|simple\.own\.where/, 'the whole/app doors are gone: every row carries its own address');
  const main = read('app/main.js');
  assert.match(main, /fetchOwnFile\(fetch\.bind\(window\), address, document\.baseURI\)/, 'a typed address is fetched by the page, never by a manifest');
  assert.doesNotMatch(read('app/manifest.js'), /own\.blocked|fetchOwnFile/, 'the manifest layer keeps its origin policy');
  assert.match(main, /q\.get\('own'\) === '1'\) return startOwn\(lang\)/, '?own=1 opens the path on any copy');
  assert.match(main, /if \(systems\.length === 0\) return startOwn\(lang\)/, 'no catalog, or an empty one, opens it too');
  assert.match(main, /describePart\(name, bytes, ui\.ownChipFamily\(\)\)/, 'every file is described, with the chosen device as the hint for a bootloader');
  assert.match(main, /return ownProblem\(parts, choice\.chipFamily\);/, 'the set is checked on every change with the engine\'s own checks');
  assert.match(main, /\.sort\(\(a, b\) => a\.offset - b\.offset\)\.map\(\(p\) => \(\{ path: p\.name, offset: p\.offset, bytes: picked\.get\(p\.id\)\.bytes \}\)\);\s*manifest = await localManifest\(\{ name: names\(\), chipFamily: choice\.chipFamily, parts \}\)/, 'every part goes into one local manifest');
  const ui = read('app/ui.js');
  assert.match(ui, /import \{ MAX_PARTS \} from '\.\/own\.js';/);
  assert.match(ui, /if \(ownRows\.length >= MAX_PARTS\) return null;/, 'no seventh row');
  assert.match(ui, /\$\('own-add'\)\.disabled = ownRows\.length >= MAX_PARTS;/);
  assert.match(ui, /for \(const id of \['own-read', 'door-line', 'doors', 'backup-opt'\]\) \$\(id\)\.hidden = !has;/, 'doors, copy and details wait for the first file');
  assert.match(ui, /\$\('door-update-hint'\)\.textContent = t\('door\.updateHintOwn'\);/, 'the update door never shows an empty system name');
  assert.match(ui, /\$\('connect'\)\.disabled = why !== '';\s*\$\('connect-why'\)\.textContent = why;/, 'the button is off exactly when there is a reason, and the reason is shown');
  assert.match(ui, /if \(filled\.length === 0\) return t\('simple\.own\.needFile'\);/);
  assert.match(ui, /t\('simple\.own\.plan', \{ name: choice\.parts\[0\]\.name, address: '0x' \+ choice\.parts\[0\]\.offset\.toString\(16\), device: chipFamily \}\)/, 'the address and the chip are shown before the install');
  assert.match(ui, /file\.accept = '\.bin,application\/octet-stream';/);
  assert.match(ui, /addrLabel\.htmlFor = `own-address-\$\{id\}`;[\s\S]*?address\.id = `own-address-\$\{id\}`;/, 'every generated input has a label');
  assert.doesNotMatch(ui, /innerHTML/);
});

test('the own-file path speaks about the visitor\'s own file, in one voice, with the hex beside the field', () => {
  const ui = read('app/ui.js');
  const map = ui.slice(ui.indexOf('const OWN_PROBLEM_KEY'), ui.indexOf('const ownFilled'));
  // Every check the page runs before connecting has an own-file sentence; nothing falls through to
  // the catalogue's "this release" / "tell whoever published it".
  for (const code of ['verify.overlap', 'verify.wrongChip', 'verify.notAnImage', 'verify.beyondFlash', 'verify.totalTooLarge', 'verify.chipUnknown']) {
    assert.ok(map.includes(`'${code}':`), code + ' needs an own-file sentence');
  }
  assert.match(ui, /const key = OWN_PROBLEM_KEY\[e\?\.code\];\s*return key \? t\(key, safeParams\(e\?\.params\)\) : t\('simple\.own\.problem'\);/, 'the fallback is an own-file sentence, never error.*');
  // And the stopped screen, which sees the stops the pre-flight check cannot: the wording is
  // chosen by which path the page is on, not by which code arrived.
  assert.match(ui, /ownPath \? ownErrorText\(t, code, params\) : t\('error\.' \+ code, params\)/, 'the stopped screen asks the path first');
  assert.match(ui, /showOwn\(chips\) \{\s*ownPath = true;/, 'and the path is set where it is entered');
  for (const k of ['overlap', 'wrongDevice', 'notAnImage', 'tooFar', 'tooMuch', 'deviceUnknown', 'problem']) {
    assert.doesNotMatch(en.simple.own[k], /release|publish|written/i, 'simple.own.' + k + ' must not blame a publisher or claim anything was written');
  }
  // One reason, one voice: two polite live regions must not read the same sentence out twice.
  assert.match(ui, /\$\('own-note'\)\.textContent = why \? '' :/, 'the note falls silent while the line above the button speaks');
  // The example with hex belongs beside the address box, not above the main button.
  assert.match(ui, /if \(filled\.some\(\(r\) => parseAddress\(r\.address\.value\) === null\)\) return t\('simple\.own\.needAddress'\);/);
  assert.doesNotMatch(en.simple.own.needAddress, /0x/);
  assert.match(en.simple.own.badAddress, /0x1000/);
  assert.match(ui, /r\.info\.textContent = bad \? `\$\{r\.kindText\} \$\{t\('simple\.own\.badAddress'\)\}`\.trim\(\) : r\.kindText;/);
});

test('a file read from an address cannot outrun the rows: the button follows the set, and bytes leave with a removed row', () => {
  const ui = read('app/ui.js');
  assert.match(ui, /setOwnReading\(on\) \{[\s\S]*?if \(!on\) refreshOwn\(\);/, 'the read button is re-decided by the page, not switched on blind');
  assert.match(ui, /const row = ownRows\.find\(\(r\) => r\.id === id\);\s*if \(!row\) return false;/, 'setOwnPart reports a row that is gone');
  assert.match(read('app/main.js'), /if \(!ui\.setOwnPart\(id, \{ name, size: bytes\.length, sha256, \.\.\.facts \}\)\) \{ picked\.delete\(id\); return; \}/, 'and main.js drops the bytes it was holding for it');
});

test('the simple layer of the own-file path never says .bin; only the file input and the technical layer may', () => {
  const flatOwn = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? flatOwn(v, p + k + '.') : [[p + k, v]]));
  for (const [k, v] of flatOwn(en.simple.own)) assert.doesNotMatch(v, /\.bin/i, k);
  assert.equal((html.match(/\.bin/g) ?? []).length, 1, 'the backup dialog\'s accept attribute; the row pickers get theirs from ui.js');
});

test('the Wi-Fi step lives on the done screen, hidden until the device asks for it, with labelled fields and a masked password', () => {
  assert.match(html, /<section class="screen" id="screen-done"[\s\S]*?<section class="wifi" id="wifi" hidden aria-labelledby="wifi-title">[\s\S]*?<\/section>[\s\S]*?<\/section>/);
  assert.match(html, /<h2 id="wifi-title" data-i18n="simple\.wifi\.title"><\/h2>/);
  assert.match(html, /<label class="field" for="wifi-ssid"><span data-i18n="simple\.wifi\.network"><\/span><input type="text" id="wifi-ssid" list="wifi-list" spellcheck="false" autocomplete="off" autocapitalize="off"><\/label>/);
  assert.match(html, /<datalist id="wifi-list"><\/datalist>/, 'the scanned networks are suggestions; a hidden network can still be typed');
  assert.match(html, /<label class="field" for="wifi-pass"><span data-i18n="simple\.wifi\.password"><\/span><input type="password" id="wifi-pass" autocomplete="off"><\/label>/);
  assert.match(html, /<button class="cta" id="wifi-send" type="button" data-i18n="action\.wifiSend"><\/button>/);
  assert.match(html, /<button class="btn btn--ghost" id="wifi-skip" type="button" data-i18n="simple\.wifi\.skip"><\/button>/);
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

test('the console lives inside the technical log: one button, hidden until a port was picked, lines through textContent under a cap', () => {
  // The hatch starts hidden and the box is focusable: a scrollable region has to be reachable
  // from the keyboard, and a log hatch that opens on nothing is a promise the page cannot keep.
  assert.match(html, /<details class="log" id="log-details" hidden>[\s\S]*?<pre id="log" tabindex="0"><\/pre>[\s\S]*?<button type="button" class="btn" id="console-toggle" hidden aria-pressed="false" data-i18n="action\.console"><\/button>[\s\S]*?<\/details>/);
  const ui = read('app/ui.js');
  assert.match(ui, /const logLines = createLineBuffer\(\);/, 'the log <pre> is fed from the capped buffer');
  assert.match(ui, /const text = logLines\.text\(\);\s*pre\.textContent = text;/);
  assert.doesNotMatch(ui, /innerHTML/, 'nothing the device prints is ever parsed as markup');
  assert.match(ui, /appendDeviceLine\(line\)/);
  assert.match(ui, /\$\('log-details'\)\.hidden = text === '';\s*\$\('copy-log'\)\.disabled = text === '';/, 'the hatch and the copy button wait for the first line');
  assert.match(ui, /if \(on\) \$\('log-details'\)\.hidden = false;/, 'and the console button is never walled into a hidden hatch');
  assert.match(ui, /ui\.setConsoleAvailable\(false\);/, 'startInstall hides the button');
  const main = read('app/main.js');
  assert.match(main, /if \(monitor\) \{ const m = monitor; monitor = null; await m\.stop\(\); ui\.setConsoleRunning\(false\); \}/, 'releasePort stops the console');
  assert.match(main, /await releasePort\(\); \/\/ the Wi-Fi step must not hold the port/, 'and every install starts with releasePort');
  assert.match(main, /ui\.setConsoleAvailable\(Boolean\(port\)\);[\s\S]*?ui\.setError\(e\.error, \{ changed: e\.changed \}\);\s*ui\.setConsoleAvailable\(Boolean\(port\)\);/, 'offered on the done screen and on the stopped screen');
  assert.match(read('app/console.js'), /export const MAX_LINES = 500;/);
});

test('the stopped title depends on whether the engine had begun erasing or writing, never on the error code alone', () => {
  const ui = read('app/ui.js');
  assert.match(ui, /setError\(error, \{ changed = false \} = \{\}\)/);
  assert.match(ui, /t\(changed \? 'simple\.stopped\.during' : 'simple\.stopped\.safe'\)/);
  assert.doesNotMatch(ui, /simple\.stopped\.title/);
  assert.match(read('app/main.js'), /ui\.setError\(e\.error, \{ changed: e\.changed \}\)/, 'main.js passes the engine flag through');
  const engine = read('app/engine.js');
  assert.match(engine, /emit\(\{ type: 'error', error, changed \}\)/);
  assert.match(engine, /stage\('erasing', 35\);\s*changed = true;/, 'the erase flips the flag before eraseFlash');
  assert.match(engine, /writing = true;\s*changed = true;\s*await loader\.writeFlash/, 'so does the write');
  assert.match(engine, /setWriting: \(\) => \{ writing = true; changed = true; \}/, 'and the preserve profile');
  assert.match(en.simple.stopped.safe, /unchanged/);
  assert.match(en.simple.stopped.during, /Keep the cable in/);
});

test('a guide link from the catalog is filtered before it can become an href', () => {
  const ui = read('app/ui.js');
  const main = read('app/main.js');
  assert.match(main, /const guide = safeHref\(release\.guide \?\? system\.guide\);/, 'once at the source');
  assert.match(ui, /const nextHref = safeHref\(next\);/);
  assert.match(ui, /const guideHref = safeHref\(guide\);/);
  assert.doesNotMatch(ui, /\$\('done-next'\)\.href = next;/);
  assert.doesNotMatch(ui, /\$\('alt-guide'\)\.href = guide;/);
});

test('the erase dialog always has a way out, the safe answer first and the erase as the heavy one', () => {
  const ui = read('app/ui.js');
  assert.match(ui, /confirmErase\(build, mode, \{ required = false \} = \{\}\)/);
  assert.match(ui, /const key = required \? 'erase\.textAlways' : mode === 'update' \? 'erase\.textUpdate' : 'erase\.textFirst';/);
  // Reading order in the markup is the order on screen: Cancel, install without erasing, erase.
  assert.match(html, /<div class="row"><button type="button" class="btn btn--ghost" id="erase-cancel" autofocus data-i18n="action\.cancel"><\/button><button type="button" class="btn" id="erase-no"><\/button><button type="button" class="btn btn--warn" id="erase-yes"><\/button><\/div>/,
    'the way out is first and focused, the erase is last');
  // Cancel is its own button, not a relabelling: the middle one installs, whatever it is called,
  // so it never says Cancel. A release that always clears simply has no middle button.
  assert.match(ui, /\$\('erase-no'\)\.textContent = t\(mode === 'update' \? 'erase\.no' : 'erase\.noErase'\);/);
  assert.match(ui, /\$\('erase-no'\)\.hidden = required;/, 'nothing can be kept, so nothing offers to keep it');
  assert.match(ui, /\$\('erase-cancel'\)\.onclick = \(\) => finish\(null\);\s*d\.oncancel = \(e\) => \{ e\.preventDefault\(\); finish\(null\); \};/,
    'Escape means the same as Cancel, as in the board dialog');
  assert.equal(en.erase.noErase, 'Install without erasing');
  for (const k of ['no', 'noErase']) assert.doesNotMatch(en.erase[k], /cancel/i, 'erase.' + k + ' must not read as cancelling');
  assert.match(en.erase.textAlways, /\{board\}/);
  assert.match(en.erase.textAlways, /cannot be kept/i, 'the dialog says what is about to happen');
  // Amber, filled, once: the heavy choice is the only filled key besides the page's own action.
  assert.match(style, /\.btn--warn \{ border-color: var\(--warn\); background: var\(--warn\); color: var\(--bg\); \}/);
  assert.equal((style.match(/\.btn--warn/g) ?? []).length, 2, 'one rule and its hover, nothing else wears it');
  const engine = read('app/engine.js');
  assert.match(engine, /if \(!await confirmErase\(build, mode, \{ required: true \}\)\) throw new InstallError\('serial\.cancelled'\);/);
  // The engine reads two answers; the third is turned into a cancelled run in the adapter, so
  // the check right after the dialog throws before an erase or a write can start.
  const main = read('app/main.js');
  assert.match(main, /const answer = await ui\.confirmErase\(build, mode, options\);\s*if \(answer === null\) installer\.cancel\(\);\s*return answer === true;/);
  assert.match(engine, /eraseFirst = await confirmErase\(build, mode, \{ required: false \}\);\s*\}\s*check\(\);/, 'and that check is still there');
});

test('the first screen names the version, labels a pre-release, and warns before a preserve install that a copy comes first', () => {
  assert.match(html, /<p class="kicker" id="title"><\/p>\s*<p class="pre-label" id="pre-label" hidden><\/p>/, 'the label sits next to the system name');
  assert.match(html, /<p class="lead" id="backup-first" hidden data-i18n="simple\.prepare\.backupFirst"><\/p>\s*<div class="opt-row" id="backup-opt" hidden>/);
  assert.match(html, /<small id="door-first-hint" data-i18n="door\.firstHint"><\/small>/);
  const main = read('app/main.js');
  assert.match(main, /title: i18n\.t\('app\.titleVersion', \{ system: system\.name, version: manifest\.version \}\)/, 'the kicker carries the version');
  assert.match(main, /preRelease: \(release\.channel \?\? 'stable'\) !== 'stable'/, 'absent channel means stable, as in catalog.js');
  assert.match(main, /ui\.setPreserve\(manifest\.profile === 'preserve'\)/);
  const ui = read('app/ui.js');
  assert.match(ui, /\$\('pre-label'\)\.textContent = preRelease \? t\('simple\.preRelease'\) : '';\s*\$\('pre-label'\)\.hidden = !preRelease;/);
  assert.match(ui, /\$\('backup-first'\)\.hidden = !on;\s*\$\('door-first-hint'\)\.textContent = t\(on \? 'door\.firstHintNew' : 'door\.firstHint'\);/);
  assert.match(en.app.titleVersion, /\{system\} \{version\}/);
  assert.match(en.simple.prepare.backupFirst, /copying everything/);
  assert.match(en.door.firstHintNew, /^New device\./);
});

test('the browser gate names every browser with Web Serial and the EN link always says lang=en', () => {
  assert.match(en.gate.noSerial, /Chrome, Edge, Opera or Firefox 151/);
  assert.match(read('README.md'), /Firefox 151 or newer/);
  assert.match(read('docs/replicate.md'), /Firefox 151 and newer/);
  const main = read('app/main.js');
  assert.match(main, /a\.href = langLinkHref\(location\.href, target\);/);
  assert.doesNotMatch(main, /searchParams\.delete\('lang'\)/, 'dropping the parameter left /pl/install Polish');
});

test('the backup checkbox estimates from the detected flash, and says "a few minutes" until then', () => {
  const ui = read('app/ui.js');
  assert.match(ui, /\$\('backup-label'\)\.textContent = t\('action\.backupUnknown'\);/, 'mountUi: nothing is known yet');
  assert.doesNotMatch(ui, /minutes: 5/, 'no hard-coded number');
  assert.match(ui, /const minutes = backupMinutes\(hw\);\s*\$\('backup-label'\)\.textContent = minutes === null \? t\('action\.backupUnknown'\) : t\('action\.backup', \{ minutes \}\);/, 'setHardware: from the flash size and the port');
  assert.match(read('app/progress.js'), /1 MB per minute through a UART bridge[\s\S]*8 MB per minute through the chip's own USB/, 'the assumption is written down');
  assert.doesNotMatch(en.action.backupUnknown, /\d/);
  assert.match(en.action.backup, /\{minutes\}/);
});

test('a phone gets a copy-the-link control and no empty hatches; a typo in ?fw= gets a way to the list', () => {
  assert.match(html, /<section class="gate" id="gate" hidden aria-live="polite">\s*<h1 id="gate-title"><\/h1>\s*<p id="gate-text"><\/p>\s*<button class="cta" id="copy-link" type="button" hidden data-i18n="action\.copyLink"><\/button>\s*<p class="note" id="gate-why" hidden data-i18n="gate\.copyWhy"><\/p>\s*<a class="cta" id="gate-link" hidden><\/a>\s*<\/section>/, 'a heading like every other screen, and the one way on is the button');
  const ui = read('app/ui.js');
  assert.match(ui, /\$\('gate-title'\)\.textContent = t\(kind === 'noSerial' \? 'gate\.titleNoSerial' : 'gate\.titleInsecure'\);/);
  assert.match(ui, /\$\('gate-why'\)\.hidden = false;/, 'and one line says what the copied link is for');
  assert.match(ui, /if \(kind === 'noSerial'\) \{[\s\S]*?\$\('tech'\)\.hidden = true;\s*\$\('log-details'\)\.hidden = true;\s*\$\('alt-wrap'\)\.open = false;\s*\$\('copy-link'\)\.hidden = false;/, 'no Details, no log, esptool folded away, the link first');
  assert.match(ui, /navigator\.share\(\{ url: location\.href/, 'a phone shares the link to itself');
  assert.match(ui, /navigator\.clipboard\.writeText\(location\.href\)/, 'a desktop without Web Serial copies it');
  assert.match(ui, /t\('action\.linkCopied'\)/);
  const main = read('app/main.js');
  assert.match(main, /if \(unknown\) \{[\s\S]*?link\.href = location\.pathname;[\s\S]*?link\.textContent = i18n\.t\('pick\.title'\)/, 'the sentence points at the list, and the link goes there');
  assert.match(main, /gate-title'\)\.textContent = i18n \? i18n\.t\(unknown \? 'gate\.titleUnknown' : 'gate\.titleError'\) : ''/, 'a boot failure names the screen too');
  assert.doesNotMatch(en.error['catalog.unknownSystem'], /published/, 'a typo in the address is not the publisher\'s fault');
  assert.match(en.error['catalog.unknownSystem'], /list of systems/);
});

test('beginner copy: the port picker names what the browser shows, the busy port does not lead with the Arduino IDE, and no hex reaches the first layer', () => {
  assert.match(en.simple.prepare.picker, /USB Serial, CP210x, CH9102 or just Unnamed device/);
  assert.match(en.simple.prepare.picker, /If the list is empty/);
  assert.match(en.error['serial.busy'], /^Another program is using this device\./);
  const pl = JSON.parse(read('locales/pl.json'));
  assert.match(pl.error['serial.busy'], /^Inny program korzysta z tego urządzenia\./);
  assert.match(pl.simple.prepare.picker, /USB Serial, CP210x, CH9102/);
  for (const [k, v] of Object.entries(en.error)) assert.doesNotMatch(v, /0x\{|\(id |\(\{schema\}\)/, k);
  for (const [k, v] of Object.entries(pl.error)) assert.doesNotMatch(v, /0x\{|\(kod |\(\{schema\}\)/, k);
  assert.match(read('app/engine.js'), /log\('ERROR ' \+ error\.code \+ paramText\(error\.params\)/, 'the offsets, ids and schema go to the technical log instead');
});

test('own-file path: the copy option is offered only once a file exists (setBackupAvailable runs before showOwn)', () => {
  const main = read('app/main.js');
  const a = main.indexOf("ui.setBackupAvailable(true); // the own-file path");
  const b = main.indexOf("ui.showOwn([...CHIP_FAMILIES]);");
  assert.ok(a > 0 && b > a, 'showOwn must run last, so its refresh decides what is visible');
  assert.match(main, /ui\.bindOwnRemove\(\(rowId\) => \{ picked\.delete\(rowId\); retitle\(\); \}\);/, 'a removed file leaves the tab title too');
  assert.match(read('app/ui.js'), /\$\('title'\)\.textContent = has \? t\('app\.title', \{ system: filled\.map\(\(r\) => r\.part\.name\)\.join\(', '\) \}\) : t\('simple\.own\.title'\);/, 'and the kicker follows the rows, not the last file added');
});

/* --- identity, footer and the de-slop round (2026-09-16) ------------------ */

test('an open hatch holds no card, and the "?" ring rides the line of text it belongs to', () => {
  const open = style.match(/\.hatches details\[open\] > \.facts, \.hatches details\[open\] > \.alt \{([^}]*)\}/);
  assert.ok(open, 'the rule that dresses an open hatch');
  assert.doesNotMatch(open[1], /background|border-radius/, 'a card in there is a third background and a second radius on one piece of text');
  assert.match(open[1], /padding:[^;]*\s0\s/, 'no side padding: the contents line up with the summary label');
  const hint = style.match(/\.hint \{([^}]*)\}/);
  assert.ok(hint, '.hint');
  assert.match(hint[1], /display:\s*inline-flex/);
  assert.match(hint[1], /vertical-align:\s*middle/);
  assert.doesNotMatch(hint[1], /flex:\s*none/, 'it is no longer a flex item pinned to the plate edge');
  assert.match(style, /\.line \{\s*display:\s*block/, 'the line is a block, so the heading stays inline and the ring follows the last word');
});

test('every secondary control wears one class, and none of them borrows the accent as a fill', () => {
  const btn = style.match(/\n\.btn \{([^}]*)\}/);
  assert.ok(btn, '.btn');
  for (const decl of [/min-height:\s*44px/, /border-radius:\s*var\(--radius-in\)/, /background:\s*var\(--bg-2\)/, /font:\s*600 var\(--t-small\) var\(--font-display\)/]) {
    assert.match(btn[1], decl, String(decl));
  }
  assert.match(style, /\.btn--ghost \{[^}]*color:\s*var\(--dim\)/);
  assert.match(style, /\.btn:disabled \{[^}]*cursor:\s*not-allowed/, 'a button that is merely off must not show a busy pointer');
  assert.doesNotMatch(style, /\.btn[^{]*\{[^}]*background:\s*var\(--accent\)/, 'the accent fills the one action and nothing else');
  // Nothing may still be reaching for the classes these replaced.
  for (const dead of ['.small', '.quiet-btn', '.warn-btn']) {
    assert.ok(!style.includes(dead + ' ') && !style.includes(dead + ','), dead + ' is gone from the stylesheet');
    assert.ok(!html.includes('"' + dead.slice(1) + '"'), dead + ' is gone from the markup');
  }
  assert.doesNotMatch(read('app/ui.js'), /className = '(small|quiet-btn|warn-btn)'/, 'and from the rows ui.js builds');
  // The file picker draws its own label, so that label has to be a button like the others.
  assert.match(html, /<label class="file" for="backup-file"><span class="btn" data-i18n="action\.chooseBackup">/);
  assert.match(read('app/ui.js'), /fileText\.className = 'btn';/);
});

test('the signet is drawn in fills on a 2px grid, and the favicon is the same drawing', () => {
  const icon = read('favicon.svg');
  // Every edge on an even coordinate, so half of each is still a whole pixel at 16px. The first
  // drawing put the lead on 13/19 and the state light on a radius of two: at 16px the lead greyed
  // out into half pixels and the light came out one pixel of accent in a corner.
  const body = /d="M16 6h10a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4ZM16 10h10v6H16Z"/;
  const plug = /d="M2 12h6v2h4v4H8v2H2Z"/;
  for (const [what, src] of [['the header sign', html], ['favicon.svg', icon]]) {
    assert.match(src, body, what + ': the body with the screen cut out of it');
    assert.match(src, plug, what + ': the plug and its lead');
    assert.match(src, /<rect[^>]*x="16" y="20" width="8" height="4" rx="2"/, what + ': the state light');
    // The lead and the light are the two pieces that fell apart at 16px. Every number in them is
    // even, so halving the grid still lands on whole pixels.
    const numbers = [...(/d="(M2[^"]*)"/.exec(src)?.[1] ?? '').matchAll(/\d+/g)].map((m) => Number(m[0]));
    assert.ok(numbers.length >= 8, what + ': the lead is drawn');
    assert.deepEqual(numbers.filter((n) => n % 2 !== 0), [], what + ': the lead sits on even units');
    for (const n of [16, 20, 8, 4, 2]) assert.equal(n % 2, 0);
  }
  // Fills, not strokes: a 1.5px line disappears at 16px, which is what the old sign did.
  assert.doesNotMatch(icon, /stroke/, 'no strokes in the favicon');
  // The tab strip has no theme, so the favicon may not borrow either theme's accent: #1A56C4
  // sits at 1.7:1 on a dark strip and #7FB2FF at 1.7:1 on a light one. One measured value that
  // clears both, and no media query, which some browsers cache past and others ignore.
  assert.match(icon, /^<svg[^>]*fill="#4E7FE4"/m, 'the favicon carries its own measured accent');
  const drawn = icon.replace(/<!--[\s\S]*?-->/g, ''); // the reasoning names both theme accents
  assert.doesNotMatch(drawn, /#1A56C4|#7FB2FF|prefers-color-scheme|<style/i);
  assert.match(icon, /<rect x="16" y="20"[^>]*fill="#FFFFFF"/, 'the state light is cut in white');
  assert.match(html, /fill-rule="evenodd"/, 'the screen is a hole in the body, not a second outline');
  assert.match(style, /\.signet \{[^}]*fill:\s*currentColor[^}]*stroke:\s*none/);
  assert.match(style, /\.signet-dot \{ fill: var\(--accent\); \}/, 'the one spot of accent');
  // The logotype: one word, two weights of the display face, and no second colour.
  assert.match(style, /\.word \{[^}]*font-weight:\s*400[^}]*letter-spacing:\s*-0\.02em/);
  assert.match(style, /\.word b \{ font-weight: 800; \}/);
  assert.doesNotMatch(style, /\.brand[^{]*\{[^}]*text-shadow|\.brand[^{]*\{[^}]*gradient/);
});

test('a row in the system list carries its release and its own address, and the newest one is not a third identical tile', () => {
  const ui = read('app/ui.js');
  // The highlight is a recommendation, so it may only land on a stable release. When the newest
  // entry is a pre-release no row is highlighted: the row under it is not the newest anything.
  assert.match(ui, /const stable = channel === 'stable';/);
  assert.match(ui, /if \(i === 0 && stable\) li\.classList\.add\('is-newest'\);/, "the tint goes to the newest entry only while it is stable");
  assert.match(ui, /if \(i === 0 && stable\) \{\s*const flag = document\.createElement\('span'\);\s*flag\.className = 'sys-newest';/, 'and so does the word');
  assert.match(ui, /const channel = \(release\?\.channel \?\? 'stable'\);/);
  assert.match(ui, /tag\.textContent = release\.version;/, 'the version is the version, with no channel suffix stuck to it');
  assert.doesNotMatch(ui, /`\$\{release\.version\} · \$\{channel\}`/, 'a two-letter suffix is not a warning');
  // A pre-release carries the install screen's own amber sentence, in the row, before the choice.
  assert.match(ui, /if \(!stable\) \{\s*const pre = document\.createElement\('span'\);\s*pre\.className = 'sys-pre';\s*pre\.textContent = t\('simple\.preRelease'\);/);
  assert.match(style, /\.pre-label, \.sys-pre \{[^}]*color: var\(--warn\)/, 'one tag, the same amber, in both places');
  assert.match(style, /\.sys-pre \{ grid-column: 1 \/ -1;/, 'on its own line in the row');
  assert.match(ui, /new URL\(a\.getAttribute\('href'\), document\.baseURI\)\.href/, 'the copied address is absolute and respects <base>');
  assert.match(ui, /copy\.textContent = t\('pick\.copied'\);\s*setTimeout\(\(\) => \{ copy\.textContent = t\('pick\.copy'\); \}, 2000\);/, 'it says so for two seconds, with no dialog');
  assert.match(ui, /copy\.setAttribute\('aria-live', 'polite'\)/);
  assert.doesNotMatch(ui, /showSystems[\s\S]{0,2000}?innerHTML/);
  assert.match(style, /\.sys\.is-newest \{[^}]*background:\s*var\(--accent-tint\)/, 'the same tint as a chosen door');
  assert.match(style, /\.sys-go::after \{[^}]*inset:\s*0/, 'the whole row is the link');
  assert.match(style, /\.sys-copy \{[^}]*position:\s*relative/, 'and the button sits above it');
  // The own-file card is the one dashed thing on the page: a dash there means "not a release".
  assert.equal((style.match(/border:\s*2px dashed/g) ?? []).length, 1);
  assert.match(style, /\.own-card \{[^}]*border: 2px dashed/);
  for (const k of ['newest', 'copy', 'copied']) assert.ok(en.pick[k], 'pick.' + k);
});

/* --- the design-QC round (2026-09-16): our controls, our lamps, our row ---- */

test('every control the visitor touches is drawn here, in one language and in both themes', () => {
  // The file picker was already ours. These two were not: a native checkbox is white in the light
  // theme and a muddy square in the dark one, and a native select brings the platform's own
  // chrome onto a panel that has its own.
  const box = style.match(/\.opt input \{([^}]*)\}/);
  assert.ok(box, '.opt input');
  assert.match(box[1], /appearance:\s*none/, 'the box is painted here');
  assert.match(box[1], /border:\s*2px solid var\(--line-2\)/);
  assert.match(box[1], /background:\s*var\(--bg-2\)/);
  assert.doesNotMatch(box[1], /accent-color/, 'accent-color only tints what the browser still draws');
  assert.match(style, /\.opt input:checked \{[^}]*background:\s*var\(--accent\)/);
  assert.match(style, /\.opt input::before \{[^}]*clip-path/, 'the tick is a shape, not a glyph from a font that may not load');
  assert.match(style, /\.opt \{[^}]*min-height:\s*44px/, 'the label is the target');
  assert.match(style, /\.field select \{[^}]*appearance:\s*none/);
  assert.match(style, /\.field:has\(select\)::after \{[^}]*border-right: 2px solid var\(--dim\);\s*border-bottom: 2px solid var\(--dim\);\s*transform: rotate\(45deg\)/, 'the same chevron the hatches use');
  assert.match(style, /\.field input, \.field select \{[^}]*min-height:\s*48px/);
  assert.match(style, /input:focus-visible, select:focus-visible/, 'and the list keeps a focus ring');
  // Never display:none on a real input: it has to stay focusable and stay a checkbox to a reader.
  assert.doesNotMatch(style, /\.opt input \{[^}]*display:\s*none/);
  assert.match(style, /\.file input \{[^}]*clip-path: inset\(50%\)/, 'the file input is clipped, not removed');
});

test('a row in the system list wears the action, and Copy link sits a level under it', () => {
  assert.match(style, /\.sys \{[^}]*grid-template-columns:\s*1fr auto auto auto/, 'name, release, copy, chevron');
  assert.match(style, /\.sys-arrow \{[^}]*border-right: 2\.5px solid var\(--ink\)/, 'the chevron is in the ink: it is the row action');
  const copy = style.match(/\n\.sys-copy \{([^}]*)\}/);
  assert.ok(copy, '.sys-copy');
  assert.match(copy[1], /color:\s*var\(--dim\)/);
  assert.match(copy[1], /text-transform:\s*uppercase/, 'panel lettering, not a second button');
  // Visible at rest on every device: the owner asked for shortcuts to the catalogued images by
  // name, and a shortcut that appears only under a pointer is not a shortcut. Quieter than the
  // row, never hidden by it.
  assert.match(copy[1], /opacity:\s*0\.7/, 'present but a level under the row');
  assert.doesNotMatch(copy[1], /opacity:\s*0;/, 'never hidden at rest');
  assert.match(style, /\.sys:hover \.sys-copy, \.sys-copy:hover, \.sys-copy:focus-visible \{ opacity: 1; \}/, 'pointer and keyboard bring it to full strength');
  assert.doesNotMatch(style, /@media \(hover: none\) \{ \.sys-copy/, 'no touch special case is needed once it is always out');
  assert.match(read('app/ui.js'), /arrow\.className = 'sys-arrow';\s*arrow\.setAttribute\('aria-hidden', 'true'\);/);
});

test('a status lamp is a lens, not a radio mark, and it is the same object in both themes', () => {
  const lamp = style.match(/\.lamp i \{([^}]*)\}/);
  assert.ok(lamp, '.lamp i');
  // A filled circle inside a ring of plate colour inside a second ring is exactly the mark a
  // chosen door wears one screen earlier, so two lit lamps read as two ticked options.
  assert.doesNotMatch(lamp[1], /0 0 0 2px var\(--bg-2\)/, 'no halo of plate colour: that is what made it a radio');
  assert.match(lamp[1], /border:\s*2px solid var\(--line\)/, 'a rim on the glass');
  assert.match(lamp[1], /box-shadow:\s*inset[^;]*rgb\(255 255 255[^;]*inset[^;]*rgb\(0 0 0/, 'light off the top of the lens, shade under it');
  const unplug = style.match(/#done-unplug::before \{([^}]*)\}/);
  assert.ok(unplug, '#done-unplug::before');
  for (const decl of [/width: 20px; height: 20px/, /border: 2px solid var\(--line\)/, /inset 0 3px 2px -2px rgb\(255 255 255 \/ 0\.7\)/]) {
    assert.match(unplug[1], decl, 'the released cable lamp is the same lens: ' + decl);
  }
  assert.doesNotMatch(unplug[1], /0 0 0 2px var\(--bg-2\)/);
});

test('the "?" ring keeps its size and gets a 44px target under it', () => {
  assert.match(style, /\.hint \{[^}]*position:\s*relative/);
  assert.match(style, /\.hint \{[^}]*width: 30px; height: 30px/, 'a 44px ring beside a sentence would be a second headline');
  assert.match(style, /\.hint::after \{[^}]*width: 44px; height: 44px[^}]*transform: translate\(-50%, -50%\)/);
});

test('nothing renders an empty box: the emptied note, the empty log, the table of dashes', () => {
  assert.match(style, /\.hint-text:empty \{ display: none; \}/, 'the own-file note is emptied in place, and must not leave its bar behind');
  assert.doesNotMatch(style, /\.facts dd:empty::before/, 'a row of dashes is not a row');
  assert.match(style, /\.facts-none \{/, 'and a table with no rows says so in a sentence');
  assert.match(html, /<p class="facts-none" id="fact-none" data-i18n="tech\.nothingYet"><\/p>/);
  const ui = read('app/ui.js');
  assert.match(ui, /export function refreshFacts\(\)/);
  assert.match(ui, /dd\.hidden = empty;\s*if \(dd\.previousElementSibling\) dd\.previousElementSibling\.hidden = empty;/, 'the label goes with its value');
  assert.match(ui, /\$\('fact-none'\)\.hidden = known > 0;/);
  assert.match(ui, /export function refreshAlt\(\)/);
  assert.match(ui, /\$\('alt-files-label'\)\.hidden = !hasFiles;/, 'a heading with no list under it does not render');
  assert.ok(en.tech.nothingYet && !/\{/.test(en.tech.nothingYet));
});
