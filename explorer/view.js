/**
 * @module explorer/view
 *
 * Loading the topology and choosing the view of it: the whole map (orbit) or the data-flow
 * preset. A failed load is an error state on the page, with a retry, never a blank canvas.
 */

import { state, touchScene, pageInstance } from './state.js';
import { computeDegreeCentrality } from './layout.js';
import { layoutMap } from './engine/topology.js';
import { buildDataFlow } from './flows.js';
import { render, fitGraphToViewport, fitPadding, ensureFlowLoop } from './render.js';
import { orderAddedLast } from './proposal-model.js';
import { renderLayerToggles } from './layers.js';
import { clearScenario } from './scenario-ui.js';
import { measureParams } from './bench.js';
import { mergeLive } from './live-model.js';
import { applyHouseLayout } from './house-model.js';
import { syncHint } from './hint.js';
import { ensurePagePieces } from './page-pieces.js';
import { TOPOLOGY_PATH, fetchTopology } from './engine/source.js';

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
    const url = fixtureUrl || TOPOLOGY_PATH;
    const data = await fetchTopology(pageInstance(), url); // engine/source.js: the same read a scope makes, here of the page's own origin
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

/** Where the nodes sit: the House view's plan here (house-model.js, PHY-11), every other view the engine's one layout (engine/topology.js `layoutMap`) */
function applyLayout() {
  if (state.view === 'house') { computeDegreeCentrality(); applyHouseLayout(state); return; }
  layoutMap(pageInstance());
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
  // The View switch: the Map button is on for the map itself; Flow and House say theirs (house.js) in aria-pressed too
  const map = $('preset-map-btn');
  if (map) map.setAttribute('aria-pressed', String(state.view !== 'dataflow' && state.view !== 'house'));
  const btn = $('preset-dataflow-btn');
  if (btn) btn.setAttribute('aria-pressed', String(preset));
  ensurePagePieces(); // the Layers menu, if the page has its place
  pageInstance().emit('view', state.view); // the Layers chip dims while the data-flow view is on (pieces/layers.js)
  syncHint(); // the hint's words for this view and pointer, and whether it shows (hint.js)
}

// The proposal asks the page to lay the map out again from the nodes and edges it hands over (engine/proposal.js): this module is not on an instance yet
pageInstance().on('map:set', ({ nodes, edges }) => { setMap(nodes, edges); return true; });
