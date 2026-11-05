/**
 * @module core/defuse
 *
 * Breaking the mentions and references in text cornfield posts on the forge for someone else: `@user`, `@org/team`,
 * `#1`, `owner/repo#1`, `GH-1`, and the links the forge would make of `https://…` or `www.…`. A zero-width space after
 * the character keeps the text as it reads and stops it notifying anyone or linking anything. The pipeline's issues
 * (server/pipeline.js), a review that came through the review API (server/reviews.js) and the agent contract
 * (core/agent-contract.js) use it. It imports nothing, so Node and the browser can both load it.
 */

/** A zero-width space: it ends a mention or a reference without showing */
export const ZW = '​';

/** Text with every mention, reference and auto-link broken (see the module's head) */
export function defuse(text) {
  return String(text).replace(/[@#]/g, (c) => `${c}${ZW}`).replace(/\b(GH)-(?=\d)/gi, `$1${ZW}-`).replace(/:\/\//g, `:${ZW}//`).replace(/\b(www)\./gi, `$1${ZW}.`);
}
