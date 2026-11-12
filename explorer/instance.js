/**
 * @module explorer/instance
 *
 * The engine as something a page can make more than one of (spec 0011 D2). `createInstance` returns the object that holds what
 * `state.js` held when the explorer was one program per document, and the things a piece of the explorer may reach:
 *
 *   inst.root       where the instance's elements are: a Document (cornfield's page), or an element or shadow root (a component); `attach(root)` moves it
 *                   to the shadow root of the one piece that draws the map when the instance belongs to a scope (pieces/scope.js)
 *   inst.state      the explorer's state (instance-state.js): the topology, the layers, the camera, the selection, the view
 *   inst.base       the address of the cornfield server the instance talks to ('' = the page's own origin)
 *   inst.fetch      `fetch` bound to that base; inst.url(path) is a served path made absolute against it
 *   inst.strings    the words the host overrides (key -> text), read with engine/strings.js `t(inst, key)`: two instances speak in two voices
 *   inst.touchScene / onSceneTouch   a change the picture is built from, and who follows it
 *   inst.on / emit  what a piece tells its neighbours, per instance: `emit(name, detail)` calls every `on(name, fn)`, and `on` returns how to stop.
 *   inst.ask        what a piece asks of a neighbour that may or may not be there: the first answer other than `undefined` from the
 *                   handlers of `on(name, ...)`, else `undefined`. A piece that finds no answer does without (the Work panel is not part of every page)
 *   inst.setSelection(node, edge, { source, quiet })   the one way the converted pieces change what is selected (explorer/engine/selection.js);
 *                   returns the change, whose `announce()` says it when `quiet` held it back (the caller touches the scene first)
 *   inst.offline()  whether the browser has no network; inst.onNetwork(fn(offline)), inst.onWindowFocus(fn), inst.onPageHide(fn), inst.onHide(fn): the few window facts the review needs
 *   inst.active()   the element that has the focus inside the root's tree (a shadow root's own, not the host)
 *   inst.el         an element of the instance by id, found inside its root and never by document id
 *   inst.listen     a listener that `destroy()` removes; inst.own: any other clean-up `destroy()` runs; inst.release(fn): takes one back that its owner ran itself
 *   inst.slot       what a module keeps for this instance (its map style), made on first use
 *   inst.map        the map (engine/render.js createMap sets it)
 *   inst.destroy()  runs every clean-up, so nothing the instance set up outlives it
 *
 * The events of an instance (name: detail). Every one is per instance; a name that is not listed here is not part of the contract.
 *
 *   What happened (`on` them):
 *   selection       { node, edge, previous: { node, edge }, source }  THE selection changed: another node (by id), another edge, or none. `source` says
 *                   who: 'tap' (the map or the panel's Close), 'keyboard', 'search', 'link' (a link or a list row in the panel), 'api' (a program calling
 *                   engine/selection.js), or 'state' (an assignment to `state.selectedNode` or `state.selectedEdge`: an edge picked on the map is one).
 *                   `node: null` is a clear. Said once per change, in order, and `previous` is what the listeners last heard: not when the same node
 *                   is chosen again or nothing was selected and nothing is; a change a listener makes while it is said is said after every
 *                   listener has heard the first
 *   scene           (none)  touchScene(): what the picture is built from changed (`onSceneTouch`)
 *   layers          (none)  a layer went on or off, or the layers were set (engine/layers.js): live.js starts or stops the live layer, a search moves its matches
 *   search          { query, current }  the search's query or its current match changed (pieces/search.js)
 *   node:painted    { node }  the node panel was filled for this node (pieces/node-panel.js)
 *   proposal        { change: 'opened' | 'view' | 'closed', slug, source, pinSource, view, proposal }  the open proposal changed (engine/proposal.js; the page writes the address from it)
 *   proposal:draw   { open }  the bar and the review column draw again; proposal:bar { open }: they have, so what sits on the bar draws again
 *   proposal:mark   { applied, effective, proposal }  before the map is laid out (the what-if editor marks its edits)
 *   proposal:message { text, isError, ways }  one line in the bar in place of a proposal; proposal:listing: the list the server gave was read
 *   proposal:pull-head sha  the open proposal's PR was read; proposal:waiting { run, key }: a run waits on it (the bar's waiting line); proposal:waiting-reset
 *   scenario:player { id, index, total, done, playing, checks } | null  the scenario player moved, or closed (engine/player.js)
 *   changes:paint   (none)  the review column's lists were drawn again; changes:peek text: its count line, for a phone's peek
 *   decision        { outcome: 'approved' | 'notes', review, slug, source, open }  the server took the review, after it answered (pieces/decision.js);
 *                   `open`: false when another proposal was opened, or this one closed, while it was sent
 *   auth            { status: 401 | 403, during: 'facts' | 'review' | 'send' | 'landing' }  sign-in is needed: a read or the press was refused
 *   source          { state, … }  where a scope's or a map's load from a cornfield server is (engine/source.js lists the states: loading, ready, sign-in,
 *                   not-allowed, offline, server, address, version); pieces/status.js shows it and pieces/scope.js turns it into `cornAuth` and `cornError`
 *   theme           { state: 'loading' | 'ready' | 'failed' | 'none' }  the server's theme sheet (engine/theme-sheet.js, with `use-theme`; 'none': taken back out): the map reads its tokens again
 *   scope:theme     (none)  the scope's `theme` (light, dark, auto) or the mode it follows changed: the map draws again (pieces/scope.js)
 *   piece:refused   { piece, reason, message, host }  a piece that cannot have this instance (a second map in a scope); the scope says it as `cornError`
 *                   and tells `host` to ask again when the root is free
 *   attach:released (none)  the piece that had the instance's root (`attach`) gave it back
 *   announce        text  what a screen reader is told (engine/keyboard.js `announce`, which also writes it in the root's `#map-announcer`, if it has one)
 *
 *   What a piece is asked to do (`emit`ted to it):
 *   node:show-edge  { edge }  show this edge in the panel (engine/proposal.js `showEdge`)
 *   changes:show    'changes' | 'scenarios'  the review column shows that section; proposal:focus-title: the focus goes to the proposal's name
 *   whatif:clear    (none)  the edits went with a note; mockups:refresh: an approval covers the screens as they are now; whatif:edits-changed: the edits changed
 *   node:show       { node, frame }  show this node in the panel (engine/selection.js `selectNode`, once the scene is up to date); node:close: close it;
 *                   node:focus: the focus goes into the open panel (Enter on the map)
 *   layers:redraw   (none)  draw the Layers menu again (engine/layers.js: a layer, the nodes or a review changed)
 *   theme           (none)  light or dark changed: the Layers menu draws its dots again (the host says so; theme.js does on the page)
 *   view            view    the view changed ('orbit', 'dataflow', 'house'): the Layers chip dims while the data-flow view is on (view.js on the page)
 *
 *   What a piece asks of a neighbour that may not be there (`ask`: the first answer that is not `undefined`; nobody answering is a no):
 *   search:active   (none)  is a search with matches on? -> boolean (the map's N and P step through its matches then)
 *   search:step     by      step to the next (+1) or previous (-1) match -> boolean, whether there was one
 *   live:section    node    the live layer's block for the node panel -> HTML, put in the panel as it is: whoever answers escapes what it shows
 *                           (live.js does); live:hydrate (emit) el: its photos
 *   forge:can-start (none)  can a run be started from here? -> boolean; forge:start (emit) { slug, returnTo }: open the Start dialog
 *   scenario:clear  (none)  (emit) a selection ends a playing scenario
 *   proposal:effective  proposal -> proposal  the proposal the map is drawn from (the what-if editor's, with its edits in); proposal:before-close -> false keeps it open
 *   work:open-specs (none) -> true  the Work panel's Specs tab opened for a bad link's way on; map:set { nodes, edges } -> true  the page laid the map out from these
 *   changes:opened-line title -> string, changes:played-line -> string  what the review column says of an opening, and how many scenarios were played
 *   whatif:edits -> edits[], whatif:form -> { name } | null, whatif:describe -> string[]  what the decision asks of the what-if editor
 *
 *   What input.js asks of the page (requests, not news of a change; the page decides what each means):
 *   select          node    a tap on a node; `background`: a tap on the bare map; `grab`: a hand took the camera
 *
 * A module that is "on the instance" takes `inst` and reads nothing global: no shared state, no `document.getElementById`, no
 * listener on `document` or `window`, no `location`, no `history`, no fetch of a literal path (test/explorer/instance-tripwires.test.js).
 * Light and dark, and the viewer's reduced-motion setting, are read through the instance too (`inst.tokenReader()`, `inst.reducedMotion`).
 */

import { createState } from './instance-state.js';

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * @param {object} [opts]
 * @param {Document|Element|ShadowRoot|null} [opts.root] where the instance's elements are; null for an instance with no page (a test, a worker)
 * @param {string} [opts.base] the cornfield server's address; '' is the document's own origin
 * @param {typeof fetch} [opts.fetch] default: the global `fetch`, looked up at each call
 * @param {Record<string, string>} [opts.strings] the host's own words
 * @param {object} [opts.state] a state object to adopt instead of a new one (state.js hands the page's to the page instance)
 */
export function createInstance({ root: rootOpt = null, base = '', fetch: fetchOpt, strings = {}, state } = {}) {
  let root = rootOpt;
  const doc = root ? (root.nodeType === 9 ? /** @type {Document} */ (root) : root.ownerDocument) : null;
  const win = doc ? doc.defaultView : null;
  const events = new Map();
  const cleanups = [];
  const slots = new Map();
  let destroyed = false;
  const fetchImpl = fetchOpt;
  const initialRoot = root;
  let attached = null;

  const on = (name, fn) => {
    let set = events.get(name);
    if (!set) events.set(name, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  };

  /**
   * A served path made absolute against the base; anything already absolute (or no base) is returned as it was. A base with a path
   * (`https://example.com/cornfield`, a server behind a proxy's prefix) keeps it: `/topology.json` is `https://example.com/cornfield/topology.json`.
   */
  const url = (path) => {
    const p = String(path);
    if (!base || ABSOLUTE.test(p)) return p;
    const at = new URL(base);
    const prefix = at.pathname.replace(/\/+$/, '');
    return new URL(prefix && p.startsWith('/') ? prefix + p : p, at).href;
  };

  /** The element whose computed style holds the tokens: the document's own for a page, else the root itself (a shadow root's host) */
  const tokenElement = () => {
    if (!root) return null;
    if (root.nodeType === 9) return /** @type {Document} */ (root).documentElement;
    return root.nodeType === 11 ? /** @type {ShadowRoot} */ (root).host : /** @type {Element} */ (root);
  };

  // What is selected: a node and an edge, kept behind accessors on the state so that every way of changing them, an assignment included, is heard
  const theState = state || createState();
  let selNode = theState.selectedNode || null;
  let selEdge = theState.selectedEdge || null;
  // The `selection` event says each change once, against what its listeners last heard (`heard`), in order: a change made while it is
  // being said (a listener that selects) is said after every listener has heard the first, and a quiet change a later one overtook says nothing
  let heard = { node: selNode, edge: selEdge };
  const queue = [];
  let saying = false;
  const differs = (a, b) => (a.node ? a.node.id : null) !== (b.node ? b.node.id : null) || a.edge !== b.edge;
  const say = (source) => {
    queue.push(source);
    if (saying) return;
    saying = true;
    try {
      while (queue.length) {
        const why = queue.shift();
        const now = { node: selNode, edge: selEdge };
        if (destroyed || !differs(heard, now)) continue;
        const previous = heard;
        heard = now;
        inst.emit('selection', { ...now, previous, source: why });
      }
    } finally { saying = false; }
  };
  const commit = (nextNode, nextEdge, source, quiet) => {
    const previous = { node: selNode, edge: selEdge };
    selNode = nextNode || null;
    selEdge = nextEdge || null;
    const changed = differs(previous, { node: selNode, edge: selEdge });
    let said = false;
    const announce = () => { if (said) return; said = true; if (changed) say(source); };
    if (!quiet) announce();
    return { changed, previous, announce };
  };
  Object.defineProperty(theState, 'selectedNode', { enumerable: true, configurable: true, get: () => selNode, set: (v) => { commit(v, selEdge, 'state', false); } });
  Object.defineProperty(theState, 'selectedEdge', { enumerable: true, configurable: true, get: () => selEdge, set: (v) => { commit(selNode, v, 'state', false); } });

  const inst = {
    root,
    doc,
    win,
    base,
    /** The host's own words (key -> text); nothing on the map reads them yet (the pieces of step 4 will) */
    strings: { ...strings },
    state: theState,

    url,
    fetch(input, init) {
      const f = fetchImpl || globalThis.fetch;
      return f(typeof input === 'string' ? url(input) : input, init);
    },

    // -- what changed -----------------------------------------------------------------------------------------------------------
    /** Call after changing anything a picture is built from: the topology or its layout, the layers, the selection, the search, the view, a playing scenario, a proposal. Not for the camera, and not for time. */
    touchScene() {
      inst.state.sceneVersion++;
      const set = events.get('scene');
      if (set) set.forEach((fn) => fn());
    },
    /** Calls `fn` after every touchScene(): for UI that follows what the scene is built from. Returns how to stop. */
    onSceneTouch: (fn) => on('scene', fn),
    on,
    emit(name, detail) {
      const set = events.get(name);
      if (set) [...set].forEach((fn) => fn(detail));
    },
    ask(name, detail) {
      const set = events.get(name);
      if (!set) return undefined;
      for (const fn of [...set]) {
        const answer = fn(detail);
        if (answer !== undefined) return answer;
      }
      return undefined;
    },
    /**
     * Sets what is selected (a node, an edge, or neither). Fires `selection` once if the node (by id) or the edge changed, unless `quiet`:
     * then the returned change's `announce()` says it later. Plain assignments to `state.selectedNode` / `state.selectedEdge` fire it too.
     */
    setSelection: (node, edge = null, { source = 'api', quiet = false } = {}) => commit(node, edge, source, quiet),

    // -- the instance's own elements ----------------------------------------------------------------------------------------------
    /** The element with this id inside the root, or null (ids are only unique inside one root) */
    el: (id) => (root ? root.querySelector(`[id="${String(id).replace(/["\\]/g, '\\$&')}"]`) : null),
    /**
     * Where the instance's elements are, once a piece has put them somewhere of its own: a scope (pieces/scope.js) makes the instance over its own
     * element before any piece exists, and the one piece that draws the map attaches its shadow root, so `el`, `active` and the tokens are read
     * there. One root at a time: a second attach throws (the engine holds one map per instance); the release gives back the root it had.
     * @param {Document|Element|ShadowRoot} next
     * @returns {() => void} release
     */
    attach(next) {
      if (attached) throw new Error('This instance already has a map');
      attached = next;
      root = next;
      inst.root = next;
      const release = () => {
        if (attached !== next) return;
        attached = null;
        root = initialRoot;
        inst.root = initialRoot;
        inst.release(release);
        if (!destroyed) inst.emit('attach:released'); // a piece that was refused (a second map in a scope) may have it now
      };
      cleanups.push(release);
      return release;
    },
    /** The element with the focus in the root's own tree: a Document's or a shadow root's `activeElement`, or the document's when it is inside the root; else null */
    active: () => {
      if (!root || !doc) return null;
      if (root.nodeType !== 1) return root.activeElement || null; // a Document or a shadow root
      return doc.activeElement && root.contains(doc.activeElement) ? doc.activeElement : null;
    },

    // -- what the viewer prefers --------------------------------------------------------------------------------------------------
    /** A reader of the computed custom properties at the root (`(name) => value`), or null where there is no page */
    tokenReader() {
      const el = tokenElement();
      if (!el || !win || !win.getComputedStyle) return null;
      const style = win.getComputedStyle(el);
      return (name) => style.getPropertyValue(name);
    },
    /** The element tokens are read from (attributes on it, `data-theme`, say, change them) */
    tokenElement,
    /** prefers-reduced-motion, as it was when the instance was made */
    reducedMotion: !!(win && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches),
    /** The device pixel ratio now */
    dpr: () => (win && win.devicePixelRatio) || 1,
    /** Whether the tab is hidden */
    hidden: () => !!(doc && (doc.hidden || doc.visibilityState === 'hidden')),
    /** Calls `fn` when the tab is shown again; the one document-level fact an instance needs. Removed by destroy(). */
    onShown(fn) {
      if (!doc) return () => {};
      return inst.listen(doc, 'visibilitychange', () => { if (!inst.hidden()) fn(); });
    },
    /** Whether the browser says it has no network (`navigator.onLine === false`) */
    offline: () => !!(win && win.navigator && win.navigator.onLine === false),
    /** Calls `fn(offline)` when the browser goes offline (true) or comes back (false). Removed by destroy(). */
    onNetwork(fn) {
      if (!win) return () => {};
      const offs = [inst.listen(win, 'offline', () => fn(true)), inst.listen(win, 'online', () => fn(false))];
      return () => offs.forEach((off) => off());
    },
    /** Calls `fn()` when the window gets the focus again. Removed by destroy(). */
    onWindowFocus: (fn) => (win ? inst.listen(win, 'focus', () => fn()) : () => {}),
    /** Calls `fn()` when the page is going away (a tab closed, a reload). Removed by destroy(). */
    onPageHide: (fn) => (win ? inst.listen(win, 'pagehide', () => fn()) : () => {}),
    /** Calls `fn()` when the tab is hidden. Removed by destroy(). */
    onHide(fn) {
      if (!doc) return () => {};
      return inst.listen(doc, 'visibilitychange', () => { if (inst.hidden()) fn(); });
    },
    /** A small key-value store (the browser's localStorage, which may be blocked): what a viewer's own choices are kept in */
    store: {
      get(key) { try { return win && win.localStorage ? win.localStorage.getItem(key) : null; } catch { return null; } },
      set(key, value) { try { if (win && win.localStorage) win.localStorage.setItem(key, value); } catch { /* blocked: holds for this visit */ } },
      remove(key) { try { if (win && win.localStorage) win.localStorage.removeItem(key); } catch { /* nothing to clear */ } },
    },

    // -- an end to everything -----------------------------------------------------------------------------------------------------
    /** Adds `listener` to `target`; destroy() removes it. Returns how to remove it now. */
    listen(target, type, listener, options) {
      target.addEventListener(type, listener, options);
      const off = () => {
        target.removeEventListener(type, listener, options);
        inst.release(off);
      };
      cleanups.push(off);
      return off;
    },
    /** Runs `fn` when the instance is destroyed (an observer's disconnect, a timer's clear, a renderer's release); returns `fn` */
    own(fn) {
      cleanups.push(fn);
      return fn;
    },
    /** Takes back a clean-up given to `own` (or the one `listen` returned) that its owner has run itself: a piece that ends before the instance does */
    release(fn) {
      const at = cleanups.lastIndexOf(fn);
      if (at >= 0) cleanups.splice(at, 1);
    },
    /** What a module keeps for this instance: `make(inst)` the first time, the same value after */
    slot(key, make) {
      if (!slots.has(key)) slots.set(key, make(inst));
      return slots.get(key);
    },
    /** Whether `destroy()` has run: an answer that arrives after it (a fetch in flight) is not wanted */
    get ended() { return destroyed; },
    /** Removes every listener, observer and timer the instance's modules set up and releases the renderer's GPU context. Safe to call twice. */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      while (cleanups.length) {
        try { cleanups.pop()(); } catch (err) { console.error('An instance clean-up failed', err); }
      }
      events.clear();
      slots.clear();
    },

    // -- the map as the state holds it ----------------------------------------------------------------------------------------------
    /** The edges the current view draws and the selection walks */
    viewEdges: () => (inst.state.view === 'dataflow' && inst.state.flow ? inst.state.flow.edges : inst.state.edges),
  };
  return inst;
}
