/**
 * @module server/files
 *
 * Taking a request path apart safely, and the files a request can name. The server serves an
 * allowlist, never a folder: cornfield's own explorer and the few pure modules it imports, the target
 * repo's map and registry, and the folders of the browser modules its config names. Everything else in
 * the checkout (.env files, databases, sources) is not reachable.
 *
 * Every file the server reads or sends for a request, the config or the repo goes through `inside`, which judges its REAL path, symlinks
 * followed, against the real folder it was asked from: a link that leads out is refused as a file that is not there.
 *
 * Proposals are found here too (server/proposal-walk.js does the walking, asynchronously): `<proposals>/*.json` in the
 * checkout and the same under each folder of the configured worktrees folder (git worktrees with unpushed drafts, those
 * that differ from the checkout's). A request can only name one the listing found itself; what it says is never joined
 * into a path.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream';
import { PROPOSAL_FILE, createProposalLister } from './proposal-walk.js';

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

/** Open flags for a plain read: never follow a link at the last step, never wait on a pipe (undefined where the platform has no such flag) */
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/** Whether `real` is strictly under `dir`, both real paths, by whole segments: `/x/repo-other` is not under `/x/repo` */
export function isUnder(dir, real) {
  const r = path.relative(dir, real);
  return r !== '' && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r);
}

/**
 * The file `rel` names under `dir`, as written: resolved, so `..`, an encoded `..%2f` and (on Windows) a backslash land outside and come
 * back null, but no link is followed. This is the name a route's allowlist is judged by; to read or send, use `inside`.
 * @param {string} dir an absolute folder
 * @param {string} rel a path under it, with or without a leading slash
 */
export function named(dir, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  const root = path.resolve(dir);
  const file = path.resolve(root, `.${rel.startsWith('/') ? '' : '/'}${rel}`);
  return file.startsWith(root + path.sep) ? file : null;
}

/**
 * The one check every file the server reads or sends goes through: the REAL path of the file `rel` names under `dir`, or null when it is
 * not there, would leave `dir` as written (`..`), or leads out of it through a link. Real path against real path, by whole segments,
 * so a folder that is itself reached through a link (a repo, an install) is judged by where it really is, and `/x/repo-other` is not
 * inside `/x/repo`. A refused file and a missing file are both null: a caller cannot tell them apart, and says the same to a visitor.
 * Read or send the path this returns, never the one written: that is the one that was checked.
 * @param {string} dir an absolute folder
 * @param {string} rel a path under it, with or without a leading slash
 * @returns {string|null}
 */
export function inside(dir, rel) {
  const file = named(dir, rel);
  if (!file) return null;
  try {
    const real = fs.realpathSync.native(file);
    return isUnder(fs.realpathSync.native(dir), real) ? real : null;
  } catch {
    return null;
  }
}

/**
 * The bytes of a plain file at a path `inside` gave, read through one descriptor opened without following a link, so a link swapped in
 * since the check is not followed and the size checked is the file read. Null when it is not a plain file, is over `maxBytes`, or cannot be read.
 * @param {string} real
 * @param {number} [maxBytes]
 * @returns {{ body: Buffer, stats: import('node:fs').Stats } | null}
 */
export function readPlain(real, maxBytes = Infinity) {
  let fd;
  try {
    fd = fs.openSync(real, READ_FLAGS);
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.size > maxBytes) return null;
    return { body: fs.readFileSync(fd), stats };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

/**
 * The repo's map, parsed: null when `config.topology` is not there or does not stay inside the repo. Throws on text that is not JSON.
 * @param {{ root: string, topology: string }} config
 */
export function readMap(config) {
  const real = inside(config.root, config.topology);
  const got = real && readPlain(real);
  return got ? JSON.parse(got.body.toString('utf8')) : null;
}

/** The ETag of each file served, by the real path served, with the size, mtime, ctime and inode it was taken at */
const etags = new Map();

function etagOf(real, fd, stats) {
  const stamp = `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}`; // ctime too: a write that puts the mtime back still moves it
  const known = etags.get(real);
  if (known && known.stamp === stamp) return known.etag;
  try {
    const etag = `W/"${createHash('sha1').update(fs.readFileSync(fd)).digest('base64url').slice(0, 22)}"`;
    etags.set(real, { stamp, etag });
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
 * unchanged file answers 304. A missing file is a 404. `filePath` is the real path `inside` gave: it is opened once, without following a
 * link, and the type, the ETag and the body all come from that one descriptor. The Content-Type is the file's own, by its real name.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string|null} filePath
 * @param {string} reqPath for the 404's text
 */
export function sendFile(req, res, filePath, reqPath) {
  let fd = null;
  let stats = null;
  try {
    if (filePath) {
      fd = fs.openSync(filePath, READ_FLAGS);
      stats = fs.fstatSync(fd);
    }
  } catch { stats = null; }
  if (fd === null || !stats || !stats.isFile()) {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ }
    return notFound(res, reqPath);
  }
  const etag = etagOf(filePath, fd, stats);
  // Typed by the file sent, not by the name asked for: with nosniff the type is binding, so a `.js` name that is a link to another kind of file
  // in the repo is not run as a script (and a file that is not a link has one name, so the two agree)
  const headers = { 'Content-Type': mime(filePath), 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...(etag ? { ETag: etag } : {}) };
  if (etag && matchesEtag(req.headers['if-none-match'], etag)) {
    fs.closeSync(fd);
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    fs.closeSync(fd);
    return res.end();
  }
  // `pipeline` closes the descriptor however the answer ends: sent, failed, the visitor gone mid-body, or gone before this was reached
  pipeline(fs.createReadStream(filePath, { fd, start: 0 }), res, () => {});
}

// ---------------------------------------------------------------------------
//  Proposals: listed from the checkout and its worktrees, served read-only
// ---------------------------------------------------------------------------

export { PROPOSAL_FILE };

/** The listers by the `fs` they use: the real one, or a fake a test hands in as `where.fs`. Each keeps its own cache. */
const listers = new WeakMap();
const realLister = createProposalLister();

function listerOf(where) {
  if (!where.fs) return realLister;
  if (!listers.has(where.fs)) listers.set(where.fs, createProposalLister({ fs: where.fs }));
  return listers.get(where.fs);
}

/**
 * Every proposal the server may serve (server/proposal-walk.js has how: async, cached, without the worktree files
 * that are copies of the checkout's). A review (`*.review.json`), a link, a directory and a name that is not a plain
 * file name are left out. When a slug is in several places each is listed, the worktree copies first, as that is
 * where it is being written. Each entry carries `parsed`, `{ proposal }` or `{ error }`: what the file holds.
 * @param {{ root: string, proposals: string, worktrees?: string|null, worktreeMaxAgeDays?: number|null }} where
 * @param {{ only?: string|null }} [opts] `only`: walk just this source (`checkout` or a worktree's name)
 * @returns {Promise<{ slug: string, source: string, file: string, parsed: { proposal?: unknown, error?: string } }[]>} `source` is `checkout` or the worktree's name
 */
export function listProposalFiles(where, opts) {
  return listerOf(where).list(where, opts);
}

/**
 * The listed proposal a request names, matched against the listing. No `source` means the first one
 * listed for the slug (the worktree copy). With a `source`, only that one place is walked.
 * @param {{ root: string, proposals: string, worktrees?: string|null, worktreeMaxAgeDays?: number|null }} where
 * @param {unknown} slug
 * @param {unknown} [source]
 */
export async function findProposalFile(where, slug, source) {
  if (typeof slug !== 'string' || (source !== undefined && source !== null && typeof source !== 'string')) return null;
  const only = typeof source === 'string' && source !== '' ? source : null;
  return (await listProposalFiles(where, { only })).find((e) => e.slug === slug && (only === null || e.source === only)) || null;
}
