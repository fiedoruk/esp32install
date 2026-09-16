/**
 * DOM layer of the installer. No installation logic lives here: `main.js` feeds it engine
 * events and it moves between the three screens (prepare, install, done). Everything a
 * beginner sees on the first layer comes from `simple.*`, `door.*`, `stage.*`, `result.*`
 * and `action.*`; chip names, sizes and checksums only ever land inside <details>.
 */
import { InstallError } from './errors.js';
import { createLineBuffer } from './console.js';
import { MAX_PARTS } from './own.js';

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

/** Fills `data-i18n` text and `data-i18n-attr` attributes under `root`. */
export function translateDom(t, vars, root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n, vars);
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    const [attr, key] = el.dataset.i18nAttr.split(':');
    el.setAttribute(attr, t(key, vars));
  }
}

export function mountUi({ i18n, system }) {
  const t = i18n.t;
  const vars = { system };
  translateDom(t, vars);
  $('connect-label').textContent = t('action.connect');
  $('backup-label').textContent = t('action.backup', { minutes: 5 });
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

  $('log-details').addEventListener('toggle', (e) => {
    $('log-summary').textContent = t(e.target.open ? 'app.hideLog' : 'app.showLog');
  });
  $('copy-log').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('log').textContent); } catch { /* clipboard may be blocked */ }
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
    pre.textContent = logLines.text();
    pre.scrollTop = pre.scrollHeight;
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
  const ownRows = []; // { id, li, title, fileText, file, address, info, remove, part }
  let ownSeq = 0, onOwnFile = null, onOwnRemove = null, onOwnChange = null, ownProblem = null;
  const OWN_PROBLEM_KEY = { 'verify.overlap': 'simple.own.overlap', 'verify.wrongChip': 'simple.own.wrongDevice', 'verify.notAnImage': 'simple.own.notAnImage' };
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
  const ownProblemText = (e) => {
    const key = OWN_PROBLEM_KEY[e?.code];
    return key ? t(key, safeParams(e.params)) : t('error.' + (e?.code ?? 'engine.unexpected'), safeParams(e?.params));
  };
  /** Why the button is off, as one sentence, or '' when it may turn on. */
  const ownWhy = () => {
    const filled = ownFilled();
    if (filled.length === 0) return t('simple.own.needFile');
    if (filled.some((r) => parseAddress(r.address.value) === null)) return t('simple.own.badAddress');
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
    });
    const chipFamily = ownChipFamily();
    $('fact-board').textContent = chipFamily ?? '';
    $('fact-release').textContent = filled.map((r) => `${r.part.name}, ${r.part.size} bytes` + (parseAddress(r.address.value) === null ? '' : `, at 0x${parseAddress(r.address.value).toString(16)}`)).join('; ');
    $('fact-checksum').textContent = filled.map((r) => r.part.sha256).join(', ');
    const choice = ownChoice();
    ownProblem = choice ? (onOwnChange?.(choice) ?? null) : null;
    const why = ownWhy();
    $('own-note').textContent = why || (choice.parts.length === 1
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
    remove.className = 'small';
    remove.textContent = t('simple.own.remove');
    li.append(title, fileLabel, fields, remove);
    const row = { id, li, title, fileText, file, address, info, remove, part: null };
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
    showGate(kind) {
      $('gate').hidden = false;
      $('gate-text').textContent = t('gate.' + kind);
      for (const s of screens) { $('screen-' + s).hidden = true; $('screen-' + s).classList.remove('is-active'); }
      $('alt-wrap').open = true;
    },
    showInstaller({ title, release }) {
      $('title').textContent = title;
      $('fact-release').textContent = release;
      showScreen('prepare');
    },
    showSystems(systems, hrefFor, ownHref) {
      $('pick').hidden = false;
      hideHatches(); // nothing to show without a system
      $('own-entry').href = ownHref;
      clear($('pick-list'));
      for (const s of systems) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = hrefFor(s);
        a.textContent = s.name;
        const small = document.createElement('small');
        small.textContent = s.device ?? '';
        a.append(small);
        li.append(a);
        $('pick-list').append(li);
      }
    },
    /** Catalogued install: the quiet way out to the own-file path. */
    setOwnLink(href) { $('own-instead').href = href; $('own-instead').hidden = false; },
    /**
     * The own-file path on the prepare screen. `chips` fills the device list; one empty row waits
     * for the first file, and the button stays off until every row has a valid address, a device
     * is chosen and the files fit together.
     */
    showOwn(chips) {
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
     * editable and visible; the first header to name a family fills the device list.
     */
    setOwnPart(id, { name, size, sha256, chipFamily, kind, offset }) {
      const row = ownRows.find((r) => r.id === id);
      if (!row) return;
      row.part = { name, size, sha256 };
      row.fileText.textContent = t('simple.own.read', { name, size: formatSize(size) });
      row.address.value = offset === null || offset === undefined ? '' : '0x' + offset.toString(16);
      row.info.textContent = t('simple.own.kind.' + kind) + (chipFamily ? ' ' + chipFamily + '.' : '');
      if (chipFamily && !$('own-chip').value) $('own-chip').value = chipFamily;
      $('title').textContent = t('app.title', { system: ownFilled().map((r) => r.part.name).join(', ') });
      refreshOwn();
    },
    ownChoice,
    mode() { return document.querySelector('input[name="mode"]:checked')?.value ?? 'first'; },
    wantsBackup() { return !$('backup-opt').hidden && $('backup').checked; },
    setBackupAvailable(on) { $('backup-opt').hidden = !on; if (!on) $('hint-backup').hidden = true; },
    bindConnect(fn) { $('connect').addEventListener('click', fn); },
    bindRetry(fn) { $('retry').addEventListener('click', fn); },
    setBusy(on) {
      $('connect').disabled = on || !ownReady();
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
      setLamp('lamp-device', 'is-on');
    },
    setBuild(b) {
      $('fact-board').textContent = b.board;
      setLamp('lamp-device', 'is-on', b.board);
    },
    appendLog(line) { logLines.push(`[${new Date().toLocaleTimeString()}] ${line}`); showLog(); },
    /** A line the device itself printed; the same <pre>, marked, and under the same cap. */
    appendDeviceLine(line) { logLines.push(`[${new Date().toLocaleTimeString()}] > ${line}`); showLog(); },
    /** The console button is offered only when a port was picked and no install is running. */
    setConsoleAvailable(on) { $('console-toggle').hidden = !on; if (!on) ui.setConsoleRunning(false); },
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
      $('done-next').hidden = !next;
      if (next) { $('done-next').href = next; $('done-next').textContent = t('simple.done.next'); }
      $('retry').hidden = true;
      $('done-again').hidden = false;
      if (checksum) $('fact-checksum').textContent = checksum;
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
      $('done-text').textContent = t('error.' + code, safeParams(error?.params));
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
      if (guide) {
        $('alt-guide').hidden = false;
        $('alt-guide').href = guide;
        $('alt-guide').textContent = t('alt.guide', vars);
      }
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
        $('board-hint').textContent = t('board.pickHint', { chip: hw.chipFamily, flash: hw.flashSizeMB + ' MB', count: builds.length });
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
    confirmErase(build, mode) {
      return new Promise((resolve) => {
        const d = $('erase-dialog');
        $('erase-title').textContent = t('erase.title');
        $('erase-text').textContent = t(mode === 'update' ? 'erase.textUpdate' : 'erase.textFirst', { board: build.board });
        $('erase-yes').textContent = t('erase.yes');
        $('erase-no').textContent = t(mode === 'update' ? 'erase.no' : 'action.cancel');
        let settled = false;
        const finish = (v) => { if (settled) return; settled = true; d.close(); resolve(v); };
        $('erase-yes').onclick = () => finish(true);
        $('erase-no').onclick = () => finish(false);
        d.oncancel = (e) => { e.preventDefault(); finish(false); };
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
