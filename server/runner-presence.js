/**
 * @module server/runner-presence
 *
 * Whether a runner is there (issue #99). On the pull transport a queued run waits for a runner that asks for it; when none does, nothing says
 * so. A runner token's last poll is already kept: `review_tokens.last_used` is set by every call a live runner token makes to the runner API
 * (server/runner-api.js: the queue read, a claim, a report), and a runner token is good for no other route, so for this scope `last_used` *is*
 * the last poll and nothing new is stored.
 *
 *   - `runnerPresence` reads it: the live runner tokens (not revoked, not expired) that have polled, each `{ label, lastSeen }`, newest first, and
 *     `online` when the newest poll is within `agents.runnerQuietAfter` (3 minutes unless set). A token no one has polled with is not a runner yet.
 *   - `createRunnerWatch` fires the `runner.offline` hook event, once: when a runner was seen online and the last live one has now been quiet
 *     for the window. It fires again only after a runner has been seen online again. A token revoked or expired is no runner, and ending one on
 *     purpose is not news. After a restart the first look only learns the state, so a runner that was already quiet is not announced twice.
 *     Only a poll newer than the one last announced re-arms it, so the clock stepping back cannot announce the same quiet spell twice.
 *     The body is `{ event, at, label, lastSeen, mapUrl }`: the label of the runner that polled last, never a token (server/hooks.js).
 *
 * Only the pull transport has runners that ask, so the watch is made for it alone. Times are ISO strings in the file; `now` is milliseconds.
 */

const iso = (ms) => new Date(ms).toISOString();

/** How often the watch looks, at most: a window is minutes, so half a minute is soon enough and costs one query */
export const WATCH_EVERY_MS = 30_000;

/**
 * @typedef {{ label: string, lastSeen: string }} SeenRunner
 * @typedef {{ online: boolean, lastSeen: string | null, quietAfterMs: number, runners: SeenRunner[] }} RunnerPresence
 */

/**
 * The live runner tokens that have polled, and whether one did within `quietMs`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} now
 * @param {number} quietMs
 * @returns {RunnerPresence}
 */
export function runnerPresence(db, now, quietMs) {
  const rows = /** @type {{ label: string, last_used: string }[]} */ (db.prepare(
    "SELECT label, last_used FROM review_tokens WHERE scope = 'runner' AND revoked_at IS NULL AND expires_at > ? AND last_used IS NOT NULL ORDER BY last_used DESC, id DESC LIMIT 50",
  ).all(iso(now)));
  const runners = rows.map((r) => ({ label: r.label, lastSeen: r.last_used }));
  const newest = runners.length ? Date.parse(runners[0].lastSeen) : NaN;
  return { online: Number.isFinite(newest) && now - newest < quietMs, lastSeen: runners.length ? runners[0].lastSeen : null, quietAfterMs: quietMs, runners };
}

/**
 * The watch: `check()` looks once and fires `runner.offline` when it is due; `start()` looks every `WATCH_EVERY_MS` until `close()`.
 * @param {{
 *   auth: { store: () => Promise<import('node:sqlite').DatabaseSync> },
 *   hooks: { emit: (event: string, payload: object) => void } | null,
 *   quietMs: number,
 *   now?: () => number,
 *   timer?: { setInterval: Function, clearInterval: Function },
 * }} opts
 */
export function createRunnerWatch({ auth, hooks, quietMs, now = Date.now, timer = { setInterval, clearInterval } }) {
  /** Whether a runner has been seen online since the last time one was announced offline */
  let armed = false;
  /** The last poll an announcement was about: only a newer one re-arms, so a clock stepped back cannot make one quiet spell fire twice */
  let announced = null;
  let handle = null;
  let closed = false;

  /** @returns {Promise<'online' | 'offline' | 'quiet' | 'none'>} what this look found: 'offline' only when the event was fired */
  async function check() {
    const db = await auth.store();
    if (closed) return 'none';
    const p = runnerPresence(db, now(), quietMs);
    if (p.online) {
      if (announced === null || (p.lastSeen !== null && Date.parse(p.lastSeen) > Date.parse(announced))) armed = true;
      return 'online';
    }
    if (!p.runners.length) { armed = false; return 'none'; }
    if (!armed) return 'quiet';
    armed = false;
    announced = p.lastSeen;
    hooks?.emit('runner.offline', { label: p.runners[0].label, lastSeen: p.lastSeen });
    return 'offline';
  }

  return {
    check,
    start() {
      if (closed || handle) return;
      const look = () => { check().catch((err) => console.error(`[cornfield] runner presence could not be checked: ${err instanceof Error ? err.message : err}`)); };
      look();
      handle = timer.setInterval(look, WATCH_EVERY_MS);
      if (handle && typeof handle.unref === 'function') handle.unref();
    },
    close() {
      closed = true;
      if (handle !== null) timer.clearInterval(handle);
      handle = null;
    },
  };
}
