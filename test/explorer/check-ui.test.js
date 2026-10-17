// @vitest-environment happy-dom
/**
 * Checked scenarios in a DOM (PHY-10, spec 0029 sections 3 and 5): a scenario that names an actor
 * asks its checks in one batch when it opens, shows each step's state on the player bar (a pill in the
 * head, a line under the text), draws the step red or green on the map, offers the As menu (the
 * personas on the map) that acts every step as one persona and asks again, turns the People layer on,
 * and leaves a scenario with no actor exactly as it was. The checker is a fake; the real one is driven
 * end to end in check-e2e.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { clearScenario, initScenarioUi, playScenario, getPlayer } from '../../explorer/scenario-ui.js';
// @ts-expect-error plain JS modules, no declarations
import { initChecks, scenarioVerdicts } from '../../explorer/check.js';
// @ts-expect-error plain JS modules, no declarations
import { VERDICT_COLOR, checkError } from '../../explorer/check-model.js';

const node = (id        , type        , extra         = {}) => ({ id, type, x: 100, y: 100, r: 20, color: '#38bdf8', label: id, ...extra });
const nodes = [
  node('root', 'root'), node('app-api', 'app'), node('app-tasks', 'app'),
  node('page-scan', 'page', { label: '/scan' }),
  node('page-rooms-id', 'page', { label: '/api/v1/rooms/[id]', methods: ['GET', 'PATCH'] }),
  node('table-rooms', 'table', { table: 'rooms', label: 'rooms', color: '#fde047' }),
  node('table-tasks', 'table', { table: 'tasks', label: 'tasks', color: '#fde047' }),
  node('persona-admin', 'persona', { label: 'Admin', role: 'admin' }),
  node('persona-adult', 'persona', { label: 'Adult', role: 'adult', groups: ['family'] }),
  node('persona-child', 'persona', { label: 'Child', role: 'child', groups: ['family'] }),
];
const edges = [
  { from: 'root', to: 'app-api' }, { from: 'root', to: 'app-tasks' }, { from: 'app-api', to: 'page-rooms-id' }, { from: 'app-tasks', to: 'page-scan' },
  { from: 'page-scan', to: 'table-tasks', kind: 'writes' }, { from: 'page-rooms-id', to: 'table-rooms', kind: 'writes' },
];
const scenario = () => ({
  id: 'child-rooms', title: 'A child tries to change a room', actor: 'child', stepMs: 1000,
  steps: [
    { node: 'page-scan', text: 'She scans.' },
    { edge: { from: 'page-scan', to: 'table-tasks', kind: 'writes' }, check: { table: 'tasks', op: 'write', row: 'household' }, expect: 'allowed', text: 'She adds a task.' },
    { edge: { from: 'page-rooms-id', to: 'table-rooms', kind: 'writes' }, check: { route: '/api/v1/rooms/[id]', method: 'PATCH' }, expect: 'refused', text: 'She tries to move the kitchen.' },
  ],
});

/** A checker that answers like the route: a child may not change rooms, anyone may add a task */
function fakeChecker(fail          = null) {
  let release             = () => {};
  const gate = { held: false };
  const check = vi.fn(async (items       ) => {
    if (gate.held) await new Promise      ((r) => { release = r; });
    if (fail) throw fail;
    return items.map((c) => (c.route && c.actor.role === 'child'
      ? { id: c.id, allowed: false, status: 403, reason: 'Only an adult can change the household\'s rooms', rule: 'ADULT_ONLY_WRITES', checked: ['gate', 'table'] }
      : { id: c.id, allowed: true, status: 200, reason: null, checked: ['gate', 'table', 'row'] }));
  });
  return { checker: { name: 'fake', apps: ['app-api'], check }, check, hold: () => { gate.held = true; }, release: () => { gate.held = false; release(); } };
}

const q = (sel        ) => document.querySelector(sel)               ;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const go = (i        ) => { getPlayer().goTo(i); getPlayer().pause(); (q('[data-action=scenario-toggle]')                     ).click(); (q('[data-action=scenario-toggle]')                     ).click(); };
const sceneEdge = (from        , to        ) => render.getScene().edges.find((e     ) => e.from === from && e.to === to);

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  document.body.innerHTML = '<div class="hx-stage"><canvas id="graph-canvas"></canvas></div>';
  state.canvas = document.getElementById('graph-canvas');
  state.nodes = structuredClone(nodes);
  state.edges = structuredClone(edges);
  state.width = 800;
  state.height = 600;
  state.camera = { x: 0, y: 0, zoom: 1 };
  state.scenario = null;
  state.activeLayers.persona = false;
  render.setRenderer({ kind: 'stub', draw() {}, resize() {}, destroy() {} });
  initScenarioUi();
  clearScenario();
});
afterEach(() => { clearScenario(); vi.unstubAllGlobals(); });

describe('a scenario that names an actor', () => {
  it('asks every check of every step in one request when it opens, as its actor', async () => {
    const fake = fakeChecker();
    initChecks({ checker: fake.checker });
    playScenario(scenario(), { autoplay: false });
    await settle();
    expect(fake.check).toHaveBeenCalledTimes(1);
    expect(fake.check.mock.calls[0][0]).toEqual([
      { id: 's2-1', table: 'tasks', op: 'write', row: 'household', actor: { role: 'child', groups: ['family'] } },
      { id: 's3-1', route: '/api/v1/rooms/[id]', method: 'PATCH', actor: { role: 'child', groups: ['family'] } },
    ]);
    expect(scenarioVerdicts().map((v     ) => v.state)).toEqual(['unchecked', 'allowed', 'refused']);
  });

  it('turns the People layer on', () => {
    initChecks({ checker: fakeChecker().checker });
    playScenario(scenario(), { autoplay: false });
    expect(state.activeLayers.persona).toBe(true);
  });

  it('shows a refused step on the bar with the production reason and rule, and draws its edge red', async () => {
    initChecks({ checker: fakeChecker().checker });
    playScenario(scenario(), { autoplay: false });
    await settle();
    go(2);
    expect(q('.hx-player-verdict').textContent).toBe('✕ Refused');
    expect(q('.hx-player-verdict').dataset.tone).toBe('refused');
    expect(q('.hx-player-check').textContent).toContain('Refused: Only an adult can change the household\'s rooms (ADULT_ONLY_WRITES)');
    expect(q('.hx-player-check').textContent).toContain('PATCH /api/v1/rooms/[id] as Child');
    expect(sceneEdge('page-rooms-id', 'table-rooms').color).toBe(VERDICT_COLOR.refused);
    go(1);
    expect(q('.hx-player-verdict').textContent).toBe('✓ Allowed');
    expect(sceneEdge('page-scan', 'table-tasks').color).toBe(VERDICT_COLOR.allowed);
    go(0);
    expect(q('.hx-player-check').textContent).toContain('Not checked: nothing in this step to ask');
  });

  it('says Checking while it asks, and redraws the step when the answer comes', async () => {
    const fake = fakeChecker();
    fake.hold();
    initChecks({ checker: fake.checker });
    playScenario(scenario(), { autoplay: false });
    go(2);
    expect(q('.hx-player-verdict').textContent).toBe('Checking…');
    const before = state.sceneVersion;
    fake.release();
    await settle();
    expect(q('.hx-player-verdict').textContent).toBe('✕ Refused');
    expect(state.sceneVersion).toBeGreaterThan(before);
  });

  it('says not checked, live layer unavailable, when the checker cannot answer, and plays on', async () => {
    initChecks({ checker: fakeChecker(checkError('unavailable')).checker });
    playScenario(scenario(), { autoplay: false });
    await settle();
    go(2);
    expect(q('.hx-player-verdict').textContent).toBe('Unavailable');
    expect(q('.hx-player-check').textContent).toContain('Not checked: live layer unavailable (the checker is not answering)');
    expect(sceneEdge('page-rooms-id', 'table-rooms').color).not.toBe(VERDICT_COLOR.refused);
    (q('[data-action=scenario-next]')                     ).click(); // it plays on
    expect(getPlayer().snapshot().done).toBe(true);
    initChecks({ checker: null });
    playScenario(scenario(), { autoplay: false });
    await settle();
    go(1);
    expect(q('.hx-player-check').textContent).toContain('Not checked: live layer unavailable (no permission checker)');
  });
});

describe('the As menu', () => {
  it('lists the personas on the map, what-if ones too, after As written', () => {
    initChecks({ checker: fakeChecker().checker });
    state.nodes.push(node('persona-teen', 'persona', { label: 'Teen', role: 'child', groups: [] }));
    playScenario(scenario(), { autoplay: false });
    const menu = q('[data-check=as]')                     ;
    expect([...menu.options].map((o) => o.textContent)).toEqual(['As written', 'Admin', 'Adult', 'Child', 'Teen']);
    expect(menu.value).toBe('');
  });

  it('acts every step as the chosen persona and asks again: an adult may change the room, so the step turns amber', async () => {
    const fake = fakeChecker();
    initChecks({ checker: fake.checker });
    playScenario(scenario(), { autoplay: false });
    await settle();
    go(2);
    const menu = q('[data-check=as]')                     ;
    menu.value = 'adult';
    menu.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(fake.check).toHaveBeenCalledTimes(2);
    expect(fake.check.mock.calls[1][0].every((c     ) => c.actor.role === 'adult')).toBe(true);
    expect(q('.hx-player-verdict').textContent).toBe('Expected refused');
    expect(q('.hx-player-check').textContent).toContain('Expected refused, but allowed');
    expect(sceneEdge('page-rooms-id', 'table-rooms').color).toBe(VERDICT_COLOR.mismatch);
    expect(state.scenario.current.actor).toBe('adult');
    expect(q('.hx-player-as-sum').textContent).toBe('2 checks · 1 not as expected');
  });

  it('asks again on Check again', async () => {
    const fake = fakeChecker();
    initChecks({ checker: fake.checker });
    playScenario(scenario(), { autoplay: false });
    await settle();
    (q('[data-check=recheck]')                     ).click();
    await settle();
    expect(fake.check).toHaveBeenCalledTimes(2);
    expect(q('.hx-player-as-sum').textContent).toBe('2 checks · 1 refused');
  });
});

describe('a scenario with no actor', () => {
  it('asks nothing, shows nothing new on its bar, and leaves the People layer and the colours alone', async () => {
    const fake = fakeChecker();
    initChecks({ checker: fake.checker });
    const plain = { ...scenario(), actor: undefined };
    playScenario(plain, { autoplay: false });
    await settle();
    go(2);
    expect(fake.check).not.toHaveBeenCalled();
    expect(q('.hx-player-verdict')).toBeNull();
    expect(q('.hx-player-as')).toBeNull();
    expect(state.activeLayers.persona).toBe(false);
    expect(sceneEdge('page-rooms-id', 'table-rooms').color).not.toBe(VERDICT_COLOR.refused);
  });
});
