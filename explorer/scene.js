/**
 * @module explorer/scene
 *
 * THE SCENE CONTRACT (spec 0012 A1, TOPO-02). Pure: no DOM, no canvas, no `window`.
 *
 * `buildScene(state)` turns the explorer's state into a plain description of ONE picture: which
 * nodes and edges are drawn, where, in what colour, how bright, with what halo and glow, which
 * edges carry a packet, and the background (grid, orbital rings, data-flow lanes). Every
 * decision about WHAT is drawn lives here (layer visibility, which edge kinds only show for the
 * selection, focus dimming, search halos, label level of detail, per-edge style). A renderer
 * decides only HOW: it reads a scene, a camera and a time, and never reads `state`.
 *
 *     state ──buildScene──▶ Scene ──┐
 *                       camera ─────┼─▶ renderer.draw(scene, camera, timeMs) ──▶ pixels
 *                       timeMs ─────┘
 *
 * What changes the scene (and so what must call `touchScene()` in state.js): the topology, the
 * layout, the layers, the selection, the search, the view, a playing scenario (the ROM simulation is one), a dragged node, a selected pull request.
 * What does NOT: the camera (pan, zoom, fit) and time (packets). So the scene is built once per
 * `state.sceneVersion` and drawn many times. The one camera-dependent decision, label level of
 * detail, is therefore not in the scene's nodes but in `labelAt(node, zoom, scene)`, which
 * every renderer or label layer calls with the current zoom.
 *
 * buildScene needs no text metrics (a label's size comes from rules, not from measuring it), so it
 * takes no `measure` function; the one place that measures text is layout.js `labelWidth`, which
 * runs before a scene exists. A label layer that needs widths brings its own measurer.
 *
 * Colours are CSS colour strings (`#818cf8`, `rgba(255, 255, 255, 0.16)`); `parseColor` turns one
 * into `[r, g, b, a]` (0..255, alpha 0..1) for a GPU. They are written for the dark ground; in the light
 * theme (`state.theme === 'light'`) buildScene hands every one through theme-model.js as its last step,
 * and the looks a renderer holds itself come from `looksFor(scene.theme)`. Positions are world units; the camera
 * `{ x, y, zoom }` maps world to screen as `screen = camera.xy + world * zoom`.
 *
 * @typedef {'none'|'added'|'changed'|'removed'|'edit'} Mark
 *   What a proposal or a what-if edit says about a node or an edge (spec part B). `none` while no
 *   proposal is open, and in a proposal's Before and After views; in its Diff view the node or edge
 *   carries the proposal's mark. `MARK[mark]` is the look; an edge's own `color`, `dash`, `width` and
 *   `alpha` already carry it (a renderer draws an edge as it is told), a node's ring is the renderer's to draw.
 *   While a proposal is open, `state.proposal` is set and the nodes and edges in `state` are
 *   `applyProposal(base, proposal)`; Diff dims what the proposal does not touch (`PROPOSAL_DIM_ALPHA`).
 *
 * @typedef {'none'|'selected'|'match'|'child'} Halo
 *   `match` (search hit) wins over `selected` when a node is both. The look is `HALO[halo]`.
 *
 * @typedef {object} SceneNode One visible node, in draw order (later is on top)
 * @property {string} id           topology id
 * @property {string} type         topology type (`app`, `page`, `table`, ...)
 * @property {number} x            world centre
 * @property {number} y
 * @property {number} r            world radius of the filled circle
 * @property {string} color        fill, and the glow colour
 * @property {number} alpha        0..1 for everything of this node (halo, circle, core, label): 1, or 0.07 when dimmed by the focus
 * @property {number} glow         blur radius in px in `color`; 0 = none (the dimmed ones, with no glow)
 * @property {Halo} halo
 * @property {Mark} mark
 * @property {boolean} selected    this is the selected node
 * @property {boolean} match       the search query matches its label
 * @property {boolean} connected   inside the focus subgraph (always true when nothing is focused)
 * @property {string} label        the text, always set; whether it is drawn is `labelAt`'s decision
 * @property {number} labelSize    px at zoom >= 0.6 (before the zoomed-out boost): 12 for `root`/`app`, else 11
 * @property {boolean} labelBold
 * @property {number} labelAlpha   = alpha
 * @property {string} labelColor   `#f8fafc`, or a dim white for a node outside the focus
 * @property {boolean} labelKeep   keeps its label when zoomed out: a landmark type, the selection, a match, a marked node, or in the focus
 * @property {boolean} labelStrike the label is struck through (a node a proposal removes, in the Diff view)
 * @property {boolean} live        the node came from the live layer (spec 0029: a floor, a room, a live device), not from topology.json
 * @property {{x:number, y:number, w:number, h:number}|null} box  a live room's box in the 800 x 600 floor viewBox (for the House view), else null
 *
 * @typedef {object} ScenePacket A dot travelling along an edge. Its position is a function of time.
 * @property {string} color        the dot (`#ffffff`)
 * @property {string} glowColor    the dot's glow (the edge's colour)
 * @property {number} radius       world units
 * @property {number} glow         blur px
 * @property {number} speed        trips along the edge per second
 * @property {number} phase        0..1, where on the edge it is at t = 0 (`packetPosition` gives the point)
 *
 * @typedef {object} SceneEdge One drawn edge, in draw order
 * @property {string} key          unique within a scene: `from->to` plus `|kind` (and `|flow` style, `|dashed` usage links)
 * @property {string} from         source node id (in the data-flow view, a page is lifted to its app)
 * @property {string} to
 * @property {string} kind         `ownership` | `usage` | `flow` | `reads` | `writes` | `calls` | `triggers` | `delivers` | `runs-on` | `uses` | `extends`
 * @property {number} x1           where the line starts: the source centre for a straight edge, trimmed to the node circle for a curved one
 * @property {number} y1
 * @property {number} x2           where it ends (the arrowhead tip, when there is one)
 * @property {number} y2
 * @property {number} r1           radius of the source node
 * @property {number} r2           radius of the target node
 * @property {string} color        stroke
 * @property {number} width        px in world units
 * @property {number} alpha        0..1 for the whole edge (line, arrowhead, packet)
 * @property {number[]|null} dash  dash pattern, or null for solid
 * @property {{cx:number, cy:number}|null} curve  control point of the quadratic from (x1,y1) to (x2,y2), or null for a straight line
 * @property {boolean} arrow       an arrowhead at (x2,y2), pointing along (x2-cx, y2-cy); `ARROW` has its size
 * @property {number} glow         blur px; 0 = none
 * @property {string|null} glowColor
 * @property {{text:string, x:number, y:number, color:string, italic:boolean}|null} label  drawn centred, for the selection's edges only
 * @property {ScenePacket|null} packet
 * @property {Mark} mark
 * @property {boolean} live        the edge came from the live layer (an ownership in the house, a phone under its persona, a dashed placement)
 *
 * @typedef {object} SceneText A piece of text that is part of the background
 * @property {string} text
 * @property {number} x            centre (text is centred)
 * @property {number} y            baseline
 * @property {number} size         px in world units
 * @property {boolean} bold
 * @property {string} color
 *
 * @typedef {object} SceneLane One tier band of the data-flow view
 * @property {number} x            rectangle left
 * @property {number} y            top
 * @property {number} w
 * @property {number} h
 * @property {number} radius       corner radius
 * @property {string} fill
 * @property {string} stroke
 * @property {number} strokeWidth
 * @property {SceneText} title
 * @property {SceneText} note
 * @property {SceneText|null} arrow  the `→` between this band and the next
 *
 * @typedef {object} SceneRing A dashed orbital circle
 * @property {number} x
 * @property {number} y
 * @property {number} r
 * @property {string} color
 * @property {number} width
 * @property {number[]} dash
 *
 * @typedef {object} SceneDecor The background, drawn under the edges
 * @property {{size:number, color:string, width:number, margin:number}|null} grid  lines every `size` world units across the viewport plus `margin`; null = none
 * @property {SceneRing[]} rings   the orbital view's rings, [] in the freeform and data-flow views
 * @property {SceneLane[]} lanes   the data-flow view's tier bands, [] otherwise
 *
 * @typedef {object} Scene
 * @property {SceneNode[]} nodes
 * @property {SceneEdge[]} edges
 * @property {SceneDecor} decor
 * @property {boolean} preset      the data-flow view: every node is labelled and the label boost differs (see `labelAt`)
 * @property {'dark'|'light'} theme  the ground it is drawn for (`state.theme`, theme.js): every colour in it already suits it; `looksFor(theme)` has the rest
 * @property {number} version      the `state.sceneVersion` it was built from
 *
 * @typedef {object} Camera
 * @property {number} x            screen px of the world origin
 * @property {number} y
 * @property {number} zoom
 *
 * @typedef {object} Renderer What draws a scene. `renderer-canvas2d.js` is the reference one.
 * @property {string} kind         `canvas2d`, later `webgl2`
 * @property {(scene: Scene, camera: Camera, timeMs: number) => void} draw
 *   Draws the whole picture. Reads only its arguments (and what `resize` told it). `timeMs` is
 *   `performance.now()`; it alone moves the packets, so an animated frame needs no new scene.
 * @property {(width: number, height: number, dpr: number) => void} resize
 *   CSS px size of the viewport and the device pixel ratio; the renderer sizes its surface.
 * @property {() => void} destroy  releases what it holds
 */

import { flowStyleOf } from './flows.js';
import { beforeOf, markIn, showsEdge, showsNode, touchedIds } from './proposal-model.js';
import { decorateHouseScene, houseEdgeStyle, houseShowsNode, houseViewEdges } from './house-model.js';
import { paintVerdict } from './check-model.js';
import { externalLayer, whenDash } from './cloud-model.js';
import { outageFor, paintOutage } from './outage-model.js';
import { paintForge } from './forge-panel-model.js';
import { lightColor, lightenScene, parseColor } from './theme-model.js';

// ---------------------------------------------------------------------------
//  Constants every renderer shares, so the looks cannot drift apart
// ---------------------------------------------------------------------------
export const LANDMARK_TYPES = ['root', 'app', 'pkg', 'tool', 'store', 'rom', 'floor']; // a floor (spec 0029) names its cluster of rooms like an app names its pages
export const FONT_NODE = '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
export const FONT_EDGE = '"Segoe UI", -apple-system, sans-serif';
/** Below this zoom (outside the data-flow view) only landmarks and the focus keep a label */
export const LABEL_ZOOM = 0.6;
/** The white dot in the middle of a node, as a fraction of its radius */
export const CORE_RATIO = 0.32;
export const CORE_COLOR = '#ffffff';
export const DIM_ALPHA = 0.07;
/** The outline drawn under a label so it reads over the lines */
export const LABEL_OUTLINE = { node: { color: 'rgba(9, 13, 22, 0.85)', width: 3.5 }, edge: { color: 'rgba(9, 13, 22, 0.9)', width: 3 } };
export const EDGE_LABEL_SIZE = 10;
/** An arrowhead: two barbs `length` back from the tip, `spread` radians either side of the line */
export const ARROW = { length: 9, spread: 0.45 };
/** Look of each halo: a filled disc (`fillR` past the node radius) and a ring (`ringR` past it) */
export const HALO = {
  selected: { fill: 'rgba(99, 102, 241, 0.55)', fillR: 8, ring: '#818cf8', ringR: 13, ringWidth: 1.5 },
  match: { fill: 'rgba(245, 158, 11, 0.4)', fillR: 8, ring: '#f59e0b', ringR: 13, ringWidth: 1.5 },
  child: { fill: null, fillR: 0, ring: 'rgba(255, 255, 255, 0.28)', ringR: 5, ringWidth: 1.2 },
};
/** The strike across a `removed` edge at its midpoint: `halfLength` each side of the line, `width` thick (world units) */
export const EDGE_STRIKE = { halfLength: 7, width: 2 };
const PACKET = { color: '#ffffff', radius: 3.5, glow: 10, cycleMs: 2600 };
/**
 * Look of each proposal mark (spec 0012 B2), shared by every renderer. A node gets a ring `ringR`
 * past its radius (dashed when `ringDash` is set); an edge is drawn in `color` (dashed when
 * `edgeDash` is set), which buildScene has already put in the edge's own `color`, `dash` and `alpha`.
 * `alpha` fades a removed node and its edge; `strike` strikes its label through (`labelStrike`).
 */
export const MARK = {
  added: { color: '#2dd4bf', ringR: 9, ringWidth: 2, ringDash: [5, 4], edgeDash: [7, 5], edgeWidth: 2.2, alpha: 1, strike: false },
  changed: { color: '#fbbf24', ringR: 9, ringWidth: 2.5, ringDash: null, edgeDash: null, edgeWidth: 2.4, alpha: 1, strike: false },
  removed: { color: '#f87171', ringR: 9, ringWidth: 2, ringDash: null, edgeDash: [3, 4], edgeWidth: 2, alpha: 0.55, strike: true },
  edit: { color: '#a78bfa', ringR: 9, ringWidth: 2.5, ringDash: null, edgeDash: null, edgeWidth: 2.4, alpha: 1, strike: false },
};
/**
 * The looks a renderer draws itself, per theme (MAP-01): the halos, the mark rings, the core dot and the
 * outline under a label. `looksFor('dark')` is HALO, MARK, CORE_COLOR and LABEL_OUTLINE as they are; the light
 * ones are derived from them by theme-model.js (the rule the scene's own colours go through), except the
 * label outline, which is the light ground itself so a dark label reads over the lines. A scene says which
 * (`scene.theme`); a renderer asks for `looksFor(scene.theme)`.
 * @param {'dark'|'light'|undefined} theme
 */
export function looksFor(theme) {
  return theme === 'light' ? LIGHT_LOOKS : DARK_LOOKS;
}
const lightLook = (look) => {
  const out = { ...look };
  for (const k of ['fill', 'ring', 'color']) if (typeof out[k] === 'string') out[k] = lightColor(out[k]);
  return out;
};
const DARK_LOOKS = Object.freeze({ halo: HALO, mark: MARK, core: CORE_COLOR, labelOutline: LABEL_OUTLINE });
const LIGHT_LOOKS = Object.freeze({
  halo: Object.fromEntries(Object.entries(HALO).map(([k, v]) => [k, lightLook(v)])),
  mark: Object.fromEntries(Object.entries(MARK).map(([k, v]) => [k, lightLook(v)])),
  core: CORE_COLOR, // the white dot stays white: it sits on the node's own (deepened) colour, not on the ground
  labelOutline: { node: { color: 'rgba(244, 246, 250, 0.9)', width: 3.5 }, edge: { color: 'rgba(244, 246, 250, 0.92)', width: 3 } },
});
/** However far the camera is zoomed out, a mark stays at least this thick on screen (px), and a ring at least this far from its node: world sizes would shrink to nothing */
export const MARK_MIN_PX = { ring: 1.8, edge: 1.6, gap: 4 };
/** How bright what a proposal does not touch is in the Diff view: dim, but still plainly there */
export const PROPOSAL_DIM_ALPHA = 0.28;

// ---------------------------------------------------------------------------
//  Visibility and focus (moved unchanged from render.js)
// ---------------------------------------------------------------------------
export function isNodeVisible(state, node) {
  const { activeLayers } = state;
  if (state.proposal && !showsNode(state.proposalView || 'diff', node)) return false; // Before hides what is added, After what is removed
  if (state.view === 'dataflow') return !!state.flow && state.flow.ids.has(node.id);
  if (state.view === 'house') return houseShowsNode(state, node); // the House view (spec 0029, PHY-11) draws its own set: house-model.js
  if (node.type === 'root') return true;
  if (node.type === 'core') return activeLayers.pkg || activeLayers.atom;
  if (node.type === 'store') return activeLayers.flow !== false;
  if (node.type === 'rom') return activeLayers.rom !== false && activeLayers.flow !== false;
  if (node.type === 'floor' || node.type === 'room') return activeLayers.house !== false; // the House layer (spec 0029)
  if (node.type === 'external') return activeLayers[externalLayer(node)] !== false; // the Cloud and Public web layers (spec 0031)
  return activeLayers[node.type] !== false;
}

/** The edges the current view draws and the selection walks (the House view adds its Cloud band's rolled-up lines: house-model.js) */
const viewEdgesOf = (state) => (state.view === 'dataflow' && state.flow ? state.flow.edges : state.view === 'house' ? houseViewEdges(state) : state.edges);

/**
 * The focus subgraph: the selected node, its children and every path through them
 * @param {{id:string}|null} selected
 * @param {object[]} edges the edges to walk
 */
export function getActiveSubgraph(selected, edges) {
  if (!selected) return null;

  const connectedNodeIds = new Set([selected.id]);
  const connectedEdgeKeys = new Set();
  const key = (e) => `${e.from}->${e.to}`;
  const owns = (e) => !e.dashed && !e.kind;

  // Direct children (ownership edges out) and the direct parent (ownership edge in)
  const childIds = new Set();
  edges.forEach((e) => {
    if (owns(e) && e.from === selected.id) { childIds.add(e.to); connectedNodeIds.add(e.to); connectedEdgeKeys.add(key(e)); }
    if (owns(e) && e.to === selected.id) { connectedNodeIds.add(e.from); connectedEdgeKeys.add(key(e)); }
  });

  // Everything connected to the selected node or to any of its children
  const focusCore = new Set([selected.id, ...childIds]);
  edges.forEach((e) => {
    if (focusCore.has(e.from)) { connectedNodeIds.add(e.to); connectedEdgeKeys.add(key(e)); }
    if (focusCore.has(e.to)) { connectedNodeIds.add(e.from); connectedEdgeKeys.add(key(e)); }
  });
  // And the edges between connected nodes that touch the focus
  edges.forEach((e) => {
    if (connectedNodeIds.has(e.from) && connectedNodeIds.has(e.to)
      && (focusCore.has(e.from) || focusCore.has(e.to) || e.from === selected.id || e.to === selected.id)) {
      connectedEdgeKeys.add(key(e));
    }
  });

  return { connectedNodeIds, connectedEdgeKeys, childIds, selectedId: selected.id };
}

/**
 * A playing scenario (`state.scenario`, the player's snapshot: scenario.js) as a subgraph: what the
 * walk has reached so far. It lights the visited nodes and the edges its edge steps name (and, for a
 * scenario with `linkNodes` such as the ROM walk, every edge between two visited nodes), and dims the rest.
 * It replaces the ROM simulation's own `state.sim` walk, which is now a scenario like any other.
 * An outage scenario (`down`, spec 0031 section 8) also lights its blast radius (outage-model.js): the down nodes,
 * everything they break and the edges the outage travels back along.
 */
export function scenarioSubgraph(state) {
  const scn = state.scenario;
  const connectedNodeIds = new Set(scn.visited.nodes);
  const connectedEdgeKeys = new Set(scn.visited.edgeList.map(focusKey));
  if (scn.linkNodes) state.edges.forEach((e) => { if (connectedNodeIds.has(e.from) && connectedNodeIds.has(e.to)) connectedEdgeKeys.add(focusKey(e)); });
  const outage = outageFor(scn, state.nodes, state.edges);
  if (outage) {
    outage.down.forEach((id) => connectedNodeIds.add(id));
    outage.hits.forEach((_, id) => connectedNodeIds.add(id));
    outage.edges.forEach((_, key) => connectedEdgeKeys.add(key));
  }
  const { node, edge } = scn.current;
  // An edge step labels itself: a table's edges name their page end, which is the one the focus is "on"
  const selectedId = node !== undefined ? node : edge ? (edge.kind === 'writes' ? edge.from : edge.to) : undefined;
  return { connectedNodeIds, connectedEdgeKeys, childIds: new Set(), selectedId };
}

// ---------------------------------------------------------------------------
//  Geometry
// ---------------------------------------------------------------------------

/**
 * Quadratic curve bowed to one side, trimmed to the node circles, so a pair of opposite flows
 * between two nodes never overlap
 */
function flowGeometry(edge, s, t) {
  const dx = t.x - s.x, dy = t.y - s.y;
  const len = Math.hypot(dx, dy) || 1;
  const bend = edge.bend !== undefined ? edge.bend : 0.18;
  const c = { x: (s.x + t.x) / 2 + (-dy / len) * len * bend, y: (s.y + t.y) / 2 + (dx / len) * len * bend };
  const towards = (p, q, r) => {
    const vx = q.x - p.x, vy = q.y - p.y, d = Math.hypot(vx, vy) || 1;
    return { x: p.x + (vx / d) * r, y: p.y + (vy / d) * r };
  };
  return { a: towards(s, c, (s.r || 18) + 3), b: towards(t, c, (t.r || 18) + 9), c };
}

function quadPoint(a, c, b, k) {
  const u = 1 - k;
  return { x: u * u * a.x + 2 * u * k * c.x + k * k * b.x, y: u * u * a.y + 2 * u * k * c.y + k * k * b.y };
}

/** The point at fraction `k` (0..1) along a scene edge (a straight edge is a degenerate curve) */
export function edgePoint(edge, k) {
  const a = { x: edge.x1, y: edge.y1 };
  const b = { x: edge.x2, y: edge.y2 };
  const c = edge.curve ? { x: edge.curve.cx, y: edge.curve.cy } : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return quadPoint(a, c, b, k);
}

/** Where a packet is at `timeMs`: a point along its edge */
export function packetPoint(edge, timeMs) {
  const k = (((timeMs / 1000) * edge.packet.speed) + edge.packet.phase) % 1;
  return edgePoint(edge, k);
}

// ---------------------------------------------------------------------------
//  Colours, for renderers that cannot take a CSS string
// ---------------------------------------------------------------------------
/** `#rgb`, `#rrggbb`, `rgb(...)` or `rgba(...)` → `[r, g, b, a]` (0..255, alpha 0..1); transparent for anything else (theme-model.js) */
export { parseColor };

// ---------------------------------------------------------------------------
//  Labels: the one decision that depends on the camera
// ---------------------------------------------------------------------------

/**
 * The label a node shows at `zoom`, or null. Zoomed out (below LABEL_ZOOM, outside the data-flow
 * view) only landmarks and the focus keep a label, drawn larger so it stays readable on screen;
 * the data-flow view is small enough to label everything, a little larger when zoomed out.
 * @param {SceneNode} node
 * @param {number} zoom
 * @param {{preset:boolean}} scene
 * @returns {{text:string, x:number, y:number, size:number, bold:boolean, color:string, alpha:number, strike:boolean}|null}
 */
export function labelAt(node, zoom, scene) {
  const zoomedOut = !scene.preset && zoom < LABEL_ZOOM;
  if (zoomedOut && !node.labelKeep) return null;
  const boost = zoomedOut ? Math.min(2.2, 0.75 / zoom) : scene.preset ? Math.min(1.8, 0.8 / zoom) : 1;
  const size = Math.round(node.labelSize * Math.max(1, boost));
  return { text: node.label, x: node.x, y: node.y + node.r + size + 3, size, bold: node.labelBold, color: node.labelColor, alpha: node.labelAlpha, strike: node.labelStrike };
}

// ---------------------------------------------------------------------------
//  Edges
// ---------------------------------------------------------------------------
const edgeKind = (e) => e.kind || (e.dashed ? 'usage' : 'ownership');
const edgeKeyOf = (e) => `${e.from}->${e.to}${e.kind ? `|${e.kind}` : e.dashed ? '|dashed' : ''}${e.kind === 'flow' && e.flow ? `|${e.flow}` : ''}`;
const focusKey = (e) => `${e.from}->${e.to}`;

/** A flow-like edge: a curve with an arrowhead, coloured by its flow style, with a packet when it is in focus (or in the data-flow view) */
function flowEdge(edge, source, target, subgraph, preset, reduceMotion) {
  const isData = edge.kind === 'reads' || edge.kind === 'writes';
  const style = flowStyleOf(edge);
  const connected = subgraph ? subgraph.connectedEdgeKeys.has(focusKey(edge)) : true;
  const proposed = edge.status !== 'live';
  const { a, b, c } = flowGeometry(edge, source, target);
  const focused = !!subgraph && connected;

  // Labels only for the selection: a flow's own node, or for a table's edges (which converge) their page
  const pageEnd = edge.kind === 'reads' ? edge.to : edge.from;
  let label = null;
  if (edge.label && subgraph && connected && (!isData || subgraph.selectedId === pageEnd)) {
    const m = quadPoint(a, c, b, 0.5);
    label = { text: edge.label, x: m.x, y: m.y - 6, color: style.color, italic: proposed };
  }

  // A packet moving along the flow: reads travel back, writes travel out
  let packet = null;
  if ((subgraph ? connected : preset) && !reduceMotion) {
    const phase = edge.phase !== undefined ? edge.phase : ((edge.from.length * 7 + edge.to.length * 13) % 10) / 10;
    packet = { color: PACKET.color, glowColor: style.color, radius: PACKET.radius, glow: PACKET.glow, speed: 1000 / PACKET.cycleMs, phase };
  }

  return {
    key: edgeKeyOf(edge), from: edge.from, to: edge.to, kind: edgeKind(edge),
    x1: a.x, y1: a.y, x2: b.x, y2: b.y, r1: source.r, r2: target.r,
    color: style.color,
    width: focused ? 2.4 : preset && !isData ? 2 : 1.6,
    alpha: subgraph ? (connected ? 1 : 0.04) : preset ? (isData ? 0.2 : 0.65) : isData ? 0.12 : 0.45,
    dash: proposed ? [7, 5] : whenDash(edge), // a call into a cloud node: dashed when it bites at the next deploy, dotted at the next renewal (spec 0031)
    curve: { cx: c.x, cy: c.y },
    arrow: true,
    glow: focused ? 8 : 0,
    glowColor: focused ? style.color : null,
    label, packet, mark: 'none', live: !!edge.live,
  };
}

/** An ownership (solid) or usage (dashed) link: a straight line between the centres */
function linkEdge(edge, source, target, subgraph) {
  const connected = subgraph ? subgraph.connectedEdgeKeys.has(focusKey(edge)) : true;
  let color, width, dash = null, glow = 0, glowColor = null;
  if (subgraph) {
    if (connected) {
      if (edge.dashed) { color = '#818cf8'; width = 2.0; glow = 8; glowColor = 'rgba(129, 140, 248, 0.7)'; dash = [5, 4]; }
      else { color = '#ffffff'; width = 2.4; glow = 10; glowColor = 'rgba(255, 255, 255, 0.8)'; }
    } else {
      color = 'rgba(255, 255, 255, 0.02)'; width = 0.8; dash = edge.dashed ? [4, 4] : null;
    }
  } else if (edge.dashed) {
    color = 'rgba(129, 140, 248, 0.35)'; width = 1.2; dash = [4, 4];
  } else {
    color = 'rgba(255, 255, 255, 0.16)'; width = 1.4;
  }
  return {
    key: edgeKeyOf(edge), from: edge.from, to: edge.to, kind: edgeKind(edge),
    x1: source.x, y1: source.y, x2: target.x, y2: target.y, r1: source.r, r2: target.r,
    color, width, alpha: 1, dash, curve: null, arrow: false, glow, glowColor, label: null, packet: null, mark: 'none', live: !!edge.live,
  };
}

/** Edge kinds drawn as a curve with an arrowhead; the rest are straight ownership / usage links */
const FLOW_LIKE = ['flow', 'reads', 'writes', 'runs-on', 'calls', 'triggers', 'delivers', 'uses', 'extends'];

/** The proposal view in force (`before | diff | after`), or null when no proposal is open */
const proposalView = (state) => (state.proposal ? state.proposalView || 'diff' : null);

/** Puts a proposal mark on a scene edge: its colour, dash and weight; in Diff what is not marked fades back */
function styleForProposal(edge, mark, view, gone = false) {
  edge.mark = mark;
  if (mark === 'none') {
    if (view === 'diff') { edge.alpha *= PROPOSAL_DIM_ALPHA; edge.glow = 0; edge.packet = null; }
    return;
  }
  const look = MARK[mark];
  edge.color = look.color;
  edge.dash = gone ? MARK.removed.edgeDash : look.edgeDash; // an edge a what-if edit removes: violet, but dotted and faded like any removal
  edge.width = Math.max(edge.width, look.edgeWidth);
  if (edge.alpha >= 0.1) edge.alpha = Math.max(edge.alpha, 0.9) * (gone ? MARK.removed.alpha : look.alpha); // not under the selection's deep dimming
  if (edge.glow) edge.glowColor = look.color;
}

function buildEdges(state, subgraph, reduceMotion) {
  const { nodes, activeLayers } = state;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const preset = state.view === 'dataflow';
  const out = [];
  const inFocus = (edge) => !!subgraph && subgraph.connectedEdgeKeys.has(focusKey(edge));
  const flow = (edge, source, target) => out.push(flowEdge(edge, source, target, subgraph, preset, reduceMotion));
  const view = proposalView(state);

  const drawEdge = (edge) => {
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (!source || !target || !isNodeVisible(state, source) || !isNodeVisible(state, target)) return;

    if (preset) return flow(edge, source, target);
    if (state.view === 'house') { const how = houseEdgeStyle(edge, source, target); if (how === 'flow') flow(edge, source, target); else if (how === 'link') out.push(linkEdge(edge, source, target, subgraph)); return; }

    if (edge.kind === 'flow') {
      if (activeLayers.flow !== false) flow(edge, source, target);
      return;
    }
    if (edge.kind === 'reads' || edge.kind === 'writes') {
      if (activeLayers.table !== false) flow(edge, source, target);
      return;
    }
    // App -> stack: only while the infra layer is on, and both ends are visible. Code -> machine (spec 0029): whenever both ends are
    if (edge.kind === 'runs-on') {
      if (activeLayers.stack !== false || target.type === 'machine') flow(edge, source, target);
      return;
    }
    // Services and what surrounds them. An endpoint's own call to an outside system is one of dozens: drawn for the selection only
    if (edge.kind === 'calls' || edge.kind === 'triggers' || edge.kind === 'delivers') {
      const quiet = source.type === 'page' && edge.kind === 'calls';
      if (quiet ? inFocus(edge) : true) flow(edge, source, target);
      return;
    }
    // Token use and inheritance: hundreds of short links, drawn only for the selection
    if (edge.kind === 'uses' || edge.kind === 'extends') {
      if (inFocus(edge)) flow(edge, source, target);
      return;
    }

    // Ownership (solid) and usage (dashed) links
    out.push(linkEdge(edge, source, target, subgraph));
  };

  viewEdgesOf(state).forEach((applied) => {
    if (view && !showsEdge(view, applied)) return;
    const edge = view === 'before' ? beforeOf(applied) : applied; // Before reads a changed edge as it was
    const mark = view ? markIn(view, applied) : 'none';
    const first = out.length;
    if (mark === 'none') {
      drawEdge(edge);
    } else {
      // What a proposal touches is drawn whatever the layer or quiet-edge rules say, as long as both ends are
      const source = byId.get(edge.from);
      const target = byId.get(edge.to);
      if (!source || !target || !isNodeVisible(state, source) || !isNodeVisible(state, target)) return;
      if (preset || FLOW_LIKE.includes(edge.kind)) flow(edge, source, target);
      else out.push(linkEdge(edge, source, target, subgraph));
    }
    for (let i = first; i < out.length; i++) styleForProposal(out[i], mark, view, mark === 'edit' && applied.editOp === 'removed');
  });
  return out;
}

// ---------------------------------------------------------------------------
//  Nodes
// ---------------------------------------------------------------------------
function buildNodes(state, subgraph) {
  const { nodes, selectedNode, searchQuery } = state;
  const query = searchQuery.toLowerCase();
  const out = [];
  const view = proposalView(state);
  const focus = view === 'diff' ? touchedIds(nodes, viewEdgesOf(state)) : null;

  nodes.forEach((node) => {
    if (!isNodeVisible(state, node)) return;

    const shown = view === 'before' ? beforeOf(node) : node; // Before reads a changed node as it was
    const match = !!query && shown.label.toLowerCase().includes(query);
    const selected = !!selectedNode && selectedNode.id === node.id;
    const connected = subgraph ? subgraph.connectedNodeIds.has(node.id) : true;
    const child = subgraph && subgraph.childIds ? subgraph.childIds.has(node.id) : false;
    const mark = view ? markIn(view, node) : 'none';
    const look = MARK[mark];
    const gone = mark === 'edit' && node.editOp === 'removed'; // a node a what-if edit removes: violet ring, faded, label struck through
    // deep dimming for what is not connected; a proposal's Diff view fades what it does not touch, less deeply, and a removed node is faded too
    let alpha = subgraph && !connected ? DIM_ALPHA : 1;
    if (focus && !focus.touched.has(node.id)) alpha = Math.min(alpha, PROPOSAL_DIM_ALPHA);
    if (look) alpha *= gone ? MARK.removed.alpha : look.alpha;
    const big = shown.type === 'root' || shown.type === 'app';

    out.push({
      id: node.id, type: shown.type,
      x: node.x, y: node.y, r: shown.r, color: shown.color,
      alpha,
      glow: connected && alpha >= 0.5 ? (big ? 15 : 9) : 0,
      halo: match ? 'match' : selected ? 'selected' : child ? 'child' : 'none',
      mark,
      selected, match, connected,
      label: shown.label,
      labelSize: big ? 12 : 11,
      labelBold: big,
      labelAlpha: alpha,
      labelColor: connected ? '#f8fafc' : 'rgba(255, 255, 255, 0.3)',
      labelKeep: LANDMARK_TYPES.includes(shown.type) || selected || match || mark !== 'none' || !!(subgraph && connected),
      labelStrike: !!look && (look.strike || gone),
      live: !!node.live,
      box: node.box || null,
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
//  The background
// ---------------------------------------------------------------------------
function buildRings(state) {
  const { rings, selectedNode } = state;
  const main = { color: selectedNode ? 'rgba(66, 153, 225, 0.04)' : 'rgba(66, 153, 225, 0.14)', width: 1, dash: [4, 6] };
  const cluster = { color: selectedNode ? 'rgba(66, 153, 225, 0.03)' : 'rgba(66, 153, 225, 0.08)', width: 1, dash: [4, 6] };
  return [
    ...rings.rings.map(({ x, y, r }) => ({ x, y, r, ...main })),
    ...rings.clusters.flatMap(({ x, y, radii }) => radii.map((r) => ({ x, y, r, ...cluster }))),
  ];
}

/** The data-flow preset: a titled band behind each tier, with arrows between the bands */
function buildLanes(flow) {
  const bottom = -flow.top + 40;
  return flow.headers.map((h, i) => {
    const next = flow.headers[i + 1];
    return {
      x: h.left - 12, y: flow.top + 30, w: h.right - h.left + 24, h: bottom - flow.top - 30, radius: 14,
      fill: 'rgba(66, 153, 225, 0.05)', stroke: 'rgba(66, 153, 225, 0.18)', strokeWidth: 1,
      title: { text: h.title, x: h.x, y: flow.top + 4, size: 15, bold: true, color: '#e2e8f0' },
      note: { text: h.note, x: h.x, y: flow.top + 22, size: 11, bold: false, color: '#94a3b8' },
      arrow: next ? { text: '→', x: (h.right + next.left) / 2, y: flow.top + 8, size: 18, bold: true, color: 'rgba(148, 163, 184, 0.5)' } : null,
    };
  });
}

// ---------------------------------------------------------------------------
//  A scenario's current step (a pass over the finished scene, so it composes with marks)
// ---------------------------------------------------------------------------
/** How strong an already-visited step stays while the walk moves on (nodes, and edges) */
export const VISITED_NODE_ALPHA = 0.55;
export const VISITED_EDGE_ALPHA = 0.5;
/** The packet that travels the current edge step: one trip per step */
const STEP_PACKET = { color: '#ffffff', radius: 4.5, glow: 12 };
const STEP_EDGE = { width: 3.6, glow: 14 };

/** Whether a drawn edge is the one a step names: same ends and kind (and flow); no kind = an ownership or usage link */
function isStepEdge(drawn, step) {
  if (drawn.from !== step.from || drawn.to !== step.to) return false;
  if (!step.kind) return drawn.kind === 'ownership' || drawn.kind === 'usage';
  return drawn.kind === step.kind && (!step.flow || drawn.key.split('|')[2] === step.flow);
}

/**
 * Makes the current step of a playing scenario stand out in a built scene: a node step gets the
 * selected halo, and so does the step's place (`at`, spec 0029) when it is drawn; an edge step draws bright and wide, with a packet making one trip per step; the
 * steps before it stay lit but quieter, with no packet. A finished walk (`done`) is left as the
 * subgraph drew it, all lit, nothing singled out (the old ROM walk's picture). Changes only
 * alpha, glow, halo, width and packet: never `mark`, so a proposal's marks pass through.
 * @param {Scene} scene
 * @param {object} scn the player's snapshot (scenario.js)
 * @param {{reduceMotion?: boolean}} [opts]
 */
export function emphasiseScenario(scene, scn, opts = {}) {
  if (scn.done) return;
  const { node, edge, at } = scn.current;
  const active = new Set(node !== undefined ? [node] : edge ? [edge.from, edge.to] : []);
  if (at !== undefined) active.add(at);

  scene.nodes.forEach((n) => {
    if (!n.connected) return;
    if (active.has(n.id)) {
      if ((node !== undefined || n.id === at) && n.halo !== 'match') n.halo = 'selected';
    } else {
      n.alpha = VISITED_NODE_ALPHA;
      n.labelAlpha = VISITED_NODE_ALPHA;
    }
  });

  const named = new Set(scn.visited.edgeList.map(focusKey));
  const lit = (e) => named.has(focusKey(e)) || (scn.linkNodes && scn.visited.nodes.has(e.from) && scn.visited.nodes.has(e.to));
  scene.edges.forEach((e) => {
    if (edge && isStepEdge(e, edge)) {
      e.alpha = 1;
      e.width = Math.max(e.width, STEP_EDGE.width);
      e.glow = STEP_EDGE.glow;
      e.glowColor = e.glowColor || e.color;
      const speed = 1000 / scn.stepMs;
      const phase = scn.stepStartMs == null ? 0 : (((-scn.stepStartMs / 1000) * speed) % 1 + 1) % 1;
      e.packet = opts.reduceMotion ? null : { ...STEP_PACKET, glowColor: e.color, speed, phase };
    } else if (lit(e)) {
      e.alpha = VISITED_EDGE_ALPHA; // reached earlier: quieter than the current step
      e.packet = null;
    }
  });
}

// ---------------------------------------------------------------------------
//  buildScene
// ---------------------------------------------------------------------------

/**
 * One picture, from the explorer's state. Pure and synchronous; reads nothing but `state`
 * (never `state.camera`, `state.width` or the canvas).
 * @param {object} state the explorer's state (state.js)
 * @param {{reduceMotion?: boolean}} [opts] `reduceMotion`: describe no packets (prefers-reduced-motion)
 * @returns {Scene}
 */
export function buildScene(state, opts = {}) {
  const preset = state.view === 'dataflow';
  const subgraph = state.scenario ? scenarioSubgraph(state) : state.selectedNode ? getActiveSubgraph(state.selectedNode, viewEdgesOf(state)) : null;

  const lanes = preset && state.flow ? buildLanes(state.flow) : [];
  const rings = !(preset && state.flow) && !state.isFreeform ? buildRings(state) : [];

  const scene = {
    nodes: buildNodes(state, subgraph),
    edges: buildEdges(state, subgraph, !!opts.reduceMotion),
    decor: { grid: { size: 48, color: 'rgba(255, 255, 255, 0.035)', width: 0.5, margin: 200 }, rings, lanes },
    preset,
    theme: 'dark',
    version: state.sceneVersion || 0,
  };
  if (state.view === 'house') decorateHouseScene(scene, state); // its bands and tray as lanes, rooms unlabelled (house-model.js)
  if (state.scenario) emphasiseScenario(scene, state.scenario, opts);
  if (state.scenario) paintOutage(scene, outageFor(state.scenario, state.nodes, state.edges)); // CLOUD-07: red, amber, violet by when the outage bites
  if (state.scenario) paintVerdict(scene, state.scenario); // PHY-10: red, green or amber by the step's permission check
  if (state.forgeLit) paintForge(scene, state.forgeLit); // CF-07: the selected pull request's nodes, the rest faded
  if (state.theme === 'light') lightenScene(scene); // MAP-01: last, so what every painter above set is themed with the rest (theme-model.js)
  return scene;
}

/**
 * Remembers the last scene and rebuilds it only when `state.sceneVersion` changed. A camera
 * change or a packet frame never changes the version, so it never rebuilds.
 * @param {(state: object) => Scene} [build]
 */
export function createSceneCache(build = buildScene) {
  let scene = null;
  let version;
  const cache = {
    /** How many times the scene was actually built */
    builds: 0,
    get(state) {
      if (scene && version === state.sceneVersion) return scene;
      scene = build(state);
      version = state.sceneVersion;
      cache.builds++;
      return scene;
    },
  };
  return cache;
}
