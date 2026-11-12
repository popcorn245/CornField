/**
 * The review piece in a browser (explorer/pieces/review.js), by hand: two reviews in one host page with styles of its own, in boxes of different sizes,
 * light and dark, fed from the synthetic repo. Needs Playwright and Chromium and nothing from outside this machine (127.0.0.1; Chromium resolves `*.localhost`).
 *
 *   node test/fixtures/review/proof.mjs [--shots <dir>] [--port 3830] [--json <file>]
 *
 * It starts three servers: a rig that lists the harness as a sibling origin (serve.js --forge --embed, signed in once), a second rig that is cornfield's own page
 * (same origin), and the harness server (serve.mjs). It then checks, and prints PASS or FAIL for each: the review draws; Before / Diff / After and Whole map;
 * a changed node and a changed edge open the node panel; a scenario plays; the narrow box is the phone layout while the window is wide; the fixed boxes stay
 * inside the piece; the two pieces are independent; nothing is added to the body or the head; destroy leaves nothing; axe on both; and that the requests of
 * Approve (hold, Undo), a landing and Send back with a note are the same, byte for byte, as cornfield's own page sends for the same steps (the credentials flag and the
 * origin are the two things a cross-origin base must add). Screenshots at each state go to --shots.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { serveHarness } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const PORT = Number(arg('port', 3830));
const SHOTS = path.resolve(arg('shots', path.join(os.tmpdir(), 'cornfield-review-proof')));
const SLUGS = ['0100-new-flow-across-apps', '0101-alerts-to-people'];
const MAP = { host: 'map.corn.localhost', port: PORT, forge: PORT + 100 };
const HOST_PORT = PORT + 1;
const PAGE = { port: PORT + 2, forge: PORT + 102 };
const MAP_ORIGIN = `http://${MAP.host}:${MAP.port}`;
const HOST_ORIGIN = `http://tasks.corn.localhost:${HOST_PORT}`;
fs.mkdirSync(SHOTS, { recursive: true });

async function loadPlaywright() {
  const tries = ['playwright', ...(process.env.PLAYWRIGHT_DIR ? [pathToFileURL(path.join(process.env.PLAYWRIGHT_DIR, 'index.mjs')).href] : []), '/opt/node-tools/node_modules/playwright/index.mjs'];
  for (const t of tries) { try { return await import(t); } catch { /* next */ } }
  throw new Error('Playwright is not installed: set PLAYWRIGHT_DIR to its folder.');
}
function axeSource() {
  for (const base of [ROOT, '/opt/node-tools']) { try { return fs.readFileSync(createRequire(path.join(base, 'x.js')).resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* next */ } }
  return null;
}

const children = [];
function startRig(args, dir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'test/fixtures/big/serve.js'), '--forge', ...args, '--dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`a rig did not start:\n${out}`)), 90_000);
    const see = (d) => { out += d; if (out.includes('Ctrl-C stops it')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', see);
    child.stderr.on('data', see);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`a rig exited (${code}):\n${out}`)); });
  });
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`); };

/** Records every request the page's script sends (fetch), from inside the page, as the lead of #244 did for cornfield's own page */
const RECORD = () => {
  window.__log = [];
  const of = window.fetch;
  window.fetch = function (input, init) {
    let url = ''; try { url = typeof input === 'string' ? input : String(input.url || input); } catch { url = ''; }
    const p = new URL(url, location.href);
    if (!(/\.(png|svg|woff2?|css|js|map)$/.test(p.pathname) || p.pathname.startsWith('/explorer/') || p.pathname.startsWith('/core/') || p.pathname.startsWith('/cornfield/') || p.pathname.startsWith('/data/') || p.pathname === '/topology.json')) {
      window.__log.push({ method: (init && init.method) || 'GET', path: p.pathname + p.search.replace(/[?&]v=\d+/, ''), cred: init && 'credentials' in init ? init.credentials : '-', redirect: (init && init.redirect) || '-', cache: (init && init.cache) || '-', headers: init && init.headers ? JSON.stringify(init.headers) : '', body: init && init.body !== undefined ? String(init.body) : '-', keys: init ? Object.keys(init).filter((k) => k !== 'credentials' && k !== 'redirect').join(',') : '-' });
    }
    return of.apply(this, arguments);
  };
};

async function decisionSteps(page, label, wait) {
  const out = [];
  const take = async (name) => { const log = await page.evaluate(() => window.__log.splice(0)); out.push({ name, log: log.filter((r) => /\/(review|decision|landing)/.test(r.path) && !(r.method === 'GET' && r.path.includes('/decision'))) }); };
  await take('open');
  await page.click('[data-review="approved"]', { force: true }); await wait(300); await take('hold');
  await page.click('[data-review-undo]', { force: true }); await wait(400); await take('undo');
  await page.click('[data-review="approved"]', { force: true }); await wait(6800); await take('landed');
  return out;
}
async function sendBack(page, wait) {
  const out = [];
  const take = async (name) => { const log = await page.evaluate(() => window.__log.splice(0)); out.push({ name, log: log.filter((r) => /\/(review|landing)/.test(r.path)) }); };
  await take('open');
  await page.click('[data-review="notes"]', { force: true }); await wait(300);
  await page.fill('#review-note', 'Please name the provider <b>first</b> & "quote".'); await wait(150);
  await page.click('[data-review="notes"]', { force: true }); await wait(300); await take('hold');
  await wait(6800); await take('sent');
  return out;
}
/** What differs only because a base on another origin makes a request credentialed and absolute: removed before comparing */
const same = (a, b) => JSON.stringify(a.map((s) => ({ name: s.name, log: s.log.map(({ cred, redirect, ...r }) => r) }))) === JSON.stringify(b.map((s) => ({ name: s.name, log: s.log.map(({ cred, redirect, ...r }) => r) })));

/**
 * What only a shadow root can show (the harness's `&shadow=1`): the host's own rules stop at it, the lookups and the focus are the box's, two reviews put
 * no id in the document, the box carries what its stylesheet says (the query container, `contain: layout`, `all: initial`), the phone's fixed backdrop
 * stays in the box, and the wheel is the host page's until the map has the focus
 */
async function shadowChecks(page, tag) {
  const facts = await page.evaluate(() => {
    const o = window.harness.pieces.objects; const r = window.harness.pieces.rig;
    const box = o.elements[0]; const cs = getComputedStyle(box);
    const btn = o.inst.el('proposal-whole'); const bs = getComputedStyle(btn);
    btn.focus();
    const active = o.inst.active() === btn;
    o.inst.state.canvas.focus();
    const canvasActive = o.inst.active() === o.inst.state.canvas;
    return {
      inShadow: box.getRootNode() instanceof ShadowRoot && r.elements[0].getRootNode() instanceof ShadowRoot,
      hostRules: { transform: bs.textTransform, font: bs.fontFamily.slice(0, 30), canvasBorder: getComputedStyle(o.inst.state.canvas).borderTopWidth },
      box: { container: `${cs.containerName} / ${cs.containerType}`, contain: cs.contain, lineHeight: cs.lineHeight, textAlign: cs.textAlign },
      active, canvasActive,
      documentIds: [...document.querySelectorAll('[id]')].map((e) => e.id).sort().join(','),
      lookups: ['sheet-dock', 'proposal-bar', 'review-column', 'spec-drawer', 'graph-canvas', 'review-decision'].every((id) => o.inst.el(id) && r.inst.el(id) && o.inst.el(id) !== r.inst.el(id)),
    };
  });
  check(tag('both reviews are in shadow roots'), facts.inShadow);
  check(tag('the host\'s rules on bare elements stop at the shadow root (no uppercase buttons, no Georgia, no dotted canvas border)'), facts.hostRules.transform === 'none' && !/Georgia/.test(facts.hostRules.font) && facts.hostRules.canvasBorder === '0px', JSON.stringify(facts.hostRules));
  check(tag('the box is the query container, contains its layout and starts from initial values'), /corn-box corn-page \/ size/.test(facts.box.container) && /layout/.test(facts.box.contain) && facts.box.textAlign !== 'justify', JSON.stringify(facts.box));
  check(tag('inst.active() is the focused element inside the shadow root'), facts.active && facts.canvasActive);
  check(tag('two reviews put no id in the document, and find their own elements'), facts.lookups && !/sheet-dock|graph-canvas|proposal-bar/.test(facts.documentIds), facts.documentIds);
  // the wheel: over the map with no focus it scrolls the host's page; with the map focused it zooms the map
  const wheel = async (focus) => {
    await page.evaluate((f) => { window.scrollTo(0, 0); const o = window.harness.pieces.objects; if (f) o.inst.state.canvas.focus(); else document.getElementById('host-button').focus(); }, focus);
    const b = await page.evaluate(() => { const r = window.harness.pieces.objects.inst.state.canvas.getBoundingClientRect(); return { x: r.x + r.width * 0.7, y: r.y + r.height * 0.5 }; });
    const z0 = await page.evaluate(() => window.harness.pieces.objects.inst.state.camera.zoom);
    await page.mouse.move(b.x, b.y); await page.mouse.wheel(0, 300); await new Promise((r) => setTimeout(r, 400));
    return page.evaluate((z) => ({ scrolled: window.scrollY > 0, zoomed: window.harness.pieces.objects.inst.state.camera.zoom !== z }), z0);
  };
  const free = await wheel(false); const focused = await wheel(true);
  check(tag('the wheel scrolls the host page over an unfocused map, and zooms the map once it has the focus'), free.scrolled && !free.zoomed && focused.zoomed && !focused.scrolled, JSON.stringify({ free, focused }));
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function main() {
  const { chromium } = await loadPlaywright();
  const base = path.join(os.tmpdir(), `cornfield-review-proof-${PORT}`);
  await Promise.all([
    startRig(['--port', String(MAP.port), '--forge-port', String(MAP.forge), '--public', MAP_ORIGIN, '--embed', HOST_ORIGIN], path.join(base, 'embed')),
    startRig(['--port', String(PAGE.port), '--forge-port', String(PAGE.forge)], path.join(base, 'page')),
  ]);
  const harness = await serveHarness({ port: HOST_PORT, repo: path.join(base, 'embed') });
  const browser = await chromium.launch({ args: ['--disable-accelerated-2d-canvas'] });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  const axe = axeSource();

  // Each review in a plain box of the host's page, then in the shadow root of a plain custom element under a strict CSP (`&shadow=1`, serve.mjs `?csp=1`):
  // how the coming <corn-review> holds it
  for (const [shadow, scheme] of [[false, 'light'], [false, 'dark'], [true, 'light'], [true, 'dark']]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await ctx.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`)); });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${MAP_ORIGIN}/auth/start`, { waitUntil: 'networkidle' });
    await page.goto(`${HOST_ORIGIN}/?objects=1100x680&rig=390x700&theme=${scheme}&base=${MAP_ORIGIN}${shadow ? '&shadow=1&csp=1' : ''}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.documentElement.dataset.harness === 'ready');
    await page.waitForFunction(() => window.harness.pieces.rig.inst.state.proposal, null, { timeout: 20000 });
    await wait(1500);
    const tag = (s) => `${shadow ? 'shadow, ' : ''}${scheme}: ${s}`;
    const pre = `${shadow ? 'shadow-' : ''}${scheme}`;
    await shot(page, `${pre}-01-open`);
    const info = await page.evaluate(() => {
      const o = window.harness.pieces.objects; const r = window.harness.pieces.rig;
      const box = (p) => p.elements[0].getBoundingClientRect();
      const phone = (p) => getComputedStyle(p.inst.el('sheet-dock')).position;
      return { oNodes: o.inst.state.nodes.length, oDraws: o.inst.map.frameStats().draws, rNodes: r.inst.state.nodes.length, oBox: [box(o).width, box(o).height], rBox: [box(r).width, box(r).height], oDock: phone(o), rDock: phone(r), win: innerWidth, rHandle: getComputedStyle(r.inst.el('proposal-bar').querySelector('.hx-sheet-handle')).display, oHandle: getComputedStyle(o.inst.el('proposal-bar').querySelector('.hx-sheet-handle')).display };
    });
    check(tag('both draw'), info.oNodes > 100 && info.oDraws > 0 && info.rNodes > 100, JSON.stringify([info.oNodes, info.oDraws, info.rNodes]));
    check(tag('the narrow box is the phone layout while the window is wide'), info.win === 1440 && info.rDock === 'absolute' && info.rHandle !== 'none' && info.oDock !== 'absolute' && info.oHandle === 'none', JSON.stringify([info.win, info.rDock, info.oDock]));
    check(tag('the boxes keep their sizes'), info.oBox[0] === 1100 + 4 || Math.abs(info.oBox[0] - 1100) <= 4, JSON.stringify([info.oBox, info.rBox]));

    // Before / Diff / After and Whole map, in the wide box
    const ow = (sel) => page.locator(`[data-box="objects"] ${sel}`);
    for (const view of ['before', 'after', 'diff']) { await ow(`[data-action="proposal-view"][data-view="${view}"]`).click(); await wait(400); if (view !== 'diff') await shot(page, `${pre}-02-view-${view}`); }
    check(tag('Before, After, Diff switch'), await page.evaluate(() => window.harness.pieces.objects.inst.state.proposalView) === 'diff');
    await ow('[data-action="proposal-whole"]').click(); await wait(500); await shot(page, `${pre}-03-whole-map`);
    check(tag('Whole map is on'), await page.evaluate(() => window.harness.pieces.objects.inst.state.review.whole) === true);
    await ow('[data-action="proposal-whole"]').click(); await wait(300);
    // a changed node and a changed edge
    await ow('[data-action="proposal-focus"][data-kind="node"]').first().click(); await wait(700);
    await shot(page, `${pre}-04-node-panel`);
    check(tag('a changed node opens the node panel'), await page.evaluate(() => window.harness.pieces.objects.inst.el('spec-drawer').classList.contains('drawer-open') && !!window.harness.pieces.objects.inst.state.selectedNode));
    await ow('[data-action="proposal-focus"][data-kind="edge"]').first().click(); await wait(700);
    await shot(page, `${pre}-05-edge-panel`);
    check(tag('a changed edge opens the edge panel'), await page.evaluate(() => window.harness.pieces.objects.inst.el('spec-drawer').classList.contains('drawer-open') && !!window.harness.pieces.objects.inst.state.selectedEdge));
    // a scenario
    await page.evaluate(() => window.harness.pieces.objects.inst.state.canvas.focus());
    await page.keyboard.press('Escape'); await wait(300);
    await ow('.hx-sc-row').first().click(); await wait(300);
    await ow('.hx-step').first().click(); await wait(900);
    await shot(page, `${pre}-06-player`);
    check(tag('a scenario plays: the player bar is in the box'), await page.evaluate(() => { const p = window.harness.pieces.objects; const bar = p.inst.el('review-column') && p.elements[0].querySelector('.hx-player'); return !!bar && p.elements[0].contains(bar) && !!p.inst.state.scenario; }));
    await page.keyboard.press('Escape'); await wait(300);
    // the phone's sheets in the narrow box
    const rig = (sel) => page.locator(`[data-box="rig"] ${sel}`);
    await rig('.hx-sheet-handle').first().click(); await wait(500);
    await shot(page, `${pre}-07-phone-expanded`);
    await page.evaluate(() => { const r = window.harness.pieces.rig; const n = r.inst.state.nodes.find((x) => x.mark === 'added'); r.update({ node: n.id }); });
    await wait(700); await shot(page, `${pre}-08-phone-node`);
    await rig('#spec-drawer').click({ position: { x: 60, y: 30 }, force: true }); await wait(500); // the node panel (a peek: a tap anywhere on it) expanded: its tap-away backdrop is drawn
    await shot(page, `${pre}-09-phone-node-expanded`);
    const fixed = await page.evaluate(() => {
      const r = window.harness.pieces.rig; const box = r.elements[0].getBoundingClientRect();
      const inside = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.left >= box.left - 1 && b.right <= box.right + 1 && b.top >= box.top - 1 && b.bottom <= box.bottom + 1; };
      const backdrop = r.inst.el('drawer-backdrop');
      return { shown: !backdrop.hidden && getComputedStyle(backdrop).display !== 'none', inside: inside(backdrop), pos: getComputedStyle(backdrop).position, rect: JSON.stringify(backdrop.getBoundingClientRect()), box: JSON.stringify(box) };
    });
    check(tag('the fixed backdrop stays inside the narrow box'), fixed.pos === 'fixed' && fixed.shown && fixed.inside, JSON.stringify(fixed));
    // independence, body, head
    const indep = await page.evaluate(() => {
      const o = window.harness.pieces.objects; const r = window.harness.pieces.rig;
      return { o: o.inst.state.selectedNode && o.inst.state.selectedNode.id, r: r.inst.state.selectedNode && r.inst.state.selectedNode.id, oEdge: !!o.inst.state.selectedEdge };
    });
    check(tag('the two pieces are independent'), indep.r && indep.o !== indep.r, JSON.stringify(indep));
    const body = await page.evaluate(() => ({ kids: [...document.body.children].map((e) => e.tagName + (e.id ? `#${e.id}` : '')), head: document.head.querySelectorAll('style').length, htmlAttrs: document.documentElement.getAttributeNames().sort() }));
    check(tag('nothing is appended to the body (and no <style> to the head)'), body.kids.join(',') === 'HEADER,MAIN,SCRIPT' && body.head === 0, JSON.stringify(body));
    if (shadow) await shadowChecks(page, tag);
    // axe
    if (axe) {
      await page.evaluate(() => window.harness.pieces.rig.update({ node: null }));
      await wait(300);
      await page.evaluate(axe);
      for (const name of ['objects', 'rig']) {
        const res = await page.evaluate(async (n) => { const r = await window.axe.run(document.querySelector(`[data-box="${n}"]`), { resultTypes: ['violations'] }); return r.violations.map((v) => `${v.id}: ${v.nodes.length} ${v.nodes.slice(0, 2).map((x) => JSON.stringify(x.target)).join(' ')}`); }, name);
        check(tag(`axe on the ${name} box`), res.length === 0, res.join('; '));
      }
    }
    // destroy leaves nothing
    const gone = await page.evaluate(() => {
      const before = [...document.body.querySelectorAll('*')].length;
      for (const n of ['objects', 'rig']) window.harness.pieces[n].destroy();
      const roots = ['objects', 'rig'].map((n) => window.harness.root(n));
      return { before, after: [...document.body.querySelectorAll('*')].length, boxes: roots.reduce((k, r) => k + r.querySelectorAll('[data-corn="review"]').length, 0), kids: roots.reduce((k, r) => k + r.childNodes.length, 0) };
    });
    check(tag('destroy leaves nothing in the host'), gone.boxes === 0 && gone.kids === 0, JSON.stringify(gone));
    check(tag('no page errors'), errors.length === 0, errors.join('; '));
    if (shadow) { const csp = await page.evaluate(() => window.__csp); check(tag('no Content-Security-Policy violation under style-src \'self\''), csp.length === 0, csp.slice(0, 5).join('; ')); }
    await ctx.close();
  }

  // the requests, against cornfield's own page
  const sizes = { width: 1440, height: 900 };
  const run = async (kind) => {
    const ctx = await browser.newContext({ viewport: sizes, reducedMotion: 'no-preference' });
    await ctx.addInitScript(RECORD);
    const page = await ctx.newPage();
    page.setDefaultTimeout(8000);
    const opened = () => page.waitForFunction(() => { const t = document.getElementById('proposal-title'); const l = document.querySelector('[data-review-line]'); return t && t.textContent && l && l.textContent && !/Reading|Checking/i.test(l.textContent); }, null, { timeout: 25000 }).catch(() => {});
    const go = async (slug, pr) => {
      if (kind === 'page') { await page.goto(`http://127.0.0.1:${PAGE.port}/?proposal=${slug}&source=pull/${pr}`, { waitUntil: 'networkidle' }); } else { await page.goto(`${HOST_ORIGIN}/?rig=1100x680&slug=${slug}&source=pull/${pr}&theme=dark&shadow=1&csp=1&base=${MAP_ORIGIN}`, { waitUntil: 'networkidle' }); }
      await opened(); await wait(600);
    };
    await page.goto(kind === 'page' ? `http://127.0.0.1:${PAGE.port}/auth/start` : `${MAP_ORIGIN}/auth/start`, { waitUntil: 'networkidle' });
    await go(SLUGS[0], 21);
    const approve = await decisionSteps(page, kind, wait);
    await go(SLUGS[1], 22);
    const send = await sendBack(page, wait);
    await ctx.close();
    return { approve, send };
  };
  const onPage = await run('page');
  const onPiece = await run('piece');
  fs.writeFileSync(path.join(SHOTS, 'requests.json'), JSON.stringify({ page: onPage, piece: onPiece }, null, 1));
  const count = (r) => [...r.approve, ...r.send].reduce((n, s) => n + s.log.length, 0);
  check('Approve with the hold, Undo and the landing: the same requests as the page', same(onPage.approve, onPiece.approve) && count({ approve: onPage.approve, send: [] }) > 0, `${count({ approve: onPage.approve, send: [] })} requests`);
  check('Send back with a note: the same request as the page', same(onPage.send, onPiece.send) && count({ approve: [], send: onPage.send }) > 0, `${count({ approve: [], send: onPage.send })} requests`);
  check('the only difference is the session on a base of another origin: credentials include, and no redirect followed with it', [...onPiece.approve, ...onPiece.send].every((s) => s.log.every((r) => r.cred === 'include' && r.redirect === 'error')) && [...onPage.approve, ...onPage.send].every((s) => s.log.every((r) => r.cred === '-' && r.redirect === '-')));

  await browser.close();
  harness.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} passed; screenshots in ${SHOTS}`);
  if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(results, null, 1));
  return failed.length ? 1 : 0;
}

main().then((code) => { children.forEach((c) => c.kill('SIGTERM')); process.exit(code); }, (err) => { console.error(err); children.forEach((c) => c.kill('SIGTERM')); process.exit(1); });
