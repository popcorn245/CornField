/**
 * @vitest-environment node
 *
 * The pipeline's own steps (server/pipeline.js, server/forge-actions.js, PIPE-05): "Start a spec" on an issue and
 * "Open the build issue" on an approved spec pull request, walked from the outside against a fake forge on loopback
 * that remembers what it is asked to make (a branch, a file, a pull request, an issue). Landing is step 3 and is the
 * merge action of forge-actions.test.js. Every rule of an action is held here too: the plan is shown first and the
 * action must carry its digest, a second ask finds what the first made, the permission is asked of the forge at that
 * moment, the same origin and JSON only, throttled, audited, and everything checked again on the server.
 * No real forge, app or token.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error plain JS module, no declarations
import { createCornfieldServer } from '../../server/server.js';
// @ts-expect-error plain JS module, no declarations
import { loadConfig } from '../../core/config.js';
// @ts-expect-error plain JS module, no declarations
import { validateProposal } from '../../core/proposal.js';
// @ts-expect-error plain JS module, no declarations
import { reviewComment } from '../../server/reviews.js';
// @ts-expect-error plain JS module, no declarations
import { specSlug, plain, code, checklist, buildMarker } from '../../server/pipeline.js';
import { SAMPLE } from '../helpers.js';
import { fakeForge, recordings } from './fake-forge.js';

const SESSION_SECRET = 'x'.repeat(40);
const ENV = { CORNFIELD_GITHUB_CLIENT_ID: 'test-client-id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: SESSION_SECRET };
const PUBLIC = 'http://127.0.0.1:3350';
const MAINT = 'tok-maint';
const READER = 'tok-reader';
const MAIN = '0000000000000000000000000000000000000001';
let H1 = '';
let H2 = '';
let heads = 0;
const API = '/api/v3';
const GH = `${API}/repos/owner/name`;
const FOLDER = 'docs/specs/proposals';
const SPEC_BRANCH = 'spec/7-meals-page-with-caf';
const SPEC_PATH = `${FOLDER}/7-meals-page-with-caf.json`;
const BUILD_PATH = `${FOLDER}/0040-meals.json`;

const proposal = () => ({
  version: 1, title: 'Meals', summary: 'Plan the week.',
  nodes: {
    add: [{ id: 'page-meals', label: '/meals', type: 'page', parent: 'app-a' }],
    change: [{ id: 'app-a', set: { desc: 'Now plans meals.' }, why: 'It owns the meals page.' }],
    remove: [{ id: 'page-old', why: 'Replaced by meals.' }],
  },
  edges: { add: [{ from: 'page-meals', to: 'app-a', kind: 'calls' }] },
});

function raw(port, method, target, { headers = {}, body } = {}) {
  const sent = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: sent, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode || 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function signedIn(port, code_) {
  const started = await raw(port, 'GET', '/auth/start');
  const to = new URL(started.headers.location);
  const stateCookie = started.headers['set-cookie'].find((c) => c.startsWith('cornfield-oauth=')).split(';')[0];
  const back = await raw(port, 'GET', `/auth/callback?code=${code_}&state=${to.searchParams.get('state')}`, { headers: { cookie: stateCookie } });
  expect(back.status, back.text).toBe(303);
  return back.headers['set-cookie'].find((c) => c.startsWith('cornfield=')).split(';')[0];
}

const user = { login: 'maintainer-one', html_url: 'https://github.example.com/maintainer-one' };
const issue = (number, title, extra = {}) => ({ number, title, state: 'open', user, labels: [], body: '', comments: 0, html_url: `https://github.example.com/owner/name/issues/${number}`, created_at: '2026-10-19T09:00:00Z', updated_at: '2026-10-19T09:00:00Z', closed_at: null, ...extra });
const pullOf = (number, title, head, sha, extra = {}) => ({ number, title, state: 'open', draft: false, user, labels: [], head: { ref: head, sha }, base: { ref: 'main' }, html_url: `https://github.example.com/owner/name/pull/${number}`, created_at: '2026-10-19T09:00:00Z', updated_at: '2026-10-19T09:00:00Z', merged_at: null, ...extra });
const comment = (id, login, body, at = '2026-10-19T10:00:00Z', updated = at) => ({ id, user: { login, html_url: `https://github.example.com/${login}` }, body, html_url: `https://github.example.com/owner/name/pull/40#issuecomment-${id}`, created_at: at, updated_at: updated });
const approval = (edits = []) => reviewComment('0040-meals', { verdict: 'approved', note: '', edits }, { login: 'maintainer-one' });
const sentBack = () => reviewComment('0040-meals', { verdict: 'notes', note: 'Not yet.', edits: [] }, { login: 'maintainer-one' });

/** What the fake forge holds, and what it was asked to make */
function freshWorld() {
  return {
    issues: { 7: issue(7, 'Meals page, with café!', { body: 'People want to plan meals.' }), 8: issue(8, 'Old', { state: 'closed' }) },
    builds: [], // issues made by createIssue, newest first
    pulls: [pullOf(40, 'Meals spec', 'spec/0040-meals', H1, { draft: true })],
    madePulls: [],
    branches: [{ name: 'main', sha: MAIN }, { name: 'spec/0040-meals', sha: H1 }],
    files: { [`${H1}:${BUILD_PATH}`]: `${JSON.stringify(proposal(), null, 2)}\n` },
    changed: { 40: [{ filename: BUILD_PATH, status: 'added', additions: 20, deletions: 0 }] },
    comments: { 40: [comment(9001, 'maintainer-one', approval())] },
    writes: [],
  };
}

describe('the pipeline steps', () => {
  let fake;
  let data;
  let srv;
  let clock = Date.parse('2026-10-19T12:00:00Z');
  let cookie;
  let world;
  let config;
  const state = { override: {} };
  const base = recordings('github');

  /** The fake forge: the recorded user and repo, and a repo that remembers what was made */
  const dispatch = (key, req) => {
    const [method, target] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
    if (state.override[key]) return state.override[key](req);
    const reader = req.headers.authorization === `Bearer ${READER}`;
    if (key === 'POST /login/oauth/access_token') return { body: { access_token: req.body.includes('c-reader') ? READER : MAINT, token_type: 'bearer' } };
    if (key === `GET ${API}/user`) return reader ? { body: { login: 'reader-two', id: 1002 } } : base['GET /user'];
    if (key === `GET ${GH}`) return reader ? { body: { id: 1, full_name: 'owner/name', permissions: { admin: false, maintain: false, push: false, triage: false, pull: true } } } : base['GET /repos/owner/name'];
    if (!target.startsWith(GH)) return { status: 404, body: { message: 'Not Found' } };
    const url = new URL(target.slice(GH.length), 'http://x');
    const p = decodeURIComponent(url.pathname);
    const body = req.body ? JSON.parse(req.body) : null;
    let m;
    if (method === 'GET' && (m = /^\/issues\/(\d+)$/.exec(p))) {
      const n = Number(m[1]);
      if (n === 12) return { body: { ...issue(12, 'A pull request'), pull_request: { url: 'x' } } };
      return world.issues[n] ? { body: world.issues[n] } : { status: 404, body: { message: 'Not Found' } };
    }
    if (method === 'GET' && p === '/issues') return { body: [...world.builds, ...Object.values(world.issues)] };
    if (method === 'GET' && p === '/pulls') return { body: [...world.madePulls, ...world.pulls] };
    if (method === 'GET' && (m = /^\/pulls\/(\d+)$/.exec(p))) {
      const found = [...world.madePulls, ...world.pulls].find((x) => x.number === Number(m[1]));
      return found ? { body: found } : { status: 404, body: { message: 'Not Found' } };
    }
    if (method === 'GET' && (m = /^\/pulls\/(\d+)\/files$/.exec(p))) return { body: world.changed[Number(m[1])] || [] };
    if (method === 'GET' && (m = /^\/issues\/(\d+)\/comments$/.exec(p))) return { body: world.comments[Number(m[1])] || [] };
    if (method === 'GET' && p === '/branches') return { body: world.branches.map((b) => ({ name: b.name, commit: { sha: b.sha }, protected: b.name === 'main' })) };
    if (method === 'GET' && (m = /^\/branches\/(.+)$/.exec(p))) {
      const b = world.branches.find((x) => x.name === m[1]);
      return b ? { body: { name: b.name, commit: { sha: b.sha } } } : { status: 404, body: { message: 'Not Found' } };
    }
    if (method === 'GET' && p.startsWith('/contents/')) {
      const text = world.files[`${url.searchParams.get('ref')}:${p.slice('/contents/'.length)}`];
      return text === undefined ? { status: 404, body: { message: 'Not Found' } } : { headers: { 'content-type': 'application/vnd.github.raw; charset=utf-8' }, body: text };
    }
    if (method === 'GET' && p.startsWith('/commits/')) return p.endsWith('/status') ? { body: { statuses: [] } } : { body: { check_runs: [] } };
    if (method === 'POST' && p === '/git/refs') {
      world.writes.push(`${method} ${p}`);
      const name = body.ref.replace('refs/heads/', '');
      if (world.branches.some((b) => b.name === name)) return { status: 422, body: { message: 'Reference already exists' } };
      world.branches.push({ name, sha: body.sha });
      return { status: 201, body: { ref: body.ref, object: { sha: body.sha } } };
    }
    if (method === 'PUT' && p.startsWith('/contents/')) {
      world.writes.push(`${method} ${p}`);
      const at = p.slice('/contents/'.length);
      if (world.files[`${body.branch}:${at}`] !== undefined) return { status: 422, body: { message: '"sha" wasn\'t supplied.' } };
      world.files[`${body.branch}:${at}`] = Buffer.from(body.content, 'base64').toString('utf8');
      const branch = world.branches.find((b) => b.name === body.branch);
      if (branch) branch.sha = 'c'.repeat(40);
      return { status: 201, body: { commit: { sha: 'c'.repeat(40) } } };
    }
    if (method === 'POST' && p === '/pulls') {
      world.writes.push(`${method} ${p}`);
      const made = pullOf(50 + world.madePulls.length, body.title, body.head, 'c'.repeat(40), { draft: body.draft, body: body.body, base: { ref: body.base } });
      world.madePulls.unshift(made);
      return { status: 201, body: made };
    }
    if (method === 'POST' && p === '/issues') {
      world.writes.push(`${method} ${p}`);
      const made = issue(60 + world.builds.length, body.title, { body: body.body });
      world.builds.unshift(made);
      return { status: 201, body: made };
    }
    return { status: 404, body: { message: 'Not Found' } };
  };
  const routes = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? (req) => dispatch(key, req) : undefined) });

  const start = async (config, opts) => {
    const server = createCornfieldServer(config, opts);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    return { port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
  };

  beforeAll(async () => {
    fake = await fakeForge(routes);
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-pipeline-'));
    config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(config, { forge: { type: 'github', url: fake.url, repo: 'owner/name' }, publicUrl: PUBLIC });
    srv = await start(config, { env: ENV, now: () => clock });
    cookie = await signedIn(srv.port, 'c-maint');
  });
  afterAll(async () => {
    await srv.close();
    await fake.close();
    fs.rmSync(data, { recursive: true, force: true });
  });
  beforeEach(() => {
    clock += 120_000;
    state.override = {};
    heads += 1;
    H1 = `${heads.toString(16).padStart(4, '0')}`.padEnd(40, 'a');
    H2 = `${heads.toString(16).padStart(4, '0')}`.padEnd(40, 'b');
    world = freshWorld();
    fake.requests.length = 0;
  });

  const origin = () => `http://127.0.0.1:${srv.port}`;
  const plan = async (target, { as = cookie } = {}) => raw(srv.port, 'GET', target, { headers: { cookie: as || undefined } });
  const post = (target, body, { headers = {}, as = cookie, method = 'POST' } = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return raw(srv.port, method, target, {
      headers: { cookie: as || undefined, origin: origin(), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers },
      body: text,
    });
  };
  const rows = () => {
    const db = new DatabaseSync(path.join(data, 'cornfield.db'));
    const out = db.prepare('SELECT * FROM actions ORDER BY id').all();
    db.close();
    return out.map((r) => ({ ...r, request: JSON.parse(String(r.request)), answer: r.answer ? JSON.parse(String(r.answer)) : null }));
  };
  const last = () => rows().at(-1);
  const wrote = () => fake.requests.filter((r) => r.method !== 'GET' && !r.url.startsWith('/login/'));
  /** A proposal's text at a head nobody has read yet (what a commit holds never changes, so cornfield keeps it by sha) */
  let bump = 0;
  const retarget = (text) => {
    bump += 1;
    const sha = `${H1.slice(0, 20)}${String(bump).padStart(20, 'e')}`;
    world.pulls[0].head.sha = sha;
    world.files[`${sha}:${BUILD_PATH}`] = typeof text === 'string' ? text : JSON.stringify(text);
    return sha;
  };
  const SPEC = '/api/forge/issues/7/spec';
  const BUILD = '/api/forge/pulls/40/build';
  const buildPlan = async () => (await plan(`${BUILD}?slug=0040-meals`)).json.plan;
  const specPlan = async () => (await plan(SPEC)).json.plan;
  const startSpec = async (extra = {}) => post(SPEC, { digest: (await specPlan()).digest, ...extra });
  const openBuild = async (extra = {}) => { const p = await buildPlan(); return post(BUILD, { slug: '0040-meals', sha: p.sha, digest: p.digest, ...extra }); };

  // -------------------------------------------------------------------------
  describe('step 1: start a spec on an issue', () => {
    it('shows the plan first: the branch, the stub proposal, the draft pull request, and writes nothing', async () => {
      const res = await plan(SPEC);
      expect(res.status, res.text).toBe(200);
      const p = res.json.plan;
      expect(p).toMatchObject({ kind: 'spec', branch: SPEC_BRANCH, base: 'main', path: SPEC_PATH, title: 'Spec: Meals page, with café!', existing: null, issue: { number: 7 } });
      expect(p.body.split('\n')[0]).toBe('Refs #7');
      const stub = JSON.parse(p.content);
      expect(stub).toMatchObject({ version: 1, title: 'Meals page, with café!' });
      expect(validateProposal({ nodes: [], edges: [] }, stub)).toEqual([]);
      expect(p.digest).toMatch(/^[0-9a-f]{32}$/);
      expect(wrote()).toEqual([]);
      expect(rows()).toHaveLength(0);
    });

    it('makes the branch, one commit with the stub proposal, and a draft pull request that refs the issue, as the maintainer', async () => {
      const shown = await specPlan();
      fake.requests.length = 0;
      const res = await post(SPEC, { digest: shown.digest });
      expect(res.status, res.text).toBe(201);
      expect(res.json).toMatchObject({ ok: true, action: 'spec', created: true, number: 7, branch: SPEC_BRANCH, path: SPEC_PATH, pull: { number: 50, draft: true } });
      expect(world.writes).toEqual(['POST /git/refs', `PUT /contents/${SPEC_PATH}`, 'POST /pulls']);
      expect(world.branches.find((b) => b.name === SPEC_BRANCH)).toBeTruthy();
      expect(world.files[`${SPEC_BRANCH}:${SPEC_PATH}`]).toBe(shown.content);
      expect(world.madePulls[0]).toMatchObject({ title: 'Spec: Meals page, with café!', draft: true, head: { ref: SPEC_BRANCH }, base: { ref: 'main' } });
      expect(world.madePulls[0].body.startsWith('Refs #7')).toBe(true);
      for (const r of fake.requests.filter((q) => q.url.startsWith(API))) expect(r.headers.authorization).toBe(`Bearer ${MAINT}`);
      expect(last()).toMatchObject({ login: 'maintainer-one', action: 'spec', target: 'owner/name#7', status: 201, request: { action: 'spec', number: 7, digest: shown.digest, branch: SPEC_BRANCH, path: SPEC_PATH } });
      expect(last().answer).toMatchObject({ ok: true, created: true });
      expect(last().at).toBe(new Date(clock).toISOString());
    });

    it('is idempotent: a second ask finds the pull request the first made, and makes nothing', async () => {
      const first = await startSpec();
      expect(first.status).toBe(201);
      clock += 10_000;
      const again = await plan(SPEC);
      expect(again.json.plan.existing).toMatchObject({ number: 50, draft: true });
      world.writes.length = 0;
      const second = await post(SPEC, { digest: again.json.plan.digest });
      expect([second.status, second.json.created, second.json.pull.number]).toEqual([200, false, 50]);
      expect(world.writes).toEqual([]);
      expect(world.madePulls).toHaveLength(1);
      expect(last()).toMatchObject({ action: 'spec', status: 200 });
    });

    it('finds the pull request even with a plan that was shown before it changed', async () => {
      await startSpec();
      clock += 10_000;
      world.issues[7].title = 'Renamed';
      world.writes.length = 0;
      const second = await post(SPEC, { digest: '0'.repeat(32) });
      expect([second.status, second.json.created]).toEqual([200, false]);
      expect(world.writes).toEqual([]);
    });

    it('picks up where a half-made one stopped: the branch and the file are there, only the pull request is missing', async () => {
      const shown = await specPlan();
      world.branches.push({ name: SPEC_BRANCH, sha: 'c'.repeat(40) });
      world.files[`${SPEC_BRANCH}:${SPEC_PATH}`] = shown.content;
      const res = await post(SPEC, { digest: shown.digest });
      expect([res.status, res.json.created]).toEqual([201, true]);
      expect(world.writes).toEqual(['POST /pulls']);
    });

    it('adds the file to a branch nothing was added to, but never commits onto a branch with other work', async () => {
      const shown = await specPlan();
      world.branches.push({ name: SPEC_BRANCH, sha: MAIN });
      const fresh = await post(SPEC, { digest: shown.digest });
      expect([fresh.status, world.writes]).toEqual([201, [`PUT /contents/${SPEC_PATH}`, 'POST /pulls']]);
      clock += 10_000;
      world = freshWorld();
      world.branches.push({ name: SPEC_BRANCH, sha: 'd'.repeat(40) });
      const taken = await post(SPEC, { digest: shown.digest });
      expect([taken.status, taken.json.code]).toEqual([409, 'conflict']);
      expect(taken.json.error).toContain('other work on it');
      expect(world.writes).toEqual([]);
      expect(last()).toMatchObject({ action: 'spec', status: 409 });
    });

    it('is the plan that was shown or nothing: an issue edited since is a 409 and nothing is made', async () => {
      const shown = await specPlan();
      world.issues[7].title = 'Something else entirely';
      const res = await post(SPEC, { digest: shown.digest });
      expect([res.status, res.json.code]).toEqual([409, 'conflict']);
      expect(res.json.error).toContain('has changed since it was shown');
      expect(wrote()).toEqual([]);
      expect(last()).toMatchObject({ action: 'spec', status: 409 });
    });

    it('wants the digest, as hex, and nothing the page says decides what is made', async () => {
      for (const body of [{}, { digest: 'nope' }, { digest: 7 }, '[1]', '{nope']) {
        const res = await post(SPEC, body);
        expect([res.status, res.json.code]).toEqual([400, 'invalid']);
        clock += 10_000;
      }
      // Extra fields change nothing: the branch, path and text come from the issue and the server
      const shown = await specPlan();
      const res = await post(SPEC, { digest: shown.digest, branch: 'main', path: 'server/server.js', content: 'evil', title: 'evil' });
      expect(res.status).toBe(201);
      expect(world.writes).toEqual(['POST /git/refs', `PUT /contents/${SPEC_PATH}`, 'POST /pulls']);
      expect(world.branches.find((b) => b.name === 'main').sha).toBe(MAIN);
      expect(Object.keys(world.files)).toContain(`${SPEC_BRANCH}:${SPEC_PATH}`);
    });

    it('refuses a closed issue, a pull request, and an issue that is not there', async () => {
      expect((await plan('/api/forge/issues/8/spec')).json.error).toBe('Issue #8 is closed, so no spec is started for it.');
      const closed = await post('/api/forge/issues/8/spec', { digest: 'a'.repeat(32) });
      expect([closed.status, closed.json.code]).toEqual([409, 'conflict']);
      clock += 10_000;
      const pr = await post('/api/forge/issues/12/spec', { digest: 'a'.repeat(32) });
      expect([pr.status, pr.json.code]).toEqual([404, 'not-found']);
      clock += 10_000;
      const none = await post('/api/forge/issues/99/spec', { digest: 'a'.repeat(32) });
      expect([none.status, none.json.code]).toEqual([404, 'not-found']);
      expect(wrote()).toEqual([]);
    });

    it('has no route for a pull request number as an issue, nor an issue as a pull request', async () => {
      expect((await post('/api/forge/pulls/7/spec', { digest: 'a'.repeat(32) })).status).not.toBe(201);
      expect((await post('/api/forge/issues/7/build', { digest: 'a'.repeat(32), slug: 'x', sha: H1 })).status).not.toBe(201);
      expect(wrote()).toEqual([]);
    });

    it('says a base branch that is not there, and starts from forge.baseBranch when the config names one', async () => {
      world.branches = world.branches.filter((b) => b.name !== 'main');
      const missing = await startSpec();
      expect([missing.status, missing.json.code]).toEqual([409, 'conflict']);
      expect(missing.json.error).toContain('The branch main is not there');
      expect(wrote()).toEqual([]);
      // The config names where specs start from and go into
      config.forge.baseBranch = 'develop';
      try {
        world.branches.push({ name: 'develop', sha: 'd'.repeat(40) });
        clock += 10_000;
        const shown = await specPlan();
        expect(shown.base).toBe('develop');
        const made = await post(SPEC, { digest: shown.digest });
        expect(made.status, made.text).toBe(201);
        expect(world.madePulls[0].base.ref).toBe('develop');
      } finally {
        delete config.forge.baseBranch;
      }
    });

    it('a forge that refuses is passed on in its words, and the row has the forge\'s status', async () => {
      const shown = await specPlan();
      state.override[`POST ${GH}/pulls`] = () => ({ status: 422, body: { message: 'No commits between main and spec' } });
      const res = await post(SPEC, { digest: shown.digest });
      expect([res.status, res.json.code]).toEqual([400, 'invalid']);
      expect(res.json.error).toContain('No commits between');
      expect(last()).toMatchObject({ action: 'spec', status: 422 });
      // The branch and the file are there now: asking again picks up and opens the pull request
      clock += 10_000;
      state.override = {};
      const again = await post(SPEC, { digest: shown.digest });
      expect([again.status, again.json.created]).toEqual([201, true]);
    });
  });

  // -------------------------------------------------------------------------
  describe('step 2: open the build issue of an approved spec', () => {
    it('lists the specs a pull request changes, and whether a maintainer approved each, with its detail', async () => {
      const res = await plan('/api/forge/pulls/40');
      expect(res.json.specs).toEqual([{ slug: '0040-meals', path: BUILD_PATH, approved: true }]);
      world.comments[40] = [comment(9001, 'maintainer-one', sentBack())];
      clock += 120_000;
      expect((await plan('/api/forge/pulls/40')).json.specs).toEqual([{ slug: '0040-meals', path: BUILD_PATH, approved: false }]);
    });

    it('shows the plan first: links the spec pull request and the proposal, the nodes and edges as a checklist, and writes nothing', async () => {
      const res = await plan(`${BUILD}?slug=0040-meals`);
      expect(res.status, res.text).toBe(200);
      const p = res.json.plan;
      expect(p).toMatchObject({ kind: 'build', slug: '0040-meals', path: BUILD_PATH, sha: H1, existing: null, items: 4, pull: { number: 40 }, review: { by: 'maintainer-one' }, title: 'Build: Meals' });
      expect(p.body).toContain('Spec pull request: #40');
      expect(p.body).toContain(`\`${BUILD_PATH}\` at \`${H1.slice(0, 12)}\``);
      expect(p.body).toContain('- [ ] Add `page-meals` (/meals, page)');
      expect(p.body).toContain('- [ ] Change `app-a`: It owns the meals page.');
      expect(p.body).toContain('- [ ] Remove `page-old`: Replaced by meals.');
      expect(p.body).toContain('- [ ] Add `page-meals` → `app-a` (calls)');
      expect(p.body).toContain(buildMarker(40, '0040-meals'));
      expect(wrote()).toEqual([]);
    });

    it('makes the issue, as the maintainer, and writes it down', async () => {
      const shown = await buildPlan();
      fake.requests.length = 0;
      const res = await post(BUILD, { slug: '0040-meals', sha: H1, digest: shown.digest });
      expect(res.status, res.text).toBe(201);
      expect(res.json).toMatchObject({ ok: true, action: 'build', created: true, number: 40, slug: '0040-meals', issue: { number: 60, state: 'open' } });
      expect(world.writes).toEqual(['POST /issues']);
      expect(world.builds[0]).toMatchObject({ title: 'Build: Meals', body: shown.body });
      for (const r of fake.requests.filter((q) => q.url.startsWith(API))) expect(r.headers.authorization).toBe(`Bearer ${MAINT}`);
      expect(last()).toMatchObject({ login: 'maintainer-one', action: 'build', target: 'owner/name#40/0040-meals', status: 201, request: { action: 'build', number: 40, slug: '0040-meals', sha: H1, digest: shown.digest } });
    });

    it('is idempotent: a second ask finds the issue the first made, even after a push', async () => {
      expect((await openBuild()).status).toBe(201);
      clock += 10_000;
      const shown = await buildPlan();
      expect(shown.existing).toMatchObject({ number: 60 });
      world.writes.length = 0;
      world.pulls[0].head.sha = H2; // a push since: the first issue is still found
      world.files[`${H2}:${BUILD_PATH}`] = world.files[`${H1}:${BUILD_PATH}`];
      const second = await post(BUILD, { slug: '0040-meals', sha: H1, digest: shown.digest });
      expect([second.status, second.json.created, second.json.issue.number]).toEqual([200, false, 60]);
      expect(world.writes).toEqual([]);
      expect(world.builds).toHaveLength(1);
    });

    it('applies the approval\'s own edits: the checklist is the proposal as approved', async () => {
      world.comments[40] = [comment(9001, 'maintainer-one', approval([{ op: 'add-node', id: 'page-extra', label: '/extra', type: 'page', parent: 'app-a' }, { op: 'remove-node', id: 'page-meals' }]))];
      const p = await buildPlan();
      expect(p.body).toContain('Add `page-extra` (/extra, page)');
      expect(p.body).not.toContain('Add `page-meals` (');
      expect(p.body).toContain('with 2 edits folded in');
    });

    it('needs an approval by a maintainer: a send back, no review, a forged one by a reader, an edited one', async () => {
      const refuse = async (words) => {
        const res = await plan(`${BUILD}?slug=0040-meals`);
        expect([res.status, res.json.code]).toEqual([409, 'conflict']);
        expect(res.json.error).toContain(words);
        clock += 10_000;
        const posted = await post(BUILD, { slug: '0040-meals', sha: H1, digest: 'a'.repeat(32) });
        expect([posted.status, posted.json.code]).toEqual([409, 'conflict']);
        expect(wrote()).toEqual([]);
      };
      world.comments[40] = [comment(9001, 'maintainer-one', sentBack())];
      await refuse('sent it back');
      world.comments[40] = [];
      await refuse('no review by a maintainer');
      // A reader's approval is no approval (reader-two reads the repo)
      state.override[`GET ${GH}/collaborators/reader-two/permission`] = () => ({ body: { permission: 'read', role_name: 'read' } });
      world.comments[40] = [comment(9001, 'reader-two', approval())];
      await refuse('no review by a maintainer');
      // A maintainer's approval someone has edited since does not count
      world.comments[40] = [comment(9001, 'maintainer-one', approval(), '2026-10-19T10:00:00Z', '2026-10-19T11:00:00Z')];
      await refuse('no review by a maintainer');
      // The latest review wins: an approval sent back after is not one
      world.comments[40] = [comment(9001, 'maintainer-one', approval()), comment(9002, 'maintainer-one', sentBack(), '2026-10-19T11:00:00Z')];
      await refuse('sent it back');
    });

    it('is the plan that was shown: a push since is a 409, and so is a new review', async () => {
      const shown = await buildPlan();
      world.pulls[0].head.sha = H2;
      world.files[`${H2}:${BUILD_PATH}`] = world.files[`${H1}:${BUILD_PATH}`];
      const pushed = await post(BUILD, { slug: '0040-meals', sha: shown.sha, digest: shown.digest });
      expect([pushed.status, pushed.json.code]).toEqual([409, 'conflict']);
      expect(pushed.json.error).toContain('has changed since it was looked at');
      clock += 10_000;
      world.pulls[0].head.sha = H1;
      world.comments[40] = [comment(9001, 'maintainer-one', approval([{ op: 'remove-node', id: 'page-meals' }]))];
      const edited = await post(BUILD, { slug: '0040-meals', sha: shown.sha, digest: shown.digest });
      expect([edited.status, edited.json.code]).toEqual([409, 'conflict']);
      expect(edited.json.error).toContain('would say has changed');
      expect(wrote()).toEqual([]);
    });

    it('wants the slug and the sha, as the proposals folder spells them', async () => {
      const p = await buildPlan();
      for (const body of [{}, { slug: '0040-meals' }, { slug: '0040-meals', sha: 'main', digest: p.digest }, { slug: '../x', sha: H1, digest: p.digest }, { slug: '0040-meals', sha: H1 }, { slug: 7, sha: H1, digest: p.digest }]) {
        const res = await post(BUILD, body);
        expect([res.status, res.json.code]).toEqual([400, 'invalid']);
        clock += 10_000;
      }
      expect((await plan(`${BUILD}?slug=..%2Fx`)).status).toBe(400);
      expect((await plan(`${BUILD}`)).status).toBe(400);
      expect(wrote()).toEqual([]);
    });

    it('refuses a closed pull request, a proposal it does not hold, and a proposal that is not one', async () => {
      world.pulls[0].state = 'closed';
      expect((await plan(`${BUILD}?slug=0040-meals`)).json.error).toContain('is closed');
      world.pulls[0].state = 'open';
      expect((await plan(`${BUILD}?slug=0041-other`)).json.error).toContain('does not hold a proposal called 0041-other');
      retarget('{"not":"a proposal"}');
      expect((await plan(`${BUILD}?slug=0040-meals`)).json.error).toContain('is not a proposal');
      retarget('{nope');
      expect((await plan(`${BUILD}?slug=0040-meals`)).json.error).toContain('is not valid JSON');
      expect(wrote()).toEqual([]);
    });

    it('defuses what a proposal says before it goes into an issue: no mention, no reference, no markup, no code span broken out of', async () => {
      const nasty = proposal();
      nasty.nodes.add[0] = { id: 'page`x`\n- [x] injected', label: '@everyone <script>alert(1)</script> #1 [a](http://evil) **b**', type: 'page' };
      nasty.nodes.change[0].why = 'Closes #99 and pings @someone\n## Heading\n> quote';
      nasty.summary = '@team look at <img src=x onerror=alert(1)>';
      retarget(nasty);
      const p = await buildPlan();
      expect(p.body).not.toMatch(/@everyone|@someone|@team/);
      expect(p.body).not.toContain('<script>');
      expect(p.body).not.toContain('<img');
      expect(p.body).not.toContain('Closes #99');
      expect(p.body).not.toMatch(/^## Heading/m);
      expect(p.body).not.toMatch(/^> quote/m);
      expect(p.body).not.toMatch(/\[a\]\(http/);
      expect(p.body.split('\n').filter((l) => l.startsWith('- [ ] ')).length).toBe(4);
      expect(p.body).not.toMatch(/^- \[x\]/m);
    });
  });

  describe('the pieces that make the text', () => {
    it('names a spec from the issue: its number, then a plain slug of the title', () => {
      expect(specSlug(7, 'Meals page, with café!')).toBe('7-meals-page-with-caf');
      expect(specSlug(18, '[PIPE-05] The pipeline\'s own steps')).toBe('18-pipe-05-the-pipeline-s-own-steps');
      expect(specSlug(3, '日本語')).toBe('3-node');
      expect(specSlug(9, 'x'.repeat(300))).toBe(`9-${'x'.repeat(48)}`);
      expect(specSlug(4, '---')).toMatch(/^4-[a-z]+$/);
    });

    it('plain() turns markup, mentions and references into entities, and code() cannot be ended', () => {
      expect(plain('@a #1 <b> `c` [d](e) *f* _g_ \\ | ~ !')).toBe('&#64;a &#35;1 &lt;b&gt; &#96;c&#96; &#91;d&#93;(e) &#42;f&#42; &#95;g&#95; &#92; &#124; &#126; &#33;'.replace('&lt;', '&#60;').replace('&gt;', '&#62;'));
      expect(plain('a\n\nb\u0000 c')).toBe('a b c');
      expect(plain('x'.repeat(500), 10)).toHaveLength(10);
      expect(code('a`b\nc')).toBe("`a'b c`");
      expect(code('')).toBe('` `');
    });

    it('caps the checklist and counts the rest', () => {
      const many = { nodes: { add: Array.from({ length: 400 }, (_, i) => ({ id: `n${i}`, label: 'x', type: 'page' })) } };
      const { lines, count } = checklist(many);
      expect(count).toBe(400);
      expect(lines.filter((l) => l.startsWith('- [ ]'))).toHaveLength(151);
      expect(lines.join('\n')).toContain('and 250 more, in the proposal');
      expect(checklist({}).lines.join('\n')).toContain('no nodes or edges');
    });
  });

  // -------------------------------------------------------------------------
  describe('who may, where from, and how often (the rules of every action)', () => {
    it('a signed-out request is a 401, and nothing is written or asked', async () => {
      const before = rows().length;
      const res = await post(SPEC, { digest: 'a'.repeat(32) }, { as: '' });
      expect(res.status).toBe(401);
      expect((await plan(SPEC, { as: '' })).status).toBe(401);
      expect(rows()).toHaveLength(before);
      expect(fake.requests).toEqual([]);
    });

    it('a reader who signed in is turned away at the door', async () => {
      const reader = await signedIn(srv.port, 'c-reader');
      const before = rows().length;
      fake.requests.length = 0;
      expect((await post(SPEC, { digest: 'a'.repeat(32) }, { as: reader })).status).toBe(403);
      expect((await post(BUILD, { digest: 'a'.repeat(32), slug: '0040-meals', sha: H1 }, { as: reader })).status).toBe(403);
      expect((await plan(SPEC, { as: reader })).status).toBe(403);
      expect(wrote()).toEqual([]);
      expect(rows()).toHaveLength(before);
    });

    it('a maintainer who has stopped being one is a 403, asked of the forge at that moment, for both steps', async () => {
      const shown = await specPlan();
      const built = await buildPlan();
      state.override[`GET ${GH}`] = () => ({ body: { id: 1, full_name: 'owner/name', permissions: { admin: false, maintain: false, push: true, triage: true, pull: true } } });
      const a = await post(SPEC, { digest: shown.digest });
      expect([a.status, a.json.code, a.json.error]).toEqual([403, 'forbidden', 'Only the repo\'s maintainers start specs; maintainer-one is not one now.']);
      clock += 10_000;
      const b = await post(BUILD, { slug: '0040-meals', sha: H1, digest: built.digest });
      expect([b.status, b.json.error]).toEqual([403, 'Only the repo\'s maintainers open build issues; maintainer-one is not one now.']);
      expect(wrote()).toEqual([]);
      expect(last()).toMatchObject({ action: 'build', status: 403 });
    });

    it('refuses a request from another origin, and writes each down', async () => {
      const before = rows().length;
      for (const headers of [{ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, { origin: undefined, 'sec-fetch-site': undefined }]) {
        const res = await post(SPEC, { digest: 'a'.repeat(32) }, { headers });
        expect([res.status, res.json.code]).toEqual([403, 'forbidden']);
        clock += 10_000;
      }
      expect(wrote()).toEqual([]);
      expect(rows()).toHaveLength(before + 2);
    });

    it('wants JSON, and takes POST (a plan is a GET at the same address; anything else is a 405)', async () => {
      const form = await post(SPEC, 'digest=a', { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      expect([form.status, form.json.code]).toEqual([415, 'invalid']);
      for (const method of ['PUT', 'DELETE', 'PATCH']) {
        const res = await post(SPEC, { digest: 'a'.repeat(32) }, { method });
        expect([method, res.status, res.headers.allow]).toEqual([method, 405, 'GET, HEAD, POST']);
      }
      expect(wrote()).toEqual([]);
    });

    it('a plan changes nothing: a GET never writes, and writes no audit row', async () => {
      const before = rows().length;
      await plan(SPEC);
      await plan(`${BUILD}?slug=0040-meals`);
      expect(wrote()).toEqual([]);
      expect(rows()).toHaveLength(before);
    });

    it('does not make twice on a double click: the second is a 429 with a wait', async () => {
      const shown = await specPlan();
      expect((await post(SPEC, { digest: shown.digest })).status).toBe(201);
      world.writes.length = 0;
      const second = await post(SPEC, { digest: shown.digest });
      expect([second.status, second.json.code]).toEqual([429, 'rate-limited']);
      expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
      expect(world.writes).toEqual([]);
      expect(last()).toMatchObject({ action: 'spec', status: 429 });
    });

    it('holds two at the same moment to one', async () => {
      const shown = await specPlan();
      let release = () => {};
      const gate = new Promise((resolve) => { release = () => resolve(undefined); });
      state.override[`POST ${GH}/git/refs`] = async () => { await gate; return { status: 201, body: { ref: 'x', object: { sha: MAIN } } }; };
      const one = post(SPEC, { digest: shown.digest });
      for (let i = 0; i < 100 && !fake.requests.some((r) => r.method === 'POST' && r.url.endsWith('/git/refs')); i++) await new Promise((r) => setTimeout(r, 10));
      const two = await post(SPEC, { digest: shown.digest });
      expect(two.status).toBe(429);
      release();
      await one;
      expect(fake.requests.filter((r) => r.url.endsWith('/git/refs'))).toHaveLength(1);
    });

    it('answers a body that is too large at once', async () => {
      const res = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: SPEC, agent: false, headers: { cookie, origin: origin(), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': String(10 * 1024 * 1024) } }, (answer) => {
          const chunks = [];
          answer.on('data', (c) => chunks.push(c));
          answer.on('end', () => { req.destroy(); resolve({ status: answer.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); });
        });
        req.on('error', () => {});
        req.write(Buffer.alloc(8192, 0x20));
        setTimeout(() => reject(new Error('no answer before the body ended')), 3000);
      });
      expect([res.status, res.json.code]).toEqual([413, 'invalid']);
      expect(last()).toMatchObject({ action: 'spec', status: 413 });
      expect(wrote()).toEqual([]);
    });

    it('does not act when it cannot write the audit: 503, the forge not asked', async () => {
      const shown = await specPlan();
      const db = new DatabaseSync(path.join(data, 'cornfield.db'));
      db.exec('ALTER TABLE actions RENAME TO actions_away');
      db.close();
      try {
        const res = await post(SPEC, { digest: shown.digest });
        expect([res.status, res.json.code]).toEqual([503, 'unavailable']);
        expect(wrote()).toEqual([]);
      } finally {
        const back = new DatabaseSync(path.join(data, 'cornfield.db'));
        back.exec('ALTER TABLE actions_away RENAME TO actions');
        back.close();
      }
    });
  });

  it('the only writes the steps make are adding: a branch, a file, a pull request, an issue; nothing launches an agent or changes what is there', async () => {
    await startSpec();
    clock += 10_000;
    await openBuild();
    expect(world.writes).toEqual(['POST /git/refs', `PUT /contents/${SPEC_PATH}`, 'POST /pulls', 'POST /issues']);
    const methods = fake.requests.filter((r) => r.method !== 'GET' && !r.url.startsWith('/login/')).map((r) => r.method);
    expect(methods.every((m) => m === 'POST' || m === 'PUT')).toBe(true);
    expect(fake.requests.some((r) => r.method === 'DELETE' || r.method === 'PATCH' || /\/merge|\/actions\//.test(r.url))).toBe(false);
  });
});
