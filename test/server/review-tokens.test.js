/**
 * @vitest-environment node
 *
 * The review token store (server/review-tokens.js) over a real SQLite file in a temporary folder: a token is made once
 * (`cf_rt_` and 32 random bytes), only its SHA-256 is kept, it is found by that hash, it expires (30 days, 90 at most),
 * it can be revoked by its owner and by nobody else, and nothing a list returns holds a secret.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
// @ts-expect-error plain JS module, no declarations
import { openStore } from '../../server/db.js';
// @ts-expect-error plain JS module, no declarations
import { TOKEN_PREFIX, DEFAULT_DAYS, MAX_DAYS, MAX_ACTIVE, MAX_LABEL, hashToken, bearerOf, labelProblem, daysOf, stateOf, mintToken, findToken, touchToken, listTokens, revokeToken, runnerBy, runnerTokenOf, byToText, byFromText, byLabel } from '../../server/review-tokens.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-19T12:00:00Z');
const owner = { userId: '1001', login: 'maintainer-one', label: 'chat bot' };

describe('review tokens', () => {
  let tmp;
  let db;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-tokens-'));
    db = openStore(tmp);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('mint', () => {
    it('makes cf_rt_ and 32 random bytes, once: the table keeps their SHA-256 and nothing else of the secret', () => {
      const { token, row } = mintToken(db, owner, T0);
      expect(token).toMatch(/^cf_rt_[A-Za-z0-9_-]{43}$/);
      expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
      expect(Buffer.from(token.slice(TOKEN_PREFIX.length), 'base64url')).toHaveLength(32);
      const stored = db.prepare('SELECT * FROM review_tokens WHERE id = ?').get(row.id);
      expect(stored.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
      expect(stored.token_hash).toBe(hashToken(token));
      expect(Object.values(stored).some((v) => typeof v === 'string' && v.includes(token.slice(TOKEN_PREFIX.length)))).toBe(false);
      expect(row).toEqual({ id: row.id, user_id: '1001', login: 'maintainer-one', label: 'chat bot', scope: 'review', created_at: new Date(T0).toISOString(), expires_at: new Date(T0 + 30 * DAY).toISOString(), revoked_at: null, last_used: null });
      expect(Object.keys(row)).not.toContain('token_hash');
    });

    it('never makes the same token twice', () => {
      const seen = new Set();
      for (let i = 0; i < 20; i++) seen.add(mintToken(db, { ...owner, label: `bot ${i}` }, T0).token);
      expect(seen.size).toBe(20);
    });

    it('lasts 30 days unless asked, and 90 at most; a day is a whole number from 1', () => {
      expect(DEFAULT_DAYS).toBe(30);
      expect(MAX_DAYS).toBe(90);
      expect(mintToken(db, owner, T0).row.expires_at).toBe(new Date(T0 + 30 * DAY).toISOString());
      expect(mintToken(db, { ...owner, days: 1 }, T0).row.expires_at).toBe(new Date(T0 + DAY).toISOString());
      expect(mintToken(db, { ...owner, days: 90 }, T0).row.expires_at).toBe(new Date(T0 + 90 * DAY).toISOString());
      for (const days of [0, 91, -3, 1.5, '30', NaN, Infinity]) expect(() => mintToken(db, { ...owner, days }, T0), String(days)).toThrow(RangeError);
      expect(daysOf(undefined)).toBe(30);
      expect(daysOf(null)).toBe(30);
    });

    it('needs a label of words: letters, digits, spaces and a little punctuation, at most 60', () => {
      expect(labelProblem('chat bot')).toBeNull();
      expect(labelProblem('CI (staging) v2.1: é中')).toBeNull();
      expect(labelProblem('x'.repeat(MAX_LABEL))).toBeNull();
      for (const bad of ['', '  ', ' lead', 'trail ', 'a`b', '@name', 'a\nb', 'a‮b', '<b>', 'a|b', 'x'.repeat(MAX_LABEL + 1), undefined, null, 5, {}]) expect(labelProblem(bad), String(bad)).toMatch(/\S/);
      expect(() => mintToken(db, { ...owner, label: 'a`b' }, T0)).toThrow(RangeError);
    });

    it('holds an owner to 20 live tokens; an expired or revoked one does not count', () => {
      const made = [];
      for (let i = 0; i < MAX_ACTIVE; i++) made.push(mintToken(db, { ...owner, label: `bot ${i}` }, T0));
      expect(() => mintToken(db, owner, T0)).toThrow(/20 live tokens/);
      mintToken(db, { ...owner, userId: '1003', login: 'maintainer-two' }, T0); // another owner has their own count
      revokeToken(db, '1001', made[0].row.id, T0);
      expect(() => mintToken(db, owner, T0)).not.toThrow();
      expect(() => mintToken(db, owner, T0 + 31 * DAY)).not.toThrow(); // the rest have expired by then
    });

    it('drops tokens that ended more than 90 days ago, and only those', () => {
      const old = mintToken(db, { ...owner, label: 'old', days: 1 }, T0);
      const revoked = mintToken(db, { ...owner, label: 'revoked' }, T0);
      revokeToken(db, '1001', revoked.row.id, T0 + DAY);
      const live = mintToken(db, { ...owner, label: 'live', days: 90 }, T0);
      mintToken(db, { ...owner, label: 'new' }, T0 + 95 * DAY);
      const ids = db.prepare('SELECT id FROM review_tokens').all().map((r) => r.id);
      expect(ids).not.toContain(old.row.id);
      expect(ids).not.toContain(revoked.row.id);
      expect(ids).toContain(live.row.id);
    });
  });

  describe('find', () => {
    it('finds a token by the hash of what was presented: active, with its owner', () => {
      const { token, row } = mintToken(db, owner, T0);
      const found = findToken(db, token, T0 + 1000);
      expect(found).toEqual({ row, state: 'active' });
    });

    it('finds nothing for a token nobody holds, or one that differs by a character', () => {
      const { token } = mintToken(db, owner, T0);
      expect(findToken(db, `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, T0)).toBeNull();
      expect(findToken(db, TOKEN_PREFIX + 'A'.repeat(43), T0)).toBeNull();
      expect(findToken(db, '', T0)).toBeNull();
      expect(findToken(db, hashToken(token), T0)).toBeNull(); // the hash is not the token
    });

    it('says a token is expired from the moment it expires, not before', () => {
      const { token, row } = mintToken(db, { ...owner, days: 2 }, T0);
      expect(findToken(db, token, T0 + 2 * DAY - 1).state).toBe('active');
      expect(findToken(db, token, T0 + 2 * DAY).state).toBe('expired');
      expect(stateOf(row, T0 + 3 * DAY)).toBe('expired');
    });

    it('says a revoked token is revoked, even before it would have expired', () => {
      const { token, row } = mintToken(db, owner, T0);
      revokeToken(db, '1001', row.id, T0 + DAY);
      expect(findToken(db, token, T0 + DAY + 1).state).toBe('revoked');
      expect(findToken(db, token, T0 + 40 * DAY).state).toBe('revoked'); // revoked wins over expired
    });

    it('notes when a token was last used', () => {
      const { token, row } = mintToken(db, owner, T0);
      touchToken(db, row.id, T0 + 5000);
      expect(findToken(db, token, T0 + 6000).row.last_used).toBe(new Date(T0 + 5000).toISOString());
    });
  });

  describe('list and revoke', () => {
    it('lists an owner\'s tokens, newest first, with their state, and never a hash or a secret', () => {
      const a = mintToken(db, { ...owner, label: 'a', days: 1 }, T0);
      const b = mintToken(db, { ...owner, label: 'b' }, T0 + 1000);
      mintToken(db, { userId: '1003', login: 'maintainer-two', label: 'theirs' }, T0);
      const list = listTokens(db, '1001', T0 + 2 * DAY);
      expect(list.map((t) => [t.label, t.state])).toEqual([['b', 'active'], ['a', 'expired']]);
      const text = JSON.stringify(list);
      expect(text).not.toContain(a.token);
      expect(text).not.toContain(b.token);
      expect(text).not.toContain(hashToken(a.token));
      expect(text).not.toContain('token_hash');
      expect(listTokens(db, '9999', T0)).toEqual([]);
    });

    it('revokes an owner\'s own token for good, and keeps the first time when asked again', () => {
      const { row } = mintToken(db, owner, T0);
      const first = revokeToken(db, '1001', row.id, T0 + 1000);
      expect(first).toMatchObject({ id: row.id, state: 'revoked', revoked_at: new Date(T0 + 1000).toISOString() });
      expect(revokeToken(db, '1001', row.id, T0 + 9000).revoked_at).toBe(first.revoked_at);
    });

    it('does not revoke another owner\'s token, or one that is not there', () => {
      const { token, row } = mintToken(db, owner, T0);
      expect(revokeToken(db, '1003', row.id, T0)).toBeNull();
      expect(revokeToken(db, '1001', row.id + 100, T0)).toBeNull();
      expect(findToken(db, token, T0).state).toBe('active');
    });
  });

  describe('bearerOf', () => {
    const token = `${TOKEN_PREFIX}${'A'.repeat(43)}`;
    it('takes the token from an Authorization header, whatever the case of the scheme', () => {
      expect(bearerOf(`Bearer ${token}`)).toBe(token);
      expect(bearerOf(`bearer   ${token}`)).toBe(token);
      expect(bearerOf(`BEARER ${token} `)).toBe(token);
    });

    it('takes nothing that is not a token of ours', () => {
      for (const header of [undefined, '', 'Bearer', 'Bearer ', `Basic ${token}`, token, `Bearer ${token} extra`, 'Bearer cf_rt_short', `Bearer ${TOKEN_PREFIX}${'A'.repeat(200)}`, `Bearer ghp_${'A'.repeat(43)}`, `Bearer ${token}\nX: y`, ['Bearer x']]) {
        expect(bearerOf(header), String(header)).toBeNull();
      }
    });
  });
});

describe('the scope, at lookup', () => {
  it('answers wrong-scope for a token asked for as the other API\'s, or whose prefix is not its row\'s scope', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-scope-'));
    const db = openStore(dir);
    try {
      const T = Date.parse('2026-11-05T10:00:00Z');
      const owner = { userId: '1001', login: 'maintainer-one', label: 'bot' };
      const review = mintToken(db, { ...owner, scope: 'review' }, T).token;
      const agent = mintToken(db, { ...owner, label: 'agent bot', scope: 'agent' }, T).token;
      expect(findToken(db, review, T, 'review').state).toBe('active');
      expect(findToken(db, review, T, 'agent').state).toBe('wrong-scope');
      expect(findToken(db, agent, T, 'agent').state).toBe('active');
      expect(findToken(db, agent, T, 'review').state).toBe('wrong-scope');
      // A row whose scope was changed under it (not by cornfield) does not make a review token good for agents
      db.prepare("UPDATE review_tokens SET scope = 'agent' WHERE token_hash = ?").run(hashToken(review));
      expect(findToken(db, review, T, 'agent').state).toBe('wrong-scope');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('who a runner token acts as', () => {
  const row = { id: 7, user_id: 1001, login: 'maintainer-one', label: 'bucket-bot' };

  it('is the runner by its label, with the maintainer who minted the token kept apart', () => {
    expect(runnerBy(runnerTokenOf(row))).toEqual({ kind: 'runner', label: 'bucket-bot', tokenId: 7, mintedBy: { login: 'maintainer-one', userId: '1001' } });
  });

  it('is kept as JSON, and an older row (a plain login) reads as it was', () => {
    const by = runnerBy(runnerTokenOf(row));
    expect(byFromText(byToText(by))).toEqual(by);
    expect(byFromText('maintainer-one')).toBe('maintainer-one');
    expect(byFromText('{not json')).toBe('{not json');
    expect(byFromText(null)).toBe(null);
    expect(byToText('maintainer-one')).toBe('maintainer-one');
    expect(byLabel(by)).toBe('bucket-bot');
    expect(byLabel('maintainer-one')).toBe('maintainer-one');
  });
});
