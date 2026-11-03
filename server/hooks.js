/**
 * @module server/hooks
 *
 * Event hooks (PIPE-07, docs/config.md#hooks): cornfield tells outside code what happened. The config's
 * `hooks: [{ url, events }]` lists where; when something happens, `emit(event, payload)` posts one JSON body to each
 * hook that asked for that event:
 *
 *   spec.ready      a spec PR was first seen, or was seen at a new head (cornfield has no webhook receiver: it notices
 *                   when it next lists the PRs, so this fires when cornfield next looks, not at the push)
 *   spec.approved   a maintainer approved a proposal          spec.sentBack   a maintainer sent one back
 *   build.opened    the build issue of an approved proposal was opened
 *   pr.landed       a pull request was landed
 *
 * **A hook never gets in the way.** `emit` returns at once and never throws; the delivery runs in the background, from a
 * queue in memory. A failed delivery (a network error, a timeout, anything but a 2xx) is tried again after 1s, 5s and 30s
 * (four attempts in all) and every attempt is a row in the `actions` audit table (`action: 'hook'`). A hook that is
 * dead, slow or wrong changes nothing else in cornfield. Deliveries wait in memory only: a restart forgets the ones
 * still being retried.
 *
 * **What is sent.** `{ event, at, slug, pull, headSha, proposalSha256, actor, note?, edits?, mapUrl }`, built here from
 * a fixed list of fields, so nothing else can leak into it: never file contents, a token or an email. The hook's URL
 * comes only from the maintainer's config and is still treated with care: no redirect is followed, a request is given
 * 10 seconds, and at most `MAX_RESPONSE_BYTES` of the answer are read (it is never kept). The audit rows name the hook's
 * origin only, never its path or query, which may hold a secret of the receiver's.
 *
 * **Signed.** Each request carries `X-Cornfield-Signature: sha256=<hex>`, the HMAC-SHA256 of the raw body under
 * CORNFIELD_HOOK_SECRET (env only, at least 32 characters; hooks without it are a startup error, `hooksSettings`), and
 * `X-Cornfield-Event`, `X-Cornfield-Delivery` (a UUID, the same on every retry) and `X-Cornfield-Timestamp` (the body's
 * `at`), so a receiver can refuse a replay. The secret is never logged or put in a row.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { HOOK_EVENTS } from '../core/config.js';
import { pullProposals, readPullProposal } from './proposal-pulls.js';
import { proposalHash } from './reviews.js';

/** @typedef {ReturnType<typeof createHooks>} Hooks */

export { HOOK_EVENTS };
/** The env var the signing secret is read from: never the config file */
export const HOOK_SECRET_ENV = 'CORNFIELD_HOOK_SECRET';
export const MIN_HOOK_SECRET = 32;
/** The wait before each retry; the first attempt is made at once, so a failing hook is tried four times */
export const BACKOFF_MS = Object.freeze([1_000, 5_000, 30_000]);
/** How long one request may take */
export const TIMEOUT_MS = 10_000;
/** How much of an answer is read before it is dropped */
export const MAX_RESPONSE_BYTES = 4096;
/** The most deliveries waiting (or being retried) at once; one past it is dropped, and the audit table says so */
export const MAX_PENDING = 500;

/**
 * The hook settings env gives, or null when the config lists no hooks. Throws, in words, when hooks are listed but cannot
 * work: no secret, a short one, or no sign-in (every event comes from a signed-in maintainer's action or listing).
 * @param {{ hooks?: unknown[] }} config
 * @param {Record<string, string | undefined>} [env]
 * @param {boolean} [signIn] whether sign-in is configured
 * @returns {null | { secret: string }}
 */
export function hooksSettings(config, env = process.env, signIn = true) {
  if (!Array.isArray(config.hooks) || config.hooks.length === 0) return null;
  const secret = env[HOOK_SECRET_ENV];
  if (typeof secret !== 'string' || secret === '') throw new Error(`The config lists hooks, so ${HOOK_SECRET_ENV} is needed: a random value of at least ${MIN_HOOK_SECRET} characters that signs every event (openssl rand -base64 48). Never put it in the config.`);
  if (secret.length < MIN_HOOK_SECRET) throw new Error(`${HOOK_SECRET_ENV} is too short: use at least ${MIN_HOOK_SECRET} random characters (openssl rand -base64 48).`);
  if (!signIn) throw new Error('The config lists hooks, but events come from a signed-in maintainer\'s actions and from the spec PRs cornfield lists for them: set up sign-in first (docs/sign-in.md), or remove `hooks`.');
  return { secret };
}

/** The HMAC-SHA256 of a body under the secret, as a request header carries it */
export const sign = (secret, body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/** A hook's address for the audit table: the origin only (a path or query may be a secret of the receiver's) */
const originOf = (url) => new URL(url).origin;

/** What went wrong with a request, without its message (a fetch error's text can hold the URL) */
const reasonOf = (err) => {
  if (err && err.name === 'AbortError') return 'timeout';
  const code = err && (err.cause?.code || err.code);
  return typeof code === 'string' ? code : 'error';
};

/** Reads at most `cap` bytes of a response and drops the rest, so the connection is freed */
async function drain(res, cap) {
  if (!res.body) return;
  const reader = res.body.getReader();
  let read = 0;
  try {
    while (read < cap) {
      const { done, value } = await reader.read();
      if (done) return;
      read += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * The hooks of a server.
 * @param {{
 *   hooks: { url: string, events: string[] | '*' }[],
 *   secret: string,
 *   fetch?: typeof fetch,
 *   record?: (entry: { login: string, action: string, target: string, request?: object, status?: number | null, answer?: object | null }) => Promise<void> | void,
 *   store?: (() => Promise<import('node:sqlite').DatabaseSync>) | null,
 *   now?: () => number,
 *   publicUrl?: string | null,
 *   timer?: { setTimeout: Function, clearTimeout: Function },
 *   backoff?: readonly number[],
 * }} opts `fetch`, `timer` and `backoff` are for tests; `store` is the SQLite file `spec.ready` remembers what it sent in
 */
export function createHooks({ hooks, secret, fetch: doFetch = globalThis.fetch, record, store = null, now = Date.now, publicUrl = null, timer = { setTimeout, clearTimeout }, backoff = BACKOFF_MS }) {
  if (typeof secret !== 'string' || secret.length < MIN_HOOK_SECRET) throw new Error(`${HOOK_SECRET_ENV} must be at least ${MIN_HOOK_SECRET} characters.`);
  const targets = hooks.map((h, i) => ({ index: i, url: h.url, origin: originOf(h.url), events: h.events === '*' ? HOOK_EVENTS : h.events }));
  const timers = new Set();
  let pending = 0;
  let closed = false;

  const later = (fn, ms) => {
    const t = timer.setTimeout(() => { timers.delete(t); fn(); }, ms);
    if (t && typeof t.unref === 'function') t.unref();
    timers.add(t);
    return t;
  };

  const audit = async (target, request, status, answer) => {
    if (!record || closed) return;
    try {
      await record({ login: 'cornfield', action: 'hook', target, request, status, answer });
    } catch (err) {
      console.error(`[cornfield] a hook delivery could not be written to the audit table: ${err instanceof Error ? err.message : err}`);
    }
  };

  /** One request, answered with its HTTP status (null when there was none) and why it failed (null when it did not) */
  async function post(t, headers, body) {
    const ctl = new AbortController();
    const cut = timer.setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      // A redirect is never followed: the address is the maintainer's, and only it
      const res = await doFetch(t.url, { method: 'POST', headers, body, redirect: 'manual', signal: ctl.signal });
      await drain(res, MAX_RESPONSE_BYTES);
      return res.status >= 200 && res.status < 300 ? { status: res.status, failed: null } : { status: res.status, failed: res.status >= 300 && res.status < 400 ? 'redirect' : 'status' };
    } catch (err) {
      return { status: null, failed: reasonOf(err) };
    } finally {
      timer.clearTimeout(cut);
    }
  }

  function deliver(t, event, delivery, body) {
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'cornfield-hooks',
      'X-Cornfield-Event': event,
      'X-Cornfield-Delivery': delivery,
      'X-Cornfield-Timestamp': JSON.parse(body).at,
      'X-Cornfield-Signature': sign(secret, body),
    };
    const target = `${event} to ${t.origin}`;
    const attempt = async (n) => {
      if (closed) { pending -= 1; return; }
      const out = await post(t, headers, body);
      const last = out.failed !== null && n > backoff.length;
      const request = { event, delivery, hook: t.index, origin: t.origin, attempt: n };
      await audit(target, request, out.status, out.failed === null ? { ok: true } : { ok: false, reason: out.failed, ...(last ? { gaveUp: true } : { retryInMs: backoff[n - 1] }) });
      if (out.failed === null || last) { pending -= 1; return; }
      later(() => { attempt(n + 1).catch(() => {}); }, backoff[n - 1]);
    };
    attempt(1).catch((err) => console.error(`[cornfield] a hook delivery failed unexpectedly: ${err instanceof Error ? err.message : err}`));
  }

  /** The body of an event: only the fields of the payload, in a fixed order */
  function bodyOf(event, p) {
    const out = {
      event, at: new Date(now()).toISOString(), slug: p.slug ?? null, pull: p.pull ?? null, headSha: p.headSha ?? null,
      proposalSha256: p.proposalSha256 ?? null, actor: p.actor ?? null,
    };
    if (p.note !== undefined) out.note = p.note;
    if (p.edits !== undefined) out.edits = p.edits;
    out.mapUrl = publicUrl || null;
    return JSON.stringify(out);
  }

  /**
   * Sends `event` to each hook that asked for it. Returns at once and never throws. The payload is an object, or a
   * function returning one (or a promise of one): that is run in the background too, so gathering it never slows the
   * action down, and a failure gathering it is written down and sends nothing.
   * @param {string} event one of HOOK_EVENTS
   * @param {object | (() => object | Promise<object>)} payload
   */
  function emit(event, payload) {
    try {
      if (closed || !HOOK_EVENTS.includes(event)) return;
      const to = targets.filter((t) => t.events.includes(event));
      if (!to.length) return;
      Promise.resolve()
        .then(() => (typeof payload === 'function' ? payload() : payload))
        .then((p) => {
          const body = bodyOf(event, p || {});
          for (const t of to) {
            if (pending >= MAX_PENDING) {
              audit(`${event} to ${t.origin}`, { event, hook: t.index, origin: t.origin }, null, { ok: false, reason: 'queue-full', gaveUp: true });
              continue;
            }
            pending += 1;
            deliver(t, event, randomUUID(), body);
          }
        })
        .catch((err) => {
          console.error(`[cornfield] the ${event} hook event could not be built: ${err instanceof Error ? err.message : err}`);
          audit(`${event}`, { event }, null, { ok: false, reason: 'payload', gaveUp: true });
        });
    } catch (err) {
      console.error(`[cornfield] the ${event} hook event was not sent: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * `spec.ready`: the spec PRs a listing just showed. A (pull request, head, proposal) not seen before is announced
   * once, and remembered in the SQLite file so a restart does not announce it again. Returns at once, never throws.
   * @param {string} repo 'owner/name'
   * @param {import('./proposal-pulls.js').PullEntry[]} entries
   * @param {(entry: import('./proposal-pulls.js').PullEntry) => Promise<string>} read the proposal's text at its head
   */
  function specsSeen(repo, entries, read) {
    if (closed || !store || !entries.length) return;
    (async () => {
      const db = await store();
      const insert = db.prepare('INSERT OR IGNORE INTO hook_seen (repo, pr, head_sha, slug, at) VALUES (?, ?, ?, ?, ?)');
      for (const e of entries) {
        if (insert.run(repo, e.pull.number, e.sha, e.slug, new Date(now()).toISOString()).changes !== 1) continue;
        emit('spec.ready', async () => ({
          slug: e.slug, pull: e.pull.number, headSha: e.sha, proposalSha256: await hashOf(read, e), actor: e.pull.author,
        }));
      }
    })().catch((err) => console.error(`[cornfield] the spec PRs could not be checked for spec.ready: ${err instanceof Error ? err.message : err}`));
  }

  function close() {
    closed = true;
    for (const t of timers) timer.clearTimeout(t);
    timers.clear();
  }

  return { emit, specsSeen, close };
}

/** The SHA-256 of a proposal file as `read` gives it, or null when it cannot be read (an event still goes out) */
async function hashOf(read, entry) {
  try {
    return proposalHash(await read(entry));
  } catch {
    return null;
  }
}

/**
 * The payload of an event about a proposal on a spec PR: the slug, the PR, its head and the file's hash. `extra` is who
 * acted and, for a review, the note and edits.
 * @param {import('./forge.js').Forge} forge
 * @param {{ proposals: string }} where
 * @param {{ slug: string, sha: string, path: string, pull: { number: number } }} entry
 * @param {{ actor: string | null, note?: string, edits?: object[] }} extra
 */
export async function proposalPayload(forge, where, entry, extra) {
  return { slug: entry.slug, pull: entry.pull.number, headSha: entry.sha, proposalSha256: await hashOf((e) => readPullProposal(forge, where, e), entry), ...extra };
}

/**
 * The payload of `pr.landed`: the PR, the head that landed, and, when it is a spec PR, its proposal's slug and hash (the
 * first when it holds several). A forge that cannot say leaves those null; the event still goes out.
 * @param {import('./forge.js').Forge} forge
 * @param {{ proposals: string }} where
 * @param {number} n the landed pull request
 * @param {string} sha the head that landed
 * @param {string} actor
 */
export async function landedPayload(forge, where, n, sha, actor) {
  let entry = null;
  try {
    entry = (await pullProposals(forge, where, await forge.pull(n)))[0] ?? null;
  } catch { /* not known: a plain pull request */ }
  if (!entry) return { slug: null, pull: n, headSha: sha, proposalSha256: null, actor };
  return { ...(await proposalPayload(forge, where, entry, { actor })), pull: n, headSha: sha };
}
