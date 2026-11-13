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
    pulls: async ({ state }) => { note('pulls', state); return state === 'open' ? d.open : d.closed; },
    issues: async ({ state }) => { note('issues', state); return state === 'open' ? d.openIssues : d.closedIssues; },
    pullFiles: async (n) => { note('pullFiles', n); return d.files[n] ?? []; },
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
