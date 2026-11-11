/**
 * @module server/decision
 *
 * The facts the line above Approve is made from (spec 0007 D1): `GET /proposals/<slug>/decision?source=pull/<n>`, for the maintainer
 * who is signed in, like the review routes. The page decides nothing from what it was told earlier; this is the server's answer, and
 * the server's own checks (server/submit-review.js) are the rule whatever the page does with it.
 *
 *   { pull: { number, draft, head }, checks: { total, passed, running, failed: [names] } | null,
 *     lands: boolean, landing: { by, since } | null, run: null | { kind, transport, runner, lastSeen, quietAfterMs } }
 *
 * - `pull`: the PR, read from the forge. A PR that is not open, or that does not hold the proposal, is 404.
 * - `checks`: the checks on the PR's head, counted: `passed` is the ones that finished green (`success`), `running` the queued and running,
 *   `failed` the names of the ones that failed or were cancelled (text from the forge: the page sets it as text). `null` when the forge
 *   could not list them (the pull is still answered; the line then says it could not read them).
 * - `lands`: `proposals.approveLands` is on; `landing`: a landing is waiting on this PR now (Cancel landing, spec 0007 D3).
 * - `run`: what an approval would ask for, from `agents.on['spec.approved']`, or null. `runner` is `online`, `quiet` (it polled once, not within
 *   the window) or `never` on the pull transport (the only one with runners that ask), and null on the forge and push transports.
 *
 * **What it costs** (the idle-cost rule): the page asks when a proposal with a PR opens, every 30 s while it is open and the tab is visible, when
 * the window gets focus and at the end of the hold. Each read is two forge calls (the PR and its checks; the PR's files are kept by head sha like
 * the Specs list's). The answer is kept `FRESH_MS` for the whole server, so two tabs read the forge once; a read asked `fresh` (the end of the
 * hold, where a stale answer could let a decision through) skips the kept one and replaces it. A review posted from cornfield forgets it.
 */

import { ForgeError } from './forge.js';
import { PROPOSAL_FILE } from './files.js';
import { filesAt, folderOf } from './proposal-pulls.js';
import path from 'node:path';

/** How long a read of a PR and its checks is kept for every tab: under the page's 30 s, so each of its looks is a new read, and two tabs share one */
export const FRESH_MS = 20_000;
/** How long a landing waits for its checks, in minutes (server/lander.js TIMEOUT_MS): the line says "marked ready within 60 minutes" */
export const LAND_WITHIN_MINUTES = 60;
/** The most checks counted by name in an answer */
const NAMES_MAX = 20;

/** @type {WeakMap<object, Map<number, { at: number, read: Promise<{ pull: import('./forge.js').Pull, checks: import('./forge.js').Check[] | null }> }>>} */
const kept = new WeakMap();

/** Forgets what was read of PR `n` (a review was just posted on it, which can start a landing) */
export function forgetDecision(where, n) {
  kept.get(where)?.delete(n);
}

/** The PR and the checks on its head, from the forge or from the read kept for every tab */
function readPull(forge, where, n, { fresh, now }) {
  let byPull = kept.get(where);
  if (!byPull) kept.set(where, (byPull = new Map()));
  const had = byPull.get(n);
  if (had && !fresh && now() - had.at < FRESH_MS) return had.read;
  const read = (async () => {
    const pull = await forge.pull(n);
    let checks = null;
    if (pull.state === 'open' && pull.head.sha) {
      try { checks = await forge.checks(pull.head.sha); } catch { checks = null; } // the pull is still known: the line says the checks could not be read
    }
    return { pull, checks };
  })();
  byPull.set(n, { at: now(), read });
  // A read that failed, or whose checks could not be listed, is not kept: the next look asks again
  const forgetIf = (bad) => { if (bad && byPull.get(n)?.read === read) byPull.delete(n); };
  read.then(({ checks }) => forgetIf(checks === null), () => forgetIf(true));
  return read;
}

/** The checks, counted (see the module's head) */
export function countChecks(checks) {
  if (!Array.isArray(checks)) return null;
  const failed = checks.filter((c) => c.state === 'failure' || c.state === 'cancelled').map((c) => String(c.name).slice(0, 80));
  return {
    total: checks.length,
    passed: checks.filter((c) => c.state === 'success').length,
    running: checks.filter((c) => c.state === 'queued' || c.state === 'running').length,
    failed: failed.slice(0, NAMES_MAX),
  };
}

/**
 * @param {import('./forge.js').Forge} forge
 * @param {{ proposals: string }} where
 * @param {{ slug: string, n: number, fresh?: boolean, now?: () => number,
 *   lands?: boolean, landing?: (n: number) => ({ by: string, since: string } | null) | null,
 *   run?: null | { kind: string, transport: string, presence: () => Promise<null | { online: boolean, lastSeen: string | null, quietAfterMs: number }> } }} opts
 * @returns {Promise<object>} the answer; throws a ForgeError (`not-found` when the PR is not open or does not hold the proposal)
 */
export async function readDecision(forge, where, { slug, n, fresh = false, now = Date.now, lands = false, landing = null, run = null }) {
  const { pull, checks } = await readPull(forge, where, n, { fresh, now });
  if (pull.state !== 'open') throw new ForgeError(`Pull request #${n} is not open.`, { code: 'not-found' });
  const folder = folderOf(where);
  const files = await filesAt(forge, where, pull); // kept by head sha, as the Specs list keeps it
  if (!files.some((f) => f.status !== 'removed' && path.posix.dirname(f.path) === folder && PROPOSAL_FILE.exec(path.posix.basename(f.path))?.[1] === slug && !f.path.endsWith('.review.json'))) {
    throw new ForgeError(`Pull request #${n} does not hold the proposal ${slug}.`, { code: 'not-found' });
  }
  let runOut = null;
  if (run) {
    runOut = { kind: run.kind, transport: run.transport, runner: null, lastSeen: null, quietAfterMs: null };
    if (run.transport === 'pull') {
      const seen = await run.presence();
      if (seen) Object.assign(runOut, { runner: seen.online ? 'online' : seen.lastSeen ? 'quiet' : 'never', lastSeen: seen.lastSeen, quietAfterMs: seen.quietAfterMs });
    }
  }
  const landingNow = landing ? landing(n) : null;
  return {
    pull: { number: n, draft: !!pull.draft, head: pull.head.sha },
    checks: countChecks(checks),
    lands: !!lands,
    landing: landingNow ? { by: landingNow.by, since: landingNow.since } : null,
    run: runOut,
  };
}
