/**
 * @module explorer/theme-names
 *
 * The named themes of the config (`theme.names`, docs/config.md#theme), the half that touches the page after load. theme-boot.js has
 * already put the pick on <html data-theme-name> before the first paint; this fills the small <select> in the header with the names,
 * and on a change sets the attribute, points the named theme's stylesheet link at it, and keeps the pick in localStorage
 * (THEME_NAME_STORAGE_KEY). A theme is CSS only: nothing here loads anything but a stylesheet from this origin.
 */

import { THEME_NAME_STORAGE_KEY, themeNameFrom, themeNameHref } from './theme-model.js';

function readStored() {
  try { return window.localStorage.getItem(THEME_NAME_STORAGE_KEY); } catch { return null; }
}

function store(name, fallback) {
  try {
    if (name === fallback) window.localStorage.removeItem(THEME_NAME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_NAME_STORAGE_KEY, name);
  } catch { /* storage blocked: the pick still holds for this visit */ }
}

/** Puts a named theme in force on the page ('' for none) */
export function setThemeName(doc, name) {
  const root = doc.documentElement;
  if (name) root.setAttribute('data-theme-name', name); else root.removeAttribute('data-theme-name');
  const link = doc.getElementById('cf-theme-name-css');
  const href = themeNameHref(name);
  if (link) { if (href) link.setAttribute('href', href); else link.removeAttribute('href'); }
}

/**
 * Fills the header's picker from the config (`{ names, default }`, from /cornfield/config.json) and wires it. Hidden when there are no names.
 * @param {Document} doc
 * @param {{ names?: string[], default?: string | null } | null | undefined} theme
 */
export function initThemePicker(doc, theme) {
  const select = doc.getElementById('theme-name-select');
  if (!select) return;
  const names = theme && Array.isArray(theme.names) ? theme.names.filter((n) => themeNameHref(n)) : [];
  if (!names.length) { select.hidden = true; return; }
  const fallback = theme.default && names.includes(theme.default) ? theme.default : '';
  select.textContent = '';
  const add = (value, label) => {
    const o = doc.createElement('option');
    o.value = value;
    o.textContent = label;
    select.appendChild(o);
  };
  if (!fallback) add('', 'Standard');
  for (const n of names) add(n, n);
  const current = themeNameFrom(readStored(), names, fallback);
  setThemeName(doc, current);
  select.value = current;
  select.hidden = false;
  select.onchange = () => {
    const next = names.includes(select.value) ? select.value : '';
    setThemeName(doc, next);
    store(next, fallback);
  };
}
