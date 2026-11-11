/**
 * @module explorer/labels
 *
 * The label overlay (spec 0012 A3, TOPO-05; spec 0008 D2): every label the map shows, drawn by one layer on
 * a transparent canvas stacked over the map canvas, for either renderer. Three parts:
 *
 *   placeLabels(scene, zoom)                      pure: which node labels fit at this zoom, and where (cached by zoom)
 *   chooseLabels(scene, camera, viewport)         pure: the text to draw, in world coordinates, for this view
 *   createLabelLayer(canvas)                      draws that on a 2d canvas, and only when something changed
 *
 * The rule (D2). Every visible node is a candidate at every zoom: there is no zoom cut-off. Candidates are tried in a fixed
 * priority order, and a label whose screen box (plus LABEL_PAD px) touches one already placed is skipped, so no two labels
 * ever collide at any zoom. The order: the selection; the current search match, then the other matches; the selection's lit
 * neighbours; the nodes a proposal (or an outage, or a pull request) marks; hubs (the landmark types: a cluster's title);
 * then the rest, the larger disc first, then the more edges, then scene order. It does not depend on the camera, so a pan never
 * reshuffles it: the placement is made for the whole map at a zoom (a box is `zoom` times its world size, offset from the
 * origin, wherever the camera is), cached per scene and zoom, and the view only picks the boxes that reach the screen.
 * A label is never drawn under 11 px (a hub's, 13 px, bold; a theme may raise the 11 with `--corn-map-label-min`): text that
 * would be smaller is not drawn smaller, it competes for room at 11 px. Zoomed in, it grows with the map.
 * A node left without a label is named by a chip over everything else while the pointer is on it (`hover`).
 * Lane titles, notes and arrows are always included and take no part in the placing. The kind words on a selection's lit edges (spec 0008 D7) are placed last, after every node label: a word is drawn only where it touches no node label, no lit node's disc and no word before it.
 * The layer redraws only when the camera, the scene, the size or the hover changed, so a packet frame (the renderer
 * redrawing for animation) costs the labels nothing.
 *
 * Pure like scene.js apart from the layer's own canvas: it reads a scene, a camera and a size,
 * never the explorer's state.
 *
 * @typedef {object} LabelItem One piece of text to draw
 * @property {'node'|'edge'|'lane'|'chip'} kind  `edge`: a kind word on a lit edge, in screen space
 * @property {string} [id]        the node, for `kind: 'node'` and `'chip'`
 * @property {string} text
 * @property {number} x           world coordinates; the text is drawn on this baseline point
 * @property {number} y
 * @property {number} size        px in world units (the camera's zoom scales it, as it scales the map)
 * @property {boolean} bold
 * @property {boolean} italic
 * @property {string} color       fill
 * @property {number} alpha       0..1
 * @property {{color:string, width:number}|null} outline  drawn under the fill so the text reads over lines
 * @property {'center'} align
 * @property {string} family      CSS font-family
 * @property {boolean} [strike]   a line through the text: a node a proposal removes
 * @property {number} [px]         a node's label: its size on screen (px)
 * @property {boolean} [screen]   a node's label at its minimum size: drawn in screen space at `px`, so the font stays one string while the zoom changes (a changing font string is the slow part of drawing text)
 */

import { FONT_EDGE, FONT_NODE, HUB_LABEL_EXTRA_PX, LABEL_MIN_FLOOR, LABEL_MIN_PX, LANDMARK_TYPES, looksFor } from './scene.js';
import { getMapStyle, styledScene } from './map-style.js';

/** At most this many node labels in view at a time (lane text and selection edge labels are extra); the placing itself never needs it */
export const MAX_LABELS = 400;
/** At most this many kind words on the lit edges in view (spec 0008 D7) */
export const MAX_EDGE_WORDS = 120;
/** A label this many screen px past the viewport is still kept, so none pops in at the border */
export const CULL_MARGIN = 32;
/** A label whose box, this many px bigger on every side, touches a placed one is skipped: placed labels are at least this far apart */
export const LABEL_PAD = 2;
/** A label dimmer than this (a node the focus or a search dims) takes no room: nobody can read it */
export const MIN_LABEL_ALPHA = 0.15;
/** A label's box: this many sizes above its baseline, and this many below */
const ASCENT = 1;
const DESCENT = 0.3;
/** Average glyph width, in sizes, when nothing measures the text */
const GLYPH = 0.58;
/** The gap between a disc and its label (px; at least the 3 world units it was, once zoomed in) */
const GAP_PX = 3;
/** The size text is measured at (then scaled): one measurement per string, whatever the zoom */
const REF = 100;
/** The grid the placing looks for neighbours in (px) */
const CELL = 64;

/** Priority tiers, best first */
const TIER = { selected: 0, current: 1, match: 2, lit: 3, marked: 4, hub: 5, rest: 6 };

/**
 * The smallest label size on screen (px) for a theme's `--corn-map-label-min` (a number, or null for `auto`): a theme may raise the 11 px,
 * never lower it (spec 0008, open question 3). 9 and 10 px are read but drawn at 11; under 9 px is not read at all (map-style.js), and
 * `validate` warns.
 * @param {number|null|undefined} value
 */
export const labelMinPx = (value) => (Number.isFinite(value) && value >= LABEL_MIN_FLOOR ? Math.max(LABEL_MIN_PX, value) : LABEL_MIN_PX);
/** The smallest label size on screen (px) for a scene: the theme's `--corn-map-label-min`, never under 11 */
export const labelMinOf = (scene) => labelMinPx(scene.labelMin);

const isHub = (node) => LANDMARK_TYPES.includes(node.type);

const tierOf = (node, focused) => (node.selected ? TIER.selected
  : node.current ? TIER.current
    : node.match ? TIER.match
      : focused && node.connected ? TIER.lit
        : (node.mark && node.mark !== 'none') || (node.labelKeep && !isHub(node)) ? TIER.marked
          : isHub(node) ? TIER.hub : TIER.rest);

/**
 * Which node labels fit at `zoom`, and where. The whole map, not the view: a box is in zoom-scaled world coordinates (`x * zoom`, no
 * camera), so the answer is the same wherever the camera is and can be kept for as long as the scene and the zoom stay.
 * @param {import('./scene.js').Scene} scene
 * @param {number} zoom
 * @param {{measure?: (text: string, size: number, bold: boolean) => number}} [opts]
 *   `measure`: the width of a text at that font size (px); default: an estimate from its length
 * @returns {{index: number, id: string, rank: number, tier: number, px: number, bold: boolean, size: number, x: number, y: number, node: object, l: number, t: number, r: number, b: number}[]}
 *   in priority order: `rank` is the place in it
 */
export function placeLabels(scene, zoom, opts = {}) {
  const { measure = null } = opts;
  const min = labelMinOf(scene);
  const focused = scene.nodes.some((n) => n.selected || !n.connected);
  const cands = [];
  scene.nodes.forEach((node, index) => {
    if (!node.label || !(node.labelAlpha >= MIN_LABEL_ALPHA)) return;
    cands.push({ node, index, tier: tierOf(node, focused) });
  });
  cands.sort((a, b) => a.tier - b.tier || b.node.r - a.node.r || (b.node.degree || 0) - (a.node.degree || 0) || a.index - b.index);

  const grid = new Map(); // cell -> the placed boxes that reach it; the key is a number (a string key per cell was most of the time)
  const cellKey = (i, j) => (i + 8192) * 16384 + (j + 8192);
  const placed = [];
  const gap = Math.max(GAP_PX, GAP_PX * zoom);
  for (const { node, index, tier } of cands) {
    const hub = isHub(node);
    const bold = !!node.labelBold || hub;
    const px = Math.max(hub ? min + HUB_LABEL_EXTRA_PX : min, node.labelSize * zoom);
    const w = measure ? (measure(node.label, REF, bold) * px) / REF : node.label.length * px * GLYPH;
    const cx = node.x * zoom;
    const baseline = node.y * zoom + node.r * zoom + gap + px;
    const l = cx - w / 2, r = cx + w / 2, t = baseline - px * ASCENT, b = baseline + px * DESCENT;
    // Touching a placed box, give or take LABEL_PAD: skipped
    const i0 = Math.floor((l - LABEL_PAD) / CELL), i1 = Math.floor((r + LABEL_PAD) / CELL);
    const j0 = Math.floor((t - LABEL_PAD) / CELL), j1 = Math.floor((b + LABEL_PAD) / CELL);
    let hit = false;
    for (let i = i0; i <= i1 && !hit; i++) {
      for (let j = j0; j <= j1 && !hit; j++) {
        const cell = grid.get(cellKey(i, j));
        if (!cell) continue;
        for (let k = 0; k < cell.length; k++) {
          const o = cell[k];
          if (l - LABEL_PAD < o.r && r + LABEL_PAD > o.l && t - LABEL_PAD < o.b && b + LABEL_PAD > o.t) { hit = true; break; }
        }
      }
    }
    if (hit) continue;
    const item = {
      index, id: node.id, rank: placed.length, tier, px, bold, screen: node.labelSize * zoom <= (hub ? min + HUB_LABEL_EXTRA_PX : min), size: px / zoom, x: node.x, y: node.y + node.r + (gap + px) / zoom,
      node, l, t, r, b,
    };
    placed.push(item);
    const ci0 = Math.floor(l / CELL), ci1 = Math.floor(r / CELL), cj0 = Math.floor(t / CELL), cj1 = Math.floor(b / CELL);
    for (let i = ci0; i <= ci1; i++) for (let j = cj0; j <= cj1; j++) {
      const key = cellKey(i, j);
      const cell = grid.get(key);
      if (cell) cell.push(item); else grid.set(key, [item]);
    }
  }
  return placed;
}

/**
 * The text to draw for `scene` seen through `camera` in a `viewport`
 * @param {import('./scene.js').Scene} scene
 * @param {import('./scene.js').Camera} camera
 * @param {{width:number, height:number}} viewport CSS px
 * @param {{max?:number, margin?:number, measure?:(text:string, size:number, bold:boolean) => number, hover?:string|null,
 *   placed?: ReturnType<typeof placeLabels>}} [opts]
 *   `max` node labels in view (default 400); `margin` px past the viewport (default 32); `measure` the width of a text at a font
 *   size (default: an estimate from its length); `hover`: the node the pointer is on, named by a chip when it has no label;
 *   `placed`: the placing for this scene at this zoom, when the caller has kept it (default: made here)
 * @returns {LabelItem[]} lane text, then node labels in scene order, then the words on the lit edges, then the chip
 */
export function chooseLabels(scene, camera, viewport, opts = {}) {
  const { max = MAX_LABELS, margin = CULL_MARGIN, measure = null, hover = null } = opts;
  const out = [];
  const outline = scene.labelOutline || looksFor(scene.theme).labelOutline; // the ground's own colour (or the theme's --corn-map-label-halo), under the text

  // Always there: the data-flow lanes' titles, notes and arrows ...
  for (const lane of scene.decor.lanes) {
    for (const t of [lane.title, lane.note, lane.arrow]) {
      if (t) out.push({ kind: 'lane', text: t.text, x: t.x, y: t.y, size: t.size, bold: t.bold, italic: false, color: t.color, alpha: 1, outline: null, align: 'center', family: scene.labelFont || FONT_NODE });
    }
  }
  // Node labels: the placing for this zoom, then the boxes that reach the viewport
  const { zoom } = camera;
  const placed = opts.placed || placeLabels(scene, zoom, { measure });
  const minX = -margin - camera.x, maxX = viewport.width + margin - camera.x;
  const minY = -margin - camera.y, maxY = viewport.height + margin - camera.y;
  let inView = placed.filter((p) => p.r >= minX && p.l <= maxX && p.b >= minY && p.t <= maxY);
  // Over the cap: the best `max` (the placing is in priority order, so the same ones win while the view pans)
  if (inView.length > max) inView = inView.slice(0, Math.max(0, max)); // placed is in priority order
  inView.sort((a, b) => a.index - b.index); // drawn in scene order, as the circles are
  const family = scene.labelFont || FONT_NODE;
  for (const p of inView) {
    const k = Math.max(1, 1 / zoom); // the outline keeps its weight on screen (3.5 px) when zoomed out, and grows with the map when zoomed in
    out.push({ kind: 'node', id: p.id, text: p.node.label, x: p.x, y: p.y, size: p.size, bold: p.bold, italic: false, color: p.node.labelColor, alpha: p.node.labelAlpha, outline: outline.node ? { color: outline.node.color, width: outline.node.width * k } : null, align: 'center', family, strike: !!p.node.labelStrike, px: p.px, screen: p.screen });
  }

  // The words on the lit edges ("reads", "calls": spec 0008 D7) go last, below every node label: one is placed only where it touches no node label, no lit
  // node's disc and no word placed before it, so it never covers a name; at the label minimum size, in screen space
  const px = labelMinOf(scene);
  const taken = inView.map((p) => ({ l: camera.x + p.l, r: camera.x + p.r, t: camera.y + p.t, b: camera.y + p.b }));
  for (const n of scene.nodes) {
    if (n.alpha < 0.5) continue;
    const cx = camera.x + n.x * zoom, cy = camera.y + n.y * zoom, rr = n.r * zoom;
    if (cx + rr < 0 || cx - rr > viewport.width || cy + rr < 0 || cy - rr > viewport.height) continue;
    taken.push({ l: cx - rr, r: cx + rr, t: cy - rr, b: cy + rr });
  }
  let words = 0;
  for (const edge of scene.edges) {
    const l = edge.label;
    if (!l || words >= MAX_EDGE_WORDS) continue;
    const sx = camera.x + l.x * zoom, sy = camera.y + l.y * zoom;
    if (sx < 0 || sx > viewport.width || sy < 0 || sy > viewport.height) continue;
    const w = (measure ? measure(l.text, px, false) : l.text.length * px * 0.55) / 2 + LABEL_PAD;
    const box = { l: sx - w, r: sx + w, t: sy - px * 0.6 - LABEL_PAD, b: sy + px * 0.6 + LABEL_PAD };
    if (taken.some((o) => box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t)) continue;
    taken.push(box);
    words++;
    out.push({ kind: 'edge', text: l.text, x: l.x, y: l.y + (px * 0.35) / zoom, size: px / zoom, px, screen: true, bold: false, italic: !!l.italic, color: l.color, alpha: edge.alpha, outline: outline.edge, align: 'center', family: scene.labelFont || FONT_EDGE });
  }

  // The chip: a node with no label, named while the pointer is on it
  if (hover) {
    const node = scene.nodes.find((n) => n.id === hover);
    if (node && node.label && !placed.some((p) => p.id === hover && inView.includes(p))) {
      const px = labelMinOf(scene);
      const above = camera.y + node.y * zoom - node.r * zoom > 40; // room above it, else below
      const y = above ? node.y - node.r - (GAP_PX + 2) / zoom : node.y + node.r + (GAP_PX + 2 + px) / zoom;
      out.push({ kind: 'chip', id: node.id, text: node.label, x: node.x, y, size: px / zoom, px, screen: true, bold: false, italic: false, color: (scene.nodes.find((n) => n.connected) || node).labelColor, alpha: 1, outline: outline.node, align: 'center', family, strike: false });
    }
  }
  return out;
}

const fontOf = (t) => `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${t.screen ? t.px : t.size}px ${t.family}`;

/** Where an item goes on the canvas: `ox`, `oy` and `k`, from world to the context (the world pass draws under the camera's transform, so `{0, 0, 1}`; the screen pass under none) */
const WORLD = { ox: 0, oy: 0, k: 1 };

/** The chip behind a hovered node's name: a rounded box in the label outline's colour, over everything else (drawn in screen space) */
function drawChip(ctx, t, v) {
  ctx.font = fontOf(t);
  const pad = 4;
  const w = ctx.measureText(t.text).width + pad * 2;
  const h = t.px * (ASCENT + DESCENT) + pad;
  const tx = v.ox + t.x * v.k, ty = v.oy + t.y * v.k;
  const x = tx - w / 2, y = ty - t.px * ASCENT - pad / 2;
  ctx.globalAlpha = 1;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, 4); else ctx.rect(x, y, w, h);
  ctx.fillStyle = t.outline ? t.outline.color : 'rgba(9, 13, 22, 0.95)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = t.color;
  ctx.stroke();
  ctx.textAlign = t.align;
  ctx.fillStyle = t.color;
  ctx.fillText(t.text, tx, ty);
}

/**
 * What the context was last set to while one draw runs: setting a font, a width or a colour is not free, and a map of hundreds of
 * labels at one size repeats the same few values. `pen` is reset at the start of every draw (and where the context is saved and restored).
 */
function newPen() { return { font: '', alpha: -1, fill: '', stroke: '', width: -1, align: '' }; }

/** Draws one item at `v` (WORLD under the camera's transform, or the screen's own `{ ox: camera.x, oy: camera.y, k: zoom }` under none) */
function drawItem(ctx, t, pen, v = WORLD) {
  if (t.kind === 'chip') { drawChip(ctx, t, v); return; }
  if (pen.alpha !== t.alpha) { ctx.globalAlpha = t.alpha; pen.alpha = t.alpha; }
  const font = fontOf(t);
  if (pen.font !== font) { ctx.font = font; pen.font = font; }
  if (pen.align !== t.align) { ctx.textAlign = t.align; pen.align = t.align; }
  const x = v.ox + t.x * v.k, y = v.oy + t.y * v.k;
  if (t.outline) {
    ctx.lineJoin = 'round';
    const width = t.outline.width * v.k;
    if (pen.stroke !== t.outline.color) { ctx.strokeStyle = t.outline.color; pen.stroke = t.outline.color; }
    if (pen.width !== width) { ctx.lineWidth = width; pen.width = width; }
    ctx.strokeText(t.text, x, y);
  }
  if (pen.fill !== t.color) { ctx.fillStyle = t.color; pen.fill = t.color; }
  ctx.fillText(t.text, x, y);
  if (t.strike) {
    const half = ctx.measureText(t.text).width / 2;
    const size = t.screen ? t.px : t.size * v.k;
    ctx.beginPath();
    ctx.moveTo(x - half, y - size * 0.32);
    ctx.lineTo(x + half, y - size * 0.32);
    ctx.strokeStyle = t.color;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    pen.stroke = t.color; pen.width = 1.4; // the strike left its own colour and width on the context
  }
}

/**
 * The placed label under a screen point, or null: the one drawn on top (the last in scene order) when two overlap their padding
 * @param {ReturnType<typeof placeLabels>} placed
 * @param {import('./scene.js').Camera} camera
 * @param {number} x screen px
 * @param {number} y
 */
export function labelHit(placed, camera, x, y) {
  let hit = null;
  for (const p of placed) {
    if (x >= camera.x + p.l && x <= camera.x + p.r && y >= camera.y + p.t && y <= camera.y + p.b && (!hit || p.index > hit.index)) hit = p;
  }
  return hit ? hit.id : null;
}

/**
 * A transparent 2D canvas that draws the chosen labels over the map
 * @param {HTMLCanvasElement} canvas
 * @param {{mapStyle?: () => import('./map-style.js').MapStyle}} [opts] `mapStyle`: where the theme's map tokens come from (default: the page's, map-style.js `getMapStyle`);
 *   a node's label colour is the theme's `--corn-map-label`, and the outline under every label its `--corn-map-label-halo`, when it sets them
 * @returns {{hit: (x: number, y: number) => string|null, draw: (scene: import('./scene.js').Scene, camera: import('./scene.js').Camera, extras?: {hover?: string|null}) => boolean, resize: (width: number, height: number, dpr: number) => void, destroy: () => void}}
 *   `draw` returns whether it painted: false when the camera, the scene, the size and the hovered node were unchanged; `extras.hover` is the
 *   node the pointer is on (named by a chip when it has no label)
 */
export function createLabelLayer(canvas, opts = {}) {
  const styleOf = opts.mapStyle || getMapStyle;
  const ctx = canvas.getContext('2d');
  let width = 0, height = 0, dpr = 1;
  let lastScene = null, lastVersion, lastX, lastY, lastZoom, lastStyle, lastHover;
  let kept = null; // the placing for the scene and zoom last drawn: a pan reuses it (placeLabels)
  let dirty = true;
  let destroyed = false;

  // Text widths for the culling, measured once per font and string
  const widths = new Map();
  let family = FONT_NODE; // the theme's label font (`--corn-map-font`) when it sets one, else the map's own
  const measure = (text, size, bold) => {
    const key = `${bold ? 'b' : 'n'}${size}|${family}|${text}`;
    let w = widths.get(key);
    if (w === undefined) {
      if (widths.size > 20000) widths.clear(); // a long session on a big map: start again rather than grow
      ctx.font = fontOf({ italic: false, bold, size, family });
      w = ctx.measureText(text).width;
      widths.set(key, w);
    }
    return w;
  };

  return {
    /** The node whose label is drawn under a screen point (a cluster's title: input.js frames the cluster), or null */
    hit(x, y) {
      return kept && lastScene ? labelHit(kept, { x: lastX, y: lastY, zoom: lastZoom }, x, y) : null;
    },

    resize(w, h, ratio) {
      width = w;
      height = h;
      dpr = ratio;
      canvas.width = w * ratio; // resizing a canvas clears it, so the next draw must repaint
      canvas.height = h * ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      dirty = true;
    },

    draw(drawn, camera, extras = {}) {
      if (destroyed) return false;
      const style = styleOf();
      const styleKey = style.plain ? 0 : style.version;
      const hover = extras.hover || null;
      if (!dirty && drawn === lastScene && drawn.version === lastVersion && camera.x === lastX && camera.y === lastY && camera.zoom === lastZoom && styleKey === lastStyle && hover === lastHover) return false;
      const samePlacing = kept && drawn === lastScene && drawn.version === lastVersion && camera.zoom === lastZoom && styleKey === lastStyle && !dirty;
      lastScene = drawn; lastVersion = drawn.version; lastX = camera.x; lastY = camera.y; lastZoom = camera.zoom; lastStyle = styleKey; lastHover = hover;
      dirty = false;
      const scene = styledScene(drawn, style); // the label colours and font of the theme (map-style.js)
      family = scene.labelFont || FONT_NODE;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.translate(camera.x, camera.y);
      ctx.scale(camera.zoom, camera.zoom);
      // The placing is for the whole map at this zoom: kept while the scene, the zoom and the style stay (a pan, a hover), made again when one changes
      if (!samePlacing) kept = placeLabels(scene, camera.zoom, { measure });
      const items = chooseLabels(scene, camera, { width, height }, { measure, hover, placed: kept });
      // The lane text (the words on the lit edges are placed below the node labels, and drawn with them in screen space, below)
      let pen = newPen();
      for (const t of items) if (t.kind === 'lane') drawItem(ctx, t, pen);
      for (const t of items) if (t.kind === 'node' && !t.screen) drawItem(ctx, t, pen); // a label that grows with the map: the camera's transform
      ctx.restore();
      // A label at its minimum size is drawn in screen space at a whole font size, whatever the zoom: the font string does not change as the
      // zoom does, and text is what costs in a frame; then the chip, over everything
      const screen = { ox: camera.x, oy: camera.y, k: camera.zoom };
      pen = newPen();
      for (const t of items) if (t.kind === 'node' && t.screen) drawItem(ctx, t, pen, screen);
      for (const t of items) if (t.kind === 'edge') drawItem(ctx, t, pen, screen); // the kind words: where no node label, disc or word is
      for (const t of items) if (t.kind === 'chip') drawItem(ctx, t, pen, screen);
      return true;
    },

    destroy() {
      destroyed = true;
      lastScene = null;
      kept = null;
      widths.clear();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
    },
  };
}
