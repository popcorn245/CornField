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
import { runTone, canRetry, aboutWords, runName, statusWords, statusWhy, runMeta, canStop, canAnswer, groupRuns, compareTitle, limitRows, checksWords, timelineWords, nodeLabels, collisionWords, answerWords } from './runs-model.js';
import { cornState, cornStateAttr, stateIconHtml } from './corn-state.js';
import { t } from './strings.js';


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
 * @property {Map<string, { text: string, ok: boolean }>} [results] what the last action on each run came to, shown in its card by the control that was used
 */

/** A link that opens a new tab, said so for a screen reader */
const link = (ctx, href, text, after = '') => (ctx.safeUrl(href) ? `<a data-corn="text-link" class="hx-link" href="${ctx.esc(href)}" target="_blank" rel="noreferrer">${ctx.esc(text)} <span class="hx-sr-only">(new tab)</span></a>${after}` : '');

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

/** A run id that is another run of the list is a button that takes you to it; otherwise it is plain text */
function runLink(ctx, runId, all) {
  const there = (all || []).find((r) => r.runId === runId);
  return there ? `<button data-corn-kind="secondary" type="button" class="hx-btn hx-forge-act" data-run-goto="${ctx.esc(runId)}" title="Go to this run">${ctx.esc(runName(there))}</button>` : 'an earlier run';
}

/** Which run this one starts again, and which start it again */
function retryHtml(ctx, run, all) {
  const again = Array.isArray(run.retriedBy) ? run.retriedBy : [];
  if (!run.retryOf && !again.length) return '';
  return `<p class="hx-forge-meta">${run.retryOf ? `Starts again on ${runLink(ctx, run.retryOf, all)}` : ''}${run.retryOf && again.length ? ' · ' : ''}${again.length ? `Started again as ${again.map((id) => runLink(ctx, id, all)).join(', ')}` : ''}</p>`;
}

function timelineHtml(ctx, run, all) {
  const items = (run.timeline || []).map((e) => {
    const w = timelineWords(e);
    const other = (e.kind === 'retry-of' || e.kind === 'retried-by') && e.ref ? (all || []).find((r) => r.runId === e.ref) : null;
    const goto = other ? ` <button data-corn-kind="secondary" type="button" class="hx-btn hx-forge-act" data-run-goto="${ctx.esc(e.ref)}" aria-label="Go to it: ${ctx.esc(runName(other))}">Go to it</button>` : '';
    return `<li><time datetime="${ctx.esc(e.at)}" title="${ctx.esc(e.at)}">${ctx.esc(relativeTime(e.at, ctx.now) || e.at)}</time>${ctx.esc(w.what.replace(/run-[0-9A-Za-z]{26}/g, (id) => { const o = (all || []).find((r) => r.runId === id); return o ? runName(o) : 'an earlier run'; }))}${goto}${w.note ? `<span class="hx-run-note">${ctx.esc(w.note)}</span>` : ''}</li>`;
  });
  return `<ol class="hx-run-timeline" id="run-tl-${ctx.esc(run.runId)}" aria-label="Timeline of ${ctx.esc(runName(run))}, oldest first">${items.join('')}</ol>`;
}

/** What was answered, escaped: the action, a reply's words, who and when */
function answeredHtml(ctx, run) {
  const a = run.answer;
  return `<p class="hx-forge-meta">Answered: ${ctx.esc(answerWords(a))} · ${ctx.esc(a.by || 'a maintainer')}, ${ctx.esc(relativeTime(a.at, ctx.now) || a.at)}</p>`;
}


/** The run's result line: what the last action on it came to, by the control that was used; always in the card (hidden when empty) so a card kept as it is can take a new one */
function resultHtml(ctx, run) {
  const r = ctx.results && ctx.results.get(run.runId);
  return `<p class="hx-forge-result" data-run-result="${ctx.esc(run.runId)}" data-corn="result"${r ? ` data-corn-state="${r.ok ? 'success' : 'failure'}"` : ' hidden'}>${r ? ctx.esc(r.text) : ''}</p>`;
}

/** A waiting run: what was asked (the note and link are shown above) and the three answers, plain buttons and a reply field */
function answerHtml(ctx, run) {
  const id = ctx.esc(run.runId);
  const name = ctx.esc(runName(run, ctx.now));
  const off = ctx.busy ? ' disabled' : '';
  const reply = ctx.replies && ctx.replies.get(run.runId) || '';
  return `${run.answer ? answeredHtml(ctx, run) : ''}<div class="hx-run-actions" data-corn="run-actions" role="group" aria-label="Answer: ${name}">
      <button data-corn-kind="secondary" type="button" class="hx-btn hx-forge-act" data-run-answer="continue" data-run-id="${id}" aria-label="${ctx.esc(t('continueRun'))}: ${name}"${off}>${ctx.esc(t('continueRun'))}</button>
      <button type="button" class="hx-btn hx-forge-act" data-run-answer="stop" data-run-id="${id}" aria-label="${ctx.esc(t('stop'))}: ${name}"${off} data-corn-kind="danger">${ctx.esc(t('stop'))}</button></div>
    <label class="hx-forge-field" data-corn="field">Reply to ${ctx.esc(`${run.kind} on ${aboutWords(run.refs)}`)}<input data-corn="control" type="text" class="hx-forge-input" data-run-reply="${id}" value="${ctx.esc(reply)}" maxlength="4000" autocomplete="off" /></label>
    <div class="hx-run-actions" data-corn="run-actions"><button data-corn-kind="secondary" type="button" class="hx-btn hx-forge-act" data-run-answer="reply" data-run-id="${id}" aria-label="${ctx.esc(t('reply'))}: ${name}"${off}>${ctx.esc(t('reply'))}</button></div>`;
}

/**
 * A reply typed to a run that no longer waits (it went on, or was stopped, while the person typed): it was not sent, and it is not lost. The
 * field stays, with what was typed, so it can be copied, and a line says the run changed; Discard lets it go. '' when nothing was typed.
 */
function unsentHtml(ctx, run) {
  const reply = ctx.replies && ctx.replies.get(run.runId) || '';
  if (!reply) return '';
  const id = ctx.esc(run.runId);
  return `<p class="hx-forge-why" data-corn="message" data-corn-state="failure">This run is now ${ctx.esc(statusWords(run).toLowerCase())} and no longer waits for a reply, so what you typed was not sent. It is kept here to copy.</p>
    <label class="hx-forge-field" data-corn="field">Your reply, not sent<input data-corn="control" type="text" class="hx-forge-input" data-run-reply="${id}" value="${ctx.esc(reply)}" maxlength="4000" autocomplete="off" /></label>
    <div class="hx-run-actions" data-corn="run-actions"><button data-corn-kind="secondary" type="button" class="hx-btn hx-forge-act" data-run-discard="${id}" aria-label="Discard: your reply to ${ctx.esc(runName(run, ctx.now))}">Discard</button></div>`;
}

/** The totals as plain lines (see `totalsLines`), escaped; '' when there are none */
export function totalsHtml(ctx, lines) {
  return lines.map((l) => `<p class="hx-forge-meta">${ctx.esc(l)}</p>`).join('');
}

/** A run's state as a pill: an icon (a shape of its own), then the word. The waiting pill is the solid one (see the CSS), the others are outlines. */
export function runPillHtml(ctx, run, words, extra = '') {
  return `<span class="hx-forge-state hx-forge-state--${runTone(run)}" data-corn="state-pill"${cornStateAttr(run.status)}${extra}>${stateIconHtml(cornState(run.status))}${ctx.esc(words)}</span>`;
}

/** Placeholder rows while a list loads: they hold the height the list will have, so nothing jumps when the data arrives */
export function loadingRowsHtml(n = 3) {
  return Array.from({ length: n }, () => '<li class="hx-forge-skeleton" data-corn="skeleton" aria-hidden="true"><span></span><span></span></li>').join('');
}

/**
 * Placeholder lines for the runner line and the totals above the runs while they load (issue #192): each is one `hx-forge-meta` line high, as the
 * line it stands for, so the list under them does not move when the data arrives.
 */
export function loadingLinesHtml(n = 1) {
  return Array.from({ length: n }, () => '<p class="hx-forge-meta hx-forge-skeleton-line" data-corn="skeleton" aria-hidden="true"><span></span></p>').join('');
}

/** One run */
export function runHtml(ctx, run, all) {
  const lit = ctx.selected === run.runId;
  const open = ctx.timelines.has(run.runId);
  const why = statusWhy(run);
  const name = ctx.esc(runName(run, ctx.now));
  const note = run.report && run.report.note ? `<p class="hx-forge-meta">Runner: ${ctx.esc(run.report.note)}</p>` : '';
  const answering = canAnswer(run);
  const off = ctx.busy ? ' disabled' : '';
  const retry = canRetry(run) ? `<button data-corn-kind="secondary" type="button" class="hx-btn hx-forge-act" data-forge-retry="${ctx.esc(run.runId)}" aria-label="${ctx.esc(t('startAgain'))}: ${name}"${off}>${ctx.esc(t('startAgain'))}</button>` : '';
  const stop = canStop(run) && !answering ? `<button type="button" class="hx-btn hx-forge-act" data-forge-stop="${ctx.esc(run.runId)}" aria-label="${ctx.esc(t('stop'))}: ${name}"${off} data-corn-kind="danger">${ctx.esc(t('stop'))}</button>` : '';
  const names = nodeLabels(run.nodes, ctx.nodes);
  const collision = collisionWords(run, all, ctx.nodes);
  const limits = limitRows(run);
  const count = (run.timeline || []).length;
  const links = linksHtml(ctx, run);
  const noNodes = !(run.nodes || []).length;
  const lightWords = lit ? 'Lit on the map' : 'Light on the map';
  const result = resultHtml(ctx, run);
  return `<li class="hx-run hx-forge-file" data-run="${ctx.esc(run.runId)}" tabindex="-1" data-corn="run"${cornStateAttr(run.status)}>
    <div class="hx-run-head">${runPillHtml(ctx, run, statusWords(run))} <span class="hx-name">${ctx.esc(run.kind)} on ${ctx.esc(aboutWords(run.refs))}</span>${run.profile ? ` <span class="hx-faint">profile ${ctx.esc(run.profile)}</span>` : ''}</div>
    ${collision ? `<p class="hx-run-collide"><span aria-hidden="true">⚠</span> ${ctx.esc(collision)}</p>` : ''}
    <p class="hx-forge-meta">${ctx.esc(runMeta(run, ctx.now))}</p>${why ? `<p class="hx-forge-why hx-faint">${ctx.esc(why)}</p>` : ''}${note}
    <dl class="hx-run-limits" aria-label="Limits and what the runner reported">${limits.length ? limits.map((r) => `<dt>${ctx.esc(r.name)}</dt><dd>limit: ${ctx.esc(r.limit)}; reported: ${ctx.esc(r.reported)}</dd>`).join('') : '<dt>Limits</dt><dd>none asked, nothing reported</dd>'}</dl>
    <p class="hx-forge-meta">${ctx.esc(checksWords(run))}</p>
    <p class="hx-forge-meta" id="run-nodes-${ctx.esc(run.runId)}">${names.length ? `Changing ${run.nodesFrom === 'files' ? '' : 'or expected to change '}${ctx.esc(names.join(', '))}` : 'No node on the map yet.'}</p>
    ${retryHtml(ctx, run, all)}
    ${links ? `<p class="hx-forge-meta">${links}</p>` : ''}
    ${answering ? `${answerHtml(ctx, run)}${result}` : unsentHtml(ctx, run)}${run.answer && !answering ? answeredHtml(ctx, run) : ''}
    <div class="hx-run-actions" data-corn="run-actions">${stop}${retry}
      <button data-corn-kind="secondary" type="button" class="hx-btn hx-forge-act" data-run-select="${ctx.esc(run.runId)}" aria-pressed="${lit}" aria-label="${lightWords}: ${name}"${noNodes ? ` disabled title="No node on the map yet, so there is nothing to light" aria-describedby="run-nodes-${ctx.esc(run.runId)}"` : ''}>${lightWords}</button>
      <button data-corn-kind="secondary" type="button" class="hx-btn hx-forge-act" data-run-timeline="${ctx.esc(run.runId)}" aria-expanded="${open}" aria-controls="run-tl-${ctx.esc(run.runId)}">Timeline (${count})</button></div>
    ${answering ? '' : result}
    ${open ? timelineHtml(ctx, run, all) : ''}</li>`;
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
    return `<li class="hx-run-group" data-key="${ctx.esc(id)}"><section class="hx-run-compare" aria-labelledby="${ctx.esc(id)}">
      <h4 class="hx-run-compare-title" id="${ctx.esc(id)}">${ctx.esc(compareTitle(g.runs))}</h4>
      <p class="hx-forge-meta hx-faint">The same request under each profile, side by side.</p>
      <ul class="hx-run-columns" aria-label="${ctx.esc(g.runs.length)} profiles compared">${g.runs.map((r) => runHtml(ctx, r, runs)).join('')}</ul></section></li>`;
  }).join('');
}
