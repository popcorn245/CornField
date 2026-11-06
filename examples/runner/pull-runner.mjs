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
 *   ASK_FIRST=1              for code: report `waiting` with the plan and publish only once a maintainer answers Continue (or a reply)
 *
 * The runner acts only on requests that reach it with its token, which a maintainer made: the token stands in for the request's author. Keep
 * the token as secret as the forge token. Run it as `node pull-runner.mjs`.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// The contract, vendored beside this file (a copy of cornfield's core/agent-contract.js, kept byte for byte): every request is checked with it
// before it is claimed, so a credential, a stray key or an unsafe branch name is refused as strictly as cornfield refuses it
import { branchProblem, validateRequest } from './agent-contract.js';

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

/**
 * The branch a request's work goes on: its hint, or `agent/<runId>`. Never the base branch, and never a name git could read as an option or a
 * refspec (`main:main`, `+x`, `-f`): only what the contract's `branchProblem` accepts. Throws in words.
 */
export function branchFor(request, base) {
  const branch = request.branch || `agent/${request.runId}`;
  const problem = branchProblem(branch);
  if (problem) throw new Error(`The branch ${problem}`);
  if (branch === base || branch === 'HEAD') throw new Error(`The work does not go on ${branch}: a run pushes a branch of its own.`);
  return branch;
}

/** Writes one file inside the clone: refused when it, or a folder on its way, is a link (it could point out of the clone) */
function writeInside(dir, rel, content) {
  const root = fs.realpathSync(dir);
  const target = path.join(root, rel);
  let at = root;
  for (const part of rel.split('/').slice(0, -1)) {
    at = path.join(at, part);
    if (fs.existsSync(at)) {
      if (fs.lstatSync(at).isSymbolicLink() || !fs.lstatSync(at).isDirectory()) throw new Error(`"${rel}" goes through ${path.relative(root, at)}, which is not a plain folder.`);
    } else fs.mkdirSync(at);
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error(`"${rel}" is a link; the runner does not write through one.`);
  fs.writeFileSync(target, content);
}

/** Writes the files on a new branch, commits as the runner, pushes, and opens the pull request. Answers its link. */
export async function publish({ request, answer, env, fetch, exec = sh }) {
  const dir = env.REPO_DIR;
  const base = env.BASE_BRANCH || 'main';
  const branch = branchFor(request, base);
  const identity = { GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME: env.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: env.GIT_AUTHOR_EMAIL };
  // The forge token goes in the environment, not on the command line (where `ps` shows it)
  const auth = `Basic ${Buffer.from(`x-access-token:${env.FORGE_TOKEN}`).toString('base64')}`;
  const git = (...args) => exec('git', args, { cwd: dir, env: { ...identity, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: ${auth}` } });
  await git('fetch', 'origin', base);
  await git('switch', '-C', branch, `origin/${base}`);
  for (const f of answer.files) writeInside(dir, f.path, f.content);
  await git('add', '--', ...answer.files.map((f) => f.path));
  // The trailer is how cornfield finds this work: the run id travels with the commit and the pull request
  await git('commit', '-m', `${answer.summary}\n\nCornfield-Run: ${request.runId}`);
  // A new branch of the run's own, never forced: a branch that is already there (someone else's work) makes the push fail
  await git('push', 'origin', `HEAD:refs/heads/${branch}`);
  const github = (env.FORGE_TYPE || 'github') === 'github';
  const root = env.FORGE_URL ? env.FORGE_URL.replace(/\/+$/, '') : '';
  const api = github ? (root ? `${root}/api/v3` : 'https://api.github.com') : `${root}/api/v1`;
  const res = await fetch(`${api}/repos/${env.FORGE_REPO}/pulls`, {
    method: 'POST', headers: { authorization: `token ${env.FORGE_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: answer.summary, head: branch, base, body: `${request.brief.slice(0, 2000)}\n\nCornfield-Run: ${request.runId}` }),
  });
  if (!res.ok) throw new Error(`The forge answered ${res.status} to the pull request.`);
  return (await res.json()).html_url;
}

/**
 * Asks a maintainer (docs/agent-contract.md#reports-stopping-and-waiting): reports `waiting` with a note, then reads the run every `every` ms
 * until it is answered or asked to stop. A new wait clears the last answer, so any answer seen belongs to this one. Resolves with the answer.
 */
export async function waitForAnswer(cf, runId, note, { sleep, every }) {
  await cf.report(runId, 'waiting', { note });
  for (;;) {
    const run = await cf.run(runId);
    if (!run || run.stopRequested || run.finished) return { action: 'stop' };
    if (run.answer) return run.answer;
    await sleep(every);
  }
}

/** One pass: claim the oldest request and do it. Resolves with the run id it handled, or null when there was nothing to do. */
export async function runOnce({ env, fetch = globalThis.fetch, exec, log = console.error, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const cf = cornfield({ fetch, url: env.CORNFIELD_URL, token: env.CORNFIELD_RUNNER_TOKEN });
  // Only a request the contract accepts is claimed: cornfield checks it too, and this runner does not take its word for it
  const request = (await cf.queue()).map((r) => validateRequest(r)).find((c) => c.ok)?.value;
  if (!request || !(await cf.claim(request.runId))) return null;
  const say = (s) => log(`[pull-runner] ${request.runId}: ${s}`);
  // Neither of the runner's own secrets goes in a note (cornfield would refuse one shaped like a credential anyway)
  const clean = (s) => [env.FORGE_TOKEN, env.CORNFIELD_RUNNER_TOKEN].filter(Boolean).reduce((t, secret) => t.replaceAll(secret, '***'), String(s)).slice(0, NOTE_CHARS);
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
      let plan = parseModelAnswer(text);
      if (env.ASK_FIRST === '1') {
        const paths = plan.files.map((f) => f.path).join(', ');
        const answer = await waitForAnswer(cf, request.runId, clean(`Plan ready: ${plan.summary} (${paths}). Continue to publish it, Stop, or reply to change it.`), { sleep, every: Math.max(5, Number(env.POLL_SECONDS) || 30) * 1000 });
        if (answer.action === 'stop') {
          await cf.report(request.runId, 'stopped', { note: 'Stopped at the plan, before anything was published.' });
          return request.runId;
        }
        await cf.report(request.runId, 'working');
        // A reply is the maintainer's words to the model: the plan is asked for again with them
        if (answer.action === 'reply') plan = parseModelAnswer(await ask({ fetch, ollamaUrl: env.OLLAMA_URL || 'http://127.0.0.1:11434', model: env.OLLAMA_MODEL, prompt: `${promptFor(request)}\n\nA maintainer answered your plan: ${answer.text}` }));
      }
      const url = await publish({ request, answer: plan, env, fetch, exec });
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
