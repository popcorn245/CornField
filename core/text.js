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

/** The characters a terminal or a log must not get raw: the C0 controls (a line break among them), DEL, the C1 controls (U+009B is an escape to some terminals), and the invisible and bidirectional marks that could make a line read as something it is not */
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb]', 'g');
const ESCAPED = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
const escapeUnsafe = (s) => s.replace(UNSAFE, (c) => ESCAPED[c] || `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * A path or a value from the config or from a file of the repo, as a message may print it: the one helper for that. By default JSON
 * (a string as `"a/b"`, any other value as `JSON.stringify` writes it), so nothing in it can break the line or forge another; every character a terminal must not get raw is written
 * as an escape (`\n`, `\u001b`, `\u009b`), the ones JSON itself leaves alone too. With `{ bare: true }`, for a whole line that already
 * has its own words: the text as it is when it holds none of those characters, else with each of them escaped (and no quotes added).
 * @param {unknown} value
 * @param {{ bare?: boolean }} [opts]
 * @returns {string}
 */
export function quote(value, { bare = false } = {}) {
  if (bare) return escapeUnsafe(String(value));
  let t;
  try { t = JSON.stringify(value) ?? String(value); } catch { t = String(value); }
  return escapeUnsafe(t);
}
