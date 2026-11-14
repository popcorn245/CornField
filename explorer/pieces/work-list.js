/**
 * @module explorer/pieces/work-list
 *
 * The Work list (spec 0012 D6): opening and closing it (the List toggle of the Work view), what a click, a change, an input and a key in it do, and how a row selects its node.
 * A row never shows the detail: it names a piece of work (`data-work-ref="pull:27"`), the Work view selects that node on the map, and the node panel shows it and its actions
 * (`showDetail` below reads what it needs; pieces/work-paint.js `paintDetail` draws it). Work the graph does not draw (older than its 14 days, past its caps) is shown by the same path:
 * `showRef` makes its node from what the lists read (work-model.js `oldItem`) and puts it in the node panel without selecting anything on the map.
 * Part of the Work piece (pieces/work.js): `install(ctx)` makes this part's functions for one mount, and hands the ones other parts call
 * to `ctx.fn`; nothing is shared between two mounts.
 */

import { workStatus } from '../agents-model.js';
import { defaultFilters, filterItems, listKeyOf, listUrl, threadUrl, pullUrl } from '../forge-panel-model.js';
import { specGroups } from '../waiting-model.js';
import { oldItem, oldNode } from '../work-model.js';
import { clearSelection } from '../engine/selection.js';
import { plural, TABS, SEARCH_ANNOUNCE_MS } from './work-common.js';

export function install(ctx) {
  const { inst, ui, m, fn, state, $ } = ctx;
  const { announce, isPhone, expandSheet, collapseSheet, showSheet, nodeById, selectNode, clearResult, resultOf, showResultIn, setT, clearT } = ctx.h;

  const isForgeOpen = () => ui.open;

  /**
   * Opens the list with the focus on its title; the first time, loads what its tab shows (the proposals, to start with).
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
    if (isPhone()) { showSheet('forge'); if (tab) expandSheet('forge'); } // a peek (it takes the place of the node panel's sheet: spec 0010 D7); only a link that names a tab opens it expanded
    fn.paintButton();
    const title = $('forge-title');
    title.focus();
    announce('Work list');
    inst.emit('work:list', { open: true });
    if (!load) return; // a deep link loads the list it wants itself
    if (!tab) fn.primeCounts(); // opened by a toggle, not for a tab: the other tabs' counts are read quietly
    if (ui.kind === 'notes') { if (!ui.notes.data && !ui.notes.loading) fn.loadNotes(); else fn.paint(); return; }
    if (ui.kind === 'specs' || !fn.current()) { fn.paintFilters(); fn.loadList(); } else fn.paint();
  }

  /** What a link names is not there: a line in the list, said through the live region */
  function linkMissing(words) {
    ui.actNote = { ok: false, text: words };
    fn.paint();
    announce(words);
    return false;
  }

  /** Closes the list. The node panel keeps what it shows. */
  function closeForge({ restoreFocus = true } = {}) {
    const panel = $('forge-panel');
    if (!panel || !ui.open) return;
    const hadFocus = panel.contains(inst.active());
    ui.open = false;
    panel.classList.remove('forge-open');
    panel.inert = true;
    collapseSheet('forge');
    fn.paintButton();
    const back = m.openerEl && m.openerEl.isConnected ? m.openerEl : ctx.root.querySelector('[data-action="toggle-forge"]');
    if (restoreFocus && hadFocus && back) back.focus();
    inst.emit('work:list', { open: false });
    announce('Work list closed');
  }

  const toggleForge = () => (ui.open ? closeForge() : openForge());

  /** After a filter changes: the list again, and how many it holds */
  function filtersChanged(announceNow = true) {
    fn.paint();
    const list = fn.current();
    if (announceNow && list && ui.kind === 'work') announce(workStatus(fn.groupsShown(), '', m.now()));
    else if (announceNow && list) announce(`${filterItems(list.items, ui.kind, ui.filters).length} of ${plural(list.items.length, fn.kindWords())} shown`);
  }

  /** A click in the list: the tabs, a spec group's fold, a row (it selects its node), the filters, Release notes, the New idea form */
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
    const row = t.closest('[data-work-ref]');
    if (row) {
      const at = row.dataset.workRef.indexOf(':');
      fn.showRef(row.dataset.workRef.slice(0, at), row.dataset.workRef.slice(at + 1)).catch(() => {});
      return;
    }
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
    else if (action.dataset.action === 'toggle-filters') { ui.filtersOpen = !ui.filtersOpen; fn.paintChip(); }
    else if (action.dataset.action === 'open-notes') fn.openNotes();
    else if (action.dataset.action === 'close-notes') fn.closeNotes();
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

  /** A click in the node panel's actions (spec 0012 D5): Land it, Re-run, Start an agent, a run's answer, Stop, Cancel a landing ... today's confirms and server checks, unchanged */
  function onDetailClick(e) {
    const t = e.target;
    if (!t.closest) return;
    const nodeBtn = t.closest('[data-forge-node]');
    if (nodeBtn) {
      const node = nodeById(nodeBtn.dataset.forgeNode);
      if (!node) return;
      selectNode(node, { frame: true });
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

  /** A reply being typed in a run's card is kept, so a repaint (the runs are looked at again) brings it back */
  function onDetailInput(e) {
    if (!(e.target.dataset && e.target.dataset.runReply)) return;
    const id = e.target.dataset.runReply;
    ui.runReplies.set(id, e.target.value);
    // "Write a reply first" goes once something is written: a refusal does not outlive what it was about
    const said = resultOf(id);
    if (said && !said.ok && e.target.value.trim()) { clearResult(id); showResultIn(e.target.closest('[data-run]') && e.target.closest('[data-run]').querySelector(`[data-run-result="${id}"]`), id); }
  }

  /** Enter in a run's reply field sends it (the node panel's own Escape closes the panel; a field keeps its own) */
  function onDetailKey(e) {
    if (e.key === 'Enter' && e.target.dataset && e.target.dataset.runReply && !e.defaultPrevented) { e.preventDefault(); fn.answerRun(e.target.dataset.runReply, 'reply'); }
  }

  /** Escape anywhere in the list closes it, and the toggle has the focus again (a field's own Escape comes first) */
  function onKey(e) {
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

  // ---------------------------------------------------------------------------
  //  A row selects its node; the node panel shows the piece of work
  // ---------------------------------------------------------------------------

  /** The row a piece of work is: `pull:27`, `proposal:0100-flow`, `run:run-…`, `deploy:9004` */
  const refOf = (item) => `${item.kind}:${item.kind === 'run' ? item.runId : item.kind === 'proposal' ? item.slug : item.kind === 'deploy' ? item.deployId : item.number}`;

  /** Whether `ref` is the piece of work the node panel shows now: a row's pressed state (a spec's pull request is its proposal here, an idea's issue its thread) */
  function isShown(ref) {
    if (!ui.item) return false;
    if (ui.ref === ref) return true;
    const at = ref.indexOf(':');
    const n = Number(ref.slice(at + 1));
    const kind = ref.slice(0, at);
    return (kind === 'pull' && ui.item.kind === 'proposal' && ui.item.number === n) || (kind === 'issue' && ui.item.kind === 'thread' && ui.item.number === n);
  }

  /** What the node panel says of a piece of work as it is read: said for work the graph does not draw; in the Work view the live region has said the node's name, kind, state and place (work-view.js), and this would only cover it */
  const sayDetail = (words) => { if (m.sayDetail) announce(words); };

  /**
   * Selects the piece of work a row (or a link) names: the Work view selects its node on the map and the node panel shows it; work the graph does not hold is made a node
   * of `oldNode` and shown by the node panel alone. Resolves when the node panel has what it needs, true when there was something to show.
   * @param {'pull' | 'issue' | 'thread' | 'run' | 'deploy' | 'proposal'} kind
   * @param {string} key a number, a run id, a deploy id or a slug
   */
  async function showRef(kind, key) {
    m.shown = Promise.resolve();
    if (inst.ask('work:pick', { kind, key }) === true) { await m.shown; return true; }
    const item = await oldItemOf(kind, key);
    if (!item || ctx.dead) return false;
    clearSelection(inst, { source: 'api' }); // a selection and the panel are one: the map has none of this
    inst.emit('node:show', { node: oldNode(item), frame: false });
    await m.shown;
    if (isPhone()) collapseSheet('forge');
    return true;
  }

  /** What the lists know of a piece of work the graph does not draw: from a list already read, else from its own route; a name that is nowhere is said, never blank */
  async function oldItemOf(kind, key) {
    const n = Number(key);
    if (kind === 'issue') { const src = await fn.oldIssue(n); return src && oldItem('issue', src); }
    if (kind === 'pull') {
      const res = await fn.request(pullUrl(n), false);
      if (!res.ok || !res.body.pull) { fn.linkMissing(fn.failWords(res, `pull request ${n}`)); return null; }
      m.preload = { kind: 'pull', n, res }; // the node panel's own read of it is this one
      return oldItem('pull', res.body.pull);
    }
    if (kind === 'thread') {
      const res = await fn.request(threadUrl(n), false);
      const thread = res.ok && res.body.thread;
      if (!thread) { fn.linkMissing(res.ok ? `Thread ${n} could not be read: the answer had no thread in it. Refresh to ask again.` : fn.failWords(res, `thread ${n}`)); return null; }
      m.preload = { kind: 'thread', n, res };
      return oldItem('thread', thread);
    }
    if (kind === 'run') {
      if (!(ui.runs && ui.runs.data)) await fn.loadRuns(false, { say: false });
      let run = fn.runById(key);
      if (!run && ui.runs && ui.runs.data) { await fn.loadRuns(true, { say: false }); run = fn.runById(key); } // a run asked for a moment ago may not be in what was read before
      if (!run) { fn.linkMissing(ui.runs && ui.runs.data ? `There is no run ${key}.` : (ui.runs && ui.runs.error) || 'The runs could not be read.'); return null; }
      return oldItem('run', run);
    }
    if (kind === 'deploy') {
      if (!ui.lists[listKeyOf('deploys')]) {
        const res = await fn.request(listUrl('deploys', 'all'), false);
        if (res.ok) ui.lists[listKeyOf('deploys')] = { items: res.body.items || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '', problem: res.body.problem || '' };
      }
      const hit = ui.lists.deploys && ui.lists.deploys.items.find((d) => d.id === key);
      if (!hit) { fn.linkMissing(`There is no deploy ${key} among the last hundred.`); return null; }
      return oldItem('deploy', hit);
    }
    if (kind === 'proposal') {
      if (!fn.specsList()) await fn.loadSpecs(m.listToken, true);
      const items = fn.specsList() ? fn.specsList().items : [];
      const hit = items.find((e) => e.slug === key) || items.find((e) => String(e.slug).startsWith(`${key}-`));
      if (!hit) { fn.linkMissing(`There is no proposal ${key}.`); return null; }
      return oldItem('proposal', hit);
    }
    return null;
  }

  /** The node panel shows a piece of work (`node:painted`): what it needs is read, and its actions are drawn into it */
  function showDetail(node) {
    const item = node.item;
    const ref = refOf(item);
    if (ui.node === node.id && ui.ref === ref && ui.item === item) { fn.paint(); return Promise.resolve(); } // the same node, its panel drawn again: the place of its actions is new, what it holds is not
    dropDetail();
    ui.node = node.id;
    ui.ref = ref;
    ui.item = item;
    m.sayDetail = node.old === true;
    switch (item.kind) {
      case 'pull': return fn.selectPull(item.number);
      case 'thread': return fn.selectThread(item.number);
      case 'deploy': return fn.showDeploy(item.deployId);
      case 'run': return fn.showRun(item.runId);
      // A spec pull request is a proposal here: its Review, and what its pull request has (Land it, the checks, Open the build issue, a landing waiting on its approval)
      case 'proposal': if (Number.isInteger(item.number)) { fn.paint(); return fn.selectPull(item.number); } fn.paint(); return Promise.resolve();
      default: fn.paint(); return Promise.resolve();
    }
  }

  /** The node panel shows something else, or closed: what it held is let go of */
  function dropDetail() {
    if (!ui.node && !ui.selected && ui.thread === null && !ui.deployItem && !ui.runShown) return;
    fn.clearPull();
    fn.clearThread();
    fn.clearDeploy();
    ui.runShown = null;
    ui.node = '';
    ui.ref = '';
    ui.item = null;
    ui.note = null;
    fn.paint();
  }

  Object.assign(fn, { isForgeOpen, openForge, linkMissing, closeForge, toggleForge, filtersChanged, onClick, onDetailClick, onChange, onInput, onDetailInput, onDetailKey, onKey, refOf, isShown, sayDetail, showRef, showDetail, dropDetail });
}
