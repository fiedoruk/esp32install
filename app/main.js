/**
 * Bootstrap: language, catalog, manifest, then the installer wired to the page.
 * Three ways in: `?fw=` installs a catalogued release; `?own=1` installs a file from this
 * computer; with neither, the page lists the catalog, or goes straight to the own-file path
 * when there is no catalog to list.
 * The portal may define `window.__esp32installAnalytics(name, props)`; this file only calls it.
 */
import { detectLang, createI18n } from './i18n.js';
import { pickRelease } from './catalog.js';
import { CHIP_FAMILIES, normalizeManifest, localManifest } from './manifest.js';
import { createInstaller, fetchBytes, fetchOwnFile } from './engine.js';
import { esptoolCommand, inspectImage, sha256Hex } from './verify.js';
import { saveBlob, saveBackupWithHandle } from './backup.js';
import { mountUi, translateDom, fileNameOf, hideHatches } from './ui.js';
import { mountThemeToggle } from './theme.js';
import { createImprovSession } from './improv.js';
import { InstallError } from './errors.js';

const AVAILABLE = ['en', 'pl'];
const PART_MAX = 32 * 1024 * 1024;

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

// Path-safe: a copy under /pl/install/ with <base href="/install/"> must stay under /pl/.
const langSuffix = (lang) => (lang !== 'en' ? '&lang=' + lang : '');
const ownHref = (lang) => `${location.pathname}?own=1${langSuffix(lang)}`;

/** The two gates and the vendored engine. Returns null after showing why the button cannot work. */
async function loadEngine(ui) {
  if (!window.isSecureContext) { ui.showGate('insecure'); return null; }
  if (!('serial' in navigator)) { ui.showGate('noSerial'); return null; }
  try { return await import('../vendor/esptool-js/esptool-js-0.6.1.js'); }
  catch (e) { ui.setError(new InstallError('engine.load', {}, e)); return null; }
}

/**
 * One installer wired to the page; `nameOf` is read late because the own-file name arrives later.
 * The port the person picked is remembered, because after the install the page reopens it for
 * the optional Wi-Fi step; whatever holds it then lets go before the next install starts.
 */
function makeInstaller({ esptool, ui, fw, guide, nameOf }) {
  let chip = '', stage = 'idle', version = '', port = null, build = null, improv = null;
  const log = (line) => ui.appendLog(line);

  /** Ends the Wi-Fi step, waiting for whatever it is doing; the port is free afterwards. */
  async function releasePort() {
    ui.hideWifi();
    if (improv) { const s = improv; improv = null; await s.close(); }
  }

  /**
   * After the install: ask the restarted device whether it takes Wi-Fi details. A silent device
   * is the normal answer and changes nothing on the done screen; a build that says `improv: false`
   * is not even asked. Nothing here can turn a finished install into a failed one.
   */
  async function offerWifi() {
    if (!port || build?.improv === false) return;
    const session = createImprovSession({ port, loadClient: () => import('../vendor/improv-wifi/serial.js'), log });
    improv = session;
    const r = await session.probe();
    if (session.closed || improv !== session) return; // the person moved on in the meantime
    if (!r.offered) {
      if (build?.improv === true) log('improv: the release says the firmware speaks Improv, but the device did not answer');
      improv = null;
      await session.close();
      return;
    }
    if (r.provisioned) {
      ui.showWifi({ provisioned: true, nextUrl: r.nextUrl });
      improv = null;
      await session.close();
      return;
    }
    const networks = await session.scan();
    if (session.closed || improv !== session) return;
    ui.showWifi({ networks });
  }
  ui.bindWifi({
    send: async ({ ssid, password }) => {
      const session = improv;
      if (!session) return;
      ui.setWifiBusy(true);
      try {
        const url = await session.provision(ssid, password);
        ui.wifiDone(url);
        track('wifi', { fw, version, chip });
        if (improv === session) improv = null;
        await session.close();
      } catch (e) {
        ui.wifiError(e);
      } finally {
        ui.setWifiBusy(false);
      }
    },
    skip: () => releasePort(),
  });

  const installer = createInstaller({
    esptool,
    requestPort: async (filters) => {
      port = await navigator.serial.requestPort(filters.length ? { filters } : {});
      return port;
    },
    fetchFn: fetch.bind(window),
    onEvent: (e) => {
      if (e.type === 'stage') { stage = e.stage; ui.setStage(e); }
      else if (e.type === 'hardware') { chip = e.hw.chipFamily; ui.setHardware(e.hw); }
      else if (e.type === 'build') { build = e.build; ui.setBuild(e.build); }
      else if (e.type === 'log') ui.appendLog(e.line);
      else if (e.type === 'done') {
        ui.setResult({ system: nameOf(), version: e.result.version, next: guide, checksum: e.result.parts?.map((p) => p.sha256).filter(Boolean).join(', ') });
        track('done', { fw, version, chip });
        offerWifi().catch((err) => log('improv: ' + String(err?.message ?? err)));
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
  return {
    async run(manifest, mode, options) {
      version = manifest.version;
      ui.setBusy(true);
      ui.startInstall();
      await releasePort(); // the Wi-Fi step must not hold the port the installer is about to open
      port = null;
      track('start', { fw, version });
      try { await installer.run({ manifest, mode, options }); }
      catch { /* already reported through onEvent */ }
      finally { ui.setBusy(false); }
    },
    cancel: () => { installer.cancel(); releasePort(); },
  };
}

/**
 * Install a file from this computer. Nothing is uploaded and no manifest is read: the file is
 * inspected for its header, the defaults it suggests are shown, and the user's two choices
 * (where it goes, which device it is for) become a local manifest that runs through the same
 * engine and the same checks as a catalogued release.
 */
async function startOwn(lang) {
  const ui = mountUi({ i18n, system: '' });
  document.title = i18n.t('simple.own.title');
  ui.showOwn([...CHIP_FAMILIES]);
  ui.setBackupAvailable(true); // the own-file path is always the factory profile
  const esptool = await loadEngine(ui);
  if (!esptool) return;
  let picked = null; // { name, bytes, sha256, url? }
  const run = makeInstaller({ esptool, ui, fw: 'local', nameOf: () => picked?.name ?? '' });
  const report = (e) => ui.setError(e instanceof InstallError ? e : new InstallError('engine.unexpected', { detail: String(e?.message ?? e) }, e));
  // Both ways in end here: bytes in memory, inspected, shown with the defaults they suggest.
  const accept = async (name, bytes, url) => {
    if (bytes.length === 0) throw new InstallError('verify.empty', { path: name });
    if (bytes.length > PART_MAX) throw new InstallError('verify.tooLarge', { path: name, bytes: bytes.length, max: PART_MAX });
    const { chipFamily, whole } = inspectImage(bytes);
    picked = { name, bytes, sha256: await sha256Hex(bytes), url };
    document.title = i18n.t('app.title', { system: name });
    ui.setOwnFile({ name, size: bytes.length, sha256: picked.sha256, chipFamily, whole });
  };
  ui.bindOwnFile(async (file) => {
    try { await accept(file.name, new Uint8Array(await file.arrayBuffer())); } catch (e) { report(e); }
  });
  ui.bindOwnUrl(async (address) => {
    if (!String(address ?? '').trim()) return;
    ui.setOwnReading(true);
    try {
      const { name, url, bytes } = await fetchOwnFile(fetch.bind(window), address, document.baseURI);
      await accept(name, bytes, url);
    } catch (e) { report(e); } finally { ui.setOwnReading(false); }
  });
  ui.bindOwnChange((choice) => {
    if (!choice || !picked) return;
    ui.setAltRoute({ cmd: esptoolCommand(choice.chipFamily, [{ offset: choice.offset }], [picked.name]), files: [{ name: picked.name, url: picked.url, sha256: picked.sha256 }] });
  });
  ui.bindConnect(async () => {
    const choice = ui.ownChoice();
    if (!picked || !choice) return;
    let manifest;
    try { manifest = await localManifest({ name: picked.name, chipFamily: choice.chipFamily, parts: [{ path: picked.name, offset: choice.offset, bytes: picked.bytes }] }); }
    catch (e) { report(e); return; }
    await run.run(manifest, ui.mode(), { backup: ui.wantsBackup() });
  });
  ui.bindRetry(() => ui.showScreen('prepare'));
  window.addEventListener('beforeunload', () => run.cancel());
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

  if (q.get('own') === '1') return startOwn(lang);

  // The catalog is optional: a copy of these files with no catalog.json is still an installer.
  let catalog = null, catalogError = null;
  try { catalog = await loadJson(new URL('catalog.json', document.baseURI).href); }
  catch (e) { catalogError = e; }
  const fw = q.get('fw') ?? '';
  if (!fw) {
    const systems = catalog ? pickRelease(catalog, {}).systems : [];
    if (systems.length === 0) return startOwn(lang);
    const ui = mountUi({ i18n, system: '' });
    ui.showSystems(systems, (s) => `${location.pathname}?fw=${encodeURIComponent(s.id)}${langSuffix(lang)}`, ownHref(lang));
    return;
  }
  if (!catalog) throw new InstallError('catalog.fetch', {}, catalogError);
  const { system, release } = pickRelease(catalog, { fw, v: q.get('v') ?? '', channel: q.get('channel') ?? '' });
  const ui = mountUi({ i18n, system: system.name });
  const manifestUrl = new URL(release.manifest, document.baseURI).href;
  const manifest = normalizeManifest(await loadJson(manifestUrl), manifestUrl, { allowOrigins: catalog.allowOrigins ?? [] });
  document.title = i18n.t('app.title', { system: system.name });
  ui.showInstaller({ title: i18n.t('app.title', { system: system.name }), release: manifest.version });
  ui.setBackupAvailable(manifest.profile === 'factory');
  ui.setOwnLink(ownHref(lang));
  const b0 = manifest.builds[0];
  const guide = release.guide ?? system.guide;
  ui.setAltRoute({
    cmd: esptoolCommand(b0.chipFamily, b0.parts, b0.parts.map((p) => fileNameOf(p.url))),
    files: manifest.builds.flatMap((b) => b.parts.map((p) => ({ name: fileNameOf(p.url), url: p.url, sha256: p.sha256 }))),
    guide,
  });

  const esptool = await loadEngine(ui);
  if (!esptool) return;
  const run = makeInstaller({ esptool, ui, fw: system.id, guide, nameOf: () => system.name });
  ui.bindConnect(() => run.run(manifest, ui.mode(), { backup: ui.wantsBackup() }));
  ui.bindRetry(() => ui.showScreen('prepare'));
  window.addEventListener('beforeunload', () => run.cancel());
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
