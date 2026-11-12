/**
 * @module explorer/engine/proposal
 *
 * Opening a proposal on an instance (spec 0011 D2, step 5). The open proposal is the instance's state, not the page's: a host hands one in
 * (`showProposal(inst, object)`), or names one for the instance to fetch (`openProposal(inst, slug, source)`, through `inst.fetch`, so a base
 * address applies), or closes it (`closeProposal`). Nothing here reads the address or writes it: the page shell turns `?proposal=` into the same
 * calls a host would make, and writes the address when the instance says a proposal opened, changed view or closed (the `proposal` event).
 *
 *   state.proposal / proposalSlug / proposalSource / proposalSha256 / proposalView / proposalErrors / effectiveProposal   what is open
 *   state.baseNodes / baseEdges   the map without it; state.nodes / edges are the base (copied) or `applyProposal(base, proposal)`
 *
 * What it tells its neighbours (`inst.on`):
 *   proposal         { change: 'opened' | 'view' | 'closed', slug, source, pinSource, view, proposal }  the open proposal changed
 *   proposal:draw    { open }  the bar and the review column draw again (pieces/proposal.js, pieces/changes.js), in that order
 *   proposal:bar     { open }  they have: the controls that sit on the bar draw again (the what-if editor, the decision, the mockups, the Work panel's line)
 *   proposal:mark    { applied, effective, proposal }  before the map is laid out: the what-if editor puts its `edit` mark on what the edits added or removed
 *   proposal:message { text, isError, ways }  one line in the bar in place of a proposal: while one opens, or why it did not
 *   proposal:pull-head  sha  the PR of the open proposal was read: the review column keys what was seen by its head
 * What it asks (`inst.ask`; nobody answering is a no):
 *   proposal:effective  proposal -> proposal  the proposal the map is drawn from (the what-if editor's, with the edits in); no answer: the proposal itself
 *   proposal:before-close  (none) -> false  keeps the proposal open (the what-if editor is asking whether to keep its edits)
 *   work:open-specs  (none) -> true  the Work panel's Specs tab is open for a bad link's way on; no answer: the bar opens its Proposals menu
 *   map:set  { nodes, edges } -> true  the page lays the map out again from these (view.js setMap, not yet an instance's)
 * And emits to the node panel: node:show-edge { edge }.
 *
 * These replace the `hooks` object proposal.js had (each assigned by whatif.js, review.js, mockups.js and forge-panel.js, and chained):
 *   hooks.effective -> ask proposal:effective       hooks.mark -> event proposal:mark              hooks.beforeClose -> ask proposal:before-close
 *   hooks.closed    -> event proposal {closed}      hooks.bar -> event proposal:bar               hooks.openSpecs -> ask work:open-specs
 *   hooks.reviewed  -> event decision (pieces/decision.js)
 */

import { edgePoint } from '../scene.js';
import { frameNodes, largestGroup, READ_ZOOM, FRAME_ZOOM_MIN } from '../camera.js';
import { PROPOSAL_VIEWS, MARK_WORDS, touchedIds, viewWords, jumpWords, notFoundWords, otherCopies } from '../proposal-model.js';
import { applyProposal, edgeKey, proposalProblems } from '../../core/proposal.js';
import { beginReview, endReview, redrawLayers, reviewLayersLine } from './layers.js';
import { visibleMapRect, collapseSheet } from './sheets.js';
import { announce } from './keyboard.js';
import { selectNode, clearSelection } from './selection.js';
import { t } from './strings.js';
import { credentialed } from './connection.js';

/** What the instance keeps of proposals: the open one is in `state`; this is the rest (the list the server gave, which opening is the latest, the bar's one line) */
const memory = (inst) => inst.slot('proposal', () => ({ pinnedSource: false, listing: null, listingProblem: null, forgeProblem: null, listingAt: 0, watchers: new Set(), openToken: 0, message: null }));

/** The name the bar gives the open proposal */
export const titleOf = (state) => (state.proposal && typeof state.proposal.title === 'string' && state.proposal.title) || state.proposalSlug || 'Proposal';

/** The way on every bad link offers: the list of specs */
const specsWay = (inst) => ({ label: t(inst, 'openSpecsList'), way: 'specs' });

// ---------------------------------------------------------------------------
//  The list the server gives
// ---------------------------------------------------------------------------

/** What the server listed last, for the Work panel's Specs tab: the entries (null before the first answer), why the list could not be read, why the spec PRs are missing, and when */
export function proposalListing(inst) {
  const m = memory(inst);
  return { entries: m.listing, problem: m.listingProblem, forgeProblem: m.forgeProblem, at: m.listingAt };
}

/** Calls `fn` each time the list is read again; returns the way to stop */
export function onProposalListing(inst, fn) {
  const m = memory(inst);
  m.watchers.add(fn);
  return () => m.watchers.delete(fn);
}

/** Asks the server for the proposals it can serve (`GET /proposals`) */
export async function loadProposalList(inst) {
  const m = memory(inst);
  const get = credentialed(inst);
  try {
    let res;
    try { res = await get('/proposals', { cache: 'no-store' }); } catch { throw new Error(inst.offline() ? 'You are offline.' : 'cornfield could not be reached. Check that it is still running.'); }
    if (!res.ok) throw new Error(`The server could not list them (error ${res.status}).`);
    let body;
    try { body = await res.json(); } catch { throw new Error('cornfield sent a list this page could not read.'); }
    if (!Array.isArray(body)) throw new Error('cornfield sent something that is not a list of proposals.');
    m.listing = body;
    m.listingProblem = null;
    const said = res.headers.get('X-Proposals-Forge-Error');
    m.forgeProblem = said ? decodeURIComponent(said) : null;
  } catch (err) {
    m.listing = null;
    m.forgeProblem = null;
    m.listingProblem = err.message || 'cornfield did not answer.'; // always a plain sentence made above, never a parser's or a runtime's own words
  }
  m.listingAt = Date.now();
  inst.emit('proposal:listing');
  for (const fn of [...m.watchers]) fn();
  return m.listing;
}

// ---------------------------------------------------------------------------
//  Opening, showing, closing
// ---------------------------------------------------------------------------

/** One line in the bar instead of a proposal: while one opens, or why it did not (with `ways`, the buttons that go on from there) */
export function setMessage(inst, text, isError = false, ways = []) {
  const m = memory(inst);
  m.message = { text, isError, ways };
  inst.emit('proposal:message', m.message);
}

/** The line the bar shows in place of a proposal, or null */
export const messageOf = (inst) => memory(inst).message;

/**
 * Opens a proposal by name: fetches it from the server (`GET /proposals/<slug>.json`, through `inst.fetch`) and shows it. `source` is where the server
 * found it (`checkout` or a worktree's name); without one the server answers with the first it lists.
 * @returns {Promise<boolean>} whether it opened
 */
export async function openProposal(inst, slug, source = null) {
  const m = memory(inst);
  const token = ++m.openToken;
  setMessage(inst, `Opening ${slug} …`);
  try {
    let res;
    try { res = await credentialed(inst)(`/proposals/${encodeURIComponent(slug)}.json${source ? `?source=${encodeURIComponent(source)}` : ''}`, { cache: 'no-store' }); } catch { throw new Error(inst.offline() ? `${slug} could not be opened: you are offline.` : `${slug} could not be opened: cornfield could not be reached.`); }
    if (!res.ok) {
      let why = '';
      try { why = (await res.json()).error || ''; } catch { /* no body */ }
      const err = new Error(res.status === 404 ? notFoundWords(slug, source) : `${slug} could not be opened: ${why || `the server had a problem (error ${res.status}).`}`);
      err.notFound = res.status === 404;
      throw err;
    }
    const found = res.headers.get('X-Proposal-Source');
    let item;
    try { item = await res.json(); } catch { throw new Error(`${slug} could not be opened: cornfield sent a file this page could not read.`); }
    const sha256 = res.headers.get('X-Proposal-Sha256'); // the version on screen: a review names it, so a push since is refused, not approved unseen
    if (inst.ended) return false; // the instance ended while the answer came
    showProposal(inst, item, { slug, source: source || (found ? decodeURIComponent(found) : null), pinSource: !!source, view: 'diff', fit: true, sha256 });
    // said once, here: a proposal opens on a person's asking, never on a background refresh
    announce(inst, [inst.ask('changes:opened-line', titleOf(inst.state)), reviewLayersLine(inst)].filter(Boolean).join(' ')); // and, once, which layers the review hid
    return true;
  } catch (err) {
    if (inst.ended) return false;
    console.error('Opening the proposal failed', err);
    // Said plainly, with the ways on: the Specs list, and the same name under another source when the list has one
    // (a failure that is not "no such proposal" can be asked for again, or let go of: Retry and Close)
    setMessage(inst, err.message || `${slug} could not be opened.`, true, err.notFound ? [specsWay(inst)] : [{ label: 'Retry', way: 'retry', slug, source }, { label: 'Close', way: 'close' }]);
    if (err.notFound && token === m.openToken) {
      await loadProposalList(inst);
      const sources = new Set((Array.isArray(m.listing) ? m.listing : []).map((e) => e && e.source));
      if (token === m.openToken) setMessage(inst, notFoundWords(slug, source, sources), true, [...otherCopies(m.listing, slug, source).map((c) => ({ label: c.label, way: 'open', slug: c.slug, source: c.source })), specsWay(inst)]);
    }
    return false;
  }
}

/**
 * Puts a parsed proposal on the map. The map's nodes and edges become `applyProposal(base, proposal)`. A host that has the proposal needs no fetch.
 * @param {ReturnType<import('../instance.js').createInstance>} inst
 * @param {object} proposal
 * @param {{slug?: string|null, source?: string|null, pinSource?: boolean, view?: 'before'|'diff'|'after', fit?: boolean, sha256?: string|null}} [opts]
 *   `sha256`: the file's SHA-256 as the server sent it (X-Proposal-Sha256): a review names it (spec 0007)
 *   `fit`: fit the camera to what the proposal touches and what it connects to (default true).
 *   `pinSource`: the page puts `&source=` in the address (it was asked for by name; otherwise `/?proposal=<slug>` finds the same one)
 */
export function showProposal(inst, proposal, { slug = null, source = null, pinSource = false, view, fit = true, sha256 = null } = {}) {
  const { state } = inst;
  state.proposal = proposal;
  beginReview(inst); // the map narrows to the change: a review of its own, the viewer's layers untouched (layers.js, layer-model.js)
  state.proposalSlug = slug;
  state.proposalSource = source;
  state.proposalSha256 = typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256) ? sha256 : null;
  memory(inst).pinnedSource = pinSource;
  if (view) state.proposalView = view;
  else if (!PROPOSAL_VIEWS.includes(state.proposalView)) state.proposalView = 'diff';
  const answer = inst.ask('proposal:effective', proposal);
  rebuildProposalMap(inst, answer === undefined ? proposal : answer, { fit });
  tell(inst, 'opened');
}

/** Says that the open proposal changed: opened, another view, or closed (the page writes the address from this) */
function tell(inst, change) {
  const { state } = inst;
  inst.emit('proposal', { change, slug: state.proposalSlug || null, source: state.proposalSource || null, pinSource: memory(inst).pinnedSource, view: state.proposalView, proposal: state.proposal || null });
}

/** The bar and the review column draw again, then whatever sits on the bar */
export function drawBar(inst) {
  const open = !!inst.state.proposal;
  inst.emit('proposal:draw', { open });
  inst.emit('proposal:bar', { open });
}

/**
 * Redraws the map from `proposal` laid over the base, and the bar from `state.proposal`. Call it after anything the map is built from changes.
 * `effective` is the proposal to apply: `state.proposal`, or an edited copy of it (what-if edits, TOPO-11).
 */
export function rebuildProposalMap(inst, effective, { fit = false } = {}) {
  const { state } = inst;
  if (effective === undefined) { const answer = inst.ask('proposal:effective', state.proposal); effective = answer === undefined ? state.proposal : answer; }
  const base = { nodes: state.baseNodes, edges: state.baseEdges };
  let applied;
  state.effectiveProposal = effective;
  try {
    state.proposalErrors = proposalProblems(base, effective).errors;
    applied = applyProposal(base, effective);
    inst.emit('proposal:mark', { applied, effective, proposal: state.proposal });
  } catch (err) {
    // A file so malformed that it cannot be read at all: the plain map, and the reason
    state.proposalErrors = [{ path: '', message: `This proposal could not be read: ${err.message}` }];
    applied = { nodes: state.baseNodes.map((n) => ({ ...n, mark: 'none' })), edges: state.baseEdges.map((e) => ({ ...e, mark: 'none' })) };
  }
  swapMap(inst, applied.nodes, applied.edges);
  drawBar(inst); // first: the fit below leaves out what the bar covers, so the bar must be laid out
  redrawLayers(inst); // the menu follows the layers the change touches
  if (fit) fitToChange(inst);
  inst.map.render();
  inst.map.ensureFlowLoop();
}

/** Closes the proposal: the plain map comes back, as it was. The page takes `?proposal=` out of the address when it hears `proposal` {closed}. */
export function closeProposal(inst) {
  const { state } = inst;
  if (inst.ask('proposal:before-close') === false) return false;
  state.proposal = null;
  state.effectiveProposal = null;
  state.proposalSlug = null;
  state.proposalSource = null;
  state.proposalSha256 = null;
  state.proposalErrors = [];
  endReview(inst); // the viewer's own layers are what is drawn again, exactly as they were
  swapMap(inst, state.baseNodes.map((n) => ({ ...n })), state.baseEdges);
  inst.map.fitGraphToViewport(inst.map.fitPadding());
  inst.map.render();
  inst.map.ensureFlowLoop();
  drawBar(inst);
  tell(inst, 'closed');
  return true;
}

/** Switches between Before, Diff and After; no node moves. Entering Diff fits the camera to the change. */
export function setProposalView(inst, view, { quiet = false } = {}) {
  const { state } = inst;
  if (!state.proposal || !PROPOSAL_VIEWS.includes(view) || state.proposalView === view) return;
  state.proposalView = view;
  inst.touchScene();
  if (state.selectedNode && !inst.map.isNodeVisible(state.selectedNode)) clearSelection(inst, { source: 'api' }); // it is not in this view
  if (view === 'diff') fitToChange(inst);
  inst.map.render();
  drawBar(inst);
  tell(inst, 'view');
  if (!quiet) announce(inst, viewWords(view));
}

/** Hands the map new nodes and edges, keeping the selection on the same node */
function swapMap(inst, nodes, edges) {
  const { state } = inst;
  const selected = state.selectedNode ? state.selectedNode.id : null;
  if (!inst.ask('map:set', { nodes, edges })) { // nobody lays the map out: it is these nodes as they are
    state.mapNodes = nodes;
    state.mapEdges = edges;
    state.nodes = nodes;
    state.edges = edges;
  }
  state.selectedEdge = null;
  if (selected) {
    const again = state.nodes.find((n) => n.id === selected);
    if (again) state.selectedNode = again;
    else clearSelection(inst, { source: 'api' });
  }
  inst.touchScene();
}

/**
 * Frames what the proposal changes (nodes added, changed or removed, and both ends of a changed edge; not what they connect to) in the part of the
 * map nothing covers (the bar, the review column, the node panel, a phone's sheets), at a zoom up to 1 so their labels read. Only what is drawn counts: a change on a
 * layer that is off is not framed (the map would centre on ground the viewer cannot see). When the change is wider than FRAME_ZOOM_MIN shows,
 * the biggest part of it that fits there is framed, not the whole at a zoom where it is a speck (the change list reaches the rest). A proposal that changes nothing drawn shows the whole map.
 */
function fitToChange(inst) {
  const { state, map } = inst;
  const { touched } = touchedIds(state.nodes, inst.viewEdges());
  const items = state.nodes.filter((n) => touched.has(n.id) && map.isNodeVisible(n));
  const rect = visibleMapRect(inst);
  const opts = { padding: map.fitPadding(), maxZoom: 1, minZoom: map.getMinZoom() };
  // The whole change when it fits at FRAME_ZOOM_MIN or closer; else the biggest part of it that does (camera.js)
  const group = largestGroup(items, rect, { ...opts, minZoom: Math.max(opts.minZoom, FRAME_ZOOM_MIN) });
  const cam = items.length ? frameNodes(group, rect, opts) : null;
  if (!cam) { map.fitGraphToViewport(map.fitPadding()); return; }
  Object.assign(state.camera, cam);
  map.render();
}

// ---------------------------------------------------------------------------
//  The change list's rows, and picking an edge
// ---------------------------------------------------------------------------

const nameOf = (state, id) => (state.nodes.find((n) => n.id === id) || { label: id }).label;
/** The kind a scene edge reports for an applied one (an ownership link has none) */
export const kindOf = (e) => e.kind || (e.dashed ? 'usage' : 'ownership');

/**
 * Picks a row of the changes list: select it, centre it in the part of the map the review column, the node panel and (on a phone) the sheets leave free,
 * at a zoom where its label reads, and make sure the current view shows it
 */
export function focusChange(inst, kind, key, { select = true } = {}) {
  const { state, map } = inst;
  const item = kind === 'edge' ? state.edges.find((e) => edgeKey(e) === key) : state.nodes.find((n) => n.id === key);
  if (!item) return;
  const ends = (kind === 'edge' ? [state.nodes.find((n) => n.id === item.from), state.nodes.find((n) => n.id === item.to)] : [item]).filter(Boolean);
  if (!ends.length) return;
  if (state.proposalView !== 'diff' && ends.some((n) => !map.isNodeVisible(n))) setProposalView(inst, 'diff', { quiet: true }); // Before or After hides what it removes or adds
  if (select) { if (kind === 'edge') showEdge(inst, item); else selectNode(inst, item); }
  // The panel is open now, so what it covers is known
  const cam = frameNodes(ends, visibleMapRect(inst), { padding: map.fitPadding(), maxZoom: Math.max(READ_ZOOM, state.camera.zoom), minZoom: map.getMinZoom() });
  if (cam) Object.assign(state.camera, cam);
  map.render();
  announce(inst, jumpWords(MARK_WORDS[item.mark] || item.mark, kind === 'edge' ? `${nameOf(state, item.from)} to ${nameOf(state, item.to)}` : item.label));
}

/**
 * The marked edge under a point of the map, or null: the nearest one within `tolerance` world units, measured along the drawn curve.
 * Only the edges of the current scene, so a hidden one is never hit.
 */
export function markedEdgeAt(inst, x, y, tolerance) {
  let best = null;
  let bestDistance = tolerance;
  for (const edge of inst.map.getScene().edges) {
    if (edge.mark === 'none') continue;
    for (let k = 0; k <= 1; k += 1 / 20) {
      const p = edgePoint(edge, k);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= bestDistance) { best = edge; bestDistance = d; }
    }
  }
  if (!best) return null;
  return inst.viewEdges().find((e) => e.from === best.from && e.to === best.to && kindOf(e) === best.kind) || null;
}

/** Selects an edge and has the node panel show it (it is the panel's to fill, to open and to make reachable: `node:show-edge`) */
export function showEdge(inst, edge) {
  clearSelection(inst, { source: 'api' }); // clears a node selection and any panel still loading
  inst.state.selectedEdge = edge;
  inst.emit('node:show-edge', { edge });
  inst.touchScene();
  inst.map.render();
}

/** A click on the map that picks no node but lands on a marked edge opens that edge. Returns the way to stop. */
export function bindEdgePicking(inst, listen) {
  const canvas = inst.state.canvas;
  if (!canvas) return () => {};
  let down = null;
  const offs = [
    listen(canvas, 'mousedown', (e) => { down = { x: e.clientX, y: e.clientY }; }),
    listen(canvas, 'click', (e) => {
      const { state } = inst;
      if (!state.proposal || state.proposalView === 'before') return; // Before has no marked edges
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // a drag
      const rect = canvas.getBoundingClientRect();
      const p = inst.map.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const zoom = state.camera.zoom;
      const onNode = state.nodes.some((n) => inst.map.isNodeVisible(n) && Math.hypot(n.x - p.x, n.y - p.y) <= n.r + 6 / zoom);
      if (onNode) return; // a node: the map's own selection handles it
      const edge = markedEdgeAt(inst, p.x, p.y, 8 / zoom);
      if (edge) showEdge(inst, edge);
    }),
  ];
  return () => offs.forEach((off) => off());
}

/** Whether the open proposal's source goes in the address (it was asked for by name) */
export const pinnedSource = (inst) => memory(inst).pinnedSource;

/** The phone's sheet for the bar folds when no proposal is open */
export const collapseProposalSheet = (inst) => collapseSheet(inst, 'proposal');
