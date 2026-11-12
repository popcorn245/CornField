// @vitest-environment node
/**
 * A host app loads the components from a cornfield server (spec 0011 D11, docs/embedding.md "From the server"): a real cornfield server on
 * map.corn.localhost, serving the build in dist/, listing `tasks.corn.localhost` in `embed.origins`, and a blank host page on each of two other
 * origins in headless Chrome (Chromium resolves *.localhost to this machine, so they are different origins). Ports 3790 to 3799.
 *
 *   - the listed host: its one `<script type="module" src=".../corn-map.js">` loads across origins (with CORS, without the cookie), the shared runtime
 *     chunk loads, the element upgrades and draws a map from a `topology` property, and `version.json` says the server's version; all under the
 *     Content-Security-Policy docs/embedding.md gives a host (no `'unsafe-inline'`), with no violation
 *   - a host that is not listed: the server answers, the browser refuses the module for want of CORS, the tag stays unknown, no chunk is fetched
 * Needs the build (dist/; this builds it when it is not there) and a Chrome: CHROME_PATH where there is no Google Chrome.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page, type Response } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JS
import { createCornfieldServer } from '../../server/server.js';
// @ts-expect-error plain JS
import { loadConfig } from '../../core/config.js';
// @ts-expect-error plain JS
import { version } from '../scripts/shared.mjs';

const PACKAGE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO = path.resolve(PACKAGE, '..');
const dist = path.join(PACKAGE, 'dist');
const MAP = 'http://map.corn.localhost:3790';
const LISTED = 'http://tasks.corn.localhost:3791';
const STRANGER = 'http://other.corn.localhost:3792';

/** The policy docs/embedding.md gives a host that loads the components from `server` (the doc is held to this text below) */
export const hostPolicy = (server: string) => `default-src 'self'; script-src 'self' ${server}; connect-src 'self' ${server}; img-src 'self' ${server}; style-src 'self'`;

const TOPOLOGY = {
  nodes: [
    { id: 'app', label: 'app', type: 'app' },
    { id: 'api', label: 'api', type: 'service', parent: 'app' },
    { id: 'db', label: 'db', type: 'store' },
  ],
  edges: [{ from: 'api', to: 'db' }, { from: 'app', to: 'api' }],
};

describe('a host page loads the components from the cornfield server', () => {
  const servers: http.Server[] = [];
  const dirs: string[] = [];
  let browser: Browser;

  const listen = (server: http.Server, port: number) => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()); });

  /** A blank host page with its own policy, loading the components from the cornfield server by one script line */
  function hostPage(port: number) {
    const server = http.createServer((req, res) => {
      if (req.url === '/host.css') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
        return res.end('corn-map { display: block; width: 640px; height: 420px; }');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': hostPolicy(MAP) });
      return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>host</title>
<link rel="stylesheet" href="/host.css">
<script type="module" src="${MAP}/cornfield/components/corn-map.js"></script></head>
<body><corn-map id="map"></corn-map></body></html>`);
    });
    servers.push(server);
    return listen(server, port);
  }

  beforeAll(async () => {
    if (!fs.existsSync(path.join(dist, 'manifest.json'))) execFileSync(process.execPath, [path.join(PACKAGE, 'scripts', 'build.mjs')], { cwd: PACKAGE, stdio: 'pipe' });
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'corn-host-'));
    dirs.push(data);
    const config = await loadConfig(path.join(REPO, 'test', 'fixtures', 'sample'), { env: { CORNFIELD_DATA: data } });
    config.embed = { origins: [LISTED] };
    // With sign-in, as a hosted cornfield has it: the name map.corn.localhost is answered because it is the public URL's, and the route is open before the guard
    Object.assign(config, { forge: { type: 'github', url: 'http://127.0.0.1:1', repo: 'owner/name' }, publicUrl: MAP });
    const cornfield = createCornfieldServer(config, { env: { CORNFIELD_GITHUB_CLIENT_ID: 'host-test', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: 'x'.repeat(40) }, componentsDir: dist });
    servers.push(cornfield);
    await listen(cornfield, 3790);
    await hostPage(3791);
    await hostPage(3792);
    const executablePath = process.env.CHROME_PATH;
    browser = await chromium.launch(executablePath ? { executablePath, args: ['--disable-accelerated-2d-canvas'] } : { channel: 'chrome', args: ['--disable-accelerated-2d-canvas'] });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    for (const s of servers) { s.closeAllConnections?.(); s.close(); }
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** Opens a host page and records what the browser asked cornfield for, what it answered, and what the page's policy refused */
  async function open(origin: string) {
    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 900, height: 600 } });
    // A cookie for cornfield's own host is in the jar: the module request must still go without it
    await context.addCookies([{ name: 'cornfield', value: 'not-a-real-session', url: MAP }]);
    const page = await context.newPage();
    const answers: Array<{ url: string; status: number; headers: Record<string, string>; requestHeaders: Record<string, string> }> = [];
    const failed: string[] = [];
    const logged: string[] = [];
    page.on('response', async (r: Response) => { if (r.url().startsWith(MAP)) answers.push({ url: r.url(), status: r.status(), headers: r.headers(), requestHeaders: await r.request().allHeaders() }); });
    page.on('requestfailed', (r) => { if (r.url().startsWith(MAP)) failed.push(`${r.url()} ${r.failure()?.errorText}`); });
    page.on('console', (m) => logged.push(m.text()));
    await page.addInitScript(() => {
      (window as any).__violations = [];
      document.addEventListener('securitypolicyviolation', (e) => (window as any).__violations.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    await page.goto(`${origin}/`);
    return { page, context, answers, failed, logged };
  }

  const draw = (page: Page) => page.evaluate(async (topology) => {
    await customElements.whenDefined('corn-map');
    const el = document.querySelector('corn-map') as any;
    await el.componentOnReady();
    el.renderer = 'canvas2d';
    const ready = new Promise<void>((resolve) => el.addEventListener('cornReady', () => resolve(), { once: true }));
    el.topology = topology;
    await ready;
    await new Promise((r) => setTimeout(r, 300));
    const canvas = el.shadowRoot.querySelector('canvas[data-corn="map-canvas"]') as HTMLCanvasElement;
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]) lit++;
    return { defined: !!customElements.get('corn-map'), upgraded: typeof el.fit === 'function', width: canvas.width, lit };
  }, TOPOLOGY);

  it('a listed host: one script line, the module loads across origins with CORS and no cookie, the runtime chunk loads, the element draws a map', async () => {
    const { page, context, answers, failed, logged } = await open(LISTED);
    const drawn = await draw(page);
    expect(drawn.defined).toBe(true);
    expect(drawn.upgraded).toBe(true);
    expect(drawn.width).toBeGreaterThan(0);
    expect(drawn.lit).toBeGreaterThan(200);
    expect(failed).toEqual([]);

    const entry = answers.find((a) => a.url === `${MAP}/cornfield/components/corn-map.js`)!;
    expect(entry.status).toBe(200);
    expect(entry.headers['content-type']).toBe('application/javascript; charset=utf-8');
    expect(entry.headers['access-control-allow-origin']).toBe(LISTED);
    expect(entry.headers['access-control-allow-credentials']).toBeUndefined();
    expect(entry.headers['x-content-type-options']).toBe('nosniff');
    expect(entry.requestHeaders.origin).toBe(LISTED);
    const chunks = answers.filter((a) => a.url.startsWith(`${MAP}/cornfield/components/chunks/`));
    expect(chunks.some((a) => /\/chunks\/runtime-[\w-]+\.js$/.test(a.url))).toBe(true);
    for (const a of chunks) {
      expect(a.status, a.url).toBe(200);
      expect(a.headers['access-control-allow-origin'], a.url).toBe(LISTED);
      expect(a.headers['cache-control'], a.url).toBe('public, max-age=31536000, immutable');
    }
    // the cookie jar holds one for cornfield, and none of these requests carried it
    for (const a of answers) expect(a.requestHeaders.cookie, a.url).toBeUndefined();
    expect((await context.cookies(MAP)).length).toBe(1);

    // the version the host got is the server's, from the file and from the code
    const served = await page.evaluate(async (url) => (await fetch(url)).json(), `${MAP}/cornfield/components/version.json`);
    expect(served).toEqual({ name: '@popcorn245/cornfield-components', cornfield: version });
    expect(JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version).toBe(version);
    const code = await page.evaluate(async (url) => (await fetch(url)).text(), `${MAP}/cornfield/components/index.js`);
    expect(code).toContain(JSON.stringify(version));

    // under the policy the docs give a host, without 'unsafe-inline', nothing was refused
    expect(await page.evaluate(() => (window as any).__violations)).toEqual([]);
    expect(logged.filter((l) => /Content Security Policy|CORS/i.test(l))).toEqual([]);
    await context.close();
  }, 60_000);

  it('a host that is not listed: the server answers, the browser refuses the module for want of CORS, and the tag stays unknown', async () => {
    const { page, context, answers, failed, logged } = await open(STRANGER);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => !!customElements.get('corn-map'))).toBe(false);
    expect(await page.evaluate(() => (document.querySelector('corn-map') as any).shadowRoot)).toBeNull();
    const entry = answers.find((a) => a.url === `${MAP}/cornfield/components/corn-map.js`);
    // Whether the browser reports the refused answer or only the failed request, there is no CORS header to let it in
    if (entry) expect(entry.headers['access-control-allow-origin']).toBeUndefined();
    expect(entry || failed.some((f) => f.includes('corn-map.js'))).toBeTruthy();
    expect(logged.join('\n')).toMatch(/CORS|Access-Control-Allow-Origin/i);
    expect(answers.filter((a) => a.url.includes('/chunks/'))).toEqual([]);
    for (const a of answers) expect(a.requestHeaders.cookie, a.url).toBeUndefined();
    await context.close();
  }, 60_000);

  it('docs/embedding.md gives a host exactly the policy this test ran under', () => {
    const doc = fs.readFileSync(path.join(REPO, 'docs', 'embedding.md'), 'utf8');
    expect(doc).toContain(`Content-Security-Policy: ${hostPolicy('https://map.example.com')}`);
  });
});
