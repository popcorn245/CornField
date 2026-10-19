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
  mergeBlock, rerunWhy, confirmMerge, mergeBody, actionUrl, actionWords,
  specBlock, buildOffers, planUrl, confirmSpec, confirmBuild, specBody, buildBody, existingWords,
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

describe('actions: why not, what is confirmed, what is said', () => {
  const check = (state, extra = {}) => ({ id: `run:${state}`, name: state, state, url: null, rerunnable: false, canRerun: false, ...extra });
  const detail = (extra = {}, checks = [check('success')]) => ({ pull: pull(12, { head: { ref: 'feature/meals', sha: 'abc0000000000000000000000000000000000000' } }), checks, ...extra });

  it('lets a green, open, ready pull request land and gives every other a reason', () => {
    expect(mergeBlock(detail())).toBe(null);
    expect(mergeBlock(detail({}, [check('success'), check('neutral'), check('skipped')]))).toBe(null);
    expect(mergeBlock({ ...detail(), pull: pull(12, { state: 'merged' }) })).toBe('It has landed already.');
    expect(mergeBlock({ ...detail(), pull: pull(12, { state: 'closed' }) })).toBe('It is closed, so it cannot be landed.');
    expect(mergeBlock({ ...detail(), pull: pull(12, { draft: true }) })).toBe('It is a draft: mark it ready on the forge first.');
    expect(mergeBlock(detail({}, []))).toBe('It has no checks, so nothing says it works.');
    expect(mergeBlock(detail({}, [check('failure', { name: 'lint' }), check('running', { name: 'test' }), check('queued', { name: 'build' }), check('cancelled', { name: 'e2e' })])))
      .toBe('Not every check is green: lint failed; test is still running; build is waiting to run; e2e was cancelled.');
    expect(mergeBlock(detail({ stale: 'GitHub could not be reached.' }))).toBe('This is an older answer from the forge: refresh before landing it.');
  });

  it('says why a failed or cancelled check has no Re-run, and nothing for the rest', () => {
    expect(rerunWhy(check('failure'), 'GitHub')).toBe('GitHub does not let cornfield re-run this one: re-run it there.');
    expect(rerunWhy(check('cancelled'), 'GitHub')).toBe('GitHub does not let cornfield re-run this one: re-run it there.');
    expect(rerunWhy(check('failure', { canRerun: true }), 'GitHub')).toBe(null);
    expect(rerunWhy(check('cancelled', { canRerun: true }), 'GitHub')).toBe(null);
    for (const state of ['success', 'running', 'queued', 'neutral', 'skipped']) expect(rerunWhy(check(state), 'GitHub')).toBe(null);
  });

  it('says how it will land: the config\'s merge method', () => {
    const d = detail({}, [check('success', { name: 'test' })]);
    const how = (m) => Object.fromEntries(confirmMerge(d, 'GitHub', m).lines).How;
    expect(how(undefined)).toBe('A merge commit, made by GitHub');
    expect(how('squash')).toBe('Squashed into one commit, made by GitHub');
    expect(how('rebase')).toBe('Its commits rebased onto the base, made by GitHub');
  });

  it('shows what will land: the pull request, the commit, where it goes, each check; and sends only the head shown', () => {
    const d = detail({}, [check('success', { name: 'test' }), check('neutral', { name: 'docs' })]);
    const c = confirmMerge(d, 'GitHub');
    expect(c.title).toBe('Land pull request #12?');
    expect(c.lines).toEqual([
      ['Pull request', '#12 Pull 12'], ['Commit', 'abc0000000000000000000000000000000000000'], ['From', 'feature/meals'], ['Into', 'main'], ['How', 'A merge commit, made by GitHub'], ['Checks', 'All 2 passed'],
    ]);
    expect(c.checks).toEqual([{ name: 'test', words: 'passed' }, { name: 'docs', words: 'neutral' }]);
    expect(c.note).toBe('Only this commit lands, and only while its checks are green on GitHub. Nothing is deployed.');
    expect(mergeBody(d)).toEqual({ sha: 'abc0000000000000000000000000000000000000' });
    expect(actionUrl(12, 'merge')).toBe('/api/forge/pulls/12/merge');
    expect(actionUrl(13, 'rerun')).toBe('/api/forge/pulls/13/rerun');
  });

  it('says an answer in words: landed, re-running, refused, signed out, unreachable', () => {
    expect(actionWords('merge', 200, { ok: true, sha: 'fff0000000000000000000000000000000000000' }, 12)).toBe('Pull request #12 landed as fff0000.');
    expect(actionWords('merge', 200, { ok: true }, 12)).toBe('Pull request #12 landed.');
    expect(actionWords('rerun', 202, { ok: true, name: 'lint' }, 13)).toBe('lint is running again.');
    expect(actionWords('merge', 409, { ok: false, error: 'Pull request #12 is not green: lint failed.' }, 12)).toBe('Pull request #12 was not landed: Pull request #12 is not green: lint failed.');
    expect(actionWords('rerun', 403, { ok: false, error: 'Only the repo\'s maintainers land pull requests or re-run checks; x is not one now.' }, 13)).toMatch(/^The check was not re-run: Only the repo's maintainers/);
    expect(actionWords('merge', 401, null, 12)).toBe('Pull request #12 was not landed: your sign-in has ended. Sign in again.');
    expect(actionWords('merge', 500, null, 12)).toBe('Pull request #12 was not landed: cornfield answered 500.');
    expect(actionWords('merge', null, null, 12)).toBe('Pull request #12 was not landed: cornfield could not be reached. Look at the forge before trying again.');
  });
});

describe('the pipeline\'s steps', () => {
  const specPlan = {
    kind: 'spec', digest: 'a'.repeat(32), issue: { number: 7, title: 'Meals page', url: 'https://git.example.test/owner/name/issues/7' }, base: 'main', branch: 'spec/7-meals-page', path: 'docs/specs/proposals/7-meals-page.json',
    message: 'Start a spec for #7', title: 'Spec: Meals page', body: 'Refs #7\n\nA draft.', content: '{\n  "version": 1\n}\n', existing: null,
  };
  const buildPlan = {
    kind: 'build', digest: 'b'.repeat(32), pull: { number: 40, title: 'Meals spec', url: 'https://git.example.test/owner/name/pull/40' }, slug: '0040-meals', path: 'docs/specs/proposals/0040-meals.json',
    sha: '4040000000000000000000000000000000000000', review: { by: 'maintainer-one', url: 'https://git.example.test/c/1', at: '2026-10-19T10:00:00Z' }, title: 'Build: Meals', body: 'Build it.\n- [ ] Add `page-meals`', items: 1, existing: null,
  };

  it('asks for a plan at the address the step is done at, and posts a spec to its issue', () => {
    expect(planUrl('spec', 7)).toBe('/api/forge/issues/7/spec');
    expect(planUrl('build', 40, '0040-meals')).toBe('/api/forge/pulls/40/build?slug=0040-meals');
    expect(planUrl('build', 40, 'a b&c')).toBe('/api/forge/pulls/40/build?slug=a%20b%26c');
    expect(actionUrl(7, 'spec')).toBe('/api/forge/issues/7/spec');
    expect(actionUrl(40, 'build')).toBe('/api/forge/pulls/40/build');
  });

  it('offers a spec on an open issue only', () => {
    expect(specBlock({ state: 'open' })).toBe(null);
    expect(specBlock({ state: 'closed' })).toBe('It is closed, so no spec is started for it.');
  });

  it('offers the build issue for an approved proposal of an open pull request, and says why not for the others', () => {
    const detail = (specs, extra = {}, state = 'open') => ({ pull: { state }, specs, ...extra });
    expect(buildOffers(detail([{ slug: 'a', path: 'p/a.json', approved: true }, { slug: 'b', path: 'p/b.json', approved: false }]))).toEqual([
      { slug: 'a', path: 'p/a.json', approved: true, offer: true, why: '' },
      { slug: 'b', path: 'p/b.json', approved: false, offer: false, why: 'No approval yet: a maintainer approves it in the proposal\'s review first.' },
    ]);
    expect(buildOffers(detail([{ slug: 'a', path: 'p/a.json', approved: true }], { stale: 'GitHub is away' }))[0]).toMatchObject({ offer: false, why: 'This is an older answer from the forge: refresh first.' });
    expect(buildOffers(detail([{ slug: 'a', path: 'p/a.json', approved: true }], {}, 'merged'))).toEqual([]);
    expect(buildOffers(detail(undefined))).toEqual([]);
    expect(buildOffers(null)).toEqual([]);
  });

  it('shows everything a spec makes: the issue, the branch, the file, the pull request, a draft; the file and the description in full', () => {
    const c = confirmSpec(specPlan, 'GitHub');
    expect(c.title).toBe('Start a spec for issue #7?');
    expect(c.lines).toEqual([
      ['Issue', '#7 Meals page'], ['Branch', 'spec/7-meals-page'], ['Starts from', 'main'], ['File', 'docs/specs/proposals/7-meals-page.json'], ['Pull request', 'Spec: Meals page'], ['Draft', 'Yes'],
    ]);
    expect(c.previews).toEqual([{ label: 'docs/specs/proposals/7-meals-page.json (the stub proposal)', text: specPlan.content }, { label: 'The pull request\'s description', text: specPlan.body }]);
    expect(c.note).toBe('Makes this branch, adds this one file in one commit, and opens the draft pull request on GitHub, as you. Nothing else changes and no agent is started.');
    expect(c.go).toBe('Start the spec');
    expect(specBody(specPlan)).toEqual({ digest: 'a'.repeat(32) });
  });

  it('shows everything a build issue makes, and sends the proposal, the commit it was read at and the plan\'s digest', () => {
    const c = confirmBuild(buildPlan, 'Forgejo');
    expect(c.title).toBe('Open the build issue for 0040-meals?');
    expect(Object.fromEntries(c.lines)).toEqual({ 'Spec pull request': '#40 Meals spec', Proposal: 'docs/specs/proposals/0040-meals.json', 'At commit': buildPlan.sha, 'Approved by': 'maintainer-one', Issue: 'Build: Meals', Checklist: '1 item' });
    expect(c.previews).toEqual([{ label: 'The issue\'s description', text: buildPlan.body }]);
    expect(c.note).toContain('on Forgejo');
    expect(c.note).toContain('no agent is started');
    expect(buildBody(buildPlan)).toEqual({ slug: '0040-meals', sha: buildPlan.sha, digest: 'b'.repeat(32) });
  });

  it('says what is made already, and each answer: made, found, refused, unreachable', () => {
    expect(existingWords('spec', { ...specPlan, existing: { number: 50, draft: true } })).toBe('Issue #7 has its spec already: pull request #50 (a draft). Nothing new is made.');
    expect(existingWords('build', { ...buildPlan, existing: { number: 60, state: 'closed' } })).toBe('0040-meals has its build issue already: #60 (closed). Nothing new is made.');
    expect(existingWords('build', { ...buildPlan, existing: { number: 60, state: 'open' } })).toBe('0040-meals has its build issue already: #60. Nothing new is made.');
    expect(actionWords('spec', 201, { ok: true, created: true, pull: { number: 50 } }, 7)).toBe('Spec started for issue #7: draft pull request #50.');
    expect(actionWords('spec', 200, { ok: true, created: false, pull: { number: 50 } }, 7)).toBe('Issue #7 has its spec already: pull request #50. Nothing new was made.');
    expect(actionWords('build', 201, { ok: true, created: true, slug: '0040-meals', issue: { number: 60 } }, 40)).toBe('Build issue #60 opened for 0040-meals.');
    expect(actionWords('build', 200, { ok: true, created: false, slug: '0040-meals', issue: { number: 60 } }, 40)).toBe('0040-meals has its build issue already: #60. Nothing new was made.');
    expect(actionWords('spec', 409, { ok: false, error: 'It changed.' }, 7)).toBe('No spec was started for issue #7: It changed.');
    expect(actionWords('build', 403, { ok: false, error: 'Only the repo\'s maintainers open build issues; x is not one now.' }, 40)).toMatch(/^No build issue was opened for pull request #40: Only the repo's maintainers/);
    expect(actionWords('spec', null, null, 7)).toBe('No spec was started for issue #7: cornfield could not be reached. Look at the forge before trying again.');
  });
});
