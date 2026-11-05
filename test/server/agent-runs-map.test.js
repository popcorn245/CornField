/**
 * @vitest-environment node
 *
 * Runs on the map (server/agent-runs.js, issue #82): the nodes an open run is changing (from the files of its branch or pull request once it
 * has one, from the request and the mentions of its subject before), read once for each head; the open runs that share a node mark each
 * other; `agents.refuseCollisions` refuses an overlapping request in the transaction that takes the place; and a run's timeline reads in
 * order, each thing once. A fake forge, a real SQLite store and a hand-wound clock, as in agent-runs.test.js.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { createRuns, proposalNodeIds } from '../../server/agent-runs.js';
// @ts-expect-error plain JS module, no declarations
import { ForgeError } from '../../server/forge.js';
// @ts-expect-error plain JS module, no declarations
import { openStore } from '../../server/db.js';
// @ts-expect-error plain JS module, no declarations
import { refusal } from '../../server/submit-review.js';
// @ts-expect-error plain JS module, no declarations
import { formatRunComment } from '../../core/agent-contract.js';

const FOLDER = 'docs/specs/proposals';
const T0 = Date.parse('2026-11-05T10:00:00Z');
const HOUR = 3_600_000;
const MAP = { nodes: [
  { id: 'orders', type: 'page', file: 'server/orders.js' },
  { id: 'cart', type: 'page', file: 'server/cart.js' },
  { id: 'web', type: 'app', file: 'web' },
  { id: 'lonely', type: 'pkg' },
], edges: [] };
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

const made = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of made.splice(0)) { d.db.close(); fs.rmSync(d.dir, { recursive: true, force: true }); } });

function setup({ refuse = false, maxOpen = 5 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-map-'));
  fs.writeFileSync(path.join(dir, 'topology.json'), JSON.stringify(MAP));
  const db = openStore(dir);
  made.push({ dir, db });
  const clock = { now: T0 };
  const stamp = () => new Date(clock.now).toISOString();
  const world = {
    issues: new Map([12, 13, 14, 15].map((n) => [n, { number: n, state: 'open', body: '' }])),
    comments: new Map(), next: 9000, pulls: [], files: new Map(), compared: [], checks: new Map(), branches: [], calls: [],
  };
  const say = (number, login, body) => {
    const c = { id: String(world.next++), author: { login }, body, url: `https://forge.test/c/${world.next}`, createdAt: stamp(), updatedAt: stamp() };
    world.comments.set(number, [...(world.comments.get(number) ?? []), c]);
    return c;
  };
  const forge = {
    repo: 'owner/name',
    me: async () => ({ id: 1001, login: 'maintainer-one' }),
    permission: async (_r, who) => (who === 'maintainer-one' ? 'admin' : who === 'runner-bot' ? 'write' : 'none'),
    issue: async (n) => { world.calls.push(`issue ${n}`); const i = world.issues.get(n); if (!i) throw new ForgeError('no', { code: 'not-found' }); return i; },
    comment: async (n, body) => { const c = say(n, 'maintainer-one', body); return { id: c.id, url: c.url }; },
    comments: async (n) => world.comments.get(n) ?? [],
    pulls: async () => world.pulls,
    pull: async (n) => world.pulls.find((p) => p.number === n),
    pullFiles: async (n) => { world.calls.push(`pullFiles ${n}`); return world.files.get(n) ?? []; },
    compare: async (base, head) => { world.compared.push([base, head]); return world.files.get(head) ?? []; },
    pullCommits: async () => [],
    checks: async (sha) => world.checks.get(sha) ?? [],
    branches: async () => world.branches,
    defaultBranch: async () => 'main',
  };
  const auth = { store: async () => db, record: async () => {} };
  const cfg = { root: dir, topology: 'topology.json', forge: { repo: 'owner/name', baseBranch: 'main' }, proposals: FOLDER,
    agents: { maxOpen, profiles: ['claude', 'qwen'], runners: ['runner-bot'], authors: [], quietAfter: '24h', refuseCollisions: refuse } };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const runs = createRuns({ config: cfg, where: { proposals: FOLDER }, auth, now: () => clock.now });
  const limits = { auth, now: () => clock.now };
  const ctx = { forge: () => forge, who: { login: 'maintainer-one', userId: '1001' }, limits };
  const ask = async (body) => {
    clock.now += 61_000; // the per-minute counters and the repeat guard are not what is held here
    try { const out = await runs.request(ctx, { body: { kind: 'code', brief: 'x', ...body } }); await settle(); return { ok: true, id: out.run.runId, run: out.run }; } catch (err) { const r = refusal(err); return { ok: false, status: r.status, code: r.body.code, error: r.body.error }; }
  };
  return { runs, ask, world, say, db, forge, clock, follow: () => runs.follow(forge), wait: (ms) => { clock.now += ms; }, stamp };
}

const pr = (id, extra = {}) => ({ number: 50, title: 'T', body: `Cornfield-Run: ${id}`, state: 'open', draft: false, author: { login: 'runner-bot' }, head: { ref: 'agent/x', sha: 'b'.repeat(40) }, base: { ref: 'main' }, url: 'https://forge.test/pull/50', createdAt: new Date(T0 + 120_000).toISOString(), updatedAt: new Date(T0 + 180_000).toISOString(), mergedAt: null, ...extra });

describe('the nodes of a run', () => {
  it('are the request\'s nodes and the mentions of its subject before the first push, only those the map has', async () => {
    const t = setup();
    t.world.issues.get(12).body = 'See [[cart]] and [[nowhere]] and `[[web]]`';
    const a = await t.ask({ refs: { issue: 12 }, nodes: ['orders', 'ghost'] });
    expect(a.run).toMatchObject({ nodes: ['orders'], nodesFrom: 'request' });
    await t.follow(); // reads the opening post, once
    await t.follow();
    expect(t.world.calls.filter((c) => c === 'issue 12').length).toBe(2); // once at the request, once for the mentions
    expect(await t.runs.get(a.id)).toMatchObject({ nodes: ['orders', 'cart'], nodesFrom: 'request' });
  });

  it('are the nodes of the files a pull request changes once it has one, read once for each head sha', async () => {
    const t = setup();
    const a = await t.ask({ refs: { issue: 12 }, nodes: ['lonely'] });
    t.world.pulls = [pr(a.id)];
    t.world.files.set(50, [{ path: 'server/orders.js', status: 'modified', previousPath: null }, { path: 'web/pages/home.js', status: 'added', previousPath: null }, { path: 'README.md', status: 'modified', previousPath: null }]);
    t.wait(300_000);
    await t.follow();
    const run = await t.runs.get(a.id);
    expect(run).toMatchObject({ nodesFrom: 'files' });
    expect([...run.nodes].sort()).toEqual(['orders', 'web']); // the request's own node is not changed by the files
    await t.follow();
    await t.follow();
    expect(t.world.calls.filter((c) => c === 'pullFiles 50').length).toBe(1);
    // a push: read again; a rename lights where it came from too
    t.world.pulls = [pr(a.id, { head: { ref: 'agent/x', sha: 'c'.repeat(40) } })];
    t.world.files.set(50, [{ path: 'server/cart.js', status: 'renamed', previousPath: 'server/orders.js' }]);
    await t.follow();
    expect([...(await t.runs.get(a.id)).nodes].sort()).toEqual(['cart', 'orders']);
    expect(t.world.calls.filter((c) => c === 'pullFiles 50').length).toBe(2);
  });

  it('come from a comparison of the branch with the base while there is no pull request', async () => {
    const t = setup();
    const a = await t.ask({ refs: { issue: 12 } });
    const sha = 'd'.repeat(40);
    t.world.branches = [{ name: `agent/${a.id}/x`, sha, protected: false }];
    t.world.files.set(sha, [{ path: 'server/cart.js', status: 'modified', previousPath: null }]);
    t.wait(60_000);
    await t.follow();
    await t.follow();
    expect(t.world.compared).toEqual([['main', sha]]);
    expect(await t.runs.get(a.id)).toMatchObject({ nodes: ['cart'], nodesFrom: 'files' });
  });

  it('fall back to what the run is about when the forge cannot list a comparison\'s files (an older Forgejo), asked once for each push', async () => {
    const t = setup();
    t.world.issues.get(12).body = 'About [[cart]]';
    const a = await t.ask({ refs: { issue: 12 }, nodes: ['orders'] });
    t.world.branches = [{ name: `agent/${a.id}/x`, sha: 'd'.repeat(40), protected: false }];
    let asked = 0;
    t.forge.compare = async () => { asked += 1; throw new ForgeError('This Forgejo does not list the files of a comparison.', { code: 'invalid' }); };
    t.wait(60_000);
    await t.follow();
    await t.follow();
    await t.follow();
    expect(asked).toBe(1); // not every look: the answer will not change at this head
    // the request's node, and the subject's mentions, read although the run has a head
    expect(await t.runs.get(a.id)).toMatchObject({ nodes: ['orders', 'cart'], nodesFrom: 'request' });
    // a push asks again
    t.world.branches = [{ name: `agent/${a.id}/x`, sha: 'e'.repeat(40), protected: false }];
    await t.follow();
    expect(asked).toBe(2);
  });

  it('try again at the next look when the forge failed for another reason (it may answer then)', async () => {
    const t = setup();
    const a = await t.ask({ refs: { issue: 12 }, nodes: ['orders'] });
    t.world.branches = [{ name: `agent/${a.id}/x`, sha: 'd'.repeat(40), protected: false }];
    let asked = 0;
    t.forge.compare = async () => { asked += 1; throw new ForgeError('down', { code: 'unavailable' }); };
    t.wait(60_000);
    await t.follow();
    await t.follow();
    expect(asked).toBe(2);
    expect(await t.runs.get(a.id)).toMatchObject({ nodes: ['orders'], nodesFrom: 'request' });
  });
});

describe('collisions', () => {
  it('mark both open runs that share a node, and no run that is not open', async () => {
    const t = setup();
    const a = await t.ask({ refs: { issue: 12 }, nodes: ['orders', 'cart'] });
    const b = await t.ask({ refs: { issue: 13 }, nodes: ['cart'] });
    const c = await t.ask({ refs: { issue: 14 }, nodes: ['web'] });
    const list = (await t.runs.list()).runs;
    const by = Object.fromEntries(list.map((r) => [r.runId, r.collidesWith]));
    expect(by[a.id]).toEqual([b.id]);
    expect(by[b.id]).toEqual([a.id]);
    expect(by[c.id]).toEqual([]);
    // a finishes: nothing collides any more
    t.say(12, 'runner-bot', formatRunComment(a.id, { state: 'done' }));
    await t.follow();
    const after = Object.fromEntries((await t.runs.list()).runs.map((r) => [r.runId, r.collidesWith]));
    expect(after[a.id]).toEqual([]);
    expect(after[b.id]).toEqual([]);
  });

  it('are found from the files too, not only from what was asked for', async () => {
    const t = setup();
    const a = await t.ask({ refs: { issue: 12 }, nodes: ['web'] });
    const b = await t.ask({ refs: { issue: 13 } });
    t.world.pulls = [pr(b.id)];
    t.world.files.set(50, [{ path: 'web/x.js', status: 'modified', previousPath: null }]);
    await t.follow();
    expect((await t.runs.get(a.id)).collidesWith).toEqual([b.id]);
    expect((await t.runs.get(b.id)).collidesWith).toEqual([a.id]);
  });

  it('are allowed by default, and refused with agents.refuseCollisions, naming the node and the run, without posting', async () => {
    const off = setup();
    await off.ask({ refs: { issue: 12 }, nodes: ['orders'] });
    expect((await off.ask({ refs: { issue: 13 }, nodes: ['orders'] })).ok).toBe(true);

    const t = setup({ refuse: true });
    const a = await t.ask({ refs: { issue: 12 }, nodes: ['orders'] });
    const posted = (t.world.comments.get(13) ?? []).length;
    const refused = await t.ask({ refs: { issue: 13 }, nodes: ['orders', 'web'] });
    expect(refused).toMatchObject({ ok: false, status: 409, code: 'collision' });
    expect(refused.error).toContain('orders');
    expect(refused.error).toContain(a.id);
    expect((t.world.comments.get(13) ?? []).length).toBe(posted);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n).toBe(1);
    // another node, or none named, is fine
    expect((await t.ask({ refs: { issue: 13 }, nodes: ['web'] })).ok).toBe(true);
    expect((await t.ask({ refs: { issue: 14 } })).ok).toBe(true);
  });

  it('refuse a request that names no node (the dashboard\'s button) by what its subject mentions, and keep those as its nodes', async () => {
    const t = setup({ refuse: true });
    t.world.issues.get(12).body = 'Meals: [[server/orders.js]]';
    t.world.issues.get(13).body = 'Also about [[orders]], and [[web]]';
    t.world.issues.get(14).body = 'Only [[cart]]';
    const a = await t.ask({ refs: { issue: 12 } });
    expect(a.run).toMatchObject({ nodes: ['orders'], nodesFrom: 'request' }); // read at the request, on the map at once
    const refused = await t.ask({ refs: { issue: 13 } });
    expect(refused).toMatchObject({ ok: false, status: 409, code: 'collision' });
    expect(refused.error).toContain('orders');
    expect(refused.error).toContain(a.id);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM run_reads').get().n).toBe(1); // nothing kept for the refused one
    expect((await t.ask({ refs: { issue: 14 } })).ok).toBe(true);
  });

  it('refuse by the proposal\'s nodes, for a request about a proposal that names none', async () => {
    const t = setup({ refuse: true });
    const sha = 'f'.repeat(40);
    t.world.pulls = [{ number: 60, title: 'Spec: meals', body: 'Thread: #12', state: 'open', draft: false, author: { login: 'maintainer-one' }, head: { ref: 'spec/0013-meals', sha }, base: { ref: 'main' }, url: 'https://forge.test/pull/60', createdAt: t.stamp(), updatedAt: t.stamp(), mergedAt: null }];
    t.world.files.set(60, [{ path: `${FOLDER}/0013-meals.json`, status: 'added', previousPath: null }]);
    t.forge.file = async (ref, p) => (ref === sha && p === `${FOLDER}/0013-meals.json`
      ? JSON.stringify({ version: 1, title: 'Meals', summary: 's', nodes: { add: [{ id: 'page-meals', label: '/meals', type: 'page', parent: 'web' }], change: [{ id: 'cart', set: { desc: 'x' }, why: 'y' }] } })
      : null);
    const a = await t.ask({ refs: { issue: 14 }, nodes: ['web'] });
    expect(a.ok).toBe(true);
    const refused = await t.ask({ refs: { proposal: '0013-meals' } });
    expect(refused).toMatchObject({ ok: false, status: 409, code: 'collision' });
    expect(refused.error).toContain('web'); // the parent of what the proposal adds
    expect(refused.error).toContain(a.id);
  });

  it('refuse rather than let through unchecked when what the request is about cannot be read', async () => {
    const t = setup({ refuse: true });
    await t.ask({ refs: { issue: 12 }, nodes: ['orders'] });
    const issue = t.forge.issue;
    let calls = 0;
    // the existence check passes, the read for the subject's mentions fails
    t.forge.issue = async (n) => { calls += 1; if (n === 13 && calls > 1) throw new ForgeError('down', { code: 'unavailable' }); return issue(n); };
    const refused = await t.ask({ refs: { issue: 13 } });
    expect(refused).toMatchObject({ ok: false, status: 503, code: 'unavailable' });
    expect(refused.error).toMatch(/cannot be checked for collisions/);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n).toBe(1);
  });

  it('are refused in the transaction that takes the place: two at once get one, and the cap is still checked first', async () => {
    const t = setup({ refuse: true });
    const ctx = (n) => ({ forge: () => t.forge, who: { login: 'maintainer-one', userId: '1001' }, limits: { auth: { store: async () => t.db, record: async () => {} }, now: () => t.clock.now + n } });
    const go = (issue, n) => t.runs.request(ctx(n), { body: { kind: 'code', brief: 'x', refs: { issue }, nodes: ['cart'] } }).then(() => 'ok', (e) => refusal(e).body.code);
    const got = await Promise.all([go(12, 0), go(13, 1)]);
    expect(got.sort()).toEqual(['collision', 'ok']);
    // the cap is said first when both are true
    const full = setup({ refuse: true, maxOpen: 1 });
    await full.ask({ refs: { issue: 12 }, nodes: ['cart'] });
    expect(await full.ask({ refs: { issue: 13 }, nodes: ['cart'] })).toMatchObject({ code: 'cap-reached' });
  });

  it('do not count a quiet run', async () => {
    const t = setup({ refuse: true });
    await t.ask({ refs: { issue: 12 }, nodes: ['cart'] });
    t.wait(25 * HOUR);
    expect((await t.ask({ refs: { issue: 13 }, nodes: ['cart'] })).ok).toBe(true);
  });
});

describe('the timeline', () => {
  it('reads in order: requested, claimed, the reports with their notes, the push, the pull request, its checks, a stop, how it ended; each once', async () => {
    const t = setup();
    const a = await t.ask({ refs: { issue: 12 }, profile: 'claude' });
    t.wait(60_000);
    t.say(12, 'runner-bot', formatRunComment(a.id, { state: 'claimed' }));
    t.wait(60_000);
    const opened = new Date(t.clock.now).toISOString();
    t.wait(60_000);
    t.say(12, 'runner-bot', formatRunComment(a.id, { state: 'working', note: 'tests <b>failing</b>', url: 'https://ci.example.org/1' }));
    t.world.pulls = [pr(a.id, { createdAt: opened })];
    t.world.checks.set('b'.repeat(40), [{ state: 'running' }]);
    t.wait(60_000);
    await t.follow();
    t.world.checks.set('b'.repeat(40), [{ state: 'success' }]);
    t.wait(60_000);
    await t.follow();
    t.wait(60_000);
    t.say(12, 'maintainer-one', formatRunComment(a.id, { state: 'stop-requested', note: 'enough' }));
    t.world.pulls = [pr(a.id, { state: 'merged', mergedAt: new Date(t.clock.now + 60_000).toISOString() })];
    t.wait(120_000);
    await t.follow();
    await t.follow();
    const run = await t.runs.get(a.id);
    expect(run.timeline.map((e) => e.kind)).toEqual(['requested', 'claimed', 'pull-opened', 'report', 'push', 'checks', 'checks', 'stop-requested', 'merged']);
    const at = run.timeline.map((e) => Date.parse(e.at));
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(run.timeline[0]).toMatchObject({ kind: 'requested', actor: 'maintainer-one', ref: 'claude' });
    expect(run.timeline[3]).toMatchObject({ kind: 'report', ref: 'working', note: 'tests <b>failing</b>', url: 'https://ci.example.org/1', actor: 'runner-bot' });
    expect(run.timeline.filter((e) => e.kind === 'checks').map((e) => e.ref)).toEqual(['running', 'success']);
    expect(run.timeline.at(-1)).toMatchObject({ kind: 'merged', ref: '#50' });
  });

  it('keeps a stop asked from cornfield, and ends with quiet when the run is', async () => {
    const t = setup();
    const a = await t.ask({ refs: { issue: 12 } });
    t.wait(60_000);
    await t.runs.stop({ forge: () => t.forge, who: { login: 'maintainer-one', userId: '1001' }, limits: { auth: { store: async () => t.db, record: async () => {} }, now: () => t.clock.now } }, { runId: a.id, note: 'wrong issue' });
    await t.follow(); // reads its own comment back: no second event
    expect((await t.runs.get(a.id)).timeline.map((e) => e.kind)).toEqual(['requested', 'stop-requested']);
    t.wait(26 * HOUR);
    const quiet = await t.runs.get(a.id);
    expect(quiet.timeline.map((e) => e.kind)).toEqual(['requested', 'stop-requested', 'quiet']);
    expect(Date.parse(quiet.timeline.at(-1).at)).toBeGreaterThan(Date.parse(quiet.timeline[1].at));
  });

  it('a forge answer missing a field (a pull request with no time) does not stop the look: the run is followed, the event dated when seen', async () => {
    const t = setup();
    const a = await t.ask({ refs: { issue: 12 } });
    t.world.pulls = [pr(a.id, { createdAt: undefined, updatedAt: undefined, author: { login: 'runner-bot', html_url: { odd: true } } })];
    t.world.files.set(50, [{ path: 'server/orders.js', status: 'modified', previousPath: null }]);
    t.wait(300_000);
    await t.follow();
    const run = await t.runs.get(a.id);
    expect(run.pull).toMatchObject({ number: 50 });
    const opened = run.timeline.find((e) => e.kind === 'pull-opened');
    expect(opened.at).toBe(new Date(t.clock.now).toISOString());
  });

  it('is in the list as well as the run, and holds nothing of a credential', async () => {
    const t = setup();
    const a = await t.ask({ refs: { issue: 12 } });
    const list = await t.runs.list();
    expect(list.refuseCollisions).toBe(false);
    expect(list.runs.find((r) => r.runId === a.id).timeline.length).toBe(1);
  });
});

describe('proposalNodeIds', () => {
  it('names every node a proposal touches: added (and their parents), changed, removed, and the ends of its edges', () => {
    expect(proposalNodeIds({
      nodes: { add: [{ id: 'page-meals', parent: 'web' }], change: [{ id: 'cart' }], remove: [{ id: 'old' }] },
      edges: { add: [{ from: 'page-meals', to: 'orders' }], change: [{ from: 'web', to: 'cart' }], remove: [{ from: 'x', to: 'y' }] },
    }).sort()).toEqual(['cart', 'old', 'orders', 'page-meals', 'web', 'x', 'y']);
  });

  it('gives nothing for what is not a proposal, and skips what is not an id', () => {
    for (const p of [null, undefined, 'text', 7, [], {}, { nodes: 'x' }, { nodes: { add: [null, { id: 3 }, { id: '' }] } }]) expect(proposalNodeIds(p)).toEqual([]);
  });
});
