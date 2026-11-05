/**
 * @vitest-environment node
 *
 * The pure half of the review tokens panel (explorer/review-tokens-model.js): what the form sends, how a token reads in
 * the list, and what a refusal says in plain words.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS module, no declarations
import { TOKENS_URL, SCOPES, introWords, tokensUrl, makeRequest, revokeUrl, tokenLine, errorWords } from '../../explorer/review-tokens-model.js';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (ms) => new Date(NOW + ms).toISOString();

describe('makeRequest', () => {
  it('sends the label, and the days only when they were given', () => {
    expect(makeRequest('chat bot', '')).toEqual({ ok: true, body: { label: 'chat bot' } });
    expect(makeRequest('  chat bot ', ' 7 ')).toEqual({ ok: true, body: { label: 'chat bot', days: 7 } });
    expect(makeRequest('ci', '90')).toEqual({ ok: true, body: { label: 'ci', days: 90 } });
  });
  it('says why it cannot send yet, in words', () => {
    for (const label of ['', '   ', undefined, 'a`b', '@name', 'x'.repeat(61)]) expect(makeRequest(label, '').ok, String(label)).toBe(false);
    for (const days of ['0', '91', '1.5', 'x', '-3', '1000']) expect(makeRequest('ok', days), days).toEqual({ ok: false, error: 'A token lasts 1 to 90 days.' });
    expect(makeRequest('', '').error).toMatch(/label/);
  });
});

describe('tokenLine', () => {
  const base = { id: 3, label: 'chat bot', created: at(-DAY), expires: at(12 * DAY + 3600_000), revoked: null, lastUsed: null, state: 'active' };
  it('reads an active token: when it ends and that it was never used', () => {
    expect(tokenLine(base, NOW)).toEqual({ id: 3, label: 'chat bot', state: 'active', status: 'Expires in 12 days', used: 'Never used', canRevoke: true });
  });
  it('says when it was last used', () => {
    expect(tokenLine({ ...base, lastUsed: at(-5 * 60_000) }, NOW).used).toBe('Last used 5 minutes ago');
  });
  it('counts the hours and the last hour', () => {
    expect(tokenLine({ ...base, expires: at(5 * 3600_000 + 5) }, NOW).status).toBe('Expires in 5 hours');
    expect(tokenLine({ ...base, expires: at(60_000) }, NOW).status).toBe('Expires in under an hour');
  });
  it('reads an expired and a revoked token; a revoked one cannot be revoked again', () => {
    expect(tokenLine({ ...base, state: 'expired', expires: at(-2 * DAY) }, NOW)).toMatchObject({ state: 'expired', status: 'Expired 2 days ago', canRevoke: true });
    expect(tokenLine({ ...base, state: 'revoked', revoked: at(-3600_000) }, NOW)).toMatchObject({ state: 'revoked', status: 'Revoked 1 hour ago', canRevoke: false });
  });
  it('is never a negative for a time that does not read', () => {
    expect(tokenLine({ ...base, expires: 'soon' }, NOW).status).toBe('Expires');
    expect(tokenLine({ ...base, state: 'whatever' }, NOW).state).toBe('active');
  });
});

describe('the addresses and the words of a refusal', () => {
  it('names the routes of the server', () => {
    expect(TOKENS_URL).toBe('/api/review-tokens');
    expect(revokeUrl(12)).toBe('/api/review-tokens/12/revoke');
    expect(revokeUrl('../x')).toBe('/api/review-tokens/..%2Fx/revoke');
  });
  it('says the server\'s own words, or plain ones', () => {
    expect(errorWords(null, null)).toMatch(/could not be reached/);
    expect(errorWords(401, { error: 'x' })).toMatch(/sign-in has ended/);
    expect(errorWords(409, { error: 'You hold 20 live tokens.' })).toBe('You hold 20 live tokens.');
    expect(errorWords(403, null)).toMatch(/maintainers/);
    expect(errorWords(429, {})).toMatch(/Wait/);
    expect(errorWords(500, null)).toMatch(/did not work/);
  });
});

describe('the three kinds of token', () => {
  it('each have an address, a line in the picker and an intro', () => {
    expect(SCOPES.map(([scope]) => scope)).toEqual(['review', 'agent', 'runner']);
    expect(tokensUrl('runner')).toBe('/api/runner-tokens');
    expect(tokensUrl('agent')).toBe('/api/agent-tokens');
    expect(tokensUrl('review')).toBe(TOKENS_URL);
    expect(revokeUrl(3, 'runner')).toBe('/api/runner-tokens/3/revoke');
    expect(introWords('runner')).toMatch(/claim/);
    expect(introWords('agent')).toMatch(/agent-requests/);
    expect(introWords('review')).toMatch(/api\/reviews/);
  });
});
