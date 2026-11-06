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
 * ## Requests written by hand (`discover`, issue #98)
 *
 * A maintainer's own `cornfield-run` request block in a comment on an open issue or pull request becomes a run (`via: 'hand'`, the comment as its
 * request and its record, sent on as `agents.transport` says like any run: on pull it is queued for a runner, on push it goes out as `agent.requested`).
 * `discover` is called by the spec poll's tick just before `follow` (and by the dashboard's Refresh); it lists the open issues and pull requests that
 * changed since the last look (`forge.changed`, one listing, the least recently changed first, from a cursor kept in `run_seen` as `hand-since:<time>` and
 * never further back than `agents.quietAfter`), reads the comments of the ones whose update it has not read (`scan:<n>@<updatedAt>`; `agents.handWritten`:
 * all of them, the ones with the threads label, or none), and judges each block once (`run_seen` key `h:…`, an `agent-hand` row in `actions`). The body
 * of an issue or pull request is not read: anyone with write access may edit it, and the forge does not say when it was.
 *
 *   - the author must be a maintainer now (the forge's answer for that login, never what the comment says) and the comment unedited (`runBlocksOf`);
 *     `requestedBy` and `requestedAt` in the block are claims, replaced by the comment's author and time. A request older than `agents.quietAfter`
 *     would be quiet at once and is not imported
 *   - a block whose run id a run already has is never imported: it is cornfield's own post (the same comment, or one still being posted), or a copy of it
 *     (refused as a duplicate). A fence without an id gets one from cornfield, the same on every look (`handRunId`), confirmed by a reply block in the
 *     thread that the poll's signed-in maintainer posts (the block's `requestedBy` is the author; the audit row names who posted it). A reply the forge
 *     refuses is posted on a later look; the run is kept meanwhile (on pull it may be claimed at once)
 *   - the cap and the one-run-per-subject rule are `reserve`'s, in the same transaction as the insert, so a hand-written request counts toward later
 *     cap checks and is refused when they say so; the rate limit guards people at the dashboard and does not apply
 *   - what started nothing (not a maintainer, edited, malformed with the contract's reason, duplicate, old, cap, subject) is kept in `actions` and shown by `list` as `handWritten.refused`
 *
 * ## Waiting, and the answer (issue #101)
 *
 * A runner may report `waiting` (a note and a link: "plan ready, approve to build"). The run stays open and is shown as Waiting. A maintainer answers
 * from the run (`answer`): **Continue**, **Stop** or a **reply** with text. Over push and pull the answer is kept on the run (one answer: a second
 * replaces the first, until the runner reports again) and comes back through `GET /api/runs/<runId>` as `answer: { action, text?, at, by }`, the
 * way `stopRequested` does. On the forge it is posted as a `cornfield-run` `answered` block, as the maintainer, like a stop request. A **Stop** is
 * a stop request (`stop`), so it behaves in every way as a Stop does; the answer is recorded beside it. A report of `waiting` after another state
 * clears the answer of the wait before. Hooks: `run.waiting` (the runner asked), `run.answered` (a maintainer answered; the action, never the text).
 *
 * ## What counts as open
 *
 * A run is **open** unless it is finished or quiet (`statusOf`): finished is the runner's report `done`, `failed` or `stopped`, or its pull
 * request merged or closed; **quiet** is no report, push or pull request activity within `agents.quietAfter` (24h unless set). A quiet run
 * is shown as quiet and counts toward neither the cap nor the one-per-subject rule; a later report or push makes it open again. A run **waiting**
 * on a maintainer (its runner reported `waiting`, nobody asked it to stop) is never quiet: a human owes it an answer, so it keeps counting.
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
 * sent once (a `run_seen` key), so a restart re-reads the forge and fires nothing twice. Hooks: `run.claimed`, `run.state`, `run.waiting`, `run.answered`,
 * `run.stopRequested`, `run.finished` (server/hooks.js).
 *
 * @typedef {import('../core/agent-contract.js').RunRequest} RunRequest
 * @typedef {{ run_id: string, repo: string, kind: string, profile: string | null, issue: number | null, proposal: string | null, thread: number | null,
 *   target: number, comment_id: string, comment_url: string | null, request: string, requested_by: string, requested_by_id: string, requested_at: string,
 *   via: string, state: string, reported_at: string | null, reported_by: string | null, note: string | null, url: string | null, tokens: number | null,
 *   cost: number | null, transport: 'forge' | 'push' | 'pull', claimed_by: number | null, claimed_at: string | null, stop_requested_at: string | null, stop_requested_by: string | null, answer_action: string | null, answer_text: string | null, answer_at: string | null, answer_by: string | null, pull: number | null, pull_state: string | null,
 *   pull_url: string | null, pull_by: string | null, pull_trusted: number, linked_via: string | null, branch: string | null, head_sha: string | null,
 *   checks: string | null, last_activity: string }} RunRow
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ForgeError, isMaintainer } from './forge.js';
import { createRequest, findRunId, fencedBlocks, formatRunComment, isRunId, newRunId, runAuthors, runBlocksOf, runIdFromBranch, validateAnswer, validateReport, validateRequest, CONTRACT_VERSION, EDIT_GRACE_MS, MAX_BLOCKS, MAX_BLOCK_CHARS, MAX_NOTE_CHARS, MAX_TEXT_CHARS, RUN_TAG } from '../core/agent-contract.js';
import { handWrittenMode, ideaLabel, quietAfterMs, runnerQuietAfterMs } from '../core/config.js';
import { runnerPresence } from './runner-presence.js';
import { nodesForFile, parseMentions, resolveMentions } from '../core/mentions.js';
import { readTopology } from '../core/validate.js';
import { findPullProposal, listPullProposals, pullProposals, readPullProposal } from './proposal-pulls.js';
import { Refused, countAttempt, throttle } from './throttle.js';
import { byFromText, byToText, runnerBy } from './review-tokens.js';

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
/** The queued requests a runner's listing answers at most, oldest first */
export const QUEUE_LIMIT = 50;
/** The open issues and pull requests listed for hand-written requests, each kind, newest activity first (`agents.handWritten`) */
export const HAND_TARGETS = 100;
/** The most conversations whose comments one look reads for hand-written requests; the rest wait for the next look */
export const MAX_HAND_READS = 30;
/** The most refused or ignored hand-written blocks the Runs view lists (newest first), and how far back */
export const HAND_SHOWN = 20;
export const HAND_SHOWN_MS = 7 * 24 * 3_600_000;
/** The most hand-written blocks one look judges, so a thread full of them cannot grow the audit table in one tick */
export const MAX_HAND_JUDGED = 50;
/** The runs that are over once the runner has said so */
/** The keys of a request as the API and the button send it: the contract's fields, less what cornfield writes, plus `force` */
export const REQUEST_BODY_KEYS = Object.freeze(['kind', 'profile', 'refs', 'branch', 'brief', 'limits', 'nodes', 'requestedBy', 'force']);

/** The states in which a run is over for good unless the runner says more */
export const FINISHED = Object.freeze(['done', 'failed', 'stopped', 'merged', 'closed']);
const REPORT_FINISHED = ['done', 'failed', 'stopped'];
/** Where a run is looked up for the dashboard and the poll: posted on the forge, or (push and pull) there is no comment to wait for */
const POSTED = "(comment_id <> '' OR transport <> 'forge')";

const iso = (ms) => new Date(ms).toISOString();
const lower = (s) => String(s).toLowerCase();
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const words = (err) => (err instanceof Error ? err.message : String(err));
const maxIso = (a, b) => (Date.parse(b) > Date.parse(a) ? b : a);

/** Whether a run is waiting on a maintainer: its runner reported `waiting` and nobody has asked it to stop. Such a run is exempt from quiet */
const waitsOnMaintainer = (row) => row.state === 'waiting' && !row.stop_requested_at;

/**
 * What a run is, as of `nowMs`, from the runner's reports and what the forge shows. Pure.
 *
 *   done / failed / stopped    the runner's latest report
 *   merged / closed            its (trusted) pull request ended
 *   quiet                      nothing happened within `quietMs`, unless it is waiting (below)
 *   stop-requested             a maintainer asked it to stop and the runner has not said so
 *   waiting                    the runner's latest report: it asks a maintainer (open: the run is not over). A run waiting on a maintainer
 *                              never goes quiet, so it keeps counting toward the cap; once a maintainer asks it to stop, or it reports again, quiet applies again
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
  else if (!waitsOnMaintainer(row) && nowMs - Date.parse(row.last_activity) >= quietMs) status = 'quiet';
  else if (row.stop_requested_at) status = 'stop-requested';
  else if (row.state !== 'requested') status = row.state;
  else status = (row.pull_trusted === 1 && row.pull) || row.branch ? 'working' : 'requested';
  const finished = FINISHED.includes(status);
  const quiet = status === 'quiet';
  return { status, open: !finished && !quiet, finished, quiet };
}

/** Who a stored `by` is for a hook event: `runner:<label>` for a runner, else the login */
function actorText(text) {
  const by = byFromText(text);
  return by && typeof by === 'object' ? `runner:${by.label}` : by;
}

/** The numbers a run is about, as keys for the one-per-subject rule: an issue and a thread are conversations (numbers are shared by issues and pull requests) */
function subjectKeys(refs) {
  const out = [];
  for (const n of [refs.issue, refs.thread]) if (n != null && !out.includes(`n:${n}`)) out.push(`n:${n}`);
  if (refs.proposal != null) out.push(`p:${refs.proposal}`);
  return out;
}

const subjectWords = (refs) => [refs.issue != null && `issue #${refs.issue}`, refs.thread != null && refs.thread !== refs.issue && `thread #${refs.thread}`, refs.proposal != null && `proposal ${refs.proposal}`].filter(Boolean).join(' and ');

/** A maintainer's answer to the latest wait as the API shows it (the runner reads the same), or null */
function answerOf(row) {
  return row.answer_at ? { action: row.answer_action, ...(row.answer_text ? { text: row.answer_text } : {}), at: row.answer_at, by: row.answer_by } : null;
}

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
    status, open, requestedBy: row.requested_by, requestedAt: row.requested_at, via: row.via, byHand: row.via === 'hand', transport: row.transport, target: row.target,
    claimedAt: row.claimed_at,
    comment: row.comment_id ? { id: row.comment_id, url: row.comment_url } : null,
    limits,
    report: row.reported_at ? { state: row.state, at: row.reported_at, by: byFromText(row.reported_by), note: row.note, url: row.url, tokens: row.tokens, cost: row.cost } : null,
    stopRequested: row.stop_requested_at ? { at: row.stop_requested_at, by: row.stop_requested_by } : null,
    answer: answerOf(row),
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
  out.push(...events.map((e) => ({ ...e, actor: byFromText(e.actor) })));
  if (now.status === 'quiet') out.push({ at: iso(Date.parse(row.last_activity) + quietMs), kind: 'quiet', actor: null, ref: null, note: null, url: null });
  return out;
}

/**
 * The ids of the nodes a proposal touches: what it adds (and their parents), changes and removes, and both ends of the edges it adds,
 * changes and removes. Anything that is not a proposal gives none. Pure.
 * @param {any} proposal
 * @returns {string[]}
 */
export function proposalNodeIds(proposal) {
  const out = new Set();
  const list = (v) => (Array.isArray(v) ? v : []);
  const id = (v) => { if (typeof v === 'string' && v !== '') out.add(v); };
  const blocks = proposal && typeof proposal === 'object' ? proposal : {};
  for (const op of ['add', 'change', 'remove']) {
    for (const n of list(blocks.nodes?.[op])) { id(n?.id); if (op === 'add') id(n?.parent); }
    for (const e of list(blocks.edges?.[op])) { id(e?.from); id(e?.to); }
  }
  return [...out];
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
 * @property {number} [landed] set only by the `spec.approved` trigger: the spec pull request the approval was on. If no open pull request holds the
 *   proposal because that one has since merged, the request is about the proposal as it is on the default branch (no `refs.pull`) and is posted there
 * @property {{ event: string, ref: string }} [trigger] set only by an opt-in trigger (server/triggers.js): what caused this request. It is written into the
 *   request (`trigger: { event, by, ref }`, `by` being the maintainer asking) and the audit row, and the run's `via` is 'trigger'. A caller's body can never set it
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
  const runnerQuietMs = runnerQuietAfterMs(config);
  const refuseCollisions = agents.refuseCollisions === true;
  /** How requests travel from now on (`agents.transport`); a run keeps the transport it was asked for with */
  const transport = /** @type {'forge' | 'push' | 'pull'} */ (agents.transport ?? 'forge');
  const log = (what) => console.error(`[cornfield] agent runs: ${what}`);
  let following = null;
  let discovering = null;

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
      // `null` at this sha: the forge could not list the files (see readNodes), so what the run is about stands in, below
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
    // A forge's answer may lack a field (a pull request with no `createdAt`): the timeline then says when cornfield saw it, and a value
    // that is not text is left out. One odd answer must never throw out of the look, or every run's state in it would be lost
    const text = (v) => (typeof v === 'string' && v !== '' ? v : v == null ? null : typeof v === 'number' ? String(v) : null);
    const at = typeof ev.at === 'string' && !Number.isNaN(Date.parse(ev.at)) ? ev.at : iso(now());
    db.prepare('INSERT OR IGNORE INTO run_events (run_id, key, at, kind, actor, ref, note, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(runId, String(ev.key), at, ev.kind, text(ev.actor), text(ev.ref), text(ev.note), text(ev.url));
  }

  /**
   * The runs of this repo that are open as of now (the cap and the one-per-subject rule count these). A reservation whose comment never got
   * posted (a crash between the reservation and the post) holds its place for `RESERVATION_MS` only, whenever cornfield last restarted.
   */
  function openRows(db, at) {
    return /** @type {RunRow[]} */ (db.prepare("SELECT * FROM runs WHERE repo = ? AND state NOT IN ('done', 'failed', 'stopped') ORDER BY requested_at").all(repo))
      .filter((r) => (r.comment_id !== '' || r.transport !== 'forge' || at - Date.parse(r.requested_at) < RESERVATION_MS) && statusOf(r, at, quietMs).open);
  }

  /** Takes a place for a run: the cap and the one-per-subject rule are checked and the row inserted in one transaction. Throws a `Refused`. */
  function reserve(db, request, { target, who, via, force, trigger = false, derived = null, hand = null }) {
    const at = now();
    const mine = subjectKeys(request.refs);
    db.exec('BEGIN IMMEDIATE');
    try {
      // What a crash left (a reservation never posted) is dropped here too, not only at the next start
      db.prepare("DELETE FROM runs WHERE repo = ? AND comment_id = '' AND transport = 'forge' AND requested_at < ?").run(repo, iso(at - RESERVATION_MS));
      const open = openRows(db, at);
      if (open.length >= cap) {
        throw new Refused(409, `${repo} already has ${open.length} open run${open.length === 1 ? '' : 's'}, the most cornfield asks for (agents.maxOpen is ${cap}): ${open.map((r) => r.run_id).join(', ')}. Wait for one to finish or go quiet, or stop one.`, 'cap-reached');
      }
      if (refuseCollisions) {
        const map = theMap();
        // What the request names; when it names nothing (the dashboard's button), what its subject is about, read before the transaction
        const wanted = [...new Set([...requestNodes(request, map.ids.size ? map.ids : null), ...resolveMentions(derived || [], map.nodes).ids])];
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
      // A hand-written request is already on the forge: its row carries that comment (the record on every transport), and it travels as any request does
      db.prepare(`INSERT INTO runs (run_id, repo, kind, profile, issue, proposal, thread, target, comment_id, comment_url, request, requested_by, requested_by_id, requested_at, via, last_activity, transport)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(request.runId, repo, request.kind, request.profile ?? null, request.refs.issue ?? null, request.refs.proposal ?? null, request.refs.thread ?? null,
          target, hand ? hand.comment.id : '', hand ? hand.comment.url : null, JSON.stringify(request), request.requestedBy, String(who.userId), request.requestedAt, hand ? 'hand' : via ? 'api' : trigger ? 'trigger' : 'dashboard', iso(at), transport);
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
    if (transport !== 'forge') out.transport = transport;
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
      const { force, requestedBy, trigger: forged, ...fields } = body;
      // What caused a request is cornfield's to write, from a trigger's own call; a caller cannot say it was a trigger
      if (forged !== undefined) throw new Refused(400, '"trigger" is written by cornfield for an automatic request; leave it out.', 'invalid');
      if (force !== undefined && typeof force !== 'boolean') throw new Refused(400, '"force" is true or false: whether to ask for another run on an issue or proposal that has an open one.', 'invalid');
      const build = (login, pull) => {
        // The config's limits are hints the request starts from; what the person sent wins key by key
        const base = agents.limits || {};
        let limits = fields.limits;
        if (limits === undefined) limits = Object.keys(base).length ? { ...base } : undefined;
        else if (isObject(limits)) limits = { ...base, ...limits };
        // The brief is required by the contract and may be empty; the spec PR that holds a proposal is named beside it
        const refs = pull != null && isObject(fields.refs) ? { ...fields.refs, pull } : fields.refs;
        const made = createRequest({ brief: '', ...fields, refs, ...(limits !== undefined ? { limits } : {}), requestedBy: login, ...(ctx.trigger ? { trigger: { event: ctx.trigger.event, by: login, ref: ctx.trigger.ref } } : {}) }, { profiles, now: at });
        if (!made.ok) throw new Refused(400, made.error, 'invalid');
        return /** @type {RunRequest} */ (made.value);
      };
      if (ctx.trigger) Object.assign(asked, { trigger: { event: ctx.trigger.event, ref: ctx.trigger.ref } });
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
      let entry = null;
      if (made.refs.thread != null) number = made.refs.thread;
      else if (made.refs.proposal != null) {
        const listed = await listPullProposals(forge, folder, { hooks: null });
        entry = listed.entries.find((e) => e.slug === made.refs.proposal) ?? null;
        if (entry) {
          number = entry.pull.number;
          made = build(me.login, number);
          runId = made.runId;
          Object.assign(asked, { runId });
        } else if (ctx.landed != null && (entry = await landedEntry(forge, ctx.landed, made.refs.proposal))) {
          // A trigger's approval landed its spec pull request first (proposals.approveLands): the proposal is on the default branch, so
          // the request names no pull request ("an approved proposal already on the default branch has none") and is posted on the merged one
          number = ctx.landed;
        } else throw new Refused(404, listed.problem ? `The open spec pull requests could not be read: ${listed.problem}` : `No open spec pull request holds the proposal ${made.refs.proposal}, so there is nowhere to post the request.`, 'not-found');
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
      // On the forge the request is a comment. On push and pull there is none: the run is recorded and the transport delivers it
      let comment = null;
      if (transport === 'forge') {
        comment = formatRunComment(made.runId, made, { profiles });
        if (via) {
          const [head, ...rest] = comment.split('\n\n');
          comment = [`${head} Sent through the agent API with the token \`${via.token.label}\`.`, ...rest].join('\n\n');
        } else if (made.trigger) {
          const [head, ...rest] = comment.split('\n\n');
          comment = [`${head} Asked by the trigger on ${made.trigger.event} (${made.trigger.ref}), after an act of ${made.trigger.by}'s.`, ...rest].join('\n\n');
        }
      }

      // The token once more, after every forge call: one revoked or expired meanwhile does not ask
      if (ctx.stillAllowed) {
        const why = await ctx.stillAllowed();
        if (why) throw new Refused(403, why, 'forbidden');
      }
      // With collisions refused, a request that names no node on the map is checked by what its subject is about (spec 0005 D9), as the
      // map would mark it before its first push: the opening post's mentions and the proposal's nodes. Read now, outside the transaction
      let derived = null;
      if (refuseCollisions && !requestNodes(made, theMap().ids.size ? theMap().ids : null).length) {
        try {
          derived = await subjectRefs(forge, made.refs, entry);
        } catch (err) {
          throw new Refused(503, `What this request is about could not be read, so it cannot be checked for collisions (agents.refuseCollisions is on): ${words(err)}`, 'unavailable');
        }
      }
      const db = await auth.store();
      reserve(db, made, { target: number, who, via, force: force === true, trigger: Boolean(made.trigger), derived });
      // What was read is what the map marks for this run until it pushes: kept, so the overlay has it now and the poll need not read it again
      if (derived) db.prepare('INSERT OR REPLACE INTO run_reads (run_id, source, sha, data, at) VALUES (?, ?, ?, ?, ?)').run(made.runId, 'mentions', '', JSON.stringify(derived), iso(now()));
      let posted = null;
      if (comment !== null) {
        try {
          posted = await forge.comment(number, comment);
        } catch (err) {
          db.prepare('DELETE FROM runs WHERE run_id = ?').run(made.runId);
          db.prepare('DELETE FROM run_reads WHERE run_id = ?').run(made.runId);
          throw err;
        }
        db.prepare('UPDATE runs SET comment_id = ?, comment_url = ? WHERE run_id = ?').run(posted.id, posted.url ?? null, made.runId);
      }
      status = 201;
      await audit({ login: me.login, action: 'agent-request', target, request: { ...asked, target: number }, status, answer: posted ? { comment: posted.id, url: posted.url ?? null } : { transport, queued: transport === 'pull' } });
      hooks?.emit('agent.requested', { request: made, actor: me.login });
      try { onAsk?.(); } catch { /* the poll is a convenience */ }
      const row = /** @type {RunRow} */ (db.prepare('SELECT * FROM runs WHERE run_id = ?').get(made.runId));
      return { run: publicRun(row, now(), quietMs, extrasFor(db, [row], now()).get(row.run_id)), request: made, comment: posted ? { id: posted.id, url: posted.url ?? null, number } : null };
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
      const stamp = iso(now());
      /** A pull run nobody has claimed has no runner to stop: cornfield ends it itself, saying so (the one `stopped` it writes) */
      const unclaimed = row.transport === 'pull' && row.claimed_by == null && row.state === 'requested';
      let posted = null;
      if (row.transport === 'forge') {
        let comment;
        try {
          comment = formatRunComment(row.run_id, { state: 'stop-requested', ...(note ? { note } : {}) }, { line: `Asked run \`${row.run_id}\` to stop (${me.login}, in cornfield${via ? `, through the agent API with the token \`${via.token.label}\`` : ''}).` });
        } catch (err) {
          throw new Refused(400, words(err), 'invalid');
        }
        posted = await forge.comment(row.target, comment);
      }
      // Judged already: the follow that reads this comment back must not fire the hook again
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE runs SET stop_requested_at = ?, stop_requested_by = ?, last_activity = MAX(last_activity, ?) WHERE run_id = ?').run(stamp, me.login, stamp, row.run_id);
        keepEvent(db, row.run_id, { key: posted ? `stop:${posted.id}` : `stop:cornfield:${stamp}`, at: stamp, kind: 'stop-requested', actor: me.login, note: note || null, url: posted ? posted.url ?? null : null });
        if (posted) {
          db.prepare('INSERT OR IGNORE INTO run_seen (run_id, key, at) VALUES (?, ?, ?)').run(row.run_id, `c:${posted.id}:${row.run_id}:stop-request:0`, stamp);
          db.prepare('INSERT OR IGNORE INTO run_seen (run_id, key, at) VALUES (?, ?, ?)').run(row.run_id, `ev:stop:${posted.id}:c:${posted.id}:${row.run_id}:stop-request:0`, stamp);
        }
        if (unclaimed) {
          const ended = db.prepare("UPDATE runs SET state = 'stopped', reported_at = ?, reported_by = ?, note = ? WHERE run_id = ? AND state = 'requested' AND claimed_by IS NULL").run(stamp, me.login, 'Stopped before a runner claimed it.', row.run_id).changes;
          if (ended !== 1) throw new Refused(409, `Run ${row.run_id} was claimed just now; ask again to stop it.`, 'conflict');
        }
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* nothing was begun */ }
        throw err;
      }
      done = true;
      await audit({ login: me.login, action: 'agent-stop', target, request: { ...asked, ...(note ? { noteChars: note.length } : {}) }, status: 201, answer: posted ? { comment: posted.id, url: posted.url ?? null } : { transport: row.transport, ...(unclaimed ? { stopped: true } : {}) } });
      const after = /** @type {RunRow} */ (db.prepare('SELECT * FROM runs WHERE run_id = ?').get(row.run_id));
      hooks?.emit('run.stopRequested', runPayload(after, me.login));
      if (unclaimed) {
        hooks?.emit('run.state', { ...runPayload(after, me.login), state: 'stopped' });
        hooks?.emit('run.finished', { ...runPayload(after, me.login), state: 'stopped' });
      }
      return { run: publicRun(after, now(), quietMs, extrasFor(db, [after], now()).get(after.run_id)), comment: posted ? { id: posted.id, url: posted.url ?? null } : null };
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

  /**
   * A maintainer's answer to a run that reported `waiting`: `continue`, `stop` or a `reply` (text). Throws like `stop`.
   * - **Stop** is `stop` itself (the same checks, block, audit row and hook), with the answer recorded beside it.
   * - **Continue and reply** are kept on the run, replacing an earlier answer to the same wait; on the forge the `answered` block is posted
   *   first, in the same place as the request, as the maintainer who clicked. A run that is not waiting, is over, or was asked to stop is a 409.
   * @param {RequestContext} ctx
   * @param {{ runId: unknown, action?: unknown, text?: unknown, problem?: { status: number, message: string } }} input
   */
  async function answer(ctx, { runId, action, text, problem }) {
    const { who, via = null } = ctx;
    // A Stop to a run that is waiting is a stop request; anything else (not strictly an answer, no such run, not waiting) is refused below as an answer
    const stopping = action === 'stop' && !problem && validateAnswer({ state: 'answered', action, ...(text !== undefined ? { text } : {}) }).ok
      && typeof runId === 'string' && /** @type {RunRow | undefined} */ ((await auth.store()).prepare('SELECT state FROM runs WHERE run_id = ? AND repo = ?').get(runId, repo))?.state === 'waiting';
    if (stopping) {
      const stopped = await stop(ctx, { runId, note: text, problem });
      const db = await auth.store();
      const stamp = iso(now());
      const kept = db.prepare("UPDATE runs SET answer_action = 'stop', answer_text = ?, answer_at = ?, answer_by = ? WHERE run_id = ? AND state = 'waiting'")
        .run(typeof text === 'string' && text.trim() !== '' ? text : null, stamp, who.login, stopped.run.runId).changes;
      const after = /** @type {RunRow} */ (db.prepare('SELECT * FROM runs WHERE run_id = ?').get(stopped.run.runId));
      if (kept) hooks?.emit('run.answered', { ...runPayload(after, who.login), action: 'stop' });
      return { ...stopped, run: publicRun(after, now(), quietMs, extrasFor(db, [after], now()).get(after.run_id)) };
    }
    const at = ctx.limits.now ?? now;
    const flood = countAttempt(ctx.limits, who.userId, at());
    if (flood) throw flood;
    let target = repo;
    let done = false;
    let release = () => {};
    const asked = { ...(typeof runId === 'string' && runId.length <= 40 ? { runId } : {}), ...(typeof action === 'string' && action.length <= 10 ? { action } : {}), ...(typeof text === 'string' ? { textChars: text.length } : {}), ...(via ? { via: 'api', token: via.token } : {}) };
    try {
      if (problem) throw new Refused(problem.status, problem.message, 'invalid');
      const checked = validateAnswer({ state: 'answered', action, ...(text !== undefined ? { text } : {}) });
      if (!checked.ok) throw new Refused(400, checked.error, 'invalid');
      const a = checked.value;
      const db = await auth.store();
      const row = typeof runId === 'string' ? /** @type {RunRow | undefined} */ (db.prepare('SELECT * FROM runs WHERE run_id = ? AND repo = ?').get(runId, repo)) : undefined;
      if (!row) throw new Refused(404, 'cornfield has no such run.', 'not-found');
      target = `${repo}#${row.target}`;
      release = throttle(ctx.limits, who.userId, `agent-answer|${row.run_id}`, at());
      const forge = await ctx.forge();
      const me = await forge.me();
      if (String(me.id) !== who.userId) throw new Refused(403, 'The forge says this sign-in is someone else now; sign in again.', 'forbidden');
      if (!isMaintainer(await forge.permission(repo, me.login))) throw new Refused(403, `Only the repo's maintainers answer agent runs; ${me.login} is not one now.`, 'forbidden');
      const was = statusOf(row, now(), quietMs);
      if (was.finished) throw new Refused(409, `Run ${row.run_id} is ${was.status}; there is nothing to answer.`, 'conflict');
      if (row.stop_requested_at) throw new Refused(409, `${row.stop_requested_by ?? 'A maintainer'} already asked run ${row.run_id} to stop (${row.stop_requested_at}); the runner decides what that means.`, 'conflict');
      if (row.state !== 'waiting') throw new Refused(409, `Run ${row.run_id} is not waiting for an answer (its runner last reported ${row.state}).`, 'conflict');
      if (a.action === 'stop') throw new Refused(409, `Run ${row.run_id} changed while the answer was being taken; read it again.`, 'conflict');
      if (ctx.stillAllowed) {
        const why = await ctx.stillAllowed();
        if (why) throw new Refused(403, why, 'forbidden');
      }
      const stamp = iso(now());
      let posted = null;
      if (row.transport === 'forge') {
        let comment;
        try {
          comment = formatRunComment(row.run_id, a, { line: `Answered run \`${row.run_id}\`: ${a.action} (${me.login}, in cornfield${via ? `, through the agent API with the token \`${via.token.label}\`` : ''}).` });
        } catch (err) {
          throw new Refused(400, words(err), 'invalid');
        }
        posted = await forge.comment(row.target, comment);
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        // The runner may have reported again while the forge was asked: it answered the wait it was in, so only a run still waiting takes it
        // The block just posted is judged already, whatever comes of it: a follow must never read cornfield's own answer back as a maintainer's,
        // not even one that came too late for the wait it answered (kept even when the answer is refused below)
        if (posted) {
          db.prepare('INSERT OR IGNORE INTO run_seen (run_id, key, at) VALUES (?, ?, ?)').run(row.run_id, `c:${posted.id}:${row.run_id}:answer:0`, stamp);
          db.prepare('INSERT OR IGNORE INTO run_seen (run_id, key, at) VALUES (?, ?, ?)').run(row.run_id, `ev:answered:${posted.id}:c:${posted.id}:${row.run_id}:answer:0`, stamp);
        }
        const kept = db.prepare("UPDATE runs SET answer_action = ?, answer_text = ?, answer_at = ?, answer_by = ?, last_activity = MAX(last_activity, ?) WHERE run_id = ? AND state = 'waiting' AND stop_requested_at IS NULL")
          .run(a.action, a.text ?? null, stamp, me.login, stamp, row.run_id).changes;
        if (kept !== 1) {
          db.exec('COMMIT');
          throw new Refused(409, `Run ${row.run_id} changed while the answer was being taken; read it again.`, 'conflict');
        }
        // Two maintainers answering at once: the last write wins on the run, and the timeline keeps both
        keepEvent(db, row.run_id, { key: posted ? `answer:${posted.id}` : `answer:cornfield:${stamp}:${me.login}`, at: stamp, kind: 'answered', actor: me.login, ref: a.action, note: a.text ?? null, url: posted ? posted.url ?? null : null });
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* nothing was begun */ }
        throw err;
      }
      done = true;
      await audit({ login: me.login, action: 'agent-answer', target, request: { ...asked, action: a.action, ...(a.text ? { textChars: a.text.length } : {}) }, status: 201, answer: posted ? { comment: posted.id, url: posted.url ?? null } : { transport: row.transport } });
      const after = /** @type {RunRow} */ (db.prepare('SELECT * FROM runs WHERE run_id = ?').get(row.run_id));
      hooks?.emit('run.answered', { ...runPayload(after, me.login), action: a.action });
      return { run: publicRun(after, now(), quietMs, extrasFor(db, [after], now()).get(after.run_id)), comment: posted ? { id: posted.id, url: posted.url ?? null } : null };
    } catch (err) {
      if (!done) {
        const out = describe(err);
        await audit({ login: who.login, action: 'agent-answer', target, request: asked, status: err instanceof ForgeError ? err.status ?? (err.code === 'unavailable' ? null : out.status) : out.status, answer: { error: out.error, code: out.code } });
        if (!(err instanceof Refused) && !(err instanceof ForgeError)) log(`answering ${asked.runId ?? ''} failed: ${err instanceof Error ? err.stack || err.message : err}`);
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
    const rows = /** @type {RunRow[]} */ (db.prepare(`SELECT * FROM runs WHERE repo = ? AND ${POSTED} ORDER BY requested_at DESC, run_id DESC LIMIT ?`).all(repo, limit));
    // The dashboard's notice for triggers that did nothing (server/triggers.js writes a `trigger-skipped` row each time): the last day's, by reason
    const skipped = /** @type {{ at: string, answer: string | null }[]} */ (db.prepare("SELECT at, answer FROM actions WHERE action = 'trigger-skipped' AND (target = ? OR target LIKE ?) AND at > ? ORDER BY id DESC LIMIT 200").all(repo, `${repo}#%`, iso(at - 24 * 3_600_000)));
    const extras = extrasFor(db, rows, at);
    const reasons = {};
    for (const r of skipped) {
      let why = 'error';
      try { why = JSON.parse(r.answer ?? '{}').reason || why; } catch { /* a row that is not JSON is counted as an error */ }
      reasons[why] = (reasons[why] || 0) + 1;
    }
    return {
      runs: rows.map((r) => publicRun(r, at, quietMs, extras.get(r.run_id))), open: openRows(db, at).length, maxOpen: cap, profiles, limits: agents.limits || {}, quietAfter: agents.quietAfter, runners: [...runnerSet].length,
      triggerSkipped: skipped.length ? { count: skipped.length, last: skipped[0].at, reasons } : null,
      refuseCollisions, runnerPresence: { transport, ...runnerPresence(db, at, runnerQuietMs) },
      handWritten: { mode: handMode, refused: discovers ? handRefused(db, at) : [] },
    };
  }

  /** One run, or null */
  async function get(runId) {
    const db = await auth.store();
    const row = typeof runId === 'string' ? /** @type {RunRow | undefined} */ (db.prepare(`SELECT * FROM runs WHERE run_id = ? AND repo = ? AND ${POSTED}`).get(runId, repo)) : undefined;
    return row ? publicRun(row, now(), quietMs, extrasFor(db, [row], now()).get(row.run_id)) : null;
  }

  /** The runs a follow looks at: posted, not over for good (a trusted pull request merged or closed), and active within the follow window or waiting on a maintainer */
  function followable(db, at) {
    const window = Math.max(2 * quietMs, FOLLOW_FLOOR_MS);
    return /** @type {RunRow[]} */ (db.prepare(`SELECT * FROM runs WHERE repo = ? AND ${POSTED} AND (last_activity > ? OR (state = 'waiting' AND stop_requested_at IS NULL)) AND NOT (pull_trusted = 1 AND pull_state IN ('merged', 'closed')) ORDER BY last_activity DESC LIMIT ?`)
      .all(repo, iso(at - window), MAX_FOLLOWED));
  }

  /** Whether there is a run to look at: what the spec poll asks before it spends a call of the forge */
  async function hasWork() {
    return followable(await auth.store(), now()).length > 0;
  }

  // -------------------------------------------------------------------------
  //  Requests written by hand (issue #98)
  // -------------------------------------------------------------------------

  const handMode = handWrittenMode(config);

  /** The refused and ignored hand-written blocks of the last days, newest first, for the Runs view: who wrote them, where, and why nothing started */
  function handRefused(db, at) {
    const rows = /** @type {{ at: string, login: string, target: string, request: string, answer: string | null }[]} */ (db.prepare("SELECT at, login, target, request, answer FROM actions WHERE action = 'agent-hand' AND (target = ? OR target LIKE ?) AND at > ? ORDER BY id DESC LIMIT 200")
      .all(repo, `${repo}#%`, iso(at - HAND_SHOWN_MS)));
    const out = [];
    for (const r of rows) {
      const a = safeJson(r.answer) ?? {};
      if (a.accepted !== false) continue;
      const q = safeJson(r.request) ?? {};
      out.push({ at: r.at, by: r.login, number: Number(r.target.slice(r.target.indexOf('#') + 1)) || null, runId: typeof q.runId === 'string' ? q.runId : null, url: typeof a.url === 'string' ? a.url : null, why: typeof a.why === 'string' ? a.why : 'malformed', reason: typeof a.reason === 'string' ? a.reason : '' });
      if (out.length >= HAND_SHOWN) break;
    }
    return out;
  }

  /**
   * The request blocks of a comment that have no run id in their fence (a bare `cornfield-run` fence), the ones a maintainer writes by hand when
   * cornfield is to assign the id: `{ ok, request | error }` for each, in order. The JSON may leave out `version`, `runId`, `requestedBy` and
   * `requestedAt` (cornfield writes them: the author is the comment's, the time is when it was posted); everything else is checked as any request.
   */
  function bareBlocks(text, login, postedAt, commentId) {
    const out = [];
    let index = 0;
    if (typeof text !== 'string' || !text.includes(RUN_TAG)) return out;
    for (const b of fencedBlocks(text.slice(0, MAX_TEXT_CHARS).replace(/\r\n?/g, '\n'))) {
      if (b.fence !== '```' || !b.end || b.info.trim() !== RUN_TAG) continue;
      if (out.length >= MAX_BLOCKS) break;
      const id = handRunId(commentId, index++, postedAt);
      if (b.body.length > MAX_BLOCK_CHARS) { out.push({ ok: false, error: `The block is longer than ${MAX_BLOCK_CHARS} characters.` }); continue; }
      let json;
      try { json = JSON.parse(b.body); } catch { out.push({ ok: false, error: 'The block is not JSON (it holds exactly one object).' }); continue; }
      if (!isObject(json)) { out.push({ ok: false, error: 'A request is a JSON object.' }); continue; }
      if (json.runId !== undefined && !isRunId(json.runId)) { out.push({ ok: false, error: '"runId" is "run-" and a 26 character ULID; leave it out and cornfield assigns one.' }); continue; }
      const checked = validateRequest({ version: CONTRACT_VERSION, ...json, runId: json.runId ?? id, requestedBy: login, requestedAt: postedAt }, { profiles });
      out.push(checked.ok ? { ok: true, request: checked.value, assigned: json.runId === undefined } : { ok: false, error: checked.error });
    }
    return out;
  }

  /**
   * The id cornfield assigns to a bare fence: the same for the same block on every look and after a restart (the time the comment was posted,
   * then bits of a hash of the repo, the comment and the block's place in it), so a block is never taken twice under two ids
   */
  function handRunId(commentId, index, postedAt) {
    const ms = Date.parse(postedAt);
    const digest = createHash('sha256').update(`${repo}\0${commentId}\0${index}`).digest();
    return newRunId({ now: () => (Number.isSafeInteger(ms) && ms >= 0 ? ms : 0), random: () => digest.subarray(0, 10) });
  }

  /** Whether the engine looks for requests written by hand (`agents.handWritten`): the spec poll asks, so it runs even with no run to follow */
  const discovers = handMode !== false;

  /**
   * Reads the comments of the open issues and pull requests for `cornfield-run` request blocks a maintainer wrote by hand, and makes a run of
   * each valid one (the steps in this module's header, "Requests written by hand"). One look reads at most `MAX_HAND_READS` conversations, the
   * ones that moved earliest since they were last read; every block is judged once (`run_seen`, an audit row). Never throws.
   * @param {import('./forge.js').Forge} forge a signed-in maintainer's
   * @returns {Promise<{ read: number, imported: number, refused: number }>}
   */
  function discover(forge) {
    if (!discovers) return Promise.resolve({ read: 0, imported: 0, refused: 0 });
    if (discovering) return discovering;
    discovering = discoverRuns(forge)
      .catch((err) => {
        log(`a look for requests written by hand failed: ${words(err)}`);
        return { read: 0, imported: 0, refused: 0 };
      })
      .finally(() => { discovering = null; });
    return discovering;
  }

  async function discoverRuns(forge) {
    const out = { read: 0, imported: 0, refused: 0 };
    const db = await auth.store();
    const at = now();
    const label = ideaLabel(config);
    const wanted = (x) => handMode === 'all' || (label !== null && Array.isArray(x.labels) && x.labels.includes(label));
    const seen = (key) => db.prepare("SELECT 1 FROM run_seen WHERE run_id = '' AND key = ?").get(key) !== undefined;
    const mark = (key) => db.prepare("INSERT OR IGNORE INTO run_seen (run_id, key, at) VALUES ('', ?, ?)").run(key, iso(at));
    // Where the last look got to (`hand-since:<time>`): only what changed since is listed, the least recently changed first, so a busy repo's
    // oldest change is read before a newer one and none is starved. Never further back than agents.quietAfter: an older request would be refused as old
    const cursorRow = /** @type {{ key: string } | undefined} */ (db.prepare("SELECT key FROM run_seen WHERE run_id = '' AND key LIKE 'hand-since:%'").get());
    const since = Math.max(at - quietMs, cursorRow ? Date.parse(cursorRow.key.slice('hand-since:'.length)) || 0 : 0);
    /** @type {{ number: number, updatedAt: string, labels: string[] }[]} */
    let targets;
    try {
      // `since` is "at or after": what shares the second the cursor stopped at is listed again, and skipped by its key
      targets = await forge.changed({ since: iso(since), limit: HAND_TARGETS });
    } catch (err) {
      log(`the open issues and pull requests could not be listed for requests written by hand: ${words(err)}`);
      return out;
    }
    let cursor = null;
    let held = false;
    const advance = (t) => { if (!held && Number.isFinite(Date.parse(t.updatedAt))) cursor = t.updatedAt; };
    const maintainerOf = new Map();
    const isMaintainerLogin = (login) => {
      const k = lower(login);
      if (!maintainerOf.has(k)) maintainerOf.set(k, forge.permission(repo, login).then(isMaintainer));
      return maintainerOf.get(k);
    };
    let poster = null;
    const posterLogin = async () => (poster ??= await forge.me().then((m) => m.login, () => null));
    let judged = 0;
    let fresh = 0;
    for (const t of targets) {
      if (!wanted(t)) { advance(t); continue; }
      const scanKey = `scan:${t.number}@${t.updatedAt}`;
      if (seen(scanKey)) { advance(t); continue; }
      fresh += 1;
      // The rest wait for the next look, which starts here
      if (out.read >= MAX_HAND_READS || judged >= MAX_HAND_JUDGED) break;
      let comments;
      try {
        comments = await forge.comments(t.number);
      } catch (err) {
        log(`the comments on #${t.number} could not be read for requests written by hand: ${words(err)}`);
        held = true;
        continue;
      }
      out.read += 1;
      const standing = new Map();
      try {
        for (const login of runAuthors(comments)) standing.set(lower(login), await isMaintainerLogin(login));
      } catch (err) {
        log(`who wrote the comments on #${t.number} could not be asked: ${words(err)}`);
        held = true;
        continue;
      }
      const rowOf = (runId) => /** @type {RunRow | undefined} */ (db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId));
      let waiting = false;
      /** @type {{ login: string | null, request: object, answer: object, number: number }[]} */
      const audits = [];
      const counts = new Map();
      const keyOf = (commentId, runId, kind) => {
        const base = `h:${commentId}:${runId ?? '-'}:${kind}`;
        const n = counts.get(base) ?? 0;
        counts.set(base, n + 1);
        return `${base}:${n}`;
      };
      /** Writes one block's outcome down once: its key is kept first, then the audit row follows; true when it is new */
      const judge = (comment, key, runId, by, answer) => {
        if (seen(key)) return false;
        mark(key);
        judged += 1;
        audits.push({ login: by ?? 'unknown', request: { runId, type: 'request', comment: comment.id }, answer: { ...answer, ...(comment.url ? { url: comment.url } : {}) }, number: t.number });
        return true;
      };
      const EDITED = 'the comment was edited after it was posted, so its request is not believed';
      const NOT_MAINTAINER = (by) => `${by ?? 'the author'} is not a maintainer now, and only a maintainer's request starts a run`;

      const found = runBlocksOf(comments, { trust: (login, block) => block.type === 'request' && standing.get(lower(login)) === true, profiles });
      // Which comments hold a request block for each run id, in the order they were written (comments come oldest first)
      /** @type {Map<string, string[]>} */
      const holders = new Map();
      for (const b of [...found.blocks, ...found.ignored]) if (b.type === 'request') holders.set(b.runId, [...(holders.get(b.runId) ?? []), b.comment.id]);
      /**
       * Whether a block is cornfield's reply naming the id it assigned to a bare fence: the run is a hand-written one, its own comment holds no
       * block with that id, and this is the first other comment that does. A later one is a copy
       */
      const isReply = (runId, commentId) => {
        const row = rowOf(runId);
        if (!row || row.via !== 'hand' || row.comment_id === commentId) return false;
        const list = (holders.get(runId) ?? []).filter((id) => id !== row.comment_id);
        return !(holders.get(runId) ?? []).includes(row.comment_id) && list[0] === commentId;
      };
      /** Posts the reply that names the id cornfield assigned, as the poll's signed-in maintainer; false when the forge said no */
      const reply = async (request) => {
        const by = await posterLogin();
        // Refresh looks as whoever pressed it: only a maintainer's sign-in posts a request block, so anyone else's leaves it to the poll's next look
        if (!by || !(await isMaintainerLogin(by).catch(() => false))) { waiting = true; return null; }
        try {
          const posted = await forge.comment(t.number, formatRunComment(request.runId, request, {
            profiles,
            line: `Run \`${request.runId}\` is the id cornfield assigned to ${request.requestedBy}'s request above, written by hand: a ${request.kind} run, followed like any other. The request is ${request.requestedBy}'s; this reply was posted by cornfield${by ? ` with ${by}'s sign-in` : ''}.`,
          }));
          return { comment: posted.id, url: posted.url ?? null, postedBy: by };
        } catch (err) {
          log(`the id of a request written by hand on #${t.number} could not be posted, so it is posted on a later look: ${words(err)}`);
          waiting = true;
          return null;
        }
      };

      /** Takes a place for one request from a maintainer; null when there is nothing to say (cornfield's own, or left for the next look), else the outcome */
      const take = async (comment, request, assigned) => {
        const row = rowOf(request.runId);
        if (row) {
          // cornfield's own request, or one taken before: the run is that comment's
          if (row.comment_id === comment.id) return null;
          // cornfield has reserved the id and is about to post it: not yet anyone's copy, so looked at again next time
          if (row.transport === 'forge' && row.comment_id === '') { waiting = true; return null; }
          return { accepted: false, why: 'duplicate', reason: `run ${row.run_id} already has this id, so this block is not imported again (cornfield never starts a second run for one block). Write a block without an id and cornfield assigns one` };
        }
        if (at - Date.parse(request.requestedAt) >= quietMs) return { accepted: false, why: 'old', reason: 'posted more than agents.quietAfter ago, so the run would be quiet at once and count for nothing; write it again to ask now' };
        try {
          reserve(db, request, { target: t.number, who: { userId: '' }, via: null, force: false, hand: { comment } });
        } catch (err) {
          if (err instanceof Refused) return { accepted: false, why: err.code ?? 'refused', reason: err.message };
          throw err;
        }
        // On push and pull the run goes out as any request does: the hook is the delivery, the queue holds it for a runner to claim
        if (transport !== 'forge') hooks?.emit('agent.requested', { request, actor: request.requestedBy });
        // The thread stays the record: the id cornfield assigned is written beside the request, as a block a runner can read. The run is kept
        // if that fails (on pull it may be claimed already): the next look posts it
        const posted = assigned ? await reply(request) : null;
        return { accepted: true, kind: request.kind, transport, ...(posted ? { reply: posted } : {}) };
      };

      /** @type {{ comment: { id: string, url: string | null }, by: string, request: any, assigned: boolean }[]} */
      const accepted = [];
      for (const b of found.blocks) accepted.push({ comment: b.comment, by: b.by, request: { ...b.value, requestedBy: b.by, requestedAt: b.at }, assigned: false });
      for (const c of comments) {
        const by = c.author?.login ?? null;
        if (!by || typeof c.body !== 'string') continue;
        const maintainer = standing.get(lower(by)) === true;
        const edited = c.updatedAt !== undefined && !(Date.parse(c.updatedAt) - Date.parse(c.createdAt) <= EDIT_GRACE_MS);
        const comment = { id: String(c.id), url: c.url ?? null };
        for (const r of bareBlocks(c.body, by, c.createdAt, comment.id)) {
          // Not a maintainer's: a block that is not even a request is nobody's business; a good one is shown as ignored, with the reason
          if (!r.ok) { if (maintainer && judge(comment, keyOf(comment.id, null, 'refused'), null, by, { accepted: false, why: 'malformed', reason: r.error })) out.refused += 1; continue; }
          if (!maintainer || edited) { if (judge(comment, keyOf(comment.id, r.request.runId, edited && maintainer ? 'edited' : 'author'), r.request.runId, by, { accepted: false, why: !maintainer ? 'author' : 'edited', reason: !maintainer ? NOT_MAINTAINER(by) : EDITED })) out.refused += 1; continue; }
          accepted.push({ comment, by, request: r.request, assigned: r.assigned });
        }
      }
      accepted.sort((x, y) => Date.parse(x.request.requestedAt) - Date.parse(y.request.requestedAt) || Number(x.comment.id) - Number(y.comment.id));
      for (const a of accepted) {
        const key = keyOf(a.comment.id, a.request.runId, 'request');
        if (isReply(a.request.runId, a.comment.id)) continue;
        // An id cornfield assigned whose reply is not in the thread (the forge said no, or cornfield stopped before it was posted): posted now
        const row = rowOf(a.request.runId);
        if (a.assigned && row && row.comment_id === a.comment.id && !(holders.get(a.request.runId) ?? []).length) {
          const posted = await reply(a.request);
          if (posted) await audit({ login: a.by, action: 'agent-hand', target: `${repo}#${t.number}`, request: { runId: a.request.runId, type: 'request', comment: a.comment.id }, answer: { accepted: true, kind: a.request.kind, transport: row.transport, reply: posted } });
          if (!seen(key)) mark(key);
          continue;
        }
        if (seen(key)) continue;
        const outcome = await take(a.comment, a.request, a.assigned);
        if (outcome === null) continue;
        judge(a.comment, key, a.request.runId, a.by, outcome);
        if (outcome.accepted) out.imported += 1; else out.refused += 1;
      }
      for (const b of found.ignored) {
        if (b.type !== 'request') continue;
        // cornfield's own request (or its reply), by a maintainer who has since stopped being one, is not a stranger's
        const own = rowOf(b.runId);
        if (own && own.comment_id === b.comment.id) continue;
        if (isReply(b.runId, b.comment.id)) continue;
        if (judge(b.comment, keyOf(b.comment.id, b.runId, b.why), b.runId, b.by, { accepted: false, why: b.why, reason: b.why === 'edited' ? EDITED : NOT_MAINTAINER(b.by) })) out.refused += 1;
      }
      // What is not strictly a request, from a maintainer: shown with the reason. A block of a run cornfield has (a report with a stray key) is the follow's to judge
      for (const r of found.refused) {
        if (r.error.startsWith('The fence names ""')) continue; // a fence with no id: read above
        if (!r.by || standing.get(lower(r.by)) !== true) continue;
        if (r.runId && rowOf(r.runId)) continue;
        if (judge(r.comment, keyOf(r.comment.id, r.runId, 'refused'), r.runId, r.by, { accepted: false, why: 'malformed', reason: r.error })) out.refused += 1;
      }
      for (const a of audits) await audit({ login: a.login ?? 'unknown', action: 'agent-hand', target: `${repo}#${a.number}`, request: a.request, status: null, answer: a.answer });
      // Read at this update: not read again until the conversation moves, unless something was left for the next look (which then starts here)
      if (waiting) held = true;
      else {
        db.prepare("DELETE FROM run_seen WHERE run_id = '' AND key LIKE ?").run(`scan:${t.number}@%`);
        mark(scanKey);
        advance(t);
      }
    }
    // A page of only what was read before, all of one second, would be listed again and again: the look steps past that second once it is a
    // minute old (nothing more can be written in it then)
    if (!held && fresh === 0 && cursor !== null && Date.parse(cursor) <= since && Date.parse(cursor) < at - 60_000) cursor = iso(Date.parse(cursor) + 1000);
    if (cursor !== null) {
      db.prepare("DELETE FROM run_seen WHERE run_id = '' AND key LIKE 'hand-since:%'").run();
      mark(`hand-since:${cursor}`);
    }
    return out;
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
   * The proposal `slug` as merged pull request `n` held it, or null: not merged, gone, or it never held that proposal. Read of the forge
   * (its files at its head), not taken from the trigger's word, so a request is posted only on a pull request that landed the proposal.
   * @param {import('./forge.js').Forge} forge
   * @param {number} n
   * @param {string} slug
   */
  async function landedEntry(forge, n, slug) {
    let pull;
    try {
      pull = await forge.pull(n);
    } catch (err) {
      if (err instanceof ForgeError && err.code === 'not-found') return null;
      throw err;
    }
    if (pull.state !== 'merged') return null;
    return (await pullProposals(forge, folder, pull)).find((e) => e.slug === slug) ?? null;
  }

  /**
   * What a run is about, as references the map resolves (spec 0005 D9: "before the first push, the nodes come from what the request was
   * about: the proposal, or the thread's mentions"): the `[[mentions]]` in the opening post of its thread, issue or spec PR, and for a
   * proposal the ids of every node it touches (what it adds, changes and removes, the parents of what it adds, and the ends of the edges it
   * adds, changes and removes). Asks the forge; throws what it throws. `entry`: the spec PR's listing when the caller has it already. A proposal
   * with no `pull` (one a trigger asked about after it landed) is read from the merged pull request `target` the request was posted on.
   * @returns {Promise<string[]>}
   */
  async function subjectRefs(forge, refs, entry = null, target = null) {
    const out = [];
    const add = (r) => { if (typeof r === 'string' && r !== '' && !out.includes(r)) out.push(r); };
    // A request about a proposal and a conversation is read as the conversation's when it names no spec pull request
    const at = refs?.pull ?? entry?.pull.number ?? (refs?.thread == null && refs?.issue == null ? target : null);
    if (refs?.proposal != null && at != null) {
      const pull = await forge.pull(at);
      parseMentions(pull.body ?? '').refs.forEach(add);
      const found = entry ?? (refs.pull != null ? await findPullProposal(forge, folder, refs.proposal, refs.pull) : await landedEntry(forge, at, refs.proposal));
      if (found) {
        let proposal = null;
        try { proposal = JSON.parse(await readPullProposal(forge, folder, found)); } catch (err) { if (!(err instanceof SyntaxError)) throw err; }
        for (const id of proposalNodeIds(proposal)) add(id);
      }
    } else if (refs?.thread != null || refs?.issue != null) {
      const n = refs.thread ?? refs.issue;
      let item;
      try {
        item = await forge.issue(n);
      } catch (err) {
        // A thread that is a pull request is not an issue to the forge: ask for it as one
        if (!(err instanceof ForgeError && err.code === 'not-found')) throw err;
        item = await forge.pull(n);
      }
      parseMentions(item.body ?? '').refs.forEach(add);
    }
    return out;
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
        // Files listed at this head: they say the nodes. Listed as unknowable (`null`): what the run is about stands in, read below
        if (had && had.sha === row.head_sha && Array.isArray(had.data)) continue;
        if (!(had && had.sha === row.head_sha) && files < MAX_FILE_READS) {
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
            // A forge that cannot list a comparison's files (an older Forgejo) will not at this head either: say so once, keep `null` for this
            // sha so it is not asked again until the next push, and the run keeps the nodes of what it is about. Anything else is tried again.
            if (err instanceof ForgeError && err.code === 'invalid') save.run(row.run_id, 'files', row.head_sha, 'null', iso(at));
            log(`the files of ${row.run_id} could not be read: ${words(err)}`);
          }
        }
        const read = readOf(db, row.run_id, 'files');
        if (!(read && read.sha === row.head_sha && read.data === null)) continue; // only an unknowable list falls through to the subject
      }
      const had = readOf(db, row.run_id, 'mentions');
      const stamp = /** @type {{ at: string } | undefined} */ (db.prepare("SELECT at FROM run_reads WHERE run_id = ? AND source = 'mentions'").get(row.run_id));
      if (had && stamp && at - Date.parse(stamp.at) < MENTIONS_KEEP_MS) continue;
      if (mentions >= MAX_MENTION_READS) continue;
      let refs = null;
      try { refs = JSON.parse(row.request).refs; } catch { refs = null; }
      if (!(refs?.proposal != null && (refs.pull != null || row.target != null)) && refs?.thread == null && refs?.issue == null) continue;
      mentions += 1;
      try {
        save.run(row.run_id, 'mentions', '', JSON.stringify(await subjectRefs(forge, refs, null, row.target)), iso(at));
      } catch (err) {
        log(`what ${row.run_id} is about could not be read for its nodes: ${words(err)}`);
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
    const queue = (row, event, key, actor, state, action) => { events.push({ runId: row.run_id, event, key, actor, state, ...(action ? { action } : {}) }); };
    /** The runs whose answer columns this look changed (written on their own, so a look that began before an answer was kept cannot undo it) */
    const answered = new Set();

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
    // A run asked for over push or pull is reported to over the API, with a runner token: a comment on the forge does not move it
    for (const r of cur.values()) if (r.transport === 'forge') for (const n of [r.target, r.pull]) if (n != null) places.set(n, (places.get(n) ?? new Set()).add(r.run_id));
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
        // A report: a runner (agents.runners) or a maintainer. A stop request and an answer: a maintainer. A request is not ours to follow
        return block.type === 'report' ? who.runner || who.maintainer : block.type === 'stop-request' || block.type === 'answer' ? who.maintainer : false;
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
        if (!judge(row, b.comment.id, key, b.by, b.type, { ...(b.value.state ? { state: b.value.state } : {}) }, { accepted: true })) continue;
        heard.push({ row, id: b.comment.id, key, at: b.at, by: b.by, block: b });
      }
      for (const b of found.ignored) {
        const row = cur.get(b.runId);
        if (!row || !ids.has(b.runId) || b.type === 'request') continue;
        const key = keyOf(b.comment.id, b.runId, b.type);
        const reason = b.why === 'edited' ? 'edited after it was posted, so it is not believed'
          : b.type === 'report' ? 'not from a runner (agents.runners) or a maintainer' : `${b.type === 'answer' ? 'an answer' : 'a stop request'} is believed only from a maintainer`;
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
        // A new wait is a new question: the answer to the last one is not its answer
        if (r.state === 'waiting' && previous !== 'waiting') {
          Object.assign(row, { answer_action: null, answer_text: null, answer_at: null, answer_by: null });
          answered.add(row.run_id);
        }
        touch(row, when);
        out.reports += 1;
        cause.set(row.run_id, key);
        happen(row, { key: `report:${key}`, at: when, kind: r.state === 'claimed' ? 'claimed' : 'report', actor: login, ref: r.state, note: r.note ?? null, url: r.url ?? null });
        if (r.state === 'claimed') queue(row, 'run.claimed', 'ev:claimed', login, 'claimed');
        if (r.state !== previous) queue(row, 'run.state', `ev:state:${id}:${key}`, login, r.state);
        if (r.state === 'waiting' && previous !== 'waiting') queue(row, 'run.waiting', `ev:waiting:${id}:${key}`, login, 'waiting');
      } else if (block.type === 'answer') {
        // An answer to a run that is not waiting answers nothing (the runner went on, or it asked nothing), nor does one after a stop request: it is kept in the audit only
        if (row.state !== 'waiting' || (row.stop_requested_at && block.value.action !== 'stop')) continue;
        const a = block.value;
        Object.assign(row, { answer_action: a.action, answer_text: a.text ?? null, answer_at: when, answer_by: login });
        answered.add(row.run_id);
        if (a.action === 'stop' && !row.stop_requested_at) Object.assign(row, { stop_requested_at: when, stop_requested_by: login });
        touch(row, when);
        happen(row, { key: `answer:${id}`, at: when, kind: 'answered', actor: login, ref: a.action, note: a.text ?? null });
        queue(row, 'run.answered', `ev:answered:${id}:${key}`, login, 'waiting', a.action);
        if (a.action === 'stop') queue(row, 'run.stopRequested', `ev:stop:${id}:${key}`, login, 'stop-requested');
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
      if (now2.finished && !FINISHED.includes(before.get(row.run_id) ?? '')) queue(row, 'run.finished', `ev:finished:${cause.get(row.run_id) ?? now2.status}`, actorText(row.reported_by) ?? row.pull_by, now2.status);
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
        if (answered.has(id)) db.prepare('UPDATE runs SET answer_action = ?, answer_text = ?, answer_at = ?, answer_by = ? WHERE run_id = ?').run(r.answer_action, r.answer_text, r.answer_at, r.answer_by, id);
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
      hooks?.emit(e.event, { ...runPayload(row, e.actor), state: e.state, ...(e.action ? { action: e.action } : {}) });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  //  Runners: pull and push (a runner token, server/runner-api.js; spec 0005 D2, D5)
  // -------------------------------------------------------------------------

  /** @typedef {{ id: number, label: string, mintedBy?: { login: string, userId: string } }} RunnerToken the runner token a call came with */

  const runnerActor = (token) => `runner:${token.label}`;
  /** What a runner's act writes into the timeline: the runner, with the maintainer who minted the token kept in `mintedBy` */
  const runnerText = (token) => byToText(runnerBy(token));

  /** A run for a runner: the state it is in as cornfield derives it, whether a maintainer asked it to stop, and the answer to its wait if there is one. Nothing else about the run, no credential */
  function runnerView(row) {
    const st = statusOf(row, now(), quietMs);
    return { runId: row.run_id, state: st.status, reported: row.state === 'requested' ? null : row.state, stopRequested: row.stop_requested_at != null, ...(row.stop_requested_at ? { stopRequestedAt: row.stop_requested_at } : {}), ...(row.answer_at ? { answer: answerOf(row) } : {}), open: st.open, finished: st.finished };
  }

  /** The run a runner token names, or a `Refused`: 404 when there is none, 403 when the token may not touch it */
  function runnerRun(db, token, runId) {
    const row = typeof runId === 'string' ? /** @type {RunRow | undefined} */ (db.prepare(`SELECT * FROM runs WHERE run_id = ? AND repo = ? AND ${POSTED}`).get(runId, repo)) : undefined;
    if (!row) throw new Refused(404, 'cornfield has no such run.', 'not-found');
    if (row.transport === 'forge') throw new Refused(403, 'This run was asked for on the forge, not over push or pull. A runner token does not reach it: report it as a cornfield-run comment.', 'forbidden');
    if (row.transport === 'pull' && row.claimed_by == null) throw new Refused(403, 'Nobody has claimed this run. Claim it first: POST /api/agent-requests/<runId>/claim.', 'forbidden');
    if (row.claimed_by != null && row.claimed_by !== token.id) throw new Refused(403, 'Another runner token holds this run. Only the token that claimed it (for a pushed run, the first to report on it) reads and reports on it.', 'forbidden');
    return row;
  }

  /**
   * The requests waiting for a runner to claim: pull runs nobody has claimed, not asked to stop, not quiet, oldest first, at most `QUEUE_LIMIT`.
   * Each is the contract's request as it was made, checked once more on the way out.
   */
  async function queued() {
    const db = await auth.store();
    const at = now();
    const rows = /** @type {RunRow[]} */ (db.prepare("SELECT * FROM runs WHERE repo = ? AND transport = 'pull' AND state = 'requested' AND claimed_by IS NULL AND stop_requested_at IS NULL AND last_activity > ? ORDER BY requested_at, run_id LIMIT ?")
      .all(repo, iso(at - quietMs), QUEUE_LIMIT));
    return rows.flatMap((r) => {
      const checked = validateRequest(safeJson(r.request));
      if (!checked.ok) { log(`the request ${r.run_id} is not a valid request any more and is not offered: ${checked.error}`); return []; }
      return [checked.value];
    });
  }

  const safeJson = (text) => { try { return JSON.parse(text); } catch { return null; } };

  /**
   * Claims a queued request for a runner token. ONE statement decides who wins (`UPDATE … WHERE claimed_by IS NULL`), so two claims at once
   * cannot both succeed: the second is a 409. Answers the request and the run as the runner sees it.
   * @param {RunnerToken} token
   * @param {unknown} runId
   */
  async function claim(token, runId) {
    const db = await auth.store();
    const at = now();
    const stamp = iso(at);
    const won = typeof runId === 'string' ? db.prepare(`UPDATE runs SET claimed_by = ?, claimed_at = ?, state = 'claimed', reported_at = ?, reported_by = ?, note = NULL, last_activity = MAX(last_activity, ?)
      WHERE run_id = ? AND repo = ? AND transport = 'pull' AND state = 'requested' AND claimed_by IS NULL AND stop_requested_at IS NULL AND last_activity > ?`)
      .run(token.id, stamp, stamp, runnerText(token), stamp, runId, repo, iso(at - quietMs)).changes === 1 : false;
    const row = typeof runId === 'string' ? /** @type {RunRow | undefined} */ (db.prepare('SELECT * FROM runs WHERE run_id = ? AND repo = ?').get(runId, repo)) : undefined;
    if (!row) throw new Refused(404, 'cornfield has no such request.', 'not-found');
    if (!won) {
      if (row.transport !== 'pull') throw new Refused(409, `This request goes over ${row.transport === 'push' ? 'push (an agent.requested hook event), not pull' : 'the forge, not pull'}; there is nothing to claim.`, 'conflict');
      if (row.claimed_by != null) throw new Refused(409, 'Another runner claimed this request first.', 'already-claimed');
      if (row.stop_requested_at) throw new Refused(409, 'A maintainer asked to stop this run before anyone claimed it.', 'conflict');
      if (statusOf(row, at, quietMs).quiet) throw new Refused(409, 'This request has waited past agents.quietAfter and is no longer offered.', 'conflict');
      throw new Refused(409, `This request is ${row.state}; there is nothing to claim.`, 'conflict');
    }
    keepEvent(db, row.run_id, { key: `claim:${token.id}:${stamp}`, at: stamp, kind: 'claimed', actor: runnerText(token), ref: 'claimed' });
    const checked = validateRequest(safeJson(row.request));
    hooks?.emit('run.claimed', { ...runPayload(row, runnerActor(token)), state: 'claimed' });
    hooks?.emit('run.state', { ...runPayload(row, runnerActor(token)), state: 'claimed' });
    return { request: checked.ok ? checked.value : null, run: runnerView(row), row };
  }

  /** One run as the runner that holds it sees it: `GET /api/runs/<runId>`, how a runner learns it was asked to stop, or answered */
  async function runnerGet(token, runId) {
    const db = await auth.store();
    return runnerView(runnerRun(db, token, runId));
  }

  /**
   * A runner's report: the contract's report JSON, from the token that holds the run (the one that claimed it; for a pushed run, the first to
   * report). The same run state and hooks as a report on the forge. A run that is over takes no more.
   * @param {RunnerToken} token
   * @param {unknown} runId
   * @param {unknown} body
   */
  async function report(token, runId, body) {
    const db = await auth.store();
    const row = runnerRun(db, token, runId);
    const checked = validateReport(body);
    if (!checked.ok) throw new Refused(400, checked.error, 'invalid');
    const r = checked.value;
    const at = now();
    const was = statusOf(row, at, quietMs);
    if (was.finished) throw new Refused(409, `Run ${row.run_id} is ${was.status}; it takes no more reports.`, 'conflict');
    const stamp = iso(at);
    // A new wait is a new question: the answer to the last one goes (a repeat of `waiting` while waiting keeps it)
    const newWait = r.state === 'waiting' && row.state !== 'waiting';
    const changed = db.prepare(`UPDATE runs SET state = ?, reported_at = ?, reported_by = ?, note = ?, url = ?, tokens = COALESCE(?, tokens), cost = COALESCE(?, cost),
      claimed_by = COALESCE(claimed_by, ?), claimed_at = COALESCE(claimed_at, ?), last_activity = MAX(last_activity, ?),
      answer_action = CASE WHEN ? THEN NULL ELSE answer_action END, answer_text = CASE WHEN ? THEN NULL ELSE answer_text END,
      answer_at = CASE WHEN ? THEN NULL ELSE answer_at END, answer_by = CASE WHEN ? THEN NULL ELSE answer_by END
      WHERE run_id = ? AND (claimed_by IS NULL OR claimed_by = ?) AND state NOT IN ('done', 'failed', 'stopped')`)
      .run(r.state, stamp, runnerText(token), r.note ?? null, r.url ?? null, r.tokens ?? null, r.cost ?? null, token.id, stamp, stamp, +newWait, +newWait, +newWait, +newWait, row.run_id, token.id).changes;
    if (changed !== 1) throw new Refused(409, `Run ${row.run_id} changed while the report was being taken; read it again (GET /api/runs/${row.run_id}).`, 'conflict');
    const after = /** @type {RunRow} */ (db.prepare('SELECT * FROM runs WHERE run_id = ?').get(row.run_id));
    // A report of `claimed` on a run the claim route already claimed is a report, not a second "Claimed" line
    keepEvent(db, row.run_id, { key: `report:runner:${token.id}:${stamp}:${r.state}`, at: stamp, kind: r.state === 'claimed' && row.state !== 'claimed' ? 'claimed' : 'report', actor: runnerText(token), ref: r.state, note: r.note ?? null, url: r.url ?? null });
    const actor = runnerActor(token);
    if (r.state === 'claimed' && row.state !== 'claimed') hooks?.emit('run.claimed', { ...runPayload(after, actor), state: r.state });
    if (r.state !== row.state) hooks?.emit('run.state', { ...runPayload(after, actor), state: r.state });
    if (newWait) hooks?.emit('run.waiting', { ...runPayload(after, actor), state: r.state });
    if (REPORT_FINISHED.includes(r.state)) hooks?.emit('run.finished', { ...runPayload(after, actor), state: r.state });
    return { run: runnerView(after), row: after, was: row };
  }

  /** Drops what a crash left: a request that was never posted. Run once at start. */
  async function resume() {
    const db = await auth.store();
    const gone = db.prepare("DELETE FROM runs WHERE comment_id = '' AND transport = 'forge' AND requested_at < ?").run(iso(now() - RESERVATION_MS)).changes;
    if (gone) log(`${gone} request${gone === 1 ? '' : 's'} that never reached the forge ${gone === 1 ? 'was' : 'were'} dropped`);
  }

  /**
   * The open run on a subject, under any profile, or null: one whose request was posted on `number` (its target), or that is about the
   * same issue, thread or proposal as `refs`. Open as the cap counts it (not finished, not quiet). An opt-in trigger asks before it requests
   * (server/triggers.js), so a maintainer's act on a target whose run is still going is skipped with `run-open`, whatever the profile.
   * @param {{ number?: number, refs?: { issue?: number, thread?: number, proposal?: string } }} about
   * @returns {Promise<string | null>} the run id
   */
  async function openOn({ number, refs = {} }) {
    const db = await auth.store();
    const mine = subjectKeys(refs);
    const hit = openRows(db, now()).find((r) => (Number.isInteger(number) && (r.target === number || r.issue === number || r.thread === number))
      || subjectKeys({ issue: r.issue ?? undefined, thread: r.thread ?? undefined, proposal: r.proposal ?? undefined }).some((k) => mine.includes(k)));
    return hit ? hit.run_id : null;
  }

  return { request, stop, answer, list, get, follow, discover, discovers, hasWork, resume, queued, claim, runnerGet, report, openOn, maxOpen: cap, profiles, transport };
}

/** @typedef {ReturnType<typeof createRuns>} Runs */
