/**
 * The forge contract: what every adapter answers through the interface (server/forge.js), run against a fake
 * forge (test/server/fake-forge.js) that serves that forge's recorded answers (test/fixtures/forge/<name>.json).
 *
 * Each forge's recordings describe the same small world, so the answers here are the same for every adapter:
 *   - the repo owner/name; the signed-in user maintainer-one (id 1001), who maintains it (administers it, where the
 *     forge has no maintain level); reader-two reads it;
 *     nobody-three is no collaborator
 *   - open issues #5 (labels v1, server) and #3 (on a second page); open PR #12 is not among them; #2 is closed
 *   - open PRs #13 (head def…, a failed lint and a running test) and #12 (head abc…, green); #14 is a draft;
 *     closed: #9 merged, #8 not
 *   - #12 changes four files and has two comments; a comment posted to it answers id 9003
 *   - branches main (protected) and feature/meals; docs/specs/proposals/0013-meals.json at abc…
 *   - tags v0.1.0, nightly and v0.2.0 (made 2026-10-12T09:00:00Z; v9.9.9 is no tag); a release draft posted for v0.3.0
 *     answers id 7001 and is a draft
 *   - the writes of the pipeline's steps (`writeRoutes`): a new branch, file, pull request and issue are made; a branch or a
 *     file that is there already is refused. They answer by what they were sent, the same for both forges
 *
 * An adapter's own test calls `forgeContract({ name, type, recordings })`; what only one forge does (its URLs, its
 * headers, its rate limits) is tested beside it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
// @ts-expect-error plain JS module, no declarations
import { createForge, ForgeError } from '../../server/forge.js';
import { fakeForge } from './fake-forge.js';

const SHA_GREEN = 'abc0000000000000000000000000000000000000';
const SHA_RED = 'def0000000000000000000000000000000000000';
const TOKEN = 'test-token-not-a-secret';

/** What the forges answer to the writes of the pipeline's steps, in each forge's shapes */
function writeRoutes(type) {
  const github = type === 'github';
  const base = github ? 'https://github.example.com' : 'https://forgejo.example.com';
  const json = (req) => JSON.parse(req.body);
  const pull = (number, title, head, into, draft) => ({ number, title, state: 'open', draft: github ? draft : false, user: { login: 'maintainer-one', html_url: `${base}/maintainer-one` }, labels: [], head: { ref: head, sha: 'eee0000000000000000000000000000000000000' }, base: { ref: into }, html_url: `${base}/owner/name/pulls/${number}`, created_at: '2026-10-19T10:00:00Z', updated_at: '2026-10-19T10:00:00Z', merged_at: null });
  const taken = { status: 422, body: { message: 'Validation Failed' } };
  const make = (path) => (req) => (json(req).branch === 'feature/meals' && path.endsWith('0013-meals.json') ? taken : { status: 201, body: { commit: { sha: 'ccc0000000000000000000000000000000000000' }, content: { path } } });
  const verb = github ? 'PUT' : 'POST';
  return {
    ...(github
      ? { 'POST /repos/owner/name/git/refs': (req) => (json(req).ref === 'refs/heads/feature/meals' ? taken : { status: 201, body: { ref: json(req).ref, object: { sha: json(req).sha } } }) }
      : { 'POST /repos/owner/name/branches': (req) => (json(req).new_branch_name === 'feature/meals' ? { status: 409, body: { message: 'branch already exists' } } : { status: 201, body: { name: json(req).new_branch_name, commit: { id: '0000000000000000000000000000000000000001' } } }) }),
    [`${verb} /repos/owner/name/contents/docs/specs/proposals/7-new.json`]: make('docs/specs/proposals/7-new.json'),
    [`${verb} /repos/owner/name/contents/docs/specs/proposals/0013-meals.json`]: make('docs/specs/proposals/0013-meals.json'),
    'POST /repos/owner/name/pulls': (req) => ({ status: 201, body: pull(30, json(req).title, json(req).head, json(req).base, json(req).draft === true) }),
    'POST /repos/owner/name/issues': (req) => ({ status: 201, body: { number: 31, title: json(req).title, state: 'open', user: { login: 'maintainer-one', html_url: `${base}/maintainer-one` }, labels: [], body: json(req).body, comments: 0, html_url: `${base}/owner/name/issues/31`, created_at: '2026-10-19T10:00:00Z', updated_at: '2026-10-19T10:00:00Z', closed_at: null } }),
  };
}

/** Calls `fn`, expects a ForgeError with `code`, and answers it */
export async function forgeError(fn, code) {
  let caught;
  try { await fn(); } catch (err) { caught = err; }
  expect(caught, `expected a ForgeError ${code}`).toBeInstanceOf(ForgeError);
  expect(caught.code, caught.message).toBe(code);
  return caught;
}

/**
 * @param {{ name: string, type: 'github' | 'forgejo', recordings: Record<string, any>, canRerun?: boolean, maintainerPermission?: 'maintain' | 'admin' }} opts
 *   `canRerun: false` for a forge whose API cannot re-run a check with a user's token: then none is `rerunnable`;
 *   `maintainerPermission: 'admin'` for a forge with no `maintain` level: its recordings make maintainer-one an admin
 */
export function forgeContract({ name, type, recordings, canRerun = true, maintainerPermission = 'maintain' }) {
  describe(`the forge contract: ${name}`, () => {
    let fake;
    let forge;
    beforeAll(async () => { fake = await fakeForge({ ...recordings, ...writeRoutes(type) }); });
    afterAll(async () => { await fake.close(); });
    beforeEach(() => {
      fake.requests.length = 0;
      forge = createForge({ type, url: fake.url, repo: 'owner/name' }, { token: TOKEN, apiUrl: fake.url });
    });
    const sent = (method) => fake.requests.filter((r) => r.method === method);

    it('says which forge and repo it is', () => {
      expect(forge.forge).toBe(type);
      expect(forge.repo).toBe('owner/name');
    });

    it('me(): the signed-in user, asked with their token', async () => {
      expect(await forge.me()).toMatchObject({ id: '1001', login: 'maintainer-one', name: 'Maintainer One' });
      expect(fake.requests[0].headers.authorization).toMatch(new RegExp(`^\\w+ ${TOKEN}$`));
      expect(fake.requests[0].headers['user-agent']).toBe('cornfield');
    });

    it('permission(): the signed-in user, a reader, and someone who is no collaborator', async () => {
      expect(await forge.permission('owner/name', 'maintainer-one')).toBe(maintainerPermission);
      expect(await forge.permission('owner/name', 'Maintainer-One')).toBe(maintainerPermission);
      expect(await forge.permission('owner/name', 'reader-two')).toBe('read');
      expect(await forge.permission('owner/name', 'nobody-three')).toBe('none');
    });

    it('issues(): open by default, every page, pull requests left out', async () => {
      const issues = await forge.issues();
      expect(issues.map((i) => i.number)).toEqual([5, 3]);
      expect(issues[0]).toMatchObject({ title: 'Sign-in', state: 'open', author: { login: 'maintainer-one' }, labels: ['v1', 'server'], comments: 1, createdAt: '2026-10-16T10:00:00Z', closedAt: null });
      expect(issues[0].url).toMatch(/\/owner\/name\/issues\/5$/);
      expect(issues[1].author).toBeNull();
    });

    it('issues(): a limit, labels, and closed ones', async () => {
      expect((await forge.issues({ limit: 1 })).map((i) => i.number)).toEqual([5]);
      const labelled = await forge.issues({ state: 'all', labels: ['v1', 'server'] });
      expect(labelled.map((i) => [i.number, i.state])).toEqual([[5, 'open'], [2, 'closed']]);
      expect(labelled[1].closedAt).toBe('2026-10-15T09:00:00Z');
    });

    it('pulls(): open and closed, a merged one told apart, a limit', async () => {
      const open = await forge.pulls();
      expect(open.map((p) => p.number)).toEqual([13, 12]);
      expect(open[1]).toMatchObject({ title: 'Meals page', state: 'open', draft: false, author: { login: 'agent-four' }, head: { ref: 'feature/meals', sha: SHA_GREEN }, base: { ref: 'main' }, mergedAt: null });
      expect(open[0].labels).toEqual(['agent']);
      expect((await forge.pulls({ state: 'closed' })).map((p) => [p.number, p.state])).toEqual([[9, 'merged'], [8, 'closed']]);
      expect((await forge.pulls({ limit: 1 })).map((p) => p.number)).toEqual([13]);
    });

    it('pull(): one, with its head', async () => {
      expect(await forge.pull(12)).toMatchObject({ number: 12, state: 'open', head: { sha: SHA_GREEN } });
      expect((await forge.pull(9)).state).toBe('merged');
      expect((await forge.pull(14)).draft).toBe(true);
      await forgeError(() => forge.pull(404), 'not-found');
    });

    it('pullFiles(): added, modified, renamed (with where it was) and removed', async () => {
      expect(await forge.pullFiles(12)).toEqual([
        { path: 'docs/specs/proposals/0013-meals.json', status: 'added', previousPath: null, additions: 40, deletions: 0 },
        { path: 'server/server.js', status: 'modified', previousPath: null, additions: 3, deletions: 1 },
        { path: 'server/meals.js', status: 'renamed', previousPath: 'server/food.js', additions: 0, deletions: 0 },
        { path: 'server/old.js', status: 'removed', previousPath: null, additions: 0, deletions: 12 },
      ]);
    });

    it('comments(): oldest first, with their text as written', async () => {
      const comments = await forge.comments(12);
      expect(comments.map((c) => [c.id, c.author?.login])).toEqual([['9001', 'agent-four'], ['9002', 'maintainer-one']]);
      expect(comments[1].body).toContain('```cornfield-review\n');
      expect(comments[1]).toMatchObject({ createdAt: '2026-10-17T10:20:00Z', updatedAt: '2026-10-17T10:25:00Z' });
    });

    it('comment(): posts the body as JSON and answers the comment', async () => {
      const posted = await forge.comment(12, 'Approved.');
      expect(posted).toMatchObject({ id: '9003', body: 'Approved.', author: { login: 'maintainer-one' } });
      const [post] = sent('POST');
      expect(post.headers['content-type']).toBe('application/json');
      expect(JSON.parse(post.body)).toEqual({ body: 'Approved.' });
    });

    it('checks(): every check on a commit, in the interface\'s states', async () => {
      const green = await forge.checks(SHA_GREEN);
      expect(green.length).toBeGreaterThan(0);
      expect(green.every((c) => c.state === 'success')).toBe(true);
      const red = await forge.checks(SHA_RED);
      expect(red.map((c) => [c.name, c.state])).toEqual([['lint', 'failure'], ['test', 'running']]);
      expect(red.find((c) => c.name === 'lint').rerunnable).toBe(canRerun);
      expect(red.find((c) => c.name === 'test').rerunnable).toBe(false);
    });

    it.skipIf(canRerun)('rerun(): this forge re-runs nothing, so every check is refused before the forge is asked', async () => {
      const lint = (await forge.checks(SHA_RED)).find((c) => c.name === 'lint');
      fake.requests.length = 0;
      await forgeError(() => forge.rerun(lint), 'invalid');
      expect(fake.requests).toEqual([]);
    });

    it.runIf(canRerun)('rerun(): a failed check runs again; one that cannot be is refused before the forge is asked', async () => {
      const lint = (await forge.checks(SHA_RED)).find((c) => c.name === 'lint');
      fake.requests.length = 0;
      await forge.rerun(lint);
      expect(sent('POST')).toHaveLength(1);
      await forgeError(() => forge.rerun({ ...lint, rerunnable: false }), 'invalid');
      expect(sent('POST')).toHaveLength(1);
    });

    it('merge(): a green, open, ready pull request lands at the head its checks ran on', async () => {
      expect(await forge.merge(12, { onlyIfGreen: true })).toEqual({ sha: 'fff0000000000000000000000000000000000000' });
      const writes = fake.requests.filter((r) => r.method !== 'GET');
      expect(writes).toHaveLength(1);
      expect(writes[0].body).toContain(SHA_GREEN);
    });

    it('merge(): nothing is written for one that is not green, a draft, merged already, or without onlyIfGreen', async () => {
      const notGreen = await forgeError(() => forge.merge(13, { onlyIfGreen: true }), 'not-green');
      expect(notGreen.message).toBe('Pull request #13 is not green: lint failed; test is still running.');
      expect((await forgeError(() => forge.merge(14, { onlyIfGreen: true }), 'conflict')).message).toContain('is a draft');
      expect((await forgeError(() => forge.merge(9, { onlyIfGreen: true }), 'conflict')).message).toContain('is merged');
      await forgeError(() => forge.merge(12, {}), 'invalid');
      await forgeError(() => forge.merge(12, { onlyIfGreen: 'yes' }), 'invalid');
      await forgeError(() => forge.merge(12, { onlyIfGreen: true, method: 'force' }), 'invalid');
      expect(fake.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    });

    it('issue(): one, with its text; a pull request at that number, and a number that is not there, are not-found', async () => {
      expect(await forge.issue(5)).toMatchObject({ number: 5, title: 'Sign-in', state: 'open', body: 'Sign in with the forge.\n', labels: ['v1'] });
      expect((await forgeError(() => forge.issue(12), 'not-found')).message).toContain('is a pull request');
      await forgeError(() => forge.issue(404), 'not-found');
    });

    it('createBranch(): a new branch where another is, never over one that is there', async () => {
      expect(await forge.createBranch('spec/7-new', { from: 'main' })).toEqual({ name: 'spec/7-new', sha: '0000000000000000000000000000000000000001' });
      const [write] = fake.requests.filter((r) => r.method === 'POST');
      expect(JSON.parse(write.body)).toEqual(type === 'github' ? { ref: 'refs/heads/spec/7-new', sha: '0000000000000000000000000000000000000001' } : { new_branch_name: 'spec/7-new', old_branch_name: 'main' });
      expect((await forgeError(() => forge.createBranch('feature/meals', { from: 'main' }), 'conflict')).message).toBe('The branch feature/meals is there already.');
    });

    it('createFile(): one new file as one commit, its text sent as base64; a file that is there is refused, not replaced', async () => {
      const text = '{ "version": 1, "title": "Caf\u00e9" }\n';
      expect(await forge.createFile({ branch: 'spec/7-new', path: 'docs/specs/proposals/7-new.json', content: text, message: 'Start a spec' })).toEqual({ sha: 'ccc0000000000000000000000000000000000000' });
      const [write] = fake.requests.filter((r) => r.method !== 'GET');
      expect(write.method).toBe(type === 'github' ? 'PUT' : 'POST');
      const body = JSON.parse(write.body);
      expect(Buffer.from(body.content, 'base64').toString('utf8')).toBe(text);
      expect(body).toMatchObject({ branch: 'spec/7-new', message: 'Start a spec' });
      expect(body.sha).toBeUndefined();
      await forgeError(() => forge.createFile({ branch: 'feature/meals', path: 'docs/specs/proposals/0013-meals.json', content: '{}', message: 'again' }), 'invalid');
    });

    it('createPull(): a draft one answers as a draft, an open one does not', async () => {
      const draft = await forge.createPull({ title: 'Spec: Meals', body: 'Refs #5', head: 'spec/7-new', base: 'main', draft: true });
      expect(draft).toMatchObject({ number: 30, draft: true, state: 'open', head: { ref: 'spec/7-new' }, base: { ref: 'main' } });
      const [write] = fake.requests.filter((r) => r.method === 'POST');
      expect(JSON.parse(write.body)).toMatchObject(type === 'github' ? { title: 'Spec: Meals', body: 'Refs #5', draft: true } : { title: 'WIP: Spec: Meals', body: 'Refs #5' });
      expect((await forge.createPull({ title: 'Ready', body: 'x', head: 'spec/7-new', base: 'main', draft: false })).draft).toBe(false);
    });

    it('createIssue(): an issue with its title and text', async () => {
      expect(await forge.createIssue({ title: 'Build: Meals', body: '- [ ] a node' })).toMatchObject({ number: 31, title: 'Build: Meals', body: '- [ ] a node', state: 'open' });
      expect(JSON.parse(sent('POST')[0].body)).toEqual({ title: 'Build: Meals', body: '- [ ] a node' });
    });

    it('refuses the arguments of a write that are not what the interface takes, before the forge is asked', async () => {
      await forgeError(() => forge.createBranch('../x', { from: 'main' }), 'invalid');
      await forgeError(() => forge.createBranch('a b', { from: 'main' }), 'invalid');
      await forgeError(() => forge.createBranch('x.lock', { from: 'main' }), 'invalid');
      await forgeError(() => forge.createBranch('/x', { from: 'main' }), 'invalid');
      await forgeError(() => forge.createBranch('x', {}), 'invalid');
      await forgeError(() => forge.createFile({ branch: 'x', path: '../secrets', content: 'a', message: 'm' }), 'invalid');
      await forgeError(() => forge.createFile({ branch: 'x', path: 'a/b.json', content: 1, message: 'm' }), 'invalid');
      await forgeError(() => forge.createFile({ branch: 'x', path: 'a/b.json', content: 'a', message: ' ' }), 'invalid');
      await forgeError(() => forge.createFile({ branch: 'x', path: 'a/b.json', content: 'x'.repeat(256 * 1024 + 1), message: 'm' }), 'invalid');
      await forgeError(() => forge.createPull({ title: 't', body: 'b', head: 'x', base: 'main' }), 'invalid');
      await forgeError(() => forge.createPull({ title: '', body: 'b', head: 'x', base: 'main', draft: true }), 'invalid');
      await forgeError(() => forge.createPull({ title: 't'.repeat(257), body: 'b', head: 'x', base: 'main', draft: true }), 'invalid');
      await forgeError(() => forge.createIssue({ title: '  ', body: 'b' }), 'invalid');
      await forgeError(() => forge.createIssue({ title: 't', body: 'b'.repeat(60001) }), 'invalid');
      await forgeError(() => forge.issue(0), 'invalid');
    });

    it('runs(): the latest workflow runs, newest first, every page, in the interface\'s states', async () => {
      const runs = await forge.runs();
      expect(runs.map((r) => [r.id, r.workflow, r.state])).toEqual([
        ['9003', 'deploy.yml', 'success'], ['9002', 'ci.yml', 'failure'], ['9001', 'deploy-media.yml', 'running'], ['9000', 'release.yml', 'cancelled'],
      ]);
      expect(runs[0]).toMatchObject({ title: 'Meals page (#12)', event: 'push', branch: 'main', sha: SHA_GREEN, actor: { login: 'maintainer-one' }, createdAt: '2026-10-18T12:00:05Z', updatedAt: '2026-10-18T12:04:00Z' });
      expect(runs[0].url).toMatch(/\/owner\/name\/actions\/runs\/\d+$/);
      expect(runs[2].actor).toBeNull();
      expect(sent('POST')).toEqual([]);
    });

    it('runs(): a limit stops the listing, and arguments that are not a limit are refused before the forge is asked', async () => {
      expect((await forge.runs({ limit: 2 })).map((r) => r.id)).toEqual(['9003', '9002']);
      fake.requests.length = 0;
      for (const bad of [0, -1, 1.5, '2', NaN]) await forgeError(() => forge.runs({ limit: bad }), 'invalid');
      await forgeError(() => forge.runs([]), 'invalid');
      expect(fake.requests).toEqual([]);
    });

    it('branches(): each with its head and whether it is protected', async () => {
      const branches = await forge.branches();
      expect([...branches].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: 'feature/meals', sha: SHA_GREEN, protected: false },
        { name: 'main', sha: '0000000000000000000000000000000000000001', protected: true },
      ]);
    });

    it('file(): the text at a ref, or null when it is not there', async () => {
      expect(JSON.parse(await forge.file(SHA_GREEN, 'docs/specs/proposals/0013-meals.json'))).toEqual({ version: 1, title: 'Meals' });
      expect(await forge.file(SHA_GREEN, 'docs/specs/proposals/0099-none.json')).toBeNull();
    });

    it('fileBytes(): the same file as bytes, or null when it is not there', async () => {
      const bytes = await forge.fileBytes(SHA_GREEN, 'docs/specs/proposals/0013-meals.json');
      expect(Buffer.isBuffer(bytes)).toBe(true);
      expect(JSON.parse(bytes.toString('utf8'))).toEqual({ version: 1, title: 'Meals' });
      expect(await forge.fileBytes(SHA_GREEN, 'docs/specs/proposals/0099-none.json')).toBeNull();
      await forgeError(() => forge.fileBytes(SHA_GREEN, '../secrets'), 'invalid');
    });

    it('defaultBranch(): the name of the repo\'s default branch', async () => {
      expect(await forge.defaultBranch()).toBe('main');
    });

    it('tags(): each with the commit it names, as the forge lists them', async () => {
      expect(await forge.tags()).toEqual([
        { name: 'v0.1.0', sha: '1110000000000000000000000000000000000000' },
        { name: 'nightly', sha: '3330000000000000000000000000000000000000' },
        { name: 'v0.2.0', sha: '2220000000000000000000000000000000000000' },
      ]);
    });

    it('tag(): the time of the commit a tag names, and not-found for one that is not there', async () => {
      expect(await forge.tag('v0.2.0')).toEqual({ name: 'v0.2.0', sha: '2220000000000000000000000000000000000000', date: expect.any(String) });
      expect(Date.parse((await forge.tag('v0.2.0')).date)).toBe(Date.parse('2026-10-12T09:00:00Z'));
      await forgeError(() => forge.tag('v9.9.9'), 'not-found');
    });

    it('createReleaseDraft(): posts a draft, never a published release, and answers it', async () => {
      const made = await forge.createReleaseDraft({ tag: 'v0.3.0', name: 'v0.3.0', body: '### server\n\n- Meals (#12)\n' });
      expect(made).toEqual({ id: '7001', url: expect.stringMatching(/^https:\/\/\w+\.example\.com\/owner\/name\/releases\//), draft: true });
      const writes = fake.requests.filter((r) => r.method !== 'GET');
      expect(writes).toHaveLength(1);
      expect(writes[0].method).toBe('POST');
      expect(writes[0].url).toMatch(/\/repos\/owner\/name\/releases$/);
      expect(JSON.parse(writes[0].body)).toEqual({ tag_name: 'v0.3.0', name: 'v0.3.0', body: '### server\n\n- Meals (#12)\n', draft: true, prerelease: false });
    });

    it('createReleaseDraft(): refuses what is not a tag name, a name or a body, before the forge is asked', async () => {
      for (const tag of ['', ' ', '-x', 'a b', 'v1..2', 'v1/', 'x'.repeat(101), null, 4]) await forgeError(() => forge.createReleaseDraft({ tag, name: 'n', body: 'b' }), 'invalid');
      await forgeError(() => forge.createReleaseDraft({ tag: 'v1', name: '  ', body: 'b' }), 'invalid');
      await forgeError(() => forge.createReleaseDraft({ tag: 'v1', name: 'n', body: 5 }), 'invalid');
      await forgeError(() => forge.createReleaseDraft({ tag: 'v1', name: 'n', body: 'x'.repeat(125_001) }), 'invalid');
      await forgeError(() => forge.createReleaseDraft(null), 'invalid');
      await forgeError(() => forge.tag('a b'), 'invalid');
      expect(fake.requests).toEqual([]);
    });

    it('refuses arguments that are not what the interface takes, before the forge is asked', async () => {
      for (const bad of [0, -1, 1.5, '12', NaN, null]) await forgeError(() => forge.pull(bad), 'invalid');
      await forgeError(() => forge.comment(12, '   '), 'invalid');
      await forgeError(() => forge.checks(''), 'invalid');
      await forgeError(() => forge.file(SHA_GREEN, '../secrets'), 'invalid');
      await forgeError(() => forge.file(SHA_GREEN, '/etc/passwd'), 'invalid');
      await forgeError(() => forge.file(SHA_GREEN, 'docs//x'), 'invalid');
      await forgeError(() => forge.issues({ state: 'merged' }), 'invalid');
      await forgeError(() => forge.issues({ limit: 0 }), 'invalid');
      await forgeError(() => forge.issues({ labels: ['a,b'] }), 'invalid');
      await forgeError(() => forge.permission('not a repo', 'x'), 'invalid');
      expect(fake.requests).toEqual([]);
    });
  });
}

export { SHA_GREEN, SHA_RED, TOKEN };

