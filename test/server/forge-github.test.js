/**
 * @vitest-environment node
 *
 * The GitHub adapter (server/forge-github.js) and what the adapters share (server/forge.js, server/forge-http.js):
 * the forge contract over recorded GitHub answers (test/fixtures/forge/github.json), then what is GitHub's own:
 * where its API is, its headers, its rate limits in words, pagination that stays on the API's origin, errors in
 * plain words, the checks it can and cannot re-run, a folder at a path. Every request goes to a fake forge on
 * loopback; no token is real and nothing leaves the machine.
 */
import { describe, it, expect, afterEach } from 'vitest';
// @ts-expect-error plain JS module, no declarations
import { createForge, isMaintainer, isGreen, notGreenWords, FORGE_METHODS } from '../../server/forge.js';
// @ts-expect-error plain JS module, no declarations
import { githubApiUrl, githubRateLimit } from '../../server/forge-github.js';
// @ts-expect-error plain JS module, no declarations
import { nextLink, rateLimitWords, MAX_PAGES } from '../../server/forge-http.js';
import { fakeForge, recordings } from './fake-forge.js';
import { forgeContract, forgeError, TOKEN } from './forge-contract.js';

forgeContract({ name: 'GitHub', type: 'github', recordings: recordings('github') });

const NOW = new Date('2026-10-17T21:08:00Z');
const RESET = String(Date.parse('2026-10-17T21:14:00Z') / 1000);

describe('the GitHub adapter', () => {
  let fake;
  afterEach(async () => { await fake?.close(); fake = undefined; });
  const forgeOn = async (routes, opts = {}) => {
    fake = await fakeForge(routes);
    return createForge({ type: 'github', url: 'https://github.com', repo: 'owner/name' }, { token: TOKEN, apiUrl: fake.url, ...opts });
  };

  it('has every call of the interface', async () => {
    const forge = await forgeOn({});
    for (const m of FORGE_METHODS) expect(typeof forge[m], m).toBe('function');
    expect(Object.isFrozen(forge)).toBe(true);
  });

  it('finds the API of github.com and of a GitHub Enterprise Server', () => {
    expect(githubApiUrl()).toBe('https://api.github.com');
    expect(githubApiUrl('https://github.com/')).toBe('https://api.github.com');
    expect(githubApiUrl('https://git.example.org')).toBe('https://git.example.org/api/v3');
  });

  it('sends GitHub\'s headers: a Bearer token, its media type and API version', async () => {
    const forge = await forgeOn({ 'GET /user': { body: { id: 1, login: 'maintainer-one' } } });
    await forge.me();
    const h = fake.requests[0].headers;
    expect(h.authorization).toBe(`Bearer ${TOKEN}`);
    expect(h.accept).toBe('application/vnd.github+json');
    expect(h['x-github-api-version']).toBe('2022-11-28');
  });

  it('sends no Authorization header without a token', async () => {
    const forge = await forgeOn({ 'GET /repos/owner/name/branches?per_page=100': { body: [] } }, { token: null });
    await forge.branches();
    expect(fake.requests[0].headers.authorization).toBeUndefined();
  });

  it('asks the signed-in user once, and their own permission from the repo', async () => {
    const forge = await forgeOn({
      'GET /user': { body: { id: 1, login: 'maintainer-one' } },
      'GET /repos/owner/name': { body: { permissions: { admin: true, maintain: true, push: true, triage: true, pull: true } } },
      'GET /repos/owner/other': { status: 404, body: { message: 'Not Found' } },
    });
    expect(await forge.permission('owner/name', 'maintainer-one')).toBe('admin');
    expect(await forge.permission('owner/other', 'maintainer-one')).toBe('none');
    expect(fake.requests.filter((r) => r.url === '/user')).toHaveLength(1);
  });

  it('reads another user\'s permission from the collaborator endpoint, old-style answers too', async () => {
    const forge = await forgeOn({
      'GET /user': { body: { id: 1, login: 'maintainer-one' } },
      'GET /repos/owner/name/collaborators/writer-five/permission': { body: { permission: 'write', role_name: 'write' } },
      'GET /repos/owner/name/collaborators/custom-six/permission': { body: { permission: 'write', role_name: 'security-reviewer' } },
      'GET /repos/owner/name/collaborators/old-seven/permission': { body: { permission: 'admin' } },
      'GET /repos/owner/name/collaborators/odd-eight/permission': { body: { permission: 'something' } },
    });
    expect(await forge.permission('owner/name', 'writer-five')).toBe('write');
    expect(await forge.permission('owner/name', 'custom-six')).toBe('write');
    expect(await forge.permission('owner/name', 'old-seven')).toBe('admin');
    expect(await forge.permission('owner/name', 'odd-eight')).toBe('none');
  });

  it('maps every check-run conclusion and commit status to the interface\'s states', async () => {
    const run = (id, status, conclusion, slug = 'github-actions') => ({ id, name: `run-${id}`, status, conclusion, html_url: null, app: { slug } });
    const forge = await forgeOn({
      'GET /repos/owner/name/commits/feature/x/check-runs?per_page=100': { body: { check_runs: [
        run(1, 'queued', null), run(2, 'waiting', null), run(3, 'in_progress', null), run(4, 'completed', 'success'),
        run(5, 'completed', 'neutral'), run(6, 'completed', 'skipped'), run(7, 'completed', 'cancelled'), run(8, 'completed', 'timed_out'),
        run(9, 'completed', 'action_required'), run(10, 'completed', 'stale'), run(11, 'completed', 'failure', 'some-app'),
      ] } },
      'GET /repos/owner/name/commits/feature/x/status?per_page=100': { body: { statuses: [
        { context: 'a', state: 'pending' }, { context: 'b', state: 'error' }, { context: 'c', state: 'failure', target_url: 'https://ci.example.com/3' },
      ] } },
    });
    const checks = await forge.checks('feature/x');
    expect(checks.map((c) => [c.id, c.state, c.rerunnable])).toEqual([
      ['run:1', 'queued', false], ['run:2', 'queued', false], ['run:3', 'running', false], ['run:4', 'success', false],
      ['run:5', 'neutral', false], ['run:6', 'skipped', false], ['run:7', 'cancelled', true], ['run:8', 'failure', true],
      ['run:9', 'failure', true], ['run:10', 'cancelled', true], ['run:11', 'failure', false],
      ['status:a', 'running', false], ['status:b', 'failure', false], ['status:c', 'failure', false],
    ]);
    expect(checks.at(-1).url).toBe('https://ci.example.com/3');
  });

  it('re-runs a GitHub Actions job, and refuses a commit status', async () => {
    const forge = await forgeOn({ 'POST /repos/owner/name/actions/jobs/42/rerun': { status: 201, body: {} } });
    await forge.rerun({ id: 'run:42', name: 'lint', state: 'failure', url: null, rerunnable: true });
    expect(fake.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['POST /repos/owner/name/actions/jobs/42/rerun']);
    await forgeError(() => forge.rerun({ id: 'status:ci', name: 'ci', state: 'failure', url: null, rerunnable: true }), 'invalid');
    expect(fake.requests).toHaveLength(1);
  });

  it('merges with the merge method asked for, and says so when GitHub refuses because the head moved', async () => {
    const pr = { number: 12, state: 'open', draft: false, head: { ref: 'f', sha: 'abc' }, base: { ref: 'main' } };
    const green = { check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }] };
    const forge = await forgeOn({
      'GET /repos/owner/name/pulls/12': { body: pr },
      'GET /repos/owner/name/commits/abc/check-runs?per_page=100': { body: green },
      'GET /repos/owner/name/commits/abc/status?per_page=100': { body: { statuses: [] } },
      'PUT /repos/owner/name/pulls/12/merge': (req) => (JSON.parse(req.body).merge_method === 'squash'
        ? { body: { sha: 'squashed', merged: true } }
        : { status: 409, body: { message: 'Head branch was modified. Review and try the merge again.' } }),
    });
    expect(await forge.merge(12, { onlyIfGreen: true, method: 'squash' })).toEqual({ sha: 'squashed' });
    expect(JSON.parse(fake.requests.at(-1).body)).toEqual({ sha: 'abc', merge_method: 'squash' });
    const moved = await forgeError(() => forge.merge(12, { onlyIfGreen: true }), 'conflict');
    expect(moved.message).toBe('GitHub refused: pull request #12 in owner/name cannot be changed that way now. GitHub said: "Head branch was modified. Review and try the merge again."');
  });

  it('does not count a commit with no checks as green', async () => {
    const forge = await forgeOn({
      'GET /repos/owner/name/pulls/12': { body: { number: 12, state: 'open', draft: false, head: { sha: 'abc' } } },
      'GET /repos/owner/name/commits/abc/check-runs?per_page=100': { body: { check_runs: [] } },
      'GET /repos/owner/name/commits/abc/status?per_page=100': { body: { statuses: [] } },
    });
    expect((await forgeError(() => forge.merge(12, { onlyIfGreen: true }), 'not-green')).message).toBe('Pull request #12 is not green: it has no checks.');
    expect(fake.requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('escapes a ref and a path, keeping their slashes', async () => {
    const forge = await forgeOn({ 'GET /repos/owner/name/contents/docs/a%20b/c%23d.json?ref=feature%2Fx%23y': { headers: { 'content-type': 'application/vnd.github.raw' }, body: 'hi' } });
    expect(await forge.file('feature/x#y', 'docs/a b/c#d.json')).toBe('hi');
  });

  it('answers null for a folder, whose contents GitHub lists as JSON', async () => {
    const forge = await forgeOn({
      'GET /repos/owner/name/contents/docs?ref=main': { body: [{ name: 'a.md', path: 'docs/a.md', type: 'file' }] },
      'GET /repos/owner/name/contents/list.json?ref=main': { body: [1, 2] },
    });
    expect(await forge.file('main', 'docs')).toBeNull();
    expect(await forge.file('main', 'list.json')).toBe('[1,2]');
  });

  it('follows every page, then stops at MAX_PAGES when the next link never ends', async () => {
    const forge = await forgeOn({
      'GET /repos/owner/name/branches?per_page=100': { headers: { link: '<{origin}/repos/owner/name/branches?per_page=100>; rel="next"' }, body: [{ name: 'b', commit: { sha: 's' } }] },
    });
    expect(await forge.branches()).toHaveLength(MAX_PAGES);
  });

  it('never follows a next link to another origin, so the token stays with GitHub', async () => {
    const forge = await forgeOn({
      'GET /repos/owner/name/branches?per_page=100': { headers: { link: '<https://elsewhere.example.com/steal?page=2>; rel="next"' }, body: [{ name: 'main', commit: { sha: 's' } }] },
    });
    expect((await forge.branches()).map((b) => b.name)).toEqual(['main']);
    expect(fake.requests).toHaveLength(1);
  });

  it('does not follow a redirect, and says the repo has moved', async () => {
    const forge = await forgeOn({ 'GET /repos/owner/name/branches?per_page=100': { status: 301, headers: { location: 'https://elsewhere.example.com/repos/1/branches' }, body: { message: 'Moved Permanently' } } });
    const err = await forgeError(() => forge.branches(), 'not-found');
    expect(err.message).toBe('GitHub says the branches of owner/name has moved; check forge.repo in cornfield.config.js.');
  });

  it('keeps the rate limit the last answer reported', async () => {
    const forge = await forgeOn({ 'GET /user': { headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '48', 'x-ratelimit-reset': RESET }, body: { id: 1, login: 'm' } } });
    expect(forge.rateLimit()).toBeNull();
    await forge.me();
    expect(forge.rateLimit()).toEqual({ limit: 5000, remaining: 48, resetAt: '2026-10-17T21:14:00.000Z', retryAfter: null });
    expect(rateLimitWords('GitHub', forge.rateLimit(), NOW)).toBe('48 of 5000 GitHub calls left; the count resets at 21:14 UTC (in about 6 minutes).');
  });

  it('says in words when the rate limit is used up, or GitHub asks it to slow down', async () => {
    const forge = await forgeOn({
      'GET /user': { status: 403, headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': RESET }, body: { message: 'API rate limit exceeded for user ID 1.' } },
      'GET /repos/owner/name/branches?per_page=100': { status: 429, headers: { 'retry-after': '40', 'x-ratelimit-remaining': '4000' }, body: { message: 'You have exceeded a secondary rate limit.' } },
      'GET /repos/owner/name/pulls/1': { status: 403, headers: { 'x-ratelimit-remaining': '4000' }, body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' } },
    });
    const used = await forgeError(() => forge.me(), 'rate-limited');
    expect(used.status).toBe(403);
    expect(used.message).toMatch(/^GitHub's limit for this sign-in is used up; it resets at 21:14 UTC \((in .+|now)\)\.$/);
    expect(used.rateLimit.resetAt).toBe('2026-10-17T21:14:00.000Z');
    expect((await forgeError(() => forge.branches(), 'rate-limited')).message).toBe('GitHub asked cornfield to slow down; try again in 40 seconds.');
    expect((await forgeError(() => forge.pull(1), 'rate-limited')).message).toBe('GitHub asked cornfield to slow down; try again in 60 seconds.');
  });

  it('says in words what every other refusal means, with GitHub\'s own first line', async () => {
    const forge = await forgeOn({
      'GET /user': { status: 401, body: { message: 'Bad credentials' } },
      'GET /repos/owner/name/pulls/1': { status: 403, body: { message: 'Resource not accessible by integration\nmore detail' } },
      'GET /repos/owner/name/pulls/2': { status: 422, body: { message: 'Validation Failed' } },
      'GET /repos/owner/name/pulls/3': { status: 502, body: 'Bad gateway' },
      'GET /repos/owner/name/pulls/4': { body: 'not json' },
    });
    expect((await forgeError(() => forge.me(), 'unauthorized')).message).toBe('GitHub did not accept the sign-in; sign in again.');
    expect((await forgeError(() => forge.pull(1), 'forbidden')).message).toBe('GitHub does not let this sign-in do that to pull request #1 in owner/name. GitHub said: "Resource not accessible by integration"');
    expect((await forgeError(() => forge.pull(2), 'invalid')).message).toBe('GitHub did not accept the request for pull request #2 in owner/name. GitHub said: "Validation Failed"');
    expect((await forgeError(() => forge.pull(3), 'unavailable')).message).toBe('GitHub could not answer for pull request #3 in owner/name (HTTP 502); try again in a minute.');
    expect((await forgeError(() => forge.pull(4), 'unavailable')).message).toBe('GitHub answered for pull request #4 in owner/name with something that is not JSON.');
    expect((await forgeError(() => forge.pull(5), 'not-found')).message).toBe('GitHub has no pull request #5 in owner/name, or this sign-in cannot see it.');
  });

  it('gives up on a forge that does not answer in time, or at all', async () => {
    const forge = await forgeOn({ 'GET /user': { hang: true } }, { timeoutMs: 100 });
    expect((await forgeError(() => forge.me(), 'unavailable')).message).toBe('GitHub did not answer within 1 second; try again in a minute.');
    const port = new URL(fake.url).port;
    await fake.close();
    fake = undefined;
    const gone = createForge({ type: 'github', repo: 'owner/name' }, { apiUrl: `http://127.0.0.1:${port}` });
    expect((await forgeError(() => gone.me(), 'unavailable')).message).toBe('GitHub did not answer; try again in a minute.');
  });

  it('asks for the signed-in user again after a failure', async () => {
    let calls = 0;
    const forge = await forgeOn({ 'GET /user': () => (++calls === 1 ? { status: 502, body: {} } : { body: { id: 1, login: 'maintainer-one' } }) });
    await forgeError(() => forge.me(), 'unavailable');
    expect((await forge.me()).login).toBe('maintainer-one');
  });
});

describe('createForge', () => {
  it('needs a forge it has an adapter for, and a repo', () => {
    expect(() => createForge(null)).toThrow('No forge is configured');
    expect(() => createForge({ type: 'gitlab', repo: 'o/n' })).toThrow('no adapter for the forge type "gitlab"');
    expect(() => createForge({ type: 'github', repo: 'nope' })).toThrow('forge.repo is "owner/name".');
  });
});

describe('what the adapters share', () => {
  it('isMaintainer: admin and maintain are cornfield\'s admins; nothing else is', () => {
    expect(['admin', 'maintain', 'write', 'triage', 'read', 'none', undefined].map(isMaintainer)).toEqual([true, true, false, false, false, false, false]);
  });

  it('isGreen and notGreenWords', () => {
    const c = (name, state) => ({ id: name, name, state, url: null, rerunnable: false });
    expect(isGreen([])).toBe(false);
    expect(isGreen([c('a', 'success'), c('b', 'neutral'), c('c', 'skipped')])).toBe(true);
    expect(isGreen([c('a', 'success'), c('b', 'queued')])).toBe(false);
    expect(notGreenWords([c('a', 'success'), c('b', 'queued'), c('c', 'cancelled'), c('d', 'failure')])).toBe('b is waiting to run; c was cancelled; d failed');
  });

  it('nextLink reads rel="next" wherever it is in the header', () => {
    expect(nextLink(undefined)).toBeNull();
    expect(nextLink('')).toBeNull();
    expect(nextLink('<https://a.test/x?page=1>; rel="prev", <https://a.test/x?page=3>; rel="next"')).toBe('https://a.test/x?page=3');
    expect(nextLink('<https://a.test/x?a=1,2>; rel=next')).toBe('https://a.test/x?a=1,2');
    expect(nextLink('<https://a.test/x?page=2>; rel="next last"')).toBe('https://a.test/x?page=2');
    expect(nextLink('<https://a.test/x?page=9>; rel="last"')).toBeNull();
    expect(nextLink('<https://a.test/x?page=9>; rel="nextish"')).toBeNull();
  });

  it('githubRateLimit reads the headers, and leaves out what is not there', () => {
    expect(githubRateLimit(new Headers())).toEqual({ limit: null, remaining: null, resetAt: null, retryAfter: null });
    expect(githubRateLimit(new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': RESET, 'retry-after': 'soon' }))).toEqual({ limit: null, remaining: 0, resetAt: '2026-10-17T21:14:00.000Z', retryAfter: null });
  });

  it('rateLimitWords: plain words for each case', () => {
    const r = (o) => ({ limit: null, remaining: null, resetAt: null, retryAfter: null, ...o });
    expect(rateLimitWords('GitHub', r({ remaining: 0 }), NOW)).toBe("GitHub's limit for this sign-in is used up; it resets soon.");
    expect(rateLimitWords('GitHub', r({ remaining: 0, resetAt: '2026-10-17T23:30:00Z' }), NOW)).toBe("GitHub's limit for this sign-in is used up; it resets at 23:30 UTC (in about 2 hours).");
    expect(rateLimitWords('GitHub', r({ remaining: 0, resetAt: '2026-10-17T21:00:00Z' }), NOW)).toBe("GitHub's limit for this sign-in is used up; it resets at 21:00 UTC (now).");
    expect(rateLimitWords('Forgejo', r({ retryAfter: 1 }), NOW)).toBe('Forgejo asked cornfield to slow down; try again in 1 second.');
    expect(rateLimitWords('Forgejo', r({ retryAfter: 600 }), NOW)).toBe('Forgejo asked cornfield to slow down; try again in about 10 minutes.');
    expect(rateLimitWords('Forgejo', r({}), NOW)).toBe('Forgejo did not say how many calls are left.');
    expect(rateLimitWords('GitHub', r({ remaining: 7 }), NOW)).toBe('7 GitHub calls left.');
  });
});
