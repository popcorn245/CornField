/**
 * @vitest-environment node
 *
 * The issues and PRs panel without a page (CF-07, explorer/forge-panel-model.js): the filters, the words, which
 * node a file is (the deepest `file` that holds it), which tests a failing check names, what a pull request lights
 * in a built scene, and a failed request in plain words. The recorded answers are the forge fixtures'.
 */
import { describe, it, expect } from 'vitest';
import {
  listUrl, serverState, matches, filterItems, facetsOf, stateWords, metaWords, checkWords, checksWords, nodesForFile, isTestPath, testFilesOf, litFor,
  paintForge, errorWords, FORGE_DIM_ALPHA, FORGE_FAIL_COLOR, defaultFilters,
  // @ts-expect-error plain JS modules, no declarations
} from '../../explorer/forge-panel-model.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene } from '../../explorer/scene.js';
import { loadSample } from '../helpers.js';

const pull = (number, extra = {}) => ({
  number, title: `Pull ${number}`, state: 'open', draft: false, author: { login: 'agent-four', url: null }, labels: [], head: { ref: 'b', sha: 'abc' }, base: { ref: 'main' },
  url: `https://git.example.test/owner/name/pull/${number}`, createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-17T11:00:00Z', mergedAt: null, ...extra,
});
const PULLS = [
  pull(13, { labels: ['agent'] }), pull(12, { title: 'Meals page' }), pull(14, { draft: true, author: { login: 'maintainer-one', url: null } }),
  pull(9, { state: 'merged', title: 'Old work', author: { login: 'maintainer-one', url: null }, labels: ['v1'] }), pull(8, { state: 'closed', title: 'Dropped' }),
];

describe('what is asked of the server', () => {
  it('asks for the kind and the state, a merged pull request being a closed one', () => {
    expect(listUrl('pulls', 'open')).toBe('/api/forge/pulls?state=open&limit=100');
    expect(listUrl('pulls', 'merged')).toBe('/api/forge/pulls?state=closed&limit=100');
    expect(listUrl('issues', 'all')).toBe('/api/forge/issues?state=all&limit=100');
    expect(serverState('merged')).toBe('closed');
    expect(serverState('open')).toBe('open');
  });
});

describe('the filters', () => {
  it('state: open is open (drafts too), merged landed, closed did not, all everything', () => {
    const nums = (state) => filterItems(PULLS, 'pulls', { state }).map((p) => p.number);
    expect(nums('open')).toEqual([13, 12, 14]);
    expect(nums('merged')).toEqual([9]);
    expect(nums('closed')).toEqual([8]);
    expect(nums('all')).toEqual([13, 12, 14, 9, 8]);
  });

  it('an issue is open or closed', () => {
    const issues = [{ ...pull(5), state: 'open' }, { ...pull(2), state: 'closed' }];
    expect(filterItems(issues, 'issues', { state: 'closed' }).map((i) => i.number)).toEqual([2]);
    expect(filterItems(issues, 'issues', { state: 'all' })).toHaveLength(2);
  });

  it('label, author and words of the search narrow it down together', () => {
    const all = { state: 'all' };
    expect(filterItems(PULLS, 'pulls', { ...all, label: 'agent' }).map((p) => p.number)).toEqual([13]);
    expect(filterItems(PULLS, 'pulls', { ...all, author: 'maintainer-one' }).map((p) => p.number)).toEqual([14, 9]);
    expect(filterItems(PULLS, 'pulls', { ...all, text: 'MEALS' }).map((p) => p.number)).toEqual([12]);
    expect(filterItems(PULLS, 'pulls', { ...all, text: '#13' }).map((p) => p.number)).toEqual([13]);
    expect(filterItems(PULLS, 'pulls', { ...all, text: 'old v1' }).map((p) => p.number)).toEqual([9]);
    expect(filterItems(PULLS, 'pulls', { ...all, author: 'maintainer-one', label: 'agent' })).toEqual([]);
    expect(matches({ ...pull(1), author: null }, 'pulls', { ...defaultFilters(), author: 'agent-four' })).toBe(false);
  });

  it('offers the labels and the authors that are in the list, once, sorted', () => {
    expect(facetsOf(PULLS)).toEqual({ labels: ['agent', 'v1'], authors: ['agent-four', 'maintainer-one'] });
    expect(facetsOf([])).toEqual({ labels: [], authors: [] });
  });
});

describe('the words', () => {
  it('says a state, and who and when', () => {
    expect(PULLS.map(stateWords)).toEqual(['Open', 'Open', 'Draft', 'Merged', 'Closed']);
    const now = Date.parse('2026-10-19T12:00:00Z');
    expect(metaWords(pull(12), now)).toBe('#12 · agent-four · 2 days ago');
    expect(metaWords({ ...pull(12), author: null, updatedAt: 'nonsense' }, now)).toBe('#12 · someone');
  });

  it('says each check, and all of them in one line', () => {
    const c = (state) => ({ name: 'x', state });
    expect(['success', 'failure', 'running', 'queued', 'neutral', 'skipped', 'cancelled'].map((s) => checkWords(c(s)))).toEqual(['passed', 'failed', 'running', 'waiting', 'neutral', 'skipped', 'cancelled']);
    expect(checksWords([])).toBe('No checks');
    expect(checksWords([c('success')])).toBe('1 check passed');
    expect(checksWords([c('success'), c('neutral')])).toBe('All 2 passed');
    expect(checksWords([c('failure'), c('running'), c('queued'), c('success')])).toBe('1 failed, 2 still running');
    expect(checksWords([c('cancelled'), c('failure'), c('failure')])).toBe('2 failed, 1 cancelled');
  });

  it('says a failure in words: the server\'s own, a sign-in that ended, a server that is gone', () => {
    expect(errorWords(429, { error: 'GitHub asked cornfield to slow down; try again in 40 seconds.' })).toBe('GitHub asked cornfield to slow down; try again in 40 seconds.');
    expect(errorWords(401, { ok: false, error: 'Sign in first.' })).toMatch(/^Your sign-in has ended/);
    expect(errorWords(null, null)).toMatch(/could not be reached/);
    expect(errorWords(500, null)).toBe('cornfield answered 500 for the forge.');
  });
});

describe('a file is the node that holds it', () => {
  const nodes = [
    { id: 'root', file: 'package.json' },
    { id: 'pkg-server', file: 'server' },
    { id: 'core-server', file: 'server/server.js' },
    { id: 'page-a', file: 'api/orders.js' },
    { id: 'page-b', file: 'api/orders.js' },
    { id: 'live', type: 'room' },
    { id: 'pkg-deep', file: 'server/deep' },
  ];
  const ids = (path) => nodesForFile(path, nodes).map((n) => n.id);

  it('picks the node whose file is the path, else the deepest folder above it', () => {
    expect(ids('server/server.js')).toEqual(['core-server']);
    expect(ids('server/forge.js')).toEqual(['pkg-server']);
    expect(ids('server/deep/x/y.js')).toEqual(['pkg-deep']);
    expect(ids('package.json')).toEqual(['root']);
  });

  it('lights every node a file holds, and none for a file on no node (a folder is not a prefix of a name)', () => {
    expect(ids('api/orders.js')).toEqual(['page-a', 'page-b']);
    expect(ids('README.md')).toEqual([]);
    expect(ids('servers/x.js')).toEqual([]);
    expect(ids('./server/server.js')).toEqual(['core-server']);
  });
});

describe('the test files a check names', () => {
  it('knows a test file by its path', () => {
    for (const p of ['test/server/auth.test.js', 'src/a.spec.ts', 'pkg/__tests__/a.js', 'x_test.go', 'tests/test_a.py', 'tests/a.py']) expect(isTestPath(p), p).toBe(true);
    for (const p of ['server/auth.js', 'test', 'testing.js', 'docs/tests.md']) expect(isTestPath(p), p).toBe(false);
  });

  it('takes the words of a check\'s name that are test files, and completes a short name from the known paths', () => {
    const known = ['server/auth.js', 'test/server/auth.test.js', 'test/explorer/a.test.js', 'test/core/a.test.js'];
    expect(testFilesOf({ name: 'vitest test/server/auth.test.js' }, known)).toEqual(['test/server/auth.test.js']);
    expect(testFilesOf({ name: 'test (auth.test.js, test/explorer/a.test.js)' }, known)).toEqual(['test/server/auth.test.js', 'test/explorer/a.test.js']);
    expect(testFilesOf({ name: 'a.test.js' }, known)).toEqual(['a.test.js']); // two files end like it: not guessed
    expect(testFilesOf({ name: 'lint' }, known)).toEqual([]);
    expect(testFilesOf({ name: 'test' }, known)).toEqual([]);
  });
});

describe('what a pull request lights', () => {
  const nodes = [
    { id: 'core-server', file: 'server/server.js' }, { id: 'pkg-server', file: 'server' }, { id: 'core-old', file: 'server/old.js' },
    { id: 'tests-auth', file: 'test/server/auth.test.js' }, { id: 'root', file: 'package.json' },
  ];
  const files = [
    { path: 'server/server.js', status: 'modified', additions: 3, deletions: 1 },
    { path: 'server/meals.js', previousPath: 'server/old.js', status: 'renamed', additions: 0, deletions: 0 },
    { path: 'docs/specs/proposals/0013-meals.json', status: 'added', additions: 40, deletions: 0 },
    { path: 'test/server/auth.test.js', status: 'modified' },
  ];
  const checks = [{ id: 'run:1', name: 'vitest test/server/auth.test.js', state: 'failure' }, { id: 'run:2', name: 'lint', state: 'failure' }, { id: 'run:3', name: 'build', state: 'success' }];

  it('lists every file with its nodes (a file on none is listed, not dropped), a rename with the old path\'s node too', () => {
    const lit = litFor({ files, checks }, nodes);
    expect(lit.files.map((f) => [f.path, f.nodes.map((n) => n.id)])).toEqual([
      ['server/server.js', ['core-server']],
      ['server/meals.js', ['pkg-server', 'core-old']],
      ['docs/specs/proposals/0013-meals.json', []],
      ['test/server/auth.test.js', ['tests-auth']],
    ]);
    expect(lit.files[3]).toMatchObject({ additions: 0, deletions: 0 });
    expect([...lit.changed].sort()).toEqual(['core-old', 'core-server', 'pkg-server', 'tests-auth']);
  });

  it('lights the tests a failing check names, and says what a failing check that names none lights', () => {
    const lit = litFor({ files, checks }, nodes);
    expect([...lit.failing]).toEqual(['tests-auth']);
    expect(lit.checks.map((c) => [c.check.name, c.tests.map((t) => [t.path, t.nodes.map((n) => n.id)])])).toEqual([
      ['vitest test/server/auth.test.js', [['test/server/auth.test.js', ['tests-auth']]]],
      ['lint', []],
    ]);
  });

  it('lists a named test that is on no node, lighting nothing for it', () => {
    const lit = litFor({ files: [], checks: [{ id: 'x', name: 'pytest tests/test_x.py', state: 'failure' }] }, nodes);
    expect(lit.checks[0].tests).toEqual([{ path: 'tests/test_x.py', nodes: [] }]);
    expect(lit.failing.size).toBe(0);
  });
});

describe('the picture', () => {
  const map = loadSample();
  const nodes = map.nodes.map((n, i) => ({ ...n, x: i * 40, y: (i % 5) * 40 }));
  const st = (forgeLit) => ({
    nodes, edges: map.edges, view: 'orbit', flow: null, rings: { rings: [], clusters: [] }, camera: { x: 0, y: 0, zoom: 1 }, width: 800, height: 600,
    selectedNode: null, searchQuery: '', isFreeform: false, theme: 'dark', forgeLit,
    activeLayers: { app: true, pkg: true, page: true, atom: true, molecule: true, token: true, tool: true, flow: true, table: true, rom: true, service: true, cloud: true, web: true, stack: true, machine: true, container: true, device: true, house: true, persona: true },
    scenario: null, sceneVersion: 1,
  });
  const lit = (changed, failing = []) => ({ changed: new Set(changed), failing: new Set(failing) });

  it('lights the nodes a pull request changes and fades the rest back, edges too', () => {
    const [a, b, c] = nodes.filter((n) => n.type === 'page' || n.type === 'pkg').map((n) => n.id);
    const plain = buildScene(st(null));
    const scene = buildScene(st(lit([a, b])));
    for (const n of scene.nodes) {
      if (n.id === a || n.id === b) expect([n.alpha, n.halo, n.labelKeep], n.id).toEqual([1, 'match', true]);
      else expect(n.alpha, n.id).toBeLessThanOrEqual(FORGE_DIM_ALPHA);
    }
    expect(scene.nodes.find((n) => n.id === c).glow).toBe(0);
    const touching = scene.edges.filter((e) => e.from === a || e.to === a || e.from === b || e.to === b);
    expect(touching.some((e) => e.alpha === plain.edges.find((p) => p.key === e.key).alpha)).toBe(true);
    expect(scene.edges.filter((e) => ![a, b].includes(e.from) && ![a, b].includes(e.to)).every((e) => e.alpha <= FORGE_DIM_ALPHA / 2)).toBe(true);
  });

  it('turns the tests of a failing check red, and keeps the selection\'s halo', () => {
    const [a, b] = nodes.map((n) => n.id);
    const scene = buildScene({ ...st(lit([a], [b])), selectedNode: nodes[0] });
    expect(scene.nodes.find((n) => n.id === b).color).toBe(FORGE_FAIL_COLOR);
    expect(scene.nodes.find((n) => n.id === a).halo).toBe('selected');
  });

  it('leaves the scene alone when nothing is lit, and follows the light theme with the rest', () => {
    const plain = JSON.stringify(buildScene(st(null)));
    expect(JSON.stringify(buildScene(st(lit([]))))).toBe(plain);
    const dark = buildScene(st(lit([], [nodes[1].id])));
    const light = buildScene({ ...st(lit([], [nodes[1].id])), theme: 'light' });
    expect(light.nodes.find((n) => n.id === nodes[1].id).color).not.toBe(dark.nodes.find((n) => n.id === nodes[1].id).color);
    expect(paintForge({ nodes: [], edges: [] }, null)).toBeUndefined();
  });
});
