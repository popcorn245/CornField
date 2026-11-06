/**
 * @vitest-environment node
 *
 * Opt-in triggers (server/triggers.js, issue #83, spec 0005 D10), on their own: a fake forge, a real SQLite store, real hooks and real
 * runs, a clock wound by hand. Held here:
 *
 *   - off by default; with a trigger set, spec.approved and build.opened each request ONE run through the request path the button uses,
 *     as the maintainer who caused it (their sign-in, so the comment is theirs), and the request names the cause (`trigger`)
 *   - `/agent` from a maintainer requests; from anyone else, from an edited comment, or inside code, it does nothing; once per comment,
 *     across a restart
 *   - no live sign-in: an audit row, trigger.skipped, nothing posted; a refusal by the cap: the same, with its code
 *   - no chaining, each case: a runner or a bot as actor, a cornfield-run block, a run's own target or pull request (linked, or only carrying
 *     a run id), a whole run's life (report, pull request, checks, finish) firing nothing, and the events a run makes being no trigger's
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
// @ts-expect-error plain JS module, no declarations
import { createRuns } from '../../server/agent-runs.js';
// @ts-expect-error plain JS module, no declarations
import { createHooks } from '../../server/hooks.js';
// @ts-expect-error plain JS module, no declarations
import { createTriggers, agentCommand } from '../../server/triggers.js';
// @ts-expect-error plain JS module, no declarations
import { ForgeError } from '../../server/forge.js';
// @ts-expect-error plain JS module, no declarations
import { openStore } from '../../server/db.js';
// @ts-expect-error plain JS module, no declarations
import { readRunBlocks, formatRunComment, newRunId, validateRequest } from '../../core/agent-contract.js';
// @ts-expect-error plain JS module, no declarations
import { createCornfieldServer } from '../../server/server.js';

const SECRET = 's3cret-'.repeat(6);
const FOLDER = 'docs/specs/proposals';
const T0 = Date.parse('2026-11-05T10:00:00Z');
const HOUR = 3_600_000;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const ULID = '01JC8Z3Q5M7VXK2RT9N4B6HDEF';
const RUN = `run-${ULID}`;
const FENCE = '`'.repeat(3);

const made = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of made.splice(0)) { d.db?.close(); fs.rmSync(d.dir, { recursive: true, force: true }); } });

const ON = { 'spec.approved': { kind: 'code', profile: 'claude' }, 'build.opened': { kind: 'code', profile: 'claude' }, 'thread.message': { kind: 'summary', profile: 'claude' } };

/**
 * One repo with triggers: a world the forge answers from, sessions in the store (who is signed in), and the engine, hooks and triggers over
 * one database. `reopen()` builds them again over the same database, as a restart does.
 */
function setup({ on = ON, config = {}, signedIn = ['maintainer-one', 'maintainer-two'], dir = null, quiet = false } = {}) {
  const folder = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-triggers-'));
  const db = openStore(folder);
  made.push({ dir: folder, db });
  const clock = { now: T0 };
  const stamp = () => new Date(clock.now).toISOString();
  const world = {
    perms: { 'maintainer-one': 'admin', 'maintainer-two': 'maintain', 'runner-bot': 'write', stranger: 'read', 'robot[bot]': 'write' },
    ids: { 'maintainer-one': 1001, 'maintainer-two': 1002, 'runner-bot': 1003, stranger: 1004 },
    issues: new Map([12, 13, 14, 15, 16, 60].map((n) => [n, { number: n, state: 'open', body: '', author: { login: 'maintainer-two' } }])),
    comments: new Map(),
    nextComment: 9000,
    pulls: [{ number: 40, state: 'open', body: '', author: { login: 'maintainer-two' }, head: { ref: 'spec/0040-meals', sha: 'a'.repeat(40) } }],
    commits: new Map(),
    checks: new Map(),
    specPulls: [{ number: 40, slug: '0040-meals' }],
    /** What a pull request that is no longer open held, by number: a merged one's files are still the forge's to list */
    held: {},
    /** The proposal file's text, at any head */
    proposalText: null,
  };
  const say = (number, login, body, extra = {}) => {
    const c = { id: String(world.nextComment++), author: { login }, body, url: `https://forge.test/c/${world.nextComment}`, createdAt: stamp(), updatedAt: stamp(), ...extra };
    world.comments.set(number, [...(world.comments.get(number) ?? []), c]);
    return c;
  };
  const as = (login) => ({
    repo: 'owner/name',
    me: async () => ({ id: world.ids[login] ?? 2000, login }),
    permission: async (_repo, who) => world.perms[who] ?? 'none',
    issue: async (n) => {
      const i = world.issues.get(n);
      if (!i) throw new ForgeError(`#${n} is a pull request, not an issue.`, { code: 'not-found' });
      return i;
    },
    comment: async (n, body) => { const c = say(n, login, body); return { id: c.id, url: c.url }; },
    comments: async (n) => world.comments.get(n) ?? [],
    pulls: async (q) => (q?.state === 'open' && q?.limit === undefined
      ? world.specPulls.map((s) => ({ number: s.number, title: 'Spec', state: 'open', draft: false, author: { login: 'maintainer-two' }, head: { sha: `${'a'.repeat(39)}${s.number % 10}`, ref: `spec/${s.slug}` }, url: `https://forge.test/pull/${s.number}` }))
      : world.pulls),
    pullFiles: async (n) => [{ path: `${FOLDER}/${world.specPulls.find((s) => s.number === n)?.slug ?? world.held[n] ?? 'x'}.json`, status: 'added' }],
    file: async () => world.proposalText ?? '{}',
    pull: async (n) => {
      const p = world.pulls.find((x) => x.number === n);
      if (!p) throw new ForgeError('no such pull request', { code: 'not-found' });
      return p;
    },
    pullCommits: async (n) => world.commits.get(n) ?? [],
    checks: async (sha) => world.checks.get(sha) ?? [],
    branches: async () => [],
  });
  /** A sign-in: a row of `sessions` that holds a token */
  const signIn = (login, { token = 'tok', expires = clock.now + 24 * HOUR } = {}) => {
    db.prepare("INSERT INTO sessions (id, forge, user_id, login, token, permission, created_at, checked_at, expires_at) VALUES (?, 'github', ?, ?, ?, 'admin', ?, ?, ?)")
      .run(`s-${login}-${Math.random()}`, String(world.ids[login] ?? 2000), login, token, stamp(), stamp(), new Date(expires).toISOString());
  };
  for (const login of signedIn) signIn(login);
  const auth = {
    store: async () => db,
    forgeForUser: async (userId) => {
      const row = db.prepare("SELECT login FROM sessions WHERE user_id = ? AND token <> '' AND expires_at > ? ORDER BY created_at DESC LIMIT 1").get(String(userId), stamp());
      if (!row) throw new ForgeError('The token\'s owner has no live sign-in.', { code: 'unauthorized' });
      return as(row.login);
    },
    record: async ({ login, action, target, request = {}, status = null, answer = null }) => {
      db.prepare('INSERT INTO actions (at, login, action, target, request, status, answer) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(stamp(), login, action, target, JSON.stringify(request), status, answer === null ? null : JSON.stringify(answer));
    },
  };
  const cfg = {
    forge: { repo: 'owner/name' }, proposals: FOLDER,
    agents: { authors: [], labels: [], branchPrefixes: [], bots: true, transport: 'forge', maxOpen: 3, profiles: ['claude'], runners: ['runner-bot'], quietAfter: '24h', limits: {}, on, ...config },
  };
  const logs = [];
  if (!quiet) vi.spyOn(console, 'error').mockImplementation((m) => { logs.push(String(m)); });
  const sent = [];
  const build = () => {
    const hooks = createHooks({
      hooks: [{ url: 'https://chat.example.org/h', events: '*' }], secret: SECRET, store: auth.store, now: () => clock.now,
      fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return new Response(null, { status: 200 }); },
      timer: { setTimeout: () => 0, clearTimeout: () => {} },
    });
    const runs = createRuns({ config: cfg, where: { proposals: FOLDER }, auth, hooks, now: () => clock.now });
    const triggers = Object.keys(on).length ? createTriggers({ config: cfg, auth, runs, hooks, now: () => clock.now }) : null;
    return { hooks, runs, triggers };
  };
  const t = { ...build(), db, world, as, say, auth, sent, cfg, clock, logs, signIn, stamp };
  /** A restart: new engine, hooks and triggers over the same database and world */
  t.reopen = () => Object.assign(t, build());
  /** Emits a moment as the code that makes it does, and waits for everything it started */
  t.fire = async (event, payload) => {
    t.hooks.emit(event, payload);
    await settle();
    await t.triggers?.idle();
    await settle();
  };
  /** Moves the clock: a request in the same minute is another request, so the per-person counters stay far from their ceilings */
  t.wait = (ms) => { clock.now += ms; };
  t.rows = (action) => db.prepare('SELECT * FROM actions ORDER BY id').all().filter((r) => !action || r.action === action).map((r) => ({ ...r, request: JSON.parse(r.request), answer: r.answer ? JSON.parse(r.answer) : null }));
  t.runRows = () => db.prepare('SELECT * FROM runs ORDER BY requested_at').all();
  t.events = (name) => sent.filter((e) => e.event === name);
  /** The request comments posted so far, wherever: [{ number, by, request }] */
  t.posted = () => [...world.comments.entries()].flatMap(([number, list]) => list.flatMap((c) => readRunBlocks(c.body).blocks.filter((b) => b.type === 'request').map((b) => ({ number, by: c.author.login, request: b.value, body: c.body }))));
  /** Everything a comment anywhere says, for "nothing was posted" */
  t.allComments = () => [...world.comments.values()].flat();
  return t;
}

const approved = (over = {}) => ({ slug: '0040-meals', pull: 40, headSha: 'a'.repeat(40), proposalSha256: 'b'.repeat(64), actor: 'maintainer-one', ...over });
const built = (over = {}) => ({ slug: '0040-meals', pull: 40, headSha: 'a'.repeat(40), proposalSha256: 'b'.repeat(64), actor: 'maintainer-one', issue: 60, ...over });
const message = (t, thread, login, body, over = {}) => {
  const c = t.say(thread, login, body, over);
  return { thread, comment: c.id, actor: login, message: { body, createdAt: c.createdAt, updatedAt: c.updatedAt, bot: Boolean(over.bot) } };
};

describe('off by default', () => {
  it('requests nothing for any event when agents.on is empty, and subscribes nothing', async () => {
    const t = setup({ on: {} });
    expect(t.triggers).toBeNull();
    await t.fire('spec.approved', approved());
    await t.fire('build.opened', built());
    await t.fire('thread.message', message(t, 15, 'maintainer-one', '/agent do it'));
    expect(t.runRows()).toEqual([]);
    expect(t.posted()).toEqual([]);
  });

  it('fires only for the events that have a trigger', async () => {
    const t = setup({ on: { 'build.opened': { kind: 'code' } } });
    await t.fire('spec.approved', approved());
    await t.fire('thread.message', message(t, 15, 'maintainer-one', '/agent do it'));
    expect(t.runRows()).toEqual([]);
    expect(t.triggers.events).toEqual(['build.opened']);
  });
});

describe('spec.approved and build.opened', () => {
  it('a spec.approved requests ONE run naming the approver, posted on the spec PR as the approver, by the request path the button uses', async () => {
    const t = setup();
    const spy = vi.spyOn(t.runs, 'request');
    await t.fire('spec.approved', approved());
    const [p, ...more] = t.posted();
    expect(more).toEqual([]);
    expect(p).toMatchObject({ number: 40, by: 'maintainer-one' });
    expect(p.request).toMatchObject({
      version: 1, kind: 'code', profile: 'claude', refs: { proposal: '0040-meals', pull: 40 }, requestedBy: 'maintainer-one',
      trigger: { event: 'spec.approved', by: 'maintainer-one', ref: 'pull:40' },
    });
    expect(validateRequest(p.request, { profiles: ['claude'] }).ok).toBe(true);
    expect(p.body).toMatch(/Asked by the trigger on spec\.approved \(pull:40\), after an act of maintainer-one's/);
    expect(t.runRows()).toEqual([expect.objectContaining({ run_id: p.request.runId, via: 'trigger', requested_by: 'maintainer-one', target: 40 })]);
    // the same function the dashboard calls: asked once, with the approver's own sign-in
    expect(t.runs.request).toBe(spy);
    // audited like any request, with its cause and never the brief; and announced like any request
    expect(t.rows('agent-request')).toEqual([expect.objectContaining({ login: 'maintainer-one', status: 201, request: expect.objectContaining({ trigger: { event: 'spec.approved', ref: 'pull:40' } }) })]);
    expect(t.events('agent.requested')).toHaveLength(1);
    expect(t.events('agent.requested')[0].request.trigger).toEqual({ event: 'spec.approved', by: 'maintainer-one', ref: 'pull:40' });
    expect(t.rows('trigger-skipped')).toEqual([]);
  });

  it('names whichever maintainer approved, not the first one signed in', async () => {
    const t = setup();
    await t.fire('spec.approved', approved({ actor: 'maintainer-two' }));
    expect(t.posted()[0]).toMatchObject({ by: 'maintainer-two', request: { requestedBy: 'maintainer-two', trigger: { by: 'maintainer-two' } } });
    expect(t.runRows()[0]).toMatchObject({ requested_by_id: '1002' });
  });

  it('a build.opened requests one run about the build issue, naming who opened it', async () => {
    const t = setup();
    await t.fire('build.opened', built());
    expect(t.posted()).toEqual([expect.objectContaining({ number: 60, by: 'maintainer-one', request: expect.objectContaining({ kind: 'code', refs: { issue: 60 }, trigger: { event: 'build.opened', by: 'maintainer-one', ref: 'issue:60' } }) })]);
    expect(t.runRows()).toHaveLength(1);
  });

  it('uses the rule\'s kind, profile and brief; a repeat of the same approval is not a second request', async () => {
    const t = setup({ on: { 'spec.approved': { kind: 'brief', profile: 'claude', brief: 'Draft a brief.' } } });
    await t.fire('spec.approved', approved());
    expect(t.posted()[0].request).toMatchObject({ kind: 'brief', profile: 'claude', brief: 'Draft a brief.' });
    t.wait(10_000);
    await t.fire('spec.approved', approved());
    expect(t.posted()).toHaveLength(1);
    expect(t.runRows()).toHaveLength(1);
  });

  it('still obeys the rules: one open run per subject, and the cap', async () => {
    const t = setup({ config: { maxOpen: 1 } });
    await t.fire('spec.approved', approved());
    t.wait(10_000);
    // the pull request is now the target of an open run: a second approval of a new head is skipped, and says so
    await t.fire('spec.approved', approved({ headSha: 'c'.repeat(40) }));
    expect(t.runRows()).toHaveLength(1);
    expect(t.events('trigger.skipped').map((e) => e.reason)).toEqual(['run-open']);
    // another subject meets the cap
    t.wait(10_000);
    t.world.pulls.push({ number: 41, state: 'open', body: '', author: { login: 'maintainer-two' }, head: { ref: 'spec/0041-x', sha: 'e'.repeat(40) } });
    await t.fire('build.opened', built({ pull: 41 }));
    expect(t.runRows()).toHaveLength(1);
    expect(t.events('trigger.skipped').map((e) => e.reason)).toEqual(['run-open', 'cap-reached']);
  });

  it('cannot be forged: a body from the button or the API that carries a trigger is refused', async () => {
    const t = setup();
    const ctx = { forge: () => t.as('maintainer-one'), who: { login: 'maintainer-one', userId: '1001' }, limits: { auth: t.auth, now: () => t.clock.now } };
    await expect(t.runs.request(ctx, { body: { kind: 'code', refs: { issue: 12 }, brief: '', trigger: { event: 'spec.approved', by: 'maintainer-one', ref: 'pull:40' } } })).rejects.toMatchObject({ status: 400, code: 'invalid' });
    expect(t.runRows()).toEqual([]);
  });
});

describe('the /agent command', () => {
  it('from a maintainer requests a run in the thread, and the rest of the line is the brief', async () => {
    const t = setup();
    await t.fire('thread.message', message(t, 15, 'maintainer-two', '/agent  summarise this thread for the release notes '));
    const [p] = t.posted();
    expect(p).toMatchObject({ number: 15, by: 'maintainer-two' });
    expect(p.request).toMatchObject({ kind: 'summary', refs: { thread: 15 }, brief: 'summarise this thread for the release notes', requestedBy: 'maintainer-two' });
    expect(p.request.trigger).toMatchObject({ event: 'thread.message', by: 'maintainer-two' });
    expect(p.request.trigger.ref).toMatch(/^comment:\d+$/);
    expect(t.runRows()).toHaveLength(1);
  });

  it('with no brief on the line, takes the rule\'s; finds the command after other lines', async () => {
    const t = setup({ on: { 'thread.message': { kind: 'summary', profile: 'claude', brief: 'Standing brief.' } } });
    await t.fire('thread.message', message(t, 15, 'maintainer-one', 'Looks good to me.\n\n/agent\n\nThanks'));
    expect(t.posted()[0].request.brief).toBe('Standing brief.');
  });

  it('does nothing for a comment from someone who is not a maintainer: no run, no row, no hook, nothing posted', async () => {
    const t = setup({ signedIn: ['maintainer-one', 'maintainer-two', 'stranger'] });
    const before = t.allComments().length;
    await t.fire('thread.message', message(t, 15, 'stranger', '/agent please'));
    await t.fire('thread.message', message(t, 15, 'nobody-at-all', '/agent please'));
    expect(t.runRows()).toEqual([]);
    expect(t.allComments().length - before).toBe(2); // only the two comments themselves
    expect(t.rows()).toEqual([]);
    expect(t.events('trigger.skipped')).toEqual([]);
  });

  it('is confirmed by the forge now: someone who was a maintainer and is not any more gets nothing', async () => {
    const t = setup();
    t.world.perms['maintainer-two'] = 'read';
    await t.fire('thread.message', message(t, 15, 'maintainer-two', '/agent go'));
    expect(t.runRows()).toEqual([]);
    expect(t.rows()).toEqual([]);
  });

  it('does nothing for a comment that was edited', async () => {
    const t = setup();
    const at = (ms) => new Date(T0 + ms).toISOString();
    await t.fire('thread.message', message(t, 15, 'maintainer-one', '/agent go', { createdAt: at(0), updatedAt: at(60_000) }));
    expect(t.runRows()).toEqual([]);
    // the forge's own touch-up within a few seconds does not count as an edit
    await t.fire('thread.message', message(t, 16, 'maintainer-one', '/agent go', { createdAt: at(0), updatedAt: at(2_000) }));
    expect(t.runRows()).toHaveLength(1);
    // a time that does not parse is not taken for "never edited"
    t.wait(10_000);
    await t.fire('thread.message', message(t, 14, 'maintainer-one', '/agent go', { createdAt: 'x', updatedAt: 'x' }));
    expect(t.runRows()).toHaveLength(1);
  });

  it('is read only as a command: code spans, fences, quotes, indented code and longer words are ignored', async () => {
    const t = setup({ config: { maxOpen: 20 } });
    const cases = [
      'Use `/agent` to ask', '`/agent run it`', '```/agent```',
      `${FENCE}\n/agent go\n${FENCE}`, `${FENCE}sh\n/agent go\n${FENCE}\n`, `~~~\n/agent go\n~~~`, `${'`'.repeat(4)}\n${FENCE}\n/agent go\n${FENCE}\n${'`'.repeat(4)}`,
      '> /agent go', '    /agent go', '\t/agent go', 'do /agent go', '/agentic go', '/agents go', '<!-- /agent go -->', 'please run /agent',
    ];
    let n = 12;
    for (const text of cases) {
      await t.fire('thread.message', message(t, n++ % 5 + 12, 'maintainer-one', text));
      t.wait(61_000);
    }
    expect(t.runRows(), cases.join('\n')).toEqual([]);
    // and the command after a closed fence is read
    await t.fire('thread.message', message(t, 13, 'maintainer-one', `${FENCE}\n/agent no\n${FENCE}\n/agent yes`));
    expect(t.posted()[0].request.brief).toBe('yes');
  });

  it('agentCommand: the first command line outside code, with its brief', () => {
    expect(agentCommand('/agent')).toEqual({ brief: '' });
    expect(agentCommand('  /agent  fix it ')).toEqual({ brief: 'fix it' });
    expect(agentCommand('a\n/agent one\n/agent two')).toEqual({ brief: 'one' });
    expect(agentCommand('/agent run `x()`')).toEqual({ brief: 'run `x()`' });
    expect(agentCommand('/agent\r\nmore')).toEqual({ brief: '' });
    expect(agentCommand('/agent ' + 'x'.repeat(30000)).brief).toHaveLength(20000);
    expect(agentCommand('nothing')).toBeNull();
    expect(agentCommand(3)).toBeNull();
    expect(agentCommand(`${FENCE}\n/agent`)).toBeNull();
  });

  it('is honoured once per comment, across a restart', async () => {
    const t = setup({ config: { maxOpen: 10 } });
    const m = message(t, 15, 'maintainer-one', '/agent go');
    await t.fire('thread.message', m);
    expect(t.runRows()).toHaveLength(1);
    expect(t.db.prepare("SELECT issue, comment FROM thread_seen WHERE comment LIKE 'trigger:%'").all()).toEqual([{ issue: 15, comment: `trigger:comment:${m.comment}` }]);
    t.reopen();
    t.wait(10_000);
    await t.fire('thread.message', m);
    await t.fire('thread.message', m);
    expect(t.runRows()).toHaveLength(1);
    // not even a refusal: it was never tried again
    expect(t.rows('agent-request')).toHaveLength(1);
    expect(t.rows('trigger-skipped')).toEqual([]);
    // another comment is another command; the first run on that thread is still open, so it is skipped with the reason
    t.wait(10_000);
    await t.fire('thread.message', message(t, 15, 'maintainer-one', '/agent again'));
    expect(t.runRows()).toHaveLength(1);
    expect(t.events('trigger.skipped').map((e) => [e.reason, e.trigger.event])).toEqual([['run-open', 'thread.message']]);
  });

  it('is not a request at all for an approval repeated after a restart', async () => {
    const t = setup({ config: { maxOpen: 10 } });
    await t.fire('spec.approved', approved());
    t.reopen();
    t.wait(10_000);
    await t.fire('spec.approved', approved());
    expect(t.rows('agent-request')).toHaveLength(1);
  });
});

describe('spec.approved after the approval landed the spec pull request (proposals.approveLands)', () => {
  /** The spec pull request merged before the trigger read it: no open one holds the proposal any more */
  const land = (t, slug = '0040-meals') => { t.world.specPulls.length = 0; t.world.pulls[0].state = 'merged'; t.world.held[40] = slug; };

  it('asks for the run on the landed proposal: refs.proposal with no pull, the cause still pull:<n>, posted on the merged pull request', async () => {
    const t = setup();
    land(t);
    await t.fire('spec.approved', approved());
    const [p, ...more] = t.posted();
    expect(more).toEqual([]);
    expect(p).toMatchObject({ number: 40, by: 'maintainer-one' });
    expect(p.request.refs).toEqual({ proposal: '0040-meals' });
    expect(p.request.trigger).toEqual({ event: 'spec.approved', by: 'maintainer-one', ref: 'pull:40' });
    expect(validateRequest(p.request, { profiles: ['claude'] }).ok).toBe(true);
    expect(t.runRows()).toEqual([expect.objectContaining({ via: 'trigger', proposal: '0040-meals', target: 40 })]);
    expect(t.rows('trigger-skipped')).toEqual([]);
  });

  it('keeps the one-run-per-subject rule: a run already open on the proposal skips it with run-open', async () => {
    const t = setup({ config: { maxOpen: 10 } });
    await t.fire('spec.approved', approved()); // asked while the pull request was open
    land(t);
    t.wait(61_000);
    await t.fire('spec.approved', approved({ headSha: 'c'.repeat(40) }));
    expect(t.runRows()).toHaveLength(1);
    expect(t.rows('trigger-skipped').map((r) => r.answer.reason)).toEqual(['run-open']);
  });

  it('keeps the cap: at the limit the landed proposal is refused with cap-reached', async () => {
    const t = setup({ config: { maxOpen: 1 } });
    await t.runs.request({ forge: () => t.as('maintainer-one'), who: { login: 'maintainer-one', userId: '1001' }, limits: { auth: t.auth, now: () => t.clock.now } }, { body: { kind: 'code', refs: { issue: 12 }, brief: '' } });
    land(t);
    t.wait(10_000);
    await t.fire('spec.approved', approved());
    expect(t.runRows()).toHaveLength(1);
    expect(t.rows('trigger-skipped').map((r) => r.answer.reason)).toEqual(['cap-reached']);
  });

  it('reads what the merged pull request held, not the event\'s word: one that never held the proposal is skipped with not-found', async () => {
    const t = setup();
    land(t, '0041-other');
    await t.fire('spec.approved', approved());
    expect(t.posted()).toEqual([]);
    expect(t.runRows()).toEqual([]);
    expect(t.rows('trigger-skipped').map((r) => r.answer.reason)).toEqual(['not-found']);
  });

  it('marks the landed proposal\'s nodes for collisions, read from the merged pull request (agents.refuseCollisions)', async () => {
    const t = setup({ config: { refuseCollisions: true } });
    land(t);
    t.world.proposalText = JSON.stringify({ version: 1, title: 'Meals', nodes: { add: [{ id: 'page-meals', label: '/meals', type: 'page', parent: 'app-a' }] } });
    await t.fire('spec.approved', approved());
    const [row] = t.runRows();
    expect(row).toMatchObject({ proposal: '0040-meals', target: 40 });
    const read = t.db.prepare("SELECT data FROM run_reads WHERE run_id = ? AND source = 'mentions'").get(row.run_id);
    expect(JSON.parse(read.data)).toEqual(expect.arrayContaining(['page-meals', 'app-a']));
  });

  it('is unchanged when the pull request did not merge (closed, or gone): skipped with not-found', async () => {
    const t = setup();
    t.world.specPulls.length = 0;
    t.world.pulls[0].state = 'closed';
    await t.fire('spec.approved', approved());
    expect(t.runRows()).toEqual([]);
    expect(t.rows('trigger-skipped').map((r) => r.answer.reason)).toEqual(['not-found']);
  });
});

describe('no live sign-in, and a refusal', () => {
  it('does nothing else: an audit row, trigger.skipped, nothing posted, and the notice for the dashboard', async () => {
    const t = setup({ signedIn: ['maintainer-two'] }); // maintainer-one is not signed in
    await t.fire('spec.approved', approved());
    expect(t.runRows()).toEqual([]);
    expect(t.posted()).toEqual([]);
    expect(t.allComments()).toEqual([]);
    expect(t.rows('trigger-skipped')).toEqual([expect.objectContaining({ login: 'maintainer-one', target: 'owner/name#40', status: null, request: { event: 'spec.approved', by: 'maintainer-one', ref: 'pull:40' }, answer: { reason: 'no-session' } })]);
    expect(t.rows('agent-request')).toEqual([]);
    expect(t.events('trigger.skipped')).toEqual([{ event: 'trigger.skipped', at: new Date(T0).toISOString(), trigger: { event: 'spec.approved', by: 'maintainer-one', ref: 'pull:40' }, by: 'maintainer-one', reason: 'no-session', mapUrl: null }]);
    const list = await t.runs.list();
    expect(list.triggerSkipped).toEqual({ count: 1, last: new Date(T0).toISOString(), reasons: { 'no-session': 1 } });
  });

  it('is the same for an /agent comment by a maintainer who has signed out or whose sign-in ended', async () => {
    const t = setup({ signedIn: ['maintainer-two'] });
    t.signIn('maintainer-one', { expires: T0 - 1000 }); // ended
    await t.fire('thread.message', message(t, 15, 'maintainer-one', '/agent go'));
    expect(t.events('trigger.skipped')).toHaveLength(1);
    expect(t.events('trigger.skipped')[0]).toMatchObject({ reason: 'no-session', by: 'maintainer-one', trigger: { event: 'thread.message' } });
    expect(t.runRows()).toEqual([]);
    expect(t.allComments().filter((c) => c.body.includes('cornfield-run'))).toEqual([]);
  });

  it('a session without a token is no sign-in', async () => {
    const t = setup({ signedIn: ['maintainer-two'] });
    t.signIn('maintainer-one', { token: '' });
    await t.fire('build.opened', built());
    expect(t.rows('trigger-skipped')[0].answer).toEqual({ reason: 'no-session' });
  });

  it('the notice counts only the last 24 hours', async () => {
    const t = setup({ signedIn: ['maintainer-two'] });
    await t.fire('spec.approved', approved());
    t.wait(25 * HOUR);
    expect((await t.runs.list()).triggerSkipped).toBeNull();
  });

  it('a cap that refuses is a skipped trigger with its code: audit, hook, nothing posted', async () => {
    const t = setup({ config: { maxOpen: 1 } });
    await t.runs.request({ forge: () => t.as('maintainer-one'), who: { login: 'maintainer-one', userId: '1001' }, limits: { auth: t.auth, now: () => t.clock.now } }, { body: { kind: 'code', refs: { issue: 12 }, brief: '' } });
    const posted = t.allComments().length;
    t.wait(10_000);
    await t.fire('build.opened', built());
    expect(t.runRows()).toHaveLength(1);
    expect(t.allComments()).toHaveLength(posted);
    expect(t.events('trigger.skipped')).toEqual([expect.objectContaining({ reason: 'cap-reached', by: 'maintainer-one', trigger: { event: 'build.opened', by: 'maintainer-one', ref: 'issue:60' } })]);
    expect(t.rows('trigger-skipped')).toEqual([expect.objectContaining({ answer: { reason: 'cap-reached' } })]);
    expect((await t.runs.list()).triggerSkipped).toMatchObject({ count: 1, reasons: { 'cap-reached': 1 } });
  });

  it('a limit that refuses (the rate) is skipped too', async () => {
    const t = setup({ config: { maxOpen: 50 } });
    for (let i = 0; i < 6; i++) await t.runs.request({ forge: () => t.as('maintainer-one'), who: { login: 'maintainer-one', userId: '1001' }, limits: { auth: t.auth, now: () => t.clock.now } }, { body: { kind: 'brief', refs: { thread: 12 + i % 4 }, brief: '', force: true } }).catch(() => {});
    const n = t.runRows().length;
    await t.fire('build.opened', built());
    expect(t.runRows()).toHaveLength(n);
    expect(t.events('trigger.skipped')[0]).toMatchObject({ reason: 'rate-limited' });
  });

  it('a maintainer who is not one now is skipped as forbidden, and a brief shaped like a credential as invalid', async () => {
    const t = setup({ on: { 'spec.approved': { kind: 'code', brief: 'use ' + ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('') } } });
    await t.fire('spec.approved', approved());
    expect(t.events('trigger.skipped')[0]).toMatchObject({ reason: 'invalid' });
    expect(t.runRows()).toEqual([]);
    const u = setup();
    u.world.perms['maintainer-one'] = 'read';
    await u.fire('spec.approved', approved());
    expect(u.events('trigger.skipped')[0]).toMatchObject({ reason: 'forbidden' });
  });
});

describe('no chaining', () => {
  const nothing = (t) => {
    expect(t.runRows()).toEqual([]);
    expect(t.posted()).toEqual([]);
    expect(t.rows('agent-request')).toEqual([]);
    expect(t.rows('trigger-skipped')).toEqual([]);
    expect(t.events('trigger.skipped')).toEqual([]);
    expect(t.events('agent.requested')).toEqual([]);
  };

  it('a runner as the actor never fires a trigger', async () => {
    const t = setup({ signedIn: ['maintainer-one', 'runner-bot'] });
    await t.fire('spec.approved', approved({ actor: 'runner-bot' }));
    await t.fire('build.opened', built({ actor: 'Runner-Bot' }));
    await t.fire('thread.message', message(t, 15, 'runner-bot', '/agent more'));
    nothing(t);
  });

  it('a bot as the actor never fires a trigger: a [bot] login, or an account the forge says is a bot', async () => {
    const t = setup({ signedIn: ['maintainer-one', 'robot[bot]', 'other'] });
    await t.fire('spec.approved', approved({ actor: 'robot[bot]' }));
    await t.fire('thread.message', message(t, 15, 'robot[bot]', '/agent more'));
    t.world.perms.other = 'admin';
    await t.fire('thread.message', message(t, 16, 'other', '/agent more', { bot: true }));
    nothing(t);
  });

  it('a comment with a cornfield-run block never fires a trigger, even a maintainer\'s with /agent in it', async () => {
    const t = setup();
    const report = formatRunComment(RUN, { state: 'working', note: 'on it' });
    await t.fire('thread.message', message(t, 15, 'maintainer-one', `/agent please\n\n${report}`));
    await t.fire('thread.message', message(t, 16, 'maintainer-one', `/agent\n${FENCE}cornfield-run ${RUN}\n{"state":"done"}\n${FENCE}`));
    await t.fire('thread.message', message(t, 14, 'maintainer-one', `/agent x\n~~~ cornfield-run ${RUN}\n{"state":"done"}\n~~~`));
    nothing(t);
    // a maintainer's own request comment, read back as a thread message, is no command either
    const ask = formatRunComment(RUN, { version: 1, runId: RUN, kind: 'code', refs: { issue: 12 }, brief: '/agent', requestedBy: 'maintainer-one', requestedAt: '2026-11-05T10:00:00Z' });
    await t.fire('thread.message', message(t, 13, 'maintainer-one', `/agent\n${ask}`));
    expect(t.runRows()).toEqual([]);
    // each says why in the audit table, and only there: which event, who, which comment, never what it said
    const rows = t.rows();
    expect(rows.map((r) => [r.action, r.target, r.answer.reason])).toEqual([15, 16, 14, 13].map((n) => ['trigger-ignored', `owner/name#${n}`, 'run-block']));
    for (const r of rows) {
      expect(Object.keys(r.request).sort()).toEqual(['by', 'event', 'ref']);
      expect(JSON.stringify(r)).not.toMatch(/please|cornfield-run|state/);
    }
    expect(t.events('trigger.skipped')).toEqual([]);
  });

  /** A run asked for by the button on thread 15, whose linked pull request is #41 */
  async function withRun(t) {
    const ctx = { forge: () => t.as('maintainer-one'), who: { login: 'maintainer-one', userId: '1001' }, limits: { auth: t.auth, now: () => t.clock.now } };
    const run = await t.runs.request(ctx, { body: { kind: 'brief', refs: { thread: 15 }, brief: '' } });
    t.db.prepare('UPDATE runs SET pull = 41, pull_state = ?, pull_trusted = 1 WHERE run_id = ?').run('open', run.run.runId);
    t.world.pulls.push({ number: 41, state: 'open', body: '', author: { login: 'maintainer-two' }, head: { ref: 'x', sha: 'e'.repeat(40) } });
    return run.run.runId;
  }

  it('a run\'s linked pull request never fires, in any state, the run open or long over: an audit row says why, no hook', async () => {
    const t = setup({ config: { maxOpen: 10 } });
    const runId = await withRun(t);
    const before = t.allComments().length;
    t.wait(61_000);
    await t.fire('spec.approved', approved({ pull: 41 }));
    await t.fire('build.opened', built({ pull: 41, issue: 16 }));
    for (const [state, pullState] of [['done', 'open'], ['failed', 'merged'], ['stopped', 'closed']]) {
      t.db.prepare('UPDATE runs SET state = ?, pull_state = ? WHERE run_id = ?').run(state, pullState, runId);
      t.wait(61_000);
      await t.fire('spec.approved', approved({ pull: 41, headSha: state.padEnd(40, 'd') }));
    }
    expect(t.runRows()).toHaveLength(1);
    expect(t.allComments().length).toBe(before);
    expect(t.rows('trigger-ignored').map((r) => [r.request.event, r.answer.reason])).toEqual([
      ['spec.approved', 'run-output'], ['build.opened', 'run-output'], ['spec.approved', 'run-output'], ['spec.approved', 'run-output'], ['spec.approved', 'run-output'],
    ]);
    expect(t.rows('trigger-skipped')).toEqual([]);
    expect(t.events('trigger.skipped')).toEqual([]);
  });

  it('a run\'s target with a run still open is skipped with run-open, whatever the profile: audited, with the hook, nothing posted', async () => {
    const t = setup({ config: { maxOpen: 10, profiles: ['claude', 'local'] }, on: { 'thread.message': { kind: 'summary', profile: 'local' } } });
    await withRun(t); // asked with no profile; the trigger's is another one, which the request path alone would let through
    const before = t.allComments().length;
    t.wait(61_000);
    await t.fire('thread.message', message(t, 15, 'maintainer-one', '/agent again'));
    expect(t.runRows()).toHaveLength(1);
    expect(t.allComments().length - before).toBe(1); // only the /agent comment itself
    expect(t.rows('trigger-skipped').map((r) => r.answer.reason)).toEqual(['run-open']);
    expect(t.events('trigger.skipped')).toEqual([expect.objectContaining({ reason: 'run-open', by: 'maintainer-one', trigger: { event: 'thread.message', by: 'maintainer-one', ref: expect.stringMatching(/^comment:/) } })]);
  });

  it('a run\'s target fires again on a fresh maintainer act once every run on it is over', async () => {
    const t = setup({ config: { maxOpen: 10 } });
    const runId = await withRun(t);
    // finished by its report
    t.db.prepare("UPDATE runs SET state = 'done' WHERE run_id = ?").run(runId);
    t.wait(61_000);
    await t.fire('thread.message', message(t, 15, 'maintainer-one', '/agent once more'));
    expect(t.runRows()).toHaveLength(2);
    const second = t.posted().filter((x) => x.number === 15).at(-1);
    expect(second.request).toMatchObject({ refs: { thread: 15 }, brief: 'once more', trigger: { event: 'thread.message', by: 'maintainer-one' } });
    // that one open: skipped; then its pull request merged, which finishes it: a fresh act fires again
    t.wait(61_000);
    await t.fire('thread.message', message(t, 15, 'maintainer-two', '/agent and again'));
    expect(t.runRows()).toHaveLength(2);
    expect(t.events('trigger.skipped').map((e) => e.reason)).toEqual(['run-open']);
    t.db.prepare("UPDATE runs SET pull = 77, pull_state = 'merged', pull_trusted = 1 WHERE run_id = ?").run(second.request.runId);
    t.wait(61_000);
    await t.fire('thread.message', message(t, 15, 'maintainer-two', '/agent third'));
    expect(t.runRows()).toHaveLength(3);
    expect(t.posted().filter((x) => x.number === 15).at(-1).request).toMatchObject({ brief: 'third', requestedBy: 'maintainer-two' });
  });

  it('a spec pull request that was a run\'s target fires again on the approval of a new head once its run is over', async () => {
    const t = setup({ config: { maxOpen: 10 } });
    await t.fire('spec.approved', approved());
    expect(t.runRows()).toHaveLength(1);
    t.wait(61_000);
    await t.fire('spec.approved', approved({ headSha: 'c'.repeat(40) }));
    expect(t.runRows()).toHaveLength(1);
    expect(t.events('trigger.skipped').map((e) => e.reason)).toEqual(['run-open']);
    t.db.prepare("UPDATE runs SET state = 'failed'").run();
    t.wait(61_000);
    await t.fire('spec.approved', approved({ headSha: 'c'.repeat(40) })); // the same head again: deduped, silently
    expect(t.runRows()).toHaveLength(1);
    await t.fire('spec.approved', approved({ headSha: 'f'.repeat(40) }));
    expect(t.runRows()).toHaveLength(2);
    expect(t.posted().map((x) => x.number)).toEqual([40, 40]);
  });

  it('an edited /agent comment, a runner\'s and a bot\'s are audited as ignored; a comment with no command writes nothing', async () => {
    const t = setup({ signedIn: ['maintainer-one', 'runner-bot'] });
    await t.fire('thread.message', message(t, 15, 'maintainer-one', '/agent go', { updatedAt: new Date(T0 + 60_000).toISOString() }));
    await t.fire('thread.message', message(t, 16, 'maintainer-one', '/agent go', { updatedAt: undefined }));
    await t.fire('thread.message', message(t, 14, 'runner-bot', '/agent go'));
    await t.fire('thread.message', message(t, 13, 'robot[bot]', '/agent go'));
    await t.fire('thread.message', message(t, 12, 'runner-bot', 'Done, see the PR.'));
    await t.fire('thread.message', message(t, 12, 'maintainer-one', 'Thanks, nice work.', { updatedAt: new Date(T0 + 60_000).toISOString() }));
    expect(t.runRows()).toEqual([]);
    expect(t.rows().map((r) => [r.action, r.login, r.answer.reason])).toEqual([
      ['trigger-ignored', 'maintainer-one', 'edited'], ['trigger-ignored', 'maintainer-one', 'edited'], ['trigger-ignored', 'runner-bot', 'machine'], ['trigger-ignored', 'robot[bot]', 'machine'],
    ]);
    expect(t.events('trigger.skipped')).toEqual([]);
  });

  it('the comment\'s text reaches no hook body, audit row or log line', async () => {
    const t = setup({ config: { maxOpen: 10 } });
    const words = 'zebra-quokka-marmot';
    await t.fire('thread.message', message(t, 15, 'stranger', `/agent ${words}`));
    await t.fire('thread.message', message(t, 16, 'maintainer-one', `hello ${words}`));
    await t.fire('thread.message', message(t, 14, 'maintainer-one', `/agent x ${words}`, { updatedAt: new Date(T0 + 60_000).toISOString() }));
    t.world.perms['maintainer-one'] = 'admin';
    t.signIn('maintainer-one', { token: '' });
    expect(JSON.stringify(t.sent)).not.toContain(words);
    expect(JSON.stringify(t.rows())).not.toContain(words);
    expect(t.logs.join('\n')).not.toContain(words);
    expect(t.events('thread.message').length).toBeGreaterThan(0);
    for (const e of t.events('thread.message')) expect(Object.keys(e)).not.toContain('message');
  });

  it('an event no hook asks for and no trigger listens to is not even worked out', async () => {
    const t = setup({ on: { 'thread.message': { kind: 'summary' } } });
    const quiet = createHooks({ hooks: [], secret: SECRET, store: t.auth.store, now: () => t.clock.now, fetch: async () => { throw new Error('no delivery'); }, timer: { setTimeout: () => 0, clearTimeout: () => {} } });
    const seen = [];
    quiet.subscribe((e) => seen.push(e), ['thread.message']);
    let worked = 0;
    quiet.emit('spec.approved', () => { worked += 1; return approved(); });
    quiet.emit('thread.message', () => { worked += 10; return { thread: 1, comment: '1', actor: 'x' }; });
    await settle();
    expect(worked).toBe(10);
    expect(seen).toEqual(['thread.message']);
  });

  it('a pull request that carries a run id, a runner as its author or a bot, is a run\'s even before cornfield has linked it', async () => {
    const t = setup();
    t.world.pulls.push({ number: 42, state: 'open', body: `Spec.\n\nCornfield-Run: ${RUN}`, author: { login: 'maintainer-two' }, head: { ref: 'x', sha: 'e'.repeat(40) } });
    t.world.pulls.push({ number: 43, state: 'open', body: '', author: { login: 'maintainer-two' }, head: { ref: `agent/${RUN}`, sha: 'e'.repeat(40) } });
    t.world.pulls.push({ number: 44, state: 'open', body: '', author: { login: 'runner-bot' }, head: { ref: 'x', sha: 'e'.repeat(40) } });
    t.world.pulls.push({ number: 45, state: 'open', body: '', author: { login: 'x', bot: true }, head: { ref: 'x', sha: 'e'.repeat(40) } });
    for (const pull of [42, 43, 44, 45]) {
      await t.fire('spec.approved', approved({ pull, headSha: String(pull).repeat(20) }));
      t.wait(61_000);
    }
    t.world.issues.set(61, { number: 61, state: 'open', body: `Cornfield-Run: ${RUN}`, author: { login: 'maintainer-two' } });
    await t.fire('build.opened', built({ issue: 61, pull: 40 }));
    nothing(t);
  });

  it('fails closed: a subject that cannot be read fires nothing', async () => {
    const t = setup();
    await t.fire('spec.approved', approved({ pull: 99 }));
    nothing(t);
  });

  it('a whole run\'s life fires nothing: its request, a report, its pull request, its checks and its finish', async () => {
    const t = setup({ config: { maxOpen: 10 } });
    await t.fire('spec.approved', approved());
    const [p] = t.posted();
    const id = p.request.runId;
    expect(t.runRows()).toHaveLength(1);
    // the runner reports, opens a pull request that carries the id, checks run, and it finishes
    t.wait(61_000);
    t.say(40, 'runner-bot', formatRunComment(id, { state: 'claimed' }));
    t.world.pulls.push({ number: 50, title: 'Meals', state: 'open', draft: false, body: `Done.\n\nCornfield-Run: ${id}`, author: { login: 'runner-bot' }, head: { ref: 'agent/meals', sha: 'f'.repeat(40) }, updatedAt: new Date(t.clock.now).toISOString(), url: 'https://forge.test/pull/50' });
    t.world.checks.set('f'.repeat(40), [{ id: '1', name: 'test', state: 'success', url: null, rerunnable: false }]);
    await t.runs.follow(t.as('maintainer-one'));
    t.wait(61_000);
    t.say(40, 'runner-bot', formatRunComment(id, { state: 'done', note: 'merged soon' }));
    t.say(50, 'runner-bot', '/agent do more');
    await t.runs.follow(t.as('maintainer-one'));
    await settle();
    await t.triggers.idle();
    expect(t.runRows()).toHaveLength(1);
    expect(t.runRows()[0]).toMatchObject({ state: 'done', pull: 50 });
    expect(t.events('run.finished')).toHaveLength(1);
    expect(t.events('run.state').length + t.events('run.claimed').length).toBeGreaterThan(0);
    expect(t.rows('trigger-skipped')).toEqual([]);
    expect(t.posted()).toHaveLength(1);
  });

  it('structurally: a run\'s events, a request\'s, a landing and a ready spec are no trigger\'s, even shaped like one', async () => {
    const t = setup({ config: { maxOpen: 10 } });
    for (const event of ['run.claimed', 'run.state', 'run.stopRequested', 'run.finished', 'agent.requested', 'pr.landed', 'spec.ready', 'spec.sentBack', 'thread.opened', 'thread.linked', 'session.expiring']) {
      await t.fire(event, { ...approved(), ...built(), runId: RUN, state: 'done', request: undefined, thread: 15, message: { body: '/agent', createdAt: t.stamp(), updatedAt: t.stamp() }, comment: '1' });
      t.wait(61_000);
    }
    await t.fire('trigger.skipped', { trigger: { event: 'spec.approved', by: 'maintainer-one', ref: 'pull:40' }, by: 'maintainer-one', reason: 'no-session' });
    expect(t.runRows()).toEqual([]);
    expect(t.posted()).toEqual([]);
    // and the module that follows and reports runs does not know the triggers exist
    const source = readFileSync(new URL('../../server/agent-runs.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/import [^\n]*triggers|createTriggers|hooks\??\.subscribe/);
    const triggers = readFileSync(new URL('../../server/triggers.js', import.meta.url), 'utf8');
    expect(triggers.match(/hooks\.subscribe\(/g)).toHaveLength(1);
    expect(triggers).not.toMatch(/'run\.|"run\.|agent\.requested'/);
  });
});

describe('the dashboard\'s notice and the server', () => {
  it('the notice is in the runs list the Agents tab reads, and is absent when nothing was skipped', async () => {
    const t = setup();
    expect((await t.runs.list()).triggerSkipped).toBeNull();
  });

  it('a config with agents.on and no sign-in is a startup error', () => {
    const config = { root: '/nonexistent', title: 't', sources: {}, personas: {}, agents: { profiles: [], on: { 'spec.approved': { kind: 'code' } } }, forge: { type: 'github', repo: 'o/n' }, hooks: [] };
    expect(() => createCornfieldServer(config, { env: {} })).toThrow(/agents\.on, but sign-in is not set up/);
  });
});
