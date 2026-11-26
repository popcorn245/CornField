/**
 * @module core/history
 *
 * The map's own history (spec 0014 D4): which commits changed each node, when each node was born, and, for each commit,
 * the trail it names from spec to issue to pull request. Read from `git log` when the config says `history: true`.
 *
 * Two halves:
 *  - pure: `parseLog` reads the fixed format `readLog` asks git for, `traceOf` reads a commit's trail from its message
 *    and files, and `historyOf` ties the commits to a map's nodes. No I/O; tested in Node.
 *  - `readLog` and `createHistory`: run git, read-only, and keep the answer per HEAD.
 *
 * Running git is the one program cornfield runs, so it is held tight (spec 0014, question 1):
 *  - a fixed list of arguments, `execFile` with no shell, the repo's path as `-C`, nothing from a request in it;
 *  - nothing from the repo's own config may run a program: no pager, external diff, text conversion, signature check
 *    or fsmonitor, and no terminal prompt;
 *  - a time and size ceiling, and at most MAX_COMMITS commits.
 */

import { execFile } from 'node:child_process';

/** The most commits read, newest first: a long history is cut at its newest MAX_COMMITS */
export const MAX_COMMITS = 5000;
/** How long `git log` may take, and how much it may say, before it is given up on */
export const GIT_TIMEOUT_MS = 15_000;
export const GIT_MAX_BYTES = 64 * 1024 * 1024;

const RS = '\x1e';
const US = '\x1f';
/** The format each commit is written in: record separator, hash, author date (ISO), subject, body, then its files */
export const LOG_FORMAT = `${RS}%H${US}%aI${US}%s${US}%b${US}`;

/**
 * The arguments `readLog` runs git with: settings that keep the repo's own config from running anything, then the log
 * of the checked-out branch, first parent only (a merged branch's own commits are its pull request's), with renames.
 * @param {string} root the repo's folder
 */
export function gitArgs(root) {
  return [
    '-C', root,
    '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'diff.external=',
    '--no-pager', 'log', '--first-parent', `--max-count=${MAX_COMMITS}`, `--format=${LOG_FORMAT}`,
    '--name-status', '-M', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--',
  ];
}

/** The environment git runs in: no prompt, no system config, the user's own config kept (it is theirs, not the repo's) */
export const gitEnv = (env = process.env) => ({ ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_PAGER: 'cat', GIT_EXTERNAL_DIFF: '', LC_ALL: 'C' });

/**
 * @typedef {object} RawCommit
 * @property {string} sha
 * @property {string} date  the author date, ISO 8601
 * @property {string} subject
 * @property {string} body
 * @property {{ status: string, path: string, from?: string }[]} files  A, M, D, R (with `from`), C, T
 */

/**
 * The commits in `readLog`'s output, oldest first. A malformed record is left out.
 * @param {string} text
 * @returns {RawCommit[]}
 */
export function parseLog(text) {
  const out = [];
  for (const rec of String(text).split(RS).slice(1)) {
    const parts = rec.split(US);
    if (parts.length < 5) continue;
    const [sha, date, subject, body] = parts;
    if (!/^[0-9a-f]{40}$/.test(sha) || Number.isNaN(Date.parse(date))) continue;
    const files = [];
    for (const line of parts.slice(4).join(US).split('\n')) {
      const cols = line.split('\t');
      if (cols.length < 2 || !/^[AMDRCT]\d*$/.test(cols[0])) continue;
      const status = cols[0][0];
      if ((status === 'R' || status === 'C') && cols.length >= 3) files.push({ status, from: cols[1], path: cols[2] });
      else files.push({ status, path: cols[1] });
    }
    out.push({ sha, date, subject: subject.trim(), body: body.trim(), files });
  }
  return out.reverse();
}

/** The words that say a commit closes an issue (GitHub's and Forgejo's) */
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
const KEY = /\[([A-Z][A-Z0-9]*-\d+)\]/g;
const SPEC_WORD = /\bspecs?\s+(\d{4})\b/gi;
const SPEC_FILE = /^docs\/specs\/(\d{4})-[^/]+\.md$/;

/**
 * The trail a commit names (spec 0014 D2, question 3): its pull request (the last `(#N)` in its subject, as a squash
 * merge writes it), its issues (an earlier `(#N)`, a `Closes #N`), the issue keys it carries (`[CF-45]`), and its specs
 * (`spec 0012` in its message, or a spec file it changed). What it does not name is not guessed.
 * @param {{ subject: string, body?: string, files?: { path: string }[] }} commit
 * @returns {{ pr: number | null, issues: number[], keys: string[], specs: string[] }}
 */
export function traceOf({ subject, body = '', files = [] }) {
  const refs = [...String(subject).matchAll(/\(#(\d+)\)/g)].map((m) => Number(m[1]));
  const pr = refs.length ? refs[refs.length - 1] : null;
  const issues = [];
  const add = (n) => { if (n !== pr && !issues.includes(n)) issues.push(n); };
  refs.slice(0, -1).forEach(add);
  for (const m of `${subject}\n${body}`.matchAll(CLOSES)) add(Number(m[1]));
  const keys = [...new Set([...`${subject}\n${body}`.matchAll(KEY)].map((m) => m[1]))];
  const specs = [];
  for (const m of `${subject}\n${body}`.matchAll(SPEC_WORD)) if (!specs.includes(m[1])) specs.push(m[1]);
  for (const f of files) { const m = SPEC_FILE.exec(f.path); if (m && !specs.includes(m[1])) specs.push(m[1]); }
  return { pr, issues, keys, specs };
}

/** A commit's subject without the `(#N)` its pull request left on it */
export const cleanSubject = (subject) => String(subject).replace(/\s*\(#\d+\)/g, '').trim();

/**
 * @typedef {object} History
 * @property {{ sha: string, date: string, subject: string, pr: number | null, issues: number[], keys: string[], specs: string[], files: number, nodes: string[] }[]} commits  oldest first
 * @property {Record<string, { born: number, commits: number[] }>} nodes  by node id: the index of the commit it was born in, and of every commit that changed it
 * @property {boolean} cut  whether the history was cut at MAX_COMMITS
 */

/**
 * Ties commits to a map's nodes. A node owns its `file`, and everything under it when that is a folder. Renames are
 * followed back (question 4): a file renamed into a node's path brings its older history with it. A node is born at the
 * first commit that changed what it owns; one that nothing in the history touches is born with the first commit.
 * A child is never born before its parent: its parent is born with it.
 * @param {RawCommit[]} raw oldest first (parseLog)
 * @param {{ nodes: { id: string, file?: string }[], edges?: { from: string, to: string, dashed?: boolean, kind?: string }[] }} topology
 * @param {{ cut?: boolean }} [opts]
 * @returns {History}
 */
export function historyOf(raw, topology, { cut = false } = {}) {
  const nodes = (topology && Array.isArray(topology.nodes) ? topology.nodes : []).filter((n) => n && typeof n.id === 'string');
  // Each node's paths, newest name first; walked newest to oldest so a rename adds the older name before it is met
  const owns = new Map(nodes.filter((n) => typeof n.file === 'string' && n.file.trim()).map((n) => [n.id, new Set([n.file.replace(/\/+$/, '')])]));
  const covers = (p, f) => f === p || f.startsWith(`${p}/`);
  const touched = raw.map(() => new Set());
  for (let i = raw.length - 1; i >= 0; i--) {
    for (const f of raw[i].files) {
      for (const [id, paths] of owns) {
        for (const p of [...paths]) {
          if (!covers(p, f.path)) continue;
          if (f.status !== 'D') touched[i].add(id);
          // The node's own file came from another name: follow it back. A rename inside a folder node needs nothing, the folder covers both
          if (f.status === 'R' && f.from && f.path === p) paths.add(f.from);
        }
      }
    }
  }
  const out = {};
  nodes.forEach((n) => { out[n.id] = { born: 0, commits: [] }; });
  touched.forEach((ids, i) => ids.forEach((id) => out[id].commits.push(i)));
  for (const n of nodes) out[n.id].born = out[n.id].commits.length ? out[n.id].commits[0] : 0;
  // Parents first: ownership edges (no kind, not dashed), a parent born no later than its child
  const parent = new Map();
  for (const e of topology?.edges || []) if (e && !e.dashed && !e.kind && out[e.from] && out[e.to] && !parent.has(e.to) && e.from !== e.to) parent.set(e.to, e.from);
  for (const n of nodes) {
    const seen = new Set([n.id]);
    for (let c = n.id, p = parent.get(c); p && !seen.has(p); c = p, p = parent.get(p)) {
      seen.add(p);
      if (out[p].born > out[c].born) out[p].born = out[c].born;
    }
  }
  const commits = raw.map((c, i) => ({ sha: c.sha, date: c.date, subject: cleanSubject(c.subject), ...traceOf(c), files: c.files.length, nodes: [...touched[i]].sort() }));
  return { commits, nodes: out, cut };
}

/**
 * Runs git and reads the log of the checked-out branch. Rejects with a plain message when git is not there, the folder
 * is not a repo, or git gives up.
 * @param {string} root
 * @param {{ env?: NodeJS.ProcessEnv, run?: typeof execFile }} [opts] `run` is the tests' fake
 * @returns {Promise<{ raw: RawCommit[], cut: boolean }>}
 */
export function readLog(root, { env = process.env, run = execFile } = {}) {
  return new Promise((resolve, reject) => {
    run('git', gitArgs(root), { env: gitEnv(env), timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BYTES, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        const why = err.code === 'ENOENT' ? 'git is not installed where cornfield runs' : err.killed ? `git log took longer than ${GIT_TIMEOUT_MS / 1000}s` : 'the repo has no history git can read (is it a git checkout with a commit?)';
        return reject(Object.assign(new Error(`The history could not be read: ${why}.`), { code: 'ENOHISTORY' }));
      }
      const raw = parseLog(stdout);
      resolve({ raw, cut: raw.length >= MAX_COMMITS });
    });
  });
}

/** The commit HEAD points at, by asking git with the same guards; null when there is none */
export function readHead(root, { env = process.env, run = execFile } = {}) {
  return new Promise((resolve) => {
    run('git', ['-C', root, '-c', 'core.fsmonitor=false', 'rev-parse', '--verify', '--quiet', 'HEAD'], { env: gitEnv(env), timeout: GIT_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      const sha = String(stdout || '').trim();
      resolve(!err && /^[0-9a-f]{40}$/.test(sha) ? sha : null);
    });
  });
}

/**
 * The history of one repo, kept per HEAD and map: read again only when either changes. One read at a time; callers
 * that ask while it runs share it.
 * @param {string} root
 * @param {{ env?: NodeJS.ProcessEnv, run?: typeof execFile }} [opts]
 * @returns {{ get(topology: object, topologyKey: string): Promise<History & { head: string }> }}
 */
export function createHistory(root, opts = {}) {
  let kept = null; // { key, value }
  let pending = null; // { key, promise }
  return {
    async get(topology, topologyKey) {
      const head = await readHead(root, opts);
      if (!head) throw Object.assign(new Error('The history could not be read: the repo has no commit yet, or is not a git checkout.'), { code: 'ENOHISTORY' });
      const key = `${head}|${topologyKey}`;
      if (kept && kept.key === key) return kept.value;
      if (pending && pending.key === key) return pending.promise;
      const promise = readLog(root, opts).then(({ raw, cut }) => {
        const value = { head, ...historyOf(raw, topology, { cut }) };
        kept = { key, value };
        return value;
      }).finally(() => { if (pending && pending.key === key) pending = null; });
      pending = { key, promise };
      return promise;
    },
  };
}
