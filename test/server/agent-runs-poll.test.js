/**
 * @vitest-environment node
 *
 * Agent runs on the spec poll's tick (server/spec-poll.js): with a run to follow the tick hands the maintainer's forge to `runs.follow`;
 * with none it asks the forge nothing; `specs: false` leaves the spec PRs alone; and the server starts the poll only when a run is asked
 * for (or was, before a restart), and close() leaves no timer.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { createSpecPoll } from '../../server/spec-poll.js';
// @ts-expect-error plain JS module, no declarations
import { createCornfieldServer } from '../../server/server.js';
// @ts-expect-error plain JS module, no declarations
import { loadConfig } from '../../core/config.js';
// @ts-expect-error plain JS module, no declarations
import { openStore } from '../../server/db.js';
import { SAMPLE } from '../helpers.js';

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const dirs = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function poll({ work, specs = false, discover = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-runpoll-'));
  dirs.push(dir);
  const db = openStore(dir);
  db.exec("INSERT INTO sessions (id, forge, user_id, login, token, permission, created_at, checked_at, expires_at) VALUES ('s', 'github', '1', 'm', 'sealed', 'admin', '2026-11-03T09:00:00.000Z', '2026-11-03T09:00:00.000Z', '2099-01-01T00:00:00.000Z')");
  const calls = [];
  const forge = { me: async () => { calls.push('me'); return { id: 1, login: 'm' }; }, permission: async () => 'admin', pulls: async () => { calls.push('pulls'); return []; }, pullFiles: async () => [] };
  const runs = { hasWork: async () => work, follow: vi.fn(async () => ({})), ...(discover ? { discovers: true, discover } : {}) };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const p = createSpecPoll({ config: { forge: { repo: 'owner/name' } }, where: { proposals: 'docs/specs/proposals' }, auth: { store: async () => db, forgeForUser: async () => forge }, hooks: null, runs, specs, intervalMs: 300_000, timer: { setTimeout: () => ({ unref() {} }), clearTimeout() {} } });
  return { p, calls, runs, close: () => db.close() };
}

describe('following runs on the poll tick', () => {
  it('follows with the maintainer\'s forge when there is a run, and leaves the spec PRs alone with specs: false', async () => {
    const t = poll({ work: true });
    expect(await t.p.tick()).toBe('ok');
    expect(t.runs.follow).toHaveBeenCalledTimes(1);
    expect(t.calls).not.toContain('pulls');
    t.close();
  });
  it('asks the forge nothing when there is no run and no spec to look at', async () => {
    const t = poll({ work: false });
    expect(await t.p.tick()).toBe('ok');
    expect(t.calls).toEqual([]);
    expect(t.runs.follow).not.toHaveBeenCalled();
    t.close();
  });
  it('does both when specs are wanted too', async () => {
    const t = poll({ work: true, specs: true });
    await t.p.tick();
    expect(t.calls).toContain('pulls');
    expect(t.runs.follow).toHaveBeenCalledTimes(1);
    t.close();
  });
});

describe('requests written by hand on the poll tick', () => {
  it('are looked for even with no run, and a run just found is followed in the same look', async () => {
    const discover = vi.fn(async () => ({ read: 1, imported: 1, refused: 0 }));
    const t = poll({ work: false, discover });
    expect(await t.p.tick()).toBe('ok');
    expect(discover).toHaveBeenCalledTimes(1);
    expect(t.runs.follow).toHaveBeenCalledTimes(1);
    t.close();
  });
  it('find nothing, follow nothing', async () => {
    const discover = vi.fn(async () => ({ read: 2, imported: 0, refused: 0 }));
    const t = poll({ work: false, discover });
    await t.p.tick();
    expect(discover).toHaveBeenCalledTimes(1);
    expect(t.runs.follow).not.toHaveBeenCalled();
    t.close();
  });
  it('failing is the look\'s failure, not a throw, and the runs are still followed', async () => {
    const t = poll({ work: true, discover: vi.fn(async () => { throw new Error('boom'); }) });
    expect(await t.p.tick()).toBe('error');
    expect(t.runs.follow).toHaveBeenCalledTimes(1);
    t.close();
  });
});

describe('the server', () => {
  const ENV = { CORNFIELD_GITHUB_CLIENT_ID: 'id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: 'x'.repeat(40) };
  async function boot(dir, agents = { handWritten: false }) {
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: dir } });
    Object.assign(config, { forge: { type: 'github', url: 'http://127.0.0.1:1', repo: 'owner/name' }, publicUrl: 'http://127.0.0.1:3350', agents: { ...config.agents, ...agents } });
    const timers = new Set();
    const timer = { setTimeout: (fn, ms) => { const t = { ms, unref() {} }; timers.add(t); return t; }, clearTimeout: (t) => { timers.delete(t); } };
    const server = createCornfieldServer(config, { env: ENV, specPollTimer: timer });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    await settle();
    return { timers, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
  }

  it('starts the poll with no run when requests written by hand are looked for (the default)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-runpoll-hand-'));
    dirs.push(dir);
    const s = await boot(dir, {});
    expect(s.timers.size).toBe(1);
    await s.close();
    expect(s.timers.size).toBe(0);
  });

  it('starts no timer with no run, starts one after a restart that finds a run to follow, and close() leaves none', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-runpoll-srv-'));
    dirs.push(dir);
    const idle = await boot(dir);
    expect(idle.timers.size).toBe(0);
    await idle.close();
    const db = openStore(dir);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO runs (run_id, repo, kind, target, comment_id, request, requested_by, requested_by_id, requested_at, last_activity) VALUES ('run-01JC8Z3Q5M7VXK2RT9N4B6HDEF', 'owner/name', 'code', 12, '9', '{}', 'm', '1', ?, ?)").run(now, now);
    db.close();
    const resumed = await boot(dir);
    expect(resumed.timers.size).toBe(1);
    await resumed.close();
    expect(resumed.timers.size).toBe(0);
  });
});
