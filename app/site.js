/**
 * Who is publishing this copy. The installer is meant to be put on other people's servers, so
 * nothing in `app/`, `style.css` or `locales/` may name a site, a brand or an address: all of that
 * lives in `site.json`, which belongs to the deployment exactly as `catalog.json` does.
 *
 * The file is optional in the strongest sense. Missing, unreachable, malformed, or full of links
 * this page will not follow — in every one of those cases the page keeps the one-line footer that
 * ships in `index.html` and nothing else changes. An installer that cannot install because its
 * footer failed to load would be an absurd thing to build.
 */
import { safeHref } from './catalog.js';

/** The installer's own version. Kept in step with package.json by tests/ui.static.test.js. */
export const VERSION = '0.1.0';

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) => (Array.isArray(v) ? v : []);

/**
 * One entry. The words are what matters, so an address this page will not follow costs the link
 * and not the line: `safeHref` keeps `https:` and paths of this site, and drops everything else —
 * `javascript:`, `data:`, a downgrade to `http:`, an address on another host by way of `//`.
 */
function entry(raw) {
  const label = text(raw?.text);
  return label ? { text: label, href: safeHref(raw?.href) } : null;
}

/**
 * The file as the footer will use it, or `null` when there is nothing in it worth drawing.
 * A column with no surviving link is dropped rather than rendered as an empty heading.
 */
export function normalizeSite(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const columns = list(raw.columns)
    .map((c) => ({ title: text(c?.title), links: list(c?.links).map(entry).filter(Boolean) }))
    .filter((c) => c.links.length > 0);
  const bottom = list(raw.bottom).map(entry).filter(Boolean);
  const site = { brand: text(raw.brand), tagline: text(raw.tagline), columns, bottom };
  return site.brand || site.tagline || columns.length || bottom.length ? site : null;
}

const el = (tag, cls, txt) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (txt) node.textContent = txt;
  return node;
};

const link = ({ text: label, href }) => {
  const node = el(href ? 'a' : 'span', null, label);
  if (href) { node.href = href; node.rel = 'noopener'; }
  return node;
};

/** The product's own mark again, small: the same signet and the same word as the header. */
function mark(doc) {
  const row = el('p', 'foot-mark');
  for (const sel of ['.brand .signet', '.brand .word']) {
    const found = doc.querySelector(sel);
    if (found) row.append(found.cloneNode(true));
  }
  return row;
}

/** Draws `site` into `foot`, replacing whatever was there. Nothing here builds markup from text. */
export function renderFooter(foot, site, doc = document) {
  while (foot.firstChild) foot.removeChild(foot.firstChild);
  foot.classList.add('is-site');
  if (site.brand) foot.append(el('p', 'foot-brand', site.brand));
  if (site.tagline) foot.append(el('p', 'foot-tagline', site.tagline));
  if (site.columns.length) {
    const cols = el('div', 'foot-cols');
    for (const column of site.columns) {
      const section = el('section', 'foot-col');
      if (column.title) section.append(el('h2', null, column.title));
      const ul = el('ul');
      for (const one of column.links) {
        const li = document.createElement('li');
        li.append(link(one));
        ul.append(li);
      }
      section.append(ul);
      cols.append(section);
    }
    foot.append(cols);
  }
  const end = el('div', 'foot-end');
  end.append(mark(doc), el('span', 'foot-version', VERSION));
  if (site.bottom.length) {
    const ul = el('ul', 'foot-bottom');
    for (const one of site.bottom) {
      const li = document.createElement('li');
      li.append(link(one));
      ul.append(li);
    }
    end.append(ul);
  }
  foot.append(end);
}

/**
 * Fetches `site.json` next to this page and draws it. `load` is main.js's own JSON reader, so the
 * file goes through the same size cap and the same same-origin path as the catalog. Returns
 * whether the footer changed; every failure is a quiet `false`.
 */
export async function mountFooter(load, doc = document) {
  const foot = doc.querySelector('footer.foot');
  if (!foot) return false;
  try {
    const site = normalizeSite(await load(new URL('site.json', doc.baseURI).href));
    if (!site) return false;
    renderFooter(foot, site, doc);
    return true;
  } catch {
    return false; // no site.json, a broken one, or one too big: the one-line footer stays
  }
}
