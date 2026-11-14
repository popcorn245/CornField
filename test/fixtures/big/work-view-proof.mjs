/**
 * The proof in a browser of cornfield's Work view (spec 0012, step 2), against the rig with the fake forge. Runs by hand: needs Playwright and Chromium.
 *
 *   node test/fixtures/big/work-view-proof.mjs [--shots <dir>] [--port <n>] [--slow <ms>]
 *
 * Signs in and opens the Work view by its button, then drives it by mouse and keyboard: every kind of node is there and each is selected (the node panel says what it is),
 * a connection is followed, Waiting on you dims the rest, the layers go off and on (the local drafts' layer is off to start, and on it has a lane), search finds `#21`, `PR 21`,
 * a slug and a title, N, P and the arrows move through the lanes, Enter goes into the panel and Escape back, each address opens the view on its node, and Map brings the map back.
 * It looks at what is on the screen: the names under the nodes (none off the screen, none over another, none under a control), the lanes' titles (readable, under the toggles),
 * the controls (none over another, on a desktop and on a phone) and the header's two Work buttons. It then starts a second rig whose fake forge is slow (`--slow`, ms a request;
 * default 1500) and proves the first answer shows its loading state at once, that the page works while it is awaited, and that a refresh keeps the last answer on the map.
 * Screenshots (synthetic fixture only) go in `--shots`: desktop dark and light with all work, with a node selected, with Waiting on you, with the drafts on, and a phone with all work and with a node selected.
 * Exit code 1 when a check fails.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE = path.join(HERE, 'serve.js');
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const SHOTS = arg('--shots');
const PORT = Number(arg('--port') || 3830);
const SLOW = Number(arg('--slow') || 1500);
const BASE = `http://127.0.0.1:${PORT}`;

async function loadPlaywright() {
  for (const t of ['playwright', pathToFileURL('/opt/node-tools/node_modules/playwright/index.mjs').href]) { try { return await import(t); } catch { /* next */ } }
  throw new Error('Playwright is not installed');
}
function startRig(port, extra = []) {
  const child = spawn(process.execPath, [SERVE, '--forge', '--port', String(port), '--forge-port', String(port + 1), '--dir', path.join(os.tmpdir(), `cornfield-work-proof-${port}`), ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`the rig did not start:\n${out}`)); }, 90_000);
    const see = (d) => { out += d; if (out.includes('Ctrl-C stops it')) { clearTimeout(timer); resolve({ stop: () => child.kill('SIGTERM') }); } };
    child.stdout.on('data', see); child.stderr.on('data', see);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`the rig exited (${code}):\n${out}`)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`); };
/** Waits until `fn` (run in the page) says true: Playwright's waitForFunction does not wait for an async one */
async function until(page, fn, arg, timeout = 30_000) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn, arg)) return true;
    if (Date.now() - t0 > timeout) return false;
    await sleep(150);
  }
}

// ---------------------------------------------------------------------------
//  What is on the screen
// ---------------------------------------------------------------------------

/** Every name drawn under a node: where it is on the screen, and whether it is off the screen, over another name, or under a control */
const namesOnScreen = (page) => page.evaluate(async () => {
  const { state } = await import('/explorer/state.js');
  const { getScene } = await import('/explorer/render.js');
  const { placeLabels } = await import('/explorer/labels.js');
  const { FONT_NODE } = await import('/explorer/scene.js');
  const ctx = document.createElement('canvas').getContext('2d');
  const measure = (text, size, bold) => { ctx.font = `${bold ? 'bold ' : ''}${size}px ${FONT_NODE}`; return ctx.measureText(text).width; };
  const { camera } = state;
  const stage = state.canvas.getBoundingClientRect();
  const boxes = placeLabels(getScene(), camera.zoom, { measure })
    .map((p) => ({ id: p.id, l: camera.x + p.l, r: camera.x + p.r, t: camera.y + p.t, b: camera.y + p.b }))
    .filter((b) => b.r > 0 && b.l < stage.width && b.b > 0 && b.t < stage.height && ((b.l + b.r) / 2) > 0 && ((b.l + b.r) / 2) < stage.width && ((b.t + b.b) / 2) > 0 && ((b.t + b.b) / 2) < stage.height);
  const off = boxes.filter((b) => b.l < 0 || b.r > stage.width || b.t < 0 || b.b > stage.height).map((b) => b.id);
  const over = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i]; const b = boxes[j]; if (a.l < b.r - 1 && a.r > b.l + 1 && a.t < b.b - 1 && a.b > b.t + 1) over.push(`${a.id} / ${b.id}`); }
  const controls = [...document.querySelectorAll('.hx-work-chip, .hx-layers-chip, #fit-btn, .hx-view, .hx-hint:not([hidden])')].filter((e) => e.offsetParent !== null).map((e) => e.getBoundingClientRect());
  const under = boxes.filter((b) => controls.some((c) => stage.left + b.l < c.right && stage.left + b.r > c.left && stage.top + b.t < c.bottom && stage.top + b.b > c.top)).map((b) => b.id);
  return { count: boxes.length, off, over, under, zoom: camera.zoom };
});

/** The controls on the page, pairwise: any two that overlap */
const controlsOverlap = (page) => page.evaluate(() => {
  const sel = ['.hx-view', '#preset-work-btn', '#fit-btn', '.hx-layers-chip', '.hx-work-bar', '#legend-toggle-btn', '[data-corn="forge-button"]', '.hx-account-btn', '.hx-search', '.hx-hint', '[data-corn="search-field"]'];
  const seen = [];
  for (const s of sel) for (const e of document.querySelectorAll(s)) { const r = e.getBoundingClientRect(); if (e.offsetParent !== null && r.width > 0 && r.height > 0) seen.push({ s, e, r }); }
  const clash = [];
  for (let i = 0; i < seen.length; i++) for (let j = i + 1; j < seen.length; j++) {
    const a = seen[i]; const b = seen[j];
    if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
    if (a.r.left < b.r.right - 1 && a.r.right > b.r.left + 1 && a.r.top < b.r.bottom - 1 && a.r.bottom > b.r.top + 1) clash.push(`${a.s} / ${b.s}`);
  }
  return clash;
});

/** The lanes' titles as drawn: their size, and whether each is on the screen and clear of the toggles */
const laneTitles = (page) => page.evaluate(() => {
  const vw = window.innerWidth;
  const others = ['.hx-work-bar', '.hx-layers-chip', '#fit-btn'].map((q) => document.querySelector(q)).filter((e) => e && e.offsetParent !== null).map((e) => e.getBoundingClientRect());
  return [...document.querySelectorAll('.hx-work-lanes .hx-work-lane-title')].filter((e) => getComputedStyle(e).visibility !== 'hidden').map((e) => {
    const r = e.getBoundingClientRect();
    return { text: e.textContent, px: parseFloat(getComputedStyle(e).fontSize), inside: r.left >= 0 && r.right <= vw, clear: others.every((bar) => r.right <= bar.left || r.left >= bar.right || r.bottom <= bar.top || r.top >= bar.bottom) };
  });
});

async function main() {
  const { chromium } = await loadPlaywright();
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const rig = await startRig(PORT);
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  try {
    const newContext = async (opts) => {
      const context = await browser.newContext({ reducedMotion: 'reduce', ...opts });
      const sign = await context.newPage();
      await sign.goto(`${BASE}/auth/start`); await sign.waitForURL(`${BASE}/**`); await sign.close();
      return context;
    };
    const listen = (page) => {
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(m.text()); });
    };
    const context = await newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    const page = await context.newPage();
    listen(page);
    await page.goto(`${BASE}/`);
    await page.waitForSelector('#preset-work-btn:not([hidden])', { timeout: 30_000 });

    const snap = () => page.evaluate(async () => {
      const { state } = await import('/explorer/state.js');
      const n = state.selectedNode;
      return { view: state.view, nodes: state.nodes.length, kinds: [...new Set(state.nodes.filter((x) => x.work).map((x) => x.work))].sort(), selected: n ? n.id : null, hidden: state.nodes.filter((x) => x.hidden).length, dim: state.nodes.filter((x) => x.dim).length, layers: { ...state.activeLayers }, zoom: state.camera.zoom, shown: state.nodes.filter((x) => !x.hidden).length };
    });
    const live = () => page.evaluate(() => document.querySelector('#map-announcer')?.textContent || '');
    const center = (id) => page.evaluate(async (want) => {
      const { state } = await import('/explorer/state.js');
      const n = state.nodes.find((x) => x.id === want);
      const r = state.canvas.getBoundingClientRect();
      return n ? { x: r.left + state.camera.x + n.x * state.camera.zoom, y: r.top + state.camera.y + n.y * state.camera.zoom } : null;
    }, id);
    const click = async (id) => { const c = await center(id); await page.mouse.click(c.x, c.y); await sleep(500); };
    const pick = async (id) => { await page.evaluate(async (i) => { const { pick: p } = await import('/explorer/work-view.js'); p(i); }, id); await sleep(500); };
    const clear = () => page.evaluate(async () => { const m = await import('/explorer/engine/selection.js'); const { pageInstance } = await import('/explorer/state.js'); m.clearSelection(pageInstance()); });
    const shot = async (name, p = page) => { if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
    const panelTitle = () => page.locator('#drawer-title').innerText();
    const layersMenu = async () => { await page.click('#legend-toggle-btn'); await sleep(300); };
    const closeMenu = async () => { await page.keyboard.press('Escape'); await sleep(200); };

    const before = await snap();
    const mapLayers = before.layers;

    // the header's two Work buttons
    const buttons = await page.evaluate(() => ({
      view: document.querySelector('#preset-work-btn').getAttribute('aria-label') || document.querySelector('#preset-work-btn').textContent,
      panel: document.querySelector('[data-corn="forge-button"]').getAttribute('aria-label'),
      panelText: document.querySelector('[data-corn="forge-button"]').textContent.replace(/\s+/g, ' ').trim(),
      panelBadge: !!document.querySelector('[data-corn="forge-button"] [data-corn="waiting-badge"]'),
    }));
    check('the far-right button is the Work panel, with no badge, and the view switch\'s Work is not that', buttons.panel === 'Work panel' && /^Work panel/.test(buttons.panelText) && !buttons.panelBadge && /^Work/.test(buttons.view) && buttons.view !== buttons.panel, JSON.stringify(buttons));

    await page.click('#preset-work-btn');
    check('the Work view opens and shows its answer', await until(page, async () => { const { state } = await import('/explorer/state.js'); return state.view === 'work' && state.nodes.some((n) => n.work); }, null, 60_000));
    await sleep(900);
    let s = await snap();
    check('the Work button is pressed and the Map button is not', (await page.getAttribute('#preset-work-btn', 'aria-pressed')) === 'true' && (await page.getAttribute('#preset-map-btn', 'aria-pressed')) === 'false');
    check('every kind of work is a node', s.kinds.join() === 'deploy,issue,proposal,pull,run,thread', s.kinds.join());
    check('the live region says the view and the counts', /^Work: \d+ pieces? of work/.test(await live()), await live());
    const badge = await page.locator('#preset-work-btn [data-corn="waiting-badge"]').innerText();
    check('the view switch\'s Work carries what waits on you, and says it', /^\d+$/.test(badge) && /waiting on you/.test(await page.getAttribute('#preset-work-btn', 'aria-label') || ''), `${badge}: ${await page.getAttribute('#preset-work-btn', 'aria-label')}`);

    // the drafts are a layer of their own, off to start
    const decide = await page.evaluate(async () => { const { state } = await import('/explorer/state.js'); const d = state.nodes.filter((n) => n.work === 'proposal'); return { shown: d.filter((n) => !n.hidden).length, local: d.filter((n) => n.item.state === 'local').length, localShown: d.filter((n) => n.item.state === 'local' && !n.hidden).length }; });
    check('with Drafts off, Decide holds the proposals on spec pull requests only', decide.local > 0 && decide.localShown === 0 && decide.shown > 0 && decide.shown < 12, JSON.stringify(decide));
    const chip = await page.locator('.hx-layers-chip').innerText();
    check('the Layers chip counts the drafts layer as off', /7 of 8/.test(chip), chip.replace(/\s+/g, ' '));

    // what is on the screen
    let names = await namesOnScreen(page);
    check('desktop, all work: no name is off the screen, over another name or under a control', names.count > 10 && names.off.length === 0 && names.over.length === 0 && names.under.length === 0, `${names.count} names, zoom ${names.zoom.toFixed(2)}; off ${names.off.join()} over ${names.over.slice(0, 3).join()} under ${names.under.slice(0, 3).join()}`);
    let lanes = await laneTitles(page);
    check('the lanes\' titles read at the first fit: Talk, Decide, Build, Ship and the code, 11 px or more, on the screen and clear of the toggles', lanes.length === 5 && lanes.every((l) => l.px >= 11 && l.inside && l.clear), lanes.map((l) => `${l.text.replace(/\s+/g, ' ')} ${l.px}px`).join(' | '));
    const top = await page.evaluate(async () => { const { state } = await import('/explorer/state.js'); const r = state.canvas.getBoundingClientRect(); return { first: Math.min(...state.work.lanes.map((l) => state.camera.y + l.y * state.camera.zoom)), bar: document.querySelector('.hx-work-bar').getBoundingClientRect().bottom - r.top }; });
    check('the lanes start under the toggles, without a band of nothing', top.first >= top.bar && top.first - top.bar < 40, `lanes at ${Math.round(top.first)} px, toggles end at ${Math.round(top.bar)}`);
    check('no control is over another', (await controlsOverlap(page)).length === 0, (await controlsOverlap(page)).join(' | '));
    await shot('desktop-dark-work');

    // each kind, by mouse
    const firstOf = (kind) => page.evaluate(async (k) => (await import('/explorer/state.js')).state.nodes.find((n) => n.work === k && !n.hidden).id, kind);
    const words = { thread: 'Thread', issue: 'Issue', proposal: 'Proposal', run: 'Agent run', pull: 'Pull request', deploy: 'Deploy' };
    for (const kind of Object.keys(words)) {
      const id = await firstOf(kind);
      await clear();
      await click(id);
      s = await snap();
      check(`a ${words[kind].toLowerCase()} is selected by a click and the panel says its kind`, s.selected === id && (await page.locator('#drawer-badge').innerText()) === words[kind], await panelTitle());
    }

    // a connection, and the node panel's links
    const pull = await firstOf('pull');
    await pick(pull);
    const links = page.locator('[data-corn="work-link"] [data-action="select-node"]');
    const n = await links.count();
    check('a selected pull request lists what it is connected to', n > 0, `${n} links`);
    if (n) {
      const first = await links.first().getAttribute('data-id');
      await links.first().click(); await sleep(500);
      check('a connection is followed: its node is selected', (await snap()).selected === first, first);
    }
    await pick('proposal:0100-new-flow-across-apps');
    const hrefs = await page.evaluate(() => [...document.querySelectorAll('[data-corn="work-actions"] a[href], [data-corn="work-links"] a[href]')].map((a) => a.getAttribute('href')));
    check('the node panel links to the forge by an http or https address only', hrefs.length > 0 && hrefs.every((h) => /^https?:\/\//.test(h)), hrefs.join(' | '));
    check('the panel offers Open in Work', await page.locator('[data-work-action="open-in-work"]').count() > 0);
    names = await namesOnScreen(page);
    check('desktop, a node selected: no name off the screen or over another', names.off.length === 0 && names.over.length === 0, `off ${names.off.join()} over ${names.over.slice(0, 3).join()}`);
    await shot('desktop-dark-selected');
    await page.evaluate(() => document.querySelector('#drawer-close, [data-action="close-drawer"]')?.click()); await sleep(300);

    // Waiting on you
    await clear();
    await page.click('[data-work-show="waiting"]'); await sleep(500);
    s = await snap();
    check('Waiting on you dims all but what waits', s.dim > 0 && (await page.getAttribute('[data-work-show="waiting"]', 'aria-pressed')) === 'true', `${s.dim} dimmed`);
    names = await namesOnScreen(page);
    check('Waiting on you: the names are placed as before', names.off.length === 0 && names.over.length === 0, `${names.count} names`);
    await shot('desktop-dark-waiting');
    await page.click('[data-work-show="all"]'); await sleep(300);
    check('All work brings them back', (await snap()).dim === 0);

    // layers: the eight rows, a layer off, the drafts on
    await layersMenu();
    const rows = await page.locator('#layer-toggles-container [data-action="toggle-layer"]').allInnerTexts();
    check('the Layers menu lists the six kinds, the drafts and the code they touch, with counts', rows.length === 8 && /Threads/.test(rows[0]) && /Drafts\s*\d+ local/.test(rows[6].replace(/\n/g, ' ')) && /Code they touch/.test(rows[7]), rows.join(' | ').replace(/\s+/g, ' '));
    await page.locator('#layer-toggles-container [data-layer="work-pull"]').click(); await sleep(500);
    s = await snap();
    check('a layer off hides its kind', s.hidden > 0, `${s.hidden} hidden`);
    await page.locator('#layer-toggles-container [data-layer="work-pull"]').click(); await sleep(500);
    check('and on brings it back', (await snap()).hidden === decide.local + (await page.evaluate(async () => (await import('/explorer/state.js')).state.nodes.filter((x) => !x.work && x.hidden).length)));
    await page.locator('#layer-toggles-container [data-layer="work-drafts"]').click(); await sleep(700);
    await closeMenu();
    await page.mouse.click(700, 880); await sleep(300);
    s = await snap();
    const draftsOn = await page.evaluate(async () => { const { state } = await import('/explorer/state.js'); return { lanes: state.work.lanes.map((l) => `${l.name} ${l.count}`), shown: state.nodes.filter((n) => n.draft && !n.hidden).length }; });
    check('Drafts on draws them in a lane of their own beside Decide', draftsOn.shown > 50 && draftsOn.lanes.some((l) => /^Drafts \d+/.test(l)) && draftsOn.lanes[2].startsWith('Drafts'), draftsOn.lanes.join(' | '));
    names = await namesOnScreen(page);
    check('Drafts on: the names that are drawn are on the screen and not over each other', names.count > 40 && names.off.length === 0 && names.over.length === 0, `${names.count} names, zoom ${names.zoom.toFixed(2)}; off ${names.off.join()} over ${names.over.slice(0, 3).join()}`);
    check('Drafts on: the Layers chip says 8 of 8', /8 of 8/.test(await page.locator('.hx-layers-chip').innerText()));
    await shot('desktop-dark-drafts');
    await layersMenu();
    await page.locator('#layer-toggles-container [data-layer="work-drafts"]').click(); await sleep(600);
    await closeMenu();
    check('Drafts off takes the lane away again', (await snap()).shown < s.shown && !(await page.evaluate(async () => (await import('/explorer/state.js')).state.work.lanes.some((l) => l.name === 'Drafts'))));

    // search
    const search = async (q) => { await page.click('#node-search'); await page.fill('#node-search', q); await sleep(700); const t = await page.locator('[data-corn="search-result"]').allInnerTexts(); await page.fill('#node-search', ''); await page.keyboard.press('Escape'); return t.join(' | ').replace(/\s+/g, ' '); };
    check('search finds #21 while in the Work view', /0100|#21/.test(await search('#21')));
    check('search finds PR 21', /0100|#21/.test(await search('PR 21')));
    check('search finds a slug', /0100/.test(await search('0100-new-flow-across-apps')));
    check('search finds a title', /new flow/i.test(await search('new flow from api')));

    // keyboard
    await clear();
    await page.evaluate(() => document.querySelector('canvas').focus());
    await page.keyboard.press('n'); await sleep(400);
    const first = (await snap()).selected;
    check('N selects the first node of the first lane', first === 'thread:21' || /^(thread|issue):/.test(first || ''), first);
    check('and the live region says its name, kind and place', /thread|issue/.test(await live()) && /of \d+/.test(await live()), await live());
    await page.keyboard.press('n'); await sleep(300);
    const second = (await snap()).selected;
    await page.keyboard.press('p'); await sleep(300);
    check('N goes on and P back', second !== first && (await snap()).selected === first, `${first} ${second}`);
    await page.keyboard.press('ArrowRight'); await sleep(400);
    const right = (await snap()).selected;
    check('an arrow goes to the nearest node that way (Right: the next lane)', right && right !== first && /^proposal:|^run:|^pull:/.test(right), right);
    await page.keyboard.press('ArrowLeft'); await sleep(400);
    check('and back again with the opposite arrow', /^(thread|issue):/.test((await snap()).selected || ''), (await snap()).selected);
    const cam = (await snap()).zoom;
    await page.evaluate(() => document.querySelector('canvas').focus());
    const x0 = await page.evaluate(async () => (await import('/explorer/state.js')).state.camera.x);
    await page.keyboard.press('Shift+ArrowRight'); await sleep(300);
    check('Shift and an arrow still pan', (await page.evaluate(async () => (await import('/explorer/state.js')).state.camera.x)) !== x0 && (await snap()).zoom === cam);
    await page.keyboard.press('Enter'); await sleep(300);
    check('Enter goes into the node panel', await page.evaluate(() => document.activeElement && document.activeElement.id === 'drawer-title'));
    await page.keyboard.press('Escape'); await sleep(300);
    check('Escape comes back to the map', (await page.evaluate(() => document.activeElement && document.activeElement.tagName)) === 'CANVAS');
    await clear();

    // Map restores
    await page.click('#preset-map-btn'); await sleep(800);
    s = await snap();
    check('Map brings the map back with its layers as they were', s.view === 'orbit' && JSON.stringify(s.layers) === JSON.stringify(mapLayers) && s.nodes === before.nodes && s.kinds.length === 0, `${s.nodes} nodes`);
    await page.click('#node-search'); await page.fill('#node-search', '#21'); await sleep(700);
    check('search from the Map finds work too', await page.locator('[data-corn="search-result"]').count() > 0);
    await page.fill('#node-search', ''); await page.keyboard.press('Escape');

    // addresses
    const addresses = [['?view=work', null], ['?pr=21', 'proposal:0100-new-flow-across-apps'], ['?issue=3', 'issue:3'], ['?thread=21', 'thread:21'], ['?spec=0100', 'proposal:0100-new-flow-across-apps']];
    for (const [q, want] of addresses) {
      await page.goto(`${BASE}/${q}`);
      await until(page, async () => { const { state } = await import('/explorer/state.js'); return state.nodes.some((n) => n.work); });
      await sleep(900);
      s = await snap();
      check(`${q} opens the Work view${want ? ' with that node selected' : ''}`, s.view === 'work' && (!want || s.selected === want), `${s.view} ${s.selected}`);
    }
    const run = await page.evaluate(async () => (await import('/explorer/state.js')).state.nodes.find((n) => n.work === 'run')?.item.runId);
    if (run) {
      await page.goto(`${BASE}/?run=${run}`);
      await until(page, async () => (await import('/explorer/state.js')).state.selectedNode?.work === 'run');
      check('?run= selects that run in the Work view', (await snap()).selected === `run:${run}`, `${(await snap()).selected} for ${run}`);
    }

    // axe, on the view with a node's panel open
    await page.goto(`${BASE}/?issue=3`);
    await until(page, async () => (await import('/explorer/state.js')).state.selectedNode?.work === 'issue');
    await sleep(800);
    const axeSource = fs.readFileSync(path.join(HERE, '..', '..', '..', 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
    await page.route('**/__axe.js', (route) => route.fulfill({ body: axeSource, contentType: 'application/javascript' })); // a script of the page's own origin: its CSP does not allow an inline one
    await page.addScriptTag({ url: `${BASE}/__axe.js` });
    const axe = await page.evaluate(async () => { const r = await window.axe.run(document, { resultTypes: ['violations'] }); return r.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0].target.join(' ')}`); });
    check('axe: no violation in the Work view with a node open', axe.length === 0, axe.join(' | '));

    // light
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`${BASE}/?view=work`);
    await until(page, async () => (await import('/explorer/state.js')).state.nodes.some((n) => n.work));
    await sleep(1500);
    names = await namesOnScreen(page);
    check('light: no name off the screen or over another', names.off.length === 0 && names.over.length === 0 && names.under.length === 0, `${names.count} names`);
    await shot('desktop-light-work');

    // a phone
    const phoneContext = await newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', hasTouch: true, isMobile: true });
    const pp = await phoneContext.newPage();
    listen(pp);
    await pp.goto(`${BASE}/?view=work`);
    await until(pp, async () => (await import('/explorer/state.js')).state.nodes.some((n) => n.work), null, 60_000);
    await sleep(2000);
    check('the phone shows the view', (await pp.evaluate(async () => (await import('/explorer/state.js')).state.view)) === 'work');
    const header = await pp.evaluate(() => ({ panelShown: getComputedStyle(document.querySelector('[data-corn="forge-button"]')).display !== 'none', badge: document.querySelector('#preset-work-btn [data-corn="waiting-badge"]') && getComputedStyle(document.querySelector('#preset-work-btn [data-corn="waiting-badge"]')).display !== 'none' }));
    check('on a phone the header\'s own Work button is not there and the view switch carries the badge', !header.panelShown && header.badge, JSON.stringify(header));
    check('on a phone no control is over another', (await controlsOverlap(pp)).length === 0, (await controlsOverlap(pp)).join(' | '));
    const phoneNames = await namesOnScreen(pp);
    check('on a phone no name is off the screen, over another or under a control', phoneNames.count > 3 && phoneNames.off.length === 0 && phoneNames.over.length === 0 && phoneNames.under.length === 0, `${phoneNames.count} names, zoom ${phoneNames.zoom.toFixed(2)}; off ${phoneNames.off.join()} over ${phoneNames.over.slice(0, 3).join()} under ${phoneNames.under.slice(0, 3).join()}`);
    const order = await pp.evaluate(async () => { const { state } = await import('/explorer/state.js'); const r = state.canvas.getBoundingClientRect(); const y = (name) => { const l = state.work.lanes.find((x) => x.name === name); return l ? l.y : null; }; return { talk: y('Talk'), decide: y('Decide'), build: y('Build · Ship'), code: state.work.lanes.find((x) => x.name === 'Code it touches'), width: r.width }; });
    check('on a phone the lanes run top to bottom: Talk, Decide, then Build and Ship, with the code beside them', order.talk < order.decide && order.decide < order.build && order.code && order.code.x > 0, JSON.stringify({ talk: order.talk, decide: order.decide, build: order.build }));
    const phoneTitles = await laneTitles(pp);
    check('on a phone the lanes\' titles are on the screen and 11 px or more', phoneTitles.length >= 3 && phoneTitles.every((l) => l.px >= 11 && l.inside), phoneTitles.map((l) => `${l.text.replace(/\s+/g, ' ')} ${l.px}px`).join(' | '));
    await shot('phone-dark-work', pp);
    const phoneNode = await pp.evaluate(async () => (await import('/explorer/state.js')).state.nodes.find((n) => n.id === 'proposal:0100-new-flow-across-apps') ? 'proposal:0100-new-flow-across-apps' : null);
    await pp.evaluate(async (i) => { const { pick: p } = await import('/explorer/work-view.js'); p(i); }, phoneNode);
    await sleep(1200);
    check('on a phone a node is selected and its sheet opens', (await pp.evaluate(async () => (await import('/explorer/state.js')).state.selectedNode?.id)) === phoneNode);
    check('on a phone, selected, no control is over another', (await controlsOverlap(pp)).length === 0, (await controlsOverlap(pp)).join(' | '));
    const phoneSelected = await namesOnScreen(pp);
    check('on a phone, selected, no name is off the screen or over another (the selection moves the map, so a name may pass under a toggle)', phoneSelected.off.length === 0 && phoneSelected.over.length === 0, `${phoneSelected.count} names; off ${phoneSelected.off.join()} over ${phoneSelected.over.slice(0, 3).join()}`);
    const titlesSelected = await laneTitles(pp);
    check('on a phone, selected, the lanes\' titles stay clear of the toggles', titlesSelected.length > 0 && titlesSelected.every((l) => l.inside && l.clear), titlesSelected.map((l) => l.text).join(' | '));
    await shot('phone-dark-selected', pp);
    await phoneContext.close();

    check('no page error', errors.length === 0, errors.slice(0, 2).join(' | '));
    await loadingProof(browser);
  } finally {
    await browser.close();
    rig.stop();
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

/** A second rig whose forge is slow: the first answer shows its loading state at once, the page works meanwhile, and a refresh keeps the last answer */
async function loadingProof(browser) {
  const port = PORT + 10;
  const base = `http://127.0.0.1:${port}`;
  const slow = await startRig(port, ['--forge-delay', String(SLOW)]);
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' });
    const sign = await context.newPage();
    await sign.goto(`${base}/auth/start`); await sign.waitForURL(`${base}/**`); await sign.close();
    const page = await context.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`${base}/`);
    await page.waitForSelector('#preset-work-btn:not([hidden])', { timeout: 30_000 });
    const t0 = Date.now();
    await page.click('#preset-work-btn');
    const sawLoading = await page.waitForSelector('[data-corn="work-loading"]:not([hidden])', { timeout: 3000 }).then(() => Date.now() - t0, () => -1);
    check(`slow forge (${SLOW} ms a request): the loading state shows at once`, sawLoading >= 0 && sawLoading < 1000, `${sawLoading} ms`);
    const words = await page.locator('.hx-work-loading-text').innerText().catch(() => '');
    check('and says what is happening', /Reading the work/.test(words), words);
    check('the lanes\' names are there while it waits', (await page.locator('.hx-work-skel-lane').count()) === 5);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'desktop-dark-loading.png') });
    // the page works meanwhile
    await page.click('#legend-toggle-btn'); await sleep(300);
    const rowCount = await page.locator('#layer-toggles-container [data-action="toggle-layer"]').count();
    check('the Layers menu opens and lists the Work view\'s rows while it waits', rowCount === 8, `${rowCount} rows`);
    await page.keyboard.press('Escape');
    await page.fill('#node-search', 'login'); await sleep(500);
    check('search takes input while it waits and says what it found', (await page.locator('[data-corn="search-status"], [data-corn="search-results"]').count()) > 0);
    await page.fill('#node-search', ''); await page.keyboard.press('Escape');
    await page.click('#preset-dataflow-btn'); await sleep(400);
    check('the views switch while it waits', (await page.evaluate(async () => (await import('/explorer/state.js')).state.view)) === 'dataflow');
    await page.click('#preset-map-btn'); await sleep(400);
    check('and the map is there as it was', (await page.evaluate(async () => (await import('/explorer/state.js')).state.nodes.length)) > 500);
    await page.click('#preset-work-btn');
    check('coming back to the Work view shows the loading state again, not a blank map', await page.evaluate(() => !document.querySelector('[data-corn="work-loading"]').hidden));
    const arrived = await until(page, async () => { const { state } = await import('/explorer/state.js'); return state.view === 'work' && state.nodes.some((n) => n.work); }, null, 120_000);
    const took = Date.now() - t0;
    console.log(`     the first answer took ${(took / 1000).toFixed(1)} s with the forge ${SLOW} ms a request`);
    check('the answer arrives and the loading state goes', arrived && await page.evaluate(() => document.querySelector('[data-corn="work-loading"]').hidden), `${(took / 1000).toFixed(1)} s`);
    await sleep(800);
    // a refresh keeps the last answer on the map until the new one arrives
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<button id="proof-refresh" type="button" data-action="refresh-forge">refresh</button>'));
    const t1 = Date.now();
    await page.click('#proof-refresh', { force: true });
    await sleep(300);
    const during = await page.evaluate(async () => { const { state } = await import('/explorer/state.js'); return { nodes: state.nodes.length, busy: !document.querySelector('.hx-work-busy').hidden, loading: !document.querySelector('[data-corn="work-loading"]').hidden }; });
    check('a refresh keeps the last answer on the map and says it is updating', during.nodes > 100 && during.busy && !during.loading, JSON.stringify(during));
    await until(page, () => document.querySelector('.hx-work-busy').hidden, null, 120_000);
    console.log(`     the refresh took ${((Date.now() - t1) / 1000).toFixed(1)} s`);
    check('the update ends and the map is whole', (await page.evaluate(async () => (await import('/explorer/state.js')).state.nodes.length)) > 100);
    check('no page error while it waited', errs.length === 0, errs.slice(0, 2).join(' | '));
  } finally {
    slow.stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
