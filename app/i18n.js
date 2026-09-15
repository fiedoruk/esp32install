/**
 * Tiny i18n for the installer. English is the source language: every key exists in `en`,
 * other languages may translate a subset and fall back key by key.
 */

/** Pick a language: page markup wins, then `?lang=`, then the browser, then English. */
export function detectLang({ htmlLang = '', query = '', navigatorLanguages = [], available = ['en'] } = {}) {
  const norm = (s) => String(s ?? '').toLowerCase().split('-')[0];
  const ok = (l) => (available.includes(l) ? l : null);
  return ok(norm(htmlLang)) ?? ok(norm(query)) ?? navigatorLanguages.map(norm).map(ok).find(Boolean) ?? 'en';
}

/**
 * Walk the dotted key, but at every node try the rest of the key literally first: error codes are
 * stored whole (`error` → `'manifest.url'`), so splitting on every dot alone would never find them.
 * Anything that does not end on a non-empty string counts as missing, so a namespace object or an
 * untranslated empty string falls through to the next dictionary.
 */
const lookup = (dict, key) => {
  let node = dict;
  const segments = key.split('.');
  for (let i = 0; i < segments.length; i++) {
    if (node === null || typeof node !== 'object') return undefined;
    const rest = segments.slice(i).join('.');
    if (rest in node) return typeof node[rest] === 'string' && node[rest].trim() ? node[rest] : undefined;
    node = node[segments[i]];
  }
  return typeof node === 'string' && node.trim() ? node : undefined;
};

/**
 * `t(key, vars)` returns plain text: `{name}` is replaced with the value as text, never as markup,
 * and an unknown placeholder is left as written so a missing value is visible instead of "undefined".
 */
export function createI18n(dicts, lang) {
  const t = (key, vars = {}) => {
    const raw = lookup(dicts[lang], key) ?? lookup(dicts.en, key) ?? key;
    return String(raw).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
  };
  return { t, lang };
}
