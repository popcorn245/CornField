/**
 * @module explorer/panel-sections
 *
 * The node panel's sections and its ⋯ menu on an instance (spec 0015 D4): a section's title opens and closes it, and which are open is remembered per kind
 * of node in the browser (`localStorage`, every read and write in a try: a private window, or storage turned off, only means nothing is remembered);
 * the ⋯ of the action bar shows the rest of the actions, Escape closes it with the focus back on ⋯. The markup is panel-model.js's.
 *
 *   applySections(inst, root, kind)   puts what was remembered for `kind` on every section under `root` (after it is drawn)
 *   onSectionsClick(inst, e, kind)    a click in the panel: a section's title, a count that opens its rows, ⋯, an action in the menu; true when it was one of the first three
 *   onSectionsKey(e)                  Escape in an open menu closes it; true when it did
 *   menuOpen(root), reopenMenu(root)  whether the ⋯ menu under `root` is open, and opening it again after the bar was drawn anew
 */

import { SECTIONS_KEY, isOpen, readPrefs, withOpen } from './panel-model.js';

const storeOf = (inst) => {
  try { return inst && inst.win && inst.win.localStorage ? inst.win.localStorage : null; } catch { return null; }
};

/** What the browser remembers of the sections (nothing, when it cannot say) */
export function loadPrefs(inst) {
  try {
    const store = storeOf(inst);
    return readPrefs(store ? store.getItem(SECTIONS_KEY) : '');
  } catch {
    return {};
  }
}

function savePrefs(inst, prefs) {
  try {
    const store = storeOf(inst);
    if (store) store.setItem(SECTIONS_KEY, JSON.stringify(prefs));
  } catch { /* nothing is remembered: the section is open or closed for now */ }
}

const bodyOf = (toggle) => {
  const block = toggle.closest('[data-sec]');
  return block ? [...block.children].find((c) => c.classList && c.classList.contains('hx-sec-body')) || null : null;
};

function setSection(toggle, open) {
  toggle.setAttribute('aria-expanded', String(open));
  const body = bodyOf(toggle);
  if (body) body.hidden = !open;
}

/** Each section under `root` as `kind`'s were left (else as it was drawn: closed unless it holds the action) */
export function applySections(inst, root, kind) {
  if (!root || !kind || typeof root.querySelectorAll !== 'function') return;
  const prefs = loadPrefs(inst);
  for (const toggle of root.querySelectorAll('[data-sec-toggle]')) setSection(toggle, isOpen(prefs, kind, toggle.dataset.secToggle, toggle.dataset.secDefault === 'true'));
}

function setMenu(toggle, open, { focus = false } = {}) {
  const box = toggle.closest('.hx-actions-more');
  const menu = box && box.querySelector('[data-more-menu]');
  if (!menu) return;
  toggle.setAttribute('aria-expanded', String(open));
  menu.hidden = !open;
  if (open && focus) {
    const first = [...menu.querySelectorAll('button, a[href]')].find((el) => !el.hidden && !el.disabled);
    if (first) first.focus();
  }
}

/** Closes every open ⋯ menu under `root` */
function closeMenus(root, except = null) {
  for (const t of root.querySelectorAll('[data-more-toggle][aria-expanded="true"]')) if (t !== except) setMenu(t, false);
}

/** Whether a ⋯ menu under `root` is open */
export const menuOpen = (root) => !!(root && root.querySelector('[data-more-toggle][aria-expanded="true"]'));

/** Opens the ⋯ menu under `root` again (its bar was drawn anew while it was open) */
export function reopenMenu(root) {
  const toggle = root && root.querySelector('[data-more-toggle]');
  if (toggle) setMenu(toggle, true);
}

/**
 * A click in the panel. A section's title opens or closes it and the browser remembers it for `kind`; ⋯ opens or closes its menu (the focus goes to the first action in it);
 * an action in the menu closes the menu once its own click is heard (it is the same button it always was); a click anywhere else closes an open menu.
 * @returns {boolean} whether it was a section's title or ⋯ (nothing else need hear it)
 */
export function onSectionsClick(inst, e, kind) {
  const t = e.target && e.target.closest ? e.target : null;
  if (!t) return false;
  const root = e.currentTarget && e.currentTarget.querySelectorAll ? e.currentTarget : t.ownerDocument;
  const toggle = t.closest('[data-sec-toggle]');
  if (toggle) {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    setSection(toggle, open);
    if (kind) savePrefs(inst, withOpen(loadPrefs(inst), kind, toggle.dataset.secToggle, open));
    return true;
  }
  // A count that opens its rows (a group of Connected, History's specs and issues): the list after it
  const sub = t.closest('[data-sub-toggle]');
  if (sub) {
    const open = sub.getAttribute('aria-expanded') !== 'true';
    sub.setAttribute('aria-expanded', String(open));
    const list = sub.nextElementSibling;
    if (list) list.hidden = !open;
    return true;
  }
  const more = t.closest('[data-more-toggle]');
  if (more) {
    const open = more.getAttribute('aria-expanded') !== 'true';
    closeMenus(root, more);
    setMenu(more, open, { focus: open });
    return true;
  }
  const inMenu = t.closest('[data-more-menu]');
  if (inMenu) {
    const box = inMenu.closest('.hx-actions-more');
    const back = box && box.querySelector('[data-more-toggle]');
    // after the action's own listeners (they are on the panel's root, which hears it later): the menu goes, the focus is not left on a hidden button
    setTimeout(() => {
      if (!back || !back.isConnected) return;
      const had = inMenu.contains(back.ownerDocument.activeElement);
      setMenu(back, false);
      if (had) back.focus();
    }, 0);
    return false;
  }
  closeMenus(root);
  return false;
}

/** Escape in an open ⋯ menu (or on ⋯ while it is open) closes it, with the focus back on ⋯; the panel's own Escape does not follow */
export function onSectionsKey(e) {
  if (e.key !== 'Escape' || e.defaultPrevented || !e.target || !e.target.closest) return false;
  const box = e.target.closest('.hx-actions-more');
  const toggle = box && box.querySelector('[data-more-toggle]');
  if (!toggle || toggle.getAttribute('aria-expanded') !== 'true') return false;
  e.preventDefault();
  setMenu(toggle, false);
  toggle.focus();
  return true;
}
