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
  /** Every file under `rel` that `test` accepts, skipping SKIP_DIRS */
  const walk = (rel, test = () => true) => list(rel).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const child = rel && rel !== '.' ? `${rel}/${name}` : name;
    return isDir(child) ? walk(child, test) : test(child) ? [child] : [];
  });
  return { root, read, exists, isDir, list, walk };
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
