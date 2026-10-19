/**
 * @module server/mockups
 *
 * The mockups of a proposal (its `mockups` list, core/proposal.js): screens kept beside the proposal, images or HTML
 * in the spec branch, that the explorer opens from the node they name.
 *
 *   GET /proposals/<slug>/mockups?source=…      the list: [{ index, node, path, title, type, url, sha256, state }]
 *   GET /proposals/<slug>/mockups/<n>?source=…  the n-th file of the proposal's own list, with the headers below
 *
 * **What a request names.** A slug, a source and a position in the proposal's `mockups`. The path is read from the
 * proposal, checked again (`mockupPathProblem`), joined to the proposals folder and resolved with its links followed;
 * a file that lands outside the folder is a 404, as is anything that is not a plain file. Nothing a request says
 * becomes part of a path. Like every route, this one is behind the sign-in and the Host check.
 *
 * **Where from.** The checkout and the worktrees: the file on disk. An open spec PR (source `pull/<n>`): the file at
 * the PR's head commit through the forge (`fileBytes`, as the signed-in maintainer), never a checkout.
 *
 * **Untrusted content.** A mockup is whatever a branch holds, so HTML and SVG in it must never run script against
 * cornfield's origin. Every mockup is answered with: the type its extension names (never sniffed: `nosniff`), a
 * `Content-Security-Policy` of `sandbox; default-src 'none'` (no script, no network, an opaque origin, even when the
 * file is opened on its own), `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` (only cornfield's own page
 * may frame it; the rest of the server says DENY), and `Cross-Origin-Resource-Policy: same-origin`. The explorer shows
 * images and SVG in an `<img>` and HTML in an `<iframe sandbox>` with no `allow-*` (explorer/mockups.js).
 *
 * **Approve covers them.** `hashMockups` gives each local mockup's SHA-256; an approval records `{ node, path, sha256 }`
 * for each (server/proposals.js), and `mockupStates` compares a later read to it: `approved`, `changed` (the file is
 * not what was approved), `unreviewed` or `missing`. A spec PR's review is not taken here yet, so its mockups are
 * `unreviewed`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mockupsOf } from '../core/proposal.js';
import { ForgeError } from './forge.js';
import { findProposalFile, mime } from './files.js';
import { findPullProposal, folderOf, forgeWords, pullNumber, readPullProposal } from './proposal-pulls.js';

/** The most a mockup file may be, in bytes */
export const MOCKUP_MAX_BYTES = 5 * 1024 * 1024;

/** The policy of every mockup: sandboxed (no script, no forms, no popups, its own opaque origin), nothing loaded from anywhere, framed only by cornfield's own page */
export const MOCKUP_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'";

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isHtml = (file) => path.extname(file).toLowerCase() === '.html';

/** The headers of a mockup answer (see the module doc) */
export function mockupHeaders(file, bytes) {
  return {
    'Content-Type': mime(file),
    'Content-Length': bytes.length,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': MOCKUP_CSP,
    'X-Frame-Options': 'SAMEORIGIN',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-cache',
    'Content-Disposition': 'inline',
    ETag: `"${sha256(bytes)}"`,
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
const refuse = (res, status, message) => sendJson(res, status, { error: message });

/** The proposal's parsed JSON for a local entry, or null */
function readLocalProposal(entry) {
  try {
    return JSON.parse(fs.readFileSync(entry.file, 'utf8'));
  } catch {
    return null;
  }
}

/** The bytes of a mockup of a local proposal, or null: the path is resolved with links followed and must stay in the proposal's folder, be a plain file, and be at most MOCKUP_MAX_BYTES */
export function readLocalMockup(entry, rel) {
  try {
    const dir = fs.realpathSync(path.dirname(entry.file));
    const real = fs.realpathSync(path.join(dir, ...rel.split('/')));
    if (!real.startsWith(dir + path.sep)) return null;
    const stats = fs.statSync(real);
    if (!stats.isFile() || stats.size > MOCKUP_MAX_BYTES) return null;
    return fs.readFileSync(real);
  } catch {
    return null;
  }
}

/**
 * What an approval records of a local proposal: each mockup it lists, with the SHA-256 of the file as it is now
 * (null when the file is not there).
 * @param {{ file: string }} entry a listed proposal
 * @returns {{ node: string, path: string, sha256: string | null }[]}
 */
export function hashMockups(entry) {
  return hashItems(entry, mockupsOf(readLocalProposal(entry)));
}

const hashItems = (entry, items) => items.map((m) => {
  const bytes = readLocalMockup(entry, m.path);
  return { node: m.node, path: m.path, sha256: bytes ? sha256(bytes) : null };
});

/**
 * Whether each mockup is what was approved.
 * @param {{ node: string, path: string, sha256: string | null }[]} now the mockups as they are
 * @param {{ verdict?: string, mockups?: unknown } | null} review the latest review, or null
 * @returns {('approved' | 'changed' | 'unreviewed' | 'missing')[]}
 */
export function mockupStates(now, review) {
  const recorded = review && review.verdict === 'approved' && Array.isArray(review.mockups) ? review.mockups : [];
  return now.map((m) => {
    if (m.sha256 === null) return 'missing';
    const was = recorded.find((r) => r && r.node === m.node && r.path === m.path);
    if (!was) return 'unreviewed';
    return was.sha256 === m.sha256 ? 'approved' : 'changed';
  });
}

/** What the explorer is handed for each mockup; `hashes` is null when the files are not read (a spec PR) */
function describe(slug, source, items, hashes, review) {
  const states = hashes ? mockupStates(hashes, review) : items.map(() => 'unreviewed');
  return items.map((m, i) => ({
    index: m.index,
    node: m.node,
    path: m.path,
    title: m.title,
    type: isHtml(m.path) ? 'page' : 'image',
    url: `/proposals/${encodeURIComponent(slug)}/mockups/${m.index}?source=${encodeURIComponent(source)}`,
    sha256: hashes ? hashes[i].sha256 : null,
    state: states[i],
  }));
}

function sendBytes(req, res, file, bytes) {
  const headers = mockupHeaders(file, bytes);
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').some((t) => t.trim() === headers.ETag)) {
    res.writeHead(304, { ...headers, 'Content-Length': 0 });
    return res.end();
  }
  res.writeHead(200, headers);
  return res.end(req.method === 'HEAD' ? undefined : bytes);
}

/** The list or one file of a proposal in an open spec PR */
async function servePull(req, res, where, forgeFor, slug, source, position) {
  let items;
  let item = null;
  let bytes = null;
  try {
    const forge = forgeFor();
    const entry = await findPullProposal(forge, where, slug, /** @type {number} */ (pullNumber(source)));
    if (!entry) return refuse(res, 404, 'No such proposal');
    items = mockupsOf(JSON.parse(await readPullProposal(forge, where, entry)));
    if (position === null) return sendJson(res, 200, describe(slug, source, items, null, null));
    item = items.find((m) => m.index === position);
    if (!item) return refuse(res, 404, 'No such mockup');
    bytes = await forge.fileBytes(entry.sha, path.posix.join(folderOf(where), item.path));
  } catch (err) {
    if (err instanceof SyntaxError) return refuse(res, 422, `Not valid JSON: ${err.message}`);
    return refuse(res, err instanceof ForgeError ? (err.code === 'not-found' ? 404 : 502) : 500, forgeWords(err));
  }
  if (!bytes || bytes.length > MOCKUP_MAX_BYTES) return refuse(res, 404, 'No such mockup');
  return sendBytes(req, res, item.path, bytes);
}

/**
 * Answers `/proposals/<slug>/mockups` and `/proposals/<slug>/mockups/<n>` (the caller has checked the method is GET or HEAD).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {RegExpExecArray} match the route's match: the slug, then the position or undefined
 * @param {URL} url
 * @param {object} where
 * @param {(() => import('./forge.js').Forge) | null} forgeFor
 * @param {(entry: object) => object | null} reviewOf the latest review of a listed local proposal
 */
export async function serveMockups(req, res, match, url, where, forgeFor, reviewOf) {
  const slug = match[1];
  const position = match[2] === undefined ? null : Number(match[2]);
  const source = url.searchParams.get('source') || null;
  const entry = findProposalFile(where, slug, source);
  if (!entry) {
    if (forgeFor && pullNumber(source) !== null) return servePull(req, res, where, forgeFor, slug, /** @type {string} */ (source), position);
    return refuse(res, 404, 'No such proposal');
  }
  const proposal = readLocalProposal(entry);
  if (!proposal) return refuse(res, 422, 'The proposal could not be read');
  const items = mockupsOf(proposal);
  if (position === null) return sendJson(res, 200, describe(slug, entry.source, items, hashItems(entry, items), reviewOf(entry)));
  const item = items.find((m) => m.index === position);
  const bytes = item ? readLocalMockup(entry, item.path) : null;
  if (!item || !bytes) return refuse(res, 404, 'No such mockup');
  return sendBytes(req, res, item.path, bytes);
}
