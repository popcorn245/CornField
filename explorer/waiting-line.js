/**
 * @module explorer/waiting-line
 *
 * The one line under the proposal bar's buttons when a run is waiting on the open proposal (spec 0010 D2): "A run is waiting on you: Plan
 * ready: approve to build, … · Answer". Answer opens Work on Runs at that run with its reply field focused (forge-panel.js). The line is its
 * own element, added after the bar's head once, so the bar's own markup is not touched. The runner's words are set as text, never as HTML.
 */

import { waitingLineWords } from './waiting-model.js';
import { t } from './strings.js';
import { announce } from './keyboard.js';

let line = null;
let saidFor = null;

/** The line, made on first use and kept after the bar's head; null when the bar is not on the page */
function mount() {
  const body = document.getElementById('proposal-body');
  if (!body) return null;
  if (line && line.isConnected) return line;
  line = document.createElement('p');
  line.className = 'hx-waiting-line';
  line.dataset.corn = 'waiting-line';
  line.dataset.cornState = 'waiting';
  line.hidden = true;
  line.innerHTML = '<span data-waiting-words></span> <button type="button" class="hx-btn hx-forge-act" data-waiting-answer data-peek-ok data-corn-kind="secondary"></button>';
  const head = body.querySelector('.hx-proposal-head');
  if (head) head.after(line); else body.append(line);
  return line;
}

/**
 * Shows the line for `run` (the run waiting on the open proposal), or hides it for null. The first time a run is shown for a proposal it is said
 * through the live region once; a repaint of the same run says nothing.
 * @param {{ runId: string, report?: { note?: string } | null } | null} run
 * @param {string | null} key what the line is about (the proposal), so a run is announced once for it
 */
export function paintWaitingLine(run, key) {
  const el = mount();
  if (!el) return;
  el.hidden = !run;
  if (!run) { saidFor = null; return; }
  const words = waitingLineWords(run);
  el.querySelector('[data-waiting-words]').textContent = words;
  const button = el.querySelector('[data-waiting-answer]');
  button.textContent = t('answer');
  button.dataset.waitingAnswer = run.runId;
  button.setAttribute('aria-label', `${t('answer')}: ${words}`);
  const said = `${key}|${run.runId}`;
  if (saidFor !== said) { saidFor = said; announce(words); }
}

/** For tests: forget the line */
export function resetWaitingLineForTests() {
  line = null;
  saidFor = null;
}
