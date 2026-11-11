/**
 * @module explorer/sheets
 *
 * The phone's bottom sheets (spec 0012, TOPO-18). Below 768px the proposal bar, the scenario
 * player, the issues and PRs panel (forge-panel.js) and the node panel are sheets docked at the bottom of
 * the map (`#sheet-dock`, which is `display: contents` from 768px up, so the desktop layout is untouched).
 * Each is a **peek** by default (a handle, a title and a line or two) and **expands** to at most half the
 * screen (60% for the node panel) with its own scroll. A tap or a swipe on the handle expands or collapses it; a tap
 * on the map collapses it. At most one is expanded at a time (sheet-model.js). Spec 0010 D7: the Work panel is a sheet too, with the review
 * (the proposal bar or the scenario player) and one other sheet at most (opening Work displaces the node panel and the reverse); while one is
 * expanded the sheet of the other group folds to a **stub** (one 44px row: its title and its badge; a tap swaps them), and an expanded sheet is
 * capped so the map keeps 35% of the screen (`--hx-sheet-cap`, sheet-model.js `sheetCap`). Escape folds an expanded sheet, then closes.
 *
 * The sheets cover the bottom of the map, so the map must not fit or follow a step into that part:
 * `measureCovered()` is the height the dock covers (0 on a desktop), kept in `state.coveredBottom`
 * and in `--hx-covered` on the stage; render.js's fit and the scenario camera read it.
 */

import { state } from './state.js';
import { createSheetModel, sheetCap } from './sheet-model.js';
import { freeRect } from './camera.js';

/** The width below which the sheets apply (matches the CSS) */
export const PHONE_QUERY = '(max-width: 767px)';
/** A drag on the handle longer than this (px) is a swipe, not a tap */
const SWIPE_PX = 20;

const model = createSheetModel();
const elements = new Map(); // id -> the sheet's element
const options = new Map(); // id -> { stub?: () => { title: string, badge?: string, label?: string }, away?: () => void } what the sheet's owner gave it
const wiredAs = new WeakMap(); // a sheet's element, and its handle -> the id their listeners were bound for
const away = new Set(); // sheets displaced by the other of their group: open on the page, hidden until opened again
const listeners = new Set();
let dock = null;
let lastCovered = 0;
let observers = [];

export const isPhone = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;

const $ = (id) => document.getElementById(id);
const stageOf = () => (dock && dock.parentElement) || (state.canvas ? state.canvas.parentElement : null);

/** 'expanded', 'stub' or 'peek' for a registered sheet (a sheet that is not open is a peek, as it is when it opens); undefined for one that is not registered */
export const sheetState = (id) => { const st = model.stateOf(id); return st === 'hidden' ? 'peek' : st; };
/** The id of the expanded sheet, or null */
export const expandedSheet = () => model.expanded();

/** Calls `fn` when the height the sheets cover, or which sheet is expanded, changes. Returns how to stop. */
export function onCoveredChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Puts the model on the page: each sheet's attribute and handle, the stage's `data-sheet-open`, the covered height */
function apply() {
  syncShown();
  for (const [id, el] of elements) {
    const expanded = model.isExpanded(id);
    const st = model.stateOf(id);
    el.dataset.sheetState = st === 'hidden' ? 'peek' : st;
    const handle = [...el.children].find((c) => c.classList.contains('hx-sheet-handle'));
    if (handle) {
      handle.setAttribute('aria-expanded', String(expanded));
      handle.setAttribute('aria-label', expanded ? 'Collapse this panel' : 'Expand this panel');
    }
    paintStub(id, el, st === 'stub');
  }
  const stage = stageOf();
  if (stage) stage.dataset.sheetOpen = model.expanded() || '';
  // The expanded sheet is capped so the map keeps 35% of the screen: what is left under the stub, if there is one
  if (dock && isPhone() && typeof window !== 'undefined') dock.style.setProperty('--hx-sheet-cap', `${sheetCap(window.innerHeight || 0, model.stubs())}px`);
  markLast();
  measureCovered();
  listeners.forEach((fn) => fn());
}

/** Whether a sheet's element is open on the page (the proposal bar is shown, the Work panel and the node panel carry their open class) */
function isOpenOnPage(id, el) {
  if (id === 'forge') return el.classList.contains('forge-open');
  if (id === 'drawer') return el.classList.contains('drawer-open');
  return !el.hidden && el.isConnected;
}

/**
 * Brings the model's open sheets in line with the page. A sheet that has just opened beside another of its group displaces it (Work and the node
 * panel take turns): the displaced one is `away` (hidden on a phone, its selection kept) and its owner is told. A sheet that is closed on the page
 * is hidden in the model and is no longer away.
 */
function syncShown() {
  if (!isPhone()) { // the sheets are panels from 768px: nothing is displaced and nothing is a stub
    away.clear();
    for (const el of elements.values()) el.removeAttribute('data-sheet-away');
    return;
  }
  for (const [id, el] of elements) {
    const open = isOpenOnPage(id, el) && !away.has(id);
    if (!open && !isOpenOnPage(id, el)) away.delete(id);
    if (open && !model.isShown(id)) {
      for (const gone of model.show(id)) displace(gone);
    } else if (!open && model.isShown(id)) model.hide(id);
  }
  for (const [id, el] of elements) {
    const gone = away.has(id);
    const was = el.hasAttribute('data-sheet-away');
    el.toggleAttribute('data-sheet-away', gone);
    if (gone && !el.inert) el.inert = true; // out of reach of Tab while it is away
    else if (!gone && was && isOpenOnPage(id, el)) el.inert = false;
  }
}

/** A sheet displaced by the other of its group: hidden, not closed (the node stays selected); Work is closed by its own code */
function displace(id) {
  const el = elements.get(id);
  if (!el) return;
  away.add(id);
  const on = options.get(id);
  if (on && on.away) on.away();
}

/** The stub's row: made on first use, shown only in the stub state, with the title and the badge the sheet's owner says */
function paintStub(id, el, on) {
  let stub = [...el.children].find((c) => c.classList.contains('hx-sheet-stub'));
  if (!stub) {
    if (!on) return;
    stub = document.createElement('button');
    stub.type = 'button';
    stub.className = 'hx-sheet-stub';
    stub.dataset.corn = 'sheet-stub';
    stub.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); expandSheet(id); const h = [...el.children].find((c) => c.classList.contains('hx-sheet-handle')); if (h && isPhone()) h.focus(); });
    el.append(stub);
  }
  stub.hidden = !on;
  if (!on) return;
  const opt = options.get(id);
  const said = (opt && opt.stub ? opt.stub() : null) || { title: el.getAttribute('aria-label') || id };
  const title = String(said.title || '');
  const badge = said.badge ? String(said.badge) : '';
  const key = `${title}\u0000${badge}\u0000${said.label || ''}`;
  if (stub.dataset.key === key) return;
  stub.dataset.key = key;
  stub.replaceChildren();
  const t = document.createElement('span');
  t.className = 'hx-sheet-stub-title';
  t.textContent = title;
  stub.append(t);
  if (badge) {
    const b = document.createElement('span');
    b.className = 'hx-waiting-badge';
    b.dataset.corn = 'waiting-badge';
    b.setAttribute('aria-hidden', 'true');
    b.textContent = badge;
    stub.append(b);
  }
  stub.setAttribute('aria-label', said.label || (badge ? `${title}, ${badge}` : title));
}

/** Says a stub's words may have changed (the number waiting, a proposal's title): drawn again, if it is showing */
export function refreshStubs() {
  for (const [id, el] of elements) if (model.stateOf(id) === 'stub') paintStub(id, el, true);
}

/**
 * Opens a sheet's place in the dock without expanding it (Work opens as a peek, a node panel opens as a peek): the other sheet of its group is
 * displaced, and this one is no longer away. Called by what opens a sheet (the node panel's code); the Work panel's open class is seen too.
 */
export function showSheet(id) {
  if (!elements.has(id)) return;
  away.delete(id);
  apply();
}

/** The lowest visible sheet gets `data-sheet-last`: it carries the bottom safe-area inset */
function markLast() {
  if (!dock) return;
  let last = null;
  for (const child of dock.children) {
    child.removeAttribute('data-sheet-last');
    const closed = (child.classList.contains('hx-drawer') && !child.classList.contains('drawer-open')) || (child.classList.contains('hx-forge') && !child.classList.contains('forge-open'));
    if (!child.hidden && !closed) last = child;
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

/**
 * The part of the map nothing covers, in the canvas's own CSS px: what the camera should frame a node into.
 * On a phone the dock's sheets cover the bottom; from 768px the proposal bar covers the top (and the change list it grows to hold),
 * the node panel the right, the Work panel the left and the scenario player the bottom. Without a layout (no page) it is the whole canvas.
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function visibleMapRect() {
  const covers = { top: 0, bottom: 0, left: 0, right: 0 };
  const canvas = state.canvas;
  const shown = (el) => !!el && !el.hidden && el.isConnected;
  if (isPhone()) covers.bottom = measureCovered() + 8;
  else if (canvas && typeof canvas.getBoundingClientRect === 'function') {
    const c = canvas.getBoundingClientRect();
    const bar = $('proposal-bar');
    if (shown(bar)) covers.top = Math.max(0, bar.getBoundingClientRect().bottom - c.top) + 8;
    const drawer = $('spec-drawer');
    if (shown(drawer) && drawer.classList.contains('drawer-open')) covers.right = drawer.offsetWidth; // its width, not its box: it slides in
    const forge = $('forge-panel');
    if (shown(forge) && forge.classList.contains('forge-open')) covers.left = forge.offsetWidth;
    const player = document.querySelector('.hx-player');
    if (shown(player)) covers.bottom = Math.max(0, c.bottom - player.getBoundingClientRect().top) + 8;
  }
  return freeRect(state.width || 0, state.height || 0, covers);
}

// ---------------------------------------------------------------------------
//  Registering and changing sheets
// ---------------------------------------------------------------------------

/** Makes `el` a sheet called `id` (a peek until expanded) and gives it a handle if it has none */
export function registerSheet(id, el, opts = {}) {
  if (!el) return;
  unregisterSheet(id, false);
  model.add(id);
  elements.set(id, el);
  options.set(id, opts);
  el.classList.add('hx-sheet');
  let handle = [...el.children].find((c) => c.classList.contains('hx-sheet-handle'));
  if (!handle) {
    handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'hx-sheet-handle';
    handle.dataset.corn = 'sheet-handle';
    handle.innerHTML = '<span data-corn="sheet-grip"></span>';
    el.prepend(handle);
  }
  if (wiredAs.get(handle) !== id) { wiredAs.set(handle, id); bindHandle(id, handle); } // registered again (a re-init): one listener, or a tap toggles twice
  if (wiredAs.get(el) !== id) { wiredAs.set(el, id); el.addEventListener('click', (e) => peekClick(id, e), true); }
  apply();
}

/** Forgets a sheet (the player closing); `redraw` false while it is only being replaced */
export function unregisterSheet(id, redraw = true) {
  if (!model.has(id)) return;
  model.remove(id);
  elements.delete(id);
  options.delete(id);
  away.delete(id);
  if (redraw) apply();
}

export function expandSheet(id) { syncShown(); if (model.expand(id)) apply(); } // what is open on the page is known first (a bar shown a moment ago)
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
  if (target.closest && target.closest('.hx-sheet-handle, .hx-sheet-stub')) return; // the handle's own listener, and the stub's (it swaps, and takes the focus to the handle)
  if (target.closest && target.closest('select, input, textarea, [data-peek-ok]')) return; // the speed menu, and the proposal's Send back, Approve and mode switcher, work from the peek
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

/** Escape in an expanded sheet folds it to a peek; Escape in a peek is the sheet's own (it closes it): "folds, then closes" (spec 0010 D7) */
function onEscape(e) {
  if (e.key !== 'Escape' || e.defaultPrevented || !isPhone()) return;
  const id = model.expanded();
  const el = id && elements.get(id);
  if (!el || !el.contains(e.target)) return;
  if (e.target.closest && e.target.closest('select, input, textarea')) return; // a field's own Escape first
  e.preventDefault();
  e.stopPropagation();
  collapseSheet(id);
  const handle = [...el.children].find((c) => c.classList.contains('hx-sheet-handle'));
  if (handle) handle.focus();
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
    options.clear();
    away.clear();
    lastCovered = 0;
    dock = found;
  }
  registerSheet('proposal', $('proposal-bar'), { stub: () => ({ title: ($('proposal-title') && $('proposal-title').textContent) || 'Proposal' }) });
  registerSheet('drawer', $('spec-drawer'), { stub: () => ({ title: ($('drawer-title') && $('drawer-title').textContent) || 'Node' }) });
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
    document.addEventListener('keydown', onEscape, true);
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia(PHONE_QUERY);
      if (mq && mq.addEventListener) mq.addEventListener('change', () => { collapseAllSheets(); measureCovered(); });
    }
  }
  apply();
}
