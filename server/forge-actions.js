/**
 * @module server/forge-actions
 *
 * The things cornfield does to a forge, and nothing else (spec 0001 section 3, CF-08 and PIPE-05; ADR 0006): land a
 * green pull request, re-run a failed check, and the pipeline's own two steps (server/pipeline.js). These are the routes
 * that change anything, so every rule is checked here, on the server, whatever the page showed:
 *
 *   POST /api/forge/pulls/<n>/merge   { sha }          lands the pull request at head `sha` (step 3 of the pipeline)
 *   POST /api/forge/pulls/<n>/rerun   { sha, check }   re-runs one failed check on head `sha`
 *   POST /api/forge/issues/<n>/spec   { digest }       step 1: a branch, a stub proposal and a draft spec pull request for the issue
 *   POST /api/forge/pulls/<n>/build   { slug, sha, digest }   step 2: the build issue of an approved proposal of the spec pull request
 *
 * The two steps first show their plan (`GET` on the same address, server/forge-routes.js) and are asked for with that
 * plan's `digest`: the server plans again and refuses (409) a plan that is not the one confirmed. They are idempotent: a
 * second ask answers 200 with what the first made (`created: false`) instead of making it again.
 *
 * In this order, each step refusing in words and the refusal written down:
 *
 *   1. POST only (405 otherwise); a signed-in maintainer only (the guard in front answers 401 and 403; without
 *      sign-in there is nobody to act as, 403)
 *   2. same origin only (`sameOrigin`, as the sign-out and the review PUT), with a JSON body: a form on another site
 *      can send neither
 *   3. not twice: one attempt at a time for the same action on the same target, a few seconds before it is asked
 *      again, and a ceiling per person per minute (429 with Retry-After). Before any of this, and before a row is
 *      written, a ceiling on attempts of any kind per person per minute (`ATTEMPTS_PER_MINUTE`): a page on a sibling
 *      subdomain is same-site, so the cookie rides along, and refused attempts must not grow the audit table without end
 *   4. the permission asked of the forge now, with their own token, never the session's kept copy: someone who has
 *      stopped being a maintainer a minute ago is refused (403)
 *   5. the forge's own state, read now: the pull request is open and not a draft, every check on its head is green,
 *      and `sha` is that head (409 otherwise: a push since they looked means they look again). `forge.merge` is the
 *      only way in, with `onlyIfGreen` and the sha: there is no force and no admin override to ask for. A re-run
 *      only takes a check the forge just listed as failed on that head, where `canRerun`. A pipeline step plans
 *      again from the forge (the issue is open; the review that approves is a maintainer's and was not edited) and
 *      only adds: a branch, a file, a pull request, an issue, never changes or removes one
 *
 * Every attempt under that ceiling, the ones refused and the ones the forge failed, is a row in `actions`
 * (server/db.js), begun before anything is asked of the forge and finished with the answer after (`auth.begin`,
 * `auth.finish`). Without an audit to write to nothing is done.
 *
 * A pull request lands by the config's `forge.mergeMethod` (`merge`, `squash` or `rebase`; `merge` when unset), the way
 * the repo lands its pull requests; the forge refuses a method the repo does not allow, in its own words.
 */

import { ForgeError, RERUN_STATES, canRerun, isMaintainer } from './forge.js';
import { sameOrigin } from './proposals.js';
import { planSpec, planBuild, startSpec, openBuildIssue } from './pipeline.js';
import { PROPOSAL_FILE } from './files.js';

/** The same action on the same target is not asked again for this long (a double click, a retry before the forge has caught up) */
export const COOLDOWN_MS = 5000;
/** The most actions one person takes in a minute */
export const PER_MINUTE = 20;
/** The most attempts of any kind (refused ones too) one person makes in a minute, before any is written down */
export const ATTEMPTS_PER_MINUTE = 60;
/** A request body is a sha and a check's id */
const MAX_BODY = 4096;

const STATUS = { unauthorized: 401, forbidden: 403, 'not-found': 404, conflict: 409, invalid: 400, 'rate-limited': 429, unavailable: 502, 'not-green': 409 };
const SHA = /^[0-9a-f]{7,64}$/i;
const DIGEST = /^[0-9a-f]{32}$/;
/** What each action is called in the words of a refusal, and what it asks of the person */
const DOING = { merge: 'Landing', rerun: 'Re-running', spec: 'Starting a spec', build: 'Opening the build issue' };
const ONLY_MAINTAINERS = { merge: 'land pull requests or re-run checks', rerun: 'land pull requests or re-run checks', spec: 'start specs', build: 'open build issues' };

/** @type {WeakMap<object, { busy: Set<string>, last: Map<string, number>, perUser: Map<string, number[]>, attempts: Map<string, number[]> }>} */
const throttles = new WeakMap();

function throttlesOf(auth) {
  let t = throttles.get(auth);
  if (!t) throttles.set(auth, (t = { busy: new Set(), last: new Map(), perUser: new Map(), attempts: new Map() }));
  return t;
}

/** Counts an attempt of any kind; refuses one past the ceiling, without writing anything down (the release draft shares it) */
export function countAttempt(ctx, userId, at) {
  const t = throttlesOf(ctx.auth);
  for (const [k, list] of t.attempts) if (!list.length || at - list[list.length - 1] >= 60_000) t.attempts.delete(k);
  const mine = (t.attempts.get(userId) || []).filter((when) => at - when < 60_000);
  if (mine.length >= ATTEMPTS_PER_MINUTE) {
    t.attempts.set(userId, mine);
    return new Refused(429, `That is ${ATTEMPTS_PER_MINUTE} attempts in a minute; wait a little.`, 'rate-limited', { 'Retry-After': String(Math.max(1, Math.ceil((60_000 - (at - mine[0])) / 1000))) });
  }
  mine.push(at);
  t.attempts.set(userId, mine);
  return null;
}

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
      if (over) return;
      size += c.length;
      if (size <= MAX_BODY) { chunks.push(c); return; }
      // Too large: answered now, and the rest is not read (the connection closes once the answer is sent)
      over = true;
      req.pause();
      reject(Object.assign(new Refused(413, 'The request is too large for an action.', 'invalid', { Connection: 'close' }), { closeAfter: true }));
    });
    req.on('error', () => reject(new Refused(400, 'The request could not be read.', 'invalid')));
    req.on('end', () => {
      if (over) return;
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
  const t = throttlesOf(ctx.auth);
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
async function assertMaintainerNow(forge, session, config, action) {
  const me = await forge.me();
  if (String(me.id) !== String(session.userId)) throw new Refused(403, 'The forge says this sign-in is someone else now; sign in again.', 'forbidden');
  const permission = await forge.permission(config.forge.repo, me.login);
  if (!isMaintainer(permission)) throw new Refused(403, `Only the repo's maintainers ${ONLY_MAINTAINERS[action]}; ${me.login} is not one now.`, 'forbidden');
}

/** What an answer from the forge may change: the kept lists and pull requests are old now */
async function forgetKept(auth, config) {
  try {
    (await auth.store()).prepare('DELETE FROM forge_cache WHERE key LIKE ?').run(`${config.forge.type}|%`);
  } catch { /* a cache that cannot be cleared expires in a minute */ }
}

/**
 * The action the request is, or null for any other path.
 * @param {string} reqPath
 * @returns {{ n: number, action: 'merge' | 'rerun' | 'spec' | 'build' } | null}
 */
export function actionOf(reqPath) {
  const m = /^\/api\/forge\/(pulls|issues)\/([1-9]\d{0,8})\/(merge|rerun|build|spec)$/.exec(reqPath);
  // A spec is started on an issue; everything else is done to a pull request
  if (!m || (m[1] === 'issues') !== (m[3] === 'spec')) return null;
  return { n: Number(m[2]), action: /** @type {'merge' | 'rerun' | 'spec' | 'build'} */ (m[3]) };
}

/**
 * Answers an action request. The caller has found `reqPath` to be an action's.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ n: number, action: 'merge' | 'rerun' | 'spec' | 'build' }} what
 * @param {{ config: object, where?: { proposals: string }, session: { login: string, userId: string } | null, auth: { store: null | (() => Promise<import('node:sqlite').DatabaseSync>), forgeFor: Function }, now?: () => number, publicHost?: string | null }} ctx
 * @param {(status: number, body: object, headers?: object) => void} send
 */
export async function serveAction(req, res, what, ctx, send) {
  const { config, session, auth, now = Date.now } = ctx;
  const { n, action } = what;
  if (req.method !== 'POST') {
    req.resume();
    return send(405, { ok: false, error: `${DOING[action]} is done with POST.`, code: 'invalid' }, { Allow: action === 'spec' || action === 'build' ? 'GET, HEAD, POST' : 'POST' });
  }
  if (!session || !auth.store) {
    req.resume();
    return send(403, { ok: false, error: `${DOING[action]} is done as the signed-in maintainer: set up sign-in first (docs/sign-in.md).`, code: 'forbidden' });
  }
  // Past the ceiling nothing is written down: a flood of refused attempts cannot grow the audit table
  const flood = countAttempt(ctx, session.userId, now());
  if (flood) {
    req.resume();
    return send(flood.status, { ok: false, error: flood.message, code: flood.code }, flood.headers);
  }
  const target = `${config.forge.repo}#${n}`;
  /** @type {Record<string, unknown>} */
  const request = { action, number: n };
  let rowTarget = target;
  let rowId = null;
  let closeAfter = false;
  let release = () => {};
  /** @type {{ status: number, body: object, headers?: object, forgeStatus?: number | null }} */
  let out;
  try {
    // No audit, no action: a row that cannot be begun means the forge is not touched
    try {
      rowId = await auth.begin({ login: session.login, action, target, request });
    } catch (err) {
      console.error(`[cornfield] the audit row of ${action} ${target} could not be written: ${err instanceof Error ? err.message : err}`);
      throw new Refused(503, 'cornfield cannot write its audit log, so it will not act on the forge.', 'unavailable');
    }

    if (!sameOrigin(req, ctx.publicHost ?? null)) {
      req.resume();
      throw new Refused(403, 'Do this from cornfield\'s own page.', 'forbidden');
    }
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      closeAfter = Boolean(err && err.closeAfter);
      throw err;
    }
    const sha = typeof body.sha === 'string' && SHA.test(body.sha) ? body.sha.toLowerCase() : null;
    if (action !== 'spec' && !sha) throw new Refused(400, 'Say which commit: the head you were looking at.', 'invalid');
    if (sha) request.sha = sha;
    // The pipeline's steps confirm a plan: the digest of what the person was shown
    const digest = typeof body.digest === 'string' && DIGEST.test(body.digest) ? body.digest : null;
    let slug = null;
    if (action === 'spec' || action === 'build') {
      if (!digest) throw new Refused(400, 'Say which plan: the digest of what you were shown.', 'invalid');
      request.digest = digest;
    }
    if (action === 'build') {
      slug = typeof body.slug === 'string' && body.slug.length <= 200 && PROPOSAL_FILE.test(`${body.slug}.json`) ? body.slug : null;
      if (!slug) throw new Refused(400, 'Say which proposal: its name in the proposals folder.', 'invalid');
      request.slug = slug;
      rowTarget = `${target}/${slug}`;
    }
    let check = null;
    if (action === 'rerun') {
      check = typeof body.check === 'string' && body.check.length > 0 && body.check.length <= 200 && !body.check.includes('\0') ? body.check : null;
      if (!check) throw new Refused(400, 'Say which check to re-run.', 'invalid');
      request.check = check;
      rowTarget = `${target}/${check}`;
    }

    release = throttle(ctx, session.userId, `${session.userId}|${action}|${n}|${check || slug || ''}`, now());
    const forge = auth.forgeFor(session);
    await assertMaintainerNow(forge, session, config, action);

    if (action === 'spec') {
      // What would be made is worked out again from the forge; it has to be what was shown
      const plan = await planSpec(forge, config, ctx.where || { proposals: config.proposals }, n);
      request.branch = plan.branch;
      request.path = plan.path;
      if (!plan.existing && plan.digest !== digest) throw new ForgeError(`What starting a spec for #${n} would make has changed since it was shown (the issue was edited); look again.`, { code: 'conflict' });
      const done = await startSpec(forge, plan);
      await forgetKept(auth, config);
      out = { status: done.created ? 201 : 200, body: { ok: true, action, created: done.created, number: n, pull: done.pull, branch: plan.branch, path: plan.path } };
    } else if (action === 'build') {
      const plan = await planBuild(forge, ctx.where || { proposals: config.proposals }, n, /** @type {string} */ (slug));
      request.path = plan.path;
      // An issue the first ask made is found whatever has changed since; a new one is made only for the plan that was shown
      if (!plan.existing && plan.sha.toLowerCase() !== sha) throw new ForgeError(`Pull request #${n} has changed since it was looked at (its proposal is now at ${plan.sha.slice(0, 7)}); look again.`, { code: 'conflict' });
      if (!plan.existing && plan.digest !== digest) throw new ForgeError(`What the build issue for ${slug} would say has changed since it was shown (a new review, or a push); look again.`, { code: 'conflict' });
      const done = await openBuildIssue(forge, plan);
      await forgetKept(auth, config);
      out = { status: done.created ? 201 : 200, body: { ok: true, action, created: done.created, number: n, slug, issue: done.issue, path: plan.path } };
    } else if (action === 'merge') {
      const method = config.forge.mergeMethod || 'merge';
      request.method = method;
      const landed = await forge.merge(n, { onlyIfGreen: true, sha, method });
      await forgetKept(auth, config);
      out = { status: 200, body: { ok: true, merged: true, number: n, sha: landed.sha, head: sha, method } };
    } else {
      const pull = await forge.pull(n);
      if (pull.state !== 'open') throw new ForgeError(`Pull request #${n} is ${pull.state}; its checks are not re-run from here.`, { code: 'conflict' });
      if (pull.head.sha.toLowerCase() !== sha) throw new ForgeError(`Pull request #${n} has changed since it was looked at (its head is now ${pull.head.sha.slice(0, 7)}); look again.`, { code: 'conflict' });
      const found = (await forge.checks(pull.head.sha)).find((c) => c.id === check);
      if (!found) throw new ForgeError(`${check} is not a check on the head of pull request #${n}; look again.`, { code: 'conflict' });
      if (!canRerun(found)) {
        throw new ForgeError(RERUN_STATES.includes(found.state) ? `${found.name} cannot be re-run from cornfield; re-run it on the forge.` : `${found.name} has not failed; only a failed or cancelled check is re-run.`, { code: 'conflict' });
      }
      await forge.rerun(found);
      await forgetKept(auth, config);
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
  if (rowId !== null) {
    try {
      await auth.finish(rowId, { target: rowTarget, request, status: 'forgeStatus' in out ? out.forgeStatus ?? null : out.status, answer: out.body });
    } catch (err) {
      console.error(`[cornfield] the audit row of ${action} ${target} could not be finished: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (closeAfter) res.on('finish', () => req.destroy());
  send(out.status, out.body, out.headers);
}
