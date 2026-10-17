/**
 * @vitest-environment node
 *
 * The hub's proposal routes (TOPO-09, spec 0012 B2): what GET /proposals lists from the
 * checkout and its worktrees, what GET /proposals/<slug>.json serves, and that nothing a request
 * says can name a file the hub did not list. Runs the handler in-process over a temporary checkout.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
// @ts-expect-error plain JS module, no declarations
import { serveProposals } from '../../server/proposals.js';
import { whereOf } from './where.js';

const topology = {
  nodes: [
    { id: 'root', label: 'root', type: 'root' },
    { id: 'app-a', label: 'a', type: 'app' },
    { id: 'table-t', label: 't', type: 'table' },
  ],
  edges: [{ from: 'root', to: 'app-a' }],
};
const good = { version: 1, spec: '0013', title: 'Meals', summary: 'Adds /meals.', nodes: { add: [{ id: 'page-meals', label: '/meals', type: 'page', parent: 'app-a' }], change: [{ id: 'app-a', set: { desc: 'x' }, why: 'w' }] } };
const broken = { version: 1, title: 'Broken', summary: 's', nodes: { add: [{ id: 'root', label: 'again', type: 'page' }, { id: 'p2', label: 'p2', type: 'nonsense' }] } };

describe('hub proposal routes', () => {
  let root        ;
  let server             ;
  let port        ;

  const put = (where        , name        , text        ) => {
    const dir = path.join(root, where, 'docs/specs/proposals');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-proposals-'));
    fs.writeFileSync(path.join(root, 'topology.json'), JSON.stringify(topology));
    fs.writeFileSync(path.join(root, 'secret.json'), '{"secret":true}');
    put('', '0013-meals.json', JSON.stringify(good));
    put('', '0013-meals.review.json', JSON.stringify({ verdict: 'approved' }));
    put('', '0014-broken.json', JSON.stringify(broken));
    put('', '0015-garbled.json', '{ not json');
    put('', '0016-array.json', '[]');
    put('.claude/worktrees/topo-09', '0013-meals.json', JSON.stringify({ ...good, title: 'Meals, newer' }));
    put('.claude/worktrees/topo-09', '0017-worktree-only.json', JSON.stringify({ version: 1, title: 'Only here', summary: 's' }));

    server = http.createServer((req, res) => {
      const url = new URL(req.url , 'http://localhost');
      const reqPath = decodeURIComponent(url.pathname);
      if (!serveProposals(req, res, reqPath, url, whereOf(root))) { res.writeHead(418); res.end('not a proposal route'); }
    });
    await new Promise      ((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address()                   ).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A request with the path exactly as given (fetch would tidy a `..` away) */
  function raw(method        , target        )                                                                               {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: target }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }
  const json = async (target        ) => { const r = await raw('GET', target); return { ...r, json: r.body ? JSON.parse(r.body) : null }; };

  it('lists every proposal as slug, title, summary, spec, source, counts and error count, worktree copy first', async () => {
    const { status, headers, json: list } = await json('/proposals');
    expect(status).toBe(200);
    expect(headers['content-type']).toMatch(/application\/json/);
    expect(headers['access-control-allow-origin']).toBeUndefined();
    expect(list.map((e     ) => `${e.slug}@${e.source}`)).toEqual([
      '0013-meals@topo-09', '0013-meals@checkout', '0014-broken@checkout', '0015-garbled@checkout', '0016-array@checkout', '0017-worktree-only@topo-09',
    ]);
    expect(list[0]).toEqual({ slug: '0013-meals', title: 'Meals, newer', summary: 'Adds /meals.', spec: '0013', source: 'topo-09', counts: { added: 1, changed: 1, removed: 0, scenarios: 0 }, errors: 0, review: null });
    expect(list[1].title).toBe('Meals');
  });

  it('counts the problems a proposal has against the checkout\'s map', async () => {
    const { json: list } = await json('/proposals');
    const entry = list.find((e     ) => e.slug === '0014-broken');
    expect(entry.errors).toBeGreaterThanOrEqual(2); // an added id that exists, an unknown type
    expect(entry.counts.added).toBe(2);
  });

  it('lists a file that does not parse with an error, and carries on', async () => {
    const { json: list } = await json('/proposals');
    const entry = list.find((e     ) => e.slug === '0015-garbled');
    expect(entry.error).toMatch(/Not valid JSON/);
    expect(entry).toMatchObject({ title: '0015-garbled', counts: null, errors: null, source: 'checkout' });
    expect(list.length).toBe(6);
  });

  it('lists a file that parses to something that is not a proposal, without crashing', async () => {
    const { json: list } = await json('/proposals');
    const entry = list.find((e     ) => e.slug === '0016-array');
    expect(entry.title).toBe('0016-array');
    expect(entry.errors).toBeGreaterThan(0);
  });

  it('never lists a review', async () => {
    const { json: list } = await json('/proposals');
    expect(list.some((e     ) => e.slug.includes('review'))).toBe(false);
  });

  it('serves one proposal as the file holds it', async () => {
    const r = await json('/proposals/0013-meals.json?source=checkout');
    expect(r.status).toBe(200);
    expect(r.json).toEqual(good);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves the worktree copy when no source is given, or the one asked for', async () => {
    expect((await json('/proposals/0013-meals.json')).json.title).toBe('Meals, newer');
    expect((await json('/proposals/0013-meals.json?source=topo-09')).json.title).toBe('Meals, newer');
    expect((await json('/proposals/0013-meals.json?source=')).json.title).toBe('Meals, newer');
    expect((await json('/proposals/0017-worktree-only.json?source=topo-09')).status).toBe(200);
  });

  it('answers 404 for a slug or a source that was not listed', async () => {
    for (const target of ['/proposals/nope.json', '/proposals/0013-meals.json?source=nowhere', '/proposals/0017-worktree-only.json?source=checkout', '/proposals/0013-meals.review.json', '/proposals/0013-meals', '/proposals/', '/proposals/.json']) {
      expect((await raw('GET', target)).status, target).toBe(404);
    }
  });

  it('answers 422 for a listed file that does not parse', async () => {
    const r = await json('/proposals/0015-garbled.json');
    expect(r.status).toBe(422);
    expect(r.json.error).toMatch(/Not valid JSON/);
  });

  it('cannot be walked out of the proposals folders, however the path or the source is spelled', async () => {
    const targets = [
      '/proposals/../secret.json',
      '/proposals/..%2fsecret.json',
      '/proposals/%2e%2e/secret.json',
      '/proposals/%2e%2e%2fsecret.json',
      '/proposals/..%5csecret.json',
      '/proposals/secret.json',
      '/proposals/0013-meals.json/../../secret.json',
      '/proposals//secret.json',
      '/proposals/%2fsecret.json',
      `/proposals/${encodeURIComponent(path.join(root, 'secret'))}.json`,
      `/proposals/${encodeURIComponent(path.join(root, 'secret.json'))}`,
      '/proposals/0013-meals.json?source=..',
      '/proposals/0013-meals.json?source=../../..',
      '/proposals/0013-meals.json?source=.claude/worktrees/topo-09',
      '/proposals/0013-meals.json?source=topo-09/../checkout',
      `/proposals/0013-meals.json?source=${encodeURIComponent(root)}`,
      '/proposals/secret.json?source=checkout',
      '/proposals/0013-meals.json?source=..&source=checkout',
    ];
    for (const target of targets) {
      const r = await raw('GET', target);
      expect(r.status, target).not.toBe(200);
      expect(r.body, target).not.toContain('secret');
    }
  });

  it('is read-only', async () => {
    for (const method of ['PUT', 'POST', 'DELETE', 'PATCH']) {
      const r = await raw(method, '/proposals/0013-meals.json');
      expect(r.status, method).toBe(405);
      expect(r.headers.allow).toBe('GET, HEAD');
    }
    expect((await raw('POST', '/proposals')).status).toBe(405);
    expect(fs.readFileSync(path.join(root, 'docs/specs/proposals/0013-meals.json'), 'utf8')).toBe(JSON.stringify(good));
  });

  it('leaves every other path to the rest of the hub', async () => {
    expect((await raw('GET', '/topology.json')).status).toBe(418);
    expect((await raw('GET', '/proposalsfoo')).status).toBe(418);
  });

  it('lists nothing, with no error, for a checkout that has none', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-proposals-empty-'));
    try {
      const other = http.createServer((req, res) => {
        const url = new URL(req.url , 'http://localhost');
        serveProposals(req, res, url.pathname, url, whereOf(empty));
      });
      await new Promise      ((resolve) => other.listen(0, '127.0.0.1', resolve));
      const p = (other.address()                   ).port;
      const body = await new Promise        ((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: p, path: '/proposals' }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b)); }).on('error', reject);
      });
      expect(JSON.parse(body)).toEqual([]);
      await new Promise((resolve) => other.close(resolve));
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  });
});

describe('a proposal whose build has landed', () => {
  it('lists no problems for the ids it adds that the map now has', async () => {
    // @ts-expect-error plain JS module, no declarations
    const { listProposals } = await import('../../server/proposals.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-landed-'));
    try {
      fs.mkdirSync(path.join(dir, 'docs/specs/proposals'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'topology.json'), JSON.stringify(topology));
      const landed = { version: 1, title: 'Landed', summary: 's', nodes: { add: [{ id: 'table-t', label: 't', type: 'table' }] } };
      const typo = { version: 1, title: 'Typo', summary: 's', nodes: { add: [{ id: 'table-t', label: 't', type: 'table' }, { id: 'page-x', label: '/x', type: 'page', parent: 'nowhere' }] } };
      fs.writeFileSync(path.join(dir, 'docs/specs/proposals/0020-landed.json'), JSON.stringify(landed));
      fs.writeFileSync(path.join(dir, 'docs/specs/proposals/0021-typo.json'), JSON.stringify(typo));
      const list = listProposals(whereOf(dir));
      expect(list.find((e     ) => e.slug === '0020-landed').errors).toBe(0);
      // the dangling parent still counts: only what a landing explains is let go
      expect(list.find((e     ) => e.slug === '0021-typo').errors).toBe(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
