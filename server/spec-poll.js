/**
 * @module server/spec-poll
 *
 * `spec.ready` and the `thread.*` events without anyone at the dashboard (PIPE-10, docs/config.md#hook-poll, docs/threads.md).
 * cornfield notices a spec PR when it
 * lists the open ones, and that listing used to run only when a maintainer opened the proposals menu or the issues and PRs
 * panel. A team that reviews from chat never does, so this lists them on a timer.
 *
 * **It is the same look, not a second one.** Each tick calls `listPullProposals` (server/proposal-pulls.js) with the hooks,
 * exactly as the dashboard does, so the draft rule, the silent first look, the once-per-(PR, head, proposal) rule and the
 * `hook_seen` table are the ones that already exist: a poll and a dashboard look never announce the same head twice, and
 * nothing here decides what is news. The forge answers come through the same per-head cache, so a tick with nothing new
 * costs the open-PR listing (a call a page) plus the two calls that check the token's owner; see the docs for the count.
 *
 * **Threads ride the same tick.** When a hook wants `thread.opened`, `thread.message` or `thread.linked` (and threads are on),
 * the look also reads the ideas and the spec PRs' conversations (server/threads.js) with the same sign-in, the same timer and
 * the same backoff: one look, one set of calls to the forge for the open PRs, then what the database says is new
 * (`hooks.threadCursors`: an idea whose update time is the one last seen is not read again, and the rest are read from their
 * newest seen comment on). A failure in either half is the tick's failure.
 *
 * **Whose token.** Never one from the config. The newest live sign-in of a user the forge confirms is a maintainer now
 * (`auth.forgeForUser`, then `me()` and `permission()` with that token; the same check the review API and the lander make).
 * A user who is not, or whose token the forge refuses, is passed over for the next newest, at most `MAX_CANDIDATES`; their
 * token is only ever asked those two questions, never used to list. With no such session the tick does nothing and says so
 * once for the stretch (and once more when a session is back). Whose sign-in it looks with is logged each time that changes.
 *
 * **It also follows agent runs** (issue #80, server/agent-runs.js): when there is a run to look at (`runs.hasWork()`, a question of the
 * database alone, so an idle repo costs the forge nothing), the same tick hands the same maintainer's forge to `runs.follow`, which reads the
 * runs' comments and pull requests. A server with no `spec.ready` hook still polls for runs (`specs: false`) and then does nothing else.
 *
 * **Never in the way.** One tick runs at a time (the next is scheduled when one ends, so a slow forge cannot pile them up).
 * A forge error is logged and never thrown; the next tick waits twice the interval until one succeeds. The timer is
 * unref'd and `close()` clears it.
 */

import { isMaintainer } from './forge.js';
import { listPullProposals } from './proposal-pulls.js';
import { gatherThreads, snapshotOf, POLL_LIMIT } from './threads.js';
import { hookWants, threadsOn, triggersOf, THREAD_EVENTS } from '../core/config.js';
import { readTopology } from '../core/validate.js';

/** How long after start the first look is made: soon, so the repo's silent first look is not left to the first interval */
export const FIRST_MS = 15_000;
/** The most signed-in users tried per tick before giving up for this tick */
export const MAX_CANDIDATES = 5;

const iso = (ms) => new Date(ms).toISOString();
const words = (err) => (err instanceof Error ? err.message : String(err));

/**
 * The forge as the newest live sign-in of a user who is a maintainer now, and their login, or null when there is none: the sign-ins are
 * tried newest first, at most `MAX_CANDIDATES` users, and a token the forge refuses passes to the next. The token is only asked who it is and
 * what it may do on the repo. Shared with the triggers (server/triggers.js), which confirm a commenter with it.
 * @param {{ auth: { store: () => Promise<import('node:sqlite').DatabaseSync>, forgeForUser: (userId: string) => Promise<import('./forge.js').Forge> }, repo: string, now?: () => number }} opts
 * @returns {Promise<{ forge: import('./forge.js').Forge, login: string } | null>}
 */
export async function findMaintainerForge({ auth, repo, now = Date.now }) {
  const rows = /** @type {{ user_id: string }[]} */ ((await auth.store()).prepare("SELECT user_id FROM sessions WHERE token <> '' AND expires_at > ? ORDER BY created_at DESC, rowid DESC").all(iso(now())));
  const users = [...new Set(rows.map((r) => r.user_id))].slice(0, MAX_CANDIDATES);
  for (const userId of users) {
    try {
      const forge = await auth.forgeForUser(userId);
      const me = await forge.me();
      if (String(me.id) === userId && isMaintainer(await forge.permission(repo, me.login))) return { forge, login: me.login };
    } catch { /* this user's token is gone or refused: the next one */ }
  }
  return null;
}

/**
 * @param {{
 *   config: any,
 *   where: { proposals: string },
 *   auth: { store: () => Promise<import('node:sqlite').DatabaseSync>, forgeForUser: (userId: string) => Promise<import('./forge.js').Forge> },
 *   hooks: import('./hooks.js').Hooks | null,
 *   runs?: { hasWork: () => Promise<boolean>, follow: (forge: import('./forge.js').Forge) => Promise<unknown> } | null,
 *   specs?: boolean,
 *   intervalMs: number,
 *   now?: () => number,
 *   timer?: { setTimeout: Function, clearTimeout: Function },
 *   firstMs?: number,
 * }} opts `now`, `timer` and `firstMs` are the tests' clock; `runs` is the agent runs engine, whose runs are followed on the same tick, and
 *   `specs: false` leaves the spec PRs alone (no hook wants `spec.ready`), so only the runs are looked at
 */
export function createSpecPoll({ config, where, auth, hooks, runs = null, specs = true, intervalMs, now = Date.now, timer = { setTimeout, clearTimeout }, firstMs = FIRST_MS }) {
  const repo = config.forge.repo;
  const log = (what) => console.error(`[cornfield] spec.ready poll: ${what}`);
  let handle = null;
  let closed = false;
  let running = null;
  let failing = false;
  /** Whether the last tick found no maintainer to look as; what makes the log once per stretch */
  let noSession = false;
  /** Whose token the last look used: the log names them each time that changes, so whose sign-in is read with is on record */
  let lookingAs = null;

  /** Whether a look reads the threads: a hook wants a thread.* event, or a trigger listens for `/agent` in a message (server/triggers.js) */
  const wantsThreads = () => threadsOn(config) && (hookWants(config, THREAD_EVENTS) || triggersOf(config).some(([e]) => e === 'thread.message'));
  const maintainerForge = () => findMaintainerForge({ auth, repo, now });

  /** The checkout's nodes, for a hook's `nodes` to be the ones a mention resolves to; none when there is no map */
  function mapNodes() {
    try {
      const topology = readTopology(config);
      return topology && Array.isArray(topology.nodes) ? topology.nodes : [];
    } catch {
      return [];
    }
  }

  /** The ideas and the spec PRs' conversations, read from where the database left off and handed to the hooks */
  async function lookAtThreads(forge, withSpecs) {
    const cursors = await hooks.threadCursors(repo);
    const got = await gatherThreads(forge, config, where, { state: 'all', limit: POLL_LIMIT, hooks: withSpecs ? hooks : null, cursors: cursors.looked ? cursors.threads : null });
    await hooks.threadsSeen(repo, snapshotOf(got, mapNodes()));
    return got.problem;
  }

  /** One look. Resolves to what happened; never rejects. */
  async function look() {
    // Nothing to look at: no forge call is made (an idle repo with only runs to follow costs nothing)
    let followRuns = false;
    try {
      followRuns = Boolean(runs) && await /** @type {NonNullable<typeof runs>} */ (runs).hasWork();
    } catch (err) {
      log(`the runs could not be counted: ${words(err)}`);
    }
    if (!specs && !followRuns) return 'ok';
    let found;
    try {
      found = await maintainerForge();
    } catch (err) {
      log(`the sign-ins could not be read: ${words(err)}`);
      return 'error';
    }
    // Closed while the sign-ins were checked: the open PRs are not listed with a token after close()
    if (closed) return 'closed';
    if (!found) {
      lookingAs = null;
      if (!noSession) log('no signed-in maintainer to look as, so the open spec PRs are not checked; it resumes when one signs in');
      noSession = true;
      return 'no-session';
    }
    if (noSession) log('a signed-in maintainer is back; checking the open spec PRs again');
    noSession = false;
    if (found.login !== lookingAs) log(`looking at the open spec PRs${wantsThreads() ? ' and threads' : ''} with the sign-in of @${found.login}, a maintainer`);
    lookingAs = found.login;
    let out = 'ok';
    if (specs) {
      try {
        const specReady = hookWants(config, ['spec.ready']);
        const threads = wantsThreads();
        // One listing of the open PRs serves both: the threads' look makes it itself when it runs
        const problem = threads ? await lookAtThreads(found.forge, specReady) : (await listPullProposals(found.forge, where, { hooks })).problem;
        if (problem) {
          log(`the forge could not be asked: ${problem}`);
          out = 'error';
        }
      } catch (err) {
        log(`failed: ${words(err)}`);
        out = 'error';
      }
    }
    if (followRuns && !closed) {
      try {
        await /** @type {NonNullable<typeof runs>} */ (runs).follow(found.forge);
      } catch (err) {
        log(`the runs could not be followed: ${words(err)}`);
        out = 'error';
      }
    }
    return out;
  }

  function schedule(ms) {
    if (closed) return;
    handle = timer.setTimeout(() => { handle = null; tick(); }, ms);
    if (handle && typeof handle.unref === 'function') handle.unref();
  }

  /**
   * One tick: a look, unless one is still running, then the next is scheduled (twice the interval after a failure, until
   * one succeeds).
   * @returns {Promise<'ok' | 'error' | 'no-session' | 'busy' | 'closed'>}
   */
  function tick() {
    if (closed) return Promise.resolve('closed');
    if (running) return Promise.resolve('busy');
    running = look().then((out) => {
      if (out === 'closed') { running = null; return out; }
      if (out !== 'no-session') failing = out === 'error';
      running = null;
      schedule(failing ? intervalMs * 2 : intervalMs);
      return out;
    });
    return running;
  }

  return {
    intervalMs,
    tick,
    /** Starts the timer: the first look after `firstMs`, then every interval */
    start() {
      if (closed || handle || running) return;
      schedule(firstMs);
    },
    close() {
      closed = true;
      if (handle !== null) timer.clearTimeout(handle);
      handle = null;
    },
  };
}
