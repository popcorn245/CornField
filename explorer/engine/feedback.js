/**
 * @module explorer/engine/feedback
 *
 * One way to say what an action came to: **where the person is looking** (by the control they used) and **to a screen reader** (the live
 * region), together. A result is kept under its key (a run's id) until the next action on that key, so a card that is drawn again shows
 * it again; a result that has no next action to end it (Copy spec) goes after `RESULT_MS`, which is never less than five seconds.
 * The results are the instance's own. explorer/feedback.js keeps the old names for the page's instance.
 *
 *   sayResult(inst, key, words, ok)    keep the result for `key` and announce it
 *   resultOf(inst, key)                { text, ok } or null
 *   clearResult(inst, key)             the next action on `key` begins: the old result goes
 *   showResultIn(inst, el, key)        paints the result of `key` into a result element (`data-corn="result"`), hidden when there is none
 */
import { announce } from './keyboard.js';

/** How long a result with no next action to end it stays (ms): at least five seconds */
export const RESULT_MS = 6000;

const resultsOf = (inst) => inst.slot('feedback', () => new Map());

/** Keeps the result of an action under `key` and announces it through the live region */
export function sayResult(inst, key, text, ok = true) {
  resultsOf(inst).set(key, { text, ok });
  announce(inst, text);
}

/** The result kept under `key`, or null */
export function resultOf(inst, key) {
  return resultsOf(inst).get(key) || null;
}

/** The next action on `key` begins: its old result goes */
export function clearResult(inst, key) {
  resultsOf(inst).delete(key);
}

/** Paints the result of `key` into `el` (a result element), hidden when there is none */
export function showResultIn(inst, el, key) {
  if (!el) return;
  const r = resultsOf(inst).get(key);
  el.hidden = !r;
  el.textContent = r ? r.text : '';
  if (r) el.dataset.cornState = r.ok ? 'success' : 'failure'; else delete el.dataset.cornState;
}

/** For tests: forget every result */
export function resetFeedback(inst) {
  resultsOf(inst).clear();
}
