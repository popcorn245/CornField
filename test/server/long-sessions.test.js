/**
 * @vitest-environment node
 *
 * Sessions that last (server/auth.js, server/hooks.js, issue #73), against fakes on loopback and a fake clock:
 *
 *   - `CORNFIELD_SESSION_DAYS`: 1 to 30, 7 when unset, anything else a startup error. With 30 a review token still works
 *     on day 20 (the session is live) and is refused with the existing 401 on day 31; with the default it is refused
 *     on day 8, as it always was
 *   - a forge token that expires is renewed with its refresh token: GitHub (an app with token expiration on) through a
 *     review token, Forgejo (1 hour tokens, always) through the 15-minute permission check. One renewal at a time per
 *     session, the new pair stored encrypted, a refused renewal ends the session (401), one the forge could not answer
 *     does not
 *   - `session.expiring`: once, about a day before a maintainer's session ends, naming the login and the time and
 *     nothing else; not again after a restart; never for a signed-out session or someone who is not a maintainer
 * No real forge, app or token.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error plain JS module, no declarations
import { createCornfieldServer } from '../../server/server.js';
// @ts-expect-error plain JS module, no declarations
import { signInSettings, SESSION_MS, MAX_SESSION_DAYS } from '../../server/auth.js';
// @ts-expect-error plain JS module, no declarations
import { ForgeError } from '../../server/forge.js';
// @ts-expect-error plain JS module, no declarations
import { SESSION_CHECK_MS } from '../../server/hooks.js';
// @ts-expect-error plain JS module, no declarations
import { loadConfig } from '../../core/config.js';
import { SAMPLE } from '../helpers.js';
import { fakeForge } from './fake-forge.js';

const SESSION_SECRET = 'x'.repeat(40);
const ENV = { CORNFIELD_GITHUB_CLIENT_ID: 'test-client-id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: SESSION_SECRET };
const FJ_ENV = { CORNFIELD_FORGEJO_CLIENT_ID: 'fj-id', CORNFIELD_FORGEJO_CLIENT_SECRET: 'not-real-fj', CORNFIELD_SESSION_SECRET: SESSION_SECRET };
const PUBLIC = 'http://127.0.0.1:3350';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-01T12:00:00Z');
const API = '/api/v3';
const GH = `${API}/repos/owner/name`;
const SLUG = '0040-meals';
const PATH = `docs/specs/proposals/${SLUG}.json`;
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

/** Signs in with a code the way a browser does; answers the session cookie (`name=value`) */
async function signedIn(port, code) {
  const started = await raw(port, 'GET', '/auth/start');
  const to = new URL(started.headers.location);
  const stateCookie = started.headers['set-cookie'].find((c) => c.startsWith('cornfield-oauth=')).split(';')[0];
  const back = await raw(port, 'GET', `/auth/callback?code=${code}&state=${to.searchParams.get('state')}`, { headers: { cookie: stateCookie } });
  expect(back.status, back.text).toBe(303);
  const set = back.headers['set-cookie'].find((c) => c.startsWith('cornfield='));
  return { cookie: set.split(';')[0], setCookie: set };
}

async function start(config, opts) {
  const server = createCornfieldServer(config, opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  return { port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
}

const rowsOf = (dir, sql, ...args) => {
  const db = new DatabaseSync(path.join(dir, 'cornfield.db'));
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
};

// ---------------------------------------------------------------------------

describe('CORNFIELD_SESSION_DAYS', () => {
  const config = { forge: { type: 'github', repo: 'acme/home' }, publicUrl: 'https://cornfield.example.test' };

  it('is 7 days when unset, and the default is what SESSION_MS has always been', () => {
    expect(signInSettings(config, ENV).sessionDays).toBe(7);
    expect(signInSettings(config, { ...ENV, CORNFIELD_SESSION_DAYS: '' }).sessionDays).toBe(7);
    expect(SESSION_MS).toBe(7 * DAY);
  });

  it('takes a whole number from 1 to 30', () => {
    for (const [v, days] of [['1', 1], ['14', 14], ['30', 30], [' 12 ', 12]]) expect(signInSettings(config, { ...ENV, CORNFIELD_SESSION_DAYS: v }).sessionDays, v).toBe(days);
    expect(MAX_SESSION_DAYS).toBe(30);
  });

  it('is a startup error out of range or not an integer, in words', () => {
    for (const v of ['0', '31', '-1', '7.5', '1e1', 'abc', '0x10', '7 days', '  ', '99999']) {
      expect(() => signInSettings(config, { ...ENV, CORNFIELD_SESSION_DAYS: v }), v).toThrow(/CORNFIELD_SESSION_DAYS is .*whole number of days from 1 to 30/);
    }
  });

  it('stops the server from starting', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-days-'));
    try {
      const cfg = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
      Object.assign(cfg, { forge: { type: 'github', url: 'http://127.0.0.1:1', repo: 'owner/name' }, publicUrl: PUBLIC });
      expect(() => createCornfieldServer(cfg, { env: { ...ENV, CORNFIELD_SESSION_DAYS: '31' } })).toThrow(/CORNFIELD_SESSION_DAYS/);
    } finally {
      fs.rmSync(data, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------

describe('GitHub: a review token over a long session', () => {
  let fake;
  let data;
  let srv;
  let clock;
  let world;

  /** The fake GitHub: one maintainer; one open spec PR; an OAuth app that may have token expiration on */
  const dispatch = (key, req) => {
    const method = key.slice(0, key.indexOf(' '));
    const target = key.slice(key.indexOf(' ') + 1);
    const auth = req.headers.authorization;
    if (key === 'POST /login/oauth/access_token') {
      const form = Object.fromEntries(new URLSearchParams(req.body));
      world.tokenRequests.push(form);
      if (form.grant_type === 'refresh_token') {
        if (world.refreshAnswer) return world.refreshAnswer;
        const n = ++world.issued;
        world.valid.add(`tok-${n}`);
        return { body: { access_token: `tok-${n}`, refresh_token: `rt-${n}`, expires_in: world.expiresIn, token_type: 'bearer' } };
      }
      world.issued = 1;
      world.valid.add('tok-1');
      return { body: { access_token: 'tok-1', token_type: 'bearer', ...(world.expiresIn ? { refresh_token: 'rt-1', expires_in: world.expiresIn } : {}) } };
    }
    if (key === 'DELETE /api/v3/applications/test-client-id/token') return { status: 204 };
    const bearer = String(auth || '').replace(/^Bearer /, '');
    if (!world.valid.has(bearer)) return { status: 401, body: { message: 'Bad credentials' } };
    if (key === `GET ${API}/user`) return { body: { login: 'maintainer-one', id: 1001 } };
    if (key === `GET ${GH}`) return { body: { id: 1, full_name: 'owner/name', permissions: { admin: false, maintain: true, push: true, triage: true, pull: true } } };
    if (!target.startsWith(GH)) return { status: 404, body: { message: 'Not Found' } };
    const url = new URL(target.slice(GH.length), 'http://x');
    const p = decodeURIComponent(url.pathname);
    if (method === 'GET' && /^\/collaborators\/[^/]+\/permission$/.test(p)) return { body: { permission: 'write', role_name: 'maintain', user: { login: 'maintainer-one' } } };
    if (method === 'GET' && p === '/pulls/40') return { body: world.pull };
    if (method === 'GET' && p === '/pulls/40/files') return { body: [{ filename: PATH, status: 'modified', additions: 1, deletions: 0, changes: 1 }] };
    if (method === 'GET' && p === '/issues/40/comments') return { body: world.comments };
    if (method === 'POST' && p === '/issues/40/comments') {
      world.posted.push({ as: bearer, body: JSON.parse(req.body).body });
      const c = { id: 9100 + world.comments.length, user: { login: 'maintainer-one', html_url: 'https://github.example.com/maintainer-one' }, body: JSON.parse(req.body).body, html_url: `https://github.example.com/owner/name/pull/40#issuecomment-${9100 + world.comments.length}`, created_at: new Date(clock).toISOString(), updated_at: new Date(clock).toISOString() };
      world.comments.push(c);
      return { status: 201, body: c };
    }
    if (method === 'GET' && p.startsWith('/contents/')) {
      return p.slice('/contents/'.length) === PATH && url.searchParams.get('ref') === world.pull.head.sha ? { headers: { 'content-type': 'application/vnd.github.raw; charset=utf-8' }, body: world.text } : { status: 404, body: { message: 'Not Found' } };
    }
    return { status: 404, body: { message: 'Not Found' } };
  };

  beforeAll(async () => {
    fake = await fakeForge(new Proxy({}, { get: (_, key) => (typeof key === 'string' ? (req) => dispatch(key, req) : undefined) }));
  });
  afterAll(async () => { await fake.close(); });

  beforeEach(() => {
    clock = T0;
    world = {
      expiresIn: 0, issued: 0, valid: new Set(), tokenRequests: [], refreshAnswer: null, posted: [], comments: [],
      text: proposalOf('Meals'),
      pull: { number: 40, title: 'Meals spec', state: 'open', draft: false, user: { login: 'agent-four', html_url: 'https://github.example.com/agent-four' }, labels: [], head: { ref: 'spec/meals', sha: `${'a'.repeat(39)}1` }, base: { ref: 'main' }, html_url: 'https://github.example.com/owner/name/pull/40', created_at: '2026-10-19T10:00:00Z', updated_at: '2026-10-19T10:30:00Z', merged_at: null },
    };
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-long-'));
  });
  afterEach(async () => {
    await srv?.close();
    fs.rmSync(data, { recursive: true, force: true });
  });

  const boot = async (extraEnv = {}) => {
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(config, { forge: { type: 'github', url: fake.url, repo: 'owner/name' }, publicUrl: PUBLIC });
    srv = await start(config, { env: { ...ENV, ...extraEnv }, now: () => clock });
    return signedIn(srv.port, 'c-maint');
  };
  const mint = async (cookie) => {
    const body = JSON.stringify({ label: 'chat bot', days: 90 });
    const res = await raw(srv.port, 'POST', '/api/review-tokens', { headers: { cookie, origin: `http://127.0.0.1:${srv.port}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, body });
    expect(res.status, res.text).toBe(201);
    return res.json.secret;
  };
  const review = (secret) => {
    const body = JSON.stringify({ pull: 40, slug: SLUG, sha256: sha256(world.text), verdict: 'approved', note: 'Ship it.' });
    return raw(srv.port, 'POST', '/api/reviews', { headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, body });
  };
  const session = () => rowsOf(data, 'SELECT * FROM sessions')[0];

  it('works on day 20 with the setting at 30, the session still live, and is refused with the 401 on day 31', async () => {
    const { cookie, setCookie } = await boot({ CORNFIELD_SESSION_DAYS: '30' });
    expect(setCookie).toContain(`Max-Age=${30 * 86400}`);
    expect(Date.parse(session().expires_at)).toBe(T0 + 30 * DAY);
    const secret = await mint(cookie);

    clock = T0 + 20 * DAY;
    const ok = await review(secret);
    expect(ok.status, ok.text).toBe(200);
    expect(world.posted).toHaveLength(1);
    expect(world.posted[0].as).toBe('tok-1');
    // the session is still the one from day 0, and live: nothing was signed in again, nothing was extended
    expect(rowsOf(data, 'SELECT count(*) AS n FROM sessions WHERE expires_at > ?', new Date(clock).toISOString())[0].n).toBe(1);
    expect(Date.parse(session().expires_at)).toBe(T0 + 30 * DAY);
    expect((await raw(srv.port, 'GET', '/auth/me', { headers: { cookie } })).status).toBe(200);

    clock = T0 + 31 * DAY;
    const late = await review(secret);
    expect(late.status, late.text).toBe(401);
    expect(late.json.error).toMatch(/no live sign-in/);
    expect(world.posted).toHaveLength(1);
    expect((await raw(srv.port, 'GET', '/auth/me', { headers: { cookie } })).status).toBe(401);
  });

  it('keeps the default of 7 days: the cookie, the row, day 6 works and day 8 is the 401', async () => {
    const { cookie, setCookie } = await boot();
    expect(setCookie).toContain(`Max-Age=${7 * 86400}`);
    expect(Date.parse(session().expires_at)).toBe(T0 + 7 * DAY);
    const secret = await mint(cookie);
    clock = T0 + 6 * DAY;
    expect((await review(secret)).status).toBe(200);
    clock = T0 + 8 * DAY;
    const late = await review(secret);
    expect(late.status, late.text).toBe(401);
    expect(world.posted).toHaveLength(1);
  });

  it('GitHub tokens that do not expire are never renewed: no expiry, no refresh token, no refresh request', async () => {
    const { cookie } = await boot({ CORNFIELD_SESSION_DAYS: '30' });
    expect(session()).toMatchObject({ refresh_token: '', token_expires_at: null });
    const secret = await mint(cookie);
    clock = T0 + 20 * DAY;
    expect((await review(secret)).status).toBe(200);
    expect(world.tokenRequests.filter((f) => f.grant_type === 'refresh_token')).toEqual([]);
  });

  describe('an app with token expiration on (expires_in and a refresh token)', () => {
    beforeEach(() => { world.expiresIn = 8 * 3600; });

    it('keeps the pair encrypted, with the expiry', async () => {
      await boot();
      const row = session();
      expect(row.token_expires_at).toBe(new Date(T0 + 8 * HOUR).toISOString());
      expect(row.refresh_token).toMatch(/^v2\./);
      expect(row.token).toMatch(/^v2\./);
      const file = fs.readFileSync(path.join(data, 'cornfield.db'));
      expect(file.includes('rt-1')).toBe(false);
      expect(file.includes('tok-1')).toBe(false);
    });

    it('renews an expired token before a review token acts, posts with the new one, and stores the new pair', async () => {
      const { cookie } = await boot({ CORNFIELD_SESSION_DAYS: '30' });
      const secret = await mint(cookie);
      const before = session();
      clock = T0 + 20 * DAY;
      const res = await review(secret);
      expect(res.status, res.text).toBe(200);
      expect(world.tokenRequests.filter((f) => f.grant_type === 'refresh_token')).toEqual([{ client_id: 'test-client-id', client_secret: 'not-real', grant_type: 'refresh_token', refresh_token: 'rt-1' }]);
      expect(world.posted.map((p) => p.as)).toEqual(['tok-2']);
      const after = session();
      expect(after.token).not.toBe(before.token);
      expect(after.refresh_token).not.toBe(before.refresh_token);
      expect(after.token_expires_at).toBe(new Date(clock + 8 * HOUR).toISOString());
      expect(after.expires_at).toBe(before.expires_at); // a renewed forge token does not lengthen the session
      expect(fs.readFileSync(path.join(data, 'cornfield.db')).includes('rt-2')).toBe(false);
    });

    it('renews once and retries when the forge refuses a token that has not expired by the stored clock (a 401)', async () => {
      const { cookie } = await boot();
      const secret = await mint(cookie);
      world.valid.delete('tok-1'); // revoked or expired early at the forge
      clock = T0 + 1 * HOUR;
      const res = await review(secret);
      expect(res.status, res.text).toBe(200);
      expect(world.tokenRequests.filter((f) => f.grant_type === 'refresh_token')).toHaveLength(1);
      expect(world.posted.map((p) => p.as)).toEqual(['tok-2']);
    });

    it('ends the session when the forge refuses the refresh token: the existing 401, and signing in again is the way back', async () => {
      const { cookie } = await boot();
      const secret = await mint(cookie);
      clock = T0 + 9 * HOUR;
      world.refreshAnswer = { status: 200, body: { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' } };
      const res = await review(secret);
      expect(res.status, res.text).toBe(401);
      expect(world.posted).toEqual([]);
      expect(rowsOf(data, 'SELECT * FROM sessions')).toEqual([]);
      expect((await raw(srv.port, 'GET', '/auth/me', { headers: { cookie } })).status).toBe(401);
      // the next review has no live sign-in, as before
      clock += 20_000;
      expect((await review(secret)).status).toBe(401);
      // signed in again, the same token works again
      world.refreshAnswer = null;
      await signedIn(srv.port, 'c-maint');
      clock += 20_000;
      expect((await review(secret)).status).toBe(200);
    });

    it('keeps the session when the forge cannot be asked to renew (not a refusal): the review fails, the next one can work', async () => {
      const { cookie } = await boot();
      const secret = await mint(cookie);
      clock = T0 + 9 * HOUR;
      world.refreshAnswer = { status: 503, body: { message: 'down' } };
      const res = await review(secret);
      expect(res.status, res.text).not.toBe(200);
      expect(res.status).not.toBe(401);
      expect(rowsOf(data, 'SELECT * FROM sessions')).toHaveLength(1);
      world.refreshAnswer = null;
      clock += 20_000;
      expect((await review(secret)).status).toBe(200);
      expect((await raw(srv.port, 'GET', '/auth/me', { headers: { cookie } })).status).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------

describe('Forgejo: tokens that last an hour', () => {
  let fake;
  let data;
  let srv;
  let clock;
  let st;
  let fjConfig;
  let stubForge;

  /** A token endpoint like Forgejo's: 1 hour access tokens, a rotating refresh token */
  const routes = {
    'POST /login/oauth/access_token': async (req) => {
      const form = Object.fromEntries(new URLSearchParams(req.body));
      st.requests.push(form);
      if (form.grant_type === 'refresh_token') {
        // A test can hold the renewals until two have arrived: two processes renewing the same row at once
        if (st.together) {
          st.together.arrived += 1;
          if (st.together.arrived >= 2) st.together.release();
          await st.together.both;
        }
        if (st.refreshAnswer) return st.refreshAnswer;
        if (form.refresh_token !== st.refreshToken) {
          if (st.together) await new Promise((r) => setTimeout(r, 50)); // the loser hears after the winner has written
          return { status: 400, body: { error: 'invalid_grant', error_description: 'unable to parse refresh token' } };
        }
      }
      st.n += 1;
      st.valid = new Set([`fj-${st.n}`]); // an issued token replaces the last: only the newest works
      st.refreshToken = `fjr-${st.n}`;
      return { body: { access_token: `fj-${st.n}`, token_type: 'bearer', ...(st.refresh ? { refresh_token: `fjr-${st.n}` } : {}), ...(st.expiresIn ? { expires_in: st.expiresIn } : {}) } };
    },
  };

  beforeAll(async () => { fake = await fakeForge(routes); });
  afterAll(async () => { await fake.close(); });
  beforeEach(async () => {
    clock = T0;
    st = { n: 0, requests: [], valid: new Set(), refreshToken: null, refreshAnswer: null, refresh: true, expiresIn: 3600, asked: [], together: null };
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-long-fj-'));
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(config, { forge: { type: 'forgejo', url: fake.url, repo: 'acme/home' }, publicUrl: PUBLIC });
    fjConfig = config;
    // A stand-in for the Forgejo adapter: it knows which token is good, and refuses (401) any other
    const createForge = stubForge = (_forge, { token }) => {
      const guard = () => {
        st.asked.push(token);
        if (!st.valid.has(token)) throw new ForgeError('Forgejo did not accept the sign-in; sign in again.', { code: 'unauthorized', status: 401, forge: 'Forgejo' });
      };
      return {
        me: async () => { guard(); return { id: '7', login: 'fj-maintainer' }; },
        permission: async () => { guard(); return 'admin'; },
        rateLimit: () => null,
      };
    };
    srv = await start(config, { env: FJ_ENV, now: () => clock, createForge });
  });
  afterEach(async () => {
    await srv.close();
    fs.rmSync(data, { recursive: true, force: true });
  });

  const refreshes = () => st.requests.filter((f) => f.grant_type === 'refresh_token');
  const session = () => rowsOf(data, 'SELECT * FROM sessions')[0];
  const dashboard = (cookie) => raw(srv.port, 'GET', '/topology.json', { headers: { cookie } });

  it('keeps the refresh token, encrypted, and the hour the access token lasts', async () => {
    await signedIn(srv.port, 'c');
    const row = session();
    expect(row.token_expires_at).toBe(new Date(T0 + HOUR).toISOString());
    expect(row.refresh_token).toMatch(/^v2\./);
    expect(fs.readFileSync(path.join(data, 'cornfield.db')).includes('fjr-1')).toBe(false);
  });

  it('refreshes an expired token transparently, calls with the new one, and stores the new pair', async () => {
    const { cookie } = await signedIn(srv.port, 'c');
    const before = session();
    clock = T0 + 2 * HOUR; // past the hour, and the permission is due again
    st.asked.length = 0;
    expect((await dashboard(cookie)).status).toBe(200);
    expect(refreshes()).toEqual([{ client_id: 'fj-id', client_secret: 'not-real-fj', grant_type: 'refresh_token', refresh_token: 'fjr-1' }]);
    expect(st.asked).toEqual(['fj-2', 'fj-2']); // never the expired token
    const after = session();
    expect(after.token).not.toBe(before.token);
    expect(after.refresh_token).not.toBe(before.refresh_token);
    expect(after.token_expires_at).toBe(new Date(clock + HOUR).toISOString());
    expect(after.expires_at).toBe(before.expires_at);
    expect(after.checked_at).toBe(new Date(clock).toISOString());
    // and the new pair is the one in use next time (rotation: fjr-1 no longer works)
    clock += 2 * HOUR;
    expect((await dashboard(cookie)).status).toBe(200);
    expect(refreshes().map((f) => f.refresh_token)).toEqual(['fjr-1', 'fjr-2']);
  });

  it('does not refresh a token that is still good', async () => {
    const { cookie } = await signedIn(srv.port, 'c');
    clock = T0 + 20 * MIN; // the permission is due, the token is not
    expect((await dashboard(cookie)).status).toBe(200);
    expect(refreshes()).toEqual([]);
  });

  it('renews once for calls that arrive together', async () => {
    const { cookie } = await signedIn(srv.port, 'c');
    clock = T0 + 2 * HOUR;
    const all = await Promise.all([1, 2, 3, 4].map(() => dashboard(cookie)));
    expect(all.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(refreshes()).toHaveLength(1);
  });

  it('refreshes on a 401 when the forge refuses a token the clock says is good', async () => {
    st.expiresIn = 0; // an instance that does not say how long a token lasts
    const { cookie } = await signedIn(srv.port, 'c');
    expect(session().token_expires_at).toBeNull();
    st.valid = new Set(); // the token stops working
    clock = T0 + 20 * MIN;
    expect((await dashboard(cookie)).status).toBe(200);
    expect(refreshes()).toHaveLength(1);
    expect(session().token_expires_at).toBeNull();
  });

  it('ends the session when the refresh token is refused: 401, the row is gone, sign in again', async () => {
    const { cookie } = await signedIn(srv.port, 'c');
    st.refreshAnswer = { status: 400, body: { error: 'invalid_grant', error_description: 'refresh token is revoked' } };
    clock = T0 + 2 * HOUR;
    const res = await dashboard(cookie);
    expect(res.status).toBe(401);
    expect(rowsOf(data, 'SELECT * FROM sessions')).toEqual([]);
    expect((await raw(srv.port, 'GET', '/auth/me', { headers: { cookie } })).status).toBe(401);
  });

  it('ends the session when there is no refresh token to renew with', async () => {
    st.refresh = false;
    const { cookie } = await signedIn(srv.port, 'c');
    expect(session().refresh_token).toBe('');
    clock = T0 + 2 * HOUR;
    st.valid = new Set(); // Forgejo no longer accepts the hour-old token
    expect((await dashboard(cookie)).status).toBe(401);
    expect(refreshes()).toEqual([]);
    expect(rowsOf(data, 'SELECT * FROM sessions')).toEqual([]);
  });

  it('does not end a valid session when two processes renew it at once: the one the forge refuses takes the winner\'s pair', async () => {
    const { cookie } = await signedIn(srv.port, 'c');
    // A second cornfield on the same data folder (a restart that overlaps, two behind one volume)
    const other = await start(fjConfig, { env: FJ_ENV, now: () => clock, createForge: stubForge });
    try {
      let release = () => {};
      st.together = { arrived: 0, both: new Promise((r) => { release = r; }), release: () => release() };
      clock = T0 + 2 * HOUR;
      const [a, b] = await Promise.all([dashboard(cookie), raw(other.port, 'GET', '/topology.json', { headers: { cookie } })]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(refreshes().map((f) => f.refresh_token)).toEqual(['fjr-1', 'fjr-1']); // one won, one was refused
      expect(rowsOf(data, 'SELECT * FROM sessions')).toHaveLength(1);
      st.together = null;
      // and the session goes on with the winner's pair
      clock += 2 * HOUR;
      expect((await dashboard(cookie)).status).toBe(200);
      expect(refreshes().at(-1).refresh_token).toBe('fjr-2');
    } finally {
      await other.close();
    }
  });

  it('a token sealed for one session does not open in another\'s row', async () => {
    const one = await signedIn(srv.port, 'c');
    const two = await signedIn(srv.port, 'c');
    st.valid = new Set(['fj-1', 'fj-2']); // both sign-ins' tokens are good at the forge
    const [a, b] = rowsOf(data, 'SELECT id, token, refresh_token FROM sessions ORDER BY created_at, rowid');
    expect(a.id).not.toBe(b.id);
    // Somebody who can write the file (not the key) copies session one's sealed pair into session two
    const db = new DatabaseSync(path.join(data, 'cornfield.db'));
    db.prepare('UPDATE sessions SET token = ?, refresh_token = ? WHERE id = ?').run(a.token, a.refresh_token, b.id);
    db.close();
    clock = T0 + 20 * MIN; // the permission is due again: the token is opened
    expect((await dashboard(two.cookie)).status).toBe(401);
    expect((await dashboard(one.cookie)).status).toBe(200);
  });

  it('ends no session for a rate limit, a timeout or an answer too large to be a token pair', async () => {
    const { cookie } = await signedIn(srv.port, 'c');
    for (const answer of [{ status: 429, body: 'slow down' }, { status: 408, body: '' }, { status: 200, body: 'x'.repeat(100 * 1024) }]) {
      st.refreshAnswer = answer;
      clock += 2 * HOUR;
      expect((await dashboard(cookie)).status, String(answer.status)).toBe(503);
      expect(rowsOf(data, 'SELECT * FROM sessions'), String(answer.status)).toHaveLength(1);
    }
    st.refreshAnswer = null;
    expect((await dashboard(cookie)).status).toBe(200);
  });

  it('a call just before expiry still works with the old token when renewing ahead cannot be done now', async () => {
    const { cookie } = await signedIn(srv.port, 'c');
    st.refreshAnswer = { status: 503, body: { message: 'down' } };
    clock = T0 + HOUR - 10_000; // inside the 30 s skew, not yet expired; the permission is due again
    expect((await dashboard(cookie)).status).toBe(200);
    expect(refreshes().length).toBeGreaterThan(0); // each call tried, and went on when it could not
    expect(st.asked.slice(-2)).toEqual(['fj-1', 'fj-1']); // me() and permission(), with the token that still works
    expect(rowsOf(data, 'SELECT * FROM sessions')).toHaveLength(1);
  });

  it('keeps the session when Forgejo cannot be asked to renew: 503 now, fine when it is back', async () => {
    const { cookie } = await signedIn(srv.port, 'c');
    st.refreshAnswer = { status: 503, body: { message: 'down' } };
    clock = T0 + 2 * HOUR;
    expect((await dashboard(cookie)).status).toBe(503);
    expect(rowsOf(data, 'SELECT * FROM sessions')).toHaveLength(1);
    st.refreshAnswer = null;
    expect((await dashboard(cookie)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('the session.expiring hook event', () => {
  const HOOK_SECRET = 'h'.repeat(40);
  let fake;
  let receiver;
  let got;
  let data;
  let srv;
  let clock;
  let tokens;
  /** The hook timer: the sessions check is held here until the test runs it; everything else is a real timer */
  let held;

  const timer = {
    setTimeout(fn, ms, ...rest) {
      if (ms === 0 || ms === SESSION_CHECK_MS) {
        const handle = { fn, ms, unref() {}, cleared: false };
        held.push(handle);
        return handle;
      }
      return setTimeout(fn, ms, ...rest);
    },
    clearTimeout(h) {
      if (h && typeof h === 'object' && 'fn' in h) h.cleared = true;
      else clearTimeout(h);
    },
  };
  /** Runs the sessions check that is waiting, and lets it finish */
  const runCheck = async () => {
    const h = held.find((x) => !x.cleared);
    expect(h, 'a sessions check is scheduled').toBeTruthy();
    held.splice(held.indexOf(h), 1);
    h.fn();
    await new Promise((r) => setTimeout(r, 150));
  };

  beforeAll(async () => {
    fake = await fakeForge({
      'POST /login/oauth/access_token': (req) => {
        const code = new URLSearchParams(req.body).get('code');
        return { body: { access_token: tokens[code], token_type: 'bearer' } };
      },
      'GET /api/v3/user': (req) => {
        const t = String(req.headers.authorization).replace(/^Bearer /, '');
        return { body: t === 'tok-reader' ? { login: 'reader-two', id: 1002 } : { login: 'maintainer-one', id: 1001 } };
      },
      'GET /api/v3/repos/acme/home': (req) => {
        const reader = req.headers.authorization === 'Bearer tok-reader';
        return { body: { full_name: 'acme/home', permissions: { admin: false, maintain: !reader, push: !reader, triage: !reader, pull: true } } };
      },
      'DELETE /api/v3/applications/test-client-id/token': { status: 204 },
    });
    receiver = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        got.push({ event: req.headers['x-cornfield-event'], valid: req.headers['x-cornfield-signature'] === `sha256=${createHmac('sha256', HOOK_SECRET).update(body).digest('hex')}`, text: body.toString('utf8'), body: JSON.parse(body.toString('utf8')) });
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise((resolve) => receiver.listen(0, '127.0.0.1', () => resolve(undefined)));
  });
  afterAll(async () => {
    await fake.close();
    await new Promise((resolve) => { receiver.closeAllConnections(); receiver.close(() => resolve(undefined)); });
  });
  beforeEach(() => {
    clock = T0;
    got = [];
    held = [];
    tokens = { 'c-maint': 'tok-maint', 'c-maint2': 'tok-maint-two', 'c-reader': 'tok-reader' };
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-expiring-'));
  });
  afterEach(async () => {
    await srv?.close();
    fs.rmSync(data, { recursive: true, force: true });
  });

  const boot = async () => {
    await srv?.close();
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(config, {
      forge: { type: 'github', url: fake.url, repo: 'acme/home' }, publicUrl: PUBLIC,
      hooks: [{ url: `http://127.0.0.1:${receiver.address().port}/hook`, events: ['session.expiring'] }],
    });
    held = [];
    srv = await start(config, { env: { ...ENV, CORNFIELD_HOOK_SECRET: HOOK_SECRET }, now: () => clock, hookTimer: timer });
  };
  const waitFor = (fn) => vi.waitFor(fn, { timeout: 3000, interval: 25 });

  it('is sent once, about a day before the session ends, with the login and the time and nothing else', async () => {
    await boot();
    await signedIn(srv.port, 'c-maint');
    const expiresAt = new Date(T0 + 7 * DAY).toISOString();

    clock = T0 + 5 * DAY; // two days left: too early
    await runCheck();
    expect(got).toEqual([]);

    clock = T0 + 6 * DAY + HOUR; // 23 hours left
    await runCheck();
    await waitFor(() => expect(got).toHaveLength(1));
    expect(got[0].valid).toBe(true);
    expect(got[0].event).toBe('session.expiring');
    expect(got[0].body).toEqual({ event: 'session.expiring', at: new Date(clock).toISOString(), actor: 'maintainer-one', expiresAt, mapUrl: PUBLIC });
    expect(got[0].text).not.toMatch(/tok-|@|email|token/i);

    // the next hour, and the hours after: not again
    clock += HOUR;
    await runCheck();
    clock += 5 * HOUR;
    await runCheck();
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toHaveLength(1);
  });

  it('is not sent again after a restart', async () => {
    await boot();
    await signedIn(srv.port, 'c-maint');
    clock = T0 + 6 * DAY + HOUR;
    await runCheck();
    await waitFor(() => expect(got).toHaveLength(1));
    expect(rowsOf(data, 'SELECT expiring_sent_at FROM sessions')[0].expiring_sent_at).toBe(new Date(clock).toISOString());

    await boot(); // a restart: same data folder
    clock += 2 * HOUR;
    await runCheck();
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toHaveLength(1);
  });

  it('is sent after a restart when the first run missed the window (the server was down at the time)', async () => {
    await boot();
    await signedIn(srv.port, 'c-maint');
    await srv.close();
    srv = null;
    clock = T0 + 6 * DAY + 20 * HOUR; // 4 hours left when it comes back
    await boot();
    await runCheck();
    await waitFor(() => expect(got).toHaveLength(1));
  });

  it('never fires for a session that was signed out', async () => {
    await boot();
    const { cookie } = await signedIn(srv.port, 'c-maint');
    const out = await raw(srv.port, 'POST', '/auth/sign-out', { headers: { cookie, origin: `http://127.0.0.1:${srv.port}`, 'sec-fetch-site': 'same-origin' } });
    expect(out.status).toBe(303);
    clock = T0 + 6 * DAY + HOUR;
    await runCheck();
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toEqual([]);
  });

  it('never fires for a session that has already ended, or for someone who is not a maintainer', async () => {
    await boot();
    await signedIn(srv.port, 'c-reader');
    await signedIn(srv.port, 'c-maint');
    clock = T0 + 7 * DAY + 1000; // the maintainer\'s is over too
    await runCheck();
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toEqual([]);
  });

  it('follows CORNFIELD_SESSION_DAYS: with 30 days nothing fires on day 6, and one does on day 29', async () => {
    await srv?.close();
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(config, { forge: { type: 'github', url: fake.url, repo: 'acme/home' }, publicUrl: PUBLIC, hooks: [{ url: `http://127.0.0.1:${receiver.address().port}/hook`, events: '*' }] });
    held = [];
    srv = await start(config, { env: { ...ENV, CORNFIELD_SESSION_DAYS: '30', CORNFIELD_HOOK_SECRET: HOOK_SECRET }, now: () => clock, hookTimer: timer });
    await signedIn(srv.port, 'c-maint');
    clock = T0 + 6 * DAY + HOUR;
    await runCheck();
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual([]);
    clock = T0 + 29 * DAY + HOUR;
    await runCheck();
    await waitFor(() => expect(got).toHaveLength(1));
    expect(got[0].body.expiresAt).toBe(new Date(T0 + 30 * DAY).toISOString());
  });

  it('is one event for each live session of a user (a laptop and a phone), each with its own end', async () => {
    await boot();
    await signedIn(srv.port, 'c-maint');
    clock = T0 + 2 * DAY;
    tokens['c-maint'] = 'tok-maint-again';
    await signedIn(srv.port, 'c-maint');
    clock = T0 + 6 * DAY + 2 * HOUR; // the first ends in 22 hours, the second in 3 days
    await runCheck();
    await waitFor(() => expect(got).toHaveLength(1));
    expect(got[0].body.expiresAt).toBe(new Date(T0 + 7 * DAY).toISOString());
    clock = T0 + 8 * DAY + 2 * HOUR; // the second ends in 23 hours
    await runCheck();
    await waitFor(() => expect(got).toHaveLength(2));
    expect(got.map((g) => g.body.actor)).toEqual(['maintainer-one', 'maintainer-one']);
    expect(got[1].body.expiresAt).toBe(new Date(T0 + 9 * DAY).toISOString());
  });

  it('is not started for a server whose hooks do not ask for it, and its timer is stopped by close()', async () => {
    await srv?.close();
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(config, { forge: { type: 'github', url: fake.url, repo: 'acme/home' }, publicUrl: PUBLIC, hooks: [{ url: `http://127.0.0.1:${receiver.address().port}/hook`, events: ['spec.ready'] }] });
    held = [];
    srv = await start(config, { env: { ...ENV, CORNFIELD_HOOK_SECRET: HOOK_SECRET }, now: () => clock, hookTimer: timer });
    expect(held).toEqual([]);
    await boot();
    expect(held).toHaveLength(1);
    const pending = held[0];
    await srv.close();
    srv = null;
    expect(pending.cleared).toBe(true);
  });
});
