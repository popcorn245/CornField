/**
 * @module explorer/selection-view
 *
 * The page side of a selection's reach (spec 0008 D5 and D6; the rules are in selection-model.js), on an instance: which nodes the selection
 * lights, how many of them are off screen, and the camera that frames them. "Frame them" in the node panel and the `F` key call
 * `frameSelection`; a selection that comes from search, a list, a link or the keyboard calls it too (engine/selection.js), and a click on the map never does.
 */
import { visibleMapRect } from './engine/sheets.js';
import { flyTo } from './engine/fly.js';
import { countOffScreen, selectionCamera } from './selection-model.js';

/** The scene's nodes the selection lights (the selected node included), or [] with no selection */
export function litNodes(inst) {
  if (!inst.state.selectedNode || inst.state.scenario) return [];
  return inst.map.getScene().nodes.filter((n) => n.connected);
}

/** How many nodes the selection lights, and how many of those are outside the part of the map nothing covers */
export function reach(inst) {
  const { state } = inst;
  if (!state.selectedNode) return { connected: 0, off: 0 };
  const others = litNodes(inst).filter((n) => n.id !== state.selectedNode.id); // the selected node is the one the reader is on
  return { connected: others.length, off: others.length ? countOffScreen(others, state.camera, visibleMapRect(inst)) : 0 };
}

/** Flies the camera to the selection and what it lights; returns the target, or null with no selection */
export function frameSelection(inst) {
  const node = inst.state.selectedNode;
  if (!node) return null;
  const lit = litNodes(inst);
  const target = selectionCamera(node, lit, visibleMapRect(inst), { padding: inst.map.fitPadding() });
  flyTo(inst, { x: target.x, y: target.y, zoom: target.zoom });
  return target;
}
