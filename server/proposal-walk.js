/**
 * @module server/proposal-walk
 *
 * Finding the proposal files of the checkout and of its worktrees without ever holding up the server.
 *
 * A worktrees folder can be huge and slow (147 worktrees of 50 proposals each on a Windows drive seen through WSL's 9p:
 * minutes of reads). So the walk is:
 *
 *  - **async**: only `fs.promises` calls, at most `CONCURRENCY` in flight at once across all walks (a slow mount is not hammered with
 *    thousands of opens), and a turn of the event loop given back every `YIELD_EVERY` calls, so `/healthz` and the
 *    other routes are answered meanwhile. No worker thread: nothing in it is CPU-bound, only waiting on the disk;
 *  - **cached by path, mtime and size**: a file whose stamp is unchanged is not read again, so a listing with nothing
 *    changed does a `readdir` per folder and an `lstat` per file, and no `readFile`;
 *  - **without copies**: a worktree starts as a copy of the checkout, so a worktree file whose contents equal the
 *    checkout's file of the same name (line endings ignored) is not a draft and is left out. The comparison is by
 *    SHA-256 of the contents with `\r\n` read as `\n`, and the hashes are cached with the files. The file's size
 *    says first whether it can be equal at all: only then is it hashed;
 *  - **single-flight**: listings asked for while one is under way share it;
 *  - **optionally pruned by age**: with `where.worktreeMaxAgeDays`, a worktree whose newest proposal is older than
 *    that is left out.
 *
 * The cache is bounded (`MAX_ENTRIES` files) and forgets the files that are gone.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** A proposal's file name: letters, digits, `.`, `_`, `-`; never a leading dot or dash. The slug is the name without `.json` */
export const PROPOSAL_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.json$/;

export const CONCURRENCY = 8;
export const YIELD_EVERY = 32;
export const MAX_ENTRIES = 20000;
const MAX_WALKS = 16;
const DAY_MS = 86_400_000;

/** Whether real path `real` is `dir` or under it, by whole segments (`/x/repo-other` is not under `/x/repo`); server/files.js `inside` holds the same rule for files */
const under = (dir, real) => {
  const r = path.relative(dir, real);
  return r === '' || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
};
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const countNewlines = (text) => { let n = 0; for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++; return n; };
const turn = () => new Promise((resolve) => setImmediate(resolve));

/** Runs the calls it is given at most `limit` at a time, and lets the event loop breathe now and then */
function gateOf(limit) {
  let active = 0;
  let calls = 0;
  const waiting = [];
  return async (fn) => {
    if (active < limit) active++;
    else await new Promise((resolve) => waiting.push(resolve)); // the slot is handed over, not freed, so the limit holds
    try {
      return await fn();
    } finally {
      if (++calls % YIELD_EVERY === 0) await turn();
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/** What a file's text is as a proposal: `{ proposal }` or `{ error }` (listed with the error rather than breaking the list) */
function parseProposal(text) {
  try {
    return { proposal: JSON.parse(text) };
  } catch (err) {
    return { error: `Not valid JSON: ${err.message}` };
  }
}

/**
 * Makes a lister, which keeps the cache of what it walked. `fs` is the `fs.promises` surface it needs
 * (`readdir`, `lstat`, `readFile`); tests pass a counting fake.
 * @param {{ fs?: Pick<typeof fsp, 'readdir'|'lstat'|'readFile'>, concurrency?: number, maxEntries?: number, now?: () => number }} [opts]
 */
export function createProposalLister({ fs = fsp, concurrency = CONCURRENCY, maxEntries = MAX_ENTRIES, now = Date.now } = {}) {
  /** One state per place walked: its cache (path -> record) and the walk under way */
  const states = new Map();
  /** One gate for every walk of this lister: two walks at once (a listing, and a lookup of one source) share the limit */
  const io = gateOf(concurrency);

  function stateOf(key) {
    let state = states.get(key);
    if (state) {
      states.delete(key); // most recently used last
    } else {
      state = { cache: new Map(), flights: new Map() };
      if (states.size >= MAX_WALKS) states.delete(states.keys().next().value);
    }
    states.set(key, state);
    return state;
  }

  async function walk(where, state, only) {
    const { cache } = state;
    const seen = new Set();
    const base = path.resolve(where.root);
    // A fake `fs` (a test's) may not have `realpath`: the real one answers then
    const realpath = (p) => (fs.realpath ?? fsp.realpath).call(fs, p);
    let realBase;
    try { realBase = await realpath(base); } catch { return []; }
    const maxAgeMs = where.worktreeMaxAgeDays > 0 ? where.worktreeMaxAgeDays * DAY_MS : null;
    const clock = where.now || now;

    /**
     * The proposal files directly in `dir`, each with its lstat; a folder that is not there has none, nor has one whose real path is not
     * under `within` (a real path: the repo's, or the worktree's). The files are named by the real folder, which is what was checked.
     */
    async function scan(dir, within) {
      let names;
      try {
        const real = await io(() => realpath(dir));
        if (!under(within, real)) return [];
        dir = real;
        names = await io(() => fs.readdir(dir));
      } catch { return []; }
      const wanted = names.filter((name) => PROPOSAL_FILE.test(name) && !name.endsWith('.review.json'));
      const found = await Promise.all(wanted.map(async (name) => {
        const file = path.join(dir, name);
        try {
          const st = await io(() => fs.lstat(file));
          return st.isFile() ? { name, slug: PROPOSAL_FILE.exec(name)[1], file, mtimeMs: st.mtimeMs, size: st.size } : null; // not a directory, nor a link to somewhere else
        } catch { return null; }
      }));
      return found.filter(Boolean);
    }

    /** Whether the cached record still answers for this file against the checkout's copy (`against`: its hash, or null) */
    const usable = (rec, f, against) => !!rec && rec.mtimeMs === f.mtimeMs && rec.size === f.size
      && (rec.hash === null ? rec.against === against : rec.hash === against || rec.parsed !== undefined);

    /**
     * The record of a file: read, hashed and parsed only when the cache cannot answer. `checkout` is the checkout's
     * record of the same name for a worktree file (null when the checkout has none), undefined for the checkout's own file.
     */
    async function recordOf(f, checkout) {
      seen.add(f.file);
      const against = checkout ? checkout.hash : null;
      const hit = cache.get(f.file);
      if (usable(hit, f, against)) return hit;
      let text;
      try {
        text = await io(() => fs.readFile(f.file, 'utf8'));
      } catch (err) {
        return { mtimeMs: f.mtimeMs, size: f.size, hash: null, against, parsed: { error: `Not valid JSON: ${err.message}` } }; // not kept: asked again next time
      }
      const normal = text.replace(/\r\n/g, '\n');
      const bytes = Buffer.byteLength(normal);
      let hash = null;
      // A copy can only be as long as the checkout's file with its line ends read as \r\n or \n
      if (checkout === undefined || (checkout && f.size >= checkout.bytes && f.size <= checkout.bytes + checkout.newlines)) hash = sha256(normal);
      const rec = { mtimeMs: f.mtimeMs, size: f.size, hash, against, bytes, newlines: checkout === undefined ? countNewlines(normal) : 0 };
      if (!checkout || hash !== against) rec.parsed = parseProposal(text);
      cache.delete(f.file);
      cache.set(f.file, rec);
      return rec;
    }

    const out = [];
    const proposals = where.proposals;
    const checkoutFiles = await scan(path.join(base, proposals), realBase);
    const checkoutRecs = new Map();
    await Promise.all(checkoutFiles.map(async (f) => checkoutRecs.set(f.name, await recordOf(f))));
    if (!only || only === 'checkout') for (const f of checkoutFiles) out.push({ slug: f.slug, source: 'checkout', file: f.file, parsed: checkoutRecs.get(f.name).parsed });

    if (where.worktrees && only !== 'checkout') {
      let dir = path.join(base, where.worktrees);
      let entries = [];
      try {
        const real = await io(() => realpath(dir));
        if (under(realBase, real)) { // a worktrees folder that is a link out of the repo holds none
          dir = real;
          entries = await io(() => fs.readdir(dir, { withFileTypes: true }));
        }
      } catch { /* no worktrees here */ }
      // A worktree called "checkout" would be taken for the checkout itself: not listed
      const names = entries.filter((w) => w.isDirectory() && w.name !== 'checkout' && (!only || w.name === only)).map((w) => w.name).sort();
      await Promise.all(names.map(async (name) => {
        const files = await scan(path.join(dir, name, proposals), path.join(dir, name));
        if (maxAgeMs !== null && files.length && clock() - Math.max(...files.map((f) => f.mtimeMs)) > maxAgeMs) return;
        await Promise.all(files.map(async (f) => {
          const rec = await recordOf(f, checkoutRecs.get(f.name) || null);
          const peer = checkoutRecs.get(f.name);
          const copy = !!peer && rec.hash !== null && rec.hash === peer.hash;
          if (!copy) out.push({ slug: f.slug, source: name, file: f.file, parsed: rec.parsed });
        }));
      }));
    }

    // Forget what is gone (only after a whole walk: a walk of one source says nothing of the others), and keep the cache bounded
    if (!only) for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);

    const rank = (e) => (e.source === 'checkout' ? 1 : 0);
    return out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : rank(a) - rank(b) || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)));
  }

  /**
   * Every proposal the server may serve (a review, a link, a directory and a name that is not a plain file name are left
   * out): the checkout's, then each worktree's that differs from the checkout's. When a slug is in several places each
   * is listed, the worktree copies first, as that is where it is being written. `only` limits the walk to one source.
   * @param {{ root: string, proposals: string, worktrees?: string|null, worktreeMaxAgeDays?: number|null, now?: () => number }} where
   * @param {{ only?: string|null }} [opts]
   * @returns {Promise<{ slug: string, source: string, file: string, parsed: { proposal?: unknown, error?: string } }[]>}
   */
  async function list(where, { only = null } = {}) {
    const state = stateOf(JSON.stringify([path.resolve(where.root), where.proposals, where.worktrees || null, where.worktreeMaxAgeDays || null]));
    const flightKey = only || '';
    let flight = state.flights.get(flightKey);
    if (!flight) {
      flight = walk(where, state, only).finally(() => state.flights.delete(flightKey));
      state.flights.set(flightKey, flight);
    }
    return [...(await flight)];
  }

  return { list };
}
