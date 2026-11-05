/**
 * @vitest-environment node
 *
 * The pull runner recipe (examples/runner/pull-runner.mjs): how it reads a model's answer, and one whole pass against a fake cornfield, a
 * fake Ollama and a fake git. Nothing leaves the machine.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { parseModelAnswer, promptFor, ask, runOnce } from '../../examples/runner/pull-runner.mjs';

const request = (extra = {}) => ({ version: 1, runId: 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEF', kind: 'code', refs: { issue: 12 }, brief: 'Add the meals page.', requestedBy: 'maintainer-one', ...extra });
const answer = (obj) => JSON.stringify(obj);

describe('parseModelAnswer', () => {
  it('reads the JSON the prompt asks for, with chatter and fences around it', () => {
    const text = 'Sure!\n```json\n' + answer({ summary: 'Add meals\nmore', files: [{ path: 'web\\meals.js', content: 'x' }] }) + '\n```\nDone.';
    expect(parseModelAnswer(text)).toEqual({ summary: 'Add meals', files: [{ path: 'web/meals.js', content: 'x' }] });
  });
  it('refuses what is not an answer, and any path outside the repo', () => {
    expect(() => parseModelAnswer('no json here')).toThrow(/JSON object/);
    expect(() => parseModelAnswer('{ not json }')).toThrow(/could not be read/);
    expect(() => parseModelAnswer(answer({ files: [] }))).toThrow(/summary/);
    expect(() => parseModelAnswer(answer({ summary: 's', files: [] }))).toThrow(/files/);
    for (const p of ['../x', '/etc/passwd', 'a/../../x', '.git/config', 'a/.GIT/hooks', 'C:/x', 'a//b', '']) {
      expect(() => parseModelAnswer(answer({ summary: 's', files: [{ path: p, content: 'x' }] })), p).toThrow(/not a path/);
    }
    expect(() => parseModelAnswer(answer({ summary: 's', files: [{ path: 'a', content: 1 }] }))).toThrow(/content/);
  });
  it('asks code for the answer shape, and anything else for plain text', () => {
    expect(promptFor(request())).toContain('"files"');
    expect(promptFor(request({ kind: 'summary' }))).not.toContain('"files"');
  });
});

describe('ask', () => {
  it('posts to Ollama\'s /api/generate without streaming and returns the response text', async () => {
    const calls = [];
    const fetch = async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true, json: async () => ({ response: 'hello' }) }; };
    expect(await ask({ fetch, ollamaUrl: 'http://ollama.local:11434/', model: 'm', prompt: 'p' })).toBe('hello');
    expect(calls).toEqual([['http://ollama.local:11434/api/generate', { model: 'm', prompt: 'p', stream: false }]]);
    await expect(ask({ fetch: async () => ({ ok: false, status: 500 }), ollamaUrl: 'http://x', model: 'm', prompt: 'p' })).rejects.toThrow(/500/);
  });
});

describe('runOnce', () => {
  const secret = ['cf_', 'nt_', 'B'.repeat(43)].join('');
  /** A cornfield with one queued request, an Ollama and a forge, all fake; what each was asked is kept */
  function world({ claimStatus = 200, model = answer({ summary: 'Add meals', files: [{ path: 'web/meals.js', content: 'export {};\n' }] }), stop = false, kind = 'code' } = {}) {
    const seen = { reports: [], git: [], pulls: [] };
    const fetch = async (url, init = {}) => {
      const u = new URL(url);
      const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
      if (u.host === 'cf.test') {
        expect(init.headers.authorization).toBe(`Bearer ${secret}`);
        if (u.pathname === '/api/agent-requests') return json(200, { ok: true, requests: [request({ kind })] });
        if (u.pathname.endsWith('/claim')) return json(claimStatus, { ok: claimStatus === 200 });
        if (init.method === 'POST') { seen.reports.push(JSON.parse(init.body)); return json(200, { ok: true }); }
        return json(200, { ok: true, run: { stopRequested: stop } });
      }
      if (u.host === 'ollama.test') return json(200, { response: model });
      if (u.host === 'git.test') { seen.pulls.push([u.pathname, JSON.parse(init.body)]); return json(201, { html_url: 'https://git.test/owner/name/pull/5' }); }
      throw new Error(`unexpected ${url}`);
    };
    const exec = async (cmd, args, opts) => { seen.git.push([cmd, ...args]); seen.env = opts.env; return ''; };
    return { seen, fetch, exec };
  }
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pull-runner-'));
  const env = (d) => ({ CORNFIELD_URL: 'http://cf.test', CORNFIELD_RUNNER_TOKEN: secret, OLLAMA_URL: 'http://ollama.test', OLLAMA_MODEL: 'm', FORGE_TYPE: 'forgejo', FORGE_URL: 'http://git.test', FORGE_REPO: 'owner/name', FORGE_TOKEN: 'forge-token-value', REPO_DIR: d, GIT_AUTHOR_NAME: 'runner', GIT_AUTHOR_EMAIL: 'runner@example.org' });

  it('claims, runs the model, commits with the trailer under its own identity, opens the pull request and reports done', async () => {
    const d = dir();
    const w = world();
    expect(await runOnce({ env: env(d), fetch: w.fetch, exec: w.exec, log: () => {} })).toBe('run-01JC8Z3Q5M7VXK2RT9N4B6HDEF');
    expect(fs.readFileSync(path.join(d, 'web/meals.js'), 'utf8')).toBe('export {};\n');
    expect(w.seen.git.map((g) => g[1])).toEqual(['fetch', 'switch', 'add', 'commit', 'push']);
    expect(w.seen.git[3][3]).toContain('Cornfield-Run: run-01JC8Z3Q5M7VXK2RT9N4B6HDEF');
    expect(w.seen.env).toMatchObject({ GIT_AUTHOR_NAME: 'runner', GIT_COMMITTER_EMAIL: 'runner@example.org' });
    // the forge token travels in the environment, never in an argument
    expect(JSON.stringify(w.seen.git)).not.toContain('forge-token-value');
    expect(w.seen.pulls[0][0]).toBe('/api/v1/repos/owner/name/pulls');
    expect(w.seen.pulls[0][1].body).toContain('Cornfield-Run: run-01JC8Z3Q5M7VXK2RT9N4B6HDEF');
    expect(w.seen.reports).toEqual([{ state: 'working' }, { state: 'done', note: 'Opened a pull request.', url: 'https://git.test/owner/name/pull/5' }]);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('leaves a request someone else claimed first alone', async () => {
    const w = world({ claimStatus: 409 });
    expect(await runOnce({ env: env(dir()), fetch: w.fetch, exec: w.exec, log: () => {} })).toBeNull();
    expect(w.seen.reports).toEqual([]);
  });

  it('reports failed, without the forge token, when the model\'s answer is no good', async () => {
    const w = world({ model: 'I cannot do that' });
    await runOnce({ env: env(dir()), fetch: w.fetch, exec: w.exec, log: () => {} });
    expect(w.seen.reports.map((r) => r.state)).toEqual(['working', 'failed']);
    expect(w.seen.git).toEqual([]);
  });

  it('does not publish when a stop was asked for, and reports stopped', async () => {
    const w = world({ stop: true });
    await runOnce({ env: env(dir()), fetch: w.fetch, exec: w.exec, log: () => {} });
    expect(w.seen.reports.map((r) => r.state)).toEqual(['working', 'stopped']);
    expect(w.seen.git).toEqual([]);
  });

  it('reports the model\'s text as the note for a request that is not code', async () => {
    const w = world({ kind: 'summary', model: 'A short summary.' });
    await runOnce({ env: env(dir()), fetch: w.fetch, exec: w.exec, log: () => {} });
    expect(w.seen.reports[1]).toEqual({ state: 'done', note: 'A short summary.' });
    expect(w.seen.git).toEqual([]);
  });
});
