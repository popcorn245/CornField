/**
 * @module server/agent-runs
 *
 * Runs on the forge (issue #80, spec 0005, ADR 0012): cornfield **asks** for an agent run and **follows** it, and nothing else. It never
 * starts a process or holds an agent's credentials. The contract with the developer's runner is core/agent-contract.js
 * (docs/agent-contract.md); this module is cornfield's side of it, and uses that module for every byte of the contract.
 *
 * ## Asking (`request`)
 *
 * A maintainer's request (the dashboard's Start an agent, or `POST /api/agent-requests` with an agent token: server/agent-api.js) is
 * the contract's request, posted as a comment with the maintainer's OWN forge token (`auth.forgeForUser`, as a review is posted), so the
 * forge shows who asked. No live sign-in for them: 401. Where it goes: a `thread` or an `issue` gets the comment on that issue or
 * thread, a `proposal` on its open spec PR. In this order, each step refusing in words (a `Refused`, or the forge's `ForgeError`):
 *
 *   1. a flood (`ATTEMPTS_PER_MINUTE` attempts of any kind, and `AGENT_REQUESTS_PER_MINUTE` requests, per person per minute): 429, and
 *      nothing is written down, so a flood cannot grow the audit table (server/throttle.js)
 *   2. the body is strictly the contract's request fields plus `force` (`createRequest`): a credential, by name or by shape, anywhere in it is 400
 *   3. a repeat (the same subject and profile again within a few seconds) and a ceiling of actions per minute (server/throttle.js): 429
 *   4. the forge, as the person: a maintainer NOW (403), the issue exists (404), the proposal has an open spec PR (404)
 *   5. **the cap and the one-run-per-subject rule, in ONE transaction with the insert** of the run's row, so two requests at once cannot
 *      both take the last place: at most `agents.maxOpen` open runs per repo (409 `cap-reached`), and one open run per issue or proposal and
 *      profile unless `force: true` asks for another on purpose (409 `run-open`; `force` never lifts the cap)
 *   6. the comment is posted. If the forge refuses it the row is removed again
 *
 * **One run per subject AND profile.** The same request under two profiles is two runs (D8), so the rule that stops a second click on the
 * same issue does not stop a second profile on it. The cap still counts both.
 *
 * Every attempt past step 1 is a row in `actions` (`agent-request`), refusals included. The audit never holds a brief, a token's secret or a
 * credential: the request's shape, the brief's length, and the token's id and label.
 *
 * ## On the map (issue #82)
 *
 * Each run in the API carries `nodes` (the ids of the map's nodes it is changing), `nodesFrom`, `collidesWith` and a `timeline`:
 *
 *   - **nodes** come from the files the run has changed once it has a branch or a trusted pull request: the pull request's files, or a
 *     comparison of the branch with the base (`forge.compare`), read once for each head sha (`run_reads`) and mapped with `nodesForFile` against the checkout's
 *     map each time they are asked for. Before the first push: the request's own `nodes` and the `[[mentions]]` in the opening post of what the run is about
 *   - **collidesWith** lists the other OPEN runs that share a node with this one (an open run only: a finished or quiet run marks nothing)
 *   - `agents.refuseCollisions` (off unless set) refuses a new request that names a node an open run is already changing (409 `collision`), in the
 *     transaction that takes the place for it, right after the cap check. Only the nodes a request names are checked: its `nodes`
 *   - the **timeline** is the request, the runner's reports, pushes, the pull request, its checks, how it ended, a stop request, and quiet: the first
 *     and last are worked out from the row, the rest are kept as they are seen (`run_events`, one row for each, so a second look adds none)
 *
 * ## What counts as open
 *
 * A run is **open** unless it is finished or quiet (`statusOf`): finished is the runner's report `done`, `failed` or `stopped`, or its pull
 * request merged or closed; **quiet** is no report, push or pull request activity within `agents.quietAfter` (24h unless set). A quiet run
 * is shown as quiet and counts toward neither the cap nor the one-per-subject rule; a later report or push makes it open again.
 *
 * ## Following (`follow`)
 *
 * No timer of its own: the spec poll's tick (server/spec-poll.js) calls `follow` with the forge as a signed-in maintainer when `hasWork`
 * says there is a run to look at, and the dashboard's Refresh does the same. A follow reads, for the runs it looks at (those not
 * finished for good, with activity in the last two quiet periods or two days):
 *
 *   - **the pull requests** (one listing): the PR that carries a run's id, in its body as a `Cornfield-Run:` trailer or in its branch name,
 *     else in a commit message (`forge.pullCommits`, at most `MAX_COMMIT_LOOKUPS` PRs a tick, each head once); then that PR's state and
 *     head, its checks, and its merge or close. A PR moves the run's state and activity only when its author is trusted (a runner, a
 *     listed `agents.authors` account, or a maintainer); anyone can write a trailer, so any other PR is linked but marked unverified
 *   - **the comments** on each run's issue or PR (and on its linked PR): `cornfield-run` blocks. A **report** counts only from a login in
 *     `agents.runners` or a maintainer, a **stop request** only from a maintainer, and neither from a comment edited after it was posted
 *     (anyone with write access can edit any comment). Everything else is ignored, and the ignoring is a row in `actions`
 *   - **the branches**, for a run that has no pull request yet: a branch whose name holds the run id, and when its head moves
 *
 * Everything seen is kept in `runs` and `run_seen` (server/db.js) before any hook is sent, and each comment is judged once and each hook event
 * sent once (a `run_seen` key), so a restart re-reads the forge and fires nothing twice. Hooks: `run.claimed`, `run.state`, `run.stopRequested`,
 * `run.finished` (server/hooks.js).
 *
 * @typedef {import('../core/agent-contract.js').RunRequest} RunRequest
 * @typedef {{ run_id: string, repo: string, kind: string, profile: string | null, issue: number | null, proposal: string | null, thread: number | null,
 *   target: number, comment_id: string, comment_url: string | null, request: string, requested_by: string, requested_by_id: string, requested_at: string,
 *   via: string, state: string, reported_at: string | null, reported_by: string | null, note: string | null, url: string | null, tokens: number | null,
 *   cost: number | null, stop_requested_at: string | null, stop_requested_by: string | null, pull: number | null, pull_state: string | null,
 *   pull_url: string | null, pull_by: string | null, pull_trusted: number, linked_via: string | null, branch: string | null, head_sha: string | null,
 *   checks: string | null, last_activity: string }} RunRow
 */

import fs from 'node:fs';
import path from 'node:path';
import { ForgeError, isMaintainer } from './forge.js';
import { createRequest, findRunId, formatRunComment, runAuthors, runBlocksOf, runIdFromBranch, MAX_NOTE_CHARS } from '../core/agent-contract.js';
import { quietAfterMs } from '../core/config.js';
import { nodesForFile, parseMentions, resolveMentions } from '../core/mentions.js';
import { readTopology } from '../core/validate.js';
import { listPullProposals } from './proposal-pulls.js';
import { Refused, countAttempt, throttle } from './throttle.js';

/** Requests one person may make in a minute (a ceiling of its own; every other action is counted by `ATTEMPTS_PER_MINUTE` and `PER_MINUTE`) */
export const AGENT_REQUESTS_PER_MINUTE = 6;
/** The most runs a follow looks at, and the most pull requests whose commits it reads, in one tick */
export const MAX_FOLLOWED = 100;
export const MAX_COMMIT_LOOKUPS = 10;
/** The newest pull requests listed to look for a run's id in (the work listing's size) */
export const WORK_PULLS = 100;
/** A run is looked at for at least this long after its last activity, even with a short `quietAfter` */
export const FOLLOW_FLOOR_MS = 48 * 3_600_000;
/** A run whose request comment never got posted (a crash between the reservation and the post) is dropped after this */
export const RESERVATION_MS = 10 * 60_000;
/** The runs a listing answers */
export const LIST_LIMIT = 200;
/** The most events a run's timeline holds */
export const TIMELINE_LIMIT = 100;
/** How much of a request's brief the API shows (the Runs view groups runs by it) */
export const BRIEF_SHOWN = 2000;
/** The most runs whose subject's opening post is read for mentions in one look, and how long a reading is kept */
export const MAX_MENTION_READS = 10;
/** The most runs whose changed files are read in one look */
export const MAX_FILE_READS = 10;
export const MENTIONS_KEEP_MS = 3_600_000;
/** The keys of a request as the API and the button send it: the contract's fields, less what cornfield writes, plus `force` */
export const REQUEST_BODY_KEYS = Object.freeze(['kind', 'profile', 'refs', 'branch', 'brief', 'limits', 'nodes', 'requestedBy', 'force']);

/** The states in which a run is over for good unless the runner says more */
export const FINISHED = Object.freeze(['done', 'failed', 'stopped', 'merged', 'closed']);
const REPORT_FINISHED = ['done', 'failed', 'stopped'];

/** cornfield's own API tokens (server/review-tokens.js): the contract's credential check does not know their shape, so a request and a report are checked for it here */
const OWN_TOKEN = /cf_(?:rt|at)_[A-Za-z0-9_-]{20,}/;

const iso = (ms) => new Date(ms).toISOString();
const lower = (s) => String(s).toLowerCase();
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const words = (err) => (err instanceof Error ? err.message : String(err));
const maxIso = (a, b) => (Date.parse(b) > Date.parse(a) ? b : a);

/**
 * What a run is, as of `nowMs`, from the runner's reports and what the forge shows. Pure.
 *
 *   done / failed / stopped    the runner's latest report
 *   merged / closed            its (trusted) pull request ended
 *   quiet                      nothing happened within `quietMs`
 *   stop-requested             a maintainer asked it to stop and the runner has not said so
 *   claimed / working          the runner's latest report
 *   working                    no report, but a (trusted) pull request or a branch carries its id: a silent runner is seen through what it pushes
 *   requested                  asked for, nothing seen yet
 *
 * `open` is whether it counts toward the cap and the one-per-subject rule: not finished, not quiet.
 * @param {RunRow} row
 * @param {number} nowMs
 * @param {number} quietMs
 * @returns {{ status: string, open: boolean, finished: boolean, quiet: boolean }}
 */
export function statusOf(row, nowMs, quietMs) {
  const ended = row.pull_trusted === 1 && (row.pull_state === 'merged' || row.pull_state === 'closed');
  let status;
  if (REPORT_FINISHED.includes(row.state)) status = row.state;
  else if (ended) status = /** @type {string} */ (row.pull_state);
  else if (nowMs - Date.parse(row.last_activity) >= quietMs) status = 'quiet';
  else if (row.stop_requested_at) status = 'stop-requested';
  else if (row.state !== 'requested') status = row.state;
  else status = (row.pull_trusted === 1 && row.pull) || row.branch ? 'working' : 'requested';
  const finished = FINISHED.includes(status);
  const quiet = status === 'quiet';
  return { status, open: !finished && !quiet, finished, quiet };
}

/** The numbers a run is about, as keys for the one-per-subject rule: an issue and a thread are conversations (numbers are shared by issues and pull requests) */
function subjectKeys(refs) {
  const out = [];
  for (const n of [refs.issue, refs.thread]) if (n != null && !out.includes(`n:${n}`)) out.push(`n:${n}`);
  if (refs.proposal != null) out.push(`p:${refs.proposal}`);
  return out;
}

const subjectWords = (refs) => [refs.issue != null && `issue #${refs.issue}`, refs.thread != null && refs.thread !== refs.issue && `thread #${refs.thread}`, refs.proposal != null && `proposal ${refs.proposal}`].filter(Boolean).join(' and ');

/**
 * A run for the dashboard and the API: derived status, the request's limits beside the runner's report, no credential, nothing that is the
 * database's own. Text the runner wrote (a note, a link) is data for the page to escape.
 * @param {RunRow} row
 * @param {number} nowMs
 * @param {number} quietMs
 */
export function publicRun(row, nowMs, quietMs, extra = {}) {
  const { status, open } = statusOf(row, nowMs, quietMs);
  let limits = null;
  try { limits = JSON.parse(row.request).limits ?? null; } catch { limits = null; }
  return {
    runId: row.run_id, kind: row.kind, profile: row.profile,
    refs: { ...(row.issue != null ? { issue: row.issue } : {}), ...(row.proposal != null ? { proposal: row.proposal } : {}), ...(row.thread != null ? { thread: row.thread } : {}) },
    status, open, requestedBy: row.requested_by, requestedAt: row.requested_at, via: row.via, target: row.target,
    comment: row.comment_id ? { id: row.comment_id, url: row.comment_url } : null,
    limits,
    report: row.reported_at ? { state: row.state, at: row.reported_at, by: row.reported_by, note: row.note, url: row.url, tokens: row.tokens, cost: row.cost } : null,
    stopRequested: row.stop_requested_at ? { at: row.stop_requested_at, by: row.stop_requested_by } : null,
    pull: row.pull != null ? { number: row.pull, state: row.pull_state, url: row.pull_url, by: row.pull_by, trusted: row.pull_trusted === 1, via: row.linked_via } : null,
    branch: row.branch, headSha: row.head_sha, checks: row.checks, lastActivity: row.last_activity,
    ...extra,
  };
}

/**
 * The run's story in order: the request first, what was seen (`events`, oldest first), and "quiet" last when the run is. Pure.
 * @param {RunRow} row
 * @param {{ at: string, kind: string, actor: string | null, ref: string | null, note: string | null, url: string | null }[]} events
 * @param {{ status: string }} now `statusOf`'s answer
 * @param {number} quietMs
 */
export function timelineOf(row, events, now, quietMs) {
  const out = [{ at: row.requested_at, kind: 'requested', actor: row.requested_by, ref: row.profile, note: null, url: row.comment_url }];
  out.push(...events);
  if (now.status === 'quiet') out.push({ at: iso(Date.parse(row.last_activity) + quietMs), kind: 'quiet', actor: null, ref: null, note: null, url: null });
  return out;
}

/** The ids a request names, the ones the map knows when it is known */
function requestNodes(request, known) {
  const ids = Array.isArray(request?.nodes) ? request.nodes.filter((n) => typeof n === 'string') : [];
  return known ? ids.filter((id) => known.has(id)) : ids;
}

/**
 * @typedef {object} RequestContext
 * @property {() => import('./forge.js').Forge | Promise<import('./forge.js').Forge>} forge the forge as the person (may throw a ForgeError `unauthorized`)
 * @property {{ login: string, userId: string }} who
 * @property {{ auth: object, now?: () => number }} limits what server/throttle.js counts by
 * @property {{ token: { id: number, label: string } } | null} [via] set when the request came through the API: the token it came with
 * @property {() => string | null | Promise<string | null>} [stillAllowed] asked once more just before the cap is taken: null to go on, or why not
 */

/**
 * @param {{
 *   config: any,
 *   where?: { proposals: string },
 *   auth: { store: () => Promise<import('node:sqlite').DatabaseSync>, record: Function, forgeForUser?: Function },
 *   hooks?: import('./hooks.js').Hooks | null,
 *   now?: () => number,
 *   onAsk?: () => void,
 * }} opts `onAsk` is called when a run was asked for: the server starts the poll that follows it
 */
export function createRuns({ config, where, auth, hooks = null, now = Date.now, onAsk }) {
  const repo = config.forge.repo;
  const folder = where || { proposals: config.proposals };
  const agents = config.agents || {};
  const cap = Number.isInteger(agents.maxOpen) ? agents.maxOpen : 3;
  const profiles = Array.isArray(agents.profiles) ? agents.profiles : [];
  const runnerSet = new Set((Array.isArray(agents.runners) ? agents.runners : []).map(lower));
  const authorSet = new Set((Array.isArray(agents.authors) ? agents.authors : []).map(lower));
  const quietMs = quietAfterMs(config);
  const refuseCollisions = agents.refuseCollisions === true;
  const log = (what) => console.error(`[cornfield] agent runs: ${what}`);
  let following = null;

  const audit = async (entry) => {
    try {
      await auth.record(entry);
    } catch (err) {
      log(`an audit row (${entry.action}) could not be written: ${words(err)}`);
    }
  };

  // -------------------------------------------------------------------------
  //  Nodes and collisions
  // -------------------------------------------------------------------------

  /** The checkout's map, read again when the file changes (a sync): `{ nodes, ids }`, empty when there is none */
  let mapCache = { stamp: '', nodes: /** @type {{ id: string, file?: string }[]} */ ([]), ids: /** @type {Set<string>} */ (new Set()) };
  function theMap() {
    let stamp = '';
    try { stamp = String(fs.statSync(path.join(config.root, config.topology)).mtimeMs); } catch { stamp = ''; }
    if (stamp === mapCache.stamp) return mapCache;
    let nodes = [];
    try { nodes = readTopology(config)?.nodes ?? []; } catch { nodes = []; }
    nodes = Array.isArray(nodes) ? nodes.filter((n) => n && typeof n.id === 'string') : [];
    mapCache = { stamp, nodes, ids: new Set(nodes.map((n) => n.id)) };
    return mapCache;
  }

  const readOf = (db, runId, source) => {
    const r = /** @type {{ sha: string, data: string } | undefined} */ (db.prepare('SELECT sha, data FROM run_reads WHERE run_id = ? AND source = ?').get(runId, source));
    if (!r) return null;
    try { return { sha: r.sha, data: JSON.parse(r.data) }; } catch { return null; }
  };

  /**
   * The nodes a run is changing: from the files at its head when they were read, else (before the first push, or before the files
   * were read) what the request names and what the opening post of its subject mentions.
   * @returns {{ nodes: string[], from: 'files' | 'request' }}
   */
  function nodesOfRow(db, row) {
    const map = theMap();
    if (row.head_sha) {
      const files = readOf(db, row.run_id, 'files');
      if (files && files.sha === row.head_sha && Array.isArray(files.data)) {
        const ids = new Set();
        for (const f of files.data) {
          for (const p of [f.path, f.previousPath]) if (typeof p === 'string') for (const n of nodesForFile(p, map.nodes)) ids.add(n.id);
        }
        return { nodes: [...ids], from: 'files' };
      }
    }
    let request = null;
    try { request = JSON.parse(row.request); } catch { request = null; }
    const ids = new Set(requestNodes(request, map.ids.size ? map.ids : null));
    const mentions = readOf(db, row.run_id, 'mentions');
    if (mentions && Array.isArray(mentions.data)) for (const id of resolveMentions(mentions.data, map.nodes).ids) ids.add(id);
    return { nodes: [...ids], from: 'request' };
  }

  /** What the runs add to their public form: the nodes, the open runs they share a node with, and the timeline */
  function extrasFor(db, rows, at) {
    const open = openRows(db, at);
    const openIds = new Set(open.map((r) => r.run_id));
    const nodesOf = new Map();
    for (const r of new Map([...open, ...rows].map((x) => [x.run_id, x])).values()) nodesOf.set(r.run_id, nodesOfRow(db, r));
    const events = new Map();
    if (rows.length) {
      const ask = db.prepare('SELECT at, kind, actor, ref, note, url FROM run_events WHERE run_id = ? ORDER BY at, rowid LIMIT ?');
      for (const r of rows) events.set(r.run_id, ask.all(r.run_id, TIMELINE_LIMIT));
    }
    return new Map(rows.map((r) => {
      const mine = nodesOf.get(r.run_id);
      const collidesWith = openIds.has(r.run_id)
        ? open.filter((o) => o.run_id !== r.run_id && nodesOf.get(o.run_id).nodes.some((id) => mine.nodes.includes(id))).map((o) => o.run_id)
        : [];
      let brief = '';
      try { brief = String(JSON.parse(r.request).brief ?? '').slice(0, BRIEF_SHOWN); } catch { brief = ''; }
      return [r.run_id, { brief, nodes: mine.nodes, nodesFrom: mine.from, collidesWith, timeline: timelineOf(r, events.get(r.run_id) ?? [], statusOf(r, at, quietMs), quietMs) }];
    }));
  }

  /** Writes what happened to a run, once: the key says what, so a second look at the same thing adds nothing */
  function keepEvent(db, runId, ev) {
    db.prepare('INSERT OR IGNORE INTO run_events (run_id, key, at, kind, actor, ref, note, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(runId, ev.key, ev.at, ev.kind, ev.actor ?? null, ev.ref ?? null, ev.note ?? null, ev.url ?? null);
  }

  /** The runs of this repo that are open as of now (the cap and the one-per-subject rule count these) */
  function openRows(db, at) {
    return /** @type {RunRow[]} */ (db.prepare("SELECT * FROM runs WHERE repo = ? AND state NOT IN ('done', 'failed', 'stopped') ORDER BY requested_at").all(repo))
      .filter((r) => statusOf(r, at, quietMs).open);
  }

  /** Takes a place for a run: the cap and the one-per-subject rule are checked and the row inserted in one transaction. Throws a `Refused`. */
  function reserve(db, request, { target, who, via, force }) {
    const at = now();
    const mine = subjectKeys(request.refs);
    db.exec('BEGIN IMMEDIATE');
    try {
      const open = openRows(db, at);
      if (open.length >= cap) {
        throw new Refused(409, `${repo} already has ${open.length} open run${open.length === 1 ? '' : 's'}, the most cornfield asks for (agents.maxOpen is ${cap}): ${open.map((r) => r.run_id).join(', ')}. Wait for one to finish or go quiet, or stop one.`, 'cap-reached');
      }
      if (refuseCollisions) {
        const map = theMap();
        const wanted = requestNodes(request, map.ids.size ? map.ids : null);
        for (const r of open) {
          const theirs = nodesOfRow(db, r).nodes;
          const shared = wanted.filter((id) => theirs.includes(id));
          if (shared.length) {
            throw new Refused(409, `${shared.length === 1 ? 'The node' : 'The nodes'} ${shared.join(', ')} ${shared.length === 1 ? 'is' : 'are'} already being changed by the open run ${r.run_id} (agents.refuseCollisions is on). Wait for it to finish or go quiet, or stop it, or ask for a request that leaves ${shared.length === 1 ? 'it' : 'them'} out.`, 'collision');
          }
        }
      }
      if (!force) {
        const clash = open.find((r) => (r.profile ?? null) === (request.profile ?? null)
          && subjectKeys({ issue: r.issue ?? undefined, thread: r.thread ?? undefined, proposal: r.proposal ?? undefined }).some((k) => mine.includes(k)));
        if (clash) {
          throw new Refused(409, `${subjectWords(request.refs)} already has an open run${clash.profile ? ` under the profile ${clash.profile}` : ''}: ${clash.run_id} (${statusOf(clash, at, quietMs).status}). To ask for another on purpose, send "force": true${profiles.length ? ', or pick another profile' : ''}.`, 'run-open');
        }
      }
      db.prepare(`INSERT INTO runs (run_id, repo, kind, profile, issue, proposal, thread, target, request, requested_by, requested_by_id, requested_at, via, last_activity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(request.runId, repo, request.kind, request.profile ?? null, request.refs.issue ?? null, request.refs.proposal ?? null, request.refs.thread ?? null,
          target, JSON.stringify(request), request.requestedBy, String(who.userId), request.requestedAt, via ? 'api' : 'dashboard', iso(at));
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* nothing was begun */ }
      throw err;
    }
  }

  /** What a request's audit row says: the shape of what was asked and never its words (a brief may be long, and may be anything) */
  function askedOf(body, via) {
    const out = /** @type {Record<string, unknown>} */ ({});
    if (!isObject(body)) return { ...(via ? { via: 'api', token: via.token } : {}) };
    const known = Object.keys(body).every((k) => REQUEST_BODY_KEYS.includes(k));
    if (!known) out.unknownKeys = Object.keys(body).filter((k) => !REQUEST_BODY_KEYS.includes(k)).length;
    if (typeof body.kind === 'string' && body.kind.length <= 20) out.kind = body.kind;
    // Only a name the config lists: anything else sent in that field could be a secret pasted in the wrong place
    if (typeof body.profile === 'string' && profiles.includes(body.profile)) out.profile = body.profile;
    if (isObject(body.refs)) {
      const refs = {};
      if (Number.isInteger(body.refs.issue)) refs.issue = body.refs.issue;
      if (Number.isInteger(body.refs.thread)) refs.thread = body.refs.thread;
      if (typeof body.refs.proposal === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(body.refs.proposal)) refs.proposal = body.refs.proposal;
      out.refs = refs;
    }
    if (typeof body.brief === 'string') out.briefChars = body.brief.length;
    if (body.force === true) out.force = true;
    if (via) Object.assign(out, { via: 'api', token: via.token });
    return out;
  }

  /**
   * Asks for a run: checks and posts a request (the steps in this module's header). Throws a `Refused` or a `ForgeError` (answer with
   * `refusal(err)`, server/submit-review.js); resolves with the run and the comment that is the request.
   * @param {RequestContext} ctx
   * @param {{ body: unknown, problem?: { status: number, message: string } }} input `problem`: something already wrong with the request
   *   itself (not same-origin, not JSON, too large): refused here, after the flood count and with a row, like every other refusal
   */
  async function request(ctx, { body, problem }) {
    const { who, via = null } = ctx;
    const at = ctx.limits.now ?? now;
    const asked = askedOf(body, via);
    const flood = countAttempt(ctx.limits, who.userId, at()) || countAttempt(ctx.limits, `agent|${who.userId}`, at(), AGENT_REQUESTS_PER_MINUTE);
    if (flood) throw flood;
    let target = repo;
    let status = null;
    let release = () => {};
    let runId = null;
    try {
      if (problem) throw new Refused(problem.status, problem.message, 'invalid');
      if (!isObject(body)) throw new Refused(400, `A request is a JSON object: { kind, refs, profile?, brief?, branch?, limits?, nodes?, force? }.`, 'invalid');
      if (OWN_TOKEN.test(JSON.stringify(body))) throw new Refused(400, 'The request holds something shaped like a cornfield token. A request never carries a credential: the runner uses its own identity.', 'invalid');
      const { force, requestedBy, ...fields } = body;
      if (force !== undefined && typeof force !== 'boolean') throw new Refused(400, '"force" is true or false: whether to ask for another run on an issue or proposal that has an open one.', 'invalid');
      const build = (login, pull) => {
        // The config's limits are hints the request starts from; what the person sent wins key by key
        const base = agents.limits || {};
        let limits = fields.limits;
        if (limits === undefined) limits = Object.keys(base).length ? { ...base } : undefined;
        else if (isObject(limits)) limits = { ...base, ...limits };
        // The brief is required by the contract and may be empty; the spec PR that holds a proposal is named beside it
        const refs = pull != null && isObject(fields.refs) ? { ...fields.refs, pull } : fields.refs;
        const made = createRequest({ brief: '', ...fields, refs, ...(limits !== undefined ? { limits } : {}), requestedBy: login }, { profiles, now: at });
        if (!made.ok) throw new Refused(400, made.error, 'invalid');
        return /** @type {RunRequest} */ (made.value);
      };
      let made = build(who.login);
      runId = made.runId;
      Object.assign(asked, { runId });
      // The same ask again within a few seconds is a double click; asking again on purpose (`force`) is another key, so a refusal can be answered at once
      release = throttle(ctx.limits, who.userId, `agent|${subjectKeys(made.refs).join('+')}|${made.profile ?? ''}|${made.kind}${force === true ? '|force' : ''}`, at());

      const forge = await ctx.forge();
      const me = await forge.me();
      if (String(me.id) !== who.userId) throw new Refused(403, 'The forge says this sign-in is someone else now; sign in again.', 'forbidden');
      if (!isMaintainer(await forge.permission(repo, me.login))) throw new Refused(403, `Only the repo's maintainers ask for agent runs; ${me.login} is not one now.`, 'forbidden');
      if (requestedBy !== undefined && lower(requestedBy) !== lower(me.login)) throw new Refused(400, `"requestedBy" is who asks: ${me.login}. Leave it out; it is filled in.`, 'invalid');
      if (me.login !== who.login) { made = build(me.login); runId = made.runId; Object.assign(asked, { runId }); }

      // Where the request goes: the thread it came from, else the open spec PR of the proposal, else the issue
      let number;
      if (made.refs.thread != null) number = made.refs.thread;
      else if (made.refs.proposal != null) {
        const listed = await listPullProposals(forge, folder, { hooks: null });
        const entry = listed.entries.find((e) => e.slug === made.refs.proposal);
        if (!entry) throw new Refused(404, listed.problem ? `The open spec pull requests could not be read: ${listed.problem}` : `No open spec pull request holds the proposal ${made.refs.proposal}, so there is nowhere to post the request.`, 'not-found');
        number = entry.pull.number;
        made = build(me.login, number);
        runId = made.runId;
        Object.assign(asked, { runId });
      } else number = /** @type {number} */ (made.refs.issue);
      if (made.refs.issue != null) {
        try {
          await forge.issue(made.refs.issue);
        } catch (err) {
          if (err instanceof ForgeError && err.code === 'not-found') throw new Refused(404, `#${made.refs.issue} is not an issue of ${repo} (a pull request is asked about as its thread).`, 'not-found');
          throw err;
        }
      }
      target = `${repo}#${number}`;
      let comment = formatRunComment(made.runId, made, { profiles });
      if (via) {
        const [head, ...rest] = comment.split('\n\n');
        comment = [`${head} Sent through the agent API with the token \`${via.token.label}\`.`, ...rest].join('\n\n');
      }

      // The token once more, after every forge call: one revoked or expired meanwhile does not ask
      if (ctx.stillAllowed) {
        const why = await ctx.stillAllowed();
        if (why) throw new Refused(403, why, 'forbidden');
      }
      const db = await auth.store();
      reserve(db, made, { target: number, who, via, force: force === true });
      let posted;
      try {
        posted = await forge.comment(number, comment);
      } catch (err) {
        db.prepare('DELETE FROM runs WHERE run_id = ?').run(made.runId);
        throw err;
      }
      db.prepare('UPDATE runs SET comment_id = ?, comment_url = ? WHERE run_id = ?').run(posted.id, posted.url ?? null, made.runId);
      status = 201;
      await audit({ login: me.login, action: 'agent-request', target, request: { ...asked, target: number }, status, answer: { comment: posted.id, url: posted.url ?? null } });
      hooks?.emit('agent.requested', { request: made, actor: me.login });
      try { onAsk?.(); } catch { /* the poll is a convenience */ }
      const row = /** @type {RunRow} */ (db.prepare('SELECT * FROM runs WHERE run_id = ?').get(made.runId));
      return { run: publicRun(row, now(), quietMs, extrasFor(db, [row], now()).get(row.run_id)), request: made, comment: { id: posted.id, url: posted.url ?? null, number } };
    } catch (err) {
      if (status === null) {
        const out = describe(err);
        await audit({ login: who.login, action: 'agent-request', target, request: asked, status: err instanceof ForgeError ? err.status ?? (err.code === 'unavailable' ? null : out.status) : out.status, answer: { error: out.error, code: out.code } });
        if (!(err instanceof Refused) && !(err instanceof ForgeError)) log(`the request ${runId ?? ''} failed: ${err instanceof Error ? err.stack || err.message : err}`);
      }
      throw err;
    } finally {
      release();
    }
  }

  /** Words and codes for an error, for the audit row (the routes answer with `refusal`) */
  function describe(err) {
    if (err instanceof Refused) return { status: err.status, error: err.message, code: err.code };
    if (err instanceof ForgeError) return { status: { 'not-found': 404, invalid: 400, unauthorized: 401, 'rate-limited': 429 }[err.code] ?? 502, error: err.message, code: err.code };
    return { status: 500, error: 'cornfield failed before it could answer.', code: 'unavailable' };
  }

  /**
   * Asks a run to stop: posts a `stop-requested` block in the same place as the request, as the maintainer who clicked. The runner decides what
   * stopping means. Throws like `request`.
   * @param {RequestContext} ctx
   * @param {{ runId: unknown, note?: unknown, problem?: { status: number, message: string } }} input
   */
  async function stop(ctx, { runId, note, problem }) {
    const { who, via = null } = ctx;
    const at = ctx.limits.now ?? now;
    const flood = countAttempt(ctx.limits, who.userId, at());
    if (flood) throw flood;
    let target = repo;
    let done = false;
    let release = () => {};
    const asked = { ...(typeof runId === 'string' && runId.length <= 40 ? { runId } : {}), ...(via ? { via: 'api', token: via.token } : {}) };
    try {
      if (problem) throw new Refused(problem.status, problem.message, 'invalid');
      if (note !== undefined && (typeof note !== 'string' || note.length > MAX_NOTE_CHARS)) throw new Refused(400, `"note" is text of at most ${MAX_NOTE_CHARS} characters.`, 'invalid');
      const db = await auth.store();
      const row = typeof runId === 'string' ? /** @type {RunRow | undefined} */ (db.prepare('SELECT * FROM runs WHERE run_id = ? AND repo = ?').get(runId, repo)) : undefined;
      if (!row) throw new Refused(404, 'cornfield has no such run.', 'not-found');
      target = `${repo}#${row.target}`;
      release = throttle(ctx.limits, who.userId, `agent-stop|${row.run_id}`, at());
      const forge = await ctx.forge();
      const me = await forge.me();
      if (String(me.id) !== who.userId) throw new Refused(403, 'The forge says this sign-in is someone else now; sign in again.', 'forbidden');
      if (!isMaintainer(await forge.permission(repo, me.login))) throw new Refused(403, `Only the repo's maintainers stop agent runs; ${me.login} is not one now.`, 'forbidden');
      const was = statusOf(row, now(), quietMs);
      if (was.finished) throw new Refused(409, `Run ${row.run_id} is ${was.status}; there is nothing to stop.`, 'conflict');
      if (row.stop_requested_at) throw new Refused(409, `${row.stop_requested_by ?? 'A maintainer'} already asked run ${row.run_id} to stop (${row.stop_requested_at}); the runner decides what that means.`, 'conflict');
      if (ctx.stillAllowed) {
        const why = await ctx.stillAllowed();
        if (why) throw new Refused(403, why, 'forbidden');
      }
      let comment;
      try {
        comment = formatRunComment(row.run_id, { state: 'stop-requested', ...(note ? { note } : {}) }, { line: `Asked run \`${row.run_id}\` to stop (${me.login}, in cornfield${via ? `, through the agent API with the token \`${via.token.label}\`` : ''}).` });
      } catch (err) {
        throw new Refused(400, words(err), 'invalid');
      }
      const posted = await forge.comment(row.target, comment);
      const stamp = iso(now());
      // Judged already: the follow that reads this comment back must not fire the hook again
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE runs SET stop_requested_at = ?, stop_requested_by = ?, last_activity = MAX(last_activity, ?) WHERE run_id = ?').run(stamp, me.login, stamp, row.run_id);
        keepEvent(db, row.run_id, { key: `stop:${posted.id}`, at: stamp, kind: 'stop-requested', actor: me.login, note: note || null, url: posted.url ?? null });
        db.prepare('INSERT OR IGNORE INTO run_seen (run_id, key, at) VALUES (?, ?, ?)').run(row.run_id, `c:${posted.id}:${row.run_id}:stop-request:0`, stamp);
        db.prepare('INSERT OR IGNORE INTO run_seen (run_id, key, at) VALUES (?, ?, ?)').run(row.run_id, `ev:stop:${posted.id}:c:${posted.id}:${row.run_id}:stop-request:0`, stamp);
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* nothing was begun */ }
        throw err;
      }
      done = true;
      await audit({ login: me.login, action: 'agent-stop', target, request: { ...asked, ...(note ? { noteChars: note.length } : {}) }, status: 201, answer: { comment: posted.id, url: posted.url ?? null } });
      const after = /** @type {RunRow} */ (db.prepare('SELECT * FROM runs WHERE run_id = ?').get(row.run_id));
      hooks?.emit('run.stopRequested', runPayload(after, me.login));
      return { run: publicRun(after, now(), quietMs, extrasFor(db, [after], now()).get(after.run_id)), comment: { id: posted.id, url: posted.url ?? null } };
    } catch (err) {
      if (!done) {
        const out = describe(err);
        await audit({ login: who.login, action: 'agent-stop', target, request: asked, status: err instanceof ForgeError ? err.status ?? (err.code === 'unavailable' ? null : out.status) : out.status, answer: { error: out.error, code: out.code } });
        if (!(err instanceof Refused) && !(err instanceof ForgeError)) log(`stopping ${asked.runId ?? ''} failed: ${err instanceof Error ? err.stack || err.message : err}`);
      }
      throw err;
    } finally {
      release();
    }
  }

  /** The body of a run hook event: which run, in what state, about what, caused by whom */
  function runPayload(row, actor) {
    return { runId: row.run_id, state: statusOf(row, now(), quietMs).status, pull: row.pull ?? undefined, issue: row.issue ?? row.thread ?? undefined, actor };
  }

  // -------------------------------------------------------------------------
  //  Reading
  // -------------------------------------------------------------------------

  /** The runs, newest first, as the dashboard shows them, with the cap and how many are open */
  async function list({ limit = LIST_LIMIT } = {}) {
    const db = await auth.store();
    const at = now();
    const rows = /** @type {RunRow[]} */ (db.prepare("SELECT * FROM runs WHERE repo = ? AND comment_id <> '' ORDER BY requested_at DESC, run_id DESC LIMIT ?").all(repo, limit));
    const extras = extrasFor(db, rows, at);
    return { runs: rows.map((r) => publicRun(r, at, quietMs, extras.get(r.run_id))), open: openRows(db, at).length, maxOpen: cap, profiles, limits: agents.limits || {}, quietAfter: agents.quietAfter, runners: [...runnerSet].length, refuseCollisions };
  }

  /** One run, or null */
  async function get(runId) {
    const db = await auth.store();
    const row = typeof runId === 'string' ? /** @type {RunRow | undefined} */ (db.prepare("SELECT * FROM runs WHERE run_id = ? AND repo = ? AND comment_id <> ''").get(runId, repo)) : undefined;
    return row ? publicRun(row, now(), quietMs, extrasFor(db, [row], now()).get(row.run_id)) : null;
  }

  /** The runs a follow looks at: posted, not over for good (a trusted pull request merged or closed), and active within the follow window */
  function followable(db, at) {
    const window = Math.max(2 * quietMs, FOLLOW_FLOOR_MS);
    return /** @type {RunRow[]} */ (db.prepare("SELECT * FROM runs WHERE repo = ? AND comment_id <> '' AND last_activity > ? AND NOT (pull_trusted = 1 AND pull_state IN ('merged', 'closed')) ORDER BY last_activity DESC LIMIT ?")
      .all(repo, iso(at - window), MAX_FOLLOWED));
  }

  /** Whether there is a run to look at: what the spec poll asks before it spends a call of the forge */
  async function hasWork() {
    return followable(await auth.store(), now()).length > 0;
  }

  /**
   * Looks at the forge for what the runs I follow have left (the steps in this module's header). One at a time: a follow that is running
   * is the answer to another asked meanwhile. Never throws; resolves with a count.
   * @param {import('./forge.js').Forge} forge a signed-in maintainer's
   * @returns {Promise<{ followed: number, reports: number, ignored: number, linked: number }>}
   */
  function follow(forge) {
    if (following) return following;
    following = followRuns(forge)
      .catch((err) => {
        log(`a look at the runs failed: ${words(err)}`);
        return { followed: 0, reports: 0, ignored: 0, linked: 0 };
      })
      .finally(() => { following = null; });
    return following;
  }

  /**
   * What the map needs from the forge, kept in `run_reads` so it is asked once: for a run with a head (a trusted pull request, or a branch)
   * the files it changes, read again only when the head moved; for a run with no head yet, the `[[mentions]]` in the opening post of what it is about.
   * A failure is logged and tried again at the next look. At most `MAX_FILE_READS` and `MAX_MENTION_READS` a look.
   */
  async function readNodes(forge, db, rows, at) {
    const save = db.prepare('INSERT OR REPLACE INTO run_reads (run_id, source, sha, data, at) VALUES (?, ?, ?, ?, ?)');
    let files = 0;
    let mentions = 0;
    let base = null;
    for (const row of rows) {
      if (!statusOf(row, at, quietMs).open) continue;
      if (row.head_sha) {
        const had = readOf(db, row.run_id, 'files');
        if (had && had.sha === row.head_sha) continue;
        if (files >= MAX_FILE_READS) continue;
        files += 1;
        try {
          let list;
          if (row.pull != null && row.pull_trusted === 1) list = await forge.pullFiles(row.pull);
          else {
            base ??= config.forge.baseBranch || await forge.defaultBranch();
            list = await forge.compare(base, row.head_sha);
          }
          save.run(row.run_id, 'files', row.head_sha, JSON.stringify(list.map((f) => ({ path: f.path, previousPath: f.previousPath ?? null, status: f.status }))), iso(at));
        } catch (err) {
          log(`the files of ${row.run_id} could not be read: ${words(err)}`);
        }
        continue;
      }
      const had = readOf(db, row.run_id, 'mentions');
      const stamp = /** @type {{ at: string } | undefined} */ (db.prepare("SELECT at FROM run_reads WHERE run_id = ? AND source = 'mentions'").get(row.run_id));
      if (had && stamp && at - Date.parse(stamp.at) < MENTIONS_KEEP_MS) continue;
      if (mentions >= MAX_MENTION_READS) continue;
      let refs = null;
      try { refs = JSON.parse(row.request).refs; } catch { refs = null; }
      const text = refs?.proposal != null && refs.pull != null ? ['pull', refs.pull] : refs?.thread != null || refs?.issue != null ? ['issue', refs.thread ?? refs.issue] : null;
      if (!text) continue;
      mentions += 1;
      try {
        const item = text[0] === 'pull' ? await forge.pull(text[1]) : await forge.issue(text[1]);
        save.run(row.run_id, 'mentions', '', JSON.stringify(parseMentions(item.body ?? '').refs), iso(at));
      } catch (err) {
        // A thread that is a pull request is not an issue to the forge: ask for it as one
        try {
          if (text[0] === 'issue' && err instanceof ForgeError && err.code === 'not-found') {
            const item = await forge.pull(text[1]);
            save.run(row.run_id, 'mentions', '', JSON.stringify(parseMentions(item.body ?? '').refs), iso(at));
          } else throw err;
        } catch (again) {
          log(`what ${row.run_id} is about could not be read for mentions: ${words(again)}`);
        }
      }
    }
  }

  async function followRuns(forge) {
    const db = await auth.store();
    const at = now();
    const rows = followable(db, at);
    const out = { followed: rows.length, reports: 0, ignored: 0, linked: 0 };
    if (!rows.length) return out;
    /** @type {Map<string, RunRow>} the rows as they will be written: patched in place as the forge is read */
    const cur = new Map(rows.map((r) => [r.run_id, { ...r }]));
    const before = new Map(rows.map((r) => [r.run_id, statusOf(r, at, quietMs).status]));
    const dirty = new Set();
    /** @type {{ runId: string, key: string, event: string, actor: string | null }[]} hook events to send once they are kept */
    const events = [];
    /** @type {Map<string, string>} the cause of the latest change of each run, for the key of its finished event */
    const cause = new Map();
    /** @type {{ runId: string, key: string, at: string, kind: string, actor?: string | null, ref?: string | null, note?: string | null, url?: string | null }[]} what happened, for the timelines */
    const happened = [];
    const happen = (row, ev) => { happened.push({ runId: row.run_id, ...ev }); };
    /** @type {{ login: string | null, request: object, answer: object, target: number }[]} audit rows to write after */
    const audits = [];

    const seen = (runId, key) => db.prepare('SELECT 1 FROM run_seen WHERE run_id = ? AND key = ?').get(runId, key) !== undefined;
    const touch = (row, when) => { row.last_activity = maxIso(row.last_activity, iso(Number.isFinite(Date.parse(when)) ? Date.parse(when) : at)); dirty.add(row.run_id); };
    const queue = (row, event, key, actor, state) => { events.push({ runId: row.run_id, event, key, actor, state }); };

    // Who counts: runners by the config, maintainers by what the forge says now (asked once per login per look)
    const maintainerOf = new Map();
    const isMaintainerLogin = (login) => {
      const k = lower(login);
      if (!maintainerOf.has(k)) maintainerOf.set(k, forge.permission(repo, login).then(isMaintainer));
      return maintainerOf.get(k);
    };

    // ---- the pull requests ------------------------------------------------
    let pulls = null;
    try {
      pulls = await forge.pulls({ state: 'all', limit: WORK_PULLS });
    } catch (err) {
      log(`the pull requests could not be listed: ${words(err)}`);
    }
    if (pulls) {
      const byNumber = new Map(pulls.map((p) => [p.number, p]));
      const taken = new Set([...cur.values()].filter((r) => r.pull != null).map((r) => r.pull));
      /** @type {Map<string, { pull: import('./forge.js').Pull, via: 'body' | 'commit' | 'branch' }>} the run ids PRs name; the lowest PR number wins */
      const named = new Map();
      const undecided = [];
      for (const p of [...pulls].sort((a, b) => a.number - b.number)) {
        if (taken.has(p.number)) continue;
        const found = findRunId({ body: p.body, branch: p.head.ref });
        if (found && cur.has(found.runId)) { if (!named.has(found.runId)) named.set(found.runId, { pull: p, via: found.via }); } else if (!found) undecided.push(p);
      }
      // A trailer in a commit message: only for a pull request nothing else names, opened after a run still unlinked was asked for, one head once
      const unlinked = [...cur.values()].filter((r) => r.pull == null && !named.has(r.run_id));
      if (unlinked.length) {
        let lookups = 0;
        for (const p of undecided) {
          if (lookups >= MAX_COMMIT_LOOKUPS) break;
          if (!unlinked.some((r) => Date.parse(p.createdAt) >= Date.parse(r.requested_at) - 60_000)) continue;
          const key = `commits:${p.number}@${p.head.sha}`;
          if (seen('', key)) continue;
          lookups += 1;
          let commits;
          try {
            commits = await forge.pullCommits(p.number);
          } catch (err) {
            log(`the commits of #${p.number} could not be read: ${words(err)}`);
            continue;
          }
          db.prepare('INSERT OR IGNORE INTO run_seen (run_id, key, at) VALUES (?, ?, ?)').run('', key, iso(at));
          const found = findRunId({ commits: commits.map((c) => c.message) });
          if (found && cur.has(found.runId) && !named.has(found.runId)) named.set(found.runId, { pull: p, via: 'commit' });
        }
      }

      const trustedAuthor = async (login) => !!login && (runnerSet.has(lower(login)) || authorSet.has(lower(login)) || await isMaintainerLogin(login));
      for (const row of cur.values()) {
        let pr = null;
        let via = row.linked_via;
        if (row.pull != null) {
          pr = byNumber.get(row.pull) ?? null;
          if (!pr) {
            try { pr = await forge.pull(row.pull); } catch (err) { log(`pull request #${row.pull} could not be read: ${words(err)}`); }
          }
        } else if (named.has(row.run_id)) {
          ({ pull: pr, via } = /** @type {{ pull: import('./forge.js').Pull, via: 'body' | 'commit' | 'branch' }} */ (named.get(row.run_id)));
        }
        if (!pr) continue;
        const firstLink = row.pull == null;
        const state = pr.state === 'merged' ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
        const earlier = row.pull_state;
        const pushedBefore = row.head_sha;
        let trusted = row.pull_trusted === 1;
        if (firstLink) {
          try { trusted = await trustedAuthor(pr.author?.login ?? null); } catch (err) { log(`who opened #${pr.number} could not be asked: ${words(err)}`); continue; }
        }
        Object.assign(row, { pull: pr.number, pull_state: state, pull_url: pr.url ?? null, pull_by: pr.author?.login ?? null, pull_trusted: trusted ? 1 : 0, linked_via: via });
        // A stranger's branch is not the run's: only a trusted pull request says where the run pushes
        if (trusted) Object.assign(row, { branch: pr.head.ref || null, head_sha: pr.head.sha || null });
        dirty.add(row.run_id);
        if (trusted && firstLink) happen(row, { key: `pull:${pr.number}:opened`, at: pr.createdAt, kind: 'pull-opened', actor: pr.author?.login ?? null, ref: `#${pr.number}`, url: pr.url ?? null });
        if (trusted && pr.head.sha && pr.head.sha !== pushedBefore) happen(row, { key: `push:${pr.head.sha}`, at: iso(at), kind: 'push', actor: pr.author?.login ?? null, ref: pr.head.sha, note: pr.head.ref || null });
        if (trusted) touch(row, pr.updatedAt);
        if (firstLink) {
          out.linked += 1;
          audits.push({ login: pr.author?.login ?? null, target: pr.number, request: { runId: row.run_id, pull: pr.number, via }, answer: { linked: true, trusted, ...(trusted ? {} : { reason: 'its author is not a runner, a listed agent author or a maintainer, so it moves nothing' }) } });
          cause.set(row.run_id, `link:${pr.number}`);
          if (trusted) queue(row, 'run.state', `ev:linked:${pr.number}`, pr.author?.login ?? null, 'working');
        }
        if (trusted && state !== 'open' && earlier !== state) {
          happen(row, { key: `pull:${pr.number}:${state}`, at: (state === 'merged' && pr.mergedAt) || pr.updatedAt || iso(at), kind: state, actor: pr.author?.login ?? null, ref: `#${pr.number}`, url: pr.url ?? null });
          cause.set(row.run_id, `pull:${pr.number}:${state}`);
          queue(row, 'run.state', `ev:pull:${pr.number}:${state}`, pr.author?.login ?? null, state);
        }
      }
    }

    // ---- the comments -----------------------------------------------------
    /** @type {Map<number, Set<string>>} */
    const places = new Map();
    for (const r of cur.values()) for (const n of [r.target, r.pull]) if (n != null) places.set(n, (places.get(n) ?? new Set()).add(r.run_id));
    /** @type {{ row: RunRow, id: string, key: string, at: string, by: string | null, block: any }[]} */
    const heard = [];
    for (const [number, ids] of places) {
      let comments;
      try {
        comments = await forge.comments(number);
      } catch (err) {
        log(`the comments on #${number} could not be read: ${words(err)}`);
        continue;
      }
      // Whom the forge says to believe: asked once per login, for the comments that hold a block at all (the contract's reader does the rest)
      const standing = new Map();
      try {
        for (const login of runAuthors(comments)) standing.set(lower(login), { runner: runnerSet.has(lower(login)), maintainer: await isMaintainerLogin(login) });
      } catch (err) {
        log(`who wrote the comments on #${number} could not be asked: ${words(err)}`);
        continue; // judged next look
      }
      const trust = (login, block) => {
        const who = standing.get(lower(login));
        if (!who) return false;
        // A report: a runner (agents.runners) or a maintainer. A stop request: a maintainer. A request is not ours to follow
        return block.type === 'report' ? who.runner || who.maintainer : block.type === 'stop-request' ? who.maintainer : false;
      };
      const found = runBlocksOf(comments, { trust });
      const counts = new Map();
      const keyOf = (id, runId, type) => {
        const base = `c:${id}:${runId}:${type}`;
        const n = counts.get(base) ?? 0;
        counts.set(base, n + 1);
        return `${base}:${n}`;
      };
      /** Judges one block once: audited whatever the outcome; true when it is new and is ours */
      const judge = (row, id, key, by, type, request, answer) => {
        if (seen(row.run_id, key)) return false;
        audits.push({ login: by, target: number, request: { runId: row.run_id, type, comment: id, ...request }, answer, runId: row.run_id, key });
        return true;
      };
      for (const b of found.blocks) {
        const row = cur.get(b.runId);
        if (!row || !ids.has(b.runId)) continue;
        const key = keyOf(b.comment.id, b.runId, b.type);
        if (OWN_TOKEN.test(JSON.stringify(b.value))) {
          if (judge(row, b.comment.id, key, b.by, b.type, {}, { accepted: false, reason: 'holds something shaped like a cornfield token, which nothing here keeps' })) out.ignored += 1;
          continue;
        }
        if (!judge(row, b.comment.id, key, b.by, b.type, { ...(b.value.state ? { state: b.value.state } : {}) }, { accepted: true })) continue;
        heard.push({ row, id: b.comment.id, key, at: b.at, by: b.by, block: b });
      }
      for (const b of found.ignored) {
        const row = cur.get(b.runId);
        if (!row || !ids.has(b.runId) || b.type === 'request') continue;
        const key = keyOf(b.comment.id, b.runId, b.type);
        const reason = b.why === 'edited' ? 'edited after it was posted, so it is not believed'
          : b.type === 'report' ? 'not from a runner (agents.runners) or a maintainer' : 'a stop request is believed only from a maintainer';
        if (judge(row, b.comment.id, key, b.by, b.type, { ...(b.value.state ? { state: b.value.state } : {}) }, { accepted: false, reason })) out.ignored += 1;
      }
      // A block that is not strictly the contract's (a credential in a report, a stray key) is turned away, and written down once
      for (const [n, r] of found.refused.entries()) {
        const row = r.runId ? cur.get(r.runId) : null;
        if (!row || !ids.has(row.run_id)) continue;
        if (judge(row, r.comment.id, `c:${r.comment.id}:${row.run_id}:refused:${n}`, r.by, 'refused', {}, { accepted: false, reason: `not a valid block: ${r.error}` })) out.ignored += 1;
      }
    }
    heard.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const { row, id, key, at: when, by: login, block } of heard) {
      if (block.type === 'report') {
        const r = block.value;
        const previous = row.state;
        Object.assign(row, {
          state: r.state, reported_at: when, reported_by: login, note: r.note ?? null, url: r.url ?? null,
          tokens: r.tokens ?? row.tokens, cost: r.cost ?? row.cost,
        });
        touch(row, when);
        out.reports += 1;
        cause.set(row.run_id, key);
        happen(row, { key: `report:${key}`, at: when, kind: r.state === 'claimed' ? 'claimed' : 'report', actor: login, ref: r.state, note: r.note ?? null, url: r.url ?? null });
        if (r.state === 'claimed') queue(row, 'run.claimed', 'ev:claimed', login, 'claimed');
        if (r.state !== previous) queue(row, 'run.state', `ev:state:${id}:${key}`, login, r.state);
      } else {
        if (!row.stop_requested_at) Object.assign(row, { stop_requested_at: when, stop_requested_by: login });
        touch(row, when);
        happen(row, { key: `stop:${id}`, at: when, kind: 'stop-requested', actor: login, note: block.value.note ?? null });
        queue(row, 'run.stopRequested', `ev:stop:${id}:${key}`, login, 'stop-requested');
      }
    }

    // ---- the checks of the pull requests I trust, and the branches of the runs that have none -----------------------------
    for (const row of cur.values()) {
      if (row.pull == null || row.pull_trusted !== 1 || row.pull_state !== 'open' || !row.head_sha || !statusOf(row, at, quietMs).open) continue;
      try {
        const checks = await forge.checks(row.head_sha);
        const summary = !checks.length ? 'none' : checks.some((c) => c.state === 'failure') ? 'failure' : checks.some((c) => c.state === 'queued' || c.state === 'running') ? 'running' : checks.some((c) => c.state === 'success') ? 'success' : 'none';
        if (summary !== row.checks) {
          row.checks = summary;
          dirty.add(row.run_id);
          happen(row, { key: `checks:${row.head_sha}:${summary}`, at: iso(at), kind: 'checks', ref: summary });
        }
      } catch (err) {
        log(`the checks of #${row.pull} could not be read: ${words(err)}`);
      }
    }
    const branchless = [...cur.values()].filter((r) => r.pull == null);
    if (branchless.length) {
      try {
        const branches = await forge.branches();
        for (const row of branchless) {
          const b = branches.find((x) => !x.protected && runIdFromBranch(x.name) === row.run_id);
          if (!b) continue;
          if (b.name !== row.branch || b.sha !== row.head_sha) {
            Object.assign(row, { branch: b.name, head_sha: b.sha });
            touch(row, iso(at)); // a push: the forge does not say when, so now
            happen(row, { key: `push:${b.sha}`, at: iso(at), kind: 'push', ref: b.sha, note: b.name });
          }
        }
      } catch (err) {
        log(`the branches could not be listed: ${words(err)}`);
      }
    }

    // ---- the files each run has changed (once for each head sha), and what its subject mentions before its first push -----------------
    await readNodes(forge, db, [...cur.values()], at);

    // ---- kept first, then announced ------------------------------------------------------------------------------------------------
    for (const row of cur.values()) {
      const now2 = statusOf(row, at, quietMs);
      if (now2.finished && !FINISHED.includes(before.get(row.run_id) ?? '')) queue(row, 'run.finished', `ev:finished:${cause.get(row.run_id) ?? now2.status}`, row.reported_by ?? row.pull_by, now2.status);
    }
    /** @type {typeof events} */
    const fresh = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      const mark = db.prepare('INSERT OR IGNORE INTO run_seen (run_id, key, at) VALUES (?, ?, ?)');
      for (const key of new Set(audits.map((a) => a.key).filter(Boolean))) {
        const owner = audits.find((a) => a.key === key);
        mark.run(owner.runId, key, iso(at));
      }
      for (const id of dirty) {
        const r = /** @type {RunRow} */ (cur.get(id));
        db.prepare(`UPDATE runs SET state = ?, reported_at = ?, reported_by = ?, note = ?, url = ?, tokens = ?, cost = ?,
          stop_requested_at = COALESCE(stop_requested_at, ?), stop_requested_by = COALESCE(stop_requested_by, ?),
          pull = ?, pull_state = ?, pull_url = ?, pull_by = ?, pull_trusted = ?, linked_via = ?, branch = ?, head_sha = ?, checks = ?,
          last_activity = MAX(last_activity, ?) WHERE run_id = ?`)
          .run(r.state, r.reported_at, r.reported_by, r.note, r.url, r.tokens, r.cost, r.stop_requested_at, r.stop_requested_by,
            r.pull, r.pull_state, r.pull_url, r.pull_by, r.pull_trusted, r.linked_via, r.branch, r.head_sha, r.checks, r.last_activity, id);
      }
      for (const e of events) if (mark.run(e.runId, e.key, iso(at)).changes === 1) fresh.push(e);
      for (const ev of happened) keepEvent(db, ev.runId, ev);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* nothing was begun */ }
      throw err;
    }
    for (const a of audits) {
      await audit({ login: a.login ?? 'unknown', action: a.answer.linked !== undefined ? 'agent-link' : 'agent-report', target: `${repo}#${a.target}`, request: a.request, status: null, answer: a.answer });
    }
    for (const e of fresh) {
      const row = /** @type {RunRow} */ (db.prepare('SELECT * FROM runs WHERE run_id = ?').get(e.runId));
      hooks?.emit(e.event, { ...runPayload(row, e.actor), state: e.state });
    }
    return out;
  }

  /** Drops what a crash left: a request that was never posted. Run once at start. */
  async function resume() {
    const db = await auth.store();
    const gone = db.prepare("DELETE FROM runs WHERE comment_id = '' AND requested_at < ?").run(iso(now() - RESERVATION_MS)).changes;
    if (gone) log(`${gone} request${gone === 1 ? '' : 's'} that never reached the forge ${gone === 1 ? 'was' : 'were'} dropped`);
  }

  return { request, stop, list, get, follow, hasWork, resume, maxOpen: cap, profiles };
}

/** @typedef {ReturnType<typeof createRuns>} Runs */
