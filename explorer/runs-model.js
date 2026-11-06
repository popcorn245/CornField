/**
 * @module explorer/runs-model
 *
 * Agent runs in the issues and PRs panel, the pure half (issue #80, spec 0005): no DOM, no `window`, no clock. It words what the server
 * (server/agent-runs.js, server/agent-api.js) answers, and makes the body of a start. cornfield only asks: a run is a request on the
 * forge, the runner does the work, and these words say so.
 */

import { relativeTime } from './review-model.js';

export const RUNS_URL = '/api/agent-runs';
export const runsUrl = (follow) => (follow ? `${RUNS_URL}?follow=1` : RUNS_URL);
export const stopUrl = (runId) => `${RUNS_URL}/${encodeURIComponent(runId)}/stop`;

/** The kinds of run (the contract's), and what each asks the runner for */
export const KINDS = Object.freeze([
  ['code', 'Code: a branch and a pull request'],
  ['summary', 'Summary of the conversation'],
  ['brief', 'A brief for another run'],
  ['proposal', 'A proposal drafted from the thread'],
]);

/** What a run is about, in words: "issue #12", "proposal 0040-meals" */
export function aboutWords(refs) {
  const out = [];
  if (refs && refs.issue != null) out.push(`issue #${refs.issue}`);
  if (refs && refs.thread != null && refs.thread !== refs.issue) out.push(`thread #${refs.thread}`);
  if (refs && refs.proposal != null) out.push(`proposal ${refs.proposal}`);
  return out.join(' and ') || 'nothing';
}

/** The state of a run, said short */
export function statusWords(run) {
  const words = {
    requested: 'Requested', claimed: 'Claimed', working: 'Working', done: 'Done', failed: 'Failed', stopped: 'Stopped',
    'stop-requested': 'Stop requested', quiet: 'Quiet', merged: 'Merged', closed: 'Closed',
  };
  return words[run.status] || run.status;
}

/** Why a state is what it is, for people who ask: one line under the state */
export function statusWhy(run) {
  switch (run.status) {
    case 'quiet': return 'Nothing reported or pushed for a while, so it no longer counts toward the limit. A report or a push brings it back.';
    case 'stop-requested': return `${run.stopRequested && run.stopRequested.by ? run.stopRequested.by : 'A maintainer'} asked it to stop. The runner decides what that means; this stays until it says stopped, or the run goes quiet.`;
    case 'requested': return 'Waiting for a runner to pick it up. cornfield only asks; it starts nothing.';
    default: return '';
  }
}

/** A line of facts: who asked and when, the profile, the limits asked for beside what the runner reported */
export function runMeta(run, nowMs) {
  const parts = [`asked ${relativeTime(run.requestedAt, nowMs)} by ${run.requestedBy}`];
  if (run.profile) parts.push(`profile ${run.profile}`);
  const l = run.limits || {};
  const limits = [l.minutes != null && `${l.minutes} min`, l.turns != null && `${l.turns} turns`, l.cost != null && `cost ${l.cost}`].filter(Boolean);
  if (limits.length) parts.push(`limits ${limits.join(', ')}`);
  const r = run.report;
  if (r) {
    const said = [r.tokens != null && `${r.tokens} tokens`, r.cost != null && `cost ${r.cost}`].filter(Boolean);
    if (said.length) parts.push(`reported ${said.join(', ')}`);
  }
  if (run.checks && run.checks !== 'none') parts.push(`checks ${run.checks === 'success' ? 'passing' : run.checks === 'failure' ? 'failing' : 'running'}`);
  return parts.join(' · ');
}

/**
 * The notice over the runs when an opt-in trigger (`agents.on`) did nothing in the last day, from the audit rows the server counted
 * (`triggerSkipped`: { count, reasons }), or '' when none did. No live sign-in is the case the person can mend, so it says how.
 */
export function triggerNotice(data) {
  const n = data && data.triggerSkipped;
  if (!n || !(n.count > 0)) return '';
  const reasons = n.reasons || {};
  const out = [];
  if (reasons['no-session']) out.push('A trigger was skipped: sign in to let triggers request runs.');
  const refused = Object.entries(reasons).filter(([why]) => why !== 'no-session');
  if (refused.length) {
    const count = refused.reduce((sum, [, c]) => sum + c, 0);
    out.push(`${count} ${count === 1 ? 'trigger was' : 'triggers were'} refused in the last day (${refused.map(([why, c]) => `${why} ${c}`).join(', ')}), so nothing was asked.`);
  }
  return out.join(' ');
}

/** Whether a Stop is offered: the run is open and nobody has asked it to stop yet */
export const canStop = (run) => run.open === true && !run.stopRequested;

/** The summary line over the list: "2 open of 3 allowed, 5 runs" */
export function runsStatus(data) {
  const n = data.runs.length;
  return `${data.open} open of ${data.maxOpen} allowed, ${n} ${n === 1 ? 'run' : 'runs'}`;
}

/** "20 s", "5 min", "2 h": how long ago, short enough for a line */
function agoShort(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

/**
 * Whether a runner is there, from the runs listing's `runnerPresence` (issue #99): 'online', 'offline' (it polled once, not lately), 'none' (no
 * live runner token has polled), or null where it does not apply (not the pull transport). Worked out against `nowMs`, so it ages on the page.
 */
export function runnerState(presence, nowMs) {
  if (!presence || presence.transport !== 'pull') return null;
  const seen = typeof presence.lastSeen === 'string' ? Date.parse(presence.lastSeen) : NaN;
  if (!Number.isFinite(seen)) return 'none';
  return nowMs - seen < (presence.quietAfterMs || 180_000) ? 'online' : 'offline';
}

/** The one line: "Runner online · last seen 20 s ago", or "No runner has polled for 5 min: a queued run will wait"; '' where it does not apply */
export function runnerWords(presence, nowMs) {
  const state = runnerState(presence, nowMs);
  if (state === 'online') return `Runner online · last seen ${agoShort(nowMs - Date.parse(presence.lastSeen))} ago`;
  if (state === 'offline') return `No runner has polled for ${agoShort(nowMs - Date.parse(presence.lastSeen))}: a queued run will wait`;
  if (state === 'none') return 'No runner has polled yet: a queued run will wait';
  return '';
}

/**
 * The body of a start. Only what the person chose; the server writes the run id, the time and who asked, and checks the rest.
 * @param {{ kind: string, profile?: string, brief?: string, refs: object, force?: boolean }} input
 */
export function startBody({ kind, profile, brief, refs, force }) {
  const out = { kind, refs, brief: (brief || '').trim() };
  if (profile) out.profile = profile;
  if (force) out.force = true;
  return out;
}

/** What a start came to, in words */
export function startWords(status, body) {
  if (status === null) return 'cornfield did not answer; nothing was asked.';
  if (status === 401) return 'Your sign-in has ended. Sign in again to start an agent.';
  if (body && body.ok) return `Asked. The request is posted on the forge as run ${body.request.runId}; a runner picks it up from there.`;
  return (body && body.error) || `The request was refused (${status}).`;
}

/** What a stop came to */
export function stopWords(status, body, runId) {
  if (status === null) return 'cornfield did not answer; nothing was asked.';
  if (status === 401) return 'Your sign-in has ended. Sign in again to stop a run.';
  if (body && body.ok) return `Asked ${runId} to stop. The runner decides what that means.`;
  return (body && body.error) || `The stop was refused (${status}).`;
}

/** What the dialog tells the person before they confirm: where the request goes and what it does and does not do */
export function confirmStartWords(refs, forgeName) {
  const where = refs.proposal != null ? `the spec pull request of proposal ${refs.proposal}` : refs.thread != null ? `thread #${refs.thread}` : `issue #${refs.issue}`;
  return `This posts a request as a comment on ${where} on ${forgeName}, as you. Your runner picks it up. cornfield starts nothing and sends no credentials.`;
}

// ---------------------------------------------------------------------------
//  Runs on the map (issue #82): the Runs view, the compare, the timeline, and what the map shows
// ---------------------------------------------------------------------------

/** Runs asked for within this long of each other, on the same subject, kind and brief, are one request under different profiles */
export const COMPARE_WINDOW_MS = 3 * 60_000;

const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const listWords = (items) => (items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** The subject of a run as a key: the same issue, thread and proposal */
const subjectKey = (refs) => JSON.stringify([refs?.issue ?? null, refs?.thread ?? null, refs?.proposal ?? null]);

/**
 * The runs for the view, newest first: a run on its own, or a **compare**: the same request (same subject, kind and brief) asked for under
 * different profiles within `COMPARE_WINDOW_MS`, shown side by side. A group sits where its newest run is; inside it the runs are in profile order.
 * @param {object[]} runs as the API lists them (newest first)
 * @returns {({ kind: 'run', run: object } | { kind: 'compare', key: string, runs: object[] })[]}
 */
export function groupRuns(runs) {
  const clusters = [];
  const byKey = new Map();
  for (const run of runs) {
    const key = `${subjectKey(run.refs)}|${run.kind}|${typeof run.brief === 'string' ? run.brief : ''}`;
    const at = Date.parse(run.requestedAt);
    const open = byKey.get(key) ?? [];
    // Newest first: a run joins the cluster its time is within the window of, if that cluster has not got its profile yet
    const home = open.find((c) => Math.abs(c.newest - at) <= COMPARE_WINDOW_MS && !c.runs.some((r) => (r.profile ?? '') === (run.profile ?? '')));
    if (home) { home.runs.push(run); continue; }
    const fresh = { key, newest: at, runs: [run], first: clusters.length };
    open.push(fresh);
    byKey.set(key, open);
    clusters.push(fresh);
  }
  return clusters.map((c) => (c.runs.length > 1
    ? { kind: 'compare', key: c.runs.map((r) => r.runId).join('+'), runs: [...c.runs].sort((a, b) => String(a.profile ?? '').localeCompare(String(b.profile ?? ''))) }
    : { kind: 'run', run: c.runs[0] }));
}

/** What the group is titled: "Code on issue #7 under 2 profiles: claude and qwen" */
export function compareTitle(runs) {
  const first = runs[0];
  const kind = (KINDS.find(([k]) => k === first.kind) || [first.kind, first.kind])[1].split(':')[0];
  return `${kind} on ${aboutWords(first.refs)} under ${plural(runs.length, 'profile')}: ${listWords(runs.map((r) => r.profile || 'no profile'))}`;
}

/** Limits beside what the runner reported: a row for each of minutes, turns, cost and tokens that has either, in words (never a bare dash) */
export function limitRows(run) {
  const l = run.limits || {};
  const r = run.report || {};
  const rows = [];
  const add = (name, limit, reported) => {
    if (limit == null && reported == null) return;
    rows.push({ name, limit: limit == null ? 'no limit asked' : String(limit), reported: reported == null ? 'not reported' : String(reported) });
  };
  add('Minutes', l.minutes, null);
  add('Turns', l.turns, null);
  add('Cost', l.cost, r.cost);
  add('Tokens', null, r.tokens);
  return rows;
}

/** The checks of a run's pull request, said short */
export function checksWords(run) {
  if (!run.pull) return 'No pull request yet, so no checks.';
  return { success: 'Checks passing', failure: 'Checks failing', running: 'Checks running', none: 'The pull request has no checks' }[run.checks] || 'Checks not read yet';
}

/** One line of a run's timeline, and the runner's words under it (data for the page to escape) */
export function timelineWords(entry) {
  const by = entry.actor ? ` by ${entry.actor}` : '';
  switch (entry.kind) {
    case 'requested': return { what: `Requested${by}${entry.ref ? ` under the profile ${entry.ref}` : ''}`, note: '' };
    case 'claimed': return { what: `Claimed${by}`, note: entry.note || '' };
    case 'report': return { what: `Reported ${entry.ref || 'in'}${by}`, note: entry.note || '' };
    // When cornfield saw it, not when it was pushed: the forge does not say
    case 'push': return { what: `Push seen: ${String(entry.ref || '').slice(0, 7)}${entry.note ? ` on ${entry.note}` : ''}`, note: '' };
    case 'pull-opened': return { what: `Opened pull request ${entry.ref || ''}${by}`.trim(), note: '' };
    case 'checks': return { what: { success: 'Checks passed', failure: 'Checks failed', running: 'Checks running', none: 'No checks' }[entry.ref] || 'Checks changed', note: '' };
    case 'stop-requested': return { what: `Asked to stop${by}`, note: entry.note || '' };
    case 'merged': return { what: `Landed: pull request ${entry.ref || ''} merged`, note: '' };
    case 'closed': return { what: `Pull request ${entry.ref || ''} closed without landing`, note: '' };
    case 'quiet': return { what: 'Went quiet: nothing reported or pushed for a while', note: '' };
    default: return { what: entry.kind, note: entry.note || '' };
  }
}

/** The ids of the nodes a run names, as the names the map shows (an id the map lacks is shown as it is) */
export function nodeLabels(ids, nodes) {
  const byId = new Map((nodes || []).map((n) => [n.id, n.label || n.id]));
  return (ids || []).map((id) => byId.get(id) || id);
}

/**
 * What the map shows of the runs: the nodes of the open runs (in flight), and those two or more open runs share (collisions). A run that
 * is finished or quiet marks nothing.
 * @param {object[]} runs
 * @returns {{ flight: Map<string, string[]>, collide: Map<string, string[]> }} node id to the ids of the open runs that name it
 */
export function overlayOf(runs) {
  const flight = new Map();
  for (const run of runs || []) {
    if (!run.open) continue;
    for (const id of run.nodes || []) flight.set(id, [...(flight.get(id) || []), run.runId]);
  }
  const collide = new Map([...flight].filter(([, ids]) => ids.length > 1));
  return { flight, collide };
}

/** What a run lights when it is selected, like a pull request: its nodes, whatever its state */
export const litOfRun = (run) => ({ changed: new Set(run ? run.nodes || [] : []), failing: new Set() });

/** The collision of a run in words: "Collides with run-… on orders and cart" (null when it does not) */
export function collisionWords(run, runs, nodes) {
  const others = (run.collidesWith || []);
  if (!run.open || !others.length) return null;
  const mine = new Set(run.nodes || []);
  const shared = [...new Set(others.flatMap((id) => ((runs.find((r) => r.runId === id) || {}).nodes || []).filter((n) => mine.has(n))))];
  return `Collides with ${listWords(others)}${shared.length ? ` on ${listWords(nodeLabels(shared, nodes))}` : ''}`;
}

/**
 * What changed between two answers, as sentences for the live region: a run that appeared, a new state, a collision begun or cleared.
 * Nothing before the first answer (`before` is null): the page does not read its whole list out on load.
 * @param {object[] | null} before
 * @param {object[]} after
 * @returns {string[]}
 */
export function changeWords(before, after) {
  if (!before) return [];
  const was = new Map(before.map((r) => [r.runId, r]));
  const out = [];
  for (const run of after) {
    const old = was.get(run.runId);
    if (!old) { out.push(`New run ${run.runId}: ${run.kind} on ${aboutWords(run.refs)}, ${statusWords(run).toLowerCase()}`); continue; }
    if (old.status !== run.status) out.push(`Run ${run.runId} is now ${statusWords(run).toLowerCase()}`);
    const was2 = new Set(old.open ? old.collidesWith || [] : []);
    const now2 = new Set(run.open ? run.collidesWith || [] : []);
    const added = [...now2].filter((id) => !was2.has(id));
    const gone = [...was2].filter((id) => !now2.has(id));
    if (added.length) out.push(`Run ${run.runId} now collides with ${listWords(added)}`);
    if (gone.length && !now2.size) out.push(`Run ${run.runId} no longer collides`);
  }
  return out;
}
