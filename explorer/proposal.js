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
import { render, getScene, fitGraphToViewport, fitPadding, isNodeVisible, ensureFlowLoop, screenToWorld, getMinZoom } from './render.js';
import { frameNodes, largestGroup, READ_ZOOM, FRAME_ZOOM_MIN } from './camera.js';
import { setMap } from './view.js';
import { closeDrawer, selectNode } from './panels.js';
import { edgePoint, looksFor } from './scene.js';
import { onThemeChange } from './theme.js';
import { looksWith, onMapStyleChange } from './map-style.js';
import {
  PROPOSAL_VIEWS, MARKS, MARK_WORDS, chipText, barCounts, parseProposalQuery, proposalPanelHtml, touchedIds,
  sourceChip, pullNumberOf, notFoundWords, otherCopies, malformedLinkWords,
} from './proposal-model.js';
import { applyProposal, edgeKey, proposalProblems, summarize } from '../core/proposal.js';
import { reviewWords } from './review-model.js';
import { collapseSheet, visibleMapRect, isPhone } from './sheets.js';
import { t } from './strings.js';

const $ = (id) => document.getElementById(id);

/**
 * What-if editing (whatif.js, TOPO-11) plugs into the overlay here, so this file never imports it:
 *  - `effective(proposal)`   the proposal the map is drawn from: `proposal` with the maintainer's edits in (called when one opens, and on a plain rebuild)
 *  - `mark(applied, effective, proposal)`   puts the `edit` mark on what the edits added or removed, before the map is laid out
 *  - `beforeClose()`   returns false to keep the proposal open (it is asking whether to keep the edits)
 *  - `closed()`   the proposal was closed
 *  - `bar(open)`   the bar was drawn: redraw the editing controls
 *  - `openSpecs()`   the Work panel's Specs tab, for a bad link's way on (forge-panel.js sets it; without it the header's Proposals menu opens)
 */
export const hooks = { effective: null, mark: null, beforeClose: null, closed: null, bar: null, openSpecs: null };

/** Whether the open proposal's source goes in the address (see `showProposal`) */
let pinnedSource = false;

/** What the server listed last: `[{ slug, title, summary, spec, source, counts, errors, review, error? }]`, or null before the first answer */
let listing = null;
let listingProblem = null;
/** Why the server left the open spec PRs out of the last listing (the forge could not be asked), or null */
let forgeProblem = null;
/** When the listing was last read (ms), and who wants to hear of a new one (the Work panel's Specs tab, forge-panel.js) */
let listingAt = 0;
const listingWatchers = new Set();

/** What the server listed last, for the Work panel's Specs tab: the entries (null before the first answer), why the list could not be read, why the spec PRs are missing, and when */
export const proposalListing = () => ({ entries: listing, problem: listingProblem, forgeProblem, at: listingAt });
/** Calls `fn` each time the list is read again; returns the way to stop */
export function onProposalListing(fn) {
  listingWatchers.add(fn);
  return () => listingWatchers.delete(fn);
}

// ---------------------------------------------------------------------------
//  Loading and closing
// ---------------------------------------------------------------------------

/** Asks the server for the proposals it can serve */
export async function loadProposalList() {
  try {
    const res = await fetch('/proposals', { cache: 'no-store' });
    if (!res.ok) throw new Error(`GET /proposals answered ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error('GET /proposals did not answer with a list');
    listing = body;
    listingProblem = null;
    const said = res.headers.get('X-Proposals-Forge-Error');
    forgeProblem = said ? decodeURIComponent(said) : null;
  } catch (err) {
    listing = null;
    forgeProblem = null;
    listingProblem = err.message || String(err);
  }
  listingAt = Date.now();
  renderMenu();
  for (const fn of listingWatchers) fn();
  return listing;
}

/**
 * Opens a proposal by name: fetches it from the server and shows it. `source` is where the server found it
 * (`checkout` or a worktree's name); without one the server answers with the first it lists.
 * @returns {Promise<boolean>} whether it opened
 */
export async function openProposal(slug, source = null) {
  const token = ++openToken;
  setMessage(`Opening ${slug} …`);
  try {
    const res = await fetch(`/proposals/${encodeURIComponent(slug)}.json${source ? `?source=${encodeURIComponent(source)}` : ''}`, { cache: 'no-store' });
    if (!res.ok) {
      let why = '';
      try { why = (await res.json()).error || ''; } catch { /* no body */ }
      const err = new Error(res.status === 404 ? notFoundWords(slug, source) : why || `The server answered ${res.status}.`);
      err.notFound = res.status === 404;
      throw err;
    }
    const found = res.headers.get('X-Proposal-Source');
    showProposal(await res.json(), { slug, source: source || (found ? decodeURIComponent(found) : null), pinSource: !!source, view: 'diff', fit: true });
    return true;
  } catch (err) {
    console.error('Opening the proposal failed', err);
    // Said plainly, with the ways on: the Specs list, and the same name under another source when the list has one
    setMessage(err.message || String(err), true, err.notFound ? [specsWay()] : []);
    if (err.notFound && token === openToken) {
      await loadProposalList();
      const sources = new Set((Array.isArray(listing) ? listing : []).map((e) => e && e.source));
      if (token === openToken) setMessage(notFoundWords(slug, source, sources), true, [...otherCopies(listing, slug, source).map((c) => ({ label: c.label, way: 'open', slug: c.slug, source: c.source })), specsWay()]);
    }
    return false;
  }
}

/** The way on every bad link offers: the list of specs */
const specsWay = () => ({ label: t('openSpecsList'), way: 'specs' });
/** Which `openProposal` is the latest, so a slow answer never writes over a newer one */
let openToken = 0;

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
  renderBar(); // first: the fit below leaves out what the bar covers, so the bar must be laid out
  if (fit) fitToChange();
  render();
  ensureFlowLoop();
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

/**
 * Frames what the proposal changes (nodes added, changed or removed, and both ends of a changed edge; not what they connect to) in the part of the
 * map nothing covers (the bar, the node panel, a phone's sheets), at a zoom up to 1 so their labels read. Only what is drawn counts: a change on a
 * layer that is off is not framed (the map would centre on ground the viewer cannot see). When the change is wider than FRAME_ZOOM_MIN shows,
 * the biggest part of it that fits there is framed, not the whole at a zoom where it is a speck (the change list reaches the rest). A proposal that changes nothing drawn shows the whole map.
 */
function fitToChange() {
  const { touched } = touchedIds(state.nodes, viewEdges());
  const items = state.nodes.filter((n) => touched.has(n.id) && isNodeVisible(n));
  const rect = visibleMapRect();
  const opts = { padding: fitPadding(), maxZoom: 1, minZoom: getMinZoom() };
  // The whole change when it fits at FRAME_ZOOM_MIN or closer; else the biggest part of it that does (camera.js)
  const group = largestGroup(items, rect, { ...opts, minZoom: Math.max(opts.minZoom, FRAME_ZOOM_MIN) });
  const cam = items.length ? frameNodes(group, rect, opts) : null;
  if (!cam) { fitGraphToViewport(fitPadding()); return; }
  Object.assign(state.camera, cam);
  render();
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

/** One line in the bar instead of a proposal: while one opens, or why it did not (with `ways`, the buttons that go on from there) */
function setMessage(text, isError = false, ways = []) {
  const bar = $('proposal-bar');
  if (!bar) return;
  bar.hidden = false;
  bar.classList.toggle('is-error', isError);
  $('proposal-body').hidden = true;
  const msg = $('proposal-message');
  msg.hidden = false;
  msg.textContent = text;
  const box = $('proposal-ways');
  if (!box) return;
  box.hidden = ways.length === 0;
  box.innerHTML = ways.map((w) => `<button type="button" class="hx-btn" data-action="proposal-way" data-way="${escHtml(w.way)}"${w.slug ? ` data-slug="${escHtml(w.slug)}"` : ''}${w.source ? ` data-source="${escHtml(w.source)}"` : ''} data-peek-ok data-corn-kind="quiet">${escHtml(w.label)}</button>`).join('');
}

// ---------------------------------------------------------------------------
//  Which copy is open: the chip after the title
// ---------------------------------------------------------------------------

/** The spec PRs read for the chip, by number: `{ pull, checks }` of `GET /api/forge/pulls/<n>`; kept, so a proposal opened again shows it at once and then asks again */
const pullInfo = new Map();
/** The proposal the PR was last asked for (`source/slug`): asked again when another opens, not each time the bar is drawn */
let pullAskedFor = null;

const safeHref = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

/** The chip says which copy is under review: a PR (number, draft or open, the checks in words) linking to it, or a local draft and where. It only tells. */
function paintSource() {
  const chip = $('proposal-source');
  if (!chip) return;
  const source = state.proposal ? state.proposalSource : null;
  chip.hidden = !source;
  if (!source) return;
  const n = pullNumberOf(source);
  const known = n ? pullInfo.get(n) : null;
  const entry = n && Array.isArray(listing) ? listing.find((e) => e.slug === state.proposalSlug && e.source === source) : null;
  const words = sourceChip(source, (known && known.pull) || (entry && entry.pull) || null, known ? known.checks : null);
  chip.textContent = words.text;
  if (words.state) chip.dataset.cornState = words.state; else delete chip.dataset.cornState;
  const href = safeHref(words.href);
  if (href) { chip.setAttribute('href', href); chip.setAttribute('target', '_blank'); chip.setAttribute('rel', 'noreferrer'); chip.title = 'Open this pull request'; } else {
    chip.removeAttribute('href'); chip.removeAttribute('target'); chip.removeAttribute('rel'); chip.title = words.label;
  }
  const key = `${source}/${state.proposalSlug}`;
  if (n && pullAskedFor !== key) { pullAskedFor = key; loadPullInfo(n); }
}

/** Reads the PR's state and checks once for this opening of the bar (the server keeps its own short cache); a forge that cannot say leaves the chip as it is */
async function loadPullInfo(n) {
  try {
    const res = await fetch(`/api/forge/pulls/${n}`);
    const body = res.ok ? await res.json() : null;
    if (body && body.ok !== false && body.pull) pullInfo.set(n, { pull: body.pull, checks: Array.isArray(body.checks) ? body.checks : null });
  } catch { /* no forge, or not signed in: the chip keeps what it has */ }
  if (state.proposal && pullNumberOf(state.proposalSource) === n) paintSource();
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
  if (!open) { closeMore(); toggleMode(false); collapseSheet('proposal'); if (hooks.bar) hooks.bar(false); return; }

  bar.classList.remove('is-error');
  $('proposal-message').hidden = true;
  $('proposal-body').hidden = false;
  const p = state.proposal;
  $('proposal-title').textContent = (p && typeof p.title === 'string' && p.title) || state.proposalSlug || 'Proposal';
  paintSource();
  const summary = $('proposal-summary');
  summary.textContent = (p && typeof p.summary === 'string' && p.summary) || '';
  const title = $('proposal-title');
  title.title = summary.textContent; // the toolbar stays one row: the summary is the title's tooltip, and shows above the list of changes
  summary.hidden = !summary.textContent || $('proposal-changes').hidden;

  const counts = summarize(p);
  const chip = $('proposal-chip');
  chip.innerHTML = barCounts(counts).map((c) => `${c.mark ? `<span class="hx-mark-dot hx-mark-dot--${c.mark}" aria-hidden="true"></span>` : ''}${escHtml(c.text)}`).join('<span class="hx-proposal-sep" aria-hidden="true"> · </span>');
  chip.title = 'Click for the list of changes.';
  $('proposal-mode').textContent = t(state.proposalView);

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
      rows.push(`<button type="button" class="hx-change-row" data-action="proposal-focus" data-kind="node" data-key="${escHtml(n.id)}" data-corn="row"><span class="hx-mark-dot hx-mark-dot--${mark}"></span><span class="hx-change-what">${escHtml(MARK_WORDS[mark])}</span><span class="hx-name">${escHtml(n.label)}</span><span class="hx-faint">${escHtml(n.type)}</span></button>`);
    }
    for (const e of state.edges.filter((x) => x.mark === mark && said.has(edgeKey(x)))) {
      rows.push(`<button type="button" class="hx-change-row" data-action="proposal-focus" data-kind="edge" data-key="${escHtml(edgeKey(e))}" data-corn="row"><span class="hx-mark-dot hx-mark-dot--${mark}"></span><span class="hx-change-what">${escHtml(MARK_WORDS[mark])}</span><span class="hx-name">${escHtml(nameOf(e.from))} → ${escHtml(nameOf(e.to))}</span><span class="hx-faint">${escHtml(e.kind || 'ownership')}</span></button>`);
    }
  }
  list.innerHTML = rows.join('') || '<p class="hx-faint">This proposal changes nothing on the map.</p>';
}

function toggleChanges(refocus = false) {
  const list = $('proposal-changes');
  if (!list) return;
  list.hidden = !list.hidden;
  $('proposal-summary').hidden = list.hidden || !$('proposal-summary').textContent;
  $('proposal-chip').setAttribute('aria-expanded', String(!list.hidden));
  // The list sits after the toolbar's buttons in the page, so focus goes into it when it opens (its first row), and back to the chip when it closes by Escape
  if (!list.hidden) { if (!isPhone()) list.querySelector('button')?.focus(); } else if (refocus) $('proposal-chip').focus();
}

/**
 * Picks a row of the changes list: select it, centre it in the part of the map the open list, the node panel and (on a phone) the sheets leave free,
 * at a zoom where its label reads, and make sure the current view shows it
 */
function focusChange(kind, key) {
  const item = kind === 'edge' ? state.edges.find((e) => edgeKey(e) === key) : state.nodes.find((n) => n.id === key);
  if (!item) return;
  const ends = (kind === 'edge' ? [state.nodes.find((n) => n.id === item.from), state.nodes.find((n) => n.id === item.to)] : [item]).filter(Boolean);
  if (!ends.length) return;
  if (state.proposalView !== 'diff' && ends.some((n) => !isNodeVisible(n))) setProposalView('diff'); // Before or After hides what it removes or adds
  if (kind === 'edge') showEdgePanel(item);
  else selectNode(item);
  // The panel is open now, so what it covers is known
  const cam = frameNodes(ends, visibleMapRect(), { padding: fitPadding(), maxZoom: Math.max(READ_ZOOM, state.camera.zoom), minZoom: getMinZoom() });
  if (cam) Object.assign(state.camera, cam);
  render();
}

// ---------------------------------------------------------------------------
//  The ⋯ menu (a menu button) and the phone's Before / Diff / After switcher
// ---------------------------------------------------------------------------

const moreItems = () => [...document.querySelectorAll('#proposal-more-menu [role="menuitem"]')];

function moreOpen() {
  const menu = $('proposal-more-menu');
  return !!menu && !menu.hidden;
}

/** Closes the ⋯ menu; `refocus` puts focus back on its button (Escape, or a choice made) */
function closeMore(refocus = false) {
  const menu = $('proposal-more-menu');
  const btn = $('proposal-more');
  if (menu) menu.hidden = true;
  if (btn) { btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus(); }
}

function openMore(which = 'first') {
  const menu = $('proposal-more-menu');
  if (!menu) return;
  menu.hidden = false;
  $('proposal-more').setAttribute('aria-expanded', 'true');
  const items = moreItems();
  (which === 'last' ? items[items.length - 1] : items[0])?.focus();
}

/** On a phone the mode button shows the compare switcher under the counts; from 768px the switcher is always there */
function toggleMode(force) {
  const bar = $('proposal-bar');
  const on = typeof force === 'boolean' ? force : bar.dataset.modeOpen !== 'true';
  bar.dataset.modeOpen = String(on);
  $('proposal-mode').setAttribute('aria-expanded', String(on));
}

function onMoreKey(e) {
  const btn = $('proposal-more');
  if (e.target === btn && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); openMore(e.key === 'ArrowUp' ? 'last' : 'first'); return; }
  if (!moreOpen()) return;
  if (e.key === 'Escape') { e.preventDefault(); closeMore(true); return; }
  if (e.key === 'Tab') { closeMore(); return; }
  const items = moreItems();
  const at = items.indexOf(document.activeElement);
  if (at < 0) return;
  const next = { ArrowDown: (at + 1) % items.length, ArrowUp: (at - 1 + items.length) % items.length, Home: 0, End: items.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  items[next].focus();
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

function where(entry) {
  if (entry.pull) return `Spec PR #${entry.pull.number}${entry.pull.draft ? ' (draft)' : ''}${entry.pull.author ? ` by ${entry.pull.author}` : ''}`;
  return entry.source === 'checkout' ? 'In the checkout' : `In worktree ${entry.source}`;
}

/** One row of the picker */
export function proposalRowHtml(entry, current) {
  const mine = current && current.slug === entry.slug && current.source === entry.source;
  const head = `<span class="hx-proposal-title">${escHtml(entry.title || entry.slug)}</span>`;
  const meta = [`<span class="hx-proposal-where">${escHtml(where(entry))}</span>`];
  if (entry.spec) meta.push(`<span>spec ${escHtml(entry.spec)}</span>`);
  if (entry.error) {
    return `<div class="hx-proposal-item is-broken" data-corn="row">${head}<span class="hx-proposal-sum hx-error-text">${escHtml(entry.error)}</span><span class="hx-proposal-meta">${meta.join('')}</span></div>`;
  }
  if (entry.counts) meta.push(`<span>${escHtml(chipText(entry.counts))}</span>`);
  const reviewed = reviewWords(entry.review, Date.now()); // "Approved 3 minutes ago", from the listing
  if (reviewed) meta.push(`<span class="hx-proposal-reviewed">${escHtml(reviewed)}</span>`);
  if (entry.errors) meta.push(`<span class="hx-warn">${escHtml(plural(entry.errors, 'problem'))}</span>`);
  return `<button type="button" class="hx-proposal-item${mine ? ' is-current' : ''}" data-action="open-proposal" data-slug="${escHtml(entry.slug)}" data-source="${escHtml(entry.source)}" data-corn="row">${head}${entry.summary ? `<span class="hx-proposal-sum">${escHtml(entry.summary)}</span>` : ''}<span class="hx-proposal-meta">${meta.join('')}</span></button>`;
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
  const forge = forgeProblem && !listingProblem ? `<p class="hx-error-text hx-proposal-empty">The spec PRs could not be listed: ${escHtml(forgeProblem)}</p>` : '';
  menu.innerHTML = `<div class="hx-menu-title hx-menu-head"><span>${escHtml(t('proposals'))}</span></div>${forge}${body}`;
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
  const row = (label, value) => (value ? `<div class="hx-fact"><div class="hx-fact-k">${escHtml(label)}</div><div class="hx-fact-v">${escHtml(value)}</div></div>` : '');
  const facts = row('Kind', kindOf(edge)) + row('Flow', edge.flow) + row('Label', edge.label) + row('Reads', Array.isArray(edge.keys) ? edge.keys.join(', ') : '');

  $('drawer-title').textContent = `${nameOf(edge.from)} → ${nameOf(edge.to)}`;
  $('drawer-title').classList.remove('hx-mono');
  $('drawer-badge').textContent = 'Edge';
  $('drawer-host').textContent = '';
  $('drawer-diff').hidden = true;
  $('drawer-description').textContent = '';
  $('drawer-description').hidden = true;
  $('drawer-meta-list').innerHTML = `${facts ? `<div class="hx-facts">${facts}</div>` : ''}
    <div class="hx-facts">
      <div class="hx-fact"><div class="hx-fact-k">From</div><div class="hx-fact-v"><button type="button" class="hx-linkbtn" data-action="select-node" data-id="${escHtml(edge.from)}">${escHtml(nameOf(edge.from))}</button></div></div>
      <div class="hx-fact"><div class="hx-fact-k">To</div><div class="hx-fact-v"><button type="button" class="hx-linkbtn" data-action="select-node" data-id="${escHtml(edge.to)}">${escHtml(nameOf(edge.to))}</button></div></div>
    </div>${proposalPanelHtml(edge)}`;
  $('drawer-open-btn').hidden = true;
  $('drawer-file-btn').hidden = true;
  $('drawer-run-btn').hidden = true;
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
  'proposal-view': (el) => { setProposalView(el.dataset.view); toggleMode(false); },
  'toggle-proposal-mode': () => toggleMode(),
  'toggle-proposal-more': () => (moreOpen() ? closeMore() : openMore()),
  'toggle-proposal-changes': () => toggleChanges(),
  'proposal-way': (el) => (el.dataset.way === 'open' ? openProposal(el.dataset.slug, el.dataset.source || null) : openSpecs()),
  'proposal-focus': (el) => focusChange(el.dataset.kind, el.dataset.key),
};

function onClick(e) {
  const target = e.target.closest ? e.target.closest('[data-action]') : null;
  const action = target && ACTIONS[target.dataset.action];
  if (action) action(target);
  // A choice in the ⋯ menu closes it back onto its button (Close may stop at the what-if confirm); a click anywhere else just closes it
  if (moreOpen() && !(target && target.dataset.action === 'toggle-proposal-more')) closeMore(!!(target && target.closest('#proposal-more-menu')));
  // Any click outside the picker closes it
  const wrap = $('proposal-wrap');
  if (menuOpen() && wrap && !wrap.contains(e.target) && !(target && target.dataset.action === 'proposal-way')) closeMenu(); // (a bad link's Specs list opens it from outside)
}

/** A bad link's way on: the Work panel's Specs tab when there is one, else the header's Proposals menu */
function openSpecs() {
  if (hooks.openSpecs) { hooks.openSpecs(); return; }
  if (!menuOpen()) toggleMenu();
}

function onKey(e) {
  if (e.key === 'Escape' && menuOpen()) closeMenu();
  onMoreKey(e);
  // Escape inside the list of changes folds it back onto its chip
  const list = $('proposal-changes');
  if (e.key === 'Escape' && !e.defaultPrevented && list && !list.hidden && list.contains(document.activeElement)) { e.preventDefault(); toggleChanges(true); }
  if (e.key === 'Tab' && !e.defaultPrevented && !e.ctrlKey && !e.metaKey && !e.altKey) tabThroughList(e);
}

/** The lists the toolbar opens, each after the button that opens it: the changes (the counts) and the scenarios (Play) */
const OPENERS = [['proposal-chip', 'proposal-changes'], ['proposal-play', 'proposal-scenarios']];
const TABBABLE = 'button, a[href], input, select, textarea, summary, [tabindex]';
const canTab = (el) => el.tabIndex >= 0 && !el.disabled && !el.closest('[hidden]') && (typeof el.checkVisibility !== 'function' || el.checkVisibility());
const tabbables = (root) => [...root.querySelectorAll(TABBABLE)].filter(canTab);

/**
 * An open list sits in the page under the whole toolbar, so Tab would reach it only after Approve and ⋯ (WCAG 2.4.3). The bar's Tab order is
 * the page's with each open list moved to right after the button that opened it: Tab goes from the button into the list, from its last row on
 * to the toolbar's next control, and Shift+Tab the same way back. Where that order and the page's agree, the browser moves the focus itself.
 */
function tabThroughList(e) {
  const bar = $('proposal-bar');
  if (!bar || bar.hidden) return;
  const open = OPENERS.map(([b, l]) => [$(b), $(l)]).filter(([btn, list]) => btn && list && !list.hidden && bar.contains(list) && canTab(btn));
  if (!open.length) return;
  const all = tabbables(bar);
  let order = all.filter((el) => !open.some(([, list]) => list.contains(el)));
  for (const [btn, list] of open) {
    const at = order.indexOf(btn);
    if (at >= 0) order = [...order.slice(0, at + 1), ...all.filter((el) => list.contains(el)), ...order.slice(at + 1)];
  }
  const active = document.activeElement;
  let to = null;
  if (active && bar.contains(active)) {
    const i = order.indexOf(active);
    if (i < 0) return;
    const next = order[i + (e.shiftKey ? -1 : 1)];
    const natural = all[all.indexOf(active) + (e.shiftKey ? -1 : 1)];
    if (next === natural) return;
    if (next) to = next;
    else if (!e.shiftKey) to = tabbables(document).find((el) => !bar.contains(el) && (bar.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) || null; // out of the bar, past the list's rows
  } else if (e.shiftKey && active) {
    // Coming back into the bar from after it: its last control in this order, not the last row of a list
    const page = tabbables(document);
    const prev = page[page.indexOf(active) - 1];
    if (prev && bar.contains(prev) && prev !== order[order.length - 1]) to = order[order.length - 1];
  }
  if (to) { e.preventDefault(); to.focus(); }
}

/** The marks' colours for the legend and the panel (the --hx-mark-* variables), the same the map draws on this ground */
function setMarkColours(theme) {
  const root = document.documentElement.style;
  const { mark: looks } = looksWith(looksFor(theme)); // the theme's --corn-map-added|changed|removed|edit, when it sets them
  for (const mark of Object.keys(looks)) root.setProperty(`--hx-mark-${mark}`, looks[mark].color);
}
let stopMarkColours = null;
let stopMarkStyle = null;

/**
 * Starts the overlay: the mark colours the legend and the panel use, the buttons, picking an
 * edge, and `/?proposal=<slug>` (and `&source=`, `&proposalView=`) when the address asks for one.
 * Call once the map has loaded (the proposal is laid over it).
 * @returns {Promise<boolean>} whether a proposal from the address opened (false when it asked for none)
 */
export async function initProposals() {
  setMarkColours(state.theme);
  if (!stopMarkColours) stopMarkColours = onThemeChange(setMarkColours);
  if (!stopMarkStyle) stopMarkStyle = onMapStyleChange(() => setMarkColours(state.theme)); // a theme stylesheet that finishes loading later

  // Once, however many times this runs
  document.removeEventListener('click', onClick);
  document.removeEventListener('keydown', onKey);
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  bindEdgePicking();
  renderBar();

  const asked = parseProposalQuery(location.search);
  if (!asked) {
    // A link whose `proposal` is not a proposal's name: said plainly (the value as text, never markup or a link), with the Specs list
    const bad = malformedLinkWords(location.search);
    if (bad) setMessage(bad, true, [specsWay()]);
    return false;
  }
  const ok = await openProposal(asked.slug, asked.source);
  if (ok && asked.view) setProposalView(asked.view);
  return ok;
}

