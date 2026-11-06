/**
 * @module server/review-tokens
 *
 * API tokens: what a maintainer hands a script or a chat bot so it can Approve or Send back a proposal through
 * `POST /api/reviews` (server/review-api.js), or ask for an agent run through `POST /api/agent-requests`
 * (server/agent-api.js). The store over the `review_tokens` table of `cornfield.db` (server/db.js); nothing here knows
 * about HTTP.
 *
 *   - **A token has a scope,** `review`, `agent` or `runner`, and is good for the one API its scope names; each API refuses the
 *     others' tokens (403) and says so. One store serves both, so hashing, expiry, revoking, `last_used` and the limits are written
 *     once and cannot drift. A review token is `cf_rt_…`, an agent token `cf_at_…` and a runner token `cf_nt_…`, so a leaked one is told apart on
 *     sight (and by a secret scanner). Rows from before scopes existed are review tokens.
 *   - A token is its prefix and 32 random bytes in base64url. It is shown once, when it is made; only its SHA-256 is
 *     kept. A presented token is found by the hash of what was presented (an indexed equality on a hash of a 256-bit
 *     secret, so there is no secret-dependent comparison to time); the token itself is never stored, logged or
 *     returned again.
 *   - It belongs to the maintainer who made it (their forge user id and login), has a label they chose (the review
 *     comment names it), and expires: 30 days unless asked, 90 at most.
 *   - It can be revoked, by its owner, at once and for good. `last_used` says when it was last presented while valid.
 *   - What a token is worth is not kept in the row: the owner's maintainer status is asked of the forge on every call
 *     (server/submit-review.js), so a token of someone who is demoted stops working with no row changed.
 *
 * Times are ISO strings, as everywhere in the file; `now` is milliseconds and is passed in, so tests need no clock.
 *
 * @typedef {'review' | 'agent' | 'runner'} TokenScope
 * @typedef {{ id: number, user_id: string, login: string, label: string, scope: TokenScope, created_at: string, expires_at: string, revoked_at: string | null, last_used: string | null }} TokenRow
 * @typedef {'active' | 'expired' | 'revoked' | 'wrong-scope'} TokenState  `wrong-scope` only from `findToken` asked for a scope
 */

import { createHash, randomBytes } from 'node:crypto';

/** The scopes a token may have, and what each one's tokens start with, so a leaked one is recognised (by a secret scanner too) */
export const SCOPES = Object.freeze(['review', 'agent', 'runner']);
export const PREFIXES = Object.freeze({ review: 'cf_rt_', agent: 'cf_at_', runner: 'cf_nt_' });
/** What a review token starts with (the original, kept for the callers that always had it) */
export const TOKEN_PREFIX = PREFIXES.review;
/** Random bytes in a token */
export const TOKEN_BYTES = 32;
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 90;
/** Live tokens one maintainer may hold at once */
export const MAX_ACTIVE = 20;
export const MAX_LABEL = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A token as presented: the prefix and base64url (43 characters for 32 bytes); anything else is not one */
const TOKEN_SHAPE = /^cf_(?:rt|at|nt)_[A-Za-z0-9_-]{43,128}$/;
/** A label is words: letters, digits, spaces and a little punctuation. No backtick, no @, no newline: the comment quotes it */
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ._:/()-]*$/u;
const COLUMNS = 'id, user_id, login, label, scope, created_at, expires_at, revoked_at, last_used';

/**
 * Who acted when a runner token did: the runner (the token's label), with the maintainer who minted the token kept apart as `mintedBy`.
 * A runner token does not act as its owner, so the timeline and the audit name the runner (issue #105).
 * @typedef {{ kind: 'runner', label: string, tokenId?: number, mintedBy?: { login: string, userId: string } }} RunnerBy
 * @param {{ id?: number, label: string, mintedBy?: { login: string, userId: string } }} token
 * @returns {RunnerBy}
 */
export function runnerBy(token) {
  return { kind: 'runner', label: token.label, ...(token.id !== undefined ? { tokenId: token.id } : {}), ...(token.mintedBy ? { mintedBy: token.mintedBy } : {}) };
}

/** The token a runner call carries from here on: its id and label, and the maintainer who minted it */
export const runnerTokenOf = (row) => ({ id: row.id, label: row.label, mintedBy: { login: row.login, userId: String(row.user_id) } });

/**
 * `by` as the TEXT columns keep it: a login stays plain text (the shape every older row has), a runner is JSON. A login never starts with `{`.
 * @param {string | RunnerBy | null | undefined} by
 * @returns {string | null}
 */
export function byToText(by) {
  if (by == null || by === '') return null;
  return typeof by === 'string' ? by : JSON.stringify(by);
}

/**
 * `by` as it was kept: the runner object, or the plain login of an older row (or null). Text that only looks like JSON is a plain string.
 * @param {string | null | undefined} text
 * @returns {string | RunnerBy | null}
 */
export function byFromText(text) {
  if (typeof text !== 'string' || text === '') return null;
  if (text.startsWith('{')) {
    try {
      const v = JSON.parse(text);
      if (v && v.kind === 'runner' && typeof v.label === 'string') return v;
    } catch { /* plain text */ }
  }
  return text;
}

/** The name `by` is shown as: a runner's label, else the login as it is */
export function byLabel(by) {
  return by && typeof by === 'object' ? by.label : by ?? null;
}

const iso = (ms) => new Date(ms).toISOString();

/** The SHA-256 of a token, as hex: what the table keeps */
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** Which scope a presented token's shape names (by its prefix; the row's `scope` is what counts), or null when it is not shaped like one of ours */
export function scopeOfShape(token) {
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return null;
  return /** @type {TokenScope} */ (Object.keys(PREFIXES).find((k) => token.startsWith(PREFIXES[k])) ?? null);
}

/**
 * The token a request presents: the value of `Authorization: Bearer <token>`, or null when there is none, or it is
 * not shaped like one of ours (either scope's; which API it is good for is the row's `scope`) (the scheme is matched in any case, as RFC 9110 says).
 * @param {string | string[] | undefined} header
 * @returns {string | null}
 */
export function bearerOf(header) {
  if (typeof header !== 'string') return null;
  const m = /^bearer[ \t]+(\S+)$/i.exec(header.trim());
  return m && TOKEN_SHAPE.test(m[1]) ? m[1] : null;
}

/**
 * What is wrong with a label, in words, or null.
 * @param {unknown} label
 */
export function labelProblem(label) {
  if (typeof label !== 'string' || !label.trim()) return 'Give the token a label: what will use it, like "chat bot".';
  if (label.trim() !== label) return 'A label does not start or end with a space.';
  if (label.length > MAX_LABEL) return `A label is at most ${MAX_LABEL} characters.`;
  if (!LABEL.test(label)) return 'A label is letters, digits, spaces and . _ : / ( ) - only.';
  return null;
}

/**
 * How many days a token lasts, from what was asked: `DEFAULT_DAYS` when nothing was. Throws a `RangeError` in words.
 * @param {unknown} days
 */
export function daysOf(days) {
  if (days === undefined || days === null) return DEFAULT_DAYS;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new RangeError(`A token lasts 1 to ${MAX_DAYS} days.`);
  return days;
}

/**
 * Whether a row is usable at `now`.
 * @param {TokenRow} row
 * @param {number} now
 * @returns {TokenState}
 */
export function stateOf(row, now) {
  if (row.revoked_at) return 'revoked';
  return Date.parse(row.expires_at) <= now ? 'expired' : 'active';
}

/**
 * Makes a token for `owner`. The token is in the answer once; the table keeps its hash. Throws a `RangeError` in words
 * for a label or a number of days that is not allowed, or when the owner holds `MAX_ACTIVE` live tokens already.
 * Tokens that ended (expired or revoked) more than `MAX_DAYS` days ago are dropped on the way.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ userId: string, login: string, label: string, days?: number, scope?: TokenScope }} owner `scope`: `review` unless said
 * @param {number} now
 * @returns {{ token: string, row: TokenRow }}
 */
export function mintToken(db, { userId, login, label, days, scope = 'review' }, now) {
  if (!SCOPES.includes(scope)) throw new RangeError(`A token's scope is one of ${SCOPES.join(', ')}.`);
  const problem = labelProblem(label);
  if (problem) throw new RangeError(problem);
  const lasts = daysOf(days);
  const nowIso = iso(now);
  db.prepare('DELETE FROM review_tokens WHERE COALESCE(revoked_at, expires_at) <= ?').run(iso(now - MAX_DAYS * DAY_MS));
  const live = /** @type {{ n: number }} */ (db.prepare('SELECT COUNT(*) AS n FROM review_tokens WHERE user_id = ? AND scope = ? AND revoked_at IS NULL AND expires_at > ?').get(String(userId), scope, nowIso)).n;
  if (live >= MAX_ACTIVE) throw new RangeError(`You hold ${MAX_ACTIVE} live ${scope === 'review' ? '' : `${scope} `}tokens; revoke one you do not use before making another.`);
  const token = `${PREFIXES[scope]}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  const id = Number(db.prepare('INSERT INTO review_tokens (token_hash, user_id, login, label, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(hashToken(token), String(userId), login, label, scope, nowIso, iso(now + lasts * DAY_MS)).lastInsertRowid);
  return { token, row: /** @type {TokenRow} */ (db.prepare(`SELECT ${COLUMNS} FROM review_tokens WHERE id = ?`).get(id)) };
}

/**
 * The row a presented token names, with whether it is usable, or null when no token has that hash.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} token what was presented
 * @param {number} now
 * @returns {{ row: TokenRow, state: TokenState } | null}
 */
export function findToken(db, token, now, scope) {
  const row = /** @type {TokenRow | undefined} */ (db.prepare(`SELECT ${COLUMNS} FROM review_tokens WHERE token_hash = ?`).get(hashToken(token)));
  if (!row) return null;
  // The scope is part of the lookup, not of each route: a token found for another API, or whose prefix is not its scope's, is no token here
  if (scope !== undefined && (row.scope !== scope || !String(token).startsWith(PREFIXES[row.scope]))) return { row, state: /** @type {const} */ ('wrong-scope') };
  return { row, state: stateOf(row, now) };
}

/** Notes that a token was presented (and valid) just now */
export function touchToken(db, id, now) {
  db.prepare('UPDATE review_tokens SET last_used = ? WHERE id = ?').run(iso(now), id);
}

/**
 * An owner's tokens of one scope (all of them when none is named), newest first, each with its state. Never the hash, never the token.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} userId
 * @param {number} now
 * @param {TokenScope} [scope]
 * @returns {(TokenRow & { state: TokenState })[]}
 */
export function listTokens(db, userId, now, scope) {
  return /** @type {TokenRow[]} */ (scope
    ? db.prepare(`SELECT ${COLUMNS} FROM review_tokens WHERE user_id = ? AND scope = ? ORDER BY id DESC`).all(String(userId), scope)
    : db.prepare(`SELECT ${COLUMNS} FROM review_tokens WHERE user_id = ? ORDER BY id DESC`).all(String(userId)))
    .map((row) => ({ ...row, state: stateOf(row, now) }));
}

/**
 * Revokes every live token of an owner, of every scope (review, agent, runner): what is done when cornfield learns they no longer maintain the
 * repo. A token revoked already keeps its first time. Answers how many were revoked.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} userId
 * @param {number} now
 */
export function revokeOwnerTokens(db, userId, now) {
  return Number(db.prepare('UPDATE review_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(iso(now), String(userId)).changes);
}

/**
 * Revokes one of an owner's tokens, for good. Another owner's id is no token to them. Revoking a token that is
 * revoked already keeps the first time.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} userId
 * @param {number} id
 * @param {number} now
 * @param {TokenScope} [scope] when named, a token of the other scope is no token to them here
 * @returns {(TokenRow & { state: TokenState }) | null} the token as it is now, or null when the owner has none by that id
 */
export function revokeToken(db, userId, id, now, scope) {
  const row = /** @type {TokenRow | undefined} */ (db.prepare(`SELECT ${COLUMNS} FROM review_tokens WHERE id = ? AND user_id = ?`).get(id, String(userId)));
  if (!row || (scope && row.scope !== scope)) return null;
  if (!row.revoked_at) db.prepare('UPDATE review_tokens SET revoked_at = ? WHERE id = ?').run(iso(now), id);
  const after = /** @type {TokenRow} */ (db.prepare(`SELECT ${COLUMNS} FROM review_tokens WHERE id = ?`).get(id));
  return { ...after, state: stateOf(after, now) };
}
