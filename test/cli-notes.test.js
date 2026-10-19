/**
 * @vitest-environment node
 *
 * `cornfield notes` end to end: the release notes on stdout as Markdown, from a fake forge on loopback that serves the
 * recorded answers of the notes world (test/fixtures/forge/notes-github.json) for a copy of the sample repo. It reads
 * with CORNFIELD_FORGE_TOKEN, and only reads: the fake sees nothing but GETs. (The command runs as a child process
 * the test waits on without blocking, so the fake forge in this process can answer.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CORNFIELD, SAMPLE } from './helpers.js';
import { fakeForge, recordings } from './server/fake-forge.js';

const CLI = path.join(CORNFIELD, 'cli', 'cornfield.js');
const TOKEN = 'cli-token-not-a-secret';

/** Runs the command and waits for it; the event loop stays free for the fake forge */
function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, CORNFIELD_FORGE_TOKEN: '', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('cornfield notes', () => {
  let fake;
  let root;
  let bare;
  beforeAll(async () => {
    const routes = {};
    for (const [key, answer] of Object.entries(recordings('notes-github'))) {
      if (key.startsWith('_')) continue;
      const [method, p] = key.split(' ');
      routes[`${method} /api/v3${p}`] = answer;
    }
    fake = await fakeForge(routes);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-notes-cli-'));
    fs.cpSync(SAMPLE, root, { recursive: true });
    const config = fs.readFileSync(path.join(root, 'cornfield.config.js'), 'utf8')
      .replace(/forge: \{[^}]*\}/, `forge: { type: 'github', url: ${JSON.stringify(fake.url)}, repo: 'owner/name' }`);
    fs.writeFileSync(path.join(root, 'cornfield.config.js'), config);
    bare = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-notes-bare-'));
    fs.writeFileSync(path.join(bare, 'package.json'), JSON.stringify({ name: 'bare' }));
  });
  afterAll(async () => {
    await fake.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  });

  it('prints the notes since the latest tag as Markdown, and says how many on stderr', async () => {
    fake.requests.length = 0;
    const res = await run(['notes', '--repo', root], { CORNFIELD_FORGE_TOKEN: TOKEN });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toBe('4 pull requests merged since v0.2.0.\n');
    expect(res.stdout.startsWith('### Breaking\n\n- Rename the cart route \\[breaking\\] ([#22](https://github.example.com/owner/name/pull/22) by @agent-four)')).toBe(true);
    expect(res.stdout).toContain('### api.example.test\n');
    expect(res.stdout.endsWith('- Fix a typo in the readme ([#23](https://github.example.com/owner/name/pull/23) by @maintainer-one)\n')).toBe(true);
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const r of fake.requests) {
      expect(r.method).toBe('GET');
      expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('starts from the tag it is given, and takes another label for Breaking', async () => {
    const since = await run(['notes', '--repo', root, '--since', 'v0.1.0']);
    expect(since.status, since.stderr).toBe(0);
    expect(since.stderr).toBe('5 pull requests merged since v0.1.0.\n');
    expect(since.stdout).toContain('Before v0.2.0');
    const label = await run(['notes', '--repo', root, '--breaking-label=semver-major']);
    expect(label.stdout).not.toContain('### Breaking');
  });

  it('without a token it asks without one (a public repo answers), and still only reads', async () => {
    fake.requests.length = 0;
    const res = await run(['notes', '--repo', root]);
    expect(res.status, res.stderr).toBe(0);
    for (const r of fake.requests) {
      expect(r.method).toBe('GET');
      expect(r.headers.authorization).toBeUndefined();
    }
  });

  it('says a tag that is not there, and a missing forge or flag value, and exits 1', async () => {
    const missing = await run(['notes', '--repo', root, '--since', 'v9.9.9']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('owner/name has no tag named "v9.9.9".');
    expect(missing.stdout).toBe('');
    const noForge = await run(['notes', '--repo', bare]);
    expect(noForge.status).toBe(1);
    expect(noForge.stderr).toContain('No forge is configured');
    const noValue = await run(['notes', '--repo', root, '--since']);
    expect(noValue.status).toBe(1);
    expect(noValue.stderr).toContain('Usage: cornfield notes');
  });

  it('tells the person to sync when the map is not there', async () => {
    fs.rmSync(path.join(root, 'topology.json'));
    const res = await run(['notes', '--repo', root]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('topology.json is not there yet: run cornfield sync');
  });
});
