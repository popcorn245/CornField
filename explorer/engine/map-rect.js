/**
 * @module explorer/engine/map-rect
 *
 * The part of the map that nothing covers, and whether the instance is laid out as a phone (spec 0012, TOPO-18; spec 0011 D2): what a map
 * frames a node into (selection-view.js) and what the sheets measure (engine/sheets.js, which re-exports all of this for the page and the
 * pieces). The instance's sheets' slot is made here, so the two share it. It is a module of its own so that a map alone (`<corn-map>`) does
 * not carry the sheets themselves: only a review, a node panel or the page registers one (the components' size budget, spec 0011 D11).
 */

import { createSheetModel } from '../sheet-model.js';
import { freeRect } from '../camera.js';

/** The width below which the sheets apply (matches the CSS) */
export const PHONE_QUERY = '(max-width: 767px)';

/** What the instance keeps of its sheets */
export function sheetsOf(inst) {
  return inst.slot('sheets', () => ({
    model: createSheetModel(),
    elements: new Map(), // id -> the sheet's element
    options: new Map(), // id -> { stub?: () => { title: string, badge?: string, label?: string }, away?: () => void } what the sheet's owner gave it
    offs: new Map(), // id -> how to remove the listeners bound on the sheet and its handle
    away: new Set(), // sheets displaced by the other of their group: open on the page, hidden until opened again
    listeners: new Set(),
    dock: null,
    box: null, // the element whose width says phone, instead of the window's (setPhoneBox)
    lastCovered: 0,
    observers: [],
    wiredDock: null,
    documentWired: false,
  }));
}

/** The width of a box below which it is a phone's (the CSS's `@container corn-box (max-width: 767px)`) */
const PHONE_WIDTH = 768;

/**
 * Whether the instance is laid out as a phone: the window's width on cornfield's page (PHONE_QUERY), or, where the instance has a box of its own
 * (`setPhoneBox`: the one-tag review in another app's page), that box's width, which is what the stylesheets' container queries ask
 */
export const isPhone = (inst) => {
  const { box } = sheetsOf(inst);
  if (box) return box.isConnected && box.clientWidth > 0 && box.clientWidth < PHONE_WIDTH;
  return !!(inst.win && typeof inst.win.matchMedia === 'function' && inst.win.matchMedia(PHONE_QUERY).matches);
};

/** The element the dock sits in (the map's stage), or the canvas's parent */
export const stageOf = (inst, S) => (S.dock && S.dock.parentElement) || (inst.state.canvas ? inst.state.canvas.parentElement : null);

/**
 * The height of the map the sheets hide, in px: the dock's height on a phone, 0 anywhere else.
 * Also written to `state.coveredBottom` and to `--hx-covered` on the stage. Without a dock on the
 * page it returns what `state.coveredBottom` holds.
 */
export function measureCovered(inst) {
  const S = sheetsOf(inst);
  const { state } = inst;
  if (!S.dock || !S.dock.isConnected) return state.coveredBottom || 0;
  const covered = isPhone(inst) ? Math.round(S.dock.offsetHeight || 0) : 0;
  state.coveredBottom = covered;
  const stage = stageOf(inst, S);
  if (stage) stage.style.setProperty('--hx-covered', `${covered}px`);
  if (covered !== S.lastCovered) {
    S.lastCovered = covered;
    S.listeners.forEach((fn) => fn());
  }
  return covered;
}

/**
 * The part of the map nothing covers, in the canvas's own CSS px: what the camera should frame a node into.
 * On a phone the dock's sheets cover the bottom; from 768px the proposal bar covers the top (and the change list it grows to hold),
 * the node panel the right, the Work panel and the review column the left and the scenario player the bottom. Without a layout (no page) it is the whole canvas.
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function visibleMapRect(inst) {
  const { state } = inst;
  const covers = { top: 0, bottom: 0, left: 0, right: 0 };
  const canvas = state.canvas;
  const shown = (el) => !!el && !el.hidden && el.isConnected;
  if (isPhone(inst)) covers.bottom = measureCovered(inst) + 8;
  else if (canvas && typeof canvas.getBoundingClientRect === 'function') {
    const c = canvas.getBoundingClientRect();
    // What lies over the map in this instance's own layout (cornfield's page, a review) answers for itself: the proposal bar, the review column and the scenario
    // player each say where their edge is, the node panel its width. In a scope the pieces sit beside the map, not over it, and none answers
    const bar = inst.ask('proposal:covers');
    if (bar) covers.top = Math.max(0, bar.bottom - c.top) + 8;
    const panel = inst.ask('panel:covers'); // the node panel, when it slides over the map: its width, not its box (it slides in)
    if (panel && panel.right) covers.right = panel.right;
    const forge = inst.el('forge-panel');
    if (shown(forge) && forge.classList.contains('forge-open')) covers.left = forge.offsetWidth;
    // the review column (review-column.js) is docked on the left under the bar: its right edge is what it covers, past the Work panel's when both are open
    const column = inst.ask('changes:covers');
    if (column) covers.left = Math.max(covers.left, Math.max(0, column.right - c.left) + 8);
    const player = inst.ask('player:covers');
    if (player) covers.bottom = Math.max(0, c.bottom - player.top) + 8;
  }
  return freeRect(state.width || 0, state.height || 0, covers);
}
