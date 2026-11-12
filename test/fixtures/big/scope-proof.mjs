/**
 * The proof in a browser that `<corn-map src>` and `<corn-scope>` read a cornfield server from a listed sibling origin as the signed-in maintainer
 * (spec 0011 D5, D6, D7, D9, D10, D11). Runs by hand: needs Playwright, Chromium and the built package (`cd components && npm ci && npm run build`),
 * and no network (everything is on 127.0.0.1; Chromium resolves `*.localhost` to loopback, so the names are different origins of one site).
 *
 *   node test/fixtures/big/scope-proof.mjs [--shots <dir>] [--json <file>] [--keep-open]
 *
 * One cornfield rig (serve.js --forge --theme retro --layers, listing only http://tasks.corn.localhost:3782) and two blank host pages that serve the
 * built components and send a strict Content-Security-Policy (`default-src 'self'`, `connect-src` and `img-src` allowing the rig's origin, `style-src
 * 'self'` with no `'unsafe-inline'`): the listed one on tasks.corn.localhost:3782 and an unlisted one on tasks2.corn.localhost:3783. Every request the
 * browser makes is logged (from the network stack: preflights, images and the sign-in's redirect included) and checked at the end.
 *
 *   a. signed in: a one-tag `<corn-map src>` draws the server's map (and its project layers); with `use-theme` it wears the retro theme, and the host
 *      page's own styles, its document's style sheets and its fonts are exactly what they were
 *   b. signed out: the map says "Sign in to cornfield"; the link goes to the server's sign-in with the page as `returnTo`; following it, the server
 *      sends the browser back to the host page, where the map is drawn
 *   c. the unlisted host page: "This page is not listed by that cornfield", with its origin; the page read nothing
 *   d. every request: none carries a cookie to any origin but the rig's, none goes to a route outside server/embed.js ROUTES, and the ones that
 *      answer a session-less visitor (the theme and its images) carry none even to the rig
 *   and also: a `<corn-scope>` around a `<corn-map>` (late-added pieces, a second map refused, `src` changing), a scope that is handed everything (no request), a server that is
 *   down (offline, then Retry), and a bad address.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { routeOf } from '../../../server/embed.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const DIST = path.join(REPO, 'components', 'dist');
const SERVE = path.join(HERE, 'serve.js');

const RIG = { name: 'map', host: 'map.corn.localhost', port: 3780, forge: 3781 };
const LISTED = { name: 'listed', host: 'tasks.corn.localhost', port: 3782 };
const UNLISTED = { name: 'unlisted', host: 'tasks2.corn.localhost', port: 3783 };
const DEAD = 3789; // nothing listens here: the server that is down
const origin = (h) => `http://${h.host}:${h.port}`;
const MAP = origin(RIG);

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const SHOTS = arg('--shots');
const JSON_OUT = arg('--json');

async function loadPlaywright() {
  const tries = ['playwright', ...(process.env.PLAYWRIGHT_DIR ? [pathToFileURL(path.join(process.env.PLAYWRIGHT_DIR, 'index.mjs')).href] : []), '/opt/node-tools/node_modules/playwright/index.mjs'];
  for (const t of tries) {
    try { return await import(t); } catch { /* next */ }
  }
  throw new Error('Playwright is not installed: set PLAYWRIGHT_DIR to its folder.');
}

function startRig() {
  const args = [SERVE, '--forge', '--theme', 'retro', '--layers', '--port', String(RIG.port), '--forge-port', String(RIG.forge), '--public', MAP, '--embed', origin(LISTED), '--dir', path.join(os.tmpdir(), `cornfield-scope-proof-${RIG.port}`)];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`the rig did not start:\n${out}`)), 90_000);
    const see = (d) => { out += d; if (out.includes('Ctrl-C stops it')) { clearTimeout(timer); resolve({ stop: () => child.kill('SIGTERM') }); } };
    child.stdout.on('data', see);
    child.stderr.on('data', see);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`the rig exited (${code}):\n${out}`)); });
  });
}

const MIME = { '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css; charset=utf-8' };
/** A host page: blank, with its own look, a strict policy, and the built components at /dist/ */
function hostPage(host) {
  const csp = `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${MAP}; img-src 'self' data: ${MAP}; font-src 'self'; object-src 'none'; base-uri 'none'`;
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>host</title>
<link rel="stylesheet" href="/host.css"><script type="module" src="/dist/index.js"></script></head><body><h1>Tasks (a host app)</h1><p id="host-text">The host page's own paragraph.</p><div id="stage"></div></body></html>`;
  const css = 'body { margin: 16px; font-family: Georgia, serif; color: #234; background: #fffbe6; } h1 { font-size: 20px; } corn-map, corn-scope { display: block; } #stage { margin-top: 12px; } .map { height: 520px; width: 100%; max-width: 1100px; }';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp }); return res.end(page); }
    if (url.pathname === '/host.css') { res.writeHead(200, { 'Content-Type': MIME['.css'] }); return res.end(css); }
    if (url.pathname.startsWith('/dist/')) {
      const file = path.join(DIST, path.normalize(url.pathname.slice(6)));
      if (file.startsWith(DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) { res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); return res.end(fs.readFileSync(file)); }
    }
    res.writeHead(404); res.end('no');
  });
  return new Promise((resolve) => server.listen(host.port, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`); };

/** Logs every request of a context from the network stack (CDP): url, method, resource type, whether a Cookie went, and the answer */
async function logRequests(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const seen = new Map();
  const entry = (id) => { if (!seen.has(id)) seen.set(id, {}); return seen.get(id); };
  cdp.on('Network.requestWillBeSent', (e) => Object.assign(entry(e.requestId), { method: e.request.method, url: e.request.url, type: e.type, initiator: e.initiator && e.initiator.type }));
  cdp.on('Network.requestWillBeSentExtraInfo', (e) => { const h = Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k.toLowerCase(), v])); Object.assign(entry(e.requestId), { cookie: !!h.cookie, origin: h.origin || null, site: h['sec-fetch-site'] || null }); });
  cdp.on('Network.responseReceived', (e) => Object.assign(entry(e.requestId), { status: e.response.status }));
  cdp.on('Network.loadingFailed', (e) => Object.assign(entry(e.requestId), { failed: e.errorText }));
  return { all: () => [...seen.values()].filter((r) => r.url), clear: () => seen.clear() };
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.js'))) throw new Error('the package is not built: cd components && npm ci && npm run build');
  const { chromium } = await loadPlaywright();
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const rig = await startRig();
  const hosts = [await hostPage(LISTED), await hostPage(UNLISTED)];
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const results = { checks, requests: [] };
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const signedOut = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });

    // Signed in on the rig (the fake forge's authorize step redirects straight back)
    const p0 = await context.newPage();
    await p0.goto(`${MAP}/auth/start`);
    await p0.waitForURL(`${MAP}/**`);
    check('signed in on the rig', (await p0.evaluate(() => fetch('/auth/me').then((r) => r.json()))).ok);
    await p0.close();

    const open = async (ctx, host, html) => {
      const page = await ctx.newPage();
      const log = await logRequests(ctx, page);
      const violations = [];
      page.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) violations.push(m.text().slice(0, 200)); });
      const events = [];
      const hops = []; // every navigation request, a redirect's hops each (CDP gives a redirect the one id)
      page.on('request', (r) => { if (r.isNavigationRequest()) hops.push(r.url()); });
      await page.exposeFunction('__event', (e) => events.push(e));
      await page.goto(`${origin(host)}/`);
      await page.evaluate(() => { for (const t of ['cornReady', 'cornAuth', 'cornError', 'cornSelect']) document.addEventListener(t, (e) => window.__event({ type: t, detail: e.detail })); });
      if (html) await page.evaluate((h) => { document.querySelector('#stage').innerHTML = h; }, html);
      return { page, log, violations, events, hops };
    };
    const shot = async (page, name) => {
      if (!SHOTS) return;
      for (const [w, h, tag] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
        await page.setViewportSize({ width: w, height: h });
        await sleep(500);
        await page.screenshot({ path: path.join(SHOTS, `${name}-${tag}.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    };
    const drawn = (page) => page.evaluate(async () => {
      const el = document.querySelector('corn-map');
      const canvas = el.shadowRoot.querySelector('canvas[data-corn="map-canvas"]');
      return { w: canvas.width, h: canvas.height, hasCard: !!el.shadowRoot.querySelector('[data-corn="source-status"]:not([hidden])') };
    });
    const waitFor = async (page, fn, arg$, ms = 20_000) => { await page.waitForFunction(fn, arg$, { timeout: ms }); };
    const cardText = (page) => page.evaluate(() => { const c = document.querySelector('corn-map').shadowRoot.querySelector('[data-corn="source-status"]:not([hidden])'); return c ? c.textContent.replace(/\s+/g, ' ').trim() : null; });
    const hostLook = (page) => page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      const p = getComputedStyle(document.querySelector('#host-text'));
      return { bodyDisplay: cs.display, bodyColor: cs.color, bodyBg: cs.backgroundColor, bodyFont: cs.fontFamily, pColor: p.color, h1Size: getComputedStyle(document.querySelector('h1')).fontSize, docSheets: document.adoptedStyleSheets.length, styleTags: document.querySelectorAll('style').length };
    });

    // ---- a. signed in, one tag ----------------------------------------------------------------------------------------------------------------
    {
      const a = await open(context, LISTED, null);
      await a.page.evaluate((src) => { document.querySelector('#stage').innerHTML = `<corn-map class="map" src="${src}" renderer="canvas2d"></corn-map>`; }, MAP);
      await waitFor(a.page, () => window.__event && document.querySelector('corn-map')?.shadowRoot?.querySelector('canvas'), null);
      await sleep(2500);
      const d = await drawn(a.page);
      check('a. signed in: <corn-map src> draws the server\'s map', d.w > 0 && !d.hasCard && a.events.some((e) => e.type === 'cornReady'), JSON.stringify(d));
      const before = await hostLook(a.page); // with the one default-tokens sheet the first corn-* element adds (zero specificity): the theme adds nothing more
      await shot(a.page, 'a1-signed-in-default');
      // with the server's theme
      await a.page.evaluate(() => { document.querySelector('corn-map').useTheme = true; });
      await sleep(2500);
      const themed = await a.page.evaluate(() => {
        const el = document.querySelector('corn-map');
        const sheets = el.shadowRoot.adoptedStyleSheets;
        const own = [...sheets].some((s) => [...s.cssRules].some((r) => r.cssText.includes('data-corn')));
        const cs = getComputedStyle(el);
        return { accent: cs.getPropertyValue('--corn-accent').trim(), radius: cs.getPropertyValue('--corn-radius').trim(), font: cs.getPropertyValue('--corn-font').trim().slice(0, 30), shadowSheets: sheets.length, ownRules: own, ground: cs.getPropertyValue('--corn-ground').trim() };
      });
      check('a. use-theme: the retro tokens are on the element and its rules are in the shadow root', themed.accent.toLowerCase() === '#c8102e' && themed.ownRules, JSON.stringify(themed));
      const after = await hostLook(a.page);
      check('a. the host page\'s own look is exactly what it was (body, text, headline, no style sheet or tag added to the document)', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
      await shot(a.page, 'a2-signed-in-retro-theme');
      check('a. no Content-Security-Policy violation under a strict host policy', a.violations.length === 0, a.violations.join(' | '));
      results.requests.push(...a.log.all().map((r) => ({ case: 'a', ...r })));
      await a.page.close();
    }

    // ---- a'. a scope around a map -------------------------------------------------------------------------------------------------------------
    {
      const s = await open(context, LISTED, `<corn-scope src="${MAP}" use-theme><corn-map class="map" id="m1" renderer="canvas2d"></corn-map></corn-scope>`);
      await waitFor(s.page, () => document.querySelector('#m1')?.shadowRoot?.querySelector('canvas'), null);
      await sleep(2500);
      const d = await drawn(s.page);
      check('scope. <corn-scope src> around a <corn-map> draws the server\'s map, and says cornReady', d.w > 0 && !d.hasCard && s.events.some((e) => e.type === 'cornReady'), JSON.stringify(s.events.map((e) => e.type)));
      // a second map in the scope is refused, and says why
      await s.page.evaluate(() => { document.querySelector('corn-scope').insertAdjacentHTML('beforeend', '<corn-map id="m2" class="map" renderer="canvas2d"></corn-map>'); });
      await sleep(1000);
      const second = await s.page.evaluate(() => document.querySelector('#m2').shadowRoot.querySelector('[data-corn="source-status"]')?.textContent.replace(/\s+/g, ' ').trim());
      check('scope. a second map in a scope says why it draws nothing, and the scope says cornError second-map', /already has a map/.test(second || '') && s.events.some((e) => e.type === 'cornError' && e.detail.kind === 'second-map'), second);
      await shot(s.page, 'a3-scope-second-map');
      results.requests.push(...s.log.all().map((r) => ({ case: 'scope', ...r })));
      await s.page.close();
    }

    // ---- c. an unlisted host page -------------------------------------------------------------------------------------------------------------
    {
      const c = await open(context, UNLISTED, `<corn-map class="map" src="${MAP}" renderer="canvas2d"></corn-map>`);
      await waitFor(c.page, () => document.querySelector('corn-map')?.shadowRoot?.querySelector('[data-corn="source-title"]'), null);
      await sleep(800);
      const text = await cardText(c.page);
      check('c. unlisted host: "This page is not listed by that cornfield", with the origin to list', /not listed by that cornfield/.test(text || '') && (text || '').includes(origin(UNLISTED)), text);
      check('c. unlisted host: cornError not-listed, and the page read nothing (no cornReady)', c.events.some((e) => e.type === 'cornError' && e.detail.kind === 'not-listed') && !c.events.some((e) => e.type === 'cornReady'));
      await shot(c.page, 'c-unlisted');
      results.requests.push(...c.log.all().map((r) => ({ case: 'c', ...r })));
      await c.page.close();
    }

    // ---- b. signed out, and the way back ------------------------------------------------------------------------------------------------------
    {
      const b = await open(signedOut, LISTED, `<corn-map class="map" src="${MAP}" renderer="canvas2d"></corn-map>`);
      await waitFor(b.page, () => document.querySelector('corn-map')?.shadowRoot?.querySelector('[data-corn="source-sign-in"]'), null);
      const text = await cardText(b.page);
      const link = await b.page.evaluate(() => { const a = document.querySelector('corn-map').shadowRoot.querySelector('[data-corn="source-sign-in"]'); return { href: a.href, target: a.target, rel: a.rel }; });
      check('b. signed out: "Sign in to cornfield" with a real link, target _top', /Sign in to cornfield/.test(text || '') && link.target === '_top', JSON.stringify(link));
      const auth = b.events.find((e) => e.type === 'cornAuth');
      check('b. cornAuth says 401 and the sign-in that returns to this page', auth && auth.detail.status === 401 && auth.detail.signIn === `${MAP}/auth/start?returnTo=${encodeURIComponent(`${origin(LISTED)}/`)}` && link.href === auth.detail.signIn, auth && auth.detail.signIn);
      check('b. the component did not navigate the window by itself', b.page.url() === `${origin(LISTED)}/`);
      await shot(b.page, 'b1-sign-in');
      await b.page.evaluate(() => document.querySelector('corn-map').shadowRoot.querySelector('[data-corn="source-sign-in"]').click());
      // The way there is a redirect chain through the rig (the browser makes one navigation of it): it is in the request log, and the way back ends on the host page
      const arrived = async () => { for (let i = 0; i < 120; i++) { if (b.hops.some((u) => u.startsWith(`${MAP}/auth/start`)) && b.page.url() === `${origin(LISTED)}/` && b.hops.filter((u) => u === `${origin(LISTED)}/`).length > 1) return true; await sleep(250); } return false; };
      const back = await arrived();
      await b.page.waitForLoadState('load');
      const trail = b.hops.map((u) => u.replace(/\?.*/, '')).join(' > ');
      check('b. the sign-in went to the rig and came back to the host page', back, trail);
      // the host page is fresh again (a new document): put the tag in and the map is drawn with the new session
      await b.page.evaluate((src) => { document.querySelector('#stage').innerHTML = `<corn-map class="map" src="${src}" renderer="canvas2d"></corn-map>`; }, MAP);
      await sleep(3500);
      const d = await drawn(b.page);
      check('b. after signing in the map is drawn', d.w > 0 && !d.hasCard, JSON.stringify(d));
      await shot(b.page, 'b2-after-sign-in');
      results.requests.push(...b.log.all().map((r) => ({ case: 'b', ...r })));
      await b.page.close();
    }

    // ---- the server is down, a bad address, handed in ----------------------------------------------------------------------------------------
    {
      const o = await open(context, LISTED, `<corn-map class="map" src="http://map.corn.localhost:${DEAD}" renderer="canvas2d"></corn-map>`);
      await waitFor(o.page, () => document.querySelector('corn-map')?.shadowRoot?.querySelector('[data-corn="source-retry"]'), null);
      const text = await cardText(o.page);
      check('offline: the server is down: "cannot be reached" with Retry', /cannot be reached/.test(text || '') && o.events.some((e) => e.type === 'cornError' && e.detail.kind === 'offline'), text);
      await shot(o.page, 'd-offline');
      results.requests.push(...o.log.all().map((r) => ({ case: 'offline', ...r })));
      await o.page.close();
      const bad = await open(context, LISTED, '<corn-map class="map" src="javascript:alert(1)" renderer="canvas2d"></corn-map>');
      await waitFor(bad.page, () => document.querySelector('corn-map')?.shadowRoot?.querySelector('[data-corn="source-title"]'), null);
      check('a bad address is refused and said (cornError address), and nothing was asked', bad.events.some((e) => e.type === 'cornError' && e.detail.kind === 'address') && bad.log.all().every((r) => !r.url.includes('javascript')));
      await shot(bad.page, 'e-bad-address');
      await bad.page.close();
    }
  } finally {
    await browser.close();
    for (const s of hosts) s.close();
    rig.stop();
  }

  // ---- d. the request log ---------------------------------------------------------------------------------------------------------------------
  const interesting = results.requests.filter((r) => /^https?:/.test(r.url) && !r.url.startsWith(origin(LISTED)) && !r.url.startsWith(origin(UNLISTED)) || r.url.startsWith(MAP));
  const toRig = results.requests.filter((r) => r.url.startsWith(MAP));
  const toOthers = results.requests.filter((r) => !r.url.startsWith(MAP) && !r.url.startsWith(origin(LISTED)) && !r.url.startsWith(origin(UNLISTED)) && !/^(data|blob|about|chrome)/.test(r.url) && !r.url.startsWith(`http://map.corn.localhost:${DEAD}`));
  const pathOf = (u) => new URL(u).pathname;
  const SIGN_IN = /^\/auth\//;
  const strays = toRig.filter((r) => r.type !== 'Document' && !SIGN_IN.test(pathOf(r.url)) && !routeOf(pathOf(r.url)));
  check('d. no request leaves for an origin other than the host\'s own, the rig and the dead port', toOthers.length === 0, toOthers.map((r) => r.url).join(' '));
  check('d. every request to the rig, but the sign-in\'s own navigation, is on a route of server/embed.js ROUTES', strays.length === 0, strays.map((r) => `${r.method} ${pathOf(r.url)}`).join(' '));
  const cookieElsewhere = results.requests.filter((r) => r.cookie && !r.url.startsWith(MAP));
  check('d. no request carried a cookie to any origin but the rig', cookieElsewhere.length === 0, cookieElsewhere.map((r) => r.url).join(' '));
  const open$ = toRig.filter((r) => routeOf(pathOf(r.url)) && routeOf(pathOf(r.url)).kind === 'open');
  check('d. the theme and its images were asked for without a cookie', open$.length > 0 && open$.every((r) => !r.cookie), `${open$.length} requests: ${[...new Set(open$.map((r) => `${r.method} ${pathOf(r.url)} cookie=${r.cookie}`))].slice(0, 6).join('; ')}`);
  const gated = toRig.filter((r) => routeOf(pathOf(r.url)) && routeOf(pathOf(r.url)).kind === 'session' && r.method === 'GET' && r.status === 200);
  check('d. the gated reads carried the session', gated.length > 0 && gated.every((r) => r.cookie), `${gated.length} requests`);
  const paths = [...new Set(toRig.map((r) => `${r.method} ${pathOf(r.url)}`))].sort();
  console.log(`\nrequests to the rig (${toRig.length}), by method and path:\n  ${paths.join('\n  ')}`);
  void interesting;
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks held${failed.length ? `; failed: ${failed.map((c) => c.name).join(' | ')}` : ''}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
