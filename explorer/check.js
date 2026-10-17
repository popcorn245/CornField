/**
 * @module explorer/check
 *
 * Checked scenarios in the page (spec 0029 sections 3 and 5, PHY-10; the pure half is
 * check-model.js). When a scenario opens, every check of every step goes to the checker (a plugin's
 * adapter, handed over by main.js) in ONE batch; each step then shows its state on the player bar,
 * and on the phone's sheet: a pill in the bar's head ("✕ Refused", seen on the peek too) and a line
 * under the step's text ("Refused: Only an adult can change the household's rooms (ADULT_ONLY_WRITES)").
 * The current step's node or edge is drawn red, green or amber (scene.js calls `paintVerdict` with the
 * verdict this module puts on the player's snapshot). The **As** menu (the personas on the map, what-if
 * ones too) acts every step as one persona and asks again; **Check again** asks again as it is.
 *
 * scenario-ui.js calls it at four points, and nothing else needs to:
 *
 *   openChecks(scenario, onChange)        a scenario opened: ask its batch
 *   decorateSnapshot(snap, scenario)      every sync: puts `verdict` (and the As actor) on the snapshot;
 *                                         asks again when what is asked changed (a what-if edit, the As menu)
 *   paintChecks(bar, snap)                every bar update (the controls go on the bar at its first paint)
 *   closeChecks()                         the scenario closed: cancel what is in flight
 *
 * A scenario that names an actor turns the People layer on, so its personas are on the map.
 * Nothing is stored: the answers live in memory for the scenario on the map, and go with it.
 */

import { state, escHtml } from './state.js';
import { toggleLayer } from './layers.js';
import { mapIndex, personaLabel, planChecks, runChecks, stepVerdict, verdictWords } from './check-model.js';

let checker = null;
let current = null; // { scenario, as, nodes, plan, answer, controller, onChange }
let version = 0;

/** Hands the tool its checker (main.js, from the plugin); none means every checked step reads "Not checked" */
export function initChecks(opts = {}) {
  checker = opts.checker || null;
}

/** Changes whenever a verdict may have: scenario-ui.js puts it in the player's signature, so an answer redraws the step */
export const checksVersion = () => version;

const namesActor = (scenario) => !!scenario && (!!scenario.actor || (Array.isArray(scenario.steps) && scenario.steps.some((s) => s && s.actor)));

/**
 * A scenario opened: its batch is asked.
 * @param {object} scenario
 * @param {() => void} onChange called when an answer arrives or the As menu moved (scenario-ui.js syncs and redraws)
 */
export function openChecks(scenario, onChange = () => {}) {
  closeChecks();
  current = { scenario: null, as: null, nodes: null, plan: null, answer: { status: 'idle' }, controller: null, onChange };
  if (namesActor(scenario) && state.activeLayers.persona !== true) toggleLayer('persona');
  replan(scenario);
}

/** The scenario closed: nothing more is asked or shown */
export function closeChecks() {
  if (current && current.controller) current.controller.abort();
  current = null;
  version++;
}

/** Plans the checks again when the scenario, the As persona or the map changed, and asks again when what is asked changed */
function replan(scenario, force = false) {
  const c = current;
  if (!c) return;
  if (!force && c.scenario === scenario && c.nodes === state.nodes && c.plan) return;
  const before = c.plan ? c.plan.key : null;
  c.scenario = scenario;
  c.nodes = state.nodes;
  c.plan = planChecks(scenario, mapIndex(state.nodes, state.edges), checker, { as: c.as });
  version++;
  if (force || c.plan.key !== before) ask();
}

/** Asks the scenario's one batch; an answer that arrives for a batch no longer on the map is dropped */
function ask() {
  const c = current;
  if (!c) return;
  if (c.controller) c.controller.abort();
  const items = c.plan.items;
  if (items.length === 0) { c.answer = { status: 'ok', results: new Map(), bad: new Map() }; version++; return; }
  const controller = new AbortController();
  c.controller = controller;
  c.answer = { status: 'pending' };
  version++;
  runChecks(checker, items, { signal: controller.signal }).then(
    ({ results, bad }) => settle(c, controller, { status: 'ok', results, bad }),
    (error) => { if (!controller.signal.aborted) settle(c, controller, { status: 'failed', error }); },
  );
}

function settle(c, controller, answer) {
  if (current !== c || c.controller !== controller) return;
  c.controller = null;
  c.answer = answer;
  version++;
  c.onChange();
}

/**
 * Puts the current step's verdict on the player's snapshot (`snap.verdict`, which scene.js draws) and,
 * while the As menu overrides it, the persona acting the step (`snap.current.actor`).
 * @param {object} snap the player's snapshot
 * @param {object} scenario the scenario the player plays (it changes with a what-if edit)
 */
export function decorateSnapshot(snap, scenario) {
  if (!current) return snap;
  replan(scenario);
  const plan = current.plan.steps[snap.index];
  snap.verdict = stepVerdict(plan, current.answer);
  if (current.as && plan && plan.actor) snap.current.actor = plan.actor;
  return snap;
}

/** The verdict for each step of the scenario on the map (for a test or a caller that wants the whole run) */
export function scenarioVerdicts() {
  if (!current || !current.plan) return [];
  return current.plan.steps.map((p) => stepVerdict(p, current.answer));
}

// ---------------------------------------------------------------------------
//  On the bar
// ---------------------------------------------------------------------------

/** The pill in the head, the line under the text, and the As row under the controls: only on the bar of a scenario that names an actor, so any other bar is as it was */
function mountControls(bar) {
  const head = bar.querySelector('.hx-player-head');
  const title = bar.querySelector('.hx-player-title');
  const pill = document.createElement('span');
  pill.className = 'hx-player-verdict';
  pill.hidden = true;
  if (head && title) title.after(pill); else bar.prepend(pill);

  const line = document.createElement('p');
  line.className = 'hx-player-check';
  line.setAttribute('aria-live', 'polite');
  line.hidden = true;
  const text = bar.querySelector('.hx-player-text');
  if (text) text.after(line); else bar.appendChild(line);

  const row = document.createElement('div');
  row.className = 'hx-player-as';
  row.innerHTML = `
    <label class="hx-player-as-label">As <select class="hx-player-speed hx-player-as-menu" data-check="as" aria-label="Act every step as"></select></label>
    <button type="button" class="hx-btn" data-check="recheck">Check again</button>
    <span class="hx-player-as-sum hx-faint"></span>`;
  const controls = bar.querySelector('.hx-player-controls');
  if (controls) controls.after(row); else bar.appendChild(row);

  row.querySelector('[data-check=as]').addEventListener('change', (e) => chooseActor(e.target.value));
  row.querySelector('[data-check=recheck]').addEventListener('click', recheck);
}

/** The As menu moved: every step acts as that persona ('' = as written), and the batch is asked again */
export function chooseActor(id) {
  if (!current) return;
  current.as = id || null;
  replan(current.scenario, true);
  current.onChange();
}

/** Check again: the same batch, asked again */
export function recheck() {
  if (!current) return;
  replan(current.scenario, true);
  current.onChange();
}

/** The personas on the map, what-if ones included, as the As menu's options */
function fillMenu(menu) {
  const personas = state.nodes.filter((n) => n.type === 'persona');
  const options = [{ value: '', label: 'As written' }, ...personas.map((p) => ({ value: p.id.replace(/^persona-/, ''), label: personaLabel(p) }))];
  const key = options.map((o) => `${o.value}\u0000${o.label}`).join('\u0001');
  if (menu.dataset.key !== key) {
    menu.innerHTML = options.map((o) => `<option value="${escHtml(o.value)}">${escHtml(o.label)}</option>`).join('');
    menu.dataset.key = key;
  }
  menu.value = current && current.as ? current.as : '';
}

/** What the batch found, in a few words: "4 checks · 1 refused" */
function summary() {
  const all = scenarioVerdicts();
  const asked = all.reduce((n, v) => n + v.checks.length, 0);
  if (!current || current.answer.status === 'pending') return asked ? `Checking ${asked}…` : '';
  if (current.answer.status === 'failed') return '';
  const refused = all.filter((v) => v.state === 'refused').length;
  const amber = all.filter((v) => v.mismatch).length;
  const parts = [`${asked} ${asked === 1 ? 'check' : 'checks'}`];
  if (refused) parts.push(`${refused} refused`);
  if (amber) parts.push(`${amber} not as expected`);
  return asked ? parts.join(' · ') : 'No permission questions';
}

/** Paints the step's state on the bar: called with every bar update */
export function paintChecks(bar, snap) {
  if (!bar || !current) return;
  if (!bar.querySelector('.hx-player-as')) {
    if (!namesActor(current.scenario)) return;
    mountControls(bar);
  }
  const pill = bar.querySelector('.hx-player-verdict');
  const line = bar.querySelector('.hx-player-check');
  const row = bar.querySelector('.hx-player-as');
  if (!pill || !line || !row) return;
  const words = verdictWords(snap.verdict);
  pill.hidden = !words;
  line.hidden = !words;
  if (words) {
    pill.dataset.tone = words.tone;
    pill.textContent = words.pill;
    pill.title = words.line;
    line.dataset.tone = words.tone;
    line.innerHTML = `${escHtml(words.line)}${words.detail ? ` <span class="hx-player-check-detail">${escHtml(words.detail)}</span>` : ''}`;
  }
  fillMenu(row.querySelector('[data-check=as]'));
  row.querySelector('[data-check=recheck]').disabled = current.answer.status === 'pending';
  row.querySelector('.hx-player-as-sum').textContent = summary();
}
