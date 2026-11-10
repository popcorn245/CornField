/**
 * @module explorer/file-url
 *
 * `fileUrl(forge, path, ref)`: where a node's file is on the forge's web site, or null. `forge` is the client config's
 * `{ type, url, repo }` (server/server.js); `ref` a branch name, or `HEAD` (the repo's default branch, on GitHub and on
 * Forgejo/Gitea 1.21 and later) when none is given. Only GitHub and Forgejo/Gitea exist (server/forge-*.js).
 * The path must be repo-relative: no `..`, no absolute path, no scheme, no backslash, no control character. The URL is
 * built with `URL`, each segment encoded, and only `https:` is allowed, with no user name and no backslash in `forge.url`
 * (`https://github.com@evil.test` is evil.test).
 */

// The page of a file at a branch, per forge
const SHAPE = { github: 'blob', forgejo: 'src/branch' };

/** The segments of a repo-relative path (or branch name), or null when it is not one */
function segments(path) {
  if (typeof path !== 'string' || !path || /[\\\u0000-\u001f\u007f]/.test(path) || path.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return null;
  const parts = path.split('/');
  return parts.every((s) => s && s !== '.' && s !== '..') ? parts : null;
}

/** @returns {string | null} */
export function fileUrl(forge, path, ref) {
  const kind = forge && Object.hasOwn(SHAPE, forge.type) && SHAPE[forge.type];
  const file = segments(path);
  const branch = segments(ref || 'HEAD');
  const repo = segments(forge && forge.repo);
  if (!kind || !file || !branch || !repo || repo.length !== 2) return null;
  try {
    const base = new URL(forge.url);
    if (base.protocol !== 'https:' || base.username || base.password || String(forge.url).includes('\\')) return null;
    const enc = (s) => s.map(encodeURIComponent).join('/');
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/${enc(repo)}/${kind}/${enc(branch)}/${enc(file)}`;
    base.search = '';
    base.hash = '';
    return base.href;
  } catch {
    return null;
  }
}
