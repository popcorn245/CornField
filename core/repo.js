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
  const read = (rel) => fs.readFileSync(abs(rel), 'utf8').replace(/\r\n/g, '\n');
  const exists = (rel) => fs.existsSync(abs(rel));
  const isDir = (rel) => {
    try { return fs.statSync(abs(rel)).isDirectory(); } catch { return false; }
  };
  const list = (rel) => (isDir(rel) ? fs.readdirSync(abs(rel)).sort() : []);
  const realRoot = (() => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } })();
  /** Whether real path `real` is `dir` or under it (by whole segments: `/x/repo-other` is not under `/x/repo`) */
  const under = (dir, real) => { const r = path.relative(dir, real); return r === '' || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)); };
  const within = (real) => under(realRoot, real);
  /**
   * Whether `rel` lies in the repo once every symlink on its way is followed. A path that is not there is judged by
   * the nearest folder on its way that is, with the rest as written (a `..` included): nothing can be read from it.
   */
  const inside = (rel) => {
    if (String(rel).includes('\0')) return false;
    let at = abs(rel);
    let rest = '';
    for (;;) {
      try { return within(path.resolve(fs.realpathSync(at), rest)); } catch { /* not there, or a link loop: try its folder */ }
      const up = path.dirname(at);
      if (up === at) return false;
      rest = path.join(path.basename(at), rest);
      at = up;
    }
  };
  /**
   * Every file under `rel` that `test` accepts, sorted by folder, skipping SKIP_DIRS. A symlink is followed only while
   * it stays in the repo, and a real folder is walked once: a link to a folder under `rel` is left to the real folder,
   * and of two links to one other folder the first wins. `onSkip(path, reason)` hears of each link left out: 'outside'
   * (out of the repo, to a folder or to a file `test` accepts), 'walked' (to a folder already walked) or 'missing' (to
   * nothing, or a loop of links, named like a file `test` accepts). Walks that share `seen` (a set of real folders) read
   * each folder once between them, a folder two of them name in the repo's own words in silence. Only links pay a
   * `realpath`.
   */
  const walk = (rel, test = () => true, onSkip = () => {}, seen = new Set()) => {
    const start = rel && rel !== '.' ? rel : '';
    let startReal;
    try { startReal = fs.realpathSync(abs(start)); } catch { return []; }
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
          const childReal = path.join(real, e.name);
          if (seen.has(childReal)) { if (viaLink) onSkip(child, 'walked'); return []; }
          return go(child, childReal, viaLink);
        }
        let target;
        try { target = fs.realpathSync(abs(child)); } catch { if (test(child)) onSkip(child, 'missing'); return []; }
        const folder = isDir(child);
        if (!within(target)) { if (folder || test(child)) onSkip(child, 'outside'); return []; }
        if (!folder) return test(child) ? [child] : [];
        const ownRoute = under(startReal, target) && !path.relative(startReal, target).split(path.sep).some((s) => SKIP_DIRS.has(s));
        if (ownRoute || seen.has(target)) { onSkip(child, 'walked'); return []; }
        return go(child, target, true);
      });
    };
    return go(start, startReal, linked);
  };
  return { root, read, exists, isDir, list, walk, inside };
}

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
