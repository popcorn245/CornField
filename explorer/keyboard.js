/**
 * @module explorer/keyboard
 *
 * The map by keyboard, and what a screen reader hears (MAP-02). keyboard-model.js decides what a key means and
 * the words; this module does it on the page:
 *
 *   - the map canvas is focusable (`tabindex="0"`, `role="application"`, its keys in `#map-keys-help`): the arrow
 *     keys pan, + and - zoom about the middle, 0 fits, N and P (or ] and [) step through the visible nodes in
 *     reading order and select each, centred, Home and End the first and the last, Enter goes into the panel,
 *     Escape closes it, and in Freeform Alt+arrow moves the selected node;
 *   - `#map-announcer` (a polite live region) says where the keyboard landed: the node, its type, its
 *     connections, its place; the zoom; a search's hit;
 *   - Enter in the search box selects the best match and goes on to the next (search.js); with a search on, N and P step through its matches;
 *   - the panel: Escape inside it closes it and gives the focus back to the map; it is `inert` while closed
 *     (panels.js), so its buttons are never tabbed to off screen;
 *   - the Layers menu says whether it is open (`aria-expanded`), and Escape closes it, back on its button;
 *   - `/` goes to the search (anywhere but in a field): the box on a desktop, the search bar on a phone.
 */

import { state, touchScene } from './state.js';
import { render, fitGraphToViewport, fitPadding, isNodeVisible, getMinZoom } from './render.js';
import { zoomAbout } from './camera.js';
import { selectNode, closeDrawer } from './panels.js';
import { saveFreeformPositions } from './layout.js';
import { closeLegendMenu } from './layers.js';
import * as K from './keyboard-model.js';
import { searchActive, stepMatch } from './search.js';
import { frameSelection, litNodes } from './selection-view.js';

const $ = (id) => document.getElementById(id);
let wired = false;
let announceTimer = null;

/** Tells a screen reader `text` (politely: after what it is reading). The same words twice are said twice. */
export function announce(text) {
  const el = $('map-announcer');
  if (!el) return;
  el.textContent = '';
  clearTimeout(announceTimer);
  // a fresh text node a moment later is what makes a live region speak again
  announceTimer = setTimeout(() => { el.textContent = text; }, 30);
}

/** The visible nodes, in the order the keys step through them */
const stepOrder = () => K.readingOrder(state.nodes.filter((n) => isNodeVisible(n)));

/** The camera that puts `node` in the middle of the part of the map not under the panels or a phone's sheets, at `zoom` (the current one by default) */
export function centreTarget(node, zoom = state.camera.zoom) {
  const { width, height } = state;
  const visibleHeight = Math.max(160, height - (state.coveredBottom || 0));
  const panel = $('spec-drawer');
  const visibleWidth = width >= 768 && panel && panel.classList.contains('drawer-open') ? Math.max(160, width - (panel.offsetWidth || 480)) : width;
  // The issues and PRs panel slides in from the left (forge-panel.js)
  const forge = $('forge-panel');
  const left = width >= 768 && forge && forge.classList.contains('forge-open') ? Math.min(forge.offsetWidth || 400, visibleWidth - 160) : 0;
  return { x: left + (visibleWidth - left) / 2 - node.x * zoom, y: visibleHeight / 2 - node.y * zoom, zoom };
}

/** Moves the camera so `node` is in the middle of the part of the map not under the panels or a phone's sheets */
export function centreOn(node) {
  Object.assign(state.camera, centreTarget(node));
  render();
}

function land(node, order) {
  if (!node) { announce('No nodes are shown. Turn a layer on in the Layers menu.'); return; }
  selectNode(node, { frame: true }); // the keyboard's selection frames the node and what it lights (spec 0008 D6)
  announce(K.describeNode(node, order.length, order.indexOf(node)));
}

/** "Frame them" and the `F` key: the camera goes to the selected node and what it lights, and a screen reader is told how many that is */
export function frameThem() {
  if (!state.selectedNode) return;
  const target = frameSelection();
  if (!target) return;
  const connected = Math.max(0, litNodes().length - 1);
  announce(target.framed ? `Framed ${state.selectedNode.label} and ${connected} connected` : `${state.selectedNode.label} centred: ${connected} connected, too spread out to frame together`);
}

/** Into the open panel: its title takes the focus, so a screen reader starts there and Tab goes on into it */
function focusPanel() {
  const title = $('drawer-title');
  if (!title) return;
  title.setAttribute('tabindex', '-1');
  title.focus();
}

function moveSelected(dx, dy) {
  const node = state.selectedNode;
  if (!node) return;
  node.x += dx;
  node.y += dy;
  state.freeformPositions[node.id] = { x: node.x, y: node.y };
  touchScene();
  saveFreeformPositions();
  render();
  announce(`Moved ${node.label}`);
}

function onMapKey(e) {
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
      render();
      break;
    case 'zoom':
      Object.assign(camera, zoomAbout(camera, action.factor, width / 2, height / 2, getMinZoom()));
      render();
      announce(K.zoomWords(camera.zoom));
      break;
    case 'fit':
      fitGraphToViewport(fitPadding());
      announce(`The whole map. ${K.zoomWords(camera.zoom)}`);
      break;
    case 'step': {
      if (searchActive() && stepMatch(action.by)) break; // with a search on, N and P walk its matches (search.js)
      const order = stepOrder();
      land(K.stepFrom(order, state.selectedNode && state.selectedNode.id, action.by), order);
      break;
    }
    case 'first': case 'last': {
      const order = stepOrder();
      land(action.type === 'first' ? order[0] : order[order.length - 1], order);
      break;
    }
    case 'frame':
      frameThem();
      break;
    case 'open':
      focusPanel();
      break;
    case 'close':
      closeDrawer();
      announce('Panel closed');
      break;
    case 'move':
      moveSelected(action.dx, action.dy);
      break;
    default:
  }
}

/** Escape anywhere in the panel closes it, and the map has the focus again */
function onPanelKey(e) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (e.target.closest && e.target.closest('select, input, textarea')) return; // a field's own Escape first
  e.preventDefault();
  closeDrawer();
  if (state.canvas) state.canvas.focus();
  announce('Panel closed');
}

/** The panel's ✕: the focus would be left on a hidden button, so it goes back to the map */
function onPanelClick(e) {
  const close = e.target.closest && e.target.closest('[data-action="close-drawer"]');
  if (close && state.canvas) setTimeout(() => state.canvas.focus(), 0);
}

/** Whether the key went to something that takes typing */
const typing = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** `/` goes to the search box, or to the phone's search bar where the box is not shown (opening the bar if it is shut) */
function goToSearch() {
  const input = $('node-search');
  const shown = input && input.closest('.hx-search') && window.getComputedStyle(input.closest('.hx-search')).display !== 'none';
  if (shown) { input.focus(); input.select(); return; }
  const bar = $('mobile-search-bar');
  if (bar && !bar.hidden) { $('mobile-node-search').focus(); return; }
  const open = $('mobile-search-toggle');
  if (open) open.click();
}

/** Escape with the Layers menu open closes it, and its button has the focus again */
function onDocumentKey(e) {
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target) && !document.querySelector('[data-corn="dialog-scrim"]:not([hidden]), .hx-mockup-dialog')) {
    e.preventDefault();
    goToSearch();
    return;
  }
  if (e.key !== 'Escape') return;
  const menu = $('legend-dropdown');
  if (!menu || menu.hidden) return;
  closeLegendMenu();
  const btn = $('legend-toggle-btn');
  if (btn) btn.focus();
}

/** Wires the keys (main.js, once the canvas is on `state`) */
export function initKeyboard() {
  if (wired || !state.canvas) return;
  wired = true;
  state.canvas.addEventListener('keydown', onMapKey);
  const drawer = $('spec-drawer');
  if (drawer) {
    drawer.addEventListener('keydown', onPanelKey);
    drawer.addEventListener('click', onPanelClick);
  }
  document.addEventListener('keydown', onDocumentKey);
}

/** For tests: wire again on a fresh page */
export function resetKeyboardForTests() {
  if (wired && state.canvas) state.canvas.removeEventListener('keydown', onMapKey);
  document.removeEventListener('keydown', onDocumentKey);
  wired = false;
}
