/**
 * @vitest-environment node
 *
 * Event hooks (PIPE-07), from the outside: a running server with `hooks` in its config, a fake forge, and a test receiver on
 * loopback that checks every signature. One test per event proves it arrives once, signed, with the right payload; an action
 * that fails sends nothing; a dead URL, a receiver that refuses the signature, and a fetch that throws change nothing about
 * the action (its route still answers success); and `spec.ready` is sent once per head, also across a restart on the same
 * data folder. The hooks themselves (retries, headers, limits) are test/server/hooks.test.js.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error plain JS module, no declarations
import { createCornfieldServer } from '../../server/server.js';
// @ts-expect-error plain JS module, no declarations
import { loadConfig } from '../../core/config.js';
// @ts-expect-error plain JS module, no declarations
import { reviewComment, proposalHash } from '../../server/reviews.js';
import { SAMPLE, freePort } from '../helpers.js';
import { fakeForge, recordings } from './fake-forge.js';

const HOOK_SECRET = 'hook-secret-for-tests-'.padEnd(40, 'z');
const SESSION_SECRET = 'x'.repeat(40);
const ENV = { CORNFIELD_GITHUB_CLIENT_ID: 'test-client-id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: SESSION_SECRET, CORNFIELD_HOOK_SECRET: HOOK_SECRET };
const PUBLIC = 'http://127.0.0.1:3350';
const MAINT = 'tok-maint';
const READER = 'tok-reader';
const MAINT2 = 'tok-maint-two';
const MAIN = '0000000000000000000000000000000000000001';
let H1 = '';
let H2 = '';
let heads = 0;
const API = '/api/v3';
const GH = `${API}/repos/owner/name`;
const FOLDER = 'docs/specs/proposals';
const SPEC_BRANCH = 'spec/0007-meals-page-with-caf';
const SPEC_PATH = `${FOLDER}/0007-meals-page-with-caf.json`;
const BUILD_PATH = `${FOLDER}/0040-meals.json`;

const proposal = () => ({
  version: 1, title: 'Meals', summary: 'Plan the week.',
  nodes: { add: [{ id: 'page-meals', label: '/meals', type: 'page', parent: 'app-a' }] },
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

/** A clock for the hooks that the test never winds: retries wait, and a hung request is never cut off */
const frozenTimer = () => ({ setTimeout: () => 0, clearTimeout: () => {} });
/** A clock fired by hand, one timer at a time: what is waiting (in ms, unref'd or not), and `fire()` runs the oldest */
function handTimer() {
  const queue = new Map();
  let n = 0;
  return {
    setTimeout: (fn, ms) => { const id = { n: ++n, unrefd: false, unref() { this.unrefd = true; } }; queue.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { queue.delete(id); },
    get waiting() { return [...queue.values()].map((t) => t.ms); },
    get unrefd() { return [...queue.keys()].every((id) => id.unrefd); },
    fire() { const [id, t] = [...queue.entries()][0]; queue.delete(id); t.fn(); },
  };
}
/** Waits for `cond` (real sockets take their time), failing rather than hanging when it never holds */
async function until(cond, what, deadlineMs = 15_000) {
  const end = Date.now() + deadlineMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

/** A receiver on loopback: it keeps what it is sent, checks each signature, and answers `status` (switchable) */
async function receiver() {
  const got = [];
  const me = { got, status: 200, url: '', close: null, of: null, next: null };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const sig = `sha256=${createHmac('sha256', HOOK_SECRET).update(body).digest('hex')}`;
      const valid = req.headers['x-cornfield-signature'] === sig;
      got.push({ headers: req.headers, valid, body: JSON.parse(body.toString('utf8')) });
      res.writeHead(valid ? me.status : 401);
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  me.url = `http://127.0.0.1:${server.address().port}/cornfield-hook`;
  me.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); });
  /** The events of one name received so far */
  me.of = (event) => got.filter((g) => g.body.event === event);
  /**
   * Waits until `n` events of that name have arrived (and then a moment, for one more that should not). It returns as
   * soon as they have; the deadline is only there to fail, rather than hang, when they never come.
   */
  me.next = async (event, n = 1) => {
    const end = Date.now() + 15_000;
    while (me.of(event).length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    await settle();
    return me.of(event);
  };
  return me;
}

const user = { login: 'maintainer-one', html_url: 'https://github.example.com/maintainer-one' };
const issue = (number, title, extra = {}) => ({ number, title, state: 'open', user, labels: [], body: '', comments: 0, html_url: `https://github.example.com/owner/name/issues/${number}`, created_at: '2026-10-19T09:00:00Z', updated_at: '2026-10-19T09:00:00Z', closed_at: null, ...extra });
const pullOf = (number, title, head, sha, extra = {}) => ({ number, title, state: 'open', draft: false, user, labels: [], head: { ref: head, sha }, base: { ref: 'main' }, html_url: `https://github.example.com/owner/name/pull/${number}`, created_at: '2026-10-19T09:00:00Z', updated_at: '2026-10-19T09:00:00Z', merged_at: null, ...extra });
const comment = (id, login, body, at = '2026-10-19T10:00:00Z', updated = at) => ({ id, user: { login, html_url: `https://github.example.com/${login}` }, body, html_url: `https://github.example.com/owner/name/pull/40#issuecomment-${id}`, created_at: at, updated_at: updated });
/** The proposal file's text as the PR's head holds it, and an approval that covers that text (as the server records it) */
const proposalText = () => `${JSON.stringify(proposal(), null, 2)}\n`;
const approval = (edits = [], covers = proposalText()) => reviewComment('0040-meals', { verdict: 'approved', note: '', edits, ...(covers === null ? {} : { proposal: proposalHash(covers) }) }, { login: 'maintainer-one' });
const sentBack = () => reviewComment('0040-meals', { verdict: 'notes', note: 'Not yet.', edits: [] }, { login: 'maintainer-one' });

/** What the fake forge holds, and what it was asked to make */
function freshWorld() {
  return {
    issues: { 7: issue(7, 'Meals page, with café!', { body: 'People want to plan meals.' }), 8: issue(8, 'Old', { state: 'closed' }) },
    builds: [], // issues made by createIssue, newest first
    pulls: [pullOf(40, 'Meals spec', 'spec/0040-meals', H1, { draft: true })],
    madePulls: [],
    branches: [{ name: 'main', sha: MAIN }, { name: 'spec/0040-meals', sha: H1 }],
    files: { [`${H1}:${BUILD_PATH}`]: proposalText() },
    changed: { 40: [{ filename: BUILD_PATH, status: 'added', additions: 20, deletions: 0 }] },
    comments: { 40: [comment(9001, 'maintainer-one', approval())] },
    writes: [],
  };
}

describe('event hooks', () => {
  let fake;
  let data;
  let srv;
  let rcv;
  let clock = Date.parse('2026-11-03T09:30:00Z');
  let cookie;
  let world;
  let config;
  let deadUrl;
  const state = { override: {} };
  const base = recordings('github');
  const timer = frozenTimer();

  /** The fake forge: the recorded user and repo, and a repo that remembers what was made */
  const dispatch = (key, req) => {
    const [method, target] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
    if (state.override[key]) return state.override[key](req);
    const reader = req.headers.authorization === `Bearer ${READER}`;
    const second = req.headers.authorization === `Bearer ${MAINT2}`;
    if (key === 'POST /login/oauth/access_token') return { body: { access_token: req.body.includes('c-reader') ? READER : req.body.includes('c-maint2') ? MAINT2 : MAINT, token_type: 'bearer' } };
    if (key === `GET ${API}/user` && second) return { body: { login: 'maintainer-two', id: 1003 } };
    if (key === `GET ${API}/user`) return reader ? { body: { login: 'reader-two', id: 1002 } } : base['GET /user'];
    if (key === `GET ${GH}`) return reader ? { body: { id: 1, full_name: 'owner/name', permissions: { admin: false, maintain: false, push: false, triage: false, pull: true } } } : base['GET /repos/owner/name'];
    // The search API: the issues whose body holds the words (q is `"<words>" in:body repo:… is:issue`)
    if (method === 'GET' && target.startsWith(`${API}/search/issues?`)) {
      const words = /^"([^"]+)"/.exec(new URL(target, 'http://x').searchParams.get('q') || '')?.[1] || '';
      if (state.searchLag) return { body: { total_count: 0, items: [] } };
      return { body: { total_count: 0, items: [...world.builds, ...Object.values(world.issues)].filter((i) => i.body.includes(words)) } };
    }
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

  const start = async (cfg, opts) => {
    // The spec.ready poll (server/spec-poll.js) is held still unless a test hands it a clock: it never looks on its own here
    const server = createCornfieldServer(cfg, { env: ENV, now: () => clock, hookTimer: timer, specPollTimer: frozenTimer(), ...opts });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    return { port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
  };
  const hooksFor = (...urls) => urls.map((url) => ({ url, events: '*' }));

  beforeAll(async () => {
    fake = await fakeForge(routes);
    rcv = await receiver();
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-hooks-'));
    config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    // the second hook is dead: nothing listens on that port
    deadUrl = `http://127.0.0.1:${await freePort()}/dead`;
    Object.assign(config, { forge: { type: 'github', url: fake.url, repo: 'owner/name' }, publicUrl: PUBLIC, hooks: hooksFor(rcv.url, deadUrl) });
    srv = await start(config);
    cookie = await signedIn(srv.port, 'c-maint');
  });
  afterAll(async () => {
    await srv.close();
    await fake.close();
    await rcv.close();
    fs.rmSync(data, { recursive: true, force: true });
  });
  beforeEach(() => {
    clock += 120_000;
    state.override = {};
    heads += 1;
    H1 = `${heads.toString(16).padStart(4, '0')}`.padEnd(40, 'a');
    H2 = `${heads.toString(16).padStart(4, '0')}`.padEnd(40, 'b');
    world = freshWorld();
    world.pulls.push(pullOf(41, 'Docs fix', 'fix/docs', 'd'.repeat(40)));
    world.changed[41] = [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 0 }];
    rcv.got.length = 0;
    rcv.status = 200;
    fake.requests.length = 0;
  });

  const post = (target, body, { method = 'POST', port = srv.port, as = cookie } = {}) => {
    const text = JSON.stringify(body);
    return raw(port, method, target, {
      headers: { cookie: as, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) },
      body: text,
    });
  };
  const get = (target, { port = srv.port, as = cookie } = {}) => raw(port, 'GET', target, { headers: { cookie: as } });
  const rows = (action) => {
    const db = new DatabaseSync(path.join(data, 'cornfield.db'));
    const out = db.prepare('SELECT * FROM actions WHERE action = ? ORDER BY id').all(action);
    db.close();
    return out.map((r) => ({ ...r, request: JSON.parse(String(r.request)), answer: r.answer ? JSON.parse(String(r.answer)) : null }));
  };
  const wrote = () => fake.requests.filter((r) => r.method !== 'GET' && !r.url.startsWith('/login/'));
  const text = () => world.files[`${H1}:${BUILD_PATH}`];
  const AT = () => new Date(clock).toISOString();
  /** The forge takes a review comment, and lands green pull requests */
  const allowWrites = () => {
    state.override[`POST ${GH}/issues/40/comments`] = (req) => ({ status: 201, body: comment(9500, 'maintainer-one', JSON.parse(req.body).body, '2026-11-03T09:30:00Z') });
    for (const [n, sha] of [[40, H1], [41, 'd'.repeat(40)]]) {
      state.override[`PUT ${GH}/pulls/${n}/merge`] = () => ({ body: { sha: 'f'.repeat(40), merged: true } });
      state.override[`GET ${GH}/commits/${sha}/check-runs?per_page=100`] = () => ({ body: { check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://ci.example.test/1' }] } });
    }
    world.pulls[0].draft = false;
    for (const p of world.pulls) p.mergeable_state = 'clean';
  };
  const REVIEW = '/proposals/0040-meals/review?source=pull%2F40';
  const BUILD = '/api/forge/pulls/40/build';
  const buildPlan = async () => (await get(`${BUILD}?slug=0040-meals`)).json.plan;

  /** What has arrived of an event after a moment: for a check that nothing more came */
  const settled = async (r, event) => { await new Promise((ok) => setTimeout(ok, 300)); return r.of(event); };
  /**
   * Waits until a data folder's cornfield.db says the repo has been looked at (the `pr = 0` row the first look writes in
   * the background), so a test never pushes before the first look is on record, however slow the machine.
   */
  const lookedAt = async (dir = data) => {
    const end = Date.now() + 15_000;
    for (;;) {
      let row;
      try {
        const db = new DatabaseSync(path.join(dir, 'cornfield.db'), { readOnly: true });
        try { row = db.prepare("SELECT 1 AS y FROM hook_seen WHERE repo = 'owner/name' AND pr = 0").get(); } finally { db.close(); }
      } catch { row = undefined; }
      if (row) return;
      if (Date.now() > end) throw new Error('timed out waiting for the first look to be recorded');
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  /** A push to spec PR #40: a new head with the proposal at it */
  const push = (tag, proposalText = text()) => {
    const sha = `${H1.slice(0, 30)}${tag.repeat(10)}`;
    world.pulls[0].head.sha = sha;
    world.files[`${sha}:${BUILD_PATH}`] = proposalText;
    return sha;
  };

  it('spec.ready: the first look records what is open and says nothing; a push after it is announced once, signed, with its head and the proposal\'s hash and no contents', async () => {
    world.pulls[0].head.sha = H1;
    world.pulls[0].draft = false;
    const res = await get('/proposals');
    expect(res.status, res.text).toBe(200);
    await lookedAt();
    // The first look after hooks were added: no flood of what was open already
    expect(await settled(rcv, 'spec.ready')).toEqual([]);
    await get('/api/forge/work');
    expect(await settled(rcv, 'spec.ready')).toEqual([]);
    // A push is a new head: waiting for review again, announced once
    const pushed = push('c', JSON.stringify({ ...proposal(), title: 'Meals, again' }));
    await get('/proposals');
    const got = await rcv.next('spec.ready');
    expect(got).toHaveLength(1);
    expect(got[0].valid).toBe(true);
    expect(got[0].headers).toMatchObject({ 'content-type': 'application/json', 'x-cornfield-event': 'spec.ready', 'x-cornfield-timestamp': AT() });
    expect(got[0].headers['x-cornfield-delivery']).toMatch(/^[0-9a-f-]{36}$/);
    expect(got[0].body).toEqual({ event: 'spec.ready', at: AT(), slug: '0040-meals', pull: 40, headSha: pushed, proposalSha256: proposalHash(world.files[`${pushed}:${BUILD_PATH}`]), actor: 'maintainer-one', mapUrl: PUBLIC });
    expect(JSON.stringify(got[0].body)).not.toContain('Meals, again');
    // Looking again changes nothing
    await get('/proposals');
    await get('/api/forge/work');
    expect(await settled(rcv, 'spec.ready')).toHaveLength(1);
  });

  it('spec.ready is never sent for a draft (a "Start a spec" stub among them), and is sent at its head once it is marked ready', async () => {
    world.pulls[0].draft = false;
    world.pulls[0].head.sha = H1;
    await get('/proposals'); // looked at (the first look may have been an earlier test's)
    await lookedAt();
    await settled(rcv, 'spec.ready');
    rcv.got.length = 0;
    // Back to a draft, and pushed to: a draft is not waiting for review
    world.pulls[0].draft = true;
    const head = push('e');
    await get('/proposals');
    await get('/api/forge/work');
    expect(await settled(rcv, 'spec.ready')).toEqual([]);
    // A draft made from the panel's Start a spec: a stub, never announced
    world.madePulls.unshift(pullOf(55, 'Spec: Planner', 'spec/0055-planner', 'c'.repeat(40), { draft: true }));
    world.changed[55] = [{ filename: 'docs/specs/proposals/0055-planner.json', status: 'added', additions: 3, deletions: 0 }];
    world.files[`${'c'.repeat(40)}:docs/specs/proposals/0055-planner.json`] = '{ "version": 1, "title": "Planner", "summary": "A stub." }\n';
    await get('/proposals');
    expect(await settled(rcv, 'spec.ready')).toEqual([]);
    // #40 marked ready, at the same head: now it is waiting for review
    world.pulls[0].draft = false;
    await get('/proposals');
    const got = await rcv.next('spec.ready');
    expect(got.map((g) => [g.body.pull, g.body.headSha])).toEqual([[40, head]]);
  });

  it('spec.ready is not sent twice across a restart on the same data folder', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-hooks-restart-'));
    const mine = await receiver();
    const cfg = { ...config, dataDir: dir, hooks: hooksFor(mine.url) };
    world.pulls[0].draft = false;
    world.pulls[0].head.sha = H1;
    try {
      let one = await start(cfg);
      let c = await signedIn(one.port, 'c-maint');
      await get('/proposals', { port: one.port, as: c }); // the first look: recorded, not announced
      await lookedAt(dir);
      expect(await settled(mine, 'spec.ready')).toEqual([]);
      const first = push('8');
      await get('/proposals', { port: one.port, as: c });
      expect((await mine.next('spec.ready')).map((g) => g.body.headSha)).toEqual([first]);
      await one.close();
      one = await start(cfg); // a restart: nothing in memory, the same db
      c = await signedIn(one.port, 'c-maint');
      await get('/proposals', { port: one.port, as: c });
      await get('/api/forge/work', { port: one.port, as: c });
      expect(await settled(mine, 'spec.ready')).toHaveLength(1);
      // a push after the restart is still news
      const pushed = push('9');
      await get('/proposals', { port: one.port, as: c });
      expect((await mine.next('spec.ready', 2)).map((g) => g.body.headSha)).toEqual([first, pushed]);
      await one.close();
    } finally {
      await mine.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('spec.ready with nobody at the dashboard: the poll alone makes the silent first look, announces a push once, and close() stops it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-hooks-poll-'));
    const mine = await receiver();
    const poll = handTimer();
    // the count below is of the spec PRs' listings, so the look for requests written by hand (which lists open pull requests too) is off
    const cfg = { ...config, dataDir: dir, hooks: [{ url: mine.url, events: ['spec.ready'] }], hookPoll: { specs: '2m' }, agents: { ...config.agents, handWritten: false } };
    world.pulls[0].draft = false;
    world.pulls[0].head.sha = H1;
    const listed = () => fake.requests.filter((r) => r.method === 'GET' && r.url.startsWith(`${GH}/pulls?`)).length;
    try {
      const one = await start(cfg, { specPollTimer: poll });
      expect(poll.waiting).toEqual([15_000]);
      expect(poll.unrefd).toBe(true);
      await signedIn(one.port, 'c-maint'); // a maintainer signed in once, and never opens the dashboard
      expect(listed()).toBe(0);
      // The first look is the poll's: it records what is open and announces nothing
      poll.fire();
      await until(() => poll.waiting.length === 1, 'the first look to finish');
      expect(poll.waiting).toEqual([120_000]);
      expect(listed()).toBe(1);
      await lookedAt(dir);
      expect(await settled(mine, 'spec.ready')).toEqual([]);
      // A push, and the next tick: announced, by the poll alone
      const pushed = push('5');
      poll.fire();
      const got = await mine.next('spec.ready');
      expect(got.map((g) => [g.valid, g.body.slug, g.body.pull, g.body.headSha])).toEqual([[true, '0040-meals', 40, pushed]]);
      await until(() => poll.waiting.length === 1, 'the second look to finish');
      expect(listed()).toBe(2);
      // Nothing new: the next tick sends nothing
      poll.fire();
      await until(() => poll.waiting.length === 1, 'the third look to finish');
      expect(await settled(mine, 'spec.ready')).toHaveLength(1);
      // close() while a look is in flight (the forge holds its permission answer until after it): nothing is listed with
      // the token after it, nothing is announced, and nothing is left waiting
      push('6');
      const before = listed();
      let release = () => {};
      const held = new Promise((r) => { release = () => r(undefined); });
      let asked = false;
      state.override[`GET ${GH}`] = async () => { asked = true; await held; return base['GET /repos/owner/name']; };
      poll.fire();
      await until(() => asked, 'the in-flight look to ask the forge');
      await one.close();
      release();
      expect(await settled(mine, 'spec.ready')).toHaveLength(1);
      expect(listed()).toBe(before);
      expect(poll.waiting).toEqual([]);
    } finally {
      await mine.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('spec.approved: once, after the review comment is posted, with the note, the edits and who acted', async () => {
    allowWrites();
    const edits = [{ op: 'remove-edge', from: 'a', to: 'b' }];
    const res = await post(REVIEW, { verdict: 'approved', note: 'Looks right.', edits }, { method: 'PUT' });
    expect(res.status, res.text).toBe(200);
    const got = await rcv.next('spec.approved');
    expect(got).toHaveLength(1);
    expect(got[0].valid).toBe(true);
    expect(got[0].body).toEqual({ event: 'spec.approved', at: AT(), slug: '0040-meals', pull: 40, headSha: H1, proposalSha256: proposalHash(text()), actor: 'maintainer-one', note: 'Looks right.', edits, mapUrl: PUBLIC });
    expect(rcv.of('spec.sentBack')).toHaveLength(0);
    expect(wrote().map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${GH}/issues/40/comments`]);
    expect(rows('hook').filter((r) => r.request.event === 'spec.approved' && r.answer.ok)).toHaveLength(1);
  });

  it('spec.sentBack: once, with the note', async () => {
    allowWrites();
    const res = await post(REVIEW, { verdict: 'notes', note: 'Drop the cache.', edits: [] }, { method: 'PUT' });
    expect(res.status, res.text).toBe(200);
    const got = await rcv.next('spec.sentBack');
    expect(got).toHaveLength(1);
    expect(got[0].valid).toBe(true);
    expect(got[0].body).toEqual({ event: 'spec.sentBack', at: AT(), slug: '0040-meals', pull: 40, headSha: H1, proposalSha256: proposalHash(text()), actor: 'maintainer-one', note: 'Drop the cache.', edits: [], mapUrl: PUBLIC });
    expect(rcv.of('spec.approved')).toHaveLength(0);
  });

  it('build.opened: once, when the issue is made, and not when a second ask only finds it', async () => {
    const plan = await buildPlan();
    const res = await post(BUILD, { slug: '0040-meals', sha: H1, digest: plan.digest });
    expect(res.status, res.text).toBe(201);
    const got = await rcv.next('build.opened');
    expect(got).toHaveLength(1);
    expect(got[0].valid).toBe(true);
    expect(got[0].body).toEqual({ event: 'build.opened', at: AT(), slug: '0040-meals', pull: 40, headSha: H1, proposalSha256: proposalHash(text()), actor: 'maintainer-one', mapUrl: PUBLIC });
    clock += 120_000;
    const second = await post(BUILD, { slug: '0040-meals', sha: H1, digest: (await buildPlan()).digest });
    expect(second.json).toMatchObject({ created: false });
    expect(await rcv.next('build.opened')).toHaveLength(1);
  });

  it('pr.landed: once, with the spec PR\'s slug and hash, and a null slug for a pull request that is not a spec', async () => {
    allowWrites();
    const spec = await post('/api/forge/pulls/40/merge', { sha: H1 });
    expect(spec.status, spec.text).toBe(200);
    const got = await rcv.next('pr.landed');
    expect(got).toHaveLength(1);
    expect(got[0].valid).toBe(true);
    expect(got[0].body).toEqual({ event: 'pr.landed', at: AT(), slug: '0040-meals', pull: 40, headSha: H1, proposalSha256: proposalHash(text()), actor: 'maintainer-one', mapUrl: PUBLIC });
    clock += 120_000;
    const plain = await post('/api/forge/pulls/41/merge', { sha: 'd'.repeat(40) });
    expect(plain.status, plain.text).toBe(200);
    const two = await rcv.next('pr.landed', 2);
    expect(two).toHaveLength(2);
    expect(two[1].body).toEqual({ event: 'pr.landed', at: AT(), slug: null, pull: 41, headSha: 'd'.repeat(40), proposalSha256: null, actor: 'maintainer-one', mapUrl: PUBLIC });
  });

  it('sends nothing for an action that failed', async () => {
    allowWrites();
    const before = rows('hook').length;
    // a review the forge refuses
    state.override[`POST ${GH}/issues/40/comments`] = () => ({ status: 403, body: { message: 'Resource not accessible' } });
    expect((await post(REVIEW, { verdict: 'approved', note: '', edits: [] }, { method: 'PUT' })).status).toBeGreaterThanOrEqual(400);
    // a review that is not valid, and a proposal that is not there (past the repeat limit on the same proposal's review)
    clock += 10_000;
    expect((await post(REVIEW, { verdict: 'notes' }, { method: 'PUT' })).status).toBe(400);
    expect((await post('/proposals/0099-none/review?source=pull%2F40', { verdict: 'approved' }, { method: 'PUT' })).status).toBe(404);
    // a build issue from a plan that is not the one shown
    expect((await post(BUILD, { slug: '0040-meals', sha: H1, digest: 'f'.repeat(32) })).status).toBe(409);
    // landing: not green, and a head that moved
    state.override[`GET ${GH}/commits/${H1}/check-runs?per_page=100`] = () => ({ body: { check_runs: [] } });
    expect((await post('/api/forge/pulls/40/merge', { sha: H1 })).status).toBe(409);
    expect((await post('/api/forge/pulls/41/merge', { sha: 'e'.repeat(40) })).status).toBe(409);
    await settle();
    expect(rcv.got).toEqual([]);
    expect(rows('hook')).toHaveLength(before);
  });

  it('a dead URL changes nothing: the second hook refuses connections, and every action still answers success', async () => {
    allowWrites();
    const firstRow = Math.max(0, ...rows('hook').map((r) => r.id));
    const plan = await buildPlan();
    expect((await post(BUILD, { slug: '0040-meals', sha: H1, digest: plan.digest })).status).toBe(201);
    expect((await post(REVIEW, { verdict: 'approved', note: '', edits: [] }, { method: 'PUT' })).status).toBe(200);
    clock += 120_000;
    expect((await post('/api/forge/pulls/40/merge', { sha: H1 })).status).toBe(200);
    await rcv.next('pr.landed');
    await settle();
    expect(rcv.got.map((g) => g.body.event).sort()).toEqual(['build.opened', 'pr.landed', 'spec.approved']);
    const dead = rows('hook').filter((r) => r.request.origin === new URL(deadUrl).origin && r.id > firstRow);
    expect(dead).toHaveLength(3);
    for (const r of dead) expect(r).toMatchObject({ login: 'cornfield', status: null, answer: { ok: false, reason: 'ECONNREFUSED', retryInMs: 1000 }, request: { attempt: 1 } });
    // the forge saw exactly the writes of the three actions, and the actions' own audit rows are as they are without hooks
    expect(wrote().map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${GH}/issues`, `POST ${GH}/issues/40/comments`, `PUT ${GH}/pulls/40/merge`]);
    expect(rows('merge').at(-1)).toMatchObject({ status: 200, answer: { ok: true, merged: true } });
    expect(rows('review').at(-1)).toMatchObject({ status: 201 });
    expect(rows('build').at(-1)).toMatchObject({ status: 201 });
  });

  it('a receiver that refuses the signature changes nothing either: its 401 is written down, the action is as it was', async () => {
    allowWrites();
    const bad = await receiver();
    const wrongKey = await start({ ...config, hooks: hooksFor(bad.url) }, { env: { ...ENV, CORNFIELD_HOOK_SECRET: 'another-secret-'.padEnd(40, 'q') } });
    try {
      const c = await signedIn(wrongKey.port, 'c-maint');
      const res = await post(REVIEW, { verdict: 'approved', note: '', edits: [] }, { method: 'PUT', port: wrongKey.port, as: c });
      expect(res.status, res.text).toBe(200);
      const got = await bad.next('spec.approved');
      expect(got).toHaveLength(1);
      expect(got[0].valid).toBe(false); // signed with another key than the receiver's
      await settle();
      const mine = rows('hook').filter((r) => r.request.origin === new URL(bad.url).origin);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ status: 401, answer: { ok: false, reason: 'status', retryInMs: 1000 } });
      expect(wrote().map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${GH}/issues/40/comments`]);
    } finally {
      await wrongKey.close();
      await bad.close();
    }
  });

  it('a fetch that throws changes nothing', async () => {
    allowWrites();
    const throwing = await start(config, { hookFetch: () => { throw new Error('no network'); } });
    try {
      const c = await signedIn(throwing.port, 'c-maint');
      const res = await post(REVIEW, { verdict: 'notes', note: 'No.', edits: [] }, { method: 'PUT', port: throwing.port, as: c });
      expect(res.status, res.text).toBe(200);
      expect(res.json).toMatchObject({ slug: '0040-meals', verdict: 'notes' });
      await settle();
      expect(rcv.got).toEqual([]);
    } finally {
      await throwing.close();
    }
  });

  describe('opt-in triggers (agents.on, server/triggers.js), through the real routes', () => {
    const NO_HOOKS = { ...ENV, CORNFIELD_HOOK_SECRET: undefined };
    const triggered = (on, extra = {}) => ({ ...config, hooks: [], agents: { ...config.agents, profiles: ['claude'], on }, ...extra });
    /** The request comments the forge was sent, parsed */
    const requestsPosted = () => wrote().filter((r) => r.method === 'POST' && /\/issues\/\d+\/comments$/.test(r.url)).map((r) => ({ url: r.url, body: JSON.parse(r.body).body }));
    const blockOf = (text) => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));

    it('approving a spec with a trigger set requests ONE run, posted as the approver on the spec PR; no hook is configured and none is needed', async () => {
      allowWrites();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-trig-'));
      // With no hook configured the hooks object only carries the moments; its secret is a random one that signs nothing
      const delivered = [];
      const one = await start(triggered({ 'spec.approved': { kind: 'code', profile: 'claude' } }, { dataDir: dir }), { env: NO_HOOKS, hookFetch: async (url) => { delivered.push(url); return new Response(null, { status: 200 }); } });
      try {
        const c = await signedIn(one.port, 'c-maint');
        const res = await post(REVIEW, { verdict: 'approved', note: '', edits: [] }, { method: 'PUT', port: one.port, as: c });
        expect(res.status, res.text).toBe(200);
        await until(() => requestsPosted().length >= 2, 'the trigger to post its request');
        await settle();
        const [review, ask] = requestsPosted();
        expect(review.url).toBe(`${GH}/issues/40/comments`);
        expect(ask.url).toBe(`${GH}/issues/40/comments`);
        const req = blockOf(ask.body);
        expect(req).toMatchObject({ kind: 'code', profile: 'claude', refs: { proposal: '0040-meals', pull: 40 }, requestedBy: 'maintainer-one', trigger: { event: 'spec.approved', by: 'maintainer-one', ref: 'pull:40' } });
        // the forge saw it posted with the approver's own token
        const posted = wrote().filter((r) => r.method === 'POST' && r.url.endsWith('/issues/40/comments'));
        expect(posted).toHaveLength(2);
        for (const r of posted) expect(r.headers.authorization).toBe(`Bearer ${MAINT}`);
        const db = new DatabaseSync(path.join(dir, 'cornfield.db'));
        const runs = db.prepare('SELECT run_id, via, requested_by FROM runs').all();
        db.close();
        expect(runs).toEqual([{ run_id: req.runId, via: 'trigger', requested_by: 'maintainer-one' }]);
        // the Agents tab's list says so
        const list = await get('/api/agent-runs', { port: one.port, as: c });
        expect(list.json.runs.map((r) => [r.runId, r.via, r.requestedBy])).toEqual([[req.runId, 'trigger', 'maintainer-one']]);
        // a second approval does not ask again
        clock += 120_000;
        await post(REVIEW, { verdict: 'approved', note: '', edits: [] }, { method: 'PUT', port: one.port, as: c });
        await settle();
        expect(requestsPosted().filter((r) => r.body.includes('"kind": "code"'))).toHaveLength(1);
        // spec.approved, agent.requested and the rest were all emitted, and not one delivery was made or signed
        expect(delivered).toEqual([]);
        const audit = new DatabaseSync(path.join(dir, 'cornfield.db'));
        const hookRows = audit.prepare("SELECT COUNT(*) AS n FROM actions WHERE action = 'hook'").get();
        audit.close();
        expect(hookRows.n).toBe(0);
      } finally {
        await one.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('with no trigger set, approving a spec requests nothing', async () => {
      allowWrites();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-trig-'));
      const one = await start(triggered({}, { dataDir: dir }), { env: NO_HOOKS });
      try {
        const c = await signedIn(one.port, 'c-maint');
        expect((await post(REVIEW, { verdict: 'approved', note: '', edits: [] }, { method: 'PUT', port: one.port, as: c })).status).toBe(200);
        await settle();
        expect(requestsPosted()).toHaveLength(1); // the review itself
      } finally {
        await one.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('opening the build issue with a trigger set requests ONE run about that issue, as the maintainer who opened it', async () => {
      allowWrites();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-trig-'));
      state.override[`GET ${GH}/issues/60`] = () => ({ body: issue(60, 'Build 0040', { body: 'x' }) });
      state.override[`POST ${GH}/issues/60/comments`] = (req) => ({ status: 201, body: comment(9600, 'maintainer-one', JSON.parse(req.body).body) });
      const one = await start(triggered({ 'build.opened': { kind: 'code', profile: 'claude' } }, { dataDir: dir }), { env: NO_HOOKS });
      try {
        const c = await signedIn(one.port, 'c-maint');
        const plan = (await get(`${BUILD}?slug=0040-meals`, { port: one.port, as: c })).json.plan;
        const res = await post(BUILD, { slug: '0040-meals', sha: H1, digest: plan.digest }, { port: one.port, as: c });
        expect(res.status, res.text).toBe(201);
        await until(() => requestsPosted().length >= 1, 'the trigger to post its request');
        await settle();
        const [ask] = requestsPosted();
        expect(ask.url).toBe(`${GH}/issues/60/comments`);
        expect(blockOf(ask.body)).toMatchObject({ kind: 'code', refs: { issue: 60 }, requestedBy: 'maintainer-one', trigger: { event: 'build.opened', by: 'maintainer-one', ref: 'issue:60' } });
        expect(requestsPosted()).toHaveLength(1);
      } finally {
        await one.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('/agent in a thread, found by the poll: a maintainer\'s requests (once, across a restart); a non-maintainer\'s and an edited one do nothing', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-trig-'));
      const poll = handTimer();
      const cfg = triggered({ 'thread.message': { kind: 'summary', profile: 'claude' } }, { dataDir: dir, hookPoll: { specs: '2m' } });
      const labelled = { name: 'idea' };
      world.issues[7] = issue(7, 'Meals page', { labels: [labelled] });
      state.override[`POST ${GH}/issues/7/comments`] = (req) => ({ status: 201, body: comment(9700, 'maintainer-one', JSON.parse(req.body).body) });
      state.override[`GET ${GH}/collaborators/reader-two/permission`] = () => ({ body: { permission: 'read', role_name: 'read' } });
      const lookAgain = async (srv_, timer) => { timer.fire(); await until(() => timer.waiting.length === 1, 'the look to finish'); await settle(); };
      let one = await start(cfg, { specPollTimer: poll, env: NO_HOOKS });
      try {
        await signedIn(one.port, 'c-maint');
        expect(poll.waiting).toEqual([15_000]);
        await lookAgain(one, poll); // the first look records what is there and fires nothing
        world.comments[7] = [
          comment(801, 'reader-two', '/agent do the thing', '2026-11-03T09:31:00Z'),
          comment(802, 'maintainer-one', '/agent sneaky', '2026-11-03T09:31:00Z', '2026-11-03T09:40:00Z'),
          comment(803, 'maintainer-one', 'Use `/agent` to ask.\n```\n/agent no\n```', '2026-11-03T09:31:00Z'),
        ];
        world.issues[7] = issue(7, 'Meals page', { labels: [labelled], comments: 3, updated_at: '2026-11-03T09:41:00Z' });
        clock += 120_000;
        await lookAgain(one, poll);
        expect(requestsPosted()).toEqual([]);
        // a maintainer's own command
        world.comments[7].push(comment(804, 'maintainer-one', '/agent summarise the thread', '2026-11-03T09:42:00Z'));
        world.issues[7] = issue(7, 'Meals page', { labels: [labelled], comments: 4, updated_at: '2026-11-03T09:43:00Z' });
        clock += 120_000;
        await lookAgain(one, poll);
        await until(() => requestsPosted().length >= 1, 'the trigger to post its request');
        expect(requestsPosted()).toHaveLength(1);
        const [ask] = requestsPosted();
        expect(ask.url).toBe(`${GH}/issues/7/comments`);
        expect(blockOf(ask.body)).toMatchObject({ kind: 'summary', refs: { thread: 7 }, brief: 'summarise the thread', requestedBy: 'maintainer-one', trigger: { event: 'thread.message', by: 'maintainer-one', ref: 'comment:804' } });
        // a restart on the same data folder looks at the same comments again and asks for nothing
        await one.close();
        one = null;
        const again = handTimer();
        const restarted = await start(cfg, { specPollTimer: again, env: NO_HOOKS });
        try {
          clock += 120_000;
          await lookAgain(restarted, again);
          await lookAgain(restarted, again);
          expect(requestsPosted()).toHaveLength(1);
        } finally {
          await restarted.close();
        }
      } finally {
        await one?.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('refuses to start with agents.on and no sign-in', () => {
      expect(() => createCornfieldServer(triggered({ 'spec.approved': { kind: 'code', profile: 'claude' } }), { env: {} })).toThrow(/agents\.on, but sign-in is not set up/);
    });
  });

  it('is off without hooks: no secret is asked for and nothing is sent', async () => {
    allowWrites();
    const none = await start({ ...config, hooks: [] }, { env: { ...ENV, CORNFIELD_HOOK_SECRET: undefined } });
    try {
      const c = await signedIn(none.port, 'c-maint');
      const res = await post(REVIEW, { verdict: 'approved', note: '', edits: [] }, { method: 'PUT', port: none.port, as: c });
      expect(res.status, res.text).toBe(200);
      await settle();
      expect(rcv.got).toEqual([]);
    } finally {
      await none.close();
    }
  });

  it('refuses to start with hooks and no secret, a short one, or no sign-in', () => {
    const hooks = hooksFor('https://chat.example.org/h');
    expect(() => createCornfieldServer({ ...config, hooks }, { env: { ...ENV, CORNFIELD_HOOK_SECRET: undefined } })).toThrow(/CORNFIELD_HOOK_SECRET is needed/);
    expect(() => createCornfieldServer({ ...config, hooks }, { env: { ...ENV, CORNFIELD_HOOK_SECRET: 'short' } })).toThrow(/too short/);
    expect(() => createCornfieldServer({ ...config, hooks }, { env: { CORNFIELD_HOOK_SECRET: HOOK_SECRET } })).toThrow(/sign-in/);
  });

  it('keeps the hooks out of what the browser is told', async () => {
    const res = await get('/cornfield/config.json');
    expect(res.text).not.toContain('cornfield-hook');
    expect(res.text).not.toContain(HOOK_SECRET);
  });
});
