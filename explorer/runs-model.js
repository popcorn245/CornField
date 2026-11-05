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
