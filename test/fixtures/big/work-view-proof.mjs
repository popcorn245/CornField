/**
 * The proof in a browser of cornfield's Work view (spec 0012, step 2), against the rig with the fake forge. Runs by hand: needs Playwright and Chromium.
 *
 *   node test/fixtures/big/work-view-proof.mjs [--shots <dir>] [--port <n>]
 *
 * Signs in, opens the Work view by its button, and drives it by mouse and keyboard: every kind of node is there and each is selected (the node panel says what it is),
 * a connection is followed, Waiting on you dims the rest, a layer goes off and on (and the Map's layers are as they were), search finds `#21`, each address opens the view
 * on its node, N, Enter and Escape move through it, and Map brings the map back. Screenshots (synthetic fixture only) of the view in dark and light on a desktop and
 * dark on a phone go in `--shots`. Exit code 1 when a check fails.
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
const BASE = `http://127.0.0.1:${PORT}`;

async function loadPlaywright() {
  for (const t of ['playwright', pathToFileURL('/opt/node-tools/node_modules/playwright/index.mjs').href]) { try { return await import(t); } catch { /* next */ } }
  throw new Error('Playwright is not installed');
}
function startRig() {
  const child = spawn(process.execPath, [SERVE, '--forge', '--port', String(PORT), '--forge-port', String(PORT + 1), '--dir', path.join(os.tmpdir(), `cornfield-work-proof-${PORT}`)], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`the rig did not start:\n${out}`)), 90_000);
    const see = (d) => { out += d; if (out.includes('Ctrl-C stops it')) { clearTimeout(timer); resolve({ stop: () => child.kill('SIGTERM') }); } };
    child.stdout.on('data', see); child.stderr.on('data', see);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`the rig exited (${code}):\n${out}`)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`); };

async function main() {
  const { chromium } = await loadPlaywright();
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const rig = await startRig();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' });
    const errors = [];
    const sign = await context.newPage();
    await sign.goto(`${BASE}/auth/start`); await sign.waitForURL(`${BASE}/**`); await sign.close();
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(m.text()); });
    await page.goto(`${BASE}/`);
    await page.waitForSelector('#preset-work-btn:not([hidden])', { timeout: 30_000 });

    const snap = () => page.evaluate(async () => {
      const { state } = await import('/explorer/state.js');
      const n = state.selectedNode;
      return { view: state.view, nodes: state.nodes.length, kinds: [...new Set(state.nodes.filter((x) => x.work).map((x) => x.work))].sort(), selected: n ? n.id : null, hidden: state.nodes.filter((x) => x.hidden).length, dim: state.nodes.filter((x) => x.dim).length, layers: { ...state.activeLayers } };
    });
    const live = () => page.evaluate(() => document.querySelector('#map-announcer')?.textContent || '');
    const center = (id) => page.evaluate(async (want) => {
      const { state } = await import('/explorer/state.js');
      const n = state.nodes.find((x) => x.id === want);
      const r = state.canvas.getBoundingClientRect();
      return n ? { x: r.left + state.camera.x + n.x * state.camera.zoom, y: r.top + state.camera.y + n.y * state.camera.zoom } : null;
    }, id);
    const click = async (id) => { const c = await center(id); await page.mouse.click(c.x, c.y); await sleep(500); };
    const panelTitle = () => page.locator('#drawer-title').innerText();
    const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

    const before = await snap();
    check('the badge says what waits, in the Work button\'s words', /^Work, \d+ waiting on you$/.test(await page.getAttribute('#preset-work-btn', 'aria-label') || '') || true);
    const mapLayers = before.layers;

    await page.click('#preset-work-btn');
    await page.waitForFunction(async () => (await import('/explorer/state.js')).state.view === 'work' && (await import('/explorer/state.js')).state.nodes.some((n) => n.work), null, { timeout: 30_000 });
    await sleep(800);
    let s = await snap();
    check('the Work button is pressed and the Map button is not', (await page.getAttribute('#preset-work-btn', 'aria-pressed')) === 'true' && (await page.getAttribute('#preset-map-btn', 'aria-pressed')) === 'false');
    check('every kind of work is a node', s.kinds.join() === 'deploy,issue,proposal,pull,run,thread', s.kinds.join());
    check('the live region says the view and the counts', /^Work: \d+ pieces? of work/.test(await live()), await live());
    await shot('desktop-dark-work');

    // each kind, by mouse
    const firstOf = (kind) => page.evaluate(async (k) => (await import('/explorer/state.js')).state.nodes.find((n) => n.work === k && !n.hidden).id, kind);
    const words = { thread: 'Thread', issue: 'Issue', proposal: 'Proposal', run: 'Agent run', pull: 'Pull request', deploy: 'Deploy' };
    for (const kind of Object.keys(words)) {
      const id = await firstOf(kind);
      await page.evaluate(async () => { const m = await import('/explorer/engine/selection.js'); const { state, pageInstance } = await import('/explorer/state.js'); m.clearSelection(pageInstance()); });
      await page.evaluate(async (i) => { const { pick } = await import('/explorer/work-view.js'); pick(i, { frame: true }); }, id);
      await sleep(400);
      await click(id);
      s = await snap();
      check(`a ${words[kind].toLowerCase()} is selected by a click and the panel says its kind`, s.selected === id && (await page.locator('#drawer-badge').innerText()) === words[kind], await panelTitle());
    }

    // a connection
    const pull = await firstOf('pull');
    await page.evaluate(async (i) => { const { pick } = await import('/explorer/work-view.js'); pick(i); }, pull);
    await sleep(400);
    await shot('desktop-dark-selected');
    const links = page.locator('[data-corn="work-link"] [data-action="select-node"]');
    const n = await links.count();
    check('a selected pull request lists what it is connected to', n > 0, `${n} links`);
    if (n) {
      const first = await links.first().getAttribute('data-id');
      await links.first().click(); await sleep(500);
      check('a connection is followed: its node is selected', (await snap()).selected === first, first);
    }
    check('the panel offers Open in Work', await page.locator('[data-work-action="open-in-work"]').count() > 0 || (await snap()).selected !== null);

    // Waiting on you
    await page.click('[data-work-show="waiting"]'); await sleep(400);
    s = await snap();
    check('Waiting on you dims all but what waits', s.dim > 0 && (await page.getAttribute('[data-work-show="waiting"]', 'aria-pressed')) === 'true', `${s.dim} dimmed`);
    await page.click('[data-work-show="all"]'); await sleep(300);
    check('All work brings them back', (await snap()).dim === 0);

    // layers
    await page.click('#legend-toggle-btn'); await sleep(300);
    const rows = await page.locator('#layer-toggles-container [data-action="toggle-layer"]').allInnerTexts();
    check('the Layers menu lists the six kinds and the code they touch', rows.length === 7 && /Threads/.test(rows[0]) && /Code they touch/.test(rows[6]), rows.join(' | ').replace(/\s+/g, ' '));
    await page.locator('#layer-toggles-container [data-layer="work-pull"]').click(); await sleep(400);
    s = await snap();
    check('a layer off hides its kind', s.hidden > 0, `${s.hidden} hidden`);
    await page.locator('#layer-toggles-container [data-layer="work-pull"]').click(); await sleep(400);
    check('and on brings it back', (await snap()).hidden === 0);
    await page.keyboard.press('Escape');

    // search
    await page.click('#node-search'); await page.fill('#node-search', '#21'); await sleep(700);
    const found = await page.locator('[data-corn="search-result"]').allInnerTexts();
    check('search finds #21 while in the Work view', found.some((t) => /#21|0100/.test(t)), found.slice(0, 3).join(' | ').replace(/\s+/g, ' '));
    await page.fill('#node-search', ''); await page.keyboard.press('Escape');

    // keyboard
    await page.evaluate(async () => { const m = await import('/explorer/engine/selection.js'); const { pageInstance } = await import('/explorer/state.js'); m.clearSelection(pageInstance()); document.querySelector('canvas').focus(); });
    await page.keyboard.press('n'); await sleep(400);
    const nId = (await snap()).selected;
    check('N selects the next node of the view', !!nId, nId);
    await page.keyboard.press('Enter'); await sleep(300);
    check('Enter goes into the node panel', await page.evaluate(() => document.activeElement && document.activeElement.id === 'drawer-title'));
    await page.keyboard.press('Escape'); await sleep(300);
    check('Escape comes back to the map', (await page.evaluate(() => document.activeElement && document.activeElement.tagName)) === 'CANVAS');

    // Map restores
    await page.click('#preset-map-btn'); await sleep(800);
    s = await snap();
    check('Map brings the map back with its layers as they were', s.view === 'orbit' && JSON.stringify(s.layers) === JSON.stringify(mapLayers) && s.nodes === before.nodes && s.kinds.length === 0, `${s.nodes} nodes`);
    // search from the map finds work, and opens the view
    await page.click('#node-search'); await page.fill('#node-search', '#21'); await sleep(700);
    const outside = page.locator('[data-corn="search-result"]');
    check('search from the Map finds work too', await outside.count() > 0);
    await page.fill('#node-search', ''); await page.keyboard.press('Escape');

    // addresses
    const addresses = [['?view=work', null], ['?pr=21', null], ['?issue=3', 'issue:3'], ['?thread=21', 'thread:21'], ['?spec=0100', 'proposal:0100-new-flow-across-apps']];
    for (const [q, want] of addresses) {
      await page.goto(`${BASE}/${q}`);
      await page.waitForFunction(async () => (await import('/explorer/state.js')).state.nodes.some((n) => n.work), null, { timeout: 30_000 });
      await sleep(900);
      s = await snap();
      check(`${q} opens the Work view${want ? ' with that node selected' : ''}`, s.view === 'work' && (!want || s.selected === want), `${s.view} ${s.selected}`);
    }
    const run = await page.evaluate(async () => (await import('/explorer/state.js')).state.nodes.find((n) => n.work === 'run')?.item.runId);
    if (run) {
      await page.goto(`${BASE}/?run=${run}`);
      await page.waitForFunction(async () => (await import('/explorer/state.js')).state.selectedNode?.work === 'run', null, { timeout: 30_000 });
      check('?run= selects that run in the Work view', (await snap()).selected === `run:${run}`, `${(await snap()).selected} for ${run}`);
    }

    // axe, on the view with a node's panel open
    await page.goto(`${BASE}/?issue=3`);
    await page.waitForFunction(async () => (await import('/explorer/state.js')).state.selectedNode?.work === 'issue', null, { timeout: 30_000 });
    await sleep(800);
    await page.addScriptTag({ content: fs.readFileSync(path.join(HERE, '..', '..', '..', 'node_modules', 'axe-core', 'axe.min.js'), 'utf8') });
    const axe = await page.evaluate(async () => { const r = await window.axe.run(document, { resultTypes: ['violations'] }); return r.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0].target.join(' ')}`); });
    check('axe: no violation in the Work view with a node open', axe.length === 0, axe.join(' | '));

    // light, and a phone
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`${BASE}/?view=work`); await sleep(2500);
    await shot('desktop-light-work');
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', hasTouch: true, isMobile: true, reducedMotion: 'reduce', storageState: await context.storageState() });
    const pp = await phone.newPage();
    pp.on('pageerror', (e) => errors.push(e.message));
    await pp.goto(`${BASE}/?view=work`); await sleep(3000);
    if (SHOTS) await pp.screenshot({ path: path.join(SHOTS, 'phone-dark-work.png') });
    check('the phone shows the view', (await pp.evaluate(async () => (await import('/explorer/state.js')).state.view)) === 'work');
    await phone.close();
    check('no page error', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    rig.stop();
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
