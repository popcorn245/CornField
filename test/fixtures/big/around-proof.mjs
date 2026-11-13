/**
 * The proof in a browser that `<corn-node-panel>`, `<corn-layers>` and `<corn-search>` work with `<corn-map>` inside one `<corn-scope>` on a host page of
 * another origin, each in a shadow root of its own, under a strict Content-Security-Policy (spec 0011 D4, D5, D6, D7, D10, D12). Runs by hand: needs Playwright,
 * Chromium and the built package (`cd components && npm ci && npm run build`), and no network (everything is on 127.0.0.1; Chromium resolves `*.localhost` to loopback).
 *
 *   node test/fixtures/big/around-proof.mjs [--shots <dir>] [--json <file>]
 *
 * One cornfield rig (serve.js --forge --layers --theme retro, listing only http://tasks.corn.localhost:3832) and one host page that serves the built components and sends
 * `default-src 'self'; script-src 'self'; style-src 'self'` (no `'unsafe-inline'`), connect and image sources only for the rig. The page lays out a `<corn-scope src>`
 * with a `<corn-map>`, `<corn-node-panel>`, `<corn-layers>` and `<corn-search>` in a grid of its own CSS, then:
 *
 *   mouse     a click on the map selects a node and the panel reads it; a click on the panel's Close clears it
 *   keyboard  N selects on the map, Enter goes into the panel, Escape comes back to the map and says "Panel closed"; `/` on the map goes to the search field
 *   search    a query, its count said in the search's own live region, a result picked: the map and the panel follow
 *   layers    the menu opens, a layer is switched and the map is drawn differently, a click elsewhere in the host page shuts the menu
 *   tags      the panel removed and put back (it is handed the selection the instance holds); two scopes on one page do not touch each other
 *   checks    no Content-Security-Policy violation, no console error, no request to an origin but the host's own and the rig's, no request off the embed routes
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

const RIG = { host: 'map.corn.localhost', port: 3830, forge: 3831 };
const LISTED = { host: 'tasks.corn.localhost', port: 3832 };
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
  const args = [SERVE, '--forge', '--layers', '--theme', 'retro', '--port', String(RIG.port), '--forge-port', String(RIG.forge), '--public', MAP, '--embed', origin(LISTED), '--dir', path.join(os.tmpdir(), `cornfield-around-proof-${RIG.port}`)];
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
/** The host page: its own look and its own grid, a strict policy, the built components at /dist/ */
function hostPage(host) {
  const csp = `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${MAP}; img-src 'self' data: ${MAP}; font-src 'self'; object-src 'none'; base-uri 'none'`;
  const page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tasks, a host app</title>'
    + '<link rel="stylesheet" href="/host.css"><script type="module" src="/dist/index.js"></script></head><body><header><h1>Tasks (a host app)</h1><span id="host-text">The host page\'s own text.</span></header><main id="stage"></main></body></html>';
  const css = `body { margin: 0; font-family: Georgia, serif; color: #234; background: #fffbe6; }
header { display: flex; align-items: center; gap: 16px; padding: 8px 16px; background: #7a3e00; color: #fbf3e4; height: 48px; box-sizing: border-box; } h1 { font-size: 18px; margin: 0; }
button { font: italic 14px cursive; background: hotpink; } canvas { border: 3px dotted red; } input { border: 4px double green; } p { text-indent: 2em; }
corn-scope { display: contents; }
.work { display: grid; grid-template-columns: minmax(0, 1fr) 360px; grid-template-rows: auto minmax(0, 1fr); gap: 8px; padding: 8px 16px; height: calc(100vh - 48px); box-sizing: border-box; }
.work corn-map { grid-column: 1; grid-row: 1 / 3; height: 100%; border: 1px solid #234; }
.work .tools { grid-column: 2; grid-row: 1; display: flex; flex-direction: column; gap: 8px; position: relative; z-index: 5; }
.work corn-node-panel { grid-column: 2; grid-row: 2; min-height: 0; border: 1px solid #234; }
.second { margin: 8px 16px; height: 240px; display: grid; grid-template-columns: 1fr 240px; gap: 8px; } .second corn-map { height: 100%; }
@media (max-width: 700px) { .work { grid-template-columns: minmax(0, 1fr); grid-template-rows: 320px auto 360px; height: auto; } .work corn-map { grid-column: 1; grid-row: 1; height: 320px; } .work .tools { grid-column: 1; grid-row: 2; } .work corn-node-panel { grid-column: 1; grid-row: 3; } .second { grid-template-columns: minmax(0, 1fr); height: auto; } .second corn-map { height: 240px; } .second corn-node-panel { height: 300px; } }`;
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
async function until(fn, ms = 30_000) { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`); await sleep(100); } }
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`); };

/** Logs every request of a context from the network stack (CDP) */
async function logRequests(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const seen = new Map();
  const entry = (id) => { if (!seen.has(id)) seen.set(id, {}); return seen.get(id); };
  cdp.on('Network.requestWillBeSent', (e) => Object.assign(entry(e.requestId), { method: e.request.method, url: e.request.url, type: e.type }));
  cdp.on('Network.responseReceived', (e) => Object.assign(entry(e.requestId), { status: e.response.status }));
  return { all: () => [...seen.values()].filter((r) => r.url) };
}

const MARKUP = `<corn-scope src="${MAP}" id="s1">
  <section class="work">
    <corn-map renderer="canvas2d" id="m1"></corn-map>
    <div class="tools"><corn-search id="se1"></corn-search><corn-layers id="l1"></corn-layers></div>
    <corn-node-panel id="p1"></corn-node-panel>
  </section>
</corn-scope>
<corn-scope src="${MAP}" id="s2" use-theme><section class="second"><corn-map renderer="canvas2d" id="m2"></corn-map><corn-node-panel id="p2"></corn-node-panel></section></corn-scope>`;

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.js'))) throw new Error('the package is not built: cd components && npm ci && npm run build');
  const { chromium } = await loadPlaywright();
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const rig = await startRig();
  const host = await hostPage(LISTED);
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-accelerated-2d-canvas'] });
  const requests = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const p0 = await context.newPage();
    await p0.goto(`${MAP}/auth/start`);
    await p0.waitForURL(`${MAP}/**`);
    check('signed in on the rig', (await p0.evaluate(() => fetch('/auth/me').then((r) => r.json()))).ok);
    await p0.close();

    const page = await context.newPage();
    const log = await logRequests(context, page);
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy|Refused to/.test(m.text())) problems.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); window.__select = []; document.addEventListener('cornSelect', (e) => window.__select.push(e.target.id)); window.__search = []; document.addEventListener('cornSearch', (e) => window.__search.push(e.detail)); });
    await page.goto(`${origin(LISTED)}/`);
    const lookBefore = await page.evaluate(() => { const cs = getComputedStyle(document.body); return { bg: cs.backgroundColor, font: cs.fontFamily, p: getComputedStyle(document.querySelector('#host-text')).color, sheets: document.adoptedStyleSheets.length, styles: document.querySelectorAll('style').length }; });
    await page.evaluate((html) => { document.querySelector('#stage').innerHTML = html; }, MARKUP);
    await page.waitForFunction(() => { const m = document.querySelector('#m1'); return m && m.shadowRoot && m.shadowRoot.querySelector('canvas') && document.querySelector('#p1')?.shadowRoot?.querySelector('[data-corn="node-panel"]') && document.querySelector('#l1')?.shadowRoot?.querySelector('[data-corn="layers-button"]') && document.querySelector('#se1')?.shadowRoot?.querySelector('input') && document.querySelector('#p2')?.shadowRoot?.querySelector('[data-corn="node-panel"]'); }, null, { timeout: 60_000 });
    await sleep(2000);

    const node = (id) => page.evaluate((i) => document.querySelector(i).getAttribute('node'), id);
    const panelOpen = (id) => page.evaluate((i) => { const d = document.querySelector(i).shadowRoot.querySelector('[data-corn="node-panel"]'); return d.classList.contains('drawer-open') && !d.inert; }, id);
    const panelTitle = (id) => page.evaluate((i) => (document.querySelector(i).shadowRoot.querySelector('[data-corn="node-title"]') || {}).textContent, id);
    const emptyShown = (id) => page.evaluate((i) => { const e = document.querySelector(i).shadowRoot.querySelector('[data-corn="empty"]'); return !!e && !e.hidden && e.textContent; }, id);
    const announcer = (id) => page.evaluate((i) => document.querySelector(i).shadowRoot.querySelector('#map-announcer').textContent, id);
    const pixels = (id) => page.evaluate((i) => { const c = document.querySelector(i).shadowRoot.querySelector('canvas[data-corn="map-canvas"]'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 2166136261; for (let k = 0; k < d.length; k += 4) h = Math.imul(h ^ (d[k] | (d[k + 1] << 8) | (d[k + 2] << 16)), 16777619); return h; }, id);
    const canvasBox = await page.locator('#m1 canvas[data-corn="map-canvas"]').boundingBox();

    check('the panel starts with its empty line; the host page\'s dotted canvas rule and double input border do not reach the pieces', await emptyShown('#p1') && !(await panelOpen('#p1')), String(await emptyShown('#p1')));
    await page.screenshot({ path: SHOTS ? path.join(SHOTS, 'around-0-start.png') : undefined, timeout: 120_000 }).catch(() => {});

    // -- mouse: a click on the map ------------------------------------------------------------------------------------------------------------------
    let hit = null;
    for (let y = 40; y < canvasBox.height - 40 && !hit; y += 37) {
      for (let x = 40; x < canvasBox.width - 40 && !hit; x += 37) {
        await page.mouse.click(canvasBox.x + x, canvasBox.y + y);
        if (await node('#m1')) hit = await node('#m1');
      }
    }
    await sleep(500);
    check('mouse: a click on a node of the map selects it', !!hit, hit);
    check('mouse: the panel opens and reads that node, in its own shadow root', await panelOpen('#p1') && !!(await panelTitle('#p1')), await panelTitle('#p1'));
    check('mouse: the other scope\'s panel did not move', !(await panelOpen('#p2')) && !(await node('#m2')));
    check('events: one cornSelect, from the map, for that click', (await page.evaluate(() => window.__select)).filter((i) => i === 'm1').length === 1 && !(await page.evaluate(() => window.__select)).includes('p1'));
    await page.screenshot({ path: SHOTS ? path.join(SHOTS, 'around-1-selected.png') : undefined, timeout: 120_000 }).catch(() => {});

    // -- mouse: Close on the panel clears it -------------------------------------------------------------------------------------------------------------
    await page.locator('#p1 [data-action="close-drawer"]').click();
    await sleep(300);
    check('mouse: Close on the panel clears the selection (the map\'s node attribute goes) and the panel says what it is for again', !(await node('#m1')) && !(await panelOpen('#p1')) && !!(await emptyShown('#p1')), String(await emptyShown('#p1')));

    // -- keyboard ------------------------------------------------------------------------------------------------------------------------------------------
    await page.locator('#m1 canvas[data-corn="map-canvas"]').focus();
    await page.keyboard.press('n');
    await sleep(400);
    check('keyboard: N on the map selects a node and the panel follows', !!(await node('#m1')) && await panelOpen('#p1'), await panelTitle('#p1'));
    await page.keyboard.press('Enter');
    const inPanel = await page.evaluate(() => { const p = document.querySelector('#p1'); return p.shadowRoot.activeElement && p.shadowRoot.activeElement.getAttribute('data-corn'); });
    check('keyboard: Enter on the map moves the focus into the panel (its title), across the shadow roots', inPanel === 'node-title', String(inPanel));
    await page.keyboard.press('Escape');
    await sleep(600);
    const back = await page.evaluate(() => { const m = document.querySelector('#m1'); return m.shadowRoot.activeElement && m.shadowRoot.activeElement.getAttribute('data-corn'); });
    check('keyboard: Escape in the panel closes it and the focus is back on the map', back === 'map-canvas' && !(await panelOpen('#p1')), String(back));
    check('keyboard: "Panel closed" is announced (by the map\'s live region)', (await announcer('#m1')) === 'Panel closed', await announcer('#m1'));
    await page.keyboard.press('/');
    const onField = await page.evaluate(() => { const s = document.querySelector('#se1'); return s.shadowRoot.activeElement && s.shadowRoot.activeElement.tagName; });
    check('keyboard: `/` pressed on the map goes to the search field in another shadow root', onField === 'INPUT', String(onField));

    // -- search ----------------------------------------------------------------------------------------------------------------------------------------------
    const field = page.locator('#se1 input').first();
    await field.fill('api');
    await until(() => page.evaluate(() => (document.querySelector('#se1').shadowRoot.querySelector('[data-corn="search-count"]') || {}).textContent));
    const count = await page.locator('#se1 [data-corn="search-count"]').textContent();
    await sleep(700);
    const said = await page.evaluate(() => document.querySelector('#se1').shadowRoot.querySelector('[data-corn="search-status"]').textContent);
    check('search: the count is shown in the field and said in the search\'s own polite live region', /match|of/.test(count) && /match/.test(said), `${count} / ${said}`);
    const rows = page.locator('#se1 [data-corn="search-result"][data-search-id]');
    await rows.first().waitFor({ timeout: 10_000 });
    const pickId = await rows.nth(1).getAttribute('data-search-id');
    const pixBefore = await pixels('#m1');
    await rows.nth(1).click();
    await sleep(1200);
    check('search: picking a result selects it on the map and fills the panel', (await node('#m1')) === pickId && await panelOpen('#p1'), `${pickId} -> ${await panelTitle('#p1')}`);
    check('search: the map flew to it (the picture changed)', (await pixels('#m1')) !== pixBefore);
    const heard = await page.evaluate(() => window.__search);
    check('events: the host heard cornSearch with the query and then the chosen match', heard.some((d) => d.query === 'api') && heard.some((d) => d.current === pickId), JSON.stringify(heard.slice(-2)));
    await page.screenshot({ path: SHOTS ? path.join(SHOTS, 'around-2-search.png') : undefined, timeout: 120_000 }).catch(() => {});

    // -- layers ----------------------------------------------------------------------------------------------------------------------------------------------
    await page.locator('#host-text').click(); // the list of matches hangs over the chip while the focus is in it: the click away shuts it
    await sleep(300);
    await page.locator('#l1 [data-corn="layers-button"]').click();
    const menuOpen = await page.evaluate(() => !document.querySelector('#l1').shadowRoot.querySelector('[data-corn="layers-menu"]').hidden);
    const row = page.locator('#l1 [data-corn="row"][aria-pressed="true"]').first();
    const layer = await row.getAttribute('data-layer');
    const pix1 = await pixels('#m1');
    await row.click();
    await sleep(700);
    const pressed = await page.locator(`#l1 [data-corn="row"][data-layer="${layer}"]`).getAttribute('aria-pressed');
    check('layers: the menu opens, a layer is switched off, and the map is drawn differently', menuOpen && pressed === 'false' && (await pixels('#m1')) !== pix1, `${layer} ${pressed}`);
    const dotStyles = await page.evaluate(() => { const r = document.querySelector('#l1').shadowRoot; return { bg: getComputedStyle(r.querySelector('[data-corn="swatch"]')).backgroundColor, attrs: r.querySelectorAll('[data-style]').length }; });
    check('layers: the dots are coloured under style-src \'self\' (set through the CSS object model)', dotStyles.bg !== 'rgba(0, 0, 0, 0)' && dotStyles.attrs === 0, dotStyles.bg);
    await page.screenshot({ path: SHOTS ? path.join(SHOTS, 'around-3-layers.png') : undefined, timeout: 120_000 }).catch(() => {});
    await page.locator('#host-text').click();
    await sleep(200);
    check('layers: a click elsewhere in the host page shuts the menu', await page.evaluate(() => document.querySelector('#l1').shadowRoot.querySelector('[data-corn="layers-menu"]').hidden));
    await page.locator('#l1 [data-corn="layers-button"]').click();
    await page.keyboard.press('Escape');
    check('layers: Escape shuts the menu and the chip has the focus', await page.evaluate(() => { const s = document.querySelector('#l1').shadowRoot; return s.querySelector('[data-corn="layers-menu"]').hidden && s.activeElement === s.querySelector('[data-corn="layers-button"]'); }));
    await page.locator('#l1 [data-corn="layers-button"]').click();
    await page.locator(`#l1 [data-corn="row"][data-layer="${layer}"]`).click();
    await page.locator('#host-text').click();
    await sleep(500);

    // -- tags removed and put back ----------------------------------------------------------------------------------------------------------------------
    const heldId = await node('#m1');
    await page.evaluate(() => document.querySelector('#p1').remove());
    await sleep(300);
    const mapStill = !!(await node('#m1')) && (await pixels('#m1')) > 0;
    await page.evaluate(() => { const p = document.createElement('corn-node-panel'); p.id = 'p1'; document.querySelector('.work').append(p); });
    await page.waitForFunction(() => document.querySelector('#p1')?.shadowRoot?.querySelector('[data-corn="node-panel"]'), null, { timeout: 15_000 });
    await sleep(400);
    check('tags: the panel removed leaves the map alone, and put back it is handed the selection the instance holds', mapStill && (await node('#m1')) === heldId && await panelOpen('#p1'), await panelTitle('#p1'));
    await page.evaluate(() => document.querySelector('#se1').remove());
    await sleep(200);
    await page.evaluate(() => { const p = document.createElement('corn-search'); p.id = 'se1'; document.querySelector('.tools').prepend(p); });
    await page.waitForFunction(() => document.querySelector('#se1')?.shadowRoot?.querySelector('input'), null, { timeout: 15_000 });
    check('tags: the search removed and put back works again (one field, not two)', await page.evaluate(() => document.querySelector('#se1').shadowRoot.querySelectorAll('input').length) === 1);
    await page.locator('#m1 canvas[data-corn="map-canvas"]').focus();
    await page.keyboard.press('/');
    check('tags: and `/` on the map reaches the new field', await page.evaluate(() => { const s = document.querySelector('#se1'); return s.shadowRoot.activeElement && s.shadowRoot.activeElement.tagName === 'INPUT'; }));

    // -- the map removed: the three say what they need; put back, they work ---------------------------------------------------------------------------------
    await page.evaluate(() => document.querySelector('#m1').remove());
    await sleep(500);
    const needs = await page.evaluate(() => ['#p1', '#l1', '#se1'].map((i) => (document.querySelector(i).shadowRoot.querySelector('[data-corn="empty"]') || {}).textContent));
    check('map removed: they say what they need and nothing is thrown', needs.every(Boolean), needs.join(' | '));
    await page.evaluate(() => { const m = document.createElement('corn-map'); m.id = 'm1'; m.setAttribute('renderer', 'canvas2d'); document.querySelector('.work').prepend(m); });
    await page.waitForFunction(() => document.querySelector('#l1')?.shadowRoot?.querySelector('[data-corn="layers-button"]') && document.querySelector('#m1')?.shadowRoot?.querySelector('canvas'), null, { timeout: 30_000 });
    await sleep(1500);
    check('map put back: they mount again, and the new map shows the selection the scope holds (node attribute)', (await node('#m1')) === heldId, await node('#m1'));

    // -- two scopes ------------------------------------------------------------------------------------------------------------------------------------------
    await page.locator('#m2 canvas[data-corn="map-canvas"]').focus();
    await page.keyboard.press('n');
    await sleep(500);
    check('two scopes: a selection in the second does not change the first (and the reverse held above)', !!(await node('#m2')) && await panelOpen('#p2') && (await node('#m1')) === heldId);
    await page.screenshot({ path: SHOTS ? path.join(SHOTS, 'around-4-two-scopes.png') : undefined, fullPage: true, timeout: 120_000 }).catch(() => {});

    // -- the server's theme (use-theme on the second scope): in the shadow root of each of its tags, its tokens on the scope -------------------------------------
    const themed = await page.evaluate(() => {
      const p = document.querySelector('#p2');
      const rules = [...p.shadowRoot.adoptedStyleSheets].some((sh) => [...sh.cssRules].some((r) => r.cssText.includes('data-corn')));
      const accent = (el) => getComputedStyle(el).getPropertyValue('--corn-accent').trim().toLowerCase();
      return { rules, second: accent(document.querySelector('#s2 .second')), first: accent(document.querySelector('#p1')) };
    });
    check('use-theme: the retro rules are adopted into the panel\'s shadow root and its tokens reach the second scope\'s tags and not the first\'s', themed.rules && themed.second === '#c8102e' && themed.first !== '#c8102e', JSON.stringify(themed));

    // -- the host page is as it was; policy; requests -------------------------------------------------------------------------------------------------------
    const lookAfter = await page.evaluate(() => { const cs = getComputedStyle(document.body); return { bg: cs.backgroundColor, font: cs.fontFamily, p: getComputedStyle(document.querySelector('#host-text')).color, sheets: document.adoptedStyleSheets.length, styles: document.querySelectorAll('style').length }; });
    check('the host page\'s own look is what it was (one default-tokens sheet added to the document, no style tag)', lookAfter.bg === lookBefore.bg && lookAfter.font === lookBefore.font && lookAfter.p === lookBefore.p && lookAfter.styles === lookBefore.styles && lookAfter.sheets === lookBefore.sheets + 1, JSON.stringify(lookAfter));
    const violations = await page.evaluate(() => window.__csp);
    check('no Content-Security-Policy violation under default-src \'self\'; script-src \'self\'; style-src \'self\'', violations.length === 0, violations.join(' | '));
    check('no console error and no page error', problems.length === 0, problems.join(' | '));
    requests.push(...log.all());

    // a narrow box: the panel in a 360px column is a plain panel (no sheet, no dim layer)
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(800);
    const narrow = await page.evaluate(() => { const p = document.querySelector('#p1'); const d = p.shadowRoot.querySelector('[data-corn="node-panel"]'); const r = p.getBoundingClientRect(); return { width: Math.round(r.width), position: getComputedStyle(d).position, backdrop: !!p.shadowRoot.querySelector('[data-corn="backdrop"]'), handle: !!p.shadowRoot.querySelector('[data-corn="sheet-handle"]'), open: d.classList.contains('drawer-open') }; });
    check('a narrow host box (390px window): the panel is in flow, fills its box, has no dim layer or sheet handle', narrow.position === 'relative' && !narrow.backdrop && !narrow.handle && narrow.width <= 390, JSON.stringify(narrow));
    await page.screenshot({ path: SHOTS ? path.join(SHOTS, 'around-5-phone.png') : undefined, fullPage: true, timeout: 120_000 }).catch(() => {});
  } finally {
    await browser.close();
    host.close();
    rig.stop();
  }

  const pathOf = (u) => new URL(u).pathname;
  const toRig = requests.filter((r) => r.url.startsWith(MAP));
  const toOthers = requests.filter((r) => !r.url.startsWith(MAP) && !r.url.startsWith(origin(LISTED)) && !/^(data|blob|about|chrome)/.test(r.url));
  check('requests: none leaves for an origin but the host\'s own and the rig\'s', toOthers.length === 0, toOthers.map((r) => r.url).join(' '));
  const strays = toRig.filter((r) => !/^\/auth\//.test(pathOf(r.url)) && !routeOf(pathOf(r.url)));
  check('requests: every one to the rig is on a route of server/embed.js ROUTES', strays.length === 0, strays.map((r) => `${r.method} ${pathOf(r.url)}`).join(' '));
  console.log(`\nrequests to the rig (${toRig.length}):\n  ${[...new Set(toRig.map((r) => `${r.method} ${pathOf(r.url)}`))].sort().join('\n  ')}`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ checks, requests }, null, 2));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks held${failed.length ? `; failed: ${failed.map((c) => c.name).join(' | ')}` : ''}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
