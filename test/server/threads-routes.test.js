/**
 * @vitest-environment node
 *
 * The threads routes (server/forge-routes.js, server/forge-actions.js `serveIdea`) from the outside, against a fake GitHub on
 * loopback: the list and one thread are read as the signed-in maintainer and kept like the other forge answers; threads: false
 * answers 404; and "New idea" (POST /api/forge/threads) is walked through the same guard as the other actions: POST, signed in,
 * the flood ceiling, an audit row, the same origin, JSON, a maintainer now, not twice. No real forge, app or token.
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
import { ATTEMPTS_PER_MINUTE } from '../../server/throttle.js';
import { SAMPLE } from '../helpers.js';
import { fakeForge, recordings } from './fake-forge.js';

const ENV = { CORNFIELD_GITHUB_CLIENT_ID: 'test-client-id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: 'x'.repeat(40), CORNFIELD_HOOK_SECRET: 'h'.repeat(40) };
const PUBLIC = 'http://127.0.0.1:3350';
const MAINT = 'tok-maint';
const READER = 'tok-reader';
const GH = '/api/v3/repos/owner/name';
const PROPOSALS = 'docs/specs/proposals';

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

const user = { login: 'maintainer-one', id: 1001, html_url: 'https://x.test/maintainer-one' };
const gh = (n, extra = {}) => ({ number: n, title: `Idea ${n}`, state: 'open', user, labels: [{ name: 'idea' }], body: '', comments: 0, html_url: `https://x.test/issues/${n}`, created_at: '2026-11-01T09:00:00Z', updated_at: '2026-11-01T09:00:00Z', closed_at: null, ...extra });
const ghComment = (id, body, at) => ({ id, user, body, html_url: `https://x.test/c/${id}`, created_at: at, updated_at: at });

/** The world a thread test lives in: GitHub's answers, as a function of the request so a test can change them */
function worldRoutes(state) {
  const base = recordings('github');
  const route = (key) => {
    const [method, p] = key.split(' ');
    const url = new URL(p, 'http://x');
    const at = url.pathname.replace('/api/v3', '');
    if (key === 'POST /login/oauth/access_token') return (req) => ({ body: { access_token: req.body.includes('c-reader') ? READER : MAINT, token_type: 'bearer' } });
    if (key === 'GET /api/v3/user' || key === `GET ${GH}`) {
      return (req) => {
        if (state.demoted && key === `GET ${GH}`) return { body: { id: 1, full_name: 'owner/name', permissions: { admin: false, maintain: false, push: true, triage: false, pull: true } } };
        if (req.headers.authorization === `Bearer ${READER}`) return key.endsWith('/user') ? { body: { login: 'reader-two', id: 1002 } } : { body: { id: 1, full_name: 'owner/name', permissions: { admin: false, maintain: false, push: false, triage: false, pull: true } } };
        return base[`${method} ${at}`];
      };
    }
    if (method === 'GET' && at === '/repos/owner/name/issues') {
      return () => ({ body: url.searchParams.get('labels') === 'idea' || url.searchParams.get('labels') === 'rfc' ? state.issues.filter((i) => i.labels.some((l) => l.name === url.searchParams.get('labels'))) : state.issues });
    }
    if (method === 'POST' && at === '/repos/owner/name/issues') return (req) => state.createIssue(req);
    let m = /^\/repos\/owner\/name\/issues\/(\d+)$/.exec(at);
    if (method === 'GET' && m) return () => { const found = state.issues.find((i) => i.number === Number(m[1])); return found ? { body: found } : { status: 404, body: { message: 'Not Found' } }; };
    m = /^\/repos\/owner\/name\/issues\/(\d+)\/comments$/.exec(at);
    if (method === 'GET' && m) return () => ({ body: state.comments[m[1]] || [] });
    if (method === 'GET' && at === '/repos/owner/name/pulls') return () => ({ body: state.pulls });
    m = /^\/repos\/owner\/name\/pulls\/(\d+)$/.exec(at);
    if (method === 'GET' && m) return () => { const found = state.pulls.find((p) => p.number === Number(m[1])); return found ? { body: found } : { status: 404, body: { message: 'Not Found' } }; };
    m = /^\/repos\/owner\/name\/pulls\/(\d+)\/files$/.exec(at);
    if (method === 'GET' && m) return () => ({ body: state.files[m[1]] || [] });
    return base[`${method} ${at}`] ? () => base[`${method} ${at}`] : undefined;
  };
  return new Proxy({}, { get: (_, key) => (typeof key === 'string' ? route(key) : undefined) });
}

describe('the threads routes', () => {
  let fake;
  let data;
  let srv;
  let off;
  let offData;
  let clock = Date.parse('2026-11-05T12:00:00Z');
  let cookie;
  let readerCookie;
  const hookSent = [];
  const state = {};
  const reset = () => {
    state.issues = [gh(41, { body: 'See [[server/auth.js]]', comments: 2, updated_at: '2026-11-04T10:00:00Z' }), gh(42), gh(43, { labels: [{ name: 'bug' }] })];
    state.comments = { 41: [ghComment(9101, 'also [[core-server-auth]]', '2026-11-02T10:00:00Z'), ghComment(9102, 'again [[packages/web/src/cart.js]]', '2026-11-04T10:00:00Z')], 40: [ghComment(9201, 'on the spec', '2026-11-03T10:00:00Z')] };
    state.pulls = [{ number: 40, title: 'Spec: Meals', body: 'Thread: #41', state: 'open', draft: false, user, labels: [], head: { ref: 'spec/40', sha: 'a'.repeat(40) }, base: { ref: 'main' }, html_url: 'https://x.test/pull/40', created_at: '2026-11-03T09:00:00Z', updated_at: '2026-11-03T10:00:00Z', merged_at: null }];
    state.files = { 40: [{ filename: `${PROPOSALS}/0040-meals.json`, status: 'added', additions: 1, deletions: 0 }] };
    state.createIssue = (req) => ({ status: 201, body: gh(77, { title: JSON.parse(req.body).title, body: JSON.parse(req.body).body, labels: (JSON.parse(req.body).labels || []).map((name) => ({ name })) }) });
  };

  const start = async (config, opts) => {
    const server = createCornfieldServer(config, opts);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    return { port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
  };
  async function signedIn(port, code) {
    const started = await raw(port, 'GET', '/auth/start');
    const to = new URL(started.headers.location);
    const stateCookie = started.headers['set-cookie'].find((c) => c.startsWith('cornfield-oauth=')).split(';')[0];
    const back = await raw(port, 'GET', `/auth/callback?code=${code}&state=${to.searchParams.get('state')}`, { headers: { cookie: stateCookie } });
    expect(back.status, back.text).toBe(303);
    return back.headers['set-cookie'].find((c) => c.startsWith('cornfield=')).split(';')[0];
  }

  beforeAll(async () => {
    reset();
    fake = await fakeForge(worldRoutes(state));
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-threads-'));
    offData = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-threads-off-'));
    const forge = { type: 'github', url: fake.url, repo: 'owner/name' };
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(config, { forge: { ...forge }, publicUrl: PUBLIC, hooks: [{ url: 'https://chat.example.org/h', events: '*' }] });
    const hookFetch = async (url, init) => { hookSent.push(JSON.parse(init.body)); return new Response(null, { status: 200 }); };
    srv = await start(config, { env: ENV, now: () => clock, hookFetch, hookTimer: { setTimeout: () => 0, clearTimeout: () => {} } });
    const offConfig = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: offData } });
    Object.assign(offConfig, { forge: { ...forge }, publicUrl: PUBLIC, threads: false });
    off = await start(offConfig, { env: ENV, now: () => clock });
    cookie = await signedIn(srv.port, 'c-maint');
    readerCookie = await signedIn(srv.port, 'c-reader');
  });
  afterAll(async () => {
    await srv.close();
    await off.close();
    await fake.close();
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(offData, { recursive: true, force: true });
  });
  beforeEach(() => {
    clock += 120_000;
    state.demoted = false;
    reset();
    fake.requests.length = 0;
    const db = new DatabaseSync(path.join(data, 'cornfield.db'));
    db.exec('DELETE FROM forge_cache');
    db.close();
  });

  const get = (p, as = cookie, port = srv.port, headers = {}) => raw(port, 'GET', p, { headers: { cookie: as || undefined, ...headers } });
  const origin = () => `http://127.0.0.1:${srv.port}`;
  const post = (body, { headers = {}, as = cookie } = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return raw(srv.port, 'POST', '/api/forge/threads', { headers: { cookie: as || undefined, origin: origin(), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers }, body: text });
  };
  const rows = () => {
    const db = new DatabaseSync(path.join(data, 'cornfield.db'));
    const out = db.prepare("SELECT * FROM actions WHERE action = 'idea' ORDER BY id").all();
    db.close();
    return out.map((r) => ({ ...r, request: JSON.parse(String(r.request)), answer: r.answer ? JSON.parse(String(r.answer)) : null }));
  };
  const written = () => fake.requests.filter((r) => r.method === 'POST' && !r.url.startsWith('/login/'));

  describe('reading', () => {
    it('lists the ideas (by the label) and the spec PR\'s conversation, newest activity first, with the references they hold', async () => {
      const res = await get('/api/forge/threads');
      expect(res.status, res.text).toBe(200);
      expect(res.json).toMatchObject({ ok: true, repo: 'owner/name', label: 'idea' });
      expect(res.json.items.map((t) => [t.kind, t.number])).toEqual([['idea', 41], ['proposal', 40], ['idea', 42]]);
      expect(res.json.items[0]).toMatchObject({ refs: ['server/auth.js', 'core-server-auth', 'packages/web/src/cart.js'], proposals: [{ pull: 40, slug: '0040-meals' }] });
      expect(res.json.items[1]).toMatchObject({ kind: 'proposal', idea: 41, refs: [] });
      expect(res.text).not.toContain('also [[core');
      for (const r of fake.requests.filter((q) => q.url.startsWith('/api/v3/'))) expect(r.headers.authorization).toBe(`Bearer ${MAINT}`);
      expect(fake.requests.some((r) => /labels=idea/.test(r.url))).toBe(true);
      expect(res.headers.etag).toMatch(/^"[0-9a-f]{20}"$/);
    });

    it('answers a second ask from its cache, and a matching ETag with 304', async () => {
      const first = await get('/api/forge/threads');
      fake.requests.length = 0;
      const second = await get('/api/forge/threads', cookie, srv.port, { 'if-none-match': first.headers.etag });
      expect(second.status).toBe(304);
      expect(fake.requests.filter((r) => r.url.includes('/issues'))).toEqual([]);
    });

    it('reads one idea with its text first and its comments as written, and one proposal thread', async () => {
      const idea = await get('/api/forge/threads/41');
      expect(idea.status, idea.text).toBe(200);
      expect(idea.json.thread).toMatchObject({ kind: 'idea', number: 41, title: 'Idea 41', url: 'https://x.test/issues/41', proposals: [{ pull: 40, slug: '0040-meals' }] });
      expect(idea.json.thread.messages.map((m) => m.id)).toEqual(['opening', '9101', '9102']);
      expect(idea.json.thread.messages[1]).toMatchObject({ body: 'also [[core-server-auth]]', author: { login: 'maintainer-one' }, url: 'https://x.test/c/9101' });
      const proposal = await get('/api/forge/threads/40');
      expect(proposal.json.thread).toMatchObject({ kind: 'proposal', number: 40, slugs: ['0040-meals'], idea: 41 });
    });

    it('a number that is no thread is 404 in words, and a reader of the page sees only what the forge lets their token see', async () => {
      const none = await get('/api/forge/threads/43');
      expect([none.status, none.json.code]).toEqual([404, 'not-found']);
      expect(none.json.error).toMatch(/not a thread/);
      expect((await get('/api/forge/threads/999')).status).toBe(404);
      expect((await get('/api/forge/threads/0')).status).toBe(404);
    });

    it('needs sign-in, like the other forge reads', async () => {
      const res = await get('/api/forge/threads', null);
      expect(res.status).toBe(401);
    });

    it('tells the hooks about what it read: a message and a link are sent once, whoever looks again', async () => {
      hookSent.length = 0;
      await get('/api/forge/threads'); // the first look: silent
      await new Promise((r) => setTimeout(r, 50));
      expect(hookSent).toEqual([]);
      state.comments[41].push(ghComment(9103, 'new [[packages/web/src/cart.js]]', '2026-11-05T09:00:00Z'));
      state.issues[0] = gh(41, { body: 'See [[server/auth.js]]', comments: 3, updated_at: '2026-11-05T09:00:00Z' });
      await get('/api/forge/threads', cookie, srv.port, { 'cache-control': 'no-cache' });
      await get('/api/forge/threads', cookie, srv.port, { 'cache-control': 'no-cache' });
      await new Promise((r) => setTimeout(r, 50));
      expect(hookSent.map((e) => [e.event, e.thread, e.comment ?? null])).toEqual(expect.arrayContaining([['thread.message', 41, '9103'], ['thread.linked', 41, '9103']]));
      expect(hookSent.filter((e) => e.event === 'thread.message')).toHaveLength(1);
      expect(hookSent.find((e) => e.event === 'thread.linked').nodes).toEqual(['page-web-cart']);
    });

    it('with threads: false the routes are 404 and say so', async () => {
      const cookieOff = await signedIn(off.port, 'c-maint');
      for (const p of ['/api/forge/threads', '/api/forge/threads/41']) {
        const res = await get(p, cookieOff, off.port);
        expect([res.status, res.json.code], p).toEqual([404, 'not-found']);
        expect(res.json.error).toMatch(/threads: false/);
      }
      const made = await raw(off.port, 'POST', '/api/forge/threads', { headers: { cookie: cookieOff, origin: `http://127.0.0.1:${off.port}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{"title":"x"}' });
      expect(made.status).toBe(404);
      expect(fake.requests.some((r) => r.method === 'POST' && r.url.includes('/issues'))).toBe(false);
    });

    it('serves the page the label, or false', async () => {
      expect((await get('/cornfield/config.json')).json.threads).toEqual({ label: 'idea' });
      expect((await get('/cornfield/config.json', await signedIn(off.port, 'c-maint'), off.port)).json.threads).toBe(false);
    });
  });

  describe('New idea', () => {
    it('opens an issue with the label as the maintainer, with their own token, and writes it down without the text', async () => {
      const before = rows().length;
      const res = await post({ title: 'Meal plans', body: 'What if we planned the week?' });
      expect(res.status, res.text).toBe(201);
      expect(res.json).toMatchObject({ ok: true, action: 'idea', created: true, number: 77, issue: { number: 77, title: 'Meal plans', url: 'https://x.test/issues/77' } });
      const w = written();
      expect(w.map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${GH}/issues`]);
      expect(w[0].headers.authorization).toBe(`Bearer ${MAINT}`);
      expect(JSON.parse(w[0].body)).toEqual({ title: 'Meal plans', body: 'What if we planned the week?', labels: ['idea'] });
      expect(rows()).toHaveLength(before + 1);
      expect(rows().at(-1)).toMatchObject({ login: 'maintainer-one', action: 'idea', target: 'owner/name', status: 201, request: { action: 'idea', title: 'Meal plans', bodyLength: 28 } });
      expect(JSON.stringify(rows().at(-1))).not.toContain('planned the week');
    });

    it('a title alone is an idea: the text says there is none yet', async () => {
      const res = await post({ title: 'Just a title' });
      expect(res.status, res.text).toBe(201);
      expect(JSON.parse(written()[0].body).body).toBe('_No description yet._');
    });

    it('forgets the kept lists, so the new idea shows when the panel asks again', async () => {
      await get('/api/forge/threads');
      const db = new DatabaseSync(path.join(data, 'cornfield.db'));
      expect(db.prepare('SELECT count(*) AS n FROM forge_cache').get().n).toBeGreaterThan(0);
      db.close();
      await post({ title: 'Another one' });
      const after = new DatabaseSync(path.join(data, 'cornfield.db'));
      expect(after.prepare('SELECT count(*) AS n FROM forge_cache').get().n).toBe(0);
      after.close();
    });

    it('refuses without sign-in (401), from another site (403), as JSON only (415), with a body that is not an idea (400), a title that is missing, an extra key', async () => {
      expect((await post({ title: 'x' }, { as: null })).status).toBe(401);
      expect((await post({ title: 'x' }, { headers: { origin: 'https://evil.example.org', 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
      expect((await post({ title: 'x' }, { headers: { origin: undefined, 'sec-fetch-site': undefined } })).status).toBe(403);
      expect((await post('title=x', { headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(415);
      expect((await post('not json')).status).toBe(400);
      expect((await post('[1]')).status).toBe(400);
      const missing = await post({ body: 'only text' });
      expect([missing.status, missing.json.code]).toEqual([400, 'invalid']);
      expect((await post({ title: 'x', labels: ['a'] })).status).toBe(400);
      expect((await post({ title: 'x'.repeat(300) })).status).toBe(400);
      expect(written()).toEqual([]);
    });

    it('refuses a text that is far too long without reading all of it', async () => {
      const res = await post(JSON.stringify({ title: 'x', body: 'b'.repeat(200 * 1024) }));
      expect([res.status, res.json && res.json.code]).toEqual([413, 'invalid']);
      expect(written()).toEqual([]);
    });

    it('refuses someone who does not maintain the repo, asked of the forge now', async () => {
      const res = await post({ title: 'Mine' }, { as: readerCookie });
      // The guard in front of every /api/forge route turns a signed-in reader away before the route is reached
      expect(res.status).toBe(403);
      expect(written()).toEqual([]);
    });

    it('asks the forge again who may do this: a maintainer removed since signing in is refused (403), with the refusal written down', async () => {
      state.demoted = true;
      const res = await post({ title: 'Too late' });
      expect([res.status, res.json.code]).toEqual([403, 'forbidden']);
      expect(res.json.error).toMatch(/Only the repo's maintainers open ideas/);
      expect(written()).toEqual([]);
      expect(rows().at(-1)).toMatchObject({ login: 'maintainer-one', action: 'idea', status: 403 });
    });

    it('is not asked twice in a row for the same title, but another title is fine', async () => {
      const first = await post({ title: 'Twice' });
      expect(first.status).toBe(201);
      const again = await post({ title: 'Twice' });
      expect([again.status, again.json.code]).toEqual([429, 'rate-limited']);
      expect(again.headers['retry-after']).toBeTruthy();
      expect((await post({ title: 'Other' })).status).toBe(201);
      expect(written()).toHaveLength(2);
    });

    it('says the forge\'s refusal in words and writes it down', async () => {
      state.createIssue = () => ({ status: 403, body: { message: 'Resource not accessible' } });
      const res = await post({ title: 'Nope' });
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ ok: false, code: 'forbidden' });
      expect(rows().at(-1)).toMatchObject({ action: 'idea', status: 403 });
    });

    it('counts every attempt against the ceiling before anything is written down', async () => {
      const before = rows().length;
      let last;
      for (let i = 0; i < ATTEMPTS_PER_MINUTE + 5; i++) last = await post({ title: '' });
      expect(last.status).toBe(429);
      // the refused ones past the ceiling left no row
      expect(rows().length - before).toBe(ATTEMPTS_PER_MINUTE);
      expect(written()).toEqual([]);
    });

    it('a same-site page cannot use up the maintainer\'s write budget: refused cross-origin ideas are not counted (#237), one row a minute', async () => {
      const before = rows().length;
      for (let i = 0; i < ATTEMPTS_PER_MINUTE + 5; i++) {
        const res = await post({ title: 'From a sibling' }, { headers: { origin: 'https://sibling.example.org', 'sec-fetch-site': 'same-site' } });
        expect([res.status, res.json.code]).toEqual([403, 'forbidden']);
      }
      expect(written()).toEqual([]);
      expect((await post({ title: 'Mine' })).status).toBe(201);
      expect(rows().slice(before).filter((r) => r.status === 403).map((r) => r.request)).toEqual([{ action: 'idea', refused: 'origin', origin: 'https://sibling.example.org', site: 'same-site' }]);
    });
  });
});
