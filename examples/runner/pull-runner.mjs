#!/usr/bin/env node
/**
 * A pull runner: the recipe for a runner that sits behind NAT (docs/agents.md#pull). No dependencies, Node 22 or newer.
 *
 * It asks cornfield for queued requests, claims one, asks an Ollama model to do the work, writes the result as a branch, a commit and a pull
 * request under its OWN git identity and forge token, and reports back. cornfield sends it no credential and takes none.
 *
 *   CORNFIELD_URL            where cornfield is, like https://map.example.org
 *   CORNFIELD_RUNNER_TOKEN   a runner token (cf_nt_…), made in the dashboard's tokens dialog
 *   OLLAMA_URL               Ollama's base URL (default http://127.0.0.1:11434)
 *   OLLAMA_MODEL            the model to run, like qwen2.5-coder:14b
 *   FORGE_TYPE               github (default) or forgejo
 *   FORGE_URL                the forge's address (default https://github.com for github; required for forgejo)
 *   FORGE_REPO               owner/name
 *   FORGE_TOKEN              this runner's own forge token: it pushes and opens the pull request as itself
 *   REPO_DIR                 a clone of the repo that only this runner uses (it switches branches in it)
 *   GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL   the runner's own git identity
 *   POLL_SECONDS (30), ONCE=1 (one pass, then exit), BASE_BRANCH (main)
 *
 * The runner acts only on requests that reach it with its token, which a maintainer made: the token stands in for the request's author. Keep
 * the token as secret as the forge token. Run it as `node pull-runner.mjs`.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_FILES = 20;
const MAX_FILE_CHARS = 200_000;
const NOTE_CHARS = 3900;

/** What to ask the model: the request's brief, and for code an exact answer shape this runner can parse */
export function promptFor(request) {
  const about = Object.entries(request.refs).map(([k, v]) => `${k} ${v}`).join(', ');
  if (request.kind !== 'code') return `${request.brief}\n\nThis is about: ${about}. Answer in plain text.`;
  return `${request.brief}\n\nThis is about: ${about}.\n\nAnswer with ONE JSON object and nothing else: {"summary": "one line for the commit", "files": [{"path": "relative/path", "content": "the whole new file"}]}`;
}

/** The model's answer for a code request: `{ summary, files }`, or throws in words. Fences and chatter around the JSON are tolerated; paths are not. */
export function parseModelAnswer(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The model did not answer with a JSON object.');
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('The model\'s JSON could not be read.');
  }
  if (!data || typeof data.summary !== 'string' || !data.summary.trim()) throw new Error('The answer has no "summary".');
  if (!Array.isArray(data.files) || data.files.length === 0 || data.files.length > MAX_FILES) throw new Error(`"files" is 1 to ${MAX_FILES} files.`);
  const files = data.files.map((f) => {
    const p = typeof f?.path === 'string' ? f.path.replaceAll('\\', '/') : '';
    const parts = p.split('/');
    // Relative, inside the repo, and never git's own folder
    if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || parts.some((x) => x === '' || x === '.' || x === '..' || x.toLowerCase() === '.git')) throw new Error(`"${p.slice(0, 80)}" is not a path inside the repo.`);
    if (typeof f.content !== 'string' || f.content.length > MAX_FILE_CHARS) throw new Error(`"${p}" has no content, or too much.`);
    return { path: parts.join('/'), content: f.content };
  });
  return { summary: data.summary.trim().split('\n')[0].slice(0, 100), files };
}

/** One call to Ollama's HTTP API; the text of its answer */
export async function ask({ fetch, ollamaUrl, model, prompt }) {
  const res = await fetch(`${ollamaUrl.replace(/\/+$/, '')}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, prompt, stream: false }) });
  if (!res.ok) throw new Error(`Ollama answered ${res.status}.`);
  const body = await res.json();
  if (typeof body.response !== 'string') throw new Error('Ollama\'s answer has no "response".');
  return body.response;
}

/** The runner's calls to cornfield, over `fetch` */
export function cornfield({ fetch, url, token }) {
  const call = async (method, p, body) => {
    const res = await fetch(`${url.replace(/\/+$/, '')}${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
  return {
    queue: async () => { const r = await call('GET', '/api/agent-requests?state=queued'); if (r.status !== 200) throw new Error(`cornfield answered ${r.status}: ${r.json.error ?? ''}`); return r.json.requests; },
    claim: async (runId) => (await call('POST', `/api/agent-requests/${runId}/claim`)).status === 200, // 409: someone else was first
    report: (runId, state, extra = {}) => call('POST', `/api/runs/${runId}`, { state, ...extra }),
    run: async (runId) => (await call('GET', `/api/runs/${runId}`)).json.run,
  };
}

const sh = (cmd, args, { cwd, env }) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, env: { ...process.env, ...env } }, (err, out, errOut) => (err ? reject(new Error(`${cmd} ${args[0]} failed: ${errOut.trim().split('\n')[0]}`)) : resolve(out)));
});

/** Writes the files on a new branch, commits as the runner, pushes, and opens the pull request. Answers its link. */
export async function publish({ request, answer, env, fetch, exec = sh }) {
  const dir = env.REPO_DIR;
  const base = env.BASE_BRANCH || 'main';
  const branch = request.branch || `agent/${request.runId}`;
  const identity = { GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME: env.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: env.GIT_AUTHOR_EMAIL };
  // The forge token goes in the environment, not on the command line (where `ps` shows it)
  const auth = `Basic ${Buffer.from(`x-access-token:${env.FORGE_TOKEN}`).toString('base64')}`;
  const git = (...args) => exec('git', args, { cwd: dir, env: { ...identity, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: ${auth}` } });
  await git('fetch', 'origin', base);
  await git('switch', '-C', branch, `origin/${base}`);
  for (const f of answer.files) {
    const target = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content);
  }
  await git('add', '--', ...answer.files.map((f) => f.path));
  // The trailer is how cornfield finds this work: the run id travels with the commit and the pull request
  await git('commit', '-m', `${answer.summary}\n\nCornfield-Run: ${request.runId}`);
  await git('push', '--force-with-lease', 'origin', branch);
  const github = (env.FORGE_TYPE || 'github') === 'github';
  const api = github ? `${env.FORGE_URL ? env.FORGE_URL.replace(/\/+$/, '') + '/api/v3' : 'https://api.github.com'}` : `${env.FORGE_URL.replace(/\/+$/, '')}/api/v1`;
  const res = await fetch(`${api}/repos/${env.FORGE_REPO}/pulls`, {
    method: 'POST', headers: { authorization: `token ${env.FORGE_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: answer.summary, head: branch, base, body: `${request.brief.slice(0, 2000)}\n\nCornfield-Run: ${request.runId}` }),
  });
  if (!res.ok) throw new Error(`The forge answered ${res.status} to the pull request.`);
  return (await res.json()).html_url;
}

/** One pass: claim the oldest request and do it. Resolves with the run id it handled, or null when there was nothing to do. */
export async function runOnce({ env, fetch = globalThis.fetch, exec, log = console.error }) {
  const cf = cornfield({ fetch, url: env.CORNFIELD_URL, token: env.CORNFIELD_RUNNER_TOKEN });
  const request = (await cf.queue()).find((r) => r.version === 1);
  if (!request || !(await cf.claim(request.runId))) return null;
  const say = (s) => log(`[pull-runner] ${request.runId}: ${s}`);
  const clean = (s) => String(s).replaceAll(env.FORGE_TOKEN || '\0', '***').slice(0, NOTE_CHARS);
  try {
    await cf.report(request.runId, 'working');
    const text = await ask({ fetch, ollamaUrl: env.OLLAMA_URL || 'http://127.0.0.1:11434', model: env.OLLAMA_MODEL, prompt: promptFor(request) });
    // A stop is asked for with GET /api/runs/<id>; the runner decides what it means. Here: do not publish.
    if ((await cf.run(request.runId))?.stopRequested) {
      await cf.report(request.runId, 'stopped', { note: 'Stopped before anything was published.' });
      return request.runId;
    }
    if (request.kind !== 'code') {
      await cf.report(request.runId, 'done', { note: clean(text) });
    } else {
      const url = await publish({ request, answer: parseModelAnswer(text), env, fetch, exec });
      await cf.report(request.runId, 'done', { note: 'Opened a pull request.', url });
    }
    say('done');
  } catch (err) {
    say(`failed: ${clean(err instanceof Error ? err.message : err)}`);
    await cf.report(request.runId, 'failed', { note: clean(err instanceof Error ? err.message : err) });
  }
  return request.runId;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { env } = process;
  for (const k of ['CORNFIELD_URL', 'CORNFIELD_RUNNER_TOKEN', 'OLLAMA_MODEL', 'FORGE_REPO', 'FORGE_TOKEN', 'REPO_DIR']) {
    if (!env[k]) { console.error(`[pull-runner] ${k} is needed (see the top of this file).`); process.exit(2); }
  }
  const every = Math.max(5, Number(env.POLL_SECONDS) || 30) * 1000;
  for (;;) {
    let handled = null;
    try {
      handled = await runOnce({ env });
    } catch (err) {
      console.error(`[pull-runner] ${err instanceof Error ? err.message : err}`);
    }
    if (env.ONCE === '1') break;
    // Work found means more may be waiting; otherwise wait before asking again
    if (!handled) await new Promise((r) => setTimeout(r, every));
  }
}
