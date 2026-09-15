/**
 * DOM layer of the installer. No installation logic lives here: `main.js` feeds it engine
 * events and it moves between the three screens (prepare, install, done). Everything a
 * beginner sees on the first layer comes from `simple.*`, `door.*`, `stage.*`, `result.*`
 * and `action.*`; chip names, sizes and checksums only ever land inside <details>.
 */
import { InstallError } from './errors.js';

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

export function mountUi({ i18n, system }) {
  const t = i18n.t;
  const vars = { system };
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n, vars);
  for (const el of document.querySelectorAll('[data-i18n-attr]')) {
    const [attr, key] = el.dataset.i18nAttr.split(':');
    el.setAttribute(attr, t(key, vars));
  }
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

  const ui = {
    showScreen,
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
    showSystems(systems, hrefFor) {
      $('pick').hidden = false;
      for (const id of ['tech', 'log-details', 'alt-wrap']) $(id).hidden = true; // nothing to show without a system
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
    mode() { return document.querySelector('input[name="mode"]:checked')?.value ?? 'first'; },
    wantsBackup() { return !$('backup-opt').hidden && $('backup').checked; },
    setBackupAvailable(on) { $('backup-opt').hidden = !on; if (!on) $('hint-backup').hidden = true; },
    bindConnect(fn) { $('connect').addEventListener('click', fn); },
    bindRetry(fn) { $('retry').addEventListener('click', fn); },
    setBusy(on) {
      $('connect').disabled = on;
      $('connect-label').textContent = on ? t('action.connecting') : t('action.connect');
      for (const r of document.querySelectorAll('input[name="mode"]')) r.disabled = on;
      $('backup').disabled = on;
    },
    /** Resets screen 2 and shows it. */
    startInstall() {
      setRing(0, true);
      $('eta').textContent = '';
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
        : stage === 'downloading' ? t('stage.downloading') : t('stage.' + stage);
      $('stage-text').textContent = sentence;
      setRing(percent, !MEASURED.has(stage));
      $('eta').textContent = eta !== undefined && eta > 0 ? t('eta.left', { seconds: eta }) : '';
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
    appendLog(line) {
      const pre = $('log');
      pre.textContent += `[${new Date().toLocaleTimeString()}] ${line}\n`;
      pre.scrollTop = pre.scrollHeight;
    },
    setResult({ system: name, version, next, checksum }) {
      setRing(100, false);
      setLamp('lamp-cable', 'is-done');
      $('lamp-cable').classList.remove('is-pulse');
      const done = $('screen-done');
      done.classList.remove('is-error');
      $('done-title').textContent = t('simple.done.title');
      $('done-text').textContent = t('result.ok', { system: name, version });
      $('done-next').hidden = !next;
      if (next) { $('done-next').href = next; $('done-next').textContent = t('simple.done.next'); }
      $('retry').hidden = true;
      $('done-again').hidden = false;
      if (checksum) $('fact-checksum').textContent = checksum;
      showScreen('done');
    },
    setError(error) {
      const code = error?.code ?? 'engine.unexpected';
      const done = $('screen-done');
      done.classList.add('is-error');
      $('done-title').textContent = t('simple.stopped.title');
      $('done-text').textContent = t('error.' + code, safeParams(error?.params));
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
        const a = document.createElement('a');
        a.href = f.url;
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
    /** Preserve profile: the user re-selects the copy they just saved. Cancelling stops the install. */
    requestBackupFile() {
      return new Promise((resolve, reject) => {
        const d = $('backup-dialog');
        const input = $('backup-file');
        input.value = '';
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
