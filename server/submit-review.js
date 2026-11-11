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
 *      requires it, the button sends the one it was shown) and the head holds another, 409, so a review counts only for the
 *      version that was read. The button also names the PR's head commit it was shown (`headSha`): another head now is 409 too,
 *      so an approval never covers (or lands) a push the maintainer did not see. An approval records the head's hash
 *      (`proposal`) and its mockups' (`mockups`), as the server read them, never the caller's word
 *   8. with the API, the token once more (`stillAllowed`): one revoked or expired while the forge was being asked is 403
 *   9. a repeat (spec 0007: a second tab, a retried call): the same approval, by the same person, of the same version, that
 *      already stands as the latest review, and would start nothing new (no landing on approval, or one already waiting at this
 *      head) is answered 200 with the review that stands and `"posted": false`, and nothing is posted or fired. Anything else
 *      (another maintainer, another note or edits, a landing that was cancelled or left open) is posted as before
 *  10. the comment is posted as that person (`postReview`)
 *
 * Every attempt that gets past step 1 is a row in `actions` (`record`), whatever the answer: a posted review and a forge
 * that refused it are written by `postReview`, every refusal before that here. The audit never holds a token's secret,
 * only its id and label.
 *
 * `submitReview` is the one place a review has been posted, so the event hooks' `spec.approved` and `spec.sentBack`
 * (server/hooks.js) are emitted here, after `postReview`, not in either caller. So is landing on approval
 * (`proposals.approveLands`, server/lander.js): after an approval is posted, and never for a send-back, `lander.start` is
 * begun in the background with the head that was approved. It is not awaited and cannot fail the review: the review is
 * already on the PR, and what goes wrong in landing is the lander's to say on the PR.
 */

import { ForgeError, isMaintainer } from './forge.js';
import { PROPOSAL_FILE } from './files.js';
import { findPullProposal, forgeWords, forgetReviewState, readPullProposal } from './proposal-pulls.js';
import { hashPullMockups } from './mockups.js';
import { latestReview, postReview, proposalHash, validateReview } from './reviews.js';
import { forgetDecision } from './decision.js';
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
 * @property {import('./lander.js').Lander | null} [lander] landing on approval (server/lander.js), set only when the config says `proposals.approveLands`
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
export async function submitReview(ctx, { pull, slug, review, sha256 = null, headSha = null, problem }) {
  const { who, repo, via } = ctx;
  const now = ctx.limits.now ?? Date.now;
  const validPull = typeof pull === 'number' && Number.isInteger(pull) && pull >= 1 && pull <= MAX_PULL;
  const target = validPull ? `${repo}#${pull}` : repo;
  // What the audit row says was asked: only what is small, plain and of the right shape, never the whole body
  // A slug or a hash only when it has the shape of one: anything else the caller sent is not kept (it could be a secret pasted in the wrong field)
  const slugShown = typeof slug === 'string' && slug.length <= 200 && PROPOSAL_FILE.test(`${slug}.json`) ? slug : undefined;
  const asked = /** @type {Record<string, unknown>} */ ({ slug: slugShown, pull: validPull ? pull : undefined, ...(isSha256(sha256) ? { sha256 } : {}), ...(isCommit(headSha) ? { headSha: headSha.toLowerCase() } : {}), ...(via ? { via: 'api', token: via.token } : {}) });

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
    if (headSha !== null && headSha !== undefined && !isCommit(headSha)) throw new Refused(400, 'Say which head you were shown: "headSha" is a commit\'s SHA, 40 or 64 hex digits.', 'invalid');
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
    if (!isMaintainer(await forge.permission(repo, me.login))) throw new Refused(403, `${me.login} no longer maintains this repo, so the forge would not count the review.`, 'forbidden');

    const entry = await findPullProposal(forge, ctx.where, slug, pull);
    if (!entry) throw new Refused(404, `Pull request #${pull} is not open or does not hold the proposal ${slug}.`, 'not-found');
    // The proposal as the head holds it now: a later push that changes it is not this review's
    const head = proposalHash(await readPullProposal(forge, ctx.where, entry));
    if (typeof sha256 === 'string' && sha256 !== head) throw new Refused(409, `${slug} has changed since you read it (the head of pull request #${pull} holds ${head.slice(0, 12)}…, not ${sha256.slice(0, 12)}…); read it again and review that version.`, 'conflict');
    if (typeof headSha === 'string' && headSha.toLowerCase() !== String(entry.sha).toLowerCase()) throw new Refused(409, `Pull request #${pull} was pushed to since you looked (its head is ${String(entry.sha).slice(0, 7)} now, not ${headSha.slice(0, 7)}); nothing was posted. Look at it again, then review that.`, 'conflict');

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
    // A repeat (step 9): this person's approval of this version stands already, and posting it again would start nothing new. The answer is
    // the review that stands, with nothing posted, no hook fired and no landing begun; it is a row in the audit table like every attempt.
    if (checkedReview.verdict === 'approved') {
      const standing = await latestReview(forge, pull, slug);
      if (isRepeat(standing, checkedReview, me.login) && (!ctx.lander || stillLanding(ctx.lander, pull, entry.sha))) {
        await record({ login: me.login, action: 'review', target, request: asked, status: 200, answer: { posted: false, comment: standing.comment?.id ?? null } });
        return { ...standing, posted: false };
      }
    }
    const posted = await postReview(forge, pull, slug, checkedReview, { login: me.login, record, via });
    forgetReviewState(ctx.where, pull); // the listing's review state for this PR is read again (spec 0010)
    forgetDecision(ctx.where, pull); // and the line above Approve: an approval can start a landing
    // The one place a review is posted, so the button and the API fire the same event; the actor is who the forge says
    // the poster is (with the API, the token's owner), never a name the caller sent
    ctx.hooks?.emit(posted.verdict === 'approved' ? 'spec.approved' : 'spec.sentBack', () => proposalPayload(forge, ctx.where, entry, { actor: me.login, note: checkedReview.note, edits: checkedReview.edits }));
    if (posted.verdict === 'approved' && ctx.lander) {
      const { lander } = ctx;
      Promise.resolve()
        .then(() => lander.start({ pull, slug, sha: entry.sha, who: { userId: who.userId, login: me.login } }))
        .catch((err) => console.error(`[cornfield] landing ${target} on approval could not begin: ${err instanceof Error ? err.message : err}`));
    }
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

/**
 * Whether `review`, about to be posted by `login`, says nothing that the review standing does not already say: the same person's approval of
 * the same version (the file and its mockups as the head holds them), with the same note and edits.
 * @param {import('./reviews.js').FoundReview | null} standing
 * @param {import('./reviews.js').Review} review the checked approval, with what the server recorded it covers
 * @param {string} login
 */
export function isRepeat(standing, review, login) {
  if (!standing || standing.by !== login || !standsApproved(standing, review.proposal, review.mockups ?? [])) return false;
  return (standing.note ?? '') === (review.note ?? '') && JSON.stringify(standing.edits ?? []) === JSON.stringify(review.edits ?? []);
}

/** Whether a landing on approval already waits on PR `n` at this head (so an approval again would begin nothing new) */
export const stillLanding = (lander, n, sha) => String(lander.pending(n)?.sha ?? '').toLowerCase() === String(sha).toLowerCase();

/**
 * Whether a review that stands is an approval of exactly this: the proposal file as the head holds it and its mockups (what an approval covers).
 * @param {import('./reviews.js').FoundReview | null} standing
 * @param {string} head the proposal file's SHA-256 at the head
 * @param {{ node: string, path: string, sha256: string }[]} mockups the mockups as the head holds them
 */
export const standsApproved = (standing, head, mockups) => !!standing && standing.verdict === 'approved' && standing.proposal === head && JSON.stringify(standing.mockups ?? []) === JSON.stringify(mockups);

/** A commit's SHA as a caller names it: 40 hex digits (SHA-1) or 64 (SHA-256 repositories) */
export const isCommit = (v) => typeof v === 'string' && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(v);

/** The checks on a `sha256` the caller names: 64 lower-case hex digits */
export const isSha256 = (v) => typeof v === 'string' && SHA256.test(v);
