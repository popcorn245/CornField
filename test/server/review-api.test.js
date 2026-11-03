/**
 * @vitest-environment node
 *
 * The review API (server/review-api.js, spec 0002, issue #67): `POST /api/reviews` with a review token, and the
 * dashboard routes that make, list and revoke tokens, walked from the outside against a fake GitHub on loopback that
 * holds one open spec PR and remembers the comments posted on it. Held here:
 *
 *   - a token-holder's approval is the button's: the same comment block, the same audit row, the head's SHA-256
 *   - the refusals: unknown or missing token 401 (a session cookie is no substitute), revoked and expired 403, an owner
 *     who is no longer a maintainer 403, a SHA-256 that is not the head's 409, a send-back without a note 400, a
 *     repeat or a flood 429, an owner with no live sign-in 401; every one a row in `actions`, none holding a token
 *   - the comment says it came through the API and names the token's label
 *   - tokens are made, listed and revoked by a signed-in maintainer from cornfield's own page only; a token cannot make
 *     a token; the secret is shown once and kept nowhere (the table holds a SHA-256)
 *   - the Host check still answers 421; without sign-in there are no tokens
 *   - the button and the API go through one function (`submitReview`)
 * No real forge, app or token.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error plain JS module, no declarations
import { createCornfieldServer } from '../../server/server.js';
// @ts-expect-error plain JS module, no declarations
import { loadConfig } from '../../core/config.js';
// @ts-expect-error plain JS module, no declarations
import { parseReviewBlocks } from '../../server/reviews.js';
// @ts-expect-error plain JS module, no declarations
import { PER_MINUTE, COOLDOWN_MS } from '../../server/throttle.js';
// @ts-expect-error plain JS module, no declarations
import { ANONYMOUS_PER_MINUTE } from '../../server/review-api.js';
import { SAMPLE, CORNFIELD } from '../helpers.js';
import { fakeForge, recordings } from './fake-forge.js';

const SESSION_SECRET = 'x'.repeat(40);
const ENV = { CORNFIELD_GITHUB_CLIENT_ID: 'test-client-id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: SESSION_SECRET };
const PUBLIC = 'http://127.0.0.1:3350';
const MAINT = 'tok-maint';
const MAINT2 = 'tok-maint-two';
const READER = 'tok-reader';
const API = '/api/v3';
const GH = `${API}/repos/owner/name`;
const FOLDER = 'docs/specs/proposals';
const SLUG = '0040-meals';
const PATH = `${FOLDER}/${SLUG}.json`;
const DAY = 24 * 60 * 60 * 1000;
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

async function signedIn(port, code) {
  const started = await raw(port, 'GET', '/auth/start');
  const to = new URL(started.headers.location);
  const stateCookie = started.headers['set-cookie'].find((c) => c.startsWith('cornfield-oauth=')).split(';')[0];
  const back = await raw(port, 'GET', `/auth/callback?code=${code}&state=${to.searchParams.get('state')}`, { headers: { cookie: stateCookie } });
  expect(back.status, back.text).toBe(303);
  return back.headers['set-cookie'].find((c) => c.startsWith('cornfield=')).split(';')[0];
}

describe('the review API', () => {
  let fake;
  let data;
  let plainData;
  let srv;
  let plain;
  let cookie;
  let config;
  let clock = Date.parse('2026-10-19T12:00:00Z');
  /** What the fake GitHub holds */
  let world;
  const base = recordings('github');

  /** The fake GitHub: who each token is, one open spec PR with its proposal at the head, and the comments on it */
  const dispatch = (key, req) => {
    const [method, target] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
    const auth = req.headers.authorization;
    if (key === 'POST /login/oauth/access_token') return { body: { access_token: req.body.includes('c-reader') ? READER : req.body.includes('c-maint2') ? MAINT2 : MAINT, token_type: 'bearer' } };
    if (key === 'DELETE /api/v3/applications/test-client-id/token') return { status: 204 };
    if (key === `GET ${API}/user`) {
      if (auth === `Bearer ${READER}`) return { body: { login: 'reader-two', id: 1002 } };
      if (auth === `Bearer ${MAINT2}`) return { body: { login: 'maintainer-two', id: 1003 } };
      return base['GET /user'];
    }
    if (key === `GET ${GH}` && world.gate) {
      // A test holds the forge here, mid-review, to change something before the post
      const gate = world.gate;
      world.gate = null;
      return gate.then(() => dispatch(key, req));
    }
    if (key === `GET ${GH}`) {
      const maintains = auth === `Bearer ${MAINT}` ? !world.demoted.has('maintainer-one') : auth === `Bearer ${MAINT2}` ? !world.demoted.has('maintainer-two') : false;
      return { body: { id: 1, full_name: 'owner/name', permissions: { admin: false, maintain: maintains, push: maintains, triage: maintains, pull: true } } };
    }
    if (!target.startsWith(GH)) return { status: 404, body: { message: 'Not Found' } };
    const url = new URL(target.slice(GH.length), 'http://x');
    const p = decodeURIComponent(url.pathname);
    let m;
    if (method === 'GET' && (m = /^\/collaborators\/([^/]+)\/permission$/.exec(p))) {
      const maintains = (m[1] === 'maintainer-one' || m[1] === 'maintainer-two') && !world.demoted.has(m[1]);
      return { body: { permission: maintains ? 'write' : 'read', role_name: maintains ? 'maintain' : 'read', user: { login: m[1] } } };
    }
    if (method === 'GET' && p === '/pulls/40') return { body: world.pull };
    if (method === 'GET' && p === '/pulls/41') return { status: 404, body: { message: 'Not Found' } };
    if (method === 'GET' && p === '/pulls/40/files') return { body: [{ filename: PATH, status: 'modified', additions: 1, deletions: 0, changes: 1 }] };
    if (method === 'GET' && p === '/issues/40/comments') return { body: world.comments };
    if (method === 'POST' && p === '/issues/40/comments') {
      world.posted.push({ as: auth, body: JSON.parse(req.body).body });
      const who = auth === `Bearer ${MAINT2}` ? 'maintainer-two' : 'maintainer-one';
      const c = { id: 9100 + world.comments.length, user: { login: who, html_url: `https://github.example.com/${who}` }, body: JSON.parse(req.body).body, html_url: `https://github.example.com/owner/name/pull/40#issuecomment-${9100 + world.comments.length}`, created_at: new Date(clock).toISOString(), updated_at: new Date(clock).toISOString() };
      world.comments.push(c);
      return { status: 201, body: c };
    }
    if (method === 'GET' && p.startsWith('/contents/')) {
      const text = p.slice('/contents/'.length) === PATH && url.searchParams.get('ref') === world.pull.head.sha ? world.text : undefined;
      return text === undefined ? { status: 404, body: { message: 'Not Found' } } : { headers: { 'content-type': 'application/vnd.github.raw; charset=utf-8' }, body: text };
    }
    return { status: 404, body: { message: 'Not Found' } };
  };
  const routes = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? (req) => dispatch(key, req) : undefined) });

  const freshWorld = () => ({
    pull: { number: 40, title: 'Meals spec', state: 'open', draft: false, user: { login: 'agent-four', html_url: 'https://github.example.com/agent-four' }, labels: [], head: { ref: 'spec/meals', sha: `${'a'.repeat(39)}1` }, base: { ref: 'main' }, html_url: 'https://github.example.com/owner/name/pull/40', created_at: '2026-10-19T10:00:00Z', updated_at: '2026-10-19T10:30:00Z', merged_at: null },
    text: proposalOf('Meals'),
    comments: [],
    posted: [],
    demoted: new Set(),
  });

  const start = async (cfg, opts) => {
    const server = createCornfieldServer(cfg, opts);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    return { port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
  };

  beforeAll(async () => {
    fake = await fakeForge(routes);
    plainData = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-review-api-plain-'));
    const open = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: plainData } });
    plain = await start(Object.assign(open, { forge: { type: 'github', url: fake.url, repo: 'owner/name' } }), { env: {} });
  });
  afterAll(async () => {
    await plain.close();
    await fake.close();
    fs.rmSync(plainData, { recursive: true, force: true });
  });
  // Each test has its own data folder and server: its own tokens, sessions, audit rows and limits
  beforeEach(async () => {
    clock += 3 * 60_000;
    world = freshWorld();
    fake.requests.length = 0;
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-review-api-'));
    config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(config, { forge: { type: 'github', url: fake.url, repo: 'owner/name' }, publicUrl: PUBLIC });
    srv = await start(config, { env: ENV, now: () => clock });
    cookie = await signedIn(srv.port, 'c-maint');
  });
  afterEach(async () => {
    await srv.close();
    fs.rmSync(data, { recursive: true, force: true });
  });

  const origin = () => `http://127.0.0.1:${srv.port}`;
  /** A request from cornfield's own page: the cookie, the origin and JSON */
  const page = (method, target, body, { as = cookie, headers = {} } = {}) => {
    const text = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    return raw(srv.port, method, target, {
      headers: { cookie: as || undefined, origin: origin(), 'sec-fetch-site': 'same-origin', ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }), ...headers },
      body: text,
    });
  };
  const mint = async (label = 'chat bot', days) => {
    const res = await page('POST', '/api/review-tokens', days === undefined ? { label } : { label, days });
    expect(res.status, res.text).toBe(201);
    return res.json;
  };
  /** The call of an outside caller: a bearer token and a JSON body, no cookie and no origin */
  const call = (token, body, { headers = {}, port = srv.port } = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return raw(port, 'POST', '/api/reviews', {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers },
      body: text,
    });
  };
  const head = () => sha256(world.text);
  const approve = (extra = {}) => ({ pull: 40, slug: SLUG, sha256: head(), verdict: 'approved', note: 'Ship it.', ...extra });
  const rows = () => {
    const db = new DatabaseSync(path.join(data, 'cornfield.db'));
    const out = db.prepare('SELECT * FROM actions ORDER BY id').all();
    db.close();
    return out.map((r) => ({ ...r, request: JSON.parse(String(r.request)), answer: r.answer ? JSON.parse(String(r.answer)) : null }));
  };
  const last = () => rows().at(-1);
  const reviewRows = () => rows().filter((r) => r.action === 'review');

  describe('an approval', () => {
    it('is posted as the token\'s owner, saying it came through the API and naming the token, and is the review the PR then shows', async () => {
      const { secret, token } = await mint('chat bot');
      const res = await call(secret, approve());
      expect(res.status, res.text).toBe(200);
      expect(res.json).toMatchObject({ ok: true, version: 1, slug: SLUG, verdict: 'approved', note: 'Ship it.', edits: [], proposal: head(), by: 'maintainer-one', comment: { id: '9100' } });
      expect(world.posted).toHaveLength(1);
      expect(world.posted[0].as).toBe(`Bearer ${MAINT}`); // the owner's own sign-in, not a token of cornfield's
      const text = world.posted[0].body;
      expect(text.split('\n')[0]).toBe('Approved `0040-meals` (maintainer-one, through the review API with the token `chat bot`).');
      expect(text).not.toContain(secret);
      expect(parseReviewBlocks(text)).toEqual([{ slug: SLUG, review: { verdict: 'approved', note: 'Ship it.', edits: [], proposal: head() } }]);
      // and the page reads it back as the review of the proposal
      const back = await page('GET', `/proposals/${SLUG}/review?source=pull%2F40`);
      expect(back.json).toMatchObject({ verdict: 'approved', by: 'maintainer-one', proposal: head() });
      // one row: who, which PR, the token's id and label, what the forge answered
      expect(reviewRows()).toEqual([expect.objectContaining({
        login: 'maintainer-one', action: 'review', target: 'owner/name#40', status: 201,
        request: { slug: SLUG, verdict: 'approved', note: 'Ship it.', edits: [], proposal: head(), via: 'api', token: { id: token.id, label: 'chat bot' } },
        answer: { comment: '9100', url: 'https://github.example.com/owner/name/pull/40#issuecomment-9100' },
      })]);
    });

    it('fires the spec.approved hook, as the button does, with the token\'s owner as the actor', async () => {
      const HOOK_SECRET = 'h'.repeat(40);
      const got = [];
      const receiver = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          got.push({ valid: req.headers['x-cornfield-signature'] === `sha256=${createHmac('sha256', HOOK_SECRET).update(body).digest('hex')}`, body: JSON.parse(body.toString('utf8')) });
          res.writeHead(200);
          res.end('ok');
        });
      });
      await new Promise((resolve) => receiver.listen(0, '127.0.0.1', () => resolve(undefined)));
      try {
        // This test's server lists a hook; the one beforeEach made does not
        await srv.close();
        config.hooks = [{ url: `http://127.0.0.1:${receiver.address().port}/hook`, events: ['spec.approved', 'spec.sentBack'] }];
        srv = await start(config, { env: { ...ENV, CORNFIELD_HOOK_SECRET: HOOK_SECRET }, now: () => clock });
        cookie = await signedIn(srv.port, 'c-maint');
        const { secret } = await mint('chat bot');
        const res = await call(secret, approve({ note: 'Good to build.' }));
        expect(res.status, res.text).toBe(200);
        for (let i = 0; i < 400 && !got.length; i++) await new Promise((r) => setTimeout(r, 5));
        expect(got).toHaveLength(1);
        expect(got[0].valid).toBe(true);
        expect(got[0].body).toMatchObject({ event: 'spec.approved', slug: SLUG, pull: 40, headSha: world.pull.head.sha, proposalSha256: head(), actor: 'maintainer-one', note: 'Good to build.', edits: [] });
        expect(JSON.stringify(got[0].body)).not.toContain(secret);
      } finally {
        await new Promise((resolve) => { receiver.closeAllConnections(); receiver.close(() => resolve(undefined)); });
      }
    });

    it('sends back with a note and edits, the same block the button writes', async () => {
      const { secret } = await mint();
      const edits = [{ op: 'remove-node', id: 'page-meals' }];
      const res = await call(secret, { pull: 40, slug: SLUG, sha256: head(), verdict: 'notes', note: 'Make it one page.', edits });
      expect(res.status, res.text).toBe(200);
      expect(world.posted[0].body.split('\n')[0]).toBe('Sent back `0040-meals` with 1 edit (maintainer-one, through the review API with the token `chat bot`).');
      expect(parseReviewBlocks(world.posted[0].body)[0].review).toEqual({ verdict: 'notes', note: 'Make it one page.', edits });
    });

    it('counts exactly like the button\'s: the same block and the same audit row, bar the token', async () => {
      const { secret } = await mint();
      const viaApi = await call(secret, approve({ note: 'Same.' }));
      expect(viaApi.status, viaApi.text).toBe(200);
      clock += 60_000;
      const viaButton = await page('PUT', `/proposals/${SLUG}/review?source=pull%2F40`, { verdict: 'approved', note: 'Same.', edits: [] });
      expect(viaButton.status, viaButton.text).toBe(200);
      expect(world.posted).toHaveLength(2);
      expect(parseReviewBlocks(world.posted[1].body)).toEqual(parseReviewBlocks(world.posted[0].body));
      expect(world.posted[1].body.split('\n')[0]).toBe('Approved `0040-meals` (maintainer-one, in cornfield).');
      const [a, b] = reviewRows();
      const { via, token, ...apiRequest } = a.request;
      expect(via).toBe('api');
      expect(token).toMatchObject({ label: 'chat bot' });
      expect(apiRequest).toEqual(b.request);
      expect([a.login, a.action, a.target, a.status]).toEqual([b.login, b.action, b.target, b.status]);
      // and the viewer's bar shows an approval of the proposal as the head holds it, from either
      expect(viaApi.json.proposal).toBe(viaButton.json.proposal);
    });

    it('marks the token as used', async () => {
      const { secret } = await mint();
      expect((await page('GET', '/api/review-tokens')).json.tokens[0].lastUsed).toBeNull();
      clock += 1000;
      await call(secret, approve());
      expect((await page('GET', '/api/review-tokens')).json.tokens[0].lastUsed).toBe(new Date(clock).toISOString());
    });
  });

  describe('refusals, each one a row', () => {
    it('refuses a call with no token, and a session cookie is no substitute for one (401, nothing posted)', async () => {
      const text = JSON.stringify(approve());
      const res = await raw(srv.port, 'POST', '/api/reviews', { headers: { cookie, origin: origin(), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }, body: text });
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
      expect(res.json).toMatchObject({ ok: false, code: 'unauthorized' });
      expect((await call(null, approve())).status).toBe(401);
      expect(world.posted).toEqual([]);
      expect(reviewRows().map((r) => [r.login, r.status, r.request.reason])).toEqual([['(no token)', 401, 'no-token'], ['(no token)', 401, 'no-token']]);
    });

    it('refuses a token nobody holds, and anything that is not shaped like one (401)', async () => {
      await mint();
      for (const bad of [`cf_rt_${'A'.repeat(43)}`, 'cf_rt_short', 'not-a-token', `cf_rt_${'A'.repeat(43)}'; DROP TABLE review_tokens;--`]) {
        const res = await call(null, approve(), { headers: { authorization: `Bearer ${bad}` } });
        expect(res.status, bad).toBe(401);
      }
      expect((await call(null, approve(), { headers: { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` } })).status).toBe(401);
      expect(world.posted).toEqual([]);
      expect(reviewRows().at(-1)).toMatchObject({ login: '(no token)', status: 401 });
    });

    it('does not let a session stand in for a token that is revoked: the cookie is never read', async () => {
      const { secret, token } = await mint();
      expect((await page('POST', `/api/review-tokens/${token.id}/revoke`, {})).status).toBe(200);
      const text = JSON.stringify(approve());
      const res = await raw(srv.port, 'POST', '/api/reviews', { headers: { authorization: `Bearer ${secret}`, cookie, origin: origin(), 'content-type': 'application/json' }, body: text });
      expect(res.status).toBe(403);
      expect(world.posted).toEqual([]);
    });

    it('refuses a revoked token (403), in words and in the audit, under its owner', async () => {
      const { secret, token } = await mint('old bot');
      expect((await call(secret, approve())).status).toBe(200);
      clock += 60_000;
      const revoked = await page('POST', `/api/review-tokens/${token.id}/revoke`, {});
      expect(revoked.json.token).toMatchObject({ id: token.id, state: 'revoked', revoked: new Date(clock).toISOString() });
      const res = await call(secret, approve());
      expect(res.status, res.text).toBe(403);
      expect(res.json).toMatchObject({ ok: false, code: 'forbidden' });
      expect(res.json.error).toMatch(/revoked/);
      expect(world.posted).toHaveLength(1);
      expect(reviewRows().at(-1)).toMatchObject({ login: 'maintainer-one', status: 403, target: 'owner/name', request: { via: 'api', reason: 'revoked', token: { id: token.id, label: 'old bot' } } });
    });

    it('does not post when the token is revoked while the review is being checked (403, nothing posted)', async () => {
      const { secret, token } = await mint('slow bot');
      let release = () => {};
      world.gate = new Promise((resolve) => { release = resolve; });
      const asked = fake.requests.length;
      const pending = call(secret, approve());
      // Wait until the review is at the forge (its token already looked up and found live), then revoke it
      for (let i = 0; i < 200 && !fake.requests.slice(asked).some((r) => r.url === GH); i++) await new Promise((r) => setTimeout(r, 5));
      expect((await page('POST', `/api/review-tokens/${token.id}/revoke`, {})).status).toBe(200);
      release();
      const res = await pending;
      expect(res.status, res.text).toBe(403);
      expect(res.json.error).toMatch(/revoked while the review was being checked; nothing was posted/);
      expect(world.posted).toEqual([]);
      expect(reviewRows().at(-1)).toMatchObject({ status: 403, request: { via: 'api', token: { id: token.id } } });
    });

    it('breaks the mentions and references in a note that came through the API, in the quote people read; the block keeps it as sent', async () => {
      const { secret } = await mint();
      const note = 'Looks fine, @owner/team and @someone; see #12 and https://example.org/x';
      expect((await call(secret, approve({ verdict: 'notes', note }))).status).toBe(200);
      const body = world.posted[0].body;
      const quote = body.split('\n').filter((l) => l.startsWith('> ')).join('\n');
      expect(quote).not.toMatch(/@[A-Za-z]/);
      expect(quote).not.toMatch(/#\d/);
      expect(quote).not.toContain('https://');
      expect(quote.replaceAll('\u200B', '')).toBe(`> ${note}`);
      expect(parseReviewBlocks(body)[0].review.note).toBe(note);
    });

    it('keeps nothing of a body it cannot read: not the parser\'s words, which quote it, nor a slug that is not one', async () => {
      const { secret } = await mint();
      const pasted = 'cf_rt_this-was-pasted-into-the-body-by-mistake-000000000000';
      const bad = await call(secret, `${pasted} {`);
      expect([bad.status, bad.json.error]).toEqual([400, 'The body is not valid JSON.']);
      clock += 10_000;
      const slugged = await call(secret, approve({ slug: `${pasted}/../x` }));
      expect(slugged.status).toBe(400);
      const all = JSON.stringify(rows());
      expect(all).not.toContain(pasted);
      expect(fs.readFileSync(path.join(data, 'cornfield.db')).includes(pasted)).toBe(false);
    });

    it('refuses an expired token (403)', async () => {
      const { secret, token } = await mint('short', 1);
      expect(token.expires).toBe(new Date(clock + DAY).toISOString());
      clock += DAY + 1000;
      const res = await call(secret, approve());
      expect(res.status, res.text).toBe(403);
      expect(res.json.error).toMatch(/expired/);
      expect(world.posted).toEqual([]);
      expect(reviewRows().at(-1)).toMatchObject({ status: 403, request: { reason: 'expired', token: { id: token.id } } });
    });

    it('refuses a proposal that is not the head\'s: the SHA-256 is of the version that was read (409)', async () => {
      const { secret } = await mint();
      const read = head();
      world.text = proposalOf('Meals, pushed to since'); // the head moves on after the caller read the file
      world.pull = { ...world.pull, head: { ...world.pull.head, sha: `${'b'.repeat(39)}2` } };
      const res = await call(secret, approve({ sha256: read }));
      expect(res.status, res.text).toBe(409);
      expect(res.json).toMatchObject({ ok: false, code: 'conflict' });
      expect(res.json.error).toMatch(/changed since you read it/);
      expect(world.posted).toEqual([]);
      expect(reviewRows().at(-1)).toMatchObject({ login: 'maintainer-one', action: 'review', target: 'owner/name#40', status: 409, request: { slug: SLUG, pull: 40, sha256: read, verdict: 'approved', via: 'api' } });
      // reading the new version and reviewing that works
      clock += 10_000;
      expect((await call(secret, approve())).status).toBe(200);
    });

    it('needs the version named: no sha256, or one that is not 64 lower-case hex digits, is 400', async () => {
      const { secret } = await mint();
      const { sha256: _, ...without } = approve();
      for (const body of [without, approve({ sha256: 'abc' }), approve({ sha256: head().toUpperCase() }), approve({ sha256: 5 })]) {
        clock += 10_000;
        const res = await call(secret, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.json.error).toMatch(/sha256/);
      }
      expect(world.posted).toEqual([]);
    });

    it('refuses a send-back without a note (400) and records it', async () => {
      const { secret } = await mint();
      for (const note of [undefined, '', '   ']) {
        clock += 10_000;
        const res = await call(secret, approve({ verdict: 'notes', note }));
        expect(res.status).toBe(400);
        expect(res.json.error).toMatch(/note is needed/);
      }
      expect(world.posted).toEqual([]);
      expect(reviewRows().at(-1)).toMatchObject({ status: 400, request: { verdict: 'notes', via: 'api' }, answer: { code: 'invalid' } });
    });

    it('refuses a body that is not a review: not JSON, a key it does not have, what an approval covers (the server records that), too large', async () => {
      const { secret } = await mint();
      const cases = [['{ nope', 400], ['[]', 400], [JSON.stringify({ ...approve(), extra: 1 }), 400], [JSON.stringify({ ...approve(), proposal: head() }), 400], [JSON.stringify({ ...approve(), mockups: [] }), 400], [JSON.stringify(approve({ verdict: 'maybe' })), 400], [JSON.stringify(approve({ pull: '40' })), 400], [JSON.stringify(approve({ slug: '../etc' })), 400], ['x'.repeat(300 * 1024), 413]];
      for (const [body, status] of cases) {
        clock += 10_000;
        const res = await call(secret, body);
        expect(res.status, body.slice(0, 60)).toBe(status);
      }
      expect(world.posted).toEqual([]);
      expect(reviewRows()).toHaveLength(cases.length); // every one written down
    });

    it('refuses a PR that is not open, one that does not hold the proposal (404)', async () => {
      const { secret } = await mint();
      expect((await call(secret, approve({ pull: 41 }))).status).toBe(404);
      clock += 10_000;
      expect((await call(secret, approve({ slug: '0099-other' }))).status).toBe(404);
      clock += 10_000;
      world.pull = { ...world.pull, state: 'closed' };
      expect((await call(secret, approve())).status).toBe(404);
      expect(world.posted).toEqual([]);
      expect(reviewRows().map((r) => r.status)).toEqual([404, 404, 404]);
    });

    it('asks the forge now whether the owner still maintains the repo: a demoted owner is refused (403) with the token still live', async () => {
      const { secret } = await mint();
      expect((await call(secret, approve())).status).toBe(200);
      clock += 60_000;
      world.demoted.add('maintainer-one');
      const res = await call(secret, approve());
      expect(res.status, res.text).toBe(403);
      expect(res.json.error).toMatch(/not one now/);
      expect(world.posted).toHaveLength(1);
      expect(last()).toMatchObject({ login: 'maintainer-one', action: 'review', status: 403 });
      // the owner is a maintainer again: the same token works again
      world.demoted.clear();
      clock += 60_000;
      expect((await call(secret, approve())).status).toBe(200);
    });

    it('does not post with a sign-in that has expired, though the token is still live (401)', async () => {
      const { secret } = await mint('weekly bot', 30);
      clock += 8 * DAY; // past the session's 7 days, within the token's 30
      const res = await call(secret, approve());
      expect([res.status, res.json.code]).toEqual([401, 'unauthorized']);
      expect(world.posted).toEqual([]);
    });

    it('cannot post for an owner who has signed out: there is no sign-in to post with (401)', async () => {
      const { secret } = await mint();
      expect((await page('POST', '/auth/sign-out', '')).status).toBe(303);
      const res = await call(secret, approve());
      expect(res.status, res.text).toBe(401);
      expect(res.json).toMatchObject({ ok: false, code: 'unauthorized' });
      expect(res.json.error).toMatch(/sign in to cornfield again/);
      expect(world.posted).toEqual([]);
      expect(last()).toMatchObject({ login: 'maintainer-one', status: 401 });
      // signed in again: the same token works
      cookie = await signedIn(srv.port, 'c-maint');
      clock += 10_000;
      expect((await call(secret, approve())).status).toBe(200);
    });

    it('holds the repeat limit: the same review of the same proposal again within a few seconds is 429, with Retry-After', async () => {
      const { secret } = await mint();
      expect((await call(secret, approve())).status).toBe(200);
      const again = await call(secret, approve());
      expect(again.status).toBe(429);
      expect(again.json.code).toBe('rate-limited');
      expect(Number(again.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(world.posted).toHaveLength(1);
      expect(reviewRows().at(-1)).toMatchObject({ status: 429 });
      clock += COOLDOWN_MS + 1;
      expect((await call(secret, approve())).status).toBe(200);
    });

    it('holds the flood limit, counting the button and the API as one person: past the ceiling it is 429 and nothing more is written down', async () => {
      const { secret } = await mint();
      const seen = [];
      for (let i = 1; i <= PER_MINUTE + 1; i++) seen.push((await call(secret, approve({ pull: 100 + i }))).status); // PRs that do not exist: counted all the same
      expect(seen.slice(0, PER_MINUTE).every((s) => s === 404)).toBe(true);
      expect(seen.at(-1)).toBe(429);
      const before = rows().length;
      const button = await page('PUT', `/proposals/${SLUG}/review?source=pull%2F40`, { verdict: 'approved' });
      expect(button.status).toBe(429); // the same person at the button
      expect(rows().length).toBe(before + 1); // a repeat is a row; past the attempts ceiling there would be none
    });

    it('does not let callers with no token grow the audit table past a ceiling: 429, nothing written', async () => {
      let written = 0;
      let refused = 0;
      const before = rows().length;
      for (let i = 0; i < ANONYMOUS_PER_MINUTE + 5; i++) {
        const res = await call(null, approve());
        if (res.status === 401) written++;
        if (res.status === 429) refused++;
      }
      expect(rows().length - before).toBe(written);
      expect(written).toBeLessThanOrEqual(ANONYMOUS_PER_MINUTE);
      expect(refused).toBeGreaterThan(0);
    });
  });

  describe('tokens, from the dashboard', () => {
    it('are made once: the secret is in the answer and in no table, no audit row and no list', async () => {
      const made = await mint('ci');
      expect(made.secret).toMatch(/^cf_rt_[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(made.secret.slice(6), 'base64url')).toHaveLength(32);
      expect(made.token).toMatchObject({ label: 'ci', login: 'maintainer-one', state: 'active', revoked: null, lastUsed: null, created: new Date(clock).toISOString(), expires: new Date(clock + 30 * DAY).toISOString() });
      const list = await page('GET', '/api/review-tokens');
      expect(list.json).toMatchObject({ ok: true, defaultDays: 30, maxDays: 90, tokens: [made.token] });
      expect(list.text).not.toContain(made.secret);
      expect(list.text).not.toContain(sha256(made.secret));
      const db = new DatabaseSync(path.join(data, 'cornfield.db'));
      try {
        const row = db.prepare('SELECT * FROM review_tokens WHERE id = ?').get(made.token.id);
        expect(row.token_hash).toBe(sha256(made.secret));
        expect(Object.values(row)).not.toContain(made.secret);
        for (const table of ['actions', 'sessions', 'forge_cache']) expect(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).not.toContain(made.secret);
      } finally {
        db.close();
      }
      expect(last()).toMatchObject({ login: 'maintainer-one', action: 'review-token', status: 201, request: { op: 'mint', label: 'ci', days: 30, id: made.token.id } });
    });

    it('last 30 days unless asked, and 90 at most', async () => {
      const long = await mint('long', 90);
      expect(long.token.expires).toBe(new Date(clock + 90 * DAY).toISOString());
      for (const days of [0, 91, 1.5, '30', -1]) {
        const res = await page('POST', '/api/review-tokens', { label: 'x', days });
        expect(res.status, String(days)).toBe(400);
      }
    });

    it('need a label that is words, and refuse what the comment could not quote', async () => {
      for (const label of ['', '   ', 'a`b', '@someone', 'line\nbreak', 'x'.repeat(61), undefined, 5, ' lead']) {
        const res = await page('POST', '/api/review-tokens', { label });
        expect(res.status, String(label)).toBe(400);
      }
      expect((await page('POST', '/api/review-tokens', { label: 'ok', admin: true })).status).toBe(400);
      expect((await mint('Chat bot (staging) v2.1')).token.label).toBe('Chat bot (staging) v2.1');
    });

    it('are made from cornfield\'s own page only: JSON, the same origin, and a session', async () => {
      const body = JSON.stringify({ label: 'x' });
      const headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
      expect((await raw(srv.port, 'POST', '/api/review-tokens', { headers: { cookie, ...headers }, body })).status).toBe(403); // no origin
      expect((await raw(srv.port, 'POST', '/api/review-tokens', { headers: { cookie, origin: 'http://evil.example', ...headers }, body })).status).toBe(403);
      expect((await raw(srv.port, 'POST', '/api/review-tokens', { headers: { cookie, origin: origin(), 'sec-fetch-site': 'cross-site', ...headers }, body })).status).toBe(403);
      expect((await raw(srv.port, 'POST', '/api/review-tokens', { headers: { cookie, origin: origin(), 'content-type': 'text/plain' }, body })).status).toBe(415);
      expect((await raw(srv.port, 'POST', '/api/review-tokens', { headers, body })).status).toBe(401); // no session
      expect((await page('GET', '/api/review-tokens', undefined, { as: null })).status).toBe(401);
      expect((await page('PUT', '/api/review-tokens', {})).status).toBe(405);
      expect((await page('GET', '/api/review-tokens/1/revoke')).status).toBe(405);
      expect((await page('GET', '/api/review-tokens')).json.tokens).toEqual([]);
    });

    it('cannot be made with a review token: a token does one thing', async () => {
      const { secret } = await mint();
      const body = JSON.stringify({ label: 'child' });
      const res = await raw(srv.port, 'POST', '/api/review-tokens', { headers: { authorization: `Bearer ${secret}`, origin: origin(), 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, body });
      expect(res.status).toBe(401);
      expect((await raw(srv.port, 'GET', '/api/review-tokens', { headers: { authorization: `Bearer ${secret}` } })).status).toBe(401);
      expect((await raw(srv.port, 'POST', '/api/review-tokens/1/revoke', { headers: { authorization: `Bearer ${secret}`, origin: origin() }, body: '{}' })).status).toBe(401);
    });

    it('are made by someone who maintains the repo now, asked of the forge, not by a session\'s memory', async () => {
      world.demoted.add('maintainer-one');
      const res = await page('POST', '/api/review-tokens', { label: 'x' });
      expect(res.status).toBe(403);
      expect(res.json.error).toMatch(/not one now/);
      expect(last()).toMatchObject({ action: 'review-token', status: 403 });
      expect((await page('GET', '/api/review-tokens')).json.tokens).toEqual([]);
    });

    it('are at most 20 live at once per owner', async () => {
      for (let i = 0; i < 20; i++) await mint(`bot ${i}`);
      clock += 60_000;
      const res = await page('POST', '/api/review-tokens', { label: 'one too many' });
      expect(res.status).toBe(409);
      expect(res.json.error).toMatch(/20 live tokens/);
    });

    it('belong to their owner: another maintainer neither sees nor revokes them', async () => {
      const { secret, token } = await mint('mine');
      const other = await signedIn(srv.port, 'c-maint2');
      expect((await page('GET', '/api/review-tokens', undefined, { as: other })).json.tokens).toEqual([]);
      const res = await page('POST', `/api/review-tokens/${token.id}/revoke`, {}, { as: other });
      expect(res.status).toBe(404);
      expect((await call(secret, approve())).status).toBe(200); // still live, and posted as its owner
      expect(world.posted[0].as).toBe(`Bearer ${MAINT}`);
    });

    it('are revoked for good, and revoking again keeps the first time; the revoke is a row', async () => {
      const { token } = await mint();
      const first = await page('POST', `/api/review-tokens/${token.id}/revoke`, {});
      clock += 60_000;
      const second = await page('POST', `/api/review-tokens/${token.id}/revoke`, {});
      expect(second.json.token.revoked).toBe(first.json.token.revoked);
      expect(last()).toMatchObject({ action: 'review-token', status: 200, request: { op: 'revoke', id: token.id, label: 'chat bot' } });
      expect((await page('GET', '/api/review-tokens')).json.tokens[0].state).toBe('revoked');
    });
  });

  describe('where it is held', () => {
    it('answers the Host check first (421), for a name that is not cornfield\'s', async () => {
      const { secret } = await mint();
      const res = await call(secret, approve(), { headers: { host: 'evil.example' } });
      expect(res.status).toBe(421);
      expect(world.posted).toEqual([]);
    });

    it('has no tokens without sign-in: nobody to post as (403)', async () => {
      const res = await call(`cf_rt_${'A'.repeat(43)}`, approve(), { port: plain.port });
      expect(res.status).toBe(403);
      expect(res.json.error).toMatch(/sign-in/);
      expect((await raw(plain.port, 'GET', '/api/review-tokens')).status).toBe(403);
      expect((await raw(plain.port, 'POST', '/api/review-tokens', { headers: { origin: `http://127.0.0.1:${plain.port}`, 'content-type': 'application/json' }, body: '{"label":"x"}' })).status).toBe(403);
      expect(fs.existsSync(path.join(plainData, 'cornfield.db'))).toBe(false);
    });

    it('answers only POST on /api/reviews', async () => {
      const { secret } = await mint();
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const res = await raw(srv.port, method, '/api/reviews', { headers: { authorization: `Bearer ${secret}` } });
        expect(res.status, method).toBe(405);
        expect(res.headers.allow).toBe('POST');
      }
    });

    it('is one function: the button and the API both go through submitReview, and nothing else posts a review', () => {
      const sources = Object.fromEntries(fs.readdirSync(path.join(CORNFIELD, 'server')).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(CORNFIELD, 'server', f), 'utf8')]));
      const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const callers = (re) => Object.keys(sources).filter((f) => re.test(code(sources[f]))).sort();
      expect(callers(/\bsubmitReview\(/)).toEqual(['proposals.js', 'review-api.js', 'submit-review.js']);
      // the comment is posted in submit-review.js, and by the one-off carry-over of Stage 1 reviews in reviews.js
      expect(callers(/\bpostReview\(/)).toEqual(['reviews.js', 'submit-review.js']);
      expect(callers(/\bforge\.comment\(/)).toEqual(['reviews.js']);
    });
  });
});
