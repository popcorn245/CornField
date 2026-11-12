/**
 * @module explorer/state
 *
 * The hand-over from the one shared state to instances (spec 0011 D2). The explorer used to be one program per document with one shared,
 * mutable `state`; it now runs as an instance (instance.js), and cornfield's page makes exactly one (page.js). The modules that are on an
 * instance take it as an argument and import nothing from here. The ones that are not yet keep importing this file and work as they did:
 *
 *   `state`           the page instance's state object (the same object: `pageInstance().state === state`)
 *   `touchScene`, `onSceneTouch`, `viewEdges`, `nodeById`, `nameOf`   the page instance's, under their old names
 *   `pageInstance()`  the page's instance, for a module that is being converted (or a bridge, explorer/render.js, map-style.js, layout.js);
 *                     `startPageInstance()` is page.js's one call that claims it
 *
 * To convert a module: take `inst` as an argument (or from the piece that mounts it), read `inst.state`, call `inst.touchScene()`, find elements
 * with `inst.el(id)`, listen with `inst.listen(root, ...)`, and drop the import of this file; add it to the converted list of
 * test/explorer/instance-tripwires.test.js. When no module imports a bridge or this file any more, delete them.
 */

import { escapeHtml } from '../core/text.js';
import { createInstance } from './instance.js';
import { createState } from './instance-state.js';
import { pageStrings } from './strings.js';

/** The page's state: one object, made at import time so a module that reads it while it loads finds it filled */
export const state = createState();

let page = null;

/**
 * The page's instance. It is made the first time anything asks, because modules that are not yet converted register with it while they load
 * (layers.js follows the map's style), before page.js has run. A test that drives one module on its own gets the same plain instance over the
 * global document, if there is one, holding the same `state`.
 */
export function pageInstance() {
  if (!page) {
    page = createInstance({ state, root: typeof document !== 'undefined' ? document : null });
    page.strings = pageStrings; // the page's words are the bridge's (strings.js), one object for the modules on an instance and the ones not yet
  }
  return page;
}

/**
 * Called once by page.js: the instance of this document. There is only ever one (`pageInstance()` above), made with the defaults cornfield's page
 * wants (its own origin, the global fetch, no strings of a host's); this hands it over, and does not make a second.
 */
export function startPageInstance({ root }) {
  const inst = pageInstance();
  if (root !== inst.root) throw new Error('The page instance is over the document it was first asked for');
  return inst;
}

export const touchScene = () => pageInstance().touchScene();
/** Calls `fn` after every touchScene(): for UI that follows what the scene is built from (the scenario list follows `state.proposal`). Returns how to stop. */
export const onSceneTouch = (fn) => pageInstance().onSceneTouch(fn);

/** The edges the current view draws and the selection walks */
export function viewEdges() {
  return state.view === 'dataflow' && state.flow ? state.flow.edges : state.edges;
}

export const nodeById = (id) => state.nodes.find((n) => n.id === id);
export const nameOf = (id) => (nodeById(id) || { label: id }).label;

export const escHtml = escapeHtml;
