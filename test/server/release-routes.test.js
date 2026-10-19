/**
 * @vitest-environment node
 *
 * The release notes routes (server/forge-routes.js) against a fake forge on loopback that serves the recorded GitHub
 * answers for the notes world (test/fixtures/forge/notes-github.json), with a maintainer signed in the way a browser
 * signs in:
 *
 *   - GET /api/forge/release-notes: the notes since a tag, grouped by the sample repo's map, kept in forge_cache;
 *   - POST /api/forge/release-drafts: the one write. Same-origin only, the maintainer asked about again at that moment,
 *     a row in `actions` before the forge is asked and the forge's answer after, a DRAFT release and nothing else
 *     (no tag, no publish), and every refusal in words with nothing written.
 *
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
const RELEASES = 'POST /api/v3/repos/owner/name/releases';
const REPO = 'GET /api/v3/repos/owner/name';
const CLOSED = 'GET /api/v3/repos/owner/name/pulls?state=closed&sort=created&direction=desc&per_page=100';

function raw(port, method, target, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const sent = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
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

/** The notes world as GitHub Enterprise Server serves it (under /api/v3), with the user and the repo from the contract's */
function routesOf(state) {
  const base = recordings('github');
  const out = { 'POST /login/oauth/access_token': () => ({ body: { access_token: TOKEN, token_type: 'bearer' } }) };
  const add = (key, answer) => {
    const [method, p] = key.split(' ');
    const served = `${method} /api/v3${p}`;
    out[served] = (req) => (state.override[served] ? state.override[served](req) : answer);
  };
  add('GET /user', base['GET /user']);
  add('GET /repos/owner/name', base['GET /repos/owner/name']);
  for (const [key, answer] of Object.entries(recordings('notes-github'))) if (!key.startsWith('_')) add(key, answer);
  return out;
}

describe('release notes and drafts over HTTP', () => {
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
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-notes-'));
    plainData = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-notes-plain-'));
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
    db.exec('DELETE FROM forge_cache; DELETE FROM actions');
    db.close();
  });

  async function signIn() {
    const started = await raw(srv.port, 'GET', '/auth/start');
    const to = new URL(started.headers.location);
    const stateCookie = started.headers['set-cookie'].find((c) => c.startsWith('cornfield-oauth=')).split(';')[0];
    const back = await raw(srv.port, 'GET', `/auth/callback?code=c-maint&state=${to.searchParams.get('state')}`, { cookie: stateCookie });
    expect(back.status).toBe(303);
    return back.headers['set-cookie'].find((c) => c.startsWith('cornfield=')).split(';')[0];
  }
  const origin = () => `http://127.0.0.1:${srv.port}`;
  /** A POST the way the page makes it: same origin, JSON */
  const post = (cookie, body, headers = {}) => raw(srv.port, 'POST', '/api/forge/release-drafts', { cookie, origin: origin(), 'content-type': 'application/json', ...headers }, typeof body === 'string' ? body : JSON.stringify(body));
  const rows = (table) => {
    const db = new DatabaseSync(path.join(data, 'cornfield.db'));
    const out = db.prepare(`SELECT * FROM ${table}`).all();
    db.close();
    return out;
  };
  const writes = () => fake.requests.filter((r) => r.method !== 'GET' && !r.url.startsWith('/login/'));

  describe('GET /api/forge/release-notes', () => {
    it('answers the notes since the latest tag, grouped by the map, as the signed-in maintainer', async () => {
      const cookie = await signIn();
      const res = await raw(srv.port, 'GET', '/api/forge/release-notes', { cookie });
      expect(res.status, res.text).toBe(200);
      expect(res.json).toMatchObject({ ok: true, forge: 'github', repo: 'owner/name', since: { name: 'v0.2.0' }, tags: ['v0.2.0', 'v0.1.0'], suggestedTag: 'v0.2.1', breakingLabel: 'breaking', count: 4, truncated: false });
      expect(res.json.groups.map((g) => g.title)).toEqual(['Breaking', 'web.example.test', 'api.example.test', 'app-stack', 'Other']);
      expect(res.json.markdown.startsWith('### Breaking\n\n- Rename the cart route')).toBe(true);
      for (const r of fake.requests.filter((q) => q.url.includes('/repos/'))) expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(writes()).toEqual([]);
    });

    it('starts from the tag it is asked for, keeps each answer apart in forge_cache, and says a tag that is not there', async () => {
      const cookie = await signIn();
      const all = await raw(srv.port, 'GET', '/api/forge/release-notes?since=v0.1.0', { cookie });
      expect(all.json.count).toBe(5);
      expect(all.json.since.name).toBe('v0.1.0');
      const latest = await raw(srv.port, 'GET', '/api/forge/release-notes', { cookie });
      expect(latest.json.count).toBe(4);
      expect(rows('forge_cache').map((r) => r.key).sort()).toEqual(['github|1001|release-notes?since=&label=breaking', 'github|1001|release-notes?since=v0.1.0&label=breaking']);
      const missing = await raw(srv.port, 'GET', '/api/forge/release-notes?since=v9.9.9', { cookie });
      expect([missing.status, missing.json.error]).toEqual([404, 'owner/name has no tag named "v9.9.9".']);
      const long = await raw(srv.port, 'GET', `/api/forge/release-notes?since=${'x'.repeat(101)}`, { cookie });
      expect(long.status).toBe(400);
    });

    it('is a 304 for a browser that has it, and is not asked of the forge again within the minute', async () => {
      const cookie = await signIn();
      const first = await raw(srv.port, 'GET', '/api/forge/release-notes', { cookie });
      const calls = fake.requests.length;
      const again = await raw(srv.port, 'GET', '/api/forge/release-notes', { cookie, 'if-none-match': first.headers.etag });
      expect(again.status).toBe(304);
      expect(fake.requests).toHaveLength(calls);
    });

    it('without sign-in there is nobody to ask as: a 403, and the forge is not asked', async () => {
      const res = await raw(plain.port, 'GET', '/api/forge/release-notes');
      expect([res.status, res.json.code]).toEqual([403, 'forbidden']);
      expect(fake.requests).toEqual([]);
    });
  });

  describe('POST /api/forge/release-drafts', () => {
    it('keeps the notes as a DRAFT release for the tag, and writes nothing else to the forge', async () => {
      const cookie = await signIn();
      const preview = await raw(srv.port, 'GET', '/api/forge/release-notes', { cookie });
      fake.requests.length = 0;
      const res = await post(cookie, { tag: 'v0.3.0' });
      expect(res.status, res.text).toBe(201);
      expect(res.json).toEqual({ ok: true, forge: 'github', repo: 'owner/name', count: 4, release: { id: '7001', url: 'https://github.example.com/owner/name/releases/tag/untagged-7001', draft: true, tag: 'v0.3.0', name: 'v0.3.0' } });
      expect(writes().map((r) => `${r.method} ${r.url}`)).toEqual(['POST /api/v3/repos/owner/name/releases']);
      const sent = JSON.parse(writes()[0].body);
      expect(sent).toEqual({ tag_name: 'v0.3.0', name: 'v0.3.0', body: preview.json.markdown, draft: true, prerelease: false });
      expect(writes()[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(fake.requests.some((r) => /\/git\/|\/tags/.test(r.url) && r.method !== 'GET')).toBe(false);
    });

    it('takes a name, and a tag to start from, and notes made from those', async () => {
      const cookie = await signIn();
      const res = await post(cookie, { tag: 'v0.3.0', since: 'v0.1.0', name: 'The cart release' });
      expect(res.status, res.text).toBe(201);
      expect(res.json.count).toBe(5);
      expect(JSON.parse(writes()[0].body)).toMatchObject({ tag_name: 'v0.3.0', name: 'The cart release', draft: true });
    });

    it('writes a row to the audit before the forge is asked, and the forge\'s answer on it', async () => {
      const cookie = await signIn();
      let during = null;
      state.override[RELEASES] = () => {
        during = rows('actions');
        return { status: 201, body: { id: 7001, draft: true, html_url: 'https://github.example.com/owner/name/releases/tag/untagged-7001' } };
      };
      const res = await post(cookie, { tag: 'v0.3.0', since: 'v0.2.0' });
      expect(res.status).toBe(201);
      expect(during).toHaveLength(1);
      expect(during[0]).toMatchObject({ login: 'maintainer-one', action: 'release-draft', target: 'owner/name@v0.3.0', status: null, answer: null });
      const [row] = rows('actions');
      expect(row).toMatchObject({ login: 'maintainer-one', action: 'release-draft', target: 'owner/name@v0.3.0', status: 201, at: '2026-10-19T12:00:00.000Z' });
      expect(JSON.parse(row.request)).toEqual({ tag: 'v0.3.0', since: 'v0.2.0', name: 'v0.3.0' });
      expect(JSON.parse(row.answer)).toEqual({ id: '7001', url: 'https://github.example.com/owner/name/releases/tag/untagged-7001', draft: true, pulls: 4 });
      expect(row.request + row.answer).not.toContain(TOKEN);
    });

    it('asks the forge again whether the signed-in user still maintains the repo: a demoted maintainer is refused, and it is audited', async () => {
      const cookie = await signIn();
      state.override[REPO] = () => ({ body: { id: 1, full_name: 'owner/name', permissions: { admin: false, maintain: false, push: true, triage: true, pull: true } } });
      const res = await post(cookie, { tag: 'v0.3.0' });
      expect([res.status, res.json.code]).toEqual([403, 'forbidden']);
      expect(res.json.error).toBe('maintainer-one does not maintain owner/name on GitHub (any more), so cornfield will not post for them.');
      expect(writes()).toEqual([]);
      expect(rows('actions')).toHaveLength(1);
      expect(rows('actions')[0]).toMatchObject({ action: 'release-draft', status: null });
      expect(JSON.parse(rows('actions')[0].answer)).toEqual({ error: res.json.error, code: 'forbidden' });
    });

    it('refuses a request that does not come from cornfield\'s own page, with nothing asked of the forge or written to the audit', async () => {
      const cookie = await signIn();
      fake.requests.length = 0;
      for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site', origin: undefined }]) {
        const res = await post(cookie, { tag: 'v0.3.0' }, headers);
        expect([JSON.stringify(headers), res.status, res.json.code]).toEqual([JSON.stringify(headers), 403, 'forbidden']);
      }
      const bare = await raw(srv.port, 'POST', '/api/forge/release-drafts', { cookie, 'content-type': 'application/json' }, '{"tag":"v0.3.0"}'); // no Origin, no Fetch Metadata: not a browser's page
      expect(bare.status).toBe(403);
      const foreignHost = await post(cookie, { tag: 'v0.3.0' }, { host: 'evil.example' });
      expect(foreignHost.status).toBe(421);
      expect(fake.requests).toEqual([]);
      expect(rows('actions')).toEqual([]);
    });

    it('is a POST and nothing else, and needs a session', async () => {
      const cookie = await signIn();
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const res = await raw(srv.port, method, '/api/forge/release-drafts', { cookie, origin: origin() });
        expect([method, res.status, res.headers.allow]).toEqual([method, 405, 'POST']);
      }
      const nobody = await post('', { tag: 'v0.3.0' });
      expect(nobody.status).toBe(401);
      const plainPost = await raw(plain.port, 'POST', '/api/forge/release-drafts', { origin: `http://127.0.0.1:${plain.port}`, 'content-type': 'application/json' }, '{"tag":"v0.3.0"}');
      expect([plainPost.status, plainPost.json.code]).toEqual([403, 'forbidden']);
      expect(writes()).toEqual([]);
      expect(rows('actions')).toEqual([]);
    });

    it('refuses what is not a draft request, before the forge is asked', async () => {
      const cookie = await signIn();
      fake.requests.length = 0;
      const bad = [
        ['not JSON', '{nope', 400],
        ['an array', '[]', 400],
        ['no tag', {}, 400],
        ['a tag with spaces', { tag: 'v 1' }, 400],
        ['a tag that climbs', { tag: '../x' }, 400],
        ['a tag that is a number', { tag: 4 }, 400],
        ['a body of its own', { tag: 'v0.3.0', body: '# mine' }, 400],
        ['a draft flag', { tag: 'v0.3.0', draft: false }, 400],
        ['an empty name', { tag: 'v0.3.0', name: '  ' }, 400],
        ['a long name', { tag: 'v0.3.0', name: 'n'.repeat(201) }, 400],
        ['a since that is not text', { tag: 'v0.3.0', since: 7 }, 400],
        ['a request that is too large', { tag: 'v0.3.0', name: 'n'.repeat(5000) }, 413],
      ];
      for (const [what, body, status] of bad) {
        const res = await post(cookie, body);
        expect([what, res.status, res.json && res.json.ok]).toEqual([what, status, false]);
      }
      expect(fake.requests).toEqual([]);
      expect(rows('actions')).toEqual([]);
    });

    it('says a tag that is not there, and nothing merged, in words, and audits the refusal', async () => {
      const cookie = await signIn();
      const missing = await post(cookie, { tag: 'v0.3.0', since: 'v9.9.9' });
      expect([missing.status, missing.json.error]).toEqual([404, 'owner/name has no tag named "v9.9.9".']);
      state.override[CLOSED] = () => ({ body: [] });
      const empty = await post(cookie, { tag: 'v0.3.0' });
      expect([empty.status, empty.json.code, empty.json.error]).toEqual([409, 'conflict', 'No pull request was merged since v0.2.0, so there is nothing to put in a draft.']);
      expect(writes()).toEqual([]);
      // Refused here, so the forge never answered for them: no status, the words in the answer
      expect(rows('actions').map((r) => [r.status, JSON.parse(r.answer).code])).toEqual([[null, 'not-found'], [null, 'conflict']]);
    });

    it('passes the forge\'s refusal on in words, with its status in the audit', async () => {
      const cookie = await signIn();
      state.override[RELEASES] = () => ({ status: 403, body: { message: 'Resource not accessible by personal access token' } });
      const res = await post(cookie, { tag: 'v0.3.0' });
      expect([res.status, res.json.code]).toEqual([403, 'forbidden']);
      expect(res.json.error).toContain('GitHub does not let this sign-in do that to a release draft in owner/name');
      const [row] = rows('actions');
      expect(row.status).toBe(403);
      expect(JSON.parse(row.answer).code).toBe('forbidden');
    });

    it('treats a release that came back published as a fault, and says so', async () => {
      const cookie = await signIn();
      state.override[RELEASES] = () => ({ status: 201, body: { id: 9, draft: false, html_url: 'https://github.example.com/owner/name/releases/tag/v0.3.0' } });
      const res = await post(cookie, { tag: 'v0.3.0' });
      expect([res.status, res.json.code]).toEqual([502, 'unavailable']);
      expect(res.json.error).toContain('did not keep v0.3.0 as a draft');
    });

    it('does not draft from the cache: it reads the forge afresh', async () => {
      const cookie = await signIn();
      await raw(srv.port, 'GET', '/api/forge/release-notes', { cookie });
      state.override[CLOSED] = () => ({ body: [] });
      const res = await post(cookie, { tag: 'v0.3.0' });
      expect(res.status).toBe(409);
    });
  });
});
