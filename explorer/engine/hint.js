/**
 * @module explorer/engine/hint
 *
 * The hint at the map's corner ("Click a node for what it is"; CF review F56), on an instance. Three rules:
 *   - its words follow the pointer: `hintInspect` / `hintDrag` for a mouse or a trackpad, `hintInspectTouch` / `hintDragTouch` where the
 *     main pointer is coarse (a finger). A repo that sets only `hintInspect` (or `hintDrag`) gets its words on both;
 *   - it goes once the person has selected a node, for the rest of the session (sessionStorage; the Flow view's own description stays,
 *     since it says what Flow is, not how to use the map);
 *   - it is never shown over an open proposal, a node panel, the Work list or a sheet.
 * The icon is `[data-corn="hint-icon"]`, so a theme can restyle or replace it. explorer/hint.js keeps the old names for the page's instance.
 */
import { isOverridden, t } from './strings.js';

export const HINT_STORAGE_KEY = 'cornfield:hint-done';

/** Whether the main pointer is a finger (`(pointer: coarse)`) */
export function coarsePointer(win) {
  try { return !!(win && win.matchMedia && win.matchMedia('(pointer: coarse)').matches); } catch { return false; }
}

/** The words by the pointer: the Touch ones on a finger, unless the repo set only the plain key (then its words serve both) */
export function hintWords(plain, touch, coarse) {
  return coarse && (touch.set || !plain.set) ? touch.text : plain.text;
}

/** The hint for the view in force */
export function hintText(inst, coarse = coarsePointer(inst.win)) {
  const { state } = inst;
  if (state.view === 'dataflow') return t(inst, 'hintDataFlow');
  return state.isFreeform
    ? hintWords({ text: t(inst, 'hintDrag'), set: isOverridden(inst, 'hintDrag') }, { text: t(inst, 'hintDragTouch'), set: isOverridden(inst, 'hintDragTouch') }, coarse)
    : hintWords({ text: t(inst, 'hintInspect'), set: isOverridden(inst, 'hintInspect') }, { text: t(inst, 'hintInspectTouch'), set: isOverridden(inst, 'hintInspectTouch') }, coarse);
}

const sessionOf = (inst) => { try { return inst.win ? inst.win.sessionStorage : null; } catch { return null; } };
/** Whether a node was selected in this session, for this instance */
const memory = (inst) => inst.slot('hint', () => {
  const m = { dismissed: false };
  try { const store = sessionOf(inst); m.dismissed = !!store && store.getItem(HINT_STORAGE_KEY) === '1'; } catch { m.dismissed = false; }
  return m;
});

/** Remembers that a node was selected: the hint is not shown again this session */
export function dismissHint(inst) {
  const m = memory(inst);
  if (m.dismissed) return;
  m.dismissed = true;
  if (!inst.el('instruction-badge-text')) return; // an instance with no hint (a map in another app's page) writes nothing in that page's storage
  try { const store = sessionOf(inst); if (store) store.setItem(HINT_STORAGE_KEY, '1'); } catch { /* storage blocked: it holds for this page load */ }
  syncHint(inst);
}

/** For tests: the hint is new again */
export function resetHint(inst) {
  memory(inst).dismissed = false;
  try { const store = sessionOf(inst); if (store) store.removeItem(HINT_STORAGE_KEY); } catch { /* none */ }
}

/** What covers the map: an open proposal, the node panel, the Work list, a sheet of the dock */
export function mapCovered(inst) {
  const open = (id) => inst.el(id);
  const bar = open('proposal-bar');
  if (bar && !bar.hidden) return true;
  const drawer = open('spec-drawer');
  if (drawer && drawer.classList.contains('drawer-open')) return true;
  const work = open('forge-panel');
  if (work && work.classList.contains('forge-open')) return true;
  return !!(inst.root && inst.root.querySelector('[data-corn="scenario-player"]')); // a scenario is playing (a sheet on a phone)
}

/** Words, and whether it shows, for the state of the page now */
export function syncHint(inst) {
  const text = inst.el('instruction-badge-text');
  const words = hintText(inst);
  if (text && text.textContent !== words) text.textContent = words;
  const hint = text && text.closest('[data-corn="hint"]');
  if (!hint) return;
  const hide = mapCovered(inst) || (memory(inst).dismissed && inst.state.view !== 'dataflow');
  if (hint.hidden !== hide) hint.hidden = hide;
}

/** Keeps the hint right as panels open and close, and as the pointer kind changes. Returns how to stop; the instance's end stops it too. */
export function watchHint(inst) {
  const win = inst.win;
  const stops = [];
  const stage = (inst.root && inst.root.querySelector('[data-corn="stage"]')) || (inst.doc && inst.doc.body);
  if (win && win.MutationObserver && stage) {
    const mo = new win.MutationObserver(() => syncHint(inst));
    mo.observe(stage, { attributes: true, attributeFilter: ['class', 'hidden', 'inert'], childList: true, subtree: true });
    stops.push(() => mo.disconnect());
  }
  const media = win && win.matchMedia ? win.matchMedia('(pointer: coarse)') : null;
  if (media && media.addEventListener) stops.push(inst.listen(media, 'change', () => syncHint(inst)));
  syncHint(inst);
  const stop = () => stops.forEach((fn) => fn());
  inst.own(stop);
  return stop;
}
