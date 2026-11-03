/**
 * @module server/review-api
 *
 * The review API (spec 0002, issue #67): Approve or Send back from somewhere that is not the button, a script or a chat
 * reaction, with a review token the maintainer made in the dashboard. The tokens are kept by the review-tokens module.
 *
 *   POST /api/reviews                    { pull, slug, sha256, verdict, note?, edits? }, with `Authorization: Bearer cf_rt_…`
 *   GET  /api/review-tokens              the signed-in maintainer's tokens: id, label, made, expires, revoked, last used (never a secret)
 *   POST /api/review-tokens              { label, days? } -> the new token, in this answer only
 *   POST /api/review-tokens/<id>/revoke  ends one of theirs for good
 *
 * **The call takes the token and nothing else.** It runs before the sign-in guard (a script has no cookie) and reads no
 * cookie: a session cookie is never a substitute for the token, and a request that sends only one is 401. Being no
 * cookie-borne request it needs no same-origin check (a browser never adds an `Authorization` header by itself); the
 * `Host` check in front of every route still applies. It is a review like the button's: both go through `submitReview`
 * (server/submit-review.js), which asks the forge NOW whether the token's owner still maintains the repo (a demoted owner is
 * 403), checks the proposal's SHA-256 at the PR's head (409), needs a note to send back (400), counts the flood and the
 * repeat, and posts the comment as the owner with their kept sign-in (`auth.forgeForUser`; without a live one, 401). The
 * comment says it came through the API and names the token's label.
 *
 * **Every call is a row in `actions`** (`review`, with the token's id and label in the request, never the token):
 *
 *   no token, or one that no row has    401 (`WWW-Authenticate: Bearer`), logged under `(no token)`. Past `ANONYMOUS_PER_MINUTE` a minute
 *                                       nothing is written and the answer is 429, so anyone who can reach the server cannot fill the table
 *   a token that is revoked or expired  403, under its owner
 *   a live token                        whatever `submitReview` answers: 200 with the review, or 400, 401, 403, 404, 409, 429, 502
 *
 * The three routes under `/api/review-tokens` are for the signed-in maintainer only: they pass the sign-in guard like
 * every other route, take a POST from cornfield's own page only (`sameOrigin`) with a JSON body, and a review token is
 * no way to them (the guard reads cookies, never `Authorization`), so a token cannot make tokens. A token is
 * made after the forge is asked who the maintainer is now, and the make and the revoke are rows in `actions` too
 * (`review-token`), begun before the change is made.
 */

import { ForgeError, isMaintainer } from './forge.js';
import { sameOrigin, readBody } from './proposals.js';
import { REVIEW_LIMIT } from './reviews.js';
import { MAX_ACTIVE, MAX_DAYS, DEFAULT_DAYS, bearerOf, daysOf, findToken, labelProblem, listTokens, mintToken, revokeToken, touchToken } from './review-tokens.js';
import { refusal, submitReview } from './submit-review.js';
import { Refused, countAttempt } from './throttle.js';

export const REVIEWS_PATH = '/api/reviews';
export const TOKENS_PATH = '/api/review-tokens';
/** Calls with no token, or one nobody holds, that are written down in a minute, all callers together */
export const ANONYMOUS_PER_MINUTE = 20;
/** What the audit row of a call nobody could name says in place of a login */
export const NO_TOKEN_LOGIN = '(no token)';
/** The keys of a call's body */
const CALL_KEYS = ['pull', 'slug', 'sha256', 'verdict', 'note', 'edits'];
const TOKEN_BODY_LIMIT = 4096;
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

const plainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @typedef {{ config: any, where: any, auth: any, hooks?: import('./hooks.js').Hooks | null, now?: () => number, publicHost?: string | null }} ApiContext */

/**
 * `POST /api/reviews`. The caller has found the path to be this one; this runs before the sign-in guard.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {ApiContext} ctx
 */
export async function serveReviewCall(req, res, ctx) {
  const { config, where, auth } = ctx;
  const now = ctx.now ?? Date.now;
  if (!auth.enabled) {
    req.resume();
    return send(res, 403, { ok: false, error: 'Review tokens need sign-in: set it up first (docs/sign-in.md).', code: 'forbidden' });
  }
  if (req.method !== 'POST') {
    req.resume();
    return send(res, 405, { ok: false, error: 'A review is sent with POST.', code: 'invalid' }, { Allow: 'POST' });
  }
  const repo = config.forge.repo;
  const audit = async (login, request, status, body, target = repo) => {
    try {
      await auth.record({ login, action: 'review', target, request: { via: 'api', ...request }, status, answer: { error: body.error, code: body.code } });
    } catch (err) {
      console.error(`[cornfield] a refused review call could not be written to the audit table: ${err instanceof Error ? err.message : err}`);
    }
  };

  // The token, from the header alone; a cookie is not looked at
  const presented = bearerOf(req.headers.authorization);
  const db = presented ? await auth.store() : null;
  const found = presented && db ? findToken(db, presented, now()) : null;
  if (!found) {
    req.resume();
    const reason = presented ? 'unknown-token' : 'no-token';
    const flood = countAttempt(ctx, NO_TOKEN_LOGIN, now(), ANONYMOUS_PER_MINUTE);
    if (flood) return send(res, flood.status, { ok: false, error: flood.message, code: flood.code }, flood.headers);
    const body = { error: 'A review token is needed: send "Authorization: Bearer cf_rt_…". A token is made in the dashboard; a sign-in is not taken in its place.', code: 'unauthorized' };
    await audit(NO_TOKEN_LOGIN, { reason }, 401, body);
    return send(res, 401, { ok: false, ...body }, { 'WWW-Authenticate': 'Bearer realm="cornfield"' });
  }

  const { row, state } = found;
  const token = { id: row.id, label: row.label };
  if (state !== 'active') {
    req.resume();
    const flood = countAttempt(ctx, row.user_id, now());
    if (flood) return send(res, flood.status, { ok: false, error: flood.message, code: flood.code }, flood.headers);
    const body = { error: state === 'revoked' ? 'This review token was revoked; make a new one in the dashboard.' : 'This review token has expired; make a new one in the dashboard.', code: 'forbidden' };
    await audit(row.login, { reason: state, token }, 403, body);
    return send(res, 403, { ok: false, ...body });
  }
  touchToken(/** @type {import('node:sqlite').DatabaseSync} */ (db), row.id, now());

  // The body: whatever is wrong with it is submitReview's to refuse, after the flood count and with a row
  let input;
  try {
    const body = await readBody(req, REVIEW_LIMIT);
    if (body.tooLarge) input = { problem: { status: 413, message: `A review is at most ${REVIEW_LIMIT / 1024} KB.` } };
    else input = inputOf(body.text);
  } catch {
    input = { problem: { status: 400, message: 'The request could not be read.' } };
  }
  try {
    const found = await submitReview({
      forge: () => auth.forgeForUser(row.user_id), where, repo, who: { login: row.login, userId: row.user_id },
      record: (entry) => auth.record(entry), limits: { auth, now: ctx.now }, via: { token }, requireSha256: true, hooks: ctx.hooks,
      stillAllowed: async () => {
        const again = findToken(await auth.store(), /** @type {string} */ (presented), now());
        if (again && again.state === 'active') return null;
        return again && again.state === 'expired' ? 'This review token expired while the review was being checked; nothing was posted.' : 'This review token was revoked while the review was being checked; nothing was posted.';
      },
    }, input);
    return send(res, 200, { ok: true, ...found });
  } catch (err) {
    const out = refusal(err);
    return send(res, out.status, { ok: false, ...out.body }, out.headers);
  }
}

/** A call's body as `submitReview` takes it, or the problem with it */
function inputOf(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not the parser's words: they quote the body, which the audit row would then keep (a token pasted in by mistake)
    return { problem: { status: 400, message: 'The body is not valid JSON.' } };
  }
  if (!plainObject(parsed)) return { problem: { status: 400, message: 'A review call is a JSON object: { pull, slug, sha256, verdict, note?, edits? }.' } };
  const extra = Object.keys(parsed).find((k) => !CALL_KEYS.includes(k));
  // What an approval covers (the proposal and its mockups) is recorded by the server from the files themselves
  if (extra !== undefined) return { problem: { status: 400, message: `A review call has only pull, slug, sha256, verdict, note and edits, not "${extra}".` } };
  const { pull, slug, sha256, ...review } = parsed;
  return { pull, slug, sha256, review };
}

// ---------------------------------------------------------------------------
//  The routes of the signed-in maintainer: make, list, revoke
// ---------------------------------------------------------------------------

/** What a token looks like to the dashboard: no hash, no secret */
const publicToken = ({ id, login, label, created_at, expires_at, revoked_at, last_used, state }) => ({ id, login, label, created: created_at, expires: expires_at, revoked: revoked_at, lastUsed: last_used, state });

/**
 * The `/api/review-tokens` routes. The caller has passed the sign-in guard, so `session` is a maintainer's.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} reqPath
 * @param {ApiContext & { session: { login: string, userId: string } | null }} ctx
 * @returns {Promise<boolean>} whether the path was one of these
 */
export async function serveTokenRoutes(req, res, reqPath, ctx) {
  const revoke = /^\/api\/review-tokens\/([1-9]\d{0,9})\/revoke$/.exec(reqPath);
  if (reqPath !== TOKENS_PATH && !revoke) return false;
  const { config, auth, session } = ctx;
  const now = ctx.now ?? Date.now;
  const allow = revoke ? 'POST' : 'GET, POST';
  const method = req.method;
  if (!allow.split(', ').includes(method || '')) {
    req.resume();
    send(res, 405, { ok: false, error: 'Method not allowed.', code: 'invalid' }, { Allow: allow });
    return true;
  }
  if (!session || !auth.store) {
    req.resume();
    send(res, 403, { ok: false, error: 'Review tokens belong to a signed-in maintainer: set up sign-in first (docs/sign-in.md).', code: 'forbidden' });
    return true;
  }
  const db = await auth.store();
  if (method === 'GET') {
    send(res, 200, { ok: true, tokens: listTokens(db, session.userId, now()).map(publicToken), defaultDays: DEFAULT_DAYS, maxDays: MAX_DAYS, maxActive: MAX_ACTIVE });
    return true;
  }

  // A change: from cornfield's own page only, as JSON, counted and written down, and the forge asked who this is now
  const flood = countAttempt(ctx, session.userId, now());
  if (flood) {
    req.resume();
    send(res, flood.status, { ok: false, error: flood.message, code: flood.code }, flood.headers);
    return true;
  }
  const what = revoke ? 'revoke' : 'mint';
  const request = /** @type {Record<string, unknown>} */ ({ op: what, ...(revoke ? { id: Number(revoke[1]) } : {}) });
  let rowId = null;
  /** @type {{ status: number, body: object }} */
  let out;
  try {
    try {
      rowId = await auth.begin({ login: session.login, action: 'review-token', target: config.forge.repo, request });
    } catch (err) {
      console.error(`[cornfield] the audit row of a review token could not be written: ${err instanceof Error ? err.message : err}`);
      throw new Refused(503, 'cornfield cannot write its audit log, so it will not change review tokens.', 'unavailable');
    }
    if (!sameOrigin(req, ctx.publicHost ?? null)) {
      req.resume();
      throw new Refused(403, 'Do this from cornfield\'s own page.', 'forbidden');
    }
    const body = revoke ? {} : await jsonBody(req);
    const forge = auth.forgeFor(session);
    const me = await forge.me();
    if (String(me.id) !== String(session.userId)) throw new Refused(403, 'The forge says this sign-in is someone else now; sign in again.', 'forbidden');
    if (!isMaintainer(await forge.permission(config.forge.repo, me.login))) throw new Refused(403, `Only the repo's maintainers make review tokens; ${me.login} is not one now.`, 'forbidden');
    if (revoke) {
      const done = revokeToken(db, session.userId, Number(revoke[1]), now());
      if (!done) throw new Refused(404, 'You have no review token by that number.', 'not-found');
      request.label = done.label;
      out = { status: 200, body: { ok: true, token: publicToken(done) } };
    } else {
      const unknown = Object.keys(body).find((k) => k !== 'label' && k !== 'days');
      if (unknown !== undefined) throw new Refused(400, `A token has a label and, if you like, a number of days, not "${unknown}".`, 'invalid');
      const problem = labelProblem(body.label);
      if (problem) throw new Refused(400, problem, 'invalid');
      let days;
      try {
        days = daysOf(body.days);
      } catch (err) {
        throw new Refused(400, err.message, 'invalid');
      }
      Object.assign(request, { label: body.label, days });
      let made;
      try {
        made = mintToken(db, { userId: session.userId, login: me.login, label: body.label, days }, now());
      } catch (err) {
        if (err instanceof RangeError) throw new Refused(409, err.message, 'conflict');
        throw err;
      }
      request.id = made.row.id;
      // The token is in this answer and nowhere else: not in the audit row, not in a log
      out = { status: 201, body: { ok: true, secret: made.token, token: publicToken({ ...made.row, state: 'active' }) } };
    }
  } catch (err) {
    if (err instanceof Refused) out = { status: err.status, body: { ok: false, error: err.message, code: err.code } };
    else if (err instanceof ForgeError) {
      const r = refusal(err);
      out = { status: r.status, body: { ok: false, ...r.body } };
    } else {
      console.error(`[cornfield] review token ${what}: ${err instanceof Error ? err.stack || err.message : err}`);
      out = { status: 500, body: { ok: false, error: 'Something went wrong in cornfield; the log says what.', code: 'unavailable' } };
    }
  }
  if (rowId !== null) {
    try {
      await auth.finish(rowId, { request, status: out.status, answer: 'error' in out.body ? { error: out.body.error, code: out.body.code } : { ok: true, id: request.id } });
    } catch (err) {
      console.error(`[cornfield] the audit row of a review token could not be finished: ${err instanceof Error ? err.message : err}`);
    }
  }
  send(res, out.status, out.body);
  return true;
}

/** A small JSON object body, or a Refused */
async function jsonBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
    req.resume();
    throw new Refused(415, 'Send the request as JSON (Content-Type: application/json).', 'invalid');
  }
  const body = await readBody(req, TOKEN_BODY_LIMIT);
  if (body.tooLarge) throw new Refused(413, 'The request is too large for a token.', 'invalid');
  let parsed;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    throw new Refused(400, 'The request is not a JSON object.', 'invalid');
  }
  if (!plainObject(parsed)) throw new Refused(400, 'The request is not a JSON object.', 'invalid');
  return parsed;
}
