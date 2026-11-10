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
import { EXPLORER, SAMPLE } from '../helpers.js';

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
  fs.writeFileSync(path.join(root, 'cornfield.config.js'), fs.readFileSync(path.join(SAMPLE, 'cornfield.config.js'), 'utf8').replace("worktrees: '.worktrees',", () => `worktrees: '.worktrees',\n  theme: ${JSON.stringify(theme)},`));
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
    expect(html).toContain('<html lang="en" data-theme-names="day night" data-theme-default="night">');
    // never inlined
    expect(html).not.toContain('--cf-bg');
    expect(html).not.toContain('--cf-accent');
  });

  it('includes theme-boot.js once, as a classic script after every stylesheet link in the head: so it runs before the first paint, and the named link exists', async () => {
    const html = (await ask(s.port, '/')).body;
    const head = html.slice(0, html.indexOf('</head>'));
    expect(html.split('/explorer/theme-boot.js').length - 1).toBe(1);
    const boot = head.indexOf('<script src="/explorer/theme-boot.js"></script>');
    expect(boot).toBeGreaterThan(0);
    const links = [...head.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)];
    const own = (fs.readFileSync(path.join(EXPLORER, 'index.html'), 'utf8').match(/<link rel="stylesheet"/g) || []).length;
    expect(links.length).toBe(own + 3); // cornfield's own (explorer.css, house.css…), then the font, theme.css and the named theme
    for (const l of links) expect(l.index, l[0]).toBeLessThan(boot);
    // nothing but whitespace between it and </head>, and the body after: no element is drawn before it runs
    expect(head.slice(boot).replace('<script src="/explorer/theme-boot.js"></script>', '').trim()).toBe('');
    expect(html.indexOf('<body')).toBeGreaterThan(boot);
    // a classic script: not a module, not deferred, not async
    expect(head.slice(boot, boot + 60)).not.toMatch(/type="module"|\bdefer\b|\basync\b/);
  });

  it('has no named link without names, and no empty href without a default', async () => {
    const plain = await serve({ css: 'tools/t.css' }, { 'tools/t.css': 'a{}' });
    const nodefault = await serve({ names: { a: 'tools/a.css' } }, { 'tools/a.css': 'a{}' });
    try {
      expect((await ask(plain.port, '/')).body).not.toContain('cf-theme-name-css');
      const html = (await ask(nodefault.port, '/')).body;
      expect(html).toContain('<link rel="stylesheet" id="cf-theme-name-css" data-corn-theme="name" />');
      expect(html).toContain('<html lang="en" data-theme-names="a">');
    } finally { await plain.close(); await nodefault.close(); }
  });

  it('keeps a $ in a font URL as written (not a replacement pattern)', async () => {
    const font = 'https://fonts.googleapis.com/css2?family=A$&b=$$c$1';
    const t = await serve({ fonts: [font] });
    try {
      const html = (await ask(t.port, '/')).body;
      expect(html).toContain('family=A$&amp;b=$$c$1"');
      expect(html).not.toContain('<!--@theme-->');
      expect(html.split('<head>').length).toBe(2);
    } finally { await t.close(); }
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

describe('assets beside a theme: /cornfield/theme/assets/<path>', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  let s;
  let outside;
  beforeAll(async () => {
    s = await serve(
      { css: './tools/cf/theme.css', names: { night: './tools/cf/night.css' } },
      {
        'tools/cf/theme.css': 'a { background: url(theme/assets/img/bg.png) }', 'tools/cf/night.css': 'a{}',
        'tools/cf/img/bg.png': PNG, 'tools/cf/img/edge.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        'tools/cf/f/p.woff2': 'wOF2', 'tools/cf/f/p.woff': 'wOFF', 'tools/cf/a.webp': 'RIFF', 'tools/cf/a.gif': 'GIF89a', 'tools/cf/a.avif': 'avif',
        'tools/cf/x.js': 'alert(1)', 'tools/cf/x.html': '<script>alert(1)</script>', 'tools/cf/.hidden.png': PNG, 'tools/cf/.git/x.png': PNG,
        'tools/cf/big.png': Buffer.alloc(1024 * 1024 + 1), 'tools/other.png': PNG, 'secret.png': PNG,
      },
    );
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-theme-asset-out-'));
    made.push(outside);
    fs.writeFileSync(path.join(outside, 'o.png'), PNG);
    fs.symlinkSync(path.join(outside, 'o.png'), path.join(s.root, 'tools/cf/out.png'));
    fs.symlinkSync(outside, path.join(s.root, 'tools/cf/outdir'));
    fs.symlinkSync(path.join(s.root, 'tools/cf/img/bg.png'), path.join(s.root, 'tools/cf/same.png'));
  });
  afterAll(() => s.close());

  it('serves images and fonts under the theme folder, same-origin, by type, with nosniff', async () => {
    const types = { 'img/bg.png': 'image/png', 'f/p.woff2': 'font/woff2', 'f/p.woff': 'font/woff', 'a.webp': 'image/webp', 'a.gif': 'image/gif', 'a.avif': 'image/avif', 'same.png': 'image/png' };
    for (const [p, type] of Object.entries(types)) {
      const res = await ask(s.port, `/cornfield/theme/assets/${p}`);
      expect(res.status, p).toBe(200);
      expect(res.headers['content-type'], p).toBe(type);
      expect(res.headers['x-content-type-options'], p).toBe('nosniff');
      expect(res.headers['access-control-allow-origin'], p).toBeUndefined();
    }
    expect((await ask(s.port, '/cornfield/theme/assets/img/bg.png', 'HEAD')).status).toBe(200);
  });

  it('serves an SVG as an image that may run and load nothing', async () => {
    const res = await ask(s.port, '/cornfield/theme/assets/img/edge.svg');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/svg+xml');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses everything else: traversal however written, other types, dot files, links out, big files, listings', async () => {
    const paths = [
      '/cornfield/theme/assets/', '/cornfield/theme/assets/img', '/cornfield/theme/assets/img/', '/cornfield/theme/assets',
      '/cornfield/theme/assets/..%2F..%2F..%2Fsecret.png', '/cornfield/theme/assets/%2e%2e/%2e%2e/%2e%2e/secret.png', '/cornfield/theme/assets/img/%2E%2E%2F%2E%2E%2F..%2Fother.png',
      '/cornfield/theme/assets/..%5C..%5Cother.png', '/cornfield/theme/assets/img%5Cbg.png', '/cornfield/theme/assets/%E2%80%A5/other.png', '/cornfield/theme/assets/%EF%BC%8E%EF%BC%8E/other.png',
      '/cornfield/theme/assets/x.js', '/cornfield/theme/assets/x.html', '/cornfield/theme/assets/theme.css', '/cornfield/theme/assets/.hidden.png', '/cornfield/theme/assets/.git/x.png',
      '/cornfield/theme/assets/out.png', '/cornfield/theme/assets/outdir/o.png', '/cornfield/theme/assets/big.png', '/cornfield/theme/assets/gone.png',
      '/cornfield/theme/assets//img/bg.png', '/cornfield/theme/assets/img//bg.png', '/cornfield/theme/assets/IMG/bg.png',
    ];
    for (const p of paths) expect((await ask(s.port, p)).status, p).toBe(404);
    // a NUL byte is refused before any route
    expect((await ask(s.port, '/cornfield/theme/assets/img/bg.png%00.png')).status).toBe(400);
  });

  it('serves nothing beside a theme at the top of the repo', async () => {
    const t = await serve({ css: 'theme.css' }, { 'theme.css': 'a{}', 'bg.png': PNG });
    try {
      expect((await ask(t.port, '/cornfield/theme/assets/bg.png')).status).toBe(404);
    } finally { await t.close(); }
  });
});

describe('theme.icons and theme.pixelated on the server', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>';
  let s;
  beforeAll(async () => {
    s = await serve(
      { css: './tools/cf/theme.css', icons: { app: './tools/cf/icons/app.svg', page: './tools/cf/icons/page.png' }, pixelated: true },
      { 'tools/cf/theme.css': ':root{}', 'tools/cf/icons/app.svg': SVG, 'tools/cf/icons/page.png': PNG },
    );
  });
  afterAll(() => s.close());

  it('tells the browser the served path of each icon and the flag, never a repo path', async () => {
    const res = await ask(s.port, '/cornfield/config.json');
    const config = JSON.parse(res.body);
    expect(config.theme).toEqual({ names: [], default: null, icons: { app: '/cornfield/theme/assets/icons/app.svg', page: '/cornfield/theme/assets/icons/page.png' }, pixelated: true });
    expect(res.body).not.toContain('tools/cf');
  });

  it('serves each icon from the route that serves the images beside the theme', async () => {
    const png = await ask(s.port, '/cornfield/theme/assets/icons/page.png');
    expect([png.status, png.headers['content-type']]).toEqual([200, 'image/png']);
    const svg = await ask(s.port, '/cornfield/theme/assets/icons/app.svg');
    expect([svg.status, svg.headers['content-type']]).toEqual([200, 'image/svg+xml']);
    expect(svg.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'");
  });

  it('widens nothing in the page policy: icons are same-origin images', async () => {
    const page = await ask(s.port, '/');
    expect(directive(page.headers['content-security-policy'], 'img-src')).toBe("img-src 'self' data: blob:");
  });
});
