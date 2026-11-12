/**
 * @module explorer/engine/topology
 *
 * Giving an instance its map (spec 0011 D2, D4: the engine half of the one-tag review). A host hands a topology in (`{ nodes, edges }`, the object
 * topology.json holds); this is the one place it becomes the instance's state, for the map piece (pieces/map.js) and for the review piece
 * (pieces/review.js), which both call it. Nothing here reads the address or fetches: a piece that loads a topology from a server hands the object over.
 *
 *   setTopology(inst, topology)   copies the nodes and edges in as the base map (the host's object is never changed: the layout writes on the copies),
 *                                 builds the data-flow preset, keeps the selection when its node is still there; returns whether it is
 *   layoutMap(inst)               where the nodes sit for the current view (orbit, or the data-flow lanes); the camera is the caller's
 *   setMap(inst, nodes, edges)    the map the instance draws from `nodes` and `edges` (the base, or `applyProposal(base, proposal)` while a proposal is
 *                                 open) laid out: the nodes that were there keep their places, only what a proposal adds is placed beside its parent
 *                                 (proposal-model.js). It is what the instance answers to the `map:set` ask of engine/proposal.js (the review piece
 *                                 answers it); the camera is the caller's
 */

import { buildDataFlow } from '../flow-build.js';
import { orderAddedLast, pinLanes, placeAddedNodes } from '../proposal-model.js';
import { computeDegreeCentrality, computeLaneLayout, layoutOrbit } from './layout.js';

/** The nodes and edges of a topology that have what the engine needs (an id, and two ends), as arrays; anything else is dropped */
export function cleanTopology(topology) {
  const nodes = topology && Array.isArray(topology.nodes) ? topology.nodes.filter((n) => n && typeof n.id === 'string') : [];
  const edges = topology && Array.isArray(topology.edges) ? topology.edges.filter((e) => e && typeof e.from === 'string' && typeof e.to === 'string') : [];
  return { nodes, edges };
}

/**
 * Makes `topology` the instance's base map. The selection outlives it when the new map has its node (the same id is the same selection, the
 * instance says nothing), else it is cleared (the instance says so once). The scene is touched; laying out and drawing are the caller's.
 * @param {ReturnType<import('../instance.js').createInstance>} inst
 * @param {{ nodes?: object[], edges?: object[] } | null | undefined} topology
 * @returns {boolean} whether the map has any nodes
 */
export function setTopology(inst, topology) {
  const { state } = inst;
  const { nodes, edges } = cleanTopology(topology);
  const keep = state.selectedNode ? state.selectedNode.id : null;
  // The host's object is never changed: the map works on copies (the layout writes positions on them)
  state.baseNodes = nodes;
  state.baseEdges = edges;
  state.nodes = nodes.map((n) => ({ ...n }));
  state.edges = edges.map((e) => ({ ...e }));
  state.mapNodes = state.nodes;
  state.mapEdges = state.edges;
  state.flow = buildDataFlow(state.nodes, state.edges);
  const again = keep ? state.nodes.find((n) => n.id === keep) || null : null;
  if (again) { state.selectedEdge = null; state.selectedNode = again; } else if (state.selectedNode || state.selectedEdge) { state.selectedNode = null; state.selectedEdge = null; }
  inst.touchScene();
  return state.nodes.length > 0;
}

/** Where nodes sit for the current view: sizes by degree, then the data-flow lanes or the orbit */
export function layoutMap(inst) {
  const { state } = inst;
  computeDegreeCentrality(inst);
  if (state.view === 'dataflow' && state.flow) {
    state.flow.tiers.forEach((tier) => tier.nodes.forEach((n) => { n.r = Math.min(n.r, 13); })); // all small in the lanes
    computeLaneLayout(inst, state.flow);
  } else layoutOrbit(inst);
}

/**
 * Puts `nodes` and `edges` on the map and lays them out. With a proposal open the base map is laid out on its own, exactly as it is with none, and
 * the nodes that were there keep those places and sizes: opening a proposal, switching Before, Diff and After, and closing it never move a node that
 * was already on the map (the same rule view.js keeps on cornfield's page).
 */
export function setMap(inst, nodes, edges) {
  const { state } = inst;
  state.mapNodes = nodes;
  state.mapEdges = edges;
  state.nodes = nodes;
  state.edges = edges;
  state.flow = buildDataFlow(nodes, edges);
  orderAddedLast(state.flow); // an added node goes last in its lane, so the nodes that were there keep their rows
  inst.touchScene();
  if (!state.proposal || !state.baseNodes) { layoutMap(inst); return; }
  if (state.view === 'dataflow') { if (!lanesAround(inst)) layoutMap(inst); } else orbitAround(inst);
}

/** The data-flow lanes while a proposal is open: the base is laid out on its own and pinned, the added nodes take free cells; false when that cannot be done */
function lanesAround(inst) {
  const { state } = inst;
  const applied = { nodes: state.nodes, edges: state.edges };
  const laid = state.baseNodes.map((n) => ({ ...n }));
  state.nodes = laid;
  state.edges = state.baseEdges;
  computeDegreeCentrality(inst);
  const baseFlow = buildDataFlow(laid, state.baseEdges);
  baseFlow.tiers.forEach((tier) => tier.nodes.forEach((n) => { n.r = Math.min(n.r, 13); }));
  computeLaneLayout(inst, baseFlow);
  state.nodes = applied.nodes;
  state.edges = applied.edges;
  const pinned = pinLanes(state.flow, baseFlow);
  inst.touchScene();
  return pinned;
}

/** The orbit while a proposal is open: the base is laid out as it is with none, and only the added nodes are placed, next to their parent */
function orbitAround(inst) {
  const { state } = inst;
  const applied = { nodes: state.nodes, edges: state.edges };
  const laid = state.baseNodes.map((n) => ({ ...n }));
  state.nodes = laid;
  state.edges = state.baseEdges;
  computeDegreeCentrality(inst);
  layoutOrbit(inst); // also sets the rings
  const at = new Map(laid.map((n) => [n.id, n]));
  state.nodes = applied.nodes;
  state.edges = applied.edges;
  computeDegreeCentrality(inst);
  state.nodes.forEach((n) => {
    const was = at.get(n.id);
    if (was) { n.x = was.x; n.y = was.y; n.r = was.r; }
  });
  placeAddedNodes(state.nodes, state.edges);
  inst.touchScene();
}
