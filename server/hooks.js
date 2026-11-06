/**
 * @module server/hooks
 *
 * Event hooks (PIPE-07, docs/config.md#hooks): cornfield tells outside code what happened. The config's
 * `hooks: [{ url, events }]` lists where; when something happens, `emit(event, payload)` posts one JSON body to each
 * hook that asked for that event:
 *
 *   spec.ready      a spec PR that is not a draft was first seen, or was seen at a new head: it is waiting for review.
 *                   A draft (a "Start a spec" stub among them) is never announced; one marked ready is, at its head.
 *                   cornfield has no webhook receiver: it notices when it lists the PRs (a maintainer's dashboard, or its own
 *                   timer, server/spec-poll.js), so this fires within the poll interval of the push, not at it. The first look at a repo after hooks are added announces
 *                   nothing: it records what is open, so only what changes after it is news
 *   spec.approved   a maintainer approved a proposal          spec.sentBack   a maintainer sent one back
 *   build.opened    the build issue of an approved proposal was opened
 *   pr.landed       a pull request was landed through cornfield (its Land it); a merge made on the forge sends nothing
 *   thread.opened  a new idea (an issue with the threads label, docs/threads.md) was first seen
 *   thread.message a comment was added to a thread: an idea's, or a spec PR's conversation. Once per comment
 *   thread.linked  a thread now points at the map: a message holds a `[[node]]` mention or a `cornfield-thread` block that
 *                  resolves, or a spec PR names the thread with `Thread: #n`. Its body adds `nodes` and `proposal`
 *                  Like `spec.ready`, these fire when cornfield next looks (the dashboard's threads list, or the poll,
 *                  server/spec-poll.js); a comment's text is never in the payload: `{ event, at, thread, comment?, actor, nodes?,
 *                  proposal?, mapUrl }`, so the receiver reads the words from the forge itself. The first look at a repo records
 *                  what is there and sends nothing; each (repo, thread, comment) is sent once, across restarts (`thread_seen`)
 *   session.expiring  a maintainer's sign-in ends within a day (`watchSessions`, below). Its body is its own:
 *                   `{ event, at, actor, expiresAt, mapUrl }`
 *   agent.requested  a maintainer asked for an agent run (server/agent-runs.js). Its body is its own: `{ event, at, request, actor, mapUrl }`,
 *                   `request` being the whole request JSON of the contract (docs/agent-contract.md), which holds no credential by construction
 *   trigger.skipped  an opt-in trigger (`agents.on`, server/triggers.js) was going to request a run and did not: the maintainer whose act caused it has no
 *                   live sign-in (`reason: 'no-session'`), or the request was refused (the cap, the one-run-per-subject rule, the rate limit: the refusal's code).
 *                   Its body is its own: `{ event, at, trigger: { event, by, ref }, by, reason, mapUrl }`
 *   runner.offline  on the pull transport, the last live runner token has not polled for `agents.runnerQuietAfter` (3 minutes unless set; server/runner-presence.js).
 *                   Once, and again only after a runner has been seen online again. Its body is its own: `{ event, at, label, lastSeen, mapUrl }`, never a token
 *   run.claimed  run.state  run.waiting  run.answered  run.stopRequested  run.finished   a run was claimed by its runner, changed state, reported
 *                   `waiting` (it asks a maintainer), was answered, was asked to stop, ended. They are
 *                   seen when cornfield looks (the spec poll, server/spec-poll.js), each once. Their body is their own:
 *                   `{ event, at, runId, state, pull?, issue?, action?, actor, mapUrl }`; `action` (continue, stop or reply) is only on `run.answered`,
 *                   and a reply's words are never in it
 *
 * **Triggers listen in-process.** `subscribe(fn)` hands a function the same moments the hooks fire at, with the payload resolved, whether or not
 * any hook asks for them (server/triggers.js: `spec.approved`, `build.opened`, `thread.message`). A thread's payload then also holds the
 * comment's text and times for that function alone; `bodyOf` picks fixed fields, so none of it can leave through a hook. A subscriber never
 * slows or breaks a delivery, and a failing one is only logged.
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
import { validateRequest } from '../core/agent-contract.js';

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
/** How often live sessions are looked at for `session.expiring`, and how far ahead of the end the event is sent */
export const SESSION_CHECK_MS = 60 * 60 * 1000;
export const EXPIRING_WITHIN_MS = 24 * 60 * 60 * 1000;
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
  if (!signIn) throw new Error('The config lists hooks, but sign-in is not set up. Every event comes from something a signed-in maintainer does in cornfield (a review, a build issue, a landing) or from the spec PRs cornfield lists for them, so without sign-in no hook would ever fire: set up sign-in (docs/sign-in.md), or remove `hooks`.');
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
  /** @type {{ fn: (event: string, payload: any) => unknown, events: string[] | null }[]} */
  const subscribers = [];
  const listeners = (event) => subscribers.filter((s) => s.events === null || s.events.includes(event));
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
    // A request still in flight at shutdown must not keep the process alive for its last seconds
    if (cut && typeof cut.unref === 'function') cut.unref();
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
      // Shut down while the request was in flight: nothing more is written or scheduled
      if (closed) { pending -= 1; return; }
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
    // A session's end has no spec, pull request or proposal: its body is only who, until when, and where cornfield is
    if (event === 'session.expiring') return JSON.stringify({ event, at: new Date(now()).toISOString(), actor: p.actor ?? null, expiresAt: p.expiresAt ?? null, mapUrl: publicUrl || null });
    // A skipped trigger says which trigger, who caused it and why it did nothing: never a brief or any text
    if (event === 'trigger.skipped') {
      const t = p.trigger && typeof p.trigger === 'object' ? { event: p.trigger.event ?? null, by: p.trigger.by ?? null, ref: p.trigger.ref ?? null } : null;
      return JSON.stringify({ event, at: new Date(now()).toISOString(), trigger: t, by: p.by ?? null, reason: p.reason ?? null, mapUrl: publicUrl || null });
    }
    // The runner that went quiet: its label and when it last polled, never a token
    if (event === 'runner.offline') return JSON.stringify({ event, at: new Date(now()).toISOString(), label: p.label ?? null, lastSeen: p.lastSeen ?? null, mapUrl: publicUrl || null });
    // A request goes out as it was posted, and is checked once more on the way: nothing like a credential can leave through a hook
    if (event === 'agent.requested') {
      const checked = validateRequest(p.request);
      if (!checked.ok) throw new Error(checked.error);
      return JSON.stringify({ event, at: new Date(now()).toISOString(), request: checked.value, actor: p.actor ?? null, mapUrl: publicUrl || null });
    }
    // The events of a run (claimed, state, waiting, answered, stopRequested, finished) say which run, in what state, and about what
    if (event.startsWith('run.')) {
      return JSON.stringify({
        event, at: new Date(now()).toISOString(), runId: p.runId ?? null, state: p.state ?? null,
        ...(p.pull != null ? { pull: p.pull } : {}), ...(p.issue != null ? { issue: p.issue } : {}),
        ...(event === 'run.answered' && ['continue', 'stop', 'reply'].includes(p.action) ? { action: p.action } : {}), actor: p.actor ?? null, mapUrl: publicUrl || null,
      });
    }
    // A thread's event is only which thread, which comment, who and what it links to: never the words said
    if (event.startsWith('thread.')) {
      const out = { event, at: new Date(now()).toISOString(), thread: p.thread ?? null };
      if (p.comment !== undefined) out.comment = p.comment;
      out.actor = p.actor ?? null;
      if (p.nodes !== undefined) out.nodes = p.nodes;
      if (p.proposal !== undefined) out.proposal = p.proposal;
      out.mapUrl = publicUrl || null;
      return JSON.stringify(out);
    }
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
      // Nobody wants it: the payload is not even worked out (it may read the forge)
      const local = listeners(event);
      if (!to.length && !local.length) return;
      Promise.resolve()
        .then(() => (typeof payload === 'function' ? payload() : payload))
        .then((p) => {
          // In-process listeners first, each on its own: they cannot hold up or break a delivery
          for (const { fn } of local) {
            Promise.resolve().then(() => fn(event, p || {})).catch((err) => console.error(`[cornfield] a listener of ${event} failed: ${err instanceof Error ? err.message : err}`));
          }
          if (!to.length) return;
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
   * Listens in-process to every event `emit` is given (a trigger does: server/triggers.js). `fn(event, payload)` gets the payload
   * resolved; it may be async, is never awaited and its failure is only logged. With `events`, only those: an event nobody listens to and no
   * hook asks for has its payload left unworked out.
   * @param {(event: string, payload: any) => unknown} fn
   * @param {string[]} [events]
   */
  function subscribe(fn, events) {
    if (typeof fn === 'function') subscribers.push({ fn, events: Array.isArray(events) ? [...events] : null });
  }

  /**
   * `spec.ready`: the spec PRs a listing just showed. A (pull request, head, proposal) that is not a draft and was not
   * seen before is announced once, and remembered in the SQLite file so a restart does not announce it again. A draft is
   * not recorded, so marking it ready announces it at its head. The first listing of a repo (no `hook_seen` row for it,
   * not even the `pr = 0` row that says it has been looked at) records what is open and announces nothing. Returns at
   * once, never throws.
   * @param {string} repo 'owner/name'
   * @param {import('./proposal-pulls.js').PullEntry[]} entries
   * @param {(entry: import('./proposal-pulls.js').PullEntry) => Promise<string>} read the proposal's text at its head
   */
  function specsSeen(repo, entries, read) {
    // Even an empty listing counts: it is what makes the first spec PR opened afterwards news
    if (closed || !store || !Array.isArray(entries)) return;
    (async () => {
      const db = await store();
      const at = new Date(now()).toISOString();
      const looked = db.prepare('SELECT 1 FROM hook_seen WHERE repo = ? AND pr = 0').get(repo) !== undefined;
      const insert = db.prepare('INSERT OR IGNORE INTO hook_seen (repo, pr, head_sha, slug, at) VALUES (?, ?, ?, ?, ?)');
      for (const e of entries) {
        // Waiting for review is not a draft: a draft is left out, so it is news once it is marked ready
        if (e.pull.draft) continue;
        if (insert.run(repo, e.pull.number, e.sha, e.slug, at).changes !== 1 || !looked) continue;
        emit('spec.ready', async () => ({
          slug: e.slug, pull: e.pull.number, headSha: e.sha, proposalSha256: await hashOf(read, e), actor: e.pull.author,
        }));
      }
      // The repo has been looked at: from now on, what is new is announced
      if (!looked) insert.run(repo, 0, '', '', at);
    })().catch((err) => console.error(`[cornfield] the spec PRs could not be checked for spec.ready: ${err instanceof Error ? err.message : err}`));
  }

  /**
   * Where each thread was last looked at: for the poll to ask the forge only for what is new. `looked` is whether the repo's
   * threads have been looked at before (the first look sends nothing); `threads` maps a thread's number to the forge's
   * last-update time when it was looked at (`stamp`) and the time of the newest comment seen (`since`, '' for none).
   * @param {string} repo
   * @returns {Promise<{ looked: boolean, threads: Map<number, { stamp: string, since: string }> }>}
   */
  async function threadCursors(repo) {
    const none = { looked: false, threads: new Map() };
    if (!store) return none;
    const db = await store();
    const rows = db.prepare('SELECT issue, comment, stamp FROM thread_seen WHERE repo = ?').all(repo);
    const threads = new Map();
    for (const r of rows) {
      if (r.issue === 0) continue;
      const t = threads.get(r.issue) || { stamp: '', since: '' };
      if (r.comment === '') t.stamp = r.stamp;
      else if (!r.comment.includes(':') && r.stamp > t.since) t.since = r.stamp;
      threads.set(r.issue, t);
    }
    return { looked: rows.some((r) => r.issue === 0 && r.comment === ''), threads };
  }

  /**
   * `thread.opened`, `thread.message` and `thread.linked`: the threads a look just read (server/threads.js `snapshotOf`).
   * Everything is recorded in `thread_seen` (repo, thread, comment) before it is announced, so a restart sends none twice,
   * and the first look at a repo records what is there and announces nothing. Returns a promise that resolves once the
   * events are queued; it never rejects.
   * @param {string} repo 'owner/name'
   * @param {{ threads: any[], pulls: { pull: number, thread: number, slug: string }[] }} snapshot
   */
  async function threadsSeen(repo, snapshot) {
    if (closed || !store || !snapshot || !Array.isArray(snapshot.threads)) return;
    try {
      const db = await store();
      const at = new Date(now()).toISOString();
      const looked = db.prepare("SELECT 1 FROM thread_seen WHERE repo = ? AND issue = 0 AND comment = ''").get(repo) !== undefined;
      const insert = db.prepare('INSERT OR IGNORE INTO thread_seen (repo, issue, comment, stamp, at) VALUES (?, ?, ?, ?, ?)');
      const move = db.prepare("INSERT INTO thread_seen (repo, issue, comment, stamp, at) VALUES (?, ?, '', ?, ?) ON CONFLICT(repo, issue, comment) DO UPDATE SET stamp = excluded.stamp");
      /** Whether this (thread, key) is news: new to the table, and not the silent first look */
      const fresh = (thread, key, stamp = '') => insert.run(repo, thread, key, stamp, at).changes === 1 && looked;
      for (const t of snapshot.threads) {
        if (t.opened && fresh(t.number, '', t.stamp)) emit('thread.opened', { thread: t.number, actor: t.opened.actor });
        if (t.opened && t.opened.linked && fresh(t.number, 'link:body')) {
          emit('thread.linked', { thread: t.number, actor: t.opened.actor, nodes: t.opened.linked.nodes, proposal: t.opened.linked.proposal });
        }
        for (const m of t.messages) {
          if (fresh(t.number, String(m.id), m.stamp)) emit('thread.message', { thread: t.number, comment: m.id, actor: m.actor, message: m.text });
          if (m.linked && fresh(t.number, `link:${m.id}`)) emit('thread.linked', { thread: t.number, comment: m.id, actor: m.actor, nodes: m.linked.nodes, proposal: m.linked.proposal });
        }
        // The last-update time moves with every look that read the thread, so the next look can skip it when nothing changed
        move.run(repo, t.number, t.stamp, at);
      }
      for (const p of snapshot.pulls || []) {
        if (fresh(p.thread, `pr:${p.pull}`)) emit('thread.linked', { thread: p.thread, actor: null, nodes: [], proposal: p.slug });
      }
      if (!looked) insert.run(repo, 0, '', '', at);
    } catch (err) {
      console.error(`[cornfield] the threads could not be checked for thread events: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * `session.expiring`: once an hour (and once now), the live sessions of maintainers (the ones that keep a forge token)
   * that end within 24 hours are announced, each once: the row's `expiring_sent_at` is set before the event is
   * emitted, so a restart sends none twice (and a delivery lost for good is not tried again later). A session that was
   * signed out, or ended, is not a row any more and is never announced. A user with several live sessions (a laptop and
   * a phone) gets an event for each, naming the same login and that session's own end. Needs the SQLite file, and only
   * runs when a hook asked for the event. The timer is unref'd and stopped by `close`. Returns at once, never throws.
   */
  function watchSessions() {
    if (closed || !store || !targets.some((t) => t.events.includes('session.expiring'))) return;
    const check = async () => {
      const db = await store();
      const at = now();
      const rows = db.prepare("SELECT id, login, expires_at FROM sessions WHERE token <> '' AND expiring_sent_at IS NULL AND expires_at > ? AND expires_at <= ? ORDER BY expires_at")
        .all(new Date(at).toISOString(), new Date(at + EXPIRING_WITHIN_MS).toISOString());
      const mark = db.prepare('UPDATE sessions SET expiring_sent_at = ? WHERE id = ? AND expiring_sent_at IS NULL');
      for (const r of rows) {
        if (mark.run(new Date(at).toISOString(), r.id).changes === 1) emit('session.expiring', { actor: r.login, expiresAt: r.expires_at });
      }
    };
    const tick = () => {
      if (closed) return;
      check()
        .catch((err) => console.error(`[cornfield] the sessions could not be checked for session.expiring: ${err instanceof Error ? err.message : err}`))
        .finally(() => { if (!closed) later(tick, SESSION_CHECK_MS); });
    };
    later(tick, 0);
  }

  function close() {
    closed = true;
    for (const t of timers) timer.clearTimeout(t);
    timers.clear();
  }

  return { emit, subscribe, specsSeen, threadCursors, threadsSeen, watchSessions, close };
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
