/**
 * @module explorer/strings
 *
 * The words a repo may say in its own voice (core/strings.js is the table; `strings` in cornfield.config.js the overrides, which
 * `/cornfield/config.json` carries). Every overridable label is read through `t(key)`; the static markup in index.html marks what
 * to replace with `data-corn-string` attributes, which `applyStrings` fills once the config is in.
 *
 *   data-corn-string="key"                the element's text
 *   data-corn-string-aria-label="key"     its aria-label
 *   data-corn-string-placeholder="key"    its placeholder
 *
 * The rule for accessible names: a control's name is its visible label. When a key is overridden the visible text and the
 * aria-label carry the same words, and where a name adds a fixed target ("Stop run 7") only the label part is replaced
 * ("Halt run 7"). So a screen reader says what is on the screen.
 *
 * Values are only ever set through textContent and attributes, never as HTML, and a value that fails core/strings.js
 * `stringProblem` (not text, a line break, too long) is ignored here as well, whatever the server sent.
 */

import { STRINGS, isStringKey, stringProblem } from '../core/strings.js';

/** The overrides in force: key -> text */
let overrides = {};

/**
 * Takes the overrides the config carries (`config.strings`). Anything that is not a known key with good text is left out.
 * @param {unknown} strings
 */
export function setStrings(strings) {
  overrides = {};
  if (!strings || typeof strings !== 'object' || Array.isArray(strings)) return;
  for (const [key, value] of Object.entries(strings)) if (isStringKey(key) && !stringProblem(value)) overrides[key] = value;
}

/** Whether the config overrides this key */
export const isOverridden = (key) => Object.hasOwn(overrides, key);

/** The words for a key: the override, else the default. A key that is not in the table gives the key itself (a test keeps the code to the table). */
export function t(key) {
  if (Object.hasOwn(overrides, key)) return overrides[key];
  return isStringKey(key) ? STRINGS[key] : String(key);
}

const TARGETS = [
  ['data-corn-string', (el, text) => { el.textContent = text; }],
  ['data-corn-string-aria-label', (el, text) => el.setAttribute('aria-label', text)],
  ['data-corn-string-placeholder', (el, text) => el.setAttribute('placeholder', text)],
];

/**
 * Puts the overrides in the static markup. Only an overridden key touches its element, so what index.html says is what shows
 * without one.
 * @param {ParentNode} root
 */
export function applyStrings(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  for (const [attr, set] of TARGETS) {
    for (const el of root.querySelectorAll(`[${attr}]`)) {
      const key = el.getAttribute(attr);
      if (isOverridden(key)) set(el, overrides[key]);
    }
  }
}

/** For tests: forget the overrides */
export function resetStringsForTests() {
  overrides = {};
}
