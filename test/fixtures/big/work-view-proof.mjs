/**
 * The proof in a browser of cornfield's Work view and its Work list (spec 0012, steps 2 and 3), against the rig with the fake forge. Runs by hand: needs Playwright and Chromium.
 *
 *   node test/fixtures/big/work-view-proof.mjs [--shots <dir>] [--port <n>] [--slow <ms>]
 *
 * Signs in and opens the Work view by its button, then drives it by mouse and keyboard: every kind of node is there and each is selected (the node panel says what it is),
 * a connection is followed, Waiting on you dims the rest, the layers go off and on (the local drafts' layer is off to start, and on it has a lane), search finds `#21`, `PR 21`,
 * a slug and a title, N, P and the arrows move through the lanes, Enter goes into the panel and Escape back, each address opens the view on its node, and Map brings the map back.
 * Step 3: the List toggle opens the Work list where the side panel sat; each tab's first row selects its node (the node panel shows it, the focus stays on the row); work older than
 * the graph's 14 days (a closed issue, a deploy) is shown in the node panel with nothing selected; every action is driven from the node panel (a proposal's Review, a pull request's Land
 * it with its confirm and Re-run, an issue's Start an agent, a run's answer field with Continue, Stop, a thread's links, a deploy's logs); the old-work addresses; the phone's two sheets
 * (the list and the node panel take turns, the map keeps 35%); axe with the list open and a node selected, in both themes and on a phone.
 * It looks at what is on the screen: the names under the nodes (none off the screen, none over another, none under a control), the lanes' titles (readable, under the toggles),
 * the controls (none over another, on a desktop and on a phone) and that the header has no Work panel button. It then starts a second rig whose fake forge is slow (`--slow`, ms a request;
 * default 1500) and proves the first answer shows its loading state at once, that the page works while it is awaited, and that a refresh keeps the last answer on the map.
 * Screenshots (synthetic fixture only) go in `--shots`: desktop dark and light with all work, with a node selected, with Waiting on you, with the drafts on, and a phone with all work and with a node selected;
 * the finals of step 3, at a device scale factor of 2 (desktop light and dark with the list open and a node selected, a proposal's actions, a run's answer field, the phone's list and node sheets).
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
const FINAL = arg('--final'); // the finals of step 3, at a device scale factor of 2
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

    // the header: the view switch's Work (with its badge) and no Work panel button
    const buttons = await page.evaluate(() => ({
      view: document.querySelector('#preset-work-btn').getAttribute('aria-label') || document.querySelector('#preset-work-btn').textContent,
      panelButton: document.querySelectorAll('[data-corn="forge-button"], .hx-work, #forge-btn').length,
      header: [...document.querySelector('[data-corn="header"]').querySelectorAll('button')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean),
    }));
    check('the header has the view switch\'s Work and no Work panel button', /^Work/.test(buttons.view) && buttons.panelButton === 0 && !buttons.header.includes('Work panel'), JSON.stringify(buttons));

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
    check('the node panel has the place for the actions and no Open in Work', await page.locator('#forge-detail[data-work-kind="proposal"]').count() === 1 && await page.locator('[data-work-action="open-in-work"]').count() === 0);
    names = await namesOnScreen(page);
    check('desktop, a node selected: no name off the screen or over another', names.off.length === 0 && names.over.length === 0, `off ${names.off.join()} over ${names.over.slice(0, 3).join()}`);
    await shot('desktop-dark-selected');
    await page.evaluate(() => document.querySelector('#drawer-close, [data-action="close-drawer"]')?.click()); await sleep(300);

    // a node of code: the work touching it, and Show on the map
    const codeId = await page.evaluate(async () => (await import('/explorer/state.js')).state.nodes.find((n) => !n.work && !n.planned && !n.hidden && n.touches >= 2)?.id);
    await pick(codeId);
    check('a node of code shows the work that touches it', await page.locator('[data-corn="work-links"] [data-action="select-node"]').count() >= 2 && await page.locator('[data-work-action="show-on-map"]').count() === 1, codeId);
    await page.click('[data-work-action="show-on-map"]'); await sleep(900);
    s = await snap();
    check('Show on the map goes to the Map view with that node selected', s.view === 'orbit' && s.selected === codeId, `${s.view} ${s.selected}`);
    await page.click('#preset-work-btn');
    await until(page, async () => { const { state } = await import('/explorer/state.js'); return state.view === 'work' && state.nodes.some((n) => n.work); });
    await sleep(800);

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

    // ---- the Work list (spec 0012 D6): the List toggle, the lists, a row selects its node, work older than the graph's 14 days ----
    await clear();
    const requests = [];
    page.on('request', (r) => requests.push(`${r.method()} ${new URL(r.url()).pathname}`));
    const listBtn = page.locator('.hx-work-bar [data-action="toggle-forge"]');
    check('the List toggle is in the Work view\'s bar, collapsed, and names the panel it opens', (await listBtn.isVisible()) && (await listBtn.getAttribute('aria-expanded')) === 'false' && (await listBtn.getAttribute('aria-controls')) === 'forge-panel');
    await listBtn.click(); await sleep(1500);
    const opened = await page.evaluate(() => { const p = document.querySelector('#forge-panel'); const r = p.getBoundingClientRect(); return { open: p.classList.contains('forge-open'), left: r.left, width: r.width, inert: p.inert, focus: document.activeElement && document.activeElement.id }; });
    check('List opens the list where the side panel sat: on the left, open, not inert, the focus on its title', opened.open && opened.left <= 1 && opened.width > 300 && !opened.inert && opened.focus === 'forge-title', JSON.stringify(opened));
    check('and the toggle says it is expanded', (await listBtn.getAttribute('aria-expanded')) === 'true');
    check('with no side-panel button anywhere in the header', (await page.locator('[data-corn="forge-button"]').count()) === 0);
    const rowsOf = (tab) => page.locator(tab === 'work' ? '#forge-runs-list [data-work-ref]:visible' : '#forge-list [data-work-ref]:visible');
    for (const tab of ['specs', 'pulls', 'issues', 'threads', 'work', 'deploys']) {
      await page.click(`[data-forge-kind="${tab}"]`); await sleep(1500);
      const rows = rowsOf(tab);
      const n = await rows.count();
      const tabInfo = await page.evaluate((t) => ({ pressed: document.querySelector(`[data-forge-kind="${t}"]`).getAttribute('aria-pressed'), status: document.querySelector('#forge-status').textContent }), tab);
      check(`${tab}: the tab is pressed and its list has rows, with a count in the line under the tabs`, tabInfo.pressed === 'true' && n > 0 && /\d/.test(tabInfo.status), `${n} rows; ${tabInfo.status}`);
      const ref = await rows.first().getAttribute('data-work-ref');
      await rows.first().focus();
      await rows.first().click(); await sleep(1400);
      const r = await page.evaluate(async (ref0) => {
        const { state } = await import('/explorer/state.js');
        const { nodeForAddress } = await import('/explorer/work-model.js');
        const at = ref0.indexOf(':');
        const want = nodeForAddress({ kind: ref0.slice(0, at), key: ref0.slice(at + 1) }, state.nodes);
        const act = document.activeElement;
        return { want, selected: state.selectedNode ? state.selectedNode.id : null, badge: document.querySelector('#drawer-badge').textContent, detail: document.querySelector('#forge-detail') ? document.querySelector('#forge-detail').dataset.workKind : null, focusRef: act && act.dataset ? act.dataset.workRef : null, listOpen: document.querySelector('#forge-panel').classList.contains('forge-open'), panelOpen: document.querySelector('#spec-drawer').classList.contains('drawer-open'), pressed: act && act.getAttribute ? act.getAttribute('aria-pressed') : null };
      }, ref);
      check(`${tab}: a row selects its node on the map and the node panel shows it (${ref}${r.want ? '' : ', older than the graph: shown with nothing selected'})`, (r.want ? r.selected === r.want : r.selected === null) && r.panelOpen && !!r.detail, JSON.stringify(r));
      check(`${tab}: the list stays open and the focus stays on the row, pressed`, r.listOpen && r.pressed === 'true' && r.focusRef !== null, JSON.stringify({ focus: r.focusRef, pressed: r.pressed }));
      await clear();
    }
    // by the keyboard, from a row into the node panel and back: Enter on the row shown goes in, Escape comes back to the row, and Escape again closes the list
    {
      await page.click('[data-forge-kind="pulls"]'); await sleep(1200);
      const row = page.locator('#forge-list [data-work-ref]').first();
      const ref = await row.getAttribute('data-work-ref');
      await row.focus(); await page.keyboard.press('Enter'); await sleep(1400);
      await page.keyboard.press('Enter'); await sleep(400);
      check('Enter again on the row shown goes into the node panel', await page.evaluate(() => document.activeElement && document.activeElement.id === 'drawer-title'));
      await page.keyboard.press('Escape'); await sleep(400);
      check('Escape in the node panel closes it and gives the focus back to the row', await page.evaluate((r) => document.activeElement && document.activeElement.dataset.workRef === r && !document.querySelector('#spec-drawer').classList.contains('drawer-open'), ref));
      await page.keyboard.press('Escape'); await sleep(400);
      check('and Escape in the list closes the list, back on the List toggle', await page.evaluate(() => !document.querySelector('#forge-panel').classList.contains('forge-open') && document.activeElement && document.activeElement.dataset.action === 'toggle-forge'));
      await page.click('[data-action="toggle-forge"]'); await sleep(800);
    }
    check('the list does not repeat the detail: it holds no action button', (await page.locator('#forge-panel [data-forge-merge], #forge-panel [data-forge-agent], #forge-panel [data-forge-stop], #forge-panel [data-run-answer], #forge-panel [data-forge-rerun], #forge-panel [data-work-action]').count()) === 0);
    await shot('desktop-dark-list');

    // work older than the graph's 14 days: its row opens it in the node panel, with nothing selected on the map
    await page.click('[data-forge-kind="issues"]'); await sleep(800);
    await page.click('#forge-filter-chip'); await sleep(300);
    await page.selectOption('#forge-state', 'all'); await sleep(1500);
    const oldIssue = page.locator('#forge-list [data-work-ref="issue:2"]');
    check('the Issues list reaches a closed issue the graph does not draw', (await oldIssue.count()) === 1);
    await oldIssue.click(); await sleep(1500);
    const oldState = await page.evaluate(async () => { const { state } = await import('/explorer/state.js'); return { selected: state.selectedNode ? state.selectedNode.id : null, badge: document.querySelector('#drawer-badge').textContent, open: document.querySelector('#spec-drawer').classList.contains('drawer-open'), agent: document.querySelectorAll('#forge-detail [data-forge-agent]').length, text: document.querySelector('#spec-drawer [data-corn="work-head"]').textContent + document.querySelector('#forge-detail').textContent, links: document.querySelector('#spec-drawer').textContent.includes('not drawn here') }; });
    check('an old issue is in the node panel (nothing selected), closed, with nothing to start and its links said not to be drawn', oldState.selected === null && oldState.badge === 'Issue' && oldState.open && oldState.agent === 0 && /Closed/.test(oldState.text) && oldState.links, JSON.stringify(oldState));
    await page.click('[data-forge-kind="deploys"]'); await sleep(1200);
    await page.locator('#forge-list [data-work-ref="deploy:9003"]').click(); await sleep(1500);
    const oldDeploy = await page.evaluate(async () => { const { state } = await import('/explorer/state.js'); return { selected: state.selectedNode ? state.selectedNode.id : null, badge: document.querySelector('#drawer-badge').textContent, logs: [...document.querySelectorAll('#forge-detail a')].map((a) => a.textContent.trim()), rerun: document.querySelectorAll('#forge-detail [data-forge-rerun]').length }; });
    check('an old deploy is in the node panel by the same path, with its logs and no Re-run', oldDeploy.selected === null && oldDeploy.badge === 'Deploy' && oldDeploy.logs.some((t) => /Open the logs on/.test(t)) && oldDeploy.rerun === 0, JSON.stringify(oldDeploy));
    await clear();
    await page.keyboard.press('Escape'); await sleep(200);

    // the node panel's actions, each one driven from it (the list is closed)
    const closeList = async () => { if (await page.evaluate(() => document.querySelector('#forge-panel').classList.contains('forge-open'))) { await page.click('#forge-panel [data-action="close-forge"]'); await sleep(300); } };
    await closeList();
    const detailText = () => page.locator('#forge-detail').innerText();
    // a proposal: Review opens the review over the map
    await pick('proposal:0013-meals');
    check('a proposal waiting on you says so and offers Review (and Start an agent when runs can start)', (await page.locator('#forge-detail [data-work-action="review"]').count()) === 1 && /waits on you/.test(await page.locator('[data-corn="work-actions"]').innerText()), (await detailText()).replace(/\s+/g, ' ').slice(0, 120));
    await page.click('#forge-detail [data-work-action="review"]'); await sleep(2500);
    const review = await page.evaluate(async () => { const { state } = await import('/explorer/state.js'); return { view: state.view, slug: state.proposalSlug, bar: !document.querySelector('#proposal-bar').hidden }; });
    check('Review goes back to the map and opens the review over it (Before, Diff, After in its bar)', review.view === 'orbit' && review.slug === '0013-meals' && review.bar, JSON.stringify(review));
    await page.click('#preset-work-btn');
    await until(page, async () => { const { state } = await import('/explorer/state.js'); return state.view === 'work' && state.nodes.some((n) => n.work); });
    await sleep(900);
    // a pull request that cannot land yet: Land it is off, with its reason; Re-run on a failed check posts
    await pick('pull:13');
    const prInfo = await page.evaluate(() => ({ land: document.querySelector('#forge-detail .hx-btn--approve') ? document.querySelector('#forge-detail .hx-btn--approve').disabled : null, why: document.querySelector('#forge-detail .hx-forge-why') ? document.querySelector('#forge-detail .hx-forge-why').textContent : '', rerun: document.querySelectorAll('#forge-detail [data-forge-rerun]').length, checks: document.querySelector('#forge-detail .hx-forge-sub') ? document.querySelector('#forge-detail .hx-forge-sub').textContent : '' }));
    check('a pull request shows its checks and Land it, off with the reason in words, and Re-run on a failed check', prInfo.land === true && /Can't land yet/.test(prInfo.why) && prInfo.rerun >= 1 && /failed/.test(prInfo.checks), JSON.stringify(prInfo));
    const rerunFrom = requests.length;
    await page.click('#forge-detail [data-forge-rerun]'); await sleep(1500);
    check('Re-run posts to the server for that head and check, and says what it came to', requests.slice(rerunFrom).some((x) => /^POST \/api\/forge\/pulls\/13\/rerun$/.test(x)) && (await detailText()).length > 0 && (await page.locator('#forge-detail .hx-forge-notice').count()) > 0, requests.slice(rerunFrom).join(' | '));
    // a spec pull request that is green: Land it opens its confirm with the focus on Cancel; Cancel gives the focus back
    await fetch(`http://127.0.0.1:${PORT + 1}/__rig/checks?pr=21&state=passed`);
    await pick('proposal:0100-new-flow-across-apps'); await sleep(1500);
    const land = page.locator('#forge-detail [data-forge-merge]');
    check('a spec pull request with green checks has Land it in the node panel, beside Review', (await land.count()) === 1 && (await page.locator('#forge-detail [data-work-action="review"]').count()) === 1);
    await land.focus(); await land.click(); await sleep(900);
    const confirm = await page.evaluate(() => ({ shown: !document.querySelector('#forge-confirm').hidden, focus: document.activeElement && document.activeElement.dataset.action, title: document.querySelector('#forge-confirm-title').textContent, role: document.querySelector('#forge-confirm [role="dialog"]').getAttribute('aria-modal') }));
    check('Land it opens the confirm step: a modal dialog, the focus on Cancel, naming what lands', confirm.shown && confirm.focus === 'forge-confirm-cancel' && confirm.role === 'true' && /Land/.test(confirm.title), JSON.stringify(confirm));
    await page.keyboard.press('Escape'); await sleep(500);
    check('Escape closes it, nothing was sent, and the focus is back on Land it', await page.evaluate(() => document.querySelector('#forge-confirm').hidden && document.activeElement && document.activeElement.hasAttribute('data-forge-merge')) && !requests.some((x) => /\/merge$/.test(x)));
    // an issue: Start an agent opens its dialog; Escape closes it, the focus back on the button
    await pick('issue:5');
    const agent = page.locator('#forge-detail [data-forge-agent="issue:5"]');
    check('an open issue has Start an agent in its node panel', (await agent.count()) === 1);
    await agent.focus(); await agent.click(); await sleep(900);
    check('Start an agent opens its dialog with the focus in it, and Escape closes it, giving the focus back', await page.evaluate(() => !document.querySelector('#agent-start').hidden && document.activeElement && document.activeElement.id === 'agent-kind'));
    await page.keyboard.press('Escape'); await sleep(500);
    check('and the focus is on the button again', await page.evaluate(() => document.querySelector('#agent-start').hidden && document.activeElement && document.activeElement.dataset.forgeAgent === 'issue:5'));
    // a run that waits on you: its answer field, then Continue, Stop or a reply
    await pick('run:run-01RIGRUN000000000000000003');
    const answerCard = await page.evaluate(() => ({ answers: [...document.querySelectorAll('#forge-detail [data-run-answer]')].map((b) => b.dataset.runAnswer), field: !!document.querySelector('#forge-detail [data-run-reply]'), label: document.querySelector('#forge-detail [data-run-reply]') ? document.querySelector('#forge-detail [data-run-reply]').closest('label').textContent : '', stop: document.querySelectorAll('#forge-detail [data-forge-stop]').length }));
    check('a waiting run shows its answer field, with Continue, Stop and Reply (and no plain Stop)', answerCard.field && answerCard.answers.join() === 'continue,stop,reply' && answerCard.stop === 0, JSON.stringify(answerCard));
    await shot('desktop-dark-run-answer');
    await page.fill('#forge-detail [data-run-reply]', 'Use the second plan.');
    const typed = await page.inputValue('#forge-detail [data-run-reply]');
    const sent0 = requests.length;
    await page.click('#forge-detail [data-run-answer="reply"]'); await sleep(1800);
    const replyPosts = requests.slice(sent0).filter((x) => /POST .*\/answer$/.test(x)).length;
    const emptied = await page.evaluate(() => { const f = document.querySelector('#forge-detail [data-run-reply]'); return f ? f.value === '' : true; });
    check('Reply posts the typed answer once, says what it came to in the run\'s card, and the field is empty again', replyPosts === 1 && typed === 'Use the second plan.' && emptied && (await page.locator('#forge-detail [data-run-result]').count()) > 0, requests.slice(sent0).join(' | '));
    // a working run: Stop
    await pick('run:run-01RIGRUN000000000000000002');
    const stop = page.locator('#forge-detail [data-forge-stop]');
    check('a working run has Stop (and the timeline), in its card', (await stop.count()) === 1 && (await page.locator('#forge-detail [data-run-timeline]').count()) === 1);
    const sent1 = requests.length;
    await stop.click(); await sleep(1500);
    check('Stop posts once and the card says so', requests.slice(sent1).filter((x) => /POST .*\/stop$/.test(x)).length === 1 && (await page.locator('#forge-detail [data-run-result]').count()) > 0, requests.slice(sent1).join(' | '));
    // a thread: read-only, its links to the forge
    await pick('thread:21');
    const threadLinks = await page.evaluate(() => ({ reply: [...document.querySelectorAll('#forge-detail a')].filter((a) => /^Reply on /.test(a.textContent)).map((a) => a.getAttribute('href')), open: [...document.querySelectorAll('[data-corn="work-actions"] > a')].map((a) => a.textContent.trim()), form: document.querySelectorAll('#forge-detail input, #forge-detail textarea, #forge-detail form').length }));
    check('a thread is read-only here, with Reply on the forge and Open on the forge, both http(s) links', threadLinks.reply.length === 1 && /^https?:\/\//.test(threadLinks.reply[0]) && threadLinks.open.some((t) => /Open on the forge/.test(t)) && threadLinks.form === 0, JSON.stringify(threadLinks));
    // a deploy: its logs, what it restarted, no Re-run
    await pick('deploy:9001');
    const deployInfo = await page.evaluate(() => ({ logs: [...document.querySelectorAll('#forge-detail a')].map((a) => [a.textContent.trim(), a.getAttribute('href')]), rerun: document.querySelectorAll('#forge-detail [data-forge-rerun]').length }));
    check('a deploy has its logs on the forge as an http(s) link, and no Re-run', deployInfo.logs.some(([t, h]) => /Open the logs on/.test(t) && /^https?:\/\//.test(h)) && deployInfo.rerun === 0, JSON.stringify(deployInfo));
    check('Copy Spec is not shown for a piece of work, and is for a node of code', await page.evaluate(async () => { const hidden = document.querySelector('#drawer-copy-btn').hidden; const { state } = await import('/explorer/state.js'); const { pick: p } = await import('/explorer/work-view.js'); p(state.nodes.find((n) => !n.work && !n.planned && !n.hidden).id); await new Promise((r) => setTimeout(r, 500)); return hidden && !document.querySelector('#drawer-copy-btn').hidden; }));
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

    // work older than the graph's 14 days: its address opens the Work list on its tab, and the node panel shows it
    await page.goto(`${BASE}/?issue=2`);
    await until(page, async () => (await import('/explorer/state.js')).state.nodes.some((n) => n.work));
    await until(page, () => document.querySelector('#spec-drawer').classList.contains('drawer-open') && !!document.querySelector('#forge-detail'));
    await sleep(800);
    const oldAddr = await page.evaluate(async () => { const { state } = await import('/explorer/state.js'); return { view: state.view, selected: state.selectedNode ? state.selectedNode.id : null, listOpen: document.querySelector('#forge-panel').classList.contains('forge-open'), tab: document.querySelector('[data-forge-kind="issues"]').getAttribute('aria-pressed'), badge: document.querySelector('#drawer-badge').textContent, title: document.querySelector('#drawer-title').textContent, search: location.search, said: (document.querySelector('#map-announcer') || {}).textContent }; });
    check('?issue=<old> opens the Work view, the list on Issues, and the issue in the node panel with nothing selected; the address is spent', oldAddr.view === 'work' && oldAddr.selected === null && oldAddr.listOpen && oldAddr.tab === 'true' && oldAddr.badge === 'Issue' && oldAddr.search === '', JSON.stringify(oldAddr));
    check('and the live region says the issue it shows, not the count of the list', /^Issue 2: .+\. It is closed\.$/.test(oldAddr.said || ''), oldAddr.said);
    await page.goto(`${BASE}/?pr=999`);
    await until(page, async () => (await import('/explorer/state.js')).state.nodes.some((n) => n.work));
    await sleep(2500);
    const noPr = await page.evaluate(() => ({ note: document.querySelector('#forge-act-note').textContent, hidden: document.querySelector('#forge-act-note').hidden, tab: document.querySelector('[data-forge-kind="pulls"]').getAttribute('aria-pressed'), said: (document.querySelector('#map-announcer') || {}).textContent }));
    check('?pr=999 (no such pull request) is a line in the list, said through the live region, never a blank', !noPr.hidden && /pull request 999/.test(noPr.note) && noPr.tab === 'true' && /pull request 999/.test(noPr.said || ''), JSON.stringify(noPr));

    // axe, on the view with the list open and a node's panel open
    const axeSource = fs.readFileSync(path.join(HERE, '..', '..', '..', 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
    await page.route('**/__axe.js', (route) => route.fulfill({ body: axeSource, contentType: 'application/javascript' })); // a script of the page's own origin: its CSP does not allow an inline one
    const runAxe = async (pg) => { await pg.route('**/__axe.js', (route) => route.fulfill({ body: axeSource, contentType: 'application/javascript' })); await pg.addScriptTag({ url: `${BASE}/__axe.js` }); return pg.evaluate(async () => { const r = await window.axe.run(document, { resultTypes: ['violations'] }); return r.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0].target.join(' ')}`); }); };
    await page.goto(`${BASE}/?issue=3`);
    await until(page, async () => (await import('/explorer/state.js')).state.selectedNode?.work === 'issue');
    await sleep(800);
    await page.click('.hx-work-bar [data-action="toggle-forge"]'); await sleep(1500);
    const axe = await runAxe(page);
    check('axe: no violation in the Work view with the list open and a node selected (dark)', axe.length === 0, axe.join(' | '));
    await page.fill('#forge-text', '').catch(() => {});
    await pick('pull:13'); await sleep(1500);
    const axePr = await runAxe(page);
    check('axe: none with a pull request\'s checks and Land it in the node panel (dark)', axePr.length === 0, axePr.join(' | '));

    // light
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`${BASE}/?view=work`);
    await until(page, async () => (await import('/explorer/state.js')).state.nodes.some((n) => n.work));
    await sleep(1500);
    names = await namesOnScreen(page);
    check('light: no name off the screen or over another', names.off.length === 0 && names.over.length === 0 && names.under.length === 0, `${names.count} names`);
    await shot('desktop-light-work');
    await page.click('.hx-work-bar [data-action="toggle-forge"]'); await sleep(1500);
    await pick('run:run-01RIGRUN000000000000000003'); await sleep(1500);
    const axeLight = await runAxe(page);
    check('axe: none with the list open and a waiting run\'s answer field in the node panel (light)', axeLight.length === 0, axeLight.join(' | '));
    await clear();
    await page.click('#forge-panel [data-action="close-forge"]'); await sleep(300);

    // a phone
    const phoneContext = await newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', hasTouch: true, isMobile: true });
    const pp = await phoneContext.newPage();
    listen(pp);
    await pp.goto(`${BASE}/?view=work`);
    await until(pp, async () => (await import('/explorer/state.js')).state.nodes.some((n) => n.work), null, 60_000);
    await sleep(2000);
    check('the phone shows the view', (await pp.evaluate(async () => (await import('/explorer/state.js')).state.view)) === 'work');
    const header = await pp.evaluate(() => ({ panelButton: document.querySelectorAll('[data-corn="forge-button"], .hx-work').length, badge: document.querySelector('#preset-work-btn [data-corn="waiting-badge"]') && getComputedStyle(document.querySelector('#preset-work-btn [data-corn="waiting-badge"]')).display !== 'none' }));
    check('on a phone the header has no Work panel button and the view switch carries the badge', header.panelButton === 0 && header.badge, JSON.stringify(header));
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

    // the phone's sheets (spec 0010 D7): the List toggle is on the map, the list and the node panel take turns, at most two are open, the map keeps 35%
    await pp.evaluate(async () => { const m = await import('/explorer/engine/selection.js'); const { pageInstance } = await import('/explorer/state.js'); m.clearSelection(pageInstance()); });
    await sleep(500);
    const sheetsNow = () => pp.evaluate(async () => {
      const { state } = await import('/explorer/state.js');
      const open = [...document.querySelectorAll('.hx-sheet')].filter((e) => (e.classList.contains('hx-forge') ? e.classList.contains('forge-open') : e.classList.contains('hx-drawer') ? e.classList.contains('drawer-open') : !e.hidden) && !e.hasAttribute('data-sheet-away')).map((e) => `${e.id}:${e.dataset.sheetState}`);
      return { open, map: (state.height - (state.coveredBottom || 0)) / state.height, selected: state.selectedNode ? state.selectedNode.id : null };
    });
    const pList = pp.locator('.hx-work-bar [data-action="toggle-forge"]');
    check('on a phone the List toggle is on the map, in the bar, and a tap target', (await pList.isVisible()) && ((await pList.boundingBox()).height >= 28));
    await pList.tap(); await sleep(1500);
    let sh = await sheetsNow();
    check('on a phone the list opens as a peek sheet, and the map keeps more than 35%', sh.open.join() === 'forge-panel:peek' && sh.map >= 0.35, JSON.stringify(sh));
    await pp.locator('#forge-panel > .hx-sheet-handle').tap(); await sleep(900);
    sh = await sheetsNow();
    check('expanded, it is one sheet and the map keeps at least 35% of the screen', sh.open.join() === 'forge-panel:expanded' && sh.map >= 0.35, JSON.stringify(sh));
    await shot('phone-dark-list', pp);
    await pp.locator('#forge-list [data-work-ref]:visible').first().tap(); await sleep(1500);
    sh = await sheetsNow();
    check('a row selects its node: the node\'s sheet takes the list\'s place (they take turns), the node is selected, and the map keeps 35%', sh.open.length <= 2 && sh.open.some((x) => x.startsWith('spec-drawer')) && !sh.open.some((x) => x.startsWith('forge-panel')) && sh.selected !== null && sh.map >= 0.35, JSON.stringify(sh));
    await shot('phone-dark-node-sheet', pp);
    await pList.tap(); await sleep(1500);
    sh = await sheetsNow();
    check('the List toggle brings the list back, the node stays selected, and never more than two sheets are open', sh.open.length <= 2 && sh.open.some((x) => x.startsWith('forge-panel')) && sh.selected !== null && sh.map >= 0.35, JSON.stringify(sh));
    check('on a phone, with the list open, no control is over another', (await controlsOverlap(pp)).length === 0, (await controlsOverlap(pp)).join(' | '));
    const axePhone = await runAxe(pp);
    check('axe: none on a phone with the list open and a node selected', axePhone.length === 0, axePhone.join(' | '));
    await phoneContext.close();

    check('no page error', errors.length === 0, errors.slice(0, 2).join(' | '));
    await finalShots(browser);
    await loadingProof(browser);
  } finally {
    await browser.close();
    rig.stop();
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

/** The finals of step 3, at a device scale factor of 2, from the rig's synthetic fixture only */
async function finalShots(browser) {
  if (!FINAL) return;
  fs.mkdirSync(FINAL, { recursive: true });
  const open = async (opts, search = '?view=work') => {
    const context = await browser.newContext({ reducedMotion: 'reduce', deviceScaleFactor: 2, ...opts });
    const sign = await context.newPage();
    await sign.goto(`${BASE}/auth/start`); await sign.waitForURL(`${BASE}/**`); await sign.close();
    const pg = await context.newPage();
    await pg.goto(`${BASE}/${search}`);
    await until(pg, async () => { const { state } = await import('/explorer/state.js'); return state.view === 'work' && state.nodes.some((n) => n.work); }, null, 60_000);
    await sleep(1500);
    return { context, pg };
  };
  const pickOn = async (pg, id) => { await pg.evaluate(async (i) => { const { pick: p } = await import('/explorer/work-view.js'); p(i); }, id); await sleep(1500); };
  const listOn = async (pg) => { await pg.click('.hx-work-bar [data-action="toggle-forge"]'); await sleep(1500); };
  for (const scheme of ['dark', 'light']) {
    const { context, pg } = await open({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await listOn(pg);
    await pickOn(pg, 'pull:13');
    await pg.screenshot({ path: path.join(FINAL, `desktop-${scheme}-list-and-node.png`) });
    if (scheme === 'dark') {
      await pickOn(pg, 'proposal:0013-meals');
      await pg.screenshot({ path: path.join(FINAL, 'desktop-dark-proposal-actions.png') });
      await pickOn(pg, 'run:run-01RIGRUN000000000000000003');
      await pg.fill('#forge-detail [data-run-reply]', 'Use the second plan.');
      await pg.screenshot({ path: path.join(FINAL, 'desktop-dark-run-answer.png') });
    } else {
      await pickOn(pg, 'proposal:0013-meals');
      await pg.screenshot({ path: path.join(FINAL, 'desktop-light-proposal-actions.png') });
      await pickOn(pg, 'run:run-01RIGRUN000000000000000003');
      await pg.screenshot({ path: path.join(FINAL, 'desktop-light-run-answer.png') });
    }
    await context.close();
  }
  for (const scheme of ['dark', 'light']) {
    const { context, pg } = await open({ viewport: { width: 390, height: 844 }, colorScheme: scheme, hasTouch: true, isMobile: true });
    await pg.locator('.hx-work-bar [data-action="toggle-forge"]').tap(); await sleep(1500);
    await pg.locator('#forge-panel > .hx-sheet-handle').tap(); await sleep(900);
    await pg.screenshot({ path: path.join(FINAL, `phone-${scheme}-list-sheet.png`) });
    await pg.locator('#forge-list [data-work-ref]:visible').nth(1).tap(); await sleep(1500);
    await pg.locator('#spec-drawer > .hx-sheet-handle').tap(); await sleep(900);
    await pg.screenshot({ path: path.join(FINAL, `phone-${scheme}-node-sheet.png`) });
    await context.close();
  }
  console.log(`     finals saved in ${FINAL}`);
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
    let answeredAt = 0;
    page.on('response', (r) => { if (r.url().includes('/api/forge/work-graph') && !answeredAt) answeredAt = Date.now(); });
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
    const took = (answeredAt || Date.now()) - t0;
    console.log(`     the server's first answer came ${(took / 1000).toFixed(1)} s after the click, with the forge ${SLOW} ms a request`);
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
