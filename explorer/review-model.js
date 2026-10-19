/**
 * @module explorer/review-model
 *
 * The pure half of approving a proposal or sending it back: no DOM, no `window`, no clock (the time is passed
 * in). review.js is the half that touches the page and the network; what the words are and what is sent are
 * decided here so they can be tested without one.
 *
 *   relativeTime       "just now", "3 minutes ago", "2 hours ago", "5 days ago"
 *   reviewWords        "Approved 3 minutes ago" / "Sent back just now", from a review's verdict and time
 *   sendBackProblem    why a note is missing (or null)
 *   reviewBody         what the server's PUT takes: { verdict, note, edits }
 *   editsHint          what to tell the maintainer about the edits after a send
 *   isReviewable       whether a proposal's source can be reviewed (a spec PR: `pull/<n>`), and the words for when it cannot
 *   specNumber         the spec number a proposal's `spec` field names
 *
 * The review is a comment on the spec PR; the server answers it as `{ "version": 1, "slug", "verdict": "approved" | "notes", "note": string, "edits": Edit[], "at": ISO string, "by": login, "comment": { id, url } }`.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * How long ago `iso` was, in plain words. A time in the future (a clock that is a little off) or one that does
 * not read is "just now" or nothing: never a negative.
 * @param {string} iso
 * @param {number} nowMs
 * @returns {string}
 */
export function relativeTime(iso, nowMs) {
  const then = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(then) || !Number.isFinite(nowMs)) return '';
  const ago = nowMs - then;
  if (ago < MINUTE) return 'just now';
  if (ago < HOUR) return `${plural(Math.floor(ago / MINUTE), 'minute')} ago`;
  if (ago < DAY) return `${plural(Math.floor(ago / HOUR), 'hour')} ago`;
  return `${plural(Math.floor(ago / DAY), 'day')} ago`;
}

const VERDICT_WORDS = { approved: 'Approved', notes: 'Sent back' };

/**
 * The line the bar shows for the last review: "Approved 3 minutes ago" or "Sent back just now". Empty for no review.
 * @param {{ verdict: string, at: string }|null|undefined} review the listing's `review`
 * @param {number} nowMs
 */
export function reviewWords(review, nowMs) {
  if (!review || !VERDICT_WORDS[review.verdict]) return '';
  const when = relativeTime(review.at, nowMs);
  return when ? `${VERDICT_WORDS[review.verdict]} ${when}` : VERDICT_WORDS[review.verdict];
}

/** Why a proposal cannot be sent back yet: it needs a note. Null when it can be. */
export function sendBackProblem(note) {
  return typeof note === 'string' && note.trim() ? null : 'Say what should change before you send it back.';
}

/**
 * What goes to `PUT /proposals/<slug>/review`. The edits are copies, so changing the list after the call changes nothing sent.
 * @param {'approved'|'notes'} verdict
 * @param {string} note
 * @param {object[]} edits
 */
export function reviewBody(verdict, note, edits) {
  return { verdict, note: typeof note === 'string' ? note.trim() : '', edits: structuredClone(Array.isArray(edits) ? edits : []) };
}

/** Whether a proposal opened from `source` can be reviewed: only a proposal of an open spec PR (`pull/<n>`) has a PR to hold the review */
export const isReviewable = (source) => typeof source === 'string' && /^pull\/[1-9]\d{0,8}$/.test(source);

/** What the bar says for a proposal that is not on a PR */
export const NOT_ON_A_PR = 'A review is a comment on the proposal\'s spec PR. Push this draft as a spec PR to approve or send it back here.';

/**
 * What to say about the edits once the review is sent. They go in the comment either way; an approval keeps them in the
 * viewer (the drafting agent folds them into the proposal), a send back empties the list (they went with the notes).
 * @param {'approved'|'notes'} verdict
 * @param {number} count
 */
export function editsHint(verdict, count) {
  if (!count) return '';
  const them = plural(count, 'edit');
  return verdict === 'approved'
    ? `Your ${them} ${count === 1 ? 'is' : 'are'} in the review comment on the PR. The drafting agent will fold ${count === 1 ? 'it' : 'them'} into the proposal.`
    : `Sent with your ${them}. The drafting agent will fold ${count === 1 ? 'it' : 'them'} into the next draft.`;
}

/**
 * The pipeline spec number a proposal belongs to: its `spec` field as a whole number ("0013" and 13 are 13), or null.
 * @param {unknown} spec
 */
export function specNumber(spec) {
  if (typeof spec === 'number') return Number.isInteger(spec) && spec > 0 ? spec : null;
  if (typeof spec !== 'string' || !/^\d{1,6}$/.test(spec.trim())) return null;
  const n = Number(spec.trim());
  return n > 0 ? n : null;
}
