/**
 * @vitest-environment node
 *
 * explorer/history-model.js (spec 0014 D2): the forge links of a trail (GitHub and Forgejo, https only, each segment encoded), the spec files
 * from the map's doc pages, a node's commits and counts, and what a spec reached.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS module, no declarations
import { forgeLinks, specFiles, nodeTrail, specReach, trailHtml, heatOf, haloWidth, historyRowOf, specBarHtml, commitKind, parentsOf, replayFrame, replayCount, stepWords, speedMs } from '../../explorer/history-model.js';

const sha = 'ab'.repeat(20);

describe('forgeLinks', () => {
  it('links a commit, a pull request and an issue on GitHub and on Forgejo', () => {
    const gh = forgeLinks({ type: 'github', url: 'https://github.com', repo: 'owner/name' });
    expect([gh.commit(sha), gh.pull(4), gh.issue(5)]).toEqual([`https://github.com/owner/name/commit/${sha}`, 'https://github.com/owner/name/pull/4', 'https://github.com/owner/name/issues/5']);
    const fj = forgeLinks({ type: 'forgejo', url: 'https://git.example.test/sub/', repo: 'owner/name', baseBranch: 'main' });
    expect([fj.pull(4), fj.issue(5), fj.file('docs/specs/0001-a.md')]).toEqual(['https://git.example.test/sub/owner/name/pulls/4', 'https://git.example.test/sub/owner/name/issues/5', 'https://git.example.test/sub/owner/name/src/branch/main/docs/specs/0001-a.md']);
  });

  it('links nothing it cannot trust: no https, a user name, a backslash, a bad repo, an unknown forge, a bad hash or number', () => {
    for (const forge of [null, { type: 'gitlab', url: 'https://x.test', repo: 'a/b' }, { type: 'github', url: 'http://x.test', repo: 'a/b' }, { type: 'github', url: 'https://github.com@evil.test', repo: 'a/b' }, { type: 'github', url: 'https://x.test\\y', repo: 'a/b' }, { type: 'github', url: 'https://x.test', repo: 'a/b/c' }, { type: 'github', url: 'https://x.test', repo: '../b' }]) expect(forgeLinks(forge)).toBe(null);
    const gh = forgeLinks({ type: 'github', url: 'https://github.com', repo: 'owner/name' });
    expect([gh.commit('javascript:x'), gh.pull(0), gh.pull('4'), gh.issue(-1)]).toEqual([null, null, null, null]);
  });
});

describe('the trail', () => {
  const history = {
    commits: [
      { sha, date: '2026-10-01T00:00:00Z', subject: 'a', pr: 1, issues: [], keys: [], specs: ['0001'], nodes: ['x', 'y'] },
      { sha, date: '2026-10-02T00:00:00Z', subject: 'b', pr: 2, issues: [3], keys: [], specs: [], nodes: ['x'] },
      { sha, date: '2026-10-03T00:00:00Z', subject: 'c', pr: 2, issues: [], keys: [], specs: ['0001'], nodes: ['z'] },
    ],
    nodes: { x: { born: 0, commits: [0, 1] }, y: { born: 0, commits: [0] }, z: { born: 2, commits: [2] } },
  };

  it('lists a node\'s commits newest first, with its pull requests, specs, issues and how many are traced', () => {
    const t = nodeTrail(history, 'x');
    expect(t.commits.map((c) => c.subject)).toEqual(['b', 'a']);
    expect(t).toMatchObject({ pulls: [2, 1], specs: ['0001'], issues: [3], traced: 2 });
    expect(t.born.subject).toBe('a');
    expect(nodeTrail(history, 'nowhere')).toBe(null);
    expect(nodeTrail(history, '__proto__')).toBe(null);
  });

  it('finds what a spec reached', () => {
    const r = specReach(history, '0001');
    expect([...r.nodes].sort()).toEqual(['x', 'y', 'z']);
    expect(r.commits).toBe(2);
  });

  it('finds each spec\'s file among the map\'s doc pages', () => {
    const files = specFiles([{ id: 'p', file: 'docs/specs/0001-a.md', desc: 'Spec 0001: A start (the first) (docs/specs/0001-a.md)' }, { id: 'q', file: 'docs/specs/proposals/0001-a.json' }, { id: 'r', file: 'docs/x.md' }]);
    expect([...files.entries()]).toEqual([['0001', { file: 'docs/specs/0001-a.md', label: 'A start', id: 'p' }]]);
  });

  it('escapes what it shows, and makes no link without a forge', () => {
    const html = trailHtml({ sha, pr: 1, issues: [], keys: ['<b>K-1</b>'], specs: ['0001'] }, { links: null, specs: new Map([['0001', { file: 'docs/specs/0001-a.md', label: '<i>x</i>' }]]) });
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
    expect(html).not.toContain('href');
  });
});

describe('the History layer\'s heat', () => {
  const H = {
    commits: [
      { date: '2026-09-01T00:00:00Z' }, { date: '2026-10-20T00:00:00Z' }, { date: '2026-10-28T00:00:00Z' }, { date: '2026-11-01T00:00:00Z' },
    ],
    nodes: { a: { commits: [0, 1, 2, 3] }, b: { commits: [1] }, c: { commits: [0] }, d: { commits: [3] }, e: { commits: [] } },
  };

  it('counts each node\'s commits up to a commit, and how lately, from that commit\'s own date', () => {
    const now = heatOf(H);
    expect(now.at).toBe(3);
    expect(now.max).toBe(4);
    expect([...now.nodes.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(now.nodes.get('a')).toMatchObject({ count: 4, last: 3, band: 'week' });
    expect(now.nodes.get('b')).toMatchObject({ count: 1, band: 'month' }); // 12 days
    expect(now.nodes.get('c').band).toBe('old');
    const then = heatOf(H, 1);
    expect(then.nodes.has('d')).toBe(false); // not born yet
    expect(then.nodes.get('a')).toMatchObject({ count: 2, band: 'week' });
    expect(heatOf(H, 99).at).toBe(3);
    expect(heatOf(null)).toMatchObject({ at: -1, max: 0 });
  });

  it('widens with how often, by the square root, from 1.5 to 6 px', () => {
    expect(haloWidth(0, 4)).toBe(0);
    expect(haloWidth(1, 4)).toBe(3.8);
    expect(haloWidth(4, 4)).toBe(6);
    expect(haloWidth(1, 9)).toBe(3);
  });

  it('says in its row what it has read', () => {
    expect(historyRowOf('idle', null, '#fff')).toMatchObject({ key: 'history-halos', label: 'History', overlay: true, countText: 'not read yet' });
    expect(historyRowOf('ready', heatOf(H), '#fff').countText).toBe('4 nodes');
    expect(historyRowOf('error', null, '#fff').countText).toBe('not read');
  });

  it('names a picked spec on its bar, its title as text', () => {
    const specs = new Map([['0012', { file: 'docs/specs/0012-x.md', label: 'Work <i>as</i> a view' }]]);
    const html = specBarHtml({ spec: '0012', nodes: new Set(['a', 'b']), commits: 1 }, { links: forgeLinks({ type: 'github', url: 'https://github.com', repo: 'o/r' }), specs });
    expect(html).toContain('href="https://github.com/o/r/blob/HEAD/docs/specs/0012-x.md"');
    expect(html).toContain('Work &lt;i&gt;as&lt;/i&gt; a view: 1 commit, 2 nodes');
    expect(specBarHtml({ spec: '0099', nodes: new Set(), commits: 0 }, { links: null, specs })).toContain('<b>Spec 0099</b>: 0 commits, 0 nodes');
  });
});

describe('Replay', () => {
  const H = {
    commits: [
      { sha: 'a'.repeat(40), date: '2026-10-01T10:00:00Z', subject: 'start', nodes: ['root', 'pkg'] },
      { sha: 'b'.repeat(40), date: '2026-10-05T10:00:00Z', subject: 'feat(x): a, b and c', nodes: ['pkg', 'a', 'b', 'c', 'd'] },
      { sha: 'c'.repeat(40), date: '2026-10-09T10:00:00Z', subject: 'fix: a', nodes: ['a'] },
    ],
    nodes: { root: { born: 0 }, pkg: { born: 0 }, a: { born: 1 }, b: { born: 1 }, c: { born: 1 }, d: { born: 1 } },
  };
  const E = [{ from: 'root', to: 'pkg' }, { from: 'pkg', to: 'a' }, { from: 'pkg', to: 'b' }, { from: 'a', to: 'b', kind: 'usage', dashed: true }, { from: 'new', to: 'pkg' }];

  it('reads a commit\'s kind from its title', () => {
    expect(['feat(x): y', 'fix: y', 'docs(spec): y', 'chore: y', 'Feat!: y', 'no kind'].map(commitKind)).toEqual(['feat', 'fix', 'docs', 'other', 'feat', 'other']);
  });

  it('holds at a commit the nodes born by then and the lines between them, and what it bore and changed', () => {
    const f0 = replayFrame(H, E, 0);
    expect([...f0.hidden].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(f0).toMatchObject({ at: 0, total: 3, born: ['pkg', 'root'], nodes: 2, edges: 2 }); // root-pkg, and new-pkg: a node newer than the history is always there
    const f1 = replayFrame(H, E, 1);
    expect(f1).toMatchObject({ born: ['a', 'b', 'c', 'd'], nodes: 6, edges: 5 });
    expect(replayCount(f1)).toBe('6 nodes · 5 edges · commit 2 of 3 · 4 born');
    expect(replayCount(replayFrame(H, E, 2))).toBe('6 nodes · 5 edges · commit 3 of 3');
    expect(replayFrame(H, E, 99).at).toBe(2);
    expect(parentsOf(E).get('b')).toBe('pkg');
  });

  it('says a step in words: the commit, who was born, what changed', () => {
    const labelOf = (id) => `${id}.js`;
    expect(stepWords(replayFrame(H, E, 1), { labelOf, locale: 'en-GB' })).toBe('Commit 2 of 3, 5 Oct 2026: feat(x): a, b and c. Born: a.js, b.js, c.js and 1 more. Changed: pkg.js. 6 nodes on the map.');
    expect(stepWords(replayFrame(H, E, 2), { labelOf, locale: 'en-GB' })).toBe('Commit 3 of 3, 9 Oct 2026: fix: a. Changed: a.js. 6 nodes on the map.');
  });

  it('plays the whole history in about forty seconds, within bounds', () => {
    expect(speedMs(100)).toBe(400);
    expect(speedMs(100, 4)).toBe(100);
    expect(speedMs(5)).toBe(700);
    expect(speedMs(5000)).toBe(40);
  });
});
