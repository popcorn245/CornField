/**
 * @vitest-environment node
 *
 * `theme` on the server (docs/config.md#theme): the repo's theme CSS is served same-origin as text/css with nosniff, only the
 * files the config names; the page links it after explorer.css; the Content-Security-Policy lists exactly the font hosts; the
 * config the browser reads carries names and the default, never a path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { createCornfieldServer } from '../../server/server.js';
// @ts-expect-error plain JS modules, no declarations
import { loadConfig } from '../../core/config.js';
import { SAMPLE } from '../helpers.js';

const GOOGLE = 'https://fonts.googleapis.com/css2?family=Nunito&family=Pixelify+Sans&display=swap';

function ask(port, target, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const made = [];
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

/** A copy of the sample repo with `theme` added to its config and the given files, served on a free port */
async function serve(theme, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-theme-srv-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-theme-data-'));
  made.push(root, data);
  fs.cpSync(SAMPLE, root, { recursive: true });
  for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); }
  fs.writeFileSync(path.join(root, 'secret.css'), 'a{} /* not in the config */');
  fs.writeFileSync(path.join(root, 'cornfield.config.js'), fs.readFileSync(path.join(SAMPLE, 'cornfield.config.js'), 'utf8').replace("worktrees: '.worktrees',", `worktrees: '.worktrees',\n  theme: ${JSON.stringify(theme)},`));
  const config = await loadConfig(root, { env: { CORNFIELD_DATA: data } });
  const server = createCornfieldServer(config, { env: {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  return { port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, root, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
}

const directive = (csp, name) => csp.split('; ').find((d) => d.startsWith(`${name} `));

describe('a theme in the config', () => {
  let s;
  beforeAll(async () => {
    s = await serve(
      { css: './tools/theme.css', fonts: [GOOGLE], names: { day: './tools/day.css', night: './tools/night.css' }, default: 'night' },
      { 'tools/theme.css': ':root { --cf-bg: #fff; }', 'tools/day.css': ':root { --cf-accent: gold; }', 'tools/night.css': ':root { --cf-accent: navy; }' },
    );
  });
  afterAll(() => s.close());

  it('serves the theme CSS as text/css with nosniff, and the named ones the same way', async () => {
    for (const [p, body] of [['/cornfield/theme.css', '--cf-bg: #fff'], ['/cornfield/theme/day.css', 'gold'], ['/cornfield/theme/night.css', 'navy']]) {
      const res = await ask(s.port, p);
      expect(res.status, p).toBe(200);
      expect(res.headers['content-type'], p).toBe('text/css; charset=utf-8');
      expect(res.headers['x-content-type-options'], p).toBe('nosniff');
      expect(res.headers['access-control-allow-origin'], p).toBeUndefined();
      expect(res.body, p).toContain(body);
    }
    expect((await ask(s.port, '/cornfield/theme.css', 'HEAD')).status).toBe(200);
  });

  it('refuses anything outside the configured files', async () => {
    for (const p of ['/cornfield/theme/other.css', '/cornfield/theme/', '/cornfield/theme/..%2Fsecret.css', '/cornfield/theme/day.css/..%2F..%2Fsecret.css', '/cornfield/theme.css/x', '/cornfield/theme/DAY.css', '/repo/tools/theme.css', '/repo/secret.css', '/secret.css', '/tools/theme.css', '/cornfield/theme/%2e%2e/secret.css']) {
      expect((await ask(s.port, p)).status, p).toBe(404);
    }
  });

  it('puts the links after explorer.css and house.css: fonts, then the theme, then the default named theme', async () => {
    const html = (await ask(s.port, '/')).body;
    const at = (needle) => html.indexOf(needle);
    expect(at('/explorer/explorer.css')).toBeGreaterThan(0);
    expect(at('/explorer/house.css')).toBeGreaterThan(at('/explorer/explorer.css'));
    expect(at(`href="${GOOGLE.replace(/&/g, '&amp;')}"`)).toBeGreaterThan(at('/explorer/house.css'));
    expect(at('href="/cornfield/theme.css"')).toBeGreaterThan(at('fonts.googleapis.com'));
    expect(at('id="cf-theme-name-css" href="/cornfield/theme/night.css"')).toBeGreaterThan(at('href="/cornfield/theme.css"'));
    // …and the second boot script comes after that link, so it can point it at the viewer's pick
    expect(html.lastIndexOf('/explorer/theme-boot.js')).toBeGreaterThan(at('id="cf-theme-name-css"'));
    expect(html).toContain('<html lang="en" data-theme-names="day night" data-theme-default="night">');
    // never inlined
    expect(html).not.toContain('--cf-bg');
    expect(html).not.toContain('--cf-accent');
  });

  it('lists exactly the font hosts in style-src and font-src, and widens nothing else', async () => {
    const res = await ask(s.port, '/');
    const csp = res.headers['content-security-policy'];
    expect(directive(csp, 'style-src')).toBe("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(directive(csp, 'font-src')).toBe("font-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com");
    expect(directive(csp, 'script-src')).toBe("script-src 'self'");
    expect(directive(csp, 'default-src')).toBe("default-src 'self'");
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self'");
    expect(directive(csp, 'img-src')).toBe("img-src 'self' data: blob:");
    // the same policy on every route
    expect((await ask(s.port, '/cornfield/theme.css')).headers['content-security-policy']).toBe(csp);
  });

  it('tells the browser the names and the default, and no path', async () => {
    const res = await ask(s.port, '/cornfield/config.json');
    const body = JSON.parse(res.body);
    expect(body.theme).toEqual({ names: ['day', 'night'], default: 'night' });
    expect(res.body).not.toMatch(/tools\/|\.css|fonts\.googleapis/);
    expect(res.body).not.toContain(s.root);
  });
});

describe('a theme with a font host that is not a known pair', () => {
  it('adds the stylesheet host and the listed file hosts, and nothing else', async () => {
    const s = await serve({ css: 'theme.css', fonts: ['https://fonts.example.org/f.css'], fontHosts: ['files.example.org'] }, { 'theme.css': 'a{}' });
    try {
      const csp = (await ask(s.port, '/')).headers['content-security-policy'];
      expect(directive(csp, 'style-src')).toBe("style-src 'self' 'unsafe-inline' https://fonts.example.org");
      expect(directive(csp, 'font-src')).toBe("font-src 'self' https://files.example.org https://fonts.example.org");
      expect(csp).not.toContain('gstatic');
    } finally { await s.close(); }
  });
});

describe('without a theme, and with a theme file that is not safe to send', () => {
  it('keeps the page and the policy as they were', async () => {
    const s = await serve({});
    try {
      const res = await ask(s.port, '/');
      expect(directive(res.headers['content-security-policy'], 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
      expect(directive(res.headers['content-security-policy'], 'font-src')).toBe("font-src 'self'");
      expect(res.body).toContain('<html lang="en">');
      expect(res.body).not.toContain('cornfield/theme');
      expect(res.body).not.toContain('<!--@theme-->');
      expect(JSON.parse((await ask(s.port, '/cornfield/config.json')).body).theme).toBeNull();
      expect((await ask(s.port, '/cornfield/theme.css')).status).toBe(404);
    } finally { await s.close(); }
  });

  it('does not send a file that holds a forbidden construct, is too big, or is a link out of the repo', async () => {
    const s = await serve({ css: 'bad.css', names: { big: 'big.css', out: 'out.css' } }, { 'bad.css': 'a { width: expression(1); }', 'big.css': `a{}${' '.repeat(256 * 1024)}` });
    try {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-theme-out-'));
      made.push(outside);
      fs.writeFileSync(path.join(outside, 'o.css'), 'a{}');
      fs.symlinkSync(path.join(outside, 'o.css'), path.join(s.root, 'out.css'));
      for (const p of ['/cornfield/theme.css', '/cornfield/theme/big.css', '/cornfield/theme/out.css']) expect((await ask(s.port, p)).status, p).toBe(404);
    } finally { await s.close(); }
  });
});
