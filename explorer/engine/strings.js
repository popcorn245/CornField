/**
 * @module explorer/engine/strings
 *
 * The words a repo may say in its own voice (core/strings.js is the table; `strings` in cornfield.config.js the overrides, which
 * `/cornfield/config.json` carries), on an instance: `inst.strings` holds the overrides (key -> text), so two instances on one page can
 * speak in two voices. Every overridable label is read through `t(inst, key)`; the markup of a piece marks what to replace with
 * `data-corn-string` attributes, which `applyStrings` fills once the words are in.
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
 * `stringProblem` (not text, a line break, too long) is ignored here as well, whatever the host sent.
 * explorer/strings.js keeps the old names for the page's instance (a bridge).
 */
import { STRINGS, isStringKey, stringProblem } from '../../core/strings.js';

/** Whether the instance overrides this key with good text */
export const isOverridden = (inst, key) => isStringKey(key) && Object.hasOwn(inst.strings, key) && !stringProblem(inst.strings[key]);

/**
 * Takes the overrides a host carries (`config.strings`) in place of the instance's. Anything that is not a known key with good text is left out.
 * @param {{ strings: Record<string, string> }} inst
 * @param {unknown} strings
 */
export function setStrings(inst, strings) {
  for (const key of Object.keys(inst.strings)) delete inst.strings[key];
  if (!strings || typeof strings !== 'object' || Array.isArray(strings)) return;
  for (const [key, value] of Object.entries(strings)) if (isStringKey(key) && !stringProblem(value)) inst.strings[key] = value;
}

/** The words for a key: the override, else the default. A key that is not in the table gives the key itself (a test keeps the code to the table). */
export function t(inst, key) {
  if (isOverridden(inst, key)) return inst.strings[key];
  return isStringKey(key) ? STRINGS[key] : String(key);
}

const TARGETS = [
  ['data-corn-string', (el, text) => { el.textContent = text; }],
  ['data-corn-string-aria-label', (el, text) => el.setAttribute('aria-label', text)],
  ['data-corn-string-placeholder', (el, text) => el.setAttribute('placeholder', text)],
];

/**
 * Puts the instance's overrides in the markup under `root` (default: the instance's own root). Only an overridden key touches its element,
 * so what the markup says is what shows without one.
 * @param {{ strings: Record<string, string>, root: ParentNode | null }} inst
 * @param {ParentNode} [scope]
 */
export function applyStrings(inst, scope = inst.root) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return;
  for (const [attr, set] of TARGETS) {
    for (const el of scope.querySelectorAll(`[${attr}]`)) {
      const key = el.getAttribute(attr);
      if (isOverridden(inst, key)) set(el, inst.strings[key]);
    }
  }
}
