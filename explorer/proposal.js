/**
 * @module explorer/proposal
 *
 * The proposal overlay on the page (spec 0012 B2, TOPO-09): the picker that lists what the server
 * finds (`GET /proposals`), `/?proposal=<slug>` opening one directly, the bar with the counts chip,
 * the Before / Diff / After control, the problems a proposal has and a Close button that returns
 * to the plain map, plus the legend rows and picking a marked edge. What the three views show is
 * decided by scene.js (buildScene); where an added node sits by view.js; the pure parts (the chip's
 * words, the address, the panel rows) are in proposal-model.js and tested without a page.
 *
 *   state.baseNodes / baseEdges   topology.json, untouched
 *   state.proposal                the parsed proposal, or null
 *   state.nodes / state.edges     the base (copied) or `applyProposal(base, proposal)`
 *   state.proposalView            'before' | 'diff' | 'after'
 *
 * What-if editing (TOPO-11) keeps its own list of edits and calls `rebuildProposalMap(effective)`
 * with `applyEdits(state.proposal, edits)`: the map is redrawn from the edited proposal while
 * `state.proposal` stays the robot's.
 */

import { state, touchScene, viewEdges, nameOf, escHtml } from './state.js';
import { render, getScene, fitGraphToViewport, fitPadding, isNodeVisible, ensureFlowLoop, screenToWorld } from './render.js';
import { setMap } from './view.js';
import { closeDrawer, selectNode } from './panels.js';
import { MARK, edgePoint } from './scene.js';
import {
  PROPOSAL_VIEWS, MARKS, MARK_WORDS, chipText, parseProposalQuery, proposalPanelHtml, touchedIds,
} from './proposal-model.js';
import { applyProposal, edgeKey, proposalProblems, summarize } from '../core/proposal.js';
import { reviewWords } from './review-model.js';
import { collapseSheet } from './sheets.js';

const $ = (id) => document.getElementById(id);

/**
 * What-if editing (whatif.js, TOPO-11) plugs into the overlay here, so this file never imports it:
 *  - `effective(proposal)`   the proposal the map is drawn from: `proposal` with the maintainer's edits in (called when one opens, and on a plain rebuild)
 *  - `mark(applied, effective, proposal)`   puts the `edit` mark on what the edits added or removed, before the map is laid out
 *  - `beforeClose()`   returns false to keep the proposal open (it is asking whether to keep the edits)
 *  - `closed()`   the proposal was closed
 *  - `bar(open)`   the bar was drawn: redraw the editing controls
 */
export const hooks = { effective: null, mark: null, beforeClose: null, closed: null, bar: null };

/** Whether the open proposal's source goes in the address (see `showProposal`) */
let pinnedSource = false;

/** What the server listed last: `[{ slug, title, summary, spec, source, counts, errors, review, error? }]`, or null before the first answer */
let listing = null;
let listingProblem = null;

// ---------------------------------------------------------------------------
//  Loading and closing
// ---------------------------------------------------------------------------

/** Asks the server for the proposals it can serve */
export async function loadProposalList() {
  try {
    const res = await fetch('/proposals', { cache: 'no-store' });
    if (!res.ok) throw new Error(`GET /proposals answered ${res.status}`);
    listing = await res.json();
    listingProblem = null;
  } catch (err) {
    listing = null;
    listingProblem = err.message || String(err);
  }
  renderMenu();
  return listing;
}

/**
 * Opens a proposal by name: fetches it from the server and shows it. `source` is where the server found it
 * (`checkout` or a worktree's name); without one the server answers with the first it lists.
 * @returns {Promise<boolean>} whether it opened
 */
export async function openProposal(slug, source = null) {
  setMessage(`Opening ${slug} …`);
  try {
    const res = await fetch(`/proposals/${encodeURIComponent(slug)}.json${source ? `?source=${encodeURIComponent(source)}` : ''}`, { cache: 'no-store' });
    if (!res.ok) {
      let why = '';
      try { why = (await res.json()).error || ''; } catch { /* no body */ }
      throw new Error(res.status === 404 ? `No proposal called ${slug}${source ? ` in ${source}` : ''}.` : why || `The server answered ${res.status}.`);
    }
    const found = res.headers.get('X-Proposal-Source');
    showProposal(await res.json(), { slug, source: source || (found ? decodeURIComponent(found) : null), pinSource: !!source, view: 'diff', fit: true });
    return true;
  } catch (err) {
    console.error('Opening the proposal failed', err);
    setMessage(err.message || String(err), true);
    return false;
  }
}

/**
 * Puts a parsed proposal on the map. The map's nodes and edges become `applyProposal(base, proposal)`.
 * @param {object} proposal
 * @param {{slug?: string|null, source?: string|null, pinSource?: boolean, view?: 'before'|'diff'|'after', fit?: boolean}} [opts]
 *   `fit`: fit the camera to what the proposal touches and what it connects to (default true).
 *   `pinSource`: put `&source=` in the address (it was asked for by name; otherwise `/?proposal=<slug>` finds the same one)
 */
export function showProposal(proposal, { slug = null, source = null, pinSource = false, view, fit = true } = {}) {
  state.proposal = proposal;
  state.proposalSlug = slug;
  state.proposalSource = source;
  pinnedSource = pinSource;
  if (view) state.proposalView = view;
  else if (!PROPOSAL_VIEWS.includes(state.proposalView)) state.proposalView = 'diff';
  rebuildProposalMap(hooks.effective ? hooks.effective(proposal) : proposal, { fit });
  syncAddress();
  closeMenu();
}

/**
 * Redraws the map from `proposal` laid over the base, and the bar from `state.proposal`. Call it
 * after anything the map is built from changes. `effective` is the proposal to apply: `state.proposal`,
 * or an edited copy of it (what-if edits, TOPO-11).
 * @param {object} [effective]
 * @param {{fit?: boolean}} [opts]
 */
export function rebuildProposalMap(effective = hooks.effective ? hooks.effective(state.proposal) : state.proposal, { fit = false } = {}) {
  const base = { nodes: state.baseNodes, edges: state.baseEdges };
  let applied;
  state.effectiveProposal = effective;
  try {
    state.proposalErrors = proposalProblems(base, effective).errors;
    applied = applyProposal(base, effective);
    if (hooks.mark) hooks.mark(applied, effective, state.proposal);
  } catch (err) {
    // A file so malformed that it cannot be read at all: the plain map, and the reason
    state.proposalErrors = [{ path: '', message: `This proposal could not be read: ${err.message}` }];
    applied = { nodes: state.baseNodes.map((n) => ({ ...n, mark: 'none' })), edges: state.baseEdges.map((e) => ({ ...e, mark: 'none' })) };
  }
  swapMap(applied.nodes, applied.edges);
  if (fit) fitToChange();
  render();
  ensureFlowLoop();
  renderBar();
}

/** Closes the proposal: the plain map comes back, as it was, and the address loses `?proposal=` */
export function closeProposal() {
  if (hooks.beforeClose && hooks.beforeClose() === false) return;
  state.proposal = null;
  state.effectiveProposal = null;
  state.proposalSlug = null;
  state.proposalSource = null;
  state.proposalErrors = [];
  swapMap(state.baseNodes.map((n) => ({ ...n })), state.baseEdges);
  fitGraphToViewport(fitPadding());
  render();
  ensureFlowLoop();
  renderBar();
  syncAddress();
  if (hooks.closed) hooks.closed();
}

/** Switches between Before, Diff and After; no node moves. Entering Diff fits the camera to the change. */
export function setProposalView(view) {
  if (!state.proposal || !PROPOSAL_VIEWS.includes(view) || state.proposalView === view) return;
  state.proposalView = view;
  touchScene();
  if (state.selectedNode && !isNodeVisible(state.selectedNode)) closeDrawer(); // it is not in this view
  if (view === 'diff') fitToChange();
  render();
  renderBar();
  syncAddress();
}

/** Hands the map new nodes and edges, keeping the selection on the same node */
function swapMap(nodes, edges) {
  const selected = state.selectedNode ? state.selectedNode.id : null;
  setMap(nodes, edges);
  state.selectedEdge = null;
  if (selected) {
    const again = state.nodes.find((n) => n.id === selected);
    if (again) state.selectedNode = again;
    else closeDrawer();
  }
  touchScene();
}

function fitToChange() {
  const { near, touched } = touchedIds(state.nodes, viewEdges());
  fitGraphToViewport(fitPadding(), touched.size ? near : null);
}

/** `?proposal=` (and `source`, `proposalView`) follow the open proposal, without a new history entry; other parameters stay */
function syncAddress() {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  try {
    const params = new URLSearchParams(location.search);
    ['proposal', 'source', 'proposalView'].forEach((k) => params.delete(k));
    if (state.proposal && state.proposalSlug) {
      params.set('proposal', state.proposalSlug);
      if (pinnedSource && state.proposalSource) params.set('source', state.proposalSource);
      if (state.proposalView !== 'diff') params.set('proposalView', state.proposalView);
    }
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  } catch { /* the address is a convenience */ }
}

// ---------------------------------------------------------------------------
//  The bar: title, counts chip, Before / Diff / After, problems, Close
// ---------------------------------------------------------------------------

/** One line in the bar instead of a proposal: while one opens, or why it did not */
function setMessage(text, isError = false) {
  const bar = $('proposal-bar');
  if (!bar) return;
  bar.hidden = false;
  bar.classList.toggle('is-error', isError);
  $('proposal-body').hidden = true;
  const msg = $('proposal-message');
  msg.hidden = false;
  msg.textContent = text;
}

/** The problems a proposal has, as the bar lists them (at most `max`, then "and N more") */
export function problemsHtml(errors, max = 8) {
  const shown = errors.slice(0, max).map((e) => `<li>${e.path ? `<code class="hx-code">${escHtml(e.path)}</code> ` : ''}${escHtml(e.message)}</li>`);
  if (errors.length > max) shown.push(`<li class="hx-faint">and ${errors.length - max} more</li>`);
  return shown.join('');
}

const asList = (v) => (Array.isArray(v) ? v : []);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function renderBar() {
  const bar = $('proposal-bar');
  if (!bar) return;
  const open = !!state.proposal;
  bar.hidden = !open;
  const legend = $('proposal-legend');
  if (legend) legend.hidden = !open;
  if (!open) { collapseSheet('proposal'); if (hooks.bar) hooks.bar(false); return; }

  bar.classList.remove('is-error');
  $('proposal-message').hidden = true;
  $('proposal-body').hidden = false;
  const p = state.proposal;
  $('proposal-title').textContent = (p && typeof p.title === 'string' && p.title) || state.proposalSlug || 'Proposal';
  const summary = $('proposal-summary');
  summary.textContent = (p && typeof p.summary === 'string' && p.summary) || '';
  summary.hidden = !summary.textContent;

  const counts = summarize(p);
  const chip = $('proposal-chip');
  chip.textContent = chipText(counts);
  chip.title = counts.scenarios ? `${plural(counts.scenarios, 'scenario')}. Click for the list of changes.` : 'Click for the list of changes.';

  for (const btn of bar.querySelectorAll('[data-action="proposal-view"]')) {
    const on = btn.dataset.view === state.proposalView;
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('is-on', on);
  }

  const errors = state.proposalErrors || [];
  const box = $('proposal-errors');
  box.hidden = errors.length === 0;
  if (errors.length) {
    $('proposal-errors-count').textContent = `${plural(errors.length, 'problem')} in this proposal`;
    $('proposal-errors-list').innerHTML = problemsHtml(errors);
  }
  renderChanges();
  if (hooks.bar) hooks.bar(true);
}

/** The list behind the chip: every marked node and edge, one row each, to pick one without finding it on the map */
function renderChanges() {
  const list = $('proposal-changes');
  if (!list) return;
  // The ownership edge a `parent` adds, and the edges of a removed node, are consequences: the list holds what the proposal says
  const said = new Set(['add', 'change', 'remove'].flatMap((op) => asList((state.effectiveProposal || state.proposal)?.edges?.[op]).map(edgeKey)));
  const rows = [];
  for (const mark of [...MARKS, 'edit']) {
    for (const n of state.nodes.filter((x) => x.mark === mark)) {
      rows.push(`<button type="button" class="hx-change-row" data-action="proposal-focus" data-kind="node" data-key="${escHtml(n.id)}"><span class="hx-mark-dot hx-mark-dot--${mark}"></span><span class="hx-change-what">${escHtml(MARK_WORDS[mark])}</span><span class="hx-name">${escHtml(n.label)}</span><span class="hx-faint">${escHtml(n.type)}</span></button>`);
    }
    for (const e of state.edges.filter((x) => x.mark === mark && said.has(edgeKey(x)))) {
      rows.push(`<button type="button" class="hx-change-row" data-action="proposal-focus" data-kind="edge" data-key="${escHtml(edgeKey(e))}"><span class="hx-mark-dot hx-mark-dot--${mark}"></span><span class="hx-change-what">${escHtml(MARK_WORDS[mark])}</span><span class="hx-name">${escHtml(nameOf(e.from))} → ${escHtml(nameOf(e.to))}</span><span class="hx-faint">${escHtml(e.kind || 'ownership')}</span></button>`);
    }
  }
  list.innerHTML = rows.join('') || '<p class="hx-faint">This proposal changes nothing on the map.</p>';
}

function toggleChanges() {
  const list = $('proposal-changes');
  if (!list) return;
  list.hidden = !list.hidden;
  $('proposal-chip').setAttribute('aria-expanded', String(!list.hidden));
}

/** Picks a row of the changes list: select it, centre on it, and make sure the current view shows it */
function focusChange(kind, key) {
  const item = kind === 'edge' ? state.edges.find((e) => edgeKey(e) === key) : state.nodes.find((n) => n.id === key);
  if (!item) return;
  const ends = (kind === 'edge' ? [state.nodes.find((n) => n.id === item.from), state.nodes.find((n) => n.id === item.to)] : [item]).filter(Boolean);
  if (!ends.length) return;
  if (state.proposalView !== 'diff' && ends.some((n) => !isNodeVisible(n))) setProposalView('diff'); // Before or After hides what it removes or adds
  const at = { x: ends.reduce((s, n) => s + n.x, 0) / ends.length, y: ends.reduce((s, n) => s + n.y, 0) / ends.length };
  state.camera.x = state.width / 2 - at.x * state.camera.zoom;
  state.camera.y = state.height / 2 - at.y * state.camera.zoom;
  if (kind === 'edge') showEdgePanel(item);
  else selectNode(item);
}

// ---------------------------------------------------------------------------
//  The picker
// ---------------------------------------------------------------------------

function menuOpen() {
  const menu = $('proposal-menu');
  return !!menu && !menu.hidden;
}

function closeMenu() {
  const menu = $('proposal-menu');
  if (menu) menu.hidden = true;
  const btn = $('proposal-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

async function toggleMenu() {
  const menu = $('proposal-menu');
  if (!menu) return;
  if (menuOpen()) return closeMenu();
  menu.hidden = false;
  $('proposal-btn').setAttribute('aria-expanded', 'true');
  if (!listing) renderMenu(true);
  await loadProposalList(); // always ask again: worktrees come and go
}

const where = (source) => (source === 'checkout' ? 'In the checkout' : `In worktree ${source}`);

/** One row of the picker */
export function proposalRowHtml(entry, current) {
  const mine = current && current.slug === entry.slug && current.source === entry.source;
  const head = `<span class="hx-proposal-title">${escHtml(entry.title || entry.slug)}</span>`;
  const meta = [`<span class="hx-proposal-where">${escHtml(where(entry.source))}</span>`];
  if (entry.spec) meta.push(`<span>spec ${escHtml(entry.spec)}</span>`);
  if (entry.error) {
    return `<div class="hx-proposal-item is-broken">${head}<span class="hx-proposal-sum hx-error-text">${escHtml(entry.error)}</span><span class="hx-proposal-meta">${meta.join('')}</span></div>`;
  }
  if (entry.counts) meta.push(`<span>${escHtml(chipText(entry.counts))}</span>`);
  const reviewed = reviewWords(entry.review, Date.now()); // "Approved 3 minutes ago", from the listing
  if (reviewed) meta.push(`<span class="hx-proposal-reviewed">${escHtml(reviewed)}</span>`);
  if (entry.errors) meta.push(`<span class="hx-warn">${escHtml(plural(entry.errors, 'problem'))}</span>`);
  return `<button type="button" class="hx-proposal-item${mine ? ' is-current' : ''}" data-action="open-proposal" data-slug="${escHtml(entry.slug)}" data-source="${escHtml(entry.source)}">${head}${entry.summary ? `<span class="hx-proposal-sum">${escHtml(entry.summary)}</span>` : ''}<span class="hx-proposal-meta">${meta.join('')}</span></button>`;
}

function renderMenu(loading = false) {
  const menu = $('proposal-menu');
  if (!menu) return;
  const current = state.proposal ? { slug: state.proposalSlug, source: state.proposalSource } : null;
  let body;
  if (loading && !listing) body = '<p class="hx-faint hx-proposal-empty">Looking for proposals …</p>';
  else if (listingProblem) body = `<p class="hx-error-text hx-proposal-empty">The list could not be loaded: ${escHtml(listingProblem)}</p>`;
  else if (!listing || listing.length === 0) body = '<p class="hx-faint hx-proposal-empty">No proposals</p>';
  else body = `<div class="hx-proposal-list" role="list">${listing.map((e) => `<div role="listitem">${proposalRowHtml(e, current)}</div>`).join('')}</div>`;
  menu.innerHTML = `<div class="hx-menu-title hx-menu-head"><span>Proposals</span></div>${body}`;
}

// ---------------------------------------------------------------------------
//  Picking an edge, and its panel
// ---------------------------------------------------------------------------

/** The kind a scene edge reports for an applied one (an ownership link has none) */
const kindOf = (e) => e.kind || (e.dashed ? 'usage' : 'ownership');

/**
 * The marked edge under a point of the map, or null: the nearest one within `tolerance` world units,
 * measured along the drawn curve. Only the edges of the current scene, so a hidden one is never hit.
 * @param {number} x world
 * @param {number} y world
 * @param {number} tolerance world units
 */
export function markedEdgeAt(x, y, tolerance) {
  let best = null;
  let bestDistance = tolerance;
  for (const edge of getScene().edges) {
    if (edge.mark === 'none') continue;
    for (let k = 0; k <= 1; k += 1 / 20) {
      const p = edgePoint(edge, k);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= bestDistance) { best = edge; bestDistance = d; }
    }
  }
  if (!best) return null;
  return viewEdges().find((e) => e.from === best.from && e.to === best.to && kindOf(e) === best.kind) || null;
}

/** Fills the side panel for an edge: what it is, and what the proposal says about it */
export function showEdgePanel(edge) {
  closeDrawer(); // clears a node selection and any panel still loading
  state.selectedEdge = edge;
  const row = (label, value) => (value ? `<div class="hx-prop"><div class="hx-prop-head"><span class="hx-accent hx-bold">${escHtml(label)}</span><span>${escHtml(value)}</span></div></div>` : '');

  $('drawer-title').textContent = `${nameOf(edge.from)} → ${nameOf(edge.to)}`;
  $('drawer-badge').textContent = 'EDGE';
  $('drawer-description').textContent = edge.label || '';
  $('drawer-props-list').innerHTML = row('Kind', kindOf(edge)) + row('Flow', edge.flow) + row('Label', edge.label) + row('Reads', Array.isArray(edge.keys) ? edge.keys.join(', ') : '');
  $('drawer-meta-list').innerHTML = `${proposalPanelHtml(edge)}
    <div><strong class="hx-strong">From:</strong> <button type="button" class="hx-linkbtn" data-action="select-node" data-id="${escHtml(edge.from)}">${escHtml(nameOf(edge.from))}</button></div>
    <div><strong class="hx-strong">To:</strong> <button type="button" class="hx-linkbtn" data-action="select-node" data-id="${escHtml(edge.to)}">${escHtml(nameOf(edge.to))}</button></div>`;
  const open = $('drawer-open-btn');
  open.removeAttribute('href');
  open.textContent = 'A link between two nodes';
  $('spec-drawer').classList.add('drawer-open');
  $('drawer-backdrop').hidden = false;
  touchScene();
  render();
}

/** A click on the canvas that picks no node but lands on a marked edge opens that edge */
function bindEdgePicking() {
  const canvas = state.canvas;
  if (!canvas) return;
  let down = null;
  canvas.addEventListener('mousedown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('click', (e) => {
    if (!state.proposal || state.proposalView === 'before') return; // Before has no marked edges
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // a drag
    const rect = canvas.getBoundingClientRect();
    const p = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const zoom = state.camera.zoom;
    const onNode = state.nodes.some((n) => isNodeVisible(n) && Math.hypot(n.x - p.x, n.y - p.y) <= n.r + 6 / zoom);
    if (onNode) return; // a node: the map's own selection handles it
    const edge = markedEdgeAt(p.x, p.y, 8 / zoom);
    if (edge) showEdgePanel(edge);
  });
}

// ---------------------------------------------------------------------------
//  Wiring
// ---------------------------------------------------------------------------

const ACTIONS = {
  'toggle-proposals-menu': () => toggleMenu(),
  'open-proposal': (el) => openProposal(el.dataset.slug, el.dataset.source || null),
  'close-proposal': () => closeProposal(),
  'proposal-view': (el) => setProposalView(el.dataset.view),
  'toggle-proposal-changes': () => toggleChanges(),
  'proposal-focus': (el) => focusChange(el.dataset.kind, el.dataset.key),
};

function onClick(e) {
  const target = e.target.closest ? e.target.closest('[data-action]') : null;
  const action = target && ACTIONS[target.dataset.action];
  if (action) action(target);
  // Any click outside the picker closes it
  const wrap = $('proposal-wrap');
  if (menuOpen() && wrap && !wrap.contains(e.target)) closeMenu();
}

function onKey(e) {
  if (e.key === 'Escape' && menuOpen()) closeMenu();
}

/**
 * Starts the overlay: the mark colours the legend and the panel use, the buttons, picking an
 * edge, and `/?proposal=<slug>` (and `&source=`, `&proposalView=`) when the address asks for one.
 * Call once the map has loaded (the proposal is laid over it).
 * @returns {Promise<boolean>} whether a proposal from the address opened (false when it asked for none)
 */
export async function initProposals() {
  const root = document.documentElement.style;
  for (const mark of Object.keys(MARK)) root.setProperty(`--hx-mark-${mark}`, MARK[mark].color);

  // Once, however many times this runs
  document.removeEventListener('click', onClick);
  document.removeEventListener('keydown', onKey);
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  bindEdgePicking();
  renderBar();

  const asked = parseProposalQuery(location.search);
  if (!asked) return false;
  const ok = await openProposal(asked.slug, asked.source);
  if (ok && asked.view) setProposalView(asked.view);
  return ok;
}

