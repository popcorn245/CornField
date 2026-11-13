/**
 * @module explorer/renderer-webgl
 *
 * The WebGL2 renderer (spec 0012 A2, TOPO-03): draws a scene (scene.js) on the GPU. Like the
 * Canvas 2D reference it reads only the scene, the camera and the time it is handed, never what
 * the explorer keeps in its shared state object.
 *
 *   scene ──packNodes / packDecor──▶ typed arrays ──(only when the scene changed)──▶ GPU buffers
 *   camera, viewport ──────────────────────────────────────────────────────────────▶ uniforms
 *
 * Every pass is ONE instanced draw call (shaders.js has the GLSL and the layout of the per-instance
 * attributes), in Canvas 2D's order: the grid, the data-flow lane bands, the orbital rings (a unit quad
 * each), then the straight edges and the curved edges (a strip along the line, TOPO-04: stroke,
 * dashes, glow, anti-aliased), the tips (arrowheads, and the strike across a removed edge), the packets
 * (placed in the shader from `timeMs`, so a frame of moving packets uploads nothing), and the nodes
 * on top (circle, white core, glow, halo and mark, all anti-aliased from a signed distance). The
 * buffers are rebuilt only when `scene.version` (or the scene object) changes; a pan or a zoom is
 * three uniforms and uploads nothing.
 *
 * NOT here, on purpose: every piece of text (node labels, lane titles, edge labels) is the label
 * layer's (labels.js), a transparent Canvas 2D over this canvas. To add a pass here, give PASSES an
 * entry and `packScene` a field.
 *
 * The pure packing (`packNodes`, `packEdges`, `packDecor`, `styleTables`) is what the tests read: there is no GPU in CI.
 */

import { ARROW, CORE_RATIO, EDGE_STRIKE, END_SHAPES, SHAPE_SIZES, MARK_MIN_PX, edgePoint, looksFor, parseColor } from './scene.js';
import { GLYPH_TOKEN, ICON_RATIO, PLAIN_STYLE, looksWith, styledScene } from './engine/map-style.js';
import { LETTER_MIN_PX, LETTER_RATIO, isLetterKey, letterImage, letterKey, lettersOfKey } from './kind-letters.js';
import { GLYPH_MIN_PX, GLYPH_RATIO, glyphImage, glyphInk, glyphKey, glyphOfKey, isGlyphKey } from './glyphs.js';
import { SHAPES } from '../core/schema.js';
import {
  CURVE_SEGMENTS, EDGE_FRAG, GRID_FRAG, GRID_VERT, ICON_FRAG, ICON_VERT, LANE_FRAG, LANE_VERT, NODE_FRAG, NODE_VERT, PACKET_FRAG, PACKET_VERT,
  RING_FRAG, RING_VERT, TIP_FRAG, TIP_VERT, edgeVert,
} from './shaders.js';

// ---------------------------------------------------------------------------
//  Packing: scene -> typed arrays (pure)
// ---------------------------------------------------------------------------

/** Floats per node: x, y, r, alpha | red, green, blue, glow | halo code, mark code, colour alpha, shape code (SHAPE_CODE, plus GLYPH_FLAG when the type's glyph takes the core dot's place) */
export const NODE_STRIDE = 12;
/** Floats per ring: x, y, r, width | rgba | dash on, off */
export const RING_STRIDE = 10;
/** Floats per lane: x, y, w, h | fill rgba | stroke rgba | radius, stroke width */
export const LANE_STRIDE = 14;
/** Floats for the grid: size, width, 0, 0 | rgba */
export const GRID_STRIDE = 8;

/** Floats per edge: x1, y1, x2, y2 | control x, y, width, glow blur | rgba | glow rgb, glow strength | dash on, off | marked (0 or 1) */
export const EDGE_STRIDE = 19;
/** Floats per icon: x, y, side, alpha */
export const ICON_STRIDE = 4;
/** Floats per tip: x, y, direction x, y | rgba | kind (TIP_CODE) */
export const TIP_STRIDE = 9;
/** Floats per packet: x1, y1, x2, y2 | control x, y, speed, phase | rgba | glow rgb, glow strength | radius, glow blur */
export const PACKET_STRIDE = 18;

export const HALO_CODE = { none: 0, selected: 1, match: 2, child: 3 };
/** What a tip is: a filled arrowhead, the strike across a removed edge, and (spec 0008 D7) the open chevron, the bar and the open diamond that end the other families, and the tick of a `when` */
export const TIP_CODE = { arrow: 1, strike: 2, chevron: 3, bar: 4, diamond: 5, tick: 6 };
/** The silhouettes, as the node shader numbers them (core/schema.js SHAPES) */
export const SHAPE_CODE = Object.freeze(Object.fromEntries(SHAPES.map((name, i) => [name, i])));
/** Added to a node's shape code when its glyph is drawn in place of the white core dot (no theme icon, no letters): the shader leaves the dot out once the glyph shows */
export const GLYPH_FLAG = 8;
export const MARK_CODE = { none: 0, added: 1, changed: 2, removed: 3, edit: 4 };

/** A CSS colour as [r, g, b, a], all 0..1 */
const rgba = (css) => {
  const [r, g, b, a] = parseColor(css);
  return [r / 255, g / 255, b / 255, a];
};

const codeOf = (table, name) => (Object.hasOwn(table, name) ? table[name] : 0);

/**
 * @param {import('./scene.js').Scene} scene
 * @returns {{data: Float32Array, count: number, stride: number}} one row of NODE_STRIDE floats per node, in draw order
 */
export function packNodes(scene) {
  const { nodes } = scene;
  const data = new Float32Array(nodes.length * NODE_STRIDE);
  nodes.forEach((n, i) => {
    const [r, g, b, a] = rgba(n.color);
    // scene.js has already faded a removed node (MARK.removed.alpha is in n.alpha); the ring is the shader's (u_markGeom, u_markColor)
    data.set([n.x, n.y, n.r, n.alpha, r, g, b, n.glow || 0, codeOf(HALO_CODE, n.halo), codeOf(MARK_CODE, n.mark), a, codeOf(SHAPE_CODE, n.shape) + (n.glyph && !n.icon && !n.letters ? GLYPH_FLAG : 0)], i * NODE_STRIDE);
  });
  return { data, count: nodes.length, stride: NODE_STRIDE };
}

/**
 * @param {import('./scene.js').Scene} scene
 * @returns {{grid: Packed, rings: Packed, lanes: Packed}} where Packed is `{data, count, stride}`
 */
export function packDecor(scene) {
  const { grid, rings, lanes } = scene.decor;

  const gridData = new Float32Array(grid ? GRID_STRIDE : 0);
  if (grid) gridData.set([grid.size, grid.width, 0, 0, ...rgba(grid.color)]);

  const ringData = new Float32Array(rings.length * RING_STRIDE);
  rings.forEach((ring, i) => {
    const [on, off] = ring.dash && ring.dash.length >= 2 ? ring.dash : [0, 0];
    ringData.set([ring.x, ring.y, ring.r, ring.width, ...rgba(ring.color), on, off], i * RING_STRIDE);
  });

  const laneData = new Float32Array(lanes.length * LANE_STRIDE);
  lanes.forEach((lane, i) => {
    laneData.set([lane.x, lane.y, lane.w, lane.h, ...rgba(lane.fill), ...rgba(lane.stroke), lane.radius, lane.strokeWidth], i * LANE_STRIDE);
  });

  return {
    grid: { data: gridData, count: grid ? 1 : 0, stride: GRID_STRIDE },
    rings: { data: ringData, count: rings.length, stride: RING_STRIDE },
    lanes: { data: laneData, count: lanes.length, stride: LANE_STRIDE },
  };
}

/**
 * The edges, as four sets of rows. `straight` and `curved` are drawn as strips (a straight edge is a
 * quadratic with its control point at the midpoint, so both share one shader); `tips` are the arrowheads
 * and the strikes across removed edges; `packets` are the dots, which only need the edge and the time.
 * The scene's order is kept within each set. A mark's look (scene.js MARK) is already in the edge's own
 * `color`, `dash`, `width` and `alpha` (buildScene put it there, for every renderer); this only adds the
 * strike across a removed edge at its midpoint. Every colour carries the edge's alpha, so the shaders
 * have one alpha to think about.
 * @param {import('./scene.js').Scene} scene
 * @returns {{straight: Packed, curved: Packed, tips: Packed, packets: Packed}} where Packed is `{data, count, stride}`
 */
export function packEdges(scene) {
  const rows = { straight: [], curved: [], tips: [], packets: [] };

  scene.edges.forEach((edge) => {
    const [r, g, b, a] = rgba(edge.color);
    const alpha = edge.alpha;
    const lineAlpha = a * alpha;
    const [on, off] = edge.dash && edge.dash.length >= 2 ? edge.dash : [0, 0];
    const glows = edge.glow > 0 && !!edge.glowColor;
    const [gr, gg, gb, ga] = glows ? rgba(edge.glowColor) : [0, 0, 0, 0];
    const cx = edge.curve ? edge.curve.cx : (edge.x1 + edge.x2) / 2;
    const cy = edge.curve ? edge.curve.cy : (edge.y1 + edge.y2) / 2;
    const marked = edge.mark && edge.mark !== 'none' ? 1 : 0; // renderer-canvas2d.js drawEdge's own test: a mark keeps the line MARK_MIN_PX.edge thick on screen

    rows[edge.curve ? 'curved' : 'straight'].push([
      edge.x1, edge.y1, edge.x2, edge.y2, cx, cy, edge.width, glows ? edge.glow : 0, r, g, b, lineAlpha, gr, gg, gb, ga * lineAlpha, on, off, marked,
    ]);

    if (edge.arrow) {
      // along the end tangent: from the control point (a straight edge: from its start)
      const ang = Math.atan2(edge.y2 - (edge.curve ? edge.curve.cy : edge.y1), edge.x2 - (edge.curve ? edge.curve.cx : edge.x1));
      const code = edge.end && edge.end !== 'triangle' ? codeOf(TIP_CODE, edge.end) || TIP_CODE.arrow : TIP_CODE.arrow;
      rows.tips.push([edge.x2, edge.y2, Math.cos(ang), Math.sin(ang), r, g, b, lineAlpha, code]);
    }
    if (edge.ticks) {
      // across the middle, one or two, a few units apart along the chord (renderer-canvas2d.js drawTicks)
      const mid = edgePoint(edge, 0.5);
      const len = Math.hypot(edge.x2 - edge.x1, edge.y2 - edge.y1);
      const [dx, dy] = len > 0 ? [(edge.x2 - edge.x1) / len, (edge.y2 - edge.y1) / len] : [1, 0];
      for (let i = 0; i < edge.ticks; i++) {
        const along = (i - (edge.ticks - 1) / 2) * END_SHAPES.tickGap;
        rows.tips.push([mid.x + dx * along, mid.y + dy * along, dx, dy, r, g, b, lineAlpha, TIP_CODE.tick]);
      }
    }
    if (edge.mark === 'removed') {
      // across the edge at its midpoint (the quadratic's tangent there is its chord)
      const mid = edgePoint(edge, 0.5);
      const len = Math.hypot(edge.x2 - edge.x1, edge.y2 - edge.y1);
      const [dx, dy] = len > 0 ? [(edge.x2 - edge.x1) / len, (edge.y2 - edge.y1) / len] : [1, 0];
      rows.tips.push([mid.x, mid.y, dx, dy, r, g, b, lineAlpha, TIP_CODE.strike]);
    }

    if (edge.packet) {
      const p = edge.packet;
      const [pr, pg, pb, pa] = rgba(p.color);
      const [qr, qg, qb, qa] = rgba(p.glowColor);
      rows.packets.push([
        edge.x1, edge.y1, edge.x2, edge.y2, cx, cy, p.speed, p.phase, pr, pg, pb, pa * alpha, qr, qg, qb, qa * pa * alpha, p.radius, p.glow,
      ]);
    }
  });

  const pack = (list, stride) => {
    const data = new Float32Array(list.length * stride);
    list.forEach((row, i) => data.set(row, i * stride));
    return { data, count: list.length, stride };
  };
  return {
    straight: pack(rows.straight, EDGE_STRIDE),
    curved: pack(rows.curved, EDGE_STRIDE),
    tips: pack(rows.tips, TIP_STRIDE),
    packets: pack(rows.packets, PACKET_STRIDE),
  };
}

/** Everything the GPU needs from a scene */
export const packScene = (scene) => ({ ...packDecor(scene), nodes: packNodes(scene), ...packEdges(scene) });

/**
 * The outlines the theme gives nodes (--corn-map-stroke), as rows of the rings pass (the same shader, drawn over the nodes): a ring
 * just inside the circle's edge, in the node's alpha. Empty for a scene whose nodes have none.
 * @param {import('./scene.js').Scene} scene a scene through `styledScene`
 */
export function packStrokes(scene) {
  const rows = [];
  scene.nodes.forEach((n) => {
    if (!n.stroke) return;
    const [r, g, b, a] = rgba(n.stroke.color);
    rows.push([n.x, n.y, Math.max(0, n.r - n.stroke.width / 2), n.stroke.width, r, g, b, a * n.alpha, 0, 0]);
  });
  const data = new Float32Array(rows.length * RING_STRIDE);
  rows.forEach((row, i) => data.set(row, i * RING_STRIDE));
  return { data, count: rows.length, stride: RING_STRIDE };
}

/**
 * The icons of the nodes that have one, grouped by kind (one texture, one draw each), in scene order within a kind. A node with no theme icon
 * but a finer kind's letters (spec 0009 D5) goes in a group of its own letters (`letters:j`), drawn from the image in explorer/kind-letters.js;
 * a group says its smallest node's radius (`minR`), for the zoom below which its letters are not drawn.
 * @param {import('./scene.js').Scene} scene a scene through `styledScene`
 * @param {(kind: string) => boolean} has whether the kind's image has loaded (a letters key: whether its image could be made)
 * @returns {{data: Float32Array, count: number, stride: number, groups: {kind: string, first: number, count: number, minR: number}[]}}
 */
export function packIcons(scene, has, style = null) {
  const byKind = new Map();
  scene.nodes.forEach((n) => {
    let kind = n.icon && has(n.icon) ? n.icon : null;
    let side = n.r * ICON_RATIO;
    if (!kind && !n.icon && n.letters && has(letterKey(n.letters))) { kind = letterKey(n.letters); side = n.r * LETTER_RATIO; }
    if (!kind && !n.icon && !n.letters && n.glyph) { const key = glyphKey(n.glyph, glyphInk(n, style, scene.theme)); if (has(key)) { kind = key; side = n.r * GLYPH_RATIO; } } // the type's own glyph, last (glyphs.js)
    if (!kind) return;
    if (!byKind.has(kind)) byKind.set(kind, { rows: [], minR: Infinity, maxR: 0 });
    const group = byKind.get(kind);
    group.maxR = Math.max(group.maxR, n.r);
    group.rows.push([n.x, n.y, side, n.alpha]);
    group.minR = Math.min(group.minR, n.r);
  });
  const groups = [];
  const rows = [];
  for (const [kind, { rows: list, minR, maxR }] of byKind) {
    groups.push({ kind, first: rows.length, count: list.length, minR, maxR });
    rows.push(...list);
  }
  const data = new Float32Array(rows.length * ICON_STRIDE);
  rows.forEach((row, i) => data.set(row, i * ICON_STRIDE));
  return { data, count: rows.length, stride: ICON_STRIDE, groups };
}

/**
 * The looks of scene.js (halo, mark, core) as flat float arrays for uniforms, indexed by the codes
 * above, so the shaders hold no colour of their own and cannot drift from the Canvas 2D renderer.
 * `theme` picks `looksFor(theme)`: the renderer sets them again when a scene's theme differs from the last. `style` (map-style.js)
 * puts the theme's colours for the halos and the diff marks over them.
 */
export function styleTables(theme = 'dark', style = null) {
  const { halo: HALO, mark: MARK, core: CORE_COLOR } = style ? looksWith(looksFor(theme), style) : looksFor(theme);
  const haloFill = new Float32Array(16);
  const haloRing = new Float32Array(16);
  const haloGeom = new Float32Array(16);
  Object.entries(HALO_CODE).forEach(([name, code]) => {
    const look = HALO[name];
    if (!code || !look) return;
    haloFill.set(rgba(look.fill), code * 4);
    haloRing.set(rgba(look.ring), code * 4);
    haloGeom.set([look.fillR, look.ringR, look.ringWidth, 0], code * 4);
  });
  const markColor = new Float32Array(20);
  const markGeom = new Float32Array(20);
  Object.entries(MARK_CODE).forEach(([name, code]) => {
    if (!code) return;
    const look = MARK[name];
    markColor.set(rgba(look.color), code * 4);
    // each mark's own ring: ringR, ringWidth (world), dash on, dash off (0, 0 = solid)
    const [on, off] = look.ringDash || [0, 0];
    markGeom.set([look.ringR, look.ringWidth, on, off], code * 4);
  });
  return {
    haloFill, haloRing, haloGeom, markColor, markGeom,
    // However far out the camera is, a mark stays this big on screen (px): ring thickness, edge thickness, gap from the node
    markMin: new Float32Array([MARK_MIN_PX.ring, MARK_MIN_PX.edge, MARK_MIN_PX.gap]),
    core: new Float32Array(rgba(CORE_COLOR)),
    coreRatio: CORE_RATIO,
  };
}

// ---------------------------------------------------------------------------
//  The passes, drawn in this order (Canvas 2D's order: grid, lanes, rings, edges, nodes; the packets and
//  the arrowheads, which Canvas 2D draws edge by edge, come after all the lines and still under the nodes)
// ---------------------------------------------------------------------------

const STRAIGHT_VERTS = 2 * (1 + 3);
const CURVED_VERTS = 2 * (CURVE_SEGMENTS + 3);

/**
 * `name`: also the key of the packed rows (packScene). `attribs`: [location, floats, offset in floats] of
 * the per-instance attributes. A pass is a unit quad (location 0 is its corner, 4 vertices) unless it says
 * `verts`: then it has no corner buffer and its vertex shader works from gl_VertexID (the edge strips).
 * `constants`: which one-time uniforms it gets. `time`: it gets u_time every frame.
 */
export const PASSES = [
  { name: 'grid', vert: GRID_VERT, frag: GRID_FRAG, stride: GRID_STRIDE, attribs: [[1, 4, 0], [2, 4, 4]] },
  { name: 'lanes', vert: LANE_VERT, frag: LANE_FRAG, stride: LANE_STRIDE, attribs: [[1, 4, 0], [2, 4, 4], [3, 4, 8], [4, 2, 12]] },
  { name: 'rings', vert: RING_VERT, frag: RING_FRAG, stride: RING_STRIDE, attribs: [[1, 4, 0], [2, 4, 4], [3, 2, 8]] },
  { name: 'straight', vert: edgeVert(1), frag: EDGE_FRAG, stride: EDGE_STRIDE, verts: STRAIGHT_VERTS, attribs: [[1, 4, 0], [2, 4, 4], [3, 4, 8], [4, 4, 12], [5, 2, 16], [6, 1, 18]], constants: 'edges' },
  { name: 'curved', vert: edgeVert(CURVE_SEGMENTS), frag: EDGE_FRAG, stride: EDGE_STRIDE, verts: CURVED_VERTS, attribs: [[1, 4, 0], [2, 4, 4], [3, 4, 8], [4, 4, 12], [5, 2, 16], [6, 1, 18]], constants: 'edges' },
  { name: 'tips', vert: TIP_VERT, frag: TIP_FRAG, stride: TIP_STRIDE, attribs: [[1, 4, 0], [2, 4, 4], [3, 1, 8]], constants: 'tips' },
  { name: 'packets', vert: PACKET_VERT, frag: PACKET_FRAG, stride: PACKET_STRIDE, attribs: [[1, 4, 0], [2, 4, 4], [3, 4, 8], [4, 4, 12], [5, 2, 16]], time: true },
  { name: 'nodes', vert: NODE_VERT, frag: NODE_FRAG, stride: NODE_STRIDE, attribs: [[1, 4, 0], [2, 4, 4], [3, 4, 8]], constants: 'nodes' },
];

/** The uniforms that never change, set once per program (the looks live in scene.js, nowhere else) */
const CONSTANTS = {
  nodes(gl, at, tables) {
    gl.uniform4fv(at('u_haloFill'), tables.haloFill);
    gl.uniform4fv(at('u_haloRing'), tables.haloRing);
    gl.uniform4fv(at('u_haloGeom'), tables.haloGeom);
    gl.uniform4fv(at('u_markColor'), tables.markColor);
    gl.uniform4fv(at('u_markGeom'), tables.markGeom);
    gl.uniform3fv(at('u_markMin'), tables.markMin);
    gl.uniform4fv(at('u_core'), tables.core);
    gl.uniform1f(at('u_coreRatio'), tables.coreRatio);
    gl.uniform4f(at('u_shape'), SHAPE_SIZES.roundedHalf, SHAPE_SIZES.roundedCorner, SHAPE_SIZES.hexInradius, SHAPE_SIZES.squareHalf);
    gl.uniform2f(at('u_shape2'), SHAPE_SIZES.squareCorner, SHAPE_SIZES.diamondHalf);
    gl.uniform1f(at('u_glyphMin'), GLYPH_MIN_PX);
  },
  edges(gl, at, tables) {
    gl.uniform3fv(at('u_markMin'), tables.markMin);
  },
  tips(gl, at) {
    gl.uniform4f(at('u_tip'), ARROW.length, ARROW.spread, EDGE_STRIKE.halfLength, EDGE_STRIKE.width);
    gl.uniform4f(at('u_end'), END_SHAPES.strokeWidth, END_SHAPES.barHalf, END_SHAPES.diamondHalf, END_SHAPES.diamondAcross);
    gl.uniform2f(at('u_tick'), END_SHAPES.tickHalf, END_SHAPES.tickWidth);
  },
};

/** What the canvas is asked for: premultiplied alpha over the page, no multisampling (the shaders anti-alias), nothing kept between frames */
export const CONTEXT_ATTRS = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' };

function compile(gl, type, source, label) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`${label} shader did not compile: ${log}`);
  }
  return shader;
}

function link(gl, vertSource, fragSource, label) {
  const vert = compile(gl, gl.VERTEX_SHADER, vertSource, `${label} vertex`);
  const frag = compile(gl, gl.FRAGMENT_SHADER, fragSource, `${label} fragment`);
  const program = gl.createProgram();
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`${label} program did not link: ${log}`);
  }
  return program;
}

/** Sets the one-time uniforms of every pass that has them, for `theme`'s looks */
/** What of a style the constants depend on: 0 for the plain one, else its version */
const styleKey = (style) => (!style || style.plain ? 0 : style.version);

function setConstants(gl, gpu, theme, style = null) {
  const tables = styleTables(theme, style);
  gpu.passes.forEach((pass) => {
    if (!pass.spec.constants) return;
    gl.useProgram(pass.program);
    CONSTANTS[pass.spec.constants](gl, pass.at, tables);
  });
  gpu.theme = theme;
  gpu.styleKey = styleKey(style);
}

/** One pass's program, vertex array and buffer (a unit quad per instance, unless the spec has `verts`) */
function makePass(gl, spec, corners) {
  const program = link(gl, spec.vert, spec.frag, spec.name);
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  if (!spec.verts) {
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  spec.attribs.forEach(([location, size, offset]) => {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, spec.stride * 4, offset * 4);
    gl.vertexAttribDivisor(location, 1);
  });
  gl.bindVertexArray(null);

  const at = (name) => gl.getUniformLocation(program, name);
  return { spec, program, vao, buffer, at, count: 0, uniforms: { viewport: at('u_viewport'), cam: at('u_cam'), dpr: at('u_dpr'), time: spec.time ? at('u_time') : null } };
}

/**
 * The passes only a theme asks for, built the first time one is needed so a map with no theme costs nothing: the node outlines (the rings
 * shader, drawn over the nodes) and the icons (a textured square per node), after the nodes, in this order.
 */
export const EXTRA_PASSES = {
  strokes: { name: 'strokes', vert: RING_VERT, frag: RING_FRAG, stride: RING_STRIDE, attribs: [[1, 4, 0], [2, 4, 4], [3, 2, 8]] },
  icons: { name: 'icons', vert: ICON_VERT, frag: ICON_FRAG, stride: ICON_STRIDE, attribs: [[1, 4, 0]] },
};

/** Programs, vertex arrays and buffers for every pass, on this context, with `theme`'s looks. Throws when a shader fails. */
function buildGpu(gl, theme = 'dark', style = null) {
  const corners = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const passes = PASSES.map((spec) => makePass(gl, spec, corners));
  const gpu = { corners, passes, theme, styleKey: 0, extras: { strokes: null, icons: null }, textures: new Map(), iconStore: null };
  setConstants(gl, gpu, theme, style);
  return gpu;
}

function destroyGpu(gl, gpu) {
  gl.deleteBuffer(gpu.corners);
  gpu.textures.forEach(({ texture }) => gl.deleteTexture(texture));
  [...gpu.passes, ...Object.values(gpu.extras).filter(Boolean)].forEach((p) => {
    gl.deleteProgram(p.program);
    gl.deleteVertexArray(p.vao);
    gl.deleteBuffer(p.buffer);
  });
}

// ---------------------------------------------------------------------------
//  The renderer
// ---------------------------------------------------------------------------

/**
 * @param {HTMLCanvasElement} canvas the canvas to draw on (it must not have given a 2d context)
 * @param {{gl?: WebGL2RenderingContext, mapStyle?: () => import('./map-style.js').MapStyle}} [opts] `gl`: a context already taken from the canvas.
 *   `mapStyle`: where the theme's map tokens and icons come from: the instance's (`mapStyleOf(inst).get`); none: no theme
 * @returns {import('./scene.js').Renderer & {stats: {uploads: number, draws: number}}}
 * @throws {Error} when there is no WebGL2 context or a shader fails to compile or link
 */
export function createWebglRenderer(canvas, opts = {}) {
  const gl = opts.gl || canvas.getContext('webgl2', CONTEXT_ATTRS);
  if (!gl) throw new Error('WebGL2 is not available');

  const styleOf = opts.mapStyle || (() => PLAIN_STYLE);
  const stats = { uploads: 0, draws: 0 };
  let gpu = buildGpu(gl);
  let lost = false;
  let width = 0;
  let height = 0;
  let packed = null;
  let packedScene = null;
  let packedVersion;
  let packedGround = null; // the ground the icon rows were packed for: a translucent node's glyph ink depends on it (glyphs.js)
  let lastArgs = null;

  /** A pass only a theme asks for (EXTRA_PASSES), built the first time it is wanted */
  function extra(name) {
    if (!gpu.extras[name]) gpu.extras[name] = makePass(gl, EXTRA_PASSES[name], gpu.corners);
    return gpu.extras[name];
  }

  /** Copies the packed arrays into the GPU buffers (only when the scene changed, or after a restore) */
  function upload() {
    gpu.passes.forEach((pass) => {
      const rows = packed[pass.spec.name];
      pass.count = rows.count;
      if (!rows.count) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, pass.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, rows.data, gl.DYNAMIC_DRAW);
    });
    for (const name of Object.keys(EXTRA_PASSES)) {
      const rows = packed[name];
      if (!rows.count && !gpu.extras[name]) continue;
      const pass = extra(name);
      pass.count = rows.count;
      if (!rows.count) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, pass.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, rows.data, gl.DYNAMIC_DRAW);
    }
    stats.uploads++;
  }

  /** Nearest-neighbour sampling when the theme is pixelated (theme.pixelated), else smooth with mipmaps */
  function sample(texture, pixelated) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, pixelated ? gl.NEAREST : gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, pixelated ? gl.NEAREST : gl.LINEAR);
  }

  /** The texture of a kind's icon: made when the image is first drawn, sampled as the style says */
  function textureOf(kind, image, pixelated) {
    let entry = gpu.textures.get(kind);
    if (!entry || entry.image !== image) {
      if (entry) gl.deleteTexture(entry.texture);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); // the context blends premultiplied
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.generateMipmap(gl.TEXTURE_2D);
      entry = { image, texture, pixelated: null };
      gpu.textures.set(kind, entry);
    }
    if (entry.pixelated !== pixelated) { sample(entry.texture, pixelated); entry.pixelated = pixelated; }
    return entry.texture;
  }

  function draw(drawn, camera, timeMs) {
    lastArgs = [drawn, camera, timeMs];
    if (lost || !gpu || !width || !height) return;
    const style = styleOf();
    const scene = styledScene(drawn, style); // the map in the theme's colours, outlines and icons (map-style.js); the scene itself when nothing is set
    const ink = style.values ? style.values[GLYPH_TOKEN] : undefined; // the theme's glyph ink: the letters' and glyphs' textures are made in it
    if (gpu.iconStore !== style.icons || gpu.glyphInk !== ink) { // a new set of icons (or none), or another ink: the old ones' textures go now, not when the renderer does
      gpu.textures.forEach(({ texture }) => gl.deleteTexture(texture));
      gpu.textures.clear();
      gpu.iconStore = style.icons;
      gpu.glyphInk = ink;
      packedScene = null; // the icon rows are made again for the new ink
    }
    if (packedGround !== style.ground) { packedGround = style.ground; packedScene = null; } // another ground: a translucent node's glyph may take the other ink
    if (scene !== packedScene || scene.version !== packedVersion) {
      packed = { ...packScene(scene), strokes: packStrokes(scene), icons: packIcons(scene, (kind) => (isLetterKey(kind) ? !!letterImage(lettersOfKey(kind), ink) : isGlyphKey(kind) ? !!glyphImage(glyphOfKey(kind).type, glyphOfKey(kind).ink) : !!(style.icons && style.icons.get(kind))), style) };
      packedScene = scene;
      packedVersion = scene.version;
      upload();
    }
    const theme = scene.theme || 'dark';
    if (gpu.theme !== theme || gpu.styleKey !== styleKey(style)) setConstants(gl, gpu, theme, style); // the halos, mark rings and core of the other ground, in the theme's colours

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gpu.passes.forEach((pass) => {
      if (!pass.count) return;
      gl.useProgram(pass.program);
      gl.uniform2f(pass.uniforms.viewport, width, height);
      gl.uniform3f(pass.uniforms.cam, camera.x, camera.y, camera.zoom);
      gl.uniform1f(pass.uniforms.dpr, canvas.width / width);
      gl.bindVertexArray(pass.vao);
      if (pass.uniforms.time) gl.uniform1f(pass.uniforms.time, (timeMs || 0) / 1000);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, pass.spec.verts || 4, pass.count);
      stats.draws++;
    });

    // Over the nodes, only when the theme gave some an outline or an icon
    const strokes = gpu.extras.strokes;
    if (strokes && strokes.count) {
      gl.useProgram(strokes.program);
      gl.uniform2f(strokes.uniforms.viewport, width, height);
      gl.uniform3f(strokes.uniforms.cam, camera.x, camera.y, camera.zoom);
      gl.uniform1f(strokes.uniforms.dpr, canvas.width / width);
      gl.bindVertexArray(strokes.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, strokes.count);
      stats.draws++;
    }
    const icons = gpu.extras.icons;
    if (icons && icons.count) {
      gl.useProgram(icons.program);
      gl.uniform2f(icons.uniforms.viewport, width, height);
      gl.uniform3f(icons.uniforms.cam, camera.x, camera.y, camera.zoom);
      gl.uniform1f(icons.uniforms.dpr, canvas.width / width);
      gl.uniform1i(icons.at('u_tex'), 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindVertexArray(icons.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, icons.buffer);
      for (const group of packed.icons.groups) {
        const letters = isLetterKey(group.kind);
        const glyph = isGlyphKey(group.kind);
        // Letters and a glyph are drawn only on a node wide enough on screen (kind-letters.js, glyphs.js): the vertex shader drops each
        // smaller one, as Canvas 2D does node by node, and a group whose largest node is under it is not drawn at all
        const minPx = letters ? LETTER_MIN_PX : glyph ? GLYPH_MIN_PX : 0;
        if (minPx && group.maxR * 2 * camera.zoom < minPx) continue;
        gl.uniform1f(icons.at('u_minR'), minPx / 2);
        gl.uniform1f(icons.at('u_sideRatio'), letters ? LETTER_RATIO : glyph ? GLYPH_RATIO : 1);
        const image = letters ? letterImage(lettersOfKey(group.kind), style.values && style.values[GLYPH_TOKEN]) : glyph ? glyphImage(glyphOfKey(group.kind).type, glyphOfKey(group.kind).ink) : style.icons && style.icons.get(group.kind);
        if (!image) continue;
        gl.bindTexture(gl.TEXTURE_2D, textureOf(group.kind, image, !!style.pixelated && !letters && !glyph));
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, ICON_STRIDE * 4, group.first * ICON_STRIDE * 4); // this kind's rows
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, group.count);
        stats.draws++;
      }
    }
    gl.bindVertexArray(null);
  }

  const onLost = (event) => {
    event.preventDefault(); // lets the browser give the context back
    lost = true;
    gpu = null; // every GL object died with the context
  };
  const onRestored = () => {
    try {
      gpu = buildGpu(gl, lastArgs ? lastArgs[0].theme || 'dark' : 'dark', styleOf());
      lost = false;
      if (packed) upload();
      if (lastArgs) draw(...lastArgs);
    } catch (err) {
      console.warn('WebGL2 context restored but the renderer could not be rebuilt:', err.message);
    }
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  return {
    kind: 'webgl2',
    stats,

    resize(w, h, ratio) {
      width = w;
      height = h;
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
      if (lastArgs) draw(...lastArgs); // resizing clears the drawing buffer
    },

    draw,

    /** Frees what this renderer made on the GPU. The canvas keeps its context: a canvas hands out one WebGL context for its life, so a renderer
     * made after this one on the same canvas (a renderer switch) draws with that same context, which must still be alive */
    destroy,

    /** destroy(), then gives the context back: a browser keeps only a handful of live ones. Only for the end of the canvas's map (engine/render.js
     * `map.destroy()`): a context lost on purpose cannot be had again from that canvas */
    release() {
      const wasLost = lost;
      destroy();
      try { const lose = !wasLost && gl.getExtension ? gl.getExtension('WEBGL_lose_context') : null; if (lose) lose.loseContext(); } catch { /* already gone */ }
    },
  };

  function destroy() {
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    if (gpu && !lost) destroyGpu(gl, gpu);
    gpu = null;
    lost = true; // draws nothing more
  }
}
