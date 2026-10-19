/**
 * @module server/forge-actions
 *
 * The two things cornfield does to a forge, and nothing else (spec 0001 section 3, CF-08): land a green pull request
 * and re-run a failed check. These are the first routes that change anything, so every rule is checked here, on the
 * server, whatever the page showed:
 *
 *   POST /api/forge/pulls/<n>/merge   { sha }          lands the pull request at head `sha`
 *   POST /api/forge/pulls/<n>/rerun   { sha, check }   re-runs one failed check on head `sha`
 *
 * In this order, each step refusing in words and the refusal written down:
 *
 *   1. POST only (405 otherwise); a signed-in maintainer only (the guard in front answers 401 and 403; without
 *      sign-in there is nobody to act as, 403)
 *   2. same origin only (`sameOrigin`, as the sign-out and the review PUT), with a JSON body: a form on another site
 *      can send neither
 *   3. not twice: one attempt at a time for the same action on the same target, a few seconds before it is asked
 *      again, and a ceiling per person per minute (429 with Retry-After)
 *   4. the permission asked of the forge now, with their own token, never the session's kept copy: someone who has
 *      stopped being a maintainer a minute ago is refused (403)
 *   5. the forge's own state, read now: the pull request is open and not a draft, every check on its head is green,
 *      and `sha` is that head (409 otherwise: a push since they looked means they look again). `forge.merge` is the
 *      only way in, with `onlyIfGreen` and the sha: there is no force and no admin override to ask for. A re-run
 *      only takes a check the forge just listed as failed on that head, where `canRerun`
 *
 * Every attempt, the ones refused and the ones the forge failed, is a row in `actions` (server/db.js), written before
 * anything is asked of the forge and finished with the answer after. Without a store to write to nothing is done.
 */

import { ForgeError, canRerun, isMaintainer } from './forge.js';
import { sameOrigin } from './proposals.js';

/** The same action on the same target is not asked again for this long (a double click, a retry before the forge has caught up) */
export const COOLDOWN_MS = 5000;
/** The most actions one person takes in a minute */
export const PER_MINUTE = 20;
/** A request body is a sha and a check's id */
const MAX_BODY = 4096;

const STATUS = { unauthorized: 401, forbidden: 403, 'not-found': 404, conflict: 409, invalid: 400, 'rate-limited': 429, unavailable: 502, 'not-green': 409 };
const SHA = /^[0-9a-f]{7,64}$/i;

/** @type {WeakMap<object, { busy: Set<string>, last: Map<string, number>, perUser: Map<string, number[]> }>} */
const throttles = new WeakMap();

/** An action's own refusal: the status to answer and the words */
class Refused extends Error {
  constructor(status, message, code, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/** Reads a small JSON object body, or refuses */
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
      req.resume();
      reject(new Refused(415, 'Send the request as JSON (Content-Type: application/json).', 'invalid'));
      return;
    }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) over = true;
      else chunks.push(c);
    });
    req.on('error', () => reject(new Refused(400, 'The request could not be read.', 'invalid')));
    req.on('end', () => {
      if (over) return reject(new Refused(413, 'The request is too large for an action.', 'invalid'));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(new Refused(400, 'The request is not a JSON object.', 'invalid'));
      }
    });
  });
}

/** Refuses a repeat and a flood; answers the key to release when the attempt is over */
function throttle(ctx, userId, key, at) {
  let t = throttles.get(ctx.auth);
  if (!t) throttles.set(ctx.auth, (t = { busy: new Set(), last: new Map(), perUser: new Map() }));
  for (const [k, when] of t.last) if (at - when >= COOLDOWN_MS) t.last.delete(k);
  const mine = (t.perUser.get(userId) || []).filter((when) => at - when < 60_000);
  t.perUser.set(userId, mine);
  const wait = (ms, words) => new Refused(429, words, 'rate-limited', { 'Retry-After': String(Math.max(1, Math.ceil(ms / 1000))) });
  if (t.busy.has(key)) throw wait(COOLDOWN_MS, 'That is already being done; wait for it to finish.');
  const before = t.last.get(key);
  if (before !== undefined && at - before < COOLDOWN_MS) throw wait(COOLDOWN_MS - (at - before), 'That was just asked; wait a few seconds before asking again.');
  if (mine.length >= PER_MINUTE) throw wait(60_000 - (at - mine[0]), `That is ${PER_MINUTE} actions in a minute; wait a little.`);
  t.busy.add(key);
  t.last.set(key, at);
  mine.push(at);
  return () => { t.busy.delete(key); };
}

/**
 * The permission of the signed-in user on the repo, asked of the forge now with their own token. Refuses unless it is
 * the same forge user as the session's and a maintainer.
 */
async function assertMaintainerNow(forge, session, config) {
  const me = await forge.me();
  if (String(me.id) !== String(session.userId)) throw new Refused(403, 'The forge says this sign-in is someone else now; sign in again.', 'forbidden');
  const permission = await forge.permission(config.forge.repo, me.login);
  if (!isMaintainer(permission)) throw new Refused(403, `Only the repo's maintainers land pull requests or re-run checks; ${me.login} is not one now.`, 'forbidden');
}

/** What an answer from the forge may change: the kept lists and pull requests are old now */
function forgetKept(db, config) {
  try {
    db.prepare('DELETE FROM forge_cache WHERE key LIKE ?').run(`${config.forge.type}|%`);
  } catch { /* a cache that cannot be cleared expires in a minute */ }
}

/**
 * The action the request is, or null for any other path.
 * @param {string} reqPath
 * @returns {{ n: number, action: 'merge' | 'rerun' } | null}
 */
export function actionOf(reqPath) {
  const m = /^\/api\/forge\/pulls\/([1-9]\d{0,8})\/(merge|rerun)$/.exec(reqPath);
  return m ? { n: Number(m[1]), action: /** @type {'merge' | 'rerun'} */ (m[2]) } : null;
}

/**
 * Answers an action request. The caller has found `reqPath` to be an action's.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ n: number, action: 'merge' | 'rerun' }} what
 * @param {{ config: object, session: { login: string, userId: string } | null, auth: { store: null | (() => Promise<import('node:sqlite').DatabaseSync>), forgeFor: Function }, now?: () => number, publicHost?: string | null }} ctx
 * @param {(status: number, body: object, headers?: object) => void} send
 */
export async function serveAction(req, res, what, ctx, send) {
  const { config, session, auth, now = Date.now } = ctx;
  const { n, action } = what;
  if (req.method !== 'POST') {
    req.resume();
    return send(405, { ok: false, error: `${action === 'merge' ? 'Landing' : 'Re-running'} is done with POST.`, code: 'invalid' }, { Allow: 'POST' });
  }
  if (!session || !auth.store) {
    req.resume();
    return send(403, { ok: false, error: 'Landing and re-running are done as the signed-in maintainer: set up sign-in first (docs/sign-in.md).', code: 'forbidden' });
  }
  const target = `${config.forge.repo}#${n}`;
  /** @type {Record<string, unknown>} */
  const request = { action, number: n };
  let db = null;
  let rowId = null;
  let release = () => {};
  /** @type {{ status: number, body: object, headers?: object, forgeStatus?: number | null }} */
  let out;
  try {
    // No audit, no action: a store that cannot be written to means the forge is not touched
    try { db = await auth.store(); } catch { db = null; }
    if (!db) throw new Refused(503, 'cornfield cannot write its audit log, so it will not act on the forge.', 'unavailable');
    const at = new Date(now()).toISOString();
    try {
      rowId = Number(db.prepare('INSERT INTO actions (at, login, action, target, request) VALUES (?, ?, ?, ?, ?)').run(at, session.login, action, target, JSON.stringify(request)).lastInsertRowid);
    } catch (err) {
      console.error(`[cornfield] the audit row of ${action} ${target} could not be written: ${err instanceof Error ? err.message : err}`);
      throw new Refused(503, 'cornfield cannot write its audit log, so it will not act on the forge.', 'unavailable');
    }

    if (!sameOrigin(req, ctx.publicHost ?? null)) {
      req.resume();
      throw new Refused(403, 'Land and re-run from cornfield\'s own page.', 'forbidden');
    }
    const body = await readJson(req);
    const sha = typeof body.sha === 'string' && SHA.test(body.sha) ? body.sha.toLowerCase() : null;
    if (!sha) throw new Refused(400, 'Say which commit: the head you were looking at.', 'invalid');
    request.sha = sha;
    let check = null;
    if (action === 'rerun') {
      check = typeof body.check === 'string' && body.check.length > 0 && body.check.length <= 200 && !body.check.includes('\0') ? body.check : null;
      if (!check) throw new Refused(400, 'Say which check to re-run.', 'invalid');
      request.check = check;
    }
    db.prepare('UPDATE actions SET request = ?, target = ? WHERE id = ?').run(JSON.stringify(request), check ? `${target}/${check}` : target, rowId);

    release = throttle(ctx, session.userId, `${session.userId}|${action}|${n}|${check || ''}`, now());
    const forge = auth.forgeFor(session);
    await assertMaintainerNow(forge, session, config);

    if (action === 'merge') {
      const landed = await forge.merge(n, { onlyIfGreen: true, sha });
      forgetKept(db, config);
      out = { status: 200, body: { ok: true, merged: true, number: n, sha: landed.sha, head: sha } };
    } else {
      const pull = await forge.pull(n);
      if (pull.state !== 'open') throw new ForgeError(`Pull request #${n} is ${pull.state}; its checks are not re-run from here.`, { code: 'conflict' });
      if (pull.head.sha.toLowerCase() !== sha) throw new ForgeError(`Pull request #${n} has changed since it was looked at (its head is now ${pull.head.sha.slice(0, 7)}); look again.`, { code: 'conflict' });
      const found = (await forge.checks(pull.head.sha)).find((c) => c.id === check);
      if (!found) throw new ForgeError(`${check} is not a check on the head of pull request #${n}; look again.`, { code: 'conflict' });
      if (!canRerun(found)) {
        throw new ForgeError(found.state === 'failure' ? `${found.name} cannot be re-run from cornfield; re-run it on the forge.` : `${found.name} has not failed; only a failed check is re-run.`, { code: 'conflict' });
      }
      await forge.rerun(found);
      forgetKept(db, config);
      out = { status: 202, body: { ok: true, rerun: true, number: n, check: found.id, name: found.name, head: sha } };
    }
  } catch (err) {
    if (err instanceof Refused) out = { status: err.status, body: { ok: false, error: err.message, code: err.code }, headers: err.headers };
    else if (err instanceof ForgeError) {
      const wait = err.rateLimit && err.rateLimit.retryAfter != null ? { 'Retry-After': String(Math.ceil(err.rateLimit.retryAfter)) } : {};
      out = { status: STATUS[err.code] || 502, body: { ok: false, error: err.message, code: err.code }, headers: wait, forgeStatus: err.status ?? (err.code === 'unavailable' ? null : STATUS[err.code] || null) };
    } else {
      out = { status: 500, body: { ok: false, error: 'Something went wrong in cornfield; the log says what.', code: 'unavailable' } };
      console.error(`[cornfield] ${action} ${target}: ${err instanceof Error ? err.stack || err.message : err}`);
    }
  } finally {
    release();
  }
  if (db && rowId !== null) {
    try {
      db.prepare('UPDATE actions SET status = ?, answer = ? WHERE id = ?').run('forgeStatus' in out ? out.forgeStatus : out.status, JSON.stringify(out.body), rowId);
    } catch (err) {
      console.error(`[cornfield] the audit row of ${action} ${target} could not be finished: ${err instanceof Error ? err.message : err}`);
    }
  }
  send(out.status, out.body, out.headers);
}
