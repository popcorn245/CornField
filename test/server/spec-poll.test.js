/**
 * @vitest-environment node
 *
 * The spec.ready poll (server/spec-poll.js, PIPE-10) on its own: a fake forge, a real hooks module over a real SQLite
 * file (so the hook_seen rule is the real one), a hand-wound clock. It proves a poll announces a new non-draft head with
 * nobody looking, a second poll sends nothing, a poll and a dashboard look (`listPullProposals`) never announce twice,
 * a draft is not announced, no live maintainer session means a quiet skip (logged once), a forge error backs off and never
 * throws, and `close()` leaves no timer. The server wiring (off without a spec.ready hook) is at the end.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { createSpecPoll, FIRST_MS, MAX_CANDIDATES } from '../../server/spec-poll.js';
// @ts-expect-error plain JS module, no declarations
import { createHooks } from '../../server/hooks.js';
// @ts-expect-error plain JS module, no declarations
import { listPullProposals } from '../../server/proposal-pulls.js';
// @ts-expect-error plain JS module, no declarations
import { ForgeError } from '../../server/forge.js';
// @ts-expect-error plain JS module, no declarations
import { openStore } from '../../server/db.js';
// @ts-expect-error plain JS module, no declarations
import { createCornfieldServer } from '../../server/server.js';
// @ts-expect-error plain JS module, no declarations
import { loadConfig } from '../../core/config.js';
import { SAMPLE } from '../helpers.js';

const SECRET = 's3cret-'.repeat(6);
const FOLDER = 'docs/specs/proposals';
const PATH = `${FOLDER}/0040-meals.json`;
const INTERVAL = 300_000;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

/** A clock wound by hand */
function fakeTimer() {
  let now = 0;
  let next = 1;
  const queue = new Map();
  return {
    setTimeout: (fn, ms) => { const id = { n: next++, unref() {} }; queue.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { queue.delete(id); },
    get waiting() { return [...queue.values()].map((t) => t.at - now).sort((a, b) => a - b); },
    get count() { return queue.size; },
    async tick(ms) {
      const to = now + ms;
      for (;;) {
        const due = [...queue.entries()].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        queue.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = to;
    },
  };
}

const user = { login: 'author-one' };
const pull = (number, sha, extra = {}) => ({ number, title: 'Meals', state: 'open', draft: false, author: user, head: { sha }, url: `https://x.test/pull/${number}`, ...extra });

/** A forge as the poll and the listing see it; `world` is what the repo holds */
function fakeForge(world) {
  const calls = [];
  const f = {
    repo: 'owner/name',
    calls,
    me: async () => { calls.push('me'); return { id: world.userId, login: world.login }; },
    permission: async () => { calls.push('permission'); return world.permission; },
    pulls: async () => { calls.push('pulls'); if (world.pullsError) throw world.pullsError; return world.pulls; },
    pullFiles: async (n) => { calls.push(`pullFiles ${n}`); return [{ path: PATH, status: 'added' }]; },
    file: async (sha, p) => { calls.push(`file ${sha.slice(0, 4)}`); return `{"head":"${sha}","path":"${p}"}`; },
  };
  return f;
}

const made = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of made.splice(0)) { d.db?.close(); fs.rmSync(d.dir, { recursive: true, force: true }); } });

/** The poll over a real store and real hooks, with fakes for the forge and the sign-ins */
function setup({ sessions = [{ userId: '1001' }], events = '*', world: extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-poll-'));
  const db = openStore(dir);
  made.push({ dir, db });
  const world = { userId: 1001, login: 'maintainer-one', permission: 'admin', pulls: [], pullsError: null, ...extra };
  const forge = fakeForge(world);
  const state = { sessions };
  // the sessions table is real: a row is a live sign-in
  const syncSessions = () => {
    db.exec('DELETE FROM sessions');
    state.sessions.forEach((s, i) => db.prepare('INSERT INTO sessions (id, forge, user_id, login, token, permission, created_at, checked_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`s${i}`, 'github', s.userId, s.login || 'x', s.token ?? 'sealed', 'admin', s.at || `2026-11-03T09:0${i}:00.000Z`, '2026-11-03T09:00:00.000Z', '2099-01-01T00:00:00.000Z'));
  };
  syncSessions();
  const forged = [];
  const auth = {
    store: async () => db,
    forgeForUser: async (userId) => {
      forged.push(userId);
      if (world.revoked?.includes(userId)) throw new ForgeError('no live sign-in', { code: 'unauthorized' });
      return forge;
    },
  };
  const sent = [];
  const fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response(null, { status: 200 }); };
  const timer = fakeTimer();
  const hooks = createHooks({ hooks: [{ url: 'https://chat.example.org/h', events }], secret: SECRET, fetch, store: auth.store, timer: { setTimeout: () => 0, clearTimeout: () => {} } });
  const where = { proposals: FOLDER };
  const logs = [];
  vi.spyOn(console, 'error').mockImplementation((m) => { logs.push(String(m)); });
  const poll = createSpecPoll({ config: { forge: { repo: 'owner/name' } }, where, auth, hooks, intervalMs: INTERVAL, timer });
  const ready = () => sent.filter((e) => e.event === 'spec.ready');
  return { poll, hooks, forge, world, timer, sent, ready, logs, state, syncSessions, forged, where, db };
}

/** One poll tick, and the background work it started */
const run = async (t) => { const out = await t.poll.tick(); await settle(); return out; };

describe('the spec.ready poll', () => {
  it('announces a new non-draft head with nobody looking; the first look is silent; a second poll sends nothing', async () => {
    const t = setup({ world: { pulls: [pull(40, 'a'.repeat(40))] } });
    expect(await run(t)).toBe('ok');
    expect(t.ready()).toEqual([]); // the first look records what is open
    t.world.pulls = [pull(40, 'b'.repeat(40))]; // a push
    expect(await run(t)).toBe('ok');
    expect(t.ready()).toHaveLength(1);
    expect(t.ready()[0]).toMatchObject({ event: 'spec.ready', slug: '0040-meals', pull: 40, headSha: 'b'.repeat(40), actor: 'author-one' });
    expect(await run(t)).toBe('ok');
    expect(await run(t)).toBe('ok');
    expect(t.ready()).toHaveLength(1);
  });

  it('a poll and a dashboard look never announce the same head twice, in either order', async () => {
    const t = setup({ world: { pulls: [pull(40, 'a'.repeat(40))] } });
    await run(t);
    t.world.pulls = [pull(40, 'b'.repeat(40))];
    await listPullProposals(t.forge, t.where, { hooks: t.hooks }); // the dashboard sees the push first
    await settle();
    await run(t);
    expect(t.ready().map((e) => e.headSha)).toEqual(['b'.repeat(40)]);
    t.world.pulls = [pull(40, 'c'.repeat(40))];
    await run(t); // now the poll first
    await listPullProposals(t.forge, t.where, { hooks: t.hooks });
    await settle();
    expect(t.ready().map((e) => e.headSha)).toEqual(['b'.repeat(40), 'c'.repeat(40)]);
  });

  it('does not announce a draft, and announces it at its head once it is marked ready', async () => {
    const t = setup({ world: { pulls: [] } });
    await run(t);
    t.world.pulls = [pull(40, 'a'.repeat(40), { draft: true })];
    await run(t);
    await run(t);
    expect(t.ready()).toEqual([]);
    t.world.pulls = [pull(40, 'a'.repeat(40), { draft: false })];
    await run(t);
    expect(t.ready().map((e) => e.headSha)).toEqual(['a'.repeat(40)]);
  });

  it('skips quietly with no live session, logs once for the stretch, and works again when one appears', async () => {
    const t = setup({ sessions: [], world: { pulls: [pull(40, 'a'.repeat(40))] } });
    t.poll.start();
    expect(t.timer.waiting).toEqual([FIRST_MS]);
    await t.timer.tick(FIRST_MS);
    await t.timer.tick(INTERVAL);
    await t.timer.tick(INTERVAL);
    expect(t.forge.calls).toEqual([]); // nothing asked of the forge
    expect(t.logs.filter((l) => /no signed-in maintainer/.test(l))).toHaveLength(1);
    expect(t.timer.waiting).toEqual([INTERVAL]); // and it keeps running, at the normal pace
    t.state.sessions = [{ userId: '1001' }];
    t.syncSessions();
    await t.timer.tick(INTERVAL);
    expect(t.forge.calls).toContain('pulls');
    expect(t.logs.filter((l) => /maintainer is back/.test(l))).toHaveLength(1);
    t.world.pulls = [pull(40, 'b'.repeat(40))];
    await t.timer.tick(INTERVAL);
    await settle();
    expect(t.ready().map((e) => e.headSha)).toEqual(['b'.repeat(40)]);
    // a second stretch is logged again
    t.state.sessions = [];
    t.syncSessions();
    await t.timer.tick(INTERVAL);
    await t.timer.tick(INTERVAL);
    expect(t.logs.filter((l) => /no signed-in maintainer/.test(l))).toHaveLength(2);
    t.poll.close();
  });

  it('uses the newest live session of someone the forge says maintains the repo now, and passes over the rest', async () => {
    const t = setup({
      sessions: [{ userId: '1001', at: '2026-11-03T09:01:00.000Z' }, { userId: '1002', at: '2026-11-03T09:05:00.000Z' }, { userId: '1003', at: '2026-11-03T09:03:00.000Z' }],
    });
    // 1002 is newest but its token is refused; 1003 is next and no longer maintains the repo; 1001 does
    const asked = [];
    const forgeOf = (id) => ({ ...t.forge, me: async () => ({ id: Number(id), login: `u${id}` }), permission: async () => (id === '1003' ? 'write' : 'maintain') });
    const forgeForUser = async (id) => { asked.push(id); if (id === '1002') throw new ForgeError('no live sign-in', { code: 'unauthorized' }); return forgeOf(id); };
    const poll = createSpecPoll({ config: { forge: { repo: 'owner/name' } }, where: t.where, auth: { store: async () => t.db, forgeForUser }, hooks: t.hooks, intervalMs: INTERVAL, timer: fakeTimer() });
    expect(await poll.tick()).toBe('ok');
    expect(asked).toEqual(['1002', '1003', '1001']);
    expect(t.forge.calls).toContain('pulls');
    // whose sign-in it looked with is on record, once while it stays the same
    expect(await poll.tick()).toBe('ok');
    expect(t.logs.filter((l) => /sign-in of @/.test(l))).toEqual(['[cornfield] spec.ready poll: looking at the open spec PRs with the sign-in of @u1001, a maintainer']);
    poll.close();
    expect(await poll.tick()).toBe('closed');
  });

  it('with only non-maintainers signed in it does not list, and tries at most MAX_CANDIDATES users', async () => {
    const sessions = Array.from({ length: MAX_CANDIDATES + 3 }, (_, i) => ({ userId: String(2000 + i) }));
    const t = setup({ sessions, world: { permission: 'write', userId: 0 } });
    t.forge.me = async () => ({ id: 0, login: 'x' });
    t.world.userId = 0;
    // every user is someone else's id: me().id does not match the session's user, so nobody qualifies
    expect(await run(t)).toBe('no-session');
    expect(t.forged).toHaveLength(MAX_CANDIDATES);
    expect(t.forge.calls).not.toContain('pulls');
  });

  it('never uses a token the config holds: it asks auth.forgeForUser, nothing else', async () => {
    const t = setup({ world: { pulls: [] } });
    const poll = createSpecPoll({ config: { forge: { repo: 'owner/name', token: 'from-config' }, token: 'x' }, where: t.where, auth: { store: async () => t.db, forgeForUser: async () => { throw new ForgeError('no', { code: 'unauthorized' }); } }, hooks: t.hooks, intervalMs: INTERVAL, timer: fakeTimer() });
    expect(await poll.tick()).toBe('no-session');
    expect(t.forge.calls).toEqual([]);
  });

  it('a forge error is logged, never thrown, and the next tick waits twice the interval until one succeeds', async () => {
    const t = setup({ world: { pulls: [pull(40, 'a'.repeat(40))] } });
    t.poll.start();
    await t.timer.tick(FIRST_MS);
    expect(t.timer.waiting).toEqual([INTERVAL]);
    t.world.pullsError = new ForgeError('The forge is down.', { code: 'unavailable' });
    await t.timer.tick(INTERVAL);
    expect(t.logs.some((l) => /The forge is down/.test(l))).toBe(true);
    expect(t.timer.waiting).toEqual([INTERVAL * 2]);
    await t.timer.tick(INTERVAL * 2); // still down
    expect(t.timer.waiting).toEqual([INTERVAL * 2]);
    t.world.pullsError = null;
    await t.timer.tick(INTERVAL * 2);
    expect(t.timer.waiting).toEqual([INTERVAL]); // back to the normal pace
    // an error that is thrown rather than returned is caught too
    t.forge.me = async () => { throw new Error('boom'); };
    await expect(t.poll.tick()).resolves.toBe('no-session');
    t.poll.close();
  });

  it('a throwing listing is caught and backs off', async () => {
    const t = setup({ world: { pulls: [] } });
    t.forge.pulls = async () => { throw new TypeError('not a forge error'); };
    t.poll.start();
    await t.timer.tick(FIRST_MS);
    expect(t.timer.waiting).toEqual([INTERVAL * 2]);
  });

  it('runs one look at a time: a tick while one is in flight is skipped', async () => {
    const t = setup({ world: { pulls: [] } });
    let release;
    t.forge.pulls = () => new Promise((r) => { release = () => r([]); });
    const first = t.poll.tick();
    await settle();
    expect(await t.poll.tick()).toBe('busy');
    release();
    expect(await first).toBe('ok');
    t.forge.pulls = async () => [];
    expect(await t.poll.tick()).toBe('ok'); // and the next one runs again
  });

  it('close() leaves no timer, also while a look is in flight, and the timer is unref\'d', async () => {
    const t = setup({ world: { pulls: [] } });
    const unref = vi.fn();
    const timer = { setTimeout: vi.fn(() => ({ unref })), clearTimeout: vi.fn() };
    const poll = createSpecPoll({ config: { forge: { repo: 'owner/name' } }, where: t.where, auth: { store: async () => t.db, forgeForUser: async () => t.forge }, hooks: t.hooks, intervalMs: INTERVAL, timer });
    poll.start();
    expect(unref).toHaveBeenCalledTimes(1);
    poll.close();
    expect(timer.clearTimeout).toHaveBeenCalledTimes(1);
    expect(await poll.tick()).toBe('closed');
    // closed while a look is running: nothing is scheduled afterwards
    let release;
    t.forge.pulls = () => new Promise((r) => { release = () => r([]); });
    const again = createSpecPoll({ config: { forge: { repo: 'owner/name' } }, where: t.where, auth: { store: async () => t.db, forgeForUser: async () => t.forge }, hooks: t.hooks, intervalMs: INTERVAL, timer: t.timer });
    const p = again.tick();
    await settle();
    again.close();
    release();
    await p;
    expect(t.timer.count).toBe(0);
  });
});

describe('the server', () => {
  const ENV = { CORNFIELD_GITHUB_CLIENT_ID: 'id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: 'x'.repeat(40), CORNFIELD_HOOK_SECRET: SECRET };

  /** Makes a server over a throwaway data folder with this hooks config, listens, and reports the timers its poll set */
  async function boot(extra) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-poll-srv-'));
    made.push({ dir });
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: dir } });
    Object.assign(config, { forge: { type: 'github', url: 'http://127.0.0.1:1', repo: 'owner/name' }, publicUrl: 'http://127.0.0.1:3350', ...extra });
    const timer = fakeTimer();
    const server = createCornfieldServer(config, { env: ENV, specPollTimer: timer, hookTimer: { setTimeout: () => 0, clearTimeout: () => {} } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); });
    return { timer, close };
  }
  const hook = (events) => [{ url: 'https://chat.example.org/h', events }];

  it('is off when no hook asks for spec.ready, and when hookPoll is false', async () => {
    for (const extra of [{ hooks: hook(['pr.landed']) }, { hooks: hook('*'), hookPoll: { specs: false } }, { hooks: hook('*'), hookPoll: false }]) {
      const s = await boot(extra);
      expect(s.timer.count, JSON.stringify(extra)).toBe(0);
      await s.close();
    }
  });

  it('is on when a hook asks for spec.ready, at the configured interval, and close leaves no timer', async () => {
    const s = await boot({ hooks: hook(['spec.ready']), hookPoll: { specs: '90s' } });
    expect(s.timer.waiting).toEqual([FIRST_MS]);
    await s.timer.tick(FIRST_MS); // no sign-in session: nothing asked of the forge, the next is a poll interval away
    expect(s.timer.waiting).toEqual([90_000]);
    await s.close();
    expect(s.timer.count).toBe(0);
  });
});
