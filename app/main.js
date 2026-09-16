/**
 * Bootstrap: language, catalog, manifest, then the installer wired to the page.
 * Three ways in: `?fw=` installs a catalogued release; `?own=1` installs a file from this
 * computer; with neither, the page lists the catalog, or goes straight to the own-file path
 * when there is no catalog to list.
 * The portal may define `window.__esp32installAnalytics(name, props)`; this file only calls it.
 */
import { detectLang, createI18n, langLinkHref } from './i18n.js';
import { pickRelease } from './catalog.js';
import { CHIP_FAMILIES, normalizeManifest, localManifest } from './manifest.js';
import { createInstaller, fetchBytes, fetchOwnFile } from './engine.js';
import { esptoolCommand, sha256Hex } from './verify.js';
import { describePart, ownProblem } from './own.js';
import { saveBlob, saveBackupWithHandle } from './backup.js';
import { mountUi, translateDom, fileNameOf, hideHatches } from './ui.js';
import { mountThemeToggle } from './theme.js';
import { createImprovSession } from './improv.js';
import { createConsole } from './console.js';
import { InstallError } from './errors.js';

const AVAILABLE = ['en', 'pl'];
const PART_MAX = 32 * 1024 * 1024;

const track = (name, props) => { try { window.__esp32installAnalytics?.(name, props); } catch { /* never ours to fix */ } };
let i18n = null; // set once the dictionary is loaded, so a boot failure can still speak

async function loadJson(url, max = 512 * 1024) {
  const bytes = await fetchBytes(fetch.bind(window), url, max);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Language links keep `?fw=` and friends; only `lang` changes, and it is always spelled out. */
function setupLangLinks(lang) {
  for (const a of document.querySelectorAll('nav.lang a')) {
    const target = a.getAttribute('hreflang');
    a.href = langLinkHref(location.href, target);
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
  let chip = '', stage = 'idle', version = '', port = null, build = null, improv = null, monitor = null;
  const log = (line) => ui.appendLog(line);

  /** Ends the Wi-Fi step and the console, waiting for whatever they are doing; the port is free afterwards. */
  async function releasePort() {
    ui.hideWifi();
    if (improv) { const s = improv; improv = null; await s.close(); }
    if (monitor) { const m = monitor; monitor = null; await m.stop(); ui.setConsoleRunning(false); }
  }

  /**
   * The console: what the device prints, streamed into the technical log. Offered on the done
   * and the stopped screen alike, because a failed boot is exactly what one wants to read.
   * It takes the port only once the installer and the Wi-Fi step have let go of it.
   */
  ui.bindConsole(async () => {
    if (monitor) { await releasePort(); return; }
    if (!port) return;
    await releasePort();
    const m = createConsole({
      port,
      onLine: (line) => ui.appendDeviceLine(line),
      onEnd: (error) => {
        if (monitor === m) monitor = null;
        ui.setConsoleRunning(false);
        log('console: ' + (error ? 'ended with ' + String(error?.message ?? error) : 'the device went away'));
      },
    });
    monitor = m;
    try {
      await m.start();
      ui.setConsoleRunning(true);
      log('console: listening at 115200');
    } catch (e) {
      monitor = null;
      ui.setConsoleRunning(false);
      log('console: could not open the port (' + String(e?.message ?? e) + ')');
    }
  });

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
        ui.setConsoleAvailable(Boolean(port));
        offerWifi().catch((err) => log('improv: ' + String(err?.message ?? err)));
      } else if (e.type === 'error') {
        ui.setError(e.error, { changed: e.changed });
        ui.setConsoleAvailable(Boolean(port));
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
 * Install files from this computer. Nothing is uploaded and no manifest is read: each file is
 * inspected for its header, the address a build tool would have given it is suggested, and the
 * user's choices (where each file goes, which device they are for) become a local manifest that
 * runs through the same engine and the same checks as a catalogued release. One merged image is
 * the common case; a PlatformIO or Arduino build brings its three or four files, one per row.
 */
async function startOwn(lang) {
  const ui = mountUi({ i18n, system: '' });
  document.title = i18n.t('simple.own.title');
  ui.setBackupAvailable(true); // the own-file path is always the factory profile...
  ui.showOwn([...CHIP_FAMILIES]); // ...and showOwn then keeps the copy hidden until there is a file
  const esptool = await loadEngine(ui);
  if (!esptool) return;
  const picked = new Map(); // row id → { name, bytes, sha256, url? }
  const names = () => [...picked.values()].map((p) => p.name).join(', ');
  const run = makeInstaller({ esptool, ui, fw: 'local', nameOf: names });
  const report = (e) => ui.setError(e instanceof InstallError ? e : new InstallError('engine.unexpected', { detail: String(e?.message ?? e) }, e));
  // Both ways in end here: bytes in memory, inspected, shown with the defaults they suggest.
  const accept = async (rowId, name, bytes, url) => {
    if (bytes.length === 0) throw new InstallError('verify.empty', { path: name });
    if (bytes.length > PART_MAX) throw new InstallError('verify.tooLarge', { path: name, bytes: bytes.length, max: PART_MAX });
    const facts = describePart(name, bytes, ui.ownChipFamily());
    const sha256 = await sha256Hex(bytes);
    const id = rowId ?? ui.addOwnPart();
    if (id === null) return; // every row is taken; the page has already switched the button off
    picked.set(id, { name, bytes, sha256, url });
    ui.setOwnPart(id, { name, size: bytes.length, sha256, ...facts });
    document.title = i18n.t('app.title', { system: names() });
  };
  ui.bindOwnFile(async (rowId, file) => {
    try { await accept(rowId, file.name, new Uint8Array(await file.arrayBuffer())); } catch (e) { report(e); }
  });
  ui.bindOwnRemove((rowId) => { picked.delete(rowId); });
  ui.bindOwnUrl(async (address) => {
    if (!String(address ?? '').trim()) return;
    ui.setOwnReading(true);
    try {
      const { name, url, bytes } = await fetchOwnFile(fetch.bind(window), address, document.baseURI);
      await accept(null, name, bytes, url);
    } catch (e) { report(e); } finally { ui.setOwnReading(false); }
  });
  // Every change: the same checks the engine will run, and the alternative route for this set.
  ui.bindOwnChange((choice) => {
    const parts = choice.parts.map((p) => ({ name: p.name, offset: p.offset, bytes: picked.get(p.id).bytes }));
    ui.setAltRoute({
      cmd: esptoolCommand(choice.chipFamily, parts, parts.map((p) => p.name)),
      files: choice.parts.map((p) => ({ name: p.name, url: picked.get(p.id).url, sha256: picked.get(p.id).sha256 })),
    });
    return ownProblem(parts, choice.chipFamily);
  });
  ui.bindConnect(async () => {
    const choice = ui.ownChoice();
    if (!choice) return;
    let manifest;
    try {
      const parts = choice.parts.slice().sort((a, b) => a.offset - b.offset).map((p) => ({ path: p.name, offset: p.offset, bytes: picked.get(p.id).bytes }));
      manifest = await localManifest({ name: names(), chipFamily: choice.chipFamily, parts });
    } catch (e) { report(e); return; }
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
  // The first layer says which version this is, and whether it is the stable one (D-06: no surprises later).
  ui.showInstaller({
    title: i18n.t('app.titleVersion', { system: system.name, version: manifest.version }),
    release: manifest.version,
    preRelease: (release.channel ?? 'stable') !== 'stable',
  });
  ui.setBackupAvailable(manifest.profile === 'factory');
  ui.setPreserve(manifest.profile === 'preserve');
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
  if (err.code.startsWith('catalog.unknown')) {
    // A typo in the address, most likely: the sentence points at the list, and so does this link.
    const link = document.getElementById('gate-link');
    link.href = location.pathname;
    link.textContent = i18n.t('pick.title');
    link.hidden = false;
  }
  hideHatches(); // nothing to show without a system
  console.error(err);
});
