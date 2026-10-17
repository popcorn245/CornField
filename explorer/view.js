/**
 * @module explorer/view
 *
 * Loading the topology and choosing the view of it: the whole map (orbit) or the data-flow
 * preset. A failed load is an error state on the page, with a retry, never a blank canvas.
 */

import { state, touchScene } from './state.js';
import { computeDegreeCentrality, layoutOrbit, computeLaneLayout } from './layout.js';
import { buildDataFlow } from './flows.js';
import { render, fitGraphToViewport, fitPadding, ensureFlowLoop } from './render.js';
import { orderAddedLast, pinLanes, placeAddedNodes } from './proposal-model.js';
import { renderLayerToggles } from './layers.js';
import { clearScenario } from './scenario-ui.js';
import { measureParams } from './bench.js';
import { mergeLive, placeLiveNodes } from './live-model.js';
import { applyHouseLayout } from './house-model.js';

const $ = (id) => document.getElementById(id);

function showError(message) {
  const el = $('error-state');
  if (!el) return;
  $('error-message').textContent = message;
  el.hidden = false;
}

export async function loadTopology() {
  const loading = $('loading-state');
  const error = $('error-state');
  if (error) error.hidden = true;
  if (loading) loading.hidden = false;
  try {
    // /?fixture=5k measures on the generated topology (bench.js, core/fixture.js)
    const { fixtureUrl } = measureParams(window.location.search);
    const url = fixtureUrl || '/topology.json';
    const res = await fetch(url + (url.includes('?') ? '&v=' : '?v=') + Date.now());
    if (!res.ok) throw new Error(`GET ${url} answered ${res.status} ${res.statusText}`.trim());
    const data = await res.json();
    if (!Array.isArray(data.nodes) || data.nodes.length === 0) throw new Error(`${url} has no nodes`);
    // The base stays as the file holds it; the map works on copies (the layout writes positions on them)
    state.baseNodes = data.nodes;
    state.baseEdges = Array.isArray(data.edges) ? data.edges : [];
    state.nodes = state.baseNodes.map((n) => ({ ...n }));
    state.edges = state.baseEdges;
    touchScene();
  } catch (err) {
    console.error('Loading the topology failed', err);
    if (loading) loading.hidden = true;
    showError(err.message || String(err));
    return false;
  }
  if (loading) loading.hidden = true;

  setMap(state.nodes, state.edges);
  fitGraphToViewport(fitPadding());
  render();
  ensureFlowLoop();
  return true;
}

/**
 * Puts `nodes` and `edges` on the map: the data-flow preset is rebuilt from them, they are laid out
 * and the Layers menu counts them. The camera is the caller's. proposal.js calls this with the base
 * map, or with `applyProposal(base, proposal)` while a proposal is open.
 */
export function setMap(nodes, edges) {
  // The live layer (live.js, spec 0029) is laid in on top: what was handed in stays as `mapNodes` / `mapEdges`,
  // so a new live answer (or none) is laid over the same map again. The data-flow preset leaves the live nodes out.
  state.mapNodes = nodes;
  state.mapEdges = edges;
  const merged = mergeLive(nodes, edges, state.live && state.live.answer);
  if (state.live) Object.assign(state.live, { counts: merged.counts, other: merged.other, linked: merged.linked });
  state.nodes = merged.nodes;
  state.edges = merged.edges;
  state.flow = buildDataFlow(nodes, edges);
  orderAddedLast(state.flow); // an added node goes last in its lane, so the nodes that were there keep their rows
  touchScene();
  applyLayout();
  renderLayerToggles();
}

function applyLayout() {
  computeDegreeCentrality(); // node sizes: by degree on the full map ...
  if (state.view === 'house') { applyHouseLayout(state); return; } // the House view (house-model.js, PHY-11): the plan, its bands and tray
  if (state.view === 'dataflow') {
    state.flow.tiers.forEach((t) => t.nodes.forEach((n) => { n.r = Math.min(n.r, 13); })); // ... all small in the lanes
    if (!(state.proposal && laneLayoutAround())) computeLaneLayout(state.flow);
  } else if (state.proposal || state.nodes.some((n) => n.live)) {
    layoutOrbitAround(); // the code map keeps its places; what a proposal adds and the live layer are placed beside it
  } else {
    layoutOrbit();
  }
}

/**
 * The data-flow lanes while a proposal is open: the base map is laid out on its own and pinned, and
 * the added nodes take free cells (pinLanes). False when that cannot be done, and the lanes are laid out afresh.
 */
function laneLayoutAround() {
  const applied = { nodes: state.nodes, edges: state.edges };
  const laid = state.baseNodes.map((n) => ({ ...n }));
  state.nodes = laid;
  state.edges = state.baseEdges;
  computeDegreeCentrality();
  const baseFlow = buildDataFlow(laid, state.baseEdges);
  baseFlow.tiers.forEach((t) => t.nodes.forEach((n) => { n.r = Math.min(n.r, 13); }));
  computeLaneLayout(baseFlow);
  state.nodes = applied.nodes;
  state.edges = applied.edges;
  const pinned = pinLanes(state.flow, baseFlow);
  touchScene();
  return pinned;
}

/**
 * The orbit layout while a proposal is open: the base map is laid out on its own, exactly as it is
 * with no proposal, and the nodes that were there keep those places and sizes; only the added ones
 * are placed, next to their parent (placeAddedNodes). So opening a proposal, switching between
 * Before, Diff and After, and closing it never move a node that was already on the map.
 */
function layoutOrbitAround() {
  const applied = { nodes: state.nodes, edges: state.edges };
  const laid = state.baseNodes.map((n) => ({ ...n }));
  state.nodes = laid;
  state.edges = state.baseEdges;
  computeDegreeCentrality();
  layoutOrbit(); // also sets the rings
  const at = new Map(laid.map((n) => [n.id, n]));

  state.nodes = applied.nodes;
  state.edges = applied.edges;
  computeDegreeCentrality();
  state.nodes.forEach((n) => {
    const was = at.get(n.id);
    if (was) { n.x = was.x; n.y = was.y; n.r = was.r; }
  });
  placeAddedNodes(state.nodes, state.edges);
  placeLiveNodes(state.nodes, state.edges);
  touchScene();
}

/** Switches between 'orbit' and 'dataflow'; the camera refits and the preset button follows */
export function setView(view) {
  if (state.view === view) return;
  state.view = view;
  clearScenario();
  touchScene();
  if (state.nodes.length) {
    applyLayout();
    fitGraphToViewport(fitPadding());
    ensureFlowLoop();
  }
  syncViewUi();
}

export function syncViewUi() {
  const preset = state.view === 'dataflow';
  const btn = $('preset-dataflow-btn');
  if (btn) {
    btn.classList.toggle('hx-btn--active', preset);
    btn.setAttribute('aria-pressed', String(preset));
  }
  const layersBtn = $('legend-toggle-btn');
  if (layersBtn) layersBtn.classList.toggle('hx-btn--dim', preset);
  const note = $('layers-preset-note');
  if (note) note.hidden = !preset;
  const badge = $('instruction-badge-text');
  if (badge) badge.textContent = preset ? 'Data flow: browser → servers → API → tables → services → outside' : (state.isFreeform ? 'Drag nodes to move • Double-tap to inspect' : 'Tap node to inspect live spec');
}
