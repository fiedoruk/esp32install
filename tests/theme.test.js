/**
 * The theme buttons, driven through fakes: no DOM here. `theme-init.js` is checked as text in
 * ui.static.test.js; this file covers app/theme.js, which the buttons call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemTheme, storedTheme, currentTheme, applyTheme, mountThemeToggle } from '../app/theme.js';

function fakeDoc(initial) {
  const attrs = new Map(initial ? [['data-theme', initial]] : []);
  return { documentElement: { getAttribute: (k) => attrs.get(k) ?? null, setAttribute: (k, v) => attrs.set(k, v) }, attrs };
}
function fakeButton() {
  const attrs = new Map();
  const handlers = [];
  return {
    attrs,
    setAttribute: (k, v) => attrs.set(k, v),
    getAttribute: (k) => attrs.get(k) ?? null,
    addEventListener: (type, fn) => { if (type === 'click') handlers.push(fn); },
    click: () => handlers.forEach((fn) => fn()),
  };
}
function fakeWin({ dark = false, storage = new Map(), throwsOnStorage = false } = {}) {
  const listeners = [];
  const mq = { matches: dark, addEventListener: (t, fn) => listeners.push(fn) };
  const win = {
    matchMedia: () => mq,
    flip() { mq.matches = !mq.matches; listeners.forEach((fn) => fn()); },
  };
  if (throwsOnStorage) Object.defineProperty(win, 'localStorage', { get() { throw new Error('SecurityError'); } });
  else win.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  return { win, storage, mq };
}

test('systemTheme reads prefers-color-scheme and falls back to light without matchMedia', () => {
  assert.equal(systemTheme(fakeWin({ dark: true }).win), 'dark');
  assert.equal(systemTheme(fakeWin({ dark: false }).win), 'light');
  assert.equal(systemTheme({}), 'light');
  assert.equal(systemTheme({ matchMedia: () => { throw new Error('no'); } }), 'light');
});

test('storedTheme accepts only light or dark and swallows a storage that throws', () => {
  assert.equal(storedTheme({ getItem: () => 'dark' }), 'dark');
  assert.equal(storedTheme({ getItem: () => 'purple' }), null);
  assert.equal(storedTheme({ getItem: () => null }), null);
  assert.equal(storedTheme({ getItem: () => { throw new Error('blocked'); } }), null);
  assert.equal(storedTheme(null), null);
});

test('currentTheme is the attribute when set, the system setting otherwise', () => {
  const { win } = fakeWin({ dark: true });
  assert.equal(currentTheme(fakeDoc(), win), 'dark');
  assert.equal(currentTheme(fakeDoc('light'), win), 'light');
  assert.equal(currentTheme(fakeDoc('bogus'), win), 'dark');
});

test('applyTheme sets the attribute, stores the choice, and ignores a storage that throws', () => {
  const doc = fakeDoc();
  const stored = new Map();
  applyTheme('dark', doc, { setItem: (k, v) => stored.set(k, v) });
  assert.equal(doc.attrs.get('data-theme'), 'dark');
  assert.equal(stored.get('theme'), 'dark');
  applyTheme('light', doc, { setItem: () => { throw new Error('QuotaExceededError'); } });
  assert.equal(doc.attrs.get('data-theme'), 'light', 'the page still switches');
  applyTheme('purple', doc, { setItem: () => { throw new Error('never called'); } });
  assert.equal(doc.attrs.get('data-theme'), 'light', 'an unknown name changes nothing');
  applyTheme('dark', doc, null);
  assert.equal(doc.attrs.get('data-theme'), 'dark');
});

test('with nothing stored the pressed button follows the system and moves when the system changes', () => {
  const { win } = fakeWin({ dark: false });
  const doc = fakeDoc();
  const light = fakeButton(), dark = fakeButton();
  mountThemeToggle({ buttons: { light, dark }, doc, win });
  assert.equal(light.getAttribute('aria-pressed'), 'true');
  assert.equal(dark.getAttribute('aria-pressed'), 'false');
  win.flip();
  assert.equal(light.getAttribute('aria-pressed'), 'false');
  assert.equal(dark.getAttribute('aria-pressed'), 'true');
  assert.equal(doc.attrs.has('data-theme'), false, 'following the system sets no attribute');
});

test('a click sets data-theme, stores it, presses that button and stops following the system', () => {
  const { win, storage } = fakeWin({ dark: false });
  const doc = fakeDoc();
  const light = fakeButton(), dark = fakeButton();
  mountThemeToggle({ buttons: { light, dark }, doc, win });
  dark.click();
  assert.equal(doc.attrs.get('data-theme'), 'dark');
  assert.equal(storage.get('theme'), 'dark');
  assert.equal(dark.getAttribute('aria-pressed'), 'true');
  assert.equal(light.getAttribute('aria-pressed'), 'false');
  win.flip(); // system now dark; then flip back to light: the choice must hold
  win.flip();
  assert.equal(dark.getAttribute('aria-pressed'), 'true');
  light.click();
  assert.equal(doc.attrs.get('data-theme'), 'light');
  assert.equal(storage.get('theme'), 'light');
  assert.equal(light.getAttribute('aria-pressed'), 'true');
});

test('a stored choice restored by theme-init.js is reflected on mount', () => {
  const { win } = fakeWin({ dark: false });
  const doc = fakeDoc('dark');
  const light = fakeButton(), dark = fakeButton();
  mountThemeToggle({ buttons: { light, dark }, doc, win });
  assert.equal(dark.getAttribute('aria-pressed'), 'true');
  assert.equal(light.getAttribute('aria-pressed'), 'false');
});

test('a window whose localStorage throws on access (blocked site data) still toggles for this page', () => {
  const { win } = fakeWin({ dark: false, throwsOnStorage: true });
  const doc = fakeDoc();
  const light = fakeButton(), dark = fakeButton();
  assert.doesNotThrow(() => mountThemeToggle({ buttons: { light, dark }, doc, win }));
  dark.click();
  assert.equal(doc.attrs.get('data-theme'), 'dark');
  assert.equal(dark.getAttribute('aria-pressed'), 'true');
});
