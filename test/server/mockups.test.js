/**
 * @vitest-environment node
 *
 * A proposal's mockups (server/mockups.js, and the routes of server/proposals.js that use it): the list with where each
 * stands with the review, each file with the headers that keep an untrusted HTML or SVG from running script against
 * cornfield's origin, paths that cannot leave the proposals folder, files of an open spec PR read at its head
 * commit (binary intact), and an approval, posted as a review comment on the spec PR, that records the files' hashes so
 * a later change shows as changed since the approval.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
// @ts-expect-error plain JS module, no declarations
import { serveProposals } from '../../server/proposals.js';
// @ts-expect-error plain JS module, no declarations
import { createForge } from '../../server/forge.js';
// @ts-expect-error plain JS module, no declarations
import { MOCKUP_CSP, mockupStates } from '../../server/mockups.js';
import { fakeForge } from './fake-forge.js';
import { TOKEN } from './forge-contract.js';
import { whereOf } from './where.js';

const topology = { nodes: [{ id: 'root', label: 'root', type: 'root' }, { id: 'app-a', label: 'a', type: 'app' }], edges: [{ from: 'root', to: 'app-a' }] };
/** Bytes that are not text: a PNG signature, then values that are not valid UTF-8 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]);
const HOSTILE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>fetch("/topology.json")</script><rect width="9" height="9"/></svg>';
const HOSTILE_HTML = '<!doctype html><title>x</title><script>fetch("/proposals").then(r => r.text()).then(t => { document.title = t; });</script><img src="http://evil.example/x.png"><p>Hi</p>';
const sha = (b) => createHash('sha256').update(b).digest('hex');

const proposal = (mockups) => ({
  version: 1, spec: '0020', title: 'Screens', summary: 'Adds /screens.',
  nodes: { add: [{ id: 'page-screens', label: '/screens', type: 'page', parent: 'app-a' }] },
  mockups,
});
const LIST = [
  { node: 'page-screens', path: '0020-screens/list.png', title: 'The list' },
  { node: 'page-screens', path: '0020-screens/hostile.svg', title: 'A hostile svg' },
  { node: 'page-screens', path: '0020-screens/hostile.html', title: 'A hostile page' },
  { node: 'page-screens', path: '0020-screens/gone.png', title: 'Not there' },
  { node: 'page-screens', path: '../secret.png', title: 'Out by dots' },
  { node: 'page-screens', path: '0020-screens/link.png', title: 'Out by a link' },
  { node: 'page-screens', path: '0020-screens/huge.png', title: 'Too big' },
  { node: 'page-screens', path: '0020-screens/notes.txt', title: 'Not a mockup type' },
];

describe('mockups of a local proposal', () => {
  let root;
  let server;
  let port;
  const dir = () => path.join(root, 'docs/specs/proposals');

  const call = (target, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode || 0, headers: res.headers, raw, text: raw.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
  const list = async () => JSON.parse((await call('/proposals/0020-screens/mockups?source=checkout')).text);

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-mockups-'));
    fs.writeFileSync(path.join(root, 'topology.json'), JSON.stringify(topology));
    fs.mkdirSync(path.join(dir(), '0020-screens'), { recursive: true });
    fs.writeFileSync(path.join(dir(), '0020-screens.json'), JSON.stringify(proposal(LIST)));
    fs.writeFileSync(path.join(dir(), '0020-screens/list.png'), PNG);
    fs.writeFileSync(path.join(dir(), '0020-screens/hostile.svg'), HOSTILE_SVG);
    fs.writeFileSync(path.join(dir(), '0020-screens/hostile.html'), HOSTILE_HTML);
    fs.writeFileSync(path.join(dir(), '0020-screens/huge.png'), Buffer.alloc(5 * 1024 * 1024 + 1));
    fs.writeFileSync(path.join(dir(), '0020-screens/notes.txt'), 'text');
    fs.writeFileSync(path.join(root, 'docs/specs/secret.png'), 'SECRET');
    fs.writeFileSync(path.join(root, 'outside.png'), 'OUTSIDE');
    fs.symlinkSync(path.join(root, 'outside.png'), path.join(dir(), '0020-screens/link.png'));
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (!serveProposals(req, res, decodeURIComponent(url.pathname), url, whereOf(root))) { res.writeHead(418); res.end('not a proposal route'); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    fs.rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    fs.rmSync(path.join(root, '.cornfield-data'), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir(), '0020-screens/hostile.svg'), HOSTILE_SVG);
  });

  it('lists the ones that can be served, by position, with their type, address and state', async () => {
    const r = await call('/proposals/0020-screens/mockups?source=checkout');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    const got = JSON.parse(r.text);
    // The one with a path that leaves the folder, and the one that is not an image or a page, are not offered
    expect(got.map((m) => m.index)).toEqual([0, 1, 2, 3, 5, 6]);
    expect(got[0]).toEqual({
      index: 0, node: 'page-screens', path: '0020-screens/list.png', title: 'The list', type: 'image',
      url: '/proposals/0020-screens/mockups/0?source=checkout', sha256: sha(PNG), state: 'unreviewed',
    });
    expect(got[2]).toMatchObject({ type: 'page', state: 'unreviewed' });
    expect(got.find((m) => m.index === 3)).toMatchObject({ sha256: null, state: 'missing' });
    expect(got.find((m) => m.index === 5)).toMatchObject({ sha256: null, state: 'missing' }); // the link out of the folder reads as not there
  });

  it('serves a picture with its own type, byte for byte, and a policy that sandboxes it', async () => {
    const r = await call('/proposals/0020-screens/mockups/0?source=checkout');
    expect(r.status).toBe(200);
    expect(r.raw.equals(PNG)).toBe(true);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['content-length']).toBe(String(PNG.length));
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBe(MOCKUP_CSP);
  });

  it('serves HTML and SVG that cannot run script against cornfield: sandbox, no sources, no sniffing, framed only by cornfield', async () => {
    const svg = await call('/proposals/0020-screens/mockups/1?source=checkout');
    const html = await call('/proposals/0020-screens/mockups/2?source=checkout');
    expect(svg.text).toBe(HOSTILE_SVG); // served as it is: the headers are what hold it
    expect(html.text).toBe(HOSTILE_HTML);
    expect(svg.headers['content-type']).toBe('image/svg+xml');
    expect(html.headers['content-type']).toBe('text/html; charset=utf-8');
    for (const r of [svg, html]) {
      expect(r.status).toBe(200);
      const csp = r.headers['content-security-policy'];
      expect(csp.split('; ')[0]).toBe('sandbox'); // no allow-scripts, no allow-same-origin: no script, an opaque origin, even opened on its own
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'self'");
      expect(csp).not.toMatch(/script-src|allow-|'unsafe-eval'|connect-src|img-src https?:|\*/);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['content-disposition']).toBe('inline');
      expect(r.headers['cache-control']).toBe('no-cache');
    }
  });

  it('answers HEAD without a body and 304 for an unchanged file', async () => {
    const head = await call('/proposals/0020-screens/mockups/0?source=checkout', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.raw).toHaveLength(0);
    expect(head.headers['content-security-policy']).toBe(MOCKUP_CSP);
    const again = await call('/proposals/0020-screens/mockups/0?source=checkout', { headers: { 'If-None-Match': head.headers.etag } });
    expect(again.status).toBe(304);
    expect(again.raw).toHaveLength(0);
  });

  it('answers 404 for a path that leaves the folder, a link out of it, a file too big, a type that is not allowed, a gone file', async () => {
    for (const n of [3, 4, 5, 6, 7]) {
      const r = await call(`/proposals/0020-screens/mockups/${n}?source=checkout`);
      expect(r.status, `mockup ${n}`).toBe(404);
      expect(r.text).not.toMatch(/SECRET|OUTSIDE/);
    }
  });

  it('never takes a path from the request: a position, a slug and a source that were listed, nothing else', async () => {
    for (const target of [
      '/proposals/0020-screens/mockups/99?source=checkout',
      '/proposals/0020-screens/mockups/-1?source=checkout',
      '/proposals/0020-screens/mockups/1.5?source=checkout',
      '/proposals/0020-screens/mockups/0x1?source=checkout',
      '/proposals/0020-screens/mockups/..%2Fsecret.png?source=checkout',
      '/proposals/0020-screens/mockups/0020-screens%2Flist.png?source=checkout',
      '/proposals/..%2F0020-screens/mockups/0?source=checkout',
      '/proposals/nope/mockups/0?source=checkout',
      '/proposals/nope/mockups?source=checkout',
      '/proposals/0020-screens/mockups/0?source=elsewhere',
      '/proposals/0020-screens/mockups/0?source=..',
      '/proposals/0020-screens/mockups/0?source=pull%2F5', // no sign-in, no forge: nothing to ask
    ]) {
      const r = await call(target);
      expect([r.status, r.raw.equals(PNG)], target).not.toEqual([200, true]);
      expect(r.status, target).toBeGreaterThanOrEqual(400);
    }
  });

  it('is read-only', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) expect((await call('/proposals/0020-screens/mockups/0?source=checkout', { method })).status, method).toBe(405);
  });

  it('has no PR to be reviewed on: its mockups read not reviewed, and nothing is recorded anywhere', async () => {
    expect((await list()).map((m) => m.state)).toEqual(['unreviewed', 'unreviewed', 'unreviewed', 'missing', 'missing', 'missing']);
    const put = await call('/proposals/0020-screens/review', {
      method: 'PUT', headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ verdict: 'approved', note: '', edits: [] }),
    });
    expect(put.status).toBe(409);
    expect(fs.existsSync(path.join(root, '.cornfield-data'))).toBe(false);
    expect((await list()).map((m) => m.state).slice(0, 3)).toEqual(['unreviewed', 'unreviewed', 'unreviewed']);
  });

  it('mockupStates is pure: approved needs the same file, a recorded hash for another is changed', () => {
    const now = [{ node: 'n', path: 'a.png', sha256: 'h1' }, { node: 'n', path: 'b.png', sha256: 'h2' }, { node: 'n', path: 'c.png', sha256: 'h3' }, { node: 'n', path: 'd.png', sha256: null }];
    const review = { verdict: 'approved', mockups: [{ node: 'n', path: 'a.png', sha256: 'h1' }, { node: 'n', path: 'b.png', sha256: 'old' }] };
    expect(mockupStates(now, review)).toEqual(['approved', 'changed', 'unreviewed', 'missing']);
    expect(mockupStates(now, { verdict: 'notes', mockups: review.mockups })).toEqual(['unreviewed', 'unreviewed', 'unreviewed', 'missing']);
    expect(mockupStates(now, null)).toEqual(['unreviewed', 'unreviewed', 'unreviewed', 'missing']);
  });
});

describe('mockups of a spec PR', () => {
  const HEAD = '7770000000000000000000000000000000000000';
  const FOLDER = '/repos/owner/name/contents/docs/specs/proposals';
  const pull = { number: 7, title: 'Screens', state: 'open', draft: false, user: { login: 'agent-four' }, labels: [], head: { ref: 'claude/screens', sha: HEAD }, base: { ref: 'main' }, html_url: 'https://github.example.com/owner/name/pull/7', created_at: '2026-10-19T10:00:00Z', updated_at: '2026-10-19T10:30:00Z', merged_at: null };
  const prProposal = proposal([
    { node: 'page-screens', path: '0021-pr/list.png', title: 'The list' },
    { node: 'page-screens', path: '0021-pr/page.html', title: 'A page' },
    { node: 'page-screens', path: '../escape.png', title: 'Out' },
    { node: 'page-screens', path: '0021-pr/gone.png', title: 'Gone' },
  ]);
  let root;
  let fake;
  let server;
  let port;
  let forgeFor;
  let comments;
  const signedIn = { login: 'maintainer-one', record: () => {} };
  const NEW_PNG = Buffer.concat([PNG, Buffer.from([0x01])]);
  let png = PNG;

  const routes = () => ({
    'GET /repos/owner/name/issues/7/comments?per_page=100': () => ({ body: comments }),
    'POST /repos/owner/name/issues/7/comments': (req) => {
      const c = { id: 9000 + comments.length, user: { login: 'maintainer-one' }, body: JSON.parse(req.body).body, html_url: `https://github.example.com/owner/name/pull/7#issuecomment-${9000 + comments.length}`, created_at: '2026-10-19T12:00:00Z', updated_at: '2026-10-19T12:00:00Z' };
      comments.push(c);
      return { status: 201, body: c };
    },
    'GET /user': { body: { login: 'maintainer-one', id: 1, html_url: 'https://github.example.com/maintainer-one' } },
    'GET /repos/owner/name': { body: { full_name: 'owner/name', permissions: { admin: true, maintain: true, push: true, triage: true, pull: true } } },
    'GET /repos/owner/name/collaborators/maintainer-one/permission': { body: { permission: 'admin', role_name: 'admin' } },
    'GET /repos/owner/name/pulls/7': { body: pull },
    'GET /repos/owner/name/pulls/7/files?per_page=100': { body: [{ sha: 'a', filename: 'docs/specs/proposals/0021-pr.json', status: 'added', additions: 1, deletions: 0, changes: 1 }, { sha: 'b', filename: 'docs/specs/proposals/0021-pr/list.png', status: 'added', additions: 0, deletions: 0, changes: 0 }] },
    [`GET ${FOLDER}/0021-pr.json?ref=${HEAD}`]: { headers: { 'content-type': 'application/vnd.github.raw; charset=utf-8' }, body: JSON.stringify(prProposal) },
    [`GET ${FOLDER}/0021-pr/list.png?ref=${HEAD}`]: () => ({ headers: { 'content-type': 'application/octet-stream' }, body: png }),
    [`GET ${FOLDER}/0021-pr/page.html?ref=${HEAD}`]: { headers: { 'content-type': 'text/html' }, body: HOSTILE_HTML },
  });
  const call = (target, method = 'GET', body) => new Promise((resolve, reject) => {
    const headers = body === undefined ? {} : { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' };
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const raw = Buffer.concat(chunks); resolve({ status: res.statusCode || 0, headers: res.headers, raw, text: raw.toString('utf8') }); });
    });
    req.on('error', reject);
    req.end(body);
  });
  const review = (body) => call('/proposals/0021-pr/review?source=pull%2F7', 'PUT', JSON.stringify(body));
  const states = async () => { const r = await call('/proposals/0021-pr/mockups?source=pull%2F7'); expect(r.status, r.text).toBe(200); return JSON.parse(r.text).map((m) => m.state); };
  /** The JSON of the review block in the last comment posted */
  const lastBlock = () => JSON.parse(/```cornfield-review 0021-pr\n([\s\S]*?)\n```/.exec(comments[comments.length - 1].body)[1]);

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-mockups-pr-'));
    fs.writeFileSync(path.join(root, 'topology.json'), JSON.stringify(topology));
    fs.mkdirSync(path.join(root, 'docs/specs/proposals'), { recursive: true });
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (!serveProposals(req, res, decodeURIComponent(url.pathname), url, whereOf(root), forgeFor, forgeFor ? signedIn : null)) { res.writeHead(418); res.end('not a proposal route'); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  });
  afterAll(async () => {
    await fake?.close();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    fs.rmSync(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await fake?.close();
    comments = [];
    png = PNG;
    fake = await fakeForge(routes());
    forgeFor = () => createForge({ type: 'github', url: 'https://github.com', repo: 'owner/name' }, { token: TOKEN, apiUrl: fake.url });
  });

  it('lists them with the hash of each file at the head, not reviewed while the PR has no review', async () => {
    const r = await call('/proposals/0021-pr/mockups?source=pull%2F7');
    expect(r.status).toBe(200);
    const got = JSON.parse(r.text);
    expect(got.map((m) => [m.index, m.type, m.state, m.sha256])).toEqual([[0, 'image', 'unreviewed', sha(PNG)], [1, 'page', 'unreviewed', sha(HOSTILE_HTML)], [3, 'image', 'missing', null]]);
    expect(got[0].url).toBe('/proposals/0021-pr/mockups/0?source=pull%2F7');
  });

  it('records what an approval covers in the review comment: each file at the head with its SHA-256, hashed by the server', async () => {
    const posted = await review({ verdict: 'approved', note: '', edits: [] });
    expect(posted.status, posted.text).toBe(200);
    expect(lastBlock()).toEqual({
      verdict: 'approved', note: '', edits: [], proposal: sha(JSON.stringify(prProposal)),
      mockups: [{ node: 'page-screens', path: '0021-pr/list.png', sha256: sha(PNG) }, { node: 'page-screens', path: '0021-pr/page.html', sha256: sha(HOSTILE_HTML) }],
    });
    expect(await states()).toEqual(['approved', 'approved', 'missing']);
    // The page cannot say what was approved
    const forged = await review({ verdict: 'approved', mockups: [{ node: 'page-screens', path: '0021-pr/list.png', sha256: 'a'.repeat(64) }] });
    expect(forged.status).toBe(400);
    expect(comments).toHaveLength(1);
  });

  it('reads changed once a file at the head is not what was approved, and approved again after a new approval', async () => {
    await review({ verdict: 'approved' });
    png = NEW_PNG;
    expect(await states()).toEqual(['changed', 'approved', 'missing']);
    await review({ verdict: 'approved' });
    expect(lastBlock().mockups[0].sha256).toBe(sha(NEW_PNG));
    expect(await states()).toEqual(['approved', 'approved', 'missing']);
  });

  it('records none for a send back, and an edited review comment does not count', async () => {
    await review({ verdict: 'approved' });
    await review({ verdict: 'notes', note: 'Not yet.' });
    expect(lastBlock()).not.toHaveProperty('mockups');
    expect(await states()).toEqual(['unreviewed', 'unreviewed', 'missing']);
    await review({ verdict: 'approved' });
    comments[comments.length - 1].updated_at = '2026-10-19T13:00:00Z'; // someone with write access changed it
    expect(await states()).toEqual(['unreviewed', 'unreviewed', 'missing']);
  });

  it('serves a picture from the PR\'s head commit intact, as the signed-in user, with the same sandbox', async () => {
    const r = await call('/proposals/0021-pr/mockups/0?source=pull%2F7');
    expect(r.status).toBe(200);
    expect(r.raw.equals(PNG)).toBe(true);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['content-security-policy']).toBe(MOCKUP_CSP);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    const read = fake.requests.find((q) => q.url === `${FOLDER}/0021-pr/list.png?ref=${HEAD}`);
    expect(read.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('serves a PR\'s HTML sandboxed too', async () => {
    const r = await call('/proposals/0021-pr/mockups/1?source=pull%2F7');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['content-security-policy']).toMatch(/^sandbox; default-src 'none'/);
    expect(r.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('answers 404 for a path out of the folder, a file not at the head, a position not listed and a PR it does not hold', async () => {
    for (const target of [
      '/proposals/0021-pr/mockups/2?source=pull%2F7',
      '/proposals/0021-pr/mockups/3?source=pull%2F7',
      '/proposals/0021-pr/mockups/9?source=pull%2F7',
      '/proposals/0021-pr/mockups/0?source=pull%2F8',
      '/proposals/0021-pr/mockups/0?source=pull%2Fx',
      '/proposals/0021-pr/mockups/0',
      '/proposals/nope/mockups/0?source=pull%2F7',
    ]) {
      expect((await call(target)).status, target).toBe(404);
    }
    expect(fake.requests.map((q) => q.url).filter((u) => u.includes('escape'))).toEqual([]);
  });

  it('is not asked without a forge', async () => {
    forgeFor = null;
    expect((await call('/proposals/0021-pr/mockups/0?source=pull%2F7')).status).toBe(404);
    expect(fake.requests).toEqual([]);
  });

  it('answers 413 for a file over the limit, and lists it as missing', async () => {
    png = Buffer.alloc(5 * 1024 * 1024 + 1);
    const r = await call('/proposals/0021-pr/mockups/0?source=pull%2F7');
    expect(r.status).toBe(413);
    expect(JSON.parse(r.text).error).toMatch(/too big/);
    expect(await states()).toEqual(['missing', 'unreviewed', 'missing']);
  });

  it('says so plainly when the forge cannot answer', async () => {
    await fake.close();
    fake = await fakeForge({ 'GET /repos/owner/name/pulls/7': { status: 503, body: { message: 'down' } } });
    const r = await call('/proposals/0021-pr/mockups/0?source=pull%2F7');
    expect(r.status).toBe(502);
    expect(JSON.parse(r.text).error).toMatch(/GitHub could not answer/);
  });
});
