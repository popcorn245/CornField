/**
 * @module server/proposals
 *
 * The proposal routes. The proposals are read-only:
 *
 *   GET /proposals                        the proposals found in the checkout and in every worktree
 *   GET /proposals/<slug>.json?source=…   one of them, as the file holds it
 *
 * The one thing the server writes is a maintainer's review of a proposal, in cornfield's own data folder
 * (never in a checkout; in v1 the review is a comment on the spec PR instead, docs/specs/0001-v1.md):
 *
 *   PUT /proposals/<slug>/review?source=…   { verdict, note, edits } -> `<dataDir>/reviews/<source>/<slug>.review.json`
 *   GET /proposals/<slug>/review?source=…   that file, or 404
 *   GET /proposals/<slug>/mockups[/<n>]?source=…   the screens a proposal lists, and each file (server/mockups.js)
 *
 * The file is `{ "version": 1, "verdict": "approved" | "notes", "note": string, "edits": Edit[], "mockups"?: Mockup[], "at": ISO string }`.
 * An approval of a proposal that lists mockups carries `mockups: [{ node, path, sha256 }]`, the files as they were when
 * it was approved (server/mockups.js; the client never sends it), so a later change to one shows as unreviewed.
 * The agent drafting the spec reads it (`cornfield review <slug>`), folds the edits into the proposal. The PUT is
 * same-origin only (`sameOrigin`), at most `REVIEW_LIMIT` bytes, checked by `validateReview`, and only
 * for a slug and source the server itself listed.
 *
 * Which files exist, and that a request can only name one the server itself listed, is server/files.js
 * (`listProposalFiles`, `findProposalFile`, `reviewFilePath`); this module reads the files, checks each
 * against the checkout's topology.json and answers. Every function takes `where`:
 * `{ root, proposals, worktrees, topology, dataDir, publicHost? }` (core/config.js names them). A file that does not
 * parse is listed with an `error` instead of breaking the list. The listing carries each proposal's
 * `review: { verdict, at } | null`.
 *
 * With sign-in the server also passes `forgeFor`, which gives the forge as the signed-in maintainer
 * (server/server.js), and the open spec PRs are listed too (server/proposal-pulls.js): source `pull/<n>`, a
 * `pull: { number, title, url, draft, author }` on the entry, the file read at the PR's head commit. A forge that
 * cannot answer does not break the list: the checkout and the worktrees are listed, and `X-Proposals-Forge-Error`
 * (percent-encoded) says why the PRs are not. A PR's review is not taken here yet (reviews as PR comments are the
 * next step). Without `forgeFor` nothing is asked of a forge and the routes answer as they always have.
 */

import fs from 'node:fs';
import path from 'node:path';
import { findProposalFile, listProposalFiles, reviewFilePath } from './files.js';
import { summarize, proposalProblems } from '../core/proposal.js';
import { ForgeError } from './forge.js';
import { hashMockups, serveMockups } from './mockups.js';
import { findPullProposal, forgeWords, listPullProposals, pullNumber, readPullProposal } from './proposal-pulls.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };

function send(res, status, body, extra = {}) {
  res.writeHead(status, { ...JSON_HEADERS, ...extra });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** The map the proposals are checked against: the checkout's topology.json, or null when it cannot be read */
function readTopology(where) {
  try {
    const topology = JSON.parse(fs.readFileSync(path.join(where.root, where.topology || 'topology.json'), 'utf8'));
    return Array.isArray(topology.nodes) && Array.isArray(topology.edges) ? topology : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
//  The review (spec 0012 B5)
// ---------------------------------------------------------------------------

/** What a PUT may carry, in bytes (the edits of a long session are a few KB; this is a ceiling, not a target) */
export const REVIEW_LIMIT = 256 * 1024;
/** Edits in one review, and the characters of its note */
export const MAX_REVIEW_EDITS = 500;
export const MAX_NOTE_CHARS = 20000;
const VERDICTS = ['approved', 'notes'];
const REVIEW_KEYS = ['verdict', 'note', 'edits'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Checks what the viewer sends for a review: `{ verdict: 'approved' | 'notes', note?: string, edits?: Edit[] }`
 * and nothing else (the server adds `version` and `at`). A note is needed to send a proposal back. Each edit is an
 * object with a string `op`; what the op means is the viewer's and the drafting agent's (whatif-model.js).
 * Pure: the same input gives the same answer, and the value it returns is a copy.
 * @param {unknown} body the parsed JSON
 * @returns {{ ok: true, value: { verdict: 'approved'|'notes', note: string, edits: object[] } } | { ok: false, error: string }}
 */
export function validateReview(body) {
  const no = (error) => ({ ok: false, error });
  if (!isObject(body)) return no('A review is a JSON object with a verdict, a note and edits.');
  const extra = Object.keys(body).find((k) => !REVIEW_KEYS.includes(k));
  if (extra !== undefined) return no(`A review has only a verdict, a note and edits, not "${extra}".`);
  if (!VERDICTS.includes(body.verdict)) return no('The verdict is "approved" or "notes".');
  if (body.note !== undefined && typeof body.note !== 'string') return no('The note is text.');
  const note = body.note ?? '';
  if (note.length > MAX_NOTE_CHARS) return no(`The note is at most ${MAX_NOTE_CHARS} characters.`);
  if (body.verdict === 'notes' && !note.trim()) return no('A note is needed to send a proposal back.');
  if (body.edits !== undefined && !Array.isArray(body.edits)) return no('The edits are a list.');
  const edits = body.edits ?? [];
  if (edits.length > MAX_REVIEW_EDITS) return no(`At most ${MAX_REVIEW_EDITS} edits in one review.`);
  const bad = edits.findIndex((e) => !isObject(e) || typeof e.op !== 'string' || e.op === '');
  if (bad >= 0) return no(`Edit ${bad + 1} is not an object with an op.`);
  return { ok: true, value: { verdict: body.verdict, note, edits: structuredClone(edits) } };
}

/** A host name that is the machine's own: localhost, an address, a tailnet name, a bare name, or the configured public host. Not an outside domain pointed here. */
function ownHostName(host, publicHost) {
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (publicHost && hostname === String(publicHost).toLowerCase()) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.ts.net')) return true;
  if (hostname.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true; // an address
  return !hostname.includes('.'); // a bare name on the LAN or the tailnet, like `server-1`
}

/**
 * Whether a request comes from a page of this server. A browser sends `Origin` (and `Sec-Fetch-Site`) on a PUT; at
 * least one must be there and each that is must say so. The Host has to be one of the machine's own names, so a page on
 * another domain that resolves here (DNS rebinding) is no more welcome than any other site.
 * @param {import('node:http').IncomingMessage} req
 * @param {string|null} [publicHost] the host of the configured public URL, which is the server's own too
 */
export function sameOrigin(req, publicHost = null) {
  const host = req.headers.host;
  if (typeof host !== 'string' || !ownHostName(host, publicHost)) return false;
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  if (origin === undefined && site === undefined) return false;
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== host.toLowerCase()) return false;
    } catch {
      return false; // `null`, or not a URL
    }
  }
  return site === undefined || site === 'same-origin';
}

/** The review file a listed proposal has, parsed, or null when there is none or it is not a review of this version */
function readReview(entry, dataDir) {
  const file = reviewFilePath(entry, dataDir);
  if (!file) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const review = JSON.parse(text);
    return isObject(review) && review.version === 1 && VERDICTS.includes(review.verdict) && typeof review.at === 'string' ? { review, text } : null;
  } catch {
    return null;
  }
}

/** Reads a request body up to `limit` bytes; `tooLarge` when it is more (the rest is drained and dropped, so the answer can be heard) */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let size = 0;
    let tooLarge = Number.isFinite(declared) && declared > limit;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit * 4) req.destroy(); // a flood is not worth answering politely
      if (tooLarge) return;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? { tooLarge } : { tooLarge, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', reject);
    req.on('close', () => { if (!req.complete) resolve({ tooLarge: true }); });
  });
}

/** Writes the review: a temporary file in the same folder, then a rename, so a reader sees all of it or none */
function writeReview(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw err;
  }
}

/** PUT /proposals/<slug>/review */
async function putReview(req, res, url, where, slug) {
  if (!sameOrigin(req, where.publicHost)) return send(res, 403, { error: 'A review is only taken from cornfield\'s own page' });
  const entry = findProposalFile(where, slug, url.searchParams.get('source') || null);
  if (!entry) return send(res, 404, { error: 'No such proposal' });
  let body;
  try {
    body = await readBody(req, REVIEW_LIMIT);
  } catch {
    return send(res, 400, { error: 'The request could not be read' });
  }
  if (body.tooLarge) return send(res, 413, { error: `A review is at most ${REVIEW_LIMIT / 1024} KB` });
  let parsed;
  try {
    parsed = JSON.parse(body.text);
  } catch (err) {
    return send(res, 400, { error: `Not valid JSON: ${err.message}` });
  }
  const checked = validateReview(parsed);
  if (!checked.ok) return send(res, 400, { error: checked.error });
  const file = reviewFilePath(entry, where.dataDir);
  if (!file) return send(res, 409, { error: 'Something that is not a file is where the review goes' });
  const mockups = checked.value.verdict === 'approved' ? hashMockups(entry) : [];
  const review = { version: 1, ...checked.value, ...(mockups.length ? { mockups } : {}), at: new Date().toISOString() };
  const text = `${JSON.stringify(review, null, 2)}\n`;
  try {
    writeReview(file, text);
  } catch (err) {
    return send(res, 500, { error: `The review could not be written: ${err.code || err.message}` });
  }
  return send(res, 200, review);
}

/**
 * One listing entry. `counts` is `summarize()` and `errors` the number of problems
 * `proposalProblems` finds against the checkout's map (null when the map could not be read);
 * a file that does not parse has `error` instead and no counts. `review` is the verdict and
 * time of the review beside it, or null.
 */
function describeEntry(entry, topology, dataDir) {
  const { slug, source } = entry;
  const found = readReview(entry, dataDir);
  const review = found ? { verdict: found.review.verdict, at: found.review.at } : null;
  let proposal;
  try {
    proposal = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
  } catch (err) {
    return { slug, title: slug, summary: '', spec: null, source, counts: null, errors: null, review, error: `Not valid JSON: ${err.message}` };
  }
  return { ...describeProposal(slug, source, proposal, topology), review };
}

/** What a listing entry says of a parsed proposal (the file may hold anything JSON can) */
function describeProposal(slug, source, proposal, topology) {
  const object = proposal !== null && typeof proposal === 'object' && !Array.isArray(proposal);
  const text = (v) => (typeof v === 'string' ? v : '');
  return {
    slug,
    title: object && text(proposal.title) ? proposal.title : slug,
    summary: object ? text(proposal.summary) : '',
    spec: object && typeof proposal.spec === 'string' ? proposal.spec : null,
    source,
    counts: summarize(proposal),
    errors: topology ? proposalProblems(topology, proposal).errors.length : null,
  };
}

/** The listing entry of a file in an open spec PR, read at the PR's head. A file the forge cannot give is listed with its error. */
async function describePull(entry, forge, where, topology) {
  const { slug, source, pull } = entry;
  let proposal;
  try {
    proposal = JSON.parse(await readPullProposal(forge, where, entry));
  } catch (err) {
    const why = err instanceof SyntaxError ? `Not valid JSON: ${err.message}` : forgeWords(err);
    return { slug, title: slug, summary: '', spec: null, source, counts: null, errors: null, review: null, pull, error: why };
  }
  return { ...describeProposal(slug, source, proposal, topology), review: null, pull };
}

/** The listing `GET /proposals` answers with */
export function listProposals(where) {
  const topology = readTopology(where);
  return listProposalFiles(where).map((entry) => describeEntry(entry, topology, where.dataDir));
}

/**
 * The listing with the open spec PRs in it, and the words for why they are missing when the forge could not be asked.
 * The checkout and the worktrees come first within a slug, then the PRs, newest first.
 * @param {object} where
 * @param {() => import('./forge.js').Forge} forgeFor
 * @returns {Promise<{ list: object[], problem: string | null }>}
 */
async function listWithPulls(where, forgeFor) {
  const topology = readTopology(where);
  const local = listProposalFiles(where).map((entry) => describeEntry(entry, topology, where.dataDir));
  let forge;
  try {
    forge = forgeFor();
  } catch (err) {
    return { list: local, problem: forgeWords(err) };
  }
  const { entries, problem } = await listPullProposals(forge, where);
  const pulls = await Promise.all(entries.map((entry) => describePull(entry, forge, where, topology)));
  const list = [...local, ...pulls].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return { list, problem };
}

/** GET /proposals/<slug>.json for a proposal that is not in a folder here: one in an open spec PR, if the forge has it */
async function servePull(res, where, forgeFor, slug, source) {
  const n = pullNumber(source);
  if (source && n === null) return send(res, 404, { error: 'No such proposal' });
  let entry;
  let text;
  try {
    const forge = forgeFor();
    entry = n === null ? (await listPullProposals(forge, where)).entries.find((e) => e.slug === slug) : await findPullProposal(forge, where, slug, n);
    if (!entry) return send(res, 404, { error: 'No such proposal' });
    text = await readPullProposal(forge, where, entry);
  } catch (err) {
    return send(res, err instanceof ForgeError ? (err.code === 'not-found' ? 404 : 502) : 500, { error: forgeWords(err) });
  }
  try {
    JSON.parse(text);
  } catch (err) {
    return send(res, 422, { error: `Not valid JSON: ${err.message}` });
  }
  return send(res, 200, text, { 'X-Proposal-Source': encodeURIComponent(entry.source) });
}

/**
 * Answers a request under `/proposals`, or returns false when it is not one.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} reqPath the decoded request path
 * @param {URL} url
 * @param {{ root: string, proposals: string, worktrees?: string|null, topology?: string, dataDir: string, publicHost?: string|null }} where
 * @param {(() => import('./forge.js').Forge) | null} [forgeFor] the forge as the signed-in user; null without sign-in
 * @returns {boolean} true when the request was answered
 */
export function serveProposals(req, res, reqPath, url, where, forgeFor = null) {
  if (reqPath !== '/proposals' && !reqPath.startsWith('/proposals/')) return false;

  // The review of one proposal (spec 0012 B5): the only thing here that can be written
  const review = /^\/proposals\/([^/]+)\/review$/.exec(reqPath);
  if (review) {
    // A proposal of a spec PR is reviewed on the PR (a later step); until then there is nothing to read or write here
    const onPull = forgeFor && pullNumber(url.searchParams.get('source')) !== null;
    if (req.method === 'PUT') {
      if (onPull) {
        req.resume();
        send(res, 409, { error: 'A review of a spec PR is not posted from cornfield yet; comment on the PR for now.' });
        return true;
      }
      putReview(req, res, url, where, review[1]).catch(() => {
        if (!res.headersSent) send(res, 500, { error: 'The review could not be saved' });
      });
    } else if (onPull && (req.method === 'GET' || req.method === 'HEAD')) {
      send(res, 404, { error: 'No review yet' });
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      const entry = findProposalFile(where, review[1], url.searchParams.get('source') || null);
      const found = entry && readReview(entry, where.dataDir);
      if (found) send(res, 200, found.text);
      else send(res, 404, { error: entry ? 'No review yet' : 'No such proposal' });
    } else {
      req.resume();
      send(res, 405, { error: 'A review is read with GET and written with PUT' }, { Allow: 'GET, HEAD, PUT' });
    }
    return true;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { error: 'Proposals are read-only here' }, { Allow: 'GET, HEAD' });
    return true;
  }

  const mockups = /^\/proposals\/([^/]+)\/mockups(?:\/(\d{1,4}))?$/.exec(reqPath);
  if (mockups) {
    serveMockups(req, res, mockups, url, where, forgeFor, (entry) => readReview(entry, where.dataDir)?.review ?? null).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'The mockups could not be read' });
    });
    return true;
  }

  if (reqPath === '/proposals') {
    if (!forgeFor) {
      send(res, 200, listProposals(where));
      return true;
    }
    listWithPulls(where, forgeFor).then(({ list, problem }) => {
      send(res, 200, list, problem ? { 'X-Proposals-Forge-Error': encodeURIComponent(problem) } : {});
    }).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'The proposals could not be listed' });
    });
    return true;
  }

  // /proposals/<slug>.json: one name, no further slashes. What is asked for is looked up in the
  // listing; it never becomes part of a path.
  const m = /^\/proposals\/([^/]+)\.json$/.exec(reqPath);
  const source = url.searchParams.get('source') || null;
  const entry = m ? findProposalFile(where, m[1], source) : null;
  if (!entry) {
    if (m && forgeFor) {
      servePull(res, where, forgeFor, m[1], source).catch(() => {
        if (!res.headersSent) send(res, 500, { error: 'The proposal could not be read' });
      });
      return true;
    }
    send(res, 404, { error: 'No such proposal' });
    return true;
  }
  let text;
  try {
    text = fs.readFileSync(entry.file, 'utf8');
    JSON.parse(text);
  } catch (err) {
    send(res, 422, { error: `Not valid JSON: ${err.message}` });
    return true;
  }
  send(res, 200, text, { 'X-Proposal-Source': encodeURIComponent(entry.source) });
  return true;
}
