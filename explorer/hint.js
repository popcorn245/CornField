/**
 * @module explorer/hint
 *
 * The hint at the map's corner ("Click a node for what it is"; CF review F56). Three rules:
 *   - its words follow the pointer: `hintInspect` / `hintDrag` for a mouse or a trackpad, `hintInspectTouch` / `hintDragTouch` where the
 *     main pointer is coarse (a finger). A repo that sets only `hintInspect` (or `hintDrag`) gets its words on both;
 *   - it goes once the person has selected a node, for the rest of the session (sessionStorage; the Flow view's own description stays,
 *     since it says what Flow is, not how to use the map);
 *   - it is never shown over an open proposal, a node panel, the Work panel or a sheet.
 * The icon is `[data-corn="hint-icon"]`, so a theme can restyle or replace it.
 */

import { state } from './state.js';
import { isOverridden, t } from './strings.js';

export const HINT_STORAGE_KEY = 'cornfield:hint-done';

const $ = (id) => document.getElementById(id);

/** Whether the main pointer is a finger (`(pointer: coarse)`) */
export function coarsePointer(win = typeof window !== 'undefined' ? window : null) {
  try { return !!(win && win.matchMedia && win.matchMedia('(pointer: coarse)').matches); } catch { return false; }
}

/** The words by the pointer: the Touch ones on a finger, unless the repo set only the plain key (then its words serve both) */
export function hintWords(plain, touch, coarse) {
  return coarse && (touch.set || !plain.set) ? touch.text : plain.text;
}

/** The hint for the view in force */
export function hintText(coarse = coarsePointer()) {
  if (state.view === 'dataflow') return t('hintDataFlow');
  return state.isFreeform
    ? hintWords({ text: t('hintDrag'), set: isOverridden('hintDrag') }, { text: t('hintDragTouch'), set: isOverridden('hintDragTouch') }, coarse)
    : hintWords({ text: t('hintInspect'), set: isOverridden('hintInspect') }, { text: t('hintInspectTouch'), set: isOverridden('hintInspectTouch') }, coarse);
}

let dismissed = false;
try { dismissed = window.sessionStorage.getItem(HINT_STORAGE_KEY) === '1'; } catch { dismissed = false; }

/** Remembers that a node was selected: the hint is not shown again this session */
export function dismissHint() {
  if (dismissed) return;
  dismissed = true;
  try { window.sessionStorage.setItem(HINT_STORAGE_KEY, '1'); } catch { /* storage blocked: it holds for this page load */ }
  syncHint();
}

/** For tests: the hint is new again */
export function resetHintForTests() {
  dismissed = false;
  try { window.sessionStorage.removeItem(HINT_STORAGE_KEY); } catch { /* none */ }
}

/** What covers the map: an open proposal, the node panel, the Work panel, a sheet of the dock */
export function mapCovered(doc = document) {
  const open = (sel) => doc.querySelector(sel);
  const bar = open('#proposal-bar');
  if (bar && !bar.hidden) return true;
  const drawer = open('#spec-drawer');
  if (drawer && drawer.classList.contains('drawer-open')) return true;
  const work = open('#forge-panel');
  if (work && work.classList.contains('forge-open')) return true;
  return !!doc.querySelector('[data-corn="scenario-player"]'); // a scenario is playing (a sheet on a phone)
}

/** Words, and whether it shows, for the state of the page now */
export function syncHint() {
  const text = $('instruction-badge-text');
  const words = hintText();
  if (text && text.textContent !== words) text.textContent = words;
  const hint = text && text.closest('[data-corn="hint"]');
  if (!hint) return;
  const hide = mapCovered() || (dismissed && state.view !== 'dataflow');
  if (hint.hidden !== hide) hint.hidden = hide;
}

/** Keeps the hint right as panels open and close, and as the pointer kind changes. Returns how to stop. */
export function watchHint(doc = document) {
  const win = doc.defaultView;
  const stops = [];
  const stage = doc.querySelector('[data-corn="stage"]') || doc.body;
  if (win && win.MutationObserver && stage) {
    const mo = new win.MutationObserver(syncHint);
    mo.observe(stage, { attributes: true, attributeFilter: ['class', 'hidden', 'inert'], childList: true, subtree: true });
    stops.push(() => mo.disconnect());
  }
  const media = win && win.matchMedia ? win.matchMedia('(pointer: coarse)') : null;
  if (media && media.addEventListener) { media.addEventListener('change', syncHint); stops.push(() => media.removeEventListener('change', syncHint)); }
  syncHint();
  return () => stops.forEach((fn) => fn());
}
