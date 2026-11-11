/**
 * @module explorer/feedback
 *
 * One way to say what an action came to: **where the person is looking** (by the control they used) and **to a screen reader** (the live
 * region), together. A result is kept under its key (a run's id) until the next action on that key, so a card that is drawn again shows
 * it again; a result that has no next action to end it (Copy spec) goes after `RESULT_MS`, which is never less than five seconds.
 *
 *   sayResult(key, words, ok)    keep the result for `key` and announce it
 *   resultOf(key)                { text, ok } or null
 *   clearResult(key)             the next action on `key` begins: the old result goes
 *   showResultIn(el, key)        paints the result of `key` into a result element (`data-corn="result"`), hidden when there is none
 */

import { announce } from './keyboard.js';

/** How long a result with no next action to end it stays (ms): at least five seconds */
export const RESULT_MS = 6000;

const results = new Map();

/** Keeps the result of an action under `key` and announces it through the live region */
export function sayResult(key, text, ok = true) {
  results.set(key, { text, ok });
  announce(text);
}

/** The result kept under `key`, or null */
export function resultOf(key) {
  return results.get(key) || null;
}

/** The next action on `key` begins: its old result goes */
export function clearResult(key) {
  results.delete(key);
}

/** Paints the result of `key` into `el` (a result element), hidden when there is none */
export function showResultIn(el, key) {
  if (!el) return;
  const r = results.get(key);
  el.hidden = !r;
  el.textContent = r ? r.text : '';
  if (r) el.dataset.cornState = r.ok ? 'success' : 'failure'; else delete el.dataset.cornState;
}

/** For tests: forget every result */
export function resetFeedbackForTests() {
  results.clear();
}
