/**
 * @module server/proposals
 *
 * The proposal routes. The proposals are read-only:
 *
 *   GET /proposals                        the proposals found in the checkout and in every worktree
 *   GET /proposals/<slug>.json?source=…   one of them, as the file holds it
 *
 * A maintainer's review of a proposal is a comment on its spec PR (server/reviews.js, docs/specs/0001-v1.md), so it is
 * only for a proposal of an open spec PR (source `pull/<n>`), and only with sign-in:
 *
 *   PUT /proposals/<slug>/review?source=pull/<n>   { verdict, note, edits } -> posts the comment as the signed-in maintainer
 *   GET /proposals/<slug>/review?source=pull/<n>   the latest admin comment's review, or 404
 *
 *   GET /proposals/<slug>/mockups[/<n>]?source=…   the screens a proposal lists, and each file (server/mockups.js)
 *
 * The answer is `{ version: 1, slug, verdict, note, edits, mockups?, at, by, comment: { id, url } }`. An approval of a
 * proposal that lists mockups carries `mockups: [{ node, path, sha256 }]`: the server hashes each file as the PR's head
 * holds it when the maintainer approves (`hashPullMockups`); every approval also carries `proposal`, the SHA-256 of the
 * proposal file at the head (`proposalHash`). The page never sends either, and a PUT that does is refused. The agent drafting the spec
 * reads it (`cornfield review <slug>`) and folds the edits into the proposal. The PUT is same-origin only
 * (`sameOrigin`), at most `REVIEW_LIMIT` bytes, checked by `validateReview`, and only for a proposal the forge
 * says the PR holds; it is written to the `actions` audit table. A proposal in the checkout or a worktree has no
 * PR yet, so there is nothing to review it on: the PUT answers 409 and says to push it as a spec PR. Stage 1 kept
 * the review in the data folder; `migrateStage1Reviews` carries those over once, when the menu is opened.
 *
 * Which files exist, and that a request can only name one the server itself listed, is server/files.js
 * (`listProposalFiles`, `findProposalFile`); this module reads the files, checks each
 * against the checkout's topology.json and answers. Every function takes `where`:
 * `{ root, proposals, worktrees, topology, dataDir, publicHost? }` (core/config.js names them). A file that does not
 * parse is listed with an `error` instead of breaking the list. The listing's `review` is always null: a review lives on
 * the PR and is read from it when a proposal opens (GET above).
 *
 * With sign-in the server also passes `forgeFor`, which gives the forge as the signed-in maintainer
 * (server/server.js), and the open spec PRs are listed too (server/proposal-pulls.js): source `pull/<n>`, a
 * `pull: { number, title, url, draft, author }` on the entry, the file read at the PR's head commit. A forge that
 * cannot answer does not break the list: the checkout and the worktrees are listed, and `X-Proposals-Forge-Error`
 * (percent-encoded) says why the PRs are not. Without `forgeFor` nothing is asked of a forge and the routes answer as they always have.
 */

import fs from 'node:fs';
import path from 'node:path';
import { findProposalFile, listProposalFiles } from './files.js';
import { summarize, proposalProblems } from '../core/proposal.js';
import { ForgeError } from './forge.js';
import { REVIEW_LIMIT, validateReview, latestReview, postReview, migrateStage1Reviews, proposalHash } from './reviews.js';
import { findPullProposal, forgeWords, listPullProposals, pullNumber, readPullProposal } from './proposal-pulls.js';
import { hashPullMockups, serveMockups } from './mockups.js';

// The review's checks live in server/reviews.js; these are re-exported for the callers that always had them here
export { REVIEW_LIMIT, MAX_REVIEW_EDITS, MAX_NOTE_CHARS, validateReview } from './reviews.js';

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

/**
 * One listing entry. `counts` is `summarize()` and `errors` the number of problems
 * `proposalProblems` finds against the checkout's map (null when the map could not be read);
 * a file that does not parse has `error` instead and no counts. `review` is null (see the module's head).
 */
function describeEntry(entry, topology) {
  const { slug, source } = entry;
  let proposal;
  try {
    proposal = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
  } catch (err) {
    return { slug, title: slug, summary: '', spec: null, source, counts: null, errors: null, review: null, error: `Not valid JSON: ${err.message}` };
  }
  return { ...describeProposal(slug, source, proposal, topology), review: null };
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
  return listProposalFiles(where).map((entry) => describeEntry(entry, topology));
}

/**
 * The listing with the open spec PRs in it, and the words for why they are missing when the forge could not be asked.
 * The checkout and the worktrees come first within a slug, then the PRs, newest first.
 * @param {object} where
 * @param {() => import('./forge.js').Forge} forgeFor
 * @param {SignedIn | null} signedIn
 * @returns {Promise<{ list: object[], problem: string | null }>}
 */
async function listWithPulls(where, forgeFor, signedIn) {
  const topology = readTopology(where);
  const local = listProposalFiles(where).map((entry) => describeEntry(entry, topology));
  let forge;
  try {
    forge = forgeFor();
  } catch (err) {
    return { list: local, problem: forgeWords(err) };
  }
  const { entries, problem } = await listPullProposals(forge, where);
  if (signedIn && entries.length) await migrateStage1Reviews({ forge, dataDir: where.dataDir, entries, login: signedIn.login, record: signedIn.record });
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

/** The words for a refusal of the forge: the status to answer with, and what to say */
const forgeStatus = (err) => (err instanceof ForgeError ? (err.code === 'not-found' ? 404 : err.code === 'invalid' ? 400 : 502) : 500);

/** GET /proposals/<slug>/review?source=pull/<n>: the latest admin comment's review, or 404 */
async function getPullReview(res, where, forgeFor, slug, n) {
  try {
    const forge = forgeFor();
    if (!(await findPullProposal(forge, where, slug, n))) return send(res, 404, { error: 'No such proposal' });
    const found = await latestReview(forge, n, slug);
    return found ? send(res, 200, found) : send(res, 404, { error: 'No review yet' });
  } catch (err) {
    return send(res, forgeStatus(err), { error: forgeWords(err) });
  }
}

/** PUT /proposals/<slug>/review?source=pull/<n>: posts the review as a comment on the PR, as the signed-in maintainer */
async function putPullReview(req, res, where, forgeFor, signedIn, slug, n) {
  if (!sameOrigin(req, where.publicHost)) {
    req.resume();
    return send(res, 403, { error: 'A review is only taken from cornfield\'s own page' });
  }
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
  // What an approval covers is the server's to record, from the files themselves, never the page's word
  if (parsed !== null && typeof parsed === 'object' && ('mockups' in parsed || 'proposal' in parsed)) return send(res, 400, { error: 'What an approval covers (the proposal and its mockups) is recorded by the server; a review does not send it.' });
  const checked = validateReview(parsed);
  if (!checked.ok) return send(res, 400, { error: checked.error });
  try {
    const forge = forgeFor();
    const entry = await findPullProposal(forge, where, slug, n);
    if (!entry) return send(res, 404, { error: 'No such proposal' });
    let review = checked.value;
    if (review.verdict === 'approved') {
      // The proposal as the head holds it now: a later push that changes it is not this approval's
      review = { ...review, proposal: proposalHash(await readPullProposal(forge, where, entry)) };
      const mockups = await hashPullMockups(forge, where, entry);
      if (mockups.length) review = { ...review, mockups };
    }
    return send(res, 200, await postReview(forge, n, slug, review, { login: signedIn.login, record: signedIn.record }));
  } catch (err) {
    return send(res, forgeStatus(err), { error: forgeWords(err) });
  }
}

/** @typedef {{ login: string, record: (entry: import('./reviews.js').AuditEntry) => Promise<void> | void }} SignedIn */

/**
 * Answers a request under `/proposals`, or returns false when it is not one.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} reqPath the decoded request path
 * @param {URL} url
 * @param {{ root: string, proposals: string, worktrees?: string|null, topology?: string, dataDir: string, publicHost?: string|null }} where
 * @param {(() => import('./forge.js').Forge) | null} [forgeFor] the forge as the signed-in user; null without sign-in
 * @param {SignedIn | null} [signedIn] who is signed in, and where their actions are recorded; null without sign-in
 * @returns {boolean} true when the request was answered
 */
export function serveProposals(req, res, reqPath, url, where, forgeFor = null, signedIn = null) {
  if (reqPath !== '/proposals' && !reqPath.startsWith('/proposals/')) return false;

  // The review of one proposal: a comment on its spec PR, the only thing here that can be written
  const review = /^\/proposals\/([^/]+)\/review$/.exec(reqPath);
  if (review) {
    const slug = review[1];
    const n = forgeFor && signedIn ? pullNumber(url.searchParams.get('source')) : null;
    if (req.method === 'PUT') {
      if (n === null || !forgeFor || !signedIn) {
        req.resume();
        send(res, 409, { error: 'A review is a comment on a spec PR. Push this draft as a spec PR (and sign in), then review it there.' });
        return true;
      }
      putPullReview(req, res, where, forgeFor, signedIn, slug, n).catch(() => {
        if (!res.headersSent) send(res, 500, { error: 'The review could not be saved' });
      });
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      if (n !== null && forgeFor) {
        getPullReview(res, where, forgeFor, slug, n).catch(() => {
          if (!res.headersSent) send(res, 500, { error: 'The review could not be read' });
        });
      } else {
        send(res, 404, { error: findProposalFile(where, slug, url.searchParams.get('source') || null) ? 'No review yet' : 'No such proposal' });
      }
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
    serveMockups(req, res, mockups, url, where, forgeFor).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'The mockups could not be read' });
    });
    return true;
  }

  if (reqPath === '/proposals') {
    if (!forgeFor) {
      send(res, 200, listProposals(where));
      return true;
    }
    listWithPulls(where, forgeFor, signedIn).then(({ list, problem }) => {
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
