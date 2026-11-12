/**
 * @module explorer/pieces/map
 *
 * The map as a piece (spec 0011 D3): its two canvases, the help for its keys and its announcer, made, wired and ended in one place, for cornfield's
 * own page (explorer/page.js mounts it where index.html keeps `<!--corn-piece:map/stage-->`) and for the `<corn-map>` component (components/src,
 * which mounts it in its shadow root). There is one code path: the keys are engine/keyboard.js's, a tap selects through engine/selection.js, and
 * the page and a component differ only in who listens to the instance's events (the page's node panel follows `node:show`; a component turns
 * `selection` into `cornSelect`).
 *
 *   const piece = mount(root, inst, options)    -> { update, destroy, ... }
 *
 *   root      where the piece's elements go when `options.slots` names no place: an element or a shadow root (they go in a stage of their own there)
 *   inst      the instance (instance.js) the map runs on; null makes one over `root`, which `destroy()` then ends too. A scope's instance (pieces/scope.js):
 *             the map attaches its root to it (one map per scope: a second mount draws nothing and says why), takes the topology the scope's source
 *             holds unless it has one of its own, and does not end the instance when it ends
 *   options   see below; `update(next)` takes the same keys and applies what changed
 *
 * Options, all optional:
 *   topology   {nodes, edges}: the map to draw (the object topology.json holds). The page does not pass it: it fetches and fills the state itself (view.js)
 *   view       'map' | 'dataflow'
 *   node       the id of the selected node, or null/'' for none. A node the map has not got yet is selected when a topology brings it
 *   theme      'light' | 'dark' | 'auto': the ground the map is drawn for. 'auto' (and nothing) follows the document's own `data-theme`, else prefers-color-scheme
 *   renderer   'auto' | 'canvas2d'
 *   base, fetch, strings   for a piece that makes its own instance
 *   src        the base address of a cornfield server, for a piece with no scope around it: it makes a private scope of its own (pieces/scope.js) that reads
 *              the config and the topology from there, with the maintainer's session, and shows the states of that load (pieces/status.js). Not applied
 *              by `update`: a new server is a new instance, so the shell mounts the piece again. pieces/scope.js and what it loads are imported then,
 *              a chunk of the package's own, so a map that is handed its topology never loads them (the piece answers at once; see mountWithSource)
 *   useTheme, version, pageUrl, onAuth, onError   for that private scope (see mountScope)
 *   slots      { stage: Node }: the place the elements go before (cornfield's page: the marker in its stage). Without it they go in a stage of their own in `root`
 *   keysHelp   the words the canvas is described by; default KEYS_HELP. cornfield's page, which has the node panel and Freeform, says KEYS_HELP_WITH_PANEL
 *   tokens     the default `--corn-*` tokens (CSS text) to add, once, to the document, and to the shadow root the map's host is in if it is in one (adopt-tokens.js)
 *   measureCovered   () => px of the bottom of the map something covers (the page's phone sheets); default none
 *   onSelect   ({ id, kind, source, from?, to? }) once per change of the selection, from the instance's `selection` event, whoever made it:
 *              kind 'node' (id: the node's), 'edge' (id: 'from->to', and from, to), or null with id null (cleared); source as the event says
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
import { layoutMap, setTopology as installTopology } from '../engine/topology.js';
import { initKeyboard, resetKeyboard } from '../engine/keyboard.js';
import { selectNode, clearSelection } from '../engine/selection.js';
import { stopFlight } from '../engine/fly.js';
import { scopeOf, place } from '../engine/piece.js';
import { createRenderer } from '../renderer.js';
import { bindCanvasInput } from '../input.js';
import { resolveTheme } from '../theme-model.js';
import { escapeHtml } from '../../core/text.js';
import { adoptDefaultTokens } from './adopt-tokens.js';
import { scopeInfo } from './scope-link.js';

/** The keys of a map on its own (engine/keyboard.js): what the canvas is described by */
export const KEYS_HELP = 'Arrow keys pan, plus and minus zoom, 0 fits the map. N and P select the next and the previous node, Home and End the first and the last. F frames the selected node and what it lights. Escape clears the selection.';
/** The same keys where the map has the node panel and Freeform beside it (cornfield's page) */
export const KEYS_HELP_WITH_PANEL = "Arrow keys pan, plus and minus zoom, 0 fits the map. N and P select the next and the previous node, Home and End the first and the last. F frames the selected node and what it lights. Enter goes to the selected node's panel, Escape closes it. In Freeform, Alt and an arrow moves the selected node.";

/** The map canvas: one per mount, and one per change of renderer (a canvas that gave a WebGL context can never give a 2d one) */
const CANVAS = '<canvas id="graph-canvas" data-corn="map-canvas" tabindex="0" role="application" aria-roledescription="map" aria-label="Topology map" aria-describedby="map-keys-help"></canvas>';

/**
 * The markup of the piece (`stage`): the map canvas, the help for its keys, the announcer the keyboard speaks in (engine/keyboard.js), and the
 * canvas the labels are drawn on (labels.js) over the map; the map canvas still gets the pointer. Hooks get their parts when placed (engine/piece.js).
 * @param {{ keysHelp?: string }} [opts]
 */
export const markup = ({ keysHelp = KEYS_HELP } = {}) => ({
  stage: `${CANVAS}
<p id="map-keys-help" class="hx-sr-only">${escapeHtml(keysHelp)}</p>
<p id="map-announcer" class="hx-sr-only" role="status" aria-live="polite"></p>
<canvas id="label-canvas" data-corn="label-canvas" aria-hidden="true"></canvas>`,
});

/**
 * The piece of a second map in a scope: the engine holds one map per instance (its state has one canvas, one camera, one selection), so this one draws
 * nothing. It says why, in its own stage (pieces/status.js), and tells the scope, which says it as `cornError` `{ kind: 'second-map' }`.
 */
function refused(root, inst, info) {
  const made = place(inst, root, '<div data-corn="map-stage"></div>', null, 'stage');
  const status = info.mountStatus(made[0], inst, { follow: false });
  status.refuse('second-map');
  inst.emit('piece:refused', { piece: 'map', reason: 'second-map', message: 'A scope holds one map.', host: root.nodeType === 11 ? /** @type {ShadowRoot} */ (root).host : root });
  const none = () => {};
  return {
    inst,
    refused: true,
    update: none,
    fit: none,
    refresh: none,
    focusNode: () => false,
    applyTheme: none,
    destroy() { status.destroy(); for (const el of made) el.remove(); },
  };
}

/** The document or shadow root the map's host sits in: where the default tokens go */
function hostRootOf(root) {
  const host = root.nodeType === 11 ? /** @type {ShadowRoot} */ (root).host : root;
  return host && typeof host.getRootNode === 'function' ? host.getRootNode() : null;
}

/**
 * @param {Element|ShadowRoot} root
 * @param {ReturnType<typeof createInstance>|null} inst
 * @param {object} [options]
 */
export function mount(root, inst, options = {}) {
  if (!inst && options.src !== undefined && options.src !== null && options.src !== '') return mountWithSource(root, options);
  return mountOn(root, inst, options, null);
}

/**
 * A map with a `src` and no scope around it makes a private scope on its own element: the same loading, the same states, one tag. The scope's code
 * (pieces/scope.js and what it loads: the reads, the states, the server's theme) is a chunk of the package's own, imported the first time a map has
 * a `src` (a map that is handed its topology never loads it). The piece answers at once: what it is told before the chunk is there is applied when it
 * is, `fit`, `refresh` and `focusNode` do nothing until then (there is no map to act on yet), and `destroy` before then makes nothing.
 */
function mountWithSource(root, options) {
  const host = root.nodeType === 11 ? /** @type {ShadowRoot} */ (root).host : root;
  const pending = {};
  let real = null;
  let ended = false;
  import('./scope.js').then(({ mountScope }) => {
    if (ended) return;
    const privateScope = mountScope(host, {
      src: options.src, theme: options.theme, useTheme: options.useTheme, tokens: options.tokens, version: options.version, pageUrl: options.pageUrl,
      onAuth: options.onAuth, onError: options.onError,
    });
    real = mountOn(root, privateScope.instance, { ...options, ...pending }, privateScope);
  }, (err) => {
    if (!ended && options.onError) options.onError({ kind: 'offline', message: `the map's loader did not load: ${err && err.message ? err.message : err}` });
  });
  return {
    get inst() { return real ? real.inst : null; },
    get map() { return real ? real.map : null; },
    update(next = {}) { if (real) real.update(next); else Object.assign(pending, next); },
    fit() { if (real) real.fit(); },
    focusNode(id) { return real ? real.focusNode(id) : false; },
    refresh() { if (real) real.refresh(); },
    applyTheme(theme) { return real ? real.applyTheme(theme) : null; },
    destroy() {
      if (ended) return;
      ended = true;
      if (real) real.destroy();
      real = null;
    },
  };
}

/** The map on an instance: a scope's, its own private scope's (`privateScope`, which it ends when it ends), or one it makes */
function mountOn(root, inst, options, privateScope) {
  const ownsInstance = !inst;
  if (ownsInstance) inst = createInstance({ root, base: options.base || '', fetch: options.fetch, strings: options.strings });
  // An instance that belongs to a scope holds one map: the map attaches its shadow root to it, and a second map is told why it has no map
  const info = scopeInfo(inst);
  let releaseRoot = () => {};
  if (info) {
    try { releaseRoot = inst.attach(root); } catch {
      if (privateScope) privateScope.destroy();
      return refused(root, inst, info);
    }
  }
  const { state } = inst;
  const source = info ? info.source : null;
  if (options.tokens) {
    // The defaults go on the document, whose :root every element inherits from (through every shadow root); where the map's host sits in a
    // shadow root of the page's own, that root gets the sheet too, for the rules on the element's `theme` attribute, which match only there
    const where = hostRootOf(root);
    if (where) adoptDefaultTokens(where.nodeType === 9 ? where : where.ownerDocument, options.tokens);
    if (where && where.nodeType === 11) adoptDefaultTokens(where, options.tokens);
  }
  /** What the piece set up, undone by destroy() (the instance's own end runs it too, if the piece is still there) */
  const scope = scopeOf(inst);
  scope.own(releaseRoot);
  if (privateScope) scope.own(() => privateScope.destroy());
  const rendererOf = (v) => (v === 'canvas2d' ? 'canvas2d' : 'auto');
  const themeOf = (v) => (v === 'light' || v === 'dark' ? v : 'auto');
  const current = { renderer: rendererOf(options.renderer), theme: themeOf(options.theme), topology: undefined };
  /** A topology the host handed to this map itself: it wins over the scope's source (the host's property is the host's choice) */
  let ownTopology = options.topology !== undefined && options.topology !== null;
  let ended = false;
  let ready = false;

  // -- elements ---------------------------------------------------------------------------------------------------------------------
  const html = markup({ keysHelp: options.keysHelp }).stage;
  const slots = options.slots && options.slots.stage ? options.slots : null;
  const made = place(inst, root, slots ? html : `<div data-corn="map-stage">${html}</div>`, slots, 'stage');
  const find = (sel) => made.map((el) => (el.matches(sel) ? el : el.querySelector(sel))).find(Boolean);
  scope.own(() => { for (const el of [...made, state.canvas]) if (el) el.remove(); });
  // What the person sees while the data loads and when it cannot be had (pieces/status.js): only a map that has a source
  const stage = made.find((el) => el.matches('[data-corn="map-stage"]')) || null;
  if (source && stage) {
    const status = info.mountStatus(stage, inst, { onRetry: () => source.load(), focusMap: () => { if (state.canvas) state.canvas.focus(); } });
    scope.own(status.destroy);
  }

  // -- what the engine needs on the state, in this order ------------------------------------------------------------------------------
  state.canvas = find('[data-corn="map-canvas"]');
  state.labelCanvas = find('[data-corn="label-canvas"]');
  // A 2d context that only measures text (layout.js labelWidth): the map canvas may be WebGL, and a canvas that gave WebGL can never give 2d
  state.ctx = inst.doc.createElement('canvas').getContext('2d');
  const map = createMap(inst, options.measureCovered ? { measureCovered: options.measureCovered } : {});
  const style = mapStyleOf(inst);
  scope.own(style.watch());
  scope.own(style.onChange(() => map.render()));
  const prefer = () => (current.renderer === 'canvas2d' ? 'canvas2d' : null);
  const installRenderer = () => map.setRenderer(createRenderer(state.canvas, { prefer: prefer(), mapStyle: style.get }));

  // -- the ground: light or dark ------------------------------------------------------------------------------------------------------
  const lightQuery = inst.win && inst.win.matchMedia ? inst.win.matchMedia('(prefers-color-scheme: light)') : null;
  /** The mode the map is drawn for: the element's own `theme`, else the document's `data-theme`, else the system's */
  function mode() {
    if (current.theme === 'light' || current.theme === 'dark') return current.theme;
    if (info && (info.theme === 'light' || info.theme === 'dark')) return info.theme; // the scope's, when the map has none of its own
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
  // The scope's server theme: its sheet goes into this root, and its tokens (on the scope's element) are read again once it is there or goes
  if (info) scope.own(info.serverTheme.adopt(root));
  if (info) { scope.on('theme', () => refresh()); scope.on('scope:theme', () => refresh()); }
  if (lightQuery && lightQuery.addEventListener) { lightQuery.addEventListener('change', refresh); scope.own(() => lightQuery.removeEventListener('change', refresh)); }
  const Mutation = inst.win && inst.win.MutationObserver;
  if (Mutation && inst.doc && inst.doc.documentElement) { // the host page switching its own light and dark
    const watch = new Mutation(refresh);
    watch.observe(inst.doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    scope.own(() => watch.disconnect());
  }

  // -- the renderer, the layout --------------------------------------------------------------------------------------------------------
  installRenderer();

  /** Where nodes sit for the current view (engine/topology.js) */
  const applyLayout = () => layoutMap(inst);

  /** A fit asked for while the map has no box (a parent `display: none`, a box of no size) waits for one: fitted to nothing, the camera would be lost */
  let fitWhenSized = false;
  const fit = () => {
    if (!state.nodes.length) return;
    fitWhenSized = !state.width || !state.height;
    if (!fitWhenSized) map.fitGraphToViewport(map.fitPadding());
  };
  const nodeById = (id) => state.nodes.find((n) => n.id === id) || null;

  // -- selection: one path for the page and a component ---------------------------------------------------------------------------------
  /** A node the host asked for that the map has not got (yet): selected when a topology brings it */
  let pendingNode = null;
  // A tap on a node selects it, a tap on the bare map clears it, a hand on the camera ends a flight (input.js asks; engine/selection.js does)
  scope.on('select', (node) => selectNode(inst, node, { source: 'tap' }));
  scope.on('background', () => clearSelection(inst, { source: 'tap' }));
  scope.on('grab', () => stopFlight(inst));
  // The instance says each change once, whoever made it (a tap, a key, a search, `node`, an assignment to the state: an edge picked on a proposal)
  scope.on('selection', ({ node, edge, source }) => {
    if (ended) return;
    if (node || edge) pendingNode = null;
    if (!options.onSelect) return;
    if (node) options.onSelect({ id: node.id, kind: 'node', source });
    else if (edge) options.onSelect({ id: `${edge.from}->${edge.to}`, kind: 'edge', from: edge.from, to: edge.to, source });
    else options.onSelect({ id: null, kind: null, source });
  });

  /** Selects the node with this id and brings it into view; false when the map has no such node */
  function focusNode(id) {
    const node = nodeById(String(id));
    if (!node || ended) return false;
    selectNode(inst, node, { frame: true, source: 'api' });
    return true;
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
    resetKeyboard(inst); // the keys are the canvas's (engine/keyboard.js): a new canvas takes them over
    initKeyboard(inst);
    offs.push(() => resetKeyboard(inst));
    stopInput = () => offs.forEach((off) => off());
  }

  // -- the first frame ---------------------------------------------------------------------------------------------------------------------
  scope.own(map.onPaint(() => {
    if (fitWhenSized && state.width && state.height) fit();
    if (ready || !state.nodes.length) return;
    ready = true;
    if (options.onReady) options.onReady();
  }));

  bind();
  scope.own(() => stopInput());
  // The topology a scope's source holds (read from its server, or handed to the scope), unless this map has one of its own
  const takeSource = () => {
    if (ownTopology || !source || !source.topology || source.topology === current.topology) return;
    current.topology = source.topology;
    setTopology(source.topology);
  };
  if (source) scope.on('source', (detail) => { if (detail.state === 'ready') takeSource(); });
  scope.own(map.watchSize());
  map.resize();

  // -- changes ---------------------------------------------------------------------------------------------------------------------------------
  function setTopology(topology) {
    const keep = state.selectedNode ? state.selectedNode.id : null; // the selection outlives a new topology that has its node
    installTopology(inst, topology); // the base map, the data-flow preset and the selection kept or cleared (engine/topology.js)
    const again = keep ? nodeById(keep) : null;
    if (state.nodes.length) { applyLayout(); fit(); }
    const asked = !again && pendingNode ? nodeById(pendingNode) : null; // the node the host asked for before the map had it
    if (asked) selectNode(inst, asked, { source: 'api' });
    map.render();
    map.ensureFlowLoop();
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
    const holder = inst.doc.createElement('template');
    holder.innerHTML = CANVAS;
    const next = /** @type {HTMLCanvasElement} */ (holder.content.firstElementChild);
    next.setAttribute('part', 'map-canvas');
    const hadFocus = inst.active() === state.canvas;
    state.canvas.replaceWith(next);
    state.canvas = next;
    bind();
    installRenderer();
    map.resize();
    if (hadFocus) next.focus();
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
    if ('topology' in next) {
      ownTopology = next.topology !== undefined && next.topology !== null;
      if (ownTopology && next.topology !== current.topology) { current.topology = next.topology; setTopology(next.topology); }
      else if (!ownTopology && source && source.topology) { current.topology = undefined; takeSource(); } // the host took its map back: the scope's again
      else if (!ownTopology && next.topology !== current.topology) { current.topology = next.topology; setTopology(next.topology); }
    }
    if ('view' in next) setView(next.view === 'dataflow' ? 'dataflow' : 'orbit');
    if ('node' in next) {
      const id = next.node == null || next.node === '' ? null : String(next.node);
      if (id === null) {
        pendingNode = null;
        if (state.selectedNode || state.selectedEdge) clearSelection(inst, { source: 'api' });
      } else {
        const node = nodeById(id);
        if (!node) pendingNode = id;
        else if (!state.selectedNode || state.selectedNode.id !== id) selectNode(inst, node, { source: 'api' }); // the same node again changes nothing and says nothing
      }
    }
  }

  /** Ends the piece: its listeners, observers and timers, its elements, and the map (the renderer gives its WebGL context back) */
  function destroy() {
    if (ended) return;
    ended = true;
    scope.destroy();
    map.destroy();
    if (ownsInstance) inst.destroy();
  }

  const first = {};
  for (const key of ['topology', 'view', 'node']) if (options[key] !== undefined) first[key] = options[key];
  update(first);
  takeSource();
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
