/**
 * @vitest-environment node
 *
 * The review column's lists, the pure half (spec 0006 D2, D4): scenarios grouped by who acts in them, Anyone last, the
 * personas no scenario uses, step rows with their node, mark and verdict words, and the record of what was seen.
 */
import { describe, it, expect } from 'vitest';
import { buildScenarioList, currentStepSentence, changeRows, actorsOf, stepVerdictWords, stepSentence, reviewCounts, reviewOpenedWords, safeKey, seenKey, readSeen, writeSeen } from '../../explorer/scenario-list-model.js';

const nodes = [
  { id: 'persona-adult', type: 'persona', label: 'Adult', mark: 'none' },
  { id: 'persona-child', type: 'persona', label: 'Child', mark: 'none' },
  { id: 'persona-guest', type: 'persona', label: 'Guest (no account)', mark: 'none' },
  { id: 'persona-admin', type: 'persona', label: 'Admin', mark: 'none' },
  { id: 'page-cart', type: 'page', label: 'cart page', mark: 'changed' },
  { id: 'page-pay', type: 'page', label: 'checkout page', mark: 'added' },
  { id: 'table-orders', type: 'table', label: 'orders table', mark: 'none' },
  { id: 'page-old', type: 'page', label: 'old page', mark: 'removed' },
];
const edges = [
  { from: 'page-pay', to: 'table-orders', kind: 'writes', mark: 'added' },
  { from: 'root', to: 'page-pay', mark: 'added' }, // the ownership edge a parent adds: a consequence, not a row
];
const proposal = { edges: { add: [{ from: 'page-pay', to: 'table-orders', kind: 'writes' }] } };
const scenarios = [
  { id: 'adult-pays', title: 'An adult pays', actor: 'adult', steps: [{ node: 'page-cart', text: 'Opens the cart.' }, { node: 'page-pay', text: 'You pay.' }, { edge: { from: 'page-pay', to: 'table-orders', kind: 'writes' }, text: 'It is stored.' }] },
  { id: 'hand-over', title: 'A guest asks, an admin answers', steps: [{ node: 'page-pay', actor: 'guest', text: 'Asks.' }, { node: 'table-orders', actor: 'admin', text: 'Answers.' }] },
  { id: 'old-goes', title: 'The old page goes', steps: [{ node: 'page-old', text: 'Gone.' }] },
];

describe('changeRows', () => {
  it('lists marked nodes and the edges the proposal names, by mark, and leaves out the consequences', () => {
    const rows = changeRows(nodes, edges, proposal);
    expect(rows.map((r) => `${r.kind} ${r.word} ${r.name}`)).toEqual([
      'node Added checkout page', 'edge Added checkout page → orders table', 'node Changed cart page', 'node Removed old page',
    ]);
  });
});

describe('buildScenarioList (D2)', () => {
  const list = buildScenarioList({ scenarios, nodes, edges, proposal });
  it('groups by persona in the order of the map, lists a hand-over under each persona that acts, and puts Anyone last', () => {
    expect(list.groups.map((g) => g.heading)).toEqual(['Adult · 1 scenario', 'Guest (no account) · 1 scenario', 'Admin · 1 scenario', 'Anyone · 1 scenario']);
    expect(list.groups[3].scenarios.map((s) => s.id)).toEqual(['old-goes']);
    expect(list.total).toBe(3);
    expect(list.personaCount).toBe(3);
  });
  it('names the personas that act in no scenario', () => {
    expect(list.notInAny).toEqual(['Child']);
    expect(list.coverage).toBe('Not in any scenario: Child');
  });
  it('says nothing about coverage when every persona acts, or there are no scenarios', () => {
    const all = buildScenarioList({ scenarios: [{ id: 'x', title: 'X', steps: [], actor: 'adult' }, { id: 'y', title: 'Y', steps: [], actor: 'child' }, { id: 'z', title: 'Z', steps: [{ actor: 'guest', node: 'page-cart', text: '' }, { actor: 'admin', node: 'page-cart', text: '' }] }], nodes, edges, proposal });
    expect(all.coverage).toBe('');
    expect(buildScenarioList({ scenarios: [], nodes, edges, proposal })).toMatchObject({ total: 0, groups: [], coverage: '', notInAny: [] });
  });
  it('when the map has no personas, an actor the map lacks is listed by its id, and a scenario with none stays under Anyone', () => {
    const none = buildScenarioList({ scenarios, nodes: nodes.filter((n) => n.type !== 'persona'), edges, proposal });
    expect(none.groups.map((g) => g.label)).toEqual(['adult', 'guest', 'admin', 'Anyone']);
    expect(none.coverage).toBe('');
  });
  it('makes the persona key safe, whatever the id says', () => {
    const hostile = buildScenarioList({ scenarios: [{ id: 'a"><b>', title: 'T', actor: '"><img src=x>', steps: [] }], nodes: [], edges: [], proposal: null });
    expect(hostile.groups[0].key).toBe('_img_src_x_');
    expect(hostile.groups[0].scenarios[0].key).toMatch(/^0-[A-Za-z0-9_-]+$/);
    expect(safeKey('')).toBe('_');
  });
  it('summarises a row: steps, and how many of the changes it walks', () => {
    expect(list.groups[0].scenarios[0].summary).toBe('3 steps · walks 3 of 4 changes');
    expect(list.groups[3].scenarios[0].summary).toBe('1 step · walks 1 of 4 changes');
  });
  it('a proposal that changes nothing has no "walks" part', () => {
    const plain = buildScenarioList({ scenarios: [scenarios[0]], nodes: nodes.map((n) => ({ ...n, mark: 'none' })), edges: [], proposal: null });
    expect(plain.groups[0].scenarios[0].summary).toBe('3 steps');
  });
});

describe('step rows (D4)', () => {
  const sc = buildScenarioList({ scenarios, nodes, edges, proposal }).groups[0].scenarios[0];
  it('has the number, the node, its mark, the text, and an edge step names both ends', () => {
    expect(sc.steps.map((s) => [s.number, s.where, s.markWord, s.text])).toEqual([
      [1, 'cart page', 'Changed', 'Opens the cart.'], [2, 'checkout page', 'Added', 'You pay.'], [3, 'checkout page → orders table', 'Added', 'It is stored.'],
    ]);
    expect(sc.steps[1].actorLabel).toBe('Adult');
  });
  it("a step's own actor wins over the scenario's, and a step nobody acts has no actor", () => {
    const g = buildScenarioList({ scenarios, nodes, edges, proposal }).groups;
    expect(g[1].scenarios[0].steps.map((s) => s.actorLabel)).toEqual(['Guest (no account)', 'Admin']);
    expect(g[3].scenarios[0].steps[0].actorLabel).toBe('');
    expect(actorsOf({ actor: 'a', steps: [{ actor: 'b' }, { actor: 'a' }, {}] })).toEqual(['a', 'b']);
  });
  it('reads the verdict of each step in words, for a step that has an actor only', () => {
    const verdicts = new Map([['adult-pays', [{ state: 'allowed' }, { state: 'refused', reason: 'Only admins.' }, { state: 'unchecked', why: 'nothing in this step to ask' }]]]);
    const list = buildScenarioList({ scenarios, nodes, edges, proposal, verdicts });
    const row = list.groups[0].scenarios[0];
    expect(row.steps.map((s) => s.verdict.words)).toEqual(['Allowed', 'Refused: Only admins.', 'Not checked: nothing in this step to ask']);
    expect(row.verdictSummary).toBe('1 allowed · 1 refused');
    expect(list.groups[3].scenarios[0].steps[0].verdict).toBeNull();
  });
  it('words the verdicts: mismatch is a failure, an expected refusal is a success, not checked has no state', () => {
    expect(stepVerdictWords({ state: 'allowed', mismatch: true, expect: 'refused' })).toMatchObject({ words: 'Expected refused, was allowed', state: 'failure' });
    expect(stepVerdictWords({ state: 'refused', mismatch: true, expect: 'allowed', reason: 'No.' })).toMatchObject({ words: 'Expected allowed, was refused: No.', state: 'failure' });
    expect(stepVerdictWords({ state: 'refused', expect: 'refused', reason: 'No.' })).toMatchObject({ state: 'success' });
    expect(stepVerdictWords({ state: 'refused', reason: 'No.' })).toMatchObject({ state: 'failure' });
    expect(stepVerdictWords({ state: 'unchecked', why: 'because' })).toEqual({ words: 'Not checked: because', state: '', tone: 'unchecked' });
    expect(stepVerdictWords({ state: 'none' })).toBeNull();
  });
  it('gives a screen reader one sentence for a step', () => {
    const s = sc.steps[1];
    expect(stepSentence({ ...s, verdict: { words: 'Allowed' } }, 3)).toBe('Step 2 of 3, as Adult: checkout page, Added. You pay. Allowed.');
    expect(stepSentence(sc.steps[0], 3)).toBe('Step 1 of 3, as Adult: cart page, Changed. Opens the cart.');
  });
});

describe('the player says the step as the list does', () => {
  it('one sentence for the step it is on, with the verdict when there is one', () => {
    const snap = { index: 1, total: 3, current: { node: 'page-pay', text: 'You pay.', actor: 'adult' }, verdict: { state: 'allowed' } };
    expect(currentStepSentence({ snap, nodes, edges })).toBe('Step 2 of 3, as Adult: checkout page, Added. You pay. Allowed.');
    expect(currentStepSentence({ snap: { ...snap, current: { edge: { from: 'page-pay', to: 'table-orders', kind: 'writes' }, text: 'Stored.' }, verdict: undefined }, nodes, edges })).toBe('Step 2 of 3: checkout page → orders table, Added. Stored.');
  });
});

describe('words', () => {
  it('counts for the phone peek and the opening announcement (D1, D5)', () => {
    const list = buildScenarioList({ scenarios, nodes, edges, proposal });
    expect(reviewCounts(6, list)).toBe('6 changes · 3 scenarios for 3 personas');
    expect(reviewOpenedWords('Checkout', 6, list)).toBe('Opened Checkout: 6 changes, 3 scenarios for 3 personas.');
    expect(reviewCounts(1, { total: 0, personaCount: 0 })).toBe('1 change');
    expect(reviewCounts(2, { total: 1, personaCount: 0 })).toBe('2 changes · 1 scenario');
  });
});

describe('the record of what was seen', () => {
  const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };
  it('is kept per proposal and PR head, and played includes read', () => {
    const store = memory();
    const key = seenKey('pull/21', '0100-x', 'abc');
    expect(readSeen(store, key)).toEqual({ played: [], read: [] });
    writeSeen(store, key, 's1', 'read');
    writeSeen(store, key, 's2', 'read');
    writeSeen(store, key, 's1', 'played');
    expect(readSeen(store, key)).toEqual({ played: ['s1'], read: ['s2'] });
    expect(readSeen(store, seenKey('pull/21', '0100-x', 'def'))).toEqual({ played: [], read: [] });
    const list = buildScenarioList({ scenarios, nodes, edges, proposal, seen: { played: ['adult-pays'], read: ['old-goes'] } });
    expect(list.groups[0].scenarios[0].seen).toBe('played');
    expect(list.groups[3].scenarios[0].seen).toBe('read');
    expect(list.playedLine).toBe('1 of 3 scenarios played');
  });
  it('works without a store: blocked, throwing or garbled storage reads as nothing seen', () => {
    const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    expect(readSeen(throwing, 'k')).toEqual({ played: [], read: [] });
    expect(writeSeen(throwing, 'k', 's', 'played')).toEqual({ played: ['s'], read: [] });
    expect(readSeen(null, 'k')).toEqual({ played: [], read: [] });
    expect(readSeen({ getItem: () => '{not json' }, 'k')).toEqual({ played: [], read: [] });
    expect(readSeen({ getItem: () => JSON.stringify({ played: [1, 'a'], read: 'x' }) }, 'k')).toEqual({ played: ['a'], read: [] });
  });
});
