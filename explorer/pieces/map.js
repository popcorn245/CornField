/**
 * @module explorer/pieces/map
 *
 * The map as a piece (spec 0011 D3): the stage, its two canvases and the keyboard help, made, wired and ended in one place, for cornfield's own
 * page (explorer/page.js mounts it into the page's stage) and for the `<corn-map>` component (components/src/corn-map, which mounts it in
 * its shadow root). There is one code path; the two differ only in the options they pass.
 *
 *   const piece = mount(root, inst, options)    -> { update, destroy, ... }
 *
 *   root      where the piece's elements go: an element or a shadow root
 *   inst      the instance (instance.js) the map runs on; null makes one over `root`, which `destroy()` then ends too
 *   options   see below; `update(next)` takes the same keys and applies what changed
 *
 * Options, all optional:
 *   topology   {nodes, edges}: the map to draw (the object topology.json holds). The page does not pass it: it fetches and fills the state itself (view.js)
 *   view       'map' | 'dataflow'
 *   node       the id of the selected node, or null/'' for none
 *   theme      'light' | 'dark' | 'auto': the ground the map is drawn for. 'auto' (and nothing) follows the document's own `data-theme`, else prefers-color-scheme
 *   renderer   'auto' | 'canvas2d'
 *   base, fetch, strings   for a piece that makes its own instance
 *   stage      true (default): the elements go in a stage of their own. false: straight into `root` (the page's stage is already there)
 *   keysHelp   the words the canvas is described by (the page's mention its panel); default: the keys the piece has
 *   measureCovered   () => px of the bottom of the map something covers (the page's phone sheets); default none
 *   keyboard   true (default): the map's keys on its canvas. The page keeps keyboard.js, which also drives its panels
 *   handleTaps true (default): a tap on a node selects it, a tap on the background clears it. The page decides that itself (it opens a panel)
 *   onSelect   ({id, kind}) after every change of selection, whoever made it (a tap, a key, `node`, `focusNode`); id null when cleared
 *   onReady    () once, after the first frame with a map in it is drawn
 *
 * What it does for a root that is not the document (the traps in test/explorer/piece-map.test.js):
 *   a drag released outside the root ends (pointer capture on the canvas), theme icons are fetched with CORS when the instance has a base,
 *   a change of theme reads the tokens again (`refresh()`), freeform positions are never stored, and `destroy()` always ends the instance's map.
 *
 * It imports the instance and the engine, and none of the bridges (state.js, render.js, map-style.js, layout.js): see instance-tripwires.test.js.
 */

import { createInstance } from '../instance.js';
import { createMap } from '../engine/render.js';
import { mapStyleOf } from '../engine/map-style.js';
import { computeDegreeCentrality, computeLaneLayout, layoutOrbit } from '../engine/layout.js';
import { createRenderer } from '../renderer.js';
import { bindCanvasInput } from '../input.js';
import { buildDataFlow } from '../flow-build.js';
import { resolveTheme } from '../theme-model.js';
import { selectionCamera } from '../selection-model.js';
import { zoomAbout } from '../camera.js';
import * as K from '../keyboard-model.js';

const KEYS_HELP = 'Arrow keys pan, plus and minus zoom, 0 fits the map. N and P select the next and the previous node, Home and End the first and the last. F frames the selected node and what it lights. Escape clears the selection.';

/** An element with a hook and the part of the same name (a host styles it with `corn-map::part(map-canvas)`) */
function hooked(inst, tag, name, attrs = {}) {
  const el = inst.doc.createElement(tag);
  if (name) { el.setAttribute('data-corn', name); el.setAttribute('part', name); }
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * @param {Element|ShadowRoot} root
 * @param {ReturnType<typeof createInstance>|null} inst
 * @param {object} [options]
 */
export function mount(root, inst, options = {}) {
  const ownsInstance = !inst;
  if (ownsInstance) inst = createInstance({ root, base: options.base || '', fetch: options.fetch, strings: options.strings });
  const { state } = inst;
  /** What the piece set up, undone by destroy() (the instance's own list is only run when the instance ends, which a page's instance does not with its piece) */
  const ends = [];
  const keep = (off) => { ends.push(off); return off; };
  const rendererOf = (v) => (v === 'canvas2d' ? 'canvas2d' : 'auto');
  const themeOf = (v) => (v === 'light' || v === 'dark' ? v : 'auto');
  const current = { renderer: rendererOf(options.renderer), theme: themeOf(options.theme), view: 'map', node: null, topology: undefined };
  let ended = false;
  let ready = false;

  // -- elements ---------------------------------------------------------------------------------------------------------------------
  const stage = options.stage === false ? null : hooked(inst, 'div', 'map-stage');
  const home = stage || root;
  const help = hooked(inst, 'p', null, { id: 'map-keys-help', class: 'hx-sr-only' });
  help.textContent = options.keysHelp || KEYS_HELP;
  const announcer = hooked(inst, 'p', null, { id: 'map-announcer', class: 'hx-sr-only', role: 'status', 'aria-live': 'polite' });
  const labelCanvas = hooked(inst, 'canvas', 'label-canvas', { id: 'label-canvas', 'aria-hidden': 'true' });

  /** A new map canvas: one per mount, and one per change of renderer (a canvas that gave a WebGL context can never give a 2d one) */
  function makeCanvas() {
    return hooked(inst, 'canvas', 'map-canvas', { id: 'graph-canvas', tabindex: '0', role: 'application', 'aria-roledescription': 'map', 'aria-label': 'Topology map', 'aria-describedby': 'map-keys-help' });
  }
  const firstCanvas = makeCanvas();
  if (stage) { stage.append(firstCanvas, help, announcer, labelCanvas); root.append(stage); } else root.prepend(firstCanvas, help, announcer, labelCanvas);
  keep(() => { for (const el of [firstCanvas, state.canvas, help, announcer, labelCanvas, stage]) if (el) el.remove(); });

  // -- what the engine needs on the state, in this order ------------------------------------------------------------------------------
  state.canvas = firstCanvas;
  state.labelCanvas = labelCanvas;
  // A 2d context that only measures text (layout.js labelWidth): the map canvas may be WebGL, and a canvas that gave WebGL can never give 2d
  state.ctx = inst.doc.createElement('canvas').getContext('2d');
  const map = createMap(inst, options.measureCovered ? { measureCovered: options.measureCovered } : {});
  const style = mapStyleOf(inst);
  keep(style.watch());
  keep(style.onChange(() => map.render()));
  const prefer = () => (current.renderer === 'canvas2d' ? 'canvas2d' : null);
  const installRenderer = () => map.setRenderer(createRenderer(state.canvas, { prefer: prefer(), mapStyle: style.get }));

  // -- the ground: light or dark ------------------------------------------------------------------------------------------------------
  const lightQuery = inst.win && inst.win.matchMedia ? inst.win.matchMedia('(prefers-color-scheme: light)') : null;
  /** The mode the map is drawn for: the element's own `theme`, else the document's `data-theme`, else the system's */
  function mode() {
    if (current.theme === 'light' || current.theme === 'dark') return current.theme;
    const root$ = inst.doc && inst.doc.documentElement;
    const own = root$ ? root$.getAttribute('data-theme') : null;
    if (own === 'light' || own === 'dark') return own;
    return resolveTheme('system', !!(lightQuery && lightQuery.matches));
  }
  /** Draws for the mode now in force and reads the tokens again (they differ by mode, and the host's `<html>` and head are not watched by the style) */
  function refresh() {
    if (ended) return;
    const next = mode();
    style.refresh();
    if (state.theme !== next) { state.theme = next; inst.touchScene(); }
    map.render();
  }
  state.theme = mode();
  if (lightQuery && lightQuery.addEventListener) { lightQuery.addEventListener('change', refresh); keep(() => lightQuery.removeEventListener('change', refresh)); }
  const Mutation = inst.win && inst.win.MutationObserver;
  if (Mutation && inst.doc && inst.doc.documentElement) { // the host page switching its own light and dark
    const watch = new Mutation(refresh);
    watch.observe(inst.doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    keep(() => watch.disconnect());
  }

  // -- the renderer, the layout, the input ------------------------------------------------------------------------------------------------
  installRenderer();

  /** Where nodes sit for the current view */
  function applyLayout() {
    computeDegreeCentrality(inst);
    if (state.view === 'dataflow' && state.flow) {
      state.flow.tiers.forEach((tier) => tier.nodes.forEach((n) => { n.r = Math.min(n.r, 13); })); // all small in the lanes
      computeLaneLayout(inst, state.flow);
    } else layoutOrbit(inst);
  }

  const fit = () => { if (state.nodes.length) map.fitGraphToViewport(map.fitPadding()); };

  // -- selection --------------------------------------------------------------------------------------------------------------------------
  let said = { id: null, kind: 'node' };
  /** Tells `onSelect` when the selection is not what it said last. Run after every change of the scene, so a tap, a key, search and a property all reach it. */
  function noteSelection() {
    if (ended) return;
    const node = state.selectedNode;
    const edge = state.selectedEdge;
    const next = node ? { id: node.id, kind: 'node' } : edge ? { id: `${edge.from}->${edge.to}`, kind: 'edge' } : { id: null, kind: said.kind };
    if (next.id === said.id) return;
    said = next;
    if (options.onSelect) options.onSelect({ ...next });
  }
  keep(inst.onSceneTouch(noteSelection));

  const nodeById = (id) => state.nodes.find((n) => n.id === id) || null;

  function select(node, { frame = false } = {}) {
    if (!node) { clear(); return; }
    if (!state.selectedNode || state.selectedNode.id !== node.id) state.selectedKind = null;
    state.selectedNode = node;
    state.selectedEdge = null;
    inst.touchScene();
    map.render();
    if (frame) frameSelected();
  }
  function clear() {
    if (!state.selectedNode && !state.selectedEdge) return;
    state.selectedNode = null;
    state.selectedEdge = null;
    inst.touchScene();
    map.render();
  }

  /** The camera goes to the selected node and what it lights (selection-model.js), at once: a flight is the page's */
  function frameSelected() {
    const node = state.selectedNode;
    if (!node || !state.width) return null;
    const lit = map.getScene().nodes.filter((n) => n.connected);
    const target = selectionCamera(node, lit, { x: 0, y: 0, width: state.width, height: state.height }, { padding: map.fitPadding() });
    Object.assign(state.camera, { x: target.x, y: target.y, zoom: target.zoom });
    map.render();
    return target;
  }

  /** Selects the node with this id and brings it into view; false when the map has no such node */
  function focusNode(id) {
    const node = nodeById(id);
    if (!node) return false;
    select(node, { frame: true });
    return true;
  }

  // -- the keyboard ---------------------------------------------------------------------------------------------------------------------
  let announceTimer = null;
  function announce(text) {
    announcer.textContent = '';
    inst.win.clearTimeout(announceTimer);
    announceTimer = inst.win.setTimeout(() => { announcer.textContent = text; }, 30); // a fresh text node a moment later is what makes a live region speak again
  }
  keep(() => inst.win.clearTimeout(announceTimer));

  const stepOrder = () => K.readingOrder(state.nodes.filter((n) => map.isNodeVisible(n)));
  function land(node, order) {
    if (!node) { announce('No nodes are shown.'); return; }
    select(node, { frame: true });
    announce(K.describeNode(node, order.length, order.indexOf(node)));
  }

  function onKey(e) {
    if (e.target !== state.canvas || e.defaultPrevented) return;
    const action = K.mapKeyAction(e.key, { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, selected: !!state.selectedNode });
    if (!action || action.type === 'open' || action.type === 'move') return; // a panel and freeform are the page's
    e.preventDefault(); // the host's own handlers see the key too, and tell by `defaultPrevented` that the map took it
    const { camera, width, height } = state;
    switch (action.type) {
      case 'pan': camera.x += action.dx; camera.y += action.dy; map.render(); break;
      case 'zoom':
        Object.assign(camera, zoomAbout(camera, action.factor, width / 2, height / 2, map.getMinZoom()));
        map.render();
        announce(K.zoomWords(camera.zoom));
        break;
      case 'fit': fit(); announce(`The whole map. ${K.zoomWords(camera.zoom)}`); break;
      case 'step': { const order = stepOrder(); land(K.stepFrom(order, state.selectedNode && state.selectedNode.id, action.by), order); break; }
      case 'first': case 'last': { const order = stepOrder(); land(action.type === 'first' ? order[0] : order[order.length - 1], order); break; }
      case 'frame': {
        const target = frameSelected();
        if (target) announce(target.framed ? `Framed ${state.selectedNode.label}` : `${state.selectedNode.label} centred`);
        break;
      }
      case 'close': clear(); announce('Selection cleared'); break;
      default:
    }
  }

  // -- pointer and keys on the canvas ---------------------------------------------------------------------------------------------------
  let stopInput = () => {};
  const inDocument = !!inst.root && inst.root.nodeType === 9;
  /** Binds the canvas now in `state.canvas`: map input, a mouse drag that follows the pointer out of the root, the keys. Once more when the canvas is replaced. */
  function bind() {
    const canvas = state.canvas;
    const offs = [bindCanvasInput(inst)];
    if (!inDocument) {
      // input.js hears the release on the root, so a drag let go outside an element root would stick: the canvas holds the pointer until it is let go
      offs.push(inst.listen(canvas, 'pointerdown', (e) => { if (e.pointerType === 'mouse' && canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ } } }));
    }
    if (options.keyboard !== false) offs.push(inst.listen(canvas, 'keydown', onKey));
    stopInput = () => offs.forEach((off) => off());
  }

  if (options.handleTaps !== false) {
    keep(inst.on('select', (node) => select(node)));
    keep(inst.on('background', () => clear()));
  }

  // -- the first frame ---------------------------------------------------------------------------------------------------------------------
  keep(map.onPaint(() => {
    if (ready || !state.nodes.length) return;
    ready = true;
    if (options.onReady) options.onReady();
  }));

  bind();
  keep(() => stopInput());
  keep(map.watchSize());
  map.resize();

  // -- changes ---------------------------------------------------------------------------------------------------------------------------------
  let pendingNode = null;
  function setTopology(topology) {
    const nodes = topology && Array.isArray(topology.nodes) ? topology.nodes : [];
    const edges = topology && Array.isArray(topology.edges) ? topology.edges : [];
    // The host's object is never changed: the map works on copies (the layout writes positions on them)
    state.baseNodes = nodes;
    state.baseEdges = edges;
    state.nodes = nodes.map((n) => ({ ...n }));
    state.edges = edges.map((e) => ({ ...e }));
    state.mapNodes = state.nodes;
    state.mapEdges = state.edges;
    state.selectedNode = null;
    state.selectedEdge = null;
    state.flow = buildDataFlow(state.nodes, state.edges);
    inst.touchScene();
    if (state.nodes.length) { applyLayout(); fit(); }
    if (pendingNode) { const node = nodeById(pendingNode); if (node) select(node); }
    map.render();
    map.ensureFlowLoop();
    noteSelection();
  }

  function setView(view) {
    const next = view === 'dataflow' ? 'dataflow' : 'orbit';
    if (state.view === next) return;
    state.view = next;
    inst.touchScene();
    if (state.nodes.length) { applyLayout(); fit(); map.ensureFlowLoop(); }
  }

  /** A canvas that has given a context cannot give the other kind: the map gets a new one, the old one gives its WebGL context back */
  function replaceRenderer() {
    const previous = map.getRenderer();
    if (previous.release) previous.release(); else previous.destroy(); // before the swap: a renderer already destroyed does not give its context back
    stopInput();
    const next = makeCanvas();
    state.canvas.replaceWith(next);
    state.canvas = next;
    bind();
    installRenderer();
    map.resize();
  }

  /**
   * Applies what changed in `next` (the options above). Only the keys present are looked at.
   * @param {object} [next]
   */
  function update(next = {}) {
    if (ended) return;
    if ('renderer' in next) {
      const value = rendererOf(next.renderer);
      if (value !== current.renderer) { current.renderer = value; replaceRenderer(); }
    }
    if ('theme' in next) {
      const value = themeOf(next.theme);
      if (value !== current.theme) { current.theme = value; refresh(); }
    }
    if ('topology' in next && next.topology !== current.topology) { current.topology = next.topology; setTopology(next.topology); }
    if ('view' in next) { current.view = next.view === 'dataflow' ? 'dataflow' : 'map'; setView(current.view === 'dataflow' ? 'dataflow' : 'orbit'); }
    if ('node' in next) {
      const id = next.node == null || next.node === '' ? null : String(next.node);
      pendingNode = id;
      if (id === null) clear();
      else { const node = nodeById(id); if (node && !(state.selectedNode && state.selectedNode.id === id)) select(node); }
    }
  }

  /** Ends the piece: its listeners, observers and timers, its elements, and the map (the renderer gives its WebGL context back) */
  function destroy() {
    if (ended) return;
    ended = true;
    while (ends.length) { try { ends.pop()(); } catch (err) { console.error('A map clean-up failed', err); } }
    map.destroy();
    if (ownsInstance) inst.destroy();
  }

  const first = {};
  for (const key of ['topology', 'view', 'node']) if (options[key] !== undefined) first[key] = options[key];
  update(first);
  refresh();

  return {
    inst,
    map,
    update,
    destroy,
    /** The whole map in view */
    fit,
    /** Selects a node by id and brings it into view; false when there is none */
    focusNode,
    /** Reads the tokens again and draws: for a change the style cannot see (the host's `<html>`, a stylesheet in its head) */
    refresh,
    /** Starts the theme's icons (`config.theme` of /cornfield/config.json), fetched with CORS when the instance has a base */
    applyTheme: (theme) => style.applyTheme(theme),
  };
}
