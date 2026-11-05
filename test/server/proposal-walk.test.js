/**
 * @vitest-environment node
 *
 * Listing the proposals of a big, slow worktrees folder (CF-21): the walk is async and bounded, leaves out the
 * worktree files that are copies of the checkout's, caches by path and mtime, shares one walk between listings, and
 * can leave out worktrees untouched for a while. A counting fs fake says what was read, and how often.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { createProposalLister } from '../../server/proposal-walk.js';
// @ts-expect-error plain JS module, no declarations
import { listProposalFiles } from '../../server/files.js';
// @ts-expect-error plain JS module, no declarations
import { serveProposals } from '../../server/proposals.js';
import { whereOf } from './where.js';

/** The real fs.promises, counting each call and (with `delay`) taking its time over it, like a 9p mount */
function slowFs(delay = 0) {
  const calls = { readdir: 0, lstat: 0, readFile: 0, read: [] };
  const wait = () => (delay ? new Promise((resolve) => setTimeout(resolve, delay)) : Promise.resolve());
  return {
    calls,
    readdir: async (...a) => { calls.readdir++; await wait(); return fsp.readdir(...a); },
    lstat: async (...a) => { calls.lstat++; await wait(); return fsp.lstat(...a); },
    readFile: async (...a) => { calls.readFile++; calls.read.push(a[0]); await wait(); return fsp.readFile(...a); },
  };
}

const doc = (n, extra = {}) => `${JSON.stringify({ version: 1, title: `Proposal ${n}`, summary: 's', ...extra }, null, 2)}\n`;

describe('listing the proposals of the worktrees', () => {
  let root;
  let dirOf;
  const put = (where, name, text) => {
    const dir = path.join(root, where, 'docs/specs/proposals');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
    return path.join(dir, name);
  };
  const names = (list) => list.map((e) => `${e.slug}@${e.source}`);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-walk-'));
    dirOf = (w) => path.join(root, '.claude/worktrees', w);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  /** 5 checkout proposals, `count` worktrees holding copies of all of them */
  function seed(count, proposals = 5) {
    for (let n = 1; n <= proposals; n++) put('', `00${n}-p.json`, doc(n));
    for (let w = 0; w < count; w++) for (let n = 1; n <= proposals; n++) put(`.claude/worktrees/w${w}`, `00${n}-p.json`, doc(n));
  }
  const lister = (fake, opts = {}) => createProposalLister({ fs: fake, ...opts });

  it('lists only the worktree files that differ from the checkout, line endings ignored', async () => {
    seed(3);
    put('.claude/worktrees/w1', '001-p.json', doc(1).replace(/\n/g, '\r\n')); // the same, with Windows line ends
    put('.claude/worktrees/w1', '002-p.json', doc(2, { title: 'Changed' }));
    put('.claude/worktrees/w2', '009-new.json', doc(9));
    const list = await lister(slowFs()).list(whereOf(root));
    expect(names(list).filter((n) => !n.endsWith('@checkout'))).toEqual(['002-p@w1', '009-new@w2']);
    expect(names(list).filter((n) => n.endsWith('@checkout'))).toHaveLength(5);
    expect(list.find((e) => e.slug === '002-p' && e.source === 'w1').parsed.proposal.title).toBe('Changed');
    expect(list.find((e) => e.slug === '009-new').parsed.proposal.title).toBe('Proposal 9');
  });

  it('lists a copy with a different size that is not a mere line-ending change, and an unparsable file with its error', async () => {
    seed(1, 2);
    put('.claude/worktrees/w0', '001-p.json', doc(1) + doc(1)); // longer than the checkout's, even with CRLF
    put('.claude/worktrees/w0', '002-p.json', '{ not json');
    const list = await lister(slowFs()).list(whereOf(root));
    expect(names(list).filter((n) => !n.endsWith('@checkout'))).toEqual(['001-p@w0', '002-p@w0']);
    expect(list.find((e) => e.slug === '002-p' && e.source === 'w0').parsed.error).toMatch(/Not valid JSON/);
  });

  it('a second listing with nothing changed reads no file, only the folders and the stamps', async () => {
    seed(6);
    put('.claude/worktrees/w3', '002-p.json', doc(2, { title: 'Changed' }));
    const fake = slowFs();
    const l = lister(fake);
    const first = await l.list(whereOf(root));
    const readsFirst = fake.calls.readFile;
    expect(readsFirst).toBeGreaterThanOrEqual(35); // the checkout's 5 and every worktree file, once
    Object.assign(fake.calls, { readdir: 0, lstat: 0, readFile: 0, read: [] });
    const second = await l.list(whereOf(root));
    expect(fake.calls.readFile).toBe(0);
    expect(fake.calls.readdir).toBe(1 + 1 + 6); // the worktrees folder, the checkout's, each worktree's
    expect(fake.calls.lstat).toBe(5 + 6 * 5);
    expect(names(second)).toEqual(names(first));
  });

  it('a changed mtime reads only that file again, and the checkout changing brings a copy back', async () => {
    seed(4);
    const fake = slowFs();
    const l = lister(fake);
    await l.list(whereOf(root));
    fake.calls.readFile = 0; fake.calls.read = [];
    const touched = path.join(dirOf('w2'), 'docs/specs/proposals/003-p.json');
    fs.writeFileSync(touched, doc(3, { title: 'Edited' }));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(touched, later, later);
    const list = await l.list(whereOf(root));
    expect(fake.calls.read).toEqual([touched]);
    expect(names(list).filter((n) => !n.endsWith('@checkout'))).toEqual(['003-p@w2']);

    // the checkout's file is edited: the four copies that were equal to it are drafts now, and the edited worktree file is equal
    fake.calls.readFile = 0; fake.calls.read = [];
    const checkoutFile = path.join(root, 'docs/specs/proposals/003-p.json');
    fs.writeFileSync(checkoutFile, doc(3, { title: 'Edited' }));
    fs.utimesSync(checkoutFile, later, later);
    const after = await l.list(whereOf(root));
    expect(names(after).filter((n) => !n.endsWith('@checkout'))).toEqual(['003-p@w0', '003-p@w1', '003-p@w3']);
    expect(fake.calls.readFile).toBe(1 + 3 + 1); // the checkout's file, the three that need parsing now, and the edited one (to see it is equal now)
  });

  it('forgets the files that are gone', async () => {
    seed(2, 2);
    const fake = slowFs();
    const l = lister(fake);
    await l.list(whereOf(root));
    fs.rmSync(dirOf('w1'), { recursive: true });
    expect(names(await l.list(whereOf(root))).some((n) => n.endsWith('@w1'))).toBe(false);
    fs.mkdirSync(path.join(dirOf('w1'), 'docs/specs/proposals'), { recursive: true });
    fs.writeFileSync(path.join(dirOf('w1'), 'docs/specs/proposals/001-p.json'), doc(1));
    fake.calls.readFile = 0;
    await l.list(whereOf(root)); // back with the same stamp or not, it was dropped from the cache: read again
    expect(fake.calls.readFile).toBe(1);
  });

  it('keeps the cache bounded', async () => {
    seed(3, 3);
    const fake = slowFs();
    const l = lister(fake, { maxEntries: 4 });
    await l.list(whereOf(root));
    fake.calls.readFile = 0;
    await l.list(whereOf(root));
    expect(fake.calls.readFile).toBeGreaterThan(0); // more files than it keeps: some are read again
    expect(fake.calls.readFile).toBeLessThanOrEqual(12 - 4);
  });

  it('shares one walk between listings asked for together', async () => {
    seed(5);
    const alone = slowFs(2);
    await lister(alone).list(whereOf(root));
    const fake = slowFs(2);
    const l = lister(fake);
    const [a, b, c] = await Promise.all([l.list(whereOf(root)), l.list(whereOf(root)), l.list(whereOf(root))]);
    expect({ ...fake.calls, read: [...fake.calls.read].sort() }).toEqual({ ...alone.calls, read: [...alone.calls.read].sort() });
    expect(names(b)).toEqual(names(a));
    expect(names(c)).toEqual(names(a));
    expect(a).not.toBe(b); // each caller has a list of its own
  });

  it('keeps no more than 8 calls in flight', async () => {
    seed(10);
    let active = 0;
    let peak = 0;
    const track = (fn) => async (...a) => { active++; peak = Math.max(peak, active); try { await new Promise((r) => setTimeout(r, 2)); return await fn(...a); } finally { active--; } };
    await lister({ readdir: track(fsp.readdir), lstat: track(fsp.lstat), readFile: track(fsp.readFile) }).list(whereOf(root));
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });

  it('keeps no more than 8 calls in flight across walks running at once', async () => {
    seed(10);
    let active = 0;
    let peak = 0;
    const track = (fn) => async (...a) => { active++; peak = Math.max(peak, active); try { await new Promise((r) => setTimeout(r, 2)); return await fn(...a); } finally { active--; } };
    const l = lister({ readdir: track(fsp.readdir), lstat: track(fsp.lstat), readFile: track(fsp.readFile) });
    await Promise.all([l.list(whereOf(root)), l.list(whereOf(root), { only: 'w3' }), l.list(whereOf(root), { only: 'checkout' })]);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it('hands a failed walk to every listing that joined it, and the next listing walks afresh', async () => {
    seed(2, 2);
    const fake = slowFs(2);
    let broken = true;
    const readdir = fake.readdir;
    fake.readdir = async (...a) => (broken && a[1]?.withFileTypes ? null : readdir(...a)); // the worktrees folder answers nonsense once
    const l = lister(fake);
    const results = await Promise.allSettled([l.list(whereOf(root)), l.list(whereOf(root)), l.list(whereOf(root))]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(results[1].reason).toBe(results[0].reason);
    broken = false;
    const list = await l.list(whereOf(root));
    expect(names(list)).toEqual(['001-p@checkout', '002-p@checkout']); // the worktree copies are compared, not taken from a half-done walk
    expect(fake.calls.readFile).toBe(2 + 4); // the checkout's 2 were cached by the failed walk; each worktree file is read once now
  });

  it('leaves out a worktree whose newest proposal is older than maxAgeDays', async () => {
    seed(3, 2);
    put('.claude/worktrees/w0', '009-old.json', doc(9));
    put('.claude/worktrees/w1', '008-new.json', doc(8));
    const old = new Date(Date.now() - 40 * 86_400_000);
    for (const f of fs.readdirSync(path.join(dirOf('w0'), 'docs/specs/proposals'))) fs.utimesSync(path.join(dirOf('w0'), 'docs/specs/proposals', f), old, old);
    const withAge = { ...whereOf(root), worktreeMaxAgeDays: 30 };
    expect(names(await lister(slowFs()).list(withAge)).filter((n) => !n.endsWith('@checkout'))).toEqual(['008-new@w1']);
    // one fresh file keeps the worktree in, and without the limit all are listed
    expect(names(await lister(slowFs()).list(whereOf(root))).filter((n) => !n.endsWith('@checkout'))).toEqual(['008-new@w1', '009-old@w0']);
    const fresh = path.join(dirOf('w0'), 'docs/specs/proposals/001-p.json');
    fs.utimesSync(fresh, new Date(), new Date());
    expect(names(await lister(slowFs()).list(withAge)).filter((n) => !n.endsWith('@checkout'))).toEqual(['008-new@w1', '009-old@w0']);
  });

  it('walks one source only when asked for one', async () => {
    seed(6);
    put('.claude/worktrees/w4', '007-x.json', doc(7));
    const fake = slowFs();
    const list = await lister(fake).list(whereOf(root), { only: 'w4' });
    expect(names(list)).toEqual(['007-x@w4']);
    expect(fake.calls.readdir).toBe(3); // the checkout's folder (to compare with), the worktrees folder, w4's
  });

  it('answers /healthz within a second while a slow listing is under way', async () => {
    seed(30, 20); // 30 worktrees of 20 identical proposals, every call taking 10 ms: a few seconds of walking at 8 at a time
    const where = { ...whereOf(root), fs: slowFs(10) };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') { res.writeHead(200); return res.end('{"ok":true}'); }
      if (!serveProposals(req, res, url.pathname, url, where)) { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const get = (target) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: target, agent: false }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
    try {
      let listed = false;
      const listing = get('/proposals').then((r) => { listed = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const t0 = Date.now();
      const health = await get('/healthz');
      const took = Date.now() - t0;
      expect(health.status).toBe(200);
      expect(took).toBeLessThan(1000);
      expect(listed, 'the listing was still under way').toBe(false);
      const done = await listing;
      expect(done.status).toBe(200);
      expect(JSON.parse(done.body)).toHaveLength(20); // only the checkout's: every worktree file is a copy
      // and the real listing function takes the same fake
      expect(await listProposalFiles(where)).toHaveLength(20);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  }, 30_000);
});
