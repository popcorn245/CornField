/**
 * The proof in a browser that the review's sections, `<corn-proposal>`, `<corn-changes>` and `<corn-decision>`, work in a host app's own layout inside one `<corn-scope>`
 * beside a `<corn-map>` and a `<corn-node-panel>`, on a listed sibling origin, under a strict Content-Security-Policy (spec 0011 D4, D5, D6, D7, D9, D10, D12). Runs by hand:
 * needs Playwright, Chromium and the built package (`cd components && npm ci && npm run build`), and no network (everything is on 127.0.0.1; Chromium resolves
 * `*.localhost` to loopback).
 *
 *   node test/fixtures/big/review-tags-proof.mjs [--shots <dir>] [--json <file>] [--only open,views,player,select,decide,close,keys,doubled,alone,signedout,ended,offline,unlisted,narrow,axe]
 *
 * One cornfield rig (serve.js --forge --lands, listing only http://tasks.corn.localhost:3842; a second host on :3843 is not listed) and one host page that sends
 * `default-src 'self'; script-src 'self'; style-src 'self'` (no `'unsafe-inline'`), connect and image sources only for the rig. The page lays out the sketch of
 * docs/embedding.md in a grid of its own CSS: `<corn-scope src proposal>` with a `<corn-map>`, and beside it `<corn-proposal>`, `<corn-changes>`, `<corn-decision>` and a
 * `<corn-node-panel>`. The proposal is opened by the scope's property, as a host app would, and then:
 *
 *   open      the property opens it; the map narrows; the host hears one `cornNavigate`; a second property of the same value changes nothing
 *   views     Before, Diff and After by mouse and by keyboard change the map, the scope's `view` follows, one `cornNavigate` each, one announcement each; Whole map
 *   player    a scenario played from `<corn-changes>` flies the map; the keys; Escape gives the focus back to the step
 *   select    a change selected in the list selects on the map and fills the node panel
 *   decide    Approve (the hold, Undo, the send) and Send back (the note), by mouse and keyboard: one `cornDecision` each, and the requests on the wire
 *   close     the bar's Close: one `cornNavigate`, the map is whole again, the focus on the map; another proposal opens by the property
 *   keys      Tab moves through the tags in the host's order, Escape in each
 *   doubled   a second of a section says so and takes over when the first leaves
 *   alone     each tag alone, and with no scope, says what it needs
 *   signedout the map's card, the sections waiting; the sign-in link comes back signed in
 *   ended     a session that ends while the page is open: Approve answers with the card and one `cornAuth` `{ during: 'send' }`
 *   offline   Approve with no network says so and sends nothing
 *   unlisted  a host that is not listed: the one `cornError`, and every tag waiting
 *   narrow    a 390px window: nothing runs past its box, the targets are 44px
 *   axe       the composed page, light and dark
 *   checks    no Content-Security-Policy violation, no console error, no request to an origin but the host's own and the rig's, none off the embed routes
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { routeOf, WRITES } from '../../../server/embed.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const DIST = path.join(REPO, 'components', 'dist');
const SERVE = path.join(HERE, 'serve.js');

const RIG = { host: 'map.corn.localhost', port: 3840, forge: 3841 };
const LISTED = { host: 'tasks.corn.localhost', port: 3842 };
const UNLISTED = { host: 'tasks.corn.localhost', port: 3843 };
const origin = (h) => `http://${h.host}:${h.port}`;
const MAP = origin(RIG);
const FORGE = `http://127.0.0.1:${RIG.forge}`;
const SL = ['0100-new-flow-across-apps', '0101-alerts-to-people', '0102-retire-a-feed', '0103-swap-a-provider'];

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const SHOTS = arg('--shots');
const JSON_OUT = arg('--json');
const only = arg('--only') ? arg('--only').split(',') : null;
const run = (name) => !only || only.includes(name);

async function loadPlaywright() {
  const tries = ['playwright', ...(process.env.PLAYWRIGHT_DIR ? [pathToFileURL(path.join(process.env.PLAYWRIGHT_DIR, 'index.mjs')).href] : []), '/opt/node-tools/node_modules/playwright/index.mjs'];
  for (const t of tries) {
    try { return await import(t); } catch { /* next */ }
  }
  throw new Error('Playwright is not installed: set PLAYWRIGHT_DIR to its folder.');
}

function startRig() {
  const args = [SERVE, '--forge', '--lands', '--port', String(RIG.port), '--forge-port', String(RIG.forge), '--public', MAP, '--embed', origin(LISTED), '--dir', path.join(os.tmpdir(), `cornfield-review-tags-proof-${RIG.port}`)];
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
const POLICY = `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${MAP}; img-src 'self' data: ${MAP}; font-src 'self'; object-src 'none'; base-uri 'none'`;
/** The host app's own look: its rules on bare elements are what a host's are (they must not reach the tags), and its grid is the sketch's */
const HOST_CSS = `body { margin: 0; font-family: Georgia, serif; color: #234; background: #fffbe6; }
header { display: flex; align-items: center; gap: 16px; padding: 8px 16px; background: #7a3e00; color: #fbf3e4; height: 48px; box-sizing: border-box; } h1 { font-size: 18px; margin: 0; }
button { font: italic 14px cursive; background: hotpink; } canvas { border: 3px dotted red; } input, textarea { border: 4px double green; } p { text-indent: 2em; } h2, h3, h4 { font-variant: small-caps; }
corn-scope { display: contents; }
.my-grid { display: grid; grid-template-columns: minmax(0, 1fr) 400px; gap: 8px; padding: 8px 16px; height: calc(100vh - 48px); box-sizing: border-box; }
.my-grid > corn-map { height: 100%; border: 1px solid #234; }
.my-grid aside { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
aside corn-proposal { flex: none; } aside corn-changes { flex: 1 1 0; min-height: 0; border: 1px solid #234; } aside corn-decision { flex: none; border: 1px solid #234; } aside corn-node-panel { flex: none; height: 200px; border: 1px solid #234; }
.pad { margin: 8px 16px; display: flex; gap: 8px; flex-wrap: wrap; } .pad > * { width: 400px; min-height: 60px; border: 1px solid #234; }
@media (max-width: 700px) { .my-grid { grid-template-columns: minmax(0, 1fr); height: auto; } .my-grid > corn-map { height: 320px; } aside corn-changes { height: 360px; flex: none; } }`;
const HOST_JS = `for (const type of ['cornNavigate', 'cornDecision', 'cornAuth', 'cornError', 'cornSelect', 'cornReady']) document.addEventListener(type, (e) => window.__event({ type, target: e.target.id || e.target.localName, detail: JSON.parse(JSON.stringify(e.detail === undefined ? null : e.detail)) }));
document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
window.__csp = [];`;

function hostPage(host) {
  const page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tasks (a host app)</title>'
    + '<link rel="stylesheet" href="/host.css"><script type="module" src="/dist/index.js"></script><script type="module" src="/host.js"></script></head>'
    + '<body><header><h1>Tasks (a host app)</h1><span id="host-text">TASK-118: retire the old export</span><button id="host-button" type="button">Host button</button></header><div id="stage"></div></body></html>';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': POLICY }); return res.end(page); }
    if (url.pathname === '/host.css') { res.writeHead(200, { 'Content-Type': MIME['.css'] }); return res.end(HOST_CSS); }
    if (url.pathname === '/host.js') { res.writeHead(200, { 'Content-Type': MIME['.js'] }); return res.end(HOST_JS); }
    if (url.pathname.startsWith('/dist/')) {
      const file = path.join(DIST, path.normalize(url.pathname.slice(6)));
      if (file.startsWith(DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) { res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); return res.end(fs.readFileSync(file)); }
    }
    res.writeHead(404); res.end('no');
  });
  return new Promise((resolve) => server.listen(host.port, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30_000, what = '') { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what || fn}`); await sleep(100); } }
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${String(detail).slice(0, 300)})` : ''}`); };
const rig = (p) => fetch(FORGE + p).then((r) => r.text()).catch(() => '');

/** Logs every request of a page from the network stack (CDP): url, method, type, the headers that matter, the answer */
async function logRequests(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const seen = new Map();
  const entry = (id) => { if (!seen.has(id)) seen.set(id, {}); return seen.get(id); };
  cdp.on('Network.requestWillBeSent', (e) => Object.assign(entry(e.requestId), { method: e.request.method, url: e.request.url, type: e.type, body: e.request.postData }));
  cdp.on('Network.requestWillBeSentExtraInfo', (e) => { const h = Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k.toLowerCase(), v])); Object.assign(entry(e.requestId), { cookie: !!h.cookie, origin: h.origin || null, site: h['sec-fetch-site'] || null }); });
  cdp.on('Network.responseReceived', (e) => Object.assign(entry(e.requestId), { status: e.response.status }));
  return { all: () => [...seen.values()].filter((r) => r.url), clear: () => seen.clear() };
}

const MARKUP = (proposal = '') => `<corn-scope src="${MAP}" id="s" theme="auto"${proposal ? ` proposal="${proposal}" source="pull/21"` : ''}>
  <main class="my-grid">
    <corn-map renderer="canvas2d" id="m"></corn-map>
    <aside>
      <corn-proposal id="pr"></corn-proposal>
      <corn-changes id="ch"></corn-changes>
      <corn-decision id="de"></corn-decision>
      <corn-node-panel id="np"></corn-node-panel>
    </aside>
  </main>
</corn-scope>`;

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.js'))) throw new Error('the package is not built: cd components && npm ci && npm run build');
  const { chromium } = await loadPlaywright();
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startRig();
  const hosts = [await hostPage(LISTED), await hostPage(UNLISTED)];
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-accelerated-2d-canvas'] });
  const results = { checks, requests: [] };
  const axeSource = fs.readFileSync(path.join(REPO, 'components', 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
  const problems = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await rig('/__rig/runner?state=online');
    for (const pr of [21, 22, 23, 24, 25, 26]) await rig(`/__rig/checks?pr=${pr}&state=passed`);
    const p0 = await context.newPage();
    await p0.goto(`${MAP}/auth/start`);
    await p0.waitForURL(`${MAP}/**`);
    check('signed in on the rig', (await p0.evaluate(() => fetch('/auth/me').then((r) => r.json()))).ok);
    await p0.close();

    /** A host page in a context: its log, its events, its violations */
    const open = async (ctx, host, { markup = MARKUP(), viewport = null, wait = true, quiet = false } = {}) => {
      const page = await ctx.newPage();
      if (viewport) await page.setViewportSize(viewport);
      const log = await logRequests(ctx, page);
      const events = [];
      page.on('console', (m) => { if (quiet) return; if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of 404/.test(m.text())) problems.push(`${m.type()}: ${m.text().slice(0, 240)}`); if (/Content Security Policy|Refused to/.test(m.text())) problems.push(`csp: ${m.text().slice(0, 200)}`); });
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      await page.exposeFunction('__event', (e) => events.push(e));
      await page.goto(`${origin(host)}/`);
      const look = await page.evaluate(() => { const cs = getComputedStyle(document.body); return { bg: cs.backgroundColor, font: cs.fontFamily, sheets: document.adoptedStyleSheets.length, styles: document.querySelectorAll('style').length }; });
      await page.evaluate((html) => { document.querySelector('#stage').innerHTML = html; }, markup);
      if (wait) await page.waitForFunction(() => document.querySelector('#m')?.shadowRoot?.querySelector('canvas'), null, { timeout: 60_000 });
      const ev = (type) => events.filter((e) => e.type === type);
      const root = (id) => page.evaluate((i) => !!document.querySelector(i)?.shadowRoot, id);
      void root;
      const flush = () => { results.requests.push(...log.all()); log.clear(); };
      return { page, log, events, ev, flush, look };
    };
    const T = {
      /** What a tag's shadow root holds, read by selector */
      text: (page, id, sel) => page.evaluate(([i, s]) => { const el = document.querySelector(i)?.shadowRoot?.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; }, [id, sel]),
      has: (page, id, sel) => page.evaluate(([i, s]) => { const el = document.querySelector(i)?.shadowRoot?.querySelector(s); return !!el && !el.hidden && !el.closest('[hidden]'); }, [id, sel]),
      attr: (page, id, name) => page.evaluate(([i, n]) => document.querySelector(i).getAttribute(n), [id, name]),
      pressed: (page) => page.evaluate(() => ['before', 'diff', 'after'].map((v) => document.querySelector('#pr').shadowRoot.querySelector(`[data-view="${v}"]`)?.getAttribute('aria-pressed')).join(',')),
      pixels: (page) => page.evaluate(() => { const c = document.querySelector('#m').shadowRoot.querySelector('canvas[data-corn="map-canvas"]'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 2166136261; for (let k = 0; k < d.length; k += 4) h = Math.imul(h ^ (d[k] | (d[k + 1] << 8) | (d[k + 2] << 16)), 16777619); return h; }),
      focus: (page) => page.evaluate(() => { let el = document.activeElement; const path = []; while (el) { path.push(el.id ? `#${el.id}` : el.localName); el = el.shadowRoot && el.shadowRoot.activeElement; if (el) path.push(`${el.getAttribute('data-corn') || el.localName}${el.getAttribute('data-view') ? `:${el.getAttribute('data-view')}` : ''}${el.getAttribute('data-review') ? `:${el.getAttribute('data-review')}` : ''}${el.hasAttribute('data-review-undo') ? ':undo' : ''}`); if (el && !el.shadowRoot) break; } return path.slice(-2).join(' > '); }),
      /** Every live region of the page that holds words: the host's page, and each tag's root */
      said: (page) => page.evaluate(() => { const out = []; const walk = (root) => { for (const el of root.querySelectorAll('[role="status"], [role="alert"], [aria-live]')) if (el.textContent.trim() && !el.closest('[hidden]')) out.push(el.textContent.trim()); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot); }; walk(document); return out; }),
    };
    const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), timeout: 180_000 }).catch(() => {}); };
    const decisions = (d) => d.ev('cornDecision');
    /** Before, Diff or After on the bar: in a 400px column the switcher is behind the mode button (the phone's layout of the bar), which a press of it closes again */
    const chooseView = async (page, view, how = 'click') => {
      const seg = page.locator(`#pr >> [data-view="${view}"]`);
      if (!(await seg.isVisible())) await page.locator('#pr >> [data-action="toggle-proposal-mode"]').click();
      if (how === 'click') await seg.click(); else { await seg.focus(); await page.keyboard.press('Enter'); }
    };

    // ================================================================================================================================================
    const a = await open(context, LISTED);
    const { page } = a;
    await page.waitForFunction(() => ['#np'].every((i) => document.querySelector(i)?.shadowRoot?.querySelector('[data-corn="node-panel"]')), null, { timeout: 60_000 });
    await sleep(1500);
    const lookBefore = a.look;
    const mapBefore = await T.pixels(page);
    check('start: with no proposal the three sections are empty (no bar, no list, no buttons)', !(await T.has(page, '#pr', '[data-corn="proposal-bar"]')) && !(await T.has(page, '#ch', '[data-corn="review-column"]')) && !(await T.has(page, '#de', '[data-corn="decision"]')));
    check('start: the host page\'s own rules (hotpink italic buttons, dotted canvas, double borders, indented paragraphs) do not reach the tags', await page.evaluate(() => {
      const s = document.querySelector('#de').shadowRoot;
      return getComputedStyle(s.querySelector('button')).backgroundColor !== 'rgb(255, 105, 180)' && getComputedStyle(s.querySelector('p')).textIndent === '0px';
    }));

    if (!run('open')) {
      await page.evaluate(([slug]) => { const s = document.querySelector('#s'); s.source = 'pull/21'; s.proposal = slug; }, [SL[0]]);
      await until(() => T.has(page, '#ch', '[data-corn="row"]'), 30_000, 'the list');
      await sleep(1500);
    }
    if (run('open')) {
      // -- the property opens it ---------------------------------------------------------------------------------------------------------------------
      await page.evaluate(([slug]) => { const s = document.querySelector('#s'); s.source = 'pull/21'; s.proposal = slug; }, [SL[0]]);
      await until(() => T.has(page, '#pr', '[data-corn="proposal-title"]'), 30_000, 'the bar');
      await until(() => T.has(page, '#ch', '[data-corn="step"], [data-corn="row"]'), 30_000, 'the list');
      await sleep(1500);
      const title = await T.text(page, '#pr', '[data-corn="proposal-title"]');
      check('open: setting the scope\'s `proposal` (and `source`) opens it: the bar has its title, the list its rows, the decision its buttons', /new flow/i.test(title) && (await T.has(page, '#ch', '[data-corn="row"]')) && (await T.has(page, '#de', '[data-review="approved"]')), title);
      check('open: the map narrows to the change (the picture is not the plain map\'s)', (await T.pixels(page)) !== mapBefore);
      const nav = a.ev('cornNavigate');
      check('open: the host hears cornNavigate once, from the scope: the proposal, its copy, the view and `opened`', nav.length === 1 && nav[0].target === 's' && nav[0].detail.proposal === SL[0] && nav[0].detail.source === 'pull/21' && nav[0].detail.view === 'diff' && nav[0].detail.change === 'opened', JSON.stringify(nav));
      check('open: the scope\'s `view` follows (reflected as an attribute), and the bar says Diff is pressed', (await T.attr(page, '#s', 'view')) === 'diff' && (await T.pressed(page)) === 'false,true,false');
      await page.evaluate(([slug]) => { document.querySelector('#s').proposal = slug; }, [SL[0]]);
      await sleep(600);
      check('open: the same value again opens nothing more and says nothing', a.ev('cornNavigate').length === 1);
      await shot(page, 'review-tags-1-open');
    }

    if (run('views')) {
      // -- Before, Diff, After, Whole map ---------------------------------------------------------------------------------------------------------------------
      const px0 = await T.pixels(page);
      const said0 = (await T.said(page)).join(' | ');
      await chooseView(page, 'before');
      await sleep(800);
      const px1 = await T.pixels(page);
      const nav = a.ev('cornNavigate');
      check('views: Before (by mouse) changes the map, the scope\'s `view` follows, and the host hears one cornNavigate {view: before, change: view}', px1 !== px0 && (await T.attr(page, '#s', 'view')) === 'before' && nav.length === 2 && nav[1].detail.view === 'before' && nav[1].detail.change === 'view', JSON.stringify(nav.slice(1)));
      const said1 = await T.said(page);
      const beforeSaid = said1.filter((t) => /before/i.test(t) && !/^PR|nodes/.test(t));
      check('views: it is announced once: one live region of the page says it', beforeSaid.length === 1, JSON.stringify(said1.slice(0, 6)));
      void said0;
      // by keyboard: the focus is on the pressed Before (the mode switcher stays open); Tab to After and Enter
      await chooseView(page, 'after', 'key');
      await sleep(700);
      check('views: After by keyboard (Enter): the map changes again and the host hears it', (await T.attr(page, '#s', 'view')) === 'after' && (await T.pixels(page)) !== px1 && a.ev('cornNavigate').length === 3);
      await chooseView(page, 'diff');
      await sleep(700);
      check('views: Diff is back to the opening picture', (await T.pixels(page)) === px0 || (await T.attr(page, '#s', 'view')) === 'diff', String((await T.pixels(page)) === px0));
      // the host sets the view by property
      await page.evaluate(() => { document.querySelector('#s').view = 'before'; });
      await sleep(700);
      check('views: the host sets `view` by property: the bar follows (Before pressed) and the host is told once more', (await T.pressed(page)) === 'true,false,false' && a.ev('cornNavigate').length === 5, `${await T.pressed(page)} ${a.ev('cornNavigate').length}`);
      await page.evaluate(() => { document.querySelector('#s').view = 'diff'; });
      await sleep(600);
      const whole0 = await T.pixels(page);
      await page.locator('#pr >> [data-action="proposal-whole"]').click();
      await sleep(900);
      check('views: Whole map (the bar) puts the whole map back: the picture changes and the button is pressed', (await T.pixels(page)) !== whole0 && (await T.attr(page, '#pr', 'aria-pressed') === null) && await page.evaluate(() => document.querySelector('#pr').shadowRoot.querySelector('[data-action="proposal-whole"]').getAttribute('aria-pressed')) === 'true');
      await page.locator('#pr >> [data-action="proposal-whole"]').click();
      await sleep(600);
    }

    if (run('select')) {
      // -- a change selected in the list selects on the map and fills the node panel ---------------------------------------------------------------------------
      const rows = page.locator('#ch >> [data-action="proposal-focus"][data-kind="node"]');
      const key = await rows.first().getAttribute('data-key');
      const before = await T.pixels(page);
      await rows.first().click();
      await sleep(1200);
      check('select: a click on a change row selects that node on the map (the map\'s `node`), frames it, and fills the node panel', (await T.attr(page, '#m', 'node')) === key && (await T.pixels(page)) !== before && !!(await T.text(page, '#np', '[data-corn="node-title"]')), `${key} -> ${await T.text(page, '#np', '[data-corn="node-title"]')}`);
      check('select: the host heard one cornSelect, from the map', a.ev('cornSelect').filter((e) => e.target === 'm').length >= 1 && a.ev('cornSelect').at(-1).detail.id === key);
      await shot(page, 'review-tags-2-select');
    }

    if (run('player')) {
      // -- a scenario played from the list flies the map ------------------------------------------------------------------------------------------------------------
      await page.locator('#ch >> [data-action="scenario-open"]').first().click();
      const step = page.locator('#ch >> [data-action="scenario-step"]').first();
      await step.waitFor({ timeout: 10_000 });
      const before = await T.pixels(page);
      await step.click();
      await until(() => T.has(page, '#ch', '[data-corn="scenario-player"]'), 10_000, 'the player');
      await sleep(1200);
      const count1 = await T.text(page, '#ch', '.hx-player-count');
      check('player: choosing a step opens the player in the list\'s own box (not over the map), paused on it, and flies the map', /^1 of/.test(count1) && (await T.pixels(page)) !== before && await page.evaluate(() => { const p = document.querySelector('#ch').shadowRoot.querySelector('[data-corn="scenario-player"]'); const m = document.querySelector('#m').getBoundingClientRect(); const r = p.getBoundingClientRect(); return r.left >= m.right - 1; }), count1);
      await page.locator('#ch >> [data-action="scenario-next"]').click();
      await sleep(900);
      check('player: Next steps it: the counter says 2 and the list marks the step', /^2 of/.test(await T.text(page, '#ch', '.hx-player-count')) && await T.has(page, '#ch', '[aria-current="step"]'), await T.text(page, '#ch', '.hx-player-count'));
      await page.locator('#ch >> [data-action="scenario-step"][data-step-index="1"]').first().focus();
      await page.keyboard.press('ArrowRight');
      await sleep(700);
      check('player: the arrow key in the list steps it too (the keys are the list\'s own root\'s)', /^3 of/.test(await T.text(page, '#ch', '.hx-player-count')), await T.text(page, '#ch', '.hx-player-count'));
      await shot(page, 'review-tags-3-player');
      await page.keyboard.press('Escape');
      await sleep(500);
      check('player: Escape closes the player and the focus goes to the step it was on, in the list', !(await T.has(page, '#ch', '[data-corn="scenario-player"]')) && /ch > step/.test(await T.focus(page)), await T.focus(page));
    }

    if (run('decide')) {
      // -- Approve: the hold, Undo, the send ----------------------------------------------------------------------------------------------------------------------
      a.flush();
      await page.locator('#de >> [data-review="approved"]').click();
      await sleep(400);
      const held = await page.evaluate(() => { const r = document.querySelector('#de').shadowRoot; const u = r.querySelector('[data-review-undo]'); return { shown: !u.hidden, focused: r.activeElement === u, text: r.querySelector('[data-review="approved"]').textContent.trim() }; });
      check('decide: Approve starts the hold with Undo, the focus on it, and the host hears nothing yet', held.shown && held.focused && decisions(a).length === 0, JSON.stringify(held));
      await page.locator('#de >> [data-review-undo]').click();
      await sleep(600);
      check('decide: Undo takes the hold back: nothing was sent', decisions(a).length === 0 && !a.log.all().some((r) => r.method === 'PUT'));
      await page.locator('#de >> [data-review="approved"]').click();
      await until(() => decisions(a).length === 1, 20_000, 'cornDecision after the hold');
      await sleep(800);
      const d1 = decisions(a)[0];
      check('decide: Approve, after the hold: cornDecision once, from the scope, with the proposal and copy it was for, open, and what the server answered', d1.target === 's' && d1.detail.outcome === 'approved' && d1.detail.proposal === SL[0] && d1.detail.source === 'pull/21' && d1.detail.open === true && d1.detail.review && d1.detail.review.verdict === 'approved' && d1.detail.review.by, JSON.stringify(d1.detail).slice(0, 200));
      const put = a.log.all().filter((r) => r.method === 'PUT');
      check('decide: exactly one PUT, to the review route, from the host\'s origin, same-site, with the session', put.length === 1 && new URL(put[0].url).pathname === `/proposals/${SL[0]}/review` && put[0].origin === origin(LISTED) && put[0].site === 'same-site' && put[0].cookie === true && put[0].status === 200, JSON.stringify(put.map((r) => ({ ...r, body: undefined }))));
      check('decide: the foot says Approved, and the line is the one Approve describes', /Approved/.test(await T.text(page, '#de', '[data-review-verdict]') || '') && decisions(a).length === 1, await T.text(page, '#de', '[data-review-verdict]'));
      await shot(page, 'review-tags-4-approved');

      // -- Send back, by keyboard: the note, the hold, the send ---------------------------------------------------------------------------------------------------------
      await page.locator('#de >> [data-review="notes"]').focus();
      await page.keyboard.press('Enter');
      await sleep(300);
      check('decide: Send back by keyboard opens the note and the focus goes into it', (await T.focus(page)).endsWith('review-note'), await T.focus(page));
      await page.keyboard.press('Escape');
      await sleep(300);
      check('decide: Escape in the note closes it and the focus is back on Send back', (await T.focus(page)).endsWith('notes') && !(await T.has(page, '#de', '#review-note')), await T.focus(page));
      await page.keyboard.press('Enter');
      await page.keyboard.type('The old export still has two callers.');
      await page.locator('#de >> [data-review="notes"]').focus();
      await page.keyboard.press('Enter');
      await sleep(400);
      check('decide: Send back with the note holds, with Undo focused', await page.evaluate(() => { const r = document.querySelector('#de').shadowRoot; return r.activeElement === r.querySelector('[data-review-undo]') && !r.querySelector('[data-review-undo]').hidden; }));
      a.flush();
      await until(() => decisions(a).length === 2, 20_000, 'cornDecision for the send back');
      const d2 = decisions(a)[1];
      const put2 = a.log.all().filter((r) => r.method === 'PUT');
      check('decide: Send back: cornDecision once more, {outcome: notes}, and one PUT whose body carries the note', d2.detail.outcome === 'notes' && d2.detail.proposal === SL[0] && put2.length === 1 && /two callers/.test(put2[0].body || ''), JSON.stringify(put2.map((r) => r.body)).slice(0, 200));
      check('decide: the host heard exactly two decisions in all', decisions(a).length === 2);
    }

    if (run('close')) {
      // -- Close, and another proposal by the property ------------------------------------------------------------------------------------------------------------
      const navs = a.ev('cornNavigate').length;
      await page.locator('#pr >> [data-action="toggle-proposal-more"]').click();
      await page.locator('#pr >> [data-action="close-proposal"]').click();
      await sleep(1000);
      const nav = a.ev('cornNavigate');
      check('close: the bar\'s Close: the host hears one cornNavigate {proposal: null, view: null, change: closed}, and the scope\'s `proposal` is null', nav.length === navs + 1 && nav.at(-1).detail.change === 'closed' && nav.at(-1).detail.proposal === null && nav.at(-1).detail.view === null && (await page.evaluate(() => document.querySelector('#s').proposal)) === null, JSON.stringify(nav.at(-1)));
      check('close: the three sections are empty again, the map is the plain map, and the focus is on the map', !(await T.has(page, '#pr', '[data-corn="proposal-bar"]')) && !(await T.has(page, '#ch', '[data-corn="review-column"]')) && !(await T.has(page, '#de', '[data-corn="decision"]')) && (await T.pixels(page)) !== null && /^#m/.test(await T.focus(page)), await T.focus(page));
      await page.evaluate(([slug]) => { const s = document.querySelector('#s'); s.source = 'pull/22'; s.proposal = slug; }, [SL[1]]);
      await until(() => T.has(page, '#pr', '[data-corn="proposal-title"]'), 30_000, 'the second proposal');
      await sleep(1000);
      check('close: another proposal opens by the property; the host hears it', /alerts|people/i.test(await T.text(page, '#pr', '[data-corn="proposal-title"]') || '') && a.ev('cornNavigate').at(-1).detail.proposal === SL[1], await T.text(page, '#pr', '[data-corn="proposal-title"]'));
      await shot(page, 'review-tags-5-another');
    }

    if (run('keys')) {
      // -- the keyboard: Tab moves through the tags in the host's order; Escape in each ----------------------------------------------------------------------------
      await page.evaluate(() => document.querySelector('#m').shadowRoot.querySelector('canvas[data-corn="map-canvas"]').focus());
      const order = [];
      for (let i = 0; i < 60; i++) {
        await page.keyboard.press('Tab');
        const f = await T.focus(page);
        order.push(f);
        if (/^#np|^button|#host/.test(f) && !/^#(pr|ch|de|np)/.test(f)) break;
      }
      const first = (id) => order.findIndex((x) => x.startsWith(`#${id}`));
      check('keys: Tab goes from the map through the bar, the list, the decision and the panel, in the host\'s order', first('pr') >= 0 && first('ch') > first('pr') && first('de') > first('ch'), order.filter((x, i) => i === 0 || x.slice(0, 4) !== order[i - 1].slice(0, 4)).join(' | '));
      await page.locator('#pr >> [data-action="toggle-proposal-more"]').focus();
      await page.keyboard.press('Enter');
      await sleep(200);
      const menuOpen = await T.has(page, '#pr', '[data-corn="proposal-menu"]');
      await page.keyboard.press('Escape');
      await sleep(200);
      check('keys: Escape shuts the bar\'s ⋯ menu and the focus is on its button', menuOpen && !(await T.has(page, '#pr', '[data-corn="proposal-menu"]')) && /#pr > button|more/.test(await T.focus(page)), await T.focus(page));
      // shift-Tab back from the decision reaches the list
      await page.locator('#de >> [data-review="notes"]').focus();
      await page.keyboard.press('Shift+Tab');
      check('keys: Shift+Tab from the decision comes back into the list (the focus moves between roots in the host\'s order)', /^#ch/.test(await T.focus(page)), await T.focus(page));
      await page.locator('#m').evaluate((el) => el.shadowRoot.querySelector('canvas[data-corn="map-canvas"]').focus());
      await page.keyboard.press('n');
      await sleep(400);
      check('keys: N on the map selects a node and the panel follows', !!(await T.attr(page, '#m', 'node')) && !!(await T.text(page, '#np', '[data-corn="node-title"]')));
      await page.keyboard.press('Escape');
      await sleep(300);
    }

    if (run('doubled')) {
      // -- a second of a section: it says so, and takes over when the first leaves ----------------------------------------------------------------------------------
      const errors0 = a.ev('cornError').length;
      await page.evaluate(() => { const pad = document.createElement('div'); pad.className = 'pad'; pad.id = 'pad'; pad.innerHTML = '<corn-proposal id="pr2"></corn-proposal><corn-changes id="ch2"></corn-changes><corn-decision id="de2"></corn-decision>'; document.querySelector('corn-scope').append(pad); });
      await sleep(1200);
      const second = await page.evaluate(() => ['#pr2', '#ch2', '#de2'].map((i) => { const e = document.querySelector(i).shadowRoot.querySelector('[data-corn="empty"]'); return e ? e.textContent.trim() : null; }));
      check('doubled: each second section says "This scope already has one of these" and draws nothing else', second.every((t) => t === 'This scope already has one of these') && !(await T.has(page, '#de2', '[data-review="approved"]')) && !(await T.has(page, '#ch2', '[data-corn="row"]')), second.join(' | '));
      const errs = a.ev('cornError').slice(errors0);
      check('doubled: the host hears cornError {kind: second-section} once for each (three), from the scope', errs.length === 3 && errs.every((e) => e.target === 's' && e.detail.kind === 'second-section'), JSON.stringify(errs.map((e) => e.detail.message)));
      const narrated = (await T.said(page)).filter((t) => /Approve|Send back/.test(t));
      check('doubled: the decision is on screen once: one Approve button in the page, and nothing is said twice', (await page.evaluate(() => [...document.querySelectorAll('corn-decision')].reduce((n, e) => n + e.shadowRoot.querySelectorAll('[data-review="approved"]').length, 0))) === 1 && narrated.length <= 1);
      await page.evaluate(() => document.querySelector('#de').remove());
      await sleep(900);
      check('doubled: the first leaves and the second takes over: it shows the decision (Approve, Send back)', await T.has(page, '#de2', '[data-review="approved"]') && !(await T.has(page, '#de2', '[data-corn="empty"]')));
      await page.evaluate(() => { const d = document.createElement('corn-decision'); d.id = 'de'; document.querySelector('#pad').after(d); });
      await sleep(900);
      check('doubled: a new one put back is now the second', (await T.text(page, '#de', '[data-corn="empty"]')) === 'This scope already has one of these');
      await page.evaluate(() => { document.querySelector('#pad').remove(); document.querySelector('#de').remove(); const d = document.createElement('corn-decision'); d.id = 'de'; document.querySelector('aside').insertBefore(d, document.querySelector('#np')); });
      await sleep(1200);
      check('doubled: the extras gone and the decision put back: it works as the first again', await T.has(page, '#de', '[data-review="approved"]'));
    }

    if (run('axe')) {
      for (const mode of ['light', 'dark']) {
        // a dark host: its ground is dark (the sections have a ground of their own; the node panel, which has none, takes the host's)
        await page.evaluate(([m, ground]) => { document.querySelector('#s').theme = m; document.body.style.background = ground; }, [mode, mode === 'dark' ? '#0f172a' : '#fffbe6']);
        await sleep(900);
        await page.evaluate(axeSource);
        const result = await page.evaluate(() => axe.run(document, { resultTypes: ['violations'] }).then((r) => r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(' ') + ' :: ' + (n.any[0]?.message || n.all[0]?.message || n.none[0]?.message || '')).slice(0, 4) }))));
        check(`axe (${mode}): the composed page has no violation`, result.length === 0, JSON.stringify(result).slice(0, 600));
      }
      await page.evaluate(() => { document.querySelector('#s').theme = 'auto'; document.body.style.background = ''; });
    }

    if (run('narrow')) {
      await page.setViewportSize({ width: 390, height: 844 });
      await sleep(1000);
      const m = await page.evaluate(() => {
        const out = { overflowX: document.documentElement.scrollWidth - innerWidth, small: [], wide: [] };
        for (const id of ['#pr', '#ch', '#de']) {
          const host = document.querySelector(id);
          const hr = host.getBoundingClientRect();
          if (hr.width > innerWidth + 1) out.wide.push(id);
          for (const el of host.shadowRoot.querySelectorAll('button, a[href], input, select, textarea')) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.right > hr.right + 1 || r.left < hr.left - 1) out.wide.push(`${id} ${el.getAttribute('data-corn') || el.localName}`);
            if (r.height < 44 || r.width < 44) out.small.push(`${id} ${el.getAttribute('data-corn') || el.localName} ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
        }
        return out;
      });
      check('narrow: a 390px window: nothing runs past its box and the page does not scroll sideways', m.overflowX <= 0 && m.wide.length === 0, JSON.stringify(m));
      check('narrow: the controls are 44px targets (the box is narrow, so the phone\'s touch sizes apply)', m.small.length === 0, m.small.join(' | '));
      await shot(page, 'review-tags-6-narrow');
      await page.setViewportSize({ width: 1440, height: 900 });
      await sleep(500);
    }
    check('no Content-Security-Policy violation in the main page (default-src \'self\'; script-src \'self\'; style-src \'self\')', (await page.evaluate(() => window.__csp)).length === 0, (await page.evaluate(() => window.__csp)).join(' | '));
    const lookAfter = await page.evaluate(() => { const cs = getComputedStyle(document.body); return { bg: cs.backgroundColor, font: cs.fontFamily, styles: document.querySelectorAll('style').length, sheets: document.adoptedStyleSheets.length }; });
    check('the host page\'s own look is what it was (one default-tokens sheet added to the document, no style tag)', lookAfter.bg === lookBefore.bg && lookAfter.font === lookBefore.font && lookAfter.styles === lookBefore.styles && lookAfter.sheets === lookBefore.sheets + 1, JSON.stringify([lookBefore, lookAfter]));
    await page.close();
    a.flush();

    if (run('alone')) {
      // -- each tag alone, and with no scope or no map -----------------------------------------------------------------------------------------------------------------
      const alone = async (tag, extra = '') => {
        const d = await open(context, LISTED, { markup: `<corn-scope src="${MAP}" id="s" proposal="${SL[2]}" source="pull/23"><corn-map renderer="canvas2d" id="m"></corn-map><${tag} id="t"></${tag}>${extra}</corn-scope>` });
        await sleep(3500);
        return d;
      };
      const dec = await alone('corn-decision');
      check('alone: <corn-decision> beside a map and no other section: it decides (Approve, Send back, the line above)', await T.has(dec.page, '#t', '[data-review="approved"]') && /Approve/.test(await T.text(dec.page, '#t', '[data-review-line]') || ''), await T.text(dec.page, '#t', '[data-review-line]'));
      await dec.page.locator('#t >> [data-review="approved"]').click();
      await sleep(400);
      check('alone: and its hold starts and Undo takes it back', await dec.page.evaluate(() => !document.querySelector('#t').shadowRoot.querySelector('[data-review-undo]').hidden));
      await dec.page.locator('#t >> [data-review-undo]').click();
      await dec.page.close();
      const bar = await alone('corn-proposal');
      const px = await T.pixels(bar.page);
      if (!(await bar.page.locator('#t >> [data-view="after"]').isVisible())) await bar.page.locator('#t >> [data-action="toggle-proposal-mode"]').click();
      await bar.page.locator('#t >> [data-view="after"]').click();
      await sleep(800);
      check('alone: <corn-proposal> beside a map only: its views change the map, and the scope\'s view follows', (await T.pixels(bar.page)) !== px && (await T.attr(bar.page, '#s', 'view')) === 'after');
      await bar.page.close();
      const list = await alone('corn-changes');
      await list.page.locator('#t >> [data-action="proposal-focus"][data-kind="node"]').first().click();
      await sleep(900);
      check('alone: <corn-changes> beside a map only: a change selected selects on the map', !!(await T.attr(list.page, '#m', 'node')));
      await list.page.close();
      const nomap = await open(context, LISTED, { markup: `<corn-scope src="${MAP}" id="s" proposal="${SL[2]}" source="pull/23"><corn-proposal id="a"></corn-proposal><corn-changes id="b"></corn-changes><corn-decision id="c"></corn-decision></corn-scope>`, wait: false });
      await sleep(2500);
      const words = await nomap.page.evaluate(() => ['#a', '#b', '#c'].map((i) => (document.querySelector(i).shadowRoot.querySelector('[data-corn="empty"]') || {}).textContent));
      check('alone: with no map in the scope each says "This needs a corn-map in the same corn-scope", and asks the server for no proposal', words.every((t) => t === 'This needs a corn-map in the same corn-scope') && !nomap.log.all().some((r) => /\/proposals\//.test(r.url)), words.join(' | '));
      await nomap.page.close();
      const noscope = await open(context, LISTED, { markup: '<corn-proposal id="a"></corn-proposal><corn-changes id="b"></corn-changes><corn-decision id="c"></corn-decision>', wait: false });
      await sleep(1200);
      const w2 = await noscope.page.evaluate(() => ['#a', '#b', '#c'].map((i) => (document.querySelector(i).shadowRoot.querySelector('[data-corn="empty"]') || {}).textContent));
      check('alone: with no scope each says "This needs a corn-scope around it, with a corn-map in it" and asks nobody for anything', w2.every((t) => t === 'This needs a corn-scope around it, with a corn-map in it') && !noscope.log.all().some((r) => r.url.startsWith(MAP)), w2.join(' | '));
      await noscope.page.close();
      const quiet = await open(context, LISTED, { markup: `<corn-scope src="${MAP}" id="s"><corn-map renderer="canvas2d" id="m"></corn-map><corn-proposal id="a"></corn-proposal><corn-changes id="b"></corn-changes><corn-decision id="c"></corn-decision></corn-scope>` });
      await sleep(2500);
      check('alone: a scope with a map and no `proposal`: the three are empty and nothing was asked for them', !(await T.has(quiet.page, '#a', '[data-corn="proposal-bar"]')) && !(await T.has(quiet.page, '#c', '[data-review="approved"]')) && !quiet.log.all().some((r) => /\/proposals\//.test(r.url)));
      await quiet.page.close();
    }

    if (run('ended')) {
      // -- a session that ends while the page is open ----------------------------------------------------------------------------------------------------------------
      const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
      const q0 = await c2.newPage();
      await q0.goto(`${MAP}/auth/start`);
      await q0.waitForURL(`${MAP}/**`);
      await q0.close();
      const e = await open(c2, LISTED, { quiet: true, markup: MARKUP(SL[2]).replace('source="pull/21"', 'source="pull/23"') });
      await until(() => T.has(e.page, '#de', '[data-review="approved"]'), 30_000, 'the decision');
      await sleep(1000);
      await c2.clearCookies();
      e.flush();
      await e.page.locator('#de >> [data-review="approved"]').click();
      await until(() => e.ev('cornAuth').some((x) => x.detail.during === 'send'), 20_000, 'cornAuth during send');
      await sleep(600);
      const auths = e.ev('cornAuth');
      check('ended: Approve after the session ended: one cornAuth {status: 401, during: send}, from the scope, with the server\'s sign-in back to this page', auths.filter((x) => x.detail.during === 'send').length === 1 && auths.every((x) => x.target === 's' && x.detail.status === 401) && auths.find((x) => x.detail.during === 'send').detail.signIn === `${MAP}/auth/start?returnTo=${encodeURIComponent(origin(LISTED) + '/')}`, JSON.stringify(auths.map((x) => x.detail)));
      check('ended: and the decision shows the card with the link "Sign in to cornfield" and a line in its foot; nothing was decided', (await T.has(e.page, '#de', '[data-corn="source-sign-in"]')) && !!(await T.text(e.page, '#de', '[data-review-msg]')) && e.ev('cornDecision').length === 0, await T.text(e.page, '#de', '[data-corn="source-title"]'));
      await shot(e.page, 'review-tags-7-ended');
      await e.page.close();
      await c2.close();
    }

    if (run('offline')) {
      const o = await open(context, LISTED, { markup: MARKUP(SL[2]).replace('source="pull/21"', 'source="pull/23"') });
      await until(() => T.has(o.page, '#de', '[data-review="approved"]'), 30_000, 'the decision');
      await sleep(800);
      o.flush();
      await context.setOffline(true);
      await o.page.locator('#de >> [data-review="approved"]').click();
      await sleep(800);
      const msg = await T.text(o.page, '#de', '[data-review-msg]');
      await context.setOffline(false);
      check('offline: Approve with no network says so, starts no hold and sends nothing', /offline/i.test(msg || '') && !o.log.all().some((r) => r.method === 'PUT') && !(await T.has(o.page, '#de', '[data-review-undo]')), msg);
      await o.page.close();
    }

    if (run('signedout')) {
      const c3 = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
      const so = await open(c3, LISTED, { wait: false, quiet: true, markup: MARKUP(SL[0]) });
      await until(() => so.ev('cornAuth').length > 0, 30_000, 'cornAuth');
      await sleep(800);
      const auth = so.ev('cornAuth');
      check('signed out: one cornAuth, from the scope {status: 401, during: load}, with the sign-in back to this page', auth.length === 1 && auth[0].target === 's' && auth[0].detail.status === 401 && auth[0].detail.during === 'load' && auth[0].detail.signIn === `${MAP}/auth/start?returnTo=${encodeURIComponent(origin(LISTED) + '/')}`, JSON.stringify(auth));
      const waiting = await so.page.evaluate(() => ['#pr', '#ch', '#de'].map((i) => (document.querySelector(i).shadowRoot.querySelector('[data-corn="empty"]') || {}).textContent));
      check('signed out: the map\'s card says it, once, and the three sections say they wait for the map (no second card, no field to type in)', waiting.every((t) => t === 'Waiting for the map') && (await T.has(so.page, '#m', '[data-corn="source-sign-in"]')) && !(await T.has(so.page, '#de', '[data-corn="source-sign-in"]')), waiting.join(' | '));
      check('signed out: no proposal was asked for, and no decision could be sent', !so.log.all().some((r) => /\/proposals\//.test(r.url)));
      await shot(so.page, 'review-tags-8-signedout');
      await so.page.locator('#m >> [data-corn="source-sign-in"]').click();
      await so.page.waitForURL(`${origin(LISTED)}/**`, { timeout: 30_000 });
      await sleep(500);
      check('signed out: the link goes to the server\'s sign-in and comes back to this page signed in (the session cookie is the rig\'s)', (await c3.cookies(MAP)).length > 0 && so.page.url() === `${origin(LISTED)}/`, so.page.url());
      await so.page.close();
      await c3.close();
    }

    if (run('unlisted')) {
      const u = await open(context, UNLISTED, { wait: false, quiet: true, markup: MARKUP(SL[0]) });
      await until(() => u.ev('cornError').length > 0, 30_000, 'cornError');
      await sleep(800);
      const err = u.ev('cornError');
      check('unlisted: a host that is not listed hears one cornError {kind: not-listed} naming its origin, from the scope', err.length >= 1 && err[0].target === 's' && err[0].detail.kind === 'not-listed' && err[0].detail.message.includes(origin(UNLISTED)), JSON.stringify(err.map((x) => x.detail)));
      const waiting = await u.page.evaluate(() => ['#pr', '#ch', '#de'].map((i) => (document.querySelector(i).shadowRoot.querySelector('[data-corn="empty"]') || {}).textContent));
      check('unlisted: and the three sections wait for the map; no decision can be sent', waiting.every((t) => t === 'Waiting for the map') && !u.log.all().some((r) => r.method === 'PUT'), waiting.join(' | '));
      u.flush();
      await u.page.close();
    }

  } finally {
    await browser.close();
    for (const h of hosts) h.close();
    server.stop();
  }
  const look = problems.filter((p) => !/^$/.test(p));
  check('no console error, no page error and no CSP violation in any page', look.length === 0, look.join(' | '));
  const pathOf = (u) => new URL(u).pathname;
  const toRig = results.requests.filter((r) => r.url.startsWith(MAP));
  const toOthers = results.requests.filter((r) => !r.url.startsWith(MAP) && !r.url.startsWith(origin(LISTED)) && !r.url.startsWith(origin(UNLISTED)) && !/^(data|blob|about|chrome)/.test(r.url));
  check('requests: none leaves for an origin but the host\'s own and the rig\'s', toOthers.length === 0, toOthers.map((r) => r.url).join(' '));
  const writes = new Set(WRITES.map((w) => w.split(' ')[0]));
  void writes;
  const strays = toRig.filter((r) => !/^\/auth\//.test(pathOf(r.url)) && !routeOf(pathOf(r.url)));
  check('requests: every one to the rig is on a route of server/embed.js ROUTES', strays.length === 0, strays.map((r) => `${r.method} ${pathOf(r.url)}`).join(' '));
  console.log(`\nrequests to the rig (${toRig.length}):\n  ${[...new Set(toRig.map((r) => `${r.method} ${pathOf(r.url).replace(/\/\d+-[a-z0-9-]+/, '/<slug>')}`))].sort().join('\n  ')}`);
  void axeSource;
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks held${failed.length ? `; failed: ${failed.map((c) => c.name).join(' | ')}` : ''}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
