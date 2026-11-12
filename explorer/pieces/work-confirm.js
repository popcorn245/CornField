/**
 * @module explorer/pieces/work-confirm
 *
 * The confirm step: landing a pull request, starting a spec, opening a build issue (a modal dialog over a scrim). Part of the Work piece (pieces/work.js): `install(ctx)` makes this part's functions for one mount, and hands the ones other parts call
 * to `ctx.fn`; nothing is shared between two mounts.
 */

import { withParts } from '../engine/piece.js';
import { mergeBlock, confirmMerge, mergeBody, actionUrl, actionWords, planUrl, confirmSpec, confirmBuild, specBody, buildBody, existingWords } from '../forge-panel-model.js';
import { trapTab } from '../focusables.js';
import { escapeHtml as escHtml } from '../../core/text.js';

export function install(ctx) {
  const { ui, m, fn, state, root, $, scope } = ctx;
  const { announce, t } = ctx.h;

  const confirmEl = () => $('forge-confirm');

  /** While the confirm step is open the focus cannot leave it: a focus that lands elsewhere is brought back */
  function keepFocusIn(e) {
    const el = confirmEl();
    if (ui.confirm && el && !el.contains(e.target)) el.querySelector('[data-action="forge-confirm-cancel"]').focus();
  }

  /** Fills and opens the confirm step; the focus goes to Cancel. `what` is the model's: title, lines, checks, previews, note */
  function showConfirm(what, goLabel, state) {
    const el = confirmEl();
    const asCode = ['Commit', 'At commit', 'Branch', 'File', 'Proposal'];
    $('forge-confirm-title').textContent = what.title;
    $('forge-confirm-body').innerHTML = withParts(`<dl class="hx-confirm-facts">${what.lines.map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${asCode.includes(k) ? `<code class="hx-code">${escHtml(v)}</code>` : escHtml(v)}</dd>`).join('')}</dl>
      ${(what.checks || []).length ? `<ul class="hx-confirm-checks">${what.checks.map((c) => `<li><span class="hx-forge-state hx-forge-state--success" data-corn="state-pill" data-corn-state="success">${escHtml(c.words)}</span> ${escHtml(c.name)}</li>`).join('')}</ul>` : ''}
      ${(what.previews || []).map((pv) => `<p class="hx-confirm-label">${escHtml(pv.label)}</p><pre class="hx-confirm-pre" data-corn="confirm-preview" tabindex="0" role="region" aria-label="${escHtml(pv.label)}">${escHtml(pv.text)}</pre>`).join('')}
      <p class="hx-confirm-note">${escHtml(what.note)}</p>`);
    const go = el.querySelector('[data-action="forge-confirm-go"]');
    go.disabled = false;
    go.textContent = goLabel;
    go.removeAttribute('aria-busy');
    // The scrim covers the page for the pointer, aria-modal tells a reader the rest is out of play, and the focus stays in
    ui.confirm = state;
    m.confirmTrap = scope.listen(root, 'focusin', keepFocusIn);
    el.hidden = false;
    el.querySelector('[data-action="forge-confirm-cancel"]').focus();
    announce(`${what.title} ${what.lines.map(([k, v]) => `${k}: ${v}`).join('. ')}. ${what.note} Cancel or ${goLabel}.`);
  }

  /** Opens the confirm step for landing the selected pull request: what will land, exactly */
  function openConfirm(opener) {
    if (!confirmEl() || ui.confirm || ui.agent || ui.busy || !ui.detail || mergeBlock(ui.detail)) return; // one dialog at a time
    showConfirm(confirmMerge(ui.detail, fn.forgeName(), ui.config && ui.config.forge && ui.config.forge.mergeMethod), t('landIt'), { opener, kind: 'merge' });
  }

  /** What a pipeline step came to, on the panel (with a link to what it made) and through the live region */
  function stepNote(text, ok, url = null) {
    ui.actNote = { text, ok, url };
    announce(text);
    fn.paint();
  }

  /** Forgets the lists of the other kind (a step made something there), so they are asked again when shown */
  function forgetOtherLists() {
    for (const key of Object.keys(ui.lists)) if (!key.startsWith(`${ui.kind}|`)) delete ui.lists[key];
  }

  /**
   * A pipeline step, first half: reads the plan from the server (what would be made, from the forge now). A step that
   * was done before says so and stops; otherwise the confirm step shows the plan and nothing is made until it is confirmed.
   */
  async function askPlan(action, n, slug, opener) {
    if (ui.busy || ui.confirm || ui.agent || !confirmEl()) return;
    ui.busy = `plan:${action}`;
    ui.actNote = null;
    announce(action === 'spec' ? `Looking at what a spec for issue ${n} would make` : `Looking at the build issue for ${slug}`);
    fn.paint();
    const res = await fn.request(planUrl(action, n, slug), true);
    ui.busy = '';
    // The button was off while it asked; it has the focus again whatever the answer is
    const refocus = () => { const back = $('forge-panel').querySelector(opener); if (back && !back.disabled && !ui.confirm) back.focus(); };
    if (!res.ok || !res.body || !res.body.plan) {
      stepNote(actionWords(action, res.status, res.body, n), false);
      refocus();
      return;
    }
    const { plan } = res.body;
    if (plan.existing) {
      stepNote(existingWords(action, plan), true, plan.existing.url);
      refocus();
      return;
    }
    fn.paint();
    if (ui.agent) return; // Start an agent was opened while the plan was read: one dialog at a time, and that one has the focus
    const what = action === 'spec' ? confirmSpec(plan, fn.forgeName()) : confirmBuild(plan, fn.forgeName());
    showConfirm(what, what.go, { opener, kind: action, plan, n, slug });
  }

  /** A pipeline step, second half: the plan that was shown is confirmed; the server plans again and must find the same */
  async function confirmedStep() {
    if (ui.busy || !ui.confirm || !ui.confirm.plan) return;
    const { kind, plan, n } = ui.confirm;
    ui.busy = kind;
    ui.actNote = null;
    const go = confirmEl().querySelector('[data-action="forge-confirm-go"]');
    go.disabled = true;
    go.setAttribute('aria-busy', 'true');
    go.textContent = 'Working …';
    announce(kind === 'spec' ? `Starting the spec for issue ${n}` : `Opening the build issue for ${plan.slug}`);
    const res = await fn.post(actionUrl(n, kind), kind === 'spec' ? specBody(plan) : buildBody(plan));
    closeConfirm();
    ui.busy = '';
    const made = res.body && (kind === 'spec' ? res.body.pull : res.body.issue);
    stepNote(actionWords(kind, res.status, res.body, n), res.ok, res.ok && made ? made.url : null);
    // Whatever it came to, it is read again: a refusal says the issue or the pull request is not what was shown
    if (res.status !== null) {
      forgetOtherLists();
      if (kind === 'build' && ui.selected === n) await fn.refreshForge({ quiet: true });
      else await fn.loadList(true, true);
    }
  }

  /** Closes the confirm step; the focus goes back to the button that opened it (or the panel's title if that is gone) */
  function closeConfirm({ restoreFocus = true } = {}) {
    const el = confirmEl();
    if (!el || !ui.confirm) return;
    const { opener } = ui.confirm;
    ui.confirm = null;
    el.hidden = true;
    if (m.confirmTrap) { m.confirmTrap(); m.confirmTrap = null; }
    if (!restoreFocus) return;
    const back = $('forge-panel').querySelector(opener) || $('forge-title');
    if (back && !back.disabled) back.focus();
  }

  /** Land it, confirmed: posts the head that was shown */
  async function confirmedMerge() {
    if (ui.busy || !ui.detail || !ui.confirm || ui.confirm.kind !== 'merge') return;
    const { pull } = ui.detail;
    const body = mergeBody(ui.detail);
    ui.busy = 'merge';
    ui.note = null;
    const go = confirmEl().querySelector('[data-action="forge-confirm-go"]');
    go.disabled = true;
    go.setAttribute('aria-busy', 'true');
    go.textContent = 'Landing …';
    announce(`Landing pull request ${pull.number}`);
    const res = await fn.post(actionUrl(pull.number, 'merge'), body);
    closeConfirm();
    await fn.finishAction('merge', res, pull.number);
  }

  /** Keys inside the confirm step: Escape cancels, Tab stays between its two buttons, nothing reaches the map behind it */
  function onConfirmKey(e) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!ui.busy) closeConfirm();
      return;
    }
    trapTab(e, confirmEl());
  }

  function onConfirmClick(e) {
    const t = e.target;
    if (t === confirmEl()) { if (!ui.busy) closeConfirm(); return; } // the scrim
    const action = t.closest && t.closest('[data-action]');
    if (!action) return;
    if (action.dataset.action === 'forge-confirm-cancel') { if (!ui.busy) closeConfirm(); } else if (action.dataset.action === 'forge-confirm-go') { if (ui.confirm && ui.confirm.kind === 'merge') confirmedMerge(); else confirmedStep(); }
  }

  Object.assign(fn, { confirmEl, keepFocusIn, showConfirm, openConfirm, stepNote, forgetOtherLists, askPlan, confirmedStep, closeConfirm, confirmedMerge, onConfirmKey, onConfirmClick });
}
