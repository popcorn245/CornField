/**
 * @module explorer/engine/selection
 *
 * Choosing a node, and choosing none, on an instance (spec 0008 D5 and D6; the rules of what a selection lights are in selection-model.js).
 * Every way of changing the selection goes through here or through `state.selectedNode` / `state.selectedEdge` (a plain assignment), and the
 * instance tells it once: the `selection` event (instance.js). The node panel (pieces/node-panel.js) follows `node:show` and `node:close`.
 *
 *   selectNode(inst, node, { frame, source })  lights what is one edge from `node`, tells the panel, and when `frame` is set (a search, a list, a
 *                                              link, the keyboard: not a click on the map) flies the camera to the node and what it lights
 *   clearSelection(inst, { source })           no node, no edge; the panel closes
 */
import { dismissHint } from './hint.js';
import { frameSelection } from '../selection-view.js';

/**
 * Selects a node: lights what is one edge from it on the map and has the panel show it. `frame` is for a selection that did not come
 * from a click on the map: the camera then flies to the node and what it lights (selection-model.js); a click leaves the camera where it is
 * (spec 0008 D6). `source` says who chose, for the `selection` event ('tap', 'keyboard', 'search', 'link', 'api').
 */
export function selectNode(inst, node, { frame = false, source = 'api' } = {}) {
  if (!node) return;
  const { state } = inst;
  inst.emit('scenario:clear'); // a playing scenario ends (scenario-ui.js)
  dismissHint(inst); // a node has been picked: the hint's job is done for this session
  if (!state.selectedNode || state.selectedNode.id !== node.id) state.selectedKind = null; // a kind chosen for one node means nothing for the next
  const change = inst.setSelection(node, null, { source, quiet: true });
  inst.touchScene();
  inst.map.render();
  change.announce(); // the scene is up to date when the instance is told
  inst.emit('node:show', { node, frame }); // the panel fills and opens, so what it covers is known below
  if (frame) frameSelection(inst);
}

/** Ends the selection: no node, no edge, the panel closes */
export function clearSelection(inst, { source = 'api' } = {}) {
  inst.emit('scenario:clear');
  const change = inst.setSelection(null, null, { source, quiet: true });
  inst.touchScene();
  inst.map.render();
  inst.emit('node:close');
  change.announce();
}
