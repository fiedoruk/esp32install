import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { detectLang, createI18n, langLinkHref } from '../app/i18n.js';
import { ownErrorText, CATALOGUE_VOICE, layoutStop } from '../app/ui.js';

const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));

test('detectLang order: ?lang, html lang, navigator, fallback en', () => {
  const available = ['en', 'pl'];
  assert.equal(detectLang({ htmlLang: 'pl', query: 'en', navigatorLanguages: ['de'], available }), 'en', '/pl/…?lang=en gives English');
  assert.equal(detectLang({ htmlLang: 'pl', query: '', navigatorLanguages: ['en-US'], available }), 'pl', '/pl/ gives Polish to an English browser');
  assert.equal(detectLang({ htmlLang: '', query: 'pl', navigatorLanguages: ['de'], available }), 'pl');
  assert.equal(detectLang({ htmlLang: '', query: '', navigatorLanguages: ['pl-PL', 'en'], available }), 'pl');
  assert.equal(detectLang({ htmlLang: 'de', query: 'xx', navigatorLanguages: ['de-DE'], available }), 'en');
});

test('langLinkHref always spells the language out, keeps the query, and returns only path and query', () => {
  assert.equal(langLinkHref('https://esp32ai.me/pl/install/?fw=radio', 'en'), '/pl/install/?fw=radio&lang=en', 'EN from a Polish copy must say lang=en, or the html lang keeps it Polish');
  assert.equal(langLinkHref('https://esp32ai.me/install/?fw=radio&lang=pl', 'en'), '/install/?fw=radio&lang=en');
  assert.equal(langLinkHref('https://esp32ai.me/install/?fw=radio', 'pl'), '/install/?fw=radio&lang=pl');
  assert.equal(langLinkHref('https://esp32ai.me/install/?own=1&lang=en', 'pl'), '/install/?own=1&lang=pl');
  assert.equal(langLinkHref('https://esp32ai.me/install/', 'en'), '/install/?lang=en');
  assert.equal(detectLang({ htmlLang: 'pl', query: 'en', navigatorLanguages: ['pl'], available: ['en', 'pl'] }), 'en', 'and detectLang honours it');
});

test('t() falls back to en, then to the key, and interpolates safely', () => {
  const i18n = createI18n({ en: { a: { b: 'Hello {name}' }, only: 'EN only' }, pl: { a: { b: 'Cześć {name}' } } }, 'pl');
  assert.equal(i18n.t('a.b', { name: '<b>' }), 'Cześć <b>');
  assert.equal(i18n.t('only'), 'EN only');
  assert.equal(i18n.t('missing.key'), 'missing.key');
});

/** One instance over the real dictionary: the page resolves error codes the same way. */
const enI18n = createI18n({ en }, 'en');

test('every InstallError code used in app/ resolves through t()', () => {
  const codes = new Set();
  for (const f of readdirSync(new URL('../app/', import.meta.url))) {
    const src = readFileSync(new URL('../app/' + f, import.meta.url), 'utf8');
    for (const m of src.matchAll(/(?:fail|new InstallError)\(\s*'([a-z]+\.[A-Za-z0-9]+)'/g)) codes.add(m[1]);
  }
  assert.ok(codes.size > 10, 'expected error codes to be found');
  const missing = [...codes].filter((c) => enI18n.t('error.' + c) === 'error.' + c);
  assert.deepEqual(missing, []);
});

test('dotted error codes are found although the key has three dots', () => {
  assert.notEqual(enI18n.t('error.serial.busy'), 'error.serial.busy');
  assert.notEqual(enI18n.t('error.manifest.url'), 'error.manifest.url');
});

test('a key that lands on a namespace is missing, not [object Object]', () => {
  assert.equal(enI18n.t('simple.done'), 'simple.done');
  assert.equal(enI18n.t('error'), 'error');
});

// Every namespace a beginner reads on a real screen, the board dialog included: it is shown to
// everyone who installs a release with more than one build.
const SIMPLE = ['simple', 'door', 'stage', 'result', 'gate', 'action', 'board'];
const JARGON = /\b(firmware|flash(ing|ed)?|offset|bootloader|md5|sha-?256|serial|baud|esptool|manifest|chip|partition|erase-all|binary|\.bin)\b/i;
// The names Chrome itself prints in its port picker; the page has to say them so a beginner can recognise the entry.
const DEVICE_NAMES = /USB Serial|CP210x|CH9102|Unnamed device/g;
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => typeof v === 'object' ? flat(v, p + k + '.') : [[p + k, v]]);

test('simple-layer strings carry no jargon', () => { const bad = flat(en).filter(([k, v]) => SIMPLE.includes(k.split('.')[0]) && JARGON.test(v.replace(DEVICE_NAMES, ''))); assert.deepEqual(bad, []); });

test('positive control: jargon in a simple key is caught, and the device-name exemption is exact', () => {
  assert.ok(JARGON.test('Flashing the firmware now'));
  assert.ok(JARGON.test('open the serial port'.replace(DEVICE_NAMES, '')), 'a bare "serial" is still jargon');
  assert.ok(!JARGON.test('called USB Serial'.replace(DEVICE_NAMES, '')));
});

/** Keys the page and the engine ask for by name. Dropping one breaks the UI silently. */
const REQUIRED = [
  'app.title', 'app.titleVersion', 'app.subtitle', 'app.notDetected',
  'app.stage', 'app.copyLog', 'app.showLog', 'app.hideLog', 'app.language',
  'door.title', 'door.first', 'door.firstHint', 'door.firstHintNew', 'door.update', 'door.updateHint', 'door.updateHintOwn',
  'gate.insecure', 'gate.noSerial', 'gate.altFirst',
  'action.connect', 'action.connecting', 'action.installing', 'action.retry',
  'action.cancel', 'action.backup', 'action.backupUnknown', 'action.saveBackup', 'action.chooseBackup', 'action.chooseBackupTitle', 'action.chooseBackupHint', 'action.erase',
  'action.theme', 'action.themeLight', 'action.themeDark', 'action.copyLink', 'action.linkCopied',
  'stage.idle', 'stage.connecting', 'stage.detecting', 'stage.matching', 'stage.downloading',
  'stage.verifying', 'stage.checkingDevice', 'stage.backup', 'stage.erasing', 'stage.writing',
  'stage.md5', 'stage.done', 'stage.error', 'stage.local',
  'eta.left', 'eta.leftMin',
  'result.ok', 'result.stopped',
  'board.pick', 'board.pickHint',
  'alt.title', 'alt.cmd', 'alt.files', 'alt.drivers', 'alt.guide',
  'simple.prepare.title', 'simple.prepare.hintCable', 'simple.prepare.hintDoor', 'simple.prepare.hintBackup', 'simple.prepare.backupFirst', 'simple.preRelease',
  'simple.install.keepCable', 'simple.backup.save', 'simple.backup.saved', 'simple.done.title', 'simple.done.next', 'simple.done.again', 'simple.stopped.safe', 'simple.stopped.during',
  'tech.title', 'tech.chip', 'tech.flash', 'tech.board', 'tech.release', 'tech.checksum', 'tech.log', 'tech.file',
  'tech.layout', 'tech.settings', 'tech.layoutUnreadable',
  'simple.own.title', 'simple.own.instead', 'simple.own.hint', 'simple.own.choose', 'simple.own.read', 'simple.own.address', 'simple.own.device',
  'simple.own.pickDevice', 'simple.own.plan', 'simple.own.planMany', 'simple.own.unknownDevice', 'simple.own.badAddress', 'simple.own.needFile',
  'simple.own.url', 'simple.own.urlHint', 'simple.own.urlGo', 'simple.own.addFile', 'simple.own.part', 'simple.own.remove',
  'simple.own.overlap', 'simple.own.wrongDevice', 'simple.own.notAnImage',
  'simple.own.needAddress', 'simple.own.tooFar', 'simple.own.tooMuch', 'simple.own.deviceUnknown', 'simple.own.problem',
  'simple.own.kind.whole', 'simple.own.kind.app', 'simple.own.kind.table', 'simple.own.kind.boot', 'simple.own.kind.otadata', 'simple.own.kind.data',
  'simple.wifi.title', 'simple.wifi.hint', 'simple.wifi.network', 'simple.wifi.password', 'simple.wifi.ok', 'simple.wifi.skip', 'simple.wifi.open',
  'action.wifiSend', 'action.console', 'action.consoleStop',
  'pick.title', 'pick.hint',
  'erase.title', 'erase.textFirst', 'erase.textUpdate', 'erase.textAlways', 'erase.yes', 'erase.no', 'erase.noErase',
  'hint.open', 'hint.close',
];
const get = (o, k) => k.split('.').reduce((x, p) => (x && typeof x === 'object' ? x[p] : undefined), o);

test('every key the page asks for exists in en.json', () => {
  const missing = REQUIRED.filter((k) => typeof get(en, k) !== 'string' || !get(en, k).trim());
  assert.deepEqual(missing, []);
});

/** Codes for parts of the engine that land in later tasks; the strings must already be there. */
const FUTURE_CODES = [
  'manifest.flashSizeMB', 'manifest.usb', 'manifest.filters', 'manifest.fetch',
  'catalog.fetch',
  'serial.cancelled', 'serial.busy', 'serial.lost', 'serial.connect', 'serial.blocked',
  'device.chipUnknown', 'device.flashUnknown', 'device.noMatch', 'device.changed', 'device.secured',
  'device.layout', 'device.notEmpty',
  'backup.mismatch', 'backup.file',
  'flash.erase', 'flash.write', 'flash.verify',
  'engine.load', 'engine.busy', 'engine.unexpected',
];

test('strings for codes the engine will throw later are already present', () => {
  const missing = FUTURE_CODES.filter((c) => typeof en.error?.[c] !== 'string' || !en.error[c].trim());
  assert.deepEqual(missing, []);
});

/** These two are thrown with different parameter shapes, so they must not name a parameter. */
test('verify.empty and verify.part interpolate nothing', () => {
  for (const c of ['verify.empty', 'verify.part']) assert.ok(!/\{/.test(en.error[c]), `${c} must not interpolate`);
});

test('t() leaves an unknown placeholder untouched instead of printing undefined', () => {
  const i18n = createI18n({ en: { k: 'a {x} b' } }, 'en');
  assert.equal(i18n.t('k'), 'a {x} b');
  assert.equal(i18n.t('k', { x: 0 }), 'a 0 b');
});

test('an empty translation counts as missing and falls back to en', () => {
  const i18n = createI18n({ en: { k: 'English' }, pl: { k: '   ' } }, 'pl');
  assert.equal(i18n.t('k'), 'English');
});

test('every error string says what happened and what to do', () => {
  const thin = Object.entries(en.error).filter(([, v]) => (v.match(/[.!?]/g) ?? []).length < 2);
  assert.deepEqual(thin, []);
});

test('the backup hint and the saved-as sentence name the file in both locales', () => {
  assert.match(en.action.chooseBackupHint, /\{file\}/);
  assert.match(readLocale('pl').action.chooseBackupHint, /\{file\}/);
  assert.match(en.simple.backup.saved, /\{file\}/);
  assert.match(readLocale('pl').simple.backup.saved, /\{file\}/);
});

test('no dead error strings: every error.* key in en.json is thrown somewhere in app/', () => {
  const thrown = new Set();
  for (const f of readdirSync(new URL('../app/', import.meta.url))) {
    const src = readFileSync(new URL('../app/' + f, import.meta.url), 'utf8');
    for (const m of src.matchAll(/'([a-z]+\.[A-Za-z0-9]+)'/g)) thrown.add(m[1]);
  }
  const dead = Object.keys(en.error).filter((c) => !thrown.has(c));
  assert.deepEqual(dead, []);
});

/* --- device.layout says what is on the device ---------------------------- */

/**
 * The refusal is decided in `preserve` and is the same in all three cases below; what changes is
 * only the sentence the person reads. These pin which one is chosen, and that nothing is chosen
 * from thin air.
 */
test('layoutStop touches nothing but device.layout', () => {
  for (const code of ['device.notEmpty', 'device.secured', 'flash.verify', 'engine.unexpected']) {
    assert.deepEqual(layoutStop(code, { settingsOffset: 0x9000, settingsSize: 0x6000 }), { code, params: { settingsOffset: 0x9000, settingsSize: 0x6000 } });
  }
});

test('a settings partition that was read becomes the sentence that names it, in both locales', () => {
  const { code, params } = layoutStop('device.layout', { offset: '0x0', size: 0x8000, settingsOffset: 0x9000, settingsSize: 0x6000 });
  assert.equal(code, 'device.layoutFound');
  assert.equal(params.settings, '0x9000');
  assert.equal(params.settingsSize, '24 KB');
  for (const lang of ['en', 'pl']) {
    const { t } = createI18n(lang === 'en' ? { en } : { en, pl: readLocale('pl') }, lang);
    const sentence = t('error.' + code, params);
    assert.match(sentence, /0x9000/, lang);
    assert.match(sentence, /24 KB/, lang);
    assert.doesNotMatch(sentence, /\{/, lang);
  }
});

test('a table that could not be read says that, and a table without settings falls back to the old sentence', () => {
  assert.equal(layoutStop('device.layout', { offset: '0x0', layout: 'unreadable' }).code, 'device.layoutUnreadable');
  assert.equal(layoutStop('device.layout', { offset: '0x0' }).code, 'device.layout', 'nothing read about the device, nothing invented');
  assert.equal(layoutStop('device.layout', { settingsOffset: 0x9000 }).code, 'device.layout', 'half an answer is no answer');
});

/* --- the own-file path speaks its own voice, whatever stops it ------------ */

/**
 * There is no release on `?own=1` and nobody published anything: the person chose the file or
 * typed the address. So no stop on that path may reach for the catalogue's words, including the
 * stops that only happen after a device is connected and that the pre-flight check cannot see.
 */
test('no error code can make the own-file path blame a release nobody published', () => {
  for (const lang of ['en', 'pl']) {
    const dicts = lang === 'en' ? { en } : { en, pl: readLocale('pl') };
    const { t } = createI18n(dicts, lang);
    const leaking = Object.keys(en.error).filter((code) => CATALOGUE_VOICE.test(ownErrorText(t, code, {})));
    assert.deepEqual(leaking, [], lang);
  }
});

test('positive control: the catalogued sentences really do say it, and the useful ones are kept', () => {
  const { t } = createI18n({ en }, 'en');
  assert.ok(CATALOGUE_VOICE.test(en.error['manifest.fetch']), 'the 404 sentence names the release');
  assert.ok(CATALOGUE_VOICE.test(readLocale('pl').error['manifest.fetch']), 'and so does the Polish one');
  assert.equal(ownErrorText(t, 'serial.lost', {}), en.error['serial.lost'], 'a pulled cable reads the same on both paths');
  assert.equal(ownErrorText(t, 'device.secured', {}), en.error['device.secured']);
  assert.notEqual(ownErrorText(t, 'manifest.fetch', {}), en.error['manifest.fetch']);
  assert.match(ownErrorText(t, 'verify.beyondFlash', {}), /device you connected/, 'after connecting, the real memory is known');
  assert.match(t('simple.own.tooFar'), /any device/, 'before connecting, it is not');
});

// Not in REQUIRED above: those keys are read by splitting on every dot, and a stop code is one
// key with a dot inside it. They are pinned here instead, the way the page looks them up.
test('both locales carry a stopped-screen sentence for every code that has one', () => {
  const pl = readLocale('pl');
  for (const c of ['manifest.fetch', 'verify.empty', 'verify.tooLarge', 'verify.beyondFlash', 'verify.totalTooLarge']) {
    assert.equal(typeof en.simple.own.stopped[c], 'string', c);
  }
  assert.deepEqual(Object.keys(pl.simple.own.stopped), Object.keys(en.simple.own.stopped));
  assert.ok(Object.keys(en.simple.own.stopped).every((c) => c in en.error), 'every one names a real stop code');
});

test('catalog.unknownVersion interpolates no version', () => {
  assert.ok(!/\{v\}/.test(en.error['catalog.unknownVersion']));
});

/* --- Polish translation ------------------------------------------------- */

/** Read a locale on demand, so a missing translation fails these tests alone. */
const readLocale = (name) => JSON.parse(readFileSync(new URL(`../locales/${name}.json`, import.meta.url), 'utf8'));
const keysOf = (dict) => flat(dict).map(([k]) => k).sort();
const placeholders = (s) => new Set(String(s).match(/\{\w+\}/g) ?? []);

/** Same gate as the English one, on the words a Polish translation is tempted to reach for. */
const JARGON_PL = /firmware|flash|offset|bootloader|md5|sha|serial|baud|esptool|manifest|chip|partycj|binar|\.bin|flashow/i;

test('pl.json carries exactly the keys of en.json', () => {
  assert.deepEqual(keysOf(readLocale('pl')), keysOf(en));
});

test('every Polish string keeps the placeholders of its English original', () => {
  const pl = new Map(flat(readLocale('pl')));
  const bad = flat(en)
    .map(([k, v]) => [k, [...placeholders(v)].sort().join(''), [...placeholders(pl.get(k) ?? '')].sort().join('')])
    .filter(([, want, got]) => want !== got);
  assert.deepEqual(bad, []);
});

test('Polish simple-layer strings carry no jargon', () => {
  const bad = flat(readLocale('pl')).filter(([k, v]) => SIMPLE.includes(k.split('.')[0]) && JARGON_PL.test(v.replace(DEVICE_NAMES, '')));
  assert.deepEqual(bad, []);
});

test('positive control: Polish jargon in a simple key is caught', () => {
  assert.ok(JARGON_PL.test('Flashuję firmware przez port serial'));
  assert.ok(JARGON_PL.test('Sprawdzam sumę md5 partycji'));
});

test('every Polish error string says what happened and what to do', () => {
  const thin = Object.entries(readLocale('pl').error).filter(([, v]) => (v.match(/[.!?]/g) ?? []).length < 2);
  assert.deepEqual(thin, []);
});
