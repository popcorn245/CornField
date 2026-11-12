/**
 * @vitest-environment node
 *
 * A listed sibling origin (spec 0011 D9, server/embed.js), from the outside: a running server with sign-in, a fake GitHub that holds one open
 * spec PR, and `embed.origins` listing `https://tasks.example.com`. Held here:
 *
 *   - reads: on the explicit list of routes, and only there, a listed origin (exactly) gets its own origin back, credentials allowed, `Vary: Origin`
 *     and the headers the explorer reads; the open theme routes carry no `Allow-Credentials`; nothing else (tokens, runs, the other forge routes) does
 *   - the preflight: answered for the methods and headers a route needs and no others; refused (no CORS header) for anything else
 *   - writes: the review PUT and the Undo of a landing are let in for a listed origin with `Sec-Fetch-Site: same-site` (or none); every other
 *     write, and every other origin, is refused exactly as a stranger's is
 *   - the page's own headers (CSP, `frame-ancestors 'none'`, `X-Frame-Options: DENY`), the Host check (421) and the session cookie do not change
 *   - with no origin listed, every response's headers are what they were without the key
 *   - signing in and returning: `/auth/start?returnTo=` ends on this server or on a listed origin, and on nothing else
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { createCornfieldServer } from '../../server/server.js';
// @ts-expect-error plain JS module, no declarations
import { loadConfig } from '../../core/config.js';
import { SAMPLE } from '../helpers.js';
import { fakeForge, recordings } from './fake-forge.js';

const ENV = { CORNFIELD_GITHUB_CLIENT_ID: 'test-client-id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: 'x'.repeat(40) };
const PUBLIC = 'http://127.0.0.1:3350';
const LISTED = 'https://tasks.example.com';
const SECOND = 'http://tasks.corn.localhost:3711';
const MAINT = 'tok-maint';
const API = '/api/v3';
const GH = `${API}/repos/owner/name`;
const SLUG = '0040-meals';
const PATH = `docs/specs/proposals/${SLUG}.json`;
const HEAD = `${'a'.repeat(39)}1`;
const proposalOf = (title) => `${JSON.stringify({ version: 1, title, summary: 'Plan the week.', nodes: { add: [{ id: 'page-meals', label: '/meals', type: 'page', parent: 'app-a' }] } }, null, 2)}\n`;
const SRC = 'source=pull%2F40';

function raw(port, method, target, { headers = {}, rawHeaders, body } = {}) {
  const sent = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: rawHeaders ?? sent, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode || 0, headers: res.headers, rawHeaders: res.rawHeaders, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const world = { posted: [], merges: [], comments: [], checks: [{ id: 101, name: 'test', status: 'in_progress', conclusion: null, html_url: 'https://ci.example.test/test' }] };
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
  const pull = { number: 40, title: 'Meals spec', state: 'open', draft: false, user: { login: 'agent-four', html_url: 'https://github.example.com/agent-four' }, labels: [], head: { ref: 'spec/meals', sha: HEAD }, base: { ref: 'main' }, html_url: 'https://github.example.com/owner/name/pull/40', created_at: '2026-11-03T08:00:00Z', updated_at: '2026-11-03T08:30:00Z', merged_at: null };
  if (method === 'GET' && p === '/pulls/40') return { body: { ...pull, mergeable_state: 'clean' } };
  if (method === 'GET' && p === '/pulls' && url.searchParams.get('state') === 'open') return { body: [pull] };
  if (method === 'GET' && p === '/pulls/40/commits') return { body: [] };
  if (method === 'GET' && p === '/pulls/40/files') return { body: [{ filename: PATH, status: 'modified', additions: 1, deletions: 0, changes: 1 }] };
  if (method === 'GET' && p === '/issues/40/comments') return { body: world.comments };
  if (method === 'POST' && p === '/issues/40/comments') {
    const text = JSON.parse(req.body).body;
    world.posted.push({ as: auth, body: text });
    const c = { id: 9100 + world.comments.length, user: { login: 'maintainer-one', html_url: 'https://github.example.com/maintainer-one' }, body: text, html_url: `https://github.example.com/owner/name/pull/40#issuecomment-${9100 + world.comments.length}`, created_at: '2026-11-03T09:00:00Z', updated_at: '2026-11-03T09:00:00Z' };
    world.comments.push(c);
    return { status: 201, body: c };
  }
  if (method === 'GET' && p.startsWith('/contents/')) {
    const text = url.searchParams.get('ref') !== HEAD ? undefined : p.slice('/contents/'.length) === PATH ? proposalOf('Meals') : undefined;
    return text === undefined ? { status: 404, body: { message: 'Not Found' } } : { headers: { 'content-type': 'application/vnd.github.raw; charset=utf-8' }, body: text };
  }
  if (method === 'GET' && /^\/commits\/[0-9a-f]+\/check-runs$/.test(p)) return { body: { check_runs: world.checks } };
  if (method === 'GET' && /^\/commits\/[0-9a-f]+\/status$/.test(p)) return { body: { statuses: [] } };
  if (method === 'GET' && p === '/actions/runs') return { body: { workflow_runs: [] } };
  if (method === 'PUT' && p === '/pulls/40/merge') { world.merges.push(JSON.parse(req.body)); return { body: { sha: 'f'.repeat(40), merged: true } }; }
  return { status: 404, body: { message: 'Not Found' } };
};
const routes = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? (req) => dispatch(key, req) : undefined) });

/** The timers of the landing, kept so a pending landing is waiting and never fires on its own */
const timers = [];
const timer = { setTimeout: () => { const t = { done: false }; timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.done = true; } };
const until = async (what, fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};
/** The server's clock, wound by hand a few seconds before each write, so the repeat and flood limits (server/throttle.js) never answer for it */
let clock = Date.now();
const tick = () => { clock += 6000; };

describe('a listed sibling origin', () => {
  let fake;
  const dirs = [];
  const closers = [];

  /** @param {object | undefined} embed the config's `embed` (undefined: the key is not there) */
  async function boot(embed, extra = {}) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-embed-'));
    dirs.push(data);
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(config, { forge: { type: 'github', url: fake.url, repo: 'owner/name' }, publicUrl: PUBLIC, approveLands: true, ...extra });
    if (embed === undefined) delete config.embed; else config.embed = embed;
    const server = createCornfieldServer(config, { env: ENV, landTimer: timer, now: () => clock });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
    const started = await raw(port, 'GET', '/auth/start');
    const to = new URL(started.headers.location);
    const stateCookie = started.headers['set-cookie'].find((c) => c.startsWith('cornfield-oauth=')).split(';')[0];
    const back = await raw(port, 'GET', `/auth/callback?code=c-maint&state=${to.searchParams.get('state')}`, { headers: { cookie: stateCookie } });
    expect(back.status, back.text).toBe(303);
    const cookie = back.headers['set-cookie'].find((c) => c.startsWith('cornfield=')).split(';')[0];
    return { port, cookie, config, sessionSetCookie: back.headers['set-cookie'].find((c) => c.startsWith('cornfield=')) };
  }

  beforeAll(async () => { fake = await fakeForge(routes); });
  afterAll(async () => {
    for (const close of closers) await close();
    await fake.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  const CORS = (h) => Object.keys(h).filter((k) => k.startsWith('access-control-'));
  const READS = [
    '/cornfield/config.json', '/topology.json', '/topology.cloud.json', '/proposals', `/proposals/${SLUG}.json?${SRC}`, `/proposals/${SLUG}/decision?${SRC}`,
    `/proposals/${SLUG}/review?${SRC}`, `/proposals/${SLUG}/mockups?${SRC}`, '/api/forge/pulls/40',
  ];
  const EXPOSED = 'X-Proposal-Sha256, X-Proposal-Source, X-Proposals-Forge-Error';

  describe('reads', () => {
    let s;
    beforeAll(async () => { s = await boot({ origins: [LISTED, SECOND] }); });
    const get = (target, headers = {}) => raw(s.port, 'GET', target, { headers: { cookie: s.cookie, ...headers } });

    it('answers a listed origin with exactly that origin, credentials, Vary and the headers the explorer reads, on every route of the list', async () => {
      for (const target of READS) {
        for (const origin of [LISTED, SECOND]) {
          const res = await get(target, { origin, 'sec-fetch-site': 'same-site' });
          expect(res.status, `${target} ${res.text}`).toBeLessThan(500);
          expect(res.status, target).not.toBe(421);
          expect(res.headers['access-control-allow-origin'], target).toBe(origin);
          expect(res.headers['access-control-allow-credentials'], target).toBe('true');
          expect(res.headers['access-control-expose-headers'], target).toBe(EXPOSED);
          expect(res.headers.vary, target).toMatch(/(^|, )Origin(,|$)/);
          expect(CORS(res.headers).sort(), target).toEqual(['access-control-allow-credentials', 'access-control-allow-origin', 'access-control-expose-headers']);
        }
      }
    });

    it('really answers: the proposal carries the headers a page reads, and the data is the maintainer\'s', async () => {
      const res = await get(`/proposals/${SLUG}.json?${SRC}`, { origin: LISTED, 'sec-fetch-site': 'same-site' });
      expect(res.status, res.text).toBe(200);
      expect(res.headers['x-proposal-sha256']).toMatch(/^[0-9a-f]{64}$/);
      expect(res.headers['x-proposal-source']).toBe('pull%2F40');
      expect((await get('/cornfield/config.json', { origin: LISTED })).json.signIn).toEqual({ login: 'maintainer-one' });
    });

    it('never says `*`, and a refusal can be read too (a 401 with no session, a 404)', async () => {
      const signedOut = await raw(s.port, 'GET', '/topology.json', { headers: { origin: LISTED } });
      expect(signedOut.status).toBe(401);
      expect(signedOut.headers['access-control-allow-origin']).toBe(LISTED);
      expect(signedOut.headers['access-control-allow-credentials']).toBe('true');
      const missing = await get('/proposals/no-such.json', { origin: LISTED });
      expect(missing.status).toBe(404);
      expect(missing.headers['access-control-allow-origin']).toBe(LISTED);
      for (const target of READS) expect((await get(target, { origin: LISTED })).headers['access-control-allow-origin']).not.toBe('*');
    });

    it('gives a request with no Origin, and one from an origin that is not listed, no CORS header, and says the answer varies by Origin', async () => {
      const lookalikes = ['https://evil.example', 'https://tasks.example.com.evil.test', 'http://tasks.example.com', 'https://tasks.example.com:8443', 'HTTPS://TASKS.EXAMPLE.COM', 'null', 'https://tasks.example.com/', `${LISTED}, https://evil.example`, '', PUBLIC];
      for (const target of READS) {
        for (const origin of [undefined, ...lookalikes]) {
          const res = await get(target, { origin });
          expect(CORS(res.headers), `${target} Origin=${origin}`).toEqual([]);
          expect(res.headers.vary, target).toMatch(/(^|, )Origin(,|$)/);
        }
      }
      // two Origin headers, one of them listed: not listed
      const two = await raw(s.port, 'GET', '/topology.json', { rawHeaders: ['Host', `127.0.0.1:${s.port}`, 'Cookie', s.cookie, 'Origin', LISTED, 'Origin', LISTED] });
      expect(CORS(two.headers)).toEqual([]);
    });

    it('gives no CORS header to any route off the list, listed origin or not', async () => {
      const off = [
        '/', '/index.html', '/healthz', '/auth/me', '/explorer/main.js', '/core/schema.js', '/manifest.webmanifest', '/topology-fixture.json?nodes=50',
        '/api/review-tokens', '/api/agent-tokens', '/api/agent-runs', '/api/agent-requests', '/api/forge/pulls', '/api/forge/issues', '/api/forge/pulls/40/landing', '/api/forge/pulls/40/build',
        '/api/forge/threads', '/api/forge/work', '/api/forge/pulls/40/merge', '/api/forge/pulls/040', '/api/forge/pulls/40/', `/proposals/${SLUG}/mockups/1?${SRC}`, `/proposals/${SLUG}/mockups/`,
        '/proposals/', `/proposals/${SLUG}`, `/proposals/${SLUG}.json/x`, '/cornfield/house.json', '/cornfield/brand/logo.svg', '/cornfield/theme', '/cornfield/theme/', '/repo/package.json',
      ];
      for (const target of off) {
        const res = await get(target, { origin: LISTED, 'sec-fetch-site': 'same-site' });
        expect(CORS(res.headers), target).toEqual([]);
        expect(res.headers.vary ?? '', target).not.toMatch(/Origin/);
      }
    });

    it('gives a method a route does not have no CORS header', async () => {
      for (const [method, target] of [['DELETE', `/proposals/${SLUG}/review?${SRC}`], ['POST', '/topology.json'], ['PUT', '/proposals'], ['PATCH', '/api/forge/pulls/40'], ['GET', '/api/forge/pulls/40/landing/cancel'], ['PUT', '/api/forge/pulls/40/landing/cancel']]) {
        const res = await raw(s.port, method, target, { headers: { cookie: s.cookie, origin: LISTED, 'sec-fetch-site': 'same-site', 'content-length': '0' } });
        expect(CORS(res.headers), `${method} ${target}`).toEqual([]);
      }
    });
  });

  describe('the preflight', () => {
    let s;
    beforeAll(async () => { s = await boot({ origins: [LISTED] }); });
    const preflight = (target, asked = {}, origin = LISTED) => raw(s.port, 'OPTIONS', target, { headers: { origin, 'access-control-request-method': 'GET', ...asked } });
    const REVIEW = `/proposals/${SLUG}/review?${SRC}`;

    it('answers the review PUT with the methods and the one header it needs, before the guard (no cookie)', async () => {
      const res = await preflight(REVIEW, { 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' });
      expect(res.status).toBe(204);
      expect(res.headers).toMatchObject({
        'access-control-allow-origin': LISTED, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, HEAD, PUT',
        'access-control-allow-headers': 'Content-Type', 'access-control-max-age': '600',
      });
      expect(res.headers.vary).toBe('Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
      expect(res.text).toBe('');
    });

    it('answers the Undo of a landing with POST and Content-Type', async () => {
      const res = await preflight('/api/forge/pulls/40/landing/cancel', { 'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type' });
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-methods']).toBe('POST');
      expect(res.headers['access-control-allow-headers']).toBe('Content-Type');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('answers a read with GET and HEAD only and no request headers', async () => {
      for (const target of ['/proposals', `/proposals/${SLUG}.json`, '/api/forge/pulls/40', '/topology.json']) {
        const res = await preflight(target);
        expect(res.status, target).toBe(204);
        expect(res.headers['access-control-allow-methods'], target).toBe('GET, HEAD');
        expect(res.headers['access-control-allow-headers'], target).toBeUndefined();
      }
      expect((await preflight('/topology.json', { 'access-control-request-headers': 'content-type' })).headers['access-control-allow-origin']).toBeUndefined();
    });

    it('refuses (no CORS header) a method or a header the route does not take, an unlisted origin, a route off the list and a request that is no preflight', async () => {
      const none = (res, why) => { expect(CORS(res.headers), why).toEqual([]); expect(res.status, why).not.toBe(204); };
      none(await preflight(REVIEW, { 'access-control-request-method': 'DELETE' }), 'DELETE review');
      none(await preflight(REVIEW, { 'access-control-request-method': 'POST' }), 'POST review');
      none(await preflight(REVIEW, { 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type, authorization' }), 'authorization');
      none(await preflight(REVIEW, { 'access-control-request-method': 'PUT', 'access-control-request-headers': 'x-anything' }), 'x-anything');
      none(await preflight('/api/forge/pulls/40/landing/cancel', { 'access-control-request-method': 'PUT' }), 'PUT cancel');
      none(await preflight('/proposals', { 'access-control-request-method': 'POST' }), 'POST list');
      none(await preflight(REVIEW, { 'access-control-request-method': 'PUT' }, 'https://evil.example'), 'unlisted');
      none(await preflight(REVIEW, { 'access-control-request-method': 'PUT' }, 'https://tasks.example.com.evil.test'), 'lookalike');
      for (const target of ['/api/review-tokens', '/api/agent-tokens', '/api/agent-runs', '/api/forge/pulls', '/api/forge/pulls/40/merge', '/api/forge/pulls/40/landing', `/proposals/${SLUG}/mockups/1`, '/']) {
        none(await preflight(target, { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }), target);
        none(await preflight(target), `${target} GET`);
      }
      none(await raw(s.port, 'OPTIONS', REVIEW, { headers: { origin: LISTED } }), 'no Access-Control-Request-Method');
      none(await raw(s.port, 'OPTIONS', REVIEW, { headers: { 'access-control-request-method': 'PUT' } }), 'no Origin');
    });
  });

  describe('writes', () => {
    let s;
    const REVIEW = `/proposals/${SLUG}/review?${SRC}`;
    const note = (text) => JSON.stringify({ verdict: 'notes', note: text, edits: [] });
    const put = (headers, body = note(`looks fine ${clock}`), { cookie = true, target = REVIEW } = {}) => { tick(); return raw(s.port, 'PUT', target, {
      headers: { ...(cookie ? { cookie: s.cookie } : {}), 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers }, body,
    }); };
    const cancel = (headers, { cookie = true } = {}) => { tick(); return raw(s.port, 'POST', '/api/forge/pulls/40/landing/cancel', {
      headers: { ...(cookie ? { cookie: s.cookie } : {}), 'content-type': 'application/json', 'content-length': '2', ...headers }, body: '{}',
    }); };
    beforeAll(async () => { s = await boot({ origins: [LISTED, SECOND] }); });

    it('lets a listed origin decide a review: same-site, or no Sec-Fetch-Site; the answer can be read', async () => {
      world.posted.length = 0;
      for (const [origin, site] of [[LISTED, 'same-site'], [SECOND, 'same-site'], [LISTED, undefined]]) {
        const res = await put({ origin, 'sec-fetch-site': site });
        expect(res.status, `${origin} ${site} ${res.text}`).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBe(origin);
        expect(res.headers['access-control-allow-credentials']).toBe('true');
      }
      expect(world.posted).toHaveLength(3);
      expect(world.posted[0].body).toContain('looks fine');
    });

    it('refuses the review PUT: an origin that is not listed or not exact, a Sec-Fetch-Site that is not same-site, no Origin, a foreign Host', async () => {
      world.posted.length = 0;
      const refused = [
        ['cross-site', { origin: LISTED, 'sec-fetch-site': 'cross-site' }],
        ['same-origin', { origin: LISTED, 'sec-fetch-site': 'same-origin' }],
        ['none', { origin: LISTED, 'sec-fetch-site': 'none' }],
        ['Same-Site case', { origin: LISTED, 'sec-fetch-site': 'Same-Site' }],
        ['no Origin, same-site', { 'sec-fetch-site': 'same-site' }],
        ['no Origin, no site', {}],
        ['unlisted', { origin: 'https://evil.example', 'sec-fetch-site': 'same-site' }],
        ['unlisted, no site', { origin: 'https://evil.example' }],
        ['lookalike suffix', { origin: 'https://tasks.example.com.evil.test', 'sec-fetch-site': 'same-site' }],
        ['lookalike prefix', { origin: 'https://xtasks.example.com', 'sec-fetch-site': 'same-site' }],
        ['other port', { origin: 'https://tasks.example.com:8443', 'sec-fetch-site': 'same-site' }],
        ['other scheme', { origin: 'http://tasks.example.com', 'sec-fetch-site': 'same-site' }],
        ['upper case', { origin: 'HTTPS://TASKS.EXAMPLE.COM', 'sec-fetch-site': 'same-site' }],
        ['trailing slash', { origin: `${LISTED}/`, 'sec-fetch-site': 'same-site' }],
        ['null', { origin: 'null', 'sec-fetch-site': 'same-site' }],
        ['empty', { origin: '', 'sec-fetch-site': 'same-site' }],
        ['two origins in one', { origin: `${LISTED}, https://evil.example`, 'sec-fetch-site': 'same-site' }],
        ['a Referer is no Origin', { referer: `${LISTED}/page`, 'sec-fetch-site': 'same-site' }],
      ];
      for (const [why, headers] of refused) {
        const res = await put(headers);
        expect(res.status, `${why}: ${res.text}`).toBe(403);
        expect(world.posted, why).toEqual([]);
      }
      // a listed origin on a foreign Host: 421, before anything
      const rebound = await put({ origin: LISTED, 'sec-fetch-site': 'same-site', host: 'evil.example' });
      expect(rebound.status).toBe(421);
      const two = await raw(s.port, 'PUT', REVIEW, { rawHeaders: ['Host', `127.0.0.1:${s.port}`, 'Cookie', s.cookie, 'Origin', LISTED, 'Origin', LISTED, 'Sec-Fetch-Site', 'same-site', 'Content-Type', 'application/json', 'Content-Length', '2'], body: '{}' });
      expect(two.status).toBe(403);
      // and a listed origin without the session is no maintainer
      expect((await put({ origin: LISTED, 'sec-fetch-site': 'same-site' }, note('x'), { cookie: false })).status).toBe(401);
      expect(world.posted).toEqual([]);
    });

    it('still lets the server\'s own page decide, as before', async () => {
      world.posted.length = 0;
      const own = `http://127.0.0.1:${s.port}`;
      expect((await put({ origin: own, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
      expect((await put({ origin: own, 'sec-fetch-site': 'same-site' })).status).toBe(403);
      expect((await put({ origin: own, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
      expect(world.posted).toHaveLength(1);
    });

    it('lets a listed origin Undo an approval\'s hold, and refuses the same cases', async () => {
      world.posted.length = 0;
      const own = `http://127.0.0.1:${s.port}`;
      const approved = await put({ origin: own, 'sec-fetch-site': 'same-origin' }, JSON.stringify({ verdict: 'approved', note: '', edits: [] }));
      expect(approved.status, approved.text).toBe(200);
      // a hold is waiting (a check is still running)
      await until('a landing is waiting', () => timers.some((t) => !t.done));
      const seen = await raw(s.port, 'GET', '/api/forge/pulls/40/landing', { headers: { cookie: s.cookie, origin: own, 'sec-fetch-site': 'same-origin' } });
      expect(seen.json).toMatchObject({ enabled: true, landing: { pull: 40 } });
      // refused first: nothing is cancelled
      for (const headers of [{ origin: LISTED, 'sec-fetch-site': 'cross-site' }, { origin: LISTED, 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'same-site' }, { origin: 'https://evil.example', 'sec-fetch-site': 'same-site' }, { origin: 'https://tasks.example.com:8443', 'sec-fetch-site': 'same-site' }, {}]) {
        const res = await cancel(headers);
        expect(res.status, JSON.stringify(headers)).toBe(403);
      }
      expect((await cancel({ origin: LISTED, 'sec-fetch-site': 'same-site' }, { cookie: false })).status).toBeGreaterThanOrEqual(401);
      expect((await raw(s.port, 'GET', '/api/forge/pulls/40/landing', { headers: { cookie: s.cookie } })).json.landing).not.toBeNull();
      const res = await cancel({ origin: LISTED, 'sec-fetch-site': 'same-site' });
      expect(res.status, res.text).toBe(200);
      expect(res.json).toMatchObject({ ok: true, cancelled: true, number: 40 });
      expect(res.headers['access-control-allow-origin']).toBe(LISTED);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect((await raw(s.port, 'GET', '/api/forge/pulls/40/landing', { headers: { cookie: s.cookie } })).json.landing).toBeNull();
    });

    it('refuses every other write from a listed origin exactly as a stranger\'s is, and does nothing', async () => {
      world.posted.length = 0;
      world.merges.length = 0;
      const json = (body) => ({ body: JSON.stringify(body), type: 'application/json' });
      const writes = [
        ['POST', '/api/review-tokens', json({ label: 'bot' })], ['POST', '/api/agent-tokens', json({ label: 'bot' })], ['DELETE', '/api/review-tokens/1', {}], ['DELETE', '/api/agent-tokens/1', {}],
        ['POST', '/api/agent-runs', json({ kind: 'code' })], ['POST', '/api/agent-runs/01ABC/stop', json({})], ['POST', '/api/forge/pulls/40/merge', json({ sha: HEAD })], ['POST', '/api/forge/pulls/40/rerun', json({})],
        ['POST', '/api/forge/pulls/40/build', json({})], ['POST', '/api/forge/issues/9/spec', json({})], ['POST', '/api/forge/release-drafts', json({ tag: 'v1' })], ['POST', '/api/forge/threads', json({ title: 'x', body: 'y' })],
        ['POST', '/auth/sign-out', {}], ['PUT', '/proposals/x', json({})], ['POST', `/proposals/${SLUG}/review?${SRC}`, json({})], ['POST', '/api/forge/pulls/40/landing', json({})],
      ];
      for (const [method, target, { body, type } = {}] of writes) {
        const ask = (origin, site) => raw(s.port, method, target, { headers: { cookie: s.cookie, origin, 'sec-fetch-site': site, ...(body ? { 'content-type': type, 'content-length': String(Buffer.byteLength(body)) } : { 'content-length': '0' }) }, body });
        const stranger = await ask('https://evil.example', 'cross-site');
        const sibling = await ask(LISTED, 'same-site');
        expect(sibling.status, `${method} ${target}: ${sibling.text}`).toBeGreaterThanOrEqual(400);
        expect(sibling.status, `${method} ${target}`).toBe(stranger.status);
        expect(sibling.json?.error ?? sibling.text, `${method} ${target}`).toBe(stranger.json?.error ?? stranger.text);
        expect(CORS(sibling.headers), `${method} ${target}`).toEqual([]);
        expect(CORS(stranger.headers), `${method} ${target}`).toEqual([]);
      }
      expect(world.posted).toEqual([]);
      expect(world.merges).toEqual([]);
    });
  });

  describe('what does not change', () => {
    it('keeps the page\'s own headers, the Host check and the session cookie as they are, whatever is listed', async () => {
      const plain = await boot(undefined);
      const listed = await boot({ origins: [LISTED] });
      for (const target of ['/', '/topology.json', '/healthz', `/proposals/${SLUG}.json?${SRC}`]) {
        for (const origin of [undefined, LISTED]) {
          const a = await raw(plain.port, 'GET', target, { headers: { cookie: plain.cookie, origin } });
          const b = await raw(listed.port, 'GET', target, { headers: { cookie: listed.cookie, origin } });
          expect(b.headers['content-security-policy'], target).toBe(a.headers['content-security-policy']);
          expect(b.headers['content-security-policy'], target).toContain("frame-ancestors 'none'");
          expect(b.headers['content-security-policy'], target).toContain("connect-src 'self'");
          expect(b.headers['x-frame-options'], target).toBe('DENY');
          expect(b.headers['referrer-policy'], target).toBe('no-referrer');
        }
      }
      // the Host check answers 421 for a foreign host, a listed Origin or not, on a route of the list and off it
      for (const target of ['/topology.json', '/proposals', '/healthz', '/']) {
        const res = await raw(listed.port, 'GET', target, { headers: { host: 'tasks.example.com', origin: LISTED, cookie: listed.cookie } });
        expect(res.status, target).toBe(421);
        expect(CORS(res.headers), target).toEqual([]);
      }
      const rebound = await raw(listed.port, 'OPTIONS', '/proposals', { headers: { host: 'evil.example', origin: LISTED, 'access-control-request-method': 'GET' } });
      expect(rebound.status).toBe(421);
      // the session cookie: host-only, HttpOnly, SameSite=Lax, same attributes with or without the key
      const attrs = (c) => c.split(';').map((p) => p.trim().replace(/^cornfield=.*/, 'cornfield=<value>').replace(/^Max-Age=\d+/, 'Max-Age=<n>'));
      expect(attrs(listed.sessionSetCookie)).toEqual(attrs(plain.sessionSetCookie));
      expect(attrs(listed.sessionSetCookie)).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Path=/']));
      expect(listed.sessionSetCookie).not.toMatch(/Domain=/i);
      expect(listed.sessionSetCookie).not.toMatch(/SameSite=None/i);
    });

    it('with no origin listed, every response has the headers it had without the key, on every route, with or without an Origin', async () => {
      const without = await boot(undefined);
      const empty = await boot({ origins: [] });
      const targets = [
        ['GET', '/'], ['GET', '/healthz'], ['GET', '/cornfield/config.json'], ['GET', '/topology.json'], ['GET', '/topology.cloud.json'], ['GET', '/proposals'], ['GET', `/proposals/${SLUG}.json?${SRC}`],
        ['GET', `/proposals/${SLUG}/decision?${SRC}`], ['GET', `/proposals/${SLUG}/review?${SRC}`], ['GET', `/proposals/${SLUG}/mockups?${SRC}`], ['GET', '/api/forge/pulls/40'], ['GET', '/api/forge/pulls'],
        ['GET', '/explorer/main.js'], ['GET', '/cornfield/theme.css'], ['GET', '/cornfield/components/corn-map.js'], ['GET', '/cornfield/components/version.json'], ['OPTIONS', '/cornfield/components/corn-map.js'], ['GET', '/api/review-tokens'], ['GET', '/auth/me'], ['OPTIONS', '/proposals'], ['OPTIONS', `/proposals/${SLUG}/review?${SRC}`],
        ['PUT', `/proposals/${SLUG}/review?${SRC}`], ['POST', '/api/forge/pulls/40/landing/cancel'], ['GET', '/nope'],
      ];
      const settle = (r) => ({ status: r.status, headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => !['date', 'etag', 'content-length'].includes(k))), body: r.text.length > 0 });
      for (const [method, target] of targets) {
        for (const origin of [undefined, LISTED, 'https://evil.example']) {
          const headers = (srv) => ({ cookie: srv.cookie, origin, 'sec-fetch-site': origin ? 'same-site' : undefined, 'access-control-request-method': method === 'OPTIONS' ? 'PUT' : undefined, 'content-length': method === 'PUT' || method === 'POST' ? '2' : undefined, 'content-type': method === 'PUT' || method === 'POST' ? 'application/json' : undefined });
          const a = settle(await raw(without.port, method, target, { headers: headers(without), body: method === 'PUT' || method === 'POST' ? '{}' : undefined }));
          const b = settle(await raw(empty.port, method, target, { headers: headers(empty), body: method === 'PUT' || method === 'POST' ? '{}' : undefined }));
          expect(b, `${method} ${target} Origin=${origin}`).toEqual(a);
          expect(Object.keys(a.headers).filter((k) => k.startsWith('access-control-')), `${method} ${target}`).toEqual([]);
          expect(a.headers.vary ?? '', `${method} ${target}`).not.toMatch(/Origin/);
        }
      }
    });

    it('with an origin listed, a request that does not come from it is answered with the headers it had, but for Vary on the list\'s routes', async () => {
      const without = await boot(undefined);
      const listed = await boot({ origins: [LISTED] });
      const strip = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => !['date', 'etag', 'content-length'].includes(k)));
      const onList = new Set([...READS, '/cornfield/components/corn-map.js']);
      for (const target of ['/', '/healthz', '/explorer/main.js', '/api/forge/pulls', '/api/review-tokens', '/cornfield/components/corn-map.js', ...READS]) {
        for (const origin of [undefined, 'https://evil.example']) {
          const a = await raw(without.port, 'GET', target, { headers: { cookie: without.cookie, origin } });
          const b = await raw(listed.port, 'GET', target, { headers: { cookie: listed.cookie, origin } });
          const { vary: va, ...ha } = strip(a.headers);
          const { vary: vb, ...hb } = strip(b.headers);
          expect(hb, target).toEqual(ha);
          if (onList.has(target)) expect(vb, target).toBe(va ? `Origin, ${va}` : 'Origin');
          else expect(vb, target).toBe(va);
        }
      }
    });
  });

  describe('the open theme routes', () => {
    it('answer a listed origin with its origin and no Allow-Credentials, and everything else as before', async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-embed-repo-'));
      dirs.push(repo);
      fs.cpSync(SAMPLE, repo, { recursive: true });
      fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'tools', 'theme.css'), ':root { --corn-accent: #336699; }\n@font-face { font-family: "Own"; src: url("/cornfield/theme/assets/own.woff2") format("woff2"); }\n');
      fs.writeFileSync(path.join(repo, 'tools', 'night.css'), ':root { --corn-accent: #99ccff; }\n');
      fs.writeFileSync(path.join(repo, 'tools', 'own.woff2'), Buffer.from('wOF2-not-really'));
      const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-embed-'));
      dirs.push(data);
      const config = await loadConfig(repo, { env: { CORNFIELD_DATA: data } });
      Object.assign(config, { forge: { type: 'github', url: fake.url, repo: 'owner/name' }, publicUrl: PUBLIC, embed: { origins: [LISTED] } });
      config.theme = { ...config.theme, css: 'tools/theme.css', names: { night: 'tools/night.css' } };
      const server = createCornfieldServer(config, { env: ENV, now: () => clock });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
      closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
      const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
      // no session at all: these answer without one
      for (const target of ['/cornfield/theme.css', '/cornfield/theme/night.css']) {
        const res = await raw(port, 'GET', target, { headers: { origin: LISTED } });
        expect(res.status, target).toBe(200);
        expect(res.headers['access-control-allow-origin'], target).toBe(LISTED);
        expect(res.headers['access-control-allow-credentials'], target).toBeUndefined();
        expect(res.headers['access-control-expose-headers'], target).toBeUndefined();
        expect(res.headers.vary, target).toMatch(/(^|, )Origin(,|$)/);
        expect(CORS((await raw(port, 'GET', target, { headers: { origin: 'https://evil.example' } })).headers), target).toEqual([]);
      }
      const asset = await raw(port, 'GET', '/cornfield/theme/assets/own.woff2', { headers: { origin: LISTED } });
      expect(asset.status).toBe(200);
      expect(asset.headers['access-control-allow-origin']).toBe(LISTED);
      expect(asset.headers['access-control-allow-credentials']).toBeUndefined();
      // an asset no theme file names is behind the sign-in: 401, and a listed origin may read that it is
      const hidden = await raw(port, 'GET', '/cornfield/theme/assets/other.png', { headers: { origin: LISTED } });
      expect(hidden.status).toBe(401);
      const pre = await raw(port, 'OPTIONS', '/cornfield/theme.css', { headers: { origin: LISTED, 'access-control-request-method': 'GET' } });
      expect(pre.status).toBe(204);
      expect(pre.headers['access-control-allow-credentials']).toBeUndefined();
      expect(pre.headers['access-control-allow-methods']).toBe('GET, HEAD');
    });
  });

  describe('signing in and returning', () => {
    let s;
    let plain;
    beforeAll(async () => { s = await boot({ origins: [LISTED, SECOND] }); plain = await boot(undefined); });

    /** /auth/start with the given query, then the callback: where the sign-in ends */
    async function endsAt(srv, query) {
      const started = await raw(srv.port, 'GET', `/auth/start${query}`);
      expect(started.status, started.text).toBe(303);
      const to = new URL(started.headers.location);
      const stateCookie = started.headers['set-cookie'].find((c) => c.startsWith('cornfield-oauth=')).split(';')[0];
      const back = await raw(srv.port, 'GET', `/auth/callback?code=c-maint&state=${to.searchParams.get('state')}`, { headers: { cookie: stateCookie } });
      expect(back.status, back.text).toBe(303);
      return back.headers.location;
    }
    const to = (value) => `?returnTo=${encodeURIComponent(value)}`;

    it('ends on a listed origin\'s page, exactly as the URL parser reads it', async () => {
      expect(await endsAt(s, to('https://tasks.example.com/reviews/7?x=1&y=%2F#top'))).toBe('https://tasks.example.com/reviews/7?x=1&y=%2F#top');
      expect(await endsAt(s, to('https://tasks.example.com'))).toBe('https://tasks.example.com/');
      expect(await endsAt(s, to('https://tasks.example.com:443/a'))).toBe('https://tasks.example.com/a');
      expect(await endsAt(s, to('HTTPS://Tasks.Example.COM/a'))).toBe('https://tasks.example.com/a');
      expect(await endsAt(s, to('http://tasks.corn.localhost:3711/p?q=1'))).toBe('http://tasks.corn.localhost:3711/p?q=1');
    });

    it('ends on this server for its own origin or a path, as before', async () => {
      expect(await endsAt(s, to(`${PUBLIC}/?proposal=a&source=pull/40`))).toBe(`${PUBLIC}/?proposal=a&source=pull/40`);
      expect(await endsAt(s, to(`${PUBLIC}/x#frag`))).toBe(`${PUBLIC}/x`);
      expect(await endsAt(s, `?return=${encodeURIComponent('/?proposal=a')}`)).toBe(`${PUBLIC}/?proposal=a`);
      expect(await endsAt(s, '')).toBe('/');
      expect(await endsAt(s, to('/?proposal=b'))).toBe(`${PUBLIC}/?proposal=b`);
    });

    const ODD = [
      '//tasks.example.com/x', '//evil.test', '///evil.test', 'https://tasks.example.com.evil.test/', 'https://tasks.example.com.evil.test', 'https://evil.test/https://tasks.example.com',
      'https://tasks.example.com@evil.test/', 'https://evil.test@tasks.example.com/', 'https://tasks.example.com:pw@evil.test/', 'https://user:pw@tasks.example.com/', 'https://tasks.example.com:8443/', 'https://tasks.example.com:80/',
      'http://tasks.example.com/', 'https://tasks.example.com\\@evil.test/', 'https://tasks.example.com\\evil.test', 'https:\\\\evil.test', 'https:\\\\tasks.example.com\\x', '/\\evil.test', '/\\/evil.test', '\\\\evil.test',
      'https://tasks.example.com%2f@evil.test/', 'https://tasks.example.com%2f.evil.test/', 'https://tasks.example.com%00.evil.test/', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd',
      ' https://tasks.example.com/', 'https://tasks.example.com/ ', 'https://tasks.example.com/\n', 'https://tasks.exa\tmple.com/', 'https://tasks.example.com\r\nSet-Cookie: a=b', 'https://tasks.example.com./', 'https://evil.test/', 'https://localhost/',
      'https://tasks.example.com:443.evil.test/', 'https://xn--tasks-example.com/', 'https://tasks.example.com。evil.test/', 'https://tasks․example.com/', 'tasks.example.com', 'https:tasks.example.com', 'https:/evil.test', 'ftp://tasks.example.com/',
      `https://tasks.example.com/${'a'.repeat(1100)}`, `${PUBLIC}.evil.test/`, 'http://127.0.0.1:3350@evil.test/', 'http://127.0.0.1:3351/', 'https://127.0.0.1:3350/', '/auth/start', `${PUBLIC}/auth/sign-out`, '/.//evil.test',
    ];

    it('falls back to the sign-in\'s own behaviour (the map, `/`) for anything that is not this server or a listed origin', async () => {
      for (const value of ODD) {
        const end = await endsAt(s, to(value));
        expect(end, JSON.stringify(value.slice(0, 80))).toBe('/');
      }
    });

    it('falls back to `return` when `returnTo` is refused: today\'s way back', async () => {
      for (const value of ['https://evil.test/', '//evil.test', 'https://tasks.example.com@evil.test/']) {
        expect(await endsAt(s, `${to(value)}&return=${encodeURIComponent('/?proposal=c')}`), value).toBe(`${PUBLIC}/?proposal=c`);
      }
      // and an accepted returnTo wins over `return`
      expect(await endsAt(s, `${to('https://tasks.example.com/p')}&return=${encodeURIComponent('/?proposal=c')}`)).toBe('https://tasks.example.com/p');
    });

    it('never takes an absolute URL in `return` (the old parameter keeps its rules)', async () => {
      for (const value of ['https://tasks.example.com/p', `${PUBLIC}/x`, '//evil.test', 'https://evil.test/']) {
        expect(await endsAt(s, `?return=${encodeURIComponent(value)}`), value).toBe('/');
      }
    });

    it('with no origin listed, `returnTo` is not read at all: the sign-in ends where it did before the key', async () => {
      expect(await endsAt(plain, to('https://tasks.example.com/p'))).toBe('/');
      // not even this server's own URL, or a path: before `embed.origins` the parameter did not exist
      expect(await endsAt(plain, to(`${PUBLIC}/p`))).toBe('/');
      expect(await endsAt(plain, to('/p'))).toBe('/');
      expect(await endsAt(plain, `${to(`${PUBLIC}/p`)}&return=${encodeURIComponent('/?proposal=c')}`)).toBe(`${PUBLIC}/?proposal=c`);
    });

    it('keeps the way back through "try again" after a failed sign-in, and checks it again there', async () => {
      const started = await raw(s.port, 'GET', `/auth/start${to('https://tasks.example.com/reviews/7?x=1')}`);
      const state = new URL(started.headers.location).searchParams.get('state');
      const stateCookie = started.headers['set-cookie'].find((c) => c.startsWith('cornfield-oauth=')).split(';')[0];
      const failed = await raw(s.port, 'GET', `/auth/callback?error=access_denied&state=${state}`, { headers: { cookie: stateCookie } });
      expect(failed.status).toBe(400);
      expect(failed.text).toContain(`/auth/start?returnTo=${encodeURIComponent('https://tasks.example.com/reviews/7?x=1').replaceAll('&', '&amp;')}`);
      // the same page from a server where that origin is no longer listed: the cookie is signed, the list is checked again, nothing is followed
      const other = await boot({ origins: [SECOND] });
      const a = await raw(other.port, 'GET', `/auth/start${to('https://tasks.example.com/x')}`);
      const sa = a.headers['set-cookie'].find((c) => c.startsWith('cornfield-oauth=')).split(';')[0];
      const done = await raw(other.port, 'GET', `/auth/callback?code=c-maint&state=${new URL(a.headers.location).searchParams.get('state')}`, { headers: { cookie: sa } });
      expect(done.headers.location).toBe('/');
    });
  });
});
