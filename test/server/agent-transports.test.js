/**
 * @vitest-environment node
 *
 * The push and pull transports and runner tokens (issue #81; server/runner-api.js over server/agent-runs.js), walked from the outside against a
 * fake GitHub on loopback and a receiver for the hooks. Held here:
 *
 *   - pull: a request is recorded and NOT posted to the forge; a runner token lists the queue (oldest first), claims, reports and finishes a
 *     run; a second claim is 409 (two at once: one wins); only the claimer reports; an unclaimed or quiet request is not offered
 *   - push: the request goes out as a signed `agent.requested` hook event that verifies with the documented check; a runner token reports on it
 *   - reports: the contract's validation, credentials refused, a run that is over takes no more; the `run.*` hooks fire as on the forge
 *   - stop: the runner learns of it by GET /api/runs/<id>; a pull run nobody claimed is stopped by cornfield
 *   - the cap, the rate and the one-run-per-subject rules apply on every transport
 *   - scope isolation both ways: a runner token gets 403 on every other route, review and agent tokens get 403 on the runner routes
 *   - the audit, and that nothing secret is ever in a row or an answer
 * No real forge, runner or token.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHmac, timingSafeEqual } from 'node:crypto';
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
import { validateRequest } from '../../core/agent-contract.js';
import { SAMPLE } from '../helpers.js';
import { fakeForge, recordings } from './fake-forge.js';

// Secret-shaped strings are built at run time so that no scanner sees one as a literal
const GHP = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join('');
const FAKE_RUNNER = ['cf_', 'nt_', 'A'.repeat(43)].join('');
const SESSION_SECRET = 'x'.repeat(40);
const HOOK_SECRET = 'hook-secret-for-tests-'.padEnd(40, 'z');
const ENV = { CORNFIELD_GITHUB_CLIENT_ID: 'test-client-id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: SESSION_SECRET, CORNFIELD_HOOK_SECRET: HOOK_SECRET };
const PUBLIC = 'http://127.0.0.1:3350';
const MAINT = 'tok-maint';
const API = '/api/v3';
const GH = `${API}/repos/owner/name`;
const DAY = 24 * 60 * 60 * 1000;
const NOTE = 'private words the audit must never keep';

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

/** The hooks' receiver on loopback: keeps each delivery with its raw body, so a signature can be checked on the bytes */
async function receiver() {
  const got = [];
  const me = { got, url: '', close: null, of: null, next: null };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      got.push({ headers: req.headers, raw: body, body: JSON.parse(body.toString('utf8')) });
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  me.url = `http://127.0.0.1:${server.address().port}/cornfield-hook`;
  me.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); });
  me.of = (event) => got.filter((g) => g.body.event === event);
  /** Waits until `n` events of that name have arrived */
  me.next = async (event, n = 1) => {
    const end = Date.now() + 15_000;
    while (me.of(event).length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
    return me.of(event);
  };
  return me;
}

/** The check a push runner makes, as docs/agents.md documents it: the HMAC over the raw bytes, then the contract's schema on `request` */
function verifyPush(secret, rawBody, signatureHeader) {
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const got = Buffer.from(String(signatureHeader ?? ''));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, error: 'bad signature' };
  const event = JSON.parse(rawBody.toString('utf8'));
  if (event.event !== 'agent.requested') return { ok: false, error: 'not a request' };
  const checked = validateRequest(event.request);
  return checked.ok ? { ok: true, request: checked.value } : { ok: false, error: checked.error };
}

const frozenTimer = () => ({ setTimeout: () => 0, clearTimeout: () => {} });

describe('the push and pull transports', () => {
  let fake;
  let rcv;
  let data;
  let srv;
  let cookie;
  let config;
  let clock = Date.parse('2026-11-05T09:00:00Z');
  let world;
  const base = recordings('github');

  const dispatch = (key, req) => {
    const [method, target] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
    const auth = req.headers.authorization;
    if (key === 'POST /login/oauth/access_token') return { body: { access_token: MAINT, token_type: 'bearer' } };
    if (key === 'DELETE /api/v3/applications/test-client-id/token') return { status: 204 };
    if (key === `GET ${API}/user`) return base['GET /user'];
    if (key === `GET ${GH}`) return { body: { id: 1, full_name: 'owner/name', permissions: { admin: false, maintain: true, push: true, triage: true, pull: true } } };
    if (!target.startsWith(GH)) return { status: 404, body: { message: 'Not Found' } };
    const url = new URL(target.slice(GH.length), 'http://x');
    const p = decodeURIComponent(url.pathname);
    let m;
    if (method === 'GET' && (m = /^\/collaborators\/([^/]+)\/permission$/.exec(p))) return { body: { permission: 'write', role_name: 'maintain', user: { login: m[1] } } };
    if (method === 'GET' && (m = /^\/issues\/(\d+)$/.exec(p))) {
      const n = Number(m[1]);
      if (!world.issues.includes(n)) return { status: 404, body: { message: 'Not Found' } };
      return { body: { number: n, title: `Issue ${n}`, state: 'open', user: { login: 'author-one' }, labels: [], body: '', comments: 0, html_url: `https://github.example.com/owner/name/issues/${n}`, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' } };
    }
    if (method === 'GET' && /^\/issues\/(\d+)\/comments$/.test(p)) return { body: [] };
    if (method === 'POST' && /^\/issues\/(\d+)\/comments$/.test(p)) {
      world.posted.push({ auth, body: JSON.parse(req.body).body });
      return { status: 201, body: { id: 9000 + world.posted.length, user: { login: 'maintainer-one' }, body: JSON.parse(req.body).body, html_url: 'https://github.example.com/owner/name/issues/12#issuecomment-1', created_at: new Date(clock).toISOString(), updated_at: new Date(clock).toISOString() } };
    }
    if (method === 'GET' && p === '/pulls') return { body: [] };
    if (method === 'GET' && p === '/branches') return { body: [] };
    return { status: 404, body: { message: 'Not Found' } };
  };
  const routes = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? (req) => dispatch(key, req) : undefined) });

  const start = async (cfg, opts = {}) => {
    const server = createCornfieldServer(cfg, { env: ENV, now: () => clock, hookTimer: frozenTimer(), specPollTimer: frozenTimer(), ...opts });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    return { port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
  };
  /** (Re)starts the server under this transport */
  const boot = async (transport, extra = {}) => {
    await srv?.close();
    Object.assign(config, { hooks: [{ url: rcv.url, events: '*' }], ...extra });
    config.agents.transport = transport;
    srv = await start(config);
    cookie = await signedIn(srv.port, 'c-maint');
  };

  beforeAll(async () => {
    fake = await fakeForge(routes);
    rcv = await receiver();
  });
  afterAll(async () => {
    await rcv.close();
    await fake.close();
  });
  beforeEach(async () => {
    clock += 3 * 60_000;
    world = { issues: [12, 13, 14, 15, 16], posted: [] };
    rcv.got.length = 0;
    fake.requests.length = 0;
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-transports-'));
    config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(config, { forge: { type: 'github', url: fake.url, repo: 'owner/name' }, publicUrl: PUBLIC });
    Object.assign(config.agents, { runners: ['runner-bot'], profiles: ['claude', 'local-qwen'] });
    srv = null;
  });
  afterEach(async () => {
    await srv?.close();
    fs.rmSync(data, { recursive: true, force: true });
  });

  const page = (method, target, body, { as = cookie, headers = {} } = {}) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    return raw(srv.port, method, target, {
      headers: { cookie: as || undefined, origin: `http://127.0.0.1:${srv.port}`, 'sec-fetch-site': 'same-origin', ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }), ...headers },
      body: text,
    });
  };
  const mint = async (scope, label = 'my runner', days) => {
    const res = await page('POST', `/api/${scope}-tokens`, days === undefined ? { label } : { label, days });
    expect(res.status, res.text).toBe(201);
    return res.json;
  };
  /** A call with a bearer token (none when `token` is null), no cookie */
  const call = (token, method, target, body, headers = {}) => {
    const text = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    return raw(srv.port, method, target, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }), ...headers }, body: text });
  };
  const ask = (agentSecret, extra = {}) => call(agentSecret, 'POST', '/api/agent-requests', { kind: 'code', refs: { issue: 12 }, brief: 'Add the meals page.', ...extra });
  const queue = (token) => call(token, 'GET', '/api/agent-requests?state=queued');
  const claim = (token, runId) => call(token, 'POST', `/api/agent-requests/${runId}/claim`);
  const report = (token, runId, body) => call(token, 'POST', `/api/runs/${runId}`, body);
  const view = (token, runId) => call(token, 'GET', `/api/runs/${runId}`);
  const rows = () => {
    const db = new DatabaseSync(path.join(data, 'cornfield.db'));
    const out = db.prepare('SELECT * FROM actions ORDER BY id').all();
    db.close();
    return out.map((r) => ({ ...r, request: JSON.parse(String(r.request)), answer: r.answer ? JSON.parse(String(r.answer)) : null }));
  };
  const runnerRows = () => rows().filter((r) => String(r.action).startsWith('runner-'));
  const later = (ms = 70_000) => { clock += ms; };
  /** A pull setup: an agent token and a runner token, and a queued request */
  const pulled = async (extra = {}) => {
    await boot('pull');
    const agent = await mint('agent', 'chat bot');
    const runner = await mint('runner', 'laptop');
    const asked = await ask(agent.secret, extra);
    expect(asked.status, asked.text).toBe(201);
    return { agent, runner, asked, runId: asked.json.request.runId };
  };

  describe('pull', () => {
    it('a runner behind NAT lists, claims, reports and finishes a run; nothing is posted to the forge, and no forge is asked for the runner', async () => {
      const { runner, asked, runId } = await pulled({ profile: 'claude' });
      expect(asked.json.comment).toBeNull();
      expect(asked.json.run).toMatchObject({ transport: 'pull', status: 'requested', via: 'api', profile: 'claude' });
      expect(world.posted).toEqual([]);
      await rcv.next('agent.requested'); // the hook is the same on every transport

      const forgeCalls = fake.requests.length;
      const queued = await queue(runner.secret);
      expect(queued.status, queued.text).toBe(200);
      expect(queued.json.requests).toEqual([asked.json.request]);
      expect(queued.json.requests[0]).toMatchObject({ version: 1, runId, kind: 'code', refs: { issue: 12 }, requestedBy: 'maintainer-one', brief: 'Add the meals page.' });

      const claimed = await claim(runner.secret, runId);
      expect(claimed.status, claimed.text).toBe(200);
      expect(claimed.json.request).toEqual(asked.json.request);
      expect(claimed.json.run).toMatchObject({ runId, state: 'claimed', stopRequested: false, open: true, finished: false });
      expect((await queue(runner.secret)).json.requests).toEqual([]);

      later(1000);
      const working = await report(runner.secret, runId, { state: 'working', note: NOTE, url: 'https://logs.example.org/run/1', tokens: 1200, cost: 0.12 });
      expect(working.status, working.text).toBe(200);
      expect(working.json.run).toMatchObject({ state: 'working', stopRequested: false });
      expect((await view(runner.secret, runId)).json.run).toMatchObject({ runId, state: 'working', reported: 'working', stopRequested: false });
      later(1000);
      const done = await report(runner.secret, runId, { state: 'done', note: 'Opened the pull request.' });
      expect(done.json.run).toMatchObject({ state: 'done', finished: true, open: false });

      // the dashboard sees what the runner said
      const list = await page('GET', '/api/agent-runs');
      expect(list.json.open).toBe(0);
      expect(list.json.runs[0]).toMatchObject({ runId, status: 'done', transport: 'pull', comment: null, report: { state: 'done', by: 'laptop', note: 'Opened the pull request.', tokens: 1200, cost: 0.12 } });
      // a finished run takes no more reports
      expect((await report(runner.secret, runId, { state: 'working' })).status).toBe(409);

      // the forge was asked nothing on the runner's behalf, and nothing was posted
      expect(fake.requests.slice(forgeCalls).filter((r) => r.method !== 'GET')).toEqual([]);
      expect(world.posted).toEqual([]);

      // the hooks, as on the forge: claimed once, a state each time it changed, finished once
      await rcv.next('run.finished');
      expect(rcv.of('run.claimed').map((g) => g.body.runId)).toEqual([runId]);
      expect(rcv.of('run.state').map((g) => g.body.state)).toEqual(['claimed', 'working', 'done']);
      expect(rcv.of('run.finished').map((g) => g.body.state)).toEqual(['done']);
      expect(rcv.of('run.finished')[0].body).toMatchObject({ runId, issue: 12, actor: 'runner:laptop' });
    });

    it('lists the oldest first', async () => {
      await boot('pull');
      const agent = await mint('agent');
      const runner = await mint('runner');
      const ids = [];
      for (const issue of [14, 12, 13]) {
        const res = await ask(agent.secret, { refs: { issue } });
        expect(res.status, res.text).toBe(201);
        ids.push(res.json.request.runId);
        later(1000);
      }
      expect((await queue(runner.secret)).json.requests.map((r) => r.runId)).toEqual(ids);
    });

    it('refuses a second claim of the same request: of two at once one wins, and a repeat is 409', async () => {
      const { runner, runId } = await pulled();
      const other = await mint('runner', 'second');
      const both = await Promise.all([claim(runner.secret, runId), claim(other.secret, runId)]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
      const loser = both.find((r) => r.status === 409);
      expect(loser.json).toMatchObject({ ok: false, code: 'already-claimed' });
      // the winner holds it; claiming again, even by the winner, is 409
      const winnerToken = both[0].status === 200 ? runner : other;
      expect((await claim(winnerToken.secret, runId)).status).toBe(409);
      expect((await view(winnerToken.secret, runId)).status).toBe(200);
      // exactly one claim reached the hooks
      await rcv.next('run.claimed');
      expect(rcv.of('run.claimed')).toHaveLength(1);
      // and the run records which token claimed it
      const db = new DatabaseSync(path.join(data, 'cornfield.db'));
      const row = db.prepare('SELECT claimed_by, state FROM runs WHERE run_id = ?').get(runId);
      db.close();
      expect(row).toEqual({ claimed_by: winnerToken.token.id, state: 'claimed' });
    });

    it('lets only the token that claimed a run read or report on it', async () => {
      const { runner, runId } = await pulled();
      const other = await mint('runner', 'second');
      // before any claim nobody holds it
      for (const t of [runner, other]) {
        expect((await report(t.secret, runId, { state: 'working' })).status).toBe(403);
        expect((await view(t.secret, runId)).status).toBe(403);
      }
      expect((await claim(runner.secret, runId)).status).toBe(200);
      const theirs = await report(other.secret, runId, { state: 'done' });
      expect(theirs.status, theirs.text).toBe(403);
      expect(theirs.json.code).toBe('forbidden');
      expect((await view(other.secret, runId)).status).toBe(403);
      expect((await claim(other.secret, runId)).status).toBe(409);
      // the run did not move
      expect((await view(runner.secret, runId)).json.run).toMatchObject({ state: 'claimed', finished: false });
      // an unknown run is 404
      expect((await report(runner.secret, 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEF', { state: 'working' })).status).toBe(404);
    });

    it('keeps the cap, the one-run-per-subject rule and the rate on this transport too', async () => {
      await boot('pull');
      const agent = await mint('agent');
      for (const issue of [12, 13, 14]) {
        expect((await ask(agent.secret, { refs: { issue } })).status).toBe(201);
        later(6000);
      }
      const capped = await ask(agent.secret, { refs: { issue: 15 } });
      expect(capped.status).toBe(409);
      expect(capped.json.code).toBe('cap-reached');
      // a run on an issue that already has one (it needs a place under the cap first)
      await page('POST', '/api/agent-runs/' + (await page('GET', '/api/agent-runs')).json.runs[0].runId + '/stop', {});
      later(6000);
      const twice = await ask(agent.secret, { refs: { issue: 13 } });
      expect(twice.status).toBe(409);
      expect(twice.json.code).toBe('run-open');
    });

    it('does not offer, or let anyone claim, a request that waited past quietAfter', async () => {
      const { runner, runId } = await pulled();
      clock += 25 * 3_600_000;
      expect((await queue(runner.secret)).json.requests).toEqual([]);
      const late = await claim(runner.secret, runId);
      expect(late.status).toBe(409);
      expect(late.json.error).toMatch(/quietAfter/);
      const list = await page('GET', '/api/agent-runs');
      expect(list.json.runs[0]).toMatchObject({ runId, status: 'quiet', open: false });
    });

    it('goes quiet as usual when a claimed run is never reported on, and a later report opens it again', async () => {
      const { runner, runId } = await pulled();
      expect((await claim(runner.secret, runId)).status).toBe(200);
      clock += 25 * 3_600_000;
      expect((await view(runner.secret, runId)).json.run).toMatchObject({ state: 'quiet', open: false });
      expect((await report(runner.secret, runId, { state: 'working' })).json.run).toMatchObject({ state: 'working', open: true });
    });

    it('offers a runner a stop through GET /api/runs/<id>, and stops a request nobody claimed itself', async () => {
      const { runner, runId } = await pulled();
      expect((await claim(runner.secret, runId)).status).toBe(200);
      later();
      const stop = await page('POST', `/api/agent-runs/${runId}/stop`, { note: 'wrong issue' });
      expect(stop.status, stop.text).toBe(200);
      expect(stop.json.comment).toBeNull();
      expect(world.posted).toEqual([]);
      const seen = await view(runner.secret, runId);
      expect(seen.json.run).toMatchObject({ state: 'stop-requested', stopRequested: true });
      expect(seen.json.run.stopRequestedAt).toBe(new Date(clock).toISOString());
      // a report answers with it too, and the runner decides what stopping means
      expect((await report(runner.secret, runId, { state: 'working' })).json.run.stopRequested).toBe(true);
      expect((await report(runner.secret, runId, { state: 'stopped', note: 'stopped as asked' })).json.run).toMatchObject({ state: 'stopped', finished: true });
      await rcv.next('run.stopRequested');
      expect(rcv.of('run.stopRequested')).toHaveLength(1);

      // a request nobody has claimed: cornfield ends it, and it leaves the queue
      later();
      const agent = await mint('agent', 'second bot');
      const second = await ask(agent.secret, { refs: { issue: 13 } });
      const id2 = second.json.request.runId;
      later();
      const stopped = await page('POST', `/api/agent-runs/${id2}/stop`, {});
      expect(stopped.status, stopped.text).toBe(200);
      expect(stopped.json.run).toMatchObject({ status: 'stopped', open: false });
      expect((await queue(runner.secret)).json.requests).toEqual([]);
      expect((await claim(runner.secret, id2)).status).toBe(409);
      await rcv.next('run.finished', 2);
      expect(rcv.of('run.finished').map((g) => g.body.runId)).toContain(id2);
    });
  });

  describe('reports', () => {
    it('are the contract\'s report JSON, checked strictly, and a bad one changes nothing', async () => {
      const { runner, runId } = await pulled();
      await claim(runner.secret, runId);
      const bad = [
        ['an unknown state', { state: 'finished' }],
        ['stop-requested, which only cornfield writes', { state: 'stop-requested' }],
        ['a key the contract does not have', { state: 'working', extra: 1 }],
        ['no state', { note: 'hi' }],
        ['a negative count', { state: 'working', tokens: -1 }],
        ['a link with a user and password', { state: 'working', url: 'https://user:pw@logs.example.org/x' }],
        ['a link with a credential in its query', { state: 'working', url: 'https://logs.example.org/x?token=abc' }],
        ['a list', [{ state: 'working' }]],
        ['a note that is too long', { state: 'working', note: 'x'.repeat(4001) }],
      ];
      for (const [what, body] of bad) {
        const res = await report(runner.secret, runId, body);
        expect(res.status, what).toBe(400);
        expect(res.json).toMatchObject({ ok: false, code: 'invalid' });
      }
      expect((await report(runner.secret, runId, 'not json')).status).toBe(400);
      expect((await report(runner.secret, runId, `{"state":"working","note":"${'x'.repeat(20 * 1024)}"}`)).status).toBe(413);
      expect((await view(runner.secret, runId)).json.run).toMatchObject({ state: 'claimed', reported: 'claimed' });
    });

    it('refuse anything shaped like a credential: a forge token, and cornfield\'s own tokens', async () => {
      const { runner, agent, runId } = await pulled();
      await claim(runner.secret, runId);
      for (const note of [`pushed with ${GHP}`, `used ${runner.secret}`, `used ${agent.secret}`, `used ${FAKE_RUNNER}`]) {
        const res = await report(runner.secret, runId, { state: 'working', note });
        expect(res.status, note).toBe(400);
        // the refusal does not repeat what it refused
        expect(res.text).not.toContain(GHP);
        expect(res.text).not.toContain(runner.secret);
      }
      expect((await view(runner.secret, runId)).json.run.reported).toBe('claimed');
      for (const r of rows()) {
        const text = JSON.stringify(r);
        for (const secret of [GHP, runner.secret, agent.secret, FAKE_RUNNER]) expect(text).not.toContain(secret);
      }
    });
  });

  describe('push', () => {
    it('sends the request as a signed agent.requested event that verifies with the documented check, and takes reports from a runner token', async () => {
      await boot('push');
      const agent = await mint('agent');
      const runner = await mint('runner', 'pushed runner');
      const asked = await ask(agent.secret);
      expect(asked.status, asked.text).toBe(201);
      expect(asked.json.comment).toBeNull();
      expect(asked.json.run.transport).toBe('push');
      expect(world.posted).toEqual([]);
      const [delivery] = await rcv.next('agent.requested');
      const checked = verifyPush(HOOK_SECRET, delivery.raw, delivery.headers['x-cornfield-signature']);
      expect(checked, JSON.stringify(checked)).toEqual({ ok: true, request: asked.json.request });
      // a wrong secret, or a body changed in flight, does not verify
      expect(verifyPush('another-secret-'.padEnd(40, 'q'), delivery.raw, delivery.headers['x-cornfield-signature']).ok).toBe(false);
      expect(verifyPush(HOOK_SECRET, Buffer.from(delivery.raw.toString('utf8').replace('meals', 'mails')), delivery.headers['x-cornfield-signature']).ok).toBe(false);

      const runId = asked.json.request.runId;
      // nothing to pull or claim on this transport
      expect((await queue(runner.secret)).json.requests).toEqual([]);
      expect((await claim(runner.secret, runId)).status).toBe(409);
      // the runner reports with its token; the first to report holds the run
      const first = await report(runner.secret, runId, { state: 'claimed' });
      expect(first.status, first.text).toBe(200);
      const other = await mint('runner', 'someone else');
      expect((await report(other.secret, runId, { state: 'working' })).status).toBe(403);
      expect((await view(other.secret, runId)).status).toBe(403);
      expect((await report(runner.secret, runId, { state: 'done', note: 'merged elsewhere' })).json.run).toMatchObject({ state: 'done', finished: true });
      await rcv.next('run.finished');
      expect(rcv.of('run.claimed')).toHaveLength(1);
      expect(rcv.of('run.state').map((g) => g.body.state)).toEqual(['claimed', 'done']);
      // a stop reaches the push runner as the hook event, and by GET
      later();
      const again = await ask(agent.secret, { refs: { issue: 13 } });
      const id2 = again.json.request.runId;
      await report(runner.secret, id2, { state: 'working' });
      later();
      expect((await page('POST', `/api/agent-runs/${id2}/stop`, {})).status).toBe(200);
      await rcv.next('run.stopRequested');
      expect(rcv.of('run.stopRequested')[0].body).toMatchObject({ runId: id2, state: 'stop-requested' });
      expect((await view(runner.secret, id2)).json.run.stopRequested).toBe(true);
    });

    it('needs a hook that subscribes to agent.requested, or the server will not start', async () => {
      await boot('forge'); // a server up for the config, then the bad ones
      const bad = [[], [{ url: rcv.url, events: ['spec.ready'] }]];
      for (const hooks of bad) {
        expect(() => createCornfieldServer({ ...config, agents: { ...config.agents, transport: 'push' }, hooks }, { env: ENV })).toThrow(/subscribe to agent\.requested/);
      }
      for (const hooks of [[{ url: rcv.url, events: '*' }], [{ url: rcv.url, events: ['agent.requested'] }]]) {
        const ok = createCornfieldServer({ ...config, agents: { ...config.agents, transport: 'push' }, hooks, dataDir: data }, { env: ENV, hookTimer: frozenTimer(), specPollTimer: frozenTimer() });
        ok.close();
      }
    });

    it('needs sign-in and a forge on push and pull', () => {
      for (const transport of ['push', 'pull']) {
        expect(() => createCornfieldServer({ ...config, agents: { ...config.agents, transport }, hooks: [{ url: rcv.url, events: '*' }] }, { env: {} })).toThrow(/sign-in/);
      }
    });
  });

  describe('on the forge', () => {
    it('a run asked for on the forge is nobody\'s to claim or report on with a runner token', async () => {
      await boot('forge');
      const agent = await mint('agent');
      const runner = await mint('runner');
      const asked = await ask(agent.secret);
      expect(asked.status).toBe(201);
      expect(world.posted).toHaveLength(1);
      const runId = asked.json.request.runId;
      expect((await queue(runner.secret)).json.requests).toEqual([]);
      expect((await claim(runner.secret, runId)).status).toBe(409);
      expect((await report(runner.secret, runId, { state: 'done' })).status).toBe(403);
      expect((await view(runner.secret, runId)).status).toBe(403);
    });
  });

  describe('runner tokens', () => {
    it('are made, listed and revoked in the dialog\'s routes like the others, kept apart from the other kinds', async () => {
      await boot('pull');
      const made = await mint('runner', 'laptop', 7);
      expect(made.secret).toMatch(/^cf_nt_[A-Za-z0-9_-]{43}$/);
      expect(made.token).toMatchObject({ scope: 'runner', label: 'laptop', state: 'active' });
      await mint('review', 'review one');
      await mint('agent', 'agent one');
      const mine = (scope) => page('GET', `/api/${scope}-tokens`).then((r) => r.json.tokens.map((t) => t.label));
      expect(await mine('runner')).toEqual(['laptop']);
      expect(await mine('review')).toEqual(['review one']);
      expect(await mine('agent')).toEqual(['agent one']);
      // one scope's revoke does not reach another's token
      expect((await page('POST', `/api/review-tokens/${made.token.id}/revoke`, {})).status).toBe(404);
      expect((await queue(made.secret)).status).toBe(200);
      const revoked = await page('POST', `/api/runner-tokens/${made.token.id}/revoke`, {});
      expect(revoked.json.token.state).toBe('revoked');
      const after = await queue(made.secret);
      expect(after.status).toBe(403);
      expect(after.json.error).toMatch(/revoked/);
      // a token cannot make tokens: the dialog's routes are the signed-in maintainer's
      const viaToken = await call(made.secret, 'POST', '/api/runner-tokens', { label: 'sneaky' });
      expect(viaToken.status).toBe(403);
    });

    it('expire like the others', async () => {
      await boot('pull');
      const made = await mint('runner', 'short', 1);
      expect((await queue(made.secret)).status).toBe(200);
      clock += 2 * DAY;
      const late = await queue(made.secret);
      expect(late.status).toBe(403);
      expect(late.json.error).toMatch(/expired/);
    });

    it('are refused without a token (401), with an unknown one (401), and with only a cookie (401)', async () => {
      await boot('pull');
      const none = await queue(null);
      expect(none.status).toBe(401);
      expect(none.headers['www-authenticate']).toMatch(/^Bearer/);
      expect((await queue(FAKE_RUNNER)).status).toBe(401);
      const cookieOnly = await raw(srv.port, 'GET', '/api/agent-requests?state=queued', { headers: { cookie: cookie } });
      expect(cookieOnly.status).toBe(401);
      const runId = 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEF';
      expect((await raw(srv.port, 'POST', `/api/runs/${runId}`, { headers: { cookie: cookie, origin: `http://127.0.0.1:${srv.port}`, 'content-type': 'application/json' }, body: '{"state":"working"}' })).status).toBe(401);
      expect(runnerRows().map((r) => r.login)).toEqual(['(no token)', '(no token)', '(no token)', '(no token)']);
    });

    it('answer 405 to a method a route does not take, and keep the Host check', async () => {
      const { runner, runId } = await pulled();
      expect((await call(runner.secret, 'DELETE', `/api/runs/${runId}`)).status).toBe(405);
      expect((await call(runner.secret, 'GET', `/api/agent-requests/${runId}/claim`)).status).toBe(405);
      const foreign = await raw(srv.port, 'GET', '/api/agent-requests?state=queued', { headers: { host: 'evil.example.org', authorization: `Bearer ${runner.secret}` } });
      expect(foreign.status).toBe(421);
      // only the queued listing exists
      expect((await call(runner.secret, 'GET', '/api/agent-requests')).status).toBe(400);
      expect((await call(runner.secret, 'GET', '/api/agent-requests?state=all')).status).toBe(400);
    });

    it('get 403 on every route that is not theirs, and review and agent tokens get 403 on theirs', async () => {
      const { runner, agent, runId } = await pulled();
      const review = await mint('review', 'reviewer');
      const stray = [
        ['POST', '/api/reviews', { pull: 1 }], ['POST', '/api/agent-requests', { kind: 'code' }], ['PUT', '/api/agent-requests', {}],
        ['GET', '/api/agent-runs'], ['GET', `/api/agent-runs/${runId}`], ['POST', '/api/agent-runs', {}], ['POST', `/api/agent-runs/${runId}/stop`, {}],
        ['GET', '/api/review-tokens'], ['POST', '/api/review-tokens', { label: 'x' }], ['GET', '/api/agent-tokens'], ['POST', '/api/agent-tokens', { label: 'x' }],
        ['GET', '/api/runner-tokens'], ['POST', '/api/runner-tokens', { label: 'x' }], ['POST', '/api/runner-tokens/1/revoke', {}], ['POST', '/api/review-tokens/1/revoke', {}],
        ['GET', '/'], ['GET', '/healthz'], ['GET', '/cornfield/config.json'], ['GET', '/topology.json'], ['GET', '/explorer/main.js'], ['GET', '/auth/start'],
        ['GET', '/api/proposals'], ['GET', '/api/forge/pulls'], ['GET', '/api/runs'], ['GET', '/api/runs/not-a-run'], ['POST', '/api/runs/not-a-run', {}], ['GET', '/nope'],
      ];
      for (const [method, target, body] of stray) {
        const res = await call(runner.secret, method, target, body);
        expect(res.status, `${method} ${target}`).toBe(403);
        expect(res.json, `${method} ${target}`).toMatchObject({ ok: false, code: 'forbidden' });
        expect(res.text).not.toContain(runner.secret);
      }
      // …and every one of them is a row
      expect(rows().filter((r) => r.action === 'runner-call')).toHaveLength(stray.length - 3);
      for (const t of [review, agent]) {
        const routes = [['GET', '/api/agent-requests?state=queued'], ['POST', `/api/agent-requests/${runId}/claim`], ['GET', `/api/runs/${runId}`], ['POST', `/api/runs/${runId}`, { state: 'working' }]];
        for (const [method, target, body] of routes) {
          const res = await call(t.secret, method, target, body);
          expect(res.status, `${t.token.scope} ${method} ${target}`).toBe(403);
          expect(res.json.error).toMatch(/runner token/);
        }
      }
      // the run was not touched by any of it
      expect((await page('GET', '/api/agent-runs')).json.runs[0]).toMatchObject({ runId, status: 'requested', claimedAt: null });
    });
  });

  describe('the audit', () => {
    it('writes a row for every runner call, with the token\'s id and label and never a secret or a note\'s words', async () => {
      const { runner, agent, runId } = await pulled();
      await queue(runner.secret);
      await claim(runner.secret, runId);
      await view(runner.secret, runId);
      await report(runner.secret, runId, { state: 'working', note: NOTE });
      await report(runner.secret, runId, { state: 'nope' });
      await claim(runner.secret, runId);
      const all = runnerRows();
      expect(all.map((r) => [r.action, r.status])).toEqual([['runner-list', 200], ['runner-claim', 200], ['runner-run', 200], ['runner-run', 200], ['runner-run', 400], ['runner-claim', 409]]);
      for (const r of all) expect(r.request).toMatchObject({ via: 'api', token: { id: runner.token.id, label: 'laptop' } });
      expect(all.map((r) => r.login)).toEqual(Array(6).fill('maintainer-one'));
      expect(all[3].request).toMatchObject({ runId, state: 'working', noteChars: NOTE.length });
      expect(all[4].answer).toMatchObject({ code: 'invalid' });
      expect(all[5].answer).toMatchObject({ code: 'already-claimed' });
      const text = JSON.stringify(rows());
      for (const secret of [runner.secret, agent.secret, NOTE, HOOK_SECRET]) expect(text).not.toContain(secret);
    });

    it('writes an empty queue read down once in a while, not on every poll', async () => {
      await boot('pull');
      const runner = await mint('runner');
      for (let i = 0; i < 5; i++) { expect((await queue(runner.secret)).status).toBe(200); later(1000); }
      expect(runnerRows()).toHaveLength(1);
      clock += 11 * 60_000;
      await queue(runner.secret);
      expect(runnerRows()).toHaveLength(2);
    });

    it('stops a runner that polls too often, without writing a row for each refusal', async () => {
      await boot('pull');
      const runner = await mint('runner');
      let limited = 0;
      for (let i = 0; i < 130; i++) if ((await queue(runner.secret)).status === 429) limited += 1;
      expect(limited).toBe(10);
      expect(runnerRows().length).toBeLessThan(5);
    });
  });
});
