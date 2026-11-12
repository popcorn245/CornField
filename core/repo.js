/**
 * @module core/repo
 *
 * Reading a target repo: the small set of readers every deriver and check is handed, rooted at one
 * folder. Text is read as LF whatever the checkout's line endings, so a pattern never sees a CR.
 * Nothing here writes.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Folders a walk never goes into */
export const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', '.worktrees', 'dist', 'coverage', '.cornfield']);

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
  // real path there, and is read without a second look.
  const folders = new Map();
  const walked = new Set();
  const pending = []; // what `walk` returned since a read last looked: only a reader of those files pays to list them
  const folderInside = (dir) => {
    let v = folders.get(dir);
    if (v === undefined) { v = insideAbs(dir); folders.set(dir, v); }
    return v;
  };
  /** `null` when there is nothing at `rel`; else whether it is a symlink, whether it lies in the repo, and (not a link) what it is */
  const look = (rel) => {
    const at = abs(rel);
    let st;
    try { st = fs.lstatSync(at); } catch { return null; }
    if (st.isSymbolicLink()) return { link: true, ok: insideAbs(at), st };
    return { link: false, ok: at === path.join(root) || folderInside(path.dirname(at)), st };
  };
  const outside = (rel) => Object.assign(new Error(`${JSON.stringify(String(rel))} is outside the repo.`), { code: 'EOUTSIDE' });
  const read = (rel) => {
    while (pending.length) for (const f of pending.pop()) walked.add(f);
    if (!walked.has(rel)) {
      const m = look(rel);
      if (m && !m.ok) throw outside(rel);
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
    pending.push(found);
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
export const outsideProblem = (who, p) => `${who}: ${JSON.stringify(p)} is outside the repo; only files and folders of the repo are read.`;

/**
 * For `missingPaths`: whether a path `repoPaths` does not list is in the repo all the same, because a symlink on its way
 * stays in the repo (`repoPaths` does not follow links; the walk does, and makes nodes at such paths). The path must be
 * written plainly (relative, no `..`, no folder the walks skip), and `exists` holds it to its real path.
 * @param {{ exists: (rel: string) => boolean }} io
 * @returns {(p: string) => boolean}
 */
export const reachable = (io) => (p) => typeof p === 'string' && p !== '' && !path.posix.isAbsolute(p) && path.posix.normalize(p) === p
  && !p.split('/').some((s) => s === '..' || SKIP_DIRS.has(s)) && io.exists(p);

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
