/**
 * @vitest-environment node
 *
 * Runner presence (issue #99; server/runner-presence.js) without the server: what counts as a live, polling runner token, and when the
 * watch fires `runner.offline` (once, re-armed only by a runner seen online again, never for a token that was ended on purpose).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { openStore } from '../../server/db.js';
// @ts-expect-error plain JS modules, no declarations
import { mintToken, touchToken, revokeToken } from '../../server/review-tokens.js';
// @ts-expect-error plain JS modules, no declarations
import { runnerPresence, createRunnerWatch } from '../../server/runner-presence.js';

const T0 = Date.parse('2026-11-05T09:00:00Z');
const MIN = 60_000;
const QUIET = 3 * MIN;

describe('runner presence', () => {
  let dir;
  let db;
  let now;
  const owner = { userId: '1', login: 'maintainer-one' };
  const runner = (label, days) => mintToken(db, { ...owner, label, scope: 'runner', days }, now).row;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-presence-')); db = openStore(dir); now = T0; });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('lists live runner tokens that have polled, newest first, and is online within the window', () => {
    const a = runner('laptop');
    runner('never polled');
    mintToken(db, { ...owner, label: 'review one', scope: 'review' }, now);
    expect(runnerPresence(db, now, QUIET)).toEqual({ online: false, lastSeen: null, quietAfterMs: QUIET, runners: [] });
    touchToken(db, a.id, now);
    const b = runner('server');
    touchToken(db, b.id, now + 10_000);
    const p = runnerPresence(db, now + 20_000, QUIET);
    expect(p.online).toBe(true);
    expect(p.runners.map((r) => r.label)).toEqual(['server', 'laptop']);
    expect(runnerPresence(db, now + 10_000 + QUIET, QUIET).online).toBe(false);
  });

  it('leaves out revoked and expired tokens', () => {
    const a = runner('laptop', 1);
    const b = runner('server');
    touchToken(db, a.id, now);
    touchToken(db, b.id, now);
    revokeToken(db, owner.userId, b.id, now);
    expect(runnerPresence(db, now, QUIET).runners.map((r) => r.label)).toEqual(['laptop']);
    expect(runnerPresence(db, now + 2 * 24 * 60 * MIN, QUIET)).toMatchObject({ online: false, runners: [] });
  });

  describe('the watch', () => {
    const watch = () => {
      const events = [];
      const w = createRunnerWatch({ auth: { store: async () => db }, hooks: { emit: (e, p) => events.push([e, p]) }, quietMs: QUIET, now: () => now });
      return { w, events };
    };

    it('says nothing before any runner has polled, or when the first look finds one already quiet', async () => {
      const t = runner('laptop');
      const { w, events } = watch();
      expect(await w.check()).toBe('none');
      touchToken(db, t.id, now);
      now += 10 * MIN;
      expect(await w.check()).toBe('quiet');
      now += 10 * MIN;
      await w.check();
      expect(events).toEqual([]);
    });

    it('fires once with the label and last-seen of the runner that went quiet last, and again only after one is back', async () => {
      const a = runner('laptop');
      const b = runner('server');
      const { w, events } = watch();
      touchToken(db, a.id, now);
      touchToken(db, b.id, now + MIN);
      now += 2 * MIN;
      expect(await w.check()).toBe('online');
      now += 1.5 * MIN; // laptop is past the window, server is not
      expect(await w.check()).toBe('online');
      expect(events).toEqual([]);
      now += 2 * MIN;
      expect(await w.check()).toBe('offline');
      expect(events).toEqual([['runner.offline', { label: 'server', lastSeen: new Date(T0 + MIN).toISOString() }]]);
      now += 30 * MIN;
      expect(await w.check()).toBe('quiet');
      expect(events).toHaveLength(1);
      touchToken(db, a.id, now);
      expect(await w.check()).toBe('online');
      now += QUIET;
      expect(await w.check()).toBe('offline');
      expect(events).toHaveLength(2);
      expect(events[1][1].label).toBe('laptop');
    });

    it('does not announce the same quiet spell twice when the clock steps back, and says nothing once closed', async () => {
      const a = runner('laptop');
      const { w, events } = watch();
      touchToken(db, a.id, now);
      expect(await w.check()).toBe('online');
      now += 10 * MIN;
      expect(await w.check()).toBe('offline');
      now -= 9 * MIN; // the clock steps back: the same poll looks recent again
      expect(await w.check()).toBe('online');
      now += 10 * MIN;
      expect(await w.check()).toBe('quiet');
      expect(events).toHaveLength(1);
      touchToken(db, a.id, now);
      expect(await w.check()).toBe('online');
      w.close();
      now += 10 * MIN;
      await w.check();
      expect(events).toHaveLength(1);
    });

    it('starts with an unref\'d timer and stops it on close', () => {
      const calls = [];
      const handle = { unref: () => calls.push('unref') };
      const w = createRunnerWatch({ auth: { store: async () => db }, hooks: null, quietMs: QUIET, now: () => now,
        timer: { setInterval: (fn, ms) => { calls.push(['set', ms]); return handle; }, clearInterval: (h) => calls.push(['clear', h === handle]) } });
      w.start();
      w.start();
      w.close();
      w.start();
      expect(calls).toEqual([['set', 30_000], 'unref', ['clear', true]]);
    });

    it('does not fire for a runner whose token was revoked', async () => {
      const a = runner('laptop');
      const { w, events } = watch();
      touchToken(db, a.id, now);
      await w.check();
      revokeToken(db, owner.userId, a.id, now);
      now += 10 * MIN;
      expect(await w.check()).toBe('none');
      expect(events).toEqual([]);
    });
  });
});
