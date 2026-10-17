/**
 * @module explorer/labels
 *
 * The label overlay (spec 0012 A3, TOPO-05): every label the map shows, drawn by one layer on
 * a transparent canvas stacked over the map canvas, for either renderer. Two parts:
 *
 *   chooseLabels(scene, camera, viewport)   pure: which text to draw, in world coordinates
 *   createLabelLayer(canvas)                draws that on a 2d canvas, and only when something changed
 *
 * chooseLabels applies `labelAt` (scene.js) for the zoom-dependent level of detail and size, drops
 * the labels whose box is off screen, and when more than MAX_LABELS node labels remain keeps the
 * most useful: the selection and what is connected to it, then search matches, then landmark
 * types, then the larger nodes, with ties kept in scene order so a pan never reshuffles them.
 * Lane titles, notes and arrows and the selection's edge labels are always included and do not
 * count against the cap. The layer redraws only when the camera, the scene or the size changed, so
 * a packet frame (the renderer redrawing for animation) costs the labels nothing.
 *
 * Pure like scene.js apart from the layer's own canvas: it reads a scene, a camera and a size,
 * never the explorer's state.
 *
 * @typedef {object} LabelItem One piece of text to draw
 * @property {'node'|'edge'|'lane'} kind
 * @property {string} [id]        the node, for `kind: 'node'`
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
 */

import { EDGE_LABEL_SIZE, FONT_EDGE, FONT_NODE, LABEL_OUTLINE, labelAt } from './scene.js';

/** At most this many node labels at a time (lane text and selection edge labels are extra) */
export const MAX_LABELS = 400;
/** A label this many screen px past the viewport is still kept, so none pops in at the border */
export const CULL_MARGIN = 32;
/** A label's box: this many sizes above its baseline, and this many below */
const ASCENT = 1;
const DESCENT = 0.3;
/** Average glyph width, in sizes, when nothing measures the text */
const GLYPH = 0.58;

const estimate = (text, size) => text.length * size * GLYPH;

/** Priority tiers, lowest first: the selection and its neighbours, search matches, landmarks, the rest */
const TIER_FOCUS = 0;
const TIER_MATCH = 1;
const TIER_LANDMARK = 2;
const TIER_REST = 3;

/**
 * The text to draw for `scene` seen through `camera` in a `viewport`
 * @param {import('./scene.js').Scene} scene
 * @param {import('./scene.js').Camera} camera
 * @param {{width:number, height:number}} viewport CSS px
 * @param {{max?:number, margin?:number, measure?:(text:string, size:number, bold:boolean) => number}} [opts]
 *   `max` node labels (default 400); `margin` px past the viewport (default 32); `measure` the
 *   width in world units of a label (default: an estimate from its length)
 * @returns {LabelItem[]} lane text, then edge labels, then node labels in scene order
 */
export function chooseLabels(scene, camera, viewport, opts = {}) {
  const { max = MAX_LABELS, margin = CULL_MARGIN, measure = null } = opts;
  const out = [];

  // Always there: the data-flow lanes' titles, notes and arrows ...
  for (const lane of scene.decor.lanes) {
    for (const t of [lane.title, lane.note, lane.arrow]) {
      if (t) out.push({ kind: 'lane', text: t.text, x: t.x, y: t.y, size: t.size, bold: t.bold, italic: false, color: t.color, alpha: 1, outline: null, align: 'center', family: FONT_NODE });
    }
  }
  // ... and the labels on the selection's edges
  for (const edge of scene.edges) {
    const l = edge.label;
    if (l) out.push({ kind: 'edge', text: l.text, x: l.x, y: l.y, size: EDGE_LABEL_SIZE, bold: false, italic: !!l.italic, color: l.color, alpha: edge.alpha, outline: LABEL_OUTLINE.edge, align: 'center', family: FONT_EDGE });
  }

  // Node labels: level of detail, then the ones whose box reaches the viewport
  const { zoom } = camera;
  const minX = -margin, maxX = viewport.width + margin;
  const minY = -margin, maxY = viewport.height + margin;
  const focused = scene.nodes.some((n) => n.selected || !n.connected);
  const found = [];

  scene.nodes.forEach((node, index) => {
    const label = labelAt(node, zoom, scene);
    if (!label) return;
    const sy = camera.y + label.y * zoom;
    if (sy + label.size * DESCENT * zoom < minY || sy - label.size * ASCENT * zoom > maxY) return;
    const sx = camera.x + label.x * zoom;
    // A label centred inside the viewport is in view whatever its width: text is measured only
    // for the ones centred past a side edge, where its half width decides
    if (sx < minX || sx > maxX) {
      const half = ((measure ? measure(label.text, label.size, label.bold) : estimate(label.text, label.size)) / 2) * zoom;
      if (sx + half < minX || sx - half > maxX) return;
    }

    const tier = node.selected || (focused && node.connected) ? TIER_FOCUS : node.match ? TIER_MATCH : node.labelKeep ? TIER_LANDMARK : TIER_REST;
    found.push({ index, tier, r: node.r, label, id: node.id });
  });

  // Over the cap: keep the best `max`. Sorting by (tier, larger radius, scene order) is a total order
  // that does not depend on the camera, so the same nodes win while the view pans.
  let kept = found;
  if (found.length > max) {
    kept = found.slice().sort((a, b) => a.tier - b.tier || b.r - a.r || a.index - b.index).slice(0, Math.max(0, max));
    kept.sort((a, b) => a.index - b.index); // draw in scene order, as the circles are
  }

  for (const { label, id } of kept) {
    out.push({ kind: 'node', id, text: label.text, x: label.x, y: label.y, size: label.size, bold: label.bold, italic: false, color: label.color, alpha: label.alpha, outline: LABEL_OUTLINE.node, align: 'center', family: FONT_NODE, strike: !!label.strike });
  }
  return out;
}

const fontOf = (t) => `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${t.size}px ${t.family}`;

function drawItem(ctx, t) {
  ctx.globalAlpha = t.alpha;
  ctx.font = fontOf(t);
  ctx.textAlign = t.align;
  if (t.outline) {
    ctx.lineJoin = 'round';
    ctx.strokeStyle = t.outline.color;
    ctx.lineWidth = t.outline.width;
    ctx.strokeText(t.text, t.x, t.y);
  }
  ctx.fillStyle = t.color;
  ctx.fillText(t.text, t.x, t.y);
  if (t.strike) {
    const half = ctx.measureText(t.text).width / 2;
    ctx.beginPath();
    ctx.moveTo(t.x - half, t.y - t.size * 0.32);
    ctx.lineTo(t.x + half, t.y - t.size * 0.32);
    ctx.strokeStyle = t.color;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
}

/**
 * Erases every node circle from what is drawn so far. The map used to draw an edge's label before
 * the circles, so a node covered it; this layer is above the circles, so it cuts them out of the
 * lane and edge text instead (a dimmed node, which hides almost nothing, does not cut).
 */
function coverWithNodes(ctx, nodes) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  nodes.forEach((n) => {
    if (n.alpha < 0.5) return;
    ctx.moveTo(n.x + n.r, n.y);
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
  });
  ctx.fill();
  ctx.restore();
}

/**
 * A transparent 2D canvas that draws the chosen labels over the map
 * @param {HTMLCanvasElement} canvas
 * @returns {{draw: (scene: import('./scene.js').Scene, camera: import('./scene.js').Camera) => boolean, resize: (width: number, height: number, dpr: number) => void, destroy: () => void}}
 *   `draw` returns whether it painted: false when the camera, the scene and the size were unchanged
 */
export function createLabelLayer(canvas) {
  const ctx = canvas.getContext('2d');
  let width = 0, height = 0, dpr = 1;
  let lastScene = null, lastVersion, lastX, lastY, lastZoom;
  let dirty = true;
  let destroyed = false;

  // Text widths for the culling, measured once per font and string
  const widths = new Map();
  const measure = (text, size, bold) => {
    const key = `${bold ? 'b' : 'n'}${size}|${text}`;
    let w = widths.get(key);
    if (w === undefined) {
      ctx.font = fontOf({ italic: false, bold, size, family: FONT_NODE });
      w = ctx.measureText(text).width;
      widths.set(key, w);
    }
    return w;
  };

  return {
    resize(w, h, ratio) {
      width = w;
      height = h;
      dpr = ratio;
      canvas.width = w * ratio; // resizing a canvas clears it, so the next draw must repaint
      canvas.height = h * ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      dirty = true;
    },

    draw(scene, camera) {
      if (destroyed) return false;
      if (!dirty && scene === lastScene && scene.version === lastVersion && camera.x === lastX && camera.y === lastY && camera.zoom === lastZoom) return false;
      lastScene = scene; lastVersion = scene.version; lastX = camera.x; lastY = camera.y; lastZoom = camera.zoom;
      dirty = false;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.translate(camera.x, camera.y);
      ctx.scale(camera.zoom, camera.zoom);
      const items = chooseLabels(scene, camera, { width, height }, { measure });
      let covered = !items.some((t) => t.kind === 'edge');
      items.forEach((t) => {
        if (!covered && t.kind === 'node') { coverWithNodes(ctx, scene.nodes); covered = true; }
        drawItem(ctx, t);
      });
      if (!covered) coverWithNodes(ctx, scene.nodes);
      ctx.restore();
      return true;
    },

    destroy() {
      destroyed = true;
      lastScene = null;
      widths.clear();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
    },
  };
}
