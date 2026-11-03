// @vitest-environment happy-dom
/**
 * Review tokens in a page (explorer/review-tokens.js): the header button only for somebody signed in, the dialog that
 * opens over the map, a token made (shown once, in a read-only field, never in the live region and gone when the dialog
 * closes), the list, a revoke, a refusal in words, and the focus kept in the dialog. Driven through the page's own markup
 * (explorer/index.html) with a fake server behind `fetch`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { initReviewTokens, openTokens, closeTokens, resetReviewTokensForTests } from '../../explorer/review-tokens.js';

const EXPLORER = path.resolve(__dirname, '../../explorer');
const page = fs.readFileSync(path.join(EXPLORER, 'index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const css = ['explorer.css', 'house.css'].map((f) => fs.readFileSync(path.join(EXPLORER, f), 'utf8')).join('\n');

const $ = (id) => document.getElementById(id);
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const key = (el, k, opts = {}) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }); el.dispatchEvent(e); return e; };
const submit = () => $('tokens-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const SECRET = `cf_rt_${'Z'.repeat(43)}`;
const CONFIG = { forge: { type: 'github', repo: 'owner/name' }, signIn: { login: 'maintainer-one' } };

let tokens;
let calls;
let refuse;

const token = (id, label, extra = {}) => ({ id, login: 'maintainer-one', label, created: new Date(NOW).toISOString(), expires: new Date(NOW + 30 * 86400_000).toISOString(), revoked: null, lastUsed: null, state: 'active', ...extra });

function server() {
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : null });
    const reply = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (refuse) return reply(refuse.status, refuse.body);
    if (method === 'GET') return reply(200, { ok: true, tokens, defaultDays: 30, maxDays: 90, maxActive: 20 });
    if (url === '/api/review-tokens') {
      const made = token(tokens.length + 1, JSON.parse(init.body).label);
      tokens = [made, ...tokens];
      return reply(201, { ok: true, secret: SECRET, token: made });
    }
    const id = Number(/\/(\d+)\/revoke$/.exec(url)[1]);
    tokens = tokens.map((t) => (t.id === id ? { ...t, state: 'revoked', revoked: new Date(NOW).toISOString() } : t));
    return reply(200, { ok: true, token: tokens.find((t) => t.id === id) });
  }));
}

function mount(config = CONFIG) {
  document.head.innerHTML = `<title>cornfield</title><style>${css}</style>`;
  document.body.innerHTML = body;
  resetReviewTokensForTests(() => NOW);
  return initReviewTokens(config, { clock: () => NOW });
}

beforeEach(() => { tokens = []; calls = []; refuse = null; server(); });
afterEach(() => { resetReviewTokensForTests(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('the button', () => {
  it('is there for somebody signed in to a forge, and nobody else', () => {
    expect(mount()).toBe(true);
    expect($('tokens-btn').hidden).toBe(false);
    expect(mount({ forge: { type: 'github', repo: 'o/n' }, signIn: false })).toBe(false);
    expect($('tokens-btn').hidden).toBe(true);
    expect(mount({ forge: null, signIn: { login: 'x' } })).toBe(false);
    expect($('tokens-dialog').hidden).toBe(true);
  });
});

describe('the dialog', () => {
  it('opens over the map with the list read from the server, the focus in it, and closes on Escape with the focus back', async () => {
    tokens = [token(2, 'chat bot', { lastUsed: new Date(NOW - 3 * 60_000).toISOString() }), token(1, 'old', { state: 'revoked', revoked: new Date(NOW - 3600_000).toISOString() })];
    mount();
    $('tokens-btn').click();
    await settle();
    expect($('tokens-dialog').hidden).toBe(false);
    expect($('tokens-btn').getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe($('tokens-title'));
    const items = [...document.querySelectorAll('#tokens-list li')];
    expect(items.map((li) => li.textContent.replace(/\s+/g, ' ').trim())).toEqual(['chat bot Expires in 30 days · Last used 3 minutes ago Revoke', 'old Revoked 1 hour ago · Never used']);
    expect(calls[0]).toMatchObject({ method: 'GET', url: '/api/review-tokens' });
    expect($('tokens-dialog').querySelector('[role="dialog"]').getAttribute('aria-modal')).toBe('true');
    key($('tokens-dialog'), 'Escape');
    expect($('tokens-dialog').hidden).toBe(true);
    expect(document.activeElement).toBe($('tokens-btn'));
  });

  it('says there are no tokens yet', async () => {
    mount();
    openTokens();
    await settle();
    expect($('tokens-list').textContent).toContain('no review tokens yet');
  });

  it('keeps the focus inside while it is open: Tab wraps, and a focus that lands outside is brought back', async () => {
    mount();
    openTokens();
    await settle();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe($('tokens-title'));
    const last = document.querySelector('[data-tokens-close]');
    last.focus();
    const e = key($('tokens-dialog'), 'Tab');
    expect(e.defaultPrevented).toBe(true);
    expect($('tokens-dialog').contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(last);
  });
});

describe('making a token', () => {
  it('sends the label and the days, shows the secret once in a read-only field, never announces it, and drops it when the dialog closes', async () => {
    mount();
    openTokens();
    await settle();
    $('tokens-label').value = 'chat bot';
    $('tokens-days').value = '7';
    submit();
    await settle(60);
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/review-tokens', body: { label: 'chat bot', days: 7 } });
    expect($('tokens-secret').hidden).toBe(false);
    expect($('tokens-secret-value').value).toBe(SECRET);
    expect($('tokens-secret-value').readOnly).toBe(true);
    expect($('tokens-msg').textContent).toMatch(/Made the token "chat bot"/);
    expect(document.body.textContent).not.toContain(SECRET); // an input's value is not text: the secret is not in the page's words
    expect($('map-announcer')?.textContent ?? '').not.toContain(SECRET);
    expect($('tokens-list').textContent).toContain('chat bot'); // listed again, without a secret
    expect($('tokens-label').value).toBe('');
    closeTokens();
    expect($('tokens-secret-value').value).toBe('');
    expect($('tokens-secret').hidden).toBe(true);
    expect(document.documentElement.outerHTML).not.toContain(SECRET);
  });

  it('refuses a label that is not words before it asks the server, in words', async () => {
    mount();
    openTokens();
    await settle();
    const before = calls.length;
    $('tokens-label').value = '   ';
    submit();
    await settle();
    expect($('tokens-msg').hidden).toBe(false);
    expect($('tokens-msg').textContent).toMatch(/label/);
    expect(calls.length).toBe(before);
  });

  it('says what the server refused, in its words', async () => {
    mount();
    openTokens();
    await settle();
    refuse = { status: 409, body: { ok: false, error: 'You hold 20 live tokens; revoke one you do not use before making another.' } };
    $('tokens-label').value = 'one more';
    submit();
    await settle(60);
    expect($('tokens-msg').textContent).toMatch(/20 live tokens/);
    expect($('tokens-secret').hidden).toBe(true);
  });

  it('says the sign-in has ended on a 401', async () => {
    mount();
    openTokens();
    await settle();
    refuse = { status: 401, body: { ok: false, error: 'Sign in first.' } };
    $('tokens-label').value = 'x';
    submit();
    await settle(60);
    expect($('tokens-msg').textContent).toMatch(/sign-in has ended/);
  });
});

describe('revoking a token', () => {
  it('posts to its revoke address, says so, and lists it as revoked with no button', async () => {
    tokens = [token(2, 'chat bot'), token(1, 'ci')];
    mount();
    openTokens();
    await settle();
    const btn = document.querySelector('[data-revoke="2"]');
    expect(btn.getAttribute('aria-label')).toBe('Revoke chat bot');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle(60);
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/review-tokens/2/revoke', body: {} });
    expect($('tokens-msg').textContent).toMatch(/Revoked "chat bot"/);
    expect(document.querySelector('[data-revoke="2"]')).toBeNull();
    expect(document.querySelector('[data-revoke="1"]')).not.toBeNull();
  });

  it('escapes a label: it is words, never markup', async () => {
    tokens = [token(1, '<img src=x onerror="window.pwned=1">')];
    mount();
    openTokens();
    await settle();
    expect($('tokens-list').querySelector('img')).toBeNull();
    expect($('tokens-list').textContent).toContain('<img src=x');
  });
});
