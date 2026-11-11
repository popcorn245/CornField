/**
 * @vitest-environment node
 *
 * The pages a visitor sees before the explorer (server/auth.js: sign-in, "ask a maintainer", failed, unchecked) wear the repo's theme and
 * brand like the explorer does, say what a proposal link was for, and reflect nothing unchecked. The look (the tokens, the sign-in
 * stylesheet, the theme, its fonts and the brand images) is served without a session; nothing else is. No real forge, app or token.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { createCornfieldServer } from '../../server/server.js';
// @ts-expect-error plain JS module, no declarations
import { proposalOf } from '../../server/auth.js';
// @ts-expect-error plain JS module, no declarations
import { loadConfig } from '../../core/config.js';
import { CORNFIELD, SAMPLE } from '../helpers.js';

const ENV = { CORNFIELD_GITHUB_CLIENT_ID: 'test-client-id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: 'x'.repeat(40) };
const RETRO = path.join(CORNFIELD, 'test', 'fixtures', 'themes', 'retro');

const get = (port, target, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: target, headers, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end();
});

describe('the sign-in pages wear the theme and the brand', () => {
  let dir;
  let server;
  let port;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-authpages-'));
    fs.cpSync(SAMPLE, dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'tools', 'cornfield'), { recursive: true });
    for (const f of ['theme.css', 'logo.svg', 'wordmark.svg']) fs.copyFileSync(path.join(RETRO, f), path.join(dir, 'tools', 'cornfield', f));
    // One image the theme names, and one beside it that it does not (a screenshot left in the folder)
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not a real image')]);
    for (const f of ['bg.png', 'private-shot.png']) fs.writeFileSync(path.join(dir, 'tools', 'cornfield', f), png);
    fs.appendFileSync(path.join(dir, 'tools', 'cornfield', 'theme.css'), '\n[data-corn="auth-page"] { background-image: url(theme/assets/bg.png); }\n');
    const config = await loadConfig(dir, { env: { CORNFIELD_DATA: path.join(dir, '.data') } });
    const retro = JSON.parse(fs.readFileSync(path.join(RETRO, 'config.json'), 'utf8'));
    Object.assign(config, retro, { forge: { type: 'github', url: 'http://127.0.0.1:9', repo: 'acme/home' }, publicUrl: 'http://127.0.0.1:3350' });
    server = createCornfieldServer(config, { env: ENV });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('links the tokens, the sign-in stylesheet, the fonts, the theme and the theme script, in the explorer\'s order, with hooks', async () => {
    const page = await get(port, '/', { accept: 'text/html' });
    expect(page.status).toBe(401);
    const b = page.body;
    const at = (s) => b.indexOf(s);
    expect(at('/explorer/tokens.css')).toBeGreaterThan(0);
    expect(at('/explorer/sign-in.css')).toBeGreaterThan(at('/explorer/tokens.css'));
    expect(at('fonts.googleapis.com')).toBeGreaterThan(at('/explorer/sign-in.css'));
    expect(at('href="/cornfield/theme.css"')).toBeGreaterThan(at('fonts.googleapis.com'));
    expect(at('/explorer/theme-boot.js')).toBeGreaterThan(at('/cornfield/theme.css'));
    expect(b).toContain('data-corn="auth-page"');
    expect(b).toContain('data-corn="auth-card"');
    expect(b).toContain('data-corn="brand-logo"');
    expect(b).toContain('src="/cornfield/brand/logo.svg"');
    expect(b).toContain('data-corn="brand-wordmark"');
    expect(b).toContain('alt="Arcade"');
    expect(b).toContain('data-corn-kind="primary"');
    expect(b).not.toContain('dev dashboard');
    expect(b).not.toContain('<style');
    expect(b).not.toMatch(/<script(?![^>]*\ssrc="\/explorer\/)/);
    expect(b).not.toContain('rel="manifest"');
    expect(page.headers['content-security-policy']).toMatch(/script-src 'self'(;|$)/);
    expect(page.headers['content-security-policy']).toContain('font-src');
  });

  it('serves the look without a session, and only the look', async () => {
    for (const [p, type] of [['/explorer/tokens.css', /css/], ['/explorer/sign-in.css', /css/], ['/explorer/theme-boot.js', /javascript/], ['/cornfield/theme.css', /css/], ['/cornfield/brand/logo.svg', /svg/]]) {
      const r = await get(port, p);
      expect([p, r.status]).toEqual([p, 200]);
      expect(r.headers['content-type']).toMatch(type);
    }
    // Everything else of the explorer, the data and the config stay behind the sign-in
    for (const p of ['/explorer/explorer.css', '/explorer/main.js', '/topology.json', '/cornfield/config.json', '/explorer/../server/auth.js']) {
      expect([p, (await get(port, p)).status]).toEqual([p, 401]);
    }
  });

  it('serves only the theme assets a theme file names in a url(), without a session; the rest of its folder stays behind the sign-in', async () => {
    const named = await get(port, '/cornfield/theme/assets/bg.png');
    expect(named.status).toBe(200);
    expect(named.headers['content-type']).toBe('image/png');
    // Beside the theme but not named by it, or not there at all: the same 401 either way, so nothing says what the folder holds
    for (const p of ['/cornfield/theme/assets/private-shot.png', '/cornfield/theme/assets/logo.svg', '/cornfield/theme/assets/nothing.png', '/cornfield/theme/assets/BG.png', '/cornfield/theme/assets/bg.png/']) {
      expect([p, (await get(port, p)).status]).toEqual([p, 401]);
    }
  });

  it('says what a proposal link was for, escaped, and reflects nothing it should not', async () => {
    const page = await get(port, '/?proposal=0100-new-flow-across-apps&source=pull/21', { accept: 'text/html' });
    expect(page.body).toContain('Sign in to review <code>0100-new-flow-across-apps</code>');
    expect(page.body).toContain('data-corn="auth-reason"');
    expect(page.body).toContain('pull request #21');
    expect(page.body).toContain('href="/auth/start?return=%2F%3Fproposal%3D0100-new-flow-across-apps%26source%3Dpull%2F21"');
    // A slug that is not one is not shown, and the plain heading stays
    for (const evil of ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', 'a b', 'A', '-x', 'x'.repeat(101)]) {
      const r = await get(port, `/?proposal=${encodeURIComponent(evil)}`, { accept: 'text/html' });
      expect(r.body, evil).not.toContain('data-corn="auth-reason"');
      expect(r.body, evil).not.toMatch(/<script>alert|<img src=x/); // only ever percent-encoded, in the link's own address
      expect(r.body, evil).toContain('<h1>Sign in to ');
    }
    // The sign-in route takes the way back only as safeReturn lets it
    const r = await get(port, `/auth/sign-in?return=${encodeURIComponent('https://evil.example/?proposal=x')}`, { accept: 'text/html' });
    expect(r.body).not.toContain('data-corn="auth-reason"');
    expect(r.body).toContain('href="/auth/start"');
  });

  it('proposalOf reads a slug and a pull number from a checked way back only', () => {
    expect(proposalOf('/?proposal=a-b&source=pull/7')).toEqual({ slug: 'a-b', pull: '7' });
    expect(proposalOf('/?proposal=a-b&source=pull/x')).toEqual({ slug: 'a-b', pull: null });
    expect(proposalOf('/?run=1')).toBeNull();
    expect(proposalOf('//evil/?proposal=a')).toBeNull();
    expect(proposalOf('/auth/start?proposal=a')).toBeNull();
    expect(proposalOf(null)).toBeNull();
  });
});
