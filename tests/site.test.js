/**
 * `site.json`: who is publishing this copy. Two things are being protected here.
 *
 * One, the red line. This installer is put on other people's servers. Nothing in `app/`, the
 * stylesheets, the dictionaries or `index.html` may name the site that publishes it, or a replica
 * would quietly advertise someone else's network. Everything of that kind lives in `site.json`,
 * which belongs to the deployment.
 *
 * Two, that a footer can never take the page down with it. A missing file, a broken one, a link
 * this page will not follow — each of those has to end in the one-line footer from index.html and
 * an installer that still installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { normalizeSite, renderFooter, mountFooter, siteFiles, VERSION, PROJECT_URL } from '../app/site.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

/* --- the red line --------------------------------------------------------- */

// Addresses the demo deployment happens to use. None may appear in the files below: a replica
// that carried one would quietly advertise a site its own visitors never chose.
const OURS = /esp32ai\.me|emini\.ink|404\.tf/i;

test('the product names no site of the workshop that publishes it', () => {
  const files = ['index.html', 'style.css', 'theme.css', 'theme-init.js', 'site.json']
    .concat(readdirSync(new URL('../app/', import.meta.url)).map((f) => 'app/' + f))
    .concat(readdirSync(new URL('../locales/', import.meta.url)).map((f) => 'locales/' + f));
  const hits = files.filter((f) => OURS.test(read(f)));
  assert.deepEqual(hits, [], 'these belong in the deployment\'s own site.json, not in the product');
});

test('positive control: the grep would catch one', () => {
  assert.ok(OURS.test('<a href="https://esp32ai.me/">'));
  assert.ok(OURS.test('emini.ink'));
});

test('the shipped site.json is a valid one, and its links are all ones the page would follow', () => {
  const site = normalizeSite(JSON.parse(read('site.json')));
  assert.ok(site, 'the file the product ships renders');
  assert.ok(site.columns.length >= 2);
  const all = [...site.columns.flatMap((c) => c.links), ...site.bottom];
  assert.ok(all.length >= 4);
  for (const l of all) assert.match(l.href, /^https:/, l.text + ' survived safeHref');
  for (const c of site.columns) assert.ok(c.title, 'every column is titled');
});

/* --- the contract --------------------------------------------------------- */

test('a missing, empty or malformed file is not a site', () => {
  for (const raw of [null, undefined, '', 0, [], 'nope', {}, { columns: [] }, { columns: 'x', bottom: 7 }]) {
    assert.equal(normalizeSite(raw), null, JSON.stringify(raw) ?? String(raw));
  }
  assert.equal(normalizeSite({ columns: [{ title: 'Empty', links: [] }] }), null, 'a column with nothing in it is not a footer');
});

test('every href goes through safeHref, and a rejected one costs the link but not the line', () => {
  const site = normalizeSite({
    columns: [{
      title: 'Mixed',
      links: [
        { text: 'https link', href: 'https://example.com/a' },
        { text: 'own path', href: 'docs/replicate.md' },
        { text: 'script', href: 'javascript:alert(1)' },
        { text: 'data', href: 'data:text/html,<script>' },
        { text: 'downgrade', href: 'http://example.com/a' },
        { text: 'another host', href: '//evil.example/a' },
        { text: 'backslashes', href: '\\\\evil.example/a' },
        { text: 'no href at all' },
      ],
    }],
  });
  assert.deepEqual(site.columns[0].links.map((l) => [l.text, l.href]), [
    ['https link', 'https://example.com/a'],
    ['own path', 'docs/replicate.md'],
    ['script', ''],
    ['data', ''],
    ['downgrade', ''],
    ['another host', ''],
    ['backslashes', ''],
    ['no href at all', ''],
  ]);
});

test('an entry with no words is dropped; whitespace is not a name', () => {
  const site = normalizeSite({ brand: '  Acme  ', bottom: [{ text: '   ', href: 'https://a.example' }, { text: 'MIT' }] });
  assert.equal(site.brand, 'Acme');
  assert.deepEqual(site.bottom.map((l) => l.text), ['MIT']);
});

test('brand or tagline alone is enough to draw a footer', () => {
  assert.ok(normalizeSite({ brand: 'Acme' }));
  assert.ok(normalizeSite({ tagline: 'Firmware for the Acme 9000.' }));
});

/* --- what reaches the DOM -------------------------------------------------- */

/** The smallest stand-in for a document that renderFooter needs; no browser and no jsdom here. */
function fakeDoc() {
  const make = (tag) => {
    const node = {
      tagName: tag.toUpperCase(), children: [], attrs: {}, className: '', _text: '',
      classList: { add(c) { node.className = (node.className + ' ' + c).trim(); } },
      set textContent(v) { node._text = v; },
      get textContent() { return node._text + node.children.map((c) => c.textContent).join(''); },
      get firstChild() { return node.children[0] ?? null; },
      removeChild(c) { node.children.splice(node.children.indexOf(c), 1); },
      append(...kids) { node.children.push(...kids); },
      cloneNode() { const copy = make(tag); copy.className = node.className; copy._text = node._text; return copy; },
      set href(v) { node.attrs.href = v; },
      set rel(v) { node.attrs.rel = v; },
    };
    return node;
  };
  const brand = { '.brand .signet': make('svg'), '.brand .word': make('span') };
  brand['.brand .word'].textContent = 'esp32install';
  return {
    createElement: make,
    querySelector: (sel) => brand[sel] ?? null,
    baseURI: 'https://example.com/install/',
    documentElement: { lang: 'en' },
  };
}

const walk = (node, out = []) => { out.push(node); for (const c of node.children) walk(c, out); return out; };

test('renderFooter replaces the one-line footer, builds nodes and never markup, and carries the version', () => {
  const doc = fakeDoc();
  global.document = doc; // renderFooter creates its <li> through the global, as ui.js does
  const foot = doc.createElement('footer');
  foot.append(doc.createElement('a'));
  renderFooter(foot, normalizeSite({
    brand: 'Acme', tagline: 'Firmware for the Acme 9000.',
    columns: [{ title: 'Devices', links: [{ text: 'Acme 9000', href: 'https://acme.example/9000' }] }],
    bottom: [{ text: 'MIT', href: 'https://acme.example/licence' }],
  }), doc);
  const nodes = walk(foot);
  assert.match(foot.className, /is-site/);
  assert.equal(foot.children.length, 4, 'brand, tagline, columns, end row');
  assert.ok(nodes.some((n) => n.className === 'foot-brand' && n.textContent === 'Acme'));
  assert.ok(nodes.some((n) => n.tagName === 'H2' && n.textContent === 'Devices'));
  assert.ok(nodes.some((n) => n.attrs.href === 'https://acme.example/9000' && n.attrs.rel === 'noopener'));
  assert.ok(nodes.some((n) => n.className === 'foot-version' && n.textContent === VERSION));
  delete global.document;
});

test('a link the page will not follow is drawn as words, with no href to click', () => {
  const doc = fakeDoc();
  global.document = doc;
  const foot = doc.createElement('footer');
  renderFooter(foot, normalizeSite({ bottom: [{ text: 'Somewhere', href: 'javascript:alert(1)' }] }), doc);
  const nodes = walk(foot);
  const shown = nodes.filter((n) => n.textContent === 'Somewhere').pop(); // the innermost, past the list around it
  assert.ok(shown, 'the words are still there');
  assert.equal(shown.tagName, 'SPAN', 'but not as a link');
  assert.equal(shown.attrs.href, undefined);
  delete global.document;
});

test('the version the footer prints is the version in package.json', () => {
  assert.equal(VERSION, JSON.parse(read('package.json')).version);
});

test('main.js loads it through its own JSON reader and never lets it stop the page', () => {
  const main = read('app/main.js');
  assert.match(main, /import \{ mountFooter \} from '\.\/site\.js';/);
  assert.match(main, /mountFooter\(loadJson, document, lang\)\.catch\(\(\) => \{\}\);/, 'a footer that fails to load is not an error');
  assert.match(read('app/site.js'), /new URL\(name, doc\.baseURI\)/, 'same origin, and under <base> on a copy that has one');
  assert.match(read('app/site.js'), /import \{ safeHref \} from '\.\/catalog\.js';/);
  assert.doesNotMatch(read('app/site.js'), /innerHTML|insertAdjacentHTML/);
});

test('index.html keeps the one line the page falls back to', () => {
  assert.match(read('index.html'), /<footer class="foot">.*<\/footer>/);
});

/* --- the mark, and the one line that removes it ---------------------------- */

test('the mark in the footer is a link to the project, whatever site.json says', () => {
  const doc = fakeDoc();
  global.document = doc;
  for (const raw of [{ brand: 'Acme' }, { bottom: [{ text: 'MIT', href: 'https://acme.example/l' }] }]) {
    const foot = doc.createElement('footer');
    renderFooter(foot, normalizeSite(raw), doc);
    const linked = walk(foot).filter((n) => n.attrs.href === PROJECT_URL);
    assert.equal(linked.length, 1, JSON.stringify(raw) + ': exactly one mark, and it is followable');
    assert.equal(linked[0].tagName, 'A');
    assert.match(linked[0].className, /\bfoot-mark\b/);
    assert.match(linked[0].className, /\bbrand\b/, 'brand is what takes the underline off, and it is already in the stylesheet');
    assert.equal(linked[0].attrs.rel, 'noopener');
    assert.equal(linked[0].textContent, 'esp32install', 'the header signet and word, cloned');
  }
  delete global.document;
});

test('the link is one line, named in the docs, and it points at the project and nowhere else', () => {
  const src = read('app/site.js');
  const lines = src.split('\n').filter((l) => l.includes('PROJECT_URL') && !l.trim().startsWith('*'));
  assert.equal(lines.length, 2, 'the constant and the one assignment; nothing else uses it');
  assert.match(src, /row\.href = PROJECT_URL; \/\/ ← delete this line/, 'the line says so itself');
  assert.match(PROJECT_URL, /^https:\/\/github\.com\/[\w.-]+\/esp32install$/, 'the project, not a site of ours');
  assert.ok(!OURS.test(PROJECT_URL), 'a repository is not a deployment');
  assert.match(read('docs/replicate.md'), /row\.href = PROJECT_URL/, 'and the reader is told where to find it');
});

test('the stylesheet already has both classes the mark wears, and neither underlines it', () => {
  const style = read('style.css');
  assert.match(style, /\.brand \{[^}]*text-decoration: none;/s, 'brand is why the mark has no underline');
  assert.match(style, /\.foot-mark \{/);
  // The footer rules come after the header ones, so the small sizes win without !important.
  assert.ok(style.indexOf('.foot-mark .signet') > style.indexOf('.brand .signet'), 'the small signet wins on order');
  assert.ok(style.indexOf('.foot-mark .word') > style.indexOf('.brand .word'), 'the small word wins on order');
});

test('index.html falls back to the same link, so the mark is followable with no site.json at all', () => {
  assert.match(read('index.html'), new RegExp('<footer class="foot">.*href="' + PROJECT_URL + '"'));
});

/* --- one footer per language ---------------------------------------------- */

test('siteFiles asks for the language first and always ends at site.json', () => {
  assert.deepEqual(siteFiles('pl'), ['site.pl.json', 'site.json']);
  assert.deepEqual(siteFiles('EN'), ['site.en.json', 'site.json'], 'the code is lower-cased');
  assert.deepEqual(siteFiles('pt-br'), ['site.pt-br.json', 'site.json']);
  for (const junk of ['', null, undefined, '../evil', 'p', 'toolongalanguage', 'pl/../x', 'a b']) {
    assert.deepEqual(siteFiles(junk), ['site.json'], JSON.stringify(junk) + ' names no file of its own');
  }
});

/** A `load` that answers for the names listed and throws a 404 for anything else, recording both. */
const fakeLoad = (files) => {
  const asked = [];
  return [asked, async (url) => {
    const name = url.split('/').pop();
    asked.push(name);
    if (!(name in files)) throw new Error('404 ' + name);
    return files[name];
  }];
};

test('mountFooter draws the language file when it is there', async () => {
  const doc = fakeDoc();
  global.document = doc;
  const foot = doc.createElement('footer');
  doc.querySelector = (sel) => (sel === 'footer.foot' ? foot : null);
  const [asked, load] = fakeLoad({ 'site.pl.json': { brand: 'Akme' }, 'site.json': { brand: 'Acme' } });
  assert.equal(await mountFooter(load, doc, 'pl'), true);
  assert.deepEqual(asked, ['site.pl.json'], 'the fallback is not even fetched');
  assert.ok(walk(foot).some((n) => n.textContent === 'Akme'));
  delete global.document;
});

test('mountFooter falls back to site.json, and an empty language file does not win', async () => {
  for (const files of [{ 'site.json': { brand: 'Acme' } }, { 'site.pl.json': {}, 'site.json': { brand: 'Acme' } }]) {
    const doc = fakeDoc();
    global.document = doc;
    const foot = doc.createElement('footer');
    doc.querySelector = (sel) => (sel === 'footer.foot' ? foot : null);
    const [asked, load] = fakeLoad(files);
    assert.equal(await mountFooter(load, doc, 'pl'), true, JSON.stringify(files));
    assert.deepEqual(asked, ['site.pl.json', 'site.json']);
    assert.ok(walk(foot).some((n) => n.textContent === 'Acme'));
    delete global.document;
  }
});

test('with neither file the one-line footer stays and nothing is thrown', async () => {
  const doc = fakeDoc();
  global.document = doc;
  const foot = doc.createElement('footer');
  const was = doc.createElement('a');
  foot.append(was);
  doc.querySelector = (sel) => (sel === 'footer.foot' ? foot : null);
  const [asked, load] = fakeLoad({});
  assert.equal(await mountFooter(load, doc, 'pl'), false);
  assert.deepEqual(asked, ['site.pl.json', 'site.json']);
  assert.deepEqual(foot.children, [was], 'untouched');
  delete global.document;
});

test('a page with no footer element asks for nothing at all', async () => {
  const doc = fakeDoc();
  doc.querySelector = () => null;
  const [asked, load] = fakeLoad({ 'site.json': { brand: 'Acme' } });
  assert.equal(await mountFooter(load, doc, 'pl'), false);
  assert.deepEqual(asked, []);
});
