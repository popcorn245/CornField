/**
 * @vitest-environment node
 *
 * Threads without a browser (server/threads.js, the thread.* hooks in server/hooks.js, the poll in server/spec-poll.js): a
 * fake forge object, a real hooks module over a real SQLite file. It proves what is read (ideas by label, a spec PR's
 * conversation, the PR that names an idea), what a hook is told (never a text), that each comment is announced once across a
 * restart, that the first look is silent, that a look asks only for what is new, and that the poll does it on its own tick.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { gatherThreads, listThreads, readThread, snapshotOf, createIdea, ideaInput, BODY_LIMIT } from '../../server/threads.js';
// @ts-expect-error plain JS module, no declarations
import { createHooks } from '../../server/hooks.js';
// @ts-expect-error plain JS module, no declarations
import { createSpecPoll } from '../../server/spec-poll.js';
// @ts-expect-error plain JS module, no declarations
import { ForgeError } from '../../server/forge.js';
// @ts-expect-error plain JS module, no declarations
import { openStore } from '../../server/db.js';
import { SAMPLE } from '../helpers.js';

const SECRET = 's3cret-'.repeat(6);
const FOLDER = 'docs/specs/proposals';
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const user = (login) => ({ login, url: null });
const NODES = [
  { id: 'page-web-cart', file: 'packages/web/src/cart.js' },
  { id: 'page-api-orders', file: 'packages/api/src/server.js' },
  { id: 'app-api', file: 'packages/api' },
];

const issue = (number, extra = {}) => ({
  number, title: `Idea ${number}`, state: 'open', author: user('maintainer-one'), labels: ['idea'], body: '', comments: 0, url: `https://x.test/issues/${number}`,
  createdAt: '2026-11-01T09:00:00Z', updatedAt: '2026-11-01T09:00:00Z', closedAt: null, ...extra,
});
const pull = (number, extra = {}) => ({
  number, title: 'Spec: Meals', body: '', state: 'open', draft: false, author: user('author-one'), labels: [], head: { ref: 'spec/40', sha: 'a'.repeat(40) }, base: { ref: 'main' },
  url: `https://x.test/pull/${number}`, createdAt: '2026-11-02T09:00:00Z', updatedAt: '2026-11-02T09:00:00Z', mergedAt: null, ...extra,
});
const comment = (id, body, at = '2026-11-01T10:00:00Z', login = 'author-one') => ({ id: String(id), author: user(login), body, url: `https://x.test/c/${id}`, createdAt: at, updatedAt: at });

/** A forge object over a world of ideas, pull requests and comments; `calls` is what it was asked */
function fakeForge(world) {
  const calls = [];
  return {
    repo: 'owner/name',
    calls,
    me: async () => ({ id: 1001, login: 'maintainer-one' }),
    permission: async () => 'admin',
    issues: async (q) => { calls.push(`issues ${q.state} ${q.labels.join(',')}`); return world.issues.filter((i) => (q.state === 'all' || i.state === q.state) && q.labels.every((l) => i.labels.includes(l))); },
    pulls: async () => { calls.push('pulls'); return world.pulls; },
    pullFiles: async (n) => { calls.push(`pullFiles ${n}`); return world.files[n] || []; },
    file: async () => '{}',
    issue: async (n) => {
      const found = world.issues.find((i) => i.number === n);
      if (!found) throw new ForgeError('not an issue', { code: 'not-found' });
      return found;
    },
    pull: async (n) => {
      const found = world.pulls.find((p) => p.number === n);
      if (!found) throw new ForgeError('no such pull request', { code: 'not-found' });
      return found;
    },
    comments: async (n, opts) => {
      calls.push(`comments ${n}${opts && opts.since ? ` since ${opts.since}` : ''}`);
      return (world.comments[n] || []).filter((c) => !opts || !opts.since || c.updatedAt >= opts.since);
    },
    createIssue: async (i) => { calls.push(`createIssue ${JSON.stringify(i)}`); return issue(99, { title: i.title, body: i.body, labels: i.labels }); },
  };
}
const spec = (n) => ({ [n]: [{ path: `${FOLDER}/0040-meals.json`, status: 'added' }] });

const config = (extra = {}) => ({ forge: { repo: 'owner/name' }, threads: { label: 'idea' }, root: SAMPLE, topology: 'topology.json', ...extra });
const where = { proposals: FOLDER };

describe('reading threads', () => {
  it('lists ideas by label and spec PR conversations, newest activity first, with the references their text holds', async () => {
    const world = {
      issues: [issue(41, { body: 'About [[server/auth.js]]', comments: 1 }), issue(42, { updatedAt: '2026-11-03T09:00:00Z' }), issue(43, { labels: ['bug'] })],
      pulls: [pull(40, { body: 'Spec for meals.\n\nThread: #41' })],
      files: spec(40),
      comments: { 41: [comment(9101, 'also [[core-server-auth]]\n```cornfield-thread\n{"nodes":["packages/api"],"proposal":"0040-meals"}\n```', '2026-11-04T10:00:00Z')], 40: [comment(9201, 'ok [[server/hooks.js]]', '2026-11-02T12:00:00Z')] },
    };
    const forge = fakeForge(world);
    const { items, label } = await listThreads(forge, config(), where, { state: 'all' });
    expect(label).toBe('idea');
    expect(items.map((t) => [t.kind, t.number])).toEqual([['idea', 41], ['idea', 42], ['proposal', 40]]);
    expect(items[0]).toMatchObject({ title: 'Idea 41', comments: 1, refs: ['server/auth.js', 'core-server-auth', 'packages/api'], proposal: '0040-meals', proposals: [{ pull: 40, slug: '0040-meals' }], updatedAt: '2026-11-04T10:00:00Z' });
    expect(items[2]).toMatchObject({ kind: 'proposal', number: 40, slugs: ['0040-meals'], idea: 41, refs: ['server/hooks.js'] });
    expect(JSON.stringify(items)).not.toContain('also [[core');
    expect(forge.calls).toContain('issues all idea');
    // an idea with no comment costs no call; the issue labelled bug is not a thread
    expect(forge.calls).not.toContain('comments 42');
    expect(items.some((t) => t.number === 43)).toBe(false);
  });

  it('a spec PR that names an idea in code, or names an issue that is no idea, links nothing', async () => {
    const world = { issues: [issue(41)], pulls: [pull(40, { body: '`Thread: #41` and Closes #77' })], files: spec(40), comments: {} };
    const { items } = await listThreads(fakeForge(world), config(), where, { state: 'all' });
    expect(items.find((t) => t.number === 41).proposals).toBeUndefined();
    expect(items.find((t) => t.number === 40).idea).toBeUndefined();
  });

  it('reads one idea (its text first) and one proposal thread, and refuses what is no thread', async () => {
    const world = {
      issues: [issue(41, { body: 'The idea text', comments: 2 }), issue(43, { labels: ['bug'] })],
      pulls: [pull(40, { body: 'Closes #41' }), pull(50)],
      files: { ...spec(40), 50: [{ path: 'README.md', status: 'modified' }] },
      comments: { 41: [comment(1, 'first'), comment(2, 'x'.repeat(BODY_LIMIT + 5))], 40: [comment(3, 'on the spec')] },
    };
    const forge = fakeForge(world);
    const idea = await readThread(forge, config(), where, 41);
    expect(idea).toMatchObject({ kind: 'idea', number: 41, title: 'Idea 41', hidden: 0, proposals: [{ pull: 40, slug: '0040-meals' }] });
    expect(idea.messages.map((m) => m.id)).toEqual(['opening', '1', '2']);
    expect(idea.messages[0]).toMatchObject({ opening: true, body: 'The idea text' });
    expect(idea.messages[2].cut).toBe(true);
    expect(idea.messages[2].body).toHaveLength(BODY_LIMIT);
    const proposal = await readThread(forge, config(), where, 40);
    expect(proposal).toMatchObject({ kind: 'proposal', number: 40, slugs: ['0040-meals'], idea: 41 });
    expect(proposal.messages.map((m) => m.body)).toEqual(['on the spec']);
    for (const n of [43, 50, 777]) await expect(readThread(forge, config(), where, n)).rejects.toMatchObject({ code: 'not-found' });
    await expect(readThread(forge, config({ threads: false }), where, 41)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('the label is the config\'s, and threads: false reads nothing', async () => {
    const world = { issues: [issue(41, { labels: ['rfc'] }), issue(42)], pulls: [], files: {}, comments: {} };
    const forge = fakeForge(world);
    expect((await listThreads(forge, config({ threads: { label: 'rfc' } }), where)).items.map((t) => t.number)).toEqual([41]);
    forge.calls.length = 0;
    const off = await gatherThreads(forge, config({ threads: false }), where);
    expect(off.threads).toEqual([]);
    expect(forge.calls).toEqual([]);
  });

  it('a thread whose comments cannot be read is left out of the hook snapshot and named as a problem', async () => {
    const world = { issues: [issue(41, { comments: 1 })], pulls: [], files: {}, comments: {} };
    const forge = fakeForge(world);
    forge.comments = async () => { throw new ForgeError('The forge is away.', { code: 'unavailable' }); };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const got = await gatherThreads(forge, config(), where);
    expect(got.problem).toMatch(/forge could not be asked|away/i);
    expect(snapshotOf(got, NODES).threads).toEqual([]);
  });

  it('opens an idea with the label and refuses what is not an idea', async () => {
    const forge = fakeForge({ issues: [], pulls: [], files: {}, comments: {} });
    const made = await createIdea(forge, config(), ideaInput({ title: ' Meals ', body: 'what if' }));
    expect(made).toMatchObject({ number: 99, title: 'Meals' });
    expect(forge.calls[0]).toBe('createIssue {"title":"Meals","body":"what if","labels":["idea"]}');
    expect(ideaInput({ title: 'T' }).body).toBe('_No description yet._');
    for (const bad of [null, [], 'x', { title: '' }, { title: 5 }, { title: 'a'.repeat(257) }, { title: 'a', body: 1 }, { title: 'a', extra: 1 }, { title: 'a', body: 'b'.repeat(BODY_LIMIT + 1) }]) {
      expect(() => ideaInput(bad), JSON.stringify(bad)).toThrow(ForgeError);
    }
    expect(() => createIdea(forge, config({ threads: false }), { title: 'a', body: 'b' })).toThrow(/off/);
  });
});

describe('the hooks', () => {
  const made = [];
  afterEach(() => { vi.restoreAllMocks(); for (const d of made.splice(0)) { d.db?.close(); fs.rmSync(d.dir, { recursive: true, force: true }); } });

  /** A data folder that outlives a "restart": `boot()` opens it again with a new hooks module */
  function site(events = '*') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-threads-'));
    const entry = { dir, db: null };
    made.push(entry);
    const sent = [];
    const fetch = async (url, init) => { sent.push({ body: JSON.parse(init.body), headers: init.headers }); return new Response(null, { status: 200 }); };
    const boot = () => {
      entry.db?.close();
      entry.db = openStore(dir);
      const db = entry.db;
      const hooks = createHooks({ hooks: [{ url: 'https://chat.example.org/h', events }], secret: SECRET, fetch, store: async () => db, publicUrl: 'https://map.example.org', timer: { setTimeout: () => 0, clearTimeout: () => {} } });
      return { hooks, db };
    };
    return { boot, sent, of: (event) => sent.filter((s) => s.body.event === event).map((s) => s.body) };
  }

  /** One look the poll way: the cursors from the database, what the forge says, the snapshot handed to the hooks */
  async function look(forge, hooks, extra = {}) {
    const cursors = await hooks.threadCursors('owner/name');
    const got = await gatherThreads(forge, config(), where, { state: 'all', cursors: cursors.looked ? cursors.threads : null, ...extra });
    await hooks.threadsSeen('owner/name', snapshotOf(got, NODES));
    await settle();
    return got;
  }

  const world = () => ({
    issues: [issue(41, { body: 'start [[packages/web/src/cart.js]]', comments: 1, updatedAt: '2026-11-01T11:00:00Z' })],
    pulls: [pull(40, { body: 'Thread: #41' })],
    files: spec(40),
    comments: { 41: [comment(9101, 'one', '2026-11-01T10:00:00Z')], 40: [] },
  });

  it('the first look sends nothing; what comes after is sent once, with no text in it', async () => {
    const s = site();
    const { hooks } = s.boot();
    const w = world();
    const forge = fakeForge(w);
    await look(forge, hooks);
    expect(s.sent).toEqual([]);

    // a new comment that links, a new idea, a comment on the spec PR
    w.issues[0] = { ...w.issues[0], comments: 2, updatedAt: '2026-11-05T09:00:00Z' };
    w.comments[41].push(comment(9102, 'now [[packages/api/src/server.js]] and [[nowhere.md]] secret words', '2026-11-05T09:00:00Z'));
    w.issues.push(issue(42, { body: 'plain', updatedAt: '2026-11-05T10:00:00Z', author: user('maintainer-two') }));
    w.comments[40].push(comment(9201, 'on the spec', '2026-11-05T11:00:00Z', 'reviewer-one'));
    w.pulls = [pull(40, { body: 'Thread: #41', updatedAt: '2026-11-05T11:00:00Z' })];
    await look(forge, hooks);

    expect(s.of('thread.opened')).toEqual([expect.objectContaining({ event: 'thread.opened', thread: 42, actor: 'maintainer-two', mapUrl: 'https://map.example.org' })]);
    expect(s.of('thread.message').map((e) => [e.thread, e.comment, e.actor])).toEqual([[41, '9102', 'author-one'], [40, '9201', 'reviewer-one']]);
    // the order of the keys is fixed, and a message carries no text, no nodes
    const message = s.of('thread.message')[0];
    expect(Object.keys(message)).toEqual(['event', 'at', 'thread', 'comment', 'actor', 'mapUrl']);
    expect(s.of('thread.linked')).toEqual([expect.objectContaining({ thread: 41, comment: '9102', actor: 'author-one', nodes: ['page-api-orders'] })]);
    expect(JSON.stringify(s.sent)).not.toMatch(/secret words|start \[\[/);
    // signed like every other event
    const opened = s.sent.find((x) => x.body.event === 'thread.opened');
    expect(opened.headers['X-Cornfield-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(opened.headers['X-Cornfield-Event']).toBe('thread.opened');
  });

  it('each comment is sent once across a restart, and nothing is repeated by a second look', async () => {
    const s = site();
    let { hooks } = s.boot();
    const w = world();
    const forge = fakeForge(w);
    await look(forge, hooks);
    w.issues[0] = { ...w.issues[0], comments: 2, updatedAt: '2026-11-05T09:00:00Z' };
    w.comments[41].push(comment(9102, 'two', '2026-11-05T09:00:00Z'));
    await look(forge, hooks);
    await look(forge, hooks);
    expect(s.of('thread.message')).toHaveLength(1);

    ({ hooks } = s.boot()); // a restart: a new hooks module over the same file
    await look(fakeForge(w), hooks);
    expect(s.of('thread.message')).toHaveLength(1);
    w.issues[0] = { ...w.issues[0], comments: 3, updatedAt: '2026-11-06T09:00:00Z' };
    w.comments[41].push(comment(9103, 'three', '2026-11-06T09:00:00Z'));
    await look(fakeForge(w), hooks);
    expect(s.of('thread.message').map((e) => e.comment)).toEqual(['9102', '9103']);
  });

  it('a look asks only for what is new: an idea unchanged since the last look costs no comment call, the rest read from the newest comment', async () => {
    const s = site();
    const { hooks } = s.boot();
    const w = world();
    await look(fakeForge(w), hooks);

    const quiet = fakeForge(w);
    await look(quiet, hooks);
    expect(quiet.calls.filter((c) => c.startsWith('comments 41'))).toEqual([]);

    w.issues[0] = { ...w.issues[0], comments: 2, updatedAt: '2026-11-05T09:00:00Z' };
    w.comments[41].push(comment(9102, 'two', '2026-11-05T09:00:00Z'));
    const next = fakeForge(w);
    await look(next, hooks);
    expect(next.calls).toContain('comments 41 since 2026-11-01T10:00:00Z');
  });

  it('thread.linked also fires when a spec PR names the thread, once, and when a block names a proposal', async () => {
    const s = site();
    const { hooks } = s.boot();
    const w = world();
    w.pulls = [];
    const forge = fakeForge(w);
    await look(forge, hooks);
    w.pulls = [pull(40, { body: 'Closes #41' })];
    await look(forge, hooks);
    await look(forge, hooks);
    expect(s.of('thread.linked')).toEqual([expect.objectContaining({ thread: 41, proposal: '0040-meals', nodes: [], actor: null })]);
    expect(s.of('thread.linked')[0]).not.toHaveProperty('comment');

    w.issues[0] = { ...w.issues[0], comments: 2, updatedAt: '2026-11-07T09:00:00Z' };
    w.comments[41].push(comment(9102, '```cornfield-thread\n{"proposal":"0040-meals","nodes":["page-web-cart"]}\n```', '2026-11-07T09:00:00Z'));
    await look(forge, hooks);
    expect(s.of('thread.linked').at(-1)).toMatchObject({ thread: 41, comment: '9102', nodes: ['page-web-cart'], proposal: '0040-meals' });
  });

  it('a comment edited to add a mention is linked once, but its message is not announced again', async () => {
    const s = site();
    const { hooks } = s.boot();
    const w = world();
    const forge = fakeForge(w);
    await look(forge, hooks);
    w.issues[0] = { ...w.issues[0], updatedAt: '2026-11-08T09:00:00Z' };
    w.comments[41] = [{ ...comment(9101, 'one, now [[page-web-cart]]'), updatedAt: '2026-11-08T09:00:00Z' }];
    await look(forge, hooks);
    await look(forge, hooks);
    expect(s.of('thread.message')).toEqual([]);
    expect(s.of('thread.linked')).toHaveLength(1);
  });

  it('only a hook that asked for an event gets it; the rows are still kept', async () => {
    const s = site(['thread.message']);
    const { hooks, db } = s.boot();
    const w = world();
    const forge = fakeForge(w);
    await look(forge, hooks);
    w.issues.push(issue(42, { comments: 1, updatedAt: '2026-11-05T10:00:00Z' }));
    w.comments[42] = [comment(9301, 'hi', '2026-11-05T10:00:00Z')];
    await look(forge, hooks);
    expect(s.sent.map((x) => x.body.event)).toEqual(['thread.message']);
    expect(db.prepare("SELECT comment FROM thread_seen WHERE repo = 'owner/name' AND issue = 42 ORDER BY comment").all().map((r) => r.comment)).toEqual(['', '9301']);
  });

  it('a thread nothing is subscribed to is not a hook at all: threadsSeen without a store does nothing', async () => {
    const hooks = createHooks({ hooks: [{ url: 'https://chat.example.org/h', events: '*' }], secret: SECRET, fetch: async () => new Response(null), timer: { setTimeout: () => 0, clearTimeout: () => {} } });
    await expect(hooks.threadsSeen('owner/name', { threads: [], pulls: [] })).resolves.toBeUndefined();
    expect(await hooks.threadCursors('owner/name')).toEqual({ looked: false, threads: new Map() });
  });
});

describe('the poll looks at threads on its tick', () => {
  const made = [];
  afterEach(() => { vi.restoreAllMocks(); for (const d of made.splice(0)) { d.db?.close(); fs.rmSync(d.dir, { recursive: true, force: true }); } });

  function setup(events, extraConfig = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-threads-poll-'));
    const db = openStore(dir);
    made.push({ dir, db });
    db.prepare('INSERT INTO sessions (id, forge, user_id, login, token, permission, created_at, checked_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('s0', 'github', '1001', 'maintainer-one', 'sealed', 'admin', '2026-11-03T09:00:00.000Z', '2026-11-03T09:00:00.000Z', '2099-01-01T00:00:00.000Z');
    const w = { issues: [issue(41, { comments: 1 })], pulls: [pull(40, { body: 'Thread: #41' })], files: spec(40), comments: { 41: [comment(9101, 'one')], 40: [] } };
    const forge = fakeForge(w);
    const auth = { store: async () => db, forgeForUser: async () => forge };
    const sent = [];
    const fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response(null, { status: 200 }); };
    const cfg = config({ hooks: [{ url: 'https://chat.example.org/h', events }], ...extraConfig });
    const hooks = createHooks({ hooks: cfg.hooks, secret: SECRET, fetch, store: auth.store, timer: { setTimeout: () => 0, clearTimeout: () => {} } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const poll = createSpecPoll({ config: cfg, where, auth, hooks, intervalMs: 300_000, timer: { setTimeout: () => ({ unref() {} }), clearTimeout() {} } });
    return { poll, forge, w, sent };
  }
  const run = async (t) => { const out = await t.poll.tick(); await settle(); return out; };

  it('one tick looks at the spec PRs and the threads, with one listing of the open PRs', async () => {
    const t = setup(['spec.ready', 'thread.message']);
    expect(await run(t)).toBe('ok');
    expect(t.sent).toEqual([]); // the first look of both is silent
    expect(t.forge.calls.filter((c) => c === 'pulls')).toHaveLength(1);
    t.w.pulls = [pull(40, { body: 'Thread: #41', head: { ref: 'spec/40', sha: 'b'.repeat(40) } })];
    t.w.issues[0] = { ...t.w.issues[0], comments: 2, updatedAt: '2026-11-05T09:00:00Z' };
    t.w.comments[41].push(comment(9102, 'two', '2026-11-05T09:00:00Z'));
    expect(await run(t)).toBe('ok');
    expect(t.sent.map((e) => e.event).sort()).toEqual(['spec.ready', 'thread.message']);
  });

  it('threads are not looked at when no hook wants a thread event, or when threads are off', async () => {
    const a = setup(['spec.ready']);
    await run(a);
    expect(a.forge.calls.some((c) => c.startsWith('issues') || c.startsWith('comments'))).toBe(false);
    const b = setup('*', { threads: false });
    await run(b);
    expect(b.forge.calls.some((c) => c.startsWith('issues') || c.startsWith('comments'))).toBe(false);
  });

  it('a thread-only hook polls the threads and not the spec PRs\' heads', async () => {
    const t = setup(['thread.opened']);
    await run(t);
    t.w.issues.push(issue(42, { updatedAt: '2026-11-05T10:00:00Z' }));
    await run(t);
    expect(t.sent.map((e) => [e.event, e.thread])).toEqual([['thread.opened', 42]]);
  });

  it('a forge that cannot be asked for comments is the tick\'s failure, and the next tick retries', async () => {
    const t = setup('*');
    const real = t.forge.comments;
    t.forge.comments = async () => { throw new ForgeError('The forge is away.', { code: 'unavailable' }); };
    expect(await run(t)).toBe('error');
    t.forge.comments = real;
    expect(await run(t)).toBe('ok');
  });
});
