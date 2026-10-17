/**
 * @vitest-environment node
 *
 * The review of a proposal (TOPO-12, spec 0012 B5): the schema of what the viewer sends, and
 * the hub's `PUT /proposals/<slug>/review` that writes it beside the proposal, with every guard it
 * has (method, same origin, size, schema, only a proposal the hub listed, only beside that one, atomic),
 * `GET` of it, and the `review` the listing carries. Runs the handler in-process over a temporary checkout.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
// @ts-expect-error plain JS module, no declarations
import { serveProposals, validateReview, sameOrigin, REVIEW_LIMIT, MAX_REVIEW_EDITS } from '../../server/proposals.js';
import { whereOf } from './where.js';

const topology = { nodes: [{ id: 'root', label: 'root', type: 'root' }, { id: 'app-a', label: 'a', type: 'app' }], edges: [{ from: 'root', to: 'app-a' }] };
const proposal = { version: 1, spec: '0013', title: 'Meals', summary: 'Adds /meals.', nodes: { add: [{ id: 'page-meals', label: '/meals', type: 'page', parent: 'app-a' }] } };
const edits = [{ op: 'add-node', id: 'page-extra', label: '/extra', type: 'page', parent: 'app-a', at: 1 }, { op: 'remove-edge', from: 'a', to: 'b' }];

// ---------------------------------------------------------------------------
//  The schema
// ---------------------------------------------------------------------------

describe('validateReview', () => {
  const ok = (body         ) => { const r = validateReview(body); expect(r.ok, JSON.stringify(r)).toBe(true); return r.value; };
  const refused = (body         , words         ) => {
    const r = validateReview(body);
    expect(r.ok, JSON.stringify(body)?.slice(0, 80)).toBe(false);
    expect(typeof r.error).toBe('string');
    if (words) expect(r.error).toMatch(words);
    return r.error;
  };

  it('takes a verdict, a note and a list of edits, and fills in what is left out', () => {
    expect(ok({ verdict: 'approved' })).toEqual({ verdict: 'approved', note: '', edits: [] });
    expect(ok({ verdict: 'approved', note: 'Looks right.', edits })).toEqual({ verdict: 'approved', note: 'Looks right.', edits });
    expect(ok({ verdict: 'notes', note: 'Drop the cache.', edits: [] })).toEqual({ verdict: 'notes', note: 'Drop the cache.', edits: [] });
  });

  it('wants the verdict to be approved or notes', () => {
    for (const verdict of ['rejected', 'APPROVED', '', 'approve', 5, null, undefined, ['approved'], {}]) refused({ verdict, note: 'n' }, /verdict/i);
    refused({}, /verdict/i);
  });

  it('wants a note, in words, when it is sent back', () => {
    refused({ verdict: 'notes' }, /note/i);
    refused({ verdict: 'notes', note: '' }, /note/i);
    refused({ verdict: 'notes', note: '   \n ' }, /note/i);
    ok({ verdict: 'approved', note: '' });
  });

  it('wants the note to be a string, not too long', () => {
    for (const note of [5, null, ['a'], {}, true]) refused({ verdict: 'approved', note }, /note/i);
    refused({ verdict: 'approved', note: 'x'.repeat(20001) }, /note/i);
    ok({ verdict: 'approved', note: 'x'.repeat(20000) });
  });

  it('wants edits to be a list of objects that each have a string op', () => {
    for (const bad of ['add-node', 5, null, {}, { op: 'add-node' }]) refused({ verdict: 'approved', edits: bad }, /edits/i);
    for (const bad of [[{ id: 'x' }], [{ op: 3 }], [{ op: '' }], [{ op: null }], ['add-node'], [null], [5], [[{ op: 'a' }]], [{ op: 'a' }, { nope: 1 }]]) {
      refused({ verdict: 'approved', edits: bad }, /edit/i);
    }
    ok({ verdict: 'approved', edits: [{ op: 'add-node' }] });
  });

  it('says which edit it is when one is wrong', () => {
    expect(refused({ verdict: 'approved', edits: [{ op: 'a' }, { op: 'b' }, { nope: 1 }] })).toMatch(/\b3\b|third|#3|edit 3/i);
  });

  it('allows MAX_REVIEW_EDITS edits and not one more', () => {
    ok({ verdict: 'approved', edits: Array.from({ length: MAX_REVIEW_EDITS }, () => ({ op: 'add-node' })) });
    refused({ verdict: 'approved', edits: Array.from({ length: MAX_REVIEW_EDITS + 1 }, () => ({ op: 'add-node' })) }, /at most/i);
  });

  it('allows nothing else at the top level, and only an object', () => {
    for (const extra of ['at', 'version', 'extra', 'proposal', '__proto__x']) refused({ verdict: 'approved', [extra]: 1 }, new RegExp(extra));
    for (const bad of [null, undefined, [], 'approved', 5, true]) refused(bad, /object/i);
  });

  it('hands back copies: what it returns is not the object it was given', () => {
    const body = { verdict: 'notes', note: 'n', edits: [{ op: 'a' }] };
    const value = ok(body);
    expect(value).not.toBe(body);
    expect(value.edits).not.toBe(body.edits);
  });
});

// ---------------------------------------------------------------------------
//  Same origin
// ---------------------------------------------------------------------------

describe('sameOrigin', () => {
  const req = (headers                        ) => ({ headers })       ;
  it('takes the page itself: Origin or Sec-Fetch-Site says it is the hub\'s own', () => {
    expect(sameOrigin(req({ host: 'localhost:3333', origin: 'http://localhost:3333' }))).toBe(true);
    expect(sameOrigin(req({ host: '127.0.0.1:3333', origin: 'http://127.0.0.1:3333', 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(sameOrigin(req({ host: 'server-1.example-net.ts.net:3333', 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(sameOrigin(req({ host: 'server-1:3333', origin: 'http://server-1:3333' }))).toBe(true);
    expect(sameOrigin(req({ host: '[::1]:3333', origin: 'http://[::1]:3333' }))).toBe(true);
    // the configured public URL's host is the server's own too
    expect(sameOrigin(req({ host: 'cornfield.example.org', origin: 'https://cornfield.example.org' }), 'cornfield.example.org')).toBe(true);
    expect(sameOrigin(req({ host: 'cornfield.example.org', origin: 'https://cornfield.example.org' }))).toBe(false);
  });
  it('refuses another site, another port, a missing header, and a host that is not the hub\'s own name', () => {
    expect(sameOrigin(req({ host: 'localhost:3333' }))).toBe(false); // neither header
    expect(sameOrigin(req({ host: 'localhost:3333', origin: 'http://evil.example' }))).toBe(false);
    expect(sameOrigin(req({ host: 'localhost:3333', origin: 'http://localhost:3334' }))).toBe(false);
    expect(sameOrigin(req({ host: 'localhost:3333', origin: 'https://localhost:3333' }))).toBe(true); // a TLS front for the same host and port is the same host
    expect(sameOrigin(req({ host: 'localhost:3333', origin: 'null' }))).toBe(false);
    expect(sameOrigin(req({ host: 'localhost:3333', origin: 'not a url' }))).toBe(false);
    expect(sameOrigin(req({ host: 'localhost:3333', 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(sameOrigin(req({ host: 'localhost:3333', 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(sameOrigin(req({ host: 'localhost:3333', 'sec-fetch-site': 'none' }))).toBe(false);
    expect(sameOrigin(req({ host: 'localhost:3333', origin: 'http://localhost:3333', 'sec-fetch-site': 'cross-site' }))).toBe(false); // both must agree
    expect(sameOrigin(req({ origin: 'http://localhost:3333' }))).toBe(false); // no Host
    // DNS rebinding: a page on evil.example resolved to this machine sends Origin and Host that match each other
    expect(sameOrigin(req({ host: 'evil.example:3333', origin: 'http://evil.example:3333', 'sec-fetch-site': 'same-origin' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  The routes
// ---------------------------------------------------------------------------

describe('PUT /proposals/<slug>/review', () => {
  let root        ;
  let server             ;
  let port        ;
  const dirOf = (where        ) => path.join(root, where, 'docs/specs/proposals');
  const put = (where        , name        , text        ) => {
    fs.mkdirSync(dirOf(where), { recursive: true });
    fs.writeFileSync(path.join(dirOf(where), name), text);
  };
  /** Where the server keeps a review: its data folder, by source (never beside the proposal) */
  const reviewsOf = (where) => path.join(root, '.cornfield-data', 'reviews', where ? where.split('/').pop() : 'checkout');
  const reviewAt = (where        , slug = '0013-meals') => path.join(reviewsOf(where), `${slug}.review.json`);
  const origin = () => `http://127.0.0.1:${port}`;
  const same = () => ({ Origin: origin() });
  const approve = { verdict: 'approved', note: 'Looks right.', edits };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-review-'));
    fs.writeFileSync(path.join(root, 'topology.json'), JSON.stringify(topology));
    fs.writeFileSync(path.join(root, 'secret.json'), '{"secret":true}');
    put('', '0013-meals.json', JSON.stringify(proposal));
    put('', '0014-other.json', JSON.stringify({ ...proposal, title: 'Other' }));
    put('.claude/worktrees/topo-09', '0013-meals.json', JSON.stringify({ ...proposal, title: 'Meals, newer' }));
    put('.claude/worktrees/topo-09', '0017-worktree-only.json', JSON.stringify({ version: 1, title: 'Only here', summary: 's' }));
    server = http.createServer((req, res) => {
      const url = new URL(req.url , 'http://localhost');
      if (!serveProposals(req, res, decodeURIComponent(url.pathname), url, whereOf(root))) { res.writeHead(418); res.end('not a proposal route'); }
    });
    await new Promise      ((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address()                   ).port;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A request with the path exactly as given and a body as given (fetch would tidy a `..` away) */
  function raw(method        , target        , body                  , headers                         = {})                                                                                          {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: false }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode || 0, headers: res.headers, body: text, json }); });
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  const send = (target        , body         , headers                         = same(), method = 'PUT') =>
    raw(method, target, typeof body === 'string' ? body : JSON.stringify(body), { 'Content-Type': 'application/json', ...headers });
  const files = (where        ) => fs.readdirSync(dirOf(where)).sort();

  it('keeps the review in its data folder, never in the checkout: version, verdict, note, edits and the time it was written', async () => {
    const before = Date.now();
    const r = await send('/proposals/0014-other/review?source=checkout', approve);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    const file = JSON.parse(fs.readFileSync(reviewAt('', '0014-other'), 'utf8'));
    expect(file).toEqual({ version: 1, verdict: 'approved', note: 'Looks right.', edits, at: expect.any(String) });
    expect(Object.keys(file)).toEqual(['version', 'verdict', 'note', 'edits', 'at']);
    expect(new Date(file.at).toISOString()).toBe(file.at);
    expect(Date.parse(file.at)).toBeGreaterThanOrEqual(before - 1000);
    expect(r.json).toEqual(file);
    expect(files('')).toEqual(['0013-meals.json', '0014-other.json']); // nothing written into the checkout
    expect(fs.readdirSync(reviewsOf('')).sort()).toEqual(['0014-other.review.json']); // no temp file left behind
  });

  it('keeps the review of the copy it was asked about: the worktree copy and the checkout copy apart', async () => {
    expect((await send('/proposals/0013-meals/review?source=topo-09', { verdict: 'notes', note: 'Smaller.', edits: [] })).status).toBe(200);
    expect(fs.existsSync(reviewAt('.claude/worktrees/topo-09'))).toBe(true);
    expect(fs.existsSync(reviewAt(''))).toBe(false);
    expect((await send('/proposals/0013-meals/review?source=checkout', approve)).status).toBe(200);
    expect(JSON.parse(fs.readFileSync(reviewAt(''), 'utf8')).verdict).toBe('approved');
    expect(JSON.parse(fs.readFileSync(reviewAt('.claude/worktrees/topo-09'), 'utf8')).verdict).toBe('notes');
  });

  it('with no source it is the first listed, the worktree copy, as for the proposal itself', async () => {
    expect((await send('/proposals/0013-meals/review', approve)).status).toBe(200);
    expect(fs.existsSync(reviewAt('.claude/worktrees/topo-09'))).toBe(true);
    expect(fs.existsSync(reviewAt(''))).toBe(false);
    expect((await send('/proposals/0013-meals/review?source=', approve)).status).toBe(200);
  });

  it('replaces the review that was there, and leaves the proposal as it was', async () => {
    const proposalText = fs.readFileSync(path.join(dirOf(''), '0014-other.json'), 'utf8');
    await send('/proposals/0014-other/review?source=checkout', approve);
    await send('/proposals/0014-other/review?source=checkout', { verdict: 'notes', note: 'Changed my mind.', edits: [] });
    const file = JSON.parse(fs.readFileSync(reviewAt('', '0014-other'), 'utf8'));
    expect(file).toMatchObject({ verdict: 'notes', note: 'Changed my mind.', edits: [] });
    expect(fs.readFileSync(path.join(dirOf(''), '0014-other.json'), 'utf8')).toBe(proposalText);
    expect(files('')).toEqual(['0013-meals.json', '0014-other.json']);
  });

  it('stores what the schema made of it: a bare approval gets an empty note and no edits', async () => {
    await send('/proposals/0014-other/review?source=checkout', { verdict: 'approved' });
    expect(JSON.parse(fs.readFileSync(reviewAt('', '0014-other'), 'utf8'))).toMatchObject({ verdict: 'approved', note: '', edits: [] });
  });

  it('answers 405 for any other method, with what is allowed', async () => {
    for (const method of ['POST', 'DELETE', 'PATCH']) {
      const r = await send('/proposals/0014-other/review?source=checkout', approve, same(), method);
      expect(r.status, method).toBe(405);
      expect(r.headers.allow).toBe('GET, HEAD, PUT');
    }
    expect(fs.existsSync(reviewAt('', '0014-other'))).toBe(false);
  });

  describe('only from the hub\'s own page', () => {
    it('answers 403 without Origin or Sec-Fetch-Site, from another site, or from another port', async () => {
      const tries                           = [
        {},
        { Origin: 'http://evil.example' },
        { Origin: `http://127.0.0.1:${port + 1}` },
        { Origin: 'null' },
        { 'Sec-Fetch-Site': 'cross-site' },
        { 'Sec-Fetch-Site': 'same-site' },
        { 'Sec-Fetch-Site': 'none' },
        { Origin: origin(), 'Sec-Fetch-Site': 'cross-site' },
        { Origin: 'http://evil.example', 'Sec-Fetch-Site': 'same-origin' },
        { Host: 'evil.example', Origin: 'http://evil.example' }, // a rebound name
      ];
      for (const headers of tries) {
        const r = await send('/proposals/0014-other/review?source=checkout', approve, headers);
        expect(r.status, JSON.stringify(headers)).toBe(403);
        expect(r.json.error).toBeTruthy();
      }
      expect(fs.existsSync(reviewAt('', '0014-other'))).toBe(false);
    });

    it('takes Sec-Fetch-Site: same-origin on its own', async () => {
      expect((await send('/proposals/0014-other/review?source=checkout', approve, { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
    });

    it('checks the origin before it looks at the slug or the body, so another site learns nothing', async () => {
      const r = await send('/proposals/nope/review', 'not json at all', { Origin: 'http://evil.example' });
      expect(r.status).toBe(403);
    });
  });

  describe('size', () => {
    it('allows a body up to 256 KB', async () => {
      expect(REVIEW_LIMIT).toBe(256 * 1024);
      const note = 'x'.repeat(20000);
      const big = { verdict: 'approved', note, edits: Array.from({ length: 300 }, (_, i) => ({ op: 'add-node', id: `n${i}`, label: 'y'.repeat(600) })) };
      expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThan(REVIEW_LIMIT);
      expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(150 * 1024);
      expect((await send('/proposals/0014-other/review?source=checkout', big)).status).toBe(200);
    });

    it('answers 413 for a body over it, and writes nothing', async () => {
      const over = JSON.stringify({ verdict: 'approved', note: 'n', edits: [{ op: 'add-node', label: 'x'.repeat(REVIEW_LIMIT) }] });
      expect(Buffer.byteLength(over)).toBeGreaterThan(REVIEW_LIMIT);
      const r = await send('/proposals/0014-other/review?source=checkout', over);
      expect(r.status).toBe(413);
      expect(r.json.error).toMatch(/256 KB/);
      expect(files('')).toEqual(['0013-meals.json', '0014-other.json']);
    });

    it('answers 413 for a body whose first bytes are fine and the rest is not (no Content-Length to go by)', async () => {
      const r = await new Promise                    ((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: '/proposals/0014-other/review?source=checkout', headers: { ...same(), 'Transfer-Encoding': 'chunked', 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode || 0 })); });
        req.on('error', reject);
        req.write('{"verdict":"approved","note":"');
        req.write('y'.repeat(REVIEW_LIMIT + 10));
        req.end('"}');
      });
      expect(r.status).toBe(413);
      expect(files('')).toEqual(['0013-meals.json', '0014-other.json']);
    });
  });

  describe('schema', () => {
    it('answers 400 with a message for a body that is not JSON, or not a review', async () => {
      const bad            = ['{ nope', '', '[]', 'null', '"approved"', {}, { verdict: 'maybe' }, { verdict: 'notes' }, { verdict: 'approved', edits: 'x' }, { verdict: 'approved', edits: [{ nope: 1 }] }, { verdict: 'approved', at: '2020-01-01' }, { verdict: 'approved', version: 1 }];
      for (const body of bad) {
        const r = await send('/proposals/0014-other/review?source=checkout', body       );
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(typeof r.json.error, JSON.stringify(body)).toBe('string');
        expect(r.json.error.length).toBeGreaterThan(5);
      }
      expect(files('')).toEqual(['0013-meals.json', '0014-other.json']);
    });
  });

  describe('only a proposal the hub listed, and only beside it', () => {
    it('answers 404 for a slug or a source that was not listed', async () => {
      const targets = [
        '/proposals/nope/review',
        '/proposals/0013-meals/review?source=nowhere',
        '/proposals/0017-worktree-only/review?source=checkout',
        '/proposals/0013-meals.review/review',
        '/proposals/0013-meals.json/review',
        '/proposals/.json/review',
      ];
      for (const target of targets) {
        const r = await send(target, approve);
        expect(r.status, target).toBe(404);
      }
      expect(files('')).toEqual(['0013-meals.json', '0014-other.json']);
    });

    it('cannot be walked out of the proposals folders, however the path or the source is spelled', async () => {
      const targets = [
        '/proposals/../secret/review',
        '/proposals/..%2fsecret/review',
        '/proposals/%2e%2e/secret/review',
        '/proposals/%2e%2e%2fsecret/review',
        '/proposals/..%5csecret/review',
        '/proposals/0014-other/../../secret/review',
        '/proposals/%2e%2e%2f%2e%2e%2fsecret/review',
        `/proposals/${encodeURIComponent(path.join(root, 'secret'))}/review`,
        `/proposals/${encodeURIComponent(path.join(root, 'docs/specs/proposals/0014-other'))}/review`,
        '/proposals/0014-other/review?source=..',
        '/proposals/0014-other/review?source=../../..',
        '/proposals/0014-other/review?source=.claude/worktrees/topo-09',
        '/proposals/0014-other/review?source=topo-09/../checkout',
        `/proposals/0014-other/review?source=${encodeURIComponent(root)}`,
        '/proposals/0014-other/review?source=..&source=checkout',
        '/proposals/0014-other/review/../../../secret',
        '/proposals/0014-other/review/extra',
        '/proposals/0014-other/reviewx',
        '/proposals//review',
      ];
      for (const target of targets) {
        const r = await send(target, approve);
        expect(r.status, target).not.toBe(200);
      }
      // nothing was written anywhere in the checkout but beside a listed proposal
      const all           = [];
      const walk = (dir        ) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else all.push(path.relative(root, p).split(path.sep).join('/')); } };
      walk(root);
      expect(all.filter((f) => f.includes('review'))).toEqual([]);
      expect(fs.readFileSync(path.join(root, 'secret.json'), 'utf8')).toBe('{"secret":true}');
    });

    it('does not write through a link, or over a folder, where the review would go', async () => {
      fs.mkdirSync(reviewAt('', '0014-other'), { recursive: true }); // a folder with the review's name
      expect((await send('/proposals/0014-other/review?source=checkout', approve)).status).toBe(409);
      expect(fs.statSync(reviewAt('', '0014-other')).isDirectory()).toBe(true);
      fs.rmdirSync(reviewAt('', '0014-other'));
      try {
        fs.symlinkSync(path.join(root, 'secret.json'), reviewAt('', '0014-other'));
      } catch { return; /* no permission to make a link here */ }
      expect((await send('/proposals/0014-other/review?source=checkout', approve)).status).toBe(409);
      expect(fs.readFileSync(path.join(root, 'secret.json'), 'utf8')).toBe('{"secret":true}');
    });

    it('never lists a review as a proposal, however many there are', async () => {
      await send('/proposals/0014-other/review?source=checkout', approve);
      await send('/proposals/0013-meals/review?source=topo-09', approve);
      const list = JSON.parse((await raw('GET', '/proposals')).body);
      expect(list.map((e     ) => `${e.slug}@${e.source}`)).toEqual(['0013-meals@topo-09', '0013-meals@checkout', '0014-other@checkout', '0017-worktree-only@topo-09']);
      expect((await raw('GET', '/proposals/0014-other.review.json')).status).toBe(404);
    });
  });

  describe('the listing and GET', () => {
    it('lists review as null until there is one, then its verdict and time', async () => {
      const entry = async (slug        , source        ) => JSON.parse((await raw('GET', '/proposals')).body).find((e     ) => e.slug === slug && e.source === source);
      expect((await entry('0014-other', 'checkout')).review).toBeNull();
      const r = await send('/proposals/0014-other/review?source=checkout', { verdict: 'notes', note: 'Smaller.' });
      expect(await entry('0014-other', 'checkout')).toMatchObject({ review: { verdict: 'notes', at: r.json.at } });
      expect(Object.keys((await entry('0014-other', 'checkout')).review)).toEqual(['verdict', 'at']); // the note and the edits are not in the list
      expect((await entry('0013-meals', 'checkout')).review).toBeNull(); // another proposal, another place
      expect((await entry('0013-meals', 'topo-09')).review).toBeNull();
    });

    it('lists null for a review file that is not one (garbled, another version, no verdict)', async () => {
      const entry = async () => JSON.parse((await raw('GET', '/proposals')).body).find((e     ) => e.slug === '0014-other');
      fs.mkdirSync(reviewsOf(''), { recursive: true });
      for (const text of ['{ nope', '[]', 'null', '{"verdict":"approved"}', '{"version":2,"verdict":"approved","at":"2026-10-06T10:00:00.000Z","note":"","edits":[]}', '{"version":1,"verdict":"maybe","at":"2026-10-06T10:00:00.000Z"}']) {
        fs.writeFileSync(reviewAt('', '0014-other'), text);
        expect((await entry()).review, text).toBeNull();
      }
    });

    it('serves the review as it was written, or 404 when there is none', async () => {
      expect((await raw('GET', '/proposals/0014-other/review?source=checkout')).status).toBe(404);
      await send('/proposals/0014-other/review?source=checkout', approve);
      const r = await raw('GET', '/proposals/0014-other/review?source=checkout');
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/application\/json/);
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
      expect(r.json).toMatchObject({ version: 1, verdict: 'approved', note: 'Looks right.', edits });
      expect((await raw('GET', '/proposals/nope/review')).status).toBe(404);
      expect((await raw('GET', '/proposals/0014-other/review?source=nowhere')).status).toBe(404);
      expect((await raw('GET', '/proposals/..%2fsecret/review')).status).toBe(404);
    });

    it('answers HEAD like GET without the body', async () => {
      await send('/proposals/0014-other/review?source=checkout', approve);
      const r = await raw('HEAD', '/proposals/0014-other/review?source=checkout');
      expect(r.status).toBe(200);
      expect(r.body).toBe('');
    });
  });
});
