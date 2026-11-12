/**
 * @module explorer/engine/checks
 *
 * Checked scenarios on an instance (spec 0029 sections 3 and 5, PHY-10; the pure half is check-model.js). When a scenario opens, every check of every
 * step goes to the checker (a plugin's adapter, handed to the piece by the host) in ONE batch; each step then shows its state on the player bar, and on
 * the phone's sheet: a pill in the bar's head ("✕ Refused", seen on the peek too) and a line under the step's text ("Refused: Only an adult can change
 * the household's rooms (ADULT_ONLY_WRITES)"). The current step's node or edge is drawn red, green or amber (scene.js calls `paintVerdict` with the
 * verdict this module puts on the player's snapshot). The **As** menu (the personas on the map, what-if ones too) acts every step as one persona and
 * asks again; **Check again** asks again as it is.
 *
 *   createChecks(inst) -> {
 *     setChecker(checker)           hands over the checker; none means every checked step reads "Not checked"
 *     open(scenario, onChange)      a scenario opened: ask its batch
 *     decorate(snap, scenario)      every sync: puts `verdict` (and the As actor) on the snapshot; asks again when what is asked changed
 *     paint(bar, snap)              every bar update (the controls go on the bar at its first paint)
 *     close()                       the scenario closed: cancel what is in flight
 *     version() / checkedScenarioId() / verdicts() / chooseActor(id) / recheck()
 *   }
 *
 * A scenario that names an actor turns the People layer on, so its personas are on the map. Nothing is stored: the answers live in memory for the
 * scenario on the map, and go with it.
 */

import { escapeHtml as escHtml } from '../../core/text.js';
import { setLayer } from './layers.js';
import { layersOf } from '../layer-model.js';
import { mapIndex, personaLabel, planChecks, runChecks, stepVerdict, verdictWords } from '../check-model.js';
import { cornState } from '../corn-state.js';
import { addParts } from './piece.js';

const namesActor = (scenario) => !!scenario && (!!scenario.actor || (Array.isArray(scenario.steps) && scenario.steps.some((s) => s && s.actor)));

/**
 * @param {ReturnType<import('../instance.js').createInstance>} inst
 * @param {{ checker?: object | null }} [opts]
 */
export function createChecks(inst, opts = {}) {
  const { state } = inst;
  let checker = opts.checker || null;
  let current = null; // { scenario, as, nodes, plan, answer, controller, onChange }
  let version = 0;
  /** The words last written into each player's check line (paint) */
  const lineHtml = new WeakMap();
  /** What takes the listeners off the controls on the bar (the bar goes with them, but a listener is held until it is taken back) */
  let controlOffs = [];

  function close() {
    if (current && current.controller) current.controller.abort();
    current = null;
    version++;
  }

  function setChecker(next) {
    next = next || null;
    if (next !== checker) close(); // answers asked of another checker are not this one's
    checker = next;
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

  /**
   * A scenario opened: its batch is asked.
   * @param {object} scenario
   * @param {() => void} onChange called when an answer arrives or the As menu moved (the player syncs and redraws)
   */
  function open(scenario, onChange = () => {}) {
    // the scenario that is already being checked (opened in the list, now played): its answers stay, only who is told changes
    if (current && current.scenario && scenario && current.scenario.id === scenario.id) { current.onChange = onChange; replan(scenario); return; }
    close();
    current = { scenario: null, as: null, nodes: null, plan: null, answer: { status: 'idle' }, controller: null, onChange };
    if (namesActor(scenario) && layersOf(state).persona !== true) setLayer(inst, 'persona', true, { scenario: true });
    replan(scenario);
  }

  /** Puts the current step's verdict on the player's snapshot (`snap.verdict`, which scene.js draws) and, while the As menu overrides it, the persona acting the step */
  function decorate(snap, scenario) {
    if (!current) return snap;
    replan(scenario);
    const plan = current.plan.steps[snap.index];
    snap.verdict = stepVerdict(plan, current.answer);
    if (current.as && plan && plan.actor) snap.current.actor = plan.actor;
    return snap;
  }

  /** The verdict for each step of the scenario on the map (for a test or a caller that wants the whole run) */
  function verdicts() {
    if (!current || !current.plan) return [];
    return current.plan.steps.map((p) => stepVerdict(p, current.answer));
  }

  /** The As menu moved: every step acts as that persona ('' = as written), and the batch is asked again */
  function chooseActor(id) {
    if (!current) return;
    current.as = id || null;
    replan(current.scenario, true);
    current.onChange();
  }

  /** Check again: the same batch, asked again */
  function recheck() {
    if (!current) return;
    replan(current.scenario, true);
    current.onChange();
  }

  /** The pill in the head, the line under the text, and the As row under the controls: only on the bar of a scenario that names an actor, so any other bar is as it was */
  function mountControls(bar) {
    const doc = inst.doc;
    // the pill ends the step's line; the reason is a line of its own under the bar's row, with the As row (the player is one bar: spec 0006 D6)
    const pill = doc.createElement('span');
    pill.className = 'hx-player-verdict';
    pill.dataset.corn = 'state-pill';
    pill.hidden = true;
    const text = bar.querySelector('.hx-player-text');
    if (text) text.append(' ', pill); else bar.prepend(pill);

    const line = doc.createElement('p');
    line.className = 'hx-player-check';
    line.dataset.corn = 'scenario-check';
    line.hidden = true;

    const row = doc.createElement('div');
    row.className = 'hx-player-as';
    row.innerHTML = `
    <label class="hx-player-as-label">As <select data-corn="control" class="hx-player-speed hx-player-as-menu" data-check="as" aria-label="Act every step as"></select></label>
    <button data-corn-kind="secondary" type="button" class="hx-btn" data-check="recheck">Check again</button>
    <span class="hx-player-as-sum hx-faint"></span>`;
    const track = bar.querySelector('.hx-player-track');
    if (track) { track.before(line); track.before(row); } else { bar.appendChild(line); bar.appendChild(row); }
    for (const el of [pill, line, row]) { if (el.hasAttribute('data-corn')) el.setAttribute('part', el.getAttribute('data-corn')); }
    addParts(row);

    const menu = row.querySelector('[data-check=as]');
    const again = row.querySelector('[data-check=recheck]');
    const onMenu = (e) => chooseActor(e.target.value);
    menu.addEventListener('change', onMenu);
    again.addEventListener('click', recheck);
    controlOffs.push(() => { menu.removeEventListener('change', onMenu); again.removeEventListener('click', recheck); });
  }

  /** The bar goes: its controls let go of their listeners */
  function unmount() {
    const offs = controlOffs;
    controlOffs = [];
    offs.forEach((off) => off());
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
    const all = verdicts();
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
  function paint(bar, snap) {
    if (!bar || !current) return;
    if (!bar.querySelector('.hx-player-as')) {
      if (!namesActor(current.scenario)) return;
      mountControls(bar);
    }
    const pill = bar.querySelector('.hx-player-verdict');
    const line = bar.querySelector('.hx-player-check');
    const row = bar.querySelector('.hx-player-as');
    if (!pill || !line || !row) return;
    const words = snap.done ? null : verdictWords(snap.verdict); // at the end there is no step to say a verdict of
    pill.hidden = !words;
    line.hidden = !words;
    if (words) {
      pill.dataset.tone = words.tone;
      if (cornState(words.tone)) pill.dataset.cornState = cornState(words.tone); else delete pill.dataset.cornState;
      pill.textContent = words.pill;
      pill.title = words.line;
      line.dataset.tone = words.tone;
      // painted every frame: the live line is rewritten only when its words change, so a verdict is said once
      const html = `${escHtml(words.line)}${words.detail ? ` <span class="hx-player-check-detail">${escHtml(words.detail)}</span>` : ''}`;
      if (lineHtml.get(line) !== html) { lineHtml.set(line, html); line.innerHTML = html; }
    }
    fillMenu(row.querySelector('[data-check=as]'));
    row.querySelector('[data-check=recheck]').disabled = current.answer.status === 'pending';
    row.querySelector('.hx-player-as-sum').textContent = summary();
  }

  return {
    setChecker,
    open,
    close,
    decorate,
    paint,
    unmount,
    verdicts,
    chooseActor,
    recheck,
    version: () => version,
    checkedScenarioId: () => (current && current.scenario ? current.scenario.id : null),
  };
}
