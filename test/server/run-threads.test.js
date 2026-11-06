/**
 * @vitest-environment node
 *
 * A thread for every run (issue #104, docs/agents.md#a-thread-for-every-run), on the engine itself: a fake forge that holds issues, pull
 * requests and comments and can edit a comment, a real SQLite store, and a clock wound by hand. Held here:
 *
 *   - a run asked for from a thread records it (`refs.thread`, and `thread.number`, the conversation its status comment is in)
 *   - the runner's reports are mirrored into that thread as ONE comment that is edited in place, on every transport (forge, push, pull)
 *   - the comment holds no `cornfield-run` block, no `/agent` command, no live mention or link: nothing it says can start or move a run, and
 *     the hand-written request scan, the follow and the trigger reader all find nothing in it
 *   - a run from a proposal shows its pull request in the proposal's thread once it opens
 *   - a comment someone deleted is not posted again; a forge that refuses is tried again at the next look; two looks at once post one comment
 *   - `agents.mirror: false` writes nothing
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { createRuns } from '../../server/agent-runs.js';
// @ts-expect-error plain JS module, no declarations
import { ForgeError } from '../../server/forge.js';
// @ts-expect-error plain JS module, no declarations
import { openStore } from '../../server/db.js';
// @ts-expect-error plain JS module, no declarations
import { formatRunStatus, isRunStatus, MIRROR_TAG } from '../../server/run-thread.js';
// @ts-expect-error plain JS module, no declarations
import { agentCommand } from '../../server/triggers.js';
// @ts-expect-error plain JS module, no declarations
import { readRunBlocks, runBlocksOf, formatRunComment } from '../../core/agent-contract.js';

const FOLDER = 'docs/specs/proposals';
const T0 = Date.parse('2026-11-05T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

const made = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of made.splice(0)) { d.db?.close(); fs.rmSync(d.dir, { recursive: true, force: true }); } });

function setup({ agents = {} } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-run-threads-'));
  const db = openStore(folder);
  made.push({ dir: folder, db });
  const clock = { now: T0 };
  const stamp = () => iso(clock.now);
  const world = {
    perms: { 'maintainer-one': 'admin', 'maintainer-two': 'maintain', 'runner-bot': 'write' },
    issues: new Set([12, 13, 14, 15]),
    comments: new Map(),
    next: 9000,
    pulls: [],
    specPulls: [{ number: 40, slug: '0040-meals' }],
    posts: [],
    edits: [],
    editFails: null,
    postFails: null,
    touched: new Map(),
  };
  const say = (number, login, body, extra = {}) => {
    const c = { id: String(world.next++), author: { login }, body, url: `https://forge.test/c/${world.next}`, createdAt: stamp(), updatedAt: stamp(), ...extra };
    world.comments.set(number, [...(world.comments.get(number) ?? []), c]);
    world.touched.set(number, stamp());
    return c;
  };
  const forgeAs = (login) => ({
    repo: 'owner/name',
    me: async () => ({ id: login === 'maintainer-one' ? 1001 : 1002, login }),
    permission: async (_repo, who) => world.perms[who] ?? 'none',
    issue: async (n) => { if (!world.issues.has(n)) throw new ForgeError('not an issue', { code: 'not-found' }); return { number: n, title: `Issue ${n}`, labels: [], body: '' }; },
    comment: async (n, body) => {
      if (world.postFails) throw world.postFails;
      world.posts.push({ n, login, body });
      const c = say(n, login, body);
      return { id: c.id, url: c.url };
    },
    editComment: async (id, body) => {
      if (world.editFails) throw world.editFails;
      world.edits.push({ id, login, body });
      for (const list of world.comments.values()) {
        const c = list.find((x) => x.id === id);
        if (c) { Object.assign(c, { body, updatedAt: stamp() }); return c; }
      }
      throw new ForgeError('no such comment', { code: 'not-found' });
    },
    comments: async (n) => world.comments.get(n) ?? [],
    changed: async () => [...world.touched].map(([number, updatedAt]) => ({ number, pull: false, labels: [], updatedAt })),
    pulls: async (q) => (q?.state === 'open' && q?.limit === undefined
      ? world.specPulls.map((s) => ({ number: s.number, title: 'Spec', state: 'open', draft: false, author: { login: 'maintainer-two' }, head: { sha: `${'a'.repeat(39)}${s.number % 10}`, ref: `spec/${s.slug}` }, url: `https://forge.test/pull/${s.number}` }))
      : world.pulls),
    pullFiles: async (n) => [{ path: `${FOLDER}/${world.specPulls.find((s) => s.number === n)?.slug ?? 'x'}.json`, status: 'added' }],
    file: async () => '{}',
    pull: async (n) => { const p = world.pulls.find((x) => x.number === n); if (!p) throw new ForgeError('no', { code: 'not-found' }); return p; },
    pullCommits: async () => [],
    checks: async () => [],
    branches: async () => [],
  });
  const auth = {
    store: async () => db,
    record: async ({ login, action, target, request = {}, status = null, answer = null }) => {
      db.prepare('INSERT INTO actions (at, login, action, target, request, status, answer) VALUES (?, ?, ?, ?, ?, ?, ?)').run(stamp(), login, action, target, JSON.stringify(request), status, answer === null ? null : JSON.stringify(answer));
    },
  };
  const cfg = { forge: { repo: 'owner/name' }, proposals: FOLDER, agents: { authors: [], labels: [], branchPrefixes: [], bots: true, transport: 'forge', maxOpen: 5, profiles: [], runners: ['runner-bot'], quietAfter: '24h', ...agents } };
  const logs = [];
  vi.spyOn(console, 'error').mockImplementation((m) => { logs.push(String(m)); });
  const runs = createRuns({ config: cfg, where: { proposals: FOLDER }, auth, now: () => clock.now });
  const limits = { auth, now: () => clock.now };
  const maintainer = (login = 'maintainer-one') => ({ forge: () => forgeAs(login), who: { login, userId: login === 'maintainer-one' ? '1001' : '1002' }, limits });
  const ask = async (body, login) => { const out = await runs.request(maintainer(login), { body }); await settle(); return out; };
  const wait = (ms) => { clock.now += ms; };
  const row = (id) => db.prepare('SELECT * FROM runs WHERE run_id = ?').get(id);
  const mirror = (id) => db.prepare('SELECT * FROM run_mirrors WHERE run_id = ?').get(id);
  /** A runner token for the push and pull transports (the engine takes it as the routes hand it) */
  const token = { id: 7, label: 'laptop', mintedBy: { login: 'maintainer-one', userId: '1001' } };
  return { runs, db, world, say, forgeAs, auth, cfg, logs, ask, wait, clock, row, mirror, token, maintainer, stamp };
}

const code = (extra = {}) => ({ kind: 'code', refs: { thread: 15 }, brief: 'Add the meals page.', ...extra });
const statusComments = (t, n) => (t.world.comments.get(n) ?? []).filter((c) => isRunStatus(c.body));
const prOf = (id, extra = {}) => ({ number: 77, title: 'Meals', body: `Cornfield-Run: ${id}\n`, state: 'open', draft: false, author: { login: 'runner-bot' }, head: { ref: 'agent/meals', sha: 'b'.repeat(40) }, base: { ref: 'main' }, url: 'https://forge.test/pull/77', createdAt: iso(T0 + 60_000), updatedAt: iso(T0 + 120_000), ...extra });

describe('a run records the thread it is about', () => {
  it('keeps the thread it was asked from, and says which conversation its status comment is in', async () => {
    const t = setup();
    const { run, request } = await t.ask(code());
    expect(request.refs).toEqual({ thread: 15 });
    expect(run).toMatchObject({ refs: { thread: 15 }, target: 15, thread: { number: 15, mirror: null } });
    expect(t.row(request.runId)).toMatchObject({ thread: 15, target: 15 });
    // an issue's and a proposal's runs are in the issue's and the spec pull request's conversation
    t.wait(10_000);
    expect((await t.ask({ kind: 'code', refs: { issue: 13 }, brief: '' })).run.thread.number).toBe(13);
    t.wait(10_000);
    expect((await t.ask({ kind: 'proposal', refs: { proposal: '0040-meals' }, brief: '' })).run.thread.number).toBe(40);
  });
});

describe('the status comment, on the forge transport', () => {
  it('is posted once the runner has said something, and edited in place after that: one comment, however many reports', async () => {
    const t = setup();
    const { request } = await t.ask(code());
    const id = request.runId;
    // the request is in the thread already: nothing more to say yet
    await t.runs.follow(t.forgeAs('maintainer-one'));
    expect(t.world.posts.filter((p) => isRunStatus(p.body))).toEqual([]);

    t.wait(5_000);
    t.say(15, 'runner-bot', formatRunComment(id, { state: 'claimed' }));
    t.say(15, 'runner-bot', formatRunComment(id, { state: 'working', note: 'Reading the code.' }));
    const out = await t.runs.follow(t.forgeAs('maintainer-two'));
    expect(out.mirrored).toBe(1);
    const [first] = statusComments(t, 15);
    // written by whoever's forge looked, as a person (never a token of cornfield's own)
    expect(first.author.login).toBe('maintainer-two');
    expect(first.body).toContain(`**Run \`${id}\`: Working**`);
    expect(first.body).toContain('> Reading the code.');
    expect(t.mirror(id)).toMatchObject({ number: 15, comment_id: first.id, gone: 0, busy: null });

    // nothing moved: nothing is written
    expect((await t.runs.follow(t.forgeAs('maintainer-one'))).mirrored).toBe(0);
    expect(t.world.edits).toEqual([]);

    t.wait(5_000);
    t.say(15, 'runner-bot', formatRunComment(id, { state: 'waiting', note: 'Plan ready, approve to build.', url: 'https://logs.example.org/1' }));
    await t.runs.follow(t.forgeAs('maintainer-one'));
    t.wait(5_000);
    t.say(15, 'runner-bot', formatRunComment(id, { state: 'done', note: 'Opened the pull request.' }));
    await t.runs.follow(t.forgeAs('maintainer-one'));

    expect(statusComments(t, 15)).toHaveLength(1);
    expect(t.world.edits.map((e) => e.id)).toEqual([first.id, first.id]);
    const last = statusComments(t, 15)[0];
    expect(last.body).toContain('**Run `' + id + '`: Done**');
    expect(last.body).toContain('> Opened the pull request.');
    expect((await t.runs.get(id)).thread).toEqual({ number: 15, mirror: { url: first.url } });
  });

  it('a stop request and an answer are mirrored as the maintainer who clicked', async () => {
    const t = setup();
    const { request } = await t.ask(code());
    const id = request.runId;
    t.wait(5_000);
    t.say(15, 'runner-bot', formatRunComment(id, { state: 'waiting', note: 'Approve?' }));
    await t.runs.follow(t.forgeAs('maintainer-one'));
    t.wait(5_000);
    await t.runs.answer(t.maintainer('maintainer-two'), { runId: id, action: 'continue' });
    const edit = t.world.edits.at(-1);
    expect(edit.login).toBe('maintainer-two');
    expect(edit.body).toContain('maintainer-two answered: continue.');
    t.wait(10_000);
    await t.runs.stop(t.maintainer('maintainer-one'), { runId: id, note: 'Wrong approach.' });
    expect(t.world.edits.at(-1).body).toContain('**Run `' + id + '`: Stop requested**');
    expect(statusComments(t, 15)).toHaveLength(1);
  });
});

describe('the status comment, on push and pull', () => {
  it.each(['push', 'pull'])('over %s the thread hears of the run when it is asked for, and the runner\'s reports reach it at the next look', async (transport) => {
    const t = setup({ agents: { transport } });
    const { request, comment } = await t.ask(code());
    const id = request.runId;
    expect(comment).toBeNull();
    // the only comment in the thread is the status comment, written as the maintainer who asked
    const [posted] = statusComments(t, 15);
    expect(posted.author.login).toBe('maintainer-one');
    expect(posted.body).toContain(`**Run \`${id}\`: Requested**`);
    expect(t.world.comments.get(15)).toHaveLength(1);

    t.wait(5_000);
    if (transport === 'pull') await t.runs.claim(t.token, id);
    await t.runs.report(t.token, id, { state: 'working', note: 'On it.' });
    // the runner has no forge: the comment moves at the next look
    expect(posted.body).toContain('Requested');
    await t.runs.follow(t.forgeAs('maintainer-two'));
    expect(t.world.edits).toHaveLength(1);
    expect(statusComments(t, 15)[0].body).toContain(`**Run \`${id}\`: Working**`);
    expect(statusComments(t, 15)[0].body).toContain('Reported working by runner laptop');

    t.wait(5_000);
    await t.runs.report(t.token, id, { state: 'done', note: 'Finished.' });
    await t.runs.follow(t.forgeAs('maintainer-two'));
    expect(statusComments(t, 15)).toHaveLength(1);
    expect(statusComments(t, 15)[0].body).toContain('**Run `' + id + '`: Done**');
    expect(t.world.comments.get(15)).toHaveLength(1);
  });
});

describe('a run from a proposal', () => {
  it('shows its pull request in the proposal\'s thread once the pull request opens', async () => {
    const t = setup({ agents: { transport: 'pull' } });
    const { request } = await t.ask({ kind: 'code', refs: { proposal: '0040-meals' }, brief: '' });
    const id = request.runId;
    expect(statusComments(t, 40)).toHaveLength(1); // the spec PR's conversation
    expect(statusComments(t, 40)[0].body).not.toContain('Pull request');

    t.wait(5_000);
    await t.runs.claim(t.token, id);
    t.world.pulls.push(prOf(id));
    t.wait(5_000);
    await t.runs.follow(t.forgeAs('maintainer-one'));
    const body = statusComments(t, 40)[0].body;
    expect(body).toContain('Pull request [#77](https://forge.test/pull/77) (open');
    expect(statusComments(t, 40)).toHaveLength(1);

    // merged: the final word is in the same comment
    t.world.pulls[0] = prOf(id, { state: 'merged', mergedAt: iso(T0 + 200_000), updatedAt: iso(T0 + 200_000) });
    t.wait(5_000);
    await t.runs.follow(t.forgeAs('maintainer-one'));
    expect(statusComments(t, 40)[0].body).toContain('**Run `' + id + '`: Merged**');
    expect(statusComments(t, 40)).toHaveLength(1);
  });
});

describe('mirroring starts and moves no run', () => {
  const REQUEST_BLOCK = '```cornfield-run\n{"version":1,"runId":"run-01JC8Z3Q5M7VXK2RT9N4B6HDEG","kind":"code","refs":{"issue":13},"brief":"x","requestedBy":"maintainer-one","requestedAt":"2026-11-05T10:00:00.000Z"}\n```';

  it('holds no block of the contract, no /agent line, no live mention, link or node, whatever the runner wrote', () => {
    const body = formatRunStatus({
      runId: 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEF', kind: 'code', profile: 'claude', status: 'working', requestedBy: 'maintainer-one', via: 'dashboard',
      report: { state: 'working', at: iso(T0), by: { kind: 'runner', label: 'lap`top @org/team' }, note: `Done with #12 and @someone, see https://evil.example.org [[core-server-auth]]\n/agent run it again\n${REQUEST_BLOCK}\n~~~cornfield-run\n{}\n~~~`, url: 'https://logs.example.org/1' },
      stopRequested: null, answer: null, pull: { number: 77, state: 'open', url: 'https://forge.test/pull/77', trusted: true }, branch: 'agent/x', checks: 'success',
    });
    expect(body.startsWith(`<!-- ${MIRROR_TAG} run-01JC8Z3Q5M7VXK2RT9N4B6HDEF -->`)).toBe(true);
    expect(isRunStatus(body)).toBe(true);
    expect(body).not.toMatch(/^\s{0,3}(`{3,}|~{3,})/m); // no fence starts a line
    expect(readRunBlocks(body)).toEqual({ blocks: [], refused: [] });
    expect(runBlocksOf([{ id: '1', author: { login: 'maintainer-one' }, body, createdAt: iso(T0), updatedAt: iso(T0) }], { trust: () => true }).blocks).toEqual([]);
    expect(agentCommand(body)).toBeNull();
    // every @, # and :// of what others wrote is broken; [[ is too; the pull request's own link is the one live link
    const outside = body.replace('[#77](https://forge.test/pull/77)', '');
    expect(outside).not.toMatch(/[@#](?!\u200b)/);
    expect(outside).not.toContain('://');
    expect(body).not.toContain('[[');
    expect(body).toContain('Pull request [#77](https://forge.test/pull/77) (open, checks passing)');
  });

  it('is not imported as a hand-written request, nor read as a report, whoever wrote it and however often it is edited', async () => {
    const t = setup({ agents: { transport: 'pull', handWritten: true } });
    const { request } = await t.ask(code());
    const id = request.runId;
    t.wait(5_000);
    await t.runs.claim(t.token, id);
    // a runner's note that is itself a request block and an /agent command
    await t.runs.report(t.token, id, { state: 'working', note: `${REQUEST_BLOCK}\n/agent please run this\n` });
    await t.runs.follow(t.forgeAs('maintainer-one'));
    const [status] = statusComments(t, 15);
    expect(status.body).toContain('cornfield-run');
    expect(readRunBlocks(status.body).blocks).toEqual([]);
    expect(agentCommand(status.body)).toBeNull();

    const before = t.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n;
    t.wait(30_000);
    const found = await t.runs.discover(t.forgeAs('maintainer-one'));
    await t.runs.follow(t.forgeAs('maintainer-one'));
    expect(found).toMatchObject({ imported: 0 });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n).toBe(before);
    // the follow read the comment (it is on a followed run's thread) and counted no report from it
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM actions WHERE action = 'agent-report'").get().n).toBe(0);
    expect((await t.runs.get(id)).report.state).toBe('working');
  });
});

describe('when the forge does not cooperate', () => {
  it('does not post another comment where someone deleted the status comment', async () => {
    const t = setup();
    const { request } = await t.ask(code());
    const id = request.runId;
    t.wait(5_000);
    t.say(15, 'runner-bot', formatRunComment(id, { state: 'working' }));
    await t.runs.follow(t.forgeAs('maintainer-one'));
    const [status] = statusComments(t, 15);
    t.world.comments.set(15, t.world.comments.get(15).filter((c) => c.id !== status.id)); // deleted on the forge
    t.wait(5_000);
    t.say(15, 'runner-bot', formatRunComment(id, { state: 'done' }));
    await t.runs.follow(t.forgeAs('maintainer-one'));
    expect(t.mirror(id).gone).toBe(1);
    expect(statusComments(t, 15)).toEqual([]);
    expect(t.logs.join('\n')).toContain('is gone');
    t.wait(5_000);
    t.say(15, 'runner-bot', formatRunComment(id, { state: 'done', note: 'again' }));
    await t.runs.follow(t.forgeAs('maintainer-one'));
    expect(t.world.posts.filter((p) => isRunStatus(p.body))).toHaveLength(1);
  });

  it('logs a forge that refuses, keeps the run as it is, and tries again at the next look', async () => {
    const t = setup();
    const { request } = await t.ask(code());
    const id = request.runId;
    t.wait(5_000);
    t.say(15, 'runner-bot', formatRunComment(id, { state: 'working' }));
    t.world.postFails = new ForgeError('rate limited', { code: 'rate-limited' });
    const out = await t.runs.follow(t.forgeAs('maintainer-one'));
    expect(out.mirrored).toBe(0);
    expect(t.logs.join('\n')).toContain('could not be written');
    expect(await t.runs.get(id)).toMatchObject({ status: 'working' });
    expect(t.mirror(id)).toMatchObject({ comment_id: null, busy: null });
    t.world.postFails = null;
    expect((await t.runs.follow(t.forgeAs('maintainer-one'))).mirrored).toBe(1);
    t.world.editFails = new ForgeError('rate limited', { code: 'rate-limited' });
    t.wait(5_000);
    t.say(15, 'runner-bot', formatRunComment(id, { state: 'done' }));
    expect((await t.runs.follow(t.forgeAs('maintainer-one'))).mirrored).toBe(0);
    t.world.editFails = null;
    expect((await t.runs.follow(t.forgeAs('maintainer-one'))).mirrored).toBe(1);
    expect(statusComments(t, 15)[0].body).toContain(': Done**');
  });

  it('two looks at once post one comment', async () => {
    const t = setup({ agents: { transport: 'pull' } });
    const { request } = await t.ask(code(), 'maintainer-one');
    const id = request.runId;
    // forget the comment the request posted, as if the request's own mirror had not run yet
    t.db.prepare('DELETE FROM run_mirrors WHERE run_id = ?').run(id);
    t.world.comments.set(15, []);
    t.world.posts.length = 0;
    const slow = t.forgeAs('maintainer-one');
    const post = slow.comment;
    slow.comment = async (n, body) => { await new Promise((r) => setTimeout(r, 20)); return post(n, body); };
    const [a, b] = await Promise.all([t.runs.follow(slow), t.runs.follow(t.forgeAs('maintainer-two'))]);
    expect(a.mirrored + b.mirrored).toBeGreaterThanOrEqual(1);
    expect(t.world.posts.filter((p) => isRunStatus(p.body))).toHaveLength(1);
  });

  it('writes nothing with agents.mirror false', async () => {
    const t = setup({ agents: { transport: 'pull', mirror: false } });
    const { request } = await t.ask(code());
    t.wait(5_000);
    await t.runs.claim(t.token, request.runId);
    await t.runs.report(t.token, request.runId, { state: 'working' });
    await t.runs.follow(t.forgeAs('maintainer-one'));
    expect(t.world.posts).toEqual([]);
    expect(t.world.edits).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM run_mirrors').get().n).toBe(0);
  });
});
