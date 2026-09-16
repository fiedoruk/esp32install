/**
 * Light or dark, by hand. theme.css follows the system setting until <html data-theme> says
 * otherwise; theme-init.js restores a stored choice before the first paint, and this module
 * wires the two header buttons. Storage may be unavailable (private mode, blocked site data):
 * the choice then lasts for this page, and the buttons still work.
 */
const KEY = 'theme';
const THEMES = ['light', 'dark'];

/** What the system asks for right now. */
export function systemTheme(win) {
  try { return win.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light'; } catch { return 'light'; }
}

/** A stored choice, or null when there is none or storage cannot be read. */
export function storedTheme(storage) {
  try { const v = storage?.getItem(KEY); return THEMES.includes(v) ? v : null; } catch { return null; }
}

/** The theme the page shows: the attribute when set, the system setting otherwise. */
export function currentTheme(doc, win) {
  const v = doc.documentElement.getAttribute('data-theme');
  return THEMES.includes(v) ? v : systemTheme(win);
}

/** Sets the attribute and tries to remember the choice; a storage failure is not an error. */
export function applyTheme(name, doc, storage) {
  if (!THEMES.includes(name)) return;
  doc.documentElement.setAttribute('data-theme', name);
  try { storage?.setItem(KEY, name); } catch { /* the choice lasts for this page */ }
}

/**
 * `buttons` maps a theme name to its button. `aria-pressed` on each button follows the theme
 * the page shows, so with nothing stored the pressed one moves with the system setting.
 */
export function mountThemeToggle({ buttons, doc = document, win = window, storage }) {
  let store = storage;
  if (store === undefined) { try { store = win.localStorage; } catch { store = null; } }
  const reflect = () => {
    const current = currentTheme(doc, win);
    for (const [name, btn] of Object.entries(buttons)) btn.setAttribute('aria-pressed', String(name === current));
  };
  for (const [name, btn] of Object.entries(buttons)) {
    btn.addEventListener('click', () => { applyTheme(name, doc, store); reflect(); });
  }
  try { win.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', reflect); } catch { /* no media queries: nothing to follow */ }
  reflect();
  return { reflect };
}
