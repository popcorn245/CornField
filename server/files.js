/**
 * @module server/files
 *
 * Taking a request path apart safely, and the files a request can name. The server serves an
 * allowlist, never a folder: cornfield's own explorer and the few pure modules it imports, the target
 * repo's map and registry, and the folders of the browser modules its config names. Everything else in
 * the checkout (.env files, databases, sources) is not reachable.
 *
 * Proposals are found here too: `<proposals>/*.json` in the checkout and the same under each folder of
 * the configured worktrees folder (git worktrees with unpushed drafts). A request can only name one the
 * listing found itself; what it says is never joined into a path.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Content-Type by lower-case file extension (with the dot) */
export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/** The Content-Type for a file name, `application/octet-stream` when the extension is unknown */
export const mime = (file) => MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';

/**
 * The URL path with its percent-escapes decoded, or null when it cannot be: a malformed escape or a NUL
 * byte. The caller answers 400.
 * @param {string} pathname
 * @returns {string|null}
 */
export function decodePath(pathname) {
  try {
    const decoded = decodeURIComponent(pathname);
    return decoded.includes('\0') ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * The file `rel` names inside `dir`, or null when it would leave it. The path is resolved before it is
 * checked, so `..`, an encoded `..%2f` and (on Windows) a backslash all land outside and come back null.
 * @param {string} dir an absolute folder
 * @param {string} rel a path under it, with or without a leading slash
 */
export function inside(dir, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  const root = path.resolve(dir);
  const file = path.resolve(root, `.${rel.startsWith('/') ? '' : '/'}${rel}`);
  return file.startsWith(root + path.sep) ? file : null;
}

/** The ETag of each file served, with the size and mtime it was taken at */
const etags = new Map();

function etagOf(filePath, stats) {
  const stamp = `${stats.size}:${stats.mtimeMs}`;
  const known = etags.get(filePath);
  if (known && known.stamp === stamp) return known.etag;
  try {
    const etag = `W/"${createHash('sha1').update(fs.readFileSync(filePath)).digest('base64url').slice(0, 22)}"`;
    etags.set(filePath, { stamp, etag });
    return etag;
  } catch {
    return null;
  }
}

const matchesEtag = (header, etag) => !!header && (header.trim() === '*' || header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag.replace(/^W\//, '')));

/** A plain 404 that says nothing about what is there */
export function notFound(res, reqPath) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(`404 Not Found: ${reqPath}`);
}

/**
 * Sends one file (it must be a plain file), `no-cache` with an ETag, so the browser asks every time and an
 * unchanged file answers 304. A missing file is a 404.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string|null} filePath
 * @param {string} reqPath for the 404's text
 */
export function sendFile(req, res, filePath, reqPath) {
  let stats = null;
  try { stats = filePath ? fs.statSync(filePath) : null; } catch { stats = null; }
  if (!stats || !stats.isFile()) return notFound(res, reqPath);
  const etag = etagOf(filePath, stats);
  const headers = { 'Content-Type': mime(filePath), 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...(etag ? { ETag: etag } : {}) };
  if (etag && matchesEtag(req.headers['if-none-match'], etag)) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

// ---------------------------------------------------------------------------
//  Proposals: listed from the checkout and its worktrees, served read-only
// ---------------------------------------------------------------------------

/** A proposal's file name: letters, digits, `.`, `_`, `-`; never a leading dot or dash. The slug is the name without `.json` */
const PROPOSAL_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.json$/;

/**
 * The folders to look in: the checkout first, then each worktree (a real directory, never a link).
 * @param {{ root: string, proposals: string, worktrees?: string|null }} where
 */
function proposalFolders({ root, proposals, worktrees }) {
  const base = path.resolve(root);
  const folders = [{ source: 'checkout', dir: path.join(base, proposals) }];
  if (!worktrees) return folders;
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(base, worktrees), { withFileTypes: true });
  } catch { /* no worktrees here */ }
  for (const w of entries) {
    // A worktree called "checkout" would be taken for the checkout itself: not listed
    if (w.isDirectory() && w.name !== 'checkout') folders.push({ source: w.name, dir: path.join(base, worktrees, w.name, proposals) });
  }
  return folders;
}

/**
 * Every proposal the server may serve. A review (`*.review.json`), a link, a directory and a name that is
 * not a plain file name are left out. When a slug is in several places each is listed, the worktree copies
 * first, as that is where it is being written.
 * @param {{ root: string, proposals: string, worktrees?: string|null }} where
 * @returns {{ slug: string, source: string, file: string }[]} `source` is `checkout` or the worktree's name
 */
export function listProposalFiles(where) {
  const out = [];
  for (const { source, dir } of proposalFolders(where)) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch { continue; }
    for (const name of names) {
      const m = PROPOSAL_FILE.exec(name);
      if (!m || name.endsWith('.review.json')) continue;
      const file = path.join(dir, name);
      try {
        if (!fs.lstatSync(file).isFile()) continue; // a directory, or a symlink to somewhere else
      } catch { continue; }
      out.push({ slug: m[1], source, file });
    }
  }
  const rank = (e) => (e.source === 'checkout' ? 1 : 0);
  return out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : rank(a) - rank(b) || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)));
}

/**
 * The listed proposal a request names, matched against the listing. No `source` means the first one
 * listed for the slug (the worktree copy).
 * @param {{ root: string, proposals: string, worktrees?: string|null }} where
 * @param {unknown} slug
 * @param {unknown} [source]
 */
export function findProposalFile(where, slug, source) {
  if (typeof slug !== 'string' || (source !== undefined && source !== null && typeof source !== 'string')) return null;
  return listProposalFiles(where).find((e) => e.slug === slug && (source === undefined || source === null || e.source === source)) || null;
}

/**
 * Where cornfield keeps its own record of the review of a listed proposal: in its data folder, never in a
 * checkout (`<dataDir>/reviews/<source>/<slug>.review.json`, the source percent-encoded). Built from an entry
 * the listing produced, never from a request. Null when the entry does not look like one, or when something
 * that is not a plain file is already at that name.
 * @param {{ slug: string, source: string, file: string }|null|undefined} entry
 * @param {string} dataDir
 * @returns {string|null}
 */
export function reviewFilePath(entry, dataDir) {
  if (!entry || typeof entry.slug !== 'string' || typeof entry.source !== 'string' || typeof entry.file !== 'string' || !path.isAbsolute(entry.file)) return null;
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) return null;
  const m = PROPOSAL_FILE.exec(path.basename(entry.file));
  if (!m || m[1] !== entry.slug || entry.slug.endsWith('.review')) return null;
  const file = path.join(dataDir, 'reviews', encodeURIComponent(entry.source), `${entry.slug}.review.json`);
  try {
    if (!fs.lstatSync(file).isFile()) return null;
  } catch { /* nothing there yet: fine */ }
  return file;
}
