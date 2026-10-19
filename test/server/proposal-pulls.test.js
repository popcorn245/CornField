/**
 * @vitest-environment node
 *
 * Proposals from spec PRs (server/proposal-pulls.js, and the routes of server/proposals.js that use it): the open PRs
 * that touch the proposals folder are listed beside the checkout and the worktrees, each file read at the PR's head
 * commit; a PR that deletes a proposal lists none; the forge's pages are followed; a forge that cannot answer is
 * said plainly and does not take the local proposals with it; and without a forge nothing is asked. Every forge
 * request goes to a fake forge on loopback that answers recorded GitHub answers
 * (test/fixtures/forge/github-spec-prs.json); no token is real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { serveProposals } from '../../server/proposals.js';
// @ts-expect-error plain JS module, no declarations
import { createForge, ForgeError } from '../../server/forge.js';
// @ts-expect-error plain JS module, no declarations
import { pullNumber, pullSource } from '../../server/proposal-pulls.js';
import { fakeForge, recordings } from './fake-forge.js';
import { TOKEN } from './forge-contract.js';
import { whereOf } from './where.js';

const SHA_MEALS = '1110000000000000000000000000000000000000';
const SHA_PLANNER = '4440000000000000000000000000000000000000';
const FIRST_PAGE = 'GET /repos/owner/name/pulls?state=open&sort=created&direction=desc&per_page=100';
const topology = { nodes: [{ id: 'root', label: 'root', type: 'root' }, { id: 'app-a', label: 'a', type: 'app' }], edges: [{ from: 'root', to: 'app-a' }] };
const local = { version: 1, spec: '0002', title: 'Checkout', summary: 'In the checkout.' };

describe('proposals from spec PRs', () => {
  let root;
  let fake;
  let server;
  let port;
  /** What forgeFor does in the next request: gives the forge, or throws */
  let forgeFor;
  const routes = () => recordings('github-spec-prs');

  const put = (where, name, text) => {
    const dir = path.join(root, where, 'docs/specs/proposals');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  };
  const forgeOn = () => createForge({ type: 'github', url: 'https://github.com', repo: 'owner/name' }, { token: TOKEN, apiUrl: fake.url });
  const serveWith = async (answers) => {
    await fake?.close();
    fake = await fakeForge(answers);
    forgeFor = () => forgeOn();
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-pulls-'));
    fs.writeFileSync(path.join(root, 'topology.json'), JSON.stringify(topology));
    put('', '0002-checkout.json', JSON.stringify(local));
    put('.claude/worktrees/topo-09', '0013-meals.json', JSON.stringify({ ...local, spec: '0013', title: 'Meals, a draft in a worktree' }));
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (!serveProposals(req, res, decodeURIComponent(url.pathname), url, whereOf(root), forgeFor)) { res.writeHead(418); res.end('not a proposal route'); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  });
  afterAll(async () => {
    await fake?.close();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    fs.rmSync(root, { recursive: true, force: true });
  });
  beforeEach(async () => { await serveWith(routes()); });

  const get = (target, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body, json: body && res.headers['content-type']?.includes('json') ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    req.end();
  });
  const filesAsked = () => fake.requests.filter((r) => /\/pulls\/\d+\/files/.test(r.url)).map((r) => r.url);

  it('lists the open PRs that touch the proposals folder, with the checkout and the worktrees, and names the PR', async () => {
    const { status, json: list, headers } = await get('/proposals');
    expect(status).toBe(200);
    expect(headers['x-proposals-forge-error']).toBeUndefined();
    expect(list.map((e) => `${e.slug}@${e.source}`)).toEqual([
      '0002-checkout@checkout', '0013-meals@topo-09', '0013-meals@pull/23', '0014-planner@pull/20', '0017-moved@pull/20', '0018-missing@pull/20',
    ]);
    const meals = list.find((e) => e.source === 'pull/23');
    expect(meals).toMatchObject({ title: 'Meals', summary: 'Adds /meals.', spec: '0013', counts: { added: 1 }, errors: 0, review: null });
    expect(meals.pull).toEqual({ number: 23, title: 'Meals proposal', url: 'https://github.example.com/owner/name/pull/23', draft: false, author: 'agent-four' });
    expect(list.find((e) => e.slug === '0014-planner').pull).toMatchObject({ number: 20, draft: true });
    expect(list.find((e) => e.source === 'checkout')).not.toHaveProperty('pull');
  });

  it('lists only a plain proposal file of the folder: not a review, a nested file, one elsewhere, or a PR with none', async () => {
    const { json: list } = await get('/proposals');
    const slugs = list.map((e) => e.slug);
    for (const not of ['0014-planner.review', 'nested/0015-nested', '0015-nested', '0016-elsewhere']) expect(slugs).not.toContain(not);
    expect(list.some((e) => e.source === 'pull/22')).toBe(false);
    expect(list.find((e) => e.slug === '0017-moved').source).toBe('pull/20'); // renamed into the folder: its new name counts
  });

  it('follows the forge\'s pages: a PR on the second page is listed', async () => {
    const { json: list } = await get('/proposals');
    expect(list.some((e) => e.source === 'pull/20')).toBe(true);
    expect(fake.requests.map((r) => r.url)).toContain('/repositories/1/pulls?state=open&sort=created&direction=desc&per_page=100&page=2');
  });

  it('does not list a proposal a PR deletes, and does not serve it', async () => {
    const { json: list } = await get('/proposals');
    expect(list.some((e) => e.slug === '0002-checkout' && e.source !== 'checkout')).toBe(false);
    expect(filesAsked()).toContain('/repos/owner/name/pulls/21/files?per_page=100');
    expect((await get('/proposals/0002-checkout.json?source=pull%2F21')).status).toBe(404);
  });

  it('reads each file at the PR\'s head commit, as the signed-in user', async () => {
    await get('/proposals');
    const reads = fake.requests.filter((r) => r.url.startsWith('/repos/owner/name/contents/'));
    expect(reads.map((r) => r.url).sort()).toEqual([
      `/repos/owner/name/contents/docs/specs/proposals/0013-meals.json?ref=${SHA_MEALS}`,
      `/repos/owner/name/contents/docs/specs/proposals/0014-planner.json?ref=${SHA_PLANNER}`,
      `/repos/owner/name/contents/docs/specs/proposals/0017-moved.json?ref=${SHA_PLANNER}`,
      `/repos/owner/name/contents/docs/specs/proposals/0018-missing.json?ref=${SHA_PLANNER}`,
    ]);
    for (const r of fake.requests) expect(r.headers.authorization, r.url).toBe(`Bearer ${TOKEN}`);
  });

  it('lists a file that does not parse, or is not at the head, with its error', async () => {
    const { json: list } = await get('/proposals');
    expect(list.find((e) => e.slug === '0017-moved')).toMatchObject({ counts: null, title: '0017-moved', pull: { number: 20 } });
    expect(list.find((e) => e.slug === '0017-moved').error).toMatch(/Not valid JSON/);
    expect(list.find((e) => e.slug === '0018-missing').error).toBe('docs/specs/proposals/0018-missing.json is not at the head of pull request #20.');
  });

  it('serves one at the PR\'s head, and says which PR it came from', async () => {
    const r = await get('/proposals/0013-meals.json?source=pull%2F23');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ title: 'Meals', spec: '0013' });
    expect(decodeURIComponent(r.headers['x-proposal-source'])).toBe('pull/23');
    expect(fake.requests.map((x) => x.url)).toContain(`/repos/owner/name/contents/docs/specs/proposals/0013-meals.json?ref=${SHA_MEALS}`);
    // The worktree copy of the same slug is still what no source gets
    expect(JSON.parse((await get('/proposals/0013-meals.json')).body).title).toBe('Meals, a draft in a worktree');
    expect(JSON.parse((await get('/proposals/0013-meals.json?source=topo-09')).body).title).toBe('Meals, a draft in a worktree');
  });

  it('finds a proposal only a PR has when no source is asked for', async () => {
    const r = await get('/proposals/0014-planner.json');
    expect(r.status).toBe(200);
    expect(decodeURIComponent(r.headers['x-proposal-source'])).toBe('pull/20');
  });

  it('answers 404 for what the forge does not list: a PR without it, a closed PR, an unknown PR, a source that is not a PR', async () => {
    for (const target of [
      '/proposals/0013-meals.json?source=pull%2F20', // PR 20 does not hold it
      '/proposals/0014-planner.json?source=pull%2F23',
      '/proposals/0013-meals.json?source=pull%2F19', // merged
      '/proposals/0013-meals.json?source=pull%2F999', // no such PR
      '/proposals/0013-meals.json?source=pull%2F0',
      '/proposals/0013-meals.json?source=pull%2F23%2F..%2F20',
      '/proposals/0013-meals.json?source=pull%2Fx',
      '/proposals/0013-meals.json?source=nowhere',
      '/proposals/..%2Fsecret.json?source=pull%2F23',
    ]) {
      expect((await get(target)).status, target).toBe(404);
    }
    expect((await get('/proposals/0018-missing.json?source=pull%2F20')).status).toBe(404); // listed, but nothing at the head
  });

  it('answers 422 for a PR\'s file that does not parse', async () => {
    const r = await get('/proposals/0017-moved.json?source=pull%2F20');
    expect(r.status).toBe(422);
    expect(r.json.error).toMatch(/Not valid JSON/);
  });

  it('is read-only for a PR\'s proposal too, and a review of one is not taken yet', async () => {
    expect((await get('/proposals/0013-meals.json?source=pull%2F23', 'POST')).status).toBe(405);
    const put409 = await get('/proposals/0013-meals/review?source=pull%2F23', 'PUT');
    expect(put409.status).toBe(409);
    expect(put409.json.error).toMatch(/not posted from cornfield yet/);
    expect((await get('/proposals/0013-meals/review?source=pull%2F23')).status).toBe(404);
    expect(fs.existsSync(path.join(root, '.cornfield-data'))).toBe(false);
  });

  describe('when the forge cannot answer', () => {
    it('says so plainly and still lists the checkout and the worktrees', async () => {
      await serveWith({ [FIRST_PAGE]: { status: 503, body: { message: 'Service Unavailable' } } });
      const r = await get('/proposals');
      expect(r.status).toBe(200);
      expect(r.json.map((e) => `${e.slug}@${e.source}`)).toEqual(['0002-checkout@checkout', '0013-meals@topo-09']);
      expect(decodeURIComponent(r.headers['x-proposals-forge-error'])).toBe('GitHub could not answer for the pull requests of owner/name (HTTP 503); try again in a minute.');
    });

    it('says a token GitHub no longer accepts', async () => {
      await serveWith({ [FIRST_PAGE]: { status: 401, body: { message: 'Bad credentials' } } });
      const r = await get('/proposals');
      expect(decodeURIComponent(r.headers['x-proposals-forge-error'])).toBe('GitHub did not accept the sign-in; sign in again.');
      expect(r.json).toHaveLength(2);
    });

    it('lists the PRs it could read when one PR\'s files cannot be asked', async () => {
      const answers = routes();
      answers['GET /repos/owner/name/pulls/23/files?per_page=100'] = { status: 403, body: { message: 'Forbidden' } };
      await serveWith(answers);
      const r = await get('/proposals');
      expect(r.json.some((e) => e.source === 'pull/20')).toBe(true);
      expect(r.json.some((e) => e.source === 'pull/23')).toBe(false);
      expect(decodeURIComponent(r.headers['x-proposals-forge-error'])).toMatch(/does not let this sign-in/);
    });

    it('says it when the forge cannot be made for this session', async () => {
      forgeFor = () => { throw new ForgeError('GitHub sign-in has to be renewed; sign in again.', { code: 'unauthorized' }); };
      const r = await get('/proposals');
      expect(r.json).toHaveLength(2);
      expect(decodeURIComponent(r.headers['x-proposals-forge-error'])).toBe('GitHub sign-in has to be renewed; sign in again.');
      forgeFor = () => forgeOn();
    });

    it('answers a proposal read with the forge\'s words', async () => {
      const answers = routes();
      answers[`GET /repos/owner/name/contents/docs/specs/proposals/0013-meals.json?ref=${SHA_MEALS}`] = { status: 503, body: { message: 'Service Unavailable' } };
      await serveWith(answers);
      const r = await get('/proposals/0013-meals.json?source=pull%2F23');
      expect(r.status).toBe(502);
      expect(r.json.error).toMatch(/GitHub could not answer for docs\/specs\/proposals\/0013-meals.json at 1110000000000000000000000000000000000000 \(HTTP 503\)/);
    });

    it('lists the file the forge refused as an entry with its error', async () => {
      const answers = routes();
      answers[`GET /repos/owner/name/contents/docs/specs/proposals/0013-meals.json?ref=${SHA_MEALS}`] = { status: 403, body: { message: 'Forbidden' } };
      await serveWith(answers);
      const entry = (await get('/proposals')).json.find((e) => e.source === 'pull/23');
      expect(entry.error).toMatch(/does not let this sign-in/);
      expect(entry.counts).toBeNull();
    });
  });

  describe('with no forge', () => {
    beforeEach(() => { forgeFor = null; });

    it('lists the checkout and the worktrees exactly as before, and asks no forge', async () => {
      const r = await get('/proposals');
      expect(r.status).toBe(200);
      expect(r.headers['x-proposals-forge-error']).toBeUndefined();
      expect(r.json.map((e) => `${e.slug}@${e.source}`)).toEqual(['0002-checkout@checkout', '0013-meals@topo-09']);
      for (const e of r.json) expect(e).not.toHaveProperty('pull');
      expect(fake.requests).toHaveLength(0);
    });

    it('does not know a PR\'s source', async () => {
      expect((await get('/proposals/0013-meals.json?source=pull%2F23')).status).toBe(404);
      expect((await get('/proposals/0014-planner.json')).status).toBe(404);
      expect((await get('/proposals/0013-meals/review?source=pull%2F23')).status).toBe(404);
      expect((await get('/proposals/0013-meals/review?source=pull%2F23')).json.error).toBe('No such proposal');
      expect(fake.requests).toHaveLength(0);
    });
  });

  it('names a PR\'s source and reads one back', () => {
    expect(pullSource(23)).toBe('pull/23');
    expect(pullNumber('pull/23')).toBe(23);
    for (const bad of ['pull/0', 'pull/-1', 'pull/1.5', 'pull/', 'pull/1/2', ' pull/1', 'checkout', '', null, undefined, 'pull/1234567890']) expect(pullNumber(bad), String(bad)).toBeNull();
  });
});

describe('what a menu open costs', () => {
  it('asks the forge for the open PRs only, once their heads were read; a PR pushed to is read again at its new head', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-pulls-cache-'));
    fs.writeFileSync(path.join(root, 'topology.json'), JSON.stringify(topology));
    const answers = recordings('github-spec-prs');
    const fake = await fakeForge(answers);
    const where = whereOf(root); // one server, one where: the cache is its own
    const forgeFor = () => createForge({ type: 'github', url: 'https://github.com', repo: 'owner/name' }, { token: TOKEN, apiUrl: fake.url });
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      serveProposals(req, res, decodeURIComponent(url.pathname), url, where, forgeFor);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const list = async () => (await fetch(`http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/proposals`)).json();
    const askedFor = () => fake.requests.map((r) => r.url).filter((u) => !/\/pulls\?|\/repositories\/1\/pulls\?/.test(u));
    try {
      const first = await list();
      expect(askedFor().length).toBeGreaterThan(0);
      fake.requests.length = 0;
      expect(await list()).toEqual(first);
      expect(askedFor()).toEqual([]);
      // #23 gets a new head: only its files and its file are asked again
      const page = answers[FIRST_PAGE].body;
      const meals = page.find((p) => p.number === 23);
      const moved = '9990000000000000000000000000000000000000';
      meals.head.sha = moved;
      answers[`GET /repos/owner/name/contents/docs/specs/proposals/0013-meals.json?ref=${moved}`] = answers[`GET /repos/owner/name/contents/docs/specs/proposals/0013-meals.json?ref=${SHA_MEALS}`];
      fake.requests.length = 0;
      await list();
      expect(askedFor().sort()).toEqual(['/repos/owner/name/contents/docs/specs/proposals/0013-meals.json?ref=' + moved, '/repos/owner/name/pulls/23/files?per_page=100']);
    } finally {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      await fake.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
