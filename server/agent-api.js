/**
 * @module server/agent-api
 *
 * The routes that ask for agent runs and show them (issue #80, spec 0005 D10; the engine is server/agent-runs.js).
 *
 *   POST /api/agent-requests             { kind, refs, profile?, brief?, branch?, limits?, nodes?, retryOf?, force? }, with `Authorization: Bearer cf_at_…`
 *   GET  /api/agent-requests             the queue, for a runner token: server/runner-api.js (and the pull transport's claim and report routes)
 *   GET  /api/agent-tokens               the signed-in maintainer's agent tokens (and POST, and /<id>/revoke: server/review-api.js)
 *   GET  /api/agent-runs[?follow=1]      the runs, newest first, with the cap and how many are open; `follow=1` looks at the forge first
 *   GET  /api/agent-runs/<runId>         one run
 *   GET  /api/agent-runs/<runId>/brief   its whole brief, for Start again (the run shows the first 2000 characters): the signed-in maintainer's only
 *   POST /api/agent-runs                 the dashboard's Start an agent: the same body as the API
 *   POST /api/agent-runs/<runId>/stop    { note? } asks the runner to stop
 *   POST /api/agent-runs/<runId>/answer  { action: 'continue' | 'stop' | 'reply', text? } answers a run that reported `waiting`
 *
 * **The call takes an agent token and nothing else,** exactly as the review API takes a review token (server/review-api.js): it runs
 * before the sign-in guard (a script has no cookie), reads no cookie, needs no same-origin check (a browser never adds an `Authorization`
 * header itself), and keeps the `Host` check in front of every route. **The two scopes are kept apart:** a review token on this route is 403
 * (and an agent token on `POST /api/reviews` is 403, and a runner token on either), whatever else is true of it. Token states, the anonymous flood ceiling and the rows
 * in `actions` are the review API's, under the action `agent-request`:
 *
 *   no token, or one that no row has    401 (`WWW-Authenticate: Bearer`), logged under `(no token)`; past `ANONYMOUS_PER_MINUTE` a minute 429 and no row
 *   a review token                      403, under its owner
 *   a token that is revoked or expired  403, under its owner
 *   a live agent token                  whatever `runs.request` answers: 201 with the run, or 400, 401, 403, 404, 409, 429, 502
 *
 * The request is made **as the token's owner**: the forge is asked now who that is and whether they still maintain the repo (a demoted owner
 * is 403), and the request comment is posted with their own kept sign-in (`auth.forgeForUser`; without a live one, 401). `requestedBy` is
 * theirs and is never taken from the body. A body that carries a credential, by key or by value, is 400 and nothing is posted.
 *
 * The `/api/agent-runs` routes are the signed-in maintainer's, behind the sign-in guard like every other action. The POSTs take a request
 * from cornfield's own page only (`sameOrigin`) with a JSON body and count toward the flood ceiling (server/throttle.js); a token is no way
 * to them (the guard reads cookies, never `Authorization`). They post with the session's own forge token (`auth.forgeFor`).
 */

import { isRunId } from '../core/agent-contract.js';
import { sameOrigin, readBody } from './proposals.js';
import { ANONYMOUS_PER_MINUTE, NO_TOKEN_LOGIN } from './review-api.js';
import { bearerOf, findToken, touchToken } from './review-tokens.js';
import { refusal } from './submit-review.js';
import { Refused, countAttempt, noteRefusedOrigin } from './throttle.js';
import { ForgeError } from './forge.js';

export const REQUESTS_PATH = '/api/agent-requests';
export const RUNS_PATH = '/api/agent-runs';
/** A request's body, in bytes: a brief of the contract's size, with room */
export const REQUEST_LIMIT = 96 * 1024;
const STOP_LIMIT = 8 * 1024;
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

/** What to answer for an error out of the engine: a refusal in words, or a plain 500 that says nothing of what went wrong */
function answerFor(err) {
  if (err instanceof Refused || err instanceof ForgeError) return refusal(err);
  return { status: 500, body: { error: 'Something went wrong in cornfield; the log says what.', code: 'unavailable' }, headers: {} };
}

/** A JSON object from a body text, or a `problem` the engine refuses with a row */
function parseBody(body, what) {
  if (body.tooLarge) return { problem: { status: 413, message: `${what} is too large.` } };
  try {
    return { body: JSON.parse(body.text) };
  } catch {
    // Not the parser's words: they quote the body, which a row would then keep (a credential pasted in by mistake)
    return { problem: { status: 400, message: 'The body is not valid JSON.' } };
  }
}

/** @typedef {{ config: any, auth: any, runs: import('./agent-runs.js').Runs | null, now?: () => number, publicHost?: string | null, publicOrigin?: string | null }} AgentContext */

/**
 * `POST /api/agent-requests`. The caller has found the path to be this one; this runs before the sign-in guard.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {AgentContext} ctx
 */
export async function serveAgentCall(req, res, ctx) {
  const { config, auth, runs } = ctx;
  const now = ctx.now ?? Date.now;
  if (!auth.enabled || !runs) {
    req.resume();
    return send(res, 403, { ok: false, error: 'Agent tokens need sign-in and a forge: set them up first (docs/sign-in.md, docs/config.md#forge).', code: 'forbidden' });
  }
  if (req.method !== 'POST') {
    req.resume();
    return send(res, 405, { ok: false, error: 'A run is asked for with POST (an agent token); a runner lists the queue with GET (a runner token).', code: 'invalid' }, { Allow: 'GET, HEAD, POST' });
  }
  const repo = config.forge.repo;
  const audit = async (login, request, status, body) => {
    try {
      await auth.record({ login, action: 'agent-request', target: repo, request: { via: 'api', ...request }, status, answer: { error: body.error, code: body.code } });
    } catch (err) {
      console.error(`[cornfield] a refused agent request could not be written to the audit table: ${err instanceof Error ? err.message : err}`);
    }
  };

  const presented = bearerOf(req.headers.authorization);
  const db = presented ? await auth.store() : null;
  const found = presented && db ? findToken(db, presented, now(), 'agent') : null;
  if (!found) {
    req.resume();
    const flood = countAttempt(ctx, NO_TOKEN_LOGIN, now(), ANONYMOUS_PER_MINUTE);
    if (flood) return send(res, flood.status, { ok: false, error: flood.message, code: flood.code }, flood.headers);
    const body = { error: 'An agent token is needed: send "Authorization: Bearer cf_at_…". A token is made in the dashboard; a sign-in is not taken in its place.', code: 'unauthorized' };
    await audit(NO_TOKEN_LOGIN, { reason: presented ? 'unknown-token' : 'no-token' }, 401, body);
    return send(res, 401, { ok: false, ...body }, { 'WWW-Authenticate': 'Bearer realm="cornfield"' });
  }

  const { row, state } = found;
  const token = { id: row.id, label: row.label };
  if (state !== 'active') {
    req.resume();
    const flood = countAttempt(ctx, row.user_id, now());
    if (flood) return send(res, flood.status, { ok: false, error: flood.message, code: flood.code }, flood.headers);
    const wrong = state === 'wrong-scope';
    const body = {
      error: wrong ? `This is ${row.scope === 'agent' ? 'an' : 'a'} ${row.scope} token. Asking for a run takes an agent token; make one in the dashboard.`
        : state === 'revoked' ? 'This agent token was revoked; make a new one in the dashboard.' : 'This agent token has expired; make a new one in the dashboard.',
      code: 'forbidden',
    };
    await audit(row.login, { reason: wrong ? 'wrong-scope' : state, token, ...(wrong ? { scope: row.scope } : {}) }, 403, body);
    return send(res, 403, { ok: false, ...body });
  }
  touchToken(/** @type {import('node:sqlite').DatabaseSync} */ (db), row.id, now());

  let input;
  try {
    input = parseBody(await readBody(req, REQUEST_LIMIT), 'A request');
  } catch {
    input = { problem: { status: 400, message: 'The request could not be read.' } };
  }
  try {
    const made = await runs.request({
      forge: () => auth.forgeForUser(row.user_id), who: { login: row.login, userId: row.user_id }, limits: { auth, now: ctx.now }, via: { token },
      stillAllowed: async () => {
        const again = findToken(await auth.store(), /** @type {string} */ (presented), now(), 'agent');
        if (again && again.state === 'active') return null;
        return again && again.state === 'expired' ? 'This agent token expired while the request was being checked; nothing was posted.' : 'This agent token was revoked while the request was being checked; nothing was posted.';
      },
    }, input);
    return send(res, 201, { ok: true, ...made });
  } catch (err) {
    const out = answerFor(err);
    return send(res, out.status, { ok: false, ...out.body }, out.headers);
  }
}

/**
 * The `/api/agent-runs` routes. The caller has passed the sign-in guard, so `session` is a maintainer's.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} reqPath
 * @param {AgentContext & { session: { login: string, userId: string } | null }} ctx
 * @returns {Promise<boolean>} whether the path was one of these
 */
export async function serveRunRoutes(req, res, reqPath, ctx) {
  const m = /^\/api\/agent-runs(?:\/(run-[0-9A-Za-z]{26}))?(\/stop|\/answer|\/brief)?$/.exec(reqPath);
  if (!m || (m[2] && !m[1])) return false;
  const { auth, runs, session } = ctx;
  const runId = m[1] ?? null;
  const reading = m[2] === '/brief';
  const allow = reading ? 'GET, HEAD' : m[2] ? 'POST' : runId ? 'GET, HEAD' : 'GET, HEAD, POST';
  if (!allow.split(', ').includes(req.method || '')) {
    req.resume();
    send(res, 405, { ok: false, error: 'Method not allowed.', code: 'invalid' }, { Allow: allow });
    return true;
  }
  if (!session || !auth.store || !runs) {
    req.resume();
    send(res, 403, { ok: false, error: 'Agent runs belong to a signed-in maintainer on a repo with a forge: set up sign-in first (docs/sign-in.md).', code: 'forbidden' });
    return true;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    req.resume();
    if (reading) {
      // A session's only (the guard reads cookies, never a token), and a run of this repo's only
      const brief = await runs.brief(/** @type {string} */ (runId));
      send(res, brief !== null ? 200 : 404, brief !== null ? { ok: true, runId, brief } : { ok: false, error: 'cornfield has no such run.', code: 'not-found' });
      return true;
    }
    if (runId) {
      const run = isRunId(runId) ? await runs.get(runId) : null;
      send(res, run ? 200 : 404, run ? { ok: true, run } : { ok: false, error: 'cornfield has no such run.', code: 'not-found' });
      return true;
    }
    // Refresh: look at the forge first, as the person asking, so the list is as of now (never an error: the list is still the list)
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.searchParams.get('follow') === '1') {
      try {
        const forge = auth.forgeFor(session);
        // Requests written by hand first, so a run just found is followed in the same look
        await runs.discover(forge);
        await runs.follow(forge);
      } catch (err) {
        console.error(`[cornfield] agent runs: the dashboard's look at the forge could not begin: ${err instanceof Error ? err.message : err}`);
      }
    }
    send(res, 200, { ok: true, ...(await runs.list()) });
    return true;
  }

  // A change: from cornfield's own page, as JSON; past the origin, the engine counts the flood first and writes a row for everything after
  const ask = { forge: () => auth.forgeFor(session), who: { login: session.login, userId: session.userId }, limits: { auth, now: ctx.now } };
  let problem;
  let body = {};
  if (!sameOrigin(req, ctx.publicHost ?? null, [], ctx.publicOrigin ?? null)) {
    // Refused before the engine counts anything: a same-site page's POST rides on the maintainer's cookie, and a refused one must not use up
    // their budget. It is written down at most once a minute (server/throttle.js `noteRefusedOrigin`)
    req.resume();
    const answer = { ok: false, error: 'Do this from cornfield\'s own page.', code: 'forbidden' };
    const action = m[2] === '/answer' ? 'agent-answer' : runId ? 'agent-stop' : 'agent-request';
    await noteRefusedOrigin({ auth }, req, session, { action, target: ctx.config.forge?.repo ?? '', request: runId ? { runId } : {}, answer }, (ctx.now ?? Date.now)());
    send(res, 403, answer);
    return true;
  } else if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
    req.resume();
    problem = { status: 415, message: 'Send the request as JSON (Content-Type: application/json).' };
  } else {
    try {
      const parsed = parseBody(await readBody(req, runId ? STOP_LIMIT : REQUEST_LIMIT), 'The request');
      if (parsed.problem) problem = parsed.problem;
      else body = parsed.body;
    } catch {
      problem = { status: 400, message: 'The request could not be read.' };
    }
  }
  const answering = m[2] === '/answer';
  if (runId && !problem && (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => !(answering ? ['action', 'text'] : ['note']).includes(k)))) {
    problem = { status: 400, message: answering ? 'An answer is { action: "continue" | "stop" | "reply", text? }.' : 'A stop request is { note? }.' };
  }
  try {
    if (runId && answering) {
      const answered = await runs.answer(ask, { runId, action: /** @type {any} */ (body)?.action, text: /** @type {any} */ (body)?.text, problem });
      send(res, 200, { ok: true, ...answered });
    } else if (runId) {
      const stopped = await runs.stop(ask, { runId, note: /** @type {any} */ (body)?.note, problem });
      send(res, 200, { ok: true, ...stopped });
    } else {
      const made = await runs.request(ask, { body, problem });
      send(res, 201, { ok: true, ...made });
    }
  } catch (err) {
    const out = answerFor(err);
    send(res, out.status, { ok: false, ...out.body }, out.headers);
  }
  return true;
}
