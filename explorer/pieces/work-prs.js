/**
 * @module explorer/pieces/work-prs
 *
 * The PRs tab: the list rows, and a pull request's detail in the node panel (its files, checks, Land it, Re-run, landing). Part of the Work piece (pieces/work.js): `install(ctx)` makes this part's functions for one mount, and hands the ones other parts call
 * to `ctx.fn`; nothing is shared between two mounts.
 */

import { withParts } from '../engine/piece.js';
import { runOnPull, pullRunWords, statusWords } from '../runs-model.js';
import { loadingRowsHtml, runPillHtml } from '../runs-view.js';
import { pullUrl, stateWords, metaWords, checkWords, checksWords, landingUrl, cancelLandingUrl, landingWords, mergeBlock, rerunWhy, actionUrl, actionWords, buildOffers, approvalWarning } from '../forge-panel-model.js';
import { cornStateAttr, stateIconHtml } from '../corn-state.js';
import { waiting } from '../waiting-model.js';
import { escapeHtml as escHtml } from '../../core/text.js';
import { plural, safeUrl } from './work-common.js';

export function install(ctx) {
  const { ui, m, fn, state, $ } = ctx;
  const { announce, t, isNodeVisible } = ctx.h;

  /** Shows a pull request in the node panel: asks for its files and checks (the node panel's own line of checks is read from the same route) */
  async function selectPull(n) {
    const token = ++m.pullToken;
    fn.dropThread();
    ui.deploy = null;
    ui.deployItem = null;
    ui.litDeploy = null;
    ui.selected = n;
    ui.detail = null;
    ui.landing = null;
    ui.detailError = '';
    ui.lit = null;
    ui.note = null;
    fn.paint();
    const res = fn.preloaded('pull', n) || await fn.request(pullUrl(n), false);
    if (token !== m.pullToken) return;
    if (!res.ok) {
      ui.detailError = fn.failWords(res, `pull request ${n}`);
      announce(ui.detailError);
      fn.paint();
      return;
    }
    ui.detail = { pull: res.body.pull, files: res.body.files || [], checks: res.body.checks || [], specs: res.body.specs || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '' };
    fn.figure();
    // The run that made it is on the detail: the runs are read once, if the config has any
    if (!ui.runs && ui.config.agents && ui.config.agents.runs) fn.loadRuns(false, { say: false }).then(() => { if (ui.selected === n) fn.paint(); }, () => {});
    await loadLanding(n, token);
    fn.sayDetail(selectionWords());
  }

  /** Asks the server whether the selected pull request waits to land on its approval (a read of the server's own state, not of the forge); nothing is shown when it does not */
  async function loadLanding(n, token) {
    if (!(ui.config && ui.config.forge && ui.config.forge.approveLands)) return; // the key is off: nothing to ask
    const res = await fn.request(landingUrl(n), true);
    if (token !== m.pullToken || ui.selected !== n) return;
    ui.landing = res.ok && res.body && res.body.landing ? res.body.landing : null;
    fn.paint();
  }

  /** Stops the landing that waits on the selected pull request: a POST from this page, then the pull request is read again */
  async function cancelLanding(n) {
    if (ui.busy) return;
    ui.busy = 'landing';
    ui.note = null;
    fn.paint();
    const res = await fn.post(cancelLandingUrl(n), {});
    ui.busy = '';
    ui.note = { text: res.ok ? `Pull request #${n} will not land on its own. It stays open.` : `Not cancelled: ${(res.body && res.body.error) || 'cornfield did not answer.'}`, ok: res.ok };
    announce(ui.note.text);
    ui.landing = null;
    fn.paint();
    if (ui.selected === n) await fn.refreshForge({ quiet: true });
  }

  /** Lets go of the pull request in the node panel (another node was chosen, or the panel closed) */
  function clearPull() {
    m.pullToken++;
    if (ui.confirm) fn.closeConfirm({ restoreFocus: false });
    ui.selected = null;
    ui.note = null;
    ui.detail = null;
    ui.landing = null;
    ui.detailError = '';
    ui.lit = null;
  }

  /** What a screen reader hears when a pull request is selected */
  function selectionWords() {
    const { pull, files, checks } = ui.detail;
    const mapped = ui.lit ? ui.lit.files.filter((f) => f.nodes.length).length : 0;
    return `Pull request ${pull.number}, ${pull.title}: ${plural(files.length, 'file')}, ${mapped} on the map. ${checksWords(checks)}.`;
  }

  /** A row of the PRs, Issues and Runs lists: it selects its node (the node panel shows the rest); a link out to the forge beside it */
  function itemHtml(item, before = '', after = '') {
    if (ui.kind === 'deploys') return fn.deployHtml(item);
    if (ui.kind === 'threads') return fn.threadHtml(item);
    const link = safeUrl(item.url);
    const labels = item.labels.length ? `<span class="hx-forge-labels">${item.labels.map((l) => `<span class="hx-forge-label" data-corn="tag">${escHtml(l)}</span>`).join('')}</span>` : '';
    const inner = `<span class="hx-forge-title">${escHtml(item.title)}</span>
      <span class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(item.draft ? 'draft' : item.state)}" data-corn="state-pill"${cornStateAttr(item.draft ? 'draft' : item.state)}>${escHtml(stateWords(item))}</span> ${escHtml(metaWords(item, m.now()))}</span>${before}${after}${labels}`;
    const out = link ? `<a data-corn="out-link" class="hx-forge-out" href="${escHtml(link)}" target="_blank" rel="noreferrer" aria-label="Open ${escHtml(item.head ? 'pull request' : 'issue')} ${item.number} on ${escHtml(fn.forgeName())} (new tab)">↗</a>` : '';
    const ref = `${item.head ? 'pull' : 'issue'}:${item.number}`;
    return `<li class="hx-forge-item"><button type="button" class="hx-forge-row" data-work-ref="${ref}" aria-pressed="${fn.isShown(ref)}" data-corn="row">${inner}</button>${out}</li>`;
  }

  /** The pull request's detail for the node panel: Land it and Open on the forge, the checks with Re-run, what the head changes. Nothing here repeats the node panel's title and state. */
  function detailHtml() {
    if (ui.detailError) return `<p class="hx-forge-notice" data-corn="notice">${escHtml(ui.detailError)}</p>`;
    if (!ui.detail) return `<p class="hx-faint">Loading its files and checks …</p><ul class="hx-forge-list" aria-hidden="true">${loadingRowsHtml(4)}</ul>`;
    const { pull, checks, stale } = ui.detail;
    const lit = ui.lit;
    const mapped = lit.files.filter((f) => f.nodes.length).length;
    const url = safeUrl(pull.url);
    const failing = new Map(lit.checks.map((c) => [c.check.id, c]));

    const checkRows = checks.map((c) => {
      const failed = failing.get(c.id);
      const lights = failed
        ? `<span class="hx-faint hx-forge-lights">${failed.tests.length
          ? `Names ${failed.tests.map((t) => `<code class="hx-code">${escHtml(t.path)}</code>${t.nodes.length ? '' : ' (not on the map)'}`).join(', ')}`
          : 'Names no test file'}</span>`
        : '';
      const name = safeUrl(c.url) ? `<a data-corn="text-link" class="hx-link" href="${escHtml(c.url)}" target="_blank" rel="noreferrer">${escHtml(c.name)}</a>` : `<span class="hx-name">${escHtml(c.name)}</span>`;
      const why = rerunWhy(c, fn.forgeName());
      const again = c.state === 'failure' && c.canRerun
        ? `<button data-corn-kind="secondary" type="button" class="hx-btn hx-forge-act" data-forge-rerun="${escHtml(c.id)}" aria-label="Re-run ${escHtml(c.name)}"${ui.busy ? ' disabled' : ''}>Re-run</button>`
        : '';
      const whyNot = why ? `<span class="hx-faint hx-forge-lights">${escHtml(why)}</span>` : '';
      return `<li class="hx-forge-check"><span class="hx-forge-state hx-forge-state--${escHtml(c.state)}" data-corn="state-pill"${cornStateAttr(c.state)}>${stateIconHtml(c.state)}${escHtml(checkWords(c))}</span> ${name}${again}${lights}${whyNot}</li>`;
    }).join('');

    const fileRows = lit.files.map((f) => {
      const nodes = f.nodes.length
        ? f.nodes.map((n) => `<button data-corn="node-chip" type="button" class="hx-forge-node" data-forge-node="${escHtml(n.id)}" aria-label="Show ${escHtml(n.label)} on the map${isNodeVisible(n) ? '' : ' (its layer is off)'}">${escHtml(n.label)}${isNodeVisible(n) ? '' : ' · layer off'}</button>`).join('')
        : '<span class="hx-faint">not on the map</span>';
      const renamed = f.status === 'renamed' && f.previousPath ? `<span class="hx-faint"> from ${escHtml(f.previousPath)}</span>` : '';
      return `<li class="hx-forge-file" data-corn="file"><span class="hx-forge-fstatus">${escHtml(f.status)}</span> <code class="hx-code">${escHtml(f.path)}</code>${renamed} <span class="hx-good">+${f.additions}</span> <span class="hx-forge-del">−${f.deletions}</span><span class="hx-forge-nodes">${nodes}</span></li>`;
    }).join('');

    // Land it is the one primary action, with Open on the forge beside it; a pull request that cannot land says why in one line
    const block = mergeBlock(ui.detail);
    const land = block
      ? `<button type="button" class="hx-btn hx-btn--approve" disabled data-corn-kind="approve">${escHtml(t('landIt'))}</button>`
      : `<button type="button" class="hx-btn hx-btn--approve hx-forge-act" data-forge-merge="${escHtml(String(pull.number))}"${ui.busy ? ' disabled' : ''} data-corn-kind="approve">${escHtml(t('landIt'))} …</button>`;
    const act = `<div class="hx-forge-cta">${land}${url ? `<a data-corn="open-link" data-corn-kind="secondary" class="hx-btn hx-forge-open" href="${escHtml(url)}" target="_blank" rel="noreferrer">Open on ${escHtml(fn.forgeName())} ↗</a>` : ''}</div>${block ? `<p class="hx-forge-why hx-faint">${escHtml(block)}</p>` : ''}${approvalWarning(ui.detail) ? `<p class="hx-forge-why hx-faint" data-corn="notice" data-corn-state="waiting">${escHtml(approvalWarning(ui.detail))}</p>` : ''}`;
    // A spec approved with `proposals.approveLands` waits for its checks: said here, with a way to stop it
    const waiting = ui.landing && pull.state === 'open'
      ? `<div class="hx-forge-step"><p class="hx-forge-notice hx-forge-notice--ok" role="status" data-corn="notice" data-corn-state="success">${escHtml(landingWords(ui.landing, m.now()))}</p><button data-corn-kind="secondary" type="button" class="hx-btn hx-forge-act" data-forge-landing-cancel="${pull.number}"${ui.busy ? ' disabled' : ''}>Cancel</button></div>`
      : '';
    const note = ui.note ? `<p class="hx-forge-notice${ui.note.ok ? ' hx-forge-notice--ok' : ''}" data-corn="notice"${ui.note.ok ? ' data-corn-state="success"' : ''}>${escHtml(ui.note.text)}</p>` : '';
    // Step 2 of the pipeline: a spec pull request with an approved proposal opens its build issue
    const offers = buildOffers(ui.detail);
    const build = offers.length
      ? `<h3 class="hx-forge-subact">Build issue</h3>${offers.map((o) => (o.offer
        ? `<div class="hx-forge-step"><button type="button" class="hx-btn hx-btn--approve hx-forge-act" data-forge-build="${escHtml(o.slug)}" aria-label="Open the build issue for ${escHtml(o.slug)}"${ui.busy ? ' disabled' : ''} data-corn-kind="approve">Open the build issue …</button><p class="hx-forge-why hx-faint"><code class="hx-code">${escHtml(o.slug)}</code> is approved. Opens a confirm step that shows the issue. Nothing is built.</p></div>`
        : `<p class="hx-forge-why hx-faint"><code class="hx-code">${escHtml(o.slug)}</code>: ${escHtml(o.why)}</p>`)).join('')}`
      : '';

    // Its run: who is running it, their state, the time and the cost (the runs are read for the Runs tab, and once for the first PR selected)
    const runs = ui.runs && ui.runs.data ? ui.runs.data.runs : null;
    const made = runOnPull(runs, pull.number);
    const runSection = made
      ? `<h3 class="hx-forge-sub">Run</h3><p class="hx-forge-runline"${cornStateAttr(made.status)} data-corn="run">${runPillHtml({ esc: escHtml }, made, statusWords(made))} ${escHtml(pullRunWords(made, m.now(), { state: false }))}</p>`
      : '';
    return `${act}
      ${stale ? `<p class="hx-forge-notice" data-corn="notice">${escHtml(`This is an older answer. ${stale}`)}</p>` : ''}
      ${note}
      ${waiting}
      ${build}
      <h3 class="hx-forge-sub">Checks: ${escHtml(checksWords(checks))}</h3>
      ${checks.length ? `<ul class="hx-forge-checks">${checkRows}</ul>` : ''}
      <h3 class="hx-forge-sub">${escHtml(plural(lit.files.length, 'file'))} changed, ${mapped} on the map</h3>
      <ul class="hx-forge-files">${fileRows}</ul>
      ${runSection}`;
  }

  /** A node button, as in a pull request's files: it selects the node on the map */
  const nodeButton = (n) => `<button data-corn="node-chip" type="button" class="hx-forge-node" data-forge-node="${escHtml(n.id)}" aria-label="Show ${escHtml(n.label)} on the map${isNodeVisible(n) ? '' : ' (its layer is off)'}">${escHtml(n.label)}${isNodeVisible(n) ? '' : ' · layer off'}</button>`;

  /** What an action came to: said on the panel and through the live region, and everything is read again from the forge */
  async function finishAction(action, res, n) {
    const text = actionWords(action, res.status, res.body, n);
    ui.busy = '';
    ui.note = { text, ok: res.ok };
    announce(text);
    fn.paint();
    if (res.status === null) return;
    // The other tabs' answers are from before it: they are read again when next shown (the server let go of its own copies)
    if (ui.kind === 'work') ui.lists = {};
    else { ui.lists = { [fn.listKey()]: ui.lists[fn.listKey()] }; ui.work = null; }
    // Whatever it came to (a refusal says the pull request is not what was shown), the panel looks again
    if (ui.selected === n) await fn.refreshForge({ quiet: true });
  }

  /** Re-runs one failed check on the head that is shown */
  async function rerunCheck(id) {
    if (ui.busy || !ui.detail) return;
    const { pull, checks } = ui.detail;
    const check = checks.find((c) => c.id === id);
    if (!check || check.state !== 'failure' || !check.canRerun) return;
    ui.busy = `rerun:${id}`;
    ui.note = null;
    announce(`Re-running ${check.name}`);
    fn.paint();
    const res = await fn.post(actionUrl(pull.number, 'rerun'), { sha: pull.head.sha, check: id });
    await finishAction('rerun', res, pull.number);
  }

  // what other parts put in the panel gets its parts (a hook is a part of the same name)
  Object.assign(fn, { selectPull, loadLanding, cancelLanding, clearPull, selectionWords, itemHtml: (...a) => withParts(itemHtml(...a)), detailHtml: (...a) => withParts(detailHtml(...a)), nodeButton: (n) => withParts(nodeButton(n)), finishAction, rerunCheck });
}
