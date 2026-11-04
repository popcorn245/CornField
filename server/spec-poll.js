/**
 * @module server/spec-poll
 *
 * `spec.ready` without anyone at the dashboard (PIPE-10, docs/config.md#hook-poll). cornfield notices a spec PR when it
 * lists the open ones, and that listing used to run only when a maintainer opened the proposals menu or the issues and PRs
 * panel. A team that reviews from chat never does, so this lists them on a timer.
 *
 * **It is the same look, not a second one.** Each tick calls `listPullProposals` (server/proposal-pulls.js) with the hooks,
 * exactly as the dashboard does, so the draft rule, the silent first look, the once-per-(PR, head, proposal) rule and the
 * `hook_seen` table are the ones that already exist: a poll and a dashboard look never announce the same head twice, and
 * nothing here decides what is news. The forge answers come through the same per-head cache, so a tick with nothing new
 * costs the open-PR listing (a call a page) plus the two calls that check the token's owner; see the docs for the count.
 *
 * **Whose token.** Never one from the config. The newest live sign-in of a user the forge confirms is a maintainer now
 * (`auth.forgeForUser`, then `me()` and `permission()` with that token; the same check the review API and the lander make).
 * A user who is not, or whose token the forge refuses, is passed over for the next newest, at most `MAX_CANDIDATES`. With no
 * such session the tick does nothing and says so once for the stretch (and once more when a session is back).
 *
 * **Never in the way.** One tick runs at a time (the next is scheduled when one ends, so a slow forge cannot pile them up).
 * A forge error is logged and never thrown; the next tick waits twice the interval until one succeeds. The timer is
 * unref'd and `close()` clears it.
 */

import { isMaintainer } from './forge.js';
import { listPullProposals } from './proposal-pulls.js';

/** How long after start the first look is made: soon, so the repo's silent first look is not left to the first interval */
export const FIRST_MS = 15_000;
/** The most signed-in users tried per tick before giving up for this tick */
export const MAX_CANDIDATES = 5;

const iso = (ms) => new Date(ms).toISOString();
const words = (err) => (err instanceof Error ? err.message : String(err));

/**
 * @param {{
 *   config: any,
 *   where: { proposals: string },
 *   auth: { store: () => Promise<import('node:sqlite').DatabaseSync>, forgeForUser: (userId: string) => Promise<import('./forge.js').Forge> },
 *   hooks: import('./hooks.js').Hooks,
 *   intervalMs: number,
 *   now?: () => number,
 *   timer?: { setTimeout: Function, clearTimeout: Function },
 *   firstMs?: number,
 * }} opts `now`, `timer` and `firstMs` are the tests' clock
 */
export function createSpecPoll({ config, where, auth, hooks, intervalMs, now = Date.now, timer = { setTimeout, clearTimeout }, firstMs = FIRST_MS }) {
  const repo = config.forge.repo;
  const log = (what) => console.error(`[cornfield] spec.ready poll: ${what}`);
  let handle = null;
  let closed = false;
  let running = null;
  let failing = false;
  /** Whether the last tick found no maintainer to look as; what makes the log once per stretch */
  let noSession = false;

  /** The forge as the newest live sign-in of a user who is a maintainer now, or null when there is none */
  async function maintainerForge() {
    const rows = /** @type {{ user_id: string }[]} */ ((await auth.store()).prepare("SELECT user_id FROM sessions WHERE token <> '' AND expires_at > ? ORDER BY created_at DESC, rowid DESC").all(iso(now())));
    const users = [...new Set(rows.map((r) => r.user_id))].slice(0, MAX_CANDIDATES);
    for (const userId of users) {
      try {
        const forge = await auth.forgeForUser(userId);
        const me = await forge.me();
        if (String(me.id) === userId && isMaintainer(await forge.permission(repo, me.login))) return forge;
      } catch { /* this user's token is gone or refused: the next one */ }
    }
    return null;
  }

  /** One look. Resolves to what happened; never rejects. */
  async function look() {
    let forge;
    try {
      forge = await maintainerForge();
    } catch (err) {
      log(`the sign-ins could not be read: ${words(err)}`);
      return 'error';
    }
    if (!forge) {
      if (!noSession) log('no signed-in maintainer to look as, so the open spec PRs are not checked; it resumes when one signs in');
      noSession = true;
      return 'no-session';
    }
    if (noSession) log('a signed-in maintainer is back; checking the open spec PRs again');
    noSession = false;
    try {
      const { problem } = await listPullProposals(forge, where, { hooks });
      if (problem) {
        log(`the forge could not be asked: ${problem}`);
        return 'error';
      }
      return 'ok';
    } catch (err) {
      log(`failed: ${words(err)}`);
      return 'error';
    }
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
