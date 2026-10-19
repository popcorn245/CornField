/**
 * @vitest-environment node
 *
 * The two actions on a forge (server/forge-actions.js, CF-08): landing a green pull request and re-running a failed
 * check, against a fake forge on loopback that serves the recorded answers (test/fixtures/forge/, GitHub and
 * Forgejo). Every rule is walked from the outside: POST only, signed in (401), a maintainer now (403, asked of the
 * forge at the time, not read from the session), the same origin (403), a head that is still the head (409), green
 * checks, open and ready (409), no double click (429), and one row in `actions` for every attempt, refused or not.
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
const MAINT = 'tok-maint';
const READER = 'tok-reader';
const ABC = 'abc0000000000000000000000000000000000000';
const DEF = 'def0000000000000000000000000000000000000';
const GH = '/api/v3/repos/owner/name';
const CHECKS = (sha) => `GET ${GH}/commits/${sha}/check-runs?per_page=100`;

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

/** The recorded GitHub answers as a GitHub Enterprise Server serves them; the reader's token is a reader */
function githubRoutes(state) {
  const out = {
    'POST /login/oauth/access_token': (req) => ({ body: { access_token: req.body.includes('c-reader') ? READER : MAINT, token_type: 'bearer' } }),
  };
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

async function signedIn(port, code) {
  const started = await raw(port, 'GET', '/auth/start');
  const to = new URL(started.headers.location);
  const stateCookie = started.headers['set-cookie'].find((c) => c.startsWith('cornfield-oauth=')).split(';')[0];
  const back = await raw(port, 'GET', `/auth/callback?code=${code}&state=${to.searchParams.get('state')}`, { headers: { cookie: stateCookie } });
  expect(back.status, back.text).toBe(303);
  return back.headers['set-cookie'].find((c) => c.startsWith('cornfield=')).split(';')[0];
}

describe('the forge actions', () => {
  let fake;
  let data;
  let plainData;
  let srv;
  let plain;
  let clock = Date.parse('2026-10-19T12:00:00Z');
  let cookie;
  const state = { override: {} };

  const start = async (config, opts) => {
    const server = createCornfieldServer(config, opts);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    return { port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
  };

  beforeAll(async () => {
    fake = await fakeForge(githubRoutes(state));
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-actions-'));
    plainData = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-actions-plain-'));
    const forge = { type: 'github', url: fake.url, repo: 'owner/name' };
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(config, { forge, publicUrl: PUBLIC });
    srv = await start(config, { env: ENV, now: () => clock });
    const open = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: plainData } });
    plain = await start(Object.assign(open, { forge }), { env: {} });
    cookie = await signedIn(srv.port, 'c-maint');
  });
  afterAll(async () => {
    await srv.close();
    await plain.close();
    await fake.close();
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(plainData, { recursive: true, force: true });
  });
  beforeEach(() => {
    clock += 120_000; // past the cooldown and the minute's count of the test before
    state.override = {};
    fake.requests.length = 0;
  });

  const origin = () => `http://127.0.0.1:${srv.port}`;
  /** An action as the page sends it */
  const act = (n, action, body, { headers = {}, port = srv.port, as = cookie } = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return raw(port, 'POST', `/api/forge/pulls/${n}/${action}`, {
      headers: { cookie: as || undefined, origin: origin(), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers },
      body: text,
    });
  };
  const rows = () => {
    const db = new DatabaseSync(path.join(data, 'cornfield.db'));
    const out = db.prepare('SELECT * FROM actions ORDER BY id').all();
    db.close();
    return out.map((r) => ({ ...r, request: JSON.parse(String(r.request)), answer: r.answer ? JSON.parse(String(r.answer)) : null }));
  };
  const last = () => rows().at(-1);
  const wrote = () => fake.requests.filter((r) => r.method !== 'GET' && !r.url.startsWith('/login/'));

  describe('landing a pull request', () => {
    it('lands a green one at the head the checks ran on, as the maintainer, and writes it down', async () => {
      const before = rows().length;
      const res = await act(12, 'merge', { sha: ABC });
      expect(res.status, res.text).toBe(200);
      expect(res.json).toMatchObject({ ok: true, merged: true, number: 12, sha: 'fff0000000000000000000000000000000000000', head: ABC });
      const puts = wrote();
      expect(puts.map((r) => `${r.method} ${r.url}`)).toEqual([`PUT ${GH}/pulls/12/merge`]);
      expect(puts[0].headers.authorization).toBe(`Bearer ${MAINT}`);
      expect(JSON.parse(puts[0].body)).toEqual({ sha: ABC, merge_method: 'merge' });
      expect(rows()).toHaveLength(before + 1);
      expect(last()).toMatchObject({ login: 'maintainer-one', action: 'merge', target: 'owner/name#12', status: 200, request: { action: 'merge', number: 12, sha: ABC } });
      expect(last().answer).toMatchObject({ ok: true, merged: true });
      expect(last().at).toBe(new Date(clock).toISOString());
    });

    it('asks the forge who this is and what they may do now, with the maintainer\'s own token', async () => {
      await act(12, 'merge', { sha: ABC });
      expect(fake.requests.some((r) => r.url === '/api/v3/user')).toBe(true);
      expect(fake.requests.some((r) => r.url === GH)).toBe(true);
      for (const r of fake.requests.filter((q) => q.url.startsWith('/api/v3/'))) expect(r.headers.authorization).toBe(`Bearer ${MAINT}`);
    });

    it('refuses one with a failed or a running check, and does not ask the forge to land it', async () => {
      const res = await act(13, 'merge', { sha: DEF });
      expect([res.status, res.json.ok, res.json.code]).toEqual([409, false, 'not-green']);
      expect(res.json.error).toBe('Pull request #13 is not green: lint failed; test is still running.');
      expect(wrote()).toEqual([]);
      expect(last()).toMatchObject({ action: 'merge', target: 'owner/name#13', status: 409 });
      expect(last().answer).toMatchObject({ ok: false, code: 'not-green' });
    });

    it('refuses one whose checks are only pending', async () => {
      state.override[CHECKS(DEF)] = () => ({ body: { total_count: 1, check_runs: [{ id: 43, name: 'test', status: 'queued', conclusion: null, app: { slug: 'github-actions' } }] } });
      state.override[`GET ${GH}/commits/${DEF}/status?per_page=100`] = () => ({ body: { state: 'pending', total_count: 0, statuses: [] } });
      const res = await act(13, 'merge', { sha: DEF });
      expect([res.status, res.json.error]).toEqual([409, 'Pull request #13 is not green: test is waiting to run.']);
      expect(wrote()).toEqual([]);
    });

    it('refuses one with no checks at all', async () => {
      state.override[CHECKS(ABC)] = () => ({ body: { total_count: 0, check_runs: [] } });
      state.override[`GET ${GH}/commits/${ABC}/status?per_page=100`] = () => ({ body: { state: 'pending', total_count: 0, statuses: [] } });
      const res = await act(12, 'merge', { sha: ABC });
      expect([res.status, res.json.code]).toEqual([409, 'not-green']);
      expect(res.json.error).toMatch(/it has no checks/);
      expect(wrote()).toEqual([]);
    });

    it('refuses a draft, though its checks are green', async () => {
      const res = await act(14, 'merge', { sha: ABC });
      expect([res.status, res.json.code]).toEqual([409, 'conflict']);
      expect(res.json.error).toBe('Pull request #14 is a draft; mark it ready first.');
      expect(wrote()).toEqual([]);
      expect(last()).toMatchObject({ target: 'owner/name#14', status: 409 });
    });

    it('refuses one that is closed or already merged', async () => {
      const res = await act(9, 'merge', { sha: '9990000000000000000000000000000000000000' });
      expect([res.status, res.json.code]).toEqual([409, 'conflict']);
      expect(res.json.error).toBe('Pull request #9 is merged; only an open one can land.');
      expect(wrote()).toEqual([]);
    });

    it('a head that is not the one they looked at is a 409, even when the new head is green', async () => {
      const res = await act(12, 'merge', { sha: '1230000000000000000000000000000000000000' });
      expect([res.status, res.json.code]).toEqual([409, 'conflict']);
      expect(res.json.error).toBe('Pull request #12 has changed since it was looked at (its head is now abc0000); look again before landing it.');
      expect(wrote()).toEqual([]);
      expect(last()).toMatchObject({ status: 409, request: { sha: '1230000000000000000000000000000000000000' } });
    });

    it('wants the sha, as hex, and says so', async () => {
      for (const body of [{}, { sha: 'main' }, { sha: 7 }, { sha: `${ABC}; rm` }, '[1]', '{nope']) {
        const res = await act(12, 'merge', body);
        expect([res.status, res.json.code]).toEqual([400, 'invalid']);
        clock += 10_000;
      }
      expect(wrote()).toEqual([]);
    });

    it('passes a forge that refuses on, in the forge\'s words, and writes the forge\'s status', async () => {
      state.override[`PUT ${GH}/pulls/12/merge`] = () => ({ status: 405, body: { message: 'Pull Request is not mergeable' } });
      const res = await act(12, 'merge', { sha: ABC });
      expect([res.status, res.json.ok, res.json.code]).toEqual([409, false, 'conflict']);
      expect(res.json.error).toMatch(/^GitHub refused/);
      expect(last()).toMatchObject({ action: 'merge', status: 405 });
      expect(last().answer).toMatchObject({ ok: false, code: 'conflict' });
    });

    it('a forge that does not answer well is a 502, and the row says what the forge said', async () => {
      state.override[`PUT ${GH}/pulls/12/merge`] = () => ({ status: 500, body: {} });
      const res = await act(12, 'merge', { sha: ABC });
      expect([res.status, res.json.code]).toEqual([502, 'unavailable']);
      expect(last()).toMatchObject({ action: 'merge', status: 500 });
      expect(last().answer).toMatchObject({ code: 'unavailable' });
    });

    it('lets go of the kept lists once it has landed, so the next look is new', async () => {
      await raw(srv.port, 'GET', '/api/forge/pulls', { headers: { cookie } });
      const count = () => {
        const d = new DatabaseSync(path.join(data, 'cornfield.db'));
        const n = Number(d.prepare('SELECT count(*) AS n FROM forge_cache').get().n);
        d.close();
        return n;
      };
      expect(count()).toBeGreaterThan(0);
      await act(12, 'merge', { sha: ABC });
      expect(count()).toBe(0);
    });
  });

  describe('re-running a check', () => {
    it('re-runs a failed check the forge says can be, and writes it down', async () => {
      const res = await act(13, 'rerun', { sha: DEF, check: 'run:42' });
      expect(res.status, res.text).toBe(202);
      expect(res.json).toMatchObject({ ok: true, rerun: true, number: 13, check: 'run:42', name: 'lint' });
      expect(wrote().map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${GH}/actions/jobs/42/rerun`]);
      expect(last()).toMatchObject({ login: 'maintainer-one', action: 'rerun', target: 'owner/name#13/run:42', status: 202, request: { check: 'run:42', sha: DEF } });
    });

    it('says in the detail which checks can be, for the page', async () => {
      const res = await raw(srv.port, 'GET', '/api/forge/pulls/13', { headers: { cookie } });
      expect(res.json.checks.map((c) => [c.id, c.state, c.canRerun])).toEqual([['run:42', 'failure', true], ['run:43', 'running', false]]);
    });

    it('refuses a check that has not failed (running, passed)', async () => {
      const running = await act(13, 'rerun', { sha: DEF, check: 'run:43' });
      expect([running.status, running.json.code]).toEqual([409, 'conflict']);
      expect(running.json.error).toBe('test has not failed; only a failed check is re-run.');
      clock += 10_000;
      const passed = await act(12, 'rerun', { sha: ABC, check: 'run:41' });
      expect(passed.status).toBe(409);
      expect(wrote()).toEqual([]);
      expect(last()).toMatchObject({ action: 'rerun', target: 'owner/name#12/run:41', status: 409 });
    });

    it('refuses a failed check the forge cannot re-run (a commit status)', async () => {
      state.override[CHECKS(DEF)] = () => ({ body: { total_count: 0, check_runs: [] } });
      state.override[`GET ${GH}/commits/${DEF}/status?per_page=100`] = () => ({ body: { state: 'failure', total_count: 1, statuses: [{ context: 'ci/legacy', state: 'failure', target_url: null }] } });
      const res = await act(13, 'rerun', { sha: DEF, check: 'status:ci/legacy' });
      expect([res.status, res.json.code]).toEqual([409, 'conflict']);
      expect(res.json.error).toBe('ci/legacy cannot be re-run from cornfield; re-run it on the forge.');
      expect(wrote()).toEqual([]);
    });

    it('refuses a check that is not on the head, a stale head, a closed pull request and a request without a check', async () => {
      const other = await act(13, 'rerun', { sha: DEF, check: 'run:999' });
      expect([other.status, other.json.error]).toEqual([409, 'run:999 is not a check on the head of pull request #13; look again.']);
      clock += 10_000;
      const stale = await act(13, 'rerun', { sha: ABC, check: 'run:42' });
      expect([stale.status, stale.json.error]).toEqual([409, 'Pull request #13 has changed since it was looked at (its head is now def0000); look again.']);
      clock += 10_000;
      const closed = await act(9, 'rerun', { sha: '9990000000000000000000000000000000000000', check: 'run:1' });
      expect([closed.status, closed.json.error]).toEqual([409, 'Pull request #9 is merged; its checks are not re-run from here.']);
      clock += 10_000;
      expect((await act(13, 'rerun', { sha: DEF })).status).toBe(400);
      expect(wrote()).toEqual([]);
    });

    it('trusts nothing the page says about a check but its id: the forge\'s own listing decides', async () => {
      state.override[CHECKS(DEF)] = () => ({ body: { total_count: 1, check_runs: [{ id: 42, name: 'lint', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }] } });
      const res = await act(13, 'rerun', { sha: DEF, check: 'run:42', rerunnable: true, state: 'failure', canRerun: true });
      expect([res.status, res.json.error]).toEqual([409, 'lint has not failed; only a failed check is re-run.']);
      expect(wrote()).toEqual([]);
    });
  });

  describe('who may', () => {
    it('a signed-out request is a 401, and nothing is written or asked', async () => {
      const before = rows().length;
      const res = await act(12, 'merge', { sha: ABC }, { as: '' });
      expect(res.status).toBe(401);
      expect(rows()).toHaveLength(before);
      expect(fake.requests).toEqual([]);
    });

    it('without sign-in configured there is nobody to act as: 403, no store, no forge', async () => {
      const res = await act(12, 'merge', { sha: ABC }, { port: plain.port, as: '' });
      expect([res.status, res.json.code]).toEqual([403, 'forbidden']);
      expect(fake.requests).toEqual([]);
      expect(fs.existsSync(path.join(plainData, 'cornfield.db'))).toBe(false);
    });

    it('a reader who signed in is turned away at the door: 403', async () => {
      const reader = await signedIn(srv.port, 'c-reader');
      const before = rows().length;
      fake.requests.length = 0;
      const res = await act(12, 'merge', { sha: ABC }, { as: reader });
      expect(res.status).toBe(403);
      expect(wrote()).toEqual([]);
      expect(rows()).toHaveLength(before);
    });

    it('a maintainer who has stopped being one is a 403, the permission asked of the forge at that moment', async () => {
      state.override[`GET ${GH}`] = () => ({ body: { id: 1, full_name: 'owner/name', permissions: { admin: false, maintain: false, push: true, triage: true, pull: true } } });
      const res = await act(12, 'merge', { sha: ABC });
      expect([res.status, res.json.code]).toEqual([403, 'forbidden']);
      expect(res.json.error).toBe('Only the repo\'s maintainers land pull requests or re-run checks; maintainer-one is not one now.');
      expect(wrote()).toEqual([]);
      expect(last()).toMatchObject({ login: 'maintainer-one', action: 'merge', status: 403 });
    });

    it('a sign-in the forge no longer accepts is a 401, and the forge is not asked to land', async () => {
      const fresh = await signedIn(srv.port, 'c-maint');
      state.override['GET /api/v3/user'] = () => ({ status: 401, body: { message: 'Bad credentials' } });
      const res = await act(12, 'merge', { sha: ABC }, { as: fresh });
      expect([res.status, res.json.code]).toEqual([401, 'unauthorized']);
      expect(wrote()).toEqual([]);
    });
  });

  describe('where from, and how often', () => {
    it('refuses a request from another origin, whatever header says so, and writes each down', async () => {
      const before = rows().length;
      const tries = [
        { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
        { origin: undefined, 'sec-fetch-site': 'cross-site' },
        { origin: 'http://127.0.0.1:1', 'sec-fetch-site': undefined },
        { origin: undefined, 'sec-fetch-site': undefined },
      ];
      for (const headers of tries) {
        const res = await act(12, 'merge', { sha: ABC }, { headers });
        expect([res.status, res.json.code]).toEqual([403, 'forbidden']);
        clock += 10_000;
      }
      expect(wrote()).toEqual([]);
      expect(rows()).toHaveLength(before + 4);
      expect(last()).toMatchObject({ action: 'merge', status: 403 });
    });

    it('refuses a wrong Host before any route (DNS rebinding)', async () => {
      const res = await act(12, 'merge', { sha: ABC }, { headers: { host: 'evil.example' } });
      expect(res.status).toBe(421);
      expect(wrote()).toEqual([]);
    });

    it('wants JSON: a form post cannot do this', async () => {
      const res = await act(12, 'merge', `sha=${ABC}`, { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      expect([res.status, res.json.code]).toEqual([415, 'invalid']);
      expect(wrote()).toEqual([]);
    });

    it('takes POST only: every other method is a 405 that says so', async () => {
      for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
        const res = await raw(srv.port, method, '/api/forge/pulls/12/merge', { headers: { cookie, origin: origin() } });
        expect([method, res.status, res.headers.allow]).toEqual([method, 405, 'POST']);
      }
      expect(wrote()).toEqual([]);
    });

    it('does not land twice on a double click: the second is a 429 with a wait, and a row says so', async () => {
      const first = await act(12, 'merge', { sha: ABC });
      expect(first.status).toBe(200);
      fake.requests.length = 0;
      const second = await act(12, 'merge', { sha: ABC });
      expect([second.status, second.json.code]).toEqual([429, 'rate-limited']);
      expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
      expect(wrote()).toEqual([]);
      expect(last()).toMatchObject({ action: 'merge', status: 429 });
      clock += 6000;
      expect((await act(12, 'merge', { sha: ABC })).status).toBe(200);
    });

    it('holds two at the same moment to one', async () => {
      let release = () => {};
      const gate = new Promise((resolve) => { release = () => resolve(undefined); });
      state.override[`PUT ${GH}/pulls/12/merge`] = async () => { await gate; return { body: { sha: 'f'.repeat(40), merged: true } }; };
      const one = act(12, 'merge', { sha: ABC });
      for (let i = 0; i < 100 && !fake.requests.some((r) => r.method === 'PUT'); i++) await new Promise((r) => setTimeout(r, 10));
      const two = await act(12, 'merge', { sha: ABC });
      expect(two.status).toBe(429);
      release();
      expect((await one).status).toBe(200);
      expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    });

    it('is not asked more than twenty times a minute by one person', async () => {
      const statuses = [];
      for (let i = 0; i < 22; i++) {
        statuses.push((await act(13, 'rerun', { sha: DEF, check: `run:${i + 100}` })).status);
        clock += 1000;
      }
      expect(statuses.slice(0, 20).every((s) => s === 409)).toBe(true);
      expect(statuses.slice(20)).toEqual([429, 429]);
    });

    it('does not act when it cannot write the audit: 503, the forge not asked', async () => {
      const db = new DatabaseSync(path.join(data, 'cornfield.db'));
      db.exec('ALTER TABLE actions RENAME TO actions_away');
      db.close();
      try {
        const res = await act(12, 'merge', { sha: ABC });
        expect([res.status, res.json.code]).toEqual([503, 'unavailable']);
        expect(wrote()).toEqual([]);
      } finally {
        const back = new DatabaseSync(path.join(data, 'cornfield.db'));
        back.exec('ALTER TABLE actions_away RENAME TO actions');
        back.close();
      }
    });
  });

  it('never calls anything that deploys or forces: the only writes it makes are the merge and the re-run', async () => {
    await act(12, 'merge', { sha: ABC });
    clock += 10_000;
    await act(13, 'rerun', { sha: DEF, check: 'run:42' });
    const writes = fake.requests.filter((r) => r.method !== 'GET' && !r.url.startsWith('/login/')).map((r) => `${r.method} ${r.url.replace(GH, '')}`);
    expect(writes).toEqual(['PUT /pulls/12/merge', 'POST /actions/jobs/42/rerun']);
  });

  it('Forgejo lands the same way: through the same checks, at the head, with its own token', async () => {
    const routes = { 'POST /login/oauth/access_token': () => ({ body: { access_token: MAINT, token_type: 'bearer' } }) };
    for (const [key, answer] of Object.entries(recordings('forgejo'))) {
      if (key.startsWith('_')) continue;
      const [method, p] = key.split(' ');
      routes[p.startsWith('/api/v1/') ? key : `${method} /api/v1${p}`] = answer;
    }
    const forgejo = await fakeForge(routes);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-actions-forgejo-'));
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: dir } });
    Object.assign(config, { forge: { type: 'forgejo', url: forgejo.url, repo: 'owner/name' }, publicUrl: PUBLIC });
    const env = { CORNFIELD_FORGEJO_CLIENT_ID: 'test-client-id', CORNFIELD_FORGEJO_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: SESSION_SECRET };
    const server = await start(config, { env, now: () => clock });
    try {
      const mine = await signedIn(server.port, 'c-maint');
      const post = (n, action, body) => {
        const text = JSON.stringify(body);
        return raw(server.port, 'POST', `/api/forge/pulls/${n}/${action}`, { headers: { cookie: mine, origin: `http://127.0.0.1:${server.port}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }, body: text });
      };
      const red = await post(13, 'merge', { sha: DEF });
      expect([red.status, red.json.code]).toEqual([409, 'not-green']);
      clock += 10_000;
      const stale = await post(12, 'merge', { sha: '4560000000000000000000000000000000000000' });
      expect(stale.status).toBe(409);
      clock += 10_000;
      const ok = await post(12, 'merge', { sha: ABC });
      expect(ok.status, ok.text).toBe(200);
      const merges = forgejo.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/merge'));
      expect(merges).toHaveLength(1);
      expect(JSON.parse(merges[0].body)).toEqual({ Do: 'merge', head_commit_id: ABC });
      expect(merges[0].headers.authorization).toBe(`token ${MAINT}`);
      const db = new DatabaseSync(path.join(dir, 'cornfield.db'));
      expect(db.prepare('SELECT action, target, status FROM actions ORDER BY id').all().map((r) => ({ ...r }))).toEqual([
        { action: 'merge', target: 'owner/name#13', status: 409 },
        { action: 'merge', target: 'owner/name#12', status: 409 },
        { action: 'merge', target: 'owner/name#12', status: 200 },
      ]);
      db.close();
      clock += 10_000;
      const rerun = await post(13, 'rerun', { sha: DEF, check: 'status:lint' });
      expect([rerun.status, rerun.json.code]).toEqual([409, 'conflict']);
      expect(rerun.json.error).toBe('lint cannot be re-run from cornfield; re-run it on the forge.');
    } finally {
      await server.close();
      await forgejo.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
