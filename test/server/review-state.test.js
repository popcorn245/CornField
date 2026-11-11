/**
 * @vitest-environment node
 *
 * The review state of each listed proposal (spec 0010 D4, server/proposal-pulls.js `reviewStates`): the latest maintainer review of a ready PR,
 * whether it still holds (`current`), and when the head was pushed; kept by head for five minutes, forgotten when a review is posted; a draft PR is
 * not read; a read that fails says so and is not kept, so a PR never looks unreviewed because the forge was down. A stub forge counts every call.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS module, no declarations
import { reviewStates, forgetReviewState, REVIEW_KEEP_MS } from '../../server/proposal-pulls.js';
// @ts-expect-error plain JS module, no declarations
import { reviewComment, proposalHash } from '../../server/reviews.js';
// @ts-expect-error plain JS module, no declarations
import { ForgeError } from '../../server/forge.js';

const TEXT = '{"version":1,"title":"Meals"}';
const entry = (n, slug, { draft = false, sha = `sha${n}` } = {}) => ({ slug, source: `pull/${n}`, path: `docs/specs/proposals/${slug}.json`, sha, pull: { number: n, title: 't', url: 'u', draft, author: 'a', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z' } });
const comment = (slug, review, at, login = 'maintainer-one') => ({ id: `c${at}`, author: { login, url: null }, body: reviewComment(slug, { note: '', edits: [], ...review }, { login }), url: 'u', createdAt: at, updatedAt: at });

/** A stub forge that counts what it is asked */
function world({ comments = {}, commits = {}, fail = null } = {}) {
  const calls = [];
  const forge = {
    repo: 'owner/name',
    pullCommits: async (n) => { calls.push(`commits ${n}`); if (fail === 'commits') throw new ForgeError('GitHub did not answer.', { code: 'unavailable' }); return commits[n] ?? []; },
    comments: async (n) => { calls.push(`comments ${n}`); if (fail === 'comments') throw new ForgeError('GitHub did not answer.', { code: 'unavailable' }); return comments[n] ?? []; },
    permission: async (_r, login) => { calls.push(`permission ${login}`); return login.startsWith('maintainer') ? 'maintain' : 'read'; },
    file: async (sha, path) => { calls.push(`file ${sha}:${path}`); return TEXT; },
  };
  return { forge, calls };
}
const where = () => ({ proposals: 'docs/specs/proposals' });
const commitAt = (date) => [{ sha: 'x', message: 'm', date }];

describe('the review state of a listing entry', () => {
  it('is null for a ready PR nobody reviewed, with the push it waits on', async () => {
    const { forge } = world({ commits: { 1: commitAt('2026-11-03T00:00:00Z') } });
    expect(await reviewStates(forge, where(), [entry(1, '0001-a')])).toEqual([{ pushedAt: '2026-11-03T00:00:00Z', review: null }]);
  });

  it('says who and when, and that an approval holds only while the file is the one approved', async () => {
    const hash = proposalHash(TEXT);
    const w = world({ commits: { 1: commitAt('2026-11-03T00:00:00Z'), 2: commitAt('2026-11-03T00:00:00Z') }, comments: {
      1: [comment('0001-a', { verdict: 'approved', proposal: hash }, '2026-11-04T00:00:00Z')],
      2: [comment('0002-b', { verdict: 'approved', proposal: 'f'.repeat(64) }, '2026-11-04T00:00:00Z')],
    } });
    const [one, two] = await reviewStates(w.forge, where(), [entry(1, '0001-a'), entry(2, '0002-b')]);
    expect(one.review).toEqual({ verdict: 'approved', by: 'maintainer-one', at: '2026-11-04T00:00:00Z', current: true });
    expect(two.review).toMatchObject({ verdict: 'approved', current: false }); // the file changed since: it is read as changed, never as approved
  });

  it('holds a send-back until something is pushed after it', async () => {
    const w = world({ commits: { 1: commitAt('2026-11-03T00:00:00Z'), 2: commitAt('2026-11-06T00:00:00Z') }, comments: {
      1: [comment('0001-a', { verdict: 'notes', note: 'fix' }, '2026-11-04T00:00:00Z')],
      2: [comment('0002-b', { verdict: 'notes', note: 'fix' }, '2026-11-04T00:00:00Z')],
    } });
    const [one, two] = await reviewStates(w.forge, where(), [entry(1, '0001-a'), entry(2, '0002-b')]);
    expect(one.review.current).toBe(true); // not pushed since
    expect(two.review.current).toBe(false); // pushed since: it waits on the maintainer again
  });

  it('ignores a review by someone who is not a maintainer', async () => {
    const w = world({ comments: { 1: [comment('0001-a', { verdict: 'approved' }, '2026-11-04T00:00:00Z', 'reader-two')] } });
    expect((await reviewStates(w.forge, where(), [entry(1, '0001-a')]))[0].review).toBeNull();
  });

  it('does not read a draft PR at all', async () => {
    const w = world();
    expect(await reviewStates(w.forge, where(), [entry(1, '0001-a', { draft: true })])).toEqual([{ pushedAt: null, review: null }]);
    expect(w.calls).toEqual([]);
  });

  it('says so when the forge could not be asked, and asks again next time (a failed read is never kept)', async () => {
    const w = world({ fail: 'comments' });
    const sameWhere = where();
    const [first] = await reviewStates(w.forge, sameWhere, [entry(1, '0001-a')]);
    expect(first.review).toEqual({ error: 'GitHub did not answer.' });
    const before = w.calls.length;
    await reviewStates(w.forge, sameWhere, [entry(1, '0001-a')]);
    expect(w.calls.length).toBeGreaterThan(before);
    const failedCommits = world({ fail: 'commits' });
    expect((await reviewStates(failedCommits.forge, where(), [entry(1, '0001-a')]))[0].review).toEqual({ error: 'GitHub did not answer.' });
  });
});

describe('what the review state costs', () => {
  it('reads a PR once at a head: a second listing within five minutes asks nothing, and a review posted from cornfield is read at once', async () => {
    const w = world({ commits: { 1: commitAt('2026-11-03T00:00:00Z') }, comments: { 1: [comment('0001-a', { verdict: 'notes', note: 'x' }, '2026-11-04T00:00:00Z')] } });
    const sameWhere = where();
    let clock = 1_000_000;
    const read = () => reviewStates(w.forge, sameWhere, [entry(1, '0001-a'), entry(2, '0002-b', { draft: true })], { now: () => clock });
    const first = await read();
    expect(w.calls.sort()).toEqual(['commits 1', 'comments 1', 'permission maintainer-one'].sort());
    w.calls.length = 0;
    expect(await read()).toEqual(first);
    expect(w.calls).toEqual([]);
    clock += REVIEW_KEEP_MS - 1;
    await read();
    expect(w.calls).toEqual([]);
    forgetReviewState(sameWhere, 1);
    await read();
    expect(w.calls).toContain('comments 1');
    expect(w.calls).not.toContain('commits 1'); // a commit never changes: kept by sha for good
    w.calls.length = 0;
    clock += REVIEW_KEEP_MS + 1;
    await read();
    expect(w.calls).toContain('comments 1');
  });

  it('asks the comments of a PR once for all its proposals, and again at a new head', async () => {
    const w = world();
    const sameWhere = where();
    await reviewStates(w.forge, sameWhere, [entry(1, '0001-a'), entry(1, '0002-b')]);
    expect(w.calls.filter((c) => c === 'comments 1')).toHaveLength(1);
    w.calls.length = 0;
    await reviewStates(w.forge, sameWhere, [entry(1, '0001-a', { sha: 'moved' }), entry(1, '0002-b', { sha: 'moved' })]);
    expect(w.calls).toContain('comments 1');
    expect(w.calls).toContain('commits 1');
  });
});
