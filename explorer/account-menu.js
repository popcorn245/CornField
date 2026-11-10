/**
 * @module explorer/account-menu
 *
 * The one menu at the right of the header (`#account-btn` and `#account-menu`): who is signed in, Theme, Freeform layout, Review tokens,
 * Proposals, the links, Sign out, and what powers it. A disclosure: `aria-expanded` says whether it is open, Escape closes it with
 * the focus back on the button, and a click outside it or a Tab out of it closes it too. What fills it is in plugins.js (the person, the links,
 * the footer), theme.js (the Theme segment), main.js (Freeform), proposal.js (the list of proposals) and review-tokens.js.
 */

const $ = (id) => document.getElementById(id);

/** Whether the menu is open */
export function accountMenuOpen() {
  const menu = $('account-menu');
  return !!menu && !menu.hidden;
}

function set(open) {
  const menu = $('account-menu');
  const btn = $('account-btn');
  if (menu) menu.hidden = !open;
  if (btn) btn.setAttribute('aria-expanded', String(open));
}

/** Opens the menu */
export function openAccountMenu() {
  set(true);
}

/**
 * Closes the menu
 * @param {{ restoreFocus?: boolean }} [opts] the focus goes back to the button (the default), unless something else takes it (a dialog)
 */
export function closeAccountMenu({ restoreFocus = true } = {}) {
  if (!accountMenuOpen()) return;
  const had = !!document.activeElement && !!$('account-menu') && $('account-menu').contains(document.activeElement);
  set(false);
  const btn = $('account-btn');
  if (restoreFocus && btn && had) btn.focus();
}

function onClick(e) {
  const btn = $('account-btn');
  const menu = $('account-menu');
  if (!btn || !menu) return;
  const target = e.target;
  if (btn.contains(target)) {
    if (accountMenuOpen()) closeAccountMenu(); else openAccountMenu();
    return;
  }
  if (!accountMenuOpen()) return;
  if (!menu.contains(target)) { closeAccountMenu({ restoreFocus: false }); return; }
  // What opens something of its own takes the focus there; a link or a proposal chosen ends the menu. Theme, Freeform and the list of proposals keep it open
  const item = target.closest ? target.closest('#tokens-btn, [data-action="open-proposal"], a[href], [data-corn="sign-out"]') : null;
  if (!item) return;
  closeAccountMenu({ restoreFocus: !item.matches('#tokens-btn') });
}

function onKey(e) {
  if (e.key !== 'Escape' || !accountMenuOpen()) return;
  e.preventDefault();
  closeAccountMenu();
}

/** Leaving the menu with Tab closes it (focus is not left on a hidden control) */
function onFocusOut(e) {
  const menu = $('account-menu');
  const btn = $('account-btn');
  if (!accountMenuOpen() || !e.relatedTarget) return;
  if (!menu.contains(e.relatedTarget) && !btn.contains(e.relatedTarget)) closeAccountMenu({ restoreFocus: false });
}

let wired = false;
/** Wires the button and the menu, once (main.js) */
export function initAccountMenu() {
  if (wired) return;
  wired = true;
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  const root = $('account-btn') && $('account-btn').parentElement;
  if (root) root.addEventListener('focusout', onFocusOut);
}

/** For tests: wire again on a fresh page */
export function resetAccountMenuForTests() {
  document.removeEventListener('click', onClick);
  document.removeEventListener('keydown', onKey);
  wired = false;
}
