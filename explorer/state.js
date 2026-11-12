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
 *                     `startPageInstance()` is page.js's one call that finishes it
 *
 * To convert a module: take `inst` as an argument (or from the piece that mounts it), read `inst.state`, call `inst.touchScene()`, find elements
 * with `inst.el(id)`, listen with `inst.listen(root, ...)`, and drop the import of this file; add it to the converted list of
 * test/explorer/instance-tripwires.test.js. When no module imports a bridge or this file any more, delete them.
 */

import { escapeHtml } from '../core/text.js';
import { createInstance } from './instance.js';
import { createState } from './instance-state.js';

/** The page's state: one object, made at import time so a module that reads it while it loads finds it filled */
export const state = createState();

let page = null;

/**
 * The page's instance. It is made the first time anything asks, because modules that are not yet converted register with it while they load
 * (layers.js follows the map's style), before page.js has run. A test that drives one module on its own gets the same plain instance over the
 * global document, if there is one, holding the same `state`.
 */
export function pageInstance() {
  if (!page) page = createInstance({ state, root: typeof document !== 'undefined' ? document : null });
  return page;
}

/**
 * Called once by page.js: the instance of this document, with the base address, the fetch and the strings the page gives it. There is only ever one
 * (`pageInstance()` above): this finishes it, and does not make a second.
 */
export function startPageInstance({ root, base, fetch: fetchImpl, strings }) {
  const inst = pageInstance();
  if (root !== inst.root) throw new Error('The page instance is over the document it was first asked for');
  inst.configure({ base, fetch: fetchImpl, strings });
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
