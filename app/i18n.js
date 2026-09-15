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

const lookup = (dict, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), dict);

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
