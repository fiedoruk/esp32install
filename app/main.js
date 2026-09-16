/**
 * Bootstrap: language, catalog, manifest, then the installer wired to the page.
 * The portal may define `window.__esp32installAnalytics(name, props)`; this file only calls it.
 */
import { detectLang, createI18n } from './i18n.js';
import { pickRelease } from './catalog.js';
import { normalizeManifest } from './manifest.js';
import { createInstaller, fetchBytes } from './engine.js';
import { esptoolCommand } from './verify.js';
import { saveBlob, saveBackupWithHandle } from './backup.js';
import { mountUi, translateDom, fileNameOf, hideHatches } from './ui.js';
import { mountThemeToggle } from './theme.js';
import { InstallError } from './errors.js';

const AVAILABLE = ['en', 'pl'];

const track = (name, props) => { try { window.__esp32installAnalytics?.(name, props); } catch { /* never ours to fix */ } };
let i18n = null; // set once the dictionary is loaded, so a boot failure can still speak

async function loadJson(url, max = 512 * 1024) {
  const bytes = await fetchBytes(fetch.bind(window), url, max);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Language links keep `?fw=` and friends; only `lang` changes. */
function setupLangLinks(lang) {
  for (const a of document.querySelectorAll('nav.lang a')) {
    const url = new URL(location.href);
    const target = a.getAttribute('hreflang');
    if (target === 'en') url.searchParams.delete('lang'); else url.searchParams.set('lang', target);
    a.href = url.pathname + url.search;
    if (target === lang) a.setAttribute('aria-current', 'true');
  }
}

async function boot() {
  const q = new URLSearchParams(location.search);
  const wanted = detectLang({ htmlLang: document.documentElement.lang, query: q.get('lang') ?? '', navigatorLanguages: navigator.languages ?? [], available: AVAILABLE });
  const dicts = { en: await loadJson(new URL('../locales/en.json', import.meta.url).href) };
  if (wanted !== 'en') {
    try { dicts[wanted] = await loadJson(new URL(`../locales/${wanted}.json`, import.meta.url).href); } catch { /* not translated yet: English */ }
  }
  const lang = dicts[wanted] ? wanted : 'en';
  i18n = createI18n(dicts, lang);
  document.documentElement.lang = lang;
  setupLangLinks(lang);
  translateDom(i18n.t, { system: '' }, document.querySelector('header.top')); // named even when the catalog fails

  let catalog;
  try { catalog = await loadJson(new URL('catalog.json', document.baseURI).href); }
  catch (e) { throw new InstallError('catalog.fetch', {}, e); }
  const picked = pickRelease(catalog, { fw: q.get('fw') ?? '', v: q.get('v') ?? '', channel: q.get('channel') ?? '' });
  if (picked.systems) {
    const ui = mountUi({ i18n, system: '' });
    // Path-safe: a copy under /pl/install/ with <base href="/install/"> must stay under /pl/.
    ui.showSystems(picked.systems, (s) => `${location.pathname}?fw=${encodeURIComponent(s.id)}${lang !== 'en' ? '&lang=' + lang : ''}`);
    return;
  }
  const { system, release } = picked;
  const ui = mountUi({ i18n, system: system.name });
  const manifestUrl = new URL(release.manifest, document.baseURI).href;
  const manifest = normalizeManifest(await loadJson(manifestUrl), manifestUrl, { allowOrigins: catalog.allowOrigins ?? [] });
  document.title = i18n.t('app.title', { system: system.name });
  ui.showInstaller({ title: i18n.t('app.title', { system: system.name }), release: manifest.version });
  ui.setBackupAvailable(manifest.profile === 'factory');
  const b0 = manifest.builds[0];
  const guide = release.guide ?? system.guide;
  ui.setAltRoute({
    cmd: esptoolCommand(b0.chipFamily, b0.parts, b0.parts.map((p) => fileNameOf(p.url))),
    files: manifest.builds.flatMap((b) => b.parts.map((p) => ({ name: fileNameOf(p.url), url: p.url, sha256: p.sha256 }))),
    guide,
  });

  if (!window.isSecureContext) return ui.showGate('insecure');
  if (!('serial' in navigator)) return ui.showGate('noSerial');

  let esptool;
  try { esptool = await import('../vendor/esptool-js/esptool-js-0.6.1.js'); }
  catch (e) { ui.setError(new InstallError('engine.load', {}, e)); return; }

  const fw = system.id, version = manifest.version;
  let chip = '';
  let stage = 'idle';
  const installer = createInstaller({
    esptool,
    requestPort: (filters) => navigator.serial.requestPort(filters.length ? { filters } : {}),
    fetchFn: fetch.bind(window),
    onEvent: (e) => {
      if (e.type === 'stage') { stage = e.stage; ui.setStage(e); }
      else if (e.type === 'hardware') { chip = e.hw.chipFamily; ui.setHardware(e.hw); }
      else if (e.type === 'build') ui.setBuild(e.build);
      else if (e.type === 'log') ui.appendLog(e.line);
      else if (e.type === 'done') {
        ui.setResult({ system: system.name, version: e.result.version, next: guide, checksum: e.result.parts?.map((p) => p.sha256).filter(Boolean).join(', ') });
        track('done', { fw, version, chip });
      } else if (e.type === 'error') {
        ui.setError(e.error);
        track('error', { fw, version, chip, stage, code: e.error?.code });
      }
    },
    chooseBuild: (builds, hw) => ui.chooseBuild(builds, hw),
    confirmErase: (build, mode) => ui.confirmErase(build, mode),
    // The save waits for a click: the browser's save picker needs a user gesture. With a picker
    // the copy goes where the user chooses and the engine reads it back through the same handle;
    // without one (Firefox, Brave, Safari) the click downloads the file and the engine asks for it.
    saveBackup: async (bytes, filename) => {
      await ui.requestBackupSave();
      const saved = await saveBackupWithHandle(bytes, filename);
      if (!saved) await saveBlob(bytes, filename);
      return saved;
    },
    requestBackupFile: (filename) => ui.requestBackupFile(filename),
  });
  ui.bindConnect(async () => {
    ui.setBusy(true);
    ui.startInstall();
    track('start', { fw, version });
    try { await installer.run({ manifest, mode: ui.mode(), options: { backup: ui.wantsBackup() } }); }
    catch { /* already reported through onEvent */ }
    finally { ui.setBusy(false); }
  });
  ui.bindRetry(() => ui.showScreen('prepare'));
  window.addEventListener('beforeunload', () => installer.cancel());
}

// Before anything loads: the header buttons work whatever happens to the catalog.
mountThemeToggle({ buttons: { light: document.getElementById('theme-light'), dark: document.getElementById('theme-dark') } });

boot().catch((e) => {
  const err = e instanceof InstallError ? e : new InstallError('catalog.fetch', {}, e);
  const el = document.getElementById('gate');
  el.hidden = false;
  document.getElementById('gate-text').textContent = i18n ? i18n.t('error.' + err.code, err.params) : err.code;
  hideHatches(); // nothing to show without a system
  console.error(err);
});
