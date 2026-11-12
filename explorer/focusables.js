/**
 * The one list of what the keyboard can stop on, shared by every dialog that keeps the focus inside itself
 * (Review tokens, Start an agent, the confirm step, the mockup window). A trap that names its own selector leaves
 * something out (the Kind of token select once), so they all ask here.
 */

/** Every control a Tab can land on: links, buttons, fields, selects, summaries, frames and anything with a tabindex that is not -1 */
export const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/**
 * The stops inside `root`, in DOM order: not disabled, not hidden, not inert and not under a hidden or inert ancestor.
 * @param {Element} root
 * @returns {HTMLElement[]}
 */
export function focusableIn(root) {
  if (!root) return [];
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && !el.closest('[hidden], [inert]') && el.getAttribute('tabindex') !== '-1');
}

/**
 * Keeps a Tab inside `root`: from the last stop it goes to the first, and Shift+Tab the other way round.
 * @param {KeyboardEvent} e a keydown; nothing happens unless it is a Tab
 * @param {Element} root
 * @returns {boolean} whether it handled the key
 */
export function trapTab(e, root) {
  if (e.key !== 'Tab') return false;
  const stops = focusableIn(root);
  e.preventDefault();
  if (!stops.length) return true;
  const at = stops.indexOf(root.getRootNode().activeElement); // the focus in the dialog's own tree: a shadow root's, not the host's
  const next = e.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at === -1 || at === stops.length - 1 ? 0 : at + 1);
  stops[next].focus();
  return true;
}
