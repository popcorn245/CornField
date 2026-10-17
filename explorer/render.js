/**
 * @module explorer/render
 *
 * The thin module the rest of the explorer calls: the camera (fit, zoom, screen to world), the
 * scene cache and the loop that animates flow packets. What is drawn is decided by scene.js
 * (buildScene); how it is drawn is the renderer's (renderer-canvas2d.js today). This module only
 * hands the one to the other: `render()` draws the cached scene with the current camera and time.
 */

import { state, viewEdges } from './state.js';
import { flowReduceMotion } from './flows.js';
import { buildScene, createSceneCache, getActiveSubgraph as activeSubgraph, isNodeVisible as nodeVisible } from './scene.js';
import { createCanvas2dRenderer } from './renderer-canvas2d.js';
import { createSpatialCache } from './spatial.js';
import { createFrameScheduler, packetsOnScreen } from './frame.js';
import { createLabelLayer } from './labels.js';
import { measureCovered } from './sheets.js';

// ---------------------------------------------------------------------------
//  Visibility and focus (decided in scene.js, kept here under their old names)
// ---------------------------------------------------------------------------
export const isNodeVisible = (node) => nodeVisible(state, node);

/** The focus subgraph: the selected node, its children and every path through them */
export const getActiveSubgraph = (selected, edges = viewEdges()) => activeSubgraph(selected, edges);

// ---------------------------------------------------------------------------
//  Scene and renderer
// ---------------------------------------------------------------------------
const sceneCache = createSceneCache((st) => buildScene(st, { reduceMotion: flowReduceMotion }));

/** The scene for the current state, rebuilt only when `state.sceneVersion` changed */
export const getScene = () => sceneCache.get(state);
/** How many times the scene has been built so far (for tests and the bench) */
export const sceneBuilds = () => sceneCache.builds;

const spatialCache = createSpatialCache();
/** The grid over the current scene's nodes (spatial.js), rebuilt only when the scene is: for hover, click and drag */
export const getSpatialIndex = () => spatialCache.get(getScene());
/** How many times the grid was built so far (for tests and the bench) */
export const spatialBuilds = () => spatialCache.builds;

let renderer = null;
let rendererCanvas = null;

const dpr = () => (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

/** The renderer drawing `state.canvas`: Canvas 2D unless another was handed to setRenderer */
export function getRenderer() {
  if (!renderer || rendererCanvas !== state.canvas) {
    if (renderer) renderer.destroy();
    renderer = createCanvas2dRenderer(state.canvas);
    rendererCanvas = state.canvas;
    if (state.width) renderer.resize(state.width, state.height, dpr());
  }
  return renderer;
}

let labelLayer = null;
let labelLayerCanvas = null;

/** The label layer on `state.labelCanvas` (labels.js), or null when the page has none */
function getLabelLayer() {
  if (!state.labelCanvas) return null;
  if (!labelLayer || labelLayerCanvas !== state.labelCanvas) {
    if (labelLayer) labelLayer.destroy();
    labelLayer = createLabelLayer(state.labelCanvas);
    labelLayerCanvas = state.labelCanvas;
    if (state.width) labelLayer.resize(state.width, state.height, dpr());
  }
  return labelLayer;
}

/** Swaps the renderer (see scene.js for the contract) and draws with it */
export function setRenderer(next) {
  if (renderer && renderer !== next) renderer.destroy();
  renderer = next;
  rendererCanvas = state.canvas;
  if (state.width) renderer.resize(state.width, state.height, dpr());
  render();
}

// ---------------------------------------------------------------------------
//  Camera
// ---------------------------------------------------------------------------
export function resize() {
  const { canvas } = state;
  state.width = canvas.parentElement.clientWidth;
  state.height = canvas.parentElement.clientHeight;
  getRenderer().resize(state.width, state.height, dpr());
  const labels = getLabelLayer();
  if (labels) labels.resize(state.width, state.height, dpr());
  render();
}

/** Zoom and pan so every visible node (and its label) is on screen; `only` (a Set of ids) narrows it to those, when any are visible */
export function fitGraphToViewport(padding = 40, only = null) {
  const { nodes, width, height, camera } = state;
  let visible = nodes.filter(isNodeVisible);
  if (only) {
    const part = visible.filter((n) => only.has(n.id));
    if (part.length) visible = part;
  }
  if (visible.length === 0) return;
  // The phone's sheets hide the bottom of the map (sheets.js): fit into the part they leave
  const mapHeight = Math.max(160, height - measureCovered());

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  visible.forEach((n) => {
    const r = n.r || 18;
    minX = Math.min(minX, n.x - r - 25);
    maxX = Math.max(maxX, n.x + r + 25);
    minY = Math.min(minY, n.y - r - 25);
    maxY = Math.max(maxY, n.y + r + 35); // room for the label below
  });
  if (state.view === 'dataflow' && state.flow) minY = Math.min(minY, state.flow.top - 10); // and the tier titles above
  if (state.view === 'house' && state.house && state.house.fit && !only) ({ minX, maxX, minY, maxY } = state.house.fit); // the House view fits its plan and bands (house-model.js)

  const availWidth = Math.max(160, width - padding * 2);
  const availHeight = Math.max(160, mapHeight - padding * 2);
  const targetZoom = Math.min(1.0, Math.max(0.18, Math.min(availWidth / (maxX - minX), availHeight / (maxY - minY))));

  camera.zoom = targetZoom;
  camera.x = width / 2 - ((minX + maxX) / 2) * targetZoom;
  camera.y = mapHeight / 2 - ((minY + maxY) / 2) * targetZoom;
  render();
}

export const fitPadding = () => (state.width < 640 ? 24 : 48);

export function screenToWorld(sx, sy) {
  return { x: (sx - state.camera.x) / state.camera.zoom, y: (sy - state.camera.y) / state.camera.zoom };
}

export function zoomBy(factor) {
  state.camera.zoom = Math.max(0.25, Math.min(3.0, state.camera.zoom * factor));
  render();
}

// ---------------------------------------------------------------------------
//  When to draw (frame.js has the rules): on demand, not on a timer
// ---------------------------------------------------------------------------
let drawnVersion = -1;

function paint() {
  if (!state.canvas) return;
  const scene = getScene();
  drawnVersion = scene.version;
  getRenderer().draw(scene, state.camera, performance.now());
  // The labels repaint only when the camera, the scene or the size changed, never on a packet frame
  const labels = getLabelLayer();
  if (labels) labels.draw(scene, state.camera);
}

const scheduler = createFrameScheduler({
  draw: paint,
  packetsVisible: () => !!state.canvas && packetsOnScreen(getScene(), state.camera, state.width, state.height),
  isHidden: () => typeof document !== 'undefined' && document.hidden,
  tickClients: (t) => { let more = false; frameClients.forEach((c) => { c.tick(t); if (c.wants()) more = true; }); return more; },
  clientsWant: () => [...frameClients].some((c) => c.wants()),
  reduceMotion: () => flowReduceMotion,
  extraDirty: () => state.sceneVersion !== drawnVersion,
  now: () => performance.now(),
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
});

/** Something changed (the camera, the scene, the size): draw it in the next animation frame, once however often this is called */
export function render() {
  if (!state.canvas) return;
  scheduler.markDirty();
}

/** Draws right now, for a caller that needs the pixels this instant (a test, a screenshot) */
export function renderNow() {
  if (!state.canvas) return;
  scheduler.drawNow();
}

// Other things that need frames (the scenario player and its camera glide): `{ tick(nowMs), wants() }`.
// `tick` runs on every frame of the loop; the loop keeps going while any client `wants()` frames, even
// under reduced motion (the packets stay still; the steps still change). frame.js runs them (`tickClients`).
const frameClients = new Set();

/** Registers a frame client (see above) and returns how to remove it */
export function addFrameClient(client) {
  frameClients.add(client);
  return () => frameClients.delete(client);
}

/** Runs `job` at the start of the next frame, once however often it is queued, then draws (unless `{ draw: false }`): input.js coalesces pointer events with it */
export const queueFrameWork = (job, opts) => scheduler.queue(job, opts);

/** How many frames ran and how many of them drew (for tests and the bench) */
export const frameStats = () => ({ frames: scheduler.frames, draws: scheduler.draws });

/** Stops (`true`) or resumes (`false`) every frame the page asks for itself, so a bench's scripted draws (`renderNow`) are the only ones */
export const holdFrames = (on) => scheduler.hold(on);

/** Forgets the frame that is waiting, if any (for tests that fake the clock) */
export const cancelFrame = () => scheduler.cancel();

// ---------------------------------------------------------------------------
//  The packet loop: frames are asked for only while packets are on screen (frame.js)
// ---------------------------------------------------------------------------

/** Start animating if allowed: asks for a frame, which draws and goes on only while a packet is on screen, motion is allowed and the visitor is active */
export function ensureFlowLoop() {
  scheduler.wake();
}

// Any pointer, wheel, touch or key event counts as the visitor being there: after 30 s without one the
// packets stop, and the next one starts them again. Passive listeners on the window, so no handler is slowed.
if (typeof window !== 'undefined') {
  const onInput = () => scheduler.noteInput();
  for (const type of ['pointerdown', 'pointermove', 'mousedown', 'mousemove', 'wheel', 'touchstart', 'touchmove', 'keydown']) {
    window.addEventListener(type, onInput, { passive: true, capture: true });
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduler.shown(); });
}
