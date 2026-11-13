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

/** What JSON leaves as it is but a terminal must not get raw: DEL and the C1 controls (U+009B is an escape to some terminals), and the invisible and bidirectional marks */
const UNSEEN = new RegExp('[\\u007f-\\u009f\\u00ad\\u061c\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb]', 'g');

/**
 * A path or a value from the config or from a file of the repo, as a message prints it: a JSON string (`"a/b"`; any
 * other value as `JSON.stringify` writes it), so a line break or an escape character in it is `\n`, `\u001b`, and it
 * cannot forge a line of output; DEL, the C1 controls and the invisible and bidirectional marks, which JSON leaves
 * alone, are written as escapes too (a zero-width joiner or non-joiner among them). Letters and marks of any script, emoji
 * and a non-breaking space are left as they are.
 * @param {unknown} value
 * @returns {string}
 */
export function quote(value) {
  let t;
  try { t = JSON.stringify(value) ?? String(value); } catch { t = String(value); }
  return t.replace(UNSEEN, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
