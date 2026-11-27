/**
 * @vitest-environment node
 *
 * The Work inbox's rules (explorer/inbox-model.js, spec 0016 D2 to D4), on a graph shaped as the review rig's answers it: every group, the reasons
 * in words, the actions, the order, a waiting run folded into the spec it asks about, folded threads and drafts kept out, and the count that is spec 0010's.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS module, no declarations
import { inboxOf, placeOf, checkWords, headingOf, openedWords, orderOf, nextAfter, rowWords, isFoldedThread, GROUPS } from '../../explorer/inbox-model.js';

const at = (h) => new Date(Date.parse('2026-11-27T00:36:00Z') - h * 3_600_000).toISOString();
const P = (slug, state, over = {}) => ({ id: `proposal:${slug}`, kind: 'proposal', stage: 'decide', title: slug, state, open: true, waiting: state === 'to-decide' || state === 'changed', slug, number: 20, updated: at(1), ...over });
const R = (n, state, over = {}) => ({ id: `run:run-${n}`, kind: 'run', stage: 'build', title: `run ${n}`, state, open: ['requested', 'claimed', 'working', 'waiting'].includes(state), waiting: state === 'waiting', runId: `run-01RIGRUN00000000000000000${n}`, updated: at(2), note: null, brief: null, pull: null, ...over });

/** The rig's work (test/fixtures/big/serve.js --forge), cut to what the rules read */
function rig() {
  const nodes = [
    { id: 'thread:21', kind: 'thread', title: 'Spec: A new flow', state: 'open', open: true, waiting: false, number: 21, updated: at(0.5) },
    { id: 'thread:12', kind: 'thread', title: 'Meals page', state: 'open', open: true, waiting: false, number: 12, updated: at(980) },
    { id: 'thread:40', kind: 'thread', title: 'An idea', state: 'open', open: true, waiting: false, number: 40, updated: at(5) },
    { id: 'issue:5', kind: 'issue', title: 'Sign-in', state: 'open', open: true, waiting: false, number: 5, updated: at(1000) },
    { id: 'issue:3', kind: 'issue', title: 'Forge adapters', state: 'open', open: true, waiting: false, number: 3, updated: at(1030) },
    P('0100-new-flow', 'to-decide', { number: 21, updated: at(0.5) }),
    P('0104-shared', 'changed', { number: 25, updated: at(0.5) }),
    P('0013-meals', 'to-decide', { number: 12, updated: at(980) }),
    P('0102-retire', 'approved', { number: 23 }),
    P('0103-swap', 'sent-back', { number: 24 }),
    P('0105-site', 'draft-pr', { number: 26, draft: true }),
    P('0001-local', 'local', { number: null }), P('0002-local', 'local', { number: null }),
    R(0, 'requested'), R(1, 'claimed'), R(2, 'working', { note: 'Reading the page and its tests.' }),
    R(3, 'waiting', { note: 'Plan ready: approve to build, or tell me what to change.', updated: at(0.6) }),
    R(4, 'done', { note: 'Merged-ready: one file changed, the checks pass.', pull: { number: 14, state: 'open' }, updated: at(3) }),
    R(5, 'failed', { note: 'The tests fail on the new version.', updated: at(4) }),
    R(6, 'stopped', { note: 'Stopped by a maintainer.', updated: at(5) }),
    { id: 'pull:13', kind: 'pull', title: 'Lint everything', state: 'open', open: true, waiting: false, number: 13, updated: at(980), checks: { failed: 1, running: 1, passed: 0, green: false, failedNames: ['lint'], runningNames: ['test'] } },
    { id: 'pull:30', kind: 'pull', title: 'Green one', state: 'open', open: true, waiting: false, number: 30, updated: at(9), checks: { failed: 0, running: 0, passed: 2, green: true, failedNames: [], runningNames: [] } },
    { id: 'pull:9', kind: 'pull', title: 'Merged one', state: 'merged', open: false, waiting: false, number: 9, updated: at(30) },
    { id: 'deploy:9001', kind: 'deploy', title: 'Deploy media', state: 'running', open: true, waiting: false, updated: at(950) },
    { id: 'code-a', kind: 'code', planned: true, label: 'a' },
  ];
  const edges = [
    { from: 'thread:21', to: 'proposal:0100-new-flow', rel: 'discusses' },
    { from: 'thread:12', to: 'proposal:0013-meals', rel: 'discusses' },
    { from: 'thread:12', to: 'run:run-2', rel: 'agent-on' },
    { from: 'proposal:0100-new-flow', to: 'run:run-3', rel: 'agent-on' },
    { from: 'issue:5', to: 'run:run-0', rel: 'agent-on' },
    { from: 'issue:5', to: 'run:run-1', rel: 'agent-on' },
    { from: 'proposal:0100-new-flow', to: 'code-a', rel: 'adds' },
  ];
  return { nodes, edges };
}
const ids = (rows) => rows.map((r) => r.id);

describe('the groups (spec 0016 D2)', () => {
  const inbox = inboxOf(rig());

  it('Waiting on you holds spec 0010 D1 exactly, oldest first, with the run folded into the spec it asks about', () => {
    expect(ids(inbox.groups.waiting)).toEqual(['proposal:0013-meals', 'proposal:0100-new-flow', 'proposal:0104-shared']);
    const host = inbox.groups.waiting[1];
    expect(host.also.id).toBe('run:run-3');
    expect(host.action).toEqual({ key: 'review', label: 'Review' });
    expect(inbox.groups.waiting[2]).toMatchObject({ why: 'Changed since you approved it', action: { key: 'review-change' } });
    expect(inbox.count).toBe(4);
    expect(inbox.rowsWaiting).toBe(3);
  });

  it('Your move: a failed check, a failed run, a finished run with its pull request open, an approved spec; never counted', () => {
    expect(ids(inbox.groups.move)).toEqual(['pull:13', 'run:run-5', 'run:run-4', 'proposal:0102-retire']);
    const [pr, failed, done, approved] = inbox.groups.move;
    expect(pr).toMatchObject({ why: 'lint failed · test running', bad: true, action: { key: 'rerun' }, counted: false });
    expect(failed).toMatchObject({ why: 'Failed: The tests fail on the new version.', bad: true, action: { key: 'retry' } });
    expect(done).toMatchObject({ action: { key: 'land', label: 'Land PR #14' } });
    expect(done.why).toMatch(/^Done: PR #14 is open\. Merged-ready/);
    expect(approved.action.key).toBe('land');
  });

  it('Nobody on it: an issue no open run is on, an idea with no spec', () => {
    expect(ids(inbox.groups.unclaimed)).toEqual(['issue:3', 'thread:40']);
    expect(inbox.groups.unclaimed[0]).toMatchObject({ why: 'Nobody is on it', action: { key: 'agent', label: 'Start an agent' } });
  });

  it('In motion and Done lately hold the rest; a green pull request is in motion, not your move', () => {
    expect(new Set(ids(inbox.groups.motion))).toEqual(new Set(['issue:5', 'proposal:0103-swap', 'proposal:0105-site', 'run:run-0', 'run:run-1', 'run:run-2', 'thread:12', 'pull:30', 'deploy:9001']));
    expect(inbox.groups.motion.find((r) => r.id === 'thread:12').why).toBe('A spec is being written from it');
    expect(inbox.groups.motion.find((r) => r.id === 'issue:5').why).toBe('2 agent runs on it');
    expect(inbox.groups.motion.find((r) => r.id === 'pull:30').why).toBe('2 passed');
    expect(ids(inbox.groups.done)).toEqual(['run:run-6', 'pull:9']);
  });

  it('a spec\'s thread is folded into it, local drafts are a count, code is never a row', () => {
    const all = inbox.rows.map((r) => r.id);
    expect(all).not.toContain('thread:21');
    expect(all).not.toContain('proposal:0001-local');
    expect(all).not.toContain('code-a');
    expect(inbox.drafts).toBe(2);
    // thread 12 is on a run too, so it is not folded: it is a spec being written from
    expect(all).toContain('thread:12');
  });

  it('every row is in exactly one group, and the groups follow GROUPS', () => {
    const shown = Object.values(inbox.groups).flat().map((r) => r.id);
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown.length + inbox.rows.filter((r) => r.folded).length).toBe(inbox.rows.length);
    expect(Object.keys(inbox.groups)).toEqual(GROUPS.map((g) => g.key));
  });
});

describe('one row per subject (D4)', () => {
  it('folds only a waiting run into a waiting spec; the count stays per item', () => {
    const g = rig();
    g.nodes.find((n) => n.id === 'proposal:0100-new-flow').waiting = false;
    g.nodes.find((n) => n.id === 'proposal:0100-new-flow').state = 'approved';
    const inbox = inboxOf(g);
    expect(ids(inbox.groups.waiting)).toContain('run:run-3');
    expect(inbox.groups.waiting.find((r) => r.id === 'run:run-3').why).toBe('Plan ready: approve to build, or tell me what to change.');
    expect(inbox.count).toBe(3);
    expect(inbox.rowsWaiting).toBe(3);
  });

  it('a run about an issue keeps its own row', () => {
    const g = rig();
    g.nodes.push(R(7, 'waiting', { note: 'Which page?' }));
    g.edges.push({ from: 'issue:3', to: 'run:run-7', rel: 'agent-on' });
    const inbox = inboxOf(g);
    expect(ids(inbox.groups.waiting)).toContain('run:run-7');
    expect(inbox.count).toBe(5);
  });
});

describe('the words', () => {
  it('says the checks by name, with more than five counted', () => {
    expect(checkWords({ failed: 7, running: 0, passed: 3, failedNames: ['a', 'b', 'c', 'd', 'e'], runningNames: [] })).toBe('a, b, c, d, e and 2 more failed · 3 passed');
    expect(checkWords({ failed: 0, running: 1, passed: 0, failedNames: [], runningNames: [] })).toBe('1 check running');
    expect(checkWords(null)).toBe('');
  });

  it('the heading and what a screen reader hears', () => {
    const inbox = inboxOf(rig());
    expect(headingOf(inbox)).toBe('4 waiting on you in 3 rows');
    expect(openedWords(inbox)).toBe('Inbox: 4 waiting on you in 3 rows, 4 your move, 2 nobody on it.');
    expect(headingOf({ count: 1, rowsWaiting: 1 })).toBe('1 waiting on you');
    const empty = inboxOf({ nodes: [], edges: [] });
    expect(headingOf(empty)).toBe('Nothing waits on you');
    expect(openedWords(empty)).toBe('Inbox: nothing waits on you.');
    expect(rowWords(inbox.groups.waiting[1], '30 minutes ago')).toBe('Spec 0100, 0100-new-flow. Ready for your decision, and Run 000003 waits on your answer. 30 minutes ago.');
  });

  it('a null or broken graph is an empty inbox, not an error', () => {
    expect(inboxOf(null).count).toBe(0);
    expect(inboxOf({ nodes: [null, { kind: 'pull' }], edges: null }).rows).toEqual([]);
  });
});

describe('moving through it (D6)', () => {
  it('J and K go through the open groups, top to bottom; after an action the next row, else the one before', () => {
    const inbox = inboxOf(rig());
    const order = orderOf(inbox);
    expect(order.slice(0, 4)).toEqual(['proposal:0013-meals', 'proposal:0100-new-flow', 'proposal:0104-shared', 'pull:13']);
    expect(order).not.toContain('run:run-6'); // Done lately starts folded
    expect(orderOf(inbox, new Set(['done']))).toEqual(['run:run-6', 'pull:9']);
    expect(nextAfter(order, 'proposal:0013-meals')).toBe('proposal:0100-new-flow');
    expect(nextAfter(order, order.at(-1))).toBe(order.at(-2));
    expect(nextAfter(['x'], 'x')).toBe(null);
    expect(nextAfter(order, 'gone')).toBe(order[0]);
  });
});

describe('placeOf, one at a time', () => {
  const ctx = { edges: [], byId: new Map() };
  it('a closed issue and a closed thread are done; a failed deploy says so', () => {
    expect(placeOf({ id: 'issue:1', kind: 'issue', open: false }, ctx).group).toBe('done');
    expect(placeOf({ id: 'thread:1', kind: 'thread', open: false }, ctx).group).toBe('done');
    expect(placeOf({ id: 'deploy:1', kind: 'deploy', state: 'failure' }, ctx)).toMatchObject({ group: 'done', why: 'Failed', bad: true });
  });
  it('a pull request whose checks could not be read is in motion with its plain state', () => {
    expect(placeOf({ id: 'pull:1', kind: 'pull', open: true, checks: null }, ctx)).toMatchObject({ group: 'motion', why: 'Open' });
  });
  it('a finished run whose pull request merged is done', () => {
    expect(placeOf(R(1, 'done', { pull: { number: 2, state: 'merged' } }), ctx).group).toBe('done');
  });
  it('a thread with no lines is not folded', () => {
    expect(isFoldedThread('thread:1', [], new Map())).toBe(false);
  });
});
