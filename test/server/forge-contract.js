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
    beforeAll(async () => { fake = await fakeForge(recordings); });
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

