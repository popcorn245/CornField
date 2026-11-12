/**
 * @module explorer/instance
 *
 * The engine as something a page can make more than one of (spec 0011 D2). `createInstance` returns the object that holds what
 * `state.js` held when the explorer was one program per document, and the things a piece of the explorer may reach:
 *
 *   inst.root       where the instance's elements are: a Document (cornfield's page), or an element or shadow root (a component)
 *   inst.state      the explorer's state (instance-state.js): the topology, the layers, the camera, the selection, the view
 *   inst.base       the address of the cornfield server the instance talks to ('' = the page's own origin)
 *   inst.fetch      `fetch` bound to that base; inst.url(path) is a served path made absolute against it
 *   inst.strings    the words the host overrides (key -> text)
 *   inst.touchScene / onSceneTouch   a change the picture is built from, and who follows it
 *   inst.on / emit  what a piece tells its neighbours, per instance. input.js emits `select` (a tap on a node: the page decides what selecting
 *                   means), `background` (a tap on the bare map) and `grab` (a hand took the camera). These are requests, not news of a change:
 *                   a selection made by keyboard or search emits nothing here
 *   inst.el         an element of the instance by id, found inside its root and never by document id
 *   inst.listen     a listener that `destroy()` removes; inst.own: any other clean-up `destroy()` runs
 *   inst.slot       what a module keeps for this instance (its map style), made on first use
 *   inst.map        the map (engine/render.js createMap sets it)
 *   inst.destroy()  runs every clean-up, so nothing the instance set up outlives it
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
export function createInstance({ root = null, base = '', fetch: fetchOpt, strings = {}, state } = {}) {
  const doc = root ? (root.nodeType === 9 ? /** @type {Document} */ (root) : root.ownerDocument) : null;
  const win = doc ? doc.defaultView : null;
  const events = new Map();
  const cleanups = [];
  const slots = new Map();
  let destroyed = false;
  const fetchImpl = fetchOpt;

  const on = (name, fn) => {
    let set = events.get(name);
    if (!set) events.set(name, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  };

  /** A served path made absolute against the base; anything already absolute (or no base) is returned as it was */
  const url = (path) => {
    const p = String(path);
    if (!base || ABSOLUTE.test(p)) return p;
    return new URL(p, base).href;
  };

  /** The element whose computed style holds the tokens: the document's own for a page, else the root itself (a shadow root's host) */
  const tokenElement = () => {
    if (!root) return null;
    if (root.nodeType === 9) return /** @type {Document} */ (root).documentElement;
    return root.nodeType === 11 ? /** @type {ShadowRoot} */ (root).host : /** @type {Element} */ (root);
  };

  const inst = {
    root,
    doc,
    win,
    base,
    /** The host's own words (key -> text); nothing on the map reads them yet (the pieces of step 4 will) */
    strings: { ...strings },
    state: state || createState(),

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

    // -- the instance's own elements ----------------------------------------------------------------------------------------------
    /** The element with this id inside the root, or null (ids are only unique inside one root) */
    el: (id) => (root ? root.querySelector(`[id="${String(id).replace(/["\\]/g, '\\$&')}"]`) : null),

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
    hidden: () => !!(doc && doc.hidden),
    /** Calls `fn` when the tab is shown again; the one document-level fact an instance needs. Removed by destroy(). */
    onShown(fn) {
      if (!doc) return () => {};
      return inst.listen(doc, 'visibilitychange', () => { if (!doc.hidden) fn(); });
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
      const off = () => target.removeEventListener(type, listener, options);
      cleanups.push(off);
      return off;
    },
    /** Runs `fn` when the instance is destroyed (an observer's disconnect, a timer's clear, a renderer's release); returns `fn` */
    own(fn) {
      cleanups.push(fn);
      return fn;
    },
    /** What a module keeps for this instance: `make(inst)` the first time, the same value after */
    slot(key, make) {
      if (!slots.has(key)) slots.set(key, make(inst));
      return slots.get(key);
    },
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
