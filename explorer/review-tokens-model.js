/**
 * @module explorer/review-tokens-model
 *
 * The pure half of the review tokens panel (spec 0002): no DOM, no `window`, no clock (the time is passed in).
 * review-tokens.js is the half that touches the page and the network; the words and the request are decided here so
 * they can be tested without a page.
 *
 *   TOKENS_URL         the server's address for them (server/review-api.js)
 *   makeRequest        what a new token's form sends: { label, days? }, or why it cannot be sent yet
 *   tokenLine          one token as the list shows it: its label, its state, when it ends, when it was last used
 *   revokeUrl          the address that revokes one
 *   errorWords         what a refusal of the server says, in plain words
 *
 * The server answers a list as `{ ok, tokens: [{ id, login, label, created, expires, revoked, lastUsed, state }], defaultDays, maxDays, maxActive }`
 * and a new token as `{ ok, secret, token }`: the secret is in that answer only.
 */

import { relativeTime } from './review-model.js';

export const TOKENS_URL = '/api/review-tokens';
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 90;
export const MAX_LABEL = 60;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ._:/()-]*$/u;

/** Tokens come in three scopes (server/review-tokens.js): `review` approves proposals, `agent` asks for agent runs, `runner` pulls and reports on them. Each has its own address. */
export const SCOPES = Object.freeze([['review', 'Review: approve or send back proposals'], ['agent', 'Agent: ask for agent runs'], ['runner', 'Runner: pull, claim and report on runs']]);
export const tokensUrl = (scope) => (scope === 'agent' ? '/api/agent-tokens' : scope === 'runner' ? '/api/runner-tokens' : TOKENS_URL);

/** What the dialog says a token of this scope is for */
export function introWords(scope) {
  if (scope === 'agent') return 'An agent token lets a script or a chat bot ask for an agent run as you (POST /api/agent-requests). It works while you are signed in here and still maintain the repo; it expires, and you can revoke it below.';
  if (scope === 'runner') return 'A runner token lets your own runner, wherever it runs, list the queued requests, claim one and report on it (GET /api/agent-requests, POST /api/agent-requests/<run>/claim, POST /api/runs/<run>). It reaches nothing else, and works until it expires or you revoke it below, even after you sign out.';
  return 'A review token lets a script or a chat bot approve or send back a proposal as you (POST /api/reviews). It works while you are signed in here and still maintain the repo; it expires, and you can revoke it below.';
}

/** The address that revokes token `id` */
export const revokeUrl = (id, scope = 'review') => `${tokensUrl(scope)}/${encodeURIComponent(String(id))}/revoke`;

/**
 * What the form sends: the label, and the days when they were given. The server checks everything again.
 * @param {string} label
 * @param {string} days what the field holds; empty is the default
 * @returns {{ ok: true, body: { label: string, days?: number } } | { ok: false, error: string }}
 */
export function makeRequest(label, days) {
  const text = typeof label === 'string' ? label.trim() : '';
  if (!text) return { ok: false, error: 'Give the token a label: what will use it, like "chat bot".' };
  if (text.length > MAX_LABEL) return { ok: false, error: `A label is at most ${MAX_LABEL} characters.` };
  if (!LABEL.test(text)) return { ok: false, error: 'A label is letters, digits, spaces and . _ : / ( ) - only.' };
  const d = typeof days === 'string' ? days.trim() : '';
  if (d === '') return { ok: true, body: { label: text } };
  if (!/^\d{1,3}$/.test(d) || Number(d) < 1 || Number(d) > MAX_DAYS) return { ok: false, error: `A token lasts 1 to ${MAX_DAYS} days.` };
  return { ok: true, body: { label: text, days: Number(d) } };
}

/** "in 12 days", "in 5 hours", "in under an hour", or "" for a time that does not read or is not ahead */
function untilWords(iso, nowMs) {
  const then = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(then) || !Number.isFinite(nowMs) || then <= nowMs) return '';
  const left = then - nowMs;
  if (left < HOUR) return 'in under an hour';
  if (left < DAY) { const h = Math.floor(left / HOUR); return `in ${h} hour${h === 1 ? '' : 's'}`; }
  const d = Math.floor(left / DAY);
  return `in ${d} day${d === 1 ? '' : 's'}`;
}

/**
 * One token as the list shows it.
 * @param {{ id: number, label: string, expires: string, revoked: string | null, lastUsed: string | null, state: string }} token
 * @param {number} nowMs
 * @returns {{ id: number, label: string, state: 'active' | 'expired' | 'revoked', status: string, used: string, canRevoke: boolean }}
 */
export function tokenLine(token, nowMs) {
  const state = token.state === 'revoked' || token.state === 'expired' ? token.state : 'active';
  const status = state === 'revoked' ? `Revoked ${relativeTime(token.revoked, nowMs)}`.trim()
    : state === 'expired' ? `Expired ${relativeTime(token.expires, nowMs)}`.trim()
      : `Expires ${untilWords(token.expires, nowMs)}`.trim();
  const used = token.lastUsed ? `Last used ${relativeTime(token.lastUsed, nowMs)}` : 'Never used';
  return { id: token.id, label: String(token.label), state, status, used, canRevoke: state !== 'revoked' };
}

/**
 * What a refusal says, in plain words: the server's own where it gave some.
 * @param {number | null} status null when the server could not be reached
 * @param {{ error?: string } | null} body
 */
export function errorWords(status, body) {
  if (status === null) return 'cornfield could not be reached. Try again in a moment.';
  if (status === 401) return 'Your sign-in has ended. Sign in again.';
  if (body && typeof body.error === 'string' && body.error) return body.error;
  if (status === 403) return 'Only the repo\'s maintainers can do that.';
  if (status === 429) return 'Too many tries. Wait a little.';
  return 'That did not work. Try again in a moment.';
}
