/**
 * @module server/runner-api
 *
 * The runner's side of the pull and push transports (issue #81, spec 0005 D2, D3, D5; the engine is server/agent-runs.js, the contract
 * core/agent-contract.js, the guide docs/agents.md and docs/agent-contract.md). A runner behind NAT asks cornfield for work, claims it, and
 * reports on it; a runner that was pushed a request (the `agent.requested` hook event) reports the same way.
 *
 *   GET  /api/agent-requests?state=queued      the queued requests (the contract's request JSON), oldest first, at most `QUEUE_LIMIT`
 *   POST /api/agent-requests/<runId>/claim     claims one; a second claim of it is 409. Answers the request and the run
 *   GET  /api/runs/<runId>                     { state, stopRequested, … } of a run this token holds: how a runner learns it was asked to stop
 *   POST /api/runs/<runId>                     the report JSON ({ state, note?, url?, tokens?, cost? }), checked by the contract's `validateReport`
 *
 * **These routes take a runner token (`Authorization: Bearer cf_nt_…`) and nothing else,** as the review API takes a review token
 * (server/review-api.js): they run before the sign-in guard (a runner has no cookie), read no cookie (a cookie is never a substitute, and a
 * request that sends only one is 401), need no same-origin check (a browser never adds an `Authorization` header itself), and keep the `Host`
 * check in front of every route. **The three scopes are kept apart both ways:** a review or an agent token here is 403 whatever else is true
 * of it, and a runner token on any other route (the review API, the agent API, the dashboard's routes, the page itself) is 403 too
 * (`serveStrayRunner`, which `server.js` calls before anything else is looked at).
 *
 * What a runner token may do, and nothing more: read the queue, claim, and read and report on **the runs it holds**. A pull run is held by the
 * token that claimed it; a push run by the first token to report on it (nothing else tells a push run apart: the hook went to a URL, not a
 * token). A run asked for on the forge is nobody's: its reports are `cornfield-run` comments. A token never reads a request it did not claim,
 * and never anything of cornfield's besides.
 *
 * **Token states, the anonymous flood ceiling and the rows in `actions` follow the review API.** Every call is a row (`runner-list`,
 * `runner-claim`, `runner-run`, `runner-report`, and `runner-call` for a token on the wrong route), with the token's id and label and the
 * run id in the request, and the status and error in the answer, **never the token and never a note's words**. Two bounds keep the table from
 * growing without end: past `RUNNER_PER_MINUTE` calls a minute a token is 429 and nothing is written, and an empty queue read is written down
 * at most once every `EMPTY_LIST_ROW_MS` per token (a runner polls; a poll that finds nothing says little).
 *
 *   no token, or one that no row has    401 (`WWW-Authenticate: Bearer`), logged under `(no token)`; past `ANONYMOUS_PER_MINUTE` a minute 429 and no row
 *   a review or an agent token          403, under its owner
 *   a token that is revoked or expired  403, under its owner
 *   a live runner token                 whatever the engine answers: 200, or 400, 403, 404, 409, 429
 *
 * **The token is not asked of the forge.** A runner has its own identity, and cornfield's forge sign-in of the token's owner may well have
 * ended by the time a runner polls. What bounds a runner token is its scope, its expiry (90 days at most), and that its owner revokes it in
 * the dashboard at once. (Review and agent tokens, which act as their owner on the forge, are checked against the forge on every call.)
 *
 * Nothing in an answer is a credential: the request is the contract's (validated again on the way out), and a run shows its state.
 */

import { readBody } from './proposals.js';
import { ANONYMOUS_PER_MINUTE, NO_TOKEN_LOGIN } from './review-api.js';
import { bearerOf, findToken, scopeOfShape, touchToken } from './review-tokens.js';
import { QUEUE_LIMIT } from './agent-runs.js';
import { refusal } from './submit-review.js';
import { Refused, countAttempt } from './throttle.js';
import { ForgeError } from './forge.js';

export const REQUESTS_PATH = '/api/agent-requests';
/** Calls one runner token may make in a minute: a runner polls, so this is well over a person's ceiling */
export const RUNNER_PER_MINUTE = 120;
/** An empty queue read is written down at most this often per token */
export const EMPTY_LIST_ROW_MS = 10 * 60_000;
/** A report's body, in bytes: a note, a link and two numbers, with room */
export const REPORT_LIMIT = 16 * 1024;
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const RUN_ID = '(run-[0-9A-Za-z]{26})';
const CLAIM = new RegExp(`^/api/agent-requests/${RUN_ID}/claim$`);
const RUN = new RegExp(`^/api/runs/${RUN_ID}$`);

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

/** The routes of this module: the action each is audited as, the run it names, and the methods it answers. Null for any other path. */
export function runnerRoute(reqPath) {
  let m;
  if (reqPath === REQUESTS_PATH) return { action: 'runner-list', runId: null, allow: ['GET', 'HEAD'] };
  if ((m = CLAIM.exec(reqPath))) return { action: 'runner-claim', runId: m[1], allow: ['POST'] };
  if ((m = RUN.exec(reqPath))) return { action: 'runner-run', runId: m[1], allow: ['GET', 'HEAD', 'POST'] };
  return null;
}

/** Whether a path is one that takes a bearer token of some scope (so a runner token on it is answered by that route, not as a stray) */
export const takesTokens = (reqPath, { reviews }) => reqPath === reviews || reqPath === REQUESTS_PATH || runnerRoute(reqPath) !== null;

/** The scope of a bearer token as the request presents it, by its shape alone (the row decides what it is worth) */
export const presentedScope = (req) => scopeOfShape(bearerOf(req.headers.authorization));

/** @type {WeakMap<object, Map<number, number>>} when each token's empty queue read was last written down */
const emptyReads = new WeakMap();

function emptyReadDue(auth, id, at) {
  let m = emptyReads.get(auth);
  if (!m) emptyReads.set(auth, (m = new Map()));
  for (const [k, when] of m) if (at - when >= EMPTY_LIST_ROW_MS) m.delete(k);
  if (m.has(id)) return false;
  m.set(id, at);
  return true;
}

/** What to answer for an error out of the engine: a refusal in words, or a plain 500 that says nothing of what went wrong */
function answerFor(err) {
  if (err instanceof Refused || err instanceof ForgeError) return refusal(err);
  console.error(`[cornfield] a runner call failed: ${err instanceof Error ? err.stack || err.message : err}`);
  return { status: 500, body: { error: 'Something went wrong in cornfield; the log says what.', code: 'unavailable' }, headers: {} };
}

/** @typedef {{ config: any, auth: any, runs: import('./agent-runs.js').Runs | null, now?: () => number }} RunnerContext */

/**
 * The runner routes. The caller has found the path to be one of `runnerRoute`'s; this runs before the sign-in guard.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {NonNullable<ReturnType<typeof runnerRoute>>} route
 * @param {URL} url
 * @param {RunnerContext} ctx
 */
export async function serveRunnerCall(req, res, route, url, ctx) {
  const { config, auth, runs } = ctx;
  const now = ctx.now ?? Date.now;
  const method = req.method || 'GET';
  if (!route.allow.includes(method)) {
    req.resume();
    return send(res, 405, { ok: false, error: 'Method not allowed.', code: 'invalid' }, { Allow: route.allow.join(', ') });
  }
  if (!auth.enabled || !runs) {
    req.resume();
    return send(res, 403, { ok: false, error: 'Runner tokens need sign-in and a forge: set them up first (docs/sign-in.md, docs/config.md#forge).', code: 'forbidden' });
  }
  const repo = config.forge.repo;
  const audit = async (login, request, status, answer, target = repo) => {
    try {
      await auth.record({ login, action: route.action, target, request: { via: 'api', ...(route.runId ? { runId: route.runId } : {}), ...request }, status, answer });
    } catch (err) {
      console.error(`[cornfield] a runner call could not be written to the audit table: ${err instanceof Error ? err.message : err}`);
    }
  };
  const refuse = async (login, request, status, body, headers = {}) => {
    await audit(login, request, status, { error: body.error, code: body.code });
    return send(res, status, { ok: false, ...body }, headers);
  };

  const presented = bearerOf(req.headers.authorization);
  const db = presented ? await auth.store() : null;
  const found = presented && db ? findToken(db, presented, now()) : null;
  if (!found) {
    req.resume();
    const flood = countAttempt(ctx, NO_TOKEN_LOGIN, now(), ANONYMOUS_PER_MINUTE);
    if (flood) return send(res, flood.status, { ok: false, error: flood.message, code: flood.code }, flood.headers);
    return refuse(NO_TOKEN_LOGIN, { reason: presented ? 'unknown-token' : 'no-token' }, 401,
      { error: 'A runner token is needed: send "Authorization: Bearer cf_nt_…". A token is made in the dashboard; a sign-in is not taken in its place.', code: 'unauthorized' },
      { 'WWW-Authenticate': 'Bearer realm="cornfield"' });
  }

  const { row, state } = found;
  const token = { id: row.id, label: row.label };
  if (row.scope !== 'runner' || state !== 'active') {
    req.resume();
    const flood = countAttempt(ctx, row.user_id, now());
    if (flood) return send(res, flood.status, { ok: false, error: flood.message, code: flood.code }, flood.headers);
    const wrong = row.scope !== 'runner';
    return refuse(row.login, { reason: wrong ? 'wrong-scope' : state, token, ...(wrong ? { scope: row.scope } : {}) }, 403, {
      error: wrong ? `This is ${row.scope === 'agent' ? 'an' : 'a'} ${row.scope} token. Runners take a runner token; make one in the dashboard.`
        : state === 'revoked' ? 'This runner token was revoked; make a new one in the dashboard.' : 'This runner token has expired; make a new one in the dashboard.',
      code: 'forbidden',
    });
  }
  const flood = countAttempt(ctx, `runner|${row.id}`, now(), RUNNER_PER_MINUTE);
  if (flood) {
    req.resume();
    return send(res, flood.status, { ok: false, error: flood.message, code: flood.code }, flood.headers);
  }
  touchToken(/** @type {import('node:sqlite').DatabaseSync} */ (db), row.id, now());
  const who = row.login;

  try {
    if (route.action === 'runner-list') {
      req.resume();
      if (url.searchParams.get('state') !== 'queued') throw new Refused(400, 'The only listing is ?state=queued: the requests waiting for a runner.', 'invalid');
      const requests = await runs.queued();
      if (requests.length || emptyReadDue(auth, row.id, now())) await audit(who, { token }, 200, { ok: true, count: requests.length });
      return send(res, 200, { ok: true, requests, limit: QUEUE_LIMIT });
    }
    if (route.action === 'runner-claim') {
      req.resume();
      const claimed = await runs.claim(token, route.runId);
      await audit(who, { token }, 200, { ok: true, claimed: true }, `${repo}#${claimed.row.target}`);
      return send(res, 200, { ok: true, request: claimed.request, run: claimed.run });
    }
    if (method === 'POST') {
      let body;
      let problem = null;
      try {
        const read = await readBody(req, REPORT_LIMIT);
        if (read.tooLarge) problem = new Refused(413, `A report is at most ${REPORT_LIMIT / 1024} KB.`, 'invalid');
        else {
          try {
            body = JSON.parse(read.text);
          } catch {
            // Not the parser's words: they quote the body, which the audit row would keep (a credential pasted in by mistake)
            problem = new Refused(400, 'The body is not valid JSON.', 'invalid');
          }
        }
      } catch {
        problem = new Refused(400, 'The report could not be read.', 'invalid');
      }
      const shape = body && typeof body === 'object' && !Array.isArray(body) ? { ...(typeof body.state === 'string' && body.state.length <= 20 ? { state: body.state } : {}), ...(typeof body.note === 'string' ? { noteChars: body.note.length } : {}) } : {};
      try {
        if (problem) throw problem;
        const done = await runs.report(token, route.runId, body);
        await audit(who, { token, ...shape }, 200, { ok: true, state: done.row.state }, `${repo}#${done.row.target}`);
        return send(res, 200, { ok: true, run: done.run });
      } catch (err) {
        const out = answerFor(err);
        await audit(who, { token, ...shape }, out.status, { error: out.body.error, code: out.body.code });
        return send(res, out.status, { ok: false, ...out.body }, out.headers);
      }
    }
    req.resume();
    const view = await runs.runnerGet(token, route.runId);
    await audit(who, { token }, 200, { ok: true, state: view.state });
    return send(res, 200, { ok: true, run: view });
  } catch (err) {
    const out = answerFor(err);
    await audit(who, { token }, out.status, { error: out.body.error, code: out.body.code });
    return send(res, out.status, { ok: false, ...out.body }, out.headers);
  }
}

/**
 * A runner token on a route that is not a runner's: 403, whatever the route would have said (even a path that does not exist). Called by
 * `server.js` for any request that presents something shaped like a runner token on a path outside `takesTokens`, before the guard, the proxies
 * and the page. A token that is a live runner's is counted under its own id, anything else under the anonymous ceiling; either way one row.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} reqPath
 * @param {RunnerContext} ctx
 */
export async function serveStrayRunner(req, res, reqPath, ctx) {
  const { config, auth } = ctx;
  const now = ctx.now ?? Date.now;
  req.resume();
  const body = { ok: false, error: 'A runner token is good for the runner routes only (docs/agents.md#pull): listing, claiming and reporting on runs. Nothing else of cornfield takes it.', code: 'forbidden' };
  const presented = bearerOf(req.headers.authorization);
  let owner = null;
  let token;
  if (presented && auth.enabled) {
    const found = findToken(await auth.store(), presented, now());
    if (found && found.row.scope === 'runner') { owner = found.row.login; token = { id: found.row.id, label: found.row.label }; }
  }
  const flood = owner === null ? countAttempt(ctx, NO_TOKEN_LOGIN, now(), ANONYMOUS_PER_MINUTE) : countAttempt(ctx, `runner|${token.id}`, now(), RUNNER_PER_MINUTE);
  if (flood) return send(res, flood.status, { ok: false, error: flood.message, code: flood.code }, flood.headers);
  if (auth.enabled) {
    try {
      await auth.record({
        login: owner ?? NO_TOKEN_LOGIN, action: 'runner-call', target: config.forge?.repo ?? '',
        request: { via: 'api', reason: 'wrong-route', method: String(req.method).slice(0, 10), path: reqPath.slice(0, 80), ...(token ? { token } : {}) }, status: 403, answer: { error: body.error, code: body.code },
      });
    } catch (err) {
      console.error(`[cornfield] a runner call could not be written to the audit table: ${err instanceof Error ? err.message : err}`);
    }
  }
  return send(res, 403, body);
}
