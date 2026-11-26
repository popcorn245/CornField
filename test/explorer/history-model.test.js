/**
 * @vitest-environment node
 *
 * explorer/history-model.js (spec 0014 D2): the forge links of a trail (GitHub and Forgejo, https only, each segment encoded), the spec files
 * from the map's doc pages, a node's commits and counts, and what a spec reached.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS module, no declarations
import { forgeLinks, specFiles, nodeTrail, specReach, trailHtml } from '../../explorer/history-model.js';

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
