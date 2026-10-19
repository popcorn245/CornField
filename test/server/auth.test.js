/**
 * @vitest-environment node
 *
 * Sign-in and the admins-only guard (server/auth.js, server/bind.js; spec 0001 section 3, ADR 0004), against a fake
 * forge on loopback: OAuth (GitHub, and Forgejo's own token request), sessions in the SQLite file, the permission
 * asked again after 15 minutes, sign-out, and the guard walked over every route as someone signed out, a reader and
 * a maintainer; a proxied path that never carries cornfield's cookies either way; tokens kept for maintainers only and
 * revoked when a session ends. The settings env must give, and where the server may then listen. No real forge, app
 * or token.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error plain JS module, no declarations
import { createCornfieldServer, listen } from '../../server/server.js';
// @ts-expect-error plain JS module, no declarations
import { signInSettings, oauthEndpoints, parseCookies, sealToken, openToken, RECHECK_MS, SESSION_MS, STATE_MS } from '../../server/auth.js';
// @ts-expect-error plain JS module, no declarations
import { assertBind } from '../../server/bind.js';
// @ts-expect-error plain JS module, no declarations
import { OWN_COOKIES, withoutOwnCookies, withoutOwnSetCookies } from '../../server/proxy.js';
// @ts-expect-error plain JS module, no declarations
import { loadConfig } from '../../core/config.js';
import { CORNFIELD, SAMPLE } from '../helpers.js';
import { fakeForge } from './fake-forge.js';

const CLI = path.join(CORNFIELD, 'cli', 'cornfield.js');
const SESSION_SECRET = 'x'.repeat(40); // long enough, and plainly not a secret
const ENV = { CORNFIELD_GITHUB_CLIENT_ID: 'test-client-id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: SESSION_SECRET };
const PUBLIC = 'http://127.0.0.1:3350';

/** A request with its path as given; answers status, headers and body */
function raw(port, method, target, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** `name=value` of each Set-Cookie of an answer, by name */
const setCookies = (res) => Object.fromEntries((res.headers['set-cookie'] || []).map((c) => [c.split('=')[0], c]));
const valueOf = (setCookie) => setCookie.split(';')[0].slice(setCookie.indexOf('=') + 1);

/**
 * A fake GitHub (Enterprise Server paths, since the forge's url is the fake): codes for tokens, a user per token,
 * and each one's permission on acme/home, which a test may change.
 */
function fakeGitHub() {
  const users = {
    'tok-maint': { id: 1001, login: 'maintainer-one', perm: 'maintain' },
    'tok-admin': { id: 1003, login: 'admin-three', perm: 'admin' },
    'tok-reader': { id: 1002, login: 'reader-two', perm: 'read' },
  };
  const codes = { 'c-maint': 'tok-maint', 'c-admin': 'tok-admin', 'c-reader': 'tok-reader' };
  const tokenRequests = [];
  const PERMS = { admin: { admin: true, maintain: true, push: true, triage: true, pull: true }, maintain: { admin: false, maintain: true, push: true, triage: true, pull: true }, read: { admin: false, maintain: false, push: false, triage: false, pull: true } };
  const who = (req) => users[String(req.headers.authorization || '').replace(/^Bearer /, '')];
  const state = { down: false, revoked: new Set(), revokedTokens: new Set() };
  const revoked = [];
  const authed = (fn) => (req) => {
    if (state.down) return { status: 503, body: { message: 'Unavailable' } };
    const u = who(req);
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (!u || state.revoked.has(u.login) || state.revokedTokens.has(token)) return { status: 401, body: { message: 'Bad credentials' } };
    return fn(u);
  };
  const routes = {
    'POST /login/oauth/access_token': (req) => {
      const form = Object.fromEntries(new URLSearchParams(req.body));
      tokenRequests.push({ headers: req.headers, form });
      const token = codes[form.code];
      if (!token || form.client_secret !== ENV.CORNFIELD_GITHUB_CLIENT_SECRET) return { status: 200, body: { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' } };
      return { body: { access_token: token, token_type: 'bearer', scope: 'repo' } };
    },
    'GET /api/v3/user': authed((u) => ({ body: { id: u.id, login: u.login, name: null } })),
    'GET /api/v3/repos/acme/home': authed((u) => ({ body: { full_name: 'acme/home', permissions: PERMS[u.perm] } })),
    // The app revokes a token with its own credentials (Basic client id and secret)
    'DELETE /api/v3/applications/test-client-id/token': (req) => {
      const basic = Buffer.from(`${ENV.CORNFIELD_GITHUB_CLIENT_ID}:${ENV.CORNFIELD_GITHUB_CLIENT_SECRET}`).toString('base64');
      if (req.headers.authorization !== `Basic ${basic}`) return { status: 401, body: { message: 'Requires authentication' } };
      const token = JSON.parse(req.body).access_token;
      revoked.push(token);
      state.revokedTokens.add(token);
      return { status: 204 };
    },
  };
  return { routes, users, tokenRequests, state, revoked };
}

async function serverOn(config, opts) {
  const server = createCornfieldServer(config, opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  return { server, port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
}

describe('sign-in with GitHub, and the guard', () => {
  let fake;
  let gh;
  let data;
  let plainData;
  let config;
  let srv;
  let plain;
  let clock;

  beforeAll(async () => {
    gh = fakeGitHub();
    fake = await fakeForge(gh.routes);
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-auth-'));
    plainData = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-plain-'));
    config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    config.forge = { type: 'github', url: fake.url, repo: 'acme/home' };
    config.publicUrl = PUBLIC;
    srv = await serverOn(config, { env: ENV, now: () => clock });
    // The same forge (the sample's own has no adapter yet), so a route that reads it answers alike with and without sign-in
    plain = await serverOn(Object.assign(await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: plainData } }), { forge: config.forge }), { env: {} });
  });
  afterAll(async () => {
    await srv.close();
    await plain.close();
    await fake.close();
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(plainData, { recursive: true, force: true });
  });
  beforeEach(() => {
    clock = Date.parse('2026-10-19T12:00:00Z');
    gh.state.down = false;
    gh.state.revoked.clear();
    gh.state.revokedTokens.clear();
    gh.revoked.length = 0;
    gh.users['tok-maint'].perm = 'maintain';
    gh.users['tok-maint'].login = 'maintainer-one';
    gh.users['tok-maint'].id = 1001;
  });

  const get = (p, headers = {}) => raw(srv.port, 'GET', p, headers);
  /** The newest session row of a login, read straight from the SQLite file */
  const sessionRow = (login) => {
    const db = new DatabaseSync(path.join(data, 'cornfield.db'));
    const row = db.prepare('SELECT * FROM sessions WHERE login = ? ORDER BY created_at DESC, rowid DESC').get(login);
    db.close();
    return row;
  };

  /** Signs in with a code, the way a browser does; answers the session cookie (`name=value`) */
  async function signIn(code) {
    const started = await get('/auth/start');
    expect(started.status).toBe(303);
    const to = new URL(started.headers.location);
    const stateCookie = setCookies(started)['cornfield-oauth'];
    const back = await get(`/auth/callback?code=${code}&state=${to.searchParams.get('state')}`, { cookie: stateCookie.split(';')[0] });
    expect(back.status, back.body).toBe(303);
    expect(back.headers.location).toBe('/');
    return setCookies(back).cornfield.split(';')[0];
  }

  it('sends the browser to the forge with the app\'s id, the callback, a state, a PKCE challenge and the repo scope', async () => {
    const res = await get('/auth/start');
    const to = new URL(res.headers.location);
    expect(`${to.origin}${to.pathname}`).toBe(`${fake.url}/login/oauth/authorize`);
    expect(Object.fromEntries(to.searchParams)).toMatchObject({ client_id: 'test-client-id', redirect_uri: `${PUBLIC}/auth/callback`, response_type: 'code', scope: 'repo', code_challenge_method: 'S256' });
    expect(to.searchParams.get('state')).toMatch(/^[\w-]{40,}$/);
    expect(to.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(res.headers.location).not.toContain(ENV.CORNFIELD_GITHUB_CLIENT_SECRET);
    const c = setCookies(res)['cornfield-oauth'];
    expect(c).toMatch(/; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/);
  });

  it('signs a maintainer in: the code for a token with the secret and the verifier, a session row, an HttpOnly cookie', async () => {
    gh.tokenRequests.length = 0;
    const cookie = await signIn('c-maint');
    const [tr] = gh.tokenRequests;
    expect(tr.headers.accept).toBe('application/json');
    expect(tr.form).toMatchObject({ client_id: 'test-client-id', client_secret: ENV.CORNFIELD_GITHUB_CLIENT_SECRET, code: 'c-maint', redirect_uri: `${PUBLIC}/auth/callback`, grant_type: 'authorization_code' });
    expect(tr.form.code_verifier).toMatch(/^[\w-]{43}$/);
    expect(JSON.parse((await get('/auth/me', { cookie })).body)).toEqual({ ok: true, login: 'maintainer-one', permission: 'maintain', admin: true });
    expect((await get('/', { cookie })).status).toBe(200);
    expect(JSON.parse((await get('/cornfield/config.json', { cookie })).body).signIn).toEqual({ login: 'maintainer-one' });
  });

  it('keeps no cookie value and no plain token in the SQLite file', async () => {
    const cookie = await signIn('c-admin');
    const db = new DatabaseSync(path.join(data, 'cornfield.db'));
    const row = db.prepare("SELECT * FROM sessions WHERE login = 'admin-three' ORDER BY created_at DESC").get();
    db.close();
    expect(row).toMatchObject({ forge: 'github', user_id: '1003', permission: 'admin' });
    expect(row.id).not.toBe(cookie.split('=')[1]);
    expect(row.token).not.toContain('tok-admin');
    expect(row.token).toMatch(/^v1\./);
    expect(fs.readFileSync(path.join(data, 'cornfield.db')).includes('tok-admin')).toBe(false);
  });

  it('refuses a callback without its state cookie, with another state, a tampered or an old cookie, a bad code, or a cancel', async () => {
    const started = await get('/auth/start');
    const state = new URL(started.headers.location).searchParams.get('state');
    const cookie = setCookies(started)['cornfield-oauth'].split(';')[0];
    // [path, headers, words, whether the answer may clear the state cookie: only one to the sign-in it belongs to]
    const tries = [
      [`/auth/callback?code=c-maint&state=${state}`, {}, 'started in another browser', false],
      [`/auth/callback?code=c-maint&state=other`, { cookie }, 'answer to another request', false],
      [`/auth/callback?code=c-maint&state=${state}`, { cookie: cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) }, 'started in another browser', false],
      [`/auth/callback?error=access_denied`, { cookie }, 'answer to another request', false],
      [`/auth/callback?error=access_denied&state=forged`, { cookie }, 'answer to another request', false],
      [`/auth/callback?code=c-bad&state=${state}`, { cookie }, 'GitHub did not give a token for this sign-in. GitHub said: &quot;The code passed is incorrect or expired.&quot;', true],
      [`/auth/callback?state=${state}`, { cookie }, 'without a sign-in code', true],
      [`/auth/callback?error=access_denied&state=${state}`, { cookie }, 'The sign-in was cancelled on GitHub.', true],
    ];
    for (const [p, h, words, clears] of tries) {
      const res = await get(p, h);
      expect(res.status, p).toBe(400);
      expect(res.body, p).toContain(words);
      expect(res.body).toContain('href="/auth/start"');
      if (clears) expect(res.headers['set-cookie'], p).toEqual([expect.stringMatching(/^cornfield-oauth=; .*Max-Age=0$/)]);
      else expect(res.headers['set-cookie'], p).toBeUndefined();
    }
    clock += STATE_MS + 1;
    expect((await get(`/auth/callback?code=c-maint&state=${state}`, { cookie })).body).toContain('The sign-in took too long.');
  });

  it('a reader signs in and sees only "ask a maintainer"; everything else is 403', async () => {
    const cookie = await signIn('c-reader');
    const page = await get('/', { cookie });
    expect(page.status).toBe(403);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.body).toContain('This is the dev dashboard');
    expect(page.body).toContain('ask a maintainer');
    expect(page.body).toContain('reader-two');
    expect(page.body).toContain('action="/auth/sign-out"');
    const api = await get('/topology.json', { cookie });
    expect([api.status, JSON.parse(api.body)]).toEqual([403, { ok: false, error: 'This is the dev dashboard; ask a maintainer.' }]);
    expect(JSON.parse((await get('/auth/me', { cookie })).body)).toMatchObject({ login: 'reader-two', admin: false });
  });

  // Every route the server answers, the way a browser or the explorer asks for it
  const own = { origin: `http://127.0.0.1`, 'content-type': 'application/json' };
  const ROUTES = [
    ['GET', '/'], ['HEAD', '/'], ['GET', '/index.html'], ['GET', '/cornfield/config.json'], ['GET', '/topology.json'], ['GET', '/topology.cloud.json'],
    ['GET', '/cornfield/house.json'], ['GET', '/topology-fixture.json?nodes=300&edges=900&seed=4'], ['GET', '/explorer/main.js'], ['GET', '/explorer/explorer.css'],
    ['GET', '/core/schema.js'], ['GET', '/plugins/house/browser.js'], ['GET', '/repo/packages/api/src/server.js'], ['GET', '/proposals'],
    ['GET', '/api/forge/issues'], ['GET', '/api/forge/pulls/12'], ['POST', '/api/forge/pulls'],
    ['GET', '/proposals/0002-checkout.json'], ['GET', '/proposals/0002-checkout/review'], ['PUT', '/proposals/0002-checkout/review', own, JSON.stringify({ verdict: 'approved' })],
    ['GET', '/.env'], ['GET', '/nope'], ['POST', '/topology.json'], ['DELETE', '/proposals'],
  ];
  const walk = async (port, cookie) => {
    const out = [];
    for (const [method, p, headers = {}, body] of ROUTES) {
      const h = { ...headers, ...(cookie ? { cookie } : {}) };
      if (h.origin) h.origin = `http://127.0.0.1:${port}`;
      out.push((await raw(port, method, p, h, body)).status);
    }
    return out;
  };

  it('walks every route: signed out is 401 (the page is the sign-in page), a reader 403, a maintainer what it would be without sign-in', async () => {
    const without = await walk(plain.port, null);
    expect(without.slice(0, 4)).toEqual([200, 200, 200, 200]);
    expect(await walk(srv.port, null)).toEqual(ROUTES.map(() => 401));
    expect(await walk(srv.port, await signIn('c-reader'))).toEqual(ROUTES.map(() => 403));
    // A maintainer gets what Stage 1 gives, except the forge's reads: those need someone to ask as (403 without sign-in)
    const forgeReads = ROUTES.map(([m, p]) => m === 'GET' && p.startsWith('/api/forge/'));
    const maint = await walk(srv.port, await signIn('c-maint'));
    expect(maint.filter((_, i) => !forgeReads[i])).toEqual(without.filter((_, i) => !forgeReads[i]));
    expect(without.filter((_, i) => forgeReads[i])).toEqual([403, 403]);
    for (const status of maint.filter((_, i) => forgeReads[i])) expect([401, 403]).not.toContain(status);
    const page = await get('/');
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.body).toContain('Sign in with GitHub');
    expect(page.body).toContain('href="/auth/start"');
    expect(page.body).not.toContain('<script');
    expect(page.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(JSON.parse((await get('/topology.json')).body)).toEqual({ ok: false, error: 'Sign in first.' });
    // A page a browser opens anywhere is the sign-in page, too
    expect((await get('/proposals', { accept: 'text/html,application/xhtml+xml' })).body).toContain('Sign in with GitHub');
  });

  it('lists the open spec PRs for a maintainer, asked of the forge with their own token; the forge down leaves the local proposals and says why', async () => {
    const pulls = 'GET /api/v3/repos/acme/home/pulls?state=open&sort=created&direction=desc&per_page=100';
    const asked = [];
    gh.routes[pulls] = (req) => { asked.push(req.headers.authorization); return { body: [{ number: 7, title: 'Meals', state: 'open', draft: false, user: { login: 'agent-four' }, labels: [], head: { ref: 'spec', sha: 'a'.repeat(40) }, base: { ref: 'main' }, html_url: 'https://forge.example/acme/home/pull/7' }] }; };
    gh.routes['GET /api/v3/repos/acme/home/pulls/7'] = { body: { number: 7, title: 'Meals', state: 'open', draft: false, user: { login: 'agent-four' }, labels: [], head: { ref: 'spec', sha: 'a'.repeat(40) }, base: { ref: 'main' }, html_url: 'https://forge.example/acme/home/pull/7' } };
    gh.routes['GET /api/v3/repos/acme/home/pulls/7/files?per_page=100'] = { body: [{ filename: 'docs/specs/proposals/0042-meals.json', status: 'added' }] };
    gh.routes[`GET /api/v3/repos/acme/home/contents/docs/specs/proposals/0042-meals.json?ref=${'a'.repeat(40)}`] = { headers: { 'content-type': 'application/vnd.github.raw' }, body: JSON.stringify({ version: 1, title: 'Meals', summary: 's' }) };
    try {
      const cookie = await signIn('c-maint');
      const list = JSON.parse((await get('/proposals', { cookie })).body);
      expect(list.find((e) => e.source === 'pull/7')).toMatchObject({ slug: '0042-meals', title: 'Meals', pull: { number: 7, author: 'agent-four' } });
      expect(list.some((e) => e.source === 'checkout')).toBe(true);
      expect(asked).toEqual(['Bearer tok-maint']);
      expect((await get('/proposals/0042-meals.json?source=pull%2F7', { cookie })).status).toBe(200);
      gh.routes[pulls] = { status: 503, body: { message: 'Unavailable' } };
      const down = await get('/proposals', { cookie });
      expect(down.status).toBe(200);
      expect(decodeURIComponent(down.headers['x-proposals-forge-error'])).toMatch(/could not answer/);
      expect(JSON.parse(down.body).some((e) => e.source === 'checkout')).toBe(true);
      // Signed out, nothing reaches the forge
      asked.length = 0;
      gh.routes[pulls] = (req) => { asked.push(req.headers.authorization); return { body: [] }; };
      expect((await get('/proposals')).status).toBe(401);
      expect(asked).toEqual([]);
    } finally {
      delete gh.routes[pulls];
    }
  });

  it('posts a review as the signed-in maintainer onto the PR, reads it back from the comments, and writes the audit row to the SQLite file; a Stage 1 review is carried over once', async () => {
    const base = '/api/v3/repos/acme/home';
    const sha = 'b'.repeat(40);
    const pull = { number: 8, title: 'Plans', state: 'open', draft: false, user: { login: 'agent-four' }, labels: [], head: { ref: 'spec', sha }, base: { ref: 'main' }, html_url: 'https://forge.example/acme/home/pull/8' };
    const comments = [];
    const posts = [];
    const mine = ['GET /user', `GET ${base}/pulls?state=open&sort=created&direction=desc&per_page=100`, `GET ${base}/pulls/8`, `GET ${base}/pulls/8/files?per_page=100`, `GET ${base}/contents/docs/specs/proposals/0043-plans.json?ref=${sha}`, `GET ${base}/issues/8/comments?per_page=100`, `POST ${base}/issues/8/comments`, `GET ${base}/collaborators/reader-two/permission`];
    gh.routes[mine[1]] = { body: [pull] };
    gh.routes[mine[2]] = { body: pull };
    gh.routes[mine[3]] = { body: [{ filename: 'docs/specs/proposals/0043-plans.json', status: 'added' }] };
    gh.routes[mine[4]] = { headers: { 'content-type': 'application/vnd.github.raw' }, body: JSON.stringify({ version: 1, title: 'Plans', summary: 's' }) };
    gh.routes[mine[5]] = () => ({ body: comments });
    gh.routes[mine[6]] = (req) => {
      expect(req.headers.authorization).toBe('Bearer tok-maint');
      const c = { id: 7000 + posts.length, user: { login: 'maintainer-one' }, body: JSON.parse(req.body).body, html_url: `https://forge.example/acme/home/pull/8#issuecomment-${7000 + posts.length}`, created_at: '2026-10-19T12:00:00Z', updated_at: '2026-10-19T12:00:00Z' };
      posts.push(c);
      comments.push(c);
      return { status: 201, body: c };
    };
    gh.routes[mine[7]] = { body: { permission: 'read', role_name: 'read' } };
    const kept = path.join(data, 'reviews', 'checkout', '0043-plans.review.json');
    fs.mkdirSync(path.dirname(kept), { recursive: true });
    fs.writeFileSync(kept, JSON.stringify({ version: 1, verdict: 'approved', note: 'Carried.', edits: [], at: '2026-10-01T00:00:00.000Z' }));
    const audit = () => {
      const db = new DatabaseSync(path.join(data, 'cornfield.db'));
      const rows = db.prepare("SELECT * FROM actions WHERE action = 'review' ORDER BY id").all();
      db.close();
      return rows;
    };
    const before = audit().length;
    try {
      const cookie = await signIn('c-maint');
      // Opening the menu carries the Stage 1 review over once
      expect((await get('/proposals', { cookie })).status).toBe(200);
      expect(posts).toHaveLength(1);
      expect(fs.existsSync(kept)).toBe(false);
      expect(fs.existsSync(`${kept}.migrated`)).toBe(true);
      await get('/proposals', { cookie });
      expect(posts).toHaveLength(1);
      // Send back from the page: the signed-in maintainer's token posts it
      const own = { cookie, origin: `http://127.0.0.1:${srv.port}`, 'content-type': 'application/json' };
      const sent = await raw(srv.port, 'PUT', '/proposals/0043-plans/review?source=pull%2F8', own, JSON.stringify({ verdict: 'notes', note: 'Smaller.', edits: [{ op: 'remove-node', id: 'x' }] }));
      expect(sent.status, sent.body).toBe(200);
      expect(posts).toHaveLength(2);
      // A reader's comment after it does not change the review
      comments.push({ id: 7100, user: { login: 'reader-two' }, body: '```cornfield-review 0043-plans\n{"verdict":"approved","note":"","edits":[]}\n```', html_url: 'x', created_at: '2026-10-19T12:05:00Z', updated_at: '2026-10-19T12:05:00Z' });
      const back = JSON.parse((await raw(srv.port, 'GET', '/proposals/0043-plans/review?source=pull%2F8', { cookie })).body);
      expect(back).toMatchObject({ verdict: 'notes', note: 'Smaller.', edits: [{ op: 'remove-node', id: 'x' }], by: 'maintainer-one', comment: { id: '7001' } });
      // Two audit rows: the migrated one, and the send back; the token is nowhere in them
      const rows = audit().slice(before);
      expect(rows.map((r) => [r.login, r.action, r.target, r.status, JSON.parse(r.request).verdict])).toEqual([['maintainer-one', 'review', 'acme/home#8', 201, 'approved'], ['maintainer-one', 'review', 'acme/home#8', 201, 'notes']]);
      expect(JSON.parse(rows[0].request).migrated).toBe('2026-10-01');
      expect(JSON.parse(rows[1].answer)).toMatchObject({ comment: '7001' });
      expect(JSON.stringify(rows)).not.toContain('tok-maint');
      // A reader cannot post one
      expect((await raw(srv.port, 'PUT', '/proposals/0043-plans/review?source=pull%2F8', { ...own, cookie: await signIn('c-reader') }, '{"verdict":"approved"}')).status).toBe(403);
      expect(posts).toHaveLength(2);
    } finally {
      for (const k of mine.slice(1)) delete gh.routes[k];
      fs.rmSync(`${kept}.migrated`, { force: true });
    }
  });

  it('a cookie that names no session, or one that has ended, is signed out', async () => {
    expect((await get('/topology.json', { cookie: 'cornfield=made-up' })).status).toBe(401);
    const cookie = await signIn('c-maint');
    clock += SESSION_MS;
    expect((await get('/topology.json', { cookie })).status).toBe(401);
  });

  it('asks the forge again after 15 minutes: a maintainer no more sees "ask a maintainer", and their token is revoked', async () => {
    const cookie = await signIn('c-maint');
    gh.users['tok-maint'].perm = 'read';
    clock += RECHECK_MS - 1000;
    expect((await get('/topology.json', { cookie })).status).toBe(200);
    clock += 2000;
    expect((await get('/topology.json', { cookie })).status).toBe(403);
    expect(gh.revoked).toEqual(['tok-maint']);
    expect(sessionRow('maintainer-one').token).toBe('');
    // Made a maintainer again: nothing is asked with no token, so it takes a new sign-in
    gh.users['tok-maint'].perm = 'maintain';
    gh.state.revokedTokens.clear();
    clock += RECHECK_MS;
    expect((await get('/topology.json', { cookie })).status).toBe(403);
    expect((await get('/', { cookie })).body).toContain('Sign out and sign in again');
    expect((await get('/topology.json', { cookie: await signIn('c-maint') })).status).toBe(200);
  });

  it('follows a rename by the forge\'s user id, and ends a session whose token now answers for someone else', async () => {
    const cookie = await signIn('c-maint');
    gh.users['tok-maint'].login = 'maintainer-renamed';
    clock += RECHECK_MS;
    expect((await get('/topology.json', { cookie })).status).toBe(200);
    expect(JSON.parse((await get('/auth/me', { cookie })).body).login).toBe('maintainer-renamed');
    gh.users['tok-maint'].id = 9999;
    clock += RECHECK_MS;
    expect((await get('/topology.json', { cookie })).status).toBe(401);
  });

  it('keeps no token for someone who is not a maintainer: it is revoked at once', async () => {
    await signIn('c-reader');
    expect(gh.revoked).toEqual(['tok-reader']);
    expect(sessionRow('reader-two')).toMatchObject({ permission: 'read', token: '' });
  });

  it('revokes the token when a session ends: on sign-out and on expiry', async () => {
    const one = await signIn('c-maint');
    await raw(srv.port, 'POST', '/auth/sign-out', { cookie: one, origin: `http://127.0.0.1:${srv.port}` });
    expect(gh.revoked).toEqual(['tok-maint']);
    gh.state.revokedTokens.clear();
    const two = await signIn('c-admin');
    clock += SESSION_MS;
    expect((await get('/topology.json', { cookie: two })).status).toBe(401);
    expect(gh.revoked).toEqual(['tok-maint', 'tok-admin']);
  });

  it('ends the session when the forge no longer takes the token, and does not pass anyone while the forge is down', async () => {
    const cookie = await signIn('c-maint');
    clock += RECHECK_MS;
    gh.state.down = true;
    const down = await get('/', { cookie });
    expect(down.status).toBe(503);
    expect(down.body).toContain('Your access could not be checked');
    gh.state.down = false;
    gh.state.revoked.add('maintainer-one');
    expect((await get('/topology.json', { cookie })).status).toBe(401);
    gh.state.revoked.clear();
    expect((await get('/topology.json', { cookie })).status).toBe(401);
  });

  it('signs out from its own page only, and the cookie then opens nothing', async () => {
    const cookie = await signIn('c-maint');
    const elsewhere = await raw(srv.port, 'POST', '/auth/sign-out', { cookie, origin: 'https://evil.example' });
    expect(elsewhere.status).toBe(403);
    expect((await get('/topology.json', { cookie })).status).toBe(200);
    const out = await raw(srv.port, 'POST', '/auth/sign-out', { cookie, origin: `http://127.0.0.1:${srv.port}` });
    expect(out.status).toBe(303);
    expect(out.headers.location).toBe('/auth/sign-in');
    expect(setCookies(out).cornfield).toMatch(/^cornfield=; .*Max-Age=0$/);
    expect((await get('/topology.json', { cookie })).status).toBe(401);
  });

  it('answers its own routes and their methods only', async () => {
    expect((await get('/auth/sign-in')).status).toBe(200);
    expect((await get('/auth/nope')).status).toBe(404);
    expect((await raw(srv.port, 'POST', '/auth/start')).status).toBe(405);
    expect((await raw(srv.port, 'GET', '/auth/sign-out')).headers.allow).toBe('POST');
    expect((await get('/auth/me')).status).toBe(401);
    const cookie = await signIn('c-maint');
    const signedIn = await get('/auth/sign-in', { cookie });
    expect([signedIn.status, signedIn.headers.location]).toEqual([303, '/']);
  });

  it('keeps /healthz open, saying nothing but ok', async () => {
    const res = await get('/healthz');
    expect([res.status, JSON.parse(res.body)]).toEqual([200, { ok: true }]);
  });
});

describe('the cookies behind an https public URL', () => {
  let fake;
  let data;
  let srv;
  beforeAll(async () => {
    const gh = fakeGitHub();
    fake = await fakeForge(gh.routes);
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-auth-https-'));
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    config.forge = { type: 'github', url: fake.url, repo: 'acme/home' };
    config.publicUrl = 'https://cornfield.example.test';
    srv = await serverOn(config, { env: ENV });
  });
  afterAll(async () => {
    await srv.close();
    await fake.close();
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('are __Host- cookies, Secure, and the callback is under the public URL', async () => {
    const started = await raw(srv.port, 'GET', '/auth/start');
    expect(new URL(started.headers.location).searchParams.get('redirect_uri')).toBe('https://cornfield.example.test/auth/callback');
    const c = setCookies(started)['__Host-cornfield-oauth'];
    expect(c).toMatch(/; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=600$/);
    const state = new URL(started.headers.location).searchParams.get('state');
    const back = await raw(srv.port, 'GET', `/auth/callback?code=c-maint&state=${state}`, { cookie: c.split(';')[0] });
    expect(setCookies(back)['__Host-cornfield']).toMatch(/; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=604800$/);
  });
});

describe('sign-in with Forgejo', () => {
  it('asks Forgejo for the token the same way, without a scope, and keeps the session', async () => {
    const tokenForms = [];
    const fake = await fakeForge({
      'POST /login/oauth/access_token': (req) => {
        tokenForms.push(Object.fromEntries(new URLSearchParams(req.body)));
        return { body: { access_token: 'fj-token', token_type: 'bearer', expires_in: 3600 } };
      },
    });
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-auth-fj-'));
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    config.forge = { type: 'forgejo', url: fake.url, repo: 'acme/home' };
    config.publicUrl = PUBLIC;
    // The Forgejo adapter is its own issue (#4): a stand-in answers the two calls sign-in makes
    const asked = [];
    const createForge = (forge, { token }) => ({
      me: async () => { asked.push(['me', token]); return { id: '7', login: 'fj-maintainer' }; },
      permission: async (repo, login) => { asked.push(['permission', repo, login]); return 'admin'; },
    });
    const env = { CORNFIELD_FORGEJO_CLIENT_ID: 'fj-id', CORNFIELD_FORGEJO_CLIENT_SECRET: 'not-real-fj', CORNFIELD_SESSION_SECRET: SESSION_SECRET };
    const srv = await serverOn(config, { env, createForge });
    try {
      const started = await raw(srv.port, 'GET', '/auth/start');
      const to = new URL(started.headers.location);
      expect(`${to.origin}${to.pathname}`).toBe(`${fake.url}/login/oauth/authorize`);
      expect(to.searchParams.has('scope')).toBe(false);
      const back = await raw(srv.port, 'GET', `/auth/callback?code=fj-code&state=${to.searchParams.get('state')}`, { cookie: setCookies(started)['cornfield-oauth'].split(';')[0] });
      expect(back.status).toBe(303);
      expect(tokenForms[0]).toMatchObject({ client_id: 'fj-id', client_secret: 'not-real-fj', code: 'fj-code', grant_type: 'authorization_code' });
      expect(asked).toEqual([['me', 'fj-token'], ['permission', 'acme/home', 'fj-maintainer']]);
      const cookie = setCookies(back).cornfield.split(';')[0];
      expect((await raw(srv.port, 'GET', '/topology.json', { cookie })).status).toBe(200);
      const page = await raw(srv.port, 'GET', '/');
      expect(page.body).toContain('Sign in with Forgejo');
    } finally {
      await srv.close();
      await fake.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  });
});

describe('signInSettings: what env must give', () => {
  const config = { forge: { type: 'github', repo: 'acme/home' }, publicUrl: 'https://cornfield.example.test' };

  it('is null with no OAuth app in env: Stage 1, loopback only', () => {
    expect(signInSettings(config, {})).toBeNull();
    expect(signInSettings({ forge: null }, {})).toBeNull();
  });

  it('reads the pair of the config\'s forge, the secret and the public URL', () => {
    expect(signInSettings(config, ENV)).toMatchObject({ forgeName: 'GitHub', clientId: 'test-client-id', secure: true });
    expect(signInSettings({ ...config, publicUrl: 'http://127.0.0.1:3350' }, ENV).secure).toBe(false);
  });

  it('refuses half a configuration, in words', () => {
    const no = (cfg, env, words) => expect(() => signInSettings(cfg, env)).toThrow(words);
    no(config, { CORNFIELD_SESSION_SECRET: SESSION_SECRET }, 'no OAuth app is');
    no(config, { CORNFIELD_GITHUB_CLIENT_ID: 'x' }, 'needs both CORNFIELD_GITHUB_CLIENT_ID and CORNFIELD_GITHUB_CLIENT_SECRET');
    no(config, { ...ENV, CORNFIELD_SESSION_SECRET: '' }, 'needs CORNFIELD_SESSION_SECRET');
    no(config, { ...ENV, CORNFIELD_SESSION_SECRET: 'short' }, 'too short');
    no(config, { ...ENV, CORNFIELD_FORGEJO_CLIENT_ID: 'x' }, "The config's forge is github, but CORNFIELD_FORGEJO_CLIENT_ID is set");
    no({ forge: null, publicUrl: config.publicUrl }, ENV, 'the config names no forge');
    no({ ...config, publicUrl: null }, ENV, 'needs the public URL');
    no({ ...config, publicUrl: 'not a url' }, ENV, 'is not a URL');
    no({ ...config, publicUrl: 'ftp://x.example.test' }, ENV, 'an http or https URL');
    no({ ...config, publicUrl: 'https://x.example.test/cornfield' }, ENV, 'is an origin');
  });

  it('finds each forge\'s OAuth endpoints', () => {
    expect(oauthEndpoints({ type: 'github' })).toEqual({ authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', scope: 'repo' });
    expect(oauthEndpoints({ type: 'forgejo', url: 'https://code.example.test/' })).toEqual({ authorize: 'https://code.example.test/login/oauth/authorize', token: 'https://code.example.test/login/oauth/access_token', scope: '' });
    expect(oauthEndpoints({ type: 'forgejo', url: 'https://example.test/forge/' }).token).toBe('https://example.test/forge/login/oauth/access_token');
    expect(oauthEndpoints({ type: 'github', url: 'https://ghe.example.test' }).authorize).toBe('https://ghe.example.test/login/oauth/authorize');
  });
});

describe('the pieces', () => {
  it('parseCookies', () => {
    expect(parseCookies('a=1; b=two=2;c=; =x; junk; a=again')).toEqual({ a: '1', b: 'two=2', c: '' });
    expect(parseCookies(undefined)).toEqual({});
  });

  it('a sealed token opens under its key only, and not once tampered with', () => {
    const key = Buffer.alloc(32, 7);
    const sealed = sealToken(key, 'tok-123');
    expect(sealed).not.toContain('tok-123');
    expect(openToken(key, sealed)).toBe('tok-123');
    expect(openToken(Buffer.alloc(32, 8), sealed)).toBeNull();
    const [v, iv, tag, body] = sealed.split('.');
    const flip = (t) => (t[0] === 'A' ? 'B' : 'A') + t.slice(1);
    expect(openToken(key, [v, iv, flip(tag), body].join('.'))).toBeNull();
    expect(openToken(key, [v, iv, tag, flip(body)].join('.'))).toBeNull();
    expect(openToken(key, 'plain')).toBeNull();
  });
});

describe('where it may listen', () => {
  it('loopback always; anywhere else only with sign-in and an https public URL', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) expect(() => assertBind(host)).not.toThrow();
    expect(() => assertBind('0.0.0.0')).toThrow(/sign-in is not configured/);
    expect(() => assertBind('0.0.0.0', { signIn: false, publicUrl: 'https://cornfield.example.test' })).toThrow(/sign-in is not configured/);
    expect(() => assertBind('0.0.0.0', { signIn: true })).toThrow(/public URL is not set, not https/);
    expect(() => assertBind('0.0.0.0', { signIn: true, publicUrl: 'http://cornfield.example.test' })).toThrow(/not https/);
    expect(() => assertBind('::', { signIn: true, publicUrl: 'https://cornfield.example.test' })).not.toThrow();
  });

  it('listen() follows it: sign-in configured with an https URL binds beyond loopback; refused before anything opens otherwise', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-bind-'));
    try {
      const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
      Object.assign(config, { host: '0.0.0.0', port: 0, forge: { type: 'github', repo: 'acme/home' } });
      expect(() => listen({ ...config, publicUrl: 'http://cornfield.example.test' }, { env: ENV })).toThrow(/not https/);
      expect(() => listen({ ...config, publicUrl: 'https://cornfield.example.test' }, { env: {} })).toThrow(/sign-in is not configured/);
      const { server, signIn } = await listen({ ...config, publicUrl: 'https://cornfield.example.test' }, { env: ENV });
      expect(signIn).toBe(true);
      expect(server.address().address).toBe('0.0.0.0');
      await new Promise((resolve) => server.close(resolve));
    } finally {
      fs.rmSync(data, { recursive: true, force: true });
    }
  });

  it('cornfield serve refuses half a sign-in, and a non-https URL beyond loopback, before it listens', () => {
    const run = (env) => spawnSync(process.execPath, [CLI, 'serve', '--repo', SAMPLE, '--port', '0'], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000 });
    const half = run({ CORNFIELD_FORGEJO_CLIENT_ID: 'x' });
    expect(half.status).toBe(1);
    expect(half.stderr).toMatch(/needs both CORNFIELD_FORGEJO_CLIENT_ID and CORNFIELD_FORGEJO_CLIENT_SECRET/);
    const plainHttp = run({ CORNFIELD_FORGEJO_CLIENT_ID: 'x', CORNFIELD_FORGEJO_CLIENT_SECRET: 'y', CORNFIELD_SESSION_SECRET: SESSION_SECRET, CORNFIELD_PUBLIC_URL: 'http://cornfield.example.test', CORNFIELD_HOST: '0.0.0.0' });
    expect(plainHttp.status).toBe(1);
    expect(plainHttp.stderr).toMatch(/will not listen on "0.0.0.0": its public URL is "http:\/\/cornfield.example.test", not https/);
  });
});

describe('a proxied path, with sign-in', () => {
  let fake;
  let upstream;
  let seen;
  let data;
  let srv;
  beforeAll(async () => {
    const gh = fakeGitHub();
    fake = await fakeForge(gh.routes);
    seen = [];
    // An upstream that logs what it is sent, and tries to set cornfield's cookies next to its own
    upstream = await fakeForge({
      'GET /api/x': (req) => {
        seen.push(req.headers);
        return { headers: { 'set-cookie': ['cornfield=attacker-chosen; Path=/; HttpOnly', '__Host-cornfield=attacker; Path=/; Secure', 'cornfield-oauth=x; Path=/', 'theirs=1; Path=/api'] }, body: { ok: true } };
      },
    });
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-auth-proxy-'));
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(config, { forge: { type: 'github', url: fake.url, repo: 'acme/home' }, publicUrl: PUBLIC, proxy: { '/api/': upstream.url } });
    srv = await serverOn(config, { env: ENV });
  });
  afterAll(async () => {
    await srv.close();
    await upstream.close();
    await fake.close();
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('sends the upstream none of cornfield\'s cookies, and lets it set none of them', async () => {
    const started = await raw(srv.port, 'GET', '/auth/start');
    const state = new URL(started.headers.location).searchParams.get('state');
    const back = await raw(srv.port, 'GET', `/auth/callback?code=c-maint&state=${state}`, { cookie: setCookies(started)['cornfield-oauth'].split(';')[0] });
    const session = setCookies(back).cornfield.split(';')[0];
    expect((await raw(srv.port, 'GET', '/api/x')).status).toBe(401);
    expect(seen).toEqual([]);
    const res = await raw(srv.port, 'GET', '/api/x', { cookie: `theirs=1; ${session}; cornfield-oauth=y; __Host-cornfield=z` });
    expect(res.status).toBe(200);
    expect(seen[0].cookie).toBe('theirs=1');
    expect(res.headers['set-cookie']).toEqual(['theirs=1; Path=/api']);
    await raw(srv.port, 'GET', '/api/x', { cookie: session });
    expect(seen[1].cookie).toBeUndefined();
  });
});

describe('the data folder', () => {
  it('a store that fails to open is tried again on the next request, and the log never has a query', async () => {
    const gh = fakeGitHub();
    const fake = await fakeForge(gh.routes);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-auth-store-'));
    const dataDir = path.join(dir, 'data');
    fs.writeFileSync(dataDir, 'a file where the folder should be');
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: dataDir } });
    Object.assign(config, { forge: { type: 'github', url: fake.url, repo: 'acme/home' }, publicUrl: PUBLIC });
    const srv = await serverOn(config, { env: ENV });
    const logged = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { logged.push(a.join(' ')); });
    try {
      const started = await raw(srv.port, 'GET', '/auth/start');
      const state = new URL(started.headers.location).searchParams.get('state');
      const cookie = setCookies(started)['cornfield-oauth'].split(';')[0];
      const failed = await raw(srv.port, 'GET', `/auth/callback?code=c-maint&state=${state}`, { cookie });
      expect(failed.status).toBe(500);
      expect(logged.join('\n')).toContain('GET /auth/callback:');
      expect(logged.join('\n')).not.toContain('c-maint');
      expect(logged.join('\n')).not.toContain(state);
      fs.rmSync(dataDir);
      const again = await raw(srv.port, 'GET', '/auth/start');
      const s2 = new URL(again.headers.location).searchParams.get('state');
      const ok = await raw(srv.port, 'GET', `/auth/callback?code=c-maint&state=${s2}`, { cookie: setCookies(again)['cornfield-oauth'].split(';')[0] });
      expect(ok.status).toBe(303);
    } finally {
      spy.mockRestore();
      await srv.close();
      await fake.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the proxy\'s cookie filters', () => {
  it('know every cookie cornfield sets, and nothing else', () => {
    expect(OWN_COOKIES).toEqual(['cornfield', 'cornfield-oauth', '__Host-cornfield', '__Host-cornfield-oauth']);
    expect(withoutOwnCookies(undefined)).toBeUndefined();
    expect(withoutOwnCookies('cornfield=a')).toBeUndefined();
    expect(withoutOwnCookies('a=1; cornfield=s;__Host-cornfield-oauth=t ; cornfield2=k; b')).toBe('a=1; cornfield2=k; b');
    expect(withoutOwnSetCookies(undefined)).toBeUndefined();
    expect(withoutOwnSetCookies(['cornfield=x; Path=/'])).toBeUndefined();
    expect(withoutOwnSetCookies('a=1; Path=/')).toEqual(['a=1; Path=/']);
    expect(withoutOwnSetCookies([' __Host-cornfield =x', 'cornfield-oauth=; Max-Age=0', 'cornfieldx=1'])).toEqual(['cornfieldx=1']);
  });
});
