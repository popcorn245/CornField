/**
 * @vitest-environment node
 *
 * `brand` on the server (docs/config.md#brand): the configured images are served same-origin with their type, nosniff and, for an SVG,
 * a policy of its own; anything not configured is a 404; the page carries the favicon, the tab title and the manifest link; the manifest;
 * the config the browser reads carries URLs and the name, never a path.
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

function ask(port, target, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, buf: Buffer.concat(chunks), body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const made = [];
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([0, 0, 0, 48, 0, 0, 0, 48]), Buffer.alloc(8)]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><script>alert(1)</script><rect width="8" height="8"/></svg>';

/** A copy of the sample repo with `brand` added to its config (or not, for `undefined`) and the given files, served on a free port */
async function serve(brand, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-brand-srv-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-brand-data-'));
  made.push(root, data);
  fs.cpSync(SAMPLE, root, { recursive: true });
  for (const [name, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), content); }
  fs.writeFileSync(path.join(root, 'secret.png'), PNG);
  const extra = brand === undefined ? '' : `\n  brand: ${JSON.stringify(brand)},`;
  fs.writeFileSync(path.join(root, 'cornfield.config.js'), fs.readFileSync(path.join(SAMPLE, 'cornfield.config.js'), 'utf8').replace("worktrees: '.worktrees',", () => `worktrees: '.worktrees',${extra}`));
  const config = await loadConfig(root, { env: { CORNFIELD_DATA: data } });
  const server = createCornfieldServer(config, { env: {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  return { port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, root, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
}

describe('a brand in the config', () => {
  let s;
  let outside;
  beforeAll(async () => {
    s = await serve(
      { logo: './brand/logo.svg', wordmark: './brand/word.png', favicon: './brand/fav.png', appName: 'Acme "Co" <b>', color: '#e53e3e', background: '#ffffff' },
      { 'brand/logo.svg': SVG, 'brand/word.png': PNG, 'brand/fav.png': PNG, 'brand/other.png': PNG },
    );
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-brand-out-'));
    made.push(outside);
  });
  afterAll(() => s.close());

  it('serves each image with its type and nosniff', async () => {
    const types = { '/cornfield/brand/logo.svg': 'image/svg+xml', '/cornfield/brand/wordmark.png': 'image/png', '/cornfield/brand/favicon.png': 'image/png' };
    for (const [p, type] of Object.entries(types)) {
      const res = await ask(s.port, p);
      expect(res.status, p).toBe(200);
      expect(res.headers['content-type'], p).toBe(type);
      expect(res.headers['x-content-type-options'], p).toBe('nosniff');
      expect(res.headers['access-control-allow-origin'], p).toBeUndefined();
      expect(res.buf.equals(fs.readFileSync(path.join(s.root, p.includes('logo') ? 'brand/logo.svg' : p.includes('word') ? 'brand/word.png' : 'brand/fav.png'))), p).toBe(true);
    }
    expect((await ask(s.port, '/cornfield/brand/favicon.png', 'HEAD')).status).toBe(200);
  });

  it('sends an SVG with a policy of its own, and a PNG without one of its own', async () => {
    const svg = await ask(s.port, '/cornfield/brand/logo.svg');
    expect(svg.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(svg.headers['content-type']).toBe('image/svg+xml');
    const png = await ask(s.port, '/cornfield/brand/favicon.png');
    expect(png.headers['content-security-policy']).toMatch(/^default-src 'self'/);
  });

  it('answers 404 for everything it was not told to serve, and for traversal however written', async () => {
    const paths = [
      '/cornfield/brand/', '/cornfield/brand', '/cornfield/brand/logo.png', '/cornfield/brand/favicon.svg', '/cornfield/brand/wordmark.svg', '/cornfield/brand/logo', '/cornfield/brand/other.png',
      '/cornfield/brand/brand/other.png', '/cornfield/brand/../secret.png', '/cornfield/brand/%2e%2e/secret.png', '/cornfield/brand/..%2fsecret.png', '/cornfield/brand/logo.svg/../../secret.png',
      '/cornfield/brand/%2e%2e%2f%2e%2e%2fsecret.png', '/cornfield/brand/..\\secret.png', '/brand/logo.svg', '/brand/fav.png', '/secret.png', '/repo/secret.png', '/repo/brand/fav.png',
      '/cornfield/theme/assets/fav.png', '/cornfield/brand/LOGO.SVG',
    ];
    for (const p of paths) {
      const res = await ask(s.port, p);
      expect(res.status, p).toBe(404);
      expect(res.headers['content-type'] || '', p).not.toMatch(/^image\//);
    }
  });

  it('refuses a NUL in the path', async () => {
    expect((await ask(s.port, '/cornfield/brand/logo.svg%00.png')).status).toBeGreaterThanOrEqual(400);
  });

  it('puts the favicon, the manifest and the tab colour in the page, and the app name in the title', async () => {
    const html = (await ask(s.port, '/')).body;
    expect(html).toContain('<link rel="icon" href="/cornfield/brand/favicon.png" type="image/png" />');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />');
    expect(html).toContain('<meta name="theme-color" content="#e53e3e" />');
    expect(html).toContain('<title>Acme home · Acme &quot;Co&quot; &lt;b&gt;</title>');
    expect(html).not.toContain('<!--@brand-->');
    // never inlined: the page holds no svg, only URLs
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"');
    // the head still ends with the theme boot
    expect(html.indexOf('rel="icon"')).toBeLessThan(html.indexOf('/explorer/theme-boot.js'));
  });

  it('serves the manifest as JSON with the name, the icons and the colours', async () => {
    const res = await ask(s.port, '/manifest.webmanifest');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/manifest\+json/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(JSON.parse(res.body)).toEqual({
      name: 'Acme "Co" <b>',
      short_name: 'Acme "Co" <b',
      start_url: '/',
      display: 'standalone',
      theme_color: '#e53e3e',
      background_color: '#ffffff',
      icons: [
        { src: '/cornfield/brand/favicon.png', type: 'image/png', sizes: '48x48', purpose: 'any' },
        { src: '/cornfield/brand/logo.svg', type: 'image/svg+xml', sizes: 'any', purpose: 'any' },
      ],
    });
  });

  it('tells the browser URLs, the name and where "powered by cornfield" leads, and no path', async () => {
    const cfg = JSON.parse((await ask(s.port, '/cornfield/config.json')).body);
    expect(cfg.brand).toEqual({ logo: '/cornfield/brand/logo.svg', wordmark: '/cornfield/brand/wordmark.png', favicon: '/cornfield/brand/favicon.png', appName: 'Acme "Co" <b>', poweredBy: 'https://github.com/popcorn245/CornField#readme' });
    expect(JSON.stringify(cfg)).not.toContain('./brand');
    expect(JSON.stringify(cfg.brand)).not.toContain(s.root);
  });
});

describe('a brand with only a name', () => {
  it('names the tab and the manifest, with no icon and no favicon link', async () => {
    const s = await serve({ appName: 'Acme home' });
    try {
      const html = (await ask(s.port, '/')).body;
      expect(html).toContain('<title>Acme home</title>');
      expect(html).not.toContain('rel="icon"');
      expect(html).toContain('rel="manifest"');
      expect(html).not.toContain('theme-color');
      expect(JSON.parse((await ask(s.port, '/manifest.webmanifest')).body)).toEqual({ name: 'Acme home', short_name: 'Acme home', start_url: '/', display: 'standalone', icons: [] });
      expect((await ask(s.port, '/cornfield/brand/logo.svg')).status).toBe(404);
    } finally { await s.close(); }
  });
});

describe('without a brand', () => {
  it('keeps the page as it was: no manifest, no icon, the title as before', async () => {
    const s = await serve(undefined);
    try {
      const html = (await ask(s.port, '/')).body;
      expect(html).toContain('<title>Acme home · cornfield</title>');
      expect(html).not.toMatch(/rel="(icon|manifest)"/);
      expect(html).not.toContain('<!--@brand-->');
      expect((await ask(s.port, '/manifest.webmanifest')).status).toBe(404);
      expect((await ask(s.port, '/cornfield/brand/logo.svg')).status).toBe(404);
      expect(JSON.parse((await ask(s.port, '/cornfield/config.json')).body).brand).toBeNull();
    } finally { await s.close(); }
  });
});

describe('a brand image that is not safe to send', () => {
  it('is a 404 when the bytes do not match, it is too big, or it is a link out of the repo', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-brand-out-'));
    made.push(outside);
    fs.writeFileSync(path.join(outside, 'o.png'), PNG);
    const s = await serve(
      { logo: 'liar.png', wordmark: 'big.png', favicon: 'out.png' },
      { 'liar.png': '<html><script>alert(1)</script></html>', 'big.png': Buffer.concat([PNG, Buffer.alloc(512 * 1024)]) },
    );
    try {
      fs.symlinkSync(path.join(outside, 'o.png'), path.join(s.root, 'out.png'));
      for (const p of ['/cornfield/brand/logo.png', '/cornfield/brand/wordmark.png', '/cornfield/brand/favicon.png']) expect((await ask(s.port, p)).status, p).toBe(404);
      // the manifest still answers, without those icons
      expect(JSON.parse((await ask(s.port, '/manifest.webmanifest')).body).icons).toEqual([]);
    } finally { await s.close(); }
  });
});
