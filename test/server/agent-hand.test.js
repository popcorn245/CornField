/**
 * @vitest-environment node
 *
 * Requests written by hand on the forge (issue #98, server/agent-runs.js `discover`): a maintainer's own `cornfield-run` block in a comment on
 * an open issue or pull request becomes a run that is listed and followed like one cornfield asked for. Held here: the maintainer rule (now, and
 * not edited), a block judged once, cornfield's own blocks never imported again, malformed and refused blocks listed with the reason, the cap and the
 * one-run-per-subject rule, an id cornfield assigns and confirms in the thread, and the config key.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { createRuns } from '../../server/agent-runs.js';
// @ts-expect-error plain JS module, no declarations
import { createHooks } from '../../server/hooks.js';
// @ts-expect-error plain JS module, no declarations
import { openStore } from '../../server/db.js';
// @ts-expect-error plain JS module, no declarations
import { formatRunBlock, formatRunComment, readRunBlocks } from '../../core/agent-contract.js';
// @ts-expect-error plain JS module, no declarations
import { handLines, runMeta } from '../../explorer/runs-model.js';

const T0 = Date.parse('2026-11-05T10:00:00Z');
const HOUR = 3_600_000;
const SECRET = 's3cret-'.repeat(6);
const ULID = '01JC8Z3Q5M7VXK2RT9N4B6HDEF';
const RUN = `run-${ULID}`;
const RUN2 = 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEG';
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const fence = (id, json) => `\`\`\`cornfield-run${id ? ` ${id}` : ''}\n${typeof json === 'string' ? json : JSON.stringify(json, null, 2)}\n\`\`\``;
const request = (over = {}) => ({ version: 1, runId: RUN, kind: 'code', refs: { issue: 12 }, brief: 'Do the thing', requestedBy: 'maintainer-one', requestedAt: iso(T0), ...over });
const block = (over = {}) => formatRunBlock(over.runId ?? RUN, request(over));

const made = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of made.splice(0)) { d.db?.close(); fs.rmSync(d.dir, { recursive: true, force: true }); } });

function setup({ agents = {}, threads, dir = null } = {}) {
  const folder = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-hand-'));
  const db = openStore(folder);
  made.push({ dir: folder, db });
  const clock = { now: T0 };
  const stamp = () => iso(clock.now);
  const world = {
    perms: { 'maintainer-one': 'admin', 'maintainer-two': 'maintain', 'runner-bot': 'write', stranger: 'read' },
    issues: new Map([[12, { number: 12, labels: [] }], [13, { number: 13, labels: ['idea'] }], [14, { number: 14, labels: [] }]]),
    pulls: new Map([[40, { number: 40, labels: [] }]]),
    comments: new Map(),
    next: 9000,
    calls: [],
    postFails: false,
  };
  const touched = new Map();
  const say = (number, login, body, extra = {}) => {
    const c = { id: String(world.next++), author: { login }, body, url: `https://forge.test/c/${world.next}`, createdAt: stamp(), updatedAt: stamp(), ...extra };
    world.comments.set(number, [...(world.comments.get(number) ?? []), c]);
    touched.set(number, stamp());
    clock.now += 1000;
    return c;
  };
  const listing = (m) => [...m.values()].map((x) => ({ number: x.number, labels: x.labels, state: 'open', updatedAt: touched.get(x.number) ?? iso(T0 - HOUR), head: { ref: 'x', sha: 'a'.repeat(40) }, createdAt: iso(T0 - HOUR), author: { login: 'x' }, body: '' }));
  const forge = {
    repo: 'owner/name',
    me: async () => ({ id: 1001, login: 'maintainer-one' }),
    permission: async (_repo, who) => { world.calls.push(`permission ${who}`); return world.perms[who] ?? 'none'; },
    issues: async () => { world.calls.push('issues'); return listing(world.issues); },
    pulls: async (q) => { world.calls.push(`pulls ${q?.state}`); return q?.state === 'open' ? listing(world.pulls) : []; },
    comments: async (n) => { world.calls.push(`comments ${n}`); return world.comments.get(n) ?? []; },
    comment: async (n, body) => {
      if (world.postFails) throw new Error('forge says no');
      const c = say(n, 'maintainer-one', body);
      return { id: c.id, url: c.url };
    },
    issue: async (n) => world.issues.get(n),
    pullCommits: async () => [],
    checks: async () => [],
    branches: async () => [],
    pull: async () => { throw new Error('no'); },
  };
  const auth = {
    store: async () => db,
    record: async ({ login, action, target, request: req = {}, status = null, answer = null }) => {
      db.prepare('INSERT INTO actions (at, login, action, target, request, status, answer) VALUES (?, ?, ?, ?, ?, ?, ?)').run(stamp(), login, action, target, JSON.stringify(req), status, answer === null ? null : JSON.stringify(answer));
    },
  };
  const sent = [];
  const hooks = createHooks({
    hooks: [{ url: 'https://chat.example.org/h', events: '*' }], secret: SECRET, store: auth.store, now: () => clock.now,
    fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return new Response(null, { status: 200 }); },
    timer: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  const cfg = { forge: { repo: 'owner/name' }, proposals: 'docs/specs/proposals', ...(threads !== undefined ? { threads } : {}), agents: { maxOpen: 3, profiles: [], runners: ['runner-bot'], quietAfter: '24h', transport: 'forge', ...agents } };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const runs = createRuns({ config: cfg, where: { proposals: cfg.proposals }, auth, hooks, now: () => clock.now });
  const look = async () => { const found = await runs.discover(forge); await runs.follow(forge); return found; };
  const actions = () => db.prepare("SELECT * FROM actions WHERE action = 'agent-hand' ORDER BY id").all().map((r) => ({ ...r, request: JSON.parse(r.request), answer: JSON.parse(r.answer) }));
  return { runs, db, world, say, forge, auth, hooks, sent, cfg, look, actions, clock, dir: folder, touch: (n) => touched.set(n, stamp()) };
}

describe('a request written by hand', () => {
  it('on an open issue, from a maintainer, becomes a run that is listed and followed', async () => {
    const t = setup();
    t.say(12, 'maintainer-one', `Please run this.\n\n${block()}`);
    expect(await t.runs.discover(t.forge)).toMatchObject({ imported: 1, refused: 0 });
    const list = await t.runs.list();
    expect(list.runs).toHaveLength(1);
    expect(list.runs[0]).toMatchObject({ runId: RUN, kind: 'code', refs: { issue: 12 }, requestedBy: 'maintainer-one', via: 'hand', byHand: true, transport: 'forge', status: 'requested', open: true, target: 12 });
    expect(list.runs[0].comment.id).toBe('9000');
    expect(list.open).toBe(1);
    // no agent.requested: cornfield did not ask
    await new Promise((r) => setImmediate(r));
    expect(t.sent.filter((e) => e.event === 'agent.requested')).toEqual([]);
    // the runner reports in the thread; the same look follows it
    t.say(12, 'runner-bot', formatRunComment(RUN, { state: 'claimed' }));
    t.say(12, 'runner-bot', formatRunComment(RUN, { state: 'working', note: 'on it' }));
    await t.runs.follow(t.forge);
    const after = await t.runs.get(RUN);
    expect(after).toMatchObject({ status: 'working', report: { state: 'working' } });
    t.say(12, 'runner-bot', formatRunComment(RUN, { state: 'done' }));
    await t.runs.follow(t.forge);
    expect(await t.runs.get(RUN)).toMatchObject({ status: 'done', open: false });
  });

  it('is the by-hand marker in the Runs view line', async () => {
    const t = setup();
    t.say(12, 'maintainer-one', block());
    await t.runs.discover(t.forge);
    const run = (await t.runs.list()).runs[0];
    expect(runMeta(run, T0 + 60_000)).toContain('by maintainer-one (by hand)');
    expect(runMeta({ ...run, byHand: false }, T0 + 60_000)).not.toContain('by hand');
  });

  it('is found on an open pull request too, and "requestedBy" in the block is only a claim', async () => {
    const t = setup();
    t.say(40, 'maintainer-two', block({ requestedBy: 'maintainer-one', refs: { issue: 12 } }));
    await t.runs.discover(t.forge);
    const run = await t.runs.get(RUN);
    expect(run).toMatchObject({ requestedBy: 'maintainer-two', via: 'hand', target: 40 });
    expect(JSON.parse(t.db.prepare('SELECT request FROM runs WHERE run_id = ?').get(RUN).request).requestedBy).toBe('maintainer-two');
  });

  it('is judged once: a second look, and a restart, list and audit it once', async () => {
    const t = setup();
    t.say(12, 'maintainer-one', block());
    await t.look();
    t.touch(12); // the conversation moved, so it is read again
    await t.look();
    const again = createRuns({ config: t.cfg, where: { proposals: t.cfg.proposals }, auth: t.auth, hooks: t.hooks, now: () => t.clock.now });
    await again.discover(t.forge);
    expect(t.db.prepare('SELECT count(*) AS n FROM runs').get().n).toBe(1);
    expect(t.actions().filter((a) => a.answer.accepted === true)).toHaveLength(1);
  });

  it('reads a conversation again only when it changed', async () => {
    const t = setup();
    t.say(12, 'maintainer-one', 'just talk');
    await t.runs.discover(t.forge);
    await t.runs.discover(t.forge);
    expect(t.world.calls.filter((c) => c === 'comments 12')).toHaveLength(1);
    t.say(12, 'maintainer-one', 'more talk');
    await t.runs.discover(t.forge);
    expect(t.world.calls.filter((c) => c === 'comments 12')).toHaveLength(2);
  });

  it('with no id in the fence gets one from cornfield, confirmed by a reply block that is not imported again', async () => {
    const t = setup();
    const c = t.say(12, 'maintainer-one', fence('', { kind: 'summary', refs: { issue: 12 }, brief: '' }));
    expect(await t.runs.discover(t.forge)).toMatchObject({ imported: 1 });
    const [run] = (await t.runs.list()).runs;
    expect(run).toMatchObject({ kind: 'summary', via: 'hand', requestedBy: 'maintainer-one' });
    expect(run.comment.id).toBe(c.id); // the run is the maintainer's comment
    const reply = t.world.comments.get(12).at(-1);
    const read = readRunBlocks(reply.body);
    expect(read.blocks).toHaveLength(1);
    expect(read.blocks[0]).toMatchObject({ runId: run.runId, type: 'request' });
    expect(reply.body).toContain('assigned');
    t.touch(12);
    await t.runs.discover(t.forge);
    expect(t.db.prepare('SELECT count(*) AS n FROM runs').get().n).toBe(1);
    // and the runner can report on the assigned id
    t.say(12, 'runner-bot', formatRunComment(run.runId, { state: 'claimed' }));
    await t.runs.follow(t.forge);
    expect((await t.runs.get(run.runId)).status).toBe('claimed');
  });

  it('with an id cornfield could not confirm is tried again next look, and leaves no run behind', async () => {
    const t = setup();
    t.say(12, 'maintainer-one', fence('', { kind: 'summary', refs: { issue: 12 }, brief: '' }));
    t.world.postFails = true;
    expect(await t.runs.discover(t.forge)).toMatchObject({ imported: 0 });
    expect(t.db.prepare('SELECT count(*) AS n FROM runs').get().n).toBe(0);
    t.world.postFails = false;
    expect(await t.runs.discover(t.forge)).toMatchObject({ imported: 1 });
    expect(t.db.prepare('SELECT count(*) AS n FROM runs').get().n).toBe(1);
  });
});

describe('who and what is believed', () => {
  it('ignores a non-maintainer\'s block and shows it with the reason', async () => {
    const t = setup();
    t.say(12, 'stranger', block());
    expect(await t.runs.discover(t.forge)).toMatchObject({ imported: 0, refused: 1 });
    const list = await t.runs.list();
    expect(list.runs).toEqual([]);
    expect(list.handWritten.refused).toHaveLength(1);
    expect(list.handWritten.refused[0]).toMatchObject({ by: 'stranger', number: 12, runId: RUN, why: 'author' });
    expect(list.handWritten.refused[0].reason).toContain('not a maintainer');
    expect(handLines(list)[0]).toContain('started nothing');
    expect(t.actions()[0].answer).toMatchObject({ accepted: false, why: 'author' });
  });

  it('ignores a comment edited after it was posted, whether the id is in the fence or not', async () => {
    const t = setup();
    t.say(12, 'maintainer-one', block(), { updatedAt: iso(T0 + 60_000) });
    t.say(12, 'maintainer-one', fence('', { kind: 'summary', refs: { issue: 12 }, brief: '' }), { updatedAt: iso(T0 + 60_000) });
    await t.runs.discover(t.forge);
    expect(t.db.prepare('SELECT count(*) AS n FROM runs').get().n).toBe(0);
    const why = (await t.runs.list()).handWritten.refused.map((r) => r.why);
    expect(why).toEqual(['edited', 'edited']);
  });

  it('lists a malformed block with its reason and starts nothing', async () => {
    const t = setup();
    t.say(12, 'maintainer-one', block().replace('"kind"', '"surprise": 1,\n  "kind"'));
    t.say(12, 'maintainer-one', fence('run-not-an-id', '{}'));
    t.say(12, 'maintainer-one', fence('', '{ nope'));
    t.say(12, 'maintainer-one', fence('', { kind: 'summary', refs: { issue: 12 }, brief: `key ${['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join('')}` }));
    await t.runs.discover(t.forge);
    expect(t.db.prepare('SELECT count(*) AS n FROM runs').get().n).toBe(0);
    const shown = (await t.runs.list()).handWritten.refused;
    expect(shown).toHaveLength(4);
    expect(shown.every((r) => r.why === 'malformed' && r.reason.length > 0)).toBe(true);
    expect(shown.map((r) => r.reason).join('\n')).toMatch(/surprise|not a run id|not JSON|credential|secret/i);
    // a stranger's garbage is nobody's business
    t.say(12, 'stranger', fence('', '{ nope'));
    await t.runs.discover(t.forge);
    expect((await t.runs.list()).handWritten.refused).toHaveLength(4);
  });

  it('ignores a request older than agents.quietAfter, saying why', async () => {
    const t = setup();
    t.say(12, 'maintainer-one', block(), { createdAt: iso(T0 - 30 * HOUR), updatedAt: iso(T0 - 30 * HOUR) });
    await t.runs.discover(t.forge);
    expect(t.db.prepare('SELECT count(*) AS n FROM runs').get().n).toBe(0);
    expect((await t.runs.list()).handWritten.refused[0]).toMatchObject({ why: 'old' });
  });
});

describe('cornfield\'s own blocks', () => {
  async function asked(t) {
    const posted = t.say(12, 'maintainer-one', block());
    t.db.prepare("INSERT INTO runs (run_id, repo, kind, target, comment_id, comment_url, request, requested_by, requested_by_id, requested_at, last_activity, issue) VALUES (?, 'owner/name', 'code', 12, ?, ?, ?, 'maintainer-one', '1001', ?, ?, 12)")
      .run(RUN, posted.id, posted.url, JSON.stringify(request()), iso(T0), iso(T0));
    return posted;
  }

  it('are not imported again, even when the maintainer is no longer one', async () => {
    const t = setup();
    await asked(t);
    t.world.perms['maintainer-one'] = 'read';
    expect(await t.runs.discover(t.forge)).toMatchObject({ imported: 0, refused: 0 });
    expect(t.db.prepare('SELECT count(*) AS n FROM runs').get().n).toBe(1);
    expect(t.db.prepare('SELECT via FROM runs').get().via).toBe('dashboard');
    expect(t.actions()).toEqual([]);
  });

  it('are not imported while their post is still in flight', async () => {
    const t = setup();
    t.say(12, 'maintainer-one', block());
    t.db.prepare("INSERT INTO runs (run_id, repo, kind, target, comment_id, request, requested_by, requested_by_id, requested_at, last_activity, issue) VALUES (?, 'owner/name', 'code', 12, '', ?, 'maintainer-one', '1001', ?, ?, 12)")
      .run(RUN, JSON.stringify(request()), iso(T0), iso(T0));
    await t.runs.discover(t.forge);
    expect(t.actions()).toEqual([]);
    expect(t.db.prepare('SELECT count(*) AS n FROM runs').get().n).toBe(1);
  });

  it('copied into a new comment, are refused as a second run for the same block', async () => {
    const t = setup();
    await asked(t);
    t.say(14, 'maintainer-two', block());
    await t.runs.discover(t.forge);
    expect(t.db.prepare('SELECT count(*) AS n FROM runs').get().n).toBe(1);
    expect((await t.runs.list()).handWritten.refused[0]).toMatchObject({ why: 'duplicate', by: 'maintainer-two' });
  });

  it('through a request over cornfield\'s own path are never imported (the whole round trip)', async () => {
    const t = setup();
    const ctx = { forge: () => t.forge, who: { login: 'maintainer-one', userId: '1001' }, limits: { auth: t.auth, now: () => t.clock.now } };
    const made = await t.runs.request(ctx, { body: { kind: 'summary', refs: { issue: 12 }, brief: '' } });
    t.touch(12);
    expect(await t.runs.discover(t.forge)).toMatchObject({ imported: 0, refused: 0 });
    expect(t.db.prepare('SELECT count(*) AS n FROM runs').get().n).toBe(1);
    expect(t.db.prepare('SELECT via FROM runs WHERE run_id = ?').get(made.run.runId).via).toBe('dashboard');
  });
});

describe('the cap and the one-run-per-subject rule', () => {
  it('refuse a hand-written request with their reason, and it is shown', async () => {
    const t = setup({ agents: { maxOpen: 1 } });
    t.say(12, 'maintainer-one', block());
    t.say(14, 'maintainer-one', block({ runId: RUN2, refs: { issue: 14 } }));
    await t.runs.discover(t.forge);
    expect((await t.runs.list()).runs.map((r) => r.runId)).toEqual([RUN]);
    const shown = (await t.runs.list()).handWritten.refused;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ runId: RUN2, why: 'cap-reached' });
    expect(shown[0].reason).toContain('agents.maxOpen');
  });

  it('refuse a second open run on the same issue and profile', async () => {
    const t = setup();
    t.say(12, 'maintainer-one', block());
    t.say(12, 'maintainer-one', block({ runId: RUN2 }));
    await t.runs.discover(t.forge);
    expect((await t.runs.list()).runs).toHaveLength(1);
    expect((await t.runs.list()).handWritten.refused[0]).toMatchObject({ runId: RUN2, why: 'run-open' });
  });

  it('count a hand-written run toward the cap for cornfield\'s own asking', async () => {
    const t = setup({ agents: { maxOpen: 1 } });
    t.say(12, 'maintainer-one', block());
    await t.runs.discover(t.forge);
    const ctx = { forge: () => t.forge, who: { login: 'maintainer-one', userId: '1001' }, limits: { auth: t.auth, now: () => t.clock.now } };
    await expect(t.runs.request(ctx, { body: { kind: 'summary', refs: { issue: 14 }, brief: '' } })).rejects.toMatchObject({ code: 'cap-reached' });
    // and its subject is taken: asking again for the issue is run-open
    expect(await t.runs.openOn({ number: 12 })).toBe(RUN);
  });
});

describe('which conversations are read (agents.handWritten)', () => {
  it('"labeled" reads only those with the threads label', async () => {
    const t = setup({ agents: { handWritten: 'labeled' } });
    t.say(12, 'maintainer-one', block());
    t.say(13, 'maintainer-one', block({ runId: RUN2, refs: { issue: 13 } }));
    await t.runs.discover(t.forge);
    expect((await t.runs.list()).runs.map((r) => r.runId)).toEqual([RUN2]);
  });

  it('false looks at nothing', async () => {
    const t = setup({ agents: { handWritten: false } });
    t.say(12, 'maintainer-one', block());
    expect(t.runs.discovers).toBe(false);
    expect(await t.runs.discover(t.forge)).toEqual({ read: 0, imported: 0, refused: 0 });
    expect(t.world.calls).toEqual([]);
    expect((await t.runs.list()).handWritten).toEqual({ mode: false, refused: [] });
  });

  it('is on by default', () => {
    expect(setup().runs.discovers).toBe(true);
  });
});
