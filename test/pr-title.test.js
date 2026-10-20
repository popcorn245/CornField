/**
 * @vitest-environment node
 *
 * The pull request title check (.github/scripts/pr-title.js): a conventional commit header, the form semantic-release
 * reads (release.config.js), and a refusal in words for anything else.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { titleProblem, TYPES } from '../.github/scripts/pr-title.js';
import { CORNFIELD } from './helpers.js';

describe('titleProblem', () => {
  it('takes a conventional commit header, with or without a scope, and a breaking mark', () => {
    for (const t of ['feat(forge): land a green pull request', 'fix(auth): keep the session on a rename', 'ci(release): automate releases with semantic-release', 'docs: say how to release', 'feat!: a breaking change', 'refactor(core/sync): one loop', 'perf(explorer): fewer draws']) {
      expect(titleProblem(t), t).toBe(null);
    }
    expect(TYPES).toEqual(expect.arrayContaining(['feat', 'fix', 'perf', 'ci', 'chore']));
  });

  it('refuses the old [KEY] titles, unknown types, a missing summary, and odd spacing, saying why', () => {
    expect(titleProblem('[CF-11] Release 0.1.0')).toMatch(/Write it as "type\(scope\): summary"/);
    expect(titleProblem('feature(forge): x')).toBe('"feature" is not a type: use one of feat, fix, perf, revert, refactor, docs, style, test, build, ci, chore.');
    expect(titleProblem('Feat(forge): x')).toMatch(/"Feat" is not a type/);
    expect(titleProblem('feat(forge):')).toMatch(/Write it as/);
    expect(titleProblem('feat(forge):  two spaces')).toMatch(/Write it as/);
    expect(titleProblem('feat(Forge): upper-case scope')).toMatch(/Write it as/);
    expect(titleProblem(' feat: x')).toBe('The title starts or ends with a space.');
    expect(titleProblem('')).toBe('The title is empty.');
    expect(titleProblem(undefined)).toBe('The title is empty.');
    expect(titleProblem(`feat: ${'x'.repeat(100)}`)).toMatch(/keep it to 100/);
  });

  it('runs as a script: exit 0 for a good title, 1 and the reason for a bad one', () => {
    const script = path.join(CORNFIELD, '.github', 'scripts', 'pr-title.js');
    const ok = spawnSync(process.execPath, [script, 'fix(auth): x'], { encoding: 'utf8' });
    expect([ok.status, ok.stdout.trim()]).toEqual([0, 'The pull request title is a conventional commit.']);
    const bad = spawnSync(process.execPath, [script, '[CF-11] Release'], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/not a conventional commit/);
  });
});
