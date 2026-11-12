/**
 * @vitest-environment node
 *
 * Landing on approval (PIPE-09, server/lander.js, spec 0003), from the outside: a running server with
 * `proposals: { approveLands: true }`, a fake GitHub on loopback that holds one open spec PR, its checks and its merge, and a
 * clock the test winds by hand (`landTimer`, `now`). Held here:
 *
 *   - key off: an approval posts the review and nothing else; no landing, no look at the checks
 *   - key on, green: the approval lands the PR with the approved sha pinned and no second click, through Land it's merge
 *     (the `merge` row, the `pr.landed` hook), and posts no comment of its own
 *   - checks still running: it waits, and lands at the look after they pass
 *   - a red check: left open, one comment (mentions defused) and an audit row; nothing merged
 *   - a push after the approval: cancelled, one comment, nothing merged; closed or merged elsewhere: done, silent
 *   - a send-back never lands; an approval through the review API lands like the button's
 *   - the approver signs out: left open, "sign in to land", no comment, nothing merged
 *   - a restart picks a pending landing up from the data folder; one past its time is dropped
 *   - the time running out leaves it open; a maintainer can cancel it from the page (same origin only)
 * No real forge, app or token.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error plain JS module, no declarations
import { createCornfieldServer } from '../../server/server.js';
// @ts-expect-error plain JS module, no declarations
import { loadConfig } from '../../core/config.js';
// @ts-expect-error plain JS module, no declarations
import { TIMEOUT_MS } from '../../server/lander.js';
// @ts-expect-error plain JS module, no declarations
import { ZW } from '../../server/defuse.js';
import { SAMPLE } from '../helpers.js';
import { fakeForge, recordings } from './fake-forge.js';

const SESSION_SECRET = 'x'.repeat(40);
const HOOK_SECRET = 'h'.repeat(40);
const ENV = { CORNFIELD_GITHUB_CLIENT_ID: 'test-client-id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: SESSION_SECRET, CORNFIELD_HOOK_SECRET: HOOK_SECRET };
const PUBLIC = 'http://127.0.0.1:3350';
const MAINT = 'tok-maint';
const MAINT2 = 'tok-maint-two';
const API = '/api/v3';
const GH = `${API}/repos/owner/name`;
const SLUG = '0040-meals';
const PATH = `docs/specs/proposals/${SLUG}.json`;
const HEAD = `${'a'.repeat(39)}1`;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const proposalOf = (title) => `${JSON.stringify({ version: 1, title, summary: 'Plan the week.', nodes: { add: [{ id: 'page-meals', label: '/meals', type: 'page', parent: 'app-a' }] } }, null, 2)}\n`;

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

async function signedIn(port, code) {
  const started = await raw(port, 'GET', '/auth/start');
  const to = new URL(started.headers.location);
  const stateCookie = started.headers['set-cookie'].find((c) => c.startsWith('cornfield-oauth=')).split(';')[0];
  const back = await raw(port, 'GET', `/auth/callback?code=${code}&state=${to.searchParams.get('state')}`, { headers: { cookie: stateCookie } });
  expect(back.status, back.text).toBe(303);
  return back.headers['set-cookie'].find((c) => c.startsWith('cornfield=')).split(';')[0];
}

/** A clock the test winds: the lander's timers are kept, and `fire` runs the ones that are waiting */
function fakeTimer() {
  const all = [];
  return {
    setTimeout: (fn, ms) => { const t = { fn, ms, done: false }; all.push(t); return t; },
    clearTimeout: (t) => { if (t) t.done = true; },
    waiting: () => all.filter((t) => !t.done),
    fire: () => { const due = all.filter((t) => !t.done); for (const t of due) { t.done = true; t.fn(); } return due.length; },
  };
}

const until = async (what, fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};
/** Long enough for a look that is going to do something to have done it */
const settle = () => new Promise((r) => setTimeout(r, 120));

describe('landing on approval', () => {
  let fake;
  let data;
  let srv;
  let cookie;
  let config;
  let timer;
  let hookCalls;
  let clock = Date.parse('2026-11-03T09:00:00Z');
  /** What the fake GitHub holds */
  let world;
  const base = recordings('github');

  const dispatch = (key, req) => {
    const [method, target] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
    const auth = req.headers.authorization;
    if (key === 'POST /login/oauth/access_token') return { body: { access_token: req.body.includes('c-maint2') ? MAINT2 : MAINT, token_type: 'bearer' } };
    if (key === 'DELETE /api/v3/applications/test-client-id/token') return { status: 204 };
    if (key === `GET ${API}/user`) return auth === `Bearer ${MAINT2}` ? { body: { login: 'maintainer-two', id: 1003 } } : base['GET /user'];
    if (key === `GET ${GH}`) return { body: { id: 1, full_name: 'owner/name', permissions: { admin: false, maintain: !world.demoted, push: true, triage: true, pull: true } } };
    if (!target.startsWith(GH)) return { status: 404, body: { message: 'Not Found' } };
    const url = new URL(target.slice(GH.length), 'http://x');
    const p = decodeURIComponent(url.pathname);
    let m;
    if (method === 'GET' && (m = /^\/collaborators\/([^/]+)\/permission$/.exec(p))) {
      const maintains = (m[1] === 'maintainer-one' || m[1] === 'maintainer-two') && !world.demoted;
      return { body: { permission: maintains ? 'write' : 'read', role_name: maintains ? 'maintain' : 'read', user: { login: m[1] } } };
    }
    world.asked.push(`${method} ${p}`);
    if (world.down && /\/check-runs$/.test(p)) return { status: 503, body: { message: 'Service Unavailable' } };
    if (method === 'GET' && p === '/pulls/40') return { body: { ...world.pull, mergeable_state: world.mergeState } };
    // The open pull requests (a trigger's request looks for the proposal's spec PR here); `listGate` holds the answer until it resolves
    if (method === 'GET' && p === '/pulls' && url.searchParams.get('state') === 'open') {
      const answer = () => ({ body: world.pull.state === 'open' ? [world.pull] : [] });
      if (world.listGate) { const gate = world.listGate; world.listGate = null; return gate.then(answer); }
      return answer();
    }
    if (method === 'GET' && p === '/pulls/40/commits') return { body: [] };
    if (method === 'GET' && p === '/pulls/40/files') return { body: [PATH, ...Object.keys(world.others)].map((filename) => ({ filename, status: 'modified', additions: 1, deletions: 0, changes: 1 })) };
    if (method === 'GET' && p === '/issues/40/comments') return { body: world.comments };
    if (method === 'POST' && p === '/issues/40/comments') {
      const text = JSON.parse(req.body).body;
      world.posted.push({ as: auth, body: text });
      const c = { id: 9100 + world.comments.length, user: { login: 'maintainer-one', html_url: 'https://github.example.com/maintainer-one' }, body: text, html_url: `https://github.example.com/owner/name/pull/40#issuecomment-${9100 + world.comments.length}`, created_at: new Date(clock).toISOString(), updated_at: new Date(clock).toISOString() };
      world.comments.push(c);
      return { status: 201, body: c };
    }
    if (method === 'GET' && p.startsWith('/contents/')) {
      const at = p.slice('/contents/'.length);
      const text = url.searchParams.get('ref') !== HEAD ? undefined : at === PATH ? world.text : world.others[at];
      return text === undefined ? { status: 404, body: { message: 'Not Found' } } : { headers: { 'content-type': 'application/vnd.github.raw; charset=utf-8' }, body: text };
    }
    if (method === 'GET' && /^\/commits\/[0-9a-f]+\/check-runs$/.test(p)) {
      if (world.gate) { const gate = world.gate; world.gate = null; return gate.then(() => ({ body: { check_runs: world.checks } })); }
      return { body: { check_runs: world.checks } };
    }
    if (method === 'GET' && /^\/commits\/[0-9a-f]+\/status$/.test(p)) return { body: { statuses: [] } };
    if (method === 'GET' && p === '/actions/runs') return { body: { workflow_runs: [] } };
    if (method === 'PUT' && p === '/pulls/40/merge') {
      world.merges.push(JSON.parse(req.body));
      world.pull.state = 'closed';
      world.pull.merged_at = new Date(clock).toISOString();
      return { body: { sha: 'f'.repeat(40), merged: true } };
    }
    return { status: 404, body: { message: 'Not Found' } };
  };
  const routes = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? (req) => dispatch(key, req) : undefined) });

  const check = (name, status, conclusion) => ({ id: name.length + 100, name, status, conclusion, html_url: `https://ci.example.test/${encodeURIComponent(name)}` });
  const freshWorld = () => ({
    pull: { number: 40, title: 'Meals spec', state: 'open', draft: false, user: { login: 'agent-four', html_url: 'https://github.example.com/agent-four' }, labels: [], head: { ref: 'spec/meals', sha: HEAD }, base: { ref: 'main' }, html_url: 'https://github.example.com/owner/name/pull/40', created_at: '2026-11-03T08:00:00Z', updated_at: '2026-11-03T08:30:00Z', merged_at: null },
    mergeState: 'clean',
    text: proposalOf('Meals'),
    comments: [],
    posted: [],
    merges: [],
    asked: [],
    checks: [check('test', 'completed', 'success')],
    demoted: false,
    /** More proposal files the PR holds at HEAD, by path */
    others: {},
  });

  const start = async (cfg, opts) => {
    const server = createCornfieldServer(cfg, { env: ENV, now: () => clock, landTimer: timer, hookFetch: async (url, init) => { hookCalls.push(JSON.parse(init.body)); return new Response('ok', { status: 200 }); }, ...opts });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    return { port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
  };

  beforeAll(async () => { fake = await fakeForge(routes); });
  afterAll(async () => { await fake.close(); });
  /** Each test has its own data folder and server; `landing` is the config key */
  const boot = async (landing = true, { on } = {}) => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-lander-'));
    config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(config, { forge: { type: 'github', url: fake.url, repo: 'owner/name' }, publicUrl: PUBLIC, approveLands: landing, hooks: [{ url: 'https://hooks.example.test/cf', events: ['pr.landed'] }] });
    if (on) config.agents = { ...config.agents, on };
    srv = await start(config);
    cookie = await signedIn(srv.port, 'c-maint');
  };
  beforeEach(() => {
    clock += 10 * 60_000;
    world = freshWorld();
    timer = fakeTimer();
    hookCalls = [];
    fake.requests.length = 0;
  });
  afterEach(async () => {
    await srv.close();
    fs.rmSync(data, { recursive: true, force: true });
  });

  const origin = () => `http://127.0.0.1:${srv.port}`;
  const page = (method, target, body, { as = cookie, headers = {} } = {}) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    return raw(srv.port, method, target, {
      headers: { cookie: as || undefined, origin: origin(), 'sec-fetch-site': 'same-origin', ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }), ...headers },
      body: text,
    });
  };
  const REVIEW = `/proposals/${SLUG}/review?source=pull%2F40`;
  const approveByButton = async (extra = {}) => {
    const res = await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [], ...extra });
    expect(res.status, res.text).toBe(200);
    clock += 60_000;
    return res;
  };
  const db = () => new DatabaseSync(path.join(data, 'cornfield.db'), { readOnly: true });
  const query = (sql, ...args) => {
    const d = db();
    try { return d.prepare(sql).all(...args); } finally { d.close(); }
  };
  const audit = (action) => query('SELECT * FROM actions WHERE action = ? ORDER BY id', action).map((r) => ({ ...r, request: JSON.parse(String(r.request)), answer: r.answer ? JSON.parse(String(r.answer)) : null }));
  const landings = () => query('SELECT * FROM landings');
  /** The comments cornfield posted besides the review itself */
  const notes = () => world.posted.filter((c) => !c.body.includes('```cornfield-review'));
  const reviews = () => world.posted.filter((c) => c.body.includes('```cornfield-review'));
  const mint = async () => {
    const res = await page('POST', '/api/review-tokens', { label: 'chat bot' });
    expect(res.status, res.text).toBe(201);
    return res.json.secret;
  };

  describe('with the key off', () => {
    it('an approval posts the review and nothing else: no landing, no look at the checks, no merge', async () => {
      await boot(false);
      await approveByButton();
      await settle();
      expect(reviews()).toHaveLength(1);
      expect(notes()).toEqual([]);
      expect(world.merges).toEqual([]);
      expect(world.asked.filter((a) => a.includes('check-runs') || a.includes('merge'))).toEqual([]);
      expect(landings()).toEqual([]);
      expect(audit('landing')).toEqual([]);
      expect(timer.waiting()).toEqual([]);
      expect((await page('GET', '/api/forge/pulls/40/landing')).json).toMatchObject({ ok: true, enabled: false, landing: null });
      expect((await page('POST', '/api/forge/pulls/40/landing/cancel')).status).toBe(404);
    });
  });

  describe('with the key on', () => {
    it('lands a green spec PR at the approved sha with no second click, as Land it does, and posts no comment of its own', async () => {
      await boot();
      await approveByButton();
      await until('the merge', () => world.merges.length === 1);
      expect(world.merges).toEqual([{ sha: HEAD, merge_method: 'merge' }]);
      await until('the landing to be marked', () => landings()[0]?.state === 'landed');
      expect(landings()).toEqual([expect.objectContaining({ repo: 'owner/name', pull: 40, slug: SLUG, sha: HEAD, user_id: '1001', login: 'maintainer-one', state: 'landed' })]);
      expect(notes()).toEqual([]);
      expect(reviews()).toHaveLength(1);
      // the merge is Land it's row, saying it came from an approval; the start is a landing row
      await until('the merge row', () => audit('merge').length === 1);
      expect(audit('merge')[0]).toMatchObject({ login: 'maintainer-one', target: 'owner/name#40', status: 200, request: { action: 'merge', number: 40, sha: HEAD, method: 'merge', via: 'approval', slug: SLUG }, answer: { ok: true, merged: true, sha: 'f'.repeat(40), head: HEAD } });
      expect(audit('landing').map((r) => r.request.state)).toEqual(['pending']);
      // the same hook Land it fires
      await until('pr.landed', () => hookCalls.some((h) => h.event === 'pr.landed'));
      expect(hookCalls.find((h) => h.event === 'pr.landed')).toMatchObject({ pull: 40, headSha: HEAD, actor: 'maintainer-one', slug: SLUG });
      // and the merge was asked with the approver's own token
      expect(fake.requests.filter((r) => r.method === 'PUT' && r.url.endsWith('/merge')).map((r) => r.headers.authorization)).toEqual([`Bearer ${MAINT}`]);
      expect(timer.waiting()).toEqual([]);
    });

    it('the review response does not wait for the landing: the checks are held, the response is not', async () => {
      await boot();
      let release;
      world.gate = new Promise((r) => { release = r; });
      const res = await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [] });
      expect(res.status, res.text).toBe(200);
      expect(reviews()).toHaveLength(1);
      expect(world.merges).toEqual([]);
      release();
      await until('the merge', () => world.merges.length === 1);
    });

    it('a landing that cannot even look (the forge is down) never fails the review, and keeps waiting', async () => {
      await boot();
      world.down = true;
      const res = await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [] });
      expect(res.status, res.text).toBe(200);
      await until('waiting', () => timer.waiting().length === 1);
      expect(world.merges).toEqual([]);
      expect(landings()[0].state).toBe('pending');
      world.down = false;
      timer.fire();
      await until('the merge', () => world.merges.length === 1);
    });

    it('does not land a PR that holds several proposals until every one is approved at its current hash, and says nothing meanwhile', async () => {
      const OTHER = '0041-planner';
      world.others = { [`docs/specs/proposals/${OTHER}.json`]: proposalOf('Planner') };
      await boot();
      await approveByButton(); // 0040 only
      await settle();
      expect(world.merges).toEqual([]);
      expect(notes()).toEqual([]);
      expect(landings()).toEqual([]); // not started: another proposal of the PR is not approved
      expect(timer.waiting()).toEqual([]);
      // the other one approved too: that approval starts the landing, and it lands
      const res = await page('PUT', `/proposals/${OTHER}/review?source=pull%2F40`, { verdict: 'approved', note: '', edits: [] });
      expect(res.status, res.text).toBe(200);
      await until('the merge', () => world.merges.length === 1);
      expect(world.merges[0].sha).toBe(HEAD);
      expect(notes()).toEqual([]);
    });

    it('a landing that started waits, and does not merge, once another proposal of the PR is no longer approved', async () => {
      const OTHER = '0041-planner';
      world.others = { [`docs/specs/proposals/${OTHER}.json`]: proposalOf('Planner') };
      world.checks = [check('test', 'in_progress', null)];
      await boot();
      await page('PUT', `/proposals/${OTHER}/review?source=pull%2F40`, { verdict: 'approved', note: '', edits: [] });
      await approveByButton(); // both approved: the landing starts, and waits for the checks
      await until('waiting', () => landings()[0]?.state === 'pending' && timer.waiting().length === 1);
      // the other proposal is sent back meanwhile, then the checks pass
      expect((await page('PUT', `/proposals/${OTHER}/review?source=pull%2F40`, { verdict: 'notes', note: 'Not yet.', edits: [] })).status).toBe(200);
      world.checks = [check('test', 'completed', 'success')];
      timer.fire();
      await until('the next look to wait', () => timer.waiting().length === 1);
      expect(world.merges).toEqual([]);
      expect(notes()).toEqual([]);
      expect(landings()[0].state).toBe('pending');
    });

    it('looks every 20 seconds for the first five minutes, then every minute', async () => {
      world.checks = [check('test', 'in_progress', null)];
      await boot();
      await approveByButton();
      await until('the first look', () => timer.waiting().length === 1);
      expect(timer.waiting()[0].ms).toBe(20_000);
      clock += 5 * 60_000;
      timer.fire();
      await until('the next look', () => timer.waiting().length === 1 && timer.waiting()[0].ms !== 20_000);
      expect(timer.waiting()[0].ms).toBe(60_000);
    });

    it('a look in flight when the server shuts down merges nothing', async () => {
      await boot();
      let release;
      world.gate = new Promise((r) => { release = r; });
      await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [] });
      await until('the look to ask for the checks', () => world.asked.some((a) => a.includes('check-runs')));
      await srv.close();
      release();
      await settle();
      expect(world.merges).toEqual([]);
      srv = await start(config); // for afterEach to close (the pending row is picked up again: the same head, green)
      await until('the resumed landing', () => world.merges.length === 1);
    });

    it('waits while checks are running, and lands at the look after they pass', async () => {
      world.checks = [check('test', 'in_progress', null)];
      await boot();
      await approveByButton();
      await until('the first look', () => world.asked.some((a) => a.includes('check-runs')) && timer.waiting().length === 1);
      expect(world.merges).toEqual([]);
      expect(landings()[0].state).toBe('pending');
      expect(timer.waiting()[0].ms).toBe(20_000);
      // still running at the next look
      expect(timer.fire()).toBe(1);
      await until('the second look', () => timer.waiting().length === 1);
      expect(world.merges).toEqual([]);
      // now they pass
      world.checks = [check('test', 'completed', 'success')];
      timer.fire();
      await until('the merge', () => world.merges.length === 1);
      expect(world.merges[0].sha).toBe(HEAD);
      await until('landed', () => landings()[0].state === 'landed');
      expect(notes()).toEqual([]);
      expect(timer.waiting()).toEqual([]);
    });

    it('waits for a draft or a PR GitHub has not finished working out, without merging', async () => {
      world.mergeState = 'unknown';
      await boot();
      await approveByButton();
      await until('the first look', () => timer.waiting().length === 1 && world.asked.includes('GET /pulls/40'));
      expect(world.merges).toEqual([]);
      world.mergeState = 'clean';
      timer.fire();
      await until('the merge', () => world.merges.length === 1);
    });

    it('leaves it open when a check is red: one comment with mentions defused, an audit row, nothing merged', async () => {
      world.checks = [check('test', 'completed', 'success'), check('lint @octocat #12', 'completed', 'failure')];
      await boot();
      await approveByButton();
      await until('the comment', () => notes().length === 1);
      await settle();
      expect(notes()).toHaveLength(1);
      const text = notes()[0].body;
      expect(text).toContain('Left open: lint');
      expect(text).toContain('failed');
      expect(text).toContain(`@${ZW}octocat`);
      expect(text).toContain(`#${ZW}12`);
      expect(text).not.toMatch(/@octocat|#12/);
      expect(notes()[0].as).toBe(`Bearer ${MAINT}`);
      expect(world.merges).toEqual([]);
      expect(landings()[0].state).toBe('left-open');
      expect(audit('landing').map((r) => [r.request.state, r.answer.why])).toEqual([['pending', 'waiting for the checks'], ['left-open', `lint @octocat #12 failed`]]);
      expect(timer.waiting()).toEqual([]);
      // it does not look again, or comment again
      expect(timer.fire()).toBe(0);
      await settle();
      expect(notes()).toHaveLength(1);
    });

    it('leaves it open when a check goes red while waiting', async () => {
      world.checks = [check('test', 'in_progress', null)];
      await boot();
      await approveByButton();
      await until('waiting', () => timer.waiting().length === 1);
      world.checks = [check('test', 'completed', 'failure')];
      timer.fire();
      await until('the comment', () => notes().length === 1);
      expect(notes()[0].body).toContain('Left open: test failed');
      expect(world.merges).toEqual([]);
    });

    it('is cancelled by a push after the approval: one comment, nothing merged, the pushed head never lands', async () => {
      world.checks = [check('test', 'in_progress', null)];
      await boot();
      await approveByButton();
      await until('waiting', () => timer.waiting().length === 1);
      const pushed = `${'b'.repeat(39)}2`;
      world.pull.head.sha = pushed;
      world.checks = [check('test', 'completed', 'success')]; // green at the new head, but it is not what was approved
      timer.fire();
      await until('the comment', () => notes().length === 1);
      expect(notes()[0].body).toContain('cancelled: a push after approval');
      expect(notes()[0].body).toContain(pushed.slice(0, 7));
      await settle();
      expect(world.merges).toEqual([]);
      expect(landings()[0].state).toBe('cancelled');
      expect(audit('landing').at(-1)).toMatchObject({ request: { state: 'cancelled', sha: HEAD, head: pushed }, answer: { state: 'cancelled', why: 'a push after approval' } });
      expect(timer.waiting()).toEqual([]);
    });

    it('is done, and says nothing, when the PR was closed or landed elsewhere', async () => {
      world.checks = [check('test', 'in_progress', null)];
      await boot();
      await approveByButton();
      await until('waiting', () => timer.waiting().length === 1);
      world.pull.state = 'closed';
      world.pull.merged_at = '2026-11-03T09:40:00Z';
      timer.fire();
      await until('done', () => landings()[0].state === 'done');
      expect(notes()).toEqual([]);
      expect(world.merges).toEqual([]);
      expect(audit('landing').at(-1)).toMatchObject({ request: { state: 'done' } });
    });

    it('never lands a send-back', async () => {
      await boot();
      const res = await page('PUT', REVIEW, { verdict: 'notes', note: 'Make it one page.', edits: [] });
      expect(res.status, res.text).toBe(200);
      await settle();
      expect(landings()).toEqual([]);
      expect(world.merges).toEqual([]);
      expect(world.asked.filter((a) => a.includes('check-runs'))).toEqual([]);
      expect(timer.waiting()).toEqual([]);
      expect(audit('landing')).toEqual([]);
    });

    it('a refused review starts nothing', async () => {
      await boot();
      const res = await page('PUT', '/proposals/0099-nothing/review?source=pull%2F40', { verdict: 'approved', note: '', edits: [] });
      expect(res.status).toBe(404);
      await settle();
      expect(landings()).toEqual([]);
      expect(world.merges).toEqual([]);
    });

    it('an approval through the review API lands too, as the token\'s owner', async () => {
      await boot();
      const secret = await mint();
      const text = JSON.stringify({ pull: 40, slug: SLUG, sha256: sha256(world.text), verdict: 'approved', note: 'Ship it.' });
      const res = await raw(srv.port, 'POST', '/api/reviews', { headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }, body: text });
      expect(res.status, res.text).toBe(200);
      await until('the merge', () => world.merges.length === 1);
      expect(world.merges[0]).toEqual({ sha: HEAD, merge_method: 'merge' });
      expect(fake.requests.filter((r) => r.method === 'PUT' && r.url.endsWith('/merge')).map((r) => r.headers.authorization)).toEqual([`Bearer ${MAINT}`]);
      expect(landings()[0]).toMatchObject({ login: 'maintainer-one', user_id: '1001' });
    });

    it('uses the repo\'s merge method', async () => {
      await boot();
      await srv.close();
      config.forge.mergeMethod = 'squash';
      srv = await start(config);
      cookie = await signedIn(srv.port, 'c-maint');
      await approveByButton();
      await until('the merge', () => world.merges.length === 1);
      expect(world.merges[0]).toEqual({ sha: HEAD, merge_method: 'squash' });
    });

    it('is left open, with "sign in to land" and nothing else, when the approver\'s session ends before the checks finish', async () => {
      world.checks = [check('test', 'in_progress', null)];
      await boot();
      await approveByButton();
      await until('waiting', () => timer.waiting().length === 1);
      const out = await page('POST', '/auth/sign-out');
      expect([200, 302, 303]).toContain(out.status);
      world.checks = [check('test', 'completed', 'success')];
      timer.fire();
      await until('left open', () => landings()[0].state === 'left-open');
      await settle();
      expect(world.merges).toEqual([]);
      expect(notes()).toEqual([]); // there is no token to comment with
      expect(audit('landing').at(-1)).toMatchObject({ login: 'maintainer-one', request: { state: 'left-open' }, answer: { state: 'left-open', why: 'sign in to land' } });
      expect(timer.waiting()).toEqual([]);
    });

    it('is left open when the approver is no longer a maintainer at the moment it would land', async () => {
      world.checks = [check('test', 'in_progress', null)];
      await boot();
      await approveByButton();
      await until('waiting', () => timer.waiting().length === 1);
      world.checks = [check('test', 'completed', 'success')];
      world.demoted = true;
      timer.fire();
      await until('the comment', () => notes().length === 1);
      expect(notes()[0].body).toContain('is not a maintainer of the repo now');
      expect(world.merges).toEqual([]);
    });

    it('is left open when the time is up, with a comment', async () => {
      world.checks = [check('test', 'in_progress', null)];
      await boot();
      await approveByButton();
      await until('waiting', () => timer.waiting().length === 1);
      clock += TIMEOUT_MS + 1000;
      timer.fire();
      await until('the comment', () => notes().length === 1);
      expect(notes()[0].body).toContain('Left open: its checks did not pass within 60 minutes');
      expect(landings()[0].state).toBe('left-open');
      expect(world.merges).toEqual([]);
    });

    it('a second approval replaces the first: one landing, the newer sha', async () => {
      world.checks = [check('test', 'in_progress', null)];
      await boot();
      await approveByButton();
      await until('waiting', () => timer.waiting().length === 1);
      await approveByButton({ note: 'again' });
      await until('waiting again', () => timer.waiting().length === 1 && audit('landing').length === 2);
      expect(landings()).toHaveLength(1);
      expect(timer.waiting()).toHaveLength(1);
    });
  });

  describe('across a restart', () => {
    it('picks a pending landing up from the data folder and lands it when the checks pass', async () => {
      world.checks = [check('test', 'in_progress', null)];
      await boot();
      await approveByButton();
      await until('waiting', () => timer.waiting().length === 1);
      await srv.close();
      expect(landings()).toEqual([expect.objectContaining({ pull: 40, sha: HEAD, state: 'pending' })]);
      // a new process: nothing in memory but the file
      timer = fakeTimer();
      world.checks = [check('test', 'completed', 'success')];
      clock += 5 * 60_000;
      srv = await start(config);
      await until('the merge', () => world.merges.length === 1);
      expect(world.merges[0]).toEqual({ sha: HEAD, merge_method: 'merge' });
      await until('landed', () => landings()[0].state === 'landed');
    });

    it('keeps waiting after a restart while the checks run, and polls on the new clock', async () => {
      world.checks = [check('test', 'in_progress', null)];
      await boot();
      await approveByButton();
      await until('waiting', () => timer.waiting().length === 1);
      await srv.close();
      timer = fakeTimer();
      srv = await start(config);
      await until('waiting again', () => timer.waiting().length === 1);
      expect(world.merges).toEqual([]);
      world.checks = [check('test', 'completed', 'success')];
      timer.fire();
      await until('the merge', () => world.merges.length === 1);
    });

    it('drops rows that are finished or past their time, and merges nothing for them', async () => {
      await boot();
      await srv.close();
      const d = new DatabaseSync(path.join(data, 'cornfield.db'));
      const old = new Date(clock - TIMEOUT_MS - 60_000).toISOString();
      d.prepare("INSERT INTO landings (repo, pull, slug, sha, user_id, login, started, state) VALUES ('owner/name', 40, ?, ?, '1001', 'maintainer-one', ?, 'pending')").run(SLUG, HEAD, old);
      d.prepare("INSERT INTO landings (repo, pull, slug, sha, user_id, login, started, state) VALUES ('owner/name', 41, ?, ?, '1001', 'maintainer-one', ?, 'landed')").run('0041-x', HEAD, new Date(clock).toISOString());
      d.close();
      srv = await start(config);
      await until('the rows to be dropped', () => landings().length === 0);
      await settle();
      expect(world.merges).toEqual([]);
      expect(timer.waiting()).toEqual([]);
      expect(audit('landing').at(-1)).toMatchObject({ request: { state: 'left-open' }, answer: { state: 'left-open' } });
    });

    it('starts nothing on a restart with the key off, even with a row left behind', async () => {
      await boot();
      await srv.close();
      const d = new DatabaseSync(path.join(data, 'cornfield.db'));
      d.prepare("INSERT INTO landings (repo, pull, slug, sha, user_id, login, started, state) VALUES ('owner/name', 40, ?, ?, '1001', 'maintainer-one', ?, 'pending')").run(SLUG, HEAD, new Date(clock).toISOString());
      d.close();
      config.approveLands = false;
      srv = await start(config);
      await settle();
      expect(world.merges).toEqual([]);
      expect(timer.waiting()).toEqual([]);
    });
  });

  describe('the page', () => {
    it('shows what is waiting, and a maintainer cancels it from the page: one comment, nothing merged', async () => {
      world.checks = [check('test', 'in_progress', null)];
      await boot();
      expect((await page('GET', '/api/forge/pulls/40/landing')).json).toMatchObject({ ok: true, enabled: true, landing: null });
      await approveByButton();
      await until('waiting', () => timer.waiting().length === 1);
      const shown = await page('GET', '/api/forge/pulls/40/landing');
      expect(shown.json).toMatchObject({ ok: true, enabled: true, landing: { pull: 40, slug: SLUG, sha: HEAD, by: 'maintainer-one' } });
      const res = await page('POST', '/api/forge/pulls/40/landing/cancel');
      expect(res.status, res.text).toBe(200);
      expect(res.json).toMatchObject({ ok: true, cancelled: true, number: 40 });
      expect(notes()).toHaveLength(1);
      expect(notes()[0].body).toContain('cancelled by maintainer-one');
      expect(landings()[0].state).toBe('cancelled');
      expect((await page('GET', '/api/forge/pulls/40/landing')).json.landing).toBeNull();
      expect(timer.waiting()).toEqual([]);
      world.checks = [check('test', 'completed', 'success')];
      timer.fire();
      await settle();
      expect(world.merges).toEqual([]);
      // nothing is waiting any more
      expect((await page('POST', '/api/forge/pulls/40/landing/cancel')).status).toBe(404);
    });

    it('a same-site page cannot use up the maintainer\'s write budget: refused cross-origin cancels are not counted (#237)', async () => {
      world.checks = [check('test', 'in_progress', null)];
      await boot();
      await approveByButton();
      await until('waiting', () => timer.waiting().length === 1);
      for (let i = 0; i < 62; i++) {
        const res = await page('POST', '/api/forge/pulls/40/landing/cancel', undefined, { headers: { origin: 'https://sibling.example', 'sec-fetch-site': 'same-site' } });
        expect(res.status).toBe(403);
      }
      // the maintainer's own cancel still goes through
      expect((await page('POST', '/api/forge/pulls/40/landing/cancel')).status).toBe(200);
    });

    it('takes a cancel from cornfield\'s own page only, and from a signed-in session only', async () => {
      world.checks = [check('test', 'in_progress', null)];
      await boot();
      await approveByButton();
      await until('waiting', () => timer.waiting().length === 1);
      const foreign = await page('POST', '/api/forge/pulls/40/landing/cancel', undefined, { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
      expect(foreign.status).toBe(403);
      expect((await raw(srv.port, 'POST', '/api/forge/pulls/40/landing/cancel', { headers: { origin: origin() } })).status).toBeGreaterThanOrEqual(401);
      expect((await page('GET', '/api/forge/pulls/40/landing/cancel')).status).toBe(405);
      expect(landings()[0].state).toBe('pending');
      expect(timer.waiting()).toHaveLength(1);
    });
  });

  describe('with the spec.approved trigger (issue #97)', () => {
    const ON = { 'spec.approved': { kind: 'code' } };
    const requests = () => world.posted.filter((c) => c.body.includes('```cornfield-run'));
    const runRows = () => query('SELECT * FROM runs');
    /** The request as cornfield made it (its comment carries the same JSON) */
    const requestOf = () => JSON.parse(String(runRows()[0].request));

    it('approve, land, then the trigger reads: the run is asked for on the landed proposal, on the merged pull request', async () => {
      await boot(true, { on: ON });
      // The trigger's look for the open spec PRs is answered only once the landing has merged it: the order #97 was about
      let merged;
      world.listGate = new Promise((r) => { merged = r; });
      await approveByButton();
      await until('the merge', () => world.merges.length === 1);
      merged();
      await until('the request', () => requests().length === 1);
      await settle();
      expect(requests()).toHaveLength(1);
      const asked = requestOf();
      expect(asked.refs).toEqual({ proposal: SLUG });
      expect(asked.trigger).toEqual({ event: 'spec.approved', by: 'maintainer-one', ref: 'pull:40' });
      expect(runRows()).toEqual([expect.objectContaining({ via: 'trigger', proposal: SLUG, target: 40 })]);
      expect(audit('trigger-skipped')).toEqual([]);
      expect(audit('agent-request')).toEqual([expect.objectContaining({ target: 'owner/name#40', status: 201, request: expect.objectContaining({ refs: { proposal: SLUG }, trigger: { event: 'spec.approved', ref: 'pull:40' }, target: 40 }) })]);
    });

    it('approve, the trigger reads, then it lands: the run names the open spec pull request, and it is still one run', async () => {
      await boot(true, { on: ON });
      // The checks are held until the request is posted, so the landing merges after it
      let green;
      world.gate = new Promise((r) => { green = r; });
      await approveByButton();
      await until('the request', () => requests().length === 1);
      expect(world.merges).toEqual([]);
      green();
      await until('the merge', () => world.merges.length === 1);
      await settle();
      expect(requests()).toHaveLength(1);
      expect(requestOf().refs).toEqual({ proposal: SLUG, pull: 40 });
      expect(runRows()).toEqual([expect.objectContaining({ via: 'trigger', proposal: SLUG, target: 40 })]);
      expect(audit('trigger-skipped')).toEqual([]);
    });
  });

  it('refuses to start with the key on and no sign-in', async () => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-lander-plain-'));
    srv = { close: async () => {} };
    const open = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(open, { forge: { type: 'github', url: fake.url, repo: 'owner/name' }, approveLands: true });
    expect(() => createCornfieldServer(open, { env: {} })).toThrow(/approveLands.*sign-in/);
  });
});
