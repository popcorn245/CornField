/**
 * @vitest-environment node
 *
 * The Forgejo adapter (server/forge-forgejo.js): the forge contract over recorded Forgejo answers
 * (test/fixtures/forge/forgejo.json), then what is Forgejo's own: where its API is, its token header, its three
 * permission levels, Link and X-Total-Count paging, checks that are commit statuses and cannot be re-run, a merge that
 * answers nothing, a file read raw. Every request goes to a fake forge on loopback; no token is real and nothing
 * leaves the machine. The recordings are hand-written in Forgejo's shapes: none was captured from an instance.
 */
import { describe, it, expect, afterEach } from 'vitest';
// @ts-expect-error plain JS module, no declarations
import { createForge, FORGE_METHODS } from '../../server/forge.js';
// @ts-expect-error plain JS module, no declarations
import { forgejoApiUrl } from '../../server/forge-forgejo.js';
// @ts-expect-error plain JS module, no declarations
import { rateLimitWords, MAX_PAGES } from '../../server/forge-http.js';
import { fakeForge, recordings } from './fake-forge.js';
import { forgeContract, forgeError, TOKEN } from './forge-contract.js';

// A merge answers an empty 200, and the pull request read afterwards is the merged one
const recorded = recordings('forgejo');
let merged = false;
const pull12 = recorded['GET /repos/owner/name/pulls/12'].body;
const withMerge = {
  ...recorded,
  'POST /repos/owner/name/pulls/12/merge': () => { merged = true; return { status: 200 }; },
  'GET /repos/owner/name/pulls/12': () => ({ body: merged ? { ...pull12, state: 'closed', merged: true, merged_at: '2026-10-17T11:30:00Z', merge_commit_sha: 'fff0000000000000000000000000000000000000' } : pull12 }),
};

forgeContract({ name: 'Forgejo', type: 'forgejo', recordings: withMerge, canRerun: false, maintainerPermission: 'admin' });

describe('the Forgejo adapter', () => {
  let fake;
  afterEach(async () => { await fake?.close(); fake = undefined; });
  const forgeOn = async (routes, opts = {}) => {
    fake = await fakeForge(routes);
    return createForge({ type: 'forgejo', url: 'https://git.example.org', repo: 'owner/name' }, { token: TOKEN, apiUrl: fake.url, ...opts });
  };

  it('has every call of the interface', async () => {
    const forge = await forgeOn({});
    for (const m of FORGE_METHODS) expect(typeof forge[m], m).toBe('function');
    expect(Object.isFrozen(forge)).toBe(true);
  });

  it('finds the API under the instance, and under a path when it is served from one', () => {
    expect(forgejoApiUrl('https://git.example.org')).toBe('https://git.example.org/api/v1');
    expect(forgejoApiUrl('https://git.example.org/')).toBe('https://git.example.org/api/v1');
    expect(forgejoApiUrl('https://example.org/forgejo/')).toBe('https://example.org/forgejo/api/v1');
    expect(forgejoApiUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000/api/v1');
    for (const bad of [undefined, '', 'git.example.org', 'ftp://git.example.org']) expect(() => forgejoApiUrl(bad), String(bad)).toThrow('forge.url is required for Forgejo');
  });

  it('asks the instance\'s own /api/v1, including the path it is served from', async () => {
    fake = await fakeForge({ 'GET /forgejo/api/v1/user': { body: { id: 1, login: 'maintainer-one' } } });
    const forge = createForge({ type: 'forgejo', url: `${fake.url}/forgejo`, repo: 'owner/name' }, { token: TOKEN });
    expect((await forge.me()).login).toBe('maintainer-one');
    expect(fake.requests.map((r) => r.url)).toEqual(['/forgejo/api/v1/user']);
  });

  it('needs a url, which Forgejo has no default for', () => {
    expect(() => createForge({ type: 'forgejo', repo: 'owner/name' }, { token: TOKEN })).toThrow('forge.url is required for Forgejo');
  });

  it('sends Forgejo\'s token header, not a Bearer one, and asks for JSON', async () => {
    const forge = await forgeOn({ 'GET /user': { body: { id: 1, login: 'maintainer-one' } } });
    await forge.me();
    const h = fake.requests[0].headers;
    expect(h.authorization).toBe(`token ${TOKEN}`);
    expect(h.accept).toBe('application/json');
    expect(h['x-github-api-version']).toBeUndefined();
  });

  it('sends no Authorization header without a token', async () => {
    const forge = await forgeOn({ 'GET /repos/owner/name/branches?limit=50': { body: [] } }, { token: null });
    await forge.branches();
    expect(fake.requests[0].headers.authorization).toBeUndefined();
  });

  it('leaves a missing full name null, and reads the signed-in user once', async () => {
    const forge = await forgeOn({ 'GET /user': { body: { id: 7, login: 'maintainer-one', full_name: '' } } });
    expect(await forge.me()).toEqual({ id: '7', login: 'maintainer-one', name: null, url: null, avatarUrl: null });
    await forge.me();
    expect(fake.requests).toHaveLength(1);
  });

  it('knows three levels of permission: the signed-in user\'s own come from the repo (admin, push, pull)', async () => {
    const repo = (permissions) => ({ body: { permissions } });
    const forge = await forgeOn({
      'GET /user': { body: { id: 1, login: 'maintainer-one' } },
      'GET /repos/owner/admin': repo({ admin: true, push: true, pull: true }),
      'GET /repos/owner/writer': repo({ admin: false, push: true, pull: true }),
      'GET /repos/owner/reader': repo({ admin: false, push: false, pull: true }),
      'GET /repos/owner/hidden': repo({ admin: false, push: false, pull: false }),
      'GET /repos/owner/bare': { body: { id: 5 } },
    });
    const asked = ['admin', 'writer', 'reader', 'hidden', 'bare', 'missing'];
    expect(await Promise.all(asked.map((r) => forge.permission(`owner/${r}`, 'maintainer-one')))).toEqual(['admin', 'write', 'read', 'none', 'none', 'none']);
    expect(fake.requests.filter((r) => r.url === '/user')).toHaveLength(1);
  });

  it('reads another user\'s level from the collaborator endpoint: owner and admin administer, anything unknown is none', async () => {
    const level = (permission) => ({ body: { permission, role_name: permission } });
    const forge = await forgeOn({
      'GET /user': { body: { id: 1, login: 'maintainer-one' } },
      'GET /repos/owner/name/collaborators/owner-five/permission': level('owner'),
      'GET /repos/owner/name/collaborators/admin-six/permission': level('admin'),
      'GET /repos/owner/name/collaborators/writer-seven/permission': level('write'),
      'GET /repos/owner/name/collaborators/reader-eight/permission': level('read'),
      'GET /repos/owner/name/collaborators/none-nine/permission': level('none'),
      'GET /repos/owner/name/collaborators/odd-ten/permission': level('maintain'),
    });
    const people = ['owner-five', 'admin-six', 'writer-seven', 'reader-eight', 'none-nine', 'odd-ten'];
    expect(await Promise.all(people.map((p) => forge.permission('owner/name', p)))).toEqual(['admin', 'admin', 'write', 'read', 'none', 'none']);
  });

  it('does not guess when Forgejo will not say: only a repo admin may ask about someone else', async () => {
    const forge = await forgeOn({
      'GET /user': { body: { id: 2, login: 'writer-seven' } },
      'GET /repos/owner/name/collaborators/reader-two/permission': { status: 403, body: { message: 'Only admins can query all permissions, repo admins can query all repo permissions, collaborators can query only their own.' } },
    });
    const err = await forgeError(() => forge.permission('owner/name', 'reader-two'), 'forbidden');
    expect(err.message).toBe('Forgejo does not let this sign-in do that to reader-two\'s permission on owner/name. Forgejo said: "Only admins can query all permissions, repo admins can query all repo permissions, collaborators can query only their own."');
  });

  it('lists issues only (not pull requests), with the labels and state asked for', async () => {
    const issue = (number, extra = {}) => ({ number, title: `t${number}`, state: 'open', user: { login: 'a' }, labels: [], comments: 0, html_url: `https://git.example.org/owner/name/issues/${number}`, ...extra });
    const forge = await forgeOn({
      'GET /repos/owner/name/issues?state=closed&type=issues&limit=50&labels=a%2Cb+c': { body: [issue(1), issue(2, { pull_request: { merged: false } }), issue(3, { labels: ['plain'] })] },
    });
    const issues = await forge.issues({ state: 'closed', labels: ['a', 'b c'] });
    expect(issues.map((i) => i.number)).toEqual([1, 3]);
    expect(issues[1].labels).toEqual(['plain']);
  });

  it('reads a draft from its flag or its WIP title, and a merged one from either of two fields', async () => {
    const pr = (number, extra) => ({ number, title: `t${number}`, state: 'open', user: { username: 'older-api' }, head: { ref: 'h', sha: 's' }, base: { ref: 'main' }, ...extra });
    const forge = await forgeOn({
      'GET /repos/owner/name/pulls?state=all&limit=50': { body: [
        pr(1, { draft: true }), pr(2, { title: 'WIP: not yet' }), pr(3, { title: '[WIP] not yet' }), pr(4, { title: 'Wipe the floor' }),
        pr(5, { state: 'closed', merged: true }), pr(6, { state: 'closed', merged_at: '2026-10-17T11:30:00Z' }), pr(7, { state: 'closed' }),
      ] },
    });
    const pulls = await forge.pulls({ state: 'all' });
    expect(pulls.map((p) => [p.number, p.draft, p.state])).toEqual([
      [1, true, 'open'], [2, true, 'open'], [3, true, 'open'], [4, false, 'open'], [5, false, 'merged'], [6, false, 'merged'], [7, false, 'closed'],
    ]);
    expect(pulls[0].author).toEqual({ login: 'older-api', url: null });
  });

  it('maps every commit status Forgejo knows, under its `status` field (older ones say `state`)', async () => {
    const forge = await forgeOn({
      'GET /repos/owner/name/commits/feature/x/status?limit=50': { body: { statuses: [
        { context: 'a', status: 'success' }, { context: 'b', status: 'pending' }, { context: 'c', status: 'failure', target_url: 'https://ci.example.com/3' },
        { context: 'd', status: 'error' }, { context: 'e', status: 'warning' }, { context: 'f', status: 'skipped' }, { context: 'g', state: 'success' }, { context: 'h', status: 'surprise' },
      ] } },
    });
    const checks = await forge.checks('feature/x');
    expect(checks.map((c) => [c.id, c.state])).toEqual([
      ['status:a', 'success'], ['status:b', 'running'], ['status:c', 'failure'], ['status:d', 'failure'],
      ['status:e', 'failure'], ['status:f', 'skipped'], ['status:g', 'success'], ['status:h', 'queued'],
    ]);
    expect(checks[2].url).toBe('https://ci.example.com/3');
    expect(checks[0].url).toBeNull();
    expect(checks.some((c) => c.rerunnable)).toBe(false);
  });

  it('does not count a warning as green, so a merge waits on it', async () => {
    const forge = await forgeOn({
      'GET /repos/owner/name/pulls/12': { body: { number: 12, state: 'open', draft: false, head: { sha: 'abc' } } },
      'GET /repos/owner/name/commits/abc/status?limit=50': { body: { statuses: [{ context: 'ci', status: 'success' }, { context: 'style', status: 'warning' }] } },
    });
    expect((await forgeError(() => forge.merge(12, { onlyIfGreen: true }), 'not-green')).message).toBe('Pull request #12 is not green: style failed.');
    expect(fake.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('cannot re-run anything: even a check made rerunnable by hand is refused before the forge is asked', async () => {
    const forge = await forgeOn({});
    const err = await forgeError(() => forge.rerun({ id: 'status:ci', name: 'ci', state: 'failure', url: null, rerunnable: true }), 'invalid');
    expect(err.message).toBe('ci cannot be re-run from cornfield; re-run it on Forgejo.');
    expect(fake.requests).toEqual([]);
  });

  it('merges with the method asked for and the head the checks ran on, and says so when Forgejo refuses because the head moved', async () => {
    const pr = { number: 12, state: 'open', draft: false, head: { ref: 'f', sha: 'abc' }, base: { ref: 'main' } };
    const forge = await forgeOn({
      'GET /repos/owner/name/pulls/12': { body: pr },
      'GET /repos/owner/name/commits/abc/status?limit=50': { body: { statuses: [{ context: 'ci', status: 'success' }] } },
      'POST /repos/owner/name/pulls/12/merge': (req) => (JSON.parse(req.body).Do === 'squash'
        ? { status: 200 }
        : { status: 409, body: { message: 'Head branch was modified. Review and try the merge again.' } }),
    });
    // Forgejo says nothing of the commit it made; without a merge_commit_sha the head that landed is answered
    expect(await forge.merge(12, { onlyIfGreen: true, method: 'squash' })).toEqual({ sha: 'abc' });
    const post = fake.requests.find((r) => r.method === 'POST');
    expect(JSON.parse(post.body)).toEqual({ Do: 'squash', head_commit_id: 'abc' });
    const moved = await forgeError(() => forge.merge(12, { onlyIfGreen: true }), 'conflict');
    expect(moved.message).toBe('Forgejo refused: pull request #12 in owner/name cannot be changed that way now. Forgejo said: "Head branch was modified. Review and try the merge again."');
  });

  it('answers a landed merge as landed even when reading the pull request back fails', async () => {
    let reads = 0;
    const forge = await forgeOn({
      'GET /repos/owner/name/pulls/12': () => (++reads <= 2 ? { body: { number: 12, state: 'open', draft: false, head: { sha: 'abc' } } } : { status: 502, body: {} }),
      'GET /repos/owner/name/commits/abc/status?limit=50': { body: { statuses: [{ context: 'ci', status: 'success' }] } },
      'POST /repos/owner/name/pulls/12/merge': { status: 200 },
    });
    expect(await forge.merge(12, { onlyIfGreen: true })).toEqual({ sha: 'abc' });
    expect(reads).toBe(3);
  });

  it('sends the merge methods under Forgejo\'s names, and never a force', async () => {
    const forge = await forgeOn({
      'GET /repos/owner/name/pulls/12': { body: { number: 12, state: 'open', draft: false, head: { sha: 'abc' } } },
      'GET /repos/owner/name/commits/abc/status?limit=50': { body: { statuses: [{ context: 'ci', status: 'success' }] } },
      'POST /repos/owner/name/pulls/12/merge': { status: 200 },
    });
    for (const method of ['merge', 'squash', 'rebase']) await forge.merge(12, { onlyIfGreen: true, method });
    const sent = fake.requests.filter((r) => r.method === 'POST').map((r) => JSON.parse(r.body));
    expect(sent.map((b) => b.Do)).toEqual(['merge', 'squash', 'rebase']);
    expect(sent.every((b) => Object.keys(b).sort().join() === 'Do,head_commit_id')).toBe(true);
  });

  it('does not count a commit with no statuses as green', async () => {
    const forge = await forgeOn({
      'GET /repos/owner/name/pulls/12': { body: { number: 12, state: 'open', draft: false, head: { sha: 'abc' } } },
      'GET /repos/owner/name/commits/abc/status?limit=50': { body: { state: 'pending', total_count: 0, statuses: [] } },
    });
    expect((await forgeError(() => forge.merge(12, { onlyIfGreen: true }), 'not-green')).message).toBe('Pull request #12 is not green: it has no checks.');
    expect(fake.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('reads a branch\'s head from its commit id, and a file raw with the ref and path escaped, slashes kept', async () => {
    const forge = await forgeOn({
      'GET /repos/owner/name/branches?limit=50': { body: [{ name: 'main', commit: { id: 'aaa' }, protected: true }, { name: 'old', commit: { sha: 'bbb' } }, { name: 'bare' }] },
      'GET /repos/owner/name/raw/docs/a%20b/c%23d.json?ref=feature%2Fx%23y': { body: 'hi' },
    });
    expect(await forge.branches()).toEqual([{ name: 'main', sha: 'aaa', protected: true }, { name: 'old', sha: 'bbb', protected: false }, { name: 'bare', sha: '', protected: false }]);
    expect(await forge.file('feature/x#y', 'docs/a b/c#d.json')).toBe('hi');
  });

  it('answers a file as the text it is, even JSON, and null for a folder (which has no raw file)', async () => {
    const forge = await forgeOn({
      'GET /repos/owner/name/raw/list.json?ref=main': { headers: { 'content-type': 'application/json' }, body: '[1, 2]' },
      'GET /repos/owner/name/raw/empty.txt?ref=main': { headers: { 'content-type': 'text/plain' }, body: '' },
    });
    expect(await forge.file('main', 'list.json')).toBe('[1, 2]');
    expect(await forge.file('main', 'empty.txt')).toBe('');
    expect(await forge.file('main', 'docs')).toBeNull();
  });

  it('follows Link when its parts have no space between them, and keeps X-Total-Count to itself', async () => {
    const forge = await forgeOn({
      'GET /repos/owner/name/branches?limit=50': { headers: { link: '<{origin}/api/v1/repos/owner/name/branches?limit=50&page=2>; rel="next",<{origin}/api/v1/repos/owner/name/branches?limit=50&page=2>; rel="last"', 'x-total-count': '51' }, body: [{ name: 'a', commit: { id: '1' } }] },
      'GET /api/v1/repos/owner/name/branches?limit=50&page=2': { headers: { link: '<{origin}/api/v1/repos/owner/name/branches?limit=50&page=1>; rel="first",<{origin}/api/v1/repos/owner/name/branches?limit=50&page=1>; rel="prev"', 'x-total-count': '51' }, body: [{ name: 'b', commit: { id: '2' } }] },
    });
    expect((await forge.branches()).map((b) => b.name)).toEqual(['a', 'b']);
    expect(fake.requests).toHaveLength(2);
  });

  it('stops a listing at the limit without asking for more pages than it needs', async () => {
    const forge = await forgeOn({
      'GET /repos/owner/name/pulls?state=open&limit=50': { headers: { link: '<{origin}/api/v1/never>; rel="next"', 'x-total-count': '500' }, body: Array.from({ length: 50 }, (_, i) => ({ number: i + 1, title: 't', state: 'open', head: {}, base: {} })) },
    });
    expect(await forge.pulls({ limit: 10 })).toHaveLength(10);
    expect(fake.requests).toHaveLength(1);
  });

  it('stops at MAX_PAGES when the next link never ends', async () => {
    const forge = await forgeOn({
      'GET /repos/owner/name/branches?limit=50': { headers: { link: '<{origin}/repos/owner/name/branches?limit=50>; rel="next"' }, body: [{ name: 'b', commit: { id: 's' } }] },
    });
    expect(await forge.branches()).toHaveLength(MAX_PAGES);
  });

  it('never follows a next link to another origin, so the token stays with Forgejo; an instance behind a proxy that names itself otherwise says so', async () => {
    const forge = await forgeOn({
      'GET /repos/owner/name/branches?limit=50': { headers: { link: '<https://git.example.org/api/v1/repos/owner/name/branches?limit=50&page=2>; rel="next"' }, body: [{ name: 'main', commit: { id: 's' } }] },
    });
    const err = await forgeError(() => forge.branches(), 'unavailable');
    expect(err.message).toContain('the next page of the branches of owner/name is at https://git.example.org');
    expect(err.message).toContain('set forge.url to the address Forgejo calls itself');
    expect(fake.requests).toHaveLength(1);
  });

  it('does not follow a redirect, and says the repo has moved', async () => {
    const forge = await forgeOn({ 'GET /repos/owner/name/branches?limit=50': { status: 301, headers: { location: 'https://elsewhere.example.com/api/v1/repos/owner/new/branches' }, body: { message: 'Moved Permanently' } } });
    expect((await forgeError(() => forge.branches(), 'not-found')).message).toBe('Forgejo says the branches of owner/name has moved; check forge.repo in cornfield.config.js.');
  });

  it('sends no rate-limit headers, so there is nothing to report until an instance or its proxy says to slow down', async () => {
    const forge = await forgeOn({
      'GET /user': { body: { id: 1, login: 'm' } },
      'GET /repos/owner/name/branches?limit=50': { status: 429, headers: { 'retry-after': '40' }, body: 'Too Many Requests' },
      'GET /repos/owner/name/pulls/1': { status: 429, body: 'Too Many Requests' },
      'GET /repos/owner/name/pulls/2': { status: 403, body: { message: 'rate limit exceeded' } },
    });
    expect(forge.rateLimit()).toBeNull();
    await forge.me();
    expect(forge.rateLimit()).toEqual({ limit: null, remaining: null, resetAt: null, retryAfter: null });
    expect(rateLimitWords('Forgejo', forge.rateLimit())).toBe('Forgejo did not say how many calls are left.');
    const slow = await forgeError(() => forge.branches(), 'rate-limited');
    expect(slow.message).toBe('Forgejo asked cornfield to slow down; try again in 40 seconds.');
    expect(forge.rateLimit()).toMatchObject({ retryAfter: 40 });
    expect((await forgeError(() => forge.pull(1), 'rate-limited')).message).toBe('Forgejo asked cornfield to slow down; try again in 60 seconds.');
    expect((await forgeError(() => forge.pull(2), 'rate-limited')).message).toBe('Forgejo asked cornfield to slow down; try again in 60 seconds.');
  });

  it('says in words what every other refusal means, with Forgejo\'s own first line', async () => {
    const forge = await forgeOn({
      'GET /user': { status: 401, body: { message: 'user does not exist [uid: 0, name: ]', url: 'https://git.example.org/api/swagger' } },
      'GET /repos/owner/name/pulls/1': { status: 403, body: { message: 'user should have write permission\nmore detail' } },
      'GET /repos/owner/name/pulls/2': { status: 422, body: { message: '[]: Do: Required' } },
      'GET /repos/owner/name/pulls/3': { status: 502, body: 'Bad gateway' },
      'GET /repos/owner/name/pulls/4': { body: '<html>sign in</html>' },
    });
    expect((await forgeError(() => forge.me(), 'unauthorized')).message).toBe('Forgejo did not accept the sign-in; sign in again.');
    expect((await forgeError(() => forge.pull(1), 'forbidden')).message).toBe('Forgejo does not let this sign-in do that to pull request #1 in owner/name. Forgejo said: "user should have write permission"');
    expect((await forgeError(() => forge.pull(2), 'invalid')).message).toBe('Forgejo did not accept the request for pull request #2 in owner/name. Forgejo said: "[]: Do: Required"');
    expect((await forgeError(() => forge.pull(3), 'unavailable')).message).toBe('Forgejo could not answer for pull request #3 in owner/name (HTTP 502); try again in a minute.');
    expect((await forgeError(() => forge.pull(4), 'unavailable')).message).toBe('Forgejo answered for pull request #4 in owner/name with something that is not JSON.');
    expect((await forgeError(() => forge.pull(5), 'not-found')).message).toBe('Forgejo has no pull request #5 in owner/name, or this sign-in cannot see it.');
  });

  it('gives up on a forge that does not answer in time, or at all', async () => {
    const forge = await forgeOn({ 'GET /user': { hang: true } }, { timeoutMs: 100 });
    expect((await forgeError(() => forge.me(), 'unavailable')).message).toBe('Forgejo did not answer within 1 second; try again in a minute.');
    const port = new URL(fake.url).port;
    await fake.close();
    fake = undefined;
    const gone = createForge({ type: 'forgejo', url: 'https://git.example.org', repo: 'owner/name' }, { apiUrl: `http://127.0.0.1:${port}` });
    expect((await forgeError(() => gone.me(), 'unavailable')).message).toBe('Forgejo did not answer; try again in a minute.');
  });

  it('asks for the signed-in user again after a failure', async () => {
    let calls = 0;
    const forge = await forgeOn({ 'GET /user': () => (++calls === 1 ? { status: 502, body: {} } : { body: { id: 1, login: 'maintainer-one' } }) });
    await forgeError(() => forge.me(), 'unavailable');
    expect((await forge.me()).login).toBe('maintainer-one');
  });

  it('marks an account the forge calls a Bot, and its Actions user, and only those', async () => {
    const pull = (number, user) => ({ number, title: `t${number}`, state: 'open', user, labels: [], head: { ref: 'b', sha: 's' }, base: { ref: 'main' }, html_url: 'u', body: `Closes #${number}` });
    const forge = await forgeOn({
      'GET /repos/owner/name/pulls?state=all&limit=50': {
        body: [
          pull(1, { id: 7, login: 'renovate', type: 'Bot' }),
          pull(2, { id: -2, login: 'forgejo-actions' }),
          pull(3, { id: 9, login: 'agent-four', type: 'User' }),
          pull(4, { id: 10, login: 'someone[bot]' }),
        ],
      },
    });
    const pulls = await forge.pulls({ state: 'all' });
    expect(pulls.map((p) => p.author)).toEqual([
      { login: 'renovate', url: null, bot: true },
      { login: 'forgejo-actions', url: null, bot: true },
      { login: 'agent-four', url: null },
      { login: 'someone[bot]', url: null }, // the name is the agent rule's to read, not the adapter's
    ]);
    expect(pulls[0].body).toBe('Closes #1');
  });
});
