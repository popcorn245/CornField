/**
 * @vitest-environment node
 *
 * The facts of a decision (spec 0007 D1, server/decision.js), from the outside: a running server with a fake GitHub that holds one open
 * spec PR, its checks and the comments on it, and a clock the test winds. Held here:
 *
 *   - the answer for each state the line above Approve names: ready, a check running, a check failed, no checks, a draft, landing on or
 *     off, a run asked for (and the runner online, quiet or never seen), a landing that waits
 *   - for the signed-in maintainer only; a proposal not on a PR, a closed PR, or a PR that does not hold the proposal is 404
 *   - what the forge says is text: names are handed over as data, never trusted by the server for a decision
 *   - what it costs: two forge calls a read, kept for every tab, skipped by `fresh=1`, forgotten by a review; a failed read is not kept
 *   - the checks that make the page's courtesy a rule: the same approval again is answered with the one that stands and posts nothing (unless a
 *     landing it began is over), a version or a head the page was not shown is 409, a maintainer who is not one now is refused in words,
 *     nothing posts without a sign-in
 * No real forge, app or token.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { createCornfieldServer } from '../../server/server.js';
// @ts-expect-error plain JS module, no declarations
import { loadConfig } from '../../core/config.js';
// @ts-expect-error plain JS module, no declarations
import { openStore } from '../../server/db.js';
// @ts-expect-error plain JS module, no declarations
import { mintToken, touchToken } from '../../server/review-tokens.js';
// @ts-expect-error plain JS module, no declarations
import { TIMEOUT_MS } from '../../server/lander.js';
// @ts-expect-error plain JS module, no declarations
import { FRESH_MS, LAND_WITHIN_MINUTES, countChecks } from '../../server/decision.js';
import { SAMPLE } from '../helpers.js';
import { fakeForge, recordings } from './fake-forge.js';

const ENV = { CORNFIELD_GITHUB_CLIENT_ID: 'test-client-id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: 'x'.repeat(40), CORNFIELD_HOOK_SECRET: 'h'.repeat(40) };
const MAINT = 'tok-maint';
const API = '/api/v3';
const GH = `${API}/repos/owner/name`;
const SLUG = '0040-meals';
const PATH = `docs/specs/proposals/${SLUG}.json`;
const HEAD = `${'a'.repeat(39)}1`;
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

async function signedIn(port, code) {
  const started = await raw(port, 'GET', '/auth/start');
  const to = new URL(started.headers.location);
  const stateCookie = started.headers['set-cookie'].find((c) => c.startsWith('cornfield-oauth=')).split(';')[0];
  const back = await raw(port, 'GET', `/auth/callback?code=${code}&state=${to.searchParams.get('state')}`, { headers: { cookie: stateCookie } });
  expect(back.status, back.text).toBe(303);
  return back.headers['set-cookie'].find((c) => c.startsWith('cornfield=')).split(';')[0];
}

describe('the facts of a decision', () => {
  let fake;
  let data;
  let srv;
  let cookie;
  let clock = Date.parse('2026-11-03T09:00:00Z');
  let world;
  const base = recordings('github');

  const dispatch = (key, req) => {
    const [method, target] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
    const auth = req.headers.authorization;
    if (key === 'POST /login/oauth/access_token') return { body: { access_token: MAINT, token_type: 'bearer' } };
    if (key === 'DELETE /api/v3/applications/test-client-id/token') return { status: 204 };
    if (key === `GET ${API}/user`) return base['GET /user'];
    if (key === `GET ${GH}`) return { body: { id: 1, full_name: 'owner/name', permissions: { admin: false, maintain: !world.demoted, push: true, triage: true, pull: true } } };
    if (!target.startsWith(GH)) return { status: 404, body: { message: 'Not Found' } };
    const url = new URL(target.slice(GH.length), 'http://x');
    const p = decodeURIComponent(url.pathname);
    let m;
    if (method === 'GET' && (m = /^\/collaborators\/([^/]+)\/permission$/.exec(p))) {
      const maintains = m[1] === 'maintainer-one' && !world.demoted;
      return { body: { permission: maintains ? 'write' : 'read', role_name: maintains ? 'maintain' : 'read', user: { login: m[1] } } };
    }
    world.asked.push(`${method} ${p}`);
    if (method === 'GET' && p === '/pulls/40') return { body: world.pull };
    if (method === 'GET' && p === '/pulls/40/commits') return { body: [] };
    if (method === 'GET' && p === '/pulls/40/files') return { body: [{ filename: world.slugFile ?? PATH, status: 'modified', additions: 1, deletions: 0, changes: 1 }] };
    if (method === 'GET' && p === '/issues/40/comments') return { body: world.comments };
    if (method === 'POST' && p === '/issues/40/comments') {
      const text = JSON.parse(req.body).body;
      world.posted.push({ as: auth, body: text });
      const c = { id: 9100 + world.comments.length, user: { login: 'maintainer-one', html_url: 'https://github.example.com/maintainer-one' }, body: text, html_url: 'https://github.example.com/owner/name/pull/40#issuecomment-1', created_at: new Date(clock).toISOString(), updated_at: new Date(clock).toISOString() };
      world.comments.push(c);
      return { status: 201, body: c };
    }
    if (method === 'GET' && p.startsWith('/contents/')) {
      const text = url.searchParams.get('ref') === world.pull.head.sha && p.slice('/contents/'.length) === PATH ? world.text : undefined;
      return text === undefined ? { status: 404, body: { message: 'Not Found' } } : { headers: { 'content-type': 'application/vnd.github.raw; charset=utf-8' }, body: text };
    }
    if (method === 'GET' && /^\/commits\/[0-9a-f]+\/check-runs$/.test(p)) return world.checksDown ? { status: 503, body: { message: 'Service Unavailable' } } : { body: { check_runs: world.checks } };
    if (method === 'GET' && /^\/commits\/[0-9a-f]+\/status$/.test(p)) return { body: { statuses: [] } };
    return { status: 404, body: { message: 'Not Found' } };
  };
  const routes = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? (req) => dispatch(key, req) : undefined) });
  const check = (name, status, conclusion) => ({ id: name.length + 100, name, status, conclusion, html_url: `https://ci.example.test/${encodeURIComponent(name)}` });
  const freshWorld = () => ({
    pull: { number: 40, title: 'Meals spec', state: 'open', draft: false, user: { login: 'agent-four', html_url: 'https://github.example.com/agent-four' }, labels: [], head: { ref: 'spec/meals', sha: HEAD }, base: { ref: 'main' }, html_url: 'https://github.example.com/owner/name/pull/40', created_at: '2026-11-03T08:00:00Z', updated_at: '2026-11-03T08:30:00Z', merged_at: null },
    text: proposalOf('Meals'),
    comments: [],
    posted: [],
    asked: [],
    checks: [check('validate', 'completed', 'success')],
    checksDown: false,
    demoted: false,
    slugFile: null,
  });

  beforeAll(async () => { fake = await fakeForge(routes); });
  afterAll(async () => { await fake.close(); });
  beforeEach(() => { clock += 10 * 60_000; world = freshWorld(); });
  afterEach(async () => {
    if (srv) await srv.close();
    srv = null;
    fs.rmSync(data, { recursive: true, force: true });
  });

  /** `lands`: proposals.approveLands; `on`: agents.on; `transport`: agents.transport */
  const boot = async ({ lands = false, on, transport } = {}) => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-decision-'));
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(config, { forge: { type: 'github', url: fake.url, repo: 'owner/name' }, publicUrl: 'http://127.0.0.1:3350', approveLands: lands });
    if (on || transport) config.agents = { ...config.agents, ...(on ? { on, profiles: ['claude'] } : {}), ...(transport ? { transport } : {}) };
    const server = createCornfieldServer(config, { env: ENV, now: () => clock });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    srv = { port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
    cookie = await signedIn(srv.port, 'c-maint');
  };
  const origin = () => `http://127.0.0.1:${srv.port}`;
  const page = (method, target, body, { as = cookie } = {}) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    return raw(srv.port, method, target, { headers: { cookie: as || undefined, origin: origin(), 'sec-fetch-site': 'same-origin', ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }) }, body: text });
  };
  const DECISION = `/proposals/${SLUG}/decision?source=pull%2F40`;
  const REVIEW = `/proposals/${SLUG}/review?source=pull%2F40`;
  const decision = async (extra = '') => {
    const res = await page('GET', `${DECISION}${extra}`);
    expect(res.status, res.text).toBe(200);
    return res.json;
  };
  const runnerToken = (lastSeenMsAgo) => {
    const db = openStore(data);
    try {
      const { row } = mintToken(db, { userId: '1001', login: 'maintainer-one', label: 'laptop', scope: 'runner' }, clock);
      if (lastSeenMsAgo !== null) touchToken(db, row.id, clock - lastSeenMsAgo);
    } finally { db.close(); }
  };

  describe('the facts, one state at a time', () => {
    it('a ready PR with its checks passed, landing off: no landing, no run', async () => {
      await boot();
      expect(await decision()).toEqual({ pull: { number: 40, draft: false, head: HEAD }, checks: { total: 1, passed: 1, running: 0, failed: [] }, lands: false, landing: null, run: null });
    });

    it('counts a running check, and names a failed or cancelled one', async () => {
      world.checks = [check('validate', 'completed', 'success'), check('docs', 'in_progress', null), check('lint', 'completed', 'failure'), check('e2e', 'completed', 'cancelled'), check('opt', 'completed', 'skipped')];
      await boot();
      expect((await decision()).checks).toEqual({ total: 5, passed: 1, running: 1, failed: ['lint', 'e2e'] });
    });

    it('a PR with no checks says so with a total of zero', async () => {
      world.checks = [];
      await boot({ lands: true });
      const got = await decision();
      expect(got.checks).toEqual({ total: 0, passed: 0, running: 0, failed: [] });
      expect(got.lands).toBe(true);
    });

    it('a draft says it is one', async () => {
      world.pull.draft = true;
      await boot();
      expect((await decision()).pull.draft).toBe(true);
    });

    it('a forge that cannot list the checks still answers the PR: `checks` is null, and is not kept', async () => {
      world.checksDown = true;
      await boot();
      const first = await decision();
      expect(first.pull.number).toBe(40);
      expect(first.checks).toBeNull();
      world.checksDown = false;
      expect((await decision()).checks).toMatchObject({ passed: 1 }); // asked again: the failed read was not kept
    });

    it('a trigger on approval says what run it asks for; the forge and push transports have no runner to ask about', async () => {
      await boot({ on: { 'spec.approved': { kind: 'code', profile: 'claude' } } });
      expect((await decision()).run).toEqual({ kind: 'code', transport: 'forge', runner: null, lastSeen: null, quietAfterMs: null, open: null, fired: false });
    });

    it('on the pull transport the runner is never seen, quiet, or online (the window is its own)', async () => {
      await boot({ on: { 'spec.approved': { kind: 'code', profile: 'claude' } }, transport: 'pull' });
      expect((await decision()).run).toMatchObject({ kind: 'code', transport: 'pull', runner: 'never', lastSeen: null });
      runnerToken(2 * 60 * 60_000);
      clock += FRESH_MS + 1;
      const quiet = (await decision()).run;
      expect(quiet).toMatchObject({ runner: 'quiet' });
      expect(Date.parse(quiet.lastSeen)).toBe(clock - FRESH_MS - 1 - 2 * 60 * 60_000);
      runnerToken(30_000);
      clock += FRESH_MS + 1;
      expect((await decision()).run.runner).toBe('online');
    });

    it('says when an approval would ask for no new run: the trigger asks once per head, and not while a run is open', async () => {
      await boot({ on: { 'spec.approved': { kind: 'code', profile: 'claude' } } });
      expect((await decision()).run).toMatchObject({ open: null, fired: false });
      expect((await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [] })).status).toBe(200);
      let got = await decision('&fresh=1');
      for (let i = 0; i < 100 && !got.run.fired; i++) { await new Promise((r) => setTimeout(r, 20)); got = await decision('&fresh=1'); }
      expect(got.run.fired).toBe(true);
    });

    it('a landing that waits on this PR is handed over, so Cancel landing can be shown', async () => {
      world.checks = [check('validate', 'in_progress', null)];
      await boot({ lands: true });
      expect((await decision()).landing).toBeNull();
      const posted = await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [] });
      expect(posted.status, posted.text).toBe(200);
      let got = await decision();
      for (let i = 0; i < 100 && !got.landing; i++) { await new Promise((r) => setTimeout(r, 20)); got = await decision('&fresh=1'); } // the landing begins in the background
      expect(got.landing).toMatchObject({ by: 'maintainer-one' });
      expect(got.lands).toBe(true);
    });

    it('the line says the landing waits an hour: the same hour the lander waits', () => {
      expect(LAND_WITHIN_MINUTES * 60_000).toBe(TIMEOUT_MS);
    });

    it('counts checks from the forge as data: a name is text, cut to a length, never a state the server acts on', () => {
      const long = 'x'.repeat(200);
      expect(countChecks([{ name: long, state: 'failure' }]).failed[0]).toHaveLength(80);
      expect(countChecks(null)).toBeNull();
      expect(countChecks([{ name: '<img src=x onerror=alert(1)>', state: 'failure' }]).failed).toEqual(['<img src=x onerror=alert(1)>']);
    });
  });

  describe('who may ask, and for what', () => {
    it('signed out is 401, never a state', async () => {
      await boot();
      const res = await raw(srv.port, 'GET', DECISION, { headers: { accept: 'application/json' } });
      expect(res.status).toBe(401);
      expect(res.json).not.toHaveProperty('pull');
    });

    it('a proposal that is not on a PR has no decision (404), and a decision is only read', async () => {
      await boot();
      expect((await page('GET', `/proposals/${SLUG}/decision?source=checkout`)).status).toBe(404);
      expect((await page('GET', `/proposals/${SLUG}/decision`)).status).toBe(404);
      const post = await page('POST', DECISION, {});
      expect(post.status).toBe(405);
      expect(post.headers.allow).toBe('GET, HEAD');
    });

    it('a PR that is closed, or does not hold the proposal, is 404', async () => {
      await boot();
      world.pull.state = 'closed';
      expect((await page('GET', DECISION)).status).toBe(404);
      world.pull.state = 'open';
      clock += FRESH_MS + 1;
      expect((await page('GET', `/proposals/0099-other/decision?source=pull%2F40`)).status).toBe(404);
    });
  });

  describe('what a read costs', () => {
    const decisionCalls = () => world.asked.filter((a) => a === 'GET /pulls/40' || /check-runs$/.test(a));
    it('two forge calls a read (the PR and its checks), and the files by head sha', async () => {
      await boot();
      await decision();
      expect(decisionCalls()).toEqual(['GET /pulls/40', expect.stringMatching(/check-runs$/)]);
      expect(world.asked.filter((a) => a === 'GET /pulls/40/files')).toHaveLength(1);
    });

    it('every tab shares the read: asked again within the window, the forge is not', async () => {
      await boot();
      await decision();
      const before = world.asked.length;
      await decision();
      await decision();
      expect(world.asked.length).toBe(before);
    });

    it('after the window it is read again, and files are not (a commit never changes)', async () => {
      await boot();
      await decision();
      clock += FRESH_MS + 1;
      await decision();
      expect(decisionCalls()).toHaveLength(4);
      expect(world.asked.filter((a) => a === 'GET /pulls/40/files')).toHaveLength(1);
    });

    it('`fresh=1` (the end of the hold) skips the kept read and replaces it', async () => {
      await boot();
      await decision();
      world.checks = [check('validate', 'completed', 'failure')];
      expect((await decision()).checks.failed).toEqual([]); // kept: what the page saw a moment ago
      expect((await decision('&fresh=1')).checks.failed).toEqual(['validate']); // the end of the hold reads the forge
      expect((await decision()).checks.failed).toEqual(['validate']); // and the next tab shares that one
    });

    it('a review posted from cornfield forgets it, so the next look sees what the approval started', async () => {
      await boot();
      await decision();
      world.checks = [check('validate', 'in_progress', null)];
      const posted = await page('PUT', REVIEW, { verdict: 'notes', note: 'Say more.', edits: [] });
      expect(posted.status, posted.text).toBe(200);
      expect((await decision()).checks.running).toBe(1);
    });
  });

  describe('what the server refuses, whatever the page asked', () => {
    it('the same approval again, by the same maintainer, of the same version, is answered with the one that stands: 200, nothing posted (a second tab, a retried send)', async () => {
      await boot();
      const first = await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [] });
      expect(first.status, first.text).toBe(200);
      expect(first.json.posted).toBeUndefined();
      clock += 60_000;
      const second = await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [] });
      expect(second.status, second.text).toBe(200);
      expect(second.json).toMatchObject({ verdict: 'approved', posted: false, by: 'maintainer-one', comment: { id: first.json.comment.id } });
      expect(world.posted).toHaveLength(1);
      // the button reads Approved: approving again would do nothing
      expect((await page('GET', REVIEW)).json).toMatchObject({ verdict: 'approved', current: true });
    });

    it('an approval that says something new (another note, other edits) is posted, as before', async () => {
      await boot();
      expect((await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [] })).status).toBe(200);
      clock += 60_000;
      const again = await page('PUT', REVIEW, { verdict: 'approved', note: 'And keep the old export.', edits: [] });
      expect(again.status, again.text).toBe(200);
      expect(again.json.posted).toBeUndefined();
      expect(world.posted).toHaveLength(2);
    });

    it('with landing on approval, the same approval again is a repeat only while its landing waits at this head; once that landing is over it is posted, so approving again lands again', async () => {
      world.checks = [check('validate', 'in_progress', null)];
      await boot({ lands: true });
      expect((await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [] })).status).toBe(200);
      let got = await decision('&fresh=1');
      for (let i = 0; i < 100 && !got.landing; i++) { await new Promise((r) => setTimeout(r, 20)); got = await decision('&fresh=1'); }
      expect(got.landing).not.toBeNull();
      clock += 60_000;
      const repeat = await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [] });
      expect(repeat.json.posted).toBe(false);
      expect(world.posted).toHaveLength(1);
      // the maintainer cancels the landing: the approval stands, and approving again begins a landing again
      const cancel = await page('POST', '/api/forge/pulls/40/landing/cancel', {});
      expect(cancel.status, cancel.text).toBe(200);
      expect((await page('GET', REVIEW)).json).toMatchObject({ verdict: 'approved', current: false });
      clock += 60_000;
      const again = await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [] });
      expect(again.status, again.text).toBe(200);
      expect(again.json.posted).toBeUndefined();
      expect(world.posted.filter((c) => /cornfield-review/.test(c.body))).toHaveLength(2);
    });

    it('what the page was shown is what is approved: a file changed since it was served (sha256), or a head pushed since (headSha), is 409 and posts nothing', async () => {
      await boot();
      const served = await page('GET', `/proposals/${SLUG}.json?source=pull%2F40`);
      expect(served.status, served.text).toBe(200);
      const sha256 = served.headers['x-proposal-sha256'];
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
      // the agent pushes a change to the file during the hold
      world.text = proposalOf('Meals, changed');
      world.pull.head.sha = `${'c'.repeat(39)}3`;
      clock += FRESH_MS + 1;
      const stale = await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [], sha256, headSha: HEAD });
      expect(stale.status).toBe(409);
      expect(stale.json.error).toMatch(/has changed since you read it/);
      // a push that leaves the file as it was: the head the page saw is not the head now
      clock += 60_000;
      const served2 = await page('GET', `/proposals/${SLUG}.json?source=pull%2F40`);
      world.pull.head.sha = `${'d'.repeat(39)}4`;
      const moved = await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [], sha256: served2.headers['x-proposal-sha256'], headSha: `${'c'.repeat(39)}3` });
      expect(moved.status).toBe(409);
      expect(moved.json.error).toMatch(/was pushed to since you looked/);
      expect(world.posted).toEqual([]);
      // what is on screen now posts; a head that is not a commit's SHA is 400
      clock += 60_000;
      expect((await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [], headSha: 'not-a-sha' })).status).toBe(400);
      clock += 60_000;
      const now = await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [], sha256: served2.headers['x-proposal-sha256'], headSha: `${'d'.repeat(39)}4` });
      expect(now.status, now.text).toBe(200);
      expect(world.posted).toHaveLength(1);
    });

    it('a send back is not an approval to repeat: after it the version is open to approve again', async () => {
      await boot();
      expect((await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [] })).status).toBe(200);
      clock += 60_000;
      expect((await page('PUT', REVIEW, { verdict: 'notes', note: 'Not yet.', edits: [] })).status).toBe(200);
      clock += 60_000;
      expect((await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [] })).status).toBe(200);
      expect(world.posted).toHaveLength(3);
    });

    it('a push after the approval (the head holds another file) makes it open to approve again', async () => {
      await boot();
      expect((await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [] })).status).toBe(200);
      clock += 60_000;
      world.text = proposalOf('Meals, changed');
      world.pull.head.sha = `${'b'.repeat(39)}2`; // a push: another head, holding another file
      expect((await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [] })).status).toBe(200);
      expect(world.posted).toHaveLength(2);
    });

    it('a maintainer who is not one now is refused at the press, in words, and nothing posts', async () => {
      await boot();
      world.demoted = true;
      const res = await page('PUT', REVIEW, { verdict: 'approved', note: '', edits: [] });
      expect(res.status).toBe(403);
      expect(res.json.error).toBe('maintainer-one no longer maintains this repo, so the forge would not count the review.');
      expect(world.posted).toEqual([]);
    });

    it('nothing posts without a sign-in, or from another origin', async () => {
      await boot();
      const signedOut = await raw(srv.port, 'PUT', REVIEW, { headers: { accept: 'application/json', 'content-type': 'application/json', origin: origin() }, body: '{"verdict":"approved"}' });
      expect(signedOut.status).toBe(401);
      const text = JSON.stringify({ verdict: 'approved', note: '', edits: [] });
      const cross = await raw(srv.port, 'PUT', REVIEW, { headers: { cookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }, body: text });
      expect(cross.status).toBe(403);
      expect(world.posted).toEqual([]);
    });
  });
});
