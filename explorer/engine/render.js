/**
 * @module explorer/engine/render
 *
 * The map of one instance (spec 0011 D2): the camera (fit, zoom, screen to world), the scene cache and the loop that animates flow
 * packets. What is drawn is decided by scene.js (buildScene); how it is drawn is the renderer's (renderer-webgl.js or
 * renderer-canvas2d.js). `createMap(inst)` hands the one to the other: `map.render()` draws the cached scene with the current camera
 * and time. Everything that used to be a module-level singleton (the renderer, the label layer, the frame loop, the frame clients, the
 * caches) is made here, once per instance, and released by `map.destroy()` (also run by `inst.destroy()`).
 *
 * It reads the instance and nothing global: the state is `inst.state`, the canvas is `inst.state.canvas` (the page shell finds it
 * inside the instance's root), activity is watched on the root, and the size by a ResizeObserver on the canvas's box.
 */

import { buildScene, createSceneCache, getActiveSubgraph as activeSubgraph, isNodeVisible as nodeVisible } from '../scene.js';
import { createCanvas2dRenderer } from '../renderer-canvas2d.js';
import { createSpatialCache } from '../spatial.js';
import { createFrameScheduler, packetsOnScreen } from '../frame.js';
import { createLabelLayer } from '../labels.js';
import { mapStyleOf } from './map-style.js';
import { ZOOM_MIN, ZOOM_FLOOR } from '../camera.js';

/** What keeps a visitor "there": after 30 s without one of these the packets stop (frame.js) */
const ACTIVITY = ['pointerdown', 'pointermove', 'mousedown', 'mousemove', 'wheel', 'touchstart', 'touchmove', 'keydown'];

/**
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst
 * @param {{ measureCovered?: () => number }} [opts] (used by the call that makes the map) `measureCovered`: the height of the bottom of the map the phone's sheets cover (sheets.js); default what `state.coveredBottom` holds
 */
export function createMap(inst, opts = {}) {
  // One map per instance: a module that is not yet converted registers with it as it loads (fly.js adds its frame client), before the page shell
  // runs, so a second call finds the map the first made
  if (inst.map) return inst.map;
  const { state } = inst;
  const measureCovered = opts.measureCovered || (() => state.coveredBottom || 0);
  const mapStyle = mapStyleOf(inst).get; // looked up once: a renderer and the labels call it on every draw
  /** The map has ended (destroy): nothing draws, nothing asks for a frame, no renderer is made again, whoever calls */
  let ended = false;

  // -------------------------------------------------------------------------
  //  Visibility and focus (decided in scene.js)
  // -------------------------------------------------------------------------
  const isNodeVisible = (node) => nodeVisible(state, node);
  /** Whether the viewer's own layers show the node, whatever a review has hidden (what-if's list of the other end of an edge) */
  const isNodeVisibleToViewer = (node) => nodeVisible(state, node, { viewer: true });

  /** The focus subgraph: the selected node and every node one edge away (selection-model.js); the switch and the kind come from the state */
  const getActiveSubgraph = (selected, edges = inst.viewEdges(), o = { throughChildren: !!state.throughChildren, kind: state.selectedKind || null }) => activeSubgraph(selected, edges, o);

  // -------------------------------------------------------------------------
  //  Scene and renderer
  // -------------------------------------------------------------------------
  const sceneCache = createSceneCache((st) => buildScene(st, { reduceMotion: inst.reducedMotion }));
  /** The scene for the current state, rebuilt only when `state.sceneVersion` changed */
  const getScene = () => sceneCache.get(state);
  /** How many times the scene has been built so far (for tests and the bench) */
  const sceneBuilds = () => sceneCache.builds;

  const spatialCache = createSpatialCache();
  /** The grid over the current scene's nodes (spatial.js), rebuilt only when the scene is: for hover, click and drag */
  const getSpatialIndex = () => spatialCache.get(getScene());
  /** How many times the grid was built so far (for tests and the bench) */
  const spatialBuilds = () => spatialCache.builds;

  let renderer = null;
  let rendererCanvas = null;

  /** The renderer drawing `state.canvas`: Canvas 2D unless another was handed to setRenderer */
  function getRenderer() {
    if (!renderer || rendererCanvas !== state.canvas) {
      if (renderer) renderer.destroy();
      renderer = createCanvas2dRenderer(state.canvas, { mapStyle });
      rendererCanvas = state.canvas;
      if (state.width) renderer.resize(state.width, state.height, inst.dpr());
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
      labelLayer = createLabelLayer(state.labelCanvas, { mapStyle });
      labelLayerCanvas = state.labelCanvas;
      if (state.width) labelLayer.resize(state.width, state.height, inst.dpr());
    }
    return labelLayer;
  }

  /** Swaps the renderer (see scene.js for the contract) and draws with it */
  function setRenderer(next) {
    if (renderer && renderer !== next) renderer.destroy();
    renderer = next;
    rendererCanvas = state.canvas;
    if (state.width) renderer.resize(state.width, state.height, inst.dpr());
    render();
  }

  // -------------------------------------------------------------------------
  //  Camera
  // -------------------------------------------------------------------------
  function resize() {
    const { canvas } = state;
    const before = `${state.width}x${state.height}`;
    state.width = canvas.parentElement.clientWidth;
    state.height = canvas.parentElement.clientHeight;
    getRenderer().resize(state.width, state.height, inst.dpr());
    const labels = getLabelLayer();
    if (labels) labels.resize(state.width, state.height, inst.dpr());
    if (before !== `${state.width}x${state.height}`) fitToNewBox();
    render();
  }

  /**
   * The box the map's fit reads is not always final when the map is first fitted: the page's own box is laid out a moment after the topology arrives
   * (an embedded pane sized after the page began loading), a component's stage is `display: none` or not yet sized. So the engine keeps what the last
   * fit asked for (`memo.lastFit`: its arguments and the camera it set), and when the box changes while the camera is still exactly there, nobody has
   * panned, zoomed or flown since, so the fit is made again for the box. Once anyone has moved the camera, a new box keeps their view.
   * A fit asked for while the map has no box (a parent `display: none`, a box of no size) waits for one (`memo.waiting`): fitted to nothing,
   * the camera would be lost.
   */
  const memo = inst.slot('fit', () => ({ lastFit: null, waiting: null })); // on the instance: a page that made two maps over one state (page.js, then the map piece) has one memory

  function fitToNewBox() {
    if (!state.width || !state.height) return;
    if (memo.waiting) { const { padding, only } = memo.waiting; fitGraphToViewport(padding === null ? fitPadding() : padding, only); return; }
    const { camera } = state;
    const last = memo.lastFit;
    if (last && camera.x === last.x && camera.y === last.y && camera.zoom === last.zoom) fitGraphToViewport(last.auto ? fitPadding() : last.padding, last.only);
  }

  /**
   * Draws again when the map's box changes size (in place of a listener on the window): a ResizeObserver on the canvas's parent. The first
   * report, which every observer makes on `observe`, is skipped when the size is already the one the map has.
   */
  function watchSize() {
    const box = state.canvas && state.canvas.parentElement;
    const Observer = inst.win && inst.win.ResizeObserver;
    if (!box || !Observer) return () => {};
    const ro = new Observer(() => {
      if (!state.canvas) return;
      if (box.clientWidth === state.width && box.clientHeight === state.height) return;
      resize();
    });
    ro.observe(box);
    const stop = () => ro.disconnect();
    inst.own(stop);
    return stop;
  }

  /** The box the fit shows (world px) and the zoom that makes it fill the screen, before any limit; null with nothing to show */
  function fitTarget(padding, only = null) {
    const { nodes, width, height } = state;
    let visible = nodes.filter(isNodeVisible);
    if (only) {
      const part = visible.filter((n) => only.has(n.id));
      if (part.length) visible = part;
    }
    if (visible.length === 0) return null;
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
    if (state.view === 'work' && state.work && state.work.fit && !only) ({ minX, maxX, minY, maxY } = state.work.fit); // the Work view fits its lanes, and the room its names and toggles need (work-model.js)

    const availWidth = Math.max(160, width - padding * 2);
    const availHeight = Math.max(160, mapHeight - padding * 2);
    const raw = Math.min(availWidth / (maxX - minX), availHeight / (maxY - minY));
    return { minX, maxX, minY, maxY, mapHeight, raw };
  }

  let minZoomKey = '';
  let minZoomValue = ZOOM_MIN;

  /**
   * The lowest zoom for this map on this screen: low enough that Fit shows all of it (at most the default floor, so a small
   * map keeps its limit). Hand zoom (wheel, pinch, keys) and Fit share it.
   */
  function getMinZoom() {
    const key = `${state.sceneVersion}|${state.width}|${state.height}|${state.view}|${measureCovered()}`;
    if (key !== minZoomKey) {
      minZoomKey = key;
      const t = fitTarget(fitPadding());
      minZoomValue = t && t.raw > 0 && Number.isFinite(t.raw) ? Math.max(ZOOM_FLOOR, Math.min(ZOOM_MIN, t.raw)) : ZOOM_MIN;
    }
    return minZoomValue;
  }

  /** Zoom and pan so every visible node (and its label) is on screen; `only` (a Set of ids) narrows it to those, when any are visible */
  function fitGraphToViewport(padding = 40, only = null) {
    const { width, height, camera } = state;
    if (!width || !height) { // no box yet: the fit is made when there is one (resize())
      if (state.nodes.length) memo.waiting = { padding: padding === fitPadding() ? null : padding, only };
      return;
    }
    memo.waiting = null;
    const t = fitTarget(padding, only);
    if (!t) return;
    const { minX, maxX, minY, maxY, mapHeight } = t;
    const targetZoom = Math.min(1.0, Math.max(ZOOM_FLOOR, t.raw));

    camera.zoom = targetZoom;
    camera.x = width / 2 - ((minX + maxX) / 2) * targetZoom;
    camera.y = mapHeight / 2 - ((minY + maxY) / 2) * targetZoom;
    memo.lastFit = { padding, auto: padding === fitPadding(), only, x: camera.x, y: camera.y, zoom: camera.zoom };
    render();
  }

  const fitPadding = () => (state.view === 'work' ? (state.width < 640 ? 44 : 96) : state.width < 640 ? 24 : 48); // the Work view leaves room for the names under the nodes at the edge, in a fit and in a selection's framing

  const screenToWorld = (sx, sy) => ({ x: (sx - state.camera.x) / state.camera.zoom, y: (sy - state.camera.y) / state.camera.zoom });

  // -------------------------------------------------------------------------
  //  When to draw (frame.js has the rules): on demand, not on a timer
  // -------------------------------------------------------------------------
  let drawnVersion = -1;

  function paint() {
    if (!state.canvas) return;
    const scene = getScene();
    drawnVersion = scene.version;
    getRenderer().draw(scene, state.camera, performance.now());
    // The labels repaint only when the camera, the scene or the size changed, never on a packet frame
    const labels = getLabelLayer();
    if (labels) labels.draw(scene, state.camera, { hover: state.hoverNodeId });
    paintHooks.forEach((fn) => fn(scene, state.camera));
  }

  /** The node whose label is drawn under a screen point, or null (labels.js `hit`): a cluster's title frames the cluster */
  function labelNodeAt(x, y) {
    const labels = getLabelLayer();
    return labels ? labels.hit(x, y) : null;
  }

  /**
   * The node the pointer is on (or null): a node with no label is named by a chip over the map while it is. Only the label layer
   * draws again (the map has nothing new to show), so moving across the map costs one small redraw per node entered.
   */
  function setHoverNode(id) {
    const next = id || null;
    if (state.hoverNodeId === next) return;
    state.hoverNodeId = next;
    const labels = getLabelLayer();
    if (labels && state.canvas && state.width) labels.draw(getScene(), state.camera, { hover: next });
  }

  /** Things drawn over the map by the page itself (the runs' marks, explorer/runs-map.js): called after each draw with the scene and the camera */
  const paintHooks = new Set();
  const onPaint = (fn) => {
    paintHooks.add(fn);
    return () => paintHooks.delete(fn);
  };

  // Other things that need frames (the scenario player and its camera glide): `{ tick(nowMs), wants() }`.
  // `tick` runs on every frame of the loop; the loop keeps going while any client `wants()` frames, even
  // under reduced motion (the packets stay still; the steps still change). frame.js runs them (`tickClients`).
  const frameClients = new Set();

  const scheduler = createFrameScheduler({
    draw: paint,
    packetsVisible: () => !!state.canvas && packetsOnScreen(getScene(), state.camera, state.width, state.height),
    isHidden: () => inst.hidden(),
    tickClients: (t) => { let more = false; frameClients.forEach((c) => { c.tick(t); if (c.wants()) more = true; }); return more; },
    clientsWant: () => [...frameClients].some((c) => c.wants()),
    reduceMotion: () => inst.reducedMotion,
    extraDirty: () => state.sceneVersion !== drawnVersion,
    now: () => performance.now(),
    raf: (cb) => requestAnimationFrame(cb),
    caf: (id) => cancelAnimationFrame(id),
  });

  /** Something changed (the camera, the scene, the size): draw it in the next animation frame, once however often this is called */
  function render() {
    if (ended || !state.canvas) return;
    scheduler.markDirty();
  }

  /** Draws right now, for a caller that needs the pixels this instant (a test, a screenshot) */
  function renderNow() {
    if (ended || !state.canvas) return;
    scheduler.drawNow();
  }

  /** Registers a frame client (see above) and returns how to remove it */
  function addFrameClient(client) {
    frameClients.add(client);
    return () => frameClients.delete(client);
  }

  // Any pointer, wheel, touch or key event counts as the visitor being there: after 30 s without one the
  // packets stop, and the next one starts them again. Passive listeners on the root (captured, so no handler hides one), so no handler is slowed.
  // They are this map's: an instance that outlives it (a scope's, whose map is removed and put back) is not left holding them (destroy)
  const listening = [];
  if (inst.root) {
    const onInput = () => scheduler.noteInput();
    for (const type of ACTIVITY) listening.push(inst.listen(inst.root, type, onInput, { passive: true, capture: true }));
  }
  listening.push(inst.onShown(() => scheduler.shown()));
  // A page that loaded hidden (a background tab, a pane not yet shown) has had no frames, and a ResizeObserver reports nothing while it is hidden:
  // the box is read again when it is shown (resize() fits the map again if nobody has moved the camera)
  listening.push(inst.onShown(() => {
    const box = state.canvas && state.canvas.parentElement;
    if (!ended && box && box.clientWidth && box.clientHeight && (box.clientWidth !== state.width || box.clientHeight !== state.height)) resize();
  }));

  /** Ends the map: no frame is waiting, the renderer's GPU context and the label layer are released, nothing is called again */
  function destroy() {
    ended = true;
    for (const off of listening.splice(0)) off();
    if (inst.map === map) inst.map = null; // an instance that outlives its map (a scope's) can be given another
    scheduler.cancel();
    // the end of this map: the renderer gives its WebGL context back too (`release`); a swap (setRenderer) only destroys, so the next renderer on the canvas has a live one
    if (renderer) { if (renderer.release) renderer.release(); else renderer.destroy(); renderer = null; rendererCanvas = null; }
    if (labelLayer) { labelLayer.destroy(); labelLayer = null; labelLayerCanvas = null; }
    paintHooks.clear();
    frameClients.clear();
  }

  const map = {
    isNodeVisible,
    isNodeVisibleToViewer,
    getActiveSubgraph,
    getScene,
    sceneBuilds,
    getSpatialIndex,
    spatialBuilds,
    getRenderer,
    setRenderer,
    resize,
    watchSize,
    getMinZoom,
    fitGraphToViewport,
    fitPadding,
    screenToWorld,
    labelNodeAt,
    setHoverNode,
    onPaint,
    render,
    renderNow,
    addFrameClient,
    /** Runs `job` at the start of the next frame, once however often it is queued, then draws (unless `{ draw: false }`): input.js coalesces pointer events with it */
    queueFrameWork: (job, o) => { if (!ended) scheduler.queue(job, o); },
    /** How many frames ran and how many of them drew (for tests and the bench) */
    frameStats: () => ({ frames: scheduler.frames, draws: scheduler.draws }),
    /** Stops (`true`) or resumes (`false`) every frame the page asks for itself, so a bench's scripted draws (`renderNow`) are the only ones */
    holdFrames: (on) => { if (!ended) scheduler.hold(on); },
    /** Forgets the frame that is waiting, if any (for tests that fake the clock) */
    cancelFrame: () => scheduler.cancel(),
    /** Start animating if allowed: asks for a frame, which draws and goes on only while a packet is on screen, motion is allowed and the visitor is active */
    ensureFlowLoop: () => { if (!ended) scheduler.wake(); },
    destroy,
  };
  inst.map = map;
  inst.own(destroy);
  return map;
}
