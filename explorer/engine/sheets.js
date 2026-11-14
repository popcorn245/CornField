/**
 * @module explorer/engine/sheets
 *
 * The phone's bottom sheets (spec 0012, TOPO-18). Below 768px the proposal bar, the scenario
 * player, the issues and PRs panel (forge-panel.js) and the node panel are sheets docked at the bottom of
 * the map (`#sheet-dock`, which is `display: contents` from 768px up, so the desktop layout is untouched).
 * Each is a **peek** by default (a handle, a title and a line or two) and **expands** to at most half the
 * screen (60% for the node panel) with its own scroll. A tap or a swipe on the handle expands or collapses it; a tap
 * on the map collapses it. At most one is expanded at a time (sheet-model.js). Spec 0010 D7: the Work list is a sheet too, with the review
 * (the proposal bar or the scenario player) and one other sheet at most (opening Work displaces the node panel and the reverse); while one is
 * expanded the sheet of the other group folds to a **stub** (one 44px row: its title and its badge; a tap swaps them), and an expanded sheet is
 * capped so the map keeps 35% of the screen (`--hx-sheet-cap`, sheet-model.js `sheetCap`). Escape folds an expanded sheet, then closes.
 *
 * The sheets cover the bottom of the map, so the map must not fit or follow a step into that part:
 * `measureCovered()` is the height the dock covers (0 on a desktop), kept in `state.coveredBottom`
 * and in `--hx-covered` on the stage; the map's fit and the scenario camera read it.
 *
 * It is on an instance (spec 0011 D2): the sheets, the dock and what is watching it are the instance's own (`inst.slot`), and the functions
 * take `inst` first. A node panel registers its own sheet (pieces/node-panel.js); explorer/sheets.js keeps the old names for the page.
 */

import { sheetCap } from '../sheet-model.js';
import { PHONE_QUERY, sheetsOf, isPhone, stageOf, measureCovered, visibleMapRect } from './map-rect.js';

export { PHONE_QUERY, isPhone, measureCovered, visibleMapRect };

/** A drag on the handle longer than this (px) is a swipe, not a tap */
const SWIPE_PX = 20;

/** Makes `el`'s width, not the window's, say whether the instance is a phone's (the review piece's box in another app's page); null goes back to the window's */
export function setPhoneBox(inst, el) {
  sheetsOf(inst).box = el || null;
}

/** Calls `fn` when the instance becomes a phone's or stops being one (the window's width, or the phone box's). Returns how to stop. */
export function onPhoneChange(inst, fn) {
  const { box } = sheetsOf(inst);
  const RO = inst.win && inst.win.ResizeObserver;
  if (box && typeof RO === 'function') {
    let was = isPhone(inst);
    const ro = new RO(() => { const now = isPhone(inst); if (now !== was) { was = now; fn(); } });
    ro.observe(box);
    const off = () => { ro.disconnect(); inst.release(off); };
    inst.own(off);
    return off;
  }
  if (inst.win && typeof inst.win.matchMedia === 'function') {
    const mq = inst.win.matchMedia(PHONE_QUERY);
    if (mq && mq.addEventListener) return inst.listen(mq, 'change', () => fn());
  }
  return () => {};
};

/** 'expanded', 'stub' or 'peek' for a registered sheet (a sheet that is not open is a peek, as it is when it opens); undefined for one that is not registered */
export const sheetState = (inst, id) => { const st = sheetsOf(inst).model.stateOf(id); return st === 'hidden' ? 'peek' : st; };
/** The id of the expanded sheet, or null */
export const expandedSheet = (inst) => sheetsOf(inst).model.expanded();

/** Calls `fn` when the height the sheets cover, or which sheet is expanded, changes. Returns how to stop. */
export function onCoveredChange(inst, fn) {
  const S = sheetsOf(inst);
  S.listeners.add(fn);
  return () => S.listeners.delete(fn);
}

/** Puts the model on the page: each sheet's attribute and handle, the stage's `data-sheet-open`, the covered height */
function apply(inst) {
  const S = sheetsOf(inst);
  const { model } = S;
  syncShown(inst);
  for (const [id, el] of S.elements) {
    const expanded = model.isExpanded(id);
    const st = model.stateOf(id);
    el.dataset.sheetState = st === 'hidden' ? 'peek' : st;
    const handle = [...el.children].find((c) => c.classList.contains('hx-sheet-handle'));
    if (handle) {
      handle.setAttribute('aria-expanded', String(expanded));
      handle.setAttribute('aria-label', expanded ? 'Collapse this panel' : 'Expand this panel');
    }
    paintStub(inst, id, el, st === 'stub');
  }
  const stage = stageOf(inst, S);
  if (stage) stage.dataset.sheetOpen = model.expanded() || '';
  // The expanded sheet is capped so the map keeps 35% of the screen (of the box, where the instance has one): what is left under the stub, if there is one
  if (S.dock && isPhone(inst)) S.dock.style.setProperty('--hx-sheet-cap', `${sheetCap((S.box ? S.box.clientHeight : inst.win.innerHeight) || 0, model.stubs())}px`);
  markLast(inst);
  measureCovered(inst);
  S.listeners.forEach((fn) => fn());
}

/** Whether a sheet's element is open on the page (the proposal bar is shown, the Work list and the node panel carry their open class) */
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
function syncShown(inst) {
  const S = sheetsOf(inst);
  const { model } = S;
  if (!isPhone(inst)) { // the sheets are panels from 768px: nothing is displaced and nothing is a stub
    S.away.clear();
    for (const el of S.elements.values()) el.removeAttribute('data-sheet-away');
    return;
  }
  for (const [id, el] of S.elements) {
    const open = isOpenOnPage(id, el) && !S.away.has(id);
    if (!open && !isOpenOnPage(id, el)) S.away.delete(id);
    if (open && !model.isShown(id)) {
      for (const gone of model.show(id)) displace(inst, gone);
    } else if (!open && model.isShown(id)) model.hide(id);
  }
  for (const [id, el] of S.elements) {
    const gone = S.away.has(id);
    const was = el.hasAttribute('data-sheet-away');
    el.toggleAttribute('data-sheet-away', gone);
    if (gone && !el.inert) el.inert = true; // out of reach of Tab while it is away
    else if (!gone && was && isOpenOnPage(id, el)) el.inert = false;
  }
}

/** A sheet displaced by the other of its group: hidden, not closed (the node stays selected); Work is closed by its own code */
function displace(inst, id) {
  const S = sheetsOf(inst);
  const el = S.elements.get(id);
  if (!el) return;
  S.away.add(id);
  const on = S.options.get(id);
  if (on && on.away) on.away();
}

/** The stub's row: made on first use, shown only in the stub state, with the title and the badge the sheet's owner says */
function paintStub(inst, id, el, on) {
  const S = sheetsOf(inst);
  let stub = [...el.children].find((c) => c.classList.contains('hx-sheet-stub'));
  if (!stub) {
    if (!on) return;
    stub = inst.doc.createElement('button');
    stub.type = 'button';
    stub.className = 'hx-sheet-stub';
    stub.dataset.corn = 'sheet-stub';
    stub.setAttribute('part', 'sheet-stub');
    stub.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); expandSheet(inst, id); const h = [...el.children].find((c) => c.classList.contains('hx-sheet-handle')); if (h && isPhone(inst)) h.focus(); });
    el.append(stub);
  }
  stub.hidden = !on;
  if (!on) return;
  const opt = S.options.get(id);
  const said = (opt && opt.stub ? opt.stub() : null) || { title: el.getAttribute('aria-label') || id };
  const title = String(said.title || '');
  const badge = said.badge ? String(said.badge) : '';
  const key = `${title}\u0000${badge}\u0000${said.label || ''}`;
  if (stub.dataset.key === key) return;
  stub.dataset.key = key;
  stub.replaceChildren();
  const t = inst.doc.createElement('span');
  t.className = 'hx-sheet-stub-title';
  t.textContent = title;
  stub.append(t);
  if (badge) {
    const b = inst.doc.createElement('span');
    b.className = 'hx-waiting-badge';
    b.dataset.corn = 'waiting-badge';
    b.setAttribute('part', 'waiting-badge');
    b.setAttribute('aria-hidden', 'true');
    b.textContent = badge;
    stub.append(b);
  }
  stub.setAttribute('aria-label', said.label || (badge ? `${title}, ${badge}` : title));
}

/** Says a stub's words may have changed (the number waiting, a proposal's title): drawn again, if it is showing */
export function refreshStubs(inst) {
  const S = sheetsOf(inst);
  for (const [id, el] of S.elements) if (S.model.stateOf(id) === 'stub') paintStub(inst, id, el, true);
}

/**
 * Opens a sheet's place in the dock without expanding it (Work opens as a peek, a node panel opens as a peek): the other sheet of its group is
 * displaced, and this one is no longer away. Called by what opens a sheet (the node panel's code); the Work list's open class is seen too.
 */
export function showSheet(inst, id) {
  const S = sheetsOf(inst);
  if (!S.elements.has(id)) return;
  S.away.delete(id);
  apply(inst);
}

/** The lowest visible sheet gets `data-sheet-last`: it carries the bottom safe-area inset */
function markLast(inst) {
  const { dock } = sheetsOf(inst);
  if (!dock) return;
  let last = null;
  for (const child of dock.children) {
    child.removeAttribute('data-sheet-last');
    const closed = (child.classList.contains('hx-drawer') && !child.classList.contains('drawer-open')) || (child.classList.contains('hx-forge') && !child.classList.contains('forge-open'));
    if (!child.hidden && !closed) last = child;
  }
  if (last) last.setAttribute('data-sheet-last', '');
}

// ---------------------------------------------------------------------------
//  Registering and changing sheets
// ---------------------------------------------------------------------------

/** Makes `el` a sheet called `id` (a peek until expanded) and gives it a handle if it has none */
export function registerSheet(inst, id, el, opts = {}) {
  if (!el) return;
  const S = sheetsOf(inst);
  unregisterSheet(inst, id, false);
  S.model.add(id);
  S.elements.set(id, el);
  S.options.set(id, opts);
  el.classList.add('hx-sheet');
  let handle = [...el.children].find((c) => c.classList.contains('hx-sheet-handle'));
  if (!handle) {
    handle = inst.doc.createElement('button');
    handle.type = 'button';
    handle.className = 'hx-sheet-handle';
    handle.dataset.corn = 'sheet-handle';
    handle.setAttribute('part', 'sheet-handle');
    handle.innerHTML = '<span data-corn="sheet-grip" part="sheet-grip"></span>';
    el.prepend(handle);
  }
  // Registered again (a re-init) the old listeners went with `unregisterSheet` above: one set, or a tap toggles twice
  S.offs.set(id, [...bindHandle(inst, id, handle), inst.listen(el, 'click', (e) => peekClick(inst, id, e), true)]);
  apply(inst);
}

/** Forgets a sheet (the player closing, a node panel ending); `redraw` false while it is only being replaced */
export function unregisterSheet(inst, id, redraw = true) {
  const S = sheetsOf(inst);
  if (!S.model.has(id)) return;
  (S.offs.get(id) || []).forEach((off) => off());
  S.offs.delete(id);
  S.model.remove(id);
  S.elements.delete(id);
  S.options.delete(id);
  S.away.delete(id);
  if (redraw) apply(inst);
}

export function expandSheet(inst, id) { syncShown(inst); if (sheetsOf(inst).model.expand(id)) apply(inst); } // what is open on the page is known first (a bar shown a moment ago)
export function collapseSheet(inst, id) { if (sheetsOf(inst).model.collapse(id)) apply(inst); }
export function collapseAllSheets(inst) { if (sheetsOf(inst).model.collapseAll()) apply(inst); }
export function toggleSheet(inst, id) { syncShown(inst); if (sheetsOf(inst).model.toggle(id)) apply(inst); } // the same: a bar shown since the last change is open

// ---------------------------------------------------------------------------
//  Taps and swipes
// ---------------------------------------------------------------------------

/** The handle: a tap toggles, a swipe up expands, a swipe down collapses. Returns how to take its listeners back */
function bindHandle(inst, id, handle) {
  let startY = null;
  let swiped = false;
  const offs = [];
  offs.push(inst.listen(handle, 'pointerdown', (e) => {
    startY = e.clientY;
    swiped = false;
    if (handle.setPointerCapture && e.pointerId !== undefined) { try { handle.setPointerCapture(e.pointerId); } catch { /* a synthetic event has no pointer to capture */ } }
  }));
  const end = (e) => {
    if (startY === null) return;
    const dy = e.clientY - startY;
    startY = null;
    if (Math.abs(dy) < SWIPE_PX) return;
    swiped = true;
    if (dy < 0) expandSheet(inst, id); else collapseSheet(inst, id);
  };
  offs.push(inst.listen(handle, 'pointerup', end));
  offs.push(inst.listen(handle, 'pointercancel', () => { startY = null; }));
  offs.push(inst.listen(handle, 'click', (e) => {
    e.stopPropagation(); // not a tap on the sheet itself (peekClick)
    if (swiped) { swiped = false; return; }
    toggleSheet(inst, id);
  }));
  return offs;
}

/** A peek sheet expands on a tap anywhere on it, except on its Close button (which still closes) */
function peekClick(inst, id, e) {
  if (!isPhone(inst) || sheetsOf(inst).model.isExpanded(id)) return;
  const target = e.target;
  if (target.closest && target.closest('.hx-sheet-handle, .hx-sheet-stub')) return; // the handle's own listener, and the stub's (it swaps, and takes the focus to the handle)
  if (target.closest && target.closest('select, input, textarea, [data-peek-ok]')) return; // the speed menu, and the proposal's Send back, Approve and mode switcher, work from the peek
  const action = target.closest && target.closest('[data-action]');
  if (action && /close/.test(action.dataset.action)) return;
  e.preventDefault();
  e.stopPropagation();
  expandSheet(inst, id);
}

/** A touch or click on the map collapses the expanded sheet */
function onMapDown(inst, e) {
  if (e.target === inst.state.canvas && isPhone(inst)) collapseAllSheets(inst);
}

/** Escape in an expanded sheet folds it to a peek; Escape in a peek is the sheet's own (it closes it): "folds, then closes" (spec 0010 D7) */
function onEscape(inst, e) {
  if (e.key !== 'Escape' || e.defaultPrevented || !isPhone(inst)) return;
  const S = sheetsOf(inst);
  const id = S.model.expanded();
  const el = id && S.elements.get(id);
  if (!el || !el.contains(e.target)) return;
  if (e.target.closest && e.target.closest('select, input, textarea')) return; // a field's own Escape first
  e.preventDefault();
  e.stopPropagation();
  collapseSheet(inst, id);
  const handle = [...el.children].find((c) => c.classList.contains('hx-sheet-handle'));
  if (handle) handle.focus();
}

/** The dim layer behind an expanded node panel: a tap there collapses the panel to its peek (it no longer closes it) */
export function onBackdrop(inst, e) {
  if (!isPhone(inst)) return;
  e.stopPropagation();
  collapseAllSheets(inst);
}

// ---------------------------------------------------------------------------
//  Wiring (the page calls this once, after the page's markup is there; a node panel calls it as it mounts)
// ---------------------------------------------------------------------------

/** Watches the instance's dock (`#sheet-dock`) and its root for the taps and keys that fold a sheet; a second call for the same dock does nothing */
export function initSheets(inst) {
  const S = sheetsOf(inst);
  const found = inst.el('sheet-dock');
  if (!found) return;
  if (found !== S.dock) {
    // A new page (or a test's new markup): forget the old sheets and watch this dock
    S.observers.forEach((o) => o.disconnect());
    S.observers = [];
    S.model.ids().forEach((id) => S.model.remove(id));
    S.elements.clear();
    S.options.clear();
    S.away.clear();
    S.lastCovered = 0;
    S.dock = found;
  }
  if (S.wiredDock !== S.dock) {
    S.wiredDock = S.dock;
    const win = inst.win;
    if (win && typeof win.MutationObserver === 'function') {
      const mo = new win.MutationObserver(() => { markLast(inst); measureCovered(inst); });
      mo.observe(S.dock, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
      S.observers.push(mo);
      inst.own(() => mo.disconnect());
    }
    if (win && typeof win.ResizeObserver === 'function') {
      const ro = new win.ResizeObserver(() => measureCovered(inst));
      ro.observe(S.dock);
      S.observers.push(ro);
      inst.own(() => ro.disconnect());
    }
  }
  if (!S.documentWired) {
    S.documentWired = true;
    // The scenario player's bar is a sheet in the dock, above the node panel's drawer (the dock's own children): the dock's owner seats it
    inst.on('player:seat', (bar) => {
      const dock = S.dock;
      if (!dock || !dock.isConnected) return undefined;
      const drawer = [...dock.children].find((child) => child.classList.contains('hx-drawer'));
      if (drawer) dock.insertBefore(bar, drawer); else dock.appendChild(bar);
      return true;
    });
    for (const type of ['pointerdown', 'touchstart', 'mousedown']) inst.listen(inst.root, type, (e) => onMapDown(inst, e), { passive: true, capture: true });
    inst.listen(inst.root, 'keydown', (e) => onEscape(inst, e), true);
    onPhoneChange(inst, () => { collapseAllSheets(inst); measureCovered(inst); });
  }
  apply(inst);
}
