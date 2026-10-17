/**
 * @vitest-environment node
 *
 * The cornfield command end to end, on a copy of the sample repo and on cornfield itself: sync writes the map
 * and is then a no-op, validate fails on drift and passes after a sync, status says what is there, help and
 * the version answer, and a stray `npm publish` is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CORNFIELD, SAMPLE } from './helpers.js';
import { releaseProblems } from '../cli/release-guard.js';

const CLI = path.join(CORNFIELD, 'cli', 'cornfield.js');
const run = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60_000, ...opts });

describe('on a copy of the sample repo', () => {
  let root;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-cli-'));
    fs.cpSync(SAMPLE, root, { recursive: true });
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('validates as committed', () => {
    const res = run(['validate', '--repo', root]);
    expect(res.stdout + res.stderr).toMatch(/Valid/);
    expect(res.status).toBe(0);
  });

  it('fails validate when the code moves under the map, names the drift, and passes after a sync that is then a no-op', () => {
    fs.mkdirSync(path.join(root, 'packages/admin/src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages/admin/package.json'), JSON.stringify({ name: '@acme/admin', dependencies: { '@acme/shared': '*' } }));
    fs.writeFileSync(path.join(root, 'packages/admin/src/index.js'), "import { money } from '@acme/shared';\nexport const admin = money;\n");
    const bad = run(['validate', '--repo', root]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/out of date with the code/);
    expect(bad.stderr).toMatch(/drift: add pkg pkg-admin \(@acme\/admin\)/);
    const sync = run(['sync', '--repo', root]);
    expect(sync.status).toBe(0);
    expect(sync.stdout).toMatch(/add pkg pkg-admin/);
    expect(run(['sync', '--repo', root]).stdout).toMatch(/already matches the code/);
    expect(run(['validate', '--repo', root]).status).toBe(0);
  });

  it('fails validate for a proposal that points at nothing, naming the file', () => {
    const file = path.join(root, 'docs/specs/proposals/0003-bad.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, title: 'Bad', summary: 's', nodes: { add: [{ id: 'page-x', label: '/x', type: 'page', parent: 'app-nowhere' }] } }));
    const res = run(['validate', '--repo', root]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/docs\/specs\/proposals\/0003-bad\.json: .*app-nowhere/);
    fs.rmSync(file);
  });

  it('prints status: the counts by type, the cloud plans and the validation', () => {
    const res = run(['status', '--repo', root]);
    expect(res.stdout).toMatch(/Acme home: \d+ nodes, \d+ edges/);
    expect(res.stdout).toMatch(/Cloud: 13 services \(10 free, 2 paid, 1 off\)/);
    expect(res.status).toBe(0);
  });

  it('checks one proposal and prints its status table', () => {
    const res = run(['proposal', path.join(root, 'docs/specs/proposals/0002-checkout.json'), '--repo', root]);
    expect(res.stdout).toMatch(/4 added · 1 changed · 0 removed · 3 scenarios/);
    expect(res.stdout).toMatch(/pending\s+add\s+node page-web-checkout/);
    expect(res.status).toBe(0);
  });

  it('says there is no review yet, and refuses a proposal it cannot find', () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-cli-data-'));
    const env = { ...process.env, CORNFIELD_DATA: data };
    expect(run(['review', '0002-checkout', '--repo', root], { env }).stdout).toMatch(/No review of 0002-checkout \(checkout\) yet/);
    expect(run(['review', '9999-nope', '--repo', root], { env }).status).toBe(1);
    fs.rmSync(data, { recursive: true, force: true });
  });
});

describe('on cornfield itself (it maps itself)', () => {
  it('validates: its own topology.json matches its code', () => {
    const res = run(['validate', '--repo', CORNFIELD]);
    expect(res.stdout + res.stderr).toMatch(/Valid/);
    expect(res.status).toBe(0);
  });
});

describe('help, version and unknown commands', () => {
  it('prints help and the version, and refuses a command it does not know', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(CORNFIELD, 'package.json'), 'utf8'));
    expect(run(['--version']).stdout.trim()).toBe(pkg.version);
    expect(run(['help']).stdout).toMatch(/Usage: cornfield <command>/);
    const bad = run(['launch']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/Unknown command: launch/);
  });
});

describe('the release guard (prepublishOnly)', () => {
  it('refuses a publish from another folder, without the release flag, or off the version tag', () => {
    expect(releaseProblems({ cwd: os.tmpdir(), env: {} }).join('\n')).toMatch(/not from cornfield's root[\s\S]*CORNFIELD_RELEASE is not 1[\s\S]*the release tag is null/);
    const pkg = JSON.parse(fs.readFileSync(path.join(CORNFIELD, 'package.json'), 'utf8'));
    expect(releaseProblems({ cwd: CORNFIELD, env: { CORNFIELD_RELEASE: '1', GITHUB_REF_NAME: 'v0.0.0-other' } })).toEqual([`the release tag is "v0.0.0-other", not v${pkg.version}.`]);
    expect(releaseProblems({ cwd: CORNFIELD, env: { CORNFIELD_RELEASE: '1', GITHUB_REF_NAME: `v${pkg.version}` } })).toEqual([]);
  });

  it('is what npm runs before a publish, and the package ships only its own folders', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(CORNFIELD, 'package.json'), 'utf8'));
    expect(pkg.scripts.prepublishOnly).toBe('node cli/release-guard.js');
    expect(pkg.files).toEqual(['cli/', 'core/', 'explorer/', 'plugins/', 'server/', 'README.md', 'LICENSE', 'CHANGELOG.md']);
    expect(pkg.bin).toEqual({ cornfield: 'cli/cornfield.js' });
    expect(pkg.dependencies).toBeUndefined();
  });
});
