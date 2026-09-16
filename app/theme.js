/**
 * Light or dark, by hand. theme.css follows the system setting until <html data-theme> says
 * otherwise; theme-init.js restores a stored choice before the first paint, and this module
 * wires the two header buttons and keeps the browser's own bar in step with them. Storage may be
 * unavailable (private mode, blocked site data): the choice then lasts for this page, and the
 * buttons still work.
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
 * The colour of the browser's own bar around the page, on a phone.
 *
 * `index.html` ships two `theme-color` tags that follow the phone's setting through `media`, and
 * that is right until somebody presses a button here: a `<meta>` is read once and a media query
 * has no way to know about a choice made inside the page. So this writes the current colour into
 * a tag of its own, put **first** in the head, because the browser takes the first `theme-color`
 * whose media matches and the shipped pair has to stay behind it as the fallback for a page whose
 * scripts never ran.
 *
 * The value is read out of the stylesheet — `--bg`, the colour of the field the plate lies on —
 * so it cannot drift from what the page is actually painted with.
 *
 * Everything here is best effort. A bar that cannot be coloured is not a reason for anything.
 */
export function paintBar(doc, win) {
  try {
    const bg = String(win.getComputedStyle?.(doc.documentElement)?.getPropertyValue?.('--bg') ?? '').trim();
    if (!bg) return null;
    let tag = doc.querySelector?.('meta[name="theme-color"][data-live]');
    if (!tag) {
      tag = doc.createElement?.('meta');
      if (!tag || !doc.head) return null;
      tag.setAttribute('name', 'theme-color');
      tag.setAttribute('data-live', '');
      (doc.head.prepend ?? doc.head.append)?.call(doc.head, tag);
    }
    tag.setAttribute('content', bg);
    return bg;
  } catch {
    return null; // no computed styles, no head, a document that is not one: the bar keeps the pair
  }
}

/**
 * `buttons` maps a theme name to its button. `aria-pressed` on each button follows the theme
 * the page shows, so with nothing stored the pressed one moves with the system setting, and so
 * does the browser bar.
 */
export function mountThemeToggle({ buttons, doc = document, win = window, storage }) {
  let store = storage;
  if (store === undefined) { try { store = win.localStorage; } catch { store = null; } }
  const reflect = () => {
    const current = currentTheme(doc, win);
    for (const [name, btn] of Object.entries(buttons)) btn.setAttribute('aria-pressed', String(name === current));
    paintBar(doc, win);
  };
  for (const [name, btn] of Object.entries(buttons)) {
    btn.addEventListener('click', () => { applyTheme(name, doc, store); reflect(); });
  }
  try { win.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', reflect); } catch { /* no media queries: nothing to follow */ }
  reflect();
  return { reflect };
}
