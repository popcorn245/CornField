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
 * `state.sceneVersion` and drawn many times. The one camera-dependent decision, which labels fit
 * and how big they are, is therefore not in the scene's nodes but in labels.js (`placeLabels(scene,
 * zoom)`, which the label layer calls and caches by zoom).
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
 * @property {string} type         topology type (`app`, `page`, `table`, ...): the node's kind for the map tokens (map-style.js)
 * @property {string} group        the node's layer in the Layers menu (`app`, `cloud`, `web`, `house`, ...): the node's group for the map tokens
 * @property {number} x            world centre
 * @property {number} y
 * @property {number} r            world radius of the node: the circle's, or the silhouette's circumscribing one
 * @property {'circle'|'rounded-square'|'hexagon'|'square'|'diamond'} shape  the silhouette (core/schema.js `NODE_SHAPES`)
 * @property {number} [hitR]       world radius of the disc a click or tap hits: `r` times how far the silhouette reaches (SHAPE_REACH)
 * @property {string} [glyph]      the type whose built-in glyph the node shows (glyphs.js), when the type has one
 * @property {string} [letters]    a finer kind's letters (kind-letters.js)
 * @property {string} color        fill, and the glow colour
 * @property {number} alpha        0..1 for everything of this node (halo, circle, core, label): 1, or 0.07 when dimmed by the focus
 * @property {number} glow         blur radius in px in `color`; 0 = none (the dimmed ones, with no glow)
 * @property {Halo} halo
 * @property {Mark} mark
 * @property {boolean} selected    this is the selected node
 * @property {boolean} match       the search finds it (its label, id, file, type or kind: search-model.js)
 * @property {boolean} current     it is the search match the stepping is on (`state.searchCurrent`): its label is placed first of the matches
 * @property {number} degree       how many edges it has (the label placer's tie-break: more edges first)
 * @property {boolean} connected   inside the focus subgraph (always true when nothing is focused)
 * @property {string} label        the text, always set; whether it is drawn is labels.js's decision (`placeLabels`)
 * @property {number} labelSize    px in world units: 12 for `root`/`app`, else 11. On screen a label is never under LABEL_MIN_PX (a hub's, 2 more)
 * @property {boolean} labelBold
 * @property {number} labelAlpha   = alpha
 * @property {string} labelColor   `#f8fafc`, or a dim white for a node outside the focus
 * @property {boolean} labelKeep   its label is asked for: a landmark type, the selection, a match, a marked node, or in the focus (and what a painter lights: an outage, a pull request)
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
 * @property {number[]|null} dash  dash pattern, or null for solid: PROPOSED_DASH for a proposed edge, USAGE_DASH (dots) for a usage link, nothing else
 * @property {0|1|2} ticks         tick marks across the middle: a call that breaks at the next deploy (1) or renewal (2); 0 for every other edge
 * @property {'triangle'|'chevron'|'bar'|'diamond'|null} end  the mark at the target (END_MARKS); null for an ownership or usage link
 * @property {{cx:number, cy:number}|null} curve  control point of the quadratic from (x1,y1) to (x2,y2), or null for a straight line
 * @property {boolean} arrow       the edge has an end mark at (x2,y2), pointing along (x2-cx, y2-cy); `end` says which and `ARROW` has its size
 * @property {number} glow         blur px; 0 = none
 * @property {string|null} glowColor
 * @property {{text:string, x:number, y:number, color:string, italic:boolean}|null} label  the kind's word, centred at the edge's middle, for the lit edges only (labels.js places it below the node labels)
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
 * @property {{nodes: Set<string>, edges: Set<string>}} painted  the ids of the nodes and the keys of the edges a painter (an outage, a check's verdict, a pull request) gave a colour of its own: map-style.js leaves those alone
 * @property {SceneDecor} decor
 * @property {{node: {color: string, width: number}, edge: {color: string, width: number}}} [labelOutline]  the outline under the labels when the theme sets one (map-style.js, `--corn-map-label-halo`); else `looksFor(theme).labelOutline`
 * @property {boolean} preset      the data-flow view
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
import { externalLayer, whenTicks } from './cloud-model.js';
import { lettersOf, projectLayerKey, shownByProposal } from './layer-model.js';
import { NODE_THEMES, shapeOf } from '../core/schema.js';
import { hasGlyph } from './glyphs.js';
import { outageFor, paintOutage } from './outage-model.js';
import { paintForge } from './forge-panel-model.js';
import { lightColor, lightenScene, parseColor } from './theme-model.js';
import { matchIds } from './search-model.js';
import { nodeColor } from './css-color.js';
import { activeSubgraph, kindEdgeWord } from './selection-model.js';
import { DIFF_MARK_COLORS, DIFF_LABEL_ALPHA, EDGE_MIN_ALPHA, MARK_SHAPES, REMOVED_ALPHA } from './diff-marks.js';

// ---------------------------------------------------------------------------
//  Constants every renderer shares, so the looks cannot drift apart
// ---------------------------------------------------------------------------
export const LANDMARK_TYPES = ['root', 'app', 'pkg', 'tool', 'store', 'rom', 'floor']; // a floor (spec 0029) names its cluster of rooms like an app names its pages
export const FONT_NODE = '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
export const FONT_EDGE = '"Segoe UI", -apple-system, sans-serif';
/**
 * The smallest a label is ever drawn on screen (px), whatever the zoom (spec 0008 D2): a node's own, and a hub's (its cluster's title).
 * A theme may raise the first with `--corn-map-label-min` (not below LABEL_MIN_FLOOR); a hub's is that plus 2.
 */
export const LABEL_MIN_PX = 11;
export const LABEL_MIN_FLOOR = 9;
export const HUB_LABEL_EXTRA_PX = 2;
/** The white dot in the middle of a node, as a fraction of its radius */
export const CORE_RATIO = 0.32;
export const CORE_COLOR = '#ffffff';
export const DIM_ALPHA = 0.07;
/** The outline drawn under a label so it reads over the lines */
export const LABEL_OUTLINE = { node: { color: 'rgba(9, 13, 22, 0.85)', width: 3.5 }, edge: { color: 'rgba(9, 13, 22, 0.9)', width: 3 } };
/** Kept for themes and tests that name it; the words on lit edges are drawn at the label minimum (labels.js) */
export const EDGE_LABEL_SIZE = 10;
/** An arrowhead: two barbs `length` back from the tip, `spread` radians either side of the line (a chevron has the same barbs, open) */
export const ARROW = { length: 9, spread: 0.45 };
/**
 * What each kind of edge ends in at its target (spec 0008 D7), one mark per family: an open chevron for data, a filled triangle for a
 * service, a bar across the line for a place, an open diamond for a token. Ownership and usage links have none. A dashed edge (proposed)
 * keeps its kind's own mark. `triangle` is the arrowhead renderers have always drawn.
 */
export const END_MARKS = Object.freeze({ flow: 'chevron', reads: 'chevron', writes: 'chevron', calls: 'triangle', triggers: 'triangle', delivers: 'triangle', 'runs-on': 'bar', uses: 'diamond', extends: 'diamond' });
/** The shapes of the end marks and the ticks, in world units (the renderers draw them, the legend mirrors them): stroke width, a bar's and a tick's half length, a diamond's half length and half width */
export const END_SHAPES = Object.freeze({ strokeWidth: 1.8, barHalf: 5, diamondHalf: 6, diamondAcross: 4.5, tickHalf: 4, tickWidth: 1.6, tickGap: 6 });
/** The sizes of the silhouettes, as fractions of a node's radius: a rounded square's half side and corner, a hexagon's inradius, a square's half side and corner, a diamond's half diagonal (both renderers draw them) */
export const SHAPE_SIZES = Object.freeze({ roundedHalf: 0.9, roundedCorner: 0.3, hexInradius: 0.9, squareHalf: 0.86, squareCorner: 0.12, diamondHalf: 1.15 });
/** How far each silhouette reaches from its centre, as a fraction of the node's radius: a click or tap on a square's corner or a diamond's point is on the node (spatial.js hit-tests a disc this wide) */
export const SHAPE_REACH = Object.freeze({
  circle: 1,
  'rounded-square': (SHAPE_SIZES.roundedHalf - SHAPE_SIZES.roundedCorner) * Math.SQRT2 + SHAPE_SIZES.roundedCorner,
  hexagon: SHAPE_SIZES.hexInradius / Math.cos(Math.PI / 6),
  square: (SHAPE_SIZES.squareHalf - SHAPE_SIZES.squareCorner) * Math.SQRT2 + SHAPE_SIZES.squareCorner,
  diamond: SHAPE_SIZES.diamondHalf,
});
/** The dash a proposed edge is drawn with: the one dashed thing on the map (a usage link is dotted, a `when` is told by ticks) */
export const PROPOSED_DASH = Object.freeze([7, 5]);
/** The dash of a usage link: dots */
export const USAGE_DASH = Object.freeze([1.5, 4]);
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
  added: { ...MARK_SHAPES.added, color: DIFF_MARK_COLORS.dark.added, ringR: 9, ringWidth: 2, edgeWidth: 2.2, alpha: 1 },
  changed: { ...MARK_SHAPES.changed, color: DIFF_MARK_COLORS.dark.changed, ringR: 9, ringWidth: 2.5, edgeWidth: 2.4, alpha: 1 },
  removed: { ...MARK_SHAPES.removed, color: DIFF_MARK_COLORS.dark.removed, ringR: 9, ringWidth: 2, edgeWidth: 2, alpha: REMOVED_ALPHA },
  edit: { ...MARK_SHAPES.edit, color: DIFF_MARK_COLORS.dark.edit, ringR: 9, ringWidth: 3, edgeWidth: 2.4, alpha: 1 }, // dotted: not the same ring as a change
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
  mark: Object.fromEntries(Object.entries(MARK).map(([k, v]) => [k, { ...v, color: DIFF_MARK_COLORS.light[k] }])), // chosen to be 3:1 over the light ground and its glow (diff-marks.js)
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
  if (state.proposal && !showsNode(state.proposalView || 'diff', node)) return false; // Before hides what is added, After what is removed
  if (state.view === 'dataflow') return !!state.flow && state.flow.ids.has(node.id);
  if (state.view === 'house') return houseShowsNode(state, node); // the House view (spec 0029, PHY-11) draws its own set: house-model.js
  if (node.type === 'root') return true;
  return layerShows(state, node) || shownByProposal(state, node); // a proposal's own nodes are drawn whatever their layer says (spec 0009 D3)
}

/** Whether the Layers menu has the node's layer on: a project layer that takes it decides alone, else its starting layer, with the rules each type has */
export function layerShows(state, node) {
  const { activeLayers } = state;
  const project = projectLayerKey(state, node);
  if (project) return activeLayers[project] !== false;
  if (node.type === 'core') return (activeLayers.pkg || activeLayers.atom) && activeLayers.core !== false; // its own row in Layers, and Packages or Atoms
  if (node.type === 'store') return activeLayers.flow !== false && activeLayers.store !== false; // its own row, and Data Flow
  if (node.type === 'rom') return activeLayers.rom !== false && activeLayers.flow !== false;
  if (node.type === 'floor' || node.type === 'room') return activeLayers.house !== false; // the House layer (spec 0029)
  if (node.type === 'external') return activeLayers[externalLayer(node)] !== false; // the Cloud and Public web layers (spec 0031)
  return activeLayers[node.type] !== false;
}

/** The edges the current view draws and the selection walks (the House view adds its Cloud band's rolled-up lines: house-model.js) */
const viewEdgesOf = (state) => (state.view === 'dataflow' && state.flow ? state.flow.edges : state.view === 'house' ? houseViewEdges(state) : state.edges);

/**
 * The focus subgraph (spec 0008 D5): the selected node and every node one edge away, of any kind; `throughChildren` adds its
 * children's neighbours, `kind` keeps one kind of line. selection-model.js has the rule.
 * @param {{id:string}|null} selected
 * @param {object[]} edges the edges to walk
 * @param {{throughChildren?: boolean, kind?: string|null}} [opts]
 */
export function getActiveSubgraph(selected, edges, opts) {
  return activeSubgraph(selected, edges, opts);
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

  // A lit edge says its kind at its middle ("reads", "calls": spec 0008 D7); the label layer places the words below the node labels (labels.js)
  const kind = edgeKind(edge);
  let label = null;
  if (subgraph && connected) {
    const m = quadPoint(a, c, b, 0.5);
    label = { text: edge.count !== undefined && edge.label ? edge.label : kindEdgeWord(kind), x: m.x, y: m.y, color: style.color, italic: proposed }; // the House's rolled-up lines say how many calls they stand for
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
    dash: proposed ? PROPOSED_DASH : null, // a dash means "proposed" and nothing else (spec 0008 D7)
    ticks: whenTicks(edge), // a call into a cloud node: one tick at the middle when it bites at the next deploy, two at the next renewal (spec 0031)
    curve: { cx: c.x, cy: c.y },
    arrow: true,
    end: Object.hasOwn(END_MARKS, kind) ? END_MARKS[kind] : 'triangle',
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
      if (edge.dashed) { color = '#818cf8'; width = 2.0; glow = 8; glowColor = 'rgba(129, 140, 248, 0.7)'; dash = USAGE_DASH; }
      else { color = '#ffffff'; width = 2.4; glow = 10; glowColor = 'rgba(255, 255, 255, 0.8)'; }
    } else {
      color = 'rgba(255, 255, 255, 0.02)'; width = 0.8; dash = edge.dashed ? USAGE_DASH : null;
    }
  } else if (edge.dashed) {
    color = 'rgba(129, 140, 248, 0.35)'; width = 1.2; dash = USAGE_DASH;
  } else {
    color = 'rgba(255, 255, 255, 0.16)'; width = 1.4;
  }
  return {
    key: edgeKeyOf(edge), from: edge.from, to: edge.to, kind: edgeKind(edge),
    x1: source.x, y1: source.y, x2: target.x, y2: target.y, r1: source.r, r2: target.r,
    color, width, alpha: 1, dash, ticks: 0, curve: null, arrow: false, end: null, glow, glowColor, label: null, packet: null, mark: 'none', live: !!edge.live,
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
  if (edge.alpha >= 0.1) edge.alpha = Math.max(edge.alpha, EDGE_MIN_ALPHA) * (gone ? MARK.removed.alpha : look.alpha); // not under the selection's deep dimming
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
/** A node's group: its layer in the Layers menu (layers.js), one per kind but for the rooms and floors (House) and the outside nodes (Cloud, or the Public web) */
export const groupOf = (node) => (node.type === 'floor' || node.type === 'room' ? 'house' : node.type === 'external' ? externalLayer(node) : node.type);

/**
 * A node's fill before any theme token: its own `color` when that is a colour the browser reads, else its type's fill in NODE_THEMES (the
 * built-in the map's fill order ends on, core/layers.js `mapFillNames`). Checked here, once, so WebGL and Canvas 2D are given the same valid
 * fill and project data never reaches a shader or a `fillStyle` unchecked. The Layers menu's dot of a project layer reads it too (layers.js).
 */
export const fillOfNode = (node) => nodeColor(node.color) ?? (NODE_THEMES[node.type] || NODE_THEMES.external).color;

function buildNodes(state, subgraph) {
  const { nodes, selectedNode, searchQuery } = state;
  const found = searchQuery ? matchIds(nodes, searchQuery) : null; // what the search finds: label, id, file, type, kind (search-model.js)
  const searching = !!found && nodes.some((n) => found.has(n.id) && isNodeVisible(state, n)); // with no match on the map nothing dims: it would only be a blank map
  const out = [];
  const view = proposalView(state);
  const focus = view === 'diff' ? touchedIds(nodes, viewEdgesOf(state)) : null;

  nodes.forEach((node) => {
    if (!isNodeVisible(state, node)) return;

    const shown = view === 'before' ? beforeOf(node) : node; // Before reads a changed node as it was
    const match = !!found && found.has(node.id);
    const current = match && state.searchCurrent === node.id;
    const selected = !!selectedNode && selectedNode.id === node.id;
    const connected = subgraph ? subgraph.connectedNodeIds.has(node.id) : true;
    const child = subgraph && subgraph.childIds ? subgraph.childIds.has(node.id) : false;
    const mark = view ? markIn(view, node) : 'none';
    const look = MARK[mark];
    const gone = mark === 'edit' && node.editOp === 'removed'; // a node a what-if edit removes: violet ring, faded, label struck through
    // deep dimming for what is not connected; a proposal's Diff view fades what it does not touch, less deeply, and a removed node is faded too
    // A search's matches are what the reader asked for: a selection's focus does not dim them, so each keeps its label (spec 0008 D4)
    let alpha = subgraph && !connected && !(searching && match) ? DIM_ALPHA : 1;
    if (searching && !match && !selected && !(subgraph && connected)) alpha = DIM_ALPHA; // a search dims what it did not find, as a focus does
    if (focus && !focus.touched.has(node.id)) alpha = Math.min(alpha, PROPOSAL_DIM_ALPHA);
    if (look) alpha *= gone ? MARK.removed.alpha : look.alpha;
    const big = shown.type === 'root' || shown.type === 'app';
    // A finer kind (spec 0009): its letters, drawn in the node's core by the renderers (kind-letters.js), and the project layer that takes the node
    const letters = lettersOf(state, shown);
    const layer = projectLayerKey(state, shown);

    out.push({
      id: node.id, type: shown.type, group: groupOf(shown),
      ...(typeof shown.kind === 'string' && shown.kind ? { kind: shown.kind } : {}),
      ...(letters ? { letters } : {}),
      shape: shapeOf(shown.type), // the silhouette of the node's family (spec 0008 D8): circle, rounded-square, hexagon, square, diamond
      hitR: shown.r * SHAPE_REACH[shapeOf(shown.type)], // the disc a click or tap hits: as far as the silhouette reaches (spatial.js)
      ...(hasGlyph(shown.type) ? { glyph: shown.type } : {}), // its built-in glyph, drawn where the core dot is once the node is wide enough (glyphs.js)
      ...(layer ? { layer } : {}),
      x: node.x, y: node.y, r: shown.r, color: fillOfNode(shown),
      alpha,
      glow: connected && alpha >= 0.5 ? (big ? 15 : 9) : 0,
      halo: match ? 'match' : selected ? 'selected' : child ? 'child' : 'none',
      mark,
      selected, match, current, connected,
      degree: node.degree || 0,
      label: shown.label,
      labelSize: big ? 12 : 11,
      labelBold: big,
      labelAlpha: focus && !focus.touched.has(node.id) && !(subgraph && !connected) ? Math.max(alpha, DIFF_LABEL_ALPHA) : alpha, // a label the diff dims stays 3:1
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
  const subgraph = state.scenario ? scenarioSubgraph(state) : state.selectedNode ? getActiveSubgraph(state.selectedNode, viewEdgesOf(state), { throughChildren: !!state.throughChildren, kind: state.selectedKind || null }) : null;

  const lanes = preset && state.flow ? buildLanes(state.flow) : [];
  const rings = !(preset && state.flow) && !state.isFreeform ? buildRings(state) : [];

  const scene = {
    nodes: buildNodes(state, subgraph),
    edges: buildEdges(state, subgraph, !!opts.reduceMotion),
    decor: { grid: { size: 48, color: 'rgba(255, 255, 255, 0.035)', width: 0.5, margin: 200 }, rings, lanes },
    painted: { nodes: new Set(), edges: new Set() },
    preset,
    theme: 'dark',
    version: state.sceneVersion || 0,
  };
  if (state.view === 'house') decorateHouseScene(scene, state); // its bands and tray as lanes, rooms unlabelled (house-model.js)
  if (state.scenario) emphasiseScenario(scene, state.scenario, opts);
  const colours = { nodes: scene.nodes.map((n) => n.color), edges: scene.edges.map((e) => e.color) };
  if (state.scenario) paintOutage(scene, outageFor(state.scenario, state.nodes, state.edges)); // CLOUD-07: red, amber, violet by when the outage bites
  if (state.scenario) paintVerdict(scene, state.scenario); // PHY-10: red, green or amber by the step's permission check
  if (state.forgeLit) paintForge(scene, state.forgeLit); // CF-07: the selected pull request's nodes, the rest faded
  // The nodes and edges a painter above gave a colour: the map's own styling (map-style.js) leaves them to it
  scene.nodes.forEach((n, i) => { if (colours.nodes.length === scene.nodes.length && n.color !== colours.nodes[i]) scene.painted.nodes.add(n.id); });
  scene.edges.forEach((e, i) => { if (colours.edges.length === scene.edges.length && e.color !== colours.edges[i]) scene.painted.edges.add(e.key); });
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
