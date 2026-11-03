/**
 * @module server/submit-review
 *
 * The one place a review is checked and posted. The Approve and Send back buttons (`PUT /proposals/<slug>/review`,
 * server/proposals.js) and the review API (`POST /api/reviews`, server/review-api.js) both call `submitReview`, and
 * nothing else posts a review, so the two cannot drift: a token-holder's approval counts exactly like the button's.
 *
 * In this order, each step refusing in words (a `Refused`, or the forge's own `ForgeError`):
 *
 *   1. a flood: more than `ATTEMPTS_PER_MINUTE` attempts by this person in a minute is 429, and nothing is written down
 *      (server/throttle.js), so a flood of refused attempts cannot grow the audit table
 *   2. a repeat: the same review of the same proposal again within a few seconds, one at a time, and a ceiling of
 *      actions per person per minute (429)
 *   3. the review itself (`validateReview`): a verdict, a note to send back, edits that are objects with an op (400)
 *   4. the forge, as the person: with the button, their session's token; with the API, the token owner's newest live
 *      sign-in (`auth.forgeForUser`), because the comment has to be the maintainer's own for `latestReview` to count it
 *   5. a maintainer NOW: the forge is asked who that token is and what it may do on the repo, not what the session
 *      remembered 15 minutes ago; a different person, or one who is no longer a maintainer, is 403
 *   6. the PR is open and holds the proposal (404)
 *   7. the proposal file's SHA-256 at the PR's head: when the caller names the version it read (`sha256`; the API
 *      requires it) and the head holds another, 409, so a review counts only for the version that was read. An
 *      approval records the head's hash (`proposal`) and its mockups' (`mockups`), as the server read them, never the caller's word
 *   8. with the API, the token once more (`stillAllowed`): one revoked or expired while the forge was being asked is 403
 *   9. the comment is posted as that person (`postReview`)
 *
 * Every attempt that gets past step 1 is a row in `actions` (`record`), whatever the answer: a posted review and a forge
 * that refused it are written by `postReview`, every refusal before that here. The audit never holds a token's secret,
 * only its id and label.
 *
 * `submitReview` is the one place a review has been posted, so the event hooks' `spec.approved` and `spec.sentBack`
 * (server/hooks.js) are emitted here, after `postReview`, not in either caller.
 */

import { ForgeError, isMaintainer } from './forge.js';
import { PROPOSAL_FILE } from './files.js';
import { findPullProposal, forgeWords, readPullProposal } from './proposal-pulls.js';
import { hashPullMockups } from './mockups.js';
import { postReview, proposalHash, validateReview } from './reviews.js';
import { Refused, countAttempt, throttle } from './throttle.js';
import { proposalPayload } from './hooks.js';

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_PULL = 999_999_999;

/**
 * @typedef {object} ReviewContext
 * @property {() => import('./forge.js').Forge | Promise<import('./forge.js').Forge>} forge the forge as the person reviewing (may throw a ForgeError `unauthorized`)
 * @property {{ proposals: string }} where the server's `where` (server/server.js)
 * @property {string} repo `owner/name`, for the audit's target
 * @property {{ login: string, userId: string }} who who is reviewing, by the forge's id
 * @property {(entry: import('./reviews.js').AuditEntry) => Promise<void> | void} record writes a row of the audit table
 * @property {{ auth: object, now?: () => number }} limits what `server/throttle.js` counts by (one `auth` per server)
 * @property {import('./reviews.js').ApiVia} [via] set when the review came through the API: the token it came with
 * @property {import('./hooks.js').Hooks | null} [hooks] the event hooks (server/hooks.js): `spec.approved` or `spec.sentBack` after a post
 * @property {boolean} [requireSha256] the caller must name the version it read (the API does; the button reads the head itself)
 * @property {() => string | null | Promise<string | null>} [stillAllowed] asked once more just before the post, after every
 *   forge call: null to go on, or the words for why not (the API's token was revoked or expired meanwhile), refused 403
 */

/**
 * Checks and posts a review. Throws a `Refused` or a `ForgeError` (answer with `refusal(err)`); resolves with the
 * review as the PR will now show it.
 * @param {ReviewContext} ctx
 * @param {{ pull: unknown, slug: unknown, review: unknown, sha256?: unknown, problem?: { status: number, message: string } }} input
 *   `review` is `{ verdict, note?, edits? }` as the caller sent it; `sha256` the proposal file's hash as the caller read it
 *   (absent for the button, which sends none); `problem` is something already wrong with the request itself (it was not
 *   JSON, it was too large): it is refused here, after the flood count and with a row, like every other refusal
 * @returns {Promise<import('./reviews.js').FoundReview>}
 */
export async function submitReview(ctx, { pull, slug, review, sha256 = null, problem }) {
  const { who, repo, via } = ctx;
  const now = ctx.limits.now ?? Date.now;
  const validPull = typeof pull === 'number' && Number.isInteger(pull) && pull >= 1 && pull <= MAX_PULL;
  const target = validPull ? `${repo}#${pull}` : repo;
  // What the audit row says was asked: only what is small, plain and of the right shape, never the whole body
  // A slug or a hash only when it has the shape of one: anything else the caller sent is not kept (it could be a secret pasted in the wrong field)
  const slugShown = typeof slug === 'string' && slug.length <= 200 && PROPOSAL_FILE.test(`${slug}.json`) ? slug : undefined;
  const asked = /** @type {Record<string, unknown>} */ ({ slug: slugShown, pull: validPull ? pull : undefined, ...(isSha256(sha256) ? { sha256 } : {}), ...(via ? { via: 'api', token: via.token } : {}) });

  const flood = countAttempt(ctx.limits, who.userId, now());
  if (flood) throw flood;

  let recorded = false;
  const record = async (entry) => {
    recorded = true;
    return ctx.record(entry);
  };
  let release = () => {};
  try {
    if (problem) throw new Refused(problem.status, problem.message, 'invalid');
    if (!validPull) throw new Refused(400, 'Say which pull request: its number.', 'invalid');
    if (typeof slug !== 'string' || slug.length > 200 || !PROPOSAL_FILE.test(`${slug}.json`)) throw new Refused(400, 'Say which proposal: its name in the proposals folder.', 'invalid');
    if ((sha256 !== null && sha256 !== undefined) || ctx.requireSha256) {
      if (!isSha256(sha256)) throw new Refused(400, 'Say which version you read: "sha256" is the proposal file\'s SHA-256, 64 lower-case hex digits.', 'invalid');
    }
    release = throttle(ctx.limits, who.userId, `review|${pull}|${slug}`, now());

    if (review !== null && typeof review === 'object') {
      const verdict = /** @type {any} */ (review).verdict;
      if (verdict === 'approved' || verdict === 'notes') asked.verdict = verdict;
      if (Array.isArray(/** @type {any} */ (review).edits)) asked.edits = /** @type {any} */ (review).edits.length;
    }
    const checked = validateReview(review);
    if (!checked.ok) throw new Refused(400, checked.error, 'invalid');

    const forge = await ctx.forge();
    const me = await forge.me();
    if (String(me.id) !== who.userId) throw new Refused(403, 'The forge says this sign-in is someone else now; sign in again.', 'forbidden');
    if (!isMaintainer(await forge.permission(repo, me.login))) throw new Refused(403, `Only the repo's maintainers review proposals; ${me.login} is not one now.`, 'forbidden');

    const entry = await findPullProposal(forge, ctx.where, slug, pull);
    if (!entry) throw new Refused(404, `Pull request #${pull} is not open or does not hold the proposal ${slug}.`, 'not-found');
    // The proposal as the head holds it now: a later push that changes it is not this review's
    const head = proposalHash(await readPullProposal(forge, ctx.where, entry));
    if (typeof sha256 === 'string' && sha256 !== head) throw new Refused(409, `${slug} has changed since you read it (the head of pull request #${pull} holds ${head.slice(0, 12)}…, not ${sha256.slice(0, 12)}…); read it again and review that version.`, 'conflict');

    let checkedReview = checked.value;
    if (checkedReview.verdict === 'approved') {
      checkedReview = { ...checkedReview, proposal: head };
      const mockups = await hashPullMockups(forge, ctx.where, entry);
      if (mockups.length) checkedReview = { ...checkedReview, mockups };
    }
    // The checks above took a while: a token revoked (or expired) since it was looked up does not post
    if (ctx.stillAllowed) {
      const why = await ctx.stillAllowed();
      if (why) throw new Refused(403, why, 'forbidden');
    }
    const posted = await postReview(forge, pull, slug, checkedReview, { login: me.login, record, via });
    // The one place a review is posted, so the button and the API fire the same event; the actor is who the forge says
    // the poster is (with the API, the token's owner), never a name the caller sent
    ctx.hooks?.emit(posted.verdict === 'approved' ? 'spec.approved' : 'spec.sentBack', () => proposalPayload(forge, ctx.where, entry, { actor: me.login, note: checkedReview.note, edits: checkedReview.edits }));
    return posted;
  } catch (err) {
    if (!(err instanceof Refused) && !(err instanceof ForgeError)) console.error(`[cornfield] the review of ${target}: ${err instanceof Error ? err.stack || err.message : err}`);
    // postReview writes the row of a review it tried to post; anything refused before that is written here
    if (!recorded) {
      const out = refusal(err);
      try {
        await ctx.record({ login: who.login, action: 'review', target, request: asked, status: err instanceof ForgeError ? err.status ?? (err.code === 'unavailable' ? null : out.status) : out.status, answer: { error: out.body.error, code: out.body.code } });
      } catch (writeErr) {
        console.error(`[cornfield] the refusal of the review of ${target} could not be written to the audit table: ${writeErr instanceof Error ? writeErr.message : writeErr}`);
      }
    }
    throw err;
  } finally {
    release();
  }
}

/**
 * The answer to give for an error `submitReview` threw: the status, `{ error, code }` and the headers to send.
 * A ForgeError keeps the words of the forge; anything else is a 500 that says nothing of what went wrong.
 * @param {unknown} err
 * @returns {{ status: number, body: { error: string, code: string }, headers: Record<string, string> }}
 */
export function refusal(err) {
  if (err instanceof Refused) return { status: err.status, body: { error: err.message, code: err.code }, headers: err.headers };
  if (err instanceof ForgeError) {
    const status = { 'not-found': 404, invalid: 400, unauthorized: 401, 'rate-limited': 429 }[err.code] ?? 502;
    const wait = err.rateLimit && err.rateLimit.retryAfter != null ? { 'Retry-After': String(Math.ceil(err.rateLimit.retryAfter)) } : {};
    return { status, body: { error: forgeWords(err), code: err.code }, headers: wait };
  }
  return { status: 500, body: { error: 'The review could not be saved; the log says why.', code: 'unavailable' }, headers: {} };
}

/** The checks on a `sha256` the caller names: 64 lower-case hex digits */
export const isSha256 = (v) => typeof v === 'string' && SHA256.test(v);
