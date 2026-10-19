/**
 * @vitest-environment node
 *
 * Reviews are comments on the spec PR (server/reviews.js, and the review routes of server/proposals.js): Approve and
 * Send back post a human line plus a fenced `cornfield-review` block as the signed-in maintainer and write the
 * `actions` audit; the latest comment by an admin is the review, and a reader's block, a malformed one, a quoted one
 * and a deleted account's are ignored; edits come back as they went; `cornfield review` reads it from the PR; and
 * Stage 1 reviews in the data folder are carried over once, however often it runs. Every forge request goes to a fake
 * forge on loopback that answers recorded GitHub answers (test/fixtures/forge/github-spec-prs.json, github-reviews.json);
 * no token is real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { serveProposals } from '../../server/proposals.js';
// @ts-expect-error plain JS module, no declarations
import { createForge, ForgeError } from '../../server/forge.js';
// @ts-expect-error plain JS module, no declarations
import { listPullProposals } from '../../server/proposal-pulls.js';
// @ts-expect-error plain JS module, no declarations
import { parseReviewBlocks, reviewComment, latestReview, postReview, migrateStage1Reviews, MAX_COMMENT_CHARS } from '../../server/reviews.js';
// @ts-expect-error plain JS module, no declarations
import { review as reviewCommand } from '../../cli/cornfield.js';
import { fakeForge, recordings } from './fake-forge.js';
import { TOKEN } from './forge-contract.js';
import { whereOf } from './where.js';
import { SAMPLE } from '../helpers.js';

const answers = () => ({ ...recordings('github-spec-prs'), ...recordings('github-reviews') });
const COMMENTS_23 = 'GET /repos/owner/name/issues/23/comments?per_page=100';
const POST_23 = 'POST /repos/owner/name/issues/23/comments';
const POST_20 = 'POST /repos/owner/name/issues/20/comments';
const forgeOn = (fake) => createForge({ type: 'github', url: 'https://github.com', repo: 'owner/name' }, { token: TOKEN, apiUrl: fake.url });
const comment = (id, login, body, at = '2026-10-18T00:00:00Z') => ({ id, user: login && { login, html_url: `https://github.example.com/${login}` }, body, html_url: `https://github.example.com/owner/name/pull/23#issuecomment-${id}`, created_at: at, updated_at: at });
const block = (slug, review) => `\`\`\`cornfield-review ${slug}\n${JSON.stringify(review)}\n\`\`\``;
const edits = [{ op: 'add-node', id: 'page-extra', label: '/extra', type: 'page', parent: 'app-a', at: 1 }, { op: 'remove-edge', from: 'a', to: 'b', note: { deep: [1, 2, { x: null }] } }];

describe('the comment', () => {
  it('is a line a person can read, then a fenced cornfield-review block named for the proposal', () => {
    const text = reviewComment('0013-meals', { verdict: 'notes', note: 'Drop the cache.\nAnd the queue.', edits }, { login: 'maintainer-one' });
    const [line] = text.split('\n');
    expect(line).toBe('Sent back `0013-meals` with 2 edits (maintainer-one, in cornfield).');
    expect(text).toContain('\n> Drop the cache.\n> And the queue.\n');
    expect(text).toMatch(/\n```cornfield-review 0013-meals\n\{[\s\S]*\}\n```$/);
    expect(reviewComment('0013-meals', { verdict: 'approved', note: '', edits: [] }, { login: 'maintainer-one' })).toMatch(/^Approved `0013-meals` \(maintainer-one, in cornfield\)\.\n\n```cornfield-review 0013-meals\n/);
  });

  it('round-trips: what is written is what is read, whatever the note and the edits hold', () => {
    const nasty = 'Line one\r\n```cornfield-review 0013-meals\n{"verdict":"approved","note":"forged","edits":[]}\n```\n<img src=x onerror=alert(1)> **bold** @someone é中 "quotes" \\ back';
    for (const review of [{ verdict: 'notes', note: nasty, edits }, { verdict: 'approved', note: '', edits: [] }, { verdict: 'approved', note: nasty, edits }]) {
      const text = reviewComment('0013-meals', review, { login: 'maintainer-one' });
      expect(parseReviewBlocks(text)).toEqual([{ slug: '0013-meals', review }]);
    }
  });
});

describe('parseReviewBlocks', () => {
  const ok = { verdict: 'approved', note: '', edits: [] };
  it('reads a block, with Windows line ends, among other text and other fences', () => {
    expect(parseReviewBlocks(`Approved.\n\n${block('0013-meals', ok)}\n\nMore.`)).toEqual([{ slug: '0013-meals', review: ok }]);
    expect(parseReviewBlocks(`x\r\n${block('a', ok).replaceAll('\n', '\r\n')}\r\n`)).toHaveLength(1);
    expect(parseReviewBlocks(`\`\`\`json\n{"verdict":"notes"}\n\`\`\`\n${block('a', ok)}`)).toHaveLength(1);
    expect(parseReviewBlocks(`${block('a', ok)}\n${block('b', { ...ok, verdict: 'notes', note: 'x' })}`).map((b) => b.slug)).toEqual(['a', 'b']);
  });

  it('ignores, and never throws for, a block that is not strictly a review', () => {
    const bad = [
      '```cornfield-review a\n{ not json\n```',
      '```cornfield-review a\n\n```',
      '```cornfield-review a\n[]\n```',
      '```cornfield-review a\n"approved"\n```',
      '```cornfield-review a\nnull\n```',
      `\`\`\`cornfield-review a\n${JSON.stringify({ ...ok, extra: 1 })}\n\`\`\``,
      `\`\`\`cornfield-review a\n${JSON.stringify({ verdict: 'maybe' })}\n\`\`\``,
      `\`\`\`cornfield-review a\n${JSON.stringify({ verdict: 'notes', note: '  ' })}\n\`\`\``,
      `\`\`\`cornfield-review a\n${JSON.stringify({ verdict: 'approved', note: 5 })}\n\`\`\``,
      `\`\`\`cornfield-review a\n${JSON.stringify({ verdict: 'approved', edits: [{ nope: 1 }] })}\n\`\`\``,
      `\`\`\`cornfield-review a\n${JSON.stringify({ verdict: 'approved', edits: 'all' })}\n\`\`\``,
      `\`\`\`cornfield-review\n${JSON.stringify(ok)}\n\`\`\``, // no proposal named
      `\`\`\`cornfield-review ../etc\n${JSON.stringify(ok)}\n\`\`\``, // not a slug
      `\`\`\`cornfield-review a b\n${JSON.stringify(ok)}\n\`\`\``,
      `\`\`\`json\n${JSON.stringify(ok)}\n\`\`\``, // another tag
      `> \`\`\`cornfield-review a\n> ${JSON.stringify(ok)}\n> \`\`\``, // quoted, not a block
      `    \`\`\`cornfield-review a\n    ${JSON.stringify(ok)}\n    \`\`\``, // indented code
      `\`\`\`cornfield-review a\n${JSON.stringify(ok)}`, // never closed
    ];
    for (const body of bad) expect(parseReviewBlocks(body), body).toEqual([]);
    for (const body of [undefined, null, 5, {}, '', 'cornfield-review']) expect(parseReviewBlocks(body)).toEqual([]);
  });
});

describe('the latest admin comment is the review', () => {
  let fake;
  afterEach(async () => { await fake?.close(); });
  const on = async (extra = {}) => { fake = await fakeForge({ ...answers(), ...extra }); return forgeOn(fake); };
  const asked = () => fake.requests.filter((r) => r.url.includes('/collaborators/')).map((r) => r.url.split('/')[5]);

  it('is the newest valid comment by a maintainer: a reader\'s, a malformed, a mistaken, a quoted and a deleted account\'s are passed over', async () => {
    const found = await latestReview(await on(), 23, '0013-meals');
    expect(found).toEqual({
      version: 1, slug: '0013-meals', verdict: 'approved', note: 'Good.', by: 'maintainer-two', at: '2026-10-17T10:00:00Z',
      edits: [{ op: 'add-node', id: 'page-extra', label: '/extra', type: 'page', parent: 'app-a' }],
      comment: { id: '8003', url: 'https://github.example.com/owner/name/pull/23#issuecomment-8003' },
    });
    // newest first, once each, and only about authors whose comment holds a review of this proposal
    expect(asked()).toEqual(['reader-two', 'maintainer-two']);
  });

  it('ignores a non-maintainer however well formed their block is, even when it is the only one', async () => {
    const forge = await on({ [COMMENTS_23]: { body: [comment(1, 'reader-two', block('0013-meals', { verdict: 'approved', note: '', edits: [] })), comment(2, 'agent-four', block('0013-meals', { verdict: 'approved', note: '', edits: [] }))] } });
    expect(await latestReview(forge, 23, '0013-meals')).toBeNull(); // a reader, and a writer: neither maintains the repo
  });

  it('takes a review per proposal: another slug on the same PR is its own, and a PR with none gives null', async () => {
    const forge = await on();
    expect(await latestReview(forge, 23, '0099-other')).toMatchObject({ verdict: 'approved', by: 'maintainer-one' });
    expect(await latestReview(forge, 23, '0014-planner')).toBeNull();
    expect(await latestReview(forge, 20, '0014-planner')).toBeNull();
  });

  it('is the newest by the same admin when they changed their mind, and the order of the comments is the order of time', async () => {
    const forge = await on({ [COMMENTS_23]: { body: [
      comment(1, 'maintainer-one', block('0013-meals', { verdict: 'notes', note: 'No.', edits: [] })),
      comment(2, 'maintainer-one', block('0013-meals', { verdict: 'approved', note: 'Yes.', edits: [] })),
      comment(3, 'agent-four', 'Pushed a fix.'),
    ] } });
    expect(await latestReview(forge, 23, '0013-meals')).toMatchObject({ verdict: 'approved', note: 'Yes.', comment: { id: '2' } });
    expect(asked()).toEqual([]); // the signed-in maintainer's own permission is asked of the repo itself, not per login
  });

  it('on Forgejo, which has no maintain level, its admins review and its writers do not', async () => {
    const at = '2026-10-18T00:00:00Z';
    const c = (id, login, verdict) => ({ id: String(id), author: { login, url: null }, body: block('0013-meals', { verdict, note: verdict === 'notes' ? 'x' : '', edits: [] }), url: `u${id}`, createdAt: at, updatedAt: at });
    // Forgejo's adapter answers admin (owner or admin), write or read: never maintain
    const levels = { 'fj-admin': 'admin', 'fj-writer': 'write' };
    const forge = { repo: 'owner/name', permission: async (_, login) => levels[login] ?? 'none' };
    expect(await latestReview(forge, 23, '0013-meals', [c(1, 'fj-admin', 'notes'), c(2, 'fj-writer', 'approved')])).toMatchObject({ verdict: 'notes', by: 'fj-admin' });
  });

  it('does not trust a maintainer\'s review that was edited after it was posted, nor let an older one stand in', async () => {
    const edited = (c, later) => ({ ...c, updated_at: later });
    const sentBack = comment(1, 'maintainer-one', block('0013-meals', { verdict: 'notes', note: 'No.', edits: [] }), '2026-10-18T00:00:00Z');
    const approved = comment(2, 'maintainer-one', block('0013-meals', { verdict: 'approved', note: '', edits: [] }), '2026-10-18T01:00:00Z');
    // Someone with write access turned a later send-back into an approval: the comment keeps its author
    const forge = await on({ [COMMENTS_23]: { body: [approved, edited({ ...sentBack, id: 3, created_at: '2026-10-18T02:00:00Z', updated_at: '2026-10-18T02:00:00Z', body: block('0013-meals', { verdict: 'approved', note: '', edits: [] }) }, '2026-10-18T03:00:00Z')] } });
    expect(await latestReview(forge, 23, '0013-meals')).toBeNull();
    // Within the grace of a forge stamping its own write, it still counts; an edited reader's comment is just ignored
    await fake.close();
    const fine = await on({ [COMMENTS_23]: { body: [edited(approved, '2026-10-18T01:00:03Z'), edited(comment(4, 'reader-two', block('0013-meals', { verdict: 'notes', note: 'x', edits: [] }), '2026-10-18T05:00:00Z'), '2026-10-18T06:00:00Z')] } });
    expect(await latestReview(fine, 23, '0013-meals')).toMatchObject({ verdict: 'approved', comment: { id: '2' } });
  });

  it('does not let an older review stand in when the forge cannot say who may review', async () => {
    const forge = await on({ 'GET /repos/owner/name/collaborators/maintainer-two/permission': { status: 503, body: { message: 'Unavailable' } } });
    await expect(latestReview(forge, 23, '0013-meals')).rejects.toBeInstanceOf(ForgeError);
  });
});

describe('posting a review', () => {
  let fake;
  let rows;
  afterEach(async () => { await fake?.close(); });
  beforeEach(() => { rows = []; });
  const record = (e) => { rows.push(e); };
  const post = async (extra = {}) => { fake = await fakeForge({ ...answers(), ...extra }); return forgeOn(fake); };
  const posted = () => fake.requests.filter((r) => r.method === 'POST');

  it('posts Approve as a comment with the line and the block, as the signed-in maintainer, and writes the audit row', async () => {
    const forge = await post();
    const review = { verdict: 'approved', note: 'Ship it.', edits };
    const out = await postReview(forge, 20, '0014-planner', review, { login: 'maintainer-one', record });
    expect(posted()).toHaveLength(1);
    expect(posted()[0].url).toBe('/repos/owner/name/issues/20/comments');
    expect(posted()[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    const sent = JSON.parse(posted()[0].body).body;
    expect(sent.split('\n')[0]).toBe('Approved `0014-planner` with 2 edits (maintainer-one, in cornfield).');
    expect(parseReviewBlocks(sent)).toEqual([{ slug: '0014-planner', review }]);
    expect(out).toEqual({ version: 1, slug: '0014-planner', ...review, at: '2026-10-18T12:00:00Z', by: 'maintainer-one', comment: { id: '9100', url: 'https://github.example.com/owner/name/pull/20#issuecomment-9100' } });
    expect(rows).toEqual([{
      login: 'maintainer-one', action: 'review', target: 'owner/name#20', status: 201,
      request: { slug: '0014-planner', ...review }, answer: { comment: '9100', url: 'https://github.example.com/owner/name/pull/20#issuecomment-9100' },
    }]);
  });

  it('posts Send back with its note, quoted for people to read, and nothing but the review in the block', async () => {
    const forge = await post();
    await postReview(forge, 20, '0014-planner', { verdict: 'notes', note: 'Make it one page.', edits: [] }, { login: 'maintainer-one', record });
    const sent = JSON.parse(posted()[0].body).body;
    expect(sent).toMatch(/^Sent back `0014-planner` \(maintainer-one, in cornfield\)\.\n\n> Make it one page\.\n\n```cornfield-review 0014-planner\n/);
    expect(parseReviewBlocks(sent)[0].review).toEqual({ verdict: 'notes', note: 'Make it one page.', edits: [] });
    expect(rows[0]).toMatchObject({ action: 'review', request: { verdict: 'notes', note: 'Make it one page.' } });
  });

  it('writes the audit row for a refusal too: the forge\'s status and words, and throws what the forge threw', async () => {
    const forge = await post({ [POST_20]: { status: 403, body: { message: 'Resource not accessible by personal access token' } } });
    const err = await postReview(forge, 20, '0014-planner', { verdict: 'approved', note: '', edits: [] }, { login: 'maintainer-one', record }).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ login: 'maintainer-one', action: 'review', target: 'owner/name#20', status: 403, answer: { error: err.message } });
  });

  it('refuses a review too long for a comment, posts nothing, and still records the attempt', async () => {
    const forge = await post();
    const long = { verdict: 'approved', note: '', edits: Array.from({ length: 400 }, (_, i) => ({ op: 'add-node', label: 'x'.repeat(200), i })) };
    expect(reviewComment('s', long, { login: 'l' }).length).toBeGreaterThan(MAX_COMMENT_CHARS);
    await expect(postReview(forge, 20, '0014-planner', long, { login: 'maintainer-one', record })).rejects.toMatchObject({ code: 'invalid' });
    expect(posted()).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBeNull();
  });

  it('is not undone by an audit table that cannot be written: the comment is on the PR, and the failure is logged', async () => {
    const forge = await post();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = await postReview(forge, 20, '0014-planner', { verdict: 'approved', note: '', edits: [] }, { login: 'maintainer-one', record: () => { throw new Error('disk full'); } });
      expect(out.comment.id).toBe('9100');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('audit table'));
    } finally {
      log.mockRestore();
    }
  });
});

describe('the review routes, on a spec PR', () => {
  let root;
  let fake;
  let server;
  let port;
  let rows;
  let signedIn;
  /** Every comment posted, so the next read of the PR's comments sees it */
  let posts;

  const routes = () => ({
    ...answers(),
    [POST_23]: (req) => {
      const body = JSON.parse(req.body).body;
      posts.push(comment(9200 + posts.length, 'maintainer-one', body, `2026-10-18T13:0${posts.length}:00Z`));
      return { status: 201, body: posts[posts.length - 1] };
    },
  });

  beforeEach(async () => {
    posts = [];
    rows = [];
    signedIn = { login: 'maintainer-one', record: (e) => { rows.push(e); } };
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-reviews-'));
    fs.writeFileSync(path.join(root, 'topology.json'), JSON.stringify({ nodes: [{ id: 'root', label: 'root', type: 'root' }], edges: [] }));
    fake = await fakeForge(routes());
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (!serveProposals(req, res, decodeURIComponent(url.pathname), url, whereOf(root), () => forgeOn(fake), signedIn)) { res.writeHead(418); res.end('not a proposal route'); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  });
  afterEach(async () => {
    await fake.close();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const call = (method, target, body, headers = { Origin: `http://127.0.0.1:${port}` }) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode || 0, headers: res.headers, body: text, json }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
  const PUT23 = '/proposals/0013-meals/review?source=pull%2F23';
  const posted = () => fake.requests.filter((r) => r.method === 'POST');

  it('reads the review from the PR: the latest admin comment, who sent it, when, and where it is', async () => {
    const res = await call('GET', PUT23);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ version: 1, slug: '0013-meals', verdict: 'approved', note: 'Good.', by: 'maintainer-two', at: '2026-10-17T10:00:00Z', comment: { id: '8003' } });
    expect((await call('HEAD', PUT23)).status).toBe(200);
  });

  it('says there is no review yet for a proposal nobody reviewed, and no such proposal for one the PR does not hold', async () => {
    fake.requests.length = 0;
    expect((await call('GET', '/proposals/0014-planner/review?source=pull%2F20')).json).toEqual({ error: 'No review yet' });
    expect((await call('GET', '/proposals/0099-other/review?source=pull%2F23')).json).toEqual({ error: 'No such proposal' }); // PR 23 has a review of it, but holds no such file
    expect((await call('GET', '/proposals/0013-meals/review?source=pull%2F19')).status).toBe(404); // a PR that is no longer open
  });

  it('Approve posts the comment and answers the review as the PR will now show it, and Send back the same', async () => {
    const approve = await call('PUT', PUT23, { verdict: 'approved', note: 'Good to go.', edits });
    expect(approve.status).toBe(200);
    expect(approve.json).toMatchObject({ version: 1, slug: '0013-meals', verdict: 'approved', note: 'Good to go.', edits, by: 'maintainer-one', comment: { id: '9200' } });
    expect(posted()).toHaveLength(1);
    expect(posted()[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    const sentBack = await call('PUT', PUT23, { verdict: 'notes', note: 'On second thought, no.', edits: [] });
    expect(sentBack.status).toBe(200);
    expect(sentBack.json).toMatchObject({ verdict: 'notes', comment: { id: '9201' } });
    expect(posts.map((p) => parseReviewBlocks(p.body)[0].review.verdict)).toEqual(['approved', 'notes']);
  });

  it('reads back what was posted: the edits round-trip, and the newest of two reviews by the same admin wins', async () => {
    await call('PUT', PUT23, { verdict: 'approved', note: 'Good to go.', edits });
    // the PR's comments now hold the fixture's, then ours (maintainer-one is the signed-in user, so their permission is the repo's own)
    fake.requests.length = 0;
    const list = answers()[COMMENTS_23].body;
    await fake.close();
    fake = await fakeForge({ ...routes(), [COMMENTS_23]: { body: [...list, ...posts] } });
    const back = await call('GET', PUT23);
    expect(back.json).toMatchObject({ verdict: 'approved', note: 'Good to go.', edits, by: 'maintainer-one', comment: { id: '9200' } });
    await call('PUT', PUT23, { verdict: 'notes', note: 'No.', edits: [] });
    await fake.close();
    fake = await fakeForge({ ...routes(), [COMMENTS_23]: { body: [...list, ...posts] } });
    expect((await call('GET', PUT23)).json).toMatchObject({ verdict: 'notes', note: 'No.', edits: [], comment: { id: '9201' } });
  });

  it('writes the audit row: who, what, which PR, the forge\'s status and the comment', async () => {
    await call('PUT', PUT23, { verdict: 'notes', note: 'Smaller.', edits });
    expect(rows).toEqual([{
      login: 'maintainer-one', action: 'review', target: 'owner/name#23', status: 201,
      request: { slug: '0013-meals', verdict: 'notes', note: 'Smaller.', edits },
      answer: { comment: '9200', url: 'https://github.example.com/owner/name/pull/23#issuecomment-9200' },
    }]);
  });

  it('refuses a bad review in words, before it asks the forge anything', async () => {
    fake.requests.length = 0;
    expect((await call('PUT', PUT23, { verdict: 'notes', note: '  ', edits: [] })).json.error).toMatch(/note is needed/);
    expect((await call('PUT', PUT23, { verdict: 'maybe' })).status).toBe(400);
    expect((await call('PUT', PUT23, { verdict: 'approved', extra: 1 })).status).toBe(400);
    expect((await call('PUT', PUT23, '{ nope')).status).toBe(400);
    expect((await call('PUT', PUT23, 'x'.repeat(300 * 1024))).status).toBe(413);
    expect(fake.requests).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('is only taken from cornfield\'s own page', async () => {
    fake.requests.length = 0;
    expect((await call('PUT', PUT23, { verdict: 'approved' }, {})).status).toBe(403);
    expect((await call('PUT', PUT23, { verdict: 'approved' }, { Origin: 'http://evil.example' })).status).toBe(403);
    expect(fake.requests).toEqual([]);
  });

  it('posts only on a proposal the PR holds, on an open PR', async () => {
    expect((await call('PUT', '/proposals/0099-other/review?source=pull%2F23', { verdict: 'approved' })).status).toBe(404);
    expect((await call('PUT', '/proposals/0013-meals/review?source=pull%2F19', { verdict: 'approved' })).status).toBe(404);
    expect((await call('PUT', '/proposals/0013-meals/review?source=pull%2F0', { verdict: 'approved' })).status).toBe(409); // not a PR source at all
    expect(posted()).toEqual([]);
  });

  it('says what the forge said when it refuses the comment, and the audit row has the status', async () => {
    await fake.close();
    fake = await fakeForge({ ...routes(), [POST_23]: { status: 403, body: { message: 'Resource not accessible by personal access token' } } });
    const res = await call('PUT', PUT23, { verdict: 'approved' });
    expect(res.status).toBe(502);
    expect(res.json.error).toMatch(/\S/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'review', target: 'owner/name#23', status: 403 });
  });

  it('answers 409 for a draft in the checkout, and for a PR source with no sign-in', async () => {
    const solo = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      serveProposals(req, res, decodeURIComponent(url.pathname), url, whereOf(root), null, null);
    });
    await new Promise((resolve) => solo.listen(0, '127.0.0.1', () => resolve(undefined)));
    try {
      const p = /** @type {import('node:net').AddressInfo} */ (solo.address()).port;
      const res = await fetch(`http://127.0.0.1:${p}${PUT23}`, { method: 'PUT', body: '{"verdict":"approved"}' });
      expect(res.status).toBe(409);
    } finally {
      await new Promise((resolve) => solo.close(() => resolve(undefined)));
    }
    expect((await call('PUT', '/proposals/0013-meals/review?source=checkout', { verdict: 'approved' })).status).toBe(409);
  });
});

describe('cornfield review <slug>', () => {
  let fake;
  let log;
  let err;
  const flags = (extra = {}) => ({ repo: SAMPLE, ...extra });
  const config = { forge: { type: 'github', url: 'https://github.com', repo: 'owner/name' } };
  let repo;
  const keep = { ...process.env };

  beforeEach(async () => {
    fake = await fakeForge(answers());
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-review-cli-'));
    fs.cpSync(SAMPLE, repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'cornfield.config.js'), `export default ${JSON.stringify({ ...config, proposals: 'docs/specs/proposals' })};\n`);
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.CORNFIELD_FORGE_TOKEN = TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });
  afterEach(async () => {
    log.mockRestore();
    err.mockRestore();
    process.env = { ...keep };
    await fake.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });
  const run = (slug, extra = {}) => reviewCommand(flags({ repo, ...extra }), slug, { apiUrl: fake.url });
  const out = () => log.mock.calls.map((c) => c[0]).join('\n');
  const errs = () => err.mock.calls.map((c) => c[0]).join('\n');

  it('prints the latest admin review of the proposal from its PR: the one open PR that holds it is found, or named with --pr', async () => {
    expect(await run('0013-meals')).toBe(0);
    expect(JSON.parse(out())).toMatchObject({ version: 1, slug: '0013-meals', verdict: 'approved', note: 'Good.', by: 'maintainer-two', comment: { id: '8003' } });
    expect(fake.requests.find((r) => r.url.startsWith('/repos/owner/name/pulls/23/files'))).toBeTruthy();
    log.mockClear();
    expect(await run('0013-meals', { pr: '23' })).toBe(0);
    expect(JSON.parse(out()).by).toBe('maintainer-two');
    log.mockClear();
    expect(await run('0013-meals', { source: 'pull/23' })).toBe(0);
    expect(JSON.parse(out()).verdict).toBe('approved');
  });

  it('reads the PR with the token it was given, and only reads', async () => {
    await run('0013-meals');
    expect(fake.requests.every((r) => r.method === 'GET' && r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('says there is no review yet, and refuses what it cannot find or cannot ask', async () => {
    expect(await run('0014-planner')).toBe(0);
    expect(out()).toMatch(/No review of 0014-planner on PR #20 yet/);
    expect(await run('9999-nope')).toBe(1);
    expect(errs()).toMatch(/No open spec PR holds a proposal "9999-nope"/);
    err.mockClear();
    expect(await run('0013-meals', { pr: 'x' })).toBe(1);
    expect(errs()).toMatch(/pull request number/);
    err.mockClear();
    delete process.env.CORNFIELD_FORGE_TOKEN;
    expect(await run('0013-meals')).toBe(1);
    expect(errs()).toMatch(/needs a token/);
    err.mockClear();
    process.env.CORNFIELD_FORGE_TOKEN = TOKEN;
    fs.writeFileSync(path.join(repo, 'cornfield.config.js'), 'export default { forge: null };\n');
    expect(await run('0013-meals')).toBe(1);
    expect(errs()).toMatch(/no forge is configured/);
  });

  it('says what the forge said when it cannot answer', async () => {
    await fake.close();
    fake = await fakeForge({ ...answers(), [COMMENTS_23]: { status: 503, body: { message: 'Unavailable' } } });
    expect(await run('0013-meals', { pr: '23' })).toBe(1);
    expect(errs()).toMatch(/\S/);
  });
});

describe('Stage 1 reviews, carried over once', () => {
  let fake;
  let dataDir;
  let rows;
  let log;
  const kept = (source, slug, review = {}) => {
    const dir = path.join(dataDir, 'reviews', source);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slug}.review.json`), `${JSON.stringify({ version: 1, verdict: 'approved', note: 'From Stage 1.', edits, at: '2026-10-01T09:30:00.000Z', ...review }, null, 2)}\n`);
    return path.join(dir, `${slug}.review.json`);
  };
  const names = (source) => fs.readdirSync(path.join(dataDir, 'reviews', source)).sort();
  const posted = () => fake.requests.filter((r) => r.method === 'POST');

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-migrate-'));
    rows = [];
    log = vi.spyOn(console, 'error').mockImplementation(() => {});
    fake = await fakeForge(answers());
  });
  afterEach(async () => {
    log.mockRestore();
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const migrate = async () => {
    const forge = forgeOn(fake);
    const { entries } = await listPullProposals(forge, { proposals: 'docs/specs/proposals' });
    return migrateStage1Reviews({ forge, dataDir, entries, login: 'maintainer-one', record: (e) => { rows.push(e); } });
  };

  it('posts a kept review on the one open PR that holds its proposal, marks the file, and does nothing the second time', async () => {
    const file = kept('checkout', '0014-planner');
    const first = await migrate();
    expect(first).toEqual({ posted: [file], superseded: [], skipped: [] });
    expect(posted()).toHaveLength(1);
    expect(posted()[0].url).toBe('/repos/owner/name/issues/20/comments');
    const sent = JSON.parse(posted()[0].body).body;
    expect(sent.split('\n')[0]).toBe('Approved `0014-planner` with 2 edits (maintainer-one, in cornfield on 2026-10-01; carried over from before reviews were comments).');
    expect(parseReviewBlocks(sent)).toEqual([{ slug: '0014-planner', review: { verdict: 'approved', note: 'From Stage 1.', edits } }]);
    expect(names('checkout')).toEqual(['0014-planner.review.json.migrated']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'review', target: 'owner/name#20', status: 201, request: { slug: '0014-planner', migrated: '2026-10-01' } });

    const again = await migrate();
    expect(again).toEqual({ posted: [], superseded: [], skipped: [] });
    expect(posted()).toHaveLength(1); // still the one comment
    expect(rows).toHaveLength(1);
    expect(names('checkout')).toEqual(['0014-planner.review.json.migrated']); // left alone
  });

  it('runs twice at once without posting twice', async () => {
    kept('checkout', '0014-planner');
    const forge = forgeOn(fake);
    const { entries } = await listPullProposals(forge, { proposals: 'docs/specs/proposals' });
    const args = { forge, dataDir, entries, login: 'maintainer-one', record: (e) => { rows.push(e); } };
    const [a, b] = await Promise.all([migrateStage1Reviews(args), migrateStage1Reviews(args)]);
    expect(a).toBe(b);
    expect(a.posted).toHaveLength(1);
    expect(posted()).toHaveLength(1);
  });

  it('does not overwrite a newer decision on the PR: a PR that already has an admin review of it supersedes the kept file', async () => {
    const file = kept('topo-09', '0013-meals', { verdict: 'notes', note: 'Old.' });
    expect(await migrate()).toEqual({ posted: [], superseded: [file], skipped: [] });
    expect(posted()).toEqual([]);
    expect(names('topo-09')).toEqual(['0013-meals.review.json.migrated']);
  });

  it('waits for a PR: a review whose proposal no open PR holds stays where it is, and is carried over when one does', async () => {
    const file = kept('checkout', '0050-not-pushed');
    expect(await migrate()).toEqual({ posted: [], superseded: [], skipped: [] });
    expect(names('checkout')).toEqual(['0050-not-pushed.review.json']);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('marks, without posting, a file that is not a review of this version, and leaves other files and folders alone', async () => {
    const dir = path.join(dataDir, 'reviews', 'checkout');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '0014-planner.review.json'), '{ garbled');
    fs.writeFileSync(path.join(dir, '0013-meals.review.json'), JSON.stringify({ version: 2, verdict: 'approved' }));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
    fs.mkdirSync(path.join(dir, '0020-a-folder.review.json'));
    const result = await migrate();
    expect(result.posted).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(names('checkout')).toEqual(['0013-meals.review.json.migrated', '0014-planner.review.json.migrated', '0020-a-folder.review.json', 'notes.txt']);
    expect(posted()).toEqual([]);
  });

  it('leaves the file for next time when the forge cannot take the comment', async () => {
    await fake.close();
    fake = await fakeForge({ ...answers(), [POST_20]: { status: 503, body: { message: 'Unavailable' } } });
    const file = kept('checkout', '0014-planner');
    expect(await migrate()).toEqual({ posted: [], superseded: [], skipped: [] });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('has nothing to do, and asks the forge nothing, when no review was ever kept', async () => {
    fake.requests.length = 0;
    const forge = forgeOn(fake);
    expect(await migrateStage1Reviews({ forge, dataDir, entries: [], login: 'maintainer-one' })).toEqual({ posted: [], superseded: [], skipped: [] });
    expect(fake.requests).toEqual([]);
  });
});
