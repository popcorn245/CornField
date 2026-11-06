/**
 * @module core/defuse
 *
 * Breaking the mentions and references in text cornfield posts on the forge for someone else: `@user`, `@org/team`,
 * `#1`, `owner/repo#1`, `GH-1`, and the links the forge would make of `https://…` or `www.…`. A zero-width space after
 * the character keeps the text as it reads and stops it notifying anyone or linking anything. The pipeline's issues
 * (server/pipeline.js), a review that came through the review API (server/reviews.js) and the agent contract
 * (core/agent-contract.js) use it; `inert` and `quoteInert` also make someone else's words plain Markdown, the way the agent contract
 * and a run's thread (server/run-thread.js) show a runner's note. It imports nothing, so Node and the browser can both load it.
 */

/** A zero-width space: it ends a mention or a reference without showing */
export const ZW = '​';

/** Text with every mention, reference and auto-link broken (see the module's head) */
export function defuse(text) {
  return String(text).replace(/[@#]/g, (c) => `${c}${ZW}`).replace(/\b(GH)-(?=\d)/gi, `$1${ZW}-`).replace(/:\/\//g, `:${ZW}//`).replace(/\b(www)\./gi, `$1${ZW}.`);
}

/**
 * Text that makes no Markdown of its own: `\\` escaped first (so no escape of ours is undone), `&` and `<` as entities (no HTML, no
 * character reference), `[` escaped (no link, image or `[[node]]`), backticks made `'` and runs of tildes broken (no code span, no fence).
 * Mentions, references and links are not touched here: `defuse` them first.
 */
export function inert(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\[/g, '\\[').replace(/`/g, "'").replace(/~(?=~)/g, `~${ZW}`);
}

/**
 * Text quoted line by line, defused and inert: every line end Markdown and the agent contract's reader know (`\r\n`, `\r` alone, `\n`)
 * ends a line here, and every line is behind `> ` (an empty one is `>`), so no line escapes the quote and nothing in it opens a fence.
 */
export function quoteInert(text) {
  return inert(defuse(text)).split(/\r\n?|\n/).map((l) => (l.trim() ? `> ${l}` : '>')).join('\n');
}
