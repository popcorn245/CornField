/**
 * @vitest-environment node
 *
 * Checked scenarios, the pure half (spec 0029 sections 3 and 5, PHY-10): from a step to its
 * checks, one batch per scenario, the batch asked through a checker, each step's verdict (allowed,
 * refused with the production reason and rule, not checked, unavailable, amber on a broken `expect`),
 * the words on the bar, and the colours on the map.
 */
import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { actorOf, checkError, mapIndex, paintVerdict, personaFor, planChecks, runChecks, stepChecks, stepVerdict, verdictWords, VERDICT_COLOR } from '../../explorer/check-model.js';

const node = (id        , type        , extra         = {}) => ({ id, type, label: id, ...extra });
const nodes = [
  node('root', 'root'),
  node('app-api', 'app'), node('app-tasks', 'app'),
  node('page-rooms-id', 'page', { label: '/api/v1/rooms/[id]', methods: ['DELETE', 'GET', 'PATCH', 'PUT'] }),
  node('page-check', 'page', { label: '/api/v1/world/check', methods: ['POST'] }),
  node('page-scan', 'page', { label: '/scan' }),
  node('page-tasks-api', 'page', { label: '/api/odd', methods: ['GET'] }),
  node('table-rooms', 'table', { label: 'rooms', table: 'rooms' }),
  node('table-tasks', 'table', { label: 'tasks', table: 'tasks' }),
  node('persona-admin', 'persona', { label: 'Admin', role: 'admin' }),
  node('persona-adult', 'persona', { label: 'Adult · 2 people', codeLabel: 'Adult', role: 'adult', groups: ['family'] }),
  node('persona-child', 'persona', { label: 'Child', role: 'child', groups: ['family'] }),
  node('persona-guest', 'persona', { label: 'Guest (no account)', account: false }),
];
const edges = [
  { from: 'root', to: 'app-api' }, { from: 'root', to: 'app-tasks' },
  { from: 'app-api', to: 'page-rooms-id' }, { from: 'app-api', to: 'page-check' },
  { from: 'app-tasks', to: 'page-scan' }, { from: 'app-tasks', to: 'page-tasks-api' },
  { from: 'page-rooms-id', to: 'table-rooms', kind: 'writes' },
  { from: 'table-rooms', to: 'page-rooms-id', kind: 'reads' },
];
const index = mapIndex(nodes, edges);
const checker = { name: 'test', apps: ['app-api'], check: vi.fn() };

describe('from a step to its checks', () => {
  it('takes the step\'s own check, one or a list, and [] as no question', () => {
    expect(stepChecks({ node: 'page-scan', check: { table: 'tasks', op: 'write', row: 'household' } }, index, checker)).toEqual([{ table: 'tasks', op: 'write', row: 'household' }]);
    expect(stepChecks({ node: 'page-scan', check: [{ route: '/a', method: 'GET' }, { route: '/b', method: 'POST' }] }, index, checker)).toHaveLength(2);
    expect(stepChecks({ node: 'page-rooms-id', check: [] }, index, checker)).toEqual([]);
  });

  it('asks an endpoint the checker understands by its label: GET when it has GET, else its first method', () => {
    expect(stepChecks({ node: 'page-rooms-id' }, index, checker)).toEqual([{ route: '/api/v1/rooms/[id]', method: 'GET' }]);
    expect(stepChecks({ node: 'page-check' }, index, checker)).toEqual([{ route: '/api/v1/world/check', method: 'POST' }]);
  });

  it('asks nothing about a page outside the checker\'s apps, a page with no methods, or a node that is no page', () => {
    expect(stepChecks({ node: 'page-tasks-api' }, index, checker)).toEqual([]);
    expect(stepChecks({ node: 'page-scan' }, index, checker)).toEqual([]);
    expect(stepChecks({ node: 'table-rooms' }, index, checker)).toEqual([]);
    expect(stepChecks({ node: 'nowhere' }, index, checker)).toEqual([]);
    // a checker that names no apps understands any page with methods
    expect(stepChecks({ node: 'page-tasks-api' }, index, { check: vi.fn() })).toEqual([{ route: '/api/odd', method: 'GET' }]);
  });

  it('asks a write on a writes edge into a table and a read on a reads edge from one', () => {
    expect(stepChecks({ edge: { from: 'page-rooms-id', to: 'table-rooms', kind: 'writes' } }, index, checker)).toEqual([{ table: 'rooms', op: 'write' }]);
    expect(stepChecks({ edge: { from: 'table-rooms', to: 'page-rooms-id', kind: 'reads' } }, index, checker)).toEqual([{ table: 'rooms', op: 'read' }]);
    // a table the map does not hold (a proposal's sketch) by its id
    expect(stepChecks({ edge: { from: 'page-x', to: 'table-sets', kind: 'writes' } }, index, checker)).toEqual([{ table: 'sets', op: 'write' }]);
  });

  it('asks nothing on any other edge', () => {
    expect(stepChecks({ edge: { from: 'stack-a', to: 'machine-b', kind: 'runs-on' } }, index, checker)).toEqual([]);
    expect(stepChecks({ edge: { from: 'root', to: 'app-api' } }, index, checker)).toEqual([]);
    expect(stepChecks({ edge: { from: 'page-rooms-id', to: 'page-scan', kind: 'writes' } }, index, checker)).toEqual([]);
  });
});

describe('the actor', () => {
  it('is the persona node of the id, a what-if one too', () => {
    expect(personaFor(nodes, 'child').id).toBe('persona-child');
    expect(personaFor([...nodes, node('persona-teen', 'persona', { role: 'child', groups: [] })], 'teen').id).toBe('persona-teen');
    expect(personaFor(nodes, 'nobody')).toBeNull();
  });

  it('asks as a role and groups, or as no account', () => {
    expect(actorOf(personaFor(nodes, 'child'))).toEqual({ role: 'child', groups: ['family'] });
    expect(actorOf(personaFor(nodes, 'admin'))).toEqual({ role: 'admin', groups: [] });
    expect(actorOf(personaFor(nodes, 'guest'))).toEqual({ account: false });
  });
});

const scenario = {
  id: 'child-rooms',
  title: 'A child tries to change a room',
  actor: 'child',
  steps: [
    { node: 'page-scan', text: 'She scans.' },
    { edge: { from: 'page-scan', to: 'table-tasks', kind: 'writes' }, check: { table: 'tasks', op: 'write', row: 'household' }, expect: 'allowed', text: 'A task.' },
    { node: 'page-check', check: [], text: 'The route.' },
    { edge: { from: 'page-rooms-id', to: 'table-rooms', kind: 'writes' }, check: { route: '/api/v1/rooms/[id]', method: 'PATCH' }, expect: 'refused', text: 'Refused.' },
    { node: 'page-rooms-id', actor: 'adult', text: 'An adult reads it.' },
  ],
};

describe('one batch per scenario', () => {
  it('plans every step and puts all their checks in one list, each with its step\'s id and actor', () => {
    const plan = planChecks(scenario, index, checker);
    expect(plan.steps.map((s     ) => s.kind)).toEqual(['unchecked', 'ask', 'unchecked', 'ask', 'ask']);
    expect(plan.steps[0].why).toBe('nothing in this step to ask');
    expect(plan.steps[2].why).toBe('this step is not a permission question');
    expect(plan.items).toEqual([
      { id: 's2-1', table: 'tasks', op: 'write', row: 'household', actor: { role: 'child', groups: ['family'] } },
      { id: 's4-1', route: '/api/v1/rooms/[id]', method: 'PATCH', actor: { role: 'child', groups: ['family'] } },
      { id: 's5-1', route: '/api/v1/rooms/[id]', method: 'GET', actor: { role: 'adult', groups: ['family'] } },
    ]);
    expect(plan.steps[4].actorLabel).toBe('Adult'); // the persona's own label, not the live count
  });

  it('acts every step as the As menu\'s persona', () => {
    const plan = planChecks(scenario, index, checker, { as: 'adult' });
    expect(new Set(plan.items.map((i     ) => JSON.stringify(i.actor)))).toEqual(new Set([JSON.stringify({ role: 'adult', groups: ['family'] })]));
    expect(plan.key).not.toBe(planChecks(scenario, index, checker).key);
  });

  it('checks nothing in a scenario with no actor, and says so for an unknown persona', () => {
    const plain = planChecks({ ...scenario, actor: undefined, steps: scenario.steps.slice(0, 4) }, index, checker);
    expect(plain.items).toEqual([]);
    expect(plain.steps.every((s     ) => s.kind === 'none')).toBe(true);
    const ghost = planChecks({ ...scenario, actor: 'ghost' }, index, checker);
    expect(ghost.steps[1]).toMatchObject({ kind: 'unchecked', why: 'no persona "ghost" on the map' });
  });
});

describe('asking the batch', () => {
  const items = Array.from({ length: 230 }, (_, i) => ({ id: `s${i}-1`, table: 'tasks', op: 'read', actor: { role: 'adult', groups: [] } }));
  const allow = (list       ) => list.map((c) => ({ id: c.id, allowed: true, status: 200, reason: null, checked: ['gate'] }));

  it('sends one request for a scenario, and splits only past the checker\'s limit', async () => {
    const check = vi.fn(async (list       ) => allow(list));
    const { results } = await runChecks({ check }, items.slice(0, 3));
    expect(check).toHaveBeenCalledTimes(1);
    expect(results.size).toBe(3);
    check.mockClear();
    const many = await runChecks({ check }, items);
    expect(check.mock.calls.map((c) => c[0].length)).toEqual([100, 100, 30]);
    expect(many.results.size).toBe(230);
  });

  it('leaves out a check the checker refuses as malformed and asks the rest again', async () => {
    const check = vi.fn(async (list       ) => {
      if (list.some((c) => c.id === 's1-1')) throw checkError('bad-check', { checkId: 's1-1', message: 'unknown table "sets"' });
      return allow(list);
    });
    const { results, bad } = await runChecks({ check }, items.slice(0, 3));
    expect([...results.keys()]).toEqual(['s0-1', 's2-1']);
    expect(bad.get('s1-1')).toBe('unknown table "sets"');
  });

  it('throws when the checker cannot answer, or there is none', async () => {
    await expect(runChecks({ check: async () => { throw checkError('unavailable'); } }, items.slice(0, 1))).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(runChecks(null, items.slice(0, 1))).rejects.toMatchObject({ reason: 'no-checker' });
  });
});

describe('a step\'s verdict', () => {
  const plan = planChecks(scenario, index, checker);
  const answered = (over                         = {}) => ({
    status: 'ok',
    results: new Map(Object.entries({
      's2-1': { id: 's2-1', allowed: true, status: 200, reason: null, checked: ['gate', 'table', 'row'] },
      's4-1': { id: 's4-1', allowed: false, status: 403, reason: 'Only an adult can change the household\'s rooms', rule: 'ADULT_ONLY_WRITES', checked: ['gate', 'table'] },
      's5-1': { id: 's5-1', allowed: true, status: 200, reason: null, checked: ['gate', 'table', 'row'] },
      ...over,
    })),
    bad: new Map(),
  });

  it('is allowed when every check passed, refused with the production reason and rule when one did not', () => {
    expect(stepVerdict(plan.steps[1], answered())).toMatchObject({ state: 'allowed', mismatch: false, actor: 'Child' });
    expect(stepVerdict(plan.steps[3], answered())).toMatchObject({ state: 'refused', mismatch: false, reason: 'Only an adult can change the household\'s rooms', rule: 'ADULT_ONLY_WRITES' });
  });

  it('turns amber when the answer is not what the step expects', () => {
    const flipped = answered({ 's4-1': { id: 's4-1', allowed: true, status: 200, reason: null, checked: ['gate'] } });
    expect(stepVerdict(plan.steps[3], flipped)).toMatchObject({ state: 'allowed', mismatch: true, expect: 'refused' });
  });

  it('is pending while asked, unavailable when the checker did not answer, not checked with nothing to ask, nothing with no actor', () => {
    expect(stepVerdict(plan.steps[1], { status: 'pending' }).state).toBe('pending');
    expect(stepVerdict(plan.steps[1], { status: 'failed', error: checkError('unavailable') })).toMatchObject({ state: 'unavailable', why: 'the checker is not answering' });
    expect(stepVerdict(plan.steps[1], { status: 'failed', error: checkError('no-token', { hint: 'set one on the board' }) }).why).toBe('no token (set one on the board)');
    expect(stepVerdict(plan.steps[2], answered())).toMatchObject({ state: 'unchecked', why: 'this step is not a permission question' });
    expect(stepVerdict({ index: 0, actor: null, kind: 'none', checks: [] }, answered()).state).toBe('none');
    const bad = { ...answered(), bad: new Map([['s2-1', 'unknown table "tasks"']]) };
    expect(stepVerdict(plan.steps[1], bad)).toMatchObject({ state: 'unchecked', why: 'unknown table "tasks"' });
  });
});

describe('the words on the bar and the sheet', () => {
  const v = (extra        ) => ({ mismatch: false, actor: 'Child', checks: [{ route: '/api/v1/rooms/[id]', method: 'PATCH' }], ...extra });
  it('says each of the four states, and the amber one', () => {
    expect(verdictWords(v({ state: 'refused', reason: 'Only an adult can change the household\'s rooms', rule: 'ADULT_ONLY_WRITES' }))).toEqual({
      tone: 'refused', pill: '✕ Refused', line: 'Refused: Only an adult can change the household\'s rooms (ADULT_ONLY_WRITES)', detail: 'PATCH /api/v1/rooms/[id] as Child',
    });
    expect(verdictWords(v({ state: 'allowed' }))).toMatchObject({ tone: 'allowed', pill: '✓ Allowed', line: 'Allowed' });
    expect(verdictWords(v({ state: 'unchecked', why: 'this step is not a permission question', checks: [] }))).toMatchObject({ tone: 'unchecked', pill: 'Not checked', line: 'Not checked: this step is not a permission question', detail: 'As Child' });
    expect(verdictWords(v({ state: 'unavailable', why: 'the live source is not answering' }))).toMatchObject({ tone: 'unavailable', pill: 'Unavailable', line: 'Not checked: live layer unavailable (the live source is not answering)' });
    expect(verdictWords(v({ state: 'allowed', mismatch: true, expect: 'refused' }))).toMatchObject({ tone: 'mismatch', pill: 'Expected refused', line: 'Expected refused, but allowed' });
    expect(verdictWords(v({ state: 'none' }))).toBeNull();
  });
});

describe('the colours on the map', () => {
  const scene = () => ({
    nodes: [{ id: 'page-rooms-id', color: '#38bdf8', glow: 6 }, { id: 'table-rooms', color: '#fde047', glow: 6 }],
    edges: [
      { key: 'page-rooms-id->table-rooms|writes', from: 'page-rooms-id', to: 'table-rooms', kind: 'writes', color: '#fde047', glow: 0, packet: { glowColor: '#fde047' } },
      { key: 'table-rooms->page-rooms-id|reads', from: 'table-rooms', to: 'page-rooms-id', kind: 'reads', color: '#38bdf8', glow: 0 },
    ],
  });
  const snap = (verdict        , current        ) => ({ done: false, current, verdict });

  it('draws a refused edge step red, packet and all, and leaves the other edges', () => {
    const s = scene();
    paintVerdict(s, snap({ state: 'refused', mismatch: false }, { edge: { from: 'page-rooms-id', to: 'table-rooms', kind: 'writes' } }));
    expect(s.edges[0]).toMatchObject({ color: VERDICT_COLOR.refused, glowColor: VERDICT_COLOR.refused, packet: { glowColor: VERDICT_COLOR.refused, speed: 0, phase: 0.5 } });
    expect(VERDICT_COLOR.refused).not.toBe('#f87171'); // a write edge's own colour
    expect(s.edges[0].glow).toBeGreaterThan(0);
    expect(s.edges[1].color).toBe('#38bdf8');
  });

  it('draws an allowed node step green and a broken expectation amber', () => {
    const s = scene();
    paintVerdict(s, snap({ state: 'allowed', mismatch: false }, { node: 'page-rooms-id' }));
    expect(s.nodes[0].color).toBe(VERDICT_COLOR.allowed);
    const t = scene();
    paintVerdict(t, snap({ state: 'refused', mismatch: true }, { node: 'page-rooms-id' }));
    expect(t.nodes[0].color).toBe(VERDICT_COLOR.mismatch);
  });

  it('leaves a step that was not checked, a finished walk, and a snapshot with no verdict as they are', () => {
    for (const v of [{ state: 'unchecked' }, { state: 'unavailable' }, { state: 'pending' }]) {
      const s = scene();
      paintVerdict(s, snap({ ...v, mismatch: false }, { node: 'page-rooms-id' }));
      expect(s).toEqual(scene());
    }
    const s = scene();
    paintVerdict(s, { done: true, current: { node: 'page-rooms-id' }, verdict: { state: 'refused', mismatch: false } });
    paintVerdict(s, { done: false, current: { node: 'page-rooms-id' } });
    expect(s).toEqual(scene());
  });
});
