/**
 * @module explorer/engine/keyboard
 *
 * The map by keyboard, and what a screen reader hears (MAP-02), on an instance. keyboard-model.js decides what a key means and the words;
 * this module does it:
 *
 *   - the map canvas is focusable (`tabindex="0"`, `role="application"`, its keys in `#map-keys-help`): the arrow keys pan, + and - zoom about
 *     the middle, 0 fits, N and P (or ] and [) step through the visible nodes in reading order and select each, centred, Home and End the first
 *     and the last, Enter goes into the panel, Escape closes it, and in Freeform Alt+arrow moves the selected node. The keys are the canvas's:
 *     they act only while the canvas has the focus, so another instance on the page is not moved;
 *   - `#map-announcer` (a polite live region) says where the keyboard landed: the node, its type, its connections, its place; the zoom; a
 *     search's hit. `announce(inst, text)` also tells the instance (`announce`), for a host that keeps its live region elsewhere;
 *   - with a search on, N and P step through its matches: the search piece answers `search:active` and `search:step` (pieces/search.js).
 *
 * The keys of the node panel (Escape inside it), of the Layers menu (Escape) and of the search (`/`) belong to those pieces. A shortcut acts
 * only while the focus is inside the instance's root; on the page the root is the document. explorer/keyboard.js keeps the old names for the page.
 */

import { zoomAbout } from '../camera.js';
import { selectNode, clearSelection } from './selection.js';
import { saveFreeformPositions } from './layout.js';
import * as K from '../keyboard-model.js';
import { frameSelection, litNodes } from '../selection-view.js';

/** Tells a screen reader `text` (politely: after what it is reading). The same words twice are said twice. */
export function announce(inst, text) {
  const mem = inst.slot('announce', () => {
    const m = { timer: null };
    inst.own(() => clearTimeout(m.timer));
    return m;
  });
  inst.emit('announce', text);
  const el = inst.el('map-announcer');
  if (!el) return;
  el.textContent = '';
  clearTimeout(mem.timer);
  // a fresh text node a moment later is what makes a live region speak again
  mem.timer = setTimeout(() => { el.textContent = text; }, 30);
}

/** The visible nodes, in the order the keys step through them */
const stepOrder = (inst) => K.readingOrder(inst.state.nodes.filter((n) => inst.map.isNodeVisible(n)));

/** The camera that puts `node` in the middle of the part of the map not under the panels or a phone's sheets, at `zoom` (the current one by default) */
export function centreTarget(inst, node, zoom = inst.state.camera.zoom) {
  const { width, height } = inst.state;
  const visibleHeight = Math.max(160, height - (inst.state.coveredBottom || 0));
  const panel = inst.el('spec-drawer');
  const visibleWidth = width >= 768 && panel && panel.classList.contains('drawer-open') ? Math.max(160, width - (panel.offsetWidth || 480)) : width;
  // The issues and PRs panel slides in from the left (forge-panel.js)
  const forge = inst.el('forge-panel');
  const left = width >= 768 && forge && forge.classList.contains('forge-open') ? Math.min(forge.offsetWidth || 400, visibleWidth - 160) : 0;
  return { x: left + (visibleWidth - left) / 2 - node.x * zoom, y: visibleHeight / 2 - node.y * zoom, zoom };
}

/** Moves the camera so `node` is in the middle of the part of the map not under the panels or a phone's sheets */
export function centreOn(inst, node) {
  Object.assign(inst.state.camera, centreTarget(inst, node));
  inst.map.render();
}

function land(inst, node, order) {
  if (!node) { announce(inst, 'No nodes are shown. Turn a layer on in the Layers menu.'); return; }
  selectNode(inst, node, { frame: true, source: 'keyboard' }); // the keyboard's selection frames the node and what it lights (spec 0008 D6)
  announce(inst, K.describeNode(node, order.length, order.indexOf(node)));
}

/** "Frame them" and the `F` key: the camera goes to the selected node and what it lights, and a screen reader is told how many that is */
export function frameThem(inst) {
  const { state } = inst;
  if (!state.selectedNode) return;
  const target = frameSelection(inst);
  if (!target) return;
  const connected = Math.max(0, litNodes(inst).length - 1);
  announce(inst, target.framed ? `Framed ${state.selectedNode.label} and ${connected} connected` : `${state.selectedNode.label} centred: ${connected} connected, too spread out to frame together`);
}

function moveSelected(inst, dx, dy) {
  const { state } = inst;
  const node = state.selectedNode;
  if (!node) return;
  node.x += dx;
  node.y += dy;
  state.freeformPositions[node.id] = { x: node.x, y: node.y };
  inst.touchScene();
  saveFreeformPositions(inst);
  inst.map.render();
  announce(inst, `Moved ${node.label}`);
}

function onMapKey(inst, e) {
  const { state, map } = inst;
  if (e.target !== state.canvas || e.defaultPrevented) return;
  const action = K.mapKeyAction(e.key, {
    shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey,
    scenario: !!state.scenario, freeform: state.isFreeform && state.view === 'orbit', selected: !!state.selectedNode,
  });
  if (!action) return;
  e.preventDefault();
  const { camera, width, height } = state;
  switch (action.type) {
    case 'pan':
      camera.x += action.dx;
      camera.y += action.dy;
      map.render();
      break;
    case 'zoom':
      Object.assign(camera, zoomAbout(camera, action.factor, width / 2, height / 2, map.getMinZoom()));
      map.render();
      announce(inst, K.zoomWords(camera.zoom));
      break;
    case 'fit':
      map.fitGraphToViewport(map.fitPadding());
      announce(inst, `The whole map. ${K.zoomWords(camera.zoom)}`);
      break;
    case 'step': {
      if (inst.ask('search:active') && inst.ask('search:step', action.by)) break; // with a search on, N and P walk its matches (pieces/search.js)
      const order = stepOrder(inst);
      land(inst, K.stepFrom(order, state.selectedNode && state.selectedNode.id, action.by), order);
      break;
    }
    case 'first': case 'last': {
      const order = stepOrder(inst);
      land(inst, action.type === 'first' ? order[0] : order[order.length - 1], order);
      break;
    }
    case 'frame':
      frameThem(inst);
      break;
    case 'open':
      inst.emit('node:focus'); // into the open panel: its title takes the focus, so a screen reader starts there and Tab goes on into it
      break;
    case 'close':
      clearSelection(inst, { source: 'keyboard' });
      announce(inst, 'Panel closed');
      break;
    case 'move':
      moveSelected(inst, action.dx, action.dy);
      break;
    default:
  }
}

/** Wires the map's keys (once the canvas is on the state); a second call does nothing until `resetKeyboard` */
export function initKeyboard(inst) {
  const mem = inst.slot('keyboard', () => ({ off: null }));
  if (mem.off || !inst.state.canvas) return;
  mem.off = inst.listen(inst.state.canvas, 'keydown', (e) => onMapKey(inst, e));
}

/** For tests: wire again on a fresh page */
export function resetKeyboard(inst) {
  const mem = inst.slot('keyboard', () => ({ off: null }));
  if (mem.off) mem.off();
  mem.off = null;
}
