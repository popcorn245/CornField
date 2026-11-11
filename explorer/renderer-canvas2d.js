/**
 * @module explorer/renderer-canvas2d
 *
 * The reference renderer: draws a scene (scene.js) on a Canvas 2D context. It is today's drawing
 * code moved behind the renderer contract, and it stays as the fallback where WebGL2 is not
 * available. It reads only the scene, the camera and the time it is handed, never the explorer's
 * state, so any other renderer can stand in for it. It draws no text: labels, lane titles and edge
 * labels are the label layer's (labels.js), one transparent canvas over the map for either renderer.
 */

import { CORE_RATIO, ARROW, END_SHAPES, EDGE_STRIKE, MARK_MIN_PX, edgePoint, looksFor, packetPoint, parseColor } from './scene.js';
import { ICON_RATIO, getMapStyle, looksWith, styledScene } from './map-style.js';
import { LETTER_RATIO, letterImage, showsLetters } from './kind-letters.js';

const TAU = Math.PI * 2;
/** A glow thinner than this on screen (px) is not drawn: zoomed out it is a fraction of a pixel, and costs a stroke or fill per edge and node */
const GLOW_MIN_PX = 1.5;
/** A scene with this many edges or fewer is drawn directly each frame; more, and its lines go into the layer while packets move */
export const LAYER_MIN_EDGES = 600;
/** A line dimmer than this (its alpha times its colour's), with no mark, glow or packet, is a trace no eye finds: it is not drawn (a selection dims thousands of lines to 4%) */
export const TRACE_ALPHA = 0.06;
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
function drawEdge(ctx, edge, timeMs, zoom, withPacket = true) {
  ctx.save();
  ctx.globalAlpha = edge.alpha;

  ctx.beginPath();
  ctx.moveTo(edge.x1, edge.y1);
  if (edge.curve) ctx.quadraticCurveTo(edge.curve.cx, edge.curve.cy, edge.x2, edge.y2);
  else ctx.lineTo(edge.x2, edge.y2);
  ctx.strokeStyle = edge.color;
  ctx.lineWidth = edge.mark && edge.mark !== 'none' ? Math.max(edge.width, MARK_MIN_PX.edge / zoom) : edge.width; // a proposal's marks stay visible zoomed out
  ctx.setLineDash(edge.dash || []);
  if (edge.glow && edge.glow * zoom >= GLOW_MIN_PX) {
    // The glow is a wider, fainter stroke under the line, not `shadowBlur`: a blur per edge is a full-canvas blur
    // pass each, and a selected hub lights ~900 edges (F30: 8 to 10 s a tap on a phone)
    const line = ctx.lineWidth;
    ctx.save();
    ctx.globalAlpha = edge.alpha * 0.3;
    ctx.strokeStyle = edge.glowColor || edge.color;
    ctx.lineWidth = line + edge.glow * 0.6;
    ctx.stroke();
    ctx.restore();
  }
  ctx.stroke();
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

  // The tick marks of a call that bites later than now: across the middle, one or two (spec 0008 D7)
  if (edge.ticks) drawTicks(ctx, edge, zoom);

  // The mark at the target, along the curve's end tangent: one per family of edge (spec 0008 D7)
  if (edge.arrow) {
    const { cx, cy } = edge.curve || { cx: edge.x1, cy: edge.y1 };
    drawEnd(ctx, edge, Math.atan2(edge.y2 - cy, edge.x2 - cx), zoom);
  }

  // The edge's label (selection only) is the label layer's, not drawn here

  if (withPacket && edge.packet) drawPacketIn(ctx, edge, timeMs, zoom);
  ctx.restore();
}

/**
 * The mark at an edge's target, pointing along `ang` (spec 0008 D7): a filled triangle (services), an open chevron (data), a bar across the
 * line (places) or an open diamond (tokens). The same shapes the WebGL tips pass draws (shaders.js TIP_FRAG).
 */
function drawEnd(ctx, edge, ang, zoom) {
  const kind = edge.end || 'triangle';
  const { x2: x, y2: y, color } = edge;
  const cs = Math.cos(ang), sn = Math.sin(ang);
  const at = (back, across) => [x - cs * back - sn * across, y - sn * back + cs * across]; // the tip's own frame: `back` behind it, `across` to its left
  const thin = Math.max(END_SHAPES.strokeWidth, 1.2 / zoom);
  ctx.beginPath();
  if (kind === 'triangle') {
    ctx.moveTo(x, y);
    ctx.lineTo(x - Math.cos(ang - ARROW.spread) * ARROW.length, y - Math.sin(ang - ARROW.spread) * ARROW.length);
    ctx.lineTo(x - Math.cos(ang + ARROW.spread) * ARROW.length, y - Math.sin(ang + ARROW.spread) * ARROW.length);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    return;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = thin;
  ctx.lineJoin = 'miter';
  if (kind === 'chevron') {
    const back = ARROW.length * Math.cos(ARROW.spread), side = ARROW.length * Math.sin(ARROW.spread);
    ctx.moveTo(...at(back, side));
    ctx.lineTo(x, y);
    ctx.lineTo(...at(back, -side));
  } else if (kind === 'bar') {
    ctx.moveTo(...at(thin / 2, END_SHAPES.barHalf));
    ctx.lineTo(...at(thin / 2, -END_SHAPES.barHalf));
  } else { // diamond: its front vertex at the tip
    const h = END_SHAPES.diamondHalf;
    ctx.moveTo(x, y);
    ctx.lineTo(...at(h, END_SHAPES.diamondAcross));
    ctx.lineTo(...at(2 * h, 0));
    ctx.lineTo(...at(h, -END_SHAPES.diamondAcross));
    ctx.closePath();
  }
  ctx.stroke();
}

/** The ticks of a `when` across the middle of an edge: short lines square to it, a few units apart along it */
function drawTicks(ctx, edge, zoom) {
  const len = Math.hypot(edge.x2 - edge.x1, edge.y2 - edge.y1);
  const [dx, dy] = len > 0 ? [(edge.x2 - edge.x1) / len, (edge.y2 - edge.y1) / len] : [1, 0];
  const mid = edgePoint(edge, 0.5);
  ctx.beginPath();
  for (let i = 0; i < edge.ticks; i++) {
    const along = (i - (edge.ticks - 1) / 2) * END_SHAPES.tickGap;
    const px = mid.x + dx * along, py = mid.y + dy * along;
    ctx.moveTo(px - dy * END_SHAPES.tickHalf, py + dx * END_SHAPES.tickHalf);
    ctx.lineTo(px + dy * END_SHAPES.tickHalf, py - dx * END_SHAPES.tickHalf);
  }
  ctx.strokeStyle = edge.color;
  ctx.lineWidth = Math.max(END_SHAPES.tickWidth, 1.5 / zoom);
  ctx.setLineDash([]);
  ctx.stroke();
}

/** The packet's dot: a soft disc under it for the glow (no `shadowBlur`: see drawEdge), then the dot */
function drawPacketIn(ctx, edge, timeMs, zoom) {
  const p = packetPoint(edge, timeMs);
  const { packet } = edge;
  if (packet.glow && packet.glow * zoom >= GLOW_MIN_PX) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, packet.radius + packet.glow * 0.5, 0, TAU);
    ctx.globalAlpha = edge.alpha * 0.3;
    ctx.fillStyle = packet.glowColor || packet.color;
    ctx.fill();
    ctx.globalAlpha = edge.alpha;
  }
  ctx.beginPath();
  ctx.arc(p.x, p.y, packet.radius, 0, TAU);
  ctx.fillStyle = packet.color;
  ctx.fill();
}

/** A packet on its own (the layer cache below draws the edges' lines once and the packets every frame) */
function drawPacket(ctx, edge, timeMs, zoom) {
  ctx.save();
  ctx.globalAlpha = edge.alpha;
  drawPacketIn(ctx, edge, timeMs, zoom);
  ctx.restore();
}

/** The edges worth a stroke: not the traces (see TRACE_ALPHA), worked out once per scene */
const drawnLists = new WeakMap();
function drawnEdges(scene) {
  let list = drawnLists.get(scene);
  if (!list) {
    list = scene.edges.filter((e) => (e.mark && e.mark !== 'none') || e.glow || e.packet || e.alpha * parseColor(e.color)[3] >= TRACE_ALPHA);
    drawnLists.set(scene, list);
  }
  return list;
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
  if (node.glow && node.glow * zoom >= GLOW_MIN_PX) {
    // A soft disc behind the node, not `shadowBlur` (see drawEdge): one cheap fill instead of a blur pass
    ctx.save();
    ctx.globalAlpha = node.alpha * 0.28;
    circle(ctx, node.x, node.y, node.r + node.glow * 0.7);
    ctx.fillStyle = node.color;
    ctx.fill();
    ctx.restore();
    circle(ctx, node.x, node.y, node.r);
  }
  ctx.fillStyle = node.color;
  ctx.fill();
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
  } else if (showsLetters(node, zoom)) {
    // A finer kind's letters (spec 0009 D5), where a theme's icon would be: the shortest start of its name, once the node is wide enough
    const letters = letterImage(node.letters);
    if (letters) {
      const side = node.r * LETTER_RATIO;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(letters, node.x - side / 2, node.y - side / 2, side, side);
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
//  The renderer
// ---------------------------------------------------------------------------

/**
 * @param {HTMLCanvasElement} canvas the canvas to draw on
 * @param {{mapStyle?: () => import('./map-style.js').MapStyle, layerMinEdges?: number}} [opts] `mapStyle`: where the theme's map tokens come from (default: the page's, map-style.js `getMapStyle`); `layerMinEdges`: how many drawn lines make the layer worth it (default LAYER_MIN_EDGES)
 * @returns {import('./scene.js').Renderer}
 */
export function createCanvas2dRenderer(canvas, opts = {}) {
  const styleOf = opts.mapStyle || getMapStyle;
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let ratio = 1;

  // The still part of a frame (the background and every edge's line) is drawn once into `layer` and blitted while only
  // the packets move: a hub's selection lights hundreds of packets, and redrawing thousands of lines on each frame is
  // what made a tap take seconds on a phone (F30). Used only when the scene has packets and a canvas can be made.
  let layer = null;
  let layerCtx = null;
  let layerFor = null; // what the layer shows: { scene, x, y, zoom, w, h }
  const makeLayer = () => {
    if (layer) return layer;
    try {
      layer = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(canvas.width || 1, canvas.height || 1)
        : typeof document !== 'undefined' ? document.createElement('canvas') : null;
      layerCtx = layer && layer.getContext ? layer.getContext('2d') : null;
    } catch { layerCtx = null; }
    if (!layerCtx) layer = null;
    return layer;
  };
  // The layer pays for itself only when there are many lines to redraw every frame: a blit of the whole canvas is not free (a phone's
  // software raster takes ~0.4 s for the first one), so a scene with a few hundred lines and a few packets (one hop of a selection)
  // draws directly
  const layerMin = opts.layerMinEdges ?? LAYER_MIN_EDGES;
  const hasPacket = new WeakMap();
  const packetsIn = (scene) => {
    if (!hasPacket.has(scene)) hasPacket.set(scene, drawnEdges(scene).length > layerMin && scene.edges.some((e) => e.packet));
    return hasPacket.get(scene);
  };

  function drawStill(c, scene, camera) {
    c.save();
    c.translate(camera.x, camera.y);
    c.scale(camera.zoom, camera.zoom);
    const { decor } = scene;
    if (decor.grid) drawGrid(c, decor.grid, camera, width, height);
    if (decor.lanes.length) drawLanes(c, decor.lanes);
    if (decor.rings.length) drawRings(c, decor.rings);
    drawnEdges(scene).forEach((edge) => drawEdge(c, edge, 0, camera.zoom, false));
    c.restore();
  }

  return {
    kind: 'canvas2d',

    resize(w, h, dpr) {
      width = w;
      height = h;
      ratio = dpr;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      layerFor = null;
      if (layer) { layer.width = canvas.width; layer.height = canvas.height; layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    },

    draw(drawn, camera, timeMs) {
      const style = styleOf();
      const scene = styledScene(drawn, style); // the map in the theme's colours (map-style.js); the scene itself when nothing is set
      ctx.clearRect(0, 0, width, height);

      const looks = looksWith(looksFor(scene.theme), style); // the halos, mark rings and core for the scene's ground, in the theme's colours
      if (packetsIn(scene) && makeLayer()) {
        const same = layerFor && layerFor.scene === scene && layerFor.x === camera.x && layerFor.y === camera.y && layerFor.zoom === camera.zoom && layerFor.w === canvas.width && layerFor.h === canvas.height;
        if (!same) {
          if (layer.width !== canvas.width || layer.height !== canvas.height) { layer.width = canvas.width; layer.height = canvas.height; }
          layerCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
          layerCtx.clearRect(0, 0, width, height);
          drawStill(layerCtx, scene, camera);
          layerFor = { scene, x: camera.x, y: camera.y, zoom: camera.zoom, w: canvas.width, h: canvas.height };
        }
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(layer, 0, 0);
        ctx.restore();
        ctx.save();
        ctx.translate(camera.x, camera.y);
        ctx.scale(camera.zoom, camera.zoom);
        scene.edges.forEach((edge) => { if (edge.packet) drawPacket(ctx, edge, timeMs, camera.zoom); });
        scene.nodes.forEach((node) => drawNode(ctx, node, camera.zoom, looks, style));
        ctx.restore();
        return;
      }

      ctx.save();
      ctx.translate(camera.x, camera.y);
      ctx.scale(camera.zoom, camera.zoom);

      const { decor } = scene;
      if (decor.grid) drawGrid(ctx, decor.grid, camera, width, height);
      if (decor.lanes.length) drawLanes(ctx, decor.lanes);
      if (decor.rings.length) drawRings(ctx, decor.rings);

      drawnEdges(scene).forEach((edge) => drawEdge(ctx, edge, timeMs, camera.zoom));
      scene.nodes.forEach((node) => drawNode(ctx, node, camera.zoom, looks, style));
      // No text here: every label (and the strike through a removed one) is drawn by the label layer (labels.js) over this canvas

      ctx.restore();
    },

    destroy() { layer = null; layerCtx = null; layerFor = null; },
  };
}
