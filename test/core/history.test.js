/**
 * @vitest-environment node
 *
 * core/history.js (spec 0014 D4): reading git's log in a fixed format, the trail a commit names, tying commits to
 * nodes (renames followed, parents born first), and the guards around running git, on a real repo made for the test.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLog, traceOf, historyOf, cleanSubject, gitArgs, gitEnv, readLog, readHead, createHistory, LOG_FORMAT } from '../../core/history.js';

const sha = (c) => c.repeat(40);
const rec = (h, date, subject, body, files) => `\x1e${h}\x1f${date}\x1f${subject}\x1f${body}\x1f\n${files.join('\n')}\n`;

describe('parseLog', () => {
  it('reads each commit, oldest first, with its files, renames and copies', () => {
    const text = rec(sha('b'), '2026-11-02T10:00:00+00:00', 'feat: two (#2)', 'Closes #1', ['M\ta.js', 'R087\told.js\tnew.js', 'D\tgone.js'])
      + rec(sha('a'), '2026-11-01T10:00:00+00:00', 'first', '', ['A\ta.js', 'A\told.js', 'C100\ta.js\tcopy.js']);
    const out = parseLog(text);
    expect(out.map((c) => c.sha)).toEqual([sha('a'), sha('b')]);
    expect(out[0].files).toEqual([{ status: 'A', path: 'a.js' }, { status: 'A', path: 'old.js' }, { status: 'C', from: 'a.js', path: 'copy.js' }]);
    expect(out[1]).toMatchObject({ subject: 'feat: two (#2)', body: 'Closes #1', date: '2026-11-02T10:00:00+00:00' });
    expect(out[1].files).toEqual([{ status: 'M', path: 'a.js' }, { status: 'R', from: 'old.js', path: 'new.js' }, { status: 'D', path: 'gone.js' }]);
  });

  it('leaves out a malformed record: no hash, a bad date, too few fields', () => {
    const text = rec('nothash', '2026-11-01T10:00:00Z', 's', '', []) + rec(sha('c'), 'yesterday', 's', '', []) + '\x1e' + sha('d') + '\x1fonly';
    expect(parseLog(text)).toEqual([]);
  });
});

describe('traceOf', () => {
  it('reads the pull request from the last (#N), issues from an earlier one and from Closes, keys, and specs', () => {
    expect(traceOf({ subject: 'fix(explorer): the leftovers of spec 0012 (#283) (#284)', body: 'Fixes #270 and resolves #283.\n[CF-45] too', files: [{ path: 'docs/specs/0013-words.md' }, { path: 'docs/specs/proposals/0013-words.json' }] }))
      .toEqual({ pr: 284, issues: [283, 270], keys: ['CF-45'], specs: ['0012', '0013'] });
  });

  it('guesses nothing a commit does not name', () => {
    expect(traceOf({ subject: 'chore: tidy up', body: 'See #12 for why', files: [{ path: 'README.md' }] })).toEqual({ pr: null, issues: [], keys: [], specs: [] });
  });

  it('cleans the (#N) a squash merge leaves off a subject', () => {
    expect(cleanSubject('docs(spec): 0013, Words (#287)')).toBe('docs(spec): 0013, Words');
  });
});

describe('historyOf', () => {
  const topology = {
    nodes: [{ id: 'root', file: 'package.json' }, { id: 'pkg', file: 'src/' }, { id: 'a', file: 'src/a.js' }, { id: 'b', file: 'src/new.js' }, { id: 'none' }],
    edges: [{ from: 'root', to: 'pkg' }, { from: 'pkg', to: 'a' }, { from: 'pkg', to: 'b' }, { from: 'a', to: 'b', dashed: true, label: 'imports' }],
  };
  const raw = [
    { sha: sha('1'), date: '2026-11-01T00:00:00Z', subject: 'start', body: '', files: [{ status: 'A', path: 'package.json' }] },
    { sha: sha('2'), date: '2026-11-02T00:00:00Z', subject: 'feat: old (#3)', body: '', files: [{ status: 'A', path: 'src/old.js' }] },
    { sha: sha('3'), date: '2026-11-03T00:00:00Z', subject: 'feat: a (#4)', body: 'spec 0001', files: [{ status: 'A', path: 'src/a.js' }, { status: 'M', path: 'src/old.js' }] },
    { sha: sha('4'), date: '2026-11-04T00:00:00Z', subject: 'refactor: rename (#5)', body: '', files: [{ status: 'R', from: 'src/old.js', path: 'src/new.js' }] },
    { sha: sha('5'), date: '2026-11-05T00:00:00Z', subject: 'fix: a (#6)', body: '', files: [{ status: 'M', path: 'src/a.js' }, { status: 'D', path: 'src/gone.js' }] },
  ];

  it('gives each node its commits, a folder node everything under it, and follows a rename back', () => {
    const h = historyOf(raw, topology);
    expect(h.nodes.a).toEqual({ born: 2, commits: [2, 4] });
    expect(h.nodes.b).toEqual({ born: 1, commits: [1, 2, 3] });
    expect(h.nodes.pkg.commits).toEqual([1, 2, 3, 4]);
    expect(h.nodes.root).toEqual({ born: 0, commits: [0] });
  });

  it('bears a node nothing touches with the first commit, and never a parent after its child', () => {
    const h = historyOf(raw, { nodes: [{ id: 'p', file: 'late.md' }, { id: 'c', file: 'src/a.js' }, { id: 'none' }], edges: [{ from: 'p', to: 'c' }] });
    expect(h.nodes.none.born).toBe(0);
    expect(h.nodes.c.born).toBe(2);
    expect(h.nodes.p.born).toBe(0); // nothing touches late.md: born with the first commit, before its child
    const late = historyOf([...raw, { sha: sha('6'), date: '2026-11-06T00:00:00Z', subject: 'docs', body: '', files: [{ status: 'A', path: 'late.md' }] }], { nodes: [{ id: 'p', file: 'late.md' }, { id: 'c', file: 'src/a.js' }], edges: [{ from: 'p', to: 'c' }] });
    expect(late.nodes.p.born).toBe(2);
  });

  it('lists each commit with its trail and the nodes it touched, a deleted file touching nothing', () => {
    const h = historyOf(raw, topology);
    expect(h.commits[2]).toEqual({ sha: sha('3'), date: '2026-11-03T00:00:00Z', subject: 'feat: a', pr: 4, issues: [], keys: [], specs: ['0001'], files: 2, nodes: ['a', 'b', 'pkg'] });
    expect(h.commits[4].nodes).toEqual(['a', 'pkg']);
    expect(h.cut).toBe(false);
  });

  it('takes a map with no nodes, or a loop of parents, without falling over', () => {
    expect(historyOf(raw, { nodes: [] }).nodes).toEqual({});
    const loop = historyOf(raw, { nodes: [{ id: 'x', file: 'src/a.js' }, { id: 'y', file: 'package.json' }], edges: [{ from: 'x', to: 'y' }, { from: 'y', to: 'x' }] });
    expect(loop.nodes.x.born).toBe(0);
  });
});

describe('running git', () => {
  it('asks for a fixed log, with nothing from the repo\'s config able to run a program', () => {
    const args = gitArgs('/repo');
    expect(args.slice(0, 2)).toEqual(['-C', '/repo']);
    for (const a of ['core.pager=cat', 'core.fsmonitor=false', 'log.showSignature=false', 'diff.external=', '--no-pager', '--no-ext-diff', '--no-textconv', '--first-parent', `--format=${LOG_FORMAT}`]) expect(args).toContain(a);
    expect(args[args.length - 1]).toBe('--');
    expect(gitEnv({ PATH: '/bin' })).toMatchObject({ PATH: '/bin', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });
  });

  it('says plainly when git is not there, and passes no shell', async () => {
    let seen;
    const run = (cmd, args, opts, cb) => { seen = { cmd, args, opts }; cb(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), ''); };
    await expect(readLog('/repo', { run })).rejects.toMatchObject({ code: 'ENOHISTORY', message: 'The history could not be read: git is not installed where cornfield runs.' });
    expect(seen.cmd).toBe('git');
    expect(seen.opts.shell).toBeUndefined();
  });
});

describe('on a real repo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-history-'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.org', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

  it('reads nothing from a folder with no commit', async () => {
    git('init', '-q', '-b', 'main');
    expect(await readHead(root)).toBe(null);
    await expect(createHistory(root).get({ nodes: [] }, 'k')).rejects.toMatchObject({ code: 'ENOHISTORY' });
  });

  it('reads the log, follows a rename, and keeps the answer until HEAD moves', async () => {
    write('src/old.js', 'export const x = 1;\n'.repeat(20));
    git('add', '.'); git('commit', '-q', '-m', 'feat: start (#1)');
    git('mv', 'src/old.js', 'src/new.js'); git('commit', '-q', '-m', 'refactor: rename, for spec 0002 (#2)', '-m', 'Closes #7');
    const topology = { nodes: [{ id: 'pkg', file: 'src' }, { id: 'n', file: 'src/new.js' }], edges: [{ from: 'pkg', to: 'n' }] };
    const h = createHistory(root);
    const first = await h.get(topology, 'k');
    expect(first.commits.map((c) => [c.subject, c.pr, c.issues, c.specs])).toEqual([['feat: start', 1, [], []], ['refactor: rename, for spec 0002', 2, [7], ['0002']]]);
    expect(first.nodes.n).toEqual({ born: 0, commits: [0, 1] });
    expect(first.head).toBe(git('rev-parse', 'HEAD').trim());
    expect(await h.get(topology, 'k')).toBe(first);
    write('src/new.js', 'changed\n'); git('commit', '-q', '-am', 'fix: change');
    const second = await h.get(topology, 'k');
    expect(second).not.toBe(first);
    expect(second.nodes.n.commits).toEqual([0, 1, 2]);
  });
});
