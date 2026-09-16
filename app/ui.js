/**
 * DOM layer of the installer. No installation logic lives here: `main.js` feeds it engine
 * events and it moves between the three screens (prepare, install, done). Everything a
 * beginner sees on the first layer comes from `simple.*`, `door.*`, `stage.*`, `result.*`
 * and `action.*`; chip names, sizes and checksums only ever land inside <details>.
 */
import { InstallError } from './errors.js';
import { createLineBuffer } from './console.js';
import { MAX_PARTS } from './own.js';
import { backupMinutes } from './progress.js';
import { safeHref } from './catalog.js';

const $ = (id) => document.getElementById(id);
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
const RING = 339.292; // 2 * PI * r for r = 54, matches style.css

/** Last path segment of a URL or path, without query or credentials. Never shows `part.path` raw. */
export function fileNameOf(urlOrPath) {
  const s = String(urlOrPath ?? '');
  try {
    return decodeURIComponent(new URL(s, 'https://x.invalid/').pathname.split('/').pop() || s);
  } catch {
    return s.split(/[?#]/)[0].split('/').pop() || s;
  }
}

/** Error params that carry a path are reduced to a file name before they reach a sentence. */
function safeParams(params = {}) {
  const out = { ...params };
  if (typeof out.path === 'string') out.path = fileNameOf(out.path);
  if (typeof out.url === 'string') out.url = fileNameOf(out.url);
  return out;
}

const MEASURED = new Set(['backup', 'writing', 'done']);
const ADDRESS = /^0x[0-9a-f]{1,8}$/i;

/** `0x` hex, sector-aligned, or null. Anything else is shown as a bad address, never guessed. */
export function parseAddress(text) {
  const v = String(text ?? '').trim();
  if (!ADDRESS.test(v)) return null;
  const n = parseInt(v, 16);
  return Number.isSafeInteger(n) && n % 0x1000 === 0 ? n : null;
}

/** Rounded size for the first layer; the exact byte count goes into the technical layer. */
export function formatSize(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Hides the three technical hatches; used when there is no system to describe (list, boot failure). */
export function hideHatches() {
  for (const id of ['tech', 'log-details', 'alt-wrap']) $(id).hidden = true;
}

/**
 * The fact table, and its own emptiness. A row whose value is not known yet is not a row — five
 * dashes under a heading say "something should be here" and nothing else — so it goes, and when
 * nothing at all is known the table says that in one sentence instead.
 */
export function refreshFacts() {
  let known = 0;
  for (const dd of document.querySelectorAll('#tech .facts dd')) {
    const empty = dd.textContent.trim() === '';
    dd.hidden = empty;
    if (dd.previousElementSibling) dd.previousElementSibling.hidden = empty;
    if (!empty) known += 1;
  }
  $('fact-none').hidden = known > 0;
}

/** The same rule in the esptool hatch: a command with nothing in it, and a heading with no list
 *  under it, do not render. The drivers are always there, so the hatch itself always has content. */
export function refreshAlt() {
  const hasCmd = $('alt-cmd').textContent.trim() !== '';
  $('alt-cmd-label').hidden = !hasCmd;
  $('alt-cmd').hidden = !hasCmd;
  const hasFiles = $('alt-files').childElementCount > 0;
  $('alt-files-label').hidden = !hasFiles;
  $('alt-files').hidden = !hasFiles;
}

/** Fills `data-i18n` text and `data-i18n-attr` attributes under `root`. */
export function translateDom(t, vars, root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n, vars);
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    const [attr, key] = el.dataset.i18nAttr.split(':');
    el.setAttribute(attr, t(key, vars));
  }
}

/**
 * What the catalogued voice says that is untrue on the own-file path: there is no release here
 * and nobody published it. The person chose the file or typed the address themselves.
 */
export const CATALOGUE_VOICE = /release|publish|wydan|opublikow/i;

/** The problems the page already names in its own voice before the device is even opened. */
const OWN_PROBLEM_KEY = {
  'verify.overlap': 'simple.own.overlap',
  'verify.wrongChip': 'simple.own.wrongDevice',
  'verify.notAnImage': 'simple.own.notAnImage',
  'verify.beyondFlash': 'simple.own.tooFar',
  'verify.totalTooLarge': 'simple.own.tooMuch',
  'verify.chipUnknown': 'simple.own.deviceUnknown',
};

/**
 * One sentence for a stop on the own-file path, in that path's own voice.
 *
 * The rule, not a list of codes, is what keeps the catalogue's voice out: whatever the engine or
 * a check raises — now or after the next change to either — the wording is chosen by where the
 * page is, and a sentence that blames a release nobody published can never be reached from here.
 *
 *   1. the sentence written for this stop after a device was connected, if there is one;
 *   2. otherwise the sentence the page already uses for the same problem before connecting;
 *   3. otherwise the catalogued sentence — but only while it says nothing about a release,
 *      because a pulled cable or a locked device reads the same on both paths and its own words
 *      help more than a vague one;
 *   4. otherwise the own-file sentence that says what is true: these files, this device.
 */
export function ownErrorText(t, code, params = {}) {
  const own = 'simple.own.stopped.' + code;
  const written = t(own, params);
  if (written !== own) return written; // t() answers with the key when nothing is written for it
  const before = OWN_PROBLEM_KEY[code];
  if (before) return t(before, params);
  const catalogued = t('error.' + code, params);
  return CATALOGUE_VOICE.test(catalogued) ? t('simple.own.problem') : catalogued;
}

export function mountUi({ i18n, system }) {
  const t = i18n.t;
  const vars = { system };
  translateDom(t, vars);
  $('connect-label').textContent = t('action.connect');
  $('backup-label').textContent = t('action.backupUnknown'); // no device read yet: words, not a number
  $('door-update-hint').textContent = t('door.updateHint', vars);
  $('lamp-device-text').textContent = t('app.notDetected');
  $('done-again').textContent = t('simple.done.again');
  $('done-again').href = location.href;

  // "?" hints: open the text underneath, Esc closes every open one.
  for (const btn of document.querySelectorAll('button.hint')) {
    const text = $(btn.getAttribute('aria-controls'));
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(open));
      btn.setAttribute('aria-label', t(open ? 'hint.close' : 'hint.open'));
      text.hidden = !open;
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const btn of document.querySelectorAll('button.hint[aria-expanded="true"]')) {
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', t('hint.open'));
      $(btn.getAttribute('aria-controls')).hidden = true;
    }
  });

  refreshFacts();
  refreshAlt();
  $('copy-log').disabled = true; // there is nothing to copy until the first line arrives
  $('log-details').addEventListener('toggle', (e) => {
    $('log-summary').textContent = t(e.target.open ? 'app.hideLog' : 'app.showLog');
  });
  $('copy-log').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('log').textContent); } catch { /* clipboard may be blocked */ }
  });
  // The link for a computer: a phone shares it to itself (mail, notes, a chat), anything else copies it.
  $('copy-link').addEventListener('click', async () => {
    try {
      if (navigator.share) { await navigator.share({ url: location.href, title: document.title }); return; }
      await navigator.clipboard.writeText(location.href);
      $('copy-link').textContent = t('action.linkCopied');
    } catch { /* the person closed the share sheet, or the clipboard is blocked */ }
  });

  const screens = ['prepare', 'install', 'done'];
  const showScreen = (name) => {
    for (const s of screens) {
      const el = $('screen-' + s);
      el.hidden = s !== name;
      el.classList.toggle('is-active', s === name);
    }
  };
  const setRing = (percent, busy) => {
    const p = Math.max(0, Math.min(100, Math.round(percent ?? 0)));
    const ring = $('ring');
    ring.setAttribute('aria-valuenow', String(p));
    ring.classList.toggle('is-busy', Boolean(busy));
    ring.classList.toggle('is-done', p >= 100);
    $('ring-arc').style.setProperty('--off', String(RING * (1 - p / 100)));
  };
  const setLamp = (id, state, text) => {
    const li = $(id);
    li.classList.remove('is-on', 'is-off', 'is-done');
    li.classList.add(state);
    if (text !== undefined) $(id + '-text').textContent = text;
  };

  // The technical log: installer lines and, when the console runs, the device's own lines, capped.
  const logLines = createLineBuffer();
  const showLog = () => {
    const pre = $('log');
    const text = logLines.text();
    pre.textContent = text;
    pre.scrollTop = pre.scrollHeight;
    // A hatch called "technical log" that opens on an empty box, over a button that copies
    // nothing, is a promise the page cannot keep. Both wait for the first line.
    $('log-details').hidden = text === '';
    $('copy-log').disabled = text === '';
  };

  /** The device's own address after Wi-Fi setup, as a link; nothing is shown when it gave none. */
  const setWifiNext = (url) => {
    const a = $('wifi-next');
    a.hidden = !url;
    if (url) { a.href = url; a.textContent = t('simple.wifi.open'); }
  };

  // The own-file path: up to MAX_PARTS rows, one file each, with the address the file suggests.
  // Rows are built here; the bytes never enter this module. main.js keeps them and answers with what
  // each file says about itself (setOwnPart) and whether the set fits together (the bindOwnChange
  // callback returns the problem, or null).
  const ownRows = []; // { id, li, title, fileText, file, address, info, remove, part, kindText }
  let ownSeq = 0, onOwnFile = null, onOwnRemove = null, onOwnChange = null, ownProblem = null;
  // Set once, when the own-file path is shown, and read by the stopped screen: which path the
  // page is on is what decides the wording there, not which code happened to arrive.
  let ownPath = false;
  const ownFilled = () => ownRows.filter((r) => r.part);
  const ownChipFamily = () => $('own-chip').value || null;
  /** Every file with a valid address and one chosen device, or null while anything is missing. */
  const ownChoice = () => {
    const filled = ownFilled();
    const chipFamily = ownChipFamily();
    if (filled.length === 0 || !chipFamily) return null;
    const parts = [];
    for (const r of filled) {
      const offset = parseAddress(r.address.value);
      if (offset === null) return null;
      parts.push({ id: r.id, name: r.part.name, offset });
    }
    return { chipFamily, parts };
  };
  // Before the device is opened. The same problem after it has been opened reads differently —
  // the memory of a real chip is known by then — so the stopped screen has its own sentences and
  // its own rule (`ownErrorText`); this is the pre-flight half M1 closed.
  const ownProblemText = (e) => {
    const key = OWN_PROBLEM_KEY[e?.code];
    return key ? t(key, safeParams(e?.params)) : t('simple.own.problem');
  };
  /**
   * Why the button is off, as one sentence, or '' when it may turn on. A bad address is named
   * here without hex: the example of what to type belongs beside the field it is about, not as
   * the headline above the main button.
   */
  const ownWhy = () => {
    const filled = ownFilled();
    if (filled.length === 0) return t('simple.own.needFile');
    if (filled.some((r) => parseAddress(r.address.value) === null)) return t('simple.own.needAddress');
    if (!ownChipFamily()) return t('simple.own.unknownDevice');
    if (ownProblem) return ownProblemText(ownProblem);
    return '';
  };
  const ownReady = () => $('own').hidden || ownWhy() === '';
  const refreshOwn = () => {
    if ($('own').hidden) return;
    const filled = ownFilled();
    const has = filled.length > 0;
    // Nothing to decide about until there is a file: the two doors, the copy and the details wait.
    for (const id of ['own-read', 'door-line', 'doors', 'backup-opt']) $(id).hidden = !has;
    if (!has) $('hint-door').hidden = true;
    $('own-add').hidden = !has;
    $('own-add').disabled = ownRows.length >= MAX_PARTS;
    $('own-url-go').disabled = ownRows.every((r) => r.part) && ownRows.length >= MAX_PARTS;
    ownRows.forEach((r, i) => {
      r.title.textContent = t('simple.own.part', { n: i + 1 });
      r.title.hidden = ownRows.length === 1;
      r.remove.hidden = ownRows.length === 1 && !r.part; // the only empty row stays
      // What the file looks like, and — while its address cannot be read — the example of what
      // to type, next to the box it is about.
      if (r.part) {
        const bad = parseAddress(r.address.value) === null;
        r.info.textContent = bad ? `${r.kindText} ${t('simple.own.badAddress')}`.trim() : r.kindText;
      }
    });
    $('title').textContent = has ? t('app.title', { system: filled.map((r) => r.part.name).join(', ') }) : t('simple.own.title');
    const chipFamily = ownChipFamily();
    $('fact-board').textContent = chipFamily ?? '';
    $('fact-release').textContent = filled.map((r) => `${r.part.name}, ${r.part.size} bytes` + (parseAddress(r.address.value) === null ? '' : `, at 0x${parseAddress(r.address.value).toString(16)}`)).join('; ');
    $('fact-checksum').textContent = filled.map((r) => r.part.sha256).join(', ');
    refreshFacts();
    const choice = ownChoice();
    ownProblem = choice ? (onOwnChange?.(choice) ?? null) : null;
    const why = ownWhy();
    // Two live regions must not say the same thing: the note carries the plan, the line above the
    // button carries the reason it is off. Exactly one of them speaks at a time.
    $('own-note').textContent = why ? '' : (choice.parts.length === 1
      ? t('simple.own.plan', { name: choice.parts[0].name, address: '0x' + choice.parts[0].offset.toString(16), device: chipFamily })
      : t('simple.own.planMany', { device: chipFamily }));
    $('connect').disabled = why !== '';
    $('connect-why').textContent = why;
    $('connect-why').hidden = why === '';
  };
  /** One row: a file picker, the address, what the file looks like, and a way to drop it. */
  const addOwnRow = () => {
    if (ownRows.length >= MAX_PARTS) return null;
    const id = ++ownSeq;
    const li = document.createElement('li');
    li.className = 'own-part';
    const title = document.createElement('b');
    title.className = 'own-part-title';
    const fileLabel = document.createElement('label');
    fileLabel.className = 'file';
    fileLabel.htmlFor = `own-file-${id}`;
    const fileText = document.createElement('span');
    fileText.className = 'btn';
    fileText.textContent = t('simple.own.choose');
    const file = document.createElement('input');
    file.type = 'file';
    file.id = `own-file-${id}`;
    file.accept = '.bin,application/octet-stream';
    fileLabel.append(fileText, file);
    const fields = document.createElement('div');
    fields.className = 'fields';
    const addrLabel = document.createElement('label');
    addrLabel.className = 'field';
    addrLabel.htmlFor = `own-address-${id}`;
    const addrText = document.createElement('span');
    addrText.textContent = t('simple.own.address');
    const address = document.createElement('input');
    address.type = 'text';
    address.id = `own-address-${id}`;
    address.spellcheck = false;
    address.autocomplete = 'off';
    address.setAttribute('autocapitalize', 'off');
    addrLabel.append(addrText, address);
    const info = document.createElement('p');
    info.className = 'own-hint';
    fields.append(addrLabel, info);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn--ghost';
    remove.textContent = t('simple.own.remove');
    li.append(title, fileLabel, fields, remove);
    const row = { id, li, title, fileText, file, address, info, remove, part: null, kindText: '' };
    file.addEventListener('change', () => { const f = file.files?.[0]; if (f) onOwnFile?.(id, f); });
    address.addEventListener('input', refreshOwn);
    remove.addEventListener('click', () => {
      ownRows.splice(ownRows.indexOf(row), 1);
      li.remove();
      onOwnRemove?.(id);
      if (ownRows.length === 0) addOwnRow();
      refreshOwn();
    });
    ownRows.push(row);
    $('own-parts').append(li);
    return row;
  };
  $('own-add').addEventListener('click', () => { addOwnRow(); refreshOwn(); });
  $('own-chip').addEventListener('change', refreshOwn);

  const ui = {
    showScreen,
    hideHatches,
    /**
     * The two gates. Without a secure context the person is on a computer and the esptool route is
     * the next thing to read, so it opens. Without Web Serial they are most likely on a phone: the
     * empty Details and log hatches go, the terminal command folds away, and one button offers the
     * link for a computer instead.
     */
    showGate(kind) {
      $('gate').hidden = false;
      // A screen a beginner lands on because something already went wrong needs a heading like
      // every other screen; without one the first thing they read is the bad news, in body text.
      $('gate-title').textContent = t(kind === 'noSerial' ? 'gate.titleNoSerial' : 'gate.titleInsecure');
      $('gate-text').textContent = t('gate.' + kind);
      for (const s of screens) { $('screen-' + s).hidden = true; $('screen-' + s).classList.remove('is-active'); }
      if (kind === 'noSerial') {
        $('tech').hidden = true;
        $('log-details').hidden = true;
        $('alt-wrap').open = false;
        $('copy-link').hidden = false;
        // "Copy the link for a computer" out of context is a button for nothing. One line says
        // what the copy is for, in the same place the picker note sits under the main button.
        $('gate-why').hidden = false;
      } else {
        $('alt-wrap').open = true;
      }
    },
    showInstaller({ title, release, preRelease = false }) {
      $('title').textContent = title;
      $('pre-label').textContent = preRelease ? t('simple.preRelease') : '';
      $('pre-label').hidden = !preRelease;
      $('fact-release').textContent = release;
      refreshFacts();
      showScreen('prepare');
    },
    /**
     * A preserve release starts with a mandatory copy of the device, and its first door is for a
     * device with nothing set up yet, not for one running something else. Both are said on screen 1.
     */
    setPreserve(on) {
      $('backup-first').hidden = !on;
      $('door-first-hint').textContent = t(on ? 'door.firstHintNew' : 'door.firstHint');
    },
    /**
     * The list of systems. A row is not a card of a name: it carries the device, the version it
     * would install and, when that release is not the stable one, a plain sentence saying so.
     * The tint and the word NEWEST belong to the newest release only while that release is
     * stable: highlighting a test build is a recommendation, and the strongest thing on the
     * screen may not recommend a pre-release to somebody afraid of breaking their device. A
     * catalogue whose newest entry is a pre-release therefore has no highlighted row at all —
     * that is the answer, not a fallback, because the row below it is not the newest anything.
     *
     * Each row also offers its own address, because the answer to "I want a link straight to this
     * one on my page" is a link the owner of that page can copy, not a second catalog.
     */
    showSystems(systems, hrefFor, ownHref) {
      $('pick').hidden = false;
      hideHatches(); // nothing to show without a system
      $('own-entry').href = ownHref;
      clear($('pick-list'));
      systems.forEach((s, i) => {
        const release = Array.isArray(s.releases) ? s.releases[0] : null;
        const channel = (release?.channel ?? 'stable');
        const stable = channel === 'stable';
        const li = document.createElement('li');
        li.className = 'sys';
        if (i === 0 && stable) li.classList.add('is-newest');
        const a = document.createElement('a');
        a.className = 'sys-go';
        a.href = hrefFor(s);
        const name = document.createElement('b');
        name.textContent = s.name;
        const small = document.createElement('small');
        small.textContent = s.device ?? '';
        a.append(name, small);
        const meta = document.createElement('p');
        meta.className = 'sys-meta';
        if (i === 0 && stable) {
          const flag = document.createElement('span');
          flag.className = 'sys-newest';
          flag.textContent = t('pick.newest');
          meta.append(flag);
        }
        if (release?.version) {
          const tag = document.createElement('span');
          tag.className = 'sys-version';
          tag.textContent = release.version;
          meta.append(tag);
        }
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'btn btn--ghost sys-copy';
        copy.textContent = t('pick.copy');
        copy.setAttribute('aria-live', 'polite'); // the word changes in place, so it is spoken in place
        // The address as a visitor would paste it elsewhere: absolute, and resolved against <base>
        // so a copy served under /pl/ hands out its own address and not the English one.
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(new URL(a.getAttribute('href'), document.baseURI).href);
            copy.textContent = t('pick.copied');
            setTimeout(() => { copy.textContent = t('pick.copy'); }, 2000);
          } catch { /* the clipboard is blocked; the address is in the row's own link anyway */ }
        });
        // The chevron is the row's own affordance. Without it the only thing on the row shaped
        // like a control was Copy link — which is for whoever runs a page of their own — so a
        // first visitor's first click landed there and got a silent "Copied".
        const arrow = document.createElement('span');
        arrow.className = 'sys-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        li.append(a, meta, copy, arrow);
        // What `· rc` used to mean, said in the same amber words the install screen uses — and
        // said before the choice instead of two screens after it. Its own line in the row: a
        // warning that has to share a line with a version number is an afterthought.
        if (!stable) {
          const pre = document.createElement('span');
          pre.className = 'sys-pre';
          pre.textContent = t('simple.preRelease');
          li.append(pre);
        }
        $('pick-list').append(li);
      });
    },
    /** Catalogued install: the quiet way out to the own-file path. */
    setOwnLink(href) { $('own-instead').href = href; $('own-instead').hidden = false; },
    /**
     * The own-file path on the prepare screen. `chips` fills the device list; one empty row waits
     * for the first file, and the button stays off until every row has a valid address, a device
     * is chosen and the files fit together.
     */
    showOwn(chips) {
      ownPath = true;
      $('title').textContent = t('simple.own.title');
      $('door-update-hint').textContent = t('door.updateHintOwn');
      $('fact-release-label').textContent = t('tech.file');
      const sel = $('own-chip');
      clear(sel);
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = t('simple.own.pickDevice');
      sel.append(blank);
      for (const c of chips) {
        const o = document.createElement('option');
        o.value = c;
        o.textContent = c;
        sel.append(o);
      }
      $('own').hidden = false;
      if (ownRows.length === 0) addOwnRow();
      refreshOwn();
      showScreen('prepare');
    },
    /** `fn(rowId, file)` for a file picked in a row; main.js reads it and answers with setOwnPart. */
    bindOwnFile(fn) { onOwnFile = fn; },
    /** `fn(rowId)` when a row is dropped, so the bytes can go too. */
    bindOwnRemove(fn) { onOwnRemove = fn; },
    /** The address field: its button, or Enter inside it. */
    bindOwnUrl(fn) {
      const go = () => { if (!$('own-url-go').disabled) fn($('own-url').value); };
      $('own-url-go').addEventListener('click', go);
      $('own-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    },
    /** While an address is being read: no second read, no other file. */
    setOwnReading(on) {
      for (const id of ['own-url', 'own-url-go']) $(id).disabled = on;
      for (const r of ownRows) r.file.disabled = on;
      // Whether the address button may come back on is decided in one place only: a full set of
      // rows keeps it off, and turning it on here would fetch a file that has nowhere to go.
      if (!on) refreshOwn();
    },
    /** `fn(choice)` runs on every change and returns the problem with the set, or null. */
    bindOwnChange(fn) { onOwnChange = fn; },
    ownChipFamily,
    /** A row for a file that arrived without a picker (by address): the first empty row, or a new one. Null when full. */
    addOwnPart() {
      const row = ownRows.find((r) => !r.part) ?? addOwnRow();
      return row ? row.id : null;
    },
    /**
     * What one file says about itself, from main.js: its size and checksum, the family its header
     * names, what it looks like and the address a build tool would have given it. All of it stays
     * editable and visible; the first header to name a family fills the device list. Returns
     * false when the row is gone — removed while the file was being read — so the caller can drop
     * the bytes it is holding for it.
     */
    setOwnPart(id, { name, size, sha256, chipFamily, kind, offset }) {
      const row = ownRows.find((r) => r.id === id);
      if (!row) return false;
      row.part = { name, size, sha256 };
      row.fileText.textContent = t('simple.own.read', { name, size: formatSize(size) });
      row.address.value = offset === null || offset === undefined ? '' : '0x' + offset.toString(16);
      row.kindText = t('simple.own.kind.' + kind) + (chipFamily ? ' ' + chipFamily + '.' : '');
      row.info.textContent = row.kindText;
      if (chipFamily && !$('own-chip').value) $('own-chip').value = chipFamily;
      refreshOwn();
      return true;
    },
    ownChoice,
    mode() { return document.querySelector('input[name="mode"]:checked')?.value ?? 'first'; },
    wantsBackup() { return !$('backup-opt').hidden && $('backup').checked; },
    setBackupAvailable(on) { $('backup-opt').hidden = !on; if (!on) $('hint-backup').hidden = true; },
    bindConnect(fn) { $('connect').addEventListener('click', fn); },
    bindRetry(fn) { $('retry').addEventListener('click', fn); },
    setBusy(on) {
      $('connect').disabled = on || !ownReady();
      $('connect').classList.toggle('is-busy', on); // only a working button may show a busy pointer
      $('connect-label').textContent = on ? t('action.connecting') : t('action.connect');
      for (const r of document.querySelectorAll('input[name="mode"]')) r.disabled = on;
      for (const id of ['backup', 'own-url', 'own-url-go', 'own-chip', 'own-add']) $(id).disabled = on;
      for (const r of ownRows) { r.file.disabled = on; r.address.disabled = on; r.remove.disabled = on; }
      if (!on) refreshOwn();
    },
    /** Resets screen 2 and shows it. */
    startInstall() {
      setRing(0, true);
      $('eta').textContent = '';
      $('save-backup').hidden = true;
      $('wifi').hidden = true;
      ui.setConsoleAvailable(false);
      $('stage-text').textContent = t('stage.connecting');
      setLamp('lamp-device', 'is-off', t('app.notDetected'));
      setLamp('lamp-cable', 'is-on');
      $('lamp-cable').classList.add('is-pulse');
      showScreen('install');
    },
    /** First layer: the stage sentence, the ring and the time left. Byte counts stay out. */
    setStage({ stage, percent, params = {}, eta }) {
      const sentence = stage === 'writing'
        ? t('stage.writing', { n: params.n, total: params.total })
        : stage === 'backup' && params.phase === 'save' ? t('simple.backup.save')
        : stage === 'backup' && params.phase === 'readBack' ? t('simple.backup.saved', { file: String(params.file ?? '') })
        : (stage === 'downloading' || stage === 'verifying') && params.local ? t('stage.local') : t('stage.' + stage);
      $('stage-text').textContent = sentence;
      setRing(percent, !MEASURED.has(stage));
      $('eta').textContent = eta === undefined || eta <= 0 ? ''
        : eta >= 90 ? t('eta.leftMin', { minutes: Math.ceil(eta / 60) }) : t('eta.left', { seconds: eta });
    },
    setHardware(hw) {
      $('fact-chip').textContent = hw.chipDescription;
      $('fact-flash').textContent = hw.flashSizeMB + ' MB';
      refreshFacts();
      setLamp('lamp-device', 'is-on');
      // The copy's length is known now; the checkbox says it for the next run on this device.
      const minutes = backupMinutes(hw);
      $('backup-label').textContent = minutes === null ? t('action.backupUnknown') : t('action.backup', { minutes });
    },
    setBuild(b) {
      $('fact-board').textContent = b.board;
      refreshFacts();
      setLamp('lamp-device', 'is-on', b.board);
    },
    appendLog(line) { logLines.push(`[${new Date().toLocaleTimeString()}] ${line}`); showLog(); },
    /** A line the device itself printed; the same <pre>, marked, and under the same cap. */
    appendDeviceLine(line) { logLines.push(`[${new Date().toLocaleTimeString()}] > ${line}`); showLog(); },
    /** The console button is offered only when a port was picked and no install is running. */
    setConsoleAvailable(on) {
      $('console-toggle').hidden = !on;
      if (on) $('log-details').hidden = false; // the button lives in the hatch; it may not be walled in
      if (!on) ui.setConsoleRunning(false);
    },
    setConsoleRunning(on) {
      const btn = $('console-toggle');
      btn.setAttribute('aria-pressed', String(on));
      btn.textContent = t(on ? 'action.consoleStop' : 'action.console');
      btn.disabled = false;
    },
    bindConsole(fn) {
      $('console-toggle').addEventListener('click', async () => {
        $('console-toggle').disabled = true; // one click at a time; setConsoleRunning re-enables
        try { await fn(); } finally { $('console-toggle').disabled = false; }
      });
    },
    setResult({ system: name, version, next, checksum }) {
      setRing(100, false);
      setLamp('lamp-cable', 'is-done');
      $('lamp-cable').classList.remove('is-pulse');
      const done = $('screen-done');
      done.classList.remove('is-error');
      $('done-title').textContent = t('simple.done.title');
      $('done-unplug').hidden = false; // the cable promise from screen 2 is released here
      $('done-text').textContent = t('result.ok', { system: name, version });
      const nextHref = safeHref(next);
      $('done-next').hidden = !nextHref;
      if (nextHref) { $('done-next').href = nextHref; $('done-next').textContent = t('simple.done.next'); }
      $('retry').hidden = true;
      $('done-again').hidden = false;
      if (checksum) { $('fact-checksum').textContent = checksum; refreshFacts(); }
      showScreen('done');
    },
    /**
     * The title is the one line a beginner reads. `changed` comes from the engine and is true once
     * an erase or a write has begun; before that the device really is untouched.
     */
    setError(error, { changed = false } = {}) {
      const code = error?.code ?? 'engine.unexpected';
      const done = $('screen-done');
      done.classList.add('is-error');
      $('done-title').textContent = t(changed ? 'simple.stopped.during' : 'simple.stopped.safe');
      $('done-unplug').hidden = true;
      const params = safeParams(error?.params);
      $('done-text').textContent = ownPath ? ownErrorText(t, code, params) : t('error.' + code, params);
      $('wifi').hidden = true;
      $('done-next').hidden = true;
      $('retry').hidden = false;
      $('done-again').hidden = true;
      $('lamp-cable').classList.remove('is-pulse');
      showScreen('done');
    },
    setAltRoute({ cmd, files, guide }) {
      $('alt-cmd').textContent = cmd;
      clear($('alt-files'));
      for (const f of files) {
        const li = document.createElement('li');
        const a = document.createElement(f.url ? 'a' : 'span'); // a local file has no address to link
        if (f.url) a.href = f.url;
        a.textContent = f.name;
        li.append(a);
        if (f.sha256) {
          const c = document.createElement('code');
          c.textContent = ' SHA-256 ' + f.sha256;
          li.append(c);
        }
        $('alt-files').append(li);
      }
      const guideHref = safeHref(guide);
      if (guideHref) {
        $('alt-guide').hidden = false;
        $('alt-guide').href = guideHref;
        $('alt-guide').textContent = t('alt.guide', vars);
      }
      refreshAlt();
    },
    /**
     * The Wi-Fi step on the done screen, shown only once the device has said it takes network
     * details over the cable. `networks` fills the suggestions; the name stays typeable for a
     * hidden network. A device already on a network skips the form and shows its address.
     */
    showWifi({ networks = [], provisioned = false, nextUrl = '' } = {}) {
      const list = $('wifi-list');
      clear(list);
      for (const n of networks) {
        const o = document.createElement('option');
        o.value = n.name;
        list.append(o);
      }
      const strongest = networks.slice().sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))[0];
      $('wifi-ssid').value = strongest?.name ?? '';
      $('wifi-pass').value = '';
      $('wifi-error').hidden = true;
      $('wifi-error').textContent = '';
      $('wifi-form').hidden = provisioned;
      $('wifi-ok').hidden = !provisioned;
      setWifiNext(nextUrl);
      ui.setWifiBusy(false);
      $('wifi').hidden = false;
      if (!provisioned) $(strongest ? 'wifi-pass' : 'wifi-ssid').focus();
    },
    setWifiBusy(on) {
      for (const id of ['wifi-ssid', 'wifi-pass', 'wifi-skip']) $(id).disabled = on;
      $('wifi-send').disabled = on || !$('wifi-ssid').value.trim();
    },
    /** The device joined: the form gives way to one sentence and, if the device gave one, its address. */
    wifiDone(nextUrl) {
      $('wifi-form').hidden = true;
      $('wifi-ok').hidden = false;
      setWifiNext(nextUrl);
    },
    /** Under the fields, which stay filled so the person can correct one thing and send again. */
    wifiError(error) {
      const code = error?.code ?? 'improv.rejected';
      $('wifi-error').textContent = t('error.' + code, safeParams(error?.params));
      $('wifi-error').hidden = false;
      $('wifi-pass').focus();
    },
    hideWifi() { $('wifi').hidden = true; },
    bindWifi({ send, skip }) {
      const submit = () => {
        const ssid = $('wifi-ssid').value.trim();
        if (!ssid || $('wifi-send').disabled) return;
        send({ ssid, password: $('wifi-pass').value });
      };
      $('wifi-send').addEventListener('click', submit);
      $('wifi-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      $('wifi-ssid').addEventListener('input', () => { $('wifi-send').disabled = !$('wifi-ssid').value.trim(); });
      $('wifi-skip').addEventListener('click', skip);
    },
    chooseBuild(builds, hw) {
      return new Promise((resolve) => {
        const d = $('board-dialog');
        clear($('board-list'));
        $('board-hint').textContent = t('board.pickHint', { device: hw.chipFamily, memory: hw.flashSizeMB + ' MB', count: builds.length });
        let settled = false;
        const finish = (v) => { if (settled) return; settled = true; d.close(); resolve(v); };
        for (const b of builds) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'choice';
          btn.textContent = b.board;
          btn.addEventListener('click', () => finish(b), { once: true });
          $('board-list').append(btn);
        }
        $('board-cancel').onclick = () => finish(null);
        d.oncancel = (e) => { e.preventDefault(); finish(null); };
        d.showModal();
      });
    },
    /**
     * The most dangerous moment on the page, so it is the one dialog with a way out that is
     * always there. Three answers, read left to right from safest to heaviest: Cancel (`null`,
     * nothing is touched), install without erasing (`false`), erase and install (`true`) — and
     * only the last one wears amber, filled, so the heavy choice is the one that looks heavy.
     * Escape and the backdrop mean Cancel, as they do in the board dialog next door.
     *
     * `required` is a release that always clears the device. Then the middle answer does not
     * exist, because nothing can be kept: the dialog says so and offers Cancel or the erase.
     * The middle button never says "Cancel" — it installs — which is why Cancel is its own
     * button rather than a relabelling of it.
     */
    confirmErase(build, mode, { required = false } = {}) {
      return new Promise((resolve) => {
        const d = $('erase-dialog');
        const key = required ? 'erase.textAlways' : mode === 'update' ? 'erase.textUpdate' : 'erase.textFirst';
        $('erase-title').textContent = t('erase.title');
        $('erase-text').textContent = t(key, { board: build.board });
        $('erase-yes').textContent = t('erase.yes');
        $('erase-cancel').textContent = t('action.cancel');
        $('erase-no').textContent = t(mode === 'update' ? 'erase.no' : 'erase.noErase');
        $('erase-no').hidden = required;
        let settled = false;
        const finish = (v) => { if (settled) return; settled = true; d.close(); resolve(v); };
        $('erase-yes').onclick = () => finish(true);
        $('erase-no').onclick = () => finish(false);
        $('erase-cancel').onclick = () => finish(null);
        d.oncancel = (e) => { e.preventDefault(); finish(null); };
        d.showModal();
      });
    },
    /**
     * The copy is ready: one button, and the promise resolves on its click. The save itself
     * happens in the caller, inside that click, because the browser's save picker only opens
     * on a user gesture. The button disappears once clicked; the stage sentence stays.
     */
    requestBackupSave() {
      return new Promise((resolve) => {
        const btn = $('save-backup');
        btn.disabled = false;
        btn.hidden = false;
        btn.onclick = () => { btn.onclick = null; btn.disabled = true; btn.hidden = true; resolve(); };
        btn.focus();
      });
    },
    /**
     * Preserve profile without a save picker: the user re-selects the copy they just downloaded.
     * The dialog names the file and says where the browser put it, so nobody has to guess.
     * Cancelling stops the install.
     */
    requestBackupFile(filename) {
      return new Promise((resolve, reject) => {
        const d = $('backup-dialog');
        const input = $('backup-file');
        input.value = '';
        $('backup-hint').textContent = t('action.chooseBackupHint', { file: String(filename ?? '') });
        let settled = false;
        const finish = (file) => {
          if (settled) return;
          settled = true;
          d.close();
          if (file) resolve(file); else reject(new InstallError('serial.cancelled'));
        };
        input.onchange = () => finish(input.files?.[0] ?? null);
        $('backup-cancel').onclick = () => finish(null);
        d.oncancel = (e) => { e.preventDefault(); finish(null); };
        d.showModal();
      });
    },
  };
  return ui;
}
