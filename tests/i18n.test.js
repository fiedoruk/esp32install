import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { detectLang, createI18n } from '../app/i18n.js';

const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));

test('detectLang order: ?lang, html lang, navigator, fallback en', () => {
  const available = ['en', 'pl'];
  assert.equal(detectLang({ htmlLang: 'pl', query: 'en', navigatorLanguages: ['de'], available }), 'en', '/pl/…?lang=en gives English');
  assert.equal(detectLang({ htmlLang: 'pl', query: '', navigatorLanguages: ['en-US'], available }), 'pl', '/pl/ gives Polish to an English browser');
  assert.equal(detectLang({ htmlLang: '', query: 'pl', navigatorLanguages: ['de'], available }), 'pl');
  assert.equal(detectLang({ htmlLang: '', query: '', navigatorLanguages: ['pl-PL', 'en'], available }), 'pl');
  assert.equal(detectLang({ htmlLang: 'de', query: 'xx', navigatorLanguages: ['de-DE'], available }), 'en');
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

const SIMPLE = ['simple', 'door', 'stage', 'result', 'gate', 'action'];
const JARGON = /\b(firmware|flash(ing|ed)?|offset|bootloader|md5|sha-?256|serial|baud|esptool|manifest|chip|partition|erase-all|binary|\.bin)\b/i;
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => typeof v === 'object' ? flat(v, p + k + '.') : [[p + k, v]]);

test('simple-layer strings carry no jargon', () => { const bad = flat(en).filter(([k, v]) => SIMPLE.includes(k.split('.')[0]) && JARGON.test(v)); assert.deepEqual(bad, []); });

test('positive control: jargon in a simple key is caught', () => { assert.ok(JARGON.test('Flashing the firmware now')); });

/** Keys the page and the engine ask for by name. Dropping one breaks the UI silently. */
const REQUIRED = [
  'app.title', 'app.subtitle', 'app.notDetected',
  'app.stage', 'app.copyLog', 'app.showLog', 'app.hideLog', 'app.language',
  'door.title', 'door.first', 'door.firstHint', 'door.update', 'door.updateHint', 'door.updateHintOwn',
  'gate.insecure', 'gate.noSerial', 'gate.altFirst',
  'action.connect', 'action.connecting', 'action.installing', 'action.retry',
  'action.cancel', 'action.backup', 'action.saveBackup', 'action.chooseBackup', 'action.chooseBackupTitle', 'action.chooseBackupHint', 'action.erase',
  'action.theme', 'action.themeLight', 'action.themeDark',
  'stage.idle', 'stage.connecting', 'stage.detecting', 'stage.matching', 'stage.downloading',
  'stage.verifying', 'stage.checkingDevice', 'stage.backup', 'stage.erasing', 'stage.writing',
  'stage.md5', 'stage.done', 'stage.error', 'stage.local',
  'eta.left', 'eta.leftMin',
  'result.ok', 'result.stopped',
  'board.pick', 'board.pickHint',
  'alt.title', 'alt.cmd', 'alt.files', 'alt.drivers', 'alt.guide',
  'simple.prepare.title', 'simple.prepare.hintCable', 'simple.prepare.hintDoor', 'simple.prepare.hintBackup',
  'simple.install.keepCable', 'simple.backup.save', 'simple.backup.saved', 'simple.done.title', 'simple.done.next', 'simple.done.again', 'simple.stopped.title',
  'tech.title', 'tech.chip', 'tech.flash', 'tech.board', 'tech.release', 'tech.checksum', 'tech.log', 'tech.file',
  'simple.own.title', 'simple.own.instead', 'simple.own.hint', 'simple.own.choose', 'simple.own.read', 'simple.own.where',
  'simple.own.whole', 'simple.own.wholeHint', 'simple.own.app', 'simple.own.appHint', 'simple.own.address', 'simple.own.device',
  'simple.own.pickDevice', 'simple.own.plan', 'simple.own.unknownDevice', 'simple.own.badAddress',
  'pick.title', 'pick.hint',
  'erase.title', 'erase.textFirst', 'erase.textUpdate', 'erase.yes', 'erase.no',
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
  const bad = flat(readLocale('pl')).filter(([k, v]) => SIMPLE.includes(k.split('.')[0]) && JARGON_PL.test(v));
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
