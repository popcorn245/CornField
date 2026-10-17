/**
 * @module explorer/sheets
 *
 * The phone's bottom sheets (spec 0012, TOPO-18). Below 768px the proposal bar, the scenario
 * player and the node panel are sheets docked at the bottom of the map (`#sheet-dock`, which is
 * `display: contents` from 768px up, so the desktop layout is untouched). Each is a **peek** by
 * default (a handle, a title and a line or two) and **expands** to at most half the screen (60% for
 * the node panel) with its own scroll. A tap or a swipe on the handle expands or collapses it; a tap
 * on the map collapses it. At most one is expanded at a time (sheet-model.js).
 *
 * The sheets cover the bottom of the map, so the map must not fit or follow a step into that part:
 * `measureCovered()` is the height the dock covers (0 on a desktop), kept in `state.coveredBottom`
 * and in `--hx-covered` on the stage; render.js's fit and the scenario camera read it.
 */

import { state } from './state.js';
import { createSheetModel } from './sheet-model.js';

/** The width below which the sheets apply (matches the CSS) */
export const PHONE_QUERY = '(max-width: 767px)';
/** A drag on the handle longer than this (px) is a swipe, not a tap */
const SWIPE_PX = 20;

const model = createSheetModel();
const elements = new Map(); // id -> the sheet's element
const listeners = new Set();
let dock = null;
let lastCovered = 0;
let observers = [];

export const isPhone = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;

const $ = (id) => document.getElementById(id);
const stageOf = () => (dock && dock.parentElement) || (state.canvas ? state.canvas.parentElement : null);

/** 'expanded' or 'peek' for a registered sheet; undefined for one that is not */
export const sheetState = (id) => (model.has(id) ? (model.isExpanded(id) ? 'expanded' : 'peek') : undefined);
/** The id of the expanded sheet, or null */
export const expandedSheet = () => model.expanded();

/** Calls `fn` when the height the sheets cover, or which sheet is expanded, changes. Returns how to stop. */
export function onCoveredChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Puts the model on the page: each sheet's attribute and handle, the stage's `data-sheet-open`, the covered height */
function apply() {
  for (const [id, el] of elements) {
    const expanded = model.isExpanded(id);
    el.dataset.sheetState = expanded ? 'expanded' : 'peek';
    const handle = el.querySelector('.hx-sheet-handle');
    if (handle) {
      handle.setAttribute('aria-expanded', String(expanded));
      handle.setAttribute('aria-label', expanded ? 'Collapse this panel' : 'Expand this panel');
    }
  }
  const stage = stageOf();
  if (stage) stage.dataset.sheetOpen = model.expanded() || '';
  markLast();
  measureCovered();
  listeners.forEach((fn) => fn());
}

/** The lowest visible sheet gets `data-sheet-last`: it carries the bottom safe-area inset */
function markLast() {
  if (!dock) return;
  let last = null;
  for (const child of dock.children) {
    child.removeAttribute('data-sheet-last');
    if (!child.hidden && !(child.classList.contains('hx-drawer') && !child.classList.contains('drawer-open'))) last = child;
  }
  if (last) last.setAttribute('data-sheet-last', '');
}

/**
 * The height of the map the sheets hide, in px: the dock's height on a phone, 0 anywhere else.
 * Also written to `state.coveredBottom` and to `--hx-covered` on the stage. Without a dock on the
 * page it returns what `state.coveredBottom` holds.
 */
export function measureCovered() {
  if (!dock || !dock.isConnected) return state.coveredBottom || 0;
  const covered = isPhone() ? Math.round(dock.offsetHeight || 0) : 0;
  state.coveredBottom = covered;
  const stage = stageOf();
  if (stage) stage.style.setProperty('--hx-covered', `${covered}px`);
  if (covered !== lastCovered) {
    lastCovered = covered;
    listeners.forEach((fn) => fn());
  }
  return covered;
}

// ---------------------------------------------------------------------------
//  Registering and changing sheets
// ---------------------------------------------------------------------------

/** Makes `el` a sheet called `id` (a peek until expanded) and gives it a handle if it has none */
export function registerSheet(id, el) {
  if (!el) return;
  unregisterSheet(id, false);
  model.add(id);
  elements.set(id, el);
  el.classList.add('hx-sheet');
  let handle = [...el.children].find((c) => c.classList.contains('hx-sheet-handle'));
  if (!handle) {
    handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'hx-sheet-handle';
    handle.innerHTML = '<span></span>';
    el.prepend(handle);
  }
  bindHandle(id, handle);
  el.addEventListener('click', (e) => peekClick(id, e), true);
  apply();
}

/** Forgets a sheet (the player closing); `redraw` false while it is only being replaced */
export function unregisterSheet(id, redraw = true) {
  if (!model.has(id)) return;
  model.remove(id);
  elements.delete(id);
  if (redraw) apply();
}

export function expandSheet(id) { if (model.expand(id)) apply(); }
export function collapseSheet(id) { if (model.collapse(id)) apply(); }
export function collapseAllSheets() { if (model.collapseAll()) apply(); }
export function toggleSheet(id) { if (model.toggle(id)) apply(); }

// ---------------------------------------------------------------------------
//  Taps and swipes
// ---------------------------------------------------------------------------

/** The handle: a tap toggles, a swipe up expands, a swipe down collapses */
function bindHandle(id, handle) {
  let startY = null;
  let swiped = false;
  handle.addEventListener('pointerdown', (e) => {
    startY = e.clientY;
    swiped = false;
    if (handle.setPointerCapture && e.pointerId !== undefined) { try { handle.setPointerCapture(e.pointerId); } catch { /* a synthetic event has no pointer to capture */ } }
  });
  const end = (e) => {
    if (startY === null) return;
    const dy = e.clientY - startY;
    startY = null;
    if (Math.abs(dy) < SWIPE_PX) return;
    swiped = true;
    if (dy < 0) expandSheet(id); else collapseSheet(id);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', () => { startY = null; });
  handle.addEventListener('click', (e) => {
    e.stopPropagation(); // not a tap on the sheet itself (peekClick)
    if (swiped) { swiped = false; return; }
    toggleSheet(id);
  });
}

/** A peek sheet expands on a tap anywhere on it, except on its Close button (which still closes) */
function peekClick(id, e) {
  if (!isPhone() || model.isExpanded(id)) return;
  const target = e.target;
  if (target.closest && target.closest('.hx-sheet-handle')) return; // the handle's own listener
  if (target.closest && target.closest('select, input, textarea')) return; // the speed menu works from the peek
  const action = target.closest && target.closest('[data-action]');
  if (action && /close/.test(action.dataset.action)) return;
  e.preventDefault();
  e.stopPropagation();
  expandSheet(id);
}

/** A touch or click on the map collapses the expanded sheet */
function onMapDown(e) {
  if (e.target === state.canvas && isPhone()) collapseAllSheets();
}

/** The dim layer behind an expanded node panel: a tap there collapses the panel to its peek (it no longer closes it) */
function onBackdrop(e) {
  if (!isPhone()) return;
  e.stopPropagation();
  collapseAllSheets();
}

// ---------------------------------------------------------------------------
//  Wiring (main.js calls this once, after the page's markup is there)
// ---------------------------------------------------------------------------
let wiredDock = null;
let documentWired = false;
export function initSheets() {
  const found = $('sheet-dock');
  if (!found) return;
  if (found !== dock) {
    // A new page (or a test's new markup): forget the old sheets and watch this dock
    observers.forEach((o) => o.disconnect());
    observers = [];
    model.ids().forEach((id) => model.remove(id));
    elements.clear();
    lastCovered = 0;
    dock = found;
  }
  registerSheet('proposal', $('proposal-bar'));
  registerSheet('drawer', $('spec-drawer'));
  if (wiredDock !== dock) {
    wiredDock = dock;
    const backdrop = $('drawer-backdrop');
    if (backdrop) backdrop.addEventListener('click', onBackdrop, true);
    if (typeof MutationObserver === 'function') {
      const mo = new MutationObserver(() => { markLast(); measureCovered(); });
      mo.observe(dock, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
      observers.push(mo);
    }
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => measureCovered());
      ro.observe(dock);
      observers.push(ro);
    }
  }
  if (!documentWired) {
    documentWired = true;
    for (const type of ['pointerdown', 'touchstart', 'mousedown']) document.addEventListener(type, onMapDown, { passive: true, capture: true });
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia(PHONE_QUERY);
      if (mq && mq.addEventListener) mq.addEventListener('change', () => { collapseAllSheets(); measureCovered(); });
    }
  }
  apply();
}
