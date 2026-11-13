/**
 * @vitest-environment node
 *
 * GET /api/forge/work-graph (server/forge-routes.js, server/work-graph.js) behind the gate every forge route has, against the recorded GitHub
 * answers of test/fixtures/forge/github.json served by a fake forge on loopback: the same body as the other forge routes for who may not ask, an
 * ETag, the forge asked again on no-cache but a pull request's files not, and nothing for an embedding origin. The graph itself is work-graph.test.js.
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

const ENV = { CORNFIELD_GITHUB_CLIENT_ID: 'test-client-id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: 'x'.repeat(40) };
const MAINT = 'tok-maint';
const READER = 'tok-reader';
const GH = '/api/v3/repos/owner/name';
const EMBED = 'http://tasks.example.test';

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

function routesOf(state) {
  const out = { 'POST /login/oauth/access_token': (req) => ({ body: { access_token: req.body.includes('c-reader') ? READER : MAINT, token_type: 'bearer' } }) };
  // the files of the two closed pull requests, which the recording has none of (a head whose files the forge cannot give is asked again each time)
  for (const n of [8, 9]) out[`GET ${GH}/pulls/${n}/files?per_page=100`] = { body: [{ sha: 'f', filename: 'server/auth.js', status: 'modified', additions: 1, deletions: 0 }] };
  for (const [key, answer] of Object.entries(recordings('github'))) {
    if (key.startsWith('_')) continue;
    const [method, p] = key.split(' ');
    const served = p.startsWith('/repositories/') ? key : `${method} /api/v3${p}`;
    out[served] = (req) => {
      const reader = req.headers.authorization === `Bearer ${READER}`;
      if (reader && served === 'GET /api/v3/user') return { body: { login: 'reader-two', id: 1002 } };
      if (reader && served === `GET ${GH}`) return { body: { id: 1, full_name: 'owner/name', permissions: { admin: false, maintain: false, push: false, triage: false, pull: true } } };
      return state.override[served] ? state.override[served](req) : answer;
    };
  }
  return out;
}

describe('GET /api/forge/work-graph', () => {
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
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-wgraph-'));
    plainData = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-wgraph-plain-'));
    const forge = { type: 'github', url: fake.url, repo: 'owner/name' };
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(config, { forge, publicUrl: 'http://127.0.0.1:3350', embed: { origins: [EMBED] }, deploys: { workflows: ['*deploy*'], restarts: { 'Deploy web': ['stack-web'] } } });
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

  async function signIn(code = 'c-maint') {
    const started = await raw(srv.port, 'GET', '/auth/start');
    const to = new URL(started.headers.location);
    const stateCookie = started.headers['set-cookie'].find((c) => c.startsWith('cornfield-oauth=')).split(';')[0];
    const back = await raw(srv.port, 'GET', `/auth/callback?code=${code}&state=${to.searchParams.get('state')}`, { cookie: stateCookie });
    expect(back.status, back.text).toBe(303);
    return back.headers['set-cookie'].find((c) => c.startsWith('cornfield=')).split(';')[0];
  }
  const asked = (p) => fake.requests.filter((r) => r.url.includes(p));
  const cached = () => {
    const db = new DatabaseSync(path.join(data, 'cornfield.db'));
    const rows = db.prepare('SELECT key, etag FROM forge_cache').all();
    db.close();
    return rows;
  };

  it('is for a signed-in maintainer only: signed out 401, a reader 403, no sign-in set up 403 in the other forge routes\' words, and the forge is not asked', async () => {
    expect((await raw(srv.port, 'GET', '/api/forge/work-graph')).status).toBe(401);
    fake.requests.length = 0;
    const reader = await raw(srv.port, 'GET', '/api/forge/work-graph', { cookie: await signIn('c-reader') });
    const readerElsewhere = await raw(srv.port, 'GET', '/api/forge/work', { cookie: await signIn('c-reader') });
    expect([reader.status, reader.json]).toEqual([403, { ok: false, error: 'Only maintainers can open this; ask one.' }]);
    expect([reader.status, reader.json]).toEqual([readerElsewhere.status, readerElsewhere.json]);
    expect(asked('/pulls')).toEqual([]);
    const none = await raw(plain.port, 'GET', '/api/forge/work-graph');
    const noneElsewhere = await raw(plain.port, 'GET', '/api/forge/work');
    expect([none.status, none.json.code]).toEqual([403, 'forbidden']);
    expect(none.json).toEqual(noneElsewhere.json);
    expect((await raw(srv.port, 'POST', '/api/forge/work-graph', { cookie: await signIn() })).status).toBe(405);
  });

  it('answers the nodes, the edges and the problems, as the signed-in maintainer, reading only', async () => {
    const cookie = await signIn();
    state.override[`GET ${GH}/issues?state=closed&sort=created&direction=desc&per_page=100`] = () => ({ body: [] });
    fake.requests.length = 0;
    const res = await raw(srv.port, 'GET', '/api/forge/work-graph', { cookie });
    expect(res.status, res.text).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.json).toMatchObject({ ok: true, forge: 'github', repo: 'owner/name', nodes: expect.any(Array), edges: expect.any(Array), problems: expect.any(Array) });
    const ids = res.json.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['pull:13', 'pull:9', 'issue:5', 'proposal:0013-meals']));
    expect(res.json.nodes.find((n) => n.id === 'issue:5')).toMatchObject({ kind: 'issue', stage: 'talk', number: 5, waiting: false });
    expect(res.json.edges.every((e) => ids.includes(e.from) || /^[a-z]/.test(e.from))).toBe(true);
    expect(fake.requests.every((r) => r.method === 'GET')).toBe(true);
    for (const r of fake.requests) expect(r.headers.authorization).toBe(`Bearer ${MAINT}`);
  });

  it('keeps the answer for a minute with an ETag, and revalidates it with a 304; no-cache asks the forge again but not for a pull request\'s files', async () => {
    const cookie = await signIn();
    const first = await raw(srv.port, 'GET', '/api/forge/work-graph', { cookie });
    expect(first.status).toBe(200);
    expect(first.headers.etag).toMatch(/^"[0-9a-f]{20}"$/);
    expect(cached().map((r) => r.key)).toEqual([expect.stringMatching(/^github\|1001\|work-graph\?config=[0-9a-f]{12}$/)]);
    const cold = asked('/pulls/').length;
    const lists = asked('/pulls?state=open').length;
    expect(lists).toBe(1);
    clock += 30_000;
    const again = await raw(srv.port, 'GET', '/api/forge/work-graph', { cookie, 'if-none-match': first.headers.etag });
    expect(again.status).toBe(304);
    expect(asked('/pulls?state=open')).toHaveLength(lists);
    // Refresh: the lists again, the files of a head not again, and the same bytes where nothing moved
    const refreshed = await raw(srv.port, 'GET', '/api/forge/work-graph', { cookie, 'cache-control': 'no-cache' });
    expect(asked('/pulls?state=open')).toHaveLength(lists + 1);
    expect(asked('/pulls/').length).toBe(cold);
    expect(refreshed.headers.etag).toBe(first.headers.etag);
  });

  it('a source failing is a line in problems, not a 500; the forge rate-limited with nothing read is the 429 of the other routes', async () => {
    const cookie = await signIn();
    state.override[`GET ${GH}/issues?state=open&sort=created&direction=desc&per_page=100`] = () => ({ status: 502, body: { message: 'Bad Gateway' } });
    const partial = await raw(srv.port, 'GET', '/api/forge/work-graph', { cookie, 'cache-control': 'no-cache' });
    expect(partial.status, partial.text).toBe(200);
    expect(partial.json.problems.map((p) => p.source)).toContain('issues');
    expect(partial.json.nodes.some((n) => n.kind === 'pull')).toBe(true);
    const limited = () => ({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) }, body: { message: 'API rate limit exceeded' } });
    for (const k of ['pulls?state=open&sort=created&direction=desc&per_page=100', 'pulls?state=closed&sort=created&direction=desc&per_page=100', 'issues?state=open&sort=created&direction=desc&per_page=100', 'issues?state=closed&sort=created&direction=desc&per_page=100', 'actions/runs?per_page=100']) state.override[`GET ${GH}/${k}`] = limited;
    const gone = await raw(srv.port, 'GET', '/api/forge/work-graph', { cookie, 'cache-control': 'no-cache' });
    expect(gone.status).toBe(200); // the answer kept before is served, and says why it is old
    expect(gone.json.stale).toEqual(expect.any(String));
    expect(gone.json.nodes).toEqual(partial.json.nodes);
  });

  it('is not an embedding origin\'s route: no CORS header on the read, none on a preflight', async () => {
    const cookie = await signIn();
    const read = await raw(srv.port, 'GET', '/api/forge/work-graph', { cookie, origin: EMBED });
    expect(read.headers['access-control-allow-origin']).toBeUndefined();
    expect(read.headers['access-control-allow-credentials']).toBeUndefined();
    const pre = await raw(srv.port, 'OPTIONS', '/api/forge/work-graph', { origin: EMBED, 'access-control-request-method': 'GET' });
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    expect(pre.status).not.toBe(204);
    // the one forge route a listed origin may read does get its header, so the check above is not a server that gives none
    const listed = await raw(srv.port, 'GET', '/api/forge/pulls/12', { cookie, origin: EMBED });
    expect(listed.headers['access-control-allow-origin']).toBe(EMBED);
  });
});
