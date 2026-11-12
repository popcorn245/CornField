/**
 * @module explorer/pieces/work
 *
 * The Work panel as a piece on the instance (spec 0011 D2 and D3; CF-07, CF-42, spec 0001 section 4, spec 0010): the Work button with its badge, the
 * panel with its tabs (Specs, PRs, Issues, Threads, Runs, Deploys, and Release notes one level down on PRs), the two dialogs it opens (the confirm
 * step and Start an agent) and the layer over the map that marks the nodes an open run is changing. What the panel shows, asks and does is the
 * parts' (work-*.js, one module each); this file makes them for one mount, wires them to the instance, and ends them.
 *
 *   mount(root, inst, { slots, config, clock }) -> { update, destroy, elements, ... }
 *     slots   where cornfield's page leaves the places (`<!--corn-piece:work/button-->`, `work/panel`, `work/overlay`, `work/dialogs`); a host
 *             that gives none gets the four at the end of `root`
 *     config  what `/cornfield/config.json` said: with no `forge`, or nobody signed in (`signIn`), the button and the panel stay hidden
 *     clock   `() => ms`, for the times shown (tests)
 *   update({ config, clock })   the config arrived (or changed): the panel starts, or does not. `isOn()` says which.
 *   destroy()                   every listener, timer and poll ends, the elements go, an answer still on its way is not heard
 *
 * What it asks of the server (all through `credentialed(inst)`, served paths only; docs/embedding.md lists which a sibling origin may reach: today none of these):
 *   GET  /api/forge/{pulls,issues,threads}?state=<open|closed|all>&limit=100   GET /api/forge/deploys?limit=100   GET /api/forge/work
 *   GET  /api/forge/pulls/<n>   GET /api/forge/pulls/<n>/landing (approveLands)   POST /api/forge/pulls/<n>/landing/cancel {}
 *   POST /api/forge/pulls/<n>/merge {sha, ...}   POST /api/forge/pulls/<n>/rerun {sha, check}   GET /api/forge/pulls/<n>/build?slug=<slug>   POST /api/forge/pulls/<n>/build {digest, ...}
 *   GET  /api/forge/issues/<n>   GET /api/forge/issues/<n>/spec   POST /api/forge/issues/<n>/spec {digest, ...}
 *   GET  /api/forge/threads/<n>   POST /api/forge/threads {title, body}
 *   GET  /api/forge/release-notes[?since=<tag>]   POST /api/forge/release-drafts {tag, since?}
 *   GET  /api/agent-runs[?follow=1]   POST /api/agent-runs {kind, refs, brief, profile?, limits?, force?, retryOf?}   GET /api/agent-runs/<id>/brief
 *   POST /api/agent-runs/<id>/stop {}   POST /api/agent-runs/<id>/answer {action: 'continue'|'stop'|'reply', text?}
 *   (and GET /proposals, which the engine reads for the Specs tab: engine/proposal.js)
 *
 * Events and asks (instance.js lists them): hears `work:open-specs` (ask, answers true), `forge:can-start` (ask) and `forge:start`, `thread:open`,
 * `thread:start`, `threads:ensure`, `threads:index` (ask), `proposal:bar`, `decision`, `work:answer`, `work:on` (ask), `scene`; says `work:waiting {total}`,
 * `work:available {on}`, `proposal:waiting`, `proposal:waiting-reset`, `runs:map {active}`, `threads:changed`, `announce`.
 */

import { place, scopeOf } from '../engine/piece.js';
import { markup } from './work-markup.js';
import { freshUi, RUNS_POLL_MS, SPECS_POLL_MS } from './work-common.js';
import { announce } from '../engine/keyboard.js';
import { t } from '../engine/strings.js';
import { isPhone, registerSheet, unregisterSheet, expandSheet, collapseSheet, showSheet, refreshStubs } from '../engine/sheets.js';
import { sayResult, clearResult, resultOf, showResultIn } from '../engine/feedback.js';
import { selectNode } from '../engine/selection.js';
import { toggleLayer } from '../engine/layers.js';
import { notSentWords } from '../engine/connection.js';
import * as P from '../engine/proposal.js';
import { isNodeVisible } from '../scene.js';
import { revealInStrip } from '../focus-room.js';
import { createRunsMap } from '../runs-map.js';
import { workButtonName } from '../waiting-model.js';
import { install as installData } from './work-data.js';
import { install as installSpecs } from './work-specs.js';
import { install as installPrs } from './work-prs.js';
import { install as installIssues } from './work-issues.js';
import { install as installThreads } from './work-threads.js';
import { install as installRuns } from './work-runs.js';
import { install as installDeploys } from './work-deploys.js';
import { install as installNotes } from './work-notes.js';
import { install as installConfirm } from './work-confirm.js';
import { install as installAgent } from './work-agent.js';
import { install as installPaint } from './work-paint.js';
import { install as installEvents } from './work-events.js';

export { markup, RUNS_POLL_MS, SPECS_POLL_MS };

/**
 * @param {ParentNode} root where the elements go when the host names no place
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst
 * @param {{ slots?: Record<string, Node | null>, config?: object | null, clock?: () => number }} [options]
 */
export function mount(root, inst, options = {}) {
  const scope = scopeOf(inst);
  const mk = markup();
  const slots = options.slots || {};
  const made = [
    ...place(inst, root, mk.button, slots, 'button'),
    ...place(inst, root, mk.panel, slots, 'panel'),
    ...place(inst, root, mk.overlay, slots, 'overlay'),
    ...place(inst, root, mk.dialogs, slots, 'dialogs'),
  ];
  const panelEl = made.find((el) => el.id === 'forge-panel');
  scope.keepParts(...made);

  // -- what the parts share: the state of this one panel, and the few things that are not functions ---------------------------------------
  /** @type {Record<string, any>} */
  const m = {
    runsTimer: 0, threadToken: 0, indexToken: 0, indexLoading: false, indexCache: null, listToken: 0, pullToken: 0, notesToken: 0,
    searchTimer: null, now: options.clock || (() => Date.now()), pageAway: false, specsTimer: 0, specsReading: false, primed: new Set(),
    shownKey: '', shownKind: '', returnTo: null, openerEl: null, merged: { entries: null, items: [] }, redrawRuns: new Set(), agentTrap: null, confirmTrap: null,
  };
  const timers = new Set();
  /** Timers that end with the piece, and do nothing once it has */
  const setT = (f, ms) => { const id = setTimeout(() => { timers.delete(id); if (!ctx.dead) f(); }, ms); timers.add(id); return id; };
  const clearT = (id) => { clearTimeout(id); timers.delete(id); };
  scope.own(() => { for (const id of timers) clearTimeout(id); timers.clear(); });
  const runsMap = createRunsMap(inst);

  /** Each of the instance's modules, bound to this instance: the parts call these and never reach a page */
  const h = {
    announce: (text) => announce(inst, text),
    t: (key) => t(inst, key),
    isPhone: () => isPhone(inst),
    registerSheet: (id, el, opts) => registerSheet(inst, id, el, opts),
    expandSheet: (id) => expandSheet(inst, id),
    collapseSheet: (id) => collapseSheet(inst, id),
    showSheet: (id) => showSheet(inst, id),
    refreshStubs: () => refreshStubs(inst),
    render: () => { if (inst.map) inst.map.render(); },
    touchScene: () => inst.touchScene(),
    nodeById: (id) => inst.state.nodes.find((n) => n.id === id),
    isNodeVisible: (node) => (inst.map ? inst.map.isNodeVisible(node) : isNodeVisible(inst.state, node)),
    selectNode: (node, opts) => selectNode(inst, node, opts),
    repaintThreads: () => inst.emit('threads:changed'),
    toggleLayer: (key) => toggleLayer(inst, key),
    sayResult: (key, text, ok) => sayResult(inst, key, text, ok),
    clearResult: (key) => clearResult(inst, key),
    resultOf: (key) => resultOf(inst, key),
    showResultIn: (el, key) => showResultIn(inst, el, key),
    isOffline: () => inst.offline(),
    notSentWords: (what) => notSentWords(inst, what),
    proposalListing: () => P.proposalListing(inst),
    onProposalListing: (f) => P.onProposalListing(inst, f),
    loadProposalList: () => P.loadProposalList(inst),
    paintWaitingLine: (run, key) => inst.emit('proposal:waiting', { run, key }),
    setRunsOnMap: (runs) => runsMap.set(runs),
    clearRunsOnMap: () => runsMap.clear(),
    setT,
    clearT,
    /**
     * Keeps the focus in an open dialog: `keep` hears every focus that lands inside the instance's root, and, when the root is not the document
     * (an element or a shadow root in a host's page), every focus that lands outside the root too, which the root never hears, unless it landed in
     * another open modal dialog (a second instance's: two traps never pull the focus between them). Returns how to stop.
     */
    trapFocus: (keep) => {
      const offs = [scope.listen(ctx.root, 'focusin', keep)];
      const inModal = (e) => (e.composedPath ? e.composedPath() : [e.target]).some((n) => n && n.nodeType === 1 && n.getAttribute('aria-modal') === 'true');
      if (inst.doc && ctx.root !== inst.doc) offs.push(scope.listen(inst.doc, 'focusin', (e) => { if (!inst.active() && !inModal(e)) keep(e); }));
      return () => offs.forEach((off) => off());
    },
  };
  const ctx = { inst, ui: freshUi(), m, fn: {}, state: inst.state, root: inst.root || root, $: (id) => inst.el(id), scope, h, dead: false };
  const { ui, fn } = ctx;
  for (const install of [installData, installSpecs, installPrs, installIssues, installThreads, installRuns, installDeploys, installNotes, installConfirm, installAgent, installPaint, installEvents]) install(ctx);

  // -- the panel starts once the config says there is a forge and somebody is signed in ---------------------------------------------------
  let on = false;
  // A piece mounted after the panel started asks rather than waits for `work:available` (the proposal piece hides its Proposals entry)
  scope.on('work:on', () => on);

  /** Starts the panel for `config`; with no forge in it, or nobody signed in, the button and the panel stay hidden. Returns whether it is on. */
  function start(config) {
    const panel = ctx.$('forge-panel');
    if (!config || !config.forge || !config.signIn || !panel) return false;
    ui.config = config;
    const first = !on;
    on = true;
    for (const toggle of ctx.root.querySelectorAll('[data-action="toggle-forge"]')) toggle.hidden = false;
    panel.hidden = false;
    inst.emit('work:available', { on: true });
    // `threads: false` in the config turns the tab off; a server that does not say has threads
    const threadsOn = config.threads !== false;
    const tab = panel.querySelector('[data-forge-kind="threads"]');
    if (tab) tab.hidden = !threadsOn;
    ui.threadsOn = threadsOn;
    // On a phone Work is a sheet: it opens as a peek and displaces the node panel; folded to a stub it says its title and what waits on you (spec 0010 D7)
    registerSheet(inst, 'forge', panel, {
      stub: () => { const n = fn.waitingNow().total; return { title: h.t('issuesAndPrs'), badge: n ? String(n) : '', label: workButtonName(h.t('issuesAndPrs'), n, h.t) }; },
      away: () => fn.closeForge({ restoreFocus: false }),
    });
    fn.paintFilters();
    fn.paint();
    // The map shows the open runs whether or not the panel is open: read them once now, and again now and then while any is open
    if (config.agents && config.agents.runs) fn.loadRuns(false).then(() => { if (ui.kind === 'work') fn.paint(); }, () => {});
    fn.readSpecsQuiet();
    fn.syncSpecsPoll();
    if (first) wire(panel);
    return true;
  }

  /** The listeners, once: they end with the piece */
  function wire(panel) {
    // The specs part of what waits on you is read after a review is sent; the proposal bar says so when a run waits on the proposal it shows
    scope.on('decision', ({ open }) => { if (open !== false) fn.readSpecsQuiet(); });
    scope.on('proposal:bar', ({ open }) => fn.paintBarLine(open));
    scope.on('work:answer', ({ run }) => { fn.answerFromBar(run); });
    // A bad link's way on, and the node panel's "Start a run"
    scope.on('work:open-specs', () => { fn.openForge({ tab: 'specs' }); return true; });
    scope.on('forge:can-start', () => fn.canStartAgent());
    scope.on('forge:start', ({ slug, returnTo }) => { fn.openProposalStart(slug, returnTo); });
    // A node's panel lists the threads that mention it; a click there shows one in this panel
    scope.on('threads:index', (nodeId) => (ui.config && ui.threadsOn ? { threads: fn.threadsFor(nodeId), forge: fn.forgeName(), start: true } : undefined));
    scope.on('threads:ensure', () => { if (ui.config && ui.threadsOn) fn.ensureThreadsList(); });
    scope.on('thread:open', ({ number }) => { if (ui.threadsOn) fn.openThread(number); });
    scope.on('thread:start', ({ node }) => { if (ui.threadsOn && node) fn.startThread(node); });
    // The map or the proposal changed the nodes: the lights follow them. The header's Proposals menu reads the same list: the Specs tab and its count follow
    scope.on('scene', fn.onNodesChange);
    scope.own(P.onProposalListing(inst, () => { fn.paintWaiting(); if (ui.open) fn.paint(); }));
    scope.own(inst.onNetwork((offline) => { if (!offline) fn.readOnline(); })); // ends with the piece, not only with the instance
    scope.own(inst.onPageHide(() => fn.onPageHide()));
    scope.own(inst.onPageShow(() => fn.onPageShow()));
    // Any `data-action="toggle-forge"` opens and closes the panel
    scope.listen(ctx.root, 'click', (e) => {
      const el = e.target.closest && e.target.closest('[data-action="toggle-forge"]');
      if (!el) return;
      m.openerEl = el;
      fn.toggleForge();
    });
    // A control tabbed to inside the strip of tabs is brought fully into view, ring and all (focus-room.js)
    scope.listen(ctx.root, 'focusin', (e) => { revealInStrip(e.target); });
    const tabs = panel.querySelector('.hx-forge-tabs');
    if (tabs) scope.listen(tabs, 'scroll', fn.paintTabsMore, { passive: true });
    scope.own(inst.onResize(() => fn.paintTabsMore()));
    // The strip's fade and the top's height follow their own size too: a phone's sheet expanding shows the tabs (they were not laid out in the
    // peek), and a host's box resizes without the window doing so (F42)
    const Observer = inst.win && inst.win.ResizeObserver;
    const top = panel.querySelector('.hx-forge-top');
    if (Observer && top && tabs) {
      const seen = new Observer(() => { if (!ctx.dead) fn.paintTabsMore(); });
      seen.observe(top);
      seen.observe(tabs);
      scope.own(() => seen.disconnect());
    }
    scope.listen(panel, 'click', fn.onClick);
    scope.listen(panel, 'change', fn.onChange);
    scope.listen(panel, 'input', fn.onInput);
    scope.listen(panel, 'keydown', fn.onKey);
    const agent = fn.agentEl();
    if (agent) {
      scope.listen(agent, 'click', fn.onAgentClick);
      scope.listen(agent, 'keydown', fn.onAgentKey);
      scope.listen(agent.querySelector('form'), 'submit', fn.submitAgent);
      scope.listen(ctx.$('agent-profile'), 'change', fn.onAgentProfile);
    }
    const confirm = fn.confirmEl();
    if (confirm) {
      scope.listen(confirm, 'click', fn.onConfirmClick);
      scope.listen(confirm, 'keydown', fn.onConfirmKey);
    }
  }

  /** What the page tells the piece after it is mounted: the config (the panel starts), a clock */
  function update(patch = {}) {
    if (ctx.dead) return;
    if (patch.clock) m.now = patch.clock;
    if (patch.config !== undefined) start(patch.config);
  }

  function destroy() {
    if (ctx.dead) return;
    ctx.dead = true;
    if (ui.confirm) fn.closeConfirm({ restoreFocus: false });
    if (ui.agent) fn.closeAgent({ restoreFocus: false });
    // What this panel lit and said goes with it
    if (inst.state.forgeLit) inst.state.forgeLit = null;
    runsMap.destroy();
    inst.emit('proposal:waiting-reset');
    inst.emit('work:waiting', { total: 0 });
    if (on) inst.emit('work:available', { on: false }); // the account menu's Proposals entry is the way to the proposals again
    try { unregisterSheet(inst, 'forge', false); } catch { /* it was never registered */ }
    scope.destroy();
    for (const el of made) el.remove();
  }

  if (options.config) update({ config: options.config });

  return {
    elements: made,
    update,
    destroy,
    isOn: () => on,
    isForgeOpen: () => ui.open,
    openForge: (opts) => fn.openForge(opts),
    closeForge: (opts) => fn.closeForge(opts),
    toggleForge: () => fn.toggleForge(),
    refreshForge: (opts) => fn.refreshForge(opts),
    clearPull: () => fn.clearPull(),
    clearDeploy: () => fn.clearDeploy(),
    clearThread: () => fn.clearThread(),
    selectDeploy: (id) => fn.selectDeploy(id),
    openRunLink: (id) => fn.openRunLink(id),
    openIssueLink: (n) => fn.openIssueLink(n),
    openProposalStart: (slug, opener) => fn.openProposalStart(slug, opener),
    canStartAgent: () => fn.canStartAgent(),
    /** For tests: force reduced motion on or off for the runs' marks (null: follow the viewer's setting) */
    setReducedMotion: (v) => runsMap.setReducedMotion(v),
  };
}
