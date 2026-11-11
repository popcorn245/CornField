/**
 * @module explorer/selection-model
 *
 * What a selection lights, and where the camera goes for it (spec 0008 D5 and D6). Pure: no DOM, no state.
 *
 *   activeSubgraph(selected, edges, opts)   the lit set: the node and everything ONE edge away, of any kind (its parent and children
 *                                           included); `throughChildren` adds the children's neighbours (the wider set every
 *                                           selection lit before 0.35); `kind` keeps only the lines of that kind
 *   linesByKind(subgraph)                   "Calls 12 · Reads 9 · Owns 4": the lit lines counted by kind, in a fixed order
 *   countOffScreen(ids, camera, rect)       how many of the lit nodes are outside the part of the map nothing covers
 *   selectionCamera(node, lit, rect, opts)  where the camera goes when a selection comes from search, a list, a link or the keyboard:
 *                                           the node and its lit set framed if that fits at zoom 0.5 or closer, else the node
 *                                           centred at zoom 1. A click on the map never asks for it (panels.js)
 *
 * An edge's `kind` is project data: it only ever selects a word from `KIND_WORDS` or is shown as escaped text; it never builds a
 * selector or a token name.
 */

import { frameNodes } from './camera.js';

/** The kinds a line is drawn as, in the order the panel lists them */
export const LINE_KINDS = ['ownership', 'usage', 'flow', 'reads', 'writes', 'calls', 'triggers', 'delivers', 'runs-on', 'uses', 'extends'];

/** The words for a kind: the panel's plural ("Calls 12"), and the word on a lit edge ("calls") */
export const KIND_WORDS = Object.freeze({
  ownership: { panel: 'Owns', edge: 'owns' },
  usage: { panel: 'Links', edge: 'links' },
  flow: { panel: 'Flows', edge: 'flow' },
  reads: { panel: 'Reads', edge: 'reads' },
  writes: { panel: 'Writes', edge: 'writes' },
  calls: { panel: 'Calls', edge: 'calls' },
  triggers: { panel: 'Triggers', edge: 'triggers' },
  delivers: { panel: 'Delivers', edge: 'delivers' },
  'runs-on': { panel: 'Runs on', edge: 'runs on' },
  uses: { panel: 'Uses', edge: 'uses' },
  extends: { panel: 'Extends', edge: 'extends' },
});

/** The kind of a topology edge: an ownership has none, a usage link is `dashed` */
export const edgeKindOf = (e) => e.kind || (e.dashed ? 'usage' : 'ownership');
export const edgeKeyOf = (e) => `${e.from}->${e.to}`;

/** A kind's panel word; a kind this table does not know (a project's own) is shown as the text it is */
export const kindPanelWord = (kind) => (Object.hasOwn(KIND_WORDS, kind) ? KIND_WORDS[kind].panel : String(kind));
export const kindEdgeWord = (kind) => (Object.hasOwn(KIND_WORDS, kind) ? KIND_WORDS[kind].edge : String(kind));

/**
 * The focus subgraph (spec 0008 D5).
 * @param {{id:string}|null} selected
 * @param {object[]} edges the edges to walk
 * @param {{throughChildren?: boolean, kind?: string|null}} [opts]
 * @returns {null | {
 *   connectedNodeIds: Set<string>, connectedEdgeKeys: Set<string>, childIds: Set<string>, selectedId: string,
 *   edges: object[], kinds: Map<string, number>, kind: string|null, throughChildren: boolean }}
 *   `kinds` counts every lit line by kind before a `kind` filter, so the panel keeps listing the others; `edges` is the lit lines
 *   (after it); `kind` is the filter in force, or null when none was asked for or the asked kind is not among the lit lines
 */
export function activeSubgraph(selected, edges, { throughChildren = false, kind = null } = {}) {
  if (!selected) return null;
  const id = selected.id;
  const childIds = new Set();
  for (const e of edges) if (!e.kind && !e.dashed && e.from === id) childIds.add(e.to);
  const core = throughChildren ? new Set([id, ...childIds]) : null; // the selected node and its children: with `throughChildren` their neighbours light too
  const lit = [];
  for (const e of edges) {
    if (core ? (core.has(e.from) || core.has(e.to)) : (e.from === id || e.to === id)) lit.push(e);
  }
  const kinds = new Map();
  for (const e of lit) { const k = edgeKindOf(e); kinds.set(k, (kinds.get(k) || 0) + 1); }
  const filter = kind && kinds.has(kind) ? kind : null;
  const shown = filter ? lit.filter((e) => edgeKindOf(e) === filter) : lit;
  const connectedNodeIds = new Set([id]);
  const connectedEdgeKeys = new Set();
  for (const e of shown) { connectedNodeIds.add(e.from); connectedNodeIds.add(e.to); connectedEdgeKeys.add(edgeKeyOf(e)); }
  return { connectedNodeIds, connectedEdgeKeys, childIds, selectedId: id, edges: shown, kinds, kind: filter, throughChildren };
}

/**
 * The lit lines counted by kind, in LINE_KINDS order (a kind of the project's own after them, by name).
 * @param {NonNullable<ReturnType<typeof activeSubgraph>>} sub
 * @returns {{kind: string, count: number, word: string}[]}
 */
export function linesByKind(sub) {
  const rank = (k) => { const i = LINE_KINDS.indexOf(k); return i < 0 ? LINE_KINDS.length : i; };
  return [...sub.kinds.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([kind, count]) => ({ kind, count, word: kindPanelWord(kind) }));
}

/**
 * The lit lines of one kind, as the node at their far end: { node id, whether the line leaves the selection }, in map order.
 * @param {NonNullable<ReturnType<typeof activeSubgraph>>} sub
 * @param {string} kind
 */
export function farEnds(sub, kind) {
  const rows = [];
  const seen = new Set();
  for (const e of sub.edges) {
    if (edgeKindOf(e) !== kind) continue;
    const out = e.from === sub.selectedId;
    const other = out ? e.to : e.from;
    if (seen.has(other)) continue;
    seen.add(other);
    rows.push({ id: other, out });
  }
  return rows;
}

/** The screen point of a world point */
const screenOf = (camera, n) => ({ x: camera.x + n.x * camera.zoom, y: camera.y + n.y * camera.zoom });

/**
 * How many of `nodes` are outside `rect` (the part of the map nothing covers) under `camera`.
 * @param {{x:number, y:number}[]} nodes
 * @param {{x:number, y:number, zoom:number}} camera
 * @param {{x:number, y:number, width:number, height:number}} rect
 */
export function countOffScreen(nodes, camera, rect) {
  let off = 0;
  for (const n of nodes) {
    const p = screenOf(camera, n);
    if (p.x < rect.x || p.x > rect.x + rect.width || p.y < rect.y || p.y > rect.y + rect.height) off++;
  }
  return off;
}

/** The zoom a selection is framed at or above: a lit set that needs less than this is not framed, the node is centred at zoom 1 instead */
export const FRAME_MIN_ZOOM = 0.5;
/** The zoom a node is centred at when its lit set is too wide to frame */
export const CENTRE_ZOOM = 1;

/**
 * Where the camera goes for a selection that did not come from a click on the map (spec 0008 D6).
 * @param {{x:number, y:number, r?:number}} node
 * @param {{x:number, y:number, r?:number}[]} lit the node and what it lights
 * @param {{x:number, y:number, width:number, height:number}} rect the part of the map nothing covers (sheets.js visibleMapRect)
 * @param {{padding?: number}} [opts]
 * @returns {{x:number, y:number, zoom:number, framed:boolean}}
 */
export function selectionCamera(node, lit, rect, { padding = 40 } = {}) {
  const all = lit.length ? lit : [node];
  const fit = frameNodes(all, rect, { padding, maxZoom: CENTRE_ZOOM, minZoom: 0.0001 });
  if (fit && fit.zoom >= FRAME_MIN_ZOOM) return { ...fit, framed: true };
  return { x: rect.x + rect.width / 2 - node.x * CENTRE_ZOOM, y: rect.y + rect.height / 2 - node.y * CENTRE_ZOOM, zoom: CENTRE_ZOOM, framed: false };
}

/** The words that say how much of a selection is in view: "27 connected · 9 off screen" */
export function connectedLine(connected, off) {
  return off > 0 ? `${connected} connected · ${off} off screen` : `${connected} connected · all on screen`;
}
