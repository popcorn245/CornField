/**
 * @vitest-environment node
 *
 * What is waiting on the maintainer (spec 0010, explorer/waiting-model.js), without a page: D1 the one number, D3 the Specs groups and their
 * order, D4 each row's review state and its words, D5 the search, D6 the Runs groups and their order.
 */
import { describe, it, expect } from 'vitest';
import {
  specStateOf, waitingSpecs, specGroups, specMatches, runGroupOf, waitingRuns, runGroups, waiting, waitingWords, workButtonName, groupCountWords, specStateWords, waitingSinceOf, runWaitingOn, waitingLineWords, LINE_NOTE_MAX,
  SPEC_STATES, SPEC_STATE_CORN, SPEC_STATE_WORDS, DRAFTS_OPEN_MAX,
  // @ts-expect-error plain JS modules, no declarations
} from '../../explorer/waiting-model.js';
// @ts-expect-error plain JS modules, no declarations
import { CORN_STATES } from '../../explorer/corn-state.js';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const ago = (h) => new Date(NOW - h * 3_600_000).toISOString();

/** A listing entry for a spec PR; `review` as the server sends it */
const pr = (n, { draft = false, review = null, pushed = 5, title = `Spec ${n}`, summary = '' } = {}) => ({
  slug: `00${n}-thing`, title, summary, source: `pull/${n}`, counts: {},
  pull: { number: n, title: `Spec: ${title}`, url: `https://git.example.test/pull/${n}`, draft, author: 'agent-four', createdAt: ago(pushed + 10), updatedAt: ago(pushed), pushedAt: ago(pushed) },
  review,
});
const local = (slug) => ({ slug, title: slug, summary: '', source: 'checkout', counts: {}, review: null });
const approved = (current, h = 2) => ({ verdict: 'approved', by: 'maintainer-one', at: ago(h), current });
const sentBack = (current, h = 20) => ({ verdict: 'notes', by: 'maintainer-one', at: ago(h), current });

describe('D1: which specs are to decide', () => {
  it('counts a ready spec PR with no review, and one approved then changed, and one pushed to after a send-back', () => {
    expect(specStateOf(pr(1)).state).toBe('to-decide');
    expect(specStateOf(pr(2, { review: approved(false) })).state).toBe('changed');
    expect(specStateOf(pr(3, { review: sentBack(false) })).state).toBe('to-decide');
    expect(waitingSpecs([pr(1), pr(2, { review: approved(false) }), pr(3, { review: sentBack(false) })])).toHaveLength(3);
  });

  it('does not count an approved spec, a sent-back one not pushed since, a draft PR, a local draft', () => {
    const list = [pr(4, { review: approved(true) }), pr(5, { review: sentBack(true) }), pr(6, { draft: true }), pr(7, { draft: true, review: approved(false) }), local('0008-x')];
    expect(waitingSpecs(list)).toEqual([]);
    expect(list.map((e) => specStateOf(e).state)).toEqual(['approved', 'sent-back', 'draft-pr', 'draft-pr', 'local']);
  });

  it('never makes a review that could not be read look unreviewed or unneeded: it says unknown, shows under To decide, and is not counted', () => {
    const e = pr(9, { review: { error: 'GitHub did not answer.' } });
    expect(specStateOf(e)).toMatchObject({ state: 'unknown', group: 'decide', counted: false });
    expect(waitingSpecs([e])).toEqual([]);
    expect(specStateWords(e, NOW)).toBe('');
  });

  it('counts runs only when they wait on an answer nobody asked to stop', () => {
    const runs = [
      { runId: 'a', status: 'waiting', open: true }, { runId: 'b', status: 'waiting', open: true, stopRequested: { by: 'x' } },
      { runId: 'c', status: 'working', open: true }, { runId: 'd', status: 'failed', open: false }, { runId: 'e', status: 'quiet', open: false },
    ];
    expect(waitingRuns(runs).map((r) => r.runId)).toEqual(['a']);
  });

  it('is one number: specs plus runs; nothing read counts nothing', () => {
    const w = waiting({ specs: [pr(1), pr(2, { review: approved(true) })], runs: [{ runId: 'a', status: 'waiting', open: true, requestedAt: ago(1) }, { runId: 'f', status: 'failed', open: false }] });
    expect(w).toMatchObject({ specs: 1, runs: 1, total: 2 });
    expect(waiting({})).toEqual({ specs: 0, runs: 0, total: 0, oldest: null });
    expect(waiting({ specs: null, runs: null }).total).toBe(0);
  });
});

describe('D2: the tab with the oldest thing waiting', () => {
  const run = (h) => ({ runId: 'r', status: 'waiting', open: true, requestedAt: ago(h), timeline: [{ kind: 'requested', at: ago(h) }, { kind: 'report', at: ago(h - 1) }] });
  it('is Runs when the question is older than the oldest spec, Specs when it is not, and null when nothing waits', () => {
    expect(waiting({ specs: [pr(1, { pushed: 30 })], runs: [run(50)] }).oldest).toBe('work');
    expect(waiting({ specs: [pr(1, { pushed: 60 })], runs: [run(10)] }).oldest).toBe('specs');
    expect(waiting({ specs: [pr(1)], runs: [] }).oldest).toBe('specs');
    expect(waiting({ specs: [], runs: [run(3)] }).oldest).toBe('work');
    expect(waiting({ specs: [pr(2, { review: approved(true) })], runs: [] }).oldest).toBeNull();
  });
  it('dates a question from its latest report, not from when the run was asked', () => {
    expect(waitingSinceOf(run(10))).toBe(Date.parse(ago(9)));
    expect(waitingSinceOf({ requestedAt: ago(4) })).toBe(Date.parse(ago(4)));
  });
  it('words the badge as "3 waiting on you" and the button as "Work, 3 waiting on you"; none at 0', () => {
    expect(waitingWords(3)).toBe('3 waiting on you');
    expect(workButtonName('Work', 3)).toBe('Work, 3 waiting on you');
    expect(workButtonName('Work', 0)).toBe('Work');
    expect(waitingWords(0)).toBe('');
  });
});

describe('D3: the Specs groups', () => {
  const list = [
    pr(1, { pushed: 5 }), pr(2, { pushed: 50 }), // to decide: 2 waited longer
    pr(3, { review: sentBack(true, 30) }), pr(4, { draft: true, pushed: 3 }), pr(5, { review: sentBack(true, 8) }), // with the agent: newest first
    pr(6, { review: approved(true, 9) }), pr(7, { review: approved(true, 1) }),
    local('0020-b'), local('0010-a'),
  ];
  it('puts each row in the group of who must act, in the order To decide, With the agent, Approved, Drafts', () => {
    const g = specGroups(list);
    expect(g.map((x) => x.key)).toEqual(['decide', 'agent', 'approved', 'drafts']);
    expect(g.map((x) => x.title)).toEqual(['toDecide', 'withAgent', 'approvedGroup', 'drafts']);
    expect(g[0].rows.map((r) => r.entry.pull.number)).toEqual([2, 1]); // waiting longest first
    expect(g[1].rows.map((r) => r.entry.pull.number)).toEqual([4, 5, 3]); // newest activity first
    expect(g[2].rows.map((r) => r.entry.pull.number)).toEqual([7, 6]); // newest first
    expect(g[3].rows.map((r) => r.entry.slug)).toEqual(['0010-a', '0020-b']); // by number
  });
  it('shows no empty group', () => {
    expect(specGroups([pr(1)]).map((x) => x.key)).toEqual(['decide']);
    expect(specGroups([])).toEqual([]);
  });
  it('collapses Drafts past ten rows, and not ten or fewer', () => {
    const many = (n) => Array.from({ length: n }, (_, i) => local(`00${String(i).padStart(2, '0')}-d`));
    expect(specGroups(many(DRAFTS_OPEN_MAX + 1))[0].collapsed).toBe(true);
    expect(specGroups(many(DRAFTS_OPEN_MAX))[0].collapsed).toBe(false);
  });
});

describe('D4: each row says its review state', () => {
  it('has one pill for each state, with its fixed words and a public data-corn-state', () => {
    expect(SPEC_STATES).toEqual(['to-decide', 'changed', 'sent-back', 'approved', 'draft-pr', 'local', 'unknown']);
    for (const s of SPEC_STATES) {
      expect(SPEC_STATE_WORDS[s], s).toBeTruthy();
      expect(CORN_STATES, s).toContain(SPEC_STATE_CORN[s]);
    }
    expect(SPEC_STATE_CORN['to-decide']).toBe('waiting');
    expect(SPEC_STATE_CORN.changed).toBe('waiting');
    expect(SPEC_STATE_CORN.approved).toBe('success');
    expect(SPEC_STATE_CORN['sent-back']).toBe('sent-back');
  });
  it('says by whom and when: "Approved by maintainer-one · 2 hours ago", "Sent back by …", "Waiting 2 days"', () => {
    expect(specStateWords(pr(1, { review: approved(true, 2) }), NOW)).toBe('Approved by maintainer-one · 2 hours ago');
    expect(specStateWords(pr(1, { review: sentBack(true, 26) }), NOW)).toBe('Sent back by maintainer-one · 1 day ago');
    expect(specStateWords(pr(1, { pushed: 50 }), NOW)).toBe('Waiting 2 days');
    expect(specStateWords(pr(1, { review: approved(false, 70), pushed: 5 }), NOW)).toBe('Approved by maintainer-one · 2 days ago; changed since');
  });
  it('keeps a login as the forge sent it (the view escapes it)', () => {
    expect(specStateWords(pr(1, { review: { verdict: 'approved', by: '<b>x</b>', at: ago(1), current: true } }), NOW)).toContain('<b>x</b>');
  });
});

describe('D5: the search', () => {
  const e = pr(1, { title: 'Retire the old export', summary: 'Drops the CSV export' });
  it('matches title, slug and summary, every word, in any case', () => {
    expect(specMatches(e, 'retire')).toBe(true);
    expect(specMatches(e, 'CSV export')).toBe(true);
    expect(specMatches(e, '001-thing')).toBe(true);
    expect(specMatches(e, 'retire zebra')).toBe(false);
    expect(specMatches(e, '   ')).toBe(true);
  });
  it('narrows each group and says "2 of 6"; a group with no match is not shown; a search opens a collapsed Drafts', () => {
    const list = [pr(1, { title: 'Alpha export' }), pr(2, { title: 'Beta' }), pr(3, { title: 'Alpha two', review: approved(true) }), ...Array.from({ length: 12 }, (_, i) => local(`00${i}-alpha-d`))];
    const g = specGroups(list, { query: 'alpha' });
    expect(g.map((x) => [x.key, groupCountWords(x)])).toEqual([['decide', '1 of 2'], ['approved', '1'], ['drafts', '12']]);
    expect(g.find((x) => x.key === 'drafts').collapsed).toBe(false);
    expect(specGroups(list, { query: 'zzz' })).toEqual([]);
  });
});

describe('D6: the Runs groups', () => {
  const R = (runId, status, h, extra = {}) => ({ runId, status, open: ['requested', 'claimed', 'working', 'waiting', 'stop-requested'].includes(status), requestedAt: ago(h), kind: 'code', refs: { issue: Number(runId.replace(/\D/g, '')) || 1 }, timeline: [{ kind: 'requested', at: ago(h) }], ...extra });
  it('sorts waiting under Needs you, the ones under way under In motion, the ended and quiet under Finished', () => {
    expect(['waiting', 'requested', 'claimed', 'working', 'stop-requested', 'done', 'failed', 'stopped', 'quiet', 'merged'].map((s) => runGroupOf(R('r1', s, 1)))).toEqual(
      ['needs', 'motion', 'motion', 'motion', 'motion', 'finished', 'finished', 'finished', 'finished', 'finished']);
    expect(runGroupOf(R('r1', 'waiting', 1, { stopRequested: { by: 'x' } }))).toBe('finished'); // asked to stop: not a question any more
  });
  it('orders Needs you oldest question first, In motion and Finished newest first', () => {
    const runs = [R('r1', 'waiting', 2), R('r2', 'waiting', 9), R('r3', 'working', 5), R('r4', 'working', 1), R('r5', 'done', 30), R('r6', 'failed', 3), R('r7', 'quiet', 40)];
    const g = runGroups(runs);
    expect(g.map((x) => x.key)).toEqual(['needs', 'motion', 'finished']);
    expect(g.map((x) => x.title)).toEqual(['needsYou', 'inMotion', 'finished']);
    const ids = (k) => g.find((x) => x.key === k).items.map((i) => i.run.runId);
    expect(ids('needs')).toEqual(['r2', 'r1']);
    expect(ids('motion')).toEqual(['r4', 'r3']);
    expect(ids('finished')).toEqual(['r6', 'r5', 'r7']);
  });
  it('leaves out an empty group, and keeps two profiles of one request together in the more urgent group', () => {
    expect(runGroups([R('r1', 'done', 3)]).map((x) => x.key)).toEqual(['finished']);
    expect(runGroups([])).toEqual([]);
    const a = R('r1', 'waiting', 3, { profile: 'alpha', refs: { issue: 7 } });
    const b = R('r2', 'done', 3, { profile: 'beta', refs: { issue: 7 } });
    const g = runGroups([a, b, R('r3', 'working', 1)]);
    expect(g.map((x) => x.key)).toEqual(['needs', 'motion']);
    expect(g[0].items).toHaveLength(1);
    expect(g[0].items[0].kind).toBe('compare');
    expect(g[0].count).toBe(2);
  });
});

describe('the proposal bar\'s line', () => {
  const run = (id, slug, status = 'waiting', h = 3, note = 'Plan ready: approve to build, or say what to change.') => ({ runId: id, status, open: status === 'waiting', refs: { proposal: slug }, requestedAt: ago(h), timeline: [], report: { note } });
  it('finds the run waiting on this proposal (the one waiting longest), and none for another proposal, a stopped run or a run that is not waiting', () => {
    const runs = [run('a', '0042-x', 'waiting', 2), run('b', '0042-x', 'waiting', 9), run('c', '0043-y'), run('d', '0042-x', 'working'), { ...run('e', '0042-x'), stopRequested: { by: 'x' } }];
    expect(runWaitingOn(runs, '0042-x').runId).toBe('b');
    expect(runWaitingOn(runs, '0044-z')).toBeNull();
    expect(runWaitingOn(runs, '')).toBeNull();
    expect(runWaitingOn(null, '0042-x')).toBeNull();
  });
  it('says what the run asked, cut when long, and says only that a run waits when it said nothing', () => {
    expect(waitingLineWords(run('a', 'x'))).toBe('A run is waiting on you: Plan ready: approve to build, or say what to change.');
    expect(waitingLineWords(run('a', 'x', 'waiting', 1, 'w'.repeat(500))).length).toBeLessThanOrEqual('A run is waiting on you: '.length + LINE_NOTE_MAX);
    expect(waitingLineWords({ report: null })).toBe('A run is waiting on you');
  });
});
