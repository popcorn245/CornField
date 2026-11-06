/**
 * @module explorer/runs-view
 *
 * The markup of the Runs view in the Agents tab (issue #82), as strings: each run's state as a word, its profile, its limits beside what
 * the runner reported, its thread, branch, pull request and checks, the nodes it changes and any collision, a timeline in order, and the
 * runner's own `url` as "Runner's log" (cornfield streams no log). Runs of one request under different profiles are a **compare**: side by
 * side on a wide panel, stacked on a narrow one. Pure: no DOM, no clock; the panel hands in what it knows and paints the string.
 * Every word from a runner or the forge is escaped.
 */

import { relativeTime } from './review-model.js';
import { aboutWords, statusWords, statusWhy, runMeta, canStop, canAnswer, groupRuns, compareTitle, limitRows, checksWords, timelineWords, nodeLabels, collisionWords, answerWords } from './runs-model.js';

const TONE = { done: 'success', merged: 'success', failed: 'failure', quiet: 'queued', 'stop-requested': 'queued', waiting: 'queued' };

/**
 * @typedef {object} ViewContext
 * @property {(s: unknown) => string} esc HTML escaping
 * @property {(u: unknown) => string | null} safeUrl an http(s) address, or null
 * @property {string} forgeName "GitHub"
 * @property {string | null} repoUrl the repo's address on the forge ("https://github.com/owner/name"), or null
 * @property {string} forgeType 'github' | 'forgejo'
 * @property {number} now
 * @property {{ id: string, label?: string }[]} nodes the map's nodes, for names
 * @property {string | null} selected the run lit on the map
 * @property {Set<string>} timelines the runs whose timeline is open
 * @property {boolean} busy an action is in flight
 * @property {Map<string, string>} [replies] the reply typed so far for each waiting run, so a repaint keeps it
 */

/** A link that opens a new tab, said so for a screen reader */
const link = (ctx, href, text, after = '') => (ctx.safeUrl(href) ? `<a class="hx-link" href="${ctx.esc(href)}" target="_blank" rel="noreferrer">${ctx.esc(text)} <span class="hx-sr-only">(new tab)</span></a>${after}` : '');

/** The address of a branch on the forge, or null */
function branchUrl(ctx, branch) {
  if (!ctx.repoUrl || !branch) return null;
  const at = branch.split('/').map(encodeURIComponent).join('/');
  return ctx.forgeType === 'forgejo' ? `${ctx.repoUrl}/src/branch/${at}` : `${ctx.repoUrl}/tree/${at}`;
}

/** The links of a run: the request, its thread, its branch, its pull request, and the runner's log (the runner's own `url`; nothing is streamed here) */
function linksHtml(ctx, run) {
  const thread = run.refs.thread ?? run.refs.issue;
  return [
    link(ctx, run.comment && run.comment.url, `Request on ${ctx.forgeName}`),
    thread != null && ctx.repoUrl ? link(ctx, `${ctx.repoUrl}/issues/${thread}`, `Thread #${thread}`) : '',
    run.branch ? link(ctx, branchUrl(ctx, run.branch), `Branch ${run.branch}`) : '',
    run.pull ? link(ctx, run.pull.url, `Pull request #${run.pull.number}`, run.pull.trusted ? '' : ' <span class="hx-faint">(not from a runner, so it moves nothing)</span>') : '',
    link(ctx, run.report && run.report.url, run.status === 'waiting' ? 'Runner\'s link' : 'Runner\'s log'),
  ].filter(Boolean).join(' · ');
}

function timelineHtml(ctx, run) {
  const items = (run.timeline || []).map((e) => {
    const w = timelineWords(e);
    return `<li><time datetime="${ctx.esc(e.at)}" title="${ctx.esc(e.at)}">${ctx.esc(relativeTime(e.at, ctx.now) || e.at)}</time>${ctx.esc(w.what)}${w.note ? `<span class="hx-run-note">${ctx.esc(w.note)}</span>` : ''}</li>`;
  });
  return `<ol class="hx-run-timeline" id="run-tl-${ctx.esc(run.runId)}" aria-label="Timeline of ${ctx.esc(run.runId)}, oldest first">${items.join('')}</ol>`;
}

/** What was answered, escaped: the action, a reply's words, who and when */
function answeredHtml(ctx, run) {
  const a = run.answer;
  return `<p class="hx-forge-meta">Answered: ${ctx.esc(answerWords(a))} · ${ctx.esc(a.by || 'a maintainer')}, ${ctx.esc(relativeTime(a.at, ctx.now) || a.at)}</p>`;
}

/** A waiting run: what was asked (the note and link are shown above) and the three answers, plain buttons and a reply field */
function answerHtml(ctx, run) {
  const id = ctx.esc(run.runId);
  const off = ctx.busy ? ' disabled' : '';
  const reply = ctx.replies && ctx.replies.get(run.runId) || '';
  return `${run.answer ? answeredHtml(ctx, run) : ''}<div class="hx-run-actions" role="group" aria-label="Answer run ${id}">
      <button type="button" class="hx-btn hx-forge-act" data-run-answer="continue" data-run-id="${id}" aria-label="Continue run ${id}"${off}>Continue</button>
      <button type="button" class="hx-btn hx-forge-act" data-run-answer="stop" data-run-id="${id}" aria-label="Stop run ${id}"${off}>Stop</button></div>
    <label class="hx-forge-field">Reply to run ${id}<input type="text" class="hx-forge-input" data-run-reply="${id}" value="${ctx.esc(reply)}" maxlength="4000" autocomplete="off" /></label>
    <div class="hx-run-actions"><button type="button" class="hx-btn hx-forge-act" data-run-answer="reply" data-run-id="${id}" aria-label="Send reply to run ${id}"${off}>Reply</button></div>`;
}

/** One run */
export function runHtml(ctx, run, all) {
  const lit = ctx.selected === run.runId;
  const open = ctx.timelines.has(run.runId);
  const tone = TONE[run.status] || 'running';
  const why = statusWhy(run);
  const note = run.report && run.report.note ? `<p class="hx-forge-meta">Runner: ${ctx.esc(run.report.note)}</p>` : '';
  const answering = canAnswer(run);
  const stop = canStop(run) && !answering ? `<button type="button" class="hx-btn hx-forge-act" data-forge-stop="${ctx.esc(run.runId)}" aria-label="Stop run ${ctx.esc(run.runId)}"${ctx.busy ? ' disabled' : ''}>Stop</button>` : '';
  const names = nodeLabels(run.nodes, ctx.nodes);
  const collision = collisionWords(run, all, ctx.nodes);
  const limits = limitRows(run);
  const count = (run.timeline || []).length;
  const links = linksHtml(ctx, run);
  return `<li class="hx-run hx-forge-file" data-run="${ctx.esc(run.runId)}">
    <div class="hx-run-head"><span class="hx-forge-state hx-forge-state--${tone}">${ctx.esc(statusWords(run))}</span> <span class="hx-name">${ctx.esc(run.kind)} on ${ctx.esc(aboutWords(run.refs))}</span>${run.profile ? ` <span class="hx-faint">profile ${ctx.esc(run.profile)}</span>` : ''}</div>
    ${collision ? `<p class="hx-run-collide"><span aria-hidden="true">⚠</span> ${ctx.esc(collision)}</p>` : ''}
    <p class="hx-forge-meta">${ctx.esc(runMeta(run, ctx.now))}</p>${why ? `<p class="hx-forge-why hx-faint">${ctx.esc(why)}</p>` : ''}${note}
    <dl class="hx-run-limits" aria-label="Limits and what the runner reported">${limits.length ? limits.map((r) => `<dt>${ctx.esc(r.name)}</dt><dd>limit: ${ctx.esc(r.limit)}; reported: ${ctx.esc(r.reported)}</dd>`).join('') : '<dt>Limits</dt><dd>none asked, nothing reported</dd>'}</dl>
    <p class="hx-forge-meta">${ctx.esc(checksWords(run))}</p>
    <p class="hx-forge-meta">${names.length ? `Changing ${run.nodesFrom === 'files' ? '' : 'or expected to change '}${ctx.esc(names.join(', '))}` : 'No node on the map yet.'}</p>
    ${links ? `<p class="hx-forge-meta">${links}</p>` : ''}
    ${answering ? answerHtml(ctx, run) : ''}${run.answer && !answering ? answeredHtml(ctx, run) : ''}
    <div class="hx-run-actions">${stop}
      <button type="button" class="hx-btn hx-forge-act" data-run-select="${ctx.esc(run.runId)}" aria-pressed="${lit}" aria-label="Light the nodes of ${ctx.esc(run.runId)} on the map"${(run.nodes || []).length ? '' : ' disabled'}>${lit ? 'Lit on the map' : 'Light on the map'}</button>
      <button type="button" class="hx-btn hx-forge-act" data-run-timeline="${ctx.esc(run.runId)}" aria-expanded="${open}" aria-controls="run-tl-${ctx.esc(run.runId)}">Timeline (${count})</button></div>
    ${open ? timelineHtml(ctx, run) : ''}</li>`;
}

/**
 * The list: runs on their own and compares, as the items of the list.
 * @param {ViewContext} ctx
 * @param {object[]} runs
 */
export function runsHtml(ctx, runs) {
  return groupRuns(runs).map((g) => {
    if (g.kind === 'run') return runHtml(ctx, g.run, runs);
    const id = `cmp-${g.runs[0].runId}`;
    return `<li class="hx-run-group"><section class="hx-run-compare" aria-labelledby="${ctx.esc(id)}">
      <h4 class="hx-run-compare-title" id="${ctx.esc(id)}">${ctx.esc(compareTitle(g.runs))}</h4>
      <p class="hx-forge-meta hx-faint">The same request under each profile, side by side.</p>
      <ul class="hx-run-columns" aria-label="${ctx.esc(g.runs.length)} profiles compared">${g.runs.map((r) => runHtml(ctx, r, runs)).join('')}</ul></section></li>`;
  }).join('');
}
