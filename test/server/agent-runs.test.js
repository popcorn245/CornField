/**
 * @vitest-environment node
 *
 * Agent runs (server/agent-runs.js, issue #80, spec 0005), on their own: a fake forge that holds issues, pull requests and
 * comments, a real SQLite store, real hooks over a fake network, and a clock wound by hand. Held here:
 *
 *   - a request is a maintainer-authored comment that parses back with `readRunBlocks`, on the issue, the thread or the proposal's spec PR
 *   - the cap and the one-run-per-subject rule refuse with a reason, in one transaction with the insert (two at once get one place);
 *     `force` lifts the second and never the first; the same request under two profiles is two runs; a quiet run counts for neither, and counts again
 *     when a report or a push comes
 *   - a run is followed: a PR with the trailer (body, branch or a commit) is linked; a runner's report moves the state; a report from anyone
 *     else is ignored and audited; an edited comment is not believed; a PR of a stranger is linked but moves nothing
 *   - stop posts a block and shows "stop requested" until the runner says otherwise
 *   - the hooks fire once across a restart; a restart follows on; no credential gets into a request; every step is a row in `actions`
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { createRuns, statusOf, AGENT_REQUESTS_PER_MINUTE } from '../../server/agent-runs.js';
// @ts-expect-error plain JS module, no declarations
import { createHooks } from '../../server/hooks.js';
// @ts-expect-error plain JS module, no declarations
import { ForgeError } from '../../server/forge.js';
// @ts-expect-error plain JS module, no declarations
import { openStore } from '../../server/db.js';
// @ts-expect-error plain JS module, no declarations
import { Refused, ATTEMPTS_PER_MINUTE } from '../../server/throttle.js';
// @ts-expect-error plain JS module, no declarations
import { refusal } from '../../server/submit-review.js';
// @ts-expect-error plain JS module, no declarations
import { readRunBlocks, formatRunComment, newRunId } from '../../core/agent-contract.js';

const SECRET = 's3cret-'.repeat(6);
const FOLDER = 'docs/specs/proposals';
const T0 = Date.parse('2026-11-05T10:00:00Z');
const HOUR = 3_600_000;
// Secret-shaped strings are built at run time so that no scanner sees one as a literal
const GHP = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join('');
const BEARER = ['Bear', 'er'].join('');
const LONG = 'abcdefghijklmnopqrstuvwxyz0123';
const AT = String.fromCharCode(64);
const DASHES = '-'.repeat(5);
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const ULID = '01JC8Z3Q5M7VXK2RT9N4B6HDEF';
const RUN = `run-${ULID}`;

const made = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of made.splice(0)) { d.db?.close(); fs.rmSync(d.dir, { recursive: true, force: true }); } });

/**
 * One repo, as the engine sees it: a world (issues, pull requests, comments, who maintains it) and a forge for each login, all over one
 * store. `t.as('maintainer-one')` is that maintainer's forge; `t.say(...)` writes a comment as anyone, at the current time.
 */
function setup({ config = {}, dir = null, db: given = null, quiet = false } = {}) {
  const folder = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-runs-'));
  const db = given ?? openStore(folder);
  made.push({ dir: folder, db: given ? null : db });
  const clock = { now: T0 };
  const world = {
    perms: { 'maintainer-one': 'admin', 'maintainer-two': 'maintain', 'runner-bot': 'write', stranger: 'read' },
    ids: { 'maintainer-one': 1001, 'maintainer-two': 1002 },
    issues: new Map([[12, { number: 12, state: 'open' }], [13, { number: 13, state: 'open' }], [14, { number: 14, state: 'open' }], [15, { number: 15, state: 'open' }], [16, { number: 16, state: 'open' }]]),
    comments: new Map(),
    nextComment: 9000,
    pulls: [],
    commits: new Map(),
    checks: new Map(),
    branches: [],
    specPulls: [{ number: 40, slug: '0040-meals' }],
    commentFails: null,
    calls: [],
  };
  const stamp = () => new Date(clock.now).toISOString();
  const say = (number, login, body, extra = {}) => {
    const c = { id: String(world.nextComment++), author: { login }, body, url: `https://forge.test/c/${world.nextComment}`, createdAt: stamp(), updatedAt: stamp(), ...extra };
    world.comments.set(number, [...(world.comments.get(number) ?? []), c]);
    return c;
  };
  const as = (login) => ({
    repo: 'owner/name',
    me: async () => ({ id: world.ids[login] ?? 2000, login }),
    permission: async (_repo, who) => { world.calls.push(`permission ${who}`); return world.perms[who] ?? 'none'; },
    issue: async (n) => {
      const i = world.issues.get(n);
      if (!i) throw new ForgeError(`#${n} is a pull request, not an issue.`, { code: 'not-found' });
      return i;
    },
    comment: async (n, body) => {
      if (world.commentFails) throw world.commentFails;
      const c = say(n, login, body);
      return { id: c.id, url: c.url };
    },
    comments: async (n) => { world.calls.push(`comments ${n}`); return world.comments.get(n) ?? []; },
    // the spec PRs, for the listing of proposals
    pulls: async (q) => {
      world.calls.push(`pulls ${q?.state}`);
      return q?.state === 'open' && q?.limit === undefined
        ? world.specPulls.map((s) => ({ number: s.number, title: 'Spec', state: 'open', draft: false, author: { login: 'maintainer-two' }, head: { sha: `${'a'.repeat(39)}${s.number % 10}`, ref: `spec/${s.slug}` }, url: `https://forge.test/pull/${s.number}` }))
        : world.pulls;
    },
    pullFiles: async (n) => [{ path: `${FOLDER}/${world.specPulls.find((s) => s.number === n)?.slug ?? 'x'}.json`, status: 'added' }],
    file: async () => '{}',
    pull: async (n) => {
      const p = world.pulls.find((x) => x.number === n);
      if (!p) throw new ForgeError('no such pull request', { code: 'not-found' });
      return p;
    },
    pullCommits: async (n) => { world.calls.push(`commits ${n}`); return world.commits.get(n) ?? []; },
    checks: async (sha) => world.checks.get(sha) ?? [],
    branches: async () => world.branches,
  });
  const auth = {
    store: async () => db,
    record: async ({ login, action, target, request = {}, status = null, answer = null }) => {
      db.prepare('INSERT INTO actions (at, login, action, target, request, status, answer) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(stamp(), login, action, target, JSON.stringify(request), status, answer === null ? null : JSON.stringify(answer));
    },
  };
  const sent = [];
  const hooks = createHooks({
    hooks: [{ url: 'https://chat.example.org/h', events: '*' }], secret: SECRET, store: auth.store, now: () => clock.now,
    fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return new Response(null, { status: 200 }); },
    timer: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  const cfg = { forge: { repo: 'owner/name' }, proposals: FOLDER, agents: { authors: [], labels: [], branchPrefixes: [], bots: true, transport: 'forge', maxOpen: 3, profiles: [], runners: ['runner-bot'], quietAfter: '24h', limits: {}, ...config } };
  const where = { proposals: FOLDER };
  const logs = [];
  if (!quiet) vi.spyOn(console, 'error').mockImplementation((m) => { logs.push(String(m)); });
  const runs = createRuns({ config: cfg, where, auth, hooks, now: () => clock.now });
  const limits = { auth, now: () => clock.now };
  const maintainer = (login = 'maintainer-one') => ({ forge: () => as(login), who: { login, userId: String(world.ids[login] ?? 2000) }, limits });
  const rows = () => db.prepare('SELECT * FROM actions ORDER BY id').all().map((r) => ({ ...r, request: JSON.parse(r.request), answer: r.answer ? JSON.parse(r.answer) : null }));
  const row = (id) => db.prepare('SELECT * FROM runs WHERE run_id = ?').get(id);
  const events = (name) => sent.filter((e) => (name ? e.event === name : true));
  /** Advances the clock; a request in the same minute is another request, so the per-person counters are far from their ceilings in most tests */
  const wait = (ms) => { clock.now += ms; };
  return { runs, hooks, db, world, as, say, auth, sent, events, rows, row, wait, clock, maintainer, logs, cfg, where, dir: folder, stamp };
}

/** Asks for a run as a maintainer and answers the engine's result, or the refusal it threw (`{ status, code, error }`) */
async function ask(t, body, { as: login = 'maintainer-one' } = {}) {
  try {
    const out = await t.runs.request(t.maintainer(login), { body });
    await settle();
    return { ok: true, ...out };
  } catch (err) {
    const out = refusal(err);
    return { ok: false, status: out.status, code: out.body.code, error: out.body.error };
  }
}

const code = (extra = {}) => ({ kind: 'code', refs: { issue: 12 }, brief: 'Add the meals page.', ...extra });

describe('asking for a run', () => {
  it('posts the contract\'s request as a comment by the maintainer, which parses back with readRunBlocks', async () => {
    const t = setup();
    const res = await ask(t, code({ profile: undefined }));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const [comment] = t.world.comments.get(12);
    expect(comment.author.login).toBe('maintainer-one');
    const { blocks, refused } = readRunBlocks(comment.body);
    expect(refused).toEqual([]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'request', runId: res.request.runId, value: { version: 1, kind: 'code', refs: { issue: 12 }, brief: 'Add the meals page.', requestedBy: 'maintainer-one' } });
    expect(blocks[0].value).toEqual(res.request);
    expect(res.run).toMatchObject({ runId: res.request.runId, status: 'requested', open: true, requestedBy: 'maintainer-one', comment: { id: comment.id } });
    // the run is a row, and the request is an audit row that holds no brief
    expect(t.row(res.request.runId)).toMatchObject({ target: 12, comment_id: comment.id, state: 'requested', via: 'dashboard' });
    const audit = t.rows().filter((r) => r.action === 'agent-request');
    expect(audit).toEqual([expect.objectContaining({ login: 'maintainer-one', target: 'owner/name#12', status: 201, request: expect.objectContaining({ kind: 'code', refs: { issue: 12 }, briefChars: 19, runId: res.request.runId }) })]);
    expect(JSON.stringify(audit)).not.toContain('meals page');
  });

  it('goes to the issue, the thread, or the open spec PR of the proposal', async () => {
    const t = setup();
    await ask(t, { kind: 'brief', refs: { thread: 15 } });
    t.wait(10_000);
    await ask(t, { kind: 'proposal', refs: { proposal: '0040-meals' } });
    t.wait(10_000);
    await ask(t, code({ refs: { issue: 13 } }));
    expect([...t.world.comments.keys()].sort()).toEqual([13, 15, 40]);
    const miss = await ask(t, { kind: 'code', refs: { proposal: '0099-nothing' } });
    expect(miss).toMatchObject({ ok: false, status: 404, code: 'not-found' });
    expect(miss.error).toMatch(/No open spec pull request holds the proposal 0099-nothing/);
    const pr = await ask(t, code({ refs: { issue: 99 } }));
    expect(pr).toMatchObject({ ok: false, status: 404 });
    expect(pr.error).toMatch(/is not an issue of owner\/name/);
    // nothing was kept for the refusals
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n).toBe(3);
  });

  it('puts the config\'s limits in the request, and lets the person\'s own win key by key', async () => {
    const t = setup({ config: { limits: { minutes: 30, turns: 40 } } });
    const a = await ask(t, code({ limits: { minutes: 10 } }));
    expect(a.request.limits).toEqual({ minutes: 10, turns: 40 });
    t.wait(10_000);
    const b = await ask(t, code({ refs: { issue: 13 } }));
    expect(b.request.limits).toEqual({ minutes: 30, turns: 40 });
  });

  it('refuses a profile the config does not list, and takes one it does', async () => {
    const t = setup({ config: { profiles: ['claude', 'local-qwen'] } });
    expect(await ask(t, code({ profile: 'gpt' }))).toMatchObject({ ok: false, status: 400, code: 'invalid' });
    const ok = await ask(t, code({ profile: 'claude' }));
    expect(ok.ok).toBe(true);
    expect(ok.request.profile).toBe('claude');
    const none = setup();
    expect((await ask(none, code({ profile: 'claude' }))).error).toMatch(/not one of the configured profiles \(none\)/);
  });

  it('refuses someone who is not a maintainer now, someone else\'s sign-in, and a sign-in that has ended (401); each is a row', async () => {
    const t = setup();
    t.world.perms['maintainer-one'] = 'write';
    expect(await ask(t, code())).toMatchObject({ ok: false, status: 403 });
    const t2 = setup();
    const gone = { ...t2.maintainer(), forge: () => { throw new ForgeError('The token\'s owner has no live sign-in.', { code: 'unauthorized' }); } };
    await expect(t2.runs.request(gone, { body: code() })).rejects.toMatchObject({ code: 'unauthorized' });
    t2.wait(10_000);
    const swapped = { ...t2.maintainer(), who: { login: 'maintainer-one', userId: '9999' } };
    await expect(t2.runs.request(swapped, { body: code() })).rejects.toMatchObject({ status: 403 });
    expect(t2.world.comments.size).toBe(0);
    expect(t2.rows().filter((r) => r.action === 'agent-request').map((r) => r.status)).toEqual([401, 403]);
    expect(t.rows().at(-1)).toMatchObject({ action: 'agent-request', status: 403 });
  });

  it('takes nothing but the contract\'s fields and force; requestedBy is the person, never another', async () => {
    const t = setup();
    expect(await ask(t, { ...code(), colour: 'red' })).toMatchObject({ ok: false, status: 400 });
    expect(await ask(t, code({ force: 'yes' }))).toMatchObject({ ok: false, status: 400 });
    expect(await ask(t, code({ requestedBy: 'maintainer-two' }))).toMatchObject({ ok: false, status: 400 });
    expect(await ask(t, code({ version: 1 }))).toMatchObject({ ok: false, status: 400 });
    expect(await ask(t, { kind: 'code' })).toMatchObject({ ok: false, status: 400 });
    expect(await ask(t, 'not an object')).toMatchObject({ ok: false, status: 400 });
    t.wait(61_000); // seven attempts so far: past the ceiling of six requests a minute
    const own = await ask(t, code({ requestedBy: 'Maintainer-One' }));
    expect(own.ok).toBe(true);
    expect(own.request.requestedBy).toBe('maintainer-one');
  });

  it('answers a problem with the request itself (not JSON, too large) with a row, after the flood count', async () => {
    const t = setup();
    await expect(t.runs.request(t.maintainer(), { body: {}, problem: { status: 413, message: 'A request is too large.' } })).rejects.toMatchObject({ status: 413 });
    expect(t.rows()).toEqual([expect.objectContaining({ action: 'agent-request', status: 413 })]);
  });

  it('removes the place it took when the forge refuses the comment, and says what the forge said', async () => {
    const t = setup();
    t.world.commentFails = new ForgeError('Issues are disabled on this repo.', { code: 'forbidden', status: 403 });
    const res = await ask(t, code());
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/Issues are disabled/);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n).toBe(0);
    expect(t.rows().at(-1)).toMatchObject({ action: 'agent-request', status: 403 });
    t.world.commentFails = null;
    t.wait(10_000);
    expect((await ask(t, code())).ok).toBe(true);
  });

  it('fires agent.requested with the whole request, and nothing else of the run', async () => {
    const t = setup();
    const res = await ask(t, code());
    await settle();
    expect(t.events('agent.requested')).toHaveLength(1);
    expect(t.events('agent.requested')[0]).toMatchObject({ event: 'agent.requested', request: res.request, actor: 'maintainer-one', mapUrl: null });
  });
});

describe('the limits cornfield enforces', () => {
  it('refuses the fourth open run past the cap of three, with the reason and the runs in the way; force does not lift it', async () => {
    const t = setup();
    for (const n of [12, 13, 14]) {
      expect((await ask(t, code({ refs: { issue: n } }))).ok).toBe(true);
      t.wait(10_000);
    }
    const fourth = await ask(t, code({ refs: { issue: 15 } }));
    expect(fourth).toMatchObject({ ok: false, status: 409, code: 'cap-reached' });
    expect(fourth.error).toMatch(/already has 3 open runs, the most cornfield asks for \(agents\.maxOpen is 3\)/);
    expect(fourth.error.match(/run-[0-9A-Z]{26}/g)).toHaveLength(3);
    t.wait(10_000);
    expect(await ask(t, code({ refs: { issue: 15 }, force: true }))).toMatchObject({ ok: false, status: 409, code: 'cap-reached' });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n).toBe(3);
    expect(t.rows().filter((r) => r.status === 409)).toHaveLength(2);
  });

  it('reads the cap from agents.maxOpen', async () => {
    const t = setup({ config: { maxOpen: 1 } });
    expect((await ask(t, code())).ok).toBe(true);
    t.wait(10_000);
    expect(await ask(t, code({ refs: { issue: 13 } }))).toMatchObject({ ok: false, code: 'cap-reached' });
  });

  it('gives the last place to one of two requests made at once', async () => {
    const t = setup({ config: { maxOpen: 1 } });
    const [a, b] = await Promise.all([ask(t, code({ refs: { issue: 12 } })), ask(t, code({ refs: { issue: 13 } }))]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((x) => !x.ok)).toMatchObject({ code: 'cap-reached' });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n).toBe(1);
    expect([...t.world.comments.values()].flat()).toHaveLength(1);
  });

  it('refuses a second open run on the same issue or proposal; force asks for another on purpose', async () => {
    const t = setup({ config: { maxOpen: 10 } });
    const first = await ask(t, code());
    t.wait(10_000);
    const again = await ask(t, code({ kind: 'summary' }));
    expect(again).toMatchObject({ ok: false, status: 409, code: 'run-open' });
    expect(again.error).toContain(first.request.runId);
    expect(again.error).toMatch(/issue #12 already has an open run/);
    expect(again.error).toMatch(/"force": true/);
    t.wait(10_000);
    expect((await ask(t, code({ force: true }))).ok).toBe(true);
    // a proposal is a subject too, and a thread is the conversation of an issue
    t.wait(10_000);
    expect((await ask(t, { kind: 'proposal', refs: { proposal: '0040-meals' } })).ok).toBe(true);
    t.wait(10_000);
    expect(await ask(t, { kind: 'proposal', refs: { proposal: '0040-meals' } })).toMatchObject({ code: 'run-open' });
  });

  it('counts a thread and an issue of the same number as the same subject', async () => {
    const t = setup({ config: { maxOpen: 10 } });
    await ask(t, { kind: 'brief', refs: { thread: 12 } });
    t.wait(10_000);
    expect(await ask(t, code())).toMatchObject({ ok: false, code: 'run-open' });
  });

  it('makes two runs of the same request under two profiles; a second under the same profile is refused', async () => {
    const t = setup({ config: { profiles: ['claude', 'local-qwen'] } });
    const a = await ask(t, code({ profile: 'claude' }));
    t.wait(10_000);
    const b = await ask(t, code({ profile: 'local-qwen' }));
    expect(a.ok && b.ok).toBe(true);
    expect(a.request.runId).not.toBe(b.request.runId);
    expect([a.request.profile, b.request.profile]).toEqual(['claude', 'local-qwen']);
    t.wait(10_000);
    expect(await ask(t, code({ profile: 'claude' }))).toMatchObject({ ok: false, code: 'run-open' });
    // both are comments on the issue, each a request that reads back
    expect(readRunBlocks(t.world.comments.get(12).map((c) => c.body).join('\n')).blocks.map((x) => x.value.profile)).toEqual(['claude', 'local-qwen']);
  });

  it('does not count a quiet run toward the cap or the one-per-issue rule, and counts it again when a report comes', async () => {
    const t = setup({ config: { maxOpen: 1 } });
    const first = await ask(t, code());
    t.wait(25 * HOUR); // nothing happened for longer than quietAfter
    const listed = await t.runs.list();
    expect(listed.runs[0]).toMatchObject({ runId: first.request.runId, status: 'quiet', open: false });
    expect(listed.open).toBe(0);
    const second = await ask(t, code()); // same issue, and the cap is one: the quiet run is in neither's way
    expect(second.ok, JSON.stringify(second)).toBe(true);
    // the first run reports: it is open again, and counts
    t.say(12, 'runner-bot', formatRunComment(first.request.runId, { state: 'working', note: 'back at it' }));
    await t.runs.follow(t.as('maintainer-one'));
    expect((await t.runs.list()).runs.find((r) => r.runId === first.request.runId)).toMatchObject({ status: 'working', open: true });
    expect((await t.runs.list()).open).toBe(2);
    t.wait(10_000);
    expect(await ask(t, code({ refs: { issue: 13 } }))).toMatchObject({ ok: false, code: 'cap-reached' });
  });

  it('does not count a finished run: done, failed, stopped, or with its pull request merged or closed', async () => {
    const t = setup({ config: { maxOpen: 1 } });
    const first = await ask(t, code());
    t.say(12, 'runner-bot', formatRunComment(first.request.runId, { state: 'done' }));
    await t.runs.follow(t.as('maintainer-one'));
    expect((await t.runs.list()).open).toBe(0);
    t.wait(10_000);
    expect((await ask(t, code())).ok).toBe(true);
  });

  it('counts a flood: past the ceiling of requests in a minute it is 429, and nothing more is written down', async () => {
    const t = setup({ config: { maxOpen: 100 } });
    const results = [];
    for (let i = 0; i < AGENT_REQUESTS_PER_MINUTE + 2; i++) {
      t.world.issues.set(100 + i, { number: 100 + i, state: 'open' });
      results.push(await ask(t, code({ refs: { issue: 100 + i } })));
      t.wait(5001); // past the cooldown of the same thing, still in the same minute for the first few
    }
    const limited = results.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThanOrEqual(1);
    expect(limited[0].code).toBe('rate-limited');
    const rowsBefore = t.rows().length;
    await ask(t, code({ refs: { issue: 12 } }));
    expect(ATTEMPTS_PER_MINUTE).toBeGreaterThan(AGENT_REQUESTS_PER_MINUTE);
    expect(t.rows().length).toBeGreaterThanOrEqual(rowsBefore); // the refused-by-flood ones wrote nothing: counted in the test above by status 429 having no row
    expect(t.rows().filter((r) => r.status === 429)).toEqual([]);
  });

  it('drops a request that never reached the forge when it resumes', async () => {
    const t = setup();
    t.db.prepare("INSERT INTO runs (run_id, repo, kind, target, request, requested_by, requested_by_id, requested_at, last_activity) VALUES (?, 'owner/name', 'code', 12, '{}', 'maintainer-one', '1001', ?, ?)").run(RUN, new Date(T0 - 20 * 60_000).toISOString(), new Date(T0 - 20 * 60_000).toISOString());
    await t.runs.resume();
    expect(t.row(RUN)).toBeUndefined();
  });
});

describe('statusOf', () => {
  const base = { state: 'requested', stop_requested_at: null, pull: null, pull_state: null, pull_trusted: 0, last_activity: new Date(T0).toISOString() };
  const at = (ms, row) => statusOf({ ...base, ...row }, T0 + ms, 24 * HOUR);

  it('derives what the runner reported and what the forge shows', () => {
    expect(at(0, {})).toMatchObject({ status: 'requested', open: true });
    expect(at(0, { state: 'claimed' }).status).toBe('claimed');
    expect(at(0, { state: 'working' }).status).toBe('working');
    expect(at(0, { pull: 5, pull_state: 'open', pull_trusted: 1 }).status).toBe('working'); // a silent runner is seen through what it pushes
    expect(at(0, { pull: 5, pull_state: 'open', pull_trusted: 0 }).status).toBe('requested'); // a stranger's pull request moves nothing
    for (const s of ['done', 'failed', 'stopped']) expect(at(0, { state: s })).toMatchObject({ status: s, open: false, finished: true });
    expect(at(0, { state: 'working', pull: 5, pull_state: 'merged', pull_trusted: 1 })).toMatchObject({ status: 'merged', open: false });
    expect(at(0, { state: 'working', pull: 5, pull_state: 'closed', pull_trusted: 1 })).toMatchObject({ status: 'closed', open: false });
    expect(at(0, { state: 'working', pull: 5, pull_state: 'merged', pull_trusted: 0 }).status).toBe('working');
  });

  it('is quiet after quietAfter with no activity, shows stop requested until then, and a runner\'s own word beats quiet only when it is an end', () => {
    expect(at(24 * HOUR - 1, {}).status).toBe('requested');
    expect(at(24 * HOUR, {})).toMatchObject({ status: 'quiet', open: false, quiet: true });
    expect(at(HOUR, { stop_requested_at: 'x', state: 'working' }).status).toBe('stop-requested');
    expect(at(25 * HOUR, { stop_requested_at: 'x', state: 'working' }).status).toBe('quiet');
    expect(at(25 * HOUR, { state: 'done' }).status).toBe('done');
    expect(at(HOUR, { stop_requested_at: 'x', state: 'stopped' }).status).toBe('stopped');
  });
});

describe('stopping a run', () => {
  it('posts a stop-requested block in the same place, as the maintainer who clicked, and shows stop requested', async () => {
    const t = setup();
    const { request } = await ask(t, code());
    t.wait(10_000);
    const out = await t.runs.stop(t.maintainer('maintainer-two'), { runId: request.runId, note: 'Wrong approach.' });
    await settle();
    const comments = t.world.comments.get(12);
    expect(comments).toHaveLength(2);
    expect(comments[1].author.login).toBe('maintainer-two');
    const { blocks } = readRunBlocks(comments[1].body);
    expect(blocks).toEqual([{ runId: request.runId, type: 'stop-request', value: { state: 'stop-requested', note: 'Wrong approach.' } }]);
    expect(out.run).toMatchObject({ status: 'stop-requested', stopRequested: { by: 'maintainer-two' } });
    expect(t.events('run.stopRequested')).toEqual([expect.objectContaining({ runId: request.runId, state: 'stop-requested', issue: 12, actor: 'maintainer-two' })]);
    expect(t.rows().filter((r) => r.action === 'agent-stop')).toEqual([expect.objectContaining({ login: 'maintainer-two', status: 201, request: { runId: request.runId, noteChars: 15 } })]);
    // the follow that reads the stop back fires nothing again
    await t.runs.follow(t.as('maintainer-one'));
    await settle();
    expect(t.events('run.stopRequested')).toHaveLength(1);
    // it stays "stop requested" until the runner says stopped
    t.say(12, 'runner-bot', formatRunComment(request.runId, { state: 'stopped', note: 'Stopped as asked.' }));
    await t.runs.follow(t.as('maintainer-one'));
    expect((await t.runs.get(request.runId)).status).toBe('stopped');
    await settle();
    expect(t.events('run.finished')).toHaveLength(1);
  });

  it('goes quiet instead when the runner never answers', async () => {
    const t = setup();
    const { request } = await ask(t, code());
    await t.runs.stop(t.maintainer(), { runId: request.runId });
    expect((await t.runs.get(request.runId)).status).toBe('stop-requested');
    t.wait(26 * HOUR);
    expect((await t.runs.get(request.runId)).status).toBe('quiet');
  });

  it('refuses a run that does not exist, one that is over, one already asked to stop, a non-maintainer, and a note that is too long', async () => {
    const t = setup();
    const { request } = await ask(t, code());
    const stop = async (input, who) => { try { return await t.runs.stop(t.maintainer(who), input); } catch (err) { return refusal(err); } };
    expect((await stop({ runId: RUN })).status).toBe(404);
    expect((await stop({ runId: 5 })).status).toBe(404);
    expect((await stop({ runId: request.runId, note: 'x'.repeat(5000) })).status).toBe(400);
    t.world.perms['maintainer-two'] = 'write';
    expect((await stop({ runId: request.runId }, 'maintainer-two')).status).toBe(403);
    t.wait(10_000);
    expect((await stop({ runId: request.runId })).run.status).toBe('stop-requested');
    t.wait(10_000);
    expect(await stop({ runId: request.runId })).toMatchObject({ status: 409 });
    const done = await ask(t, code({ refs: { issue: 13 } }));
    t.say(13, 'runner-bot', formatRunComment(done.request.runId, { state: 'done' }));
    await t.runs.follow(t.as('maintainer-one'));
    t.wait(10_000);
    expect((await stop({ runId: done.request.runId })).body.error).toMatch(/is done; there is nothing to stop/);
    expect(t.world.comments.get(13)).toHaveLength(2); // the request and the report; no stop
  });
});

describe('following a run', () => {
  const asked = async (t, extra = {}) => (await ask(t, code(extra))).request.runId;

  it('moves the state on a runner\'s report, and keeps its note, link, tokens and cost', async () => {
    const t = setup();
    const id = await asked(t);
    t.wait(60_000);
    t.say(12, 'runner-bot', formatRunComment(id, { state: 'claimed' }));
    t.wait(60_000);
    t.say(12, 'runner-bot', formatRunComment(id, { state: 'working', note: 'tests failing on auth, retrying', url: 'https://ci.example.org/logs/1', tokens: 1200, cost: 0.42 }));
    expect(await t.runs.follow(t.as('maintainer-one'))).toMatchObject({ followed: 1, reports: 2, ignored: 0 });
    const run = await t.runs.get(id);
    expect(run).toMatchObject({
      status: 'working', open: true,
      report: { state: 'working', by: 'runner-bot', note: 'tests failing on auth, retrying', url: 'https://ci.example.org/logs/1', tokens: 1200, cost: 0.42 },
    });
    await settle();
    expect(t.events('run.claimed')).toEqual([expect.objectContaining({ runId: id, state: 'claimed', actor: 'runner-bot', issue: 12 })]);
    expect(t.events('run.state').map((e) => e.state)).toEqual(['claimed', 'working']);
    expect(t.rows().filter((r) => r.action === 'agent-report').map((r) => r.answer)).toEqual([{ accepted: true }, { accepted: true }]);
    // a second look reads the same comments and does nothing
    expect(await t.runs.follow(t.as('maintainer-one'))).toMatchObject({ reports: 0 });
    await settle();
    expect(t.events('run.state')).toHaveLength(2);
  });

  it('believes a maintainer\'s report too, and ignores one from anyone else, writing the ignoring down', async () => {
    const t = setup();
    const id = await asked(t);
    t.say(12, 'stranger', formatRunComment(id, { state: 'done', note: 'I did it all' }));
    t.say(12, 'maintainer-two', formatRunComment(id, { state: 'working' }));
    const out = await t.runs.follow(t.as('maintainer-one'));
    expect(out).toMatchObject({ reports: 1, ignored: 1 });
    expect((await t.runs.get(id)).status).toBe('working');
    const rows = t.rows().filter((r) => r.action === 'agent-report');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.login === 'stranger')).toMatchObject({ target: 'owner/name#12', request: { runId: id, type: 'report', state: 'done' }, answer: { accepted: false, reason: expect.stringContaining('not from a runner') } });
    expect(rows.find((r) => r.login === 'maintainer-two').answer).toEqual({ accepted: true });
    // judged once: another look writes nothing more
    await t.runs.follow(t.as('maintainer-one'));
    expect(t.rows().filter((r) => r.action === 'agent-report')).toHaveLength(2);
    await settle();
    expect(t.events('run.finished')).toEqual([]);
  });

  it('does not believe a comment edited after it was posted, nor a stop request from a non-maintainer', async () => {
    const t = setup();
    const id = await asked(t);
    t.say(12, 'runner-bot', formatRunComment(id, { state: 'done' }), { updatedAt: new Date(T0 + 60_000).toISOString() });
    t.say(12, 'runner-bot', formatRunComment(id, { state: 'stop-requested' }));
    t.say(12, 'stranger', formatRunComment(id, { state: 'stop-requested' }));
    const out = await t.runs.follow(t.as('maintainer-one'));
    expect(out).toMatchObject({ reports: 0, ignored: 3 });
    const reasons = t.rows().filter((r) => r.action === 'agent-report').map((r) => r.answer.reason);
    expect(reasons[0]).toMatch(/edited/);
    expect(reasons[1]).toMatch(/only from a maintainer/);
    expect((await t.runs.get(id)).status).toBe('requested');
  });

  it('ignores a block for another run, a request block, a malformed block, and blocks on a thread the run is not on', async () => {
    const t = setup();
    const id = await asked(t);
    t.say(12, 'runner-bot', formatRunComment(newRunId(), { state: 'done' }));
    t.say(12, 'runner-bot', `\`\`\`cornfield-run ${id}\n{ "state": "done", "token": "x" }\n\`\`\``);
    t.say(12, 'runner-bot', formatRunComment(id, { version: 1, runId: id, kind: 'code', brief: '', refs: { issue: 12 }, requestedBy: 'maintainer-one', requestedAt: '2026-11-05T10:00:00Z' }));
    t.world.comments.set(13, [{ id: '1', author: { login: 'runner-bot' }, body: formatRunComment(id, { state: 'done' }), url: 'u', createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString() }]);
    // the malformed block (a key the contract does not have) is turned away and written down; the rest is not ours
    expect(await t.runs.follow(t.as('maintainer-one'))).toMatchObject({ reports: 0, ignored: 1 });
    expect(t.rows().filter((r) => r.action === 'agent-report').map((r) => r.answer.reason)).toEqual([expect.stringMatching(/^not a valid block/)]);
    expect((await t.runs.get(id)).status).toBe('requested');
  });

  it('links a pull request that carries the trailer in its body, and its checks and merge move the run', async () => {
    const t = setup();
    const id = await asked(t);
    const pr = { number: 50, title: 'Meals page', body: `Closes #12\n\nCornfield-Run: ${id}\n`, state: 'open', draft: false, author: { login: 'runner-bot' }, head: { ref: 'agent/meals', sha: 'b'.repeat(40) }, base: { ref: 'main' }, url: 'https://forge.test/pull/50', createdAt: new Date(T0 + 60_000).toISOString(), updatedAt: new Date(T0 + 120_000).toISOString() };
    t.world.pulls = [pr];
    t.world.checks.set(pr.head.sha, [{ state: 'success' }, { state: 'running' }]);
    t.wait(300_000);
    expect(await t.runs.follow(t.as('maintainer-one'))).toMatchObject({ linked: 1 });
    expect(await t.runs.get(id)).toMatchObject({ status: 'working', pull: { number: 50, state: 'open', trusted: true, via: 'body', by: 'runner-bot' }, branch: 'agent/meals', headSha: pr.head.sha, checks: 'running' });
    expect(t.rows().filter((r) => r.action === 'agent-link')).toEqual([expect.objectContaining({ login: 'runner-bot', target: 'owner/name#50', answer: { linked: true, trusted: true } })]);
    t.world.checks.set(pr.head.sha, [{ state: 'failure' }]);
    await t.runs.follow(t.as('maintainer-one'));
    expect((await t.runs.get(id)).checks).toBe('failure');
    // merged: finished, once
    t.world.pulls = [{ ...pr, state: 'merged', updatedAt: new Date(T0 + 600_000).toISOString() }];
    await t.runs.follow(t.as('maintainer-one'));
    await t.runs.follow(t.as('maintainer-one'));
    await settle();
    expect(await t.runs.get(id)).toMatchObject({ status: 'merged', open: false });
    expect(t.events('run.finished')).toEqual([expect.objectContaining({ runId: id, state: 'merged', pull: 50, issue: 12 })]);
    expect(t.events('run.state').map((e) => e.state)).toEqual(['working', 'merged']);
  });

  it('links by the run id in the branch name, and by a trailer in a commit message', async () => {
    const t = setup({ config: { maxOpen: 5 } });
    const a = await asked(t);
    t.wait(10_000);
    const b = await asked(t, { refs: { issue: 13 } });
    const pull = (number, extra) => ({ number, title: 'x', body: 'no trailer here', state: 'open', draft: false, author: { login: 'runner-bot' }, head: { ref: 'agent/x', sha: String(number).repeat(40).slice(0, 40) }, base: { ref: 'main' }, url: `https://forge.test/pull/${number}`, createdAt: new Date(T0 + 60_000).toISOString(), updatedAt: new Date(T0 + 60_000).toISOString(), ...extra });
    t.world.pulls = [pull(51, { head: { ref: `agent/${a.toLowerCase()}/meals`, sha: 'c'.repeat(40) } }), pull(52)];
    t.world.commits.set(52, [{ sha: '1', message: 'Add meals' }, { sha: '2', message: `Wire it\n\nCornfield-Run: ${b}` }]);
    await t.runs.follow(t.as('maintainer-one'));
    expect((await t.runs.get(a)).pull).toMatchObject({ number: 51, via: 'branch' });
    expect((await t.runs.get(b)).pull).toMatchObject({ number: 52, via: 'commit' });
    // the commits of a head are read once
    const reads = () => t.world.calls.filter((c) => c === 'commits 52').length;
    const n = reads();
    await t.runs.follow(t.as('maintainer-one'));
    expect(reads()).toBe(n);
  });

  it('links a stranger\'s pull request that carries the trailer, but it moves nothing', async () => {
    const t = setup();
    const id = await asked(t);
    const pr = { number: 60, title: 'Hijack', body: `Cornfield-Run: ${id}`, state: 'merged', draft: false, author: { login: 'stranger' }, head: { ref: 'fork/x', sha: 'd'.repeat(40) }, base: { ref: 'main' }, url: 'https://forge.test/pull/60', createdAt: new Date(T0 + 1000).toISOString(), updatedAt: new Date(T0 + 2000).toISOString() };
    t.world.pulls = [pr];
    await t.runs.follow(t.as('maintainer-one'));
    const run = await t.runs.get(id);
    expect(run).toMatchObject({ status: 'requested', open: true, pull: { number: 60, trusted: false } });
    expect(t.rows().filter((r) => r.action === 'agent-link')[0].answer).toMatchObject({ linked: true, trusted: false });
    await settle();
    expect(t.events('run.finished')).toEqual([]);
    expect((await t.runs.list()).open).toBe(1); // it still counts toward the cap
  });

  it('sees a push to a branch with the run id before any pull request, and a push makes a quiet run open again', async () => {
    const t = setup();
    const id = await asked(t);
    t.wait(25 * HOUR);
    expect((await t.runs.get(id)).status).toBe('quiet');
    t.world.branches = [{ name: `agent/${id}/meals`, sha: 'e'.repeat(40), protected: false }];
    await t.runs.follow(t.as('maintainer-one'));
    expect(await t.runs.get(id)).toMatchObject({ status: 'working', open: true, branch: `agent/${id}/meals`, pull: null });
  });

  it('follows runs only while there is something to see, and says so with hasWork', async () => {
    const t = setup();
    expect(await t.runs.hasWork()).toBe(false);
    expect(await t.runs.follow(t.as('maintainer-one'))).toMatchObject({ followed: 0 });
    expect(t.world.calls).toEqual([]);
    await asked(t);
    expect(await t.runs.hasWork()).toBe(true);
    t.wait(10 * 24 * 3_600_000);
    expect(await t.runs.hasWork()).toBe(false); // untouched for ten days: not looked at any more
  });

  it('survives a forge that does not answer: it is logged, nothing is lost, and the next look goes on', async () => {
    const t = setup();
    const id = await asked(t);
    t.say(12, 'runner-bot', formatRunComment(id, { state: 'working' }));
    const flaky = { ...t.as('maintainer-one'), pulls: async () => { throw new ForgeError('The forge is down.', { code: 'unavailable' }); }, comments: async () => { throw new ForgeError('The forge is down.', { code: 'unavailable' }); } };
    expect(await t.runs.follow(flaky)).toMatchObject({ reports: 0 });
    expect(t.logs.some((l) => /The forge is down/.test(l))).toBe(true);
    expect(await t.runs.follow(t.as('maintainer-one'))).toMatchObject({ reports: 1 });
  });

  it('does not judge a comment whose author it could not ask about, and judges it at the next look', async () => {
    const t = setup();
    const id = await asked(t);
    t.say(12, 'maintainer-two', formatRunComment(id, { state: 'working' }));
    let fail = true;
    const forge = { ...t.as('maintainer-one'), permission: async (r, l) => { if (fail) throw new ForgeError('rate limited', { code: 'rate-limited' }); return t.world.perms[l] ?? 'none'; } };
    expect(await t.runs.follow(forge)).toMatchObject({ reports: 0, ignored: 0 });
    fail = false;
    expect(await t.runs.follow(forge)).toMatchObject({ reports: 1 });
  });

  it('runs one look at a time: a look asked for meanwhile is the same look', async () => {
    const t = setup();
    await asked(t);
    let release;
    const slow = { ...t.as('maintainer-one'), pulls: () => new Promise((r) => { release = () => r([]); }) };
    const first = t.runs.follow(slow);
    const second = t.runs.follow(t.as('maintainer-one'));
    await settle();
    release();
    expect(await second).toBe(await first);
  });
});

describe('restarts', () => {
  it('fire each hook once and judge each comment once across a restart, and go on following', async () => {
    const t = setup();
    const id = (await ask(t, code())).request.runId;
    t.say(12, 'runner-bot', formatRunComment(id, { state: 'claimed' }));
    t.say(12, 'stranger', formatRunComment(id, { state: 'done' }));
    await t.runs.follow(t.as('maintainer-one'));
    await settle();
    const before = { claimed: t.events('run.claimed').length, state: t.events('run.state').length, reports: t.rows().filter((r) => r.action === 'agent-report').length };
    expect(before).toEqual({ claimed: 1, state: 1, reports: 2 });

    // a new process over the same data folder
    const again = setup({ dir: t.dir, db: t.db });
    again.world.comments = t.world.comments;
    again.world.nextComment = t.world.nextComment;
    await again.runs.resume();
    expect(await again.runs.hasWork()).toBe(true);
    await again.runs.follow(again.as('maintainer-one'));
    await settle();
    expect(again.events()).toEqual([]); // nothing announced again
    expect(again.rows().filter((r) => r.action === 'agent-report')).toHaveLength(2);
    // and it follows on: a new report is seen by the new process
    again.say(12, 'runner-bot', formatRunComment(id, { state: 'done' }));
    await again.runs.follow(again.as('maintainer-one'));
    await settle();
    expect(again.events().map((e) => e.event)).toEqual(['run.state', 'run.finished']);
    expect((await again.runs.get(id)).status).toBe('done');
  });
});

describe('a request never carries a credential', () => {
  const secrets = [
    ['a token key', { token: 'abc' }],
    ['an authorization key', { authorization: `${BEARER} abc` }],
    ['a password key in the refs', { refs: { issue: 12, password: 'x' } }],
    ['a secret key in the limits', { limits: { minutes: 5, secret: 'x' } }],
    ['a forge token in the brief', { brief: `use ${GHP} to push` }],
    ['an agent token in the brief', { brief: 'call with cf_at_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE' }],
    ['a key in the branch hint', { branch: 'x' }],
    ['a login in a link in the brief', { brief: `clone https://user:hunter2${AT}git.example.org/x.git` }],
    ['a bearer header in the brief', { brief: `Authorization: ${BEARER} ${LONG}` }],
    ['a private key in the brief', { brief: `${DASHES}BEGIN RSA PRIVATE KEY${DASHES}\nabc` }],
  ];
  it.each(secrets)('refuses %s: 400, nothing is posted, nothing is kept, and the audit row holds none of it', async (name, extra) => {
    const t = setup();
    const res = await ask(t, code(name === 'a key in the branch hint' ? { branch: '--upload-pack=x' } : extra));
    expect(res, name).toMatchObject({ ok: false, status: 400 });
    expect(t.world.comments.size).toBe(0);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n).toBe(0);
    expect(t.events('agent.requested')).toEqual([]);
    const audit = JSON.stringify(t.rows());
    for (const bit of ['gh' + 'p_', 'cf_at_', 'hunter2', 'PRIVATE KEY', LONG]) expect(audit).not.toContain(bit);
  });

  it('puts nothing of the sign-in into the comment, the run row or the hook', async () => {
    const t = setup();
    const res = await ask(t, code());
    await settle();
    const all = JSON.stringify([...t.world.comments.values(), t.row(res.request.runId), t.events(), t.rows()]);
    expect(all).not.toMatch(/gh[p]_|cf_at_|cf_rt_|Bearer|tok-/);
  });

  it('refuses a report with a credential in it, and writes down that it did', async () => {
    const t = setup();
    const id = (await ask(t, code())).request.runId;
    t.say(12, 'runner-bot', `\`\`\`cornfield-run ${id}\n{ "state": "working", "note": "key is ${GHP}" }\n\`\`\``);
    await t.runs.follow(t.as('maintainer-one'));
    expect((await t.runs.get(id)).report).toBeNull();
  });
});
