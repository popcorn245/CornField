/**
 * @module explorer/engine/roots
 *
 * More than one root for one instance (spec 0011 D2, D4, D5). Inside a `<corn-scope>` each leaf piece (the map, the node panel, the Layers menu, the
 * search) has a shadow root of its own, and they share one instance. The instance has one primary root (the map's, once it attached it: `inst.el` looks
 * there); every other piece's root joins it here, so that what is the instance's by root is the instance's in all of them:
 *
 *   joinRoot(inst, node)                    the root `node` is in belongs to the instance, until the returned function is called or the instance ends:
 *                                           its focus (`inst.active()`) and its keys (`listenRoots`) are the instance's. A root the instance covers already
 *                                           (cornfield's document, the review's one root) is not added again
 *   listenRoots(inst, type, fn, opts)       a listener on every root of the instance, those that join later too; an event that reaches two of them (a root
 *                                           inside another) is handled once. Removed by `destroy()`
 *   onPageClick(inst, fn, { capture })      a click anywhere in the page, outside every root too, heard first (capture, the default) or last: what closes a
 *                                           menu a click beside it in the host's page lands on. The event's `composedPath()` says what was in the way, but
 *                                           not inside a host's closed shadow root: a piece asks its own element too (pieces/layers.js)
 *
 * A piece owns its own elements and never looks for a neighbour's by id: it reaches it by an event or an `ask` on the instance (instance.js lists them).
 * This module is the sister of instance.js: it is where the instance meets the page's own roots, so it is exempt from the same tripwire rules.
 */

/** @param {ReturnType<typeof import('../instance.js').createInstance>} inst */
const rootsOf = (inst) => [inst.root, ...inst.extraRoots].filter(Boolean);

/**
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst
 * @param {Node} node
 * @returns {() => void} how to leave
 */
export function joinRoot(inst, node) {
  if (!node || inst.ended) return () => {};
  const tree = typeof node.getRootNode === 'function' ? node.getRootNode() : node;
  if (!tree || rootsOf(inst).some((r) => r === tree || r === node)) return () => {};
  inst.extraRoots.add(tree);
  inst.emit('root:changed');
  const off = () => { if (inst.extraRoots.delete(tree)) inst.emit('root:changed'); inst.release(off); };
  inst.own(off);
  return off;
}

/**
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst
 * @param {string} type
 * @param {(e: Event) => void} fn
 * @param {boolean | AddEventListenerOptions} [opts]
 * @returns {() => void}
 */
export function listenRoots(inst, type, fn, opts) {
  const seen = new WeakSet();
  const handler = (e) => { if (seen.has(e)) return; seen.add(e); fn(e); };
  const offs = new Map();
  const sync = () => {
    const now = new Set(rootsOf(inst));
    for (const [r, off] of [...offs]) if (!now.has(r)) { off(); offs.delete(r); }
    for (const r of now) if (!offs.has(r)) offs.set(r, inst.listen(r, type, handler, opts));
  };
  sync();
  const stop = inst.on('root:changed', sync);
  const off = () => { stop(); for (const o of offs.values()) o(); offs.clear(); inst.release(off); };
  inst.own(off);
  return off;
}

/**
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst
 * @param {(e: MouseEvent) => void} fn
 * @param {{ capture?: boolean }} [opts] heard first (the default), or last, once the click has reached everything in its way
 * @returns {() => void}
 */
export function onPageClick(inst, fn, { capture = true } = {}) {
  return inst.doc ? inst.listen(inst.doc, 'click', (e) => fn(e), capture) : () => {};
}
