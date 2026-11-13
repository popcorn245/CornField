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
 *   - the listed host with `<corn-map src>`, and with corn-scope.js and corn-map.js and a scope around a map: the scope's chunk loads from the server
 *     (with CORS, without the cookie), the gated read carries the session to the server, and a signed-out visitor sees the server's sign-in
 *   - the listed host with `<corn-review src proposal>`: one script line, corn-review.js and the review's chunks load from the server with CORS and no
 *     cookie (the loader of a `src` among them, once), the gated read carries the session to the server alone, and a signed-out visitor is shown the card
 *     with the server's sign-in and `cornAuth` says it; a review handed its data loads no loader and asks nothing
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
export const hostPolicy = (server: string) => `default-src 'self'; script-src 'self' ${server}; connect-src 'self' ${server}; img-src 'self' data: ${server}; style-src 'self'`;

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
        return res.end('corn-map { display: block; width: 640px; height: 420px; } corn-review { display: block; width: 900px; height: 560px; }');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': hostPolicy(MAP) });
      // `/?src`: a one-tag map that reads the server; `/?scope`: the two entries, a scope around a map
      const query = new URL(req.url || '/', 'http://x').searchParams;
      const scripts = query.has('scope') ? ['corn-scope.js', 'corn-map.js'] : query.has('review') ? ['corn-review.js'] : ['corn-map.js'];
      const body = query.has('plain') ? '<corn-review id="review"></corn-review>' : query.has('review') ? `<corn-review id="review" src="${MAP}" proposal="0042-retire-the-old-export"></corn-review>` : query.has('scope') ? `<corn-scope src="${MAP}"><corn-map id="map" renderer="canvas2d"></corn-map></corn-scope>` : query.has('src') ? `<corn-map id="map" renderer="canvas2d" src="${MAP}"></corn-map>` : '<corn-map id="map"></corn-map>';
      return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>host</title>
<link rel="stylesheet" href="/host.css">
${scripts.map((f) => `<script type="module" src="${MAP}/cornfield/components/${f}"></script>`).join('\n')}</head>
<body>${body}</body></html>`);
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
  async function open(origin: string, path = '/') {
    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 900, height: 600 } });
    // A cookie for cornfield's own host is in the jar: the module request must still go without it
    await context.addCookies([{ name: 'cornfield', value: 'not-a-real-session', url: MAP }]);
    const page = await context.newPage();
    const answers: Array<{ url: string; status: number; headers: Record<string, string>; requestHeaders: Record<string, string> }> = [];
    const failed: string[] = [];
    const logged: string[] = [];
    // A response is recorded once its request's headers are read, which is a step later: `settled()` waits for every one heard so far
    const reading = new Set<Promise<void>>();
    page.on('response', (r: Response) => {
      if (!r.url().startsWith(MAP)) return;
      const read = r.request().allHeaders().then((requestHeaders) => { answers.push({ url: r.url(), status: r.status(), headers: r.headers(), requestHeaders }); });
      reading.add(read);
      void read.finally(() => reading.delete(read));
    });
    const settled = async () => { while (reading.size) await Promise.allSettled([...reading]); };
    page.on('requestfailed', (r) => { if (r.url().startsWith(MAP)) failed.push(`${r.url()} ${r.failure()?.errorText}`); });
    page.on('console', (m) => logged.push(m.text()));
    await page.addInitScript(() => {
      (window as any).__violations = [];
      // What the components tell the host, heard from before the page's scripts run (as a host that listens before its tags load): with whether the
      // sign-in card was already on screen when each was sent
      (window as any).__events = [];
      for (const type of ['cornAuth', 'cornError', 'cornReady']) {
        document.addEventListener(type, (e) => {
          const card = document.querySelector('corn-map, corn-review');
          const shown = !!(card && card.shadowRoot && card.shadowRoot.querySelector('a[data-corn="source-sign-in"]'));
          (window as any).__events.push({ type, target: (e.target as Element).localName, detail: (e as CustomEvent).detail, cardShown: shown });
        });
      }
      document.addEventListener('securitypolicyviolation', (e) => (window as any).__violations.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    await page.goto(`${origin}${path}`);
    return { page, context, answers, failed, logged, settled };
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
    const { page, context, answers, failed, logged, settled } = await open(LISTED);
    const drawn = await draw(page);
    await settled();
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

  for (const [what, path] of [['a one-tag corn-map with src', '/?src'], ['corn-scope.js and corn-map.js, a scope around a map', '/?scope']]) {
    it(`a listed host, ${what}: the scope's chunk comes from the server with CORS and no cookie, the reads carry the session to the server alone, and a signed-out visitor is shown the server's sign-in`, async () => {
      const { page, context, answers, failed, settled } = await open(LISTED, path);
      const link = await page.evaluate(async () => {
        await customElements.whenDefined('corn-map');
        const el = document.querySelector('corn-map') as any;
        for (let i = 0; i < 100; i++) {
          const a = el.shadowRoot && el.shadowRoot.querySelector('a[data-corn="source-sign-in"]');
          if (a) return { href: a.getAttribute('href'), title: el.shadowRoot.querySelector('[data-corn="source-title"]').textContent };
          await new Promise((r) => setTimeout(r, 100));
        }
        return null;
      });
      // the cookie in the jar is not a session: the server says 401, and the map says sign in, with the way back to this page
      expect(link).toEqual({ href: `${MAP}/auth/start?returnTo=${encodeURIComponent(`${LISTED}${path}`)}`, title: 'You are not signed in to cornfield' });
      await settled();
      expect(failed).toEqual([]);
      const scope = answers.filter((a) => /\/cornfield\/components\/chunks\/scope-[\w-]+\.js$/.test(a.url));
      expect(scope).toHaveLength(1);
      expect(scope[0].headers['access-control-allow-origin']).toBe(LISTED);
      expect(scope[0].requestHeaders.cookie).toBeUndefined();
      const config = answers.find((a) => a.url === `${MAP}/cornfield/config.json`)!;
      expect(config.status).toBe(401);
      expect(config.requestHeaders.cookie).toBe('cornfield=not-a-real-session'); // the session goes to the server's gated read
      expect(config.headers['access-control-allow-credentials']).toBe('true');
      for (const a of answers) if (!/\/cornfield\/config\.json$|\/topology\.json/.test(new URL(a.url).pathname)) expect(a.requestHeaders.cookie, a.url).toBeUndefined();
      // cornAuth is sent once, by the element that has the `src` (the map, or the scope), before the card is on screen, and no cornError with it
      const events = await page.evaluate(() => (window as any).__events);
      expect(events.filter((e: { type: string }) => e.type !== 'cornReady')).toEqual([{ type: 'cornAuth', target: path === '/?scope' ? 'corn-scope' : 'corn-map', detail: { status: 401, signIn: link!.href }, cardShown: false }]);
      expect(await page.evaluate(() => (window as any).__violations)).toEqual([]);
      await context.close();
    }, 60_000);
  }

  it('a listed host, a one-tag corn-review with src: the loader comes from the server with CORS and no cookie, the reads carry the session to the server alone, and a signed-out visitor is shown the server\'s sign-in, with cornAuth', async () => {
    const { page, context, answers, failed, settled } = await open(LISTED, '/?review');
    const link = await page.evaluate(async () => {
      await customElements.whenDefined('corn-review');
      const el = document.querySelector('corn-review') as any;
      await el.componentOnReady();
      for (let i = 0; i < 100; i++) {
        const a = el.shadowRoot && el.shadowRoot.querySelector('a[data-corn="source-sign-in"]');
        if (a) return { href: a.getAttribute('href'), title: el.shadowRoot.querySelector('[data-corn="source-title"]').textContent, region: el.shadowRoot.querySelector('[data-corn="review"]').getAttribute('role') };
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    });
    expect(link).toEqual({ href: `${MAP}/auth/start?returnTo=${encodeURIComponent(`${LISTED}/?review`)}`, title: 'You are not signed in to cornfield', region: 'region' });
    await settled();
    expect(failed).toEqual([]);
    const entry = answers.find((a) => a.url === `${MAP}/cornfield/components/corn-review.js`)!;
    expect(entry.status).toBe(200);
    expect(entry.headers['access-control-allow-origin']).toBe(LISTED);
    expect(entry.requestHeaders.cookie).toBeUndefined();
    const loader = answers.filter((a) => /\/chunks\/review-source-[\w-]+\.js$/.test(a.url));
    expect(loader).toHaveLength(1);
    expect(loader[0].headers['access-control-allow-origin']).toBe(LISTED);
    expect(loader[0].requestHeaders.cookie).toBeUndefined();
    const config = answers.find((a) => a.url === `${MAP}/cornfield/config.json`)!;
    expect(config.status).toBe(401);
    expect(config.requestHeaders.cookie).toBe('cornfield=not-a-real-session');
    // signed out, so no map, and the proposal was never asked for: nothing of it went to the server
    expect(answers.some((a) => /\/proposals/.test(a.url))).toBe(false);
    for (const a of answers) if (!/\/cornfield\/config\.json$|\/topology\.json/.test(new URL(a.url).pathname)) expect(a.requestHeaders.cookie, a.url).toBeUndefined();
    const events = await page.evaluate(() => (window as any).__events);
    // Sent once, by the review, before its card was on screen: a host that reacts to the card already has the event
    expect(events.filter((e: { type: string }) => e.type === 'cornAuth')).toEqual([{ type: 'cornAuth', target: 'corn-review', detail: { status: 401, signIn: link!.href, during: 'load' }, cardShown: false }]);
    expect(events.filter((e: { type: string }) => e.type === 'cornError')).toEqual([]);
    expect(await page.evaluate(() => (window as any).__violations)).toEqual([]);
    await context.close();
  }, 60_000);

  it('a listed host, a corn-review with no src: no loader is fetched and nothing is asked of the server', async () => {
    const { page, context, answers } = await open(LISTED, '/?review&plain');
    await page.evaluate(async () => { await customElements.whenDefined('corn-review'); await (document.querySelector('corn-review') as any).componentOnReady(); });
    await page.waitForTimeout(800);
    expect(answers.filter((a) => /review-source|config\.json|topology/.test(a.url))).toEqual([]);
    expect(await page.evaluate(() => (window as any).__violations)).toEqual([]);
    await context.close();
  }, 60_000);

  it('under that policy a review in a phone-wide box, a proposal open, reports no violation (its controls draw small data: images, as a theme may)', async () => {
    const { page, context } = await open(LISTED, '/?review&plain');
    const sample = JSON.parse(fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'sample', 'topology.json'), 'utf8'));
    const proposal = JSON.parse(fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'sample', 'docs', 'specs', 'proposals', '0002-checkout.json'), 'utf8'));
    const shown = await page.evaluate(async ([topology, object]) => {
      await customElements.whenDefined('corn-review');
      const el = document.querySelector('corn-review') as any;
      await el.componentOnReady();
      el.style.width = '390px'; // a phone's box: the bar is a sheet, with its view menu (CSSOM, which a policy does not govern)
      el.style.height = '700px';
      el.topology = topology;
      el.proposal = object;
      for (let i = 0; i < 50 && !el.shadowRoot.querySelector('#proposal-title')?.textContent; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 500));
      const mode = el.shadowRoot.querySelector('.hx-proposal-mode');
      return { title: el.shadowRoot.querySelector('#proposal-title').textContent, mode: !!mode && getComputedStyle(mode).display !== 'none' };
    }, [{ nodes: sample.nodes, edges: sample.edges }, proposal]);
    expect(shown).toEqual({ title: proposal.title, mode: true });
    expect(await page.evaluate(() => (window as any).__violations)).toEqual([]);
    await context.close();
  }, 60_000);

  it('docs/embedding.md gives a host exactly the policy this test ran under', () => {
    const doc = fs.readFileSync(path.join(REPO, 'docs', 'embedding.md'), 'utf8');
    expect(doc).toContain(`Content-Security-Policy: ${hostPolicy('https://map.example.com')}`);
  });
});
