/**
 * @module core/text
 *
 * The one HTML escaper. It imports nothing, so Node and the browser load the same file, and every
 * module that draws markup uses it instead of a private copy.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escapes a value for an HTML text node or a quoted attribute: `& < > " '`. `null` and
 * `undefined` become '' (never "null"); any other value is turned into text first.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}
