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
  const within = (real) => { const r = path.relative(realRoot, real); return r === '' || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)); };
  /**
   * Whether `rel` lies in the repo once every symlink on its way is followed (a path that is not there is judged as
   * written, a `..` included: nothing can be read from it).
   */
  const inside = (rel) => {
    try { return within(fs.realpathSync(abs(rel))); } catch (err) { return err.code === 'ENOENT' ? within(path.resolve(abs(rel))) : false; }
  };
  /**
   * Every file under `rel` that `test` accepts, skipping SKIP_DIRS. A symlink is followed only while it stays in the
   * repo, and a real folder is walked once; `onSkip(path, reason)` hears of each one left out ('outside' or 'walked').
   */
  const walk = (rel, test = () => true, onSkip = () => {}, visited = new Set()) => {
    try { visited.add(fs.realpathSync(abs(rel))); } catch { /* not there: list() is empty */ }
    return list(rel).flatMap((name) => {
      if (SKIP_DIRS.has(name)) return [];
      const child = rel && rel !== '.' ? `${rel}/${name}` : name;
      let target = null;
      try { target = fs.realpathSync(abs(child)); } catch { /* a link to nothing: left to the caller, as before */ }
      if (target && !within(target)) { if (isDir(child) || test(child)) onSkip(child, 'outside'); return []; }
      if (!isDir(child)) return test(child) ? [child] : [];
      if (target && visited.has(target)) { onSkip(child, 'walked'); return []; }
      return walk(child, test, onSkip, visited);
    });
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
