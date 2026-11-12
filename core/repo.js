/**
 * @module core/repo
 *
 * Reading a target repo: the small set of readers every deriver and check is handed, rooted at one
 * folder. Text is read as LF whatever the checkout's line endings, so a pattern never sees a CR.
 * Nothing here writes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { quote } from './text.js';

/** Folders a walk never goes into */
export const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', '.worktrees', 'dist', 'coverage', '.cornfield']);

/** What a reader throws for a path whose real path is outside the repo: it names the path as given, as a JSON string, never where it leads */
export const outsideError = (rel) => Object.assign(new Error(`${quote(String(rel))} is outside the repo.`), { code: 'EOUTSIDE' });

/**
 * The readers for a repo root. Every path is relative to the root with forward slashes.
 * @param {string} root an absolute folder
 */
export function repoReader(root) {
  const abs = (rel) => path.join(root, rel);
  const realpath = fs.realpathSync.native;
  const realRoot = (() => { try { return realpath(root); } catch { return path.resolve(root); } })();
  /** Whether real path `real` is `dir` or under it (by whole segments: `/x/repo-other` is not under `/x/repo`) */
  const under = (dir, real) => { const r = path.relative(dir, real); return r === '' || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)); };
  const within = (real) => under(realRoot, real);
  /**
   * Whether the path `at` (absolute) lies in the repo once every symlink on its way is followed. A path that is not
   * there is judged by the nearest folder on its way that is, with the rest as written (a `..` included): nothing can
   * be read from it.
   */
  const insideAbs = (at) => {
    if (at.includes('\0')) return false;
    let rest = '';
    for (;;) {
      try { return within(path.resolve(realpath(at), rest)); } catch { /* not there, or a link loop: try its folder */ }
      const up = path.dirname(at);
      if (up === at) return false;
      rest = path.join(path.basename(at), rest);
      at = up;
    }
  };
  const inside = (rel) => insideAbs(abs(String(rel)));
  // The readers below are the one place a path is held to the repo: whatever a deriver is told to read, and whatever a
  // symlink points at, a file whose real path is outside is not there (`read` throws, `exists` and `isDir` say no,
  // `list` is empty). A folder's verdict is kept for the reader's life, so a plain file costs one `lstat`, not a
  // `realpath` walk of its whole way; only a symlink is resolved each time. A file `walk` returned was judged by its
  // real path there, and is read without a second look. Both are kept for the reader's life: make a reader per run, not
  // one that outlives changes to the repo's links.
  const folders = new Map();
  const walked = new Set();
  const pending = []; // what `walk` returned since a read last looked: only a reader of those files pays to list them
  const folderInside = (dir) => {
    let v = folders.get(dir);
    if (v === undefined) { v = insideAbs(dir); folders.set(dir, v); }
    return v;
  };
  // A trailing separator would make `lstat` follow a link it names (`ext/` for `ext`), so a path is looked at without one
  const bare = (p) => { let q = p; while (q.length > 1 && (q.endsWith('/') || q.endsWith(path.sep))) q = q.slice(0, -1); return q; };
  const rootAt = bare(path.join(root));
  /** `null` when there is nothing at `rel`; else whether it is a symlink, whether it lies in the repo, and (not a link) what it is */
  const look = (rel) => {
    const at = bare(abs(rel));
    let st;
    try { st = fs.lstatSync(at); } catch { return null; }
    if (st.isSymbolicLink()) return { link: true, ok: insideAbs(at), st };
    return { link: false, ok: at === rootAt || folderInside(path.dirname(at)), st };
  };
  const read = (rel) => {
    while (pending.length) for (const f of pending.pop()) walked.add(f);
    if (!walked.has(rel)) {
      const m = look(rel);
      if (m && !m.ok) throw outsideError(rel);
    }
    return fs.readFileSync(abs(rel), 'utf8').replace(/\r\n/g, '\n');
  };
  const exists = (rel) => { const m = look(rel); return !!m && m.ok && (!m.link || fs.existsSync(abs(rel))); };
  const rawIsDir = (rel) => {
    try { return fs.statSync(abs(rel)).isDirectory(); } catch { return false; }
  };
  const isDir = (rel) => { const m = look(rel); return !!m && m.ok && (m.link ? rawIsDir(rel) : m.st.isDirectory()); };
  const list = (rel) => (isDir(rel) ? fs.readdirSync(abs(rel)).sort() : []);
  /**
   * Every file under `rel` that `test` accepts, sorted by folder, skipping SKIP_DIRS. A symlink is followed only while
   * it stays in the repo, and a real folder is walked once: a link to a folder under `rel` is left to the real folder,
   * and of two links to one other folder the first wins. `onSkip(path, reason)` hears of each link left out: 'outside'
   * (out of the repo, to a folder or to a file `test` accepts), 'walked' (to a folder already walked) or 'missing' (to
   * nothing, or a loop of links, named like a file `test` accepts). Walks that share `seen` (a set of real folders) read
   * each folder once between them, a folder two of them name in the repo's own words in silence. `skipDir(name)` leaves
   * out, beside SKIP_DIRS, each folder (or link to one) it accepts. Only links pay a `realpath`.
   */
  const walk = (rel, test = () => true, onSkip = () => {}, seen = new Set(), skipDir = null) => {
    const start = rel && rel !== '.' ? rel : '';
    let startReal;
    try { startReal = realpath(abs(start)); } catch { return []; }
    if (!within(startReal)) { onSkip(start, 'outside'); return []; }
    const linked = startReal !== path.join(realRoot, start);
    if (seen.has(startReal)) { if (linked) onSkip(start, 'walked'); return []; }
    // `viaLink`: `dir` is reached through a link, so a real folder in it may be one walked by its own name
    const go = (dir, real, viaLink) => {
      seen.add(real);
      let entries;
      try { entries = fs.readdirSync(abs(dir), { withFileTypes: true }); } catch { return []; }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return entries.flatMap((e) => {
        if (SKIP_DIRS.has(e.name)) return [];
        const child = dir ? `${dir}/${e.name}` : e.name;
        if (!e.isSymbolicLink()) {
          if (!e.isDirectory()) return test(child) ? [child] : [];
          if (skipDir && skipDir(e.name)) return [];
          const childReal = path.join(real, e.name);
          if (seen.has(childReal)) { if (viaLink) onSkip(child, 'walked'); return []; }
          return go(child, childReal, viaLink);
        }
        let target;
        try { target = realpath(abs(child)); } catch { if (test(child)) onSkip(child, 'missing'); return []; }
        const folder = rawIsDir(child);
        if (folder && skipDir && skipDir(e.name)) return [];
        if (!within(target)) { if (folder || test(child)) onSkip(child, 'outside'); return []; }
        if (!folder) return test(child) ? [child] : [];
        const ownRoute = under(startReal, target) && !path.relative(startReal, target).split(path.sep).some((s) => SKIP_DIRS.has(s) || (skipDir && skipDir(s)));
        if (ownRoute || seen.has(target)) { onSkip(child, 'walked'); return []; }
        return go(child, target, true);
      });
    };
    const found = go(start, startReal, linked);
    pending.push(found.slice()); // a copy: what a caller adds to the list it gets back is not taken for a walked file
    return found;
  };
  return { root, read, exists, isDir, list, walk, inside };
}

/**
 * Whether a path a config names (a file or folder option of a deriver) leaves the repo: it is absolute, climbs out
 * with `..`, or a symlink on its way leads out. `io` is a repo reader (`inside`).
 * @param {{ inside: (rel: string) => boolean }} io
 * @param {unknown} p
 */
export function leavesRepo(io, p) {
  if (typeof p !== 'string') return false;
  const rel = path.posix.normalize(p.replace(/^\.\/+/, '').replace(/\/+$/, '') || '.');
  return path.isAbsolute(p) || path.win32.isAbsolute(p) || rel === '..' || rel.startsWith('../') || !io.inside(rel);
}

/**
 * The problem `validate` fails on for a config path that leaves the repo, naming the path as written (a JSON string, so
 * nothing in it can break the line) and never where it leads.
 * @param {string} who the deriver's name
 * @param {unknown} p
 */
export const outsideProblem = (who, p) => `${who}: ${quote(p)} is outside the repo; only files and folders of the repo are read.`;

/**
 * The problem `validate` fails on for a config value that names a folder where a file is wanted (`''`, `.` and `src/` are folders).
 * @param {string} who the deriver's name
 * @param {string} option the option, as the config spells it (`caddyfiles`, `specs[].file`)
 * @param {unknown} p
 */
export const notFileProblem = (who, option, p) => `${who}: options.${option} ${quote(p)} is a folder, not a file.`;

/**
 * What is wrong with a config value that must name a file of the repo, or null: it leaves the repo (`outsideProblem`), or is a folder
 * (`notFileProblem`). A file that is not there is the deriver's own word. `io` is a repo reader.
 * @param {{ inside: (rel: string) => boolean, isDir: (rel: string) => boolean }} io
 * @param {string} who
 * @param {string} option
 * @param {unknown} p
 * @returns {string | null}
 */
export function fileOptionProblem(io, who, option, p) {
  if (leavesRepo(io, p)) return outsideProblem(who, p);
  if (typeof p === 'string' && io.isDir(p)) return notFileProblem(who, option, p);
  return null;
}

/**
 * A list of paths a config names, each place once: `a`, `./a`, `a/`, `a/.` and `a/../a` are one place, and so are `` and `.` (the
 * repo itself). The first spelling stays; a later one is dropped, as the deriver would read the same place twice. `key` picks the path of an entry.
 * @template T
 * @param {T[]} list
 * @param {(entry: T) => unknown} [key]
 * @returns {T[]}
 */
export function eachPlaceOnce(list, key = (e) => e) {
  const seen = new Set();
  return list.filter((e) => {
    const p = key(e);
    if (typeof p !== 'string') return true;
    const at = path.posix.normalize(p.replace(/^\.\/+/, '') || '.').replace(/\/+$/, '');
    const k = at === '.' ? '' : at;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * For `missingPaths`: whether a path `repoPaths` does not list is in the repo all the same, because a symlink on its way
 * stays in the repo (`repoPaths` does not follow links; the walk does, and makes nodes at such paths). The path must be
 * written plainly (relative, no empty, `.` or `..` segment, no folder the walks skip), a symlink must be on its way (so a
 * repo without one is checked exactly as `repoPaths` says), and `exists` holds it to its real path.
 * @param {{ root: string, exists: (rel: string) => boolean }} io a repo reader
 * @returns {(p: string) => boolean}
 */
export const reachable = (io) => (p) => {
  if (typeof p !== 'string' || p === '' || p.includes('\0') || path.posix.isAbsolute(p) || path.win32.isAbsolute(p)) return false;
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || SKIP_DIRS.has(s))) return false;
  if (!io.exists(p)) return false; // first, so a path that is not there costs one look
  for (let i = 1; i <= segments.length; i++) {
    try { if (fs.lstatSync(path.join(io.root, ...segments.slice(0, i))).isSymbolicLink()) return true; } catch { return false; }
  }
  return false;
};

/**
 * Every file and folder path under the root (relative, forward slashes), for checking the paths a map cites.
 * @param {string} root
 * @returns {Set<string>}
 */
export function repoPaths(root) {
  const out = new Set();
  const visit = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.add(r);
      if (e.isDirectory()) visit(path.join(dir, e.name), r);
    }
  };
  visit(root, '');
  return out;
}
