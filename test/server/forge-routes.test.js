/**
 * @vitest-environment node
 *
 * The read-only forge routes behind the issues and PRs panel (server/forge-routes.js), against a fake forge on
 * loopback that serves the recorded GitHub answers (test/fixtures/forge/github.json): they ask the forge as the
 * signed-in maintainer with their own token, keep answers in `forge_cache` with an ETag, serve the last answer when the
 * forge is rate-limited, and say every failure in plain words. The guard in front of them is walked in auth.test.js.
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
import { SAMPLE } from '../helpers.js';
import { fakeForge, recordings } from './fake-forge.js';

const SESSION_SECRET = 'x'.repeat(40);
const ENV = { CORNFIELD_GITHUB_CLIENT_ID: 'test-client-id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: SESSION_SECRET };
const PUBLIC = 'http://127.0.0.1:3350';
const TOKEN = 'tok-maint';
const OPEN_PULLS = 'GET /api/v3/repos/owner/name/pulls?state=open&sort=created&direction=desc&per_page=100';

function raw(port, method, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: false }, (res) => {
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
    req.end();
  });
}

/** The recorded answers as a GitHub Enterprise Server serves them (under /api/v3), plus the OAuth token request */
function routesOf(state) {
  const out = {
    'POST /login/oauth/access_token': () => ({ body: { access_token: TOKEN, token_type: 'bearer' } }),
  };
  for (const [key, answer] of Object.entries(recordings('github'))) {
    if (key.startsWith('_')) continue;
    const [method, p] = key.split(' ');
    const served = p.startsWith('/repositories/') ? key : `${method} /api/v3${p}`;
    out[served] = (req) => (state.override[served] ? state.override[served](req) : answer);
  }
  return out;
}

describe('the forge routes', () => {
  let fake;
  let data;
  let plainData;
  let srv;
  let plain;
  let clock;
  const state = { override: {} };

  const start = async (config, opts) => {
    const server = createCornfieldServer(config, opts);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    return { port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
  };

  beforeAll(async () => {
    fake = await fakeForge(routesOf(state));
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-forge-'));
    plainData = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-forge-plain-'));
    const forge = { type: 'github', url: fake.url, repo: 'owner/name' };
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(config, { forge, publicUrl: PUBLIC });
    srv = await start(config, { env: ENV, now: () => clock });
    const open = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: plainData } });
    plain = await start(Object.assign(open, { forge }), { env: {} });
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
    state.override = {};
    fake.requests.length = 0;
    if (!fs.existsSync(path.join(data, 'cornfield.db'))) return;
    const db = new DatabaseSync(path.join(data, 'cornfield.db'));
    db.exec('DELETE FROM forge_cache');
    db.close();
  });

  /** Signs in the way a browser does; answers the session cookie */
  async function signIn() {
    const started = await raw(srv.port, 'GET', '/auth/start');
    const to = new URL(started.headers.location);
    const stateCookie = started.headers['set-cookie'].find((c) => c.startsWith('cornfield-oauth=')).split(';')[0];
    const back = await raw(srv.port, 'GET', `/auth/callback?code=c-maint&state=${to.searchParams.get('state')}`, { cookie: stateCookie });
    expect(back.status).toBe(303);
    return back.headers['set-cookie'].find((c) => c.startsWith('cornfield=')).split(';')[0];
  }
  const asked = (p) => fake.requests.filter((r) => r.url.includes(p));
  const cached = () => {
    const db = new DatabaseSync(path.join(data, 'cornfield.db'));
    const rows = db.prepare('SELECT key, etag, body, fetched_at FROM forge_cache').all();
    db.close();
    return rows;
  };

  it('lists the issues as the signed-in maintainer, with their own token, pull requests left out', async () => {
    const cookie = await signIn();
    fake.requests.length = 0;
    const res = await raw(srv.port, 'GET', '/api/forge/issues', { cookie });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ ok: true, forge: 'github', repo: 'owner/name' });
    expect(res.json.items.map((i) => i.number)).toEqual([5, 3]);
    expect(res.json.items[0]).toMatchObject({ title: 'Sign-in', labels: ['v1', 'server'], author: { login: 'maintainer-one' } });
    expect(res.json.rate).toBe(null);
    expect(asked('/issues').length).toBeGreaterThan(0);
    for (const r of asked('/issues')) expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{20}"$/);
  });

  it('passes the state and the labels on, and lists pull requests', async () => {
    const cookie = await signIn();
    const labelled = await raw(srv.port, 'GET', '/api/forge/issues?state=all&labels=v1,server', { cookie });
    expect(labelled.json.items.map((i) => [i.number, i.state])).toEqual([[5, 'open'], [2, 'closed']]);
    const pulls = await raw(srv.port, 'GET', '/api/forge/pulls', { cookie });
    expect(pulls.json.items.map((p) => p.number)).toEqual([13, 12]);
    const closed = await raw(srv.port, 'GET', '/api/forge/pulls?state=closed', { cookie });
    expect(closed.json.items.map((p) => [p.number, p.state])).toEqual([[9, 'merged'], [8, 'closed']]);
  });

  it('answers one pull request with its files and the checks on its head', async () => {
    const cookie = await signIn();
    const res = await raw(srv.port, 'GET', '/api/forge/pulls/12', { cookie });
    expect(res.status, res.text).toBe(200);
    expect(res.json.pull).toMatchObject({ number: 12, head: { sha: 'abc0000000000000000000000000000000000000' } });
    expect(res.json.files.map((f) => [f.path, f.status])).toEqual([
      ['docs/specs/proposals/0013-meals.json', 'added'], ['server/server.js', 'modified'], ['server/meals.js', 'renamed'], ['server/old.js', 'removed'],
    ]);
    expect(res.json.checks.map((c) => [c.name, c.state])).toEqual([['test', 'success'], ['ci/legacy', 'success']]);
    const red = await raw(srv.port, 'GET', '/api/forge/pulls/13', { cookie });
    expect(red.json.checks.map((c) => [c.name, c.state])).toEqual([['lint', 'failure'], ['test', 'running']]);
  });

  it('keeps an answer for a minute in forge_cache, per user, and the browser\'s revalidation is a 304', async () => {
    const cookie = await signIn();
    const first = await raw(srv.port, 'GET', '/api/forge/pulls', { cookie });
    const calls = asked('/pulls?').length;
    expect(calls).toBe(1);
    const rows = cached();
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('github|1001|pulls?state=open&limit=100');
    expect(rows[0].etag).toBe(first.headers.etag);
    expect(rows[0].body).not.toContain(TOKEN);
    clock += 30_000;
    const again = await raw(srv.port, 'GET', '/api/forge/pulls', { cookie });
    expect(again.json).toEqual(first.json);
    expect(asked('/pulls?')).toHaveLength(calls);
    const revalidated = await raw(srv.port, 'GET', '/api/forge/pulls', { cookie, 'if-none-match': first.headers.etag });
    expect(revalidated.status).toBe(304);
    expect(revalidated.text).toBe('');
    clock += 31_000;
    await raw(srv.port, 'GET', '/api/forge/pulls', { cookie });
    expect(asked('/pulls?')).toHaveLength(calls + 1);
  });

  it('asks the forge again when the browser says no-cache (the panel\'s Refresh)', async () => {
    const cookie = await signIn();
    await raw(srv.port, 'GET', '/api/forge/pulls', { cookie });
    await raw(srv.port, 'GET', '/api/forge/pulls', { cookie, 'cache-control': 'no-cache' });
    expect(asked('/pulls?')).toHaveLength(2);
  });

  it('says what is left of the forge\'s limit in words', async () => {
    const cookie = await signIn();
    state.override[OPEN_PULLS] = () => ({
      headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '48', 'x-ratelimit-reset': String(Date.parse('2026-10-19T12:06:00Z') / 1000) }, body: [],
    });
    const res = await raw(srv.port, 'GET', '/api/forge/pulls', { cookie });
    expect(res.json.rate).toBe('48 of 5000 GitHub calls left; the count resets at 12:06 UTC (in about 6 minutes).');
  });

  it('serves the last answer, saying why it is old, when the forge is rate-limited', async () => {
    const cookie = await signIn();
    const fresh = await raw(srv.port, 'GET', '/api/forge/pulls', { cookie });
    // The words about the reset are the adapter's, from the real clock: the reset is twelve minutes from now
    state.override[OPEN_PULLS] = () => ({
      status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 12 * 60) }, body: { message: 'API rate limit exceeded' },
    });
    clock += 120_000;
    const stale = await raw(srv.port, 'GET', '/api/forge/pulls', { cookie });
    expect(stale.status).toBe(200);
    expect(stale.json.items).toEqual(fresh.json.items);
    expect(stale.json.at).toBe(fresh.json.at);
    expect(stale.json.stale).toMatch(/^GitHub's limit for this sign-in is used up; it resets at \d\d:\d\d UTC \(in about 1[12] minutes\)\.$/);
    expect(stale.headers.etag).toBeUndefined();
    clock += 25 * 60 * 60 * 1000; // a day on, it is not kept any more
    const gone = await raw(srv.port, 'GET', '/api/forge/pulls', { cookie });
    expect([gone.status, gone.json.code]).toEqual([429, 'rate-limited']);
  });

  it('says a rate limit with nothing kept as 429, a missing pull request as 404, a forge that is down as 502', async () => {
    const cookie = await signIn();
    state.override['GET /api/v3/repos/owner/name/pulls/12'] = () => ({ status: 429, headers: { 'retry-after': '40' }, body: { message: 'slow down' } });
    const limited = await raw(srv.port, 'GET', '/api/forge/pulls/12', { cookie });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('40');
    expect(limited.json).toEqual({ ok: false, error: 'GitHub asked cornfield to slow down; try again in 40 seconds.', code: 'rate-limited' });
    const missing = await raw(srv.port, 'GET', '/api/forge/pulls/999', { cookie });
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe('GitHub has no pull request #999 in owner/name, or this sign-in cannot see it.');
    state.override['GET /api/v3/repos/owner/name/pulls/13'] = () => ({ status: 500, body: { message: 'boom' } });
    const down = await raw(srv.port, 'GET', '/api/forge/pulls/13', { cookie });
    expect(down.status).toBe(502);
    expect(down.json.error).toContain('could not answer');
  });

  it('refuses what it does not understand: a state, a limit, a number, a route, a write', async () => {
    const cookie = await signIn();
    expect((await raw(srv.port, 'GET', '/api/forge/issues?state=merged', { cookie })).status).toBe(400);
    const big = await raw(srv.port, 'GET', '/api/forge/pulls?limit=9999', { cookie });
    expect([big.status, big.json.error]).toEqual([400, 'The limit is at most 300.']);
    expect((await raw(srv.port, 'GET', '/api/forge/pulls?limit=none', { cookie })).status).toBe(400);
    expect((await raw(srv.port, 'GET', '/api/forge/pulls/0', { cookie })).status).toBe(404);
    expect((await raw(srv.port, 'GET', '/api/forge/pulls/12/merge', { cookie })).status).toBe(404);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await raw(srv.port, method, '/api/forge/pulls/12', { cookie, origin: `http://127.0.0.1:${srv.port}` });
      expect([method, res.status, res.headers.allow]).toEqual([method, 405, 'GET, HEAD']);
    }
    expect(fake.requests.filter((r) => r.method !== 'GET' && !r.url.startsWith('/login/'))).toEqual([]);
  });

  it('without sign-in there is nobody to ask as: a 403 in words, and the forge is not asked', async () => {
    for (const p of ['/api/forge/pulls/12', '/api/forge/issues', '/api/forge/pulls']) {
      const res = await raw(plain.port, 'GET', p);
      expect([p, res.status, res.json.ok, res.json.code]).toEqual([p, 403, false, 'forbidden']);
      expect(res.json.error).toBe('Issues and pull requests are read from GitHub as the signed-in maintainer: set up sign-in to see them (docs/sign-in.md).');
    }
    expect(fake.requests).toEqual([]);
    expect(fs.existsSync(path.join(plainData, 'cornfield.db'))).toBe(false);
  });

  it('a forge type with no adapter is a 501 that says so, before anything else is asked', async () => {
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: plainData } });
    Object.assign(config, { forge: { type: 'gitlab', url: fake.url, repo: 'owner/name' } });
    const other = await start(config, { env: {} });
    const res = await raw(other.port, 'GET', '/api/forge/pulls');
    expect([res.status, res.json.ok]).toEqual([501, false]);
    expect(res.json.error).toBe('cornfield has no adapter for the forge type "gitlab" yet.');
    expect(fake.requests).toEqual([]);
    await other.close();
  });

  it('with no forge in the config there is nothing to read', async () => {
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: plainData } });
    delete config.forge;
    const none = await start(config, { env: {} });
    const res = await raw(none.port, 'GET', '/api/forge/issues');
    expect([res.status, res.json.ok, res.json.error]).toEqual([404, false, 'No forge is configured: set `forge` in cornfield.config.js.']);
    await none.close();
  });
});
