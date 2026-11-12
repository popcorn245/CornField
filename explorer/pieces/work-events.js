/**
 * @module explorer/pieces/work-events
 *
 * Opening and closing the panel, and what a click, a change, an input and a key in it do. Part of the Work piece (pieces/work.js): `install(ctx)` makes this part's functions for one mount, and hands the ones other parts call
 * to `ctx.fn`; nothing is shared between two mounts.
 */

import { workStatus } from '../agents-model.js';
import { defaultFilters, filterItems } from '../forge-panel-model.js';
import { waiting, specGroups } from '../waiting-model.js';
import { plural, TABS, SEARCH_ANNOUNCE_MS } from './work-common.js';

export function install(ctx) {
  const { inst, ui, m, fn, state, $ } = ctx;
  const { announce, t, isPhone, expandSheet, collapseSheet, showSheet, nodeById, selectNode, clearResult, resultOf, showResultIn, setT, clearT } = ctx.h;

  const isForgeOpen = () => ui.open;

  /**
   * Opens the panel with the focus on its title; the first time, loads what its tab shows (the proposals, to start with).
   * `tab` opens it on that tab ('specs', 'pulls', 'issues', 'threads', 'work' for Runs, 'deploys'), whichever was shown last otherwise.
   */
  function openForge({ load = true, tab } = {}) {
    const panel = $('forge-panel');
    if (!panel || panel.hidden) return;
    if (tab && tab !== (ui.kind === 'notes' ? 'pulls' : ui.kind) && TABS.includes(tab)) { // the Release notes are one level down on PRs
      ui.kind = tab;
      ui.filters = defaultFilters(tab);
      ui.actNote = null;
    } else if (!tab && load && !ui.open) {
      // Opened by a toggle: on the tab with the oldest thing waiting on you, else the tab used last (spec 0010 D2)
      const oldest = fn.waitingNow().oldest;
      if (oldest && oldest !== ui.kind) {
        ui.kind = oldest;
        ui.filters = defaultFilters(oldest);
        ui.actNote = null;
        fn.paintFilters();
      }
    }
    ui.open = true;
    panel.inert = false;
    panel.classList.add('forge-open');
    if (isPhone()) { showSheet('forge'); if (tab) expandSheet('forge'); } // a peek; only a link that names a tab (a deep link, "Open the Specs list") opens it expanded
    fn.paintButton();
    const title = $('forge-title');
    title.focus();
    announce('Work');
    if (!load) return; // a deep link loads the list it wants itself (openTab)
    if (!tab) fn.primeCounts(); // opened by a toggle, not for a tab: the other tabs' counts are read quietly
    if (ui.kind === 'notes') { if (!ui.notes.data && !ui.notes.loading) fn.loadNotes(); else fn.paint(); return; }
    if (ui.kind === 'specs' || !fn.current()) { fn.paintFilters(); fn.loadList(); } else fn.paint();
  }

  /** Shows `tab` in the panel, opened (and, on a phone, expanded), with its list read; resolves when the list is in */
  async function openTab(tab) {
    ui.kind = tab;
    ui.filters = defaultFilters(tab); // a filter left from before must not hide what the link names
    ui.actNote = null;
    fn.paintFilters();
    if (!ui.open) openForge({ load: false });
    if (isPhone()) expandSheet('forge');
    if (fn.current()) fn.paint(); else await fn.loadList();
  }

  /** What a link names is not there: a line in the panel, said through the live region */
  function linkMissing(words) {
    ui.actNote = { ok: false, text: words };
    fn.paint();
    announce(words);
    return false;
  }

  /** Moves the focus to `el` (made focusable if it is a row) and brings it into view */
  function bringIntoView(el) {
    if (!el) return;
    if (!el.matches('button, a, input, select, textarea')) el.setAttribute('tabindex', '-1');
    el.focus();
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }

  /** Closes the panel. What a selected pull request lit stays lit (the button says which); Clear lets go of it. */
  function closeForge({ restoreFocus = true } = {}) {
    const panel = $('forge-panel');
    if (!panel || !ui.open) return;
    const hadFocus = panel.contains(inst.active());
    ui.open = false;
    panel.classList.remove('forge-open');
    panel.inert = true;
    collapseSheet('forge');
    fn.paintButton();
    const back = m.openerEl && m.openerEl.isConnected ? m.openerEl : $('forge-btn');
    if (restoreFocus && hadFocus && back) back.focus();
    announce('Work closed');
  }

  const toggleForge = () => (ui.open ? closeForge() : openForge());

  /** After a filter changes: the list again, and how many it holds */
  function filtersChanged(announceNow = true) {
    fn.paint();
    const list = fn.current();
    if (announceNow && list && ui.kind === 'work') announce(workStatus(fn.groupsShown(), '', m.now()));
    else if (announceNow && list) announce(`${filterItems(list.items, ui.kind, ui.filters).length} of ${plural(list.items.length, fn.kindWords())} shown`);
  }

  function onClick(e) {
    const t = e.target;
    if (!t.closest) return;
    const kind = t.closest('[data-forge-kind]');
    if (kind) {
      if (kind.dataset.forgeKind === ui.kind) return;
      ui.kind = kind.dataset.forgeKind;
      ui.actNote = null;
      ui.filters = defaultFilters(ui.kind);
      fn.paintFilters();
      // The proposals are asked for again each time (worktrees come and go); the other lists keep what they have
      if (ui.kind === 'specs') { fn.paint(); fn.loadList(false, true); announce(fn.current() ? `${plural(fn.current().items.length, 'spec')} shown` : 'Looking for proposals'); } else if (fn.current()) filtersChanged(); else { fn.paint(); fn.loadList(); }
      return;
    }
    const fold = t.closest('[data-spec-group-toggle]');
    if (fold) {
      // Drafts folded behind their header, opened by hand and folded again; the focus stays on the header (findAgain)
      const drafts = specGroups(fn.specsList() ? fn.specsList().items : [], { query: ui.specQuery }).find((g) => g.key === 'drafts');
      const folded = ui.draftsOpen === null ? !!(drafts && drafts.collapsed) : !ui.draftsOpen;
      ui.draftsOpen = folded;
      fn.paint();
      return;
    }
    const pr = t.closest('[data-forge-pr]');
    if (pr) {
      const n = Number(pr.dataset.forgePr);
      m.returnTo = fn.findAgain(pr); // the row to give the focus back to when the selection is let go of
      if (ui.selected === n) fn.clearPull(); else fn.selectPull(n);
      return;
    }
    const thr = t.closest('[data-forge-thread]');
    if (thr) {
      const n = Number(thr.dataset.forgeThread);
      m.returnTo = fn.findAgain(thr);
      if (ui.thread === n) fn.clearThread(); else fn.selectThread(n);
      return;
    }
    const dep = t.closest('[data-forge-deploy]');
    if (dep) {
      m.returnTo = fn.findAgain(dep);
      if (ui.deploy === dep.dataset.forgeDeploy) fn.clearDeploy(); else fn.selectDeploy(dep.dataset.forgeDeploy);
      return;
    }
    const nodeBtn = t.closest('[data-forge-node]');
    if (nodeBtn) {
      const node = nodeById(nodeBtn.dataset.forgeNode);
      if (!node) return;
      selectNode(node, { frame: true });
      if (isPhone()) collapseSheet('forge'); // the map and the node's sheet are what is wanted now
      announce(`${node.label}, ${node.type}`);
      return;
    }
    const agent = t.closest('[data-forge-agent]');
    if (agent) { fn.openAgent(agent.dataset.forgeAgent, `[data-forge-agent="${agent.dataset.forgeAgent}"]`); return; }
    const stop = t.closest('[data-forge-stop]');
    if (stop) { fn.stopRun(stop.dataset.forgeStop); return; }
    const retry = t.closest('[data-forge-retry]');
    if (retry) { fn.startAgain(retry.dataset.forgeRetry); return; }
    const goto = t.closest('[data-run-goto]');
    if (goto) { fn.goToRun(goto.dataset.runGoto); return; }
    const answer = t.closest('[data-run-answer]');
    if (answer) { fn.answerRun(answer.dataset.runId, answer.dataset.runAnswer); return; }
    const discard = t.closest('[data-run-discard]');
    if (discard) { fn.discardReply(discard.dataset.runDiscard); return; }
    const pick = t.closest('[data-run-select]');
    if (pick) { fn.selectRun(pick.dataset.runSelect); return; }
    const timeline = t.closest('[data-run-timeline]');
    if (timeline) { fn.toggleTimeline(timeline.dataset.runTimeline); return; }
    const unland = t.closest('[data-forge-landing-cancel]');
    if (unland) { fn.cancelLanding(Number(unland.dataset.forgeLandingCancel)); return; }
    const merge = t.closest('[data-forge-merge]');
    if (merge) { fn.openConfirm('[data-forge-merge]'); return; }
    const spec = t.closest('[data-forge-spec]');
    if (spec) { fn.askPlan('spec', Number(spec.dataset.forgeSpec), null, `[data-forge-spec="${spec.dataset.forgeSpec}"]`); return; }
    const build = t.closest('[data-forge-build]');
    if (build && ui.selected !== null) { fn.askPlan('build', ui.selected, build.dataset.forgeBuild, `[data-forge-build="${build.dataset.forgeBuild}"]`); return; }
    const rerun = t.closest('[data-forge-rerun]');
    if (rerun) { fn.rerunCheck(rerun.dataset.forgeRerun); return; }
    const action = t.closest('[data-action]');
    if (!action) return;
    if (action.dataset.action === 'close-forge') closeForge();
    else if (action.dataset.action === 'refresh-forge' || action.dataset.action === 'retry-forge') fn.refreshForge();
    else if (action.dataset.action === 'clear-specs-search') {
      ui.specQuery = '';
      const box = $('specs-search');
      if (box) { box.value = ''; }
      fn.paint();
      announce(fn.specsShownWords());
      if (box) box.focus();
    }
    else if (action.dataset.action === 'copy-notes') fn.copyNotes();
    else if (action.dataset.action === 'post-notes') { if (ui.notes.confirm) fn.closeNotesConfirm(); else fn.openNotesConfirm(); }
    else if (action.dataset.action === 'confirm-notes') fn.postDraft();
    else if (action.dataset.action === 'cancel-notes') { fn.closeNotesConfirm(); announce('Cancelled. Nothing was posted.'); }
    else if (action.dataset.action === 'clear-forge-pr') fn.clearPull();
    else if (action.dataset.action === 'clear-forge-deploy') fn.clearDeploy();
    else if (action.dataset.action === 'clear-forge-thread') fn.clearThread();
    else if (action.dataset.action === 'toggle-filters') { ui.filtersOpen = !ui.filtersOpen; fn.paintChip(); }
    else if (action.dataset.action === 'open-notes') fn.openNotes();
    else if (action.dataset.action === 'close-notes') fn.closeNotes();
    else if (action.dataset.action === 'open-proposal' && isPhone()) collapseSheet('forge'); // the proposal's own bar and the map are what is wanted now
    else if (action.dataset.action === 'idea-open') fn.toggleIdea(!ui.idea.open);
    else if (action.dataset.action === 'idea-send') {
      // Nothing of it may escape as an unhandled rejection: what went wrong is said, and the form is usable again
      fn.sendIdea().catch((err) => {
        ui.idea.busy = false;
        ui.idea.message = `Something went wrong in the page: ${err instanceof Error ? err.message : err}`;
        ui.idea.bad = true;
        fn.paintIdea();
        announce(ui.idea.message);
      });
    }
    else if (action.dataset.action === 'idea-cancel') { fn.toggleIdea(false); announce('Cancelled. Nothing was opened.'); }
  }

  function onChange(e) {
    const id = e.target.id;
    if (id === 'notes-since') {
      ui.notes.since = e.target.value;
      ui.notes.message = '';
      fn.loadNotes();
    } else if (id === 'forge-state') {
      ui.filters.state = e.target.value;
      fn.paintFilters();
      if (fn.current()) filtersChanged(); else { fn.paint(); fn.loadList(); }
    } else if (id === 'forge-work-agents' || id === 'forge-work-finished') {
      if (id === 'forge-work-agents') ui.workFilters.agentsOnly = e.target.checked;
      else ui.workFilters.finished = e.target.checked;
      fn.paint();
      announce(workStatus(fn.groupsShown(), '', m.now()));
    } else if (id === 'forge-label') {
      ui.filters.label = e.target.value;
      filtersChanged();
    } else if (id === 'forge-author') {
      ui.filters.author = e.target.value;
      filtersChanged();
    }
  }

  function onInput(e) {
    if (e.target.dataset && e.target.dataset.runReply) {
      const id = e.target.dataset.runReply;
      ui.runReplies.set(id, e.target.value);
      // "Write a reply first" goes once something is written: a refusal does not outlive what it was about
      const said = resultOf(id);
      if (said && !said.ok && e.target.value.trim()) { clearResult(id); showResultIn(e.target.closest('[data-run]') && e.target.closest('[data-run]').querySelector(`[data-run-result="${id}"]`), id); }
      return;
    }
    if (e.target.id === 'specs-search') {
      ui.specQuery = e.target.value;
      fn.paint();
      clearT(m.searchTimer);
      m.searchTimer = setT(() => announce(fn.specsShownWords()), SEARCH_ANNOUNCE_MS);
      return;
    }
    if (e.target.id !== 'forge-text') return;
    ui.filters.text = e.target.value;
    filtersChanged(false);
    clearT(m.searchTimer);
    m.searchTimer = setT(() => filtersChanged(), SEARCH_ANNOUNCE_MS);
  }

  /** Escape anywhere in the panel closes it, and the button has the focus again (a field's own Escape comes first) */
  function onKey(e) {
    if (e.key === 'Enter' && e.target.dataset && e.target.dataset.runReply && !e.defaultPrevented) { e.preventDefault(); fn.answerRun(e.target.dataset.runReply, 'reply'); return; }
    if (e.key === 'Enter' && e.target.id === 'notes-tag' && !e.defaultPrevented) { e.preventDefault(); fn.postDraft(); return; }
    if (e.key === 'Escape' && !e.defaultPrevented && ui.notes.confirm && e.target.closest && e.target.closest('#notes-confirm')) {
      e.preventDefault();
      fn.closeNotesConfirm();
      announce('Cancelled. Nothing was posted.');
      return;
    }
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (e.target.closest && e.target.closest('select, input, textarea')) return;
    e.preventDefault();
    closeForge();
  }

  Object.assign(fn, { isForgeOpen, openForge, openTab, linkMissing, bringIntoView, closeForge, toggleForge, filtersChanged, onClick, onChange, onInput, onKey });
}
