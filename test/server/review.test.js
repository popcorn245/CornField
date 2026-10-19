/**
 * @vitest-environment node
 *
 * The schema of a review (server/reviews.js `validateReview`, what the viewer sends), the same-origin rule of the
 * PUT, and what the review routes say for a proposal that is not on a spec PR (the checkout, a worktree): it has no PR
 * to hold a review, so the PUT answers 409 and nothing is written. Reviews of spec PRs are test/server/reviews.test.js.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { serveProposals, validateReview, sameOrigin, MAX_REVIEW_EDITS } from '../../server/proposals.js';
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
//  A draft that is not on a PR
// ---------------------------------------------------------------------------

describe('the review of a proposal in the checkout or a worktree', () => {
  let root        ;
  let server             ;
  let port        ;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-review-'));
    fs.writeFileSync(path.join(root, 'topology.json'), JSON.stringify(topology));
    const put = (where        , name        , text        ) => {
      const dir = path.join(root, where, 'docs/specs/proposals');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    };
    put('', '0013-meals.json', JSON.stringify(proposal));
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

  const call = (method        , target        , body         ) => fetch(`http://127.0.0.1:${port}${target}`, { method, headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }, body });
  const ok = JSON.stringify({ verdict: 'approved', note: '', edits });

  it('cannot be reviewed: a review is a comment on a PR, so the PUT says to push a spec PR, and nothing is written anywhere', async () => {
    for (const target of ['/proposals/0013-meals/review', '/proposals/0013-meals/review?source=checkout', '/proposals/0017-worktree-only/review?source=topo-09']) {
      const res = await call('PUT', target, ok);
      expect(res.status, target).toBe(409);
      expect((await res.json()).error).toMatch(/comment on a spec PR.*Push this draft/);
    }
    expect(fs.existsSync(path.join(root, '.cornfield-data'))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'docs/specs/proposals'))).toEqual(['0013-meals.json']);
  });

  it('refuses a PR\'s source without sign-in the same way: there is no forge to ask', async () => {
    expect((await call('PUT', '/proposals/0013-meals/review?source=pull%2F23', ok)).status).toBe(409);
    expect((await call('GET', '/proposals/0013-meals/review?source=pull%2F23')).status).toBe(404);
  });

  it('has no review to read: 404, "No review yet" for a listed proposal and "No such proposal" for any other', async () => {
    const yet = await call('GET', '/proposals/0013-meals/review');
    expect([yet.status, (await yet.json()).error]).toEqual([404, 'No review yet']);
    const none = await call('GET', '/proposals/nope/review');
    expect([none.status, (await none.json()).error]).toEqual([404, 'No such proposal']);
  });

  it('reads no review from the data folder any more, and lists none', async () => {
    const dir = path.join(root, '.cornfield-data', 'reviews', 'checkout');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '0013-meals.review.json'), JSON.stringify({ version: 1, verdict: 'approved', note: '', edits: [], at: '2026-10-01T00:00:00.000Z' }));
    expect((await call('GET', '/proposals/0013-meals/review')).status).toBe(404);
    const list = await (await call('GET', '/proposals')).json();
    expect(list.every((e        ) => e.review === null)).toBe(true);
  });

  it('answers 405 for any other method, with what is allowed', async () => {
    const res = await call('DELETE', '/proposals/0013-meals/review');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD, PUT');
  });
});
