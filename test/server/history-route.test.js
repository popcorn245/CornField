/**
 * @vitest-environment node
 *
 * GET /api/history (spec 0014 D4): off unless the config says `history: true`, then the repo's git history tied to
 * its map; a plain answer when the map or the history cannot be read; and `history` in the browser's config.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCornfieldServer, clientConfig } from '../../server/server.js';
import { loadConfig, configProblems } from '../../core/config.js';

const made = [];
afterAll(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A repo with a map and, unless `commits` is 0, a commit; its config says `history` as given */
function repo({ history, commits = 1 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-history-route-'));
  made.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', type: 'module' }));
  fs.writeFileSync(path.join(root, 'cornfield.config.js'), `export default ${JSON.stringify(history === undefined ? {} : { history })};\n`);
  fs.writeFileSync(path.join(root, 'topology.json'), JSON.stringify({ nodes: [{ id: 'root', label: 'demo', type: 'root', file: 'package.json' }], edges: [] }));
  if (commits) {
    const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.org', '-c', 'commit.gpgsign=false', ...a]);
    git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'feat: the start (#1)');
  }
  return root;
}

async function start(root) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-history-data-'));
  made.push(data);
  const config = await loadConfig(root, { env: { CORNFIELD_DATA: data } });
  const server = createCornfieldServer(config, { env: {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  return { config, get: (p) => fetch(`http://127.0.0.1:${port}${p}`), close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
}

describe('GET /api/history', () => {
  let on; let off; let empty;
  beforeAll(async () => {
    on = await start(repo({ history: true }));
    off = await start(repo());
    empty = await start(repo({ history: true, commits: 0 }));
  });
  afterAll(async () => { await on.close(); await off.close(); await empty.close(); });

  it('answers the history tied to the map when history is on', async () => {
    const res = await on.get('/api/history');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, cut: false, nodes: { root: { born: 0, commits: [0] } } });
    expect(body.head).toMatch(/^[0-9a-f]{40}$/);
    expect(body.commits).toHaveLength(1);
    expect(body.commits[0]).toMatchObject({ subject: 'feat: the start', pr: 1, issues: [], specs: [], nodes: ['root'] });
  });

  it('is a 404 that says how to turn it on when history is off', async () => {
    const res = await off.get('/api/history');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/history: true/);
  });

  it('is a 503 with a plain reason when there is no history to read', async () => {
    const res = await empty.get('/api/history');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'The history could not be read: the repo has no commit yet, or is not a git checkout.' });
  });

  it('tells the page whether history is on', () => {
    expect(clientConfig(on.config).history).toBe(true);
    expect(clientConfig(off.config).history).toBe(false);
  });
});

describe('history in the config', () => {
  it('is true or false, and nothing else', () => {
    expect(configProblems({ history: true })).toEqual([]);
    expect(configProblems({ history: false })).toEqual([]);
    expect(configProblems({ history: 'yes' })).toEqual(['"history" is true or false: true reads the repo\'s git history (docs/config.md#history).']);
  });
});
