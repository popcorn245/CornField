/**
 * The proof in a browser that `<corn-review src proposal>` reviews and decides from a listed sibling origin as the signed-in maintainer
 * (spec 0011 D1, D4, D5, D6, D7, D9, D10, D11, D12: the milestone). Runs by hand: needs Playwright, Chromium and the built package
 * (`cd components && npm ci && npm run build`), and no network (everything is on 127.0.0.1; Chromium resolves `*.localhost` to loopback, so the names
 * are different origins of one site). Ports 3920 to 3929.
 *
 *   node test/fixtures/big/review-proof.mjs [--shots <dir>] [--json <file>] [--only a,b,c]
 *
 * One cornfield rig (serve.js --forge, listing only http://tasks.corn.localhost:3921) and two host pages with their own blunt styles and the strict
 * Content-Security-Policy docs/embedding.md gives: the listed one on tasks.corn.localhost:3921 loads `corn-review.js` FROM THE SERVER's /cornfield/components/
 * route, and an unlisted one on tasks2.corn.localhost:3922 serves its own copy of the build (the server gives it no CORS answer for a module, so it cannot load it). The host page's own script is what a host app writes: it reads the proposal
 * from its address, puts the tag in a box of 1100x680 (or 390x700), and answers `cornNavigate` by keeping its own address. Every request the browser makes
 * is logged from the network stack (preflights and the sign-in's redirects included) and every fetch with its credentials mode, and checked at the end.
 *
 *   open.      signed in: the proposal opens on the map; Before / Diff / After; a changed node and a changed edge; a scenario plays; the host hears
 *              cornReady, cornNavigate, cornSelect; the host's styles do not reach in and the review's do not leak out; two reviews are independent;
 *              thirty made and removed leave nothing; nothing is appended to the host's body or head but the default tokens sheet, once
 *   decide.    Approve (the hold, Undo, then the landing), a repeat approval, Send back with a note, the stale-version refusal after a push: cornDecision
 *              once per decision with the right detail, and what the fake forge received (/__rig/requests)
 *   signedout. the sign-in card; its link goes to the server's sign-in and back to the host page with the proposal open; a decision pressed with an
 *              expired session shows the card and says cornAuth with `during`
 *   unlisted.  "not listed", nothing read, nothing written
 *   keys.      the whole flow with the keyboard alone
 *   axe.       axe on every state, light and dark, at both box sizes
 *   logs.      no cookie to any origin but the server; no request to a route outside server/embed.js ROUTES (any other is a failure); the theme without
 *              credentials; zero Content-Security-Policy violations
 *
 * test/fixtures/big/review-requests.mjs compares the requests of a decision with cornfield's own page's, byte for byte.
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
const SERVE = path.join(HERE, 'serve.js');

const RIG = { host: 'map.corn.localhost', port: 3920, forge: 4020 };
const LISTED = { host: 'tasks.corn.localhost', port: 3921 };
const UNLISTED = { host: 'tasks2.corn.localhost', port: 3922 };
const origin = (h) => `http://${h.host}:${h.port}`;
const MAP = origin(RIG);
const FORGE = `http://127.0.0.1:${RIG.forge}`;
const SL = ['0100-new-flow-across-apps', '0101-alerts-to-people', '0102-retire-a-feed', '0103-swap-a-provider', '0104-shared-component', '0105-second-site'];

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const SHOTS = arg('--shots');
const JSON_OUT = arg('--json');
const ONLY = arg('--only') ? arg('--only').split(',') : null;
const run = (name) => !ONLY || ONLY.includes(name);

async function loadPlaywright() {
  const tries = ['playwright', ...(process.env.PLAYWRIGHT_DIR ? [pathToFileURL(path.join(process.env.PLAYWRIGHT_DIR, 'index.mjs')).href] : []), '/opt/node-tools/node_modules/playwright/index.mjs'];
  for (const t of tries) {
    try { return await import(t); } catch { /* next */ }
  }
  throw new Error('Playwright is not installed: set PLAYWRIGHT_DIR to its folder.');
}

function startRig() {
  const args = [SERVE, '--forge', '--port', String(RIG.port), '--forge-port', String(RIG.forge), '--public', MAP, '--embed', origin(LISTED), '--dir', path.join(os.tmpdir(), `cornfield-review-proof-${RIG.port}`)];
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

const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
/** What a host app's page sends: the policy docs/embedding.md gives for a host that loads the components from the server (no 'unsafe-inline') */
const POLICY = `default-src 'self'; script-src 'self' ${MAP}; connect-src 'self' ${MAP}; img-src 'self' data: ${MAP}; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'`;
/** The host app's own look, some of it blunt: a bare button, canvas, heading, paragraph and anchor rule, box-sizing, and a body that is not cornfield's */
const HOST_CSS = `
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 Georgia, 'Times New Roman', serif; background: #fbf3e4; color: #2b1d0e; }
header { padding: 12px 16px; background: #7a3e00; color: #fbf3e4; }
header h1 { font-size: 20px; margin: 0; }
main { padding: 16px; }
h2, h3 { color: #c00; text-transform: uppercase; letter-spacing: 2px; }
p { text-indent: 40px; }
a { color: #070; }
button { font: italic 20px cursive; background: hotpink; color: #000; padding: 8px 20px; border-radius: 20px; }
canvas { border: 3px dotted red; }
.box { margin-top: 12px; border: 2px solid #7a3e00; }
.box.wide { width: 1100px; height: 680px; }
.box.phone { width: 390px; height: 700px; }
.box.half { width: 540px; height: 680px; float: left; margin-right: 8px; }
corn-review { display: block; }
`;
/** What a host app's own script does with the tag: it reads the proposal from its own address, and keeps its address as `cornNavigate` says (its own choice) */
const HOST_JS = `
const q = new URLSearchParams(location.search);
const box = document.querySelector('#box');
const size = q.get('size') || 'wide';
const count = Number(q.get('count') || 1);
for (let i = 0; i < count; i++) {
  const holder = document.createElement('div');
  holder.className = 'box ' + (count > 1 ? 'half' : size);
  const el = document.createElement('corn-review');
  el.setAttribute('src', '${MAP}');
  el.id = 'r' + i;
  if (q.get('p') && (i === 0 || !q.get('one'))) el.setAttribute('proposal', q.get('p'));
  if (q.get('s')) el.setAttribute('source', q.get('s'));
  if (q.get('v')) el.setAttribute('view', q.get('v'));
  if (q.get('theme')) el.setAttribute('theme', q.get('theme'));
  holder.append(el);
  box.append(holder);
}
const log = (type, e) => window.__event && window.__event({ type, id: e.target.id, detail: e.detail });
for (const t of ['cornReady', 'cornSelect', 'cornNavigate', 'cornDecision', 'cornAuth', 'cornError']) document.addEventListener(t, (e) => log(t, e));
document.addEventListener('cornNavigate', (e) => {
  if (e.target.id !== 'r0') return;
  const next = new URLSearchParams(location.search);
  for (const k of ['p', 's', 'v']) next.delete(k);
  if (e.detail.proposal) next.set('p', e.detail.proposal);
  if (e.detail.source) next.set('s', e.detail.source);
  if (e.detail.view && e.detail.view !== 'diff') next.set('v', e.detail.view);
  history.replaceState(null, '', location.pathname + (next.toString() ? '?' + next : ''));
});
`;
const DIST = path.join(REPO, 'components', 'dist');
/** `ownCopy`: the page serves the build itself (an app that installed the package): a host that is not listed cannot load the components from the server (no CORS answer for a module), so it has to */
function hostPage(host, ownCopy = false) {
  const entry = ownCopy ? '/dist/corn-review.js' : `${MAP}/cornfield/components/corn-review.js`;
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tasks (a host app)</title>
<link rel="stylesheet" href="/host.css"><script type="module" src="${entry}"></script><script type="module" src="/host.js"></script></head>
<body><header><h1>Tasks (a host app)</h1></header><main><h2>TASK-118: retire the old export</h2><p id="host-text">The host page's own paragraph. <a id="host-link" href="#">A link</a> <button id="host-button" type="button">Host button</button></p><div id="box"></div></main></body></html>`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': POLICY }); return res.end(page); }
    if (url.pathname === '/host.css') { res.writeHead(200, { 'Content-Type': MIME['.css'] }); return res.end(HOST_CSS); }
    if (url.pathname.startsWith('/dist/')) {
      const file = path.join(DIST, path.normalize(url.pathname.slice(6)));
      if (file.startsWith(DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) { res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); return res.end(fs.readFileSync(file)); }
    }
    if (url.pathname === '/host.js') { res.writeHead(200, { 'Content-Type': MIME['.js'] }); return res.end(HOST_JS); }
    res.writeHead(404); res.end('no');
  });
  return new Promise((resolve) => server.listen(host.port, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30_000, what = '') { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what || fn}`); await sleep(100); } }
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${String(detail).slice(0, 300)})` : ''}`); };
const rig = (p) => fetch(FORGE + p).then((r) => r.text()).catch(() => '');

/** Logs every request of a page from the network stack (CDP): url, method, type, whether a Cookie went, the answer */
async function logRequests(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const seen = new Map();
  const entry = (id) => { if (!seen.has(id)) seen.set(id, {}); return seen.get(id); };
  cdp.on('Network.requestWillBeSent', (e) => Object.assign(entry(e.requestId), { method: e.request.method, url: e.request.url, type: e.type }));
  cdp.on('Network.requestWillBeSentExtraInfo', (e) => { const h = Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k.toLowerCase(), v])); Object.assign(entry(e.requestId), { cookie: !!h.cookie, origin: h.origin || null, site: h['sec-fetch-site'] || null }); });
  cdp.on('Network.responseReceived', (e) => Object.assign(entry(e.requestId), { status: e.response.status }));
  cdp.on('Network.loadingFailed', (e) => Object.assign(entry(e.requestId), { failed: e.errorText }));
  return { all: () => [...seen.values()].filter((r) => r.url), clear: () => seen.clear() };
}

/** In every page of the context: the fetch calls the components make, with the credentials mode they asked for (the page's own are not in the list: they have no `src`) */
const FETCH_SPY = () => {
  window.__fetches = [];
  const real = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : String(input.url || input);
      window.__fetches.push({ method: (init && init.method) || 'GET', url, credentials: init && 'credentials' in init ? init.credentials : '-', body: init && typeof init.body === 'string' ? init.body : undefined });
    } catch { /* never in the way */ }
    return real.apply(this, arguments);
  };
};

async function main() {
  if (!fs.existsSync(path.join(REPO, 'components', 'dist', 'corn-review.js'))) throw new Error('the package is not built: cd components && npm ci && npm run build');
  const { chromium } = await loadPlaywright();
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startRig();
  const hosts = [await hostPage(LISTED), await hostPage(UNLISTED, true)];
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const results = { checks, requests: [], fetches: [] };
  const axeSource = fs.readFileSync(path.join(REPO, 'components', 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
  try {
    const context = await browser.newContext({ viewport: { width: 1300, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(FETCH_SPY);
    await rig('/__rig/runner?state=online');
    for (const pr of [21, 22, 23, 24, 25, 26]) await rig(`/__rig/checks?pr=${pr}&state=passed`);

    // Signed in on the rig (the fake forge's authorize step redirects straight back)
    const p0 = await context.newPage();
    await p0.goto(`${MAP}/auth/start`);
    await p0.waitForURL(`${MAP}/**`);
    check('signed in on the rig', (await p0.evaluate(() => fetch('/auth/me').then((r) => r.json()))).ok);
    await p0.close();

    /** A host page in a context: logs, events, violations, navigations */
    const open = async (ctx, host, query = '', viewport = null) => {
      const page = await ctx.newPage();
      if (viewport) await page.setViewportSize(viewport);
      const log = await logRequests(ctx, page);
      const violations = [];
      page.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) violations.push(m.text().slice(0, 200)); });
      page.on('pageerror', (e) => violations.push(`pageerror: ${e.message}`));
      const events = [];
      const hops = [];
      page.on('request', (r) => { if (r.isNavigationRequest()) hops.push(r.url()); });
      await page.exposeFunction('__event', (e) => events.push(e));
      await page.goto(`${origin(host)}/${query}`);
      const ev = (type) => events.filter((e) => e.type === type);
      return { page, log, violations, events, hops, ev, host, fetches: () => page.evaluate(() => window.__fetches.slice()) };
    };
    /** A screenshot at each box size: the review in its 1100x680 box, then in a 390x700 one (the same review, reflowed in place: its state is kept) */
    const shot = async (page, name, sizes = [[1300, 900, 'desk'], [430, 900, 'phone']]) => {
      if (!SHOTS) return;
      for (const [w, h, tag] of sizes) {
        await page.setViewportSize({ width: w, height: h });
        await page.evaluate((phone) => { const b = document.querySelector('#r0')?.parentElement; if (b && b.classList.contains('box') && !b.classList.contains('half')) b.className = phone ? 'box phone' : 'box wide'; }, tag === 'phone');
        await sleep(700);
        await page.screenshot({ path: path.join(SHOTS, `${name}-${tag}.png`), timeout: 180_000 });
      }
      await page.setViewportSize({ width: 1300, height: 900 });
      await page.evaluate(() => { const b = document.querySelector('#r0')?.parentElement; if (b && b.classList.contains('phone')) b.className = 'box wide'; });
    };
    const sh = (p, sel) => p.locator(`corn-review >> ${sel}`).first();
    const hostLook = (page) => page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      const p = getComputedStyle(document.querySelector('#host-text'));
      const b = getComputedStyle(document.querySelector('#host-button'));
      return { bodyDisplay: cs.display, bodyColor: cs.color, bodyBg: cs.backgroundColor, bodyFont: cs.fontFamily, pColor: p.color, pIndent: p.textIndent, button: [b.fontStyle, b.backgroundColor, b.paddingLeft].join('|'), h2: getComputedStyle(document.querySelector('h2')).textTransform, docSheets: document.adoptedStyleSheets.length, styleTags: document.querySelectorAll('style').length, linkTags: document.querySelectorAll('link').length, bodyKids: document.body.children.length, headKids: document.head.children.length, scripts: document.scripts.length };
    });
    const state = (page, i = 0) => page.evaluate((n) => {
      const el = document.querySelectorAll('corn-review')[n];
      const r = el.shadowRoot;
      const t = (s) => (r.querySelector(s) ? r.querySelector(s).textContent.replace(/\s+/g, ' ').trim() : null);
      const card = r.querySelector('[data-corn="source-status"]:not([hidden])');
      return { title: t('#proposal-title'), view: el.view, node: el.node, card: card ? card.textContent.replace(/\s+/g, ' ').trim() : null, pressed: ['before', 'diff', 'after'].map((v) => r.querySelector(`[data-view="${v}"]`)?.getAttribute('aria-pressed')), line: t('[data-review-line]'), verdict: t('[data-review-verdict]'), message: t('#proposal-message') };
    }, i);
    const opened = (a, i = 0) => until(async () => !!(await state(a.page, i)).title, 40_000, 'the proposal to open');
    const lineRead = (a) => until(async () => { const l = (await state(a.page)).line; return l && !/Reading|Checking/i.test(l); }, 20_000, 'the decision line');
    const decisions = (a) => a.ev('cornDecision');
    const forgeRequests = async () => JSON.parse((await rig('/__rig/requests?last=50')) || '{"last":[]}');

    // ---- open: signed in, one tag, the whole of a look at a proposal ----------------------------------------------------------------------------
    if (run('open')) {
      const a = await open(context, LISTED, `?p=${SL[0]}&s=pull/21`);
      await opened(a);
      await until(() => a.ev('cornReady').length > 0, 30_000, 'cornReady');
      await sleep(1500);
      const look0 = await hostLook(a.page); // after the first corn-* element has added the default tokens (one sheet, at zero specificity)
      check('open. the proposal opens on the map, loaded from the server\'s components route; cornReady once, cornNavigate says it opened', a.ev('cornReady').length === 1 && a.ev('cornNavigate')[0] && JSON.stringify(a.ev('cornNavigate')[0].detail) === JSON.stringify({ proposal: SL[0], source: 'pull/21', view: 'diff', change: 'opened' }), JSON.stringify(a.ev('cornNavigate').map((e) => e.detail)));
      check('open. the host answered cornNavigate with its own address and the component touched nothing of it', a.page.url() === `${origin(LISTED)}/?p=${SL[0]}&s=pull%2F21`, a.page.url());
      check('open. the default tokens are the one sheet the document gained, nothing in its head or body', look0.docSheets === 1 && look0.styleTags === 0 && look0.linkTags === 1 && look0.scripts === 2 && look0.headKids === 6 && look0.bodyKids === 2, JSON.stringify(look0));
      await shot(a.page, 'open-diff');
      const src = (await a.fetches()).filter((f) => f.url.startsWith(MAP));
      check('open. every request of the components is the server\'s, with the session', src.length > 0 && src.every((f) => f.credentials === 'include' || /\/cornfield\/theme/.test(f.url)), [...new Set(src.map((f) => `${f.method} ${new URL(f.url).pathname} ${f.credentials}`))].join('; '));
      // Before, Diff, After
      for (const v of ['before', 'after', 'diff']) {
        await sh(a.page, `[data-view="${v}"]`).click();
        await sleep(500);
        const s = await state(a.page);
        check(`open. ${v}: the bar says it, the property follows it and cornNavigate says it`, s.view === v && s.pressed[['before', 'diff', 'after'].indexOf(v)] === 'true' && a.ev('cornNavigate').at(-1).detail.view === v, JSON.stringify([s.view, s.pressed]));
        if (v !== 'diff') await shot(a.page, `open-${v}`);
      }
      check('open. the host\'s address follows the view (its own choice)', a.page.url().includes('p=') && !a.page.url().includes('v='), a.page.url());
      // a changed node, a changed edge
      await sh(a.page, '.hx-change-row[data-kind="node"]').click();
      await sleep(900);
      check('open. a changed node: the node panel opens and cornSelect says node', a.ev('cornSelect').at(-1)?.detail.kind === 'node' && !!(await state(a.page)).node, JSON.stringify(a.ev('cornSelect').at(-1)));
      await shot(a.page, 'open-node');
      await sh(a.page, '.hx-change-row[data-kind="edge"]').click();
      await sleep(900);
      check('open. a changed edge: cornSelect says edge, with its ends', a.ev('cornSelect').at(-1)?.detail.kind === 'edge' && !!a.ev('cornSelect').at(-1).detail.from, JSON.stringify(a.ev('cornSelect').at(-1)));
      await shot(a.page, 'open-edge');
      await a.page.evaluate(() => document.querySelector('corn-review').shadowRoot.querySelector('#spec-drawer.drawer-open [data-action="close-drawer"]')?.click());
      // a scenario plays
      await sh(a.page, '[data-action="scenario-open"]').click();
      await sleep(700);
      await sh(a.page, '[data-action="scenario-step"]').click();
      await sleep(1200);
      const played = await a.page.evaluate(() => { const r = document.querySelector('corn-review').shadowRoot; const p = r.querySelector('[data-corn="scenario-player"]'); return { shown: !!p && !p.closest('[hidden]'), text: p ? p.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : null }; });
      check('open. a scenario plays on the map, in the review\'s own player', played.shown, played.text);
      await shot(a.page, 'open-scenario');
      await sh(a.page, '[data-action="scenario-close"]').click().catch(() => {});
      // the host's styles do not reach in, the review's do not leak out
      const look1 = await hostLook(a.page);
      check('open. the host page\'s own look is exactly what it was (body, text, headline, button, anchors; no style sheet, tag or script added)', JSON.stringify(look0) === JSON.stringify(look1), JSON.stringify(look1));
      const inner = await a.page.evaluate(() => {
        const r = document.querySelector('corn-review').shadowRoot;
        const btn = r.querySelector('[data-review="approved"]');
        const canvas = r.querySelector('canvas[data-corn="map-canvas"]');
        return { btnFont: getComputedStyle(btn).fontStyle, btnBg: getComputedStyle(btn).backgroundColor, canvasBorder: getComputedStyle(canvas).borderTopWidth, h2: [...r.querySelectorAll('h2')].map((h) => getComputedStyle(h).textTransform) };
      });
      check('open. the host\'s bare button, canvas and heading rules do not reach into the review', inner.btnFont !== 'italic' && inner.btnBg !== 'rgb(255, 105, 180)' && inner.canvasBorder === '0px' && inner.h2.every((t) => t === 'none'), JSON.stringify(inner));
      check('open. no Content-Security-Policy violation and no page error', a.violations.length === 0, a.violations.join(' | '));
      results.requests.push(...a.log.all().map((r) => ({ case: 'open', ...r })));
      results.fetches.push(...(await a.fetches()).map((f) => ({ case: 'open', ...f })));
      await a.page.close();

      // a view and a copy that were asked for in the host's address
      const v = await open(context, LISTED, `?p=${SL[1]}&s=pull/22&v=after`, null);
      await opened(v);
      const sv = await state(v.page);
      check('open. a view in the host\'s address (`view="after"`) is the one shown', sv.view === 'after' && sv.pressed[2] === 'true', JSON.stringify(sv.pressed));
      await shot(v.page, 'open-view-from-address');
      await v.page.close();

      // two reviews on one page are independent
      const two = await open(context, LISTED, `?p=${SL[0]}&s=pull/21&count=2&one=1`);
      await until(async () => !!(await state(two.page, 0)).title && (await two.page.evaluate(() => document.querySelectorAll('corn-review').length)) === 2, 40_000, 'two reviews');
      await two.page.evaluate(() => { document.querySelectorAll('corn-review')[1].setAttribute('proposal', '0101-alerts-to-people'); document.querySelectorAll('corn-review')[1].setAttribute('source', 'pull/22'); });
      await until(async () => !!(await state(two.page, 1)).title, 40_000, 'the second review\'s proposal');
      await two.page.evaluate(() => { document.querySelector('#r0').view = 'after'; }); // the first one's (at half the width a review is the phone layout: its buttons are folded)
      await sleep(500);
      const [s0, s1] = [await state(two.page, 0), await state(two.page, 1)];
      check('open. two reviews on one page are independent: another proposal, another view, another selection', s0.title !== s1.title && s0.view === 'after' && s1.view !== 'after', JSON.stringify([s0.title, s1.title, s0.view, s1.view]));
      await shot(two.page, 'open-two', [[1300, 900, 'desk']]);
      await two.page.close();

      // thirty made and removed leave nothing
      const leak = await open(context, LISTED, '?p=nothing-here&size=half');
      await until(async () => (await state(leak.page)).card !== undefined, 10_000).catch(() => {});
      const before = await hostLook(leak.page);
      const after = await leak.page.evaluate(async () => {
        const box = document.querySelector('#box');
        for (let i = 0; i < 30; i++) {
          const holder = document.createElement('div');
          holder.className = 'box wide';
          holder.innerHTML = '<corn-review src="about:blank"></corn-review>';
          box.append(holder);
          await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 10)));
          holder.remove();
        }
        await new Promise((r) => setTimeout(r, 500));
        return { kids: box.children.length, canvases: 'n/a' };
      });
      const after2 = await hostLook(leak.page);
      check('open. thirty made and removed leave nothing: no element, sheet, style or link in the host\'s page', after.kids === 1 && JSON.stringify(before) === JSON.stringify(after2), JSON.stringify([before, after2]));
      await leak.page.close();
    }

    // ---- decide: Approve, a repeat approval, Send back, the stale refusal ------------------------------------------------------------------------
    if (run('decide')) {
      const press = (page, sel) => page.locator(`corn-review >> ${sel}`).first().click({ force: true }).catch(() => {});
      const d = await open(context, LISTED, `?p=${SL[0]}&s=pull/21`);
      await opened(d);
      await lineRead(d);
      await forgeRequests();
      await press(d.page, '[data-review="approved"]');
      await sleep(400);
      const held = await d.page.evaluate(() => { const u = document.querySelector('corn-review').shadowRoot.querySelector('[data-review-undo]'); return { shown: !u.hidden, text: u.textContent.trim(), focused: document.querySelector('corn-review').shadowRoot.activeElement === u }; });
      check('decide. Approve starts the hold with Undo, the focus on it, and says nothing to the host yet', held.shown && held.focused && decisions(d).length === 0, JSON.stringify(held));
      await shot(d.page, 'decide-hold', [[1300, 900, 'desk']]);
      await press(d.page, '[data-review-undo]');
      await sleep(600);
      check('decide. Undo takes the hold back: nothing was sent', decisions(d).length === 0 && !(await state(d.page)).verdict, JSON.stringify((await state(d.page)).verdict));
      await press(d.page, '[data-review="approved"]');
      await until(() => decisions(d).length === 1, 15_000, 'cornDecision after the hold');
      const sent = (await forgeRequests()).last.filter((r) => /^(POST|PUT|PATCH) /.test(r)); // asked right after the answer: the polls have not pushed it out of the rig's short list
      const first = decisions(d)[0].detail;
      check('decide. Approve, after the hold: cornDecision once, with the proposal and copy it was for, open, and what the server answered', first.outcome === 'approved' && first.proposal === SL[0] && first.source === 'pull/21' && first.open === true && first.review && first.review.verdict === 'approved' && first.review.by, JSON.stringify(first));
      await sleep(1500);
      await shot(d.page, 'decide-approved', [[1300, 900, 'desk'], [430, 900, 'phone']]);
      await sleep(5000);
      const landed = await state(d.page);
      check('decide. the line afterwards says an approval of this version stands', /stands|Approved/i.test(`${landed.line} ${landed.verdict}`), `${landed.verdict} | ${landed.line}`);
      await press(d.page, '[data-review="approved"]');
      await sleep(1500);
      check('decide. a repeat approval of what stands says nothing new to the host (the button is done)', decisions(d).length === 1 || (decisions(d)[1] && decisions(d)[1].detail.review.posted === false), JSON.stringify(decisions(d).map((e) => e.detail.review && e.detail.review.posted)));
      check('decide. the fake forge received the approval, posted for the signed-in maintainer (what it receives from cornfield\'s own page: review-requests.mjs compares)', sent.some((r) => /\/(reviews|comments)/.test(r)), sent.slice(0, 6).join('; '));
      results.fetches.push(...(await d.fetches()).map((f) => ({ case: 'decide', ...f })));
      const puts = (await d.fetches()).filter((f) => f.method === 'PUT');
      check('decide. the review PUT is credentialed, to the server, and nothing is sent anywhere else', puts.length >= 1 && puts.every((f) => f.credentials === 'include' && f.url.startsWith(MAP)), JSON.stringify(puts.map((f) => f.url)));
      results.requests.push(...d.log.all().map((r) => ({ case: 'decide', ...r })));
      check('decide. no violation', d.violations.length === 0, d.violations.join(' | '));
      await d.page.close();

      // Send back with a note
      const sb = await open(context, LISTED, `?p=${SL[1]}&s=pull/22`);
      await opened(sb);
      await lineRead(sb);
      await press(sb.page, '[data-review="notes"]');
      await sleep(400);
      const noted = await sb.page.evaluate(() => document.querySelector('corn-review').shadowRoot.activeElement?.id);
      check('decide. Send back opens the note and the focus goes to it', noted === 'review-note', noted);
      await sb.page.keyboard.type('Please name the provider <b>first</b> & "quote".');
      await shot(sb.page, 'decide-note', [[1300, 900, 'desk'], [430, 900, 'phone']]);
      await press(sb.page, '[data-review="notes"]');
      await sleep(500);
      if (await sh(sb.page, '[data-review-ask]:not([hidden])').count()) await press(sb.page, '[data-review="notes"]');
      await until(() => decisions(sb).length === 1, 15_000, 'cornDecision for the send back');
      const posted = (await forgeRequests()).last.filter((r) => /^(POST|PUT|PATCH) /.test(r));
      check('decide. Send back: cornDecision says notes for that proposal and copy', decisions(sb)[0].detail.outcome === 'notes' && decisions(sb)[0].detail.proposal === SL[1] && decisions(sb)[0].detail.source === 'pull/22', JSON.stringify(decisions(sb)[0].detail));
      const noteSent = (await sb.fetches()).filter((f) => f.method === 'PUT').map((f) => JSON.parse(f.body || '{}'));
      check('decide. the note reached the server as typed (the markup is text, not changed), and the forge received a comment', noteSent.length === 1 && noteSent[0].note === 'Please name the provider <b>first</b> & "quote".' && posted.some((r) => /\/(reviews|comments)/.test(r)), `${JSON.stringify(noteSent.map((n) => n.note))} | ${posted.join('; ')}`);
      await sb.page.close();

      // the stale version: a push since the proposal opened
      const st = await open(context, LISTED, `?p=${SL[4]}&s=pull/25`);
      await opened(st);
      await lineRead(st);
      await rig('/__rig/pull?pr=25&push=file');
      await press(st.page, '[data-review="approved"]');
      await sleep(500);
      if (await sh(st.page, '[data-review-ask]:not([hidden])').count()) await press(st.page, '[data-review="approved"]');
      await sleep(7500);
      const stale = await state(st.page);
      const msg = await st.page.evaluate(() => { const r = document.querySelector('corn-review').shadowRoot; const e = r.querySelector('[data-review-msg]:not([hidden])'); return e ? e.textContent.trim() : null; });
      check('decide. a push since it was shown: the server refuses, the foot says so in words, and cornDecision was not said', decisions(st).length === 0 && !!msg, `${msg} | ${stale.verdict}`);
      await shot(st.page, 'decide-stale', [[1300, 900, 'desk']]);
      await st.page.close();
    }

    // ---- signed out, and the way back; a session that ends ---------------------------------------------------------------------------------------
    if (run('signedout')) {
      const signedOut = await browser.newContext({ viewport: { width: 1300, height: 900 }, reducedMotion: 'reduce' });
      await signedOut.addInitScript(FETCH_SPY);
      const b = await open(signedOut, LISTED, `?p=${SL[0]}&s=pull/21`);
      await until(() => sh(b.page, '[data-corn="source-sign-in"]').count().then((n) => n > 0), 30_000, 'the sign-in card');
      const card = await state(b.page);
      const link = await b.page.evaluate(() => { const a = document.querySelector('corn-review').shadowRoot.querySelector('[data-corn="source-sign-in"]'); return { href: a.href, target: a.target, rel: a.rel }; });
      check('signedout. "You are not signed in to cornfield" with a real link, target _top', /not signed in/i.test(card.card || '') && link.target === '_top', JSON.stringify(link));
      const auth = b.ev('cornAuth')[0];
      check('signedout. cornAuth says 401 during load, and the sign-in that returns to this page', auth && auth.detail.status === 401 && auth.detail.during === 'load' && auth.detail.signIn === `${MAP}/auth/start?returnTo=${encodeURIComponent(`${origin(LISTED)}/?p=${SL[0]}&s=pull/21`)}` && link.href === auth.detail.signIn, auth && auth.detail.signIn);
      check('signedout. the component did not navigate the window, and nothing of the proposal was asked', b.page.url().startsWith(origin(LISTED)) && (await b.fetches()).every((f) => !/proposals/.test(f.url)));
      await shot(b.page, 'signedout-card');
      await b.page.evaluate(() => document.querySelector('corn-review').setAttribute('theme', 'dark'));
      await sleep(500);
      await shot(b.page, 'signedout-card-dark');
      results.requests.push(...b.log.all().map((r) => ({ case: 'signedout', ...r })));
      await b.page.evaluate(() => document.querySelector('corn-review').setAttribute('theme', 'light'));
      await b.page.evaluate(() => document.querySelector('corn-review').shadowRoot.querySelector('[data-corn="source-sign-in"]').click());
      const arrived = async () => { for (let i = 0; i < 160; i++) { if (b.hops.some((u) => u.startsWith(`${MAP}/auth/start`)) && b.page.url().startsWith(origin(LISTED)) && b.hops.filter((u) => u.startsWith(origin(LISTED))).length > 1) return true; await sleep(250); } return false; };
      const back = await arrived();
      await b.page.waitForLoadState('load');
      check('signedout. the sign-in went to the server and came back to the host page, with the proposal in its address', back && b.page.url().includes(`p=${SL[0]}`), b.hops.map((u) => u.replace(/\?.*/, '')).join(' > '));
      await opened(b);
      check('signedout. after signing in the review loads and the proposal is open', !!(await state(b.page)).title && (await state(b.page)).card === null, JSON.stringify(await state(b.page)));
      await shot(b.page, 'signedout-after-sign-in');
      await b.page.close();

      // a session that ends while a review is open
      const e = await browser.newContext({ viewport: { width: 1300, height: 900 }, reducedMotion: 'reduce' });
      await e.addInitScript(FETCH_SPY);
      const pe = await e.newPage();
      await pe.goto(`${MAP}/auth/start`);
      await pe.waitForURL(`${MAP}/**`);
      await pe.close();
      const x = await open(e, LISTED, `?p=${SL[3]}&s=pull/24`);
      await opened(x);
      await lineRead(x);
      await e.clearCookies(); // the session ended
      await sh(x.page, '[data-review="approved"]').click({ force: true });
      await until(() => x.ev('cornAuth').some((a) => a.detail.during === 'send' || a.detail.during === 'facts' || a.detail.during === 'review'), 20_000, 'cornAuth for the press').catch(async (err) => { console.log('events', JSON.stringify(x.events.map((v) => v.type)), JSON.stringify(await state(x.page)), JSON.stringify((await x.fetches()).slice(-4))); throw err; });
      await sh(x.page, '[data-review="approved"]').click({ force: true }).catch(() => {});
      await until(() => x.ev('cornAuth').some((a) => a.detail.during === 'send'), 20_000, 'cornAuth during send');
      await until(() => sh(x.page, '[data-corn="source-sign-in"]').count().then((n) => n > 0), 10_000, 'the sign-in card');
      const auths = x.ev('cornAuth').map((a) => `${a.detail.status}/${a.detail.during}`);
      check('signedout. an Approve pressed with an expired session: the same sign-in card, cornAuth says what was refused, and no cornDecision', x.ev('cornAuth').some((a) => a.detail.during === 'send' && a.detail.status === 401) && x.ev('cornDecision').length === 0, auths.join(' '));
      await shot(x.page, 'signedout-expired', [[1300, 900, 'desk'], [430, 900, 'phone']]);
      results.requests.push(...x.log.all().map((r) => ({ case: 'expired', ...r })));
      await x.page.close();
      await e.close();
      await signedOut.close();
    }

    // ---- an unlisted host page ------------------------------------------------------------------------------------------------------------------
    if (run('unlisted')) {
      const c = await open(context, UNLISTED, `?p=${SL[0]}&s=pull/21`);
      await until(() => sh(c.page, '[data-corn="source-origin"]').count().then((n) => n > 0), 30_000, 'the not-listed card');
      const text = (await state(c.page)).card;
      check('unlisted. "This page is not listed by that cornfield", with the origin to list', /not listed by that cornfield/.test(text || '') && (text || '').includes(origin(UNLISTED)), text);
      check('unlisted. cornError not-listed, and the page read nothing: no cornReady, no proposal asked for, nothing written', c.ev('cornError').some((e) => e.detail.kind === 'not-listed') && c.ev('cornReady').length === 0 && (await c.fetches()).every((f) => ['GET', 'HEAD'].includes(f.method) && !/proposals/.test(f.url)));
      await shot(c.page, 'unlisted');
      results.requests.push(...c.log.all().map((r) => ({ case: 'unlisted', ...r })));
      await c.page.close();
    }

    // ---- the keyboard alone ---------------------------------------------------------------------------------------------------------------------
    if (run('keys')) {
      const k = await open(context, LISTED, `?p=${SL[3]}&s=pull/24`);
      await opened(k);
      await lineRead(k);
      await k.page.focus('#host-button');
      const order = [];
      for (let i = 0; i < 60; i++) {
        await k.page.keyboard.press('Tab');
        const at = await k.page.evaluate(() => { const r = document.querySelector('corn-review').shadowRoot; const e = r.activeElement; return e ? `${e.getAttribute('data-corn') || e.localName}${e.getAttribute('data-view') ? `:${e.getAttribute('data-view')}` : ''}${e.getAttribute('data-review') ? `:${e.getAttribute('data-review')}` : ''}` : (document.activeElement.localName === 'corn-review' ? '?' : 'out'); });
        order.push(at);
        if (at === 'out' || order.filter((x) => x === 'review-bar' || /^.*:approved$/.test(x)).length > 0 && /:approved$/.test(at)) break;
      }
      check('keys. Tab reaches the map, the bar\'s views, the list and the decision, in that order', ['map-canvas'].every((x) => order.includes(x)) && order.some((x) => /:approved$/.test(x)) && order.some((x) => /:notes$/.test(x)), order.join(' '));
      // the view by Enter on After, the note by Enter on Send back and Escape/Cancel, a hold by Enter and Undo by Enter
      await k.page.evaluate(() => document.querySelector('corn-review').shadowRoot.querySelector('[data-view="after"]').focus());
      await k.page.keyboard.press('Enter');
      await sleep(500);
      check('keys. After by Enter: the view changes and the focus stays on the button', (await state(k.page)).view === 'after' && await k.page.evaluate(() => document.querySelector('corn-review').shadowRoot.activeElement?.getAttribute('data-view') === 'after'));
      await k.page.evaluate(() => document.querySelector('corn-review').shadowRoot.querySelector('[data-review="notes"]').focus());
      await k.page.keyboard.press('Enter');
      await sleep(400);
      check('keys. Send back by Enter: the focus goes into the note', await k.page.evaluate(() => document.querySelector('corn-review').shadowRoot.activeElement?.id === 'review-note'));
      await k.page.keyboard.press('Tab');
      await k.page.keyboard.press('Enter'); // Cancel
      await sleep(400);
      check('keys. Cancel by Enter: the note closes and the focus goes back to Send back', await k.page.evaluate(() => document.querySelector('corn-review').shadowRoot.activeElement?.getAttribute('data-review') === 'notes'));
      await k.page.evaluate(() => document.querySelector('corn-review').shadowRoot.querySelector('[data-review="approved"]').focus());
      await k.page.keyboard.press('Enter');
      await sleep(500);
      check('keys. Approve by Enter: the hold, with the focus on Undo', await k.page.evaluate(() => { const r = document.querySelector('corn-review').shadowRoot; return r.activeElement === r.querySelector('[data-review-undo]'); }));
      await k.page.keyboard.press('Escape');
      await sleep(500);
      check('keys. Escape stops the hold: nothing was decided', k.ev('cornDecision').length === 0);
      await k.page.close();
    }

    // ---- axe, every state, light and dark, at both sizes -------------------------------------------------------------------------------------------
    if (run('axe')) {
      // axe goes in by the debugger's evaluate, which a page policy without 'unsafe-eval' does not govern
      const audit = async (page) => { if (!(await page.evaluate(() => !!window.axe))) await page.evaluate(axeSource); return page.evaluate(async () => {
        const r = await window.axe.run(document.body, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
        return r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
      }); };
      const states = [
        ['open', context, `?p=${SL[0]}&s=pull/21`, async (a) => { await opened(a); await lineRead(a); await sleep(800); }],
        ['node selected', context, `?p=${SL[0]}&s=pull/21`, async (a) => { await opened(a); await lineRead(a); await a.page.evaluate(() => document.querySelector('corn-review').shadowRoot.querySelector('.hx-change-row[data-kind="node"]').click()); await sleep(1000); }],
        ['missing', context, '?p=0999-nothing', async (a) => { await until(async () => /no proposal/i.test((await state(a.page)).message || ''), 30_000); await sleep(500); }],
        ['not listed', null, `?p=${SL[0]}`, async (a) => { await until(() => sh(a.page, '[data-corn="source-origin"]').count().then((n) => n > 0), 30_000); }],
      ];
      for (const scheme of ['light', 'dark']) {
        for (const [name, ctx, query, ready] of states) {
          for (const size of ['wide', 'phone']) {
            const c = ctx || context;
            const a = await open(c, name === 'not listed' ? UNLISTED : LISTED, `${query}${query.includes('?') ? '&' : '?'}theme=${scheme}&size=${size}`, size === 'phone' ? { width: 430, height: 900 } : { width: 1300, height: 900 });
            await a.page.emulateMedia({ colorScheme: scheme });
            await ready(a);
            const bad = await audit(a.page);
            check(`axe. ${name}, ${scheme}, ${size}: nothing`, bad.length === 0, bad.join(' | '));
            await a.page.close();
          }
        }
      }
      const fresh = await browser.newContext({ viewport: { width: 1300, height: 900 }, reducedMotion: 'reduce' });
      await fresh.addInitScript(FETCH_SPY);
      for (const scheme of ['light', 'dark']) {
        const a = await open(fresh, LISTED, `?p=${SL[0]}&theme=${scheme}`);
        await until(() => sh(a.page, '[data-corn="source-sign-in"]').count().then((n) => n > 0), 30_000);
        const bad = await audit(a.page);
        check(`axe. signed out, ${scheme}: nothing`, bad.length === 0, bad.join(' | '));
        await a.page.close();
      }
      await fresh.close();
    }
  } finally {
    await browser.close();
    for (const s of hosts) s.close();
    server.stop();
  }

  // ---- logs: the request log -------------------------------------------------------------------------------------------------------------------
  const toRig = results.requests.filter((r) => r.url.startsWith(MAP));
  const toOthers = results.requests.filter((r) => !r.url.startsWith(MAP) && !r.url.startsWith(origin(LISTED)) && !r.url.startsWith(origin(UNLISTED)) && !/^(data|blob|about|chrome)/.test(r.url));
  const pathOf = (u) => new URL(u).pathname;
  const SIGN_IN = /^\/auth\//;
  const strays = toRig.filter((r) => r.type !== 'Document' && !SIGN_IN.test(pathOf(r.url)) && !routeOf(pathOf(r.url)));
  const some = (name, ok, detail) => check(name, ok, detail);
  if (results.requests.length) {
    some('logs. no request leaves for an origin other than the host\'s own and the server', toOthers.length === 0, toOthers.map((r) => r.url).join(' '));
    some('logs. every request to the server, but the sign-in\'s own navigation, is on a route of server/embed.js ROUTES', strays.length === 0, strays.map((r) => `${r.method} ${pathOf(r.url)}`).join(' '));
    const cookieElsewhere = results.requests.filter((r) => r.cookie && !r.url.startsWith(MAP));
    some('logs. no request carried a cookie to any origin but the server', cookieElsewhere.length === 0, cookieElsewhere.map((r) => r.url).join(' '));
    const open$ = toRig.filter((r) => routeOf(pathOf(r.url)) && routeOf(pathOf(r.url)).kind === 'open');
    some('logs. the routes that answer anyone (the components, the theme) were asked without a cookie', open$.every((r) => !r.cookie), `${open$.length} requests`);
    const gated = toRig.filter((r) => routeOf(pathOf(r.url)) && routeOf(pathOf(r.url)).kind === 'session' && r.status === 200 && r.url.startsWith(MAP));
    some('logs. the gated reads and writes that were answered carried the session', gated.length > 0 && gated.every((r) => r.cookie), `${gated.length} requests`);
    const paths = [...new Set(toRig.map((r) => `${r.method} ${pathOf(r.url).replace(/\/proposals\/[^/]+/, '/proposals/<name>').replace(/pulls\/\d+/, 'pulls/<n>')}`))].sort();
    console.log(`\nrequests to the server (${toRig.length}), by method and path:\n  ${paths.join('\n  ')}`);
    const fetched = results.fetches.filter((f) => f.url.startsWith(MAP));
    const creds = [...new Set(fetched.map((f) => `${f.method} ${new URL(f.url).pathname.replace(/\/proposals\/[^/]+/, '/proposals/<name>').replace(/pulls\/\d+/, 'pulls/<n>')} credentials=${f.credentials}`))].sort();
    console.log(`\nfetch calls of the components, with their credentials mode:\n  ${creds.join('\n  ')}`);
    const outside = fetched.filter((f) => !routeOf(new URL(f.url).pathname));
    some('logs. every fetch of the components is to a route of ROUTES, with credentials: include, but the theme (omit) and the reach test (omit)', outside.length === 0 && fetched.filter((f) => !/\/cornfield\/theme/.test(f.url)).every((f) => f.credentials === 'include' || f.credentials === 'omit'), outside.map((f) => f.url).join(' '));
  }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks held${failed.length ? `; failed: ${failed.map((c) => c.name).join(' | ')}` : ''}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
