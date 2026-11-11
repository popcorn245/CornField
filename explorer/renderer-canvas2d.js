/**
 * @module explorer/renderer-canvas2d
 *
 * The reference renderer: draws a scene (scene.js) on a Canvas 2D context. It is today's drawing
 * code moved behind the renderer contract, and it stays as the fallback where WebGL2 is not
 * available. It reads only the scene, the camera and the time it is handed, never the explorer's
 * state, so any other renderer can stand in for it. It draws no text: labels, lane titles and edge
 * labels are the label layer's (labels.js), one transparent canvas over the map for either renderer.
 */

import { CORE_RATIO, ARROW, EDGE_STRIKE, MARK_MIN_PX, edgePoint, looksFor, packetPoint } from './scene.js';
import { ICON_RATIO, getMapStyle, looksWith, styledScene } from './map-style.js';

const TAU = Math.PI * 2;
const circle = (ctx, x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); };

// ---------------------------------------------------------------------------
//  The background
// ---------------------------------------------------------------------------
function drawGrid(ctx, grid, camera, width, height) {
  const left = -camera.x / camera.zoom - grid.margin;
  const right = (width - camera.x) / camera.zoom + grid.margin;
  const top = -camera.y / camera.zoom - grid.margin;
  const bottom = (height - camera.y) / camera.zoom + grid.margin;

  ctx.beginPath();
  ctx.strokeStyle = grid.color;
  ctx.lineWidth = grid.width;
  for (let x = Math.floor(left / grid.size) * grid.size; x < right; x += grid.size) { ctx.moveTo(x, top); ctx.lineTo(x, bottom); }
  for (let y = Math.floor(top / grid.size) * grid.size; y < bottom; y += grid.size) { ctx.moveTo(left, y); ctx.lineTo(right, y); }
  ctx.stroke();
}

function drawRings(ctx, rings) {
  ctx.save();
  rings.forEach((ring) => {
    ctx.lineWidth = ring.width;
    ctx.setLineDash(ring.dash);
    ctx.strokeStyle = ring.color;
    circle(ctx, ring.x, ring.y, ring.r);
    ctx.stroke();
  });
  ctx.restore();
}

// The lanes' titles, notes and arrows are text, so the label layer draws them (labels.js)
function drawLanes(ctx, lanes) {
  ctx.save();
  lanes.forEach((lane) => {
    ctx.fillStyle = lane.fill;
    ctx.strokeStyle = lane.stroke;
    ctx.lineWidth = lane.strokeWidth;
    ctx.beginPath();
    ctx.roundRect(lane.x, lane.y, lane.w, lane.h, lane.radius);
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
}

// ---------------------------------------------------------------------------
//  Edges
// ---------------------------------------------------------------------------
function drawEdge(ctx, edge, timeMs, zoom) {
  ctx.save();
  ctx.globalAlpha = edge.alpha;

  ctx.beginPath();
  ctx.moveTo(edge.x1, edge.y1);
  if (edge.curve) ctx.quadraticCurveTo(edge.curve.cx, edge.curve.cy, edge.x2, edge.y2);
  else ctx.lineTo(edge.x2, edge.y2);
  ctx.strokeStyle = edge.color;
  ctx.lineWidth = edge.mark && edge.mark !== 'none' ? Math.max(edge.width, MARK_MIN_PX.edge / zoom) : edge.width; // a proposal's marks stay visible zoomed out
  ctx.setLineDash(edge.dash || []);
  if (edge.glow) {
    ctx.shadowColor = edge.glowColor;
    ctx.shadowBlur = edge.glow;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.setLineDash([]);

  // A removed edge is struck across at its midpoint, as the WebGL tips pass draws it
  if (edge.mark === 'removed') {
    const mid = edgePoint(edge, 0.5);
    const len = Math.hypot(edge.x2 - edge.x1, edge.y2 - edge.y1);
    const [dx, dy] = len > 0 ? [(edge.x2 - edge.x1) / len, (edge.y2 - edge.y1) / len] : [1, 0];
    ctx.beginPath();
    ctx.moveTo(mid.x - dy * EDGE_STRIKE.halfLength, mid.y + dx * EDGE_STRIKE.halfLength);
    ctx.lineTo(mid.x + dy * EDGE_STRIKE.halfLength, mid.y - dx * EDGE_STRIKE.halfLength);
    ctx.lineWidth = Math.max(EDGE_STRIKE.width, 1.5 / zoom);
    ctx.stroke();
  }

  // Arrowhead along the curve's end tangent
  if (edge.arrow) {
    const { cx, cy } = edge.curve || { cx: edge.x1, cy: edge.y1 };
    const ang = Math.atan2(edge.y2 - cy, edge.x2 - cx);
    ctx.beginPath();
    ctx.moveTo(edge.x2, edge.y2);
    ctx.lineTo(edge.x2 - Math.cos(ang - ARROW.spread) * ARROW.length, edge.y2 - Math.sin(ang - ARROW.spread) * ARROW.length);
    ctx.lineTo(edge.x2 - Math.cos(ang + ARROW.spread) * ARROW.length, edge.y2 - Math.sin(ang + ARROW.spread) * ARROW.length);
    ctx.closePath();
    ctx.fillStyle = edge.color;
    ctx.fill();
  }

  // The edge's label (selection only) is the label layer's, not drawn here

  if (edge.packet) {
    const p = packetPoint(edge, timeMs);
    ctx.beginPath();
    ctx.arc(p.x, p.y, edge.packet.radius, 0, TAU);
    ctx.fillStyle = edge.packet.color;
    ctx.shadowColor = edge.packet.glowColor;
    ctx.shadowBlur = edge.packet.glow;
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
//  Nodes
// ---------------------------------------------------------------------------
function drawNode(ctx, node, zoom, looks, style) {
  ctx.save();
  ctx.globalAlpha = node.alpha;

  // Selection / search highlight halos
  const halo = looks.halo[node.halo];
  if (halo) {
    if (halo.fill) {
      circle(ctx, node.x, node.y, node.r + halo.fillR);
      ctx.fillStyle = halo.fill;
      ctx.fill();
    }
    circle(ctx, node.x, node.y, node.r + halo.ringR);
    ctx.strokeStyle = halo.ring;
    ctx.lineWidth = halo.ringWidth;
    ctx.stroke();
  }

  // A proposal's mark: a ring just outside the node in the mark's own dash, at the node's alpha (a removed node's ring is as faded
  // as the node, as the WebGL shader draws it and as the contrast check measures it), and for removed a strike through the node
  const mark = looks.mark[node.mark];
  if (mark) {
    const rr = node.r + Math.max(mark.ringR, MARK_MIN_PX.gap / zoom);
    circle(ctx, node.x, node.y, rr);
    ctx.strokeStyle = mark.color;
    ctx.lineWidth = Math.max(mark.ringWidth, MARK_MIN_PX.ring / zoom);
    ctx.setLineDash(mark.ringDash || []);
    ctx.stroke();
    ctx.setLineDash([]);
    if (node.mark === 'removed') {
      ctx.beginPath();
      ctx.moveTo(node.x - rr, node.y);
      ctx.lineTo(node.x + rr, node.y);
      ctx.stroke();
    }
  }

  // The node circle, glowing, with a white core dot
  circle(ctx, node.x, node.y, node.r);
  ctx.fillStyle = node.color;
  if (node.glow) {
    ctx.shadowColor = node.color;
    ctx.shadowBlur = node.glow;
  }
  ctx.fill();
  ctx.shadowBlur = 0;
  circle(ctx, node.x, node.y, node.r * CORE_RATIO);
  ctx.fillStyle = looks.core;
  ctx.fill();

  // The theme's outline (--corn-map-stroke), just inside the edge of the circle
  if (node.stroke) {
    circle(ctx, node.x, node.y, Math.max(0, node.r - node.stroke.width / 2));
    ctx.strokeStyle = node.stroke.color;
    ctx.lineWidth = node.stroke.width;
    ctx.stroke();
  }

  // The theme's icon for this kind (theme.icons), inside the circle; crisp when the theme is pixelated
  const image = node.icon && style.icons ? style.icons.get(node.icon) : null;
  if (image) {
    const side = node.r * ICON_RATIO;
    ctx.imageSmoothingEnabled = !style.pixelated;
    ctx.drawImage(image, node.x - side / 2, node.y - side / 2, side, side);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
//  The renderer
// ---------------------------------------------------------------------------

/**
 * @param {HTMLCanvasElement} canvas the canvas to draw on
 * @param {{mapStyle?: () => import('./map-style.js').MapStyle}} [opts] `mapStyle`: where the theme's map tokens come from (default: the page's, map-style.js `getMapStyle`)
 * @returns {import('./scene.js').Renderer}
 */
export function createCanvas2dRenderer(canvas, opts = {}) {
  const styleOf = opts.mapStyle || getMapStyle;
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;

  return {
    kind: 'canvas2d',

    resize(w, h, dpr) {
      width = w;
      height = h;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    },

    draw(drawn, camera, timeMs) {
      const style = styleOf();
      const scene = styledScene(drawn, style); // the map in the theme's colours (map-style.js); the scene itself when nothing is set
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.translate(camera.x, camera.y);
      ctx.scale(camera.zoom, camera.zoom);

      const { decor } = scene;
      if (decor.grid) drawGrid(ctx, decor.grid, camera, width, height);
      if (decor.lanes.length) drawLanes(ctx, decor.lanes);
      if (decor.rings.length) drawRings(ctx, decor.rings);

      scene.edges.forEach((edge) => drawEdge(ctx, edge, timeMs, camera.zoom));
      const looks = looksWith(looksFor(scene.theme), style); // the halos, mark rings and core for the scene's ground, in the theme's colours
      scene.nodes.forEach((node) => drawNode(ctx, node, camera.zoom, looks, style));
      // No text here: every label (and the strike through a removed one) is drawn by the label layer (labels.js) over this canvas

      ctx.restore();
    },

    destroy() { /* a 2d context holds nothing to release */ },
  };
}
