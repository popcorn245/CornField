/**
 * @vitest-environment node
 *
 * Which workflow runs are deploys and what each restarted (server/deploys.js): patterns on a workflow's name or file,
 * the defaults, and an unmapped deploy kept with nothing restarted.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS module, no declarations
import { fits, deploysOf, DEFAULT_WORKFLOWS } from '../../server/deploys.js';

const run = (id, name, workflow) => ({ id, name, workflow, title: '', event: 'push', branch: 'main', sha: 'abc', state: 'success', actor: null, url: null, createdAt: '2026-10-18T12:00:00Z', updatedAt: '2026-10-18T12:00:00Z' });
const RUNS = [run('4', 'Deploy web', 'deploy.yml'), run('3', 'CI', 'ci.yml'), run('2', 'Ship media', 'deploy-media.yml'), run('1', 'Release', 'release.yml')];

describe('fits', () => {
  it('is plain text with * for anything, whatever the case, and the whole name', () => {
    expect(fits('Deploy web', 'deploy WEB')).toBe(true);
    expect(fits('deploy', 'Deploy web')).toBe(false);
    expect(fits('deploy*', 'Deploy web')).toBe(true);
    expect(fits('*deploy*', 'Redeploy it')).toBe(true);
    expect(fits('*', '')).toBe(true);
  });

  it('takes every other character as itself, so a name cannot be a pattern of its own', () => {
    expect(fits('deploy.yml', 'deployxyml')).toBe(false);
    expect(fits('deploy.yml', 'deploy.yml')).toBe(true);
    expect(fits('a+b(c)[d]', 'a+b(c)[d]')).toBe(true);
    expect(fits('^$', 'x')).toBe(false);
  });
});

describe('deploysOf', () => {
  it('by default lists the runs with "deploy" in the name or the file, newest first as given', () => {
    expect(DEFAULT_WORKFLOWS).toEqual(['*deploy*']);
    expect(deploysOf(RUNS, undefined).map((d) => d.id)).toEqual(['4', '2']);
    expect(deploysOf(RUNS, null).map((d) => d.id)).toEqual(['4', '2']);
  });

  it('takes the workflows the config names, by name or by file', () => {
    expect(deploysOf(RUNS, { workflows: ['Release', 'ci.yml'] }).map((d) => d.id)).toEqual(['3', '1']);
    expect(deploysOf(RUNS, { workflows: [] })).toEqual([]);
  });

  it('says what each restarted from every pattern that fits, each node once, and keeps an unmapped deploy with none', () => {
    const out = deploysOf(RUNS, { workflows: ['*deploy*'], restarts: { 'Deploy web': ['stack-web', 'media'], 'deploy*.yml': ['media', 'machine-nas'] } });
    expect(out.map((d) => [d.id, d.restarts])).toEqual([['4', ['stack-web', 'media', 'machine-nas']], ['2', ['media', 'machine-nas']]]);
    const unmapped = deploysOf(RUNS, { restarts: { Other: ['x'] } });
    expect(unmapped.map((d) => [d.id, d.restarts])).toEqual([['4', []], ['2', []]]);
  });

  it('leaves the runs as the forge gave them', () => {
    const [first] = deploysOf(RUNS, null);
    expect(first).toMatchObject({ id: '4', name: 'Deploy web', workflow: 'deploy.yml', state: 'success' });
    expect(RUNS[0]).not.toHaveProperty('restarts');
  });
});
