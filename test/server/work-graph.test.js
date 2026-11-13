/**
 * @vitest-environment node
 *
 * The map of work (server/work-graph.js, spec 0012 D2, D3 and D7) against a forge that counts what it is asked: every kind of node, every rel,
 * the 14-day window, the caps, a source failing, what is read once per head commit. The route and its gate are test/server/work-graph-route.test.js.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { workGraph, stageOf, inWindow, isDrawn, buildMarkerOf, touchesOf, nodesOfFiles, MAX_OPEN_PULLS, MAX_PULL_FILES, WINDOW_DAYS, KINDS, RELS, STAGES } from '../../server/work-graph.js';
// @ts-expect-error plain JS module, no declarations
import { ForgeError } from '../../server/forge.js';
// @ts-expect-error plain JS module, no declarations
import { closesOf } from '../../core/mentions.js';
// @ts-expect-error plain JS module, no declarations
import { listPullProposals, reviewStates } from '../../server/proposal-pulls.js';
// @ts-expect-error plain JS module, no declarations
import { reviewComment, proposalHash } from '../../server/reviews.js';
// @ts-expect-error plain JS module, no declarations
import { waiting } from '../../explorer/waiting-model.js';
// @ts-expect-error plain JS module, no declarations
import { mergeSpecs } from '../../explorer/proposal-model.js';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const ago = (days) => new Date(NOW - days * 86_400_000).toISOString();
const FOLDER = 'docs/specs/proposals';

const MAP = {
  nodes: [
    { id: 'srv', file: 'server', label: 'server' },
    { id: 'auth', file: 'server/auth.js', label: 'auth' },
    { id: 'old', file: 'old/path.js', label: 'old' },
    { id: 'moved', file: 'web/new.js', label: 'moved' },
    { id: 'web', label: 'web', type: 'stack' },
    { id: 'stack-web', label: 'web-stack', type: 'stack' },
  ],
};

const pull = (n, over = {}) => ({ number: n, title: `Pull ${n}`, body: '', state: 'open', draft: false, author: { login: 'agent-four' }, labels: [], head: { ref: `b${n}`, sha: `h${n}` }, base: { ref: 'main' }, url: `https://forge.test/pull/${n}`, createdAt: ago(5), updatedAt: ago(1), mergedAt: null, mergeSha: null, ...over });
const issue = (n, over = {}) => ({ number: n, title: `Issue ${n}`, state: 'open', author: { login: 'maintainer-one' }, labels: [], body: '', comments: 0, url: `https://forge.test/issues/${n}`, createdAt: ago(9), updatedAt: ago(2), closedAt: null, ...over });
const file = (p, over = {}) => ({ path: p, status: 'modified', previousPath: null, additions: 1, deletions: 0, ...over });
const proposalText = (over = {}) => JSON.stringify({ title: 'Retire the export', summary: 's', nodes: { add: [{ id: 'new-thing', label: 'New thing', type: 'service' }], change: [{ id: 'auth', set: {} }] }, ...over });

/** A forge that serves `data` and writes down every call it is asked */
function makeForge(data = {}) {
  const calls = [];
  const d = { open: [], closed: [], openIssues: [], closedIssues: [], files: {}, comments: {}, texts: {}, runs: [], fail: {}, ...data };
  const note = (name, ...args) => { calls.push([name, ...args]); if (d.fail[name]) throw d.fail[name]; };
  const forge = {
    repo: 'owner/name',
    calls,
    data: d,
    pulls: async (q = {}) => { note('pulls', q.state ?? 'open', q); return q.state === 'closed' ? d.closed : d.open; },
    issues: async (q = {}) => { note('issues', q.state ?? 'open', q); return q.state === 'closed' ? d.closedIssues : d.openIssues; },
    pullFiles: async (n) => { note('pullFiles', n); if (d.slow) await new Promise((r) => setTimeout(r, d.slow)); return d.files[n] ?? []; },
    pullCommits: async (n) => { note('pullCommits', n); return [{ sha: 'c', message: 'm', date: ago(1) }]; },
    comments: async (n) => { note('comments', n); return d.comments[n] ?? []; },
    file: async (sha, p) => { note('file', sha, p); return d.texts[`${sha}:${p}`] ?? null; },
    runs: async () => { note('runs'); return d.runs; },
    permission: async () => 'maintain',
  };
  return forge;
}
const count = (forge, name) => forge.calls.filter((c) => c[0] === name).length;

/** A where of its own, so what is kept by head belongs to the test */
function whereOf() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-wg-'));
  fs.mkdirSync(path.join(root, FOLDER), { recursive: true });
  return { root, proposals: FOLDER, worktrees: null };
}

const run = (over = {}) => ({
  runId: 'run-01AAAAAAAAAAAAAAAAAAAAAAAA', kind: 'code', profile: null, refs: { issue: 14, proposal: '0100-retire' }, status: 'working', open: true, requestedBy: 'maintainer-one', requestedAt: ago(1),
  report: null, stopRequested: null, comment: null, pull: { number: 27, state: 'open', url: 'u' }, lastActivity: ago(0.5), nodes: ['auth'], ...over,
});

/** The whole story: an idea, the spec PR that names it, an issue, a build issue, a code PR, a run, a merged PR and its deploy */
function story() {
  const pulls = [
    pull(27, { body: 'Closes #14 and fixes #99.', updatedAt: ago(0.2) }),
    pull(41, { title: 'Spec: retire the export', body: 'Closes #40\n', updatedAt: ago(0.4) }),
  ];
  const closed = [
    pull(20, { state: 'merged', mergedAt: ago(3), updatedAt: ago(3), mergeSha: 'm20', body: 'Closes #14' }),
    pull(22, { state: 'merged', mergedAt: ago(2), updatedAt: ago(2), mergeSha: 'm22', body: 'Closes #15' }),
    pull(19, { state: 'closed', updatedAt: ago(20) }),
  ];
  const forge = makeForge({
    open: pulls,
    closed,
    openIssues: [
      issue(14, { body: 'See [[server/auth.js]] and [[no-such-node]].' }),
      issue(40, { labels: ['idea'], body: 'An idea about [[auth]].', comments: 1, updatedAt: ago(0.3) }),
    ],
    closedIssues: [issue(15, { state: 'closed', closedAt: ago(5), body: 'Build.\n<!-- cornfield-build pull/41 0100-retire -->' }), issue(16, { state: 'closed', closedAt: ago(20), updatedAt: ago(20) })],
    files: {
      27: [file('server/auth.js'), file('web/new.js', { status: 'renamed', previousPath: 'old/path.js' })],
      41: [file(`${FOLDER}/0100-retire.json`, { status: 'added' })],
      20: [file('server/other.js')],
      22: [file('server/auth.js')],
      19: [file('server/auth.js')],
    },
    texts: { [`h41:${FOLDER}/0100-retire.json`]: proposalText() },
    comments: {
      40: [{ id: '1', author: { login: 'maintainer-one' }, body: '```cornfield-thread\n{"proposal":"0100-retire","nodes":["web"]}\n```', url: 'u', createdAt: ago(1), updatedAt: ago(1) }],
      41: [{ id: '2', author: { login: 'maintainer-one' }, body: 'Looks at [[server]].', url: 'u', createdAt: ago(1), updatedAt: ago(1) }],
    },
    runs: [
      { id: '9001', workflow: 'deploy.yml', name: 'Deploy web', title: 'Release', event: 'push', branch: 'main', sha: 'm20', state: 'success', actor: { login: 'maintainer-one' }, url: 'https://forge.test/runs/9001', createdAt: ago(2), updatedAt: ago(2) },
      { id: '9002', workflow: 'deploy.yml', name: 'Deploy web', title: 'Old', event: 'push', branch: 'main', sha: 'x', state: 'success', actor: null, url: null, createdAt: ago(20), updatedAt: ago(20) },
      { id: '9003', workflow: 'ci.yml', name: 'CI', title: 'Tests', event: 'push', branch: 'main', sha: 'y', state: 'success', actor: null, url: null, createdAt: ago(1), updatedAt: ago(1) },
    ],
  });
  const runs = {
    list: async () => ({
      runs: [
        run({ runId: 'run-01WAITING00000000000000000A', status: 'waiting', refs: { issue: 14, proposal: '0100-retire' }, pull: { number: 27 } }),
        run({ runId: 'run-01DONE0000000000000000000A', status: 'done', open: false, refs: { thread: 40 }, pull: null, nodes: ['srv', 'gone'], lastActivity: ago(2) }),
        run({ runId: 'run-01OLD00000000000000000000A', status: 'done', open: false, refs: { issue: 14 }, pull: null, nodes: [], lastActivity: ago(20) }),
      ],
    }),
  };
  const config = { forge: { type: 'github', repo: 'owner/name' }, deploys: { workflows: ['*deploy*'], restarts: { 'Deploy web': ['stack-web'] } } };
  return { forge, runs, config };
}

const graphOf = (s, over = {}) => workGraph(s.forge, s.config, MAP, { where: s.where ?? whereOf(), runs: s.runs, now: () => NOW, ...over });
const rels = (g, from, to) => g.edges.filter((e) => (from === undefined || e.from === from) && (to === undefined || e.to === to)).map((e) => `${e.from} ${e.rel} ${e.to}`);

describe('the pure functions', () => {
  it('puts each kind of work in its lane', () => {
    expect(KINDS.map(stageOf)).toEqual(['talk', 'talk', 'decide', 'build', 'build', 'ship']);
    expect(STAGES).toEqual(['talk', 'decide', 'build', 'ship']);
    expect(stageOf('code')).toBe(null);
  });
  it('keeps what is open and what ended within 14 days, the day of it included', () => {
    expect(WINDOW_DAYS).toBe(14);
    expect(inWindow(ago(13.9), NOW)).toBe(true);
    expect(inWindow(ago(14.1), NOW)).toBe(false);
    expect(inWindow(new Date(NOW + 5000).toISOString(), NOW)).toBe(true);
    expect([null, undefined, '', 'soon'].map((v) => inWindow(v, NOW))).toEqual([false, false, false, false]);
    expect(isDrawn(true, ago(400), NOW)).toBe(true);
    expect(isDrawn(false, ago(400), NOW)).toBe(false);
    expect(isDrawn(false, ago(3), NOW)).toBe(true);
  });
  it('reads every Closes #n outside code, and not another repo\'s', () => {
    expect(closesOf('Closes #14 and fixes #99, resolved: #7. Also closes owner/name#5')).toEqual([14, 99, 7]);
    expect(closesOf('```\nCloses #3\n```\nCloses `#4`\n')).toEqual([]);
    // every keyword both forges honour, in any case; not inside a word
    expect(closesOf('CLOSE #1, closed #2, Fix #3, fixed: #4, RESOLVE #5, resolved #6 (fixes #7) unfixes #8 prefix-closes #9')).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // a template's HTML comment is not read by either forge; a quote is still the text
    expect(closesOf('<!-- e.g. Fixes #123 -->\nCloses #4\n<!-- Closes #5\nnever closed')).toEqual([4]);
    expect(closesOf('> Closes #8')).toEqual([8]);
    // this repo written out in full is this repo; another is not, in any case
    expect(closesOf('Closes Owner/Name#5 and fixes other/repo#6', 'owner/name')).toEqual([5]);
    expect(closesOf('Closes #14\nCloses #14')).toEqual([14]);
    expect(closesOf(undefined)).toEqual([]);
  });
  it('finds the marker of a build issue', () => {
    expect(buildMarkerOf('x <!-- cornfield-build pull/41 0100-retire --> y')).toEqual({ pull: 41, slug: '0100-retire' });
    expect(buildMarkerOf('<!-- cornfield-build pull/0 s -->')).toBe(null);
    expect(buildMarkerOf(null)).toBe(null);
  });
  it('says what a proposal adds and what it changes or removes, whatever the file holds', () => {
    const t = touchesOf({ nodes: { add: [{ id: 'a', label: 'A', type: 'api' }, { id: 'b' }, { label: 'no id' }], change: [{ id: 'c' }], remove: ['d', { id: 'c' }] } });
    expect(t).toEqual({ adds: [{ id: 'a', label: 'A', type: 'api' }, { id: 'b', label: 'b', type: null }], changes: ['c', 'd'] });
    for (const v of [null, 4, 'x', [], {}, { nodes: 3 }]) expect(touchesOf(v)).toEqual({ adds: [], changes: [] });
  });
  it('turns files into the map\'s nodes, a rename lighting the old path, at most 300 files', () => {
    expect(nodesOfFiles([file('server/auth.js'), file('web/new.js', { previousPath: 'old/path.js', status: 'renamed' }), file('README.md')], MAP.nodes).sort()).toEqual(['auth', 'moved', 'old']);
    const many = { nodes: Array.from({ length: 320 }, (_, i) => ({ id: `n${i}`, file: `f${i}` })) };
    expect(nodesOfFiles(many.nodes.map((n) => file(n.file)), many.nodes)).toHaveLength(MAX_PULL_FILES);
  });
});

describe('the work graph', () => {
  it('makes a node for every kind of work, with its stage, state, number, url, update and waiting', async () => {
    const g = await graphOf(story());
    expect(g.problems).toEqual([]);
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(Object.keys(byId).sort()).toEqual([
      'deploy:9001', 'issue:14', 'issue:15', 'new-thing', 'proposal:0100-retire', 'pull:20', 'pull:22', 'pull:27', 'run:run-01DONE0000000000000000000A', 'run:run-01WAITING00000000000000000A', 'thread:40', 'thread:41',
    ]);
    expect([...new Set(g.nodes.filter((n) => n.kind !== 'code').map((n) => n.kind))].sort()).toEqual([...KINDS].sort());
    expect(byId['pull:27']).toMatchObject({ kind: 'pull', stage: 'build', title: 'Pull 27', state: 'open', open: true, number: 27, url: 'https://forge.test/pull/27', waiting: false });
    expect(byId['pull:20']).toMatchObject({ kind: 'pull', state: 'merged', open: false });
    expect(byId['issue:14']).toMatchObject({ kind: 'issue', stage: 'talk', state: 'open', number: 14, updated: ago(2) });
    expect(byId['thread:40']).toMatchObject({ kind: 'thread', stage: 'talk', number: 40, threadKind: 'idea' });
    expect(byId['thread:41']).toMatchObject({ kind: 'thread', number: 41, threadKind: 'proposal' });
    expect(byId['proposal:0100-retire']).toMatchObject({ kind: 'proposal', stage: 'decide', slug: '0100-retire', number: 41, title: 'Retire the export', state: 'to-decide', waiting: true, url: 'https://forge.test/pull/41' });
    expect(byId['run:run-01WAITING00000000000000000A']).toMatchObject({ kind: 'run', stage: 'build', state: 'waiting', waiting: true, runId: 'run-01WAITING00000000000000000A' });
    expect(byId['run:run-01DONE0000000000000000000A']).toMatchObject({ state: 'done', open: false, waiting: false });
    expect(byId['deploy:9001']).toMatchObject({ kind: 'deploy', stage: 'ship', state: 'success', deployId: '9001', url: 'https://forge.test/runs/9001', waiting: false });
    expect(byId['new-thing']).toEqual({ id: 'new-thing', kind: 'code', planned: true, label: 'New thing', type: 'service' });
    // what only waits on the maintainer is a spec to decide and a run waiting on an answer
    expect(g.nodes.filter((n) => n.waiting).map((n) => n.id).sort()).toEqual(['proposal:0100-retire', 'run:run-01WAITING00000000000000000A']);
  });

  it('draws every rel, from where it comes', async () => {
    const g = await graphOf(story());
    const all = g.edges.map((e) => `${e.from} ${e.rel} ${e.to}`);
    for (const line of [
      'thread:40 became proposal:0100-retire',                       // the spec PR names the idea
      'thread:41 discusses proposal:0100-retire',                    // a spec PR's conversation
      'thread:40 discusses proposal:0100-retire',                    // an idea's cornfield-thread block
      'issue:14 agent-on run:run-01WAITING00000000000000000A',
      'proposal:0100-retire agent-on run:run-01WAITING00000000000000000A',
      'thread:40 agent-on run:run-01DONE0000000000000000000A',
      'run:run-01WAITING00000000000000000A opened pull:27',
      'pull:27 closes issue:14',
      'pull:20 closes issue:14',
      'pull:22 closes issue:15',
      'pull:22 implements proposal:0100-retire',                     // it closes the build issue of the proposal
      'pull:27 implements proposal:0100-retire',                     // a code run on the proposal opened it
      'pull:20 shipped deploy:9001',                                 // the deploy ran at its merge commit
      'pull:27 changes auth', 'pull:27 changes moved', 'pull:27 changes old',
      'proposal:0100-retire changes auth', 'proposal:0100-retire adds new-thing',
      'run:run-01WAITING00000000000000000A changes auth', 'run:run-01DONE0000000000000000000A changes srv',
      'thread:40 mentions auth', 'thread:40 mentions web', 'thread:41 mentions srv', 'issue:14 mentions auth',
      'deploy:9001 restarts stack-web',
    ]) expect(all, line).toContain(line);
    expect(new Set(g.edges.map((e) => e.rel))).toEqual(new Set(RELS));
  });

  it('never draws an edge to an id that is neither a node of the answer, the map, nor a planned one', async () => {
    const g = await graphOf(story());
    const known = new Set([...g.nodes.map((n) => n.id), ...MAP.nodes.map((n) => n.id)]);
    for (const e of g.edges) { expect(known.has(e.from), e.from).toBe(true); expect(known.has(e.to), e.to).toBe(true); }
    // a [[mention]] of a node that does not exist, a run's node that is gone, an issue it closes that is not here: no edge
    expect(g.edges.some((e) => e.to === 'no-such-node' || e.to === 'gone' || e.to === 'issue:99')).toBe(false);
    expect(rels(g, 'issue:14')).toEqual(['issue:14 mentions auth', 'issue:14 agent-on run:run-01WAITING00000000000000000A']);
    // and the same facts are the same bytes
    expect(JSON.stringify(await graphOf(story()))).toBe(JSON.stringify(g));
  });

  it('draws what is open, and what ended within 14 days', async () => {
    const g = await graphOf(story());
    const ids = g.nodes.map((n) => n.id);
    for (const gone of ['pull:19', 'issue:16', 'run:run-01OLD00000000000000000000A', 'deploy:9002']) expect(ids).not.toContain(gone);
    expect(ids).not.toContain('deploy:9003'); // a workflow that is not a deploy
    for (const here of ['pull:20', 'issue:15', 'run:run-01DONE0000000000000000000A', 'deploy:9001']) expect(ids).toContain(here);
    // time moves: 14 days on, none of the recently ended work is left, what is open still is
    const later = await graphOf(story(), { now: () => NOW + 15 * 86_400_000 });
    expect(later.nodes.map((n) => n.id).filter((id) => ['pull:20', 'pull:22', 'issue:15', 'deploy:9001'].includes(id))).toEqual([]);
    expect(later.nodes.map((n) => n.id)).toContain('pull:27');
  });

  it('a local proposal is a node of its own, until a spec PR holds the slug', async () => {
    const s = story();
    s.where = whereOf();
    fs.writeFileSync(path.join(s.where.root, FOLDER, '0200-local.json'), proposalText({ title: 'Only here', nodes: { add: [{ id: 'local-thing', label: 'Local thing', type: 'api' }] } }));
    fs.writeFileSync(path.join(s.where.root, FOLDER, '0100-retire.json'), proposalText());
    const g = await graphOf(s);
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(byId['proposal:0200-local']).toMatchObject({ kind: 'proposal', stage: 'decide', state: 'local', open: true, waiting: false, number: null, slug: '0200-local', url: null });
    expect(rels(g, 'proposal:0200-local')).toEqual(['proposal:0200-local adds local-thing']);
    expect(byId['proposal:0100-retire'].number).toBe(41); // the PR's wins
    expect(g.nodes.filter((n) => n.id === 'proposal:0100-retire')).toHaveLength(1);
  });

  it('is waiting only for a spec that asks for a decision', async () => {
    const s = story();
    s.forge.data.open[1] = pull(41, { draft: true, body: 'Closes #40' });
    const g = await graphOf(s);
    expect(g.nodes.find((n) => n.id === 'proposal:0100-retire')).toMatchObject({ state: 'draft-pr', waiting: false });
    const stopped = story();
    stopped.runs.list = async () => ({ runs: [run({ status: 'waiting', stopRequested: { at: ago(0.1), by: 'x' } })] });
    expect((await graphOf(stopped)).nodes.find((n) => n.kind === 'run').waiting).toBe(false);
  });
});

describe('what it costs and keeps', () => {
  it('reads a pull request\'s files once for a head, and again only after a push', async () => {
    const s = story();
    s.where = whereOf();
    const first = await graphOf(s);
    const cold = count(s.forge, 'pullFiles');
    expect(cold).toBe(4); // #27, #41, and the two closed in the window (#19 is older), once each
    const commentsCold = count(s.forge, 'comments');
    const filesAndTexts = count(s.forge, 'file');
    expect(filesAndTexts).toBe(1);
    s.forge.calls.length = 0;
    const second = await graphOf(s);
    expect(count(s.forge, 'pullFiles')).toBe(0);
    expect(count(s.forge, 'file')).toBe(0);
    expect(count(s.forge, 'comments')).toBe(0); // no thread has moved
    expect(commentsCold).toBe(3); // the two threads, and the spec PR's review state (kept five minutes per head)
    expect(second).toEqual(first);
    // the lists are asked again each time
    expect(count(s.forge, 'pulls')).toBe(2);
    expect(count(s.forge, 'issues')).toBe(2);
    // a push to #27: a new head, read again, and only that one
    s.forge.data.open[0] = pull(27, { body: 'Closes #14', head: { ref: 'b27', sha: 'h27b' }, updatedAt: ago(0.1) });
    s.forge.data.files[27] = [file('server/auth.js')];
    s.forge.calls.length = 0;
    const third = await graphOf(s);
    expect(s.forge.calls.filter((c) => c[0] === 'pullFiles').map((c) => c[1])).toEqual([27]);
    expect(rels(third, 'pull:27').filter((l) => l.includes('changes'))).toEqual(['pull:27 changes auth']);
    // a thread whose last activity moved is read again
    s.forge.data.openIssues[1] = issue(40, { labels: ['idea'], body: 'An idea about [[auth]].', comments: 2, updatedAt: ago(0.05) });
    s.forge.calls.length = 0;
    await graphOf(s);
    expect(s.forge.calls.filter((c) => c[0] === 'comments').map((c) => c[1])).toEqual([40]);
  });

  it('draws at most 50 open pull requests and 300 files of each, and names the rest', async () => {
    const open = Array.from({ length: 53 }, (_, i) => pull(100 + i, { updatedAt: ago(1 + i / 100) }));
    const map = { nodes: Array.from({ length: 350 }, (_, i) => ({ id: `n${i}`, file: `f${i}` })) };
    const forge = makeForge({ open, files: { 100: map.nodes.map((n) => file(n.file)) } });
    const g = await workGraph(forge, { forge: {}, threads: false }, map, { where: whereOf(), now: () => NOW });
    expect(MAX_OPEN_PULLS).toBe(50);
    expect(g.nodes.filter((n) => n.kind === 'pull')).toHaveLength(50);
    expect(g.nodes.some((n) => n.id === 'pull:152')).toBe(false); // the least recently updated are the ones left out
    expect(g.edges.filter((e) => e.from === 'pull:100')).toHaveLength(300);
    const said = g.problems.filter((p) => p.source === 'pulls').map((p) => p.text);
    expect(said.some((t) => t.includes('53 pull requests are open') && t.includes('#152'))).toBe(true);
    expect(said.some((t) => t.includes('first 300 files') && t.includes('#100 changes 350'))).toBe(true);
  });
});

describe('when a source fails, the rest is answered and a line says why', () => {
  it('the issues', async () => {
    const s = story();
    s.forge.data.fail.issues = new ForgeError('GitHub says no.', { code: 'unavailable' });
    const g = await graphOf(s);
    expect(g.nodes.some((n) => n.kind === 'pull')).toBe(true);
    expect(g.nodes.some((n) => n.kind === 'issue')).toBe(false);
    expect(g.problems.map((p) => p.source)).toEqual(['issues', 'issues']);
    expect(g.problems[0].text).toContain('GitHub says no.');
  });
  it('the runs store', async () => {
    const s = story();
    s.runs.list = async () => { throw new Error('no such table: runs'); };
    const g = await graphOf(s);
    expect(g.nodes.some((n) => n.kind === 'run')).toBe(false);
    expect(g.nodes.some((n) => n.kind === 'deploy')).toBe(true);
    expect(g.problems).toEqual([{ source: 'runs', text: expect.stringContaining('The agent runs could not be read') }]);
    const none = await graphOf(story(), { runs: null });
    expect(none.problems.map((p) => p.source)).toEqual(['runs']);
  });
  it('the deploys, when the forge cannot list them', async () => {
    const s = story();
    s.forge.data.fail.runs = new ForgeError('Not allowed.', { code: 'forbidden' });
    const g = await graphOf(s);
    expect(g.nodes.some((n) => n.kind === 'deploy')).toBe(false);
    expect(g.problems).toEqual([{ source: 'deploys', text: expect.stringContaining('The deploys could not be read') }]);
  });
  it('threads, when they are off', async () => {
    const s = story();
    s.config.threads = false;
    const g = await graphOf(s);
    expect(g.nodes.some((n) => n.kind === 'thread')).toBe(false);
    expect(g.nodes.find((n) => n.id === 'issue:40')).toMatchObject({ kind: 'issue' }); // an idea is only an issue now
    expect(g.problems).toEqual([{ source: 'threads', text: expect.stringContaining('Threads are off') }]);
  });
  it('a thread\'s comments, a pull request\'s files, a proposal\'s file', async () => {
    const s = story();
    s.forge.data.fail.comments = new ForgeError('Slow down.', { code: 'rate-limited' });
    const g = await graphOf(s);
    expect(g.nodes.filter((n) => n.kind === 'thread').map((n) => n.id).sort()).toEqual(['thread:40', 'thread:41']);
    expect(g.problems.map((p) => p.source)).toContain('threads');
    const t = story();
    t.forge.pullFiles = async (n) => { if (n === 27) throw new ForgeError('Bad gateway.', { code: 'unavailable' }); return t.forge.data.files[n] ?? []; };
    const h = await graphOf(t);
    expect(h.nodes.map((n) => n.id)).toContain('pull:27');
    expect(h.edges.some((e) => e.from === 'pull:27' && e.rel === 'changes')).toBe(false);
    expect(h.problems[0].text).toMatch(/files of pull request #27 could not be read/);
    const u = story();
    u.forge.data.texts = {};
    const k = await graphOf(u);
    expect(k.nodes.map((n) => n.id)).toContain('proposal:0100-retire');
    expect(k.problems.map((p) => p.text).join()).toMatch(/proposal file/);
  });
  it('the map', async () => {
    const g = await workGraph(story().forge, story().config, null, { where: whereOf(), now: () => NOW });
    expect(g.problems.some((p) => p.source === 'map')).toBe(true);
    expect(g.nodes.some((n) => n.kind === 'pull')).toBe(true);
    expect(g.edges.some((e) => e.rel === 'changes' && !e.to.startsWith('new-thing'))).toBe(false);
  });
  it('the whole forge, with nothing read of it: the error itself, so the last answer can be served', async () => {
    const forge = makeForge();
    forge.pulls = forge.issues = forge.runs = async () => { throw new ForgeError('API rate limit exceeded.', { code: 'rate-limited' }); };
    await expect(workGraph(forge, { forge: {} }, MAP, { where: whereOf(), now: () => NOW })).rejects.toMatchObject({ code: 'rate-limited' });
  });
});

describe('what an attack on the rels found', () => {
  it('closes only an issue or an idea: never a spec PR\'s conversation, which is a pull request', async () => {
    const s = story();
    s.forge.data.open[0] = pull(27, { body: 'Closes #41, fixes #14 and closes #40.', updatedAt: ago(0.2) });
    const g = await graphOf(s);
    expect(rels(g, 'pull:27').filter((l) => l.includes(' closes '))).toEqual(['pull:27 closes issue:14', 'pull:27 closes thread:40']);
    // a spec PR that names another spec PR's number has not become it either
    const t = story();
    t.forge.data.open[1] = pull(41, { title: 'Spec: retire the export', body: 'Thread: #41\nCloses #40', updatedAt: ago(0.4) });
    expect(rels(await graphOf(t), undefined, 'proposal:0100-retire').filter((l) => l.includes(' became '))).toEqual(['thread:40 became proposal:0100-retire']);
  });

  it('ships by the merge commit: a squash-merged pull request\'s head is not what a deploy at it shipped', async () => {
    const s = story();
    s.forge.data.closed[0] = pull(20, { state: 'merged', mergedAt: ago(3), updatedAt: ago(3), mergeSha: 'squash20', head: { ref: 'b20', sha: 'm20' }, body: 'Closes #14' });
    expect(rels(await graphOf(s)).filter((l) => l.includes(' shipped '))).toEqual([]);
    s.forge.data.closed[0] = pull(20, { state: 'merged', mergedAt: ago(3), updatedAt: ago(3), mergeSha: null, head: { ref: 'b20', sha: 'm20' } });
    expect(rels(await graphOf(s)).filter((l) => l.includes(' shipped '))).toEqual(['pull:20 shipped deploy:9001']); // no merge commit said: its head
  });

  it('a pull request closed between the two lists is one node; a closed one is in the window by when it closed, not by a later comment', async () => {
    const s = story();
    s.forge.data.closed.push(pull(27, { state: 'closed', updatedAt: ago(0.1) }), pull(18, { state: 'closed', closedAt: ago(20), updatedAt: ago(1) }));
    const g = await graphOf(s);
    expect(g.nodes.filter((n) => n.id === 'pull:27')).toEqual([expect.objectContaining({ state: 'open' })]);
    expect(g.nodes.map((n) => n.id)).not.toContain('pull:18');
    expect(s.forge.calls.filter((c) => c[0] === 'pullFiles' && c[1] === 27)).toHaveLength(1);
  });

  it('asks for the closed work that moved in the window, so an old issue closed today is drawn, and says when a list came back full', async () => {
    const s = story();
    s.forge.data.closedIssues.push(issue(3, { state: 'closed', createdAt: ago(400), updatedAt: ago(0.1), closedAt: ago(0.1) }));
    const g = await graphOf(s);
    expect(g.nodes.map((n) => n.id)).toContain('issue:3');
    const asked = s.forge.calls.filter((c) => c[0] === 'pulls' || c[0] === 'issues').map((c) => [c[0], c[2]]);
    expect(asked).toContainEqual(['pulls', expect.objectContaining({ state: 'closed', sort: 'updated' })]);
    expect(asked).toContainEqual(['issues', expect.objectContaining({ state: 'closed', since: ago(WINDOW_DAYS) })]);
    expect(asked).toContainEqual(['pulls', { state: 'open' }]); // every open one, as the Specs list asks
    expect(g.problems).toEqual([]);
    // full lists: 200 open issues, 100 closed pull requests all in the window, 100 workflow runs reaching into it
    const full = story();
    full.forge.data.openIssues = Array.from({ length: 200 }, (_, i) => issue(1000 + i));
    full.forge.data.closed = Array.from({ length: 100 }, (_, i) => pull(500 - i, { state: 'merged', mergedAt: ago(1 + i / 10), updatedAt: ago(1 + i / 10) }));
    full.forge.data.closedIssues = Array.from({ length: 100 }, (_, i) => issue(3000 + i, { state: 'closed', closedAt: ago(1), updatedAt: ago(1) }));
    full.forge.data.runs = Array.from({ length: 100 }, (_, i) => ({ id: String(8000 + i), workflow: 'ci.yml', name: 'CI', title: 't', event: 'push', branch: 'main', sha: 's', state: 'success', actor: null, url: null, createdAt: ago(i / 20), updatedAt: ago(i / 20) }));
    const said = (await graphOf(full)).problems.map((p) => `${p.source}: ${p.text}`);
    expect(said).toEqual(expect.arrayContaining([
      expect.stringMatching(/^issues: 200 or more issues are open/),
      expect.stringMatching(/^issues: 100 or more closed issues moved in the last 14 days/),
      expect.stringMatching(/^pulls: Only the 100 most recently updated closed pull requests were read/),
      expect.stringMatching(/^pulls: 100 pull requests were closed in the last 14 days: the 50 newest are drawn/),
      expect.stringMatching(/^deploys: Only the 100 newest workflow runs were read/),
    ]));
  });

  it('a map node whose id looks like work is left out, and said: an id names one thing', async () => {
    const map = { nodes: [...MAP.nodes, { id: 'pull:27', file: 'web/new.js' }, { id: 'issue:14', label: 'x' }] };
    const s = story();
    s.forge.data.texts[`h41:${FOLDER}/0100-retire.json`] = proposalText({ nodes: { add: [{ id: 'run:fake', label: 'r' }, { id: 'new-thing' }], change: [{ id: 'auth' }] } });
    const g = await workGraph(s.forge, s.config, map, { where: whereOf(), runs: s.runs, now: () => NOW });
    expect(g.problems).toEqual([{ source: 'map', text: expect.stringContaining('pull:27, issue:14') }]);
    expect(g.nodes.filter((n) => n.id === 'pull:27' || n.id === 'issue:14').map((n) => n.kind)).toEqual(['issue', 'pull']);
    expect(g.nodes.some((n) => n.id === 'run:fake')).toBe(false);
    expect(rels(g, 'proposal:0100-retire').filter((l) => l.includes(' adds '))).toEqual(['proposal:0100-retire adds new-thing']);
    const ids = g.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a deleted file changes its node, a file off the map changes none; a run with no nodes, a deploy with no commit and a block naming no proposal draw nothing', async () => {
    const s = story();
    s.forge.data.files[27] = [file('server/auth.js', { status: 'removed' }), file('docs/not-on-the-map.md', { status: 'added' })];
    s.forge.data.comments[40] = [{ id: '1', author: { login: 'maintainer-one' }, body: '```cornfield-thread\n{"proposal":"9999-no-such","nodes":[]}\n```', url: 'u', createdAt: ago(1), updatedAt: ago(1) }];
    s.forge.data.runs.push({ id: '9004', workflow: 'deploy.yml', name: 'Deploy web', title: 'No commit', event: 'workflow_dispatch', branch: '', sha: '', state: 'success', actor: null, url: null, createdAt: ago(1), updatedAt: ago(1) });
    s.forge.data.closed.push(pull(21, { state: 'merged', mergedAt: ago(1), updatedAt: ago(1), mergeSha: null, head: { ref: 'b21', sha: '' } }));
    s.runs.list = async () => ({ runs: [run({ runId: 'run-01EMPTY000000000000000000A', nodes: [], pull: null, refs: {} })] });
    const g = await graphOf(s);
    expect(rels(g, 'pull:27').filter((l) => l.includes(' changes '))).toEqual(['pull:27 changes auth']);
    expect(rels(g, 'thread:40').filter((l) => l.includes(' discusses '))).toEqual([]);
    expect(rels(g, 'deploy:9004')).toEqual(['deploy:9004 restarts stack-web']);
    expect(rels(g, 'run:run-01EMPTY000000000000000000A')).toEqual([]);
    expect(rels(g, 'pull:21')).toEqual([]);
  });

  it('a link is http(s) or none: a runner\'s report that says javascript: is no link', async () => {
    const s = story();
    s.runs.list = async () => ({ runs: [run({ report: { url: 'javascript:alert(1)', at: ago(0.1) }, comment: { url: 'https://forge.test/c/1' } })] });
    s.forge.data.open[0] = pull(27, { url: 'data:text/html,x', body: 'Closes #14' });
    const g = await graphOf(s);
    expect(g.nodes.find((n) => n.kind === 'run').url).toBe('https://forge.test/c/1');
    expect(g.nodes.find((n) => n.id === 'pull:27').url).toBe(null);
  });

  it('the files of a head are asked once even when two answers are worked out side by side (the Specs list and the graph as a page opens)', async () => {
    const s = story();
    s.where = whereOf();
    s.forge.data.slow = 20;
    await Promise.all([graphOf(s), graphOf(s), listPullProposals(s.forge, s.where)]);
    expect(count(s.forge, 'pullFiles')).toBe(4);
  });
});

describe('waiting is the page\'s number, both ways', () => {
  /** The page's number from the same forge: the Specs list's entries (server/proposals.js `listWithPulls`), merged as the page merges them, and the runs */
  async function pageNumber(forge, where, runList) {
    const { entries } = await listPullProposals(forge, where);
    const states = await reviewStates(forge, where, entries, { now: () => NOW });
    const specs = mergeSpecs(entries.map((e, i) => ({ slug: e.slug, source: e.source, pull: { ...e.pull, pushedAt: states[i].pushedAt }, review: states[i].review })));
    return waiting({ specs, runs: runList }).total;
  }
  const review = (slug, verdict, at, text) => ({ id: `r-${slug}-${at}`, author: { login: 'maintainer-one' }, body: reviewComment(slug, { verdict, note: verdict === 'notes' ? 'Not yet.' : '', edits: [], ...(verdict === 'approved' ? { proposal: proposalHash(text) } : {}) }, { login: 'maintainer-one' }), url: 'u', createdAt: at, updatedAt: at });

  it('to decide, sent back, a draft, approved, approved and changed since, the same slug in two spec PRs, one past the 50 open pull requests drawn, a run asked to stop', async () => {
    const text = (slug) => proposalText({ title: slug });
    const specs = [
      { n: 61, slug: '0201-decide', updated: ago(0.9) },                     // never reviewed: to decide (the most recently updated holder of its slug)
      { n: 62, slug: '0202-sent-back', review: 'notes' },                    // sent back, nothing pushed since: with the agent
      { n: 63, slug: '0203-draft', draft: true },                            // a draft PR
      { n: 64, slug: '0204-approved', review: 'approved' },                  // approved at this file
      { n: 65, slug: '0205-changed', review: 'approved', changed: true },    // approved, then the file changed: to decide
      { n: 66, slug: '0201-decide' },                                        // the same slug in a second spec PR: a row of its own
      { n: 67, slug: '0207-old', updated: ago(9) },                          // to decide, and the least recently updated open pull request
    ];
    const plain = Array.from({ length: 55 }, (_, i) => pull(200 + i, { updatedAt: ago(0.5 + i / 100) }));
    const open = [...plain, ...specs.map((x) => pull(x.n, { title: `Spec ${x.slug}`, draft: !!x.draft, updatedAt: x.updated ?? ago(1), head: { ref: `s${x.n}`, sha: `h${x.n}` } }))];
    const files = Object.fromEntries(specs.map((x) => [x.n, [file(`${FOLDER}/${x.slug}.json`, { status: 'added' })]]));
    const texts = Object.fromEntries(specs.map((x) => [`h${x.n}:${FOLDER}/${x.slug}.json`, text(x.slug)]));
    const comments = Object.fromEntries(specs.filter((x) => x.review).map((x) => [x.n, [review(x.slug, x.review, ago(0.5), x.changed ? 'an older file' : text(x.slug))]]));
    const forge = makeForge({ open, files, texts, comments });
    forge.pullCommits = async () => [{ sha: 'c', message: 'm', date: ago(2) }];
    const runList = [
      run({ runId: 'run-01WAIT0000000000000000000A', status: 'waiting' }),
      run({ runId: 'run-01STOP0000000000000000000A', status: 'waiting', stopRequested: { at: ago(0.1), by: 'maintainer-one' } }),
      run({ runId: 'run-01WORK0000000000000000000A', status: 'working' }),
    ];
    const where = whereOf();
    const g = await workGraph(forge, { forge: {}, threads: false }, MAP, { where, runs: { list: async () => ({ runs: runList }) }, now: () => NOW });
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(Object.fromEntries(Object.values(byId).filter((n) => n.kind === 'proposal').map((n) => [n.id, [n.number, n.state, n.waiting]]))).toEqual({
      'proposal:0201-decide': [61, 'to-decide', true], 'proposal:0201-decide@66': [66, 'to-decide', true], 'proposal:0202-sent-back': [62, 'sent-back', false],
      'proposal:0203-draft': [63, 'draft-pr', false], 'proposal:0204-approved': [64, 'approved', false], 'proposal:0205-changed': [65, 'changed', true],
      'proposal:0207-old': [67, 'to-decide', true],
    });
    expect(g.nodes.filter((n) => n.kind === 'pull')).toHaveLength(MAX_OPEN_PULLS);
    const graphCount = g.nodes.filter((n) => n.waiting).length;
    expect(graphCount).toBe(5); // four specs (one of them twice) and the run that waits; not the one asked to stop
    expect(await pageNumber(forge, where, runList)).toBe(graphCount);
  });
});
