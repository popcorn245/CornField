/**
 * @module server/reviews
 *
 * A review is a comment on the spec PR (spec 0001 section 3): a line a person can read, then a fenced block tagged
 * `cornfield-review` and named for the proposal, holding `{ verdict, note, edits }`:
 *
 *     Approved `0014-planner` (maintainer-one, in cornfield).
 *
 *     ```cornfield-review 0014-planner
 *     { "verdict": "approved", "note": "", "edits": [] }
 *     ```
 *
 * The latest such comment by an admin is the review (`latestReview`). Admins are the repo's maintainers
 * (`isMaintainer`, server/forge.js): a comment by anyone else is ignored, however well formed, and so is a block that
 * is not strictly a review (not JSON, a verdict it does not know, a key it does not have). Comment text is untrusted:
 * it is parsed, never rendered as HTML, and never joined into a path. A PR holds several proposals, so the slug is
 * in the fence's info string; the JSON is exactly the review.
 *
 * **An edited review is not trusted.** On both forges someone with write access may edit anyone's comment, and the
 * comment keeps its author: a writer could turn a maintainer's "Sent back" into "Approved". cornfield never edits a
 * comment it posted, so a review comment changed after it was posted (`updatedAt` more than `EDIT_GRACE_MS` after
 * `createdAt`) does not count, and neither does anything older on that proposal: there is no review until a
 * maintainer posts a new one. (A maintainer who wants to change their mind posts a new review.)
 *
 * Everything goes through the forge interface as the signed-in maintainer (their own token). Posting is recorded in
 * the `actions` audit table by the caller's `record` (server/auth.js), whatever the forge answered.
 *
 * Stage 1 kept reviews in the data folder (`<dataDir>/reviews/<source>/<slug>.review.json`). That path is gone:
 * `migrateStage1Reviews` posts each such file once, as a comment on the one open spec PR that holds its slug, and
 * renames it to `<slug>.review.json.migrated` (left alone, never read again). It is safe to run any number of times.
 *
 * An approval of a proposal that lists mockups also carries `mockups: [{ node, path, sha256 }]` in the same block: the
 * files it covers as the server hashed them (server/mockups.js `hashPullMockups`). A later file that is not that one
 * reads as changed since the approval.
 *
 * @typedef {{ node: string, path: string, sha256: string }} ReviewedMockup
 * @typedef {{ verdict: 'approved' | 'notes', note: string, edits: object[], mockups?: ReviewedMockup[] }} Review
 * @typedef {Review & { version: 1, slug: string, at: string, by: string, comment: { id: string, url: string } }} FoundReview
 * @typedef {{ login: string, action: string, target: string, request: object, status: number | null, answer: object | null }} AuditEntry
 */

import fs from 'node:fs';
import path from 'node:path';
import { isMaintainer, ForgeError } from './forge.js';
import { PROPOSAL_FILE } from './files.js';
import { MAX_MOCKUPS, mockupPathProblem } from '../core/proposal.js';

// ---------------------------------------------------------------------------
//  The review a person sends
// ---------------------------------------------------------------------------

/** What a PUT may carry, in bytes (the edits of a long session are a few KB; this is a ceiling, not a target) */
export const REVIEW_LIMIT = 256 * 1024;
/** Edits in one review, and the characters of its note */
export const MAX_REVIEW_EDITS = 500;
export const MAX_NOTE_CHARS = 20000;
/** What a comment may hold: GitHub refuses 65536 characters, and the human line comes with it */
export const MAX_COMMENT_CHARS = 60000;
const VERDICTS = ['approved', 'notes'];
const REVIEW_KEYS = ['verdict', 'note', 'edits', 'mockups'];
const MOCKUP_KEYS = ['node', 'path', 'sha256'];
const SHA256 = /^[0-9a-f]{64}$/;

/** The tag of the fenced block */
export const REVIEW_TAG = 'cornfield-review';
/** How long after it was posted a comment may show a later `updatedAt` and still count as never edited */
export const EDIT_GRACE_MS = 5_000;

/** Whether a comment was changed after it was posted */
const wasEdited = (c) => Date.parse(c.updatedAt) - Date.parse(c.createdAt) > EDIT_GRACE_MS;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Checks a review: `{ verdict: 'approved' | 'notes', note?: string, edits?: Edit[] }` and nothing else. A note is
 * needed to send a proposal back. Each edit is an object with a string `op`; what the op means is the viewer's and
 * the drafting agent's (whatif-model.js). Pure: the value it returns is a copy.
 * @param {unknown} body the parsed JSON
 * @returns {{ ok: true, value: Review } | { ok: false, error: string }}
 */
export function validateReview(body) {
  const no = (error) => ({ ok: false, error });
  if (!isObject(body)) return no('A review is a JSON object with a verdict, a note and edits.');
  const extra = Object.keys(body).find((k) => !REVIEW_KEYS.includes(k));
  if (extra !== undefined) return no(`A review has only a verdict, a note, edits and mockups, not "${extra}".`);
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
  let mockups;
  if (body.mockups !== undefined) {
    if (body.verdict !== 'approved') return no('Only an approval covers mockups.');
    if (!Array.isArray(body.mockups)) return no('The mockups are a list.');
    if (body.mockups.length > MAX_MOCKUPS) return no(`At most ${MAX_MOCKUPS} mockups in one review.`);
    for (const [i, m] of body.mockups.entries()) {
      const at = `Mockup ${i + 1}`;
      if (!isObject(m) || Object.keys(m).some((k) => !MOCKUP_KEYS.includes(k))) return no(`${at} is { node, path, sha256 } and nothing else.`);
      if (typeof m.node !== 'string' || !m.node.trim() || m.node.length > 200) return no(`${at} needs the node it is beside.`);
      if (mockupPathProblem(m.path) !== null) return no(`${at}: ${mockupPathProblem(m.path)}`);
      if (typeof m.sha256 !== 'string' || !SHA256.test(m.sha256)) return no(`${at}: "sha256" is the file's SHA-256, 64 lower-case hex digits.`);
    }
    mockups = body.mockups.map((m) => ({ node: m.node, path: m.path, sha256: m.sha256 }));
  }
  return { ok: true, value: { verdict: body.verdict, note, edits: structuredClone(edits), ...(mockups ? { mockups } : {}) } };
}

// ---------------------------------------------------------------------------
//  The comment: written, and read back
// ---------------------------------------------------------------------------

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
const FENCE = '```';

/**
 * The text of the comment for a review: the human line, the note quoted (so nothing in it can open or close a block),
 * then the fenced block.
 * @param {string} slug
 * @param {Review} review
 * @param {{ login: string, carriedOver?: string }} by who sent it; `carriedOver` is the day of a Stage 1 review being migrated
 */
export function reviewComment(slug, review, { login, carriedOver }) {
  const verdict = review.verdict === 'approved' ? 'Approved' : 'Sent back';
  const withEdits = review.edits.length ? ` with ${plural(review.edits.length, 'edit')}` : '';
  const how = carriedOver ? `${login}, in cornfield on ${carriedOver}; carried over from before reviews were comments` : `${login}, in cornfield`;
  const line = `${verdict} \`${slug}\`${withEdits} (${how}).`;
  const quoted = review.note.trim() ? `\n\n${review.note.trim().split(/\r?\n/).map((l) => (l ? `> ${l}` : '>')).join('\n')}` : '';
  const json = JSON.stringify({ verdict: review.verdict, note: review.note, edits: review.edits, ...(review.mockups ? { mockups: review.mockups } : {}) }, null, 2);
  return `${line}${quoted}\n\n${FENCE}${REVIEW_TAG} ${slug}\n${json}\n${FENCE}`;
}

const BLOCK = new RegExp(`^${FENCE}${REVIEW_TAG}[ \\t]+([A-Za-z0-9][A-Za-z0-9._-]*)[ \\t]*\\n([\\s\\S]*?)\\n${FENCE}[ \\t]*$`, 'gm');

/**
 * The reviews a comment's text holds, in order. A block that is not strictly a review is not one: it is skipped,
 * and nothing is thrown for it.
 * @param {unknown} body a comment's text
 * @returns {{ slug: string, review: Review }[]}
 */
export function parseReviewBlocks(body) {
  if (typeof body !== 'string' || !body.includes(REVIEW_TAG)) return [];
  const out = [];
  for (const m of body.replace(/\r\n?/g, '\n').matchAll(BLOCK)) {
    let json;
    try {
      json = JSON.parse(m[2]);
    } catch {
      continue;
    }
    const checked = validateReview(json);
    if (checked.ok) out.push({ slug: m[1], review: checked.value });
  }
  return out;
}

/**
 * The review of proposal `slug` on PR `n`: the latest comment by an admin that holds one for it, or null. Authors are
 * asked about newest first, once each, and only when their comment holds a review of this slug; a forge that cannot
 * say throws, rather than let an older review stand in for a newer one.
 * @param {import('./forge.js').Forge} forge
 * @param {number} n
 * @param {string} slug
 * @param {import('./forge.js').Comment[]} [comments] when the caller already has them
 * @returns {Promise<FoundReview | null>}
 */
export async function latestReview(forge, n, slug, comments) {
  const all = comments ?? (await forge.comments(n));
  const admins = new Map();
  for (let i = all.length - 1; i >= 0; i--) {
    const c = all[i];
    if (!c.author) continue; // a deleted account: nobody to ask about
    const found = parseReviewBlocks(c.body).filter((b) => b.slug === slug).pop();
    if (!found) continue;
    const login = c.author.login;
    if (!admins.has(login)) admins.set(login, isMaintainer(await forge.permission(forge.repo, login)));
    if (!admins.get(login)) continue;
    // A maintainer's review someone may have rewritten: it does not stand, and an older one does not take its place
    if (wasEdited(c)) return null;
    return { version: 1, slug, ...found.review, at: c.createdAt, by: login, comment: { id: c.id, url: c.url } };
  }
  return null;
}

/**
 * Posts a review as a comment on PR `n`, as the token's user, and records it in the audit table whatever the forge said.
 * Throws what the forge throws (a `ForgeError`), or a `ForgeError` of code `invalid` when the comment would be too long.
 * @param {import('./forge.js').Forge} forge
 * @param {number} n
 * @param {string} slug
 * @param {Review} review a checked review (`validateReview`)
 * @param {{ login: string, record?: (entry: AuditEntry) => Promise<void> | void, carriedOver?: string }} who
 * @returns {Promise<FoundReview>}
 */
export async function postReview(forge, n, slug, review, { login, record, carriedOver }) {
  const target = `${forge.repo}#${n}`;
  const request = { slug, ...review, ...(carriedOver ? { migrated: carriedOver } : {}) };
  const audit = async (status, answer) => {
    if (!record) return;
    try {
      await record({ login, action: 'review', target, request, status, answer });
    } catch (err) {
      console.error(`[cornfield] the review of ${target} was posted but could not be written to the audit table: ${err.message}`);
    }
  };
  const body = reviewComment(slug, review, { login, carriedOver });
  try {
    if (body.length > MAX_COMMENT_CHARS) throw new ForgeError(`That review is too long for a comment (${body.length} characters, at most ${MAX_COMMENT_CHARS}); shorten the note or send fewer edits.`, { code: 'invalid' });
    const comment = await forge.comment(n, body);
    await audit(201, { comment: comment.id, url: comment.url });
    return { version: 1, slug, ...review, at: comment.createdAt, by: login, comment: { id: comment.id, url: comment.url } };
  } catch (err) {
    await audit(err instanceof ForgeError ? err.status : null, { error: err instanceof ForgeError ? err.message : String((err && err.message) || err) });
    throw err;
  }
}

// ---------------------------------------------------------------------------
//  Stage 1 reviews, once
// ---------------------------------------------------------------------------

/** What Stage 1 left: `<dataDir>/reviews/<source>/<slug>.review.json` files that are plain files */
function stage1Files(dataDir) {
  const out = [];
  const base = path.join(dataDir, 'reviews');
  let sources = [];
  try {
    sources = fs.readdirSync(base);
  } catch {
    return out; // nothing was ever kept here: the usual case
  }
  for (const dir of sources) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(base, dir));
    } catch { continue; }
    for (const name of names) {
      const m = /^(.+)\.review\.json$/.exec(name);
      if (!m || !PROPOSAL_FILE.test(`${m[1]}.json`)) continue;
      const file = path.join(base, dir, name);
      try {
        if (!fs.lstatSync(file).isFile()) continue;
      } catch { continue; }
      try {
        const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
        const checked = isObject(kept) && kept.version === 1 ? validateReview({ verdict: kept.verdict, note: kept.note, edits: kept.edits }) : null;
        out.push({ slug: m[1], file, review: checked && checked.ok ? checked.value : null, at: typeof kept?.at === 'string' ? kept.at : '' });
      } catch {
        out.push({ slug: m[1], file, review: null, at: '' }); // garbled: marked too, so it is not looked at again
      }
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/** One run at a time per data folder, so two menu opens do not post twice */
const running = new Map();

/**
 * Offers each Stage 1 review in the data folder as a comment, once. A file is posted on the one open spec PR that holds
 * its slug; with none, or several, it waits for a run that finds exactly one. It is not posted when the PR already has an
 * admin review of that slug (a newer decision is not to be overwritten by an older one). Each file that was posted,
 * superseded, or is not a review is renamed to `<name>.migrated`, so a second run finds nothing to do. Never throws: a forge
 * that cannot answer leaves the file for next time.
 * @param {{ forge: import('./forge.js').Forge, dataDir: string, entries: { slug: string, pull: { number: number } }[], login: string, record?: (entry: AuditEntry) => Promise<void> | void }} args
 * @returns {Promise<{ posted: string[], superseded: string[], skipped: string[] }>}
 */
export function migrateStage1Reviews(args) {
  const key = path.resolve(args.dataDir);
  if (!running.has(key)) running.set(key, run(args).finally(() => running.delete(key)));
  return running.get(key);
}

async function run({ forge, dataDir, entries, login, record }) {
  const result = { posted: [], superseded: [], skipped: [] };
  const mark = (file) => {
    try {
      fs.renameSync(file, `${file}.migrated`);
    } catch (err) {
      console.error(`[cornfield] ${file} could not be marked as migrated: ${err.message}`);
    }
  };
  for (const kept of stage1Files(dataDir)) {
    if (!kept.review) {
      mark(kept.file);
      result.skipped.push(kept.file);
      continue;
    }
    const holders = entries.filter((e) => e.slug === kept.slug);
    if (holders.length !== 1) continue;
    const n = holders[0].pull.number;
    try {
      if (await latestReview(forge, n, kept.slug)) {
        mark(kept.file);
        result.superseded.push(kept.file);
        continue;
      }
      await postReview(forge, n, kept.slug, kept.review, { login, record, carriedOver: /^\d{4}-\d{2}-\d{2}/.exec(kept.at)?.[0] });
      mark(kept.file);
      result.posted.push(kept.file);
    } catch (err) {
      console.error(`[cornfield] the Stage 1 review of ${kept.slug} was not carried over yet: ${err.message}`);
    }
  }
  return result;
}
