/**
 * @module server/lander
 *
 * Landing on approval (PIPE-09, docs/proposals.md#land-on-approval): for a team that has set `proposals: { approveLands: true }`,
 * approving a spec also lands its pull request, once it is mergeable and every check is green, with no second click. It is
 * off unless the maintainer turned it on (ADR 0006), and with it off nothing here is built.
 *
 * `submitReview` (server/submit-review.js) calls `start` once, after an approval is posted, and never for a send-back. The
 * review is already on the PR by then and its response does not wait for this. A landing is a row in `landings`
 * (server/db.js) and a timer; on a restart `resume` picks up the rows still pending.
 *
 * **One polled path, for both forges.** Forgejo has a server-side "merge when checks succeed" and GitHub does not; using it
 * would mean two code paths, and the pinned sha and the green rule would be the forge's to enforce rather than ours. So
 * both are polled (every `POLL_MS` for the first `FAST_FOR_MS`, then every `SLOW_POLL_MS`, for up to `TIMEOUT_MS`; each
 * look reads the PR, its head and its checks fresh from the forge, never a kept answer, since they decide the merge), and the
 * landing is `landPull` (server/forge-actions.js): the same
 * `forge.merge(n, { onlyIfGreen: true, sha })` Land it uses, with the same `pr.landed` hook.
 *
 * Each look stops at the first terminal state, in this order:
 *
 *   no sign-in left to land with      left open: sign in to land (nothing else is done; there is no token to comment with)
 *   the PR is closed or merged        done (landed elsewhere, or closed: nothing to say)
 *   its head is not the approved sha  cancelled, "a push after approval" (the approval covered another version)
 *   a check is red                    left open: <check> failed
 *   another proposal not approved     waits, saying nothing (a PR with several proposals lands only once every one of them
 *                                     is approved by a maintainer at its current SHA-256, `allApproved`)
 *   green, not a draft, mergeable     lands, pinned to the approved sha
 *   the time is up                    left open: timed out
 *
 * and otherwise (checks still running, the forge still working out mergeability, a forge that did not answer) it waits.
 *
 * **As the approver.** It lands with the approver's own forge token, the newest live sign-in of that forge user
 * (`auth.forgeForUser`, as the review API posts a review), asked who they are and whether they still maintain the repo just
 * before it merges. Their session ending before the checks finish is "left open: sign in to land".
 *
 * **Says so.** A landing that is cancelled or left open (and one a maintainer cancels) posts one comment on the PR as the
 * approver, through the review's comment call (`postNote`, server/reviews.js) with its mentions and references defused (server/defuse.js:
 * a check's name is the forge's, not ours). Every state change is a row in `actions` (`action: 'landing'`; a landing itself is the
 * `merge` row Land it writes, with `via: 'approval'`). A landing posts no comment: the merge is its own news.
 */

import { ForgeError, isGreen, isMaintainer } from './forge.js';
import { landPull, mergeMethodOf } from './forge-actions.js';
import { latestReview, postNote, proposalHash } from './reviews.js';
import { pullProposals, readPullProposal } from './proposal-pulls.js';
import { sameOrigin } from './proposals.js';
import { Refused, countAttempt } from './throttle.js';

/** How often a pending landing looks at its PR, for its first `FAST_FOR_MS` */
export const POLL_MS = 20_000;
/** How long a landing is looked at every `POLL_MS`; after that, every `SLOW_POLL_MS` (most checks finish in minutes) */
export const FAST_FOR_MS = 5 * 60_000;
export const SLOW_POLL_MS = 60_000;
/** How long a landing waits for its checks before it is left open */
export const TIMEOUT_MS = 60 * 60_000;
/** The most of a check's name that goes into a comment */
const NAME_MAX = 80;

/** @typedef {'pending' | 'landed' | 'cancelled' | 'left-open' | 'done'} LandingState */
/** @typedef {{ repo: string, pull: number, slug: string, sha: string, user_id: string, login: string, started: string, state: LandingState }} LandingRow */

const iso = (ms) => new Date(ms).toISOString();
const oneLine = (v, max) => String(v).replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * @param {{
 *   config: any,
 *   where?: { proposals: string },
 *   auth: { store: () => Promise<import('node:sqlite').DatabaseSync>, forgeForUser: (userId: string) => Promise<import('./forge.js').Forge>, record: Function },
 *   hooks?: import('./hooks.js').Hooks | null,
 *   now?: () => number,
 *   timer?: { setTimeout: Function, clearTimeout: Function },
 *   pollMs?: number,
 *   timeoutMs?: number,
 * }} opts `timer`, `pollMs` and `timeoutMs` are the tests' clock
 */
export function createLander({ config, where, auth, hooks = null, now = Date.now, timer = { setTimeout, clearTimeout }, pollMs = POLL_MS, slowPollMs = SLOW_POLL_MS, fastForMs = FAST_FOR_MS, timeoutMs = TIMEOUT_MS }) {
  const repo = config.forge.repo;
  const folder = where || { proposals: config.proposals };
  const targetOf = (pull) => `${repo}#${pull}`;
  /** The landings being waited for in this process, by pull request */
  const jobs = new Map();
  /** The looks in flight, so a test (and a shutdown) can wait for them */
  const looking = new Set();
  let closed = false;

  const log = (what, err) => console.error(`[cornfield] landing on approval: ${what}: ${err instanceof Error ? err.message : err}`);

  const audit = async (job, request, status, answer) => {
    try {
      await auth.record({ login: job.login, action: 'landing', target: targetOf(job.pull), request: { slug: job.slug, sha: job.sha, ...request }, status, answer });
    } catch (err) {
      log(`the audit row of #${job.pull} could not be written`, err);
    }
  };

  const setState = async (job, state) => {
    try {
      (await auth.store()).prepare("UPDATE landings SET state = ? WHERE repo = ? AND pull = ? AND sha = ? AND state = 'pending'").run(state, repo, job.pull, job.sha);
    } catch (err) {
      log(`#${job.pull} could not be marked ${state}`, err);
    }
  };

  /** Ends a landing: marks it, writes the audit row, and posts the one comment when there is one and a forge to post it with */
  async function end(job, state, why, { forge = null, comment = null, request = {} } = {}) {
    if (job.over) return;
    job.over = true;
    if (job.timer !== null) timer.clearTimeout(job.timer);
    if (jobs.get(job.pull) === job) jobs.delete(job.pull);
    await setState(job, state);
    await audit(job, { state, ...request }, null, { state, why });
    if (forge && comment) {
      try {
        await postNote(forge, job.pull, comment);
      } catch (err) {
        log(`the comment on #${job.pull} could not be posted`, err);
      }
    }
  }

  const leftOpen = (job, why, forge) => end(job, 'left-open', why, {
    forge, comment: `Left open: ${why}. cornfield will not land \`${job.slug}\` on its own now; land it with Land it once it is green.`,
  });

  /**
   * Whether every proposal the PR holds at its head has, as its latest review by a maintainer, an approval of the file as it
   * is now (its SHA-256). Approving one proposal of a PR that holds several does not land the others.
   * @param {import('./forge.js').Forge} forge
   * @param {import('./forge.js').Pull} pull read fresh from the forge
   */
  async function allApproved(forge, pull) {
    const entries = await pullProposals(forge, folder, pull);
    if (!entries.length) return false;
    const comments = await forge.comments(pull.number);
    for (const e of entries) {
      const review = await latestReview(forge, pull.number, e.slug, comments);
      if (!review || review.verdict !== 'approved' || typeof review.proposal !== 'string') return false;
      if (review.proposal !== proposalHash(await readPullProposal(forge, folder, e))) return false;
    }
    return true;
  }

  /** One look at the PR. Resolves when it has ended the landing or decided to wait. */
  async function look(job) {
    if (job.over) return;
    if (now() - Date.parse(job.started) >= timeoutMs) {
      let forge = null;
      try { forge = await auth.forgeForUser(job.userId); } catch { /* no sign-in left: no comment, the audit row says it */ }
      return leftOpen(job, `its checks did not pass within ${Math.round(timeoutMs / 60_000)} minutes`, forge);
    }
    let forge;
    try {
      forge = await auth.forgeForUser(job.userId);
    } catch (err) {
      if (err instanceof ForgeError && err.code === 'unauthorized') return end(job, 'left-open', 'sign in to land');
      log(`#${job.pull} waits`, err);
      return;
    }
    try {
      const pull = await forge.pull(job.pull);
      if (pull.state !== 'open') return end(job, 'done', `the pull request is ${pull.state}`);
      if (pull.head.sha.toLowerCase() !== job.sha) {
        return end(job, 'cancelled', 'a push after approval', {
          forge, request: { head: pull.head.sha },
          comment: `Landing on approval was cancelled: a push after approval (the head is now ${pull.head.sha.slice(0, 7)}, not ${job.sha.slice(0, 7)}). \`${job.slug}\` was approved as it was; approve it again to land it.`,
        });
      }
      const checks = await forge.checks(pull.head.sha);
      const red = checks.filter((c) => c.state === 'failure' || c.state === 'cancelled');
      if (red.length) return leftOpen(job, red.map((c) => `${oneLine(c.name, NAME_MAX)} ${c.state === 'failure' ? 'failed' : 'was cancelled'}`).join('; '), forge);
      if (pull.draft || !isGreen(checks)) return;
      // The approver, now: their sign-in is theirs, and a maintainer is what lands
      const me = await forge.me();
      if (String(me.id) !== job.userId) return end(job, 'left-open', 'sign in to land');
      if (!isMaintainer(await forge.permission(repo, me.login))) return leftOpen(job, `${oneLine(me.login, NAME_MAX)} is not a maintainer of the repo now`, forge);
      // Every proposal of the PR approved as it is now, not only the one that started this: else it waits, saying nothing
      if (!(await allApproved(forge, pull))) return;
      const method = mergeMethodOf(config);
      // Stopped (cancelled, approved again, or the server shutting down) while the forge was being asked: nothing more is done
      if (job.over || closed) return;
      let landed;
      try {
        landed = await landPull({ forge, config, where, hooks, auth }, job.pull, job.sha, me.login);
      } catch (err) {
        return await merging(job, forge, err);
      }
      job.over = true;
      if (job.timer !== null) timer.clearTimeout(job.timer);
      jobs.delete(job.pull);
      await setState(job, 'landed');
      try {
        await auth.record({ login: me.login, action: 'merge', target: targetOf(job.pull), request: { action: 'merge', number: job.pull, sha: job.sha, method, via: 'approval', slug: job.slug }, status: 200, answer: { ok: true, merged: true, number: job.pull, sha: landed.sha, head: job.sha, method } });
      } catch (err) {
        log(`the audit row of the landing of #${job.pull} could not be written`, err);
      }
    } catch (err) {
      if (!(err instanceof ForgeError)) return log(`#${job.pull} waits`, err);
      if (err.code === 'unauthorized') return end(job, 'left-open', 'sign in to land');
      // Not found, rate-limited, unavailable: the forge's trouble, tried again at the next look (until the time is up)
    }
  }

  /** What a refused merge means: not ready yet (wait), the head moved (cancelled), or a refusal for good (left open) */
  async function merging(job, forge, err) {
    if (!(err instanceof ForgeError)) throw err;
    if (err.code === 'unauthorized') return end(job, 'left-open', 'sign in to land');
    if (err.code === 'not-green' || err.code === 'rate-limited' || err.code === 'unavailable') return;
    if (err.code === 'conflict') {
      const pull = await forge.pull(job.pull);
      if (pull.state !== 'open') return end(job, 'done', `the pull request is ${pull.state}`);
      if (pull.head.sha.toLowerCase() !== job.sha) {
        return end(job, 'cancelled', 'a push after approval', {
          forge, request: { head: pull.head.sha },
          comment: `Landing on approval was cancelled: a push after approval (the head is now ${pull.head.sha.slice(0, 7)}, not ${job.sha.slice(0, 7)}). \`${job.slug}\` was approved as it was; approve it again to land it.`,
        });
      }
      if (pull.draft) return;
    }
    return leftOpen(job, oneLine(err.message, 300).replace(/\.$/, ''), forge);
  }

  /** A look, now or after a wait; schedules the next unless the landing ended */
  function run(job) {
    if (closed || job.over || job.looking) return Promise.resolve();
    job.looking = true;
    const p = look(job)
      .catch((err) => log(`#${job.pull}`, err))
      .finally(() => {
        job.looking = false;
        looking.delete(p);
        if (!job.over && !closed) schedule(job);
      });
    looking.add(p);
    return p;
  }

  function schedule(job) {
    // Often at first, while checks usually finish; then less, so an hour's wait is not a request every 20 seconds
    const waited = now() - Date.parse(job.started);
    const t = timer.setTimeout(() => { job.timer = null; run(job); }, waited < fastForMs ? pollMs : slowPollMs);
    if (t && typeof t.unref === 'function') t.unref();
    job.timer = t;
  }

  /** Starts waiting for a landing; the first look is made at once */
  function begin(row) {
    const job = { ...row, pull: row.pull, userId: row.user_id, over: false, looking: false, timer: null };
    const had = jobs.get(job.pull);
    if (had) {
      // Approved again: the newer approval replaces the older (its sha, its approver)
      had.over = true;
      if (had.timer !== null) timer.clearTimeout(had.timer);
    }
    jobs.set(job.pull, job);
    return job;
  }

  /**
   * Starts a landing for a spec PR that was just approved at `sha`, as `who`. Resolves once the row is written and the
   * first look is made. A second approval of the same PR replaces the first.
   * @param {{ pull: number, slug: string, sha: string, who: { userId: string, login: string } }} input
   */
  async function start({ pull, slug, sha, who }) {
    if (closed) return;
    // A PR that holds other proposals not approved as they are now: this approval does not start a landing (the last
    // approval does). Asked fresh of the forge; a forge that cannot say now is asked again at every look before the merge.
    try {
      const forge = await auth.forgeForUser(String(who.userId));
      const now_ = await forge.pull(pull);
      if (now_.state === 'open' && now_.head.sha.toLowerCase() === sha.toLowerCase() && !(await allApproved(forge, now_))) return;
    } catch { /* the looks decide */ }
    const row = { repo, pull, slug, sha: sha.toLowerCase(), user_id: String(who.userId), login: who.login, started: iso(now()), state: /** @type {LandingState} */ ('pending') };
    (await auth.store()).prepare("INSERT INTO landings (repo, pull, slug, sha, user_id, login, started, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending') ON CONFLICT(repo, pull) DO UPDATE SET slug = excluded.slug, sha = excluded.sha, user_id = excluded.user_id, login = excluded.login, started = excluded.started, state = 'pending'")
      .run(repo, pull, row.slug, row.sha, row.user_id, row.login, row.started);
    const job = begin(row);
    await audit(job, { state: 'pending' }, null, { state: 'pending', why: 'waiting for the checks' });
    await run(job);
  }

  /**
   * Picks up what a restart left: a pending row is waited for again, from when it started; one that is not pending, or whose
   * time ran out while cornfield was away, is dropped (the timed-out one with an audit row).
   */
  async function resume() {
    if (closed) return;
    const db = await auth.store();
    db.prepare("DELETE FROM landings WHERE repo = ? AND state <> 'pending'").run(repo);
    const rows = /** @type {LandingRow[]} */ (db.prepare("SELECT * FROM landings WHERE repo = ? AND state = 'pending'").all(repo));
    const looks = [];
    for (const row of rows) {
      const job = begin(row);
      if (now() - Date.parse(row.started) >= timeoutMs) {
        job.over = true;
        jobs.delete(row.pull);
        db.prepare('DELETE FROM landings WHERE repo = ? AND pull = ?').run(repo, row.pull);
        await audit(job, { state: 'left-open' }, null, { state: 'left-open', why: 'its time ran out while cornfield was not running' });
        continue;
      }
      looks.push(run(job));
    }
    await Promise.all(looks);
  }

  /**
   * What is being waited for on a PR, or null.
   * @returns {{ pull: number, slug: string, sha: string, by: string, since: string } | null}
   */
  function pending(pull) {
    const job = jobs.get(pull);
    return job && !job.over ? { pull, slug: job.slug, sha: job.sha, by: job.login, since: job.started } : null;
  }

  /**
   * A maintainer stops a landing. Posts the one comment, as them. False when nothing was waiting.
   * @param {number} pull
   * @param {{ forge: import('./forge.js').Forge, login: string }} by
   */
  async function cancel(pull, by) {
    const job = jobs.get(pull);
    if (!job || job.over) return false;
    await end(job, 'cancelled', `cancelled by ${by.login}`, {
      forge: by.forge, request: { by: by.login },
      comment: `Landing on approval was cancelled by ${oneLine(by.login, NAME_MAX)}. \`${job.slug}\` stays approved and the pull request stays open; land it with Land it when you are ready.`,
    });
    return true;
  }

  /** Waits for the looks in flight (the tests', and a clean shutdown's) */
  async function idle() {
    while (looking.size) await Promise.allSettled([...looking]);
  }

  function close() {
    closed = true;
    for (const job of jobs.values()) if (job.timer !== null) timer.clearTimeout(job.timer);
    jobs.clear();
  }

  return { start, resume, pending, cancel, idle, close };
}

/** @typedef {ReturnType<typeof createLander>} Lander */

// ---------------------------------------------------------------------------
//  The dashboard's two routes
// ---------------------------------------------------------------------------

/**
 * The landing route of the path, or null: `GET /api/forge/pulls/<n>/landing` (what is waiting) and
 * `POST /api/forge/pulls/<n>/landing/cancel` (stop it).
 * @param {string} reqPath
 * @returns {{ n: number, cancel: boolean } | null}
 */
export function landingOf(reqPath) {
  const m = /^\/api\/forge\/pulls\/([1-9]\d{0,8})\/landing(\/cancel)?$/.exec(reqPath);
  return m ? { n: Number(m[1]), cancel: m[2] !== undefined } : null;
}

/**
 * Answers a landing route. The read needs only a signed-in maintainer and asks the forge nothing; the cancel is a POST from
 * cornfield's own page by a maintainer the forge confirms now, counted like any action.
 * @param {import('node:http').IncomingMessage} req
 * @param {{ n: number, cancel: boolean }} what
 * @param {{ config: any, session: { login: string, userId: string } | null, auth: any, lander?: Lander | null, now?: () => number, publicHost?: string | null, publicOrigin?: string | null, embedOrigins?: readonly string[] }} ctx
 * @returns {Promise<{ status: number, body: object, headers?: Record<string, string> }>}
 */
export async function serveLanding(req, what, ctx) {
  const { config, session, auth, lander = null, now = Date.now } = ctx;
  req.resume();
  if (!session) return { status: 403, body: { ok: false, error: 'Landing on approval is for the signed-in maintainer: set up sign-in first (docs/sign-in.md).', code: 'forbidden' } };
  if (!what.cancel) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return { status: 405, body: { ok: false, error: 'Ask what is waiting with GET.', code: 'invalid' }, headers: { Allow: 'GET, HEAD' } };
    return { status: 200, body: { ok: true, enabled: lander !== null, landing: lander ? lander.pending(what.n) : null } };
  }
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'Cancelling is done with POST.', code: 'invalid' }, headers: { Allow: 'POST' } };
  try {
    // The origin first: a same-site page's POST carries the maintainer's cookie, and a refused one must not use up their budget
    if (!sameOrigin(req, ctx.publicHost ?? null, ctx.embedOrigins ?? [], ctx.publicOrigin ?? null)) throw new Refused(403, 'Do this from cornfield\'s own page.', 'forbidden');
    const flood = countAttempt(ctx, session.userId, now());
    if (flood) throw flood;
    if (!lander) throw new Refused(404, 'Landing on approval is not turned on (proposals.approveLands).', 'not-found');
    const forge = auth.forgeFor(session);
    const me = await forge.me();
    if (String(me.id) !== String(session.userId)) throw new Refused(403, 'The forge says this sign-in is someone else now; sign in again.', 'forbidden');
    if (!isMaintainer(await forge.permission(config.forge.repo, me.login))) throw new Refused(403, `Only the repo's maintainers stop a landing; ${me.login} is not one now.`, 'forbidden');
    const stopped = await lander.cancel(what.n, { forge, login: me.login });
    if (!stopped) throw new Refused(404, `Nothing is waiting to land pull request #${what.n}.`, 'not-found');
    return { status: 200, body: { ok: true, cancelled: true, number: what.n } };
  } catch (err) {
    if (err instanceof Refused) return { status: err.status, body: { ok: false, error: err.message, code: err.code }, headers: err.headers };
    if (err instanceof ForgeError) return { status: err.code === 'unauthorized' ? 401 : 502, body: { ok: false, error: err.message, code: err.code } };
    throw err;
  }
}
