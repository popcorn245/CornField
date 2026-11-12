/**
 * @vitest-environment node
 *
 * The agent API and the dashboard's run routes (server/agent-api.js over server/agent-runs.js, issue #80), walked from the outside against a
 * fake GitHub on loopback that holds issues, one open spec PR and the comments posted on them. Held here:
 *
 *   - an agent token (made by a signed-in maintainer at /api/agent-tokens) asks for a run: the request is a comment by the token's owner, with
 *     their own sign-in, that reads back with `readRunBlocks`; the human line names the token's label; no secret is in it
 *   - the scopes are kept apart: a review token is 403 on POST /api/agent-requests, and an agent token is 403 on POST /api/reviews; neither
 *     lists in the other's token list
 *   - the refusals, each a row in `actions`: no token 401, revoked and expired 403, a demoted owner 403, no live sign-in 401, the cap and the
 *     one-per-issue rule 409 with the reason, a credential 400, a flood 429
 *   - the session routes: start and stop from cornfield's own page only; list and get; a token is no way to them; Refresh looks at the forge
 *   - the Host check still answers 421; without sign-in there is no route
 * No real forge, app or token.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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
import { readRunBlocks, formatRunComment } from '../../core/agent-contract.js';
// @ts-expect-error plain JS module, no declarations
import { ZW } from '../../core/defuse.js';
import { SAMPLE } from '../helpers.js';
import { fakeForge, recordings } from './fake-forge.js';

// Secret-shaped strings are built at run time so that no scanner sees one as a literal
const GHP = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join('');
const BEARER = ['Bear', 'er'].join('');
const LONG = 'abcdefghijklmnopqrstuvwxyz0123';
const AT = String.fromCharCode(64);
const DASHES = '-'.repeat(5);
const SESSION_SECRET = 'x'.repeat(40);
const ENV = { CORNFIELD_GITHUB_CLIENT_ID: 'test-client-id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: SESSION_SECRET };
const PUBLIC = 'http://127.0.0.1:3350';
const MAINT = 'tok-maint';
const MAINT2 = 'tok-maint-two';
const API = '/api/v3';
const GH = `${API}/repos/owner/name`;
const DAY = 24 * 60 * 60 * 1000;

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

describe('the agent API', () => {
  let fake;
  let data;
  let plainData;
  let srv;
  let plain;
  let cookie;
  let config;
  let clock = Date.parse('2026-11-05T09:00:00Z');
  let world;
  const base = recordings('github');

  const comment = (n, login, body, extra = {}) => {
    const c = { id: world.next++, user: { login, html_url: `https://github.example.com/${login}` }, body, html_url: `https://github.example.com/owner/name/issues/${n}#issuecomment-${world.next}`, created_at: new Date(clock).toISOString(), updated_at: new Date(clock).toISOString(), ...extra };
    world.comments[n] = [...(world.comments[n] ?? []), c];
    return c;
  };

  const dispatch = (key, req) => {
    const [method, target] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
    const auth = req.headers.authorization;
    if (key === 'POST /login/oauth/access_token') return { body: { access_token: req.body.includes('c-maint2') ? MAINT2 : MAINT, token_type: 'bearer' } };
    if (key === 'DELETE /api/v3/applications/test-client-id/token') return { status: 204 };
    if (key === `GET ${API}/user`) return auth === `Bearer ${MAINT2}` ? { body: { login: 'maintainer-two', id: 1003 } } : base['GET /user'];
    if (key === `GET ${GH}`) {
      const maintains = auth === `Bearer ${MAINT}` ? !world.demoted.has('maintainer-one') : auth === `Bearer ${MAINT2}` ? !world.demoted.has('maintainer-two') : false;
      return { body: { id: 1, full_name: 'owner/name', permissions: { admin: false, maintain: maintains, push: maintains, triage: maintains, pull: true } } };
    }
    if (!target.startsWith(GH)) return { status: 404, body: { message: 'Not Found' } };
    const url = new URL(target.slice(GH.length), 'http://x');
    const p = decodeURIComponent(url.pathname);
    let m;
    if (method === 'GET' && (m = /^\/collaborators\/([^/]+)\/permission$/.exec(p))) {
      const maintains = ['maintainer-one', 'maintainer-two'].includes(m[1]) && !world.demoted.has(m[1]);
      return { body: { permission: maintains ? 'write' : 'read', role_name: maintains ? 'maintain' : 'read', user: { login: m[1] } } };
    }
    if (method === 'GET' && (m = /^\/issues\/(\d+)$/.exec(p))) {
      const n = Number(m[1]);
      if (!world.issues.includes(n)) return { status: 404, body: { message: 'Not Found' } };
      return { body: { number: n, title: `Issue ${n}`, state: 'open', user: { login: 'author-one' }, labels: [], body: '', comments: 0, html_url: `https://github.example.com/owner/name/issues/${n}`, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' } };
    }
    if (method === 'GET' && (m = /^\/issues\/(\d+)\/comments$/.exec(p))) return { body: world.comments[Number(m[1])] ?? [] };
    if (method === 'POST' && (m = /^\/issues\/(\d+)\/comments$/.exec(p))) {
      world.posted.push({ n: Number(m[1]), as: auth, body: JSON.parse(req.body).body });
      const who = auth === `Bearer ${MAINT2}` ? 'maintainer-two' : 'maintainer-one';
      return { status: 201, body: comment(Number(m[1]), who, JSON.parse(req.body).body) };
    }
    if (method === 'GET' && p === '/pulls') {
      if (url.searchParams.get('state') === 'open') return { body: [{ number: 40, title: 'Meals spec', state: 'open', draft: false, user: { login: 'maintainer-two' }, labels: [], head: { ref: 'spec/meals', sha: `${'a'.repeat(39)}1` }, base: { ref: 'main' }, html_url: 'https://github.example.com/owner/name/pull/40', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }] };
      return { body: world.pulls };
    }
    if (method === 'GET' && p === '/pulls/40/files') return { body: [{ filename: 'docs/specs/proposals/0040-meals.json', status: 'added', additions: 1, deletions: 0, changes: 1 }] };
    if (method === 'GET' && p === '/branches') return { body: [] };
    return { status: 404, body: { message: 'Not Found' } };
  };
  const routes = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? (req) => dispatch(key, req) : undefined) });

  const start = async (cfg, opts) => {
    const server = createCornfieldServer(cfg, opts);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    return { port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
  };

  beforeAll(async () => {
    fake = await fakeForge(routes);
    plainData = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-agent-api-plain-'));
    const open = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: plainData } });
    plain = await start(Object.assign(open, { forge: { type: 'github', url: fake.url, repo: 'owner/name' } }), { env: {} });
  });
  afterAll(async () => {
    await plain.close();
    await fake.close();
    fs.rmSync(plainData, { recursive: true, force: true });
  });
  beforeEach(async () => {
    clock += 3 * 60_000;
    world = { issues: [12, 13, 14, 15, 16], comments: {}, posted: [], pulls: [], demoted: new Set(), next: 9100 };
    fake.requests.length = 0;
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-agent-api-'));
    config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(config, { forge: { type: 'github', url: fake.url, repo: 'owner/name' }, publicUrl: PUBLIC });
    Object.assign(config.agents, { runners: ['runner-bot'], profiles: ['claude', 'local-qwen'] });
    srv = await start(config, { env: ENV, now: () => clock });
    cookie = await signedIn(srv.port, 'c-maint');
  });
  afterEach(async () => {
    await srv.close();
    fs.rmSync(data, { recursive: true, force: true });
  });

  const origin = () => `http://127.0.0.1:${srv.port}`;
  const page = (method, target, body, { as = cookie, headers = {}, port = srv.port } = {}) => {
    const text = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    return raw(port, method, target, {
      headers: { cookie: as || undefined, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }), ...headers },
      body: text,
    });
  };
  const mint = async (scope = 'agent', label = 'chat bot', days) => {
    const res = await page('POST', scope === 'agent' ? '/api/agent-tokens' : '/api/review-tokens', days === undefined ? { label } : { label, days });
    expect(res.status, res.text).toBe(201);
    return res.json;
  };
  /** The call of an outside caller: a bearer token and a JSON body, no cookie and no origin */
  const call = (token, body, { headers = {}, path: p = '/api/agent-requests', port = srv.port } = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return raw(port, 'POST', p, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers }, body: text });
  };
  const code = (extra = {}) => ({ kind: 'code', refs: { issue: 12 }, brief: 'Add the meals page.', ...extra });
  const rows = () => {
    const db = new DatabaseSync(path.join(data, 'cornfield.db'));
    const out = db.prepare('SELECT * FROM actions ORDER BY id').all();
    db.close();
    return out.map((r) => ({ ...r, request: JSON.parse(String(r.request)), answer: r.answer ? JSON.parse(String(r.answer)) : null }));
  };
  const agentRows = () => rows().filter((r) => r.action === 'agent-request');
  /** Moves past the repeat and flood windows between two calls of a test */
  const later = (ms = 70_000) => { clock += ms; };

  describe('a request with an agent token', () => {
    it('is posted as the token\'s owner with their own sign-in, and reads back with readRunBlocks', async () => {
      const { secret, token } = await mint('agent', 'chat bot');
      expect(secret).toMatch(/^cf_at_[A-Za-z0-9_-]{43}$/);
      expect(token).toMatchObject({ scope: 'agent', label: 'chat bot', state: 'active' });
      const res = await call(secret, code({ profile: 'claude' }));
      expect(res.status, res.text).toBe(201);
      expect(world.posted).toHaveLength(1);
      expect(world.posted[0]).toMatchObject({ n: 12, as: `Bearer ${MAINT}` }); // the owner's own sign-in, not a token of cornfield's
      const text = world.posted[0].body;
      expect(text.split('\n')[0].replaceAll(ZW, '')).toBe(`Asked for a code run \`${res.json.request.runId}\` on issue #12 with the profile claude (maintainer-one, in cornfield). Sent through the agent API with the token \`chat bot\`.`);
      const { blocks } = readRunBlocks(text);
      expect(blocks).toEqual([{ runId: res.json.request.runId, type: 'request', value: res.json.request }]);
      expect(res.json.request).toMatchObject({ version: 1, kind: 'code', profile: 'claude', refs: { issue: 12 }, requestedBy: 'maintainer-one', brief: 'Add the meals page.' });
      expect(text).not.toContain(secret);
      expect(JSON.stringify(res.json)).not.toContain(secret);
      // one row: who, the issue, the token's id and label, never the brief or the token
      expect(agentRows()).toEqual([expect.objectContaining({ login: 'maintainer-one', target: 'owner/name#12', status: 201, request: expect.objectContaining({ via: 'api', token: { id: token.id, label: 'chat bot' }, kind: 'code', briefChars: 19 }) })]);
      expect(JSON.stringify(rows())).not.toContain(secret);
      // and the dashboard sees the run
      const list = await page('GET', '/api/agent-runs');
      expect(list.json).toMatchObject({ ok: true, open: 1, maxOpen: 3, profiles: ['claude', 'local-qwen'] });
      expect(list.json.runs[0]).toMatchObject({ runId: res.json.request.runId, status: 'requested', via: 'api', profile: 'claude' });
    });

    it('starts from the profile\'s limits over the flat ones, and the caller\'s own win, from the API and from the dashboard alike (CF-27)', async () => {
      config.agents.limits = { minutes: 30, claude: { cost: 5, minutes: 60 } };
      const { secret } = await mint();
      const api = await call(secret, code({ profile: 'claude', limits: { cost: 1 } }));
      expect(api.status, api.text).toBe(201);
      expect(api.json.request.limits).toEqual({ minutes: 60, cost: 1 });
      later();
      const dash = await page('POST', '/api/agent-runs', code({ refs: { issue: 13 }, profile: 'claude' }));
      expect(dash.status, dash.text).toBe(201);
      expect(dash.json.request.limits).toEqual({ minutes: 60, cost: 5 });
      later();
      const flat = await call(secret, code({ refs: { issue: 14 }, profile: 'local-qwen', limits: { tokens: 1000 } }));
      expect(flat.json.request.limits).toEqual({ minutes: 30, tokens: 1000 });
    });

    it('marks the token as used', async () => {
      const { secret } = await mint();
      expect((await page('GET', '/api/agent-tokens')).json.tokens[0].lastUsed).toBeNull();
      clock += 1000;
      await call(secret, code());
      expect((await page('GET', '/api/agent-tokens')).json.tokens[0].lastUsed).toBe(new Date(clock).toISOString());
    });

    it('answers POST with an agent token; GET is the runners\' (a runner token), and anything else is 405', async () => {
      const { secret } = await mint();
      for (const method of ['PUT', 'DELETE']) {
        const res = await raw(srv.port, method, '/api/agent-requests', { headers: { authorization: `Bearer ${secret}` } });
        expect(res.status, method).toBe(405);
        expect(res.headers.allow).toBe('GET, HEAD, POST');
      }
      // an agent token is no runner's: the queue is 403 to it
      expect((await raw(srv.port, 'GET', '/api/agent-requests?state=queued', { headers: { authorization: `Bearer ${secret}` } })).status).toBe(403);
    });

    it('posts to the thread, and to the spec PR of a proposal', async () => {
      const { secret } = await mint();
      expect((await call(secret, { kind: 'brief', refs: { thread: 15 } })).status).toBe(201);
      later();
      expect((await call(secret, { kind: 'proposal', refs: { proposal: '0040-meals' } })).status).toBe(201);
      expect(world.posted.map((p) => p.n)).toEqual([15, 40]);
    });
  });

  describe('the two scopes', () => {
    it('keeps a review token out of the agent API (403, nothing posted) and an agent token out of the review API (403), each a row', async () => {
      const review = await mint('review', 'reviewer');
      const agent = await mint('agent', 'runner starter');
      const a = await call(review.secret, code());
      expect(a.status).toBe(403);
      expect(a.json).toMatchObject({ ok: false, code: 'forbidden' });
      expect(a.json.error).toMatch(/This is a review token\. Asking for a run takes an agent token/);
      later();
      const b = await call(agent.secret, { pull: 40, slug: '0040-meals', sha256: 'a'.repeat(64), verdict: 'approved' }, { path: '/api/reviews' });
      expect(b.status).toBe(403);
      expect(b.json.error).toMatch(/This is an agent token\. Reviews take a review token/);
      expect(world.posted).toEqual([]);
      expect(agentRows()[0]).toMatchObject({ login: 'maintainer-one', status: 403, request: expect.objectContaining({ reason: 'wrong-scope', scope: 'review', token: { id: review.token.id, label: 'reviewer' } }) });
      expect(rows().filter((r) => r.action === 'review')[0]).toMatchObject({ status: 403, request: expect.objectContaining({ reason: 'wrong-scope', scope: 'agent' }) });
      // a refused call is not a use
      expect((await page('GET', '/api/agent-tokens')).json.tokens[0].lastUsed).toBeNull();
      expect((await page('GET', '/api/review-tokens')).json.tokens[0].lastUsed).toBeNull();
    });

    it('lists, mints and revokes each scope on its own path', async () => {
      const review = await mint('review', 'reviewer');
      const agent = await mint('agent', 'runner starter');
      expect((await page('GET', '/api/review-tokens')).json.tokens.map((t) => [t.label, t.scope])).toEqual([['reviewer', 'review']]);
      expect((await page('GET', '/api/agent-tokens')).json.tokens.map((t) => [t.label, t.scope])).toEqual([['runner starter', 'agent']]);
      // a token of the other scope is no token to you on this path
      expect((await page('POST', `/api/review-tokens/${agent.token.id}/revoke`, '')).status).toBe(404);
      expect((await page('POST', `/api/agent-tokens/${review.token.id}/revoke`, '')).status).toBe(404);
      const revoked = await page('POST', `/api/agent-tokens/${agent.token.id}/revoke`, '');
      expect(revoked.json.token).toMatchObject({ state: 'revoked', scope: 'agent' });
      expect(rows().filter((r) => r.action === 'review-token').map((r) => r.request.scope)).toEqual([undefined, 'agent', undefined, 'agent', 'agent']);
    });

    it('does not let a token make tokens, and holds each scope to 20 live ones', async () => {
      const { secret } = await mint('agent');
      const res = await raw(srv.port, 'POST', '/api/agent-tokens', { headers: { authorization: `Bearer ${secret}`, origin: origin(), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{"label":"x"}' });
      expect([401, 403]).toContain(res.status);
      for (let i = 0; i < 19; i++) await mint('agent', `bot ${i}`);
      later();
      expect((await page('POST', '/api/agent-tokens', { label: 'one too many' })).status).toBe(409);
      expect((await page('POST', '/api/review-tokens', { label: 'a review one' })).status).toBe(201);
    });
  });

  describe('refusals, each one a row', () => {
    it('refuses a call with no token, and a session cookie is no substitute (401, nothing posted)', async () => {
      const text = JSON.stringify(code());
      const res = await raw(srv.port, 'POST', '/api/agent-requests', { headers: { cookie, origin: origin(), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }, body: text });
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
      expect((await call(null, code())).status).toBe(401);
      expect((await call(null, code(), { headers: { authorization: `Bearer cf_at_${'A'.repeat(43)}` } })).status).toBe(401);
      expect(world.posted).toEqual([]);
      expect(agentRows().map((r) => [r.login, r.status, r.request.reason])).toEqual([['(no token)', 401, 'no-token'], ['(no token)', 401, 'no-token'], ['(no token)', 401, 'unknown-token']]);
    });

    it('refuses a revoked token and an expired one (403)', async () => {
      const a = await mint('agent', 'one');
      await page('POST', `/api/agent-tokens/${a.token.id}/revoke`, '');
      const res = await call(a.secret, code());
      expect(res.status).toBe(403);
      expect(res.json.error).toMatch(/revoked/);
      const b = await mint('agent', 'two', 1);
      clock += 2 * DAY;
      cookie = await signedIn(srv.port, 'c-maint');
      const exp = await call(b.secret, code());
      expect(exp.status).toBe(403);
      expect(exp.json.error).toMatch(/expired/);
      expect(world.posted).toEqual([]);
    });

    it('refuses an owner who is not a maintainer now (403), and one with no live sign-in (401)', async () => {
      const { secret } = await mint();
      world.demoted.add('maintainer-one');
      const demoted = await call(secret, code());
      expect(demoted.status).toBe(403);
      expect(demoted.json.error).toMatch(/Only the repo's maintainers/);
      // learning it revoked the token: it stays revoked when the owner is a maintainer again
      world.demoted.clear();
      later();
      expect((await call(secret, code())).status).toBe(403);
      const fresh = (await mint('agent', 'second bot')).secret;
      later();
      expect((await page('POST', '/auth/sign-out', '')).status).toBe(303);
      const gone = await call(fresh, code());
      expect(gone.status, gone.text).toBe(401);
      expect(gone.json.error).toMatch(/no live sign-in/);
      expect(world.posted).toEqual([]);
      expect(agentRows().map((r) => r.status)).toEqual([403, 403, 401]);
    });

    it('refuses past the cap of three, and a second on the same issue, with the reason; force asks on purpose and never lifts the cap', async () => {
      const { secret } = await mint();
      for (const n of [12, 13, 14]) {
        expect((await call(secret, code({ refs: { issue: n } }))).status).toBe(201);
        later(6_000);
      }
      const fourth = await call(secret, code({ refs: { issue: 15 } }));
      expect(fourth).toMatchObject({ status: 409 });
      expect(fourth.json).toMatchObject({ ok: false, code: 'cap-reached' });
      expect(fourth.json.error).toMatch(/already has 3 open runs/);
      later(6_000);
      expect((await call(secret, code({ refs: { issue: 15 }, force: true }))).json.code).toBe('cap-reached');
      later();
      // free a place by stopping nothing: ask for a run on an issue that has one, with a cap of three that is full
      expect(world.posted).toHaveLength(3);
      expect(agentRows().filter((r) => r.status === 409)).toHaveLength(2);
    });

    it('refuses a second open run on one issue, and force makes another on purpose', async () => {
      const { secret } = await mint();
      expect((await call(secret, code())).status).toBe(201);
      later(6_000);
      const second = await call(secret, code());
      expect(second.status).toBe(409);
      expect(second.json.code).toBe('run-open');
      expect(second.json.error).toMatch(/issue #12 already has an open run: run-/);
      later(6_000);
      expect((await call(secret, code({ force: true }))).status).toBe(201);
      expect(world.posted).toHaveLength(2);
    });

    it('makes two runs of the same request under two profiles', async () => {
      const { secret } = await mint();
      const a = await call(secret, code({ profile: 'claude' }));
      later(6_000);
      const b = await call(secret, code({ profile: 'local-qwen' }));
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.json.request.runId).not.toBe(b.json.request.runId);
      later(6_000);
      expect((await page('GET', '/api/agent-runs')).json.runs.map((r) => r.profile).sort()).toEqual(['claude', 'local-qwen']);
    });

    it('refuses a profile that is not listed, bad JSON, a body that is not an object, and a body that is too large (400, 413)', async () => {
      const { secret } = await mint();
      expect((await call(secret, code({ profile: 'gpt-9' }))).status).toBe(400);
      expect((await call(secret, '{ nope')).status).toBe(400);
      expect((await call(secret, '[1]')).status).toBe(400);
      expect((await call(secret, JSON.stringify(code({ brief: 'x'.repeat(200 * 1024) })))).status).toBe(413);
      expect(world.posted).toEqual([]);
      expect(agentRows().map((r) => r.status)).toEqual([400, 400, 400, 413]);
      // the parser's words quote the body: the row must not
      expect(JSON.stringify(agentRows())).not.toContain('nope');
    });

    it('counts a flood: past six requests a minute it is 429 with Retry-After, and nothing more is written down', async () => {
      const { secret } = await mint();
      const statuses = [];
      for (let i = 0; i < 9; i++) {
        const res = await call(secret, code({ refs: { issue: 12 }, profile: 'nope' }));
        statuses.push(res.status);
        if (res.status === 429) expect(res.headers['retry-after']).toBeDefined();
      }
      expect(statuses.filter((s) => s === 400)).toHaveLength(6);
      expect(statuses.filter((s) => s === 429)).toHaveLength(3);
      expect(agentRows()).toHaveLength(6);
    });
  });

  describe('no credential in a request, by any route', () => {
    const bad = [
      ['a token key', { token: 'abc' }],
      ['a secret key in the refs', { refs: { issue: 12, secret: 'x' } }],
      ['a password key in the limits', { limits: { minutes: 5, password: 'x' } }],
      ['a forge token in the brief', { brief: `push with ${GHP}` }],
      ['an agent token in the brief', { brief: `use cf_at_${'A'.repeat(43)}` }],
      ['a review token in the profile', { profile: `cf_rt_${'A'.repeat(43)}` }],
      ['a bearer header in the brief', { brief: `Authorization: ${BEARER} ${LONG}` }],
    ];
    it.each(bad)('refuses %s through the API and through the button\'s route: 400, nothing posted, nothing kept', async (_name, extra) => {
      const { secret } = await mint();
      const viaApi = await call(secret, code(extra));
      expect(viaApi.status, viaApi.text).toBe(400);
      later();
      const viaPage = await page('POST', '/api/agent-runs', code(extra));
      expect(viaPage.status, viaPage.text).toBe(400);
      expect(world.posted).toEqual([]);
      expect((await page('GET', '/api/agent-runs')).json.runs).toEqual([]);
      const kept = JSON.stringify(rows());
      for (const bit of ['gh' + 'p_abc', 'cf_at_AAAA', 'cf_rt_AAAA', LONG]) expect(kept).not.toContain(bit);
    });

    it('refuses a credential in a report: the run does not take it up', async () => {
      const { secret } = await mint();
      const made = await call(secret, code());
      comment(12, 'runner-bot', `\`\`\`cornfield-run ${made.json.request.runId}\n{ "state": "working", "note": "${GHP}" }\n\`\`\``);
      const list = await page('GET', '/api/agent-runs?follow=1');
      expect(list.json.runs[0]).toMatchObject({ status: 'requested', report: null });
      expect(list.text).not.toContain('gh' + 'p_abc');
    });
  });

  describe('the dashboard\'s routes', () => {
    it('start a run from cornfield\'s own page, the same as the API (201), and show it', async () => {
      const res = await page('POST', '/api/agent-runs', code({ profile: 'claude' }));
      expect(res.status, res.text).toBe(201);
      expect(world.posted[0].as).toBe(`Bearer ${MAINT}`);
      expect(world.posted[0].body.split('\n')[0].replaceAll(ZW, '')).toBe(`Asked for a code run \`${res.json.request.runId}\` on issue #12 with the profile claude (maintainer-one, in cornfield).`);
      const one = await page('GET', `/api/agent-runs/${res.json.request.runId}`);
      expect(one.json.run).toMatchObject({ runId: res.json.request.runId, status: 'requested', requestedBy: 'maintainer-one', via: 'dashboard' });
      expect((await page('GET', '/api/agent-runs/run-01JC8Z3Q5M7VXK2RT9N4B6HDEF')).status).toBe(404);
      expect(agentRows()[0].request.via).toBeUndefined();
    });

    it('a same-site page cannot use up the maintainer\'s write budget: refused cross-origin writes are not counted (#237)', async () => {
      const text = JSON.stringify(code());
      for (let i = 0; i < 62; i++) {
        const res = await raw(srv.port, 'POST', '/api/agent-runs', { headers: { cookie, origin: 'https://sibling.example', 'sec-fetch-site': 'same-site', 'content-type': 'application/json', 'content-length': String(text.length) }, body: text });
        expect(res.status).toBe(403);
      }
      // one row for the minute, whatever the count, and the budget untouched
      expect(agentRows().map((r) => [r.status, r.request.refused, r.request.origin])).toEqual([[403, 'origin', 'https://sibling.example']]);
      const own = await page('POST', '/api/agent-runs', code());
      expect(own.status, own.text).toBe(201);
    });

    it('still count the maintainer\'s own changes from cornfield\'s page: past sixty a minute it is 429 and nothing more is written down', async () => {
      const before = rows().length;
      const statuses = [];
      for (let i = 0; i < 62; i++) statuses.push((await page('POST', '/api/agent-runs/run-01JC8Z3Q5M7VXK2RT9N4B6HDEF/stop', {})).status);
      expect(statuses.slice(0, 60).every((s) => s === 404)).toBe(true); // no such run: refused and written down
      expect(statuses.slice(60)).toEqual([429, 429]);
      expect(rows()).toHaveLength(before + 60);
    });

    it('refuse a POST that is not from cornfield\'s own page (not counted; a row at most once a minute), or not JSON (a row); GET needs nothing more than the sign-in', async () => {
      const text = JSON.stringify(code());
      const foreign = await raw(srv.port, 'POST', '/api/agent-runs', { headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json', 'content-length': String(text.length) }, body: text });
      expect(foreign.status).toBe(403);
      later();
      const noOrigin = await raw(srv.port, 'POST', '/api/agent-runs', { headers: { cookie, 'content-type': 'application/json', 'content-length': String(text.length) }, body: text });
      expect(noOrigin.status).toBe(403);
      later();
      const form = await page('POST', '/api/agent-runs', text, { headers: { 'content-type': 'text/plain' } });
      expect(form.status).toBe(415);
      expect(world.posted).toEqual([]);
      expect(agentRows().map((r) => r.status)).toEqual([403, 403, 415]); // a minute apart, so each refused for its origin left its row
      expect((await raw(srv.port, 'GET', '/api/agent-runs')).status).toBe(401); // no session: the guard
      expect((await page('PUT', '/api/agent-runs', text)).status).toBe(405);
    });

    it('are no way for a token: the guard reads cookies, never Authorization', async () => {
      const { secret } = await mint();
      const text = JSON.stringify(code());
      const res = await raw(srv.port, 'POST', '/api/agent-runs', { headers: { authorization: `Bearer ${secret}`, origin: origin(), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': String(text.length) }, body: text });
      expect([401, 403]).toContain(res.status);
      expect(world.posted).toEqual([]);
    });

    it('read a run\'s whole brief for Start again: a signed-in maintainer\'s session only, never a token, never past a demotion', async () => {
      const long = `${'b'.repeat(2400)} the end`;
      const made = await page('POST', '/api/agent-runs', code({ brief: long }));
      const id = made.json.request.runId;
      const listed = (await page('GET', '/api/agent-runs')).json.runs[0];
      expect(listed).toMatchObject({ runId: id, briefCut: true });
      expect(listed.brief).toHaveLength(2000);
      const read = await page('GET', `/api/agent-runs/${id}/brief`);
      expect(read.status, read.text).toBe(200);
      expect(read.json).toEqual({ ok: true, runId: id, brief: long });
      expect(read.headers['cache-control']).toBe('no-store');
      expect((await page('HEAD', `/api/agent-runs/${id}/brief`)).status).toBe(200);
      expect((await page('GET', '/api/agent-runs/run-01JC8Z3Q5M7VXK2RT9N4B6HDEF/brief')).status).toBe(404);
      expect((await page('POST', `/api/agent-runs/${id}/brief`, {})).status).toBe(405);
      // no session: the guard; a token in place of one: the guard reads cookies, never Authorization
      const noSession = await raw(srv.port, 'GET', `/api/agent-runs/${id}/brief`);
      expect(noSession.status).toBe(401);
      expect(noSession.text).not.toContain('the end');
      const { secret } = await mint();
      const byToken = await raw(srv.port, 'GET', `/api/agent-runs/${id}/brief`, { headers: { authorization: `Bearer ${secret}` } });
      expect([401, 403]).toContain(byToken.status);
      expect(byToken.text).not.toContain('the end');
      // no longer a maintainer: once the forge is asked again, the guard says no
      world.demoted.add('maintainer-one');
      clock += 16 * 60_000;
      const demoted = await page('GET', `/api/agent-runs/${id}/brief`);
      expect(demoted.status).toBe(403);
      expect(demoted.text).not.toContain('the end');
    });

    it('stop a run: a stop-requested block in the same place, as the maintainer who clicked, once', async () => {
      const made = await page('POST', '/api/agent-runs', code());
      const id = made.json.request.runId;
      later(6_000);
      const stopped = await page('POST', `/api/agent-runs/${id}/stop`, { note: 'Wrong approach.' });
      expect(stopped.status, stopped.text).toBe(200);
      expect(stopped.json.run).toMatchObject({ status: 'stop-requested', stopRequested: { by: 'maintainer-one' } });
      // the request, the stop request, and the run's status comment (issue #104: it holds no block)
      expect(world.posted).toHaveLength(3);
      expect(readRunBlocks(world.posted[1].body).blocks).toEqual([{ runId: id, type: 'stop-request', value: { state: 'stop-requested', note: 'Wrong approach.' } }]);
      expect(world.posted[2].body).toContain('**Run `' + id + '`: Stop requested**');
      expect(readRunBlocks(world.posted[2].body).blocks).toEqual([]);
      expect(world.posted[1].body.split('\n')[0]).toBe(`Asked run \`${id}\` to stop (maintainer-one, in cornfield).`);
      later(6_000);
      expect((await page('POST', `/api/agent-runs/${id}/stop`, {})).status).toBe(409);
      expect((await page('POST', `/api/agent-runs/${id}/stop`, { colour: 'red' })).status).toBe(400);
      expect(rows().filter((r) => r.action === 'agent-stop').map((r) => r.status)).toEqual([201, 409, 400]);
    });

    it('follow the forge on Refresh: a runner\'s report moves the state, one from a stranger is ignored and written down', async () => {
      const made = await page('POST', '/api/agent-runs', code());
      const id = made.json.request.runId;
      comment(12, 'stranger', formatRunComment(id, { state: 'done' }));
      comment(12, 'runner-bot', formatRunComment(id, { state: 'working', note: 'on it', url: 'https://ci.example.org/1' }));
      const quick = await page('GET', '/api/agent-runs');
      expect(quick.json.runs[0].status).toBe('requested'); // a plain list does not ask the forge
      const list = await page('GET', '/api/agent-runs?follow=1');
      expect(list.json.runs[0]).toMatchObject({ status: 'working', report: { state: 'working', by: 'runner-bot', note: 'on it', url: 'https://ci.example.org/1' } });
      const reports = rows().filter((r) => r.action === 'agent-report');
      expect(reports.map((r) => [r.login, r.answer.accepted]).sort()).toEqual([['runner-bot', true], ['stranger', false]]);
    });
  });

  describe('where it is held', () => {
    it('answers 421 to a foreign Host, and has no route without sign-in', async () => {
      const { secret } = await mint();
      const text = JSON.stringify(code());
      const res = await raw(srv.port, 'POST', '/api/agent-requests', { headers: { host: 'evil.example', authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'content-length': String(text.length) }, body: text });
      expect(res.status).toBe(421);
      const off = await call('cf_at_' + 'A'.repeat(43), code(), { port: plain.port });
      expect(off.status).toBe(403);
      expect(off.json.error).toMatch(/need sign-in/);
      expect((await page('GET', '/api/agent-runs', undefined, { as: undefined, port: plain.port })).status).toBe(403);
      expect(fs.existsSync(path.join(plainData, 'cornfield.db'))).toBe(false);
    });
  });
});
