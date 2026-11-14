/**
 * The proof in a browser of the Work layer on the Map view (spec 0012, step 4: D4) and of the Work list's tab strip, against the rig with the fake forge. Runs by hand: needs Playwright and Chromium.
 *
 *   node test/fixtures/big/work-layer-proof.mjs [--shots <dir>] [--final <dir>] [--port <n>]
 *
 * Synthetic fixture only: the rig's own map and fake forge, and a work graph the proof adds links to (the rig's pull request, issues, runs, deploy and threads touch no node of the
 * map): the page asks the server's real `GET /api/forge/work-graph`, and the proof's route answers with that answer plus a PR, an issue, a run, a deploy and a thread each touching nodes
 * of the map's own, near each other, so that every kind of badge is on screen at once. What is expected is worked out here from the answer, not from the page.
 *
 *  - off by default: the Layers menu has the Work row (under Overlays), off, saying it is not read yet; no badge, no layer of badges in the page, no request for the graph; the map's
 *    layer count is the one it had; the runs' pulse layer is not touched
 *  - on, by the keyboard (the row is a button, in the tab order, pressed): the graph is asked for once and the count says how many nodes open work touches; a PR, Issue, Run, Spec, Deploy
 *    and Thread badge are on the nodes they belong to, a node touched by several shows the most pressing (waiting on you first) then +N; closed work, a local draft and a planned node get none
 *  - badges are in screen space (the same size at every zoom, centred on their node), none over another, none over a name, none off the screen; fewer at a distance than near; where two
 *    would pile up the one that waits on you stays; the selected node has its badge
 *  - the Work view and the layer share one read: opening the Work view first and then the layer asks for nothing more; the layer first and then the view does not start a second read while
 *    the first is on its way (a slow forge: the row says "reading…", the view shows its loading state); one poll
 *  - the Layers row is remembered (a reload with it on reads the graph and draws); off again, the badges go and nothing is asked
 *  - selecting a badged node: the node panel lists its open work as links that open the Work view with that piece selected; every forge word is escaped (a title with markup, a javascript: address)
 *  - the keyboard says it: landing on a badged node adds "4 open: Spec 0100 (waiting on you), PR #13 ..." to what is said
 *  - with no forge in the config, or nobody signed in (the Work piece is off: the page asks `work:on`), the row is absent and nothing is asked, even with the layer remembered on
 *  - axe: the Map view with the layer on, the menu open, and a badged node selected (dark, light, phone); a phone
 *  - the Work list's tab strip (spec 0012 step 3's lead): Deploys is reachable at 400 px by a vertical wheel, on a phone by a finger's swipe, and the tab that is on is scrolled into the strip
 * Screenshots (synthetic fixture only) go in `--shots`; the finals of step 4 at a device scale factor of 2 go in `--final`.
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
const FINAL = arg('--final');
const PORT = Number(arg('--port') || 3860);
const BASE = `http://127.0.0.1:${PORT}`;
const GRAPH = '/api/forge/work-graph';

async function loadPlaywright() {
  for (const t of ['playwright', pathToFileURL('/opt/node-tools/node_modules/playwright/index.mjs').href]) { try { return await import(t); } catch { /* next */ } }
  throw new Error('Playwright is not installed');
}
function startRig(port, extra = [], { forge = true } = {}) {
  const child = spawn(process.execPath, [SERVE, ...(forge ? ['--forge', '--forge-port', String(port + 1)] : []), '--port', String(port), '--dir', path.join(os.tmpdir(), `cornfield-wlayer-proof-${port}`), ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
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
async function until(page, fn, arg0, timeout = 30_000) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn, arg0)) return true;
    if (Date.now() - t0 > timeout) return false;
    await sleep(150);
  }
}

// ---------------------------------------------------------------------------
//  What the proof expects, worked out from the answer (never from the page)
// ---------------------------------------------------------------------------
const CODE_RELS = new Set(['changes', 'adds', 'mentions', 'restarts']);
const numberOf = (slug) => { const m = /^(\d{2,6})(?:-|$)/.exec(slug); return m ? m[1] : slug; };
const tagOf = (n) => ({ pull: `PR #${n.number}`, issue: `Issue #${n.number}`, thread: `Thread #${n.number}`, proposal: `Spec ${numberOf(n.slug)}`, run: `Run ${String(n.runId).slice(-6)}`, deploy: 'Deploy' })[n.kind];
/** node id -> the badge text it should have: open work only, never a local draft, never a node the map does not hold; waiting on you first, then the newest, then the id */
function expected(graph, mapIds) {
  const work = new Map(graph.nodes.filter((n) => n.kind !== 'code').map((n) => [n.id, n]));
  const by = new Map();
  for (const e of graph.edges) {
    const from = work.get(e.from);
    if (!from || !CODE_RELS.has(e.rel) || !mapIds.has(e.to) || from.open !== true || (from.kind === 'proposal' && from.state === 'local')) continue;
    if (!by.has(e.to)) by.set(e.to, new Map());
    by.get(e.to).set(from.id, from);
  }
  const out = new Map();
  for (const [id, items] of by) {
    const list = [...items.values()].sort((a, b) => (a.waiting === b.waiting ? 0 : a.waiting ? -1 : 1) || (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0) || (a.id < b.id ? -1 : 1));
    out.set(id, { text: `${tagOf(list[0])}${list.length > 1 ? ` +${list.length - 1}` : ''}`, items: list, waiting: list[0].waiting === true });
  }
  return out;
}

// ---------------------------------------------------------------------------
//  What is on the screen
// ---------------------------------------------------------------------------
const pillsOnScreen = (page) => page.evaluate(async () => {
  const { state } = await import('/explorer/state.js');
  const { getScene } = await import('/explorer/render.js');
  const { placeLabels } = await import('/explorer/labels.js');
  const { FONT_NODE } = await import('/explorer/scene.js');
  const ctx = document.createElement('canvas').getContext('2d');
  const measure = (text, size, bold) => { ctx.font = `${bold ? 'bold ' : ''}${size}px ${FONT_NODE}`; return ctx.measureText(text).width; };
  const stage = state.canvas.getBoundingClientRect();
  const { camera } = state;
  const pills = [...document.querySelectorAll('.hx-work-badge')].map((el) => {
    const r = el.getBoundingClientRect();
    const node = state.nodes.find((n) => n.id === el.dataset.node);
    return { id: el.dataset.node, text: el.textContent, kind: el.dataset.workKind, waiting: el.classList.contains('is-waiting'), l: r.left - stage.left, r: r.right - stage.left, t: r.top - stage.top, b: r.bottom - stage.top, px: parseFloat(getComputedStyle(el).fontSize), border: getComputedStyle(el).borderTopColor, cx: node ? camera.x + node.x * camera.zoom : null };
  });
  const names = placeLabels(getScene(), camera.zoom, { measure }).map((p) => ({ id: p.id, l: camera.x + p.l, r: camera.x + p.r, t: camera.y + p.t, b: camera.y + p.b })).filter((b) => b.r > 0 && b.l < stage.width && b.b > 0 && b.t < stage.height);
  const over = [];
  for (let i = 0; i < pills.length; i++) for (let j = i + 1; j < pills.length; j++) { const a = pills[i]; const b = pills[j]; if (a.l < b.r - 1 && a.r > b.l + 1 && a.t < b.b - 1 && a.b > b.t + 1) over.push(`${a.text} / ${b.text}`); }
  const onName = pills.filter((p) => names.some((n) => p.l < n.r - 1 && p.r > n.l + 1 && p.t < n.b - 1 && p.b > n.t + 1)).map((p) => `${p.text} (${p.id}) over ${names.filter((n) => p.l < n.r - 1 && p.r > n.l + 1 && p.t < n.b - 1 && p.b > n.t + 1).map((n) => `${n.id} [${n.l.toFixed(1)} ${n.r.toFixed(1)} ${n.t.toFixed(1)} ${n.b.toFixed(1)}]`).join(', ')}`);
  const off = pills.filter((p) => p.r < 0 || p.l > stage.width || p.b < 0 || p.t > stage.height).map((p) => p.id);
  const centred = pills.filter((p) => p.cx !== null && Math.abs((p.l + p.r) / 2 - p.cx) > 1.5).map((p) => `${p.id}: ${((p.l + p.r) / 2).toFixed(1)} vs ${p.cx.toFixed(1)}`);
  return { pills, over, onName, off, centred, zoom: camera.zoom };
});

/** Puts the camera where the most badges show (the plan's nodes, a few zooms): what a picture of the layer should show; the pills as drawn there */
async function showMost(pg, plan, zooms) {
  let best = null;
  for (const id of ['@pair', ...plan.ids.slice(2)]) {
    for (const z of zooms) {
      await pg.evaluate(async ({ id: want, z: zoom, centre }) => {
        const { state } = await import('/explorer/state.js');
        const { render } = await import('/explorer/render.js');
        const n = want === '@pair' ? centre : state.nodes.find((x) => x.id === want);
        const w = state.canvas.getBoundingClientRect();
        Object.assign(state.camera, { zoom, x: w.width / 2 - n.x * zoom, y: w.height / 2 - n.y * zoom });
        render();
      }, { id, z, centre: plan.centre });
      await sleep(350);
      const t = await pillsOnScreen(pg);
      if (!best || t.pills.length > best.n) best = { n: t.pills.length, id, z };
    }
  }
  await pg.evaluate(async ({ id: want, z: zoom, centre }) => {
    const { state } = await import('/explorer/state.js');
    const { render } = await import('/explorer/render.js');
    const n = want === '@pair' ? centre : state.nodes.find((x) => x.id === want);
    const w = state.canvas.getBoundingClientRect();
    Object.assign(state.camera, { zoom, x: w.width / 2 - n.x * zoom, y: w.height / 2 - n.y * zoom });
    render();
  }, { id: best.id, z: best.z, centre: plan.centre });
  await sleep(500);
  return pillsOnScreen(pg);
}

async function main() {
  const { chromium } = await loadPlaywright();
  for (const d of [SHOTS, FINAL]) if (d) fs.mkdirSync(d, { recursive: true });
  const axeSource = fs.readFileSync(path.join(HERE, '..', '..', '..', 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
  const rig = await startRig(PORT);
  const errors = [];
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const newContext = async (opts, { signIn = true } = {}) => {
      const context = await browser.newContext({ reducedMotion: 'reduce', ...opts });
      if (signIn) { const sign = await context.newPage(); await sign.goto(`${BASE}/auth/start`); await sign.waitForURL(`${BASE}/**`); await sign.close(); }
      return context;
    };
    const listen = (page) => {
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(m.text()); });
    };
    const runAxe = async (pg) => { await pg.route('**/__axe.js', (route) => route.fulfill({ body: axeSource, contentType: 'application/javascript' })); await pg.addScriptTag({ url: `${BASE}/__axe.js` }); return pg.evaluate(async () => { const r = await window.axe.run(document, { resultTypes: ['violations'] }); return r.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0].target.join(' ')}`); }); };

    // ---- the page, signed in, the layer off ----
    const context = await newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    const page = await context.newPage();
    listen(page);
    const asked = [];
    page.on('request', (r) => { if (new URL(r.url()).pathname === GRAPH) asked.push(Date.now()); });
    await page.goto(`${BASE}/`);
    await page.waitForSelector('#preset-work-btn:not([hidden])', { timeout: 30_000 });
    await sleep(1500);
    const shot = async (dir, name, p = page) => { if (dir) await p.screenshot({ path: path.join(dir, `${name}.png`) }); };
    const layersMenu = async () => { await page.click('#legend-toggle-btn'); await sleep(300); };
    const closeMenu = async () => { await page.keyboard.press('Escape'); await sleep(200); };
    const row = () => page.locator('#layer-toggles-container [data-layer="work-badges"]');
    const live = () => page.evaluate(() => document.querySelector('#map-announcer')?.textContent || '');

    const off = await page.evaluate(async () => {
      const { state } = await import('/explorer/state.js');
      return { on: state.activeLayers['work-badges'], layer: document.querySelectorAll('.hx-work-badges, .hx-work-badge').length, chip: document.querySelector('#layers-count').textContent.trim(), runOverlay: document.querySelector('#run-overlay') ? document.querySelector('#run-overlay').children.length : -1, stored: localStorage.getItem('cornfield:layers') };
    });
    check('off by default: the layer is off in the state, nothing of it is in the page, and nothing is stored', off.on === false && off.layer === 0 && off.stored === null, JSON.stringify(off));
    check('and the graph has not been asked for', asked.length === 0, String(asked.length));
    await layersMenu();
    const rowOff = await row().evaluate((el) => ({ pressed: el.getAttribute('aria-pressed'), text: el.innerText.replace(/\s+/g, ' ').trim(), tag: el.tagName, disabled: el.disabled, under: el.closest('#layer-toggles-container').querySelector('[data-corn="overlays"]') !== null && !!(el.previousElementSibling || el.parentElement), title: el.title }));
    check('the Layers menu has the Work row under Overlays, off, saying the graph is not read yet', rowOff.pressed === 'false' && /^Work\s+not read yet/.test(rowOff.text) && rowOff.tag === 'BUTTON' && !rowOff.disabled, JSON.stringify(rowOff));
    const overlaysOrder = await page.evaluate(() => [...document.querySelectorAll('#layer-toggles-container [data-corn="overlays"] ~ [data-layer]')].map((b) => b.dataset.layer));
    check('it is the second overlay, after Runs in flight', overlaysOrder.join() === 'runs,work-badges', overlaysOrder.join());
    check('the chip counts layers as it did (an overlay is not one)', off.chip === '· 15 of 22' || /^· \d+ of \d+$/.test(off.chip), off.chip);
    await closeMenu();

    // ---- the plan: nodes of the map near each other, and a graph that touches them ----
    const realGraph = await (await context.request.get(`${BASE}${GRAPH}`)).json(); // what the server really says (not a request of the page: the count of the page's own reads is kept)
    const touchedByReal = [...new Set(realGraph.edges.map((e) => e.to))];
    const plan = await page.evaluate(async (taken) => {
      const { state } = await import('/explorer/state.js');
      const { isNodeVisible } = await import('/explorer/render.js');
      const pool = state.nodes.filter((n) => isNodeVisible(n) && !taken.includes(n.id) && ['service', 'table', 'page', 'atom', 'molecule', 'app', 'pkg'].includes(n.type) && n.type !== 'root');
      // A and B are the two nearest nodes (a pair whose badges can pile up); the others are the most alone, where a badge has room
      const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      let pair = null;
      for (const a of pool) for (const b of pool) if (a !== b && d(a, b) >= 12 && (!pair || d(a, b) < pair.dist)) pair = { a, b, dist: d(a, b) };
      const lone = pool.filter((n) => n !== pair.a && n !== pair.b).map((n) => ({ n, gap: Math.min(...pool.filter((m) => m !== n).map((m) => d(n, m))) })).sort((x, y) => y.gap - x.gap).slice(0, 7).map((x) => x.n);
      const best = { ids: [pair.a.id, pair.b.id, ...lone.map((n) => n.id)] };
      return { ids: best.ids, mapIds: state.nodes.map((n) => n.id), centre: { x: (pair.a.x + pair.b.x) / 2, y: (pair.a.y + pair.b.y) / 2 } };
    }, touchedByReal);
    const [A, B, C, D, E, F, G, H, I] = plan.ids;
    const mapIds = new Set(plan.mapIds);
    const RUN3 = 'run:run-01RIGRUN000000000000000003';
    const XSS_TITLE = '<img src=x onerror="window.__xss=1">Exports time out';
    let graph = null;
    let slow = 0;
    await page.route(`**${GRAPH}`, async (route) => {
      const real = await (await route.fetch()).json();
      if (slow) await sleep(slow);
      const g = JSON.parse(JSON.stringify(real));
      const node = (id) => g.nodes.find((n) => n.id === id);
      node('issue:5').title = XSS_TITLE;
      node('issue:5').url = 'javascript:alert(1)';
      const link = (from, to, rel) => g.edges.push({ from, to, rel });
      link('pull:13', A, 'changes'); // A: a pull request alone: PR #13
      link(RUN3, B, 'changes'); // B: a run that waits on you (the answer field): Run 000003
      link('proposal:0100-new-flow-across-apps', C, 'changes'); link('pull:13', C, 'changes'); link('issue:5', C, 'mentions'); // C: a spec that waits on you, and two more: Spec 0100 +2
      link('issue:5', D, 'mentions'); // D: an issue alone
      link('deploy:9001', E, 'restarts'); // E: a deploy that is running
      link('thread:21', F, 'mentions'); // F: a thread
      link('run:run-01RIGRUN000000000000000004', G, 'changes'); // G: a run that is done: no badge
      link('proposal:0001-stale-cleanup-client', H, 'changes'); // H: a local draft: no badge
      link('proposal:0100-new-flow-across-apps', '/not/on/the/map', 'adds'); // planned: not on the map
      link('pull:13', B, 'changes'); // B: the run waits, the pull request does not: Run 000003 +1
      graph = g;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(g) });
    });

    // ---- on, by the keyboard ----
    await layersMenu();
    await row().focus();
    const reach = await row().evaluate((el) => ({ focused: document.activeElement === el, tabindex: el.tabIndex }));
    check('the Work row is a button in the tab order, and has the focus when it is focused', reach.focused && reach.tabindex >= 0, JSON.stringify(reach));
    await page.keyboard.press('Space');
    check('Space turns the layer on (the graph is read, the row is pressed)', await until(page, async () => { const { state } = await import('/explorer/state.js'); return state.work && state.work.status === 'ok'; }, null, 60_000));
    await sleep(600);
    check('the row is pressed, and the layer is kept (the same store as the other layers)', (await row().getAttribute('aria-pressed')) === 'true' && JSON.parse(await page.evaluate(() => localStorage.getItem('cornfield:layers')))['work-badges'] === true);
    check('the focus stays on the row after it is drawn again', await row().evaluate((el) => document.activeElement === el));
    check('the graph was asked for once', asked.length === 1, String(asked.length));
    const want = expected(graph, mapIds);
    const rowOn = (await row().innerText()).replace(/\s+/g, ' ').trim();
    check('the row counts the nodes open work touches', rowOn.startsWith(`Work ${want.size} nodes`), `${rowOn} vs ${want.size}`);
    check('and says so to a screen reader when the read is in', new RegExp(`^Work layer: ${want.size} nodes have open work\\.$`).test(await live()), await live());
    await row().scrollIntoViewIfNeeded(); await sleep(300);
    await shot(FINAL, 'layers-menu-work-row');
    await closeMenu();

    // ---- the badges, near ----
    const near = async (zoom, ids = plan.ids) => {
      await page.evaluate(async ({ centre, zoom: z }) => {
        const { state } = await import('/explorer/state.js');
        const { render } = await import('/explorer/render.js');
        const w = state.canvas.getBoundingClientRect();
        Object.assign(state.camera, { zoom: z, x: w.width / 2 - centre.x * z, y: w.height / 2 - centre.y * z });
        render();
      }, { centre: plan.centre, zoom });
      await sleep(500);
    };
    // each kind of node, close up (the node in the middle of the screen at zoom 6, where a badge has room): its badge is what the answer says
    const nodeAt = async (id, zoom) => {
      await page.evaluate(async ({ id: want, z }) => {
        const { state } = await import('/explorer/state.js');
        const { render } = await import('/explorer/render.js');
        const n = state.nodes.find((x) => x.id === want);
        const w = state.canvas.getBoundingClientRect();
        Object.assign(state.camera, { zoom: z, x: w.width / 2 - n.x * z, y: w.height / 2 - n.y * z });
        render();
      }, { id, z: zoom });
      await sleep(450);
      return (await pillsOnScreen(page)).pills.find((p) => p.id === id) || null;
    };
    const got = {};
    for (const id of [A, B, C, D, E, F, G, H]) got[id] = await nodeAt(id, 6);
    const sayText = (id) => (got[id] ? got[id].text : 'none');
    check('a pull request alone: PR #13', sayText(A) === 'PR #13' && want.get(A).text === 'PR #13', sayText(A));
    check('a run that waits on you, and a pull request: the run first, then +1', sayText(B) === 'Run 000003 +1' && want.get(B).text === 'Run 000003 +1', sayText(B));
    check('a spec that waits on you, a pull request and an issue: the spec first, then +2', sayText(C) === 'Spec 0100 +2' && want.get(C).text === 'Spec 0100 +2', sayText(C));
    check('an issue alone: Issue #5', sayText(D) === 'Issue #5', sayText(D));
    check('a deploy that is running: Deploy', sayText(E) === 'Deploy', sayText(E));
    check('a thread: Thread #21', sayText(F) === 'Thread #21', sayText(F));
    check('a run that is done and a local draft get no badge, and a node the map does not hold (a planned one) has none', !got[G] && !got[H] && !want.has(G) && !want.has(H) && (await page.locator('.hx-work-badge[data-node="/not/on/the/map"]').count()) === 0, `${sayText(G)} ${sayText(H)}`);
    check('the waiting ones are drawn heavier: a spec and a run that wait', !!(got[C] && got[C].waiting && got[B] && got[B].waiting && got[A] && !got[A].waiting));
    const colours = await page.evaluate(() => { const probe = document.createElement('i'); const out = {}; for (const [k, c] of Object.entries({ pull: '#60a5fa', run: '#818cf8', proposal: '#2dd4bf', issue: '#fbbf24', deploy: '#4ade80', thread: '#a78bfa' })) { probe.style.color = c; document.body.append(probe); out[k] = getComputedStyle(probe).color; probe.remove(); } return out; });
    const bd = (id) => (got[id] || {}).border;
    check('each badge is bordered in the colour of its kind (--corn-work-<kind>): pull, run, spec, issue, deploy, thread', bd(A) === colours.pull && bd(B) === colours.run && bd(C) === colours.proposal && bd(D) === colours.issue && bd(E) === colours.deploy && bd(F) === colours.thread, [A, B, C, D, E, F].map(bd).join(' '));
    // the cluster, at the zoom that shows the most of it
    let bestZoom = 3.2; let most = -1;
    for (const z of [0.8, 1.2, 1.6, 2.2]) { await near(z); const t = await pillsOnScreen(page); if (t.pills.length > most) { most = t.pills.length; bestZoom = z; } }
    await near(bestZoom);
    let s = await pillsOnScreen(page);
    const wrong = s.pills.filter((p) => !want.has(p.id) || want.get(p.id).text !== p.text).map((p) => `${p.id}: ${p.text}`);
    check('every badge on the screen is the one the answer says that node has (and no node without open work has one)', s.pills.length >= 1 && wrong.length === 0, `${s.pills.length} badges at zoom ${bestZoom}; ${wrong.join(' | ')}`);
    check('near: no badge over another, none over a name, none off the screen, each centred on its node', s.over.length === 0 && s.onName.length === 0 && s.off.length === 0 && s.centred.length === 0, JSON.stringify({ over: s.over, onName: s.onName, off: s.off, centred: s.centred }));
    await shot(SHOTS, 'near-dark');

    // screen space: the same size at every zoom, and still centred
    const sizes = [];
    for (const z of [0.5, 1, 3.2, 6]) { await near(z); const t = await pillsOnScreen(page); sizes.push({ z, px: [...new Set(t.pills.map((p) => p.px))].join('/'), n: t.pills.length, centred: t.centred.length, over: t.over.length, onName: t.onName.length }); }
    check('badges are in screen space: one size (11px) at every zoom, centred on their node, none piled up', sizes.every((x) => x.px === '11' && x.centred === 0 && x.over === 0 && x.onName === 0 && x.n > 0), JSON.stringify(sizes));
    const far = sizes.find((x) => x.z === 0.5).n;
    check('and fewer of them at a distance than near (the same rule as the names)', far < sizes.find((x) => x.z === 6).n || far <= 6, `${far} at 0.5, ${sizes.find((x) => x.z === 6).n} at 6`);

    // a sweep of zooms over the cluster: where badges would pile up (the plan's nodes are close), the placing hides some, and what is left never piles up or covers a name (the priority is the unit test's)
    const sweep = [];
    for (const z of [0.4, 0.55, 0.7, 0.85, 1, 1.2, 1.5, 1.9, 2.4, 3.2, 4.5, 6]) { await near(z); const t = await pillsOnScreen(page); sweep.push({ z, n: t.pills.length, over: t.over.length, onName: t.onName.length, off: t.off.length, centred: t.centred.length, why: t.onName.length ? t.onName : undefined, boxes: t.onName.length ? t.pills.filter((p) => t.onName.some((x) => x.includes(`(${p.id})`))).map((p) => [p.l, p.r, p.t, p.b, p.border]) : undefined }); }
    check('at every zoom of a sweep: no badge over another, none over a name, none off the screen', sweep.every((x) => x.over === 0 && x.onName === 0 && x.off === 0 && x.centred === 0), JSON.stringify(sweep.filter((x) => x.over || x.onName || x.off || x.centred)));
    check('and the badges do thin out where they would pile up (not the same number at every zoom)', new Set(sweep.map((x) => x.n)).size > 1, sweep.map((x) => `${x.z}:${x.n}`).join(' '));

    // the selected node has its badge
    await near(1.2);
    const picked = await page.evaluate(async (id) => {
      const { state, pageInstance } = await import('/explorer/state.js');
      const { selectNode } = await import('/explorer/engine/selection.js');
      selectNode(pageInstance(), state.nodes.find((n) => n.id === id), { frame: false, source: 'link' });
      return true;
    }, A);
    await sleep(700);
    s = await pillsOnScreen(page);
    check('the selected node has its badge, whatever the zoom', picked && s.pills.some((p) => p.id === A && p.text === 'PR #13'), s.pills.map((p) => p.text).join(', '));
    check('selecting dims the rest: a node outside what it lights has none', s.pills.every((p) => p.id === A || want.has(p.id)));

    // ---- the node panel: Open work ----
    await nodeAt(C, 4);
    await page.evaluate(async (id) => { const { state, pageInstance } = await import('/explorer/state.js'); const { selectNode } = await import('/explorer/engine/selection.js'); selectNode(pageInstance(), state.nodes.find((n) => n.id === id), { frame: false, source: 'link' }); }, C);
    await sleep(900);
    const panel = await page.evaluate(() => {
      const sec = [...document.querySelectorAll('#spec-drawer [data-corn="section"]')].find((s) => /Open work/.test(s.textContent));
      const links = sec ? [...sec.querySelectorAll('a[data-work-action="open-item"]')].map((a) => ({ text: a.textContent, href: a.getAttribute('href'), id: a.dataset.id })) : [];
      const outs = sec ? [...sec.querySelectorAll('a[target="_blank"]')].map((a) => a.getAttribute('href')) : [];
      return { has: !!sec, links, outs, imgs: sec ? sec.querySelectorAll('img').length : -1, xss: window.__xss === undefined, first: sec ? sec.parentElement.firstElementChild === sec : false };
    });
    check('the node panel of a badged node has an Open work section, first, listing each piece of open work', panel.has && panel.links.length === 3 && panel.first, JSON.stringify(panel.links));
    check('each is a link to the Work view with that piece selected (the address a new tab takes)', panel.links.some((l) => l.href === '?view=work&pr=13') && panel.links.some((l) => l.href === '?view=work&spec=0100-new-flow-across-apps') && panel.links.some((l) => l.href === '?view=work&issue=5'), JSON.stringify(panel.links.map((l) => l.href)));
    check('a title with markup is text, an address that is not http(s) is no link, an https one is', panel.imgs === 0 && panel.xss && panel.outs.length === 2 && panel.outs.every((u) => /^https:\/\//.test(u)), JSON.stringify({ imgs: panel.imgs, xss: panel.xss, outs: panel.outs }));
    await shot(FINAL, 'badged-node-selected-dark');
    const asksBefore = asked.length;
    await page.click('#spec-drawer a[data-id="pull:13"]');
    check('a link opens the Work view with that piece selected', await until(page, async () => { const { state } = await import('/explorer/state.js'); return state.view === 'work' && state.selectedNode && state.selectedNode.id === 'pull:13'; }, null, 30_000));
    check('and the Work view read the graph as it opened (its own opening), no second poll', asked.length === asksBefore + 1, `${asksBefore} -> ${asked.length}`);
    await sleep(500);
    await page.click('#preset-map-btn'); await sleep(900);
    await near(1.6); // the map comes back fitted whole, where an 800-node map leaves a badge no room beside the names: near, as a reader would look
    check('Map brings the map back, with the layer still on and the badges drawn', (await page.evaluate(async () => { const { state } = await import('/explorer/state.js'); return state.view === 'orbit' && state.activeLayers['work-badges'] === true; })) && (await page.locator('.hx-work-badge').count()) > 0);

    // ---- the keyboard says it ----
    await near(3.2);
    await page.evaluate(async () => { const { clearSelection } = await import('/explorer/engine/selection.js'); const { pageInstance } = await import('/explorer/state.js'); clearSelection(pageInstance()); });
    const stepsTo = await page.evaluate(async (id) => {
      const { state } = await import('/explorer/state.js');
      const { isNodeVisible } = await import('/explorer/render.js');
      const { readingOrder } = await import('/explorer/keyboard-model.js');
      return readingOrder(state.nodes.filter((n) => isNodeVisible(n))).findIndex((n) => n.id === id) + 1;
    }, C);
    await page.locator('#graph-canvas').focus();
    for (let i = 0; i < stepsTo; i++) await page.keyboard.press('n');
    await sleep(500);
    const said = await live();
    check('landing on a badged node by the keyboard says its open work after its name', /, 3 open: Spec 0100 \(waiting on you\), PR #13, Issue #5$/.test(said), said);
    await page.keyboard.press('Escape');

    // ---- the runs' pulse is untouched ----
    const pulse = await page.evaluate(() => ({ marks: document.querySelectorAll('#run-overlay .hx-run-mark').length, inside: document.querySelectorAll('#run-overlay .hx-work-badge').length, runsLayer: document.querySelector('.hx-run-overlay') !== null }));
    check('the runs\' pulse layer is the one it was: no badge in it, and no mark of its own added', pulse.inside === 0 && pulse.marks === off.runOverlay, JSON.stringify(pulse));

    // ---- axe ----
    await near(3.2);
    await page.evaluate(async (id) => { const { state, pageInstance } = await import('/explorer/state.js'); const { selectNode } = await import('/explorer/engine/selection.js'); selectNode(pageInstance(), state.nodes.find((n) => n.id === id), { frame: false, source: 'link' }); }, C);
    await sleep(800);
    await layersMenu();
    const axeDark = await runAxe(page);
    check('axe: no violation on the Map view with the layer on, the menu open and a badged node selected (dark)', axeDark.length === 0, axeDark.join(' | '));
    await closeMenu();

    // ---- shared read: the Work view first, then the layer ----
    const ctx2 = await newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const p2 = await ctx2.newPage();
    listen(p2);
    const asked2 = [];
    p2.on('request', (r) => { if (new URL(r.url()).pathname === GRAPH) asked2.push(Date.now()); });
    await p2.route(`**${GRAPH}`, async (route) => { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(graph) }); });
    await p2.goto(`${BASE}/`);
    await p2.waitForSelector('#preset-work-btn:not([hidden])', { timeout: 30_000 });
    await sleep(1200);
    await p2.click('#preset-work-btn');
    await until(p2, async () => { const { state } = await import('/explorer/state.js'); return state.view === 'work' && state.nodes.some((n) => n.work); }, null, 60_000);
    await sleep(500);
    await p2.click('#preset-map-btn'); await sleep(700);
    const before2 = asked2.length;
    await p2.click('#legend-toggle-btn'); await sleep(300);
    const rowCountBefore = (await p2.locator('[data-layer="work-badges"]').innerText()).replace(/\s+/g, ' ').trim();
    check('the Work view having read the graph, the row already knows its count', new RegExp(`^Work ${want.size} nodes`).test(rowCountBefore), rowCountBefore);
    await p2.click('[data-layer="work-badges"]'); await sleep(1500);
    await p2.keyboard.press('Escape'); await sleep(200);
    await p2.evaluate(async ({ centre, zoom }) => { // near the plan's nodes, as near() does: the whole map fitted leaves a badge no room beside the names
      const { state } = await import('/explorer/state.js');
      const { render } = await import('/explorer/render.js');
      const w = state.canvas.getBoundingClientRect();
      Object.assign(state.camera, { zoom, x: w.width / 2 - centre.x * zoom, y: w.height / 2 - centre.y * zoom });
      render();
    }, { centre: plan.centre, zoom: 1.6 });
    await sleep(500);
    check('and turning the layer on asks for nothing more: it draws from the Work view\'s read', asked2.length === before2 && (await p2.locator('.hx-work-badge').count()) > 0, `${before2} -> ${asked2.length}; ${await p2.locator('.hx-work-badge').count()} badges`);
    await p2.keyboard.press('Escape');
    await p2.click('#legend-toggle-btn'); await sleep(200); await p2.click('[data-layer="work-badges"]'); await sleep(200); await p2.click('[data-layer="work-badges"]'); await sleep(800);
    check('off and on again asks for nothing either', asked2.length === before2, `${before2} -> ${asked2.length}`);
    await p2.keyboard.press('Escape');
    // light
    const light = await showMost(p2, plan, [1.5, 2.5, 4]);
    const lightWrong = light.pills.filter((p) => !want.has(p.id) || want.get(p.id).text !== p.text).map((p) => `${p.id}: ${p.text}`);
    check('light: the badges are the same ones, and none over another, over a name, or off the screen', light.pills.length >= 2 && lightWrong.length === 0 && light.over.length === 0 && light.onName.length === 0 && light.off.length === 0 && light.centred.length === 0, `${light.pills.length} badges: ${light.pills.map((p) => p.text).join(', ')}; ${lightWrong.join(' | ')}; ${JSON.stringify([light.over, light.onName])}`);
    await shot(SHOTS, 'near-light', p2);
    await shot(FINAL, 'map-layer-on-desktop-light', p2);
    // desktop dark: where the most show (the final)
    await page.evaluate(async () => { const { clearSelection } = await import('/explorer/engine/selection.js'); const { pageInstance } = await import('/explorer/state.js'); clearSelection(pageInstance()); });
    const darkBest = await showMost(page, plan, [1.5, 2.5, 4]);
    check('dark: the same, at the view that shows the most', darkBest.pills.length >= 2 && darkBest.over.length === 0 && darkBest.onName.length === 0, `${darkBest.pills.length}: ${darkBest.pills.map((p) => p.text).join(', ')}`);
    await shot(FINAL, 'map-layer-on-desktop-dark');
    await shot(SHOTS, 'near-dark');
    await ctx2.close();

    // ---- remembered: a reload with the layer on reads the graph and draws ----
    const before3 = asked.length;
    await page.reload();
    await page.waitForSelector('#preset-work-btn:not([hidden])', { timeout: 30_000 });
    check('a reload with the layer on reads the graph by itself (the layer is remembered) and draws the badges', await until(page, async () => { const { state } = await import('/explorer/state.js'); return state.work && state.work.status === 'ok' && state.activeLayers['work-badges'] === true; }, null, 60_000) && asked.length === before3 + 1, `${before3} -> ${asked.length}`);
    await near(3.2);
    check('and the badges are there', (await page.locator('.hx-work-badge').count()) > 0);
    await layersMenu();
    await page.click('[data-layer="work-badges"]'); await sleep(700);
    const offAgain = await page.evaluate(async () => { const { state } = await import('/explorer/state.js'); return { badges: document.querySelectorAll('.hx-work-badge').length, stored: localStorage.getItem('cornfield:layers'), layer: state.activeLayers['work-badges'] }; });
    check('off again: the badges are gone, and the choice is the default again (nothing stored)', offAgain.badges === 0 && offAgain.layer === false && offAgain.stored === null, JSON.stringify(offAgain));
    await closeMenu();
    // no poll while it is off
    const before4 = asked.length;
    await sleep(2500);
    check('and nothing asks for the graph while it is off', asked.length === before4);
    await context.close();

    // ---- the first read is slow: the row says so, and the Work view shares the read and its loading state ----
    await fetch(`http://127.0.0.1:${PORT + 1}/__rig/delay?ms=0`);
    const ctx3 = await newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    const p3 = await ctx3.newPage();
    listen(p3);
    const asked3 = [];
    p3.on('request', (r) => { if (new URL(r.url()).pathname === GRAPH) asked3.push(Date.now()); });
    let release = null;
    const gate = new Promise((r) => { release = r; });
    await p3.route(`**${GRAPH}`, async (route) => { await gate; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(graph) }); });
    await p3.goto(`${BASE}/`);
    await p3.waitForSelector('#preset-work-btn:not([hidden])', { timeout: 30_000 });
    await sleep(1200);
    await p3.click('#legend-toggle-btn'); await sleep(300);
    await p3.click('[data-layer="work-badges"]'); await sleep(600);
    const loadingRow = (await p3.locator('[data-layer="work-badges"]').innerText()).replace(/\s+/g, ' ').trim();
    check('while the first read is on its way the row says "reading…"', /^Work reading…/.test(loadingRow), loadingRow);
    await p3.keyboard.press('Escape');
    await p3.click('#preset-work-btn'); await sleep(900);
    const view = await p3.evaluate(() => ({ loading: !document.querySelector('.hx-work-loading').hidden, status: document.querySelector('.hx-work-loading-text') ? document.querySelector('.hx-work-loading-text').textContent.slice(0, 20) : '' }));
    check('the Work view opened meanwhile shows the same loading state, and asks for nothing', view.loading && asked3.length === 1, JSON.stringify({ view, asked: asked3.length }));
    release();
    check('and one answer serves both: the view has its work', await until(p3, async () => { const { state } = await import('/explorer/state.js'); return state.view === 'work' && state.nodes.some((n) => n.work); }, null, 30_000) && asked3.length === 1, String(asked3.length));
    await ctx3.close();

    // ---- no forge in the config (or nobody signed in: the same answer, `work:on`): the row is absent, and nothing is asked even with the layer remembered on ----
    const bare = await startRig(PORT + 10, [], { forge: false });
    try {
      const ctxOut = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
      const pOut = await ctxOut.newPage();
      listen(pOut);
      const askedOut = [];
      pOut.on('request', (r) => { if (new URL(r.url()).pathname === GRAPH) askedOut.push(1); });
      await pOut.addInitScript(() => { try { localStorage.setItem('cornfield:layers', JSON.stringify({ 'work-badges': true })); } catch { /* none */ } });
      await pOut.goto(`http://127.0.0.1:${PORT + 10}/`);
      await sleep(3000);
      await pOut.click('#legend-toggle-btn'); await sleep(300);
      const out = await pOut.evaluate(() => ({ row: document.querySelectorAll('[data-layer="work-badges"]').length, runs: document.querySelectorAll('[data-layer="runs"]').length, badges: document.querySelectorAll('.hx-work-badge').length }));
      check('with no forge, the Work row is not in the menu (the Runs row is), and nothing asks for the graph even with the layer remembered on', out.row === 0 && out.runs === 1 && out.badges === 0 && askedOut.length === 0, JSON.stringify({ out, asked: askedOut.length }));
      await ctxOut.close();
    } finally { bare.stop(); }

    // ---- a phone ----
    const ctxP = await newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', hasTouch: true, isMobile: true, deviceScaleFactor: FINAL ? 2 : 1 });
    const pp = await ctxP.newPage();
    listen(pp);
    const askedP = [];
    pp.on('request', (r) => { if (new URL(r.url()).pathname === GRAPH) askedP.push(1); });
    await pp.route(`**${GRAPH}`, async (route) => { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(graph) }); });
    await pp.goto(`${BASE}/`);
    await pp.waitForSelector('#preset-work-btn:not([hidden])', { timeout: 30_000 });
    await sleep(1500);
    await pp.tap('#legend-toggle-btn'); await sleep(400);
    await pp.tap('[data-layer="work-badges"]');
    check('phone: the row turns the layer on (a tap)', await until(pp, async () => { const { state } = await import('/explorer/state.js'); return state.work && state.work.status === 'ok'; }, null, 60_000));
    await sleep(500);
    await pp.keyboard.press('Escape'); await sleep(300);
    const ph = await showMost(pp, plan, [1.2, 2, 3.2]);
    const phWrong = ph.pills.filter((p) => !want.has(p.id) || want.get(p.id).text !== p.text).map((p) => `${p.id}: ${p.text}`);
    check('phone: badges are on the nodes they belong to, 11px, none over another, none over a name, none off the screen', ph.pills.length >= 1 && phWrong.length === 0 && ph.pills.every((p) => p.px === 11) && ph.over.length === 0 && ph.onName.length === 0 && ph.off.length === 0 && ph.centred.length === 0, JSON.stringify({ n: ph.pills.length, wrong: phWrong, over: ph.over, onName: ph.onName, off: ph.off, centred: ph.centred }));
    await shot(SHOTS, 'phone-dark', pp);
    await shot(FINAL, 'map-layer-on-phone-dark', pp);
    const axePhone = await runAxe(pp);
    check('axe: none on a phone with the layer on', axePhone.length === 0, axePhone.join(' | '));
    await ctxP.close();

    // ---- the Work list's tab strip ----
    const ctxT = await newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', deviceScaleFactor: FINAL ? 2 : 1 });
    const pt = await ctxT.newPage();
    listen(pt);
    await pt.goto(`${BASE}/`);
    await pt.waitForSelector('#preset-work-btn:not([hidden])', { timeout: 30_000 });
    await pt.click('#preset-work-btn'); await sleep(2500);
    await pt.click('.hx-work-bar [data-action="toggle-forge"]'); await sleep(1200);
    const strip = () => pt.evaluate(() => { const t = document.querySelector('.hx-forge-tabs'); const tabs = [...t.children].filter((c) => !c.hidden); const box = t.getBoundingClientRect(); const room = parseFloat(getComputedStyle(t).scrollPaddingInlineStart) || 0; const vis = (c) => { const r = c.getBoundingClientRect(); return Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left)) / r.width; }; return { cw: t.clientWidth, sw: t.scrollWidth, left: Math.round(t.scrollLeft), tabs: tabs.map((c) => ({ k: c.dataset.forgeKind, seen: Math.round(vis(c) * 100), on: c.getAttribute('aria-pressed') === 'true' })), room, more: document.querySelector('.hx-forge-top').dataset.more || '' }; });
    const s0 = await strip();
    const deploys0 = s0.tabs.find((x) => x.k === 'deploys');
    check('at 400px the strip is wider than its box (so the cut is real), and Deploys is cut at first', s0.sw > s0.cw && deploys0.seen < 100 && /end/.test(s0.more), JSON.stringify(s0));
    await pt.mouse.move(200, 120);
    const box = await pt.locator('.hx-forge-tabs').boundingBox();
    await pt.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await pt.mouse.wheel(0, 120); await sleep(300);
    const s1 = await strip();
    check('a vertical wheel over the strip scrolls it sideways, and Deploys is whole', s1.left > 0 && s1.tabs.find((x) => x.k === 'deploys').seen === 100, JSON.stringify(s1.tabs.find((x) => x.k === 'deploys')) + ` left ${s1.left}`);
    check('the start fades in as it scrolls (the strip says there is more that way)', /start/.test(s1.more) && !/end/.test(s1.more), s1.more);
    await pt.mouse.wheel(0, -400); await sleep(300);
    const s2 = await strip();
    check('and back: a wheel up brings the first tab whole again', s2.left === 0 && s2.tabs[0].seen === 100, `left ${s2.left}`);
    await pt.click('[data-forge-kind="deploys"]'); await sleep(1400);
    const s3 = await strip();
    check('pressing Deploys leaves it on, and whole in the strip, clear of the fade', s3.tabs.find((x) => x.k === 'deploys' && x.on && x.seen === 100) !== undefined && !/end/.test(s3.more), JSON.stringify(s3));
    await shot(FINAL, 'work-list-tabs-deploys', pt);
    // by the keyboard: Tab to the last tab brings it fully into view too (focus-room.js)
    await pt.click('[data-forge-kind="specs"]'); await sleep(1200);
    await pt.locator('[data-forge-kind="deploys"]').focus(); await sleep(300);
    const s4 = await strip();
    check('and by the keyboard: the focus on Deploys brings it whole into the strip', s4.tabs.find((x) => x.k === 'deploys').seen === 100, JSON.stringify(s4.tabs.find((x) => x.k === 'deploys')));
    await ctxT.close();

    // ---- the phone's strip: a tab pressed is brought in ----
    const ctxT2 = await newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', hasTouch: true, isMobile: true });
    const pt2 = await ctxT2.newPage();
    listen(pt2);
    await pt2.goto(`${BASE}/?view=work&pr=13`);
    await pt2.waitForSelector('#preset-work-btn:not([hidden])', { timeout: 30_000 });
    await sleep(2500);
    await pt2.tap('.hx-work-bar [data-action="toggle-forge"]'); await sleep(900);
    await pt2.evaluate(() => { document.querySelector('[data-sheet="forge"] [data-corn="sheet-handle"], #forge-panel [data-corn="sheet-handle"]')?.click(); });
    await sleep(600);
    const expanded = await pt2.evaluate(() => { const t = document.querySelector('.hx-forge-tabs'); return t.clientWidth > 0; });
    if (!expanded) await pt2.evaluate(async () => { const { expandSheet } = await import('/explorer/sheets.js'); expandSheet('forge'); });
    await sleep(600);
    // a finger swiping the strip leftwards (raw touch events: the browser's own panning, as a phone does it) brings Deploys in, and moves neither the map nor the sheet
    const sbox = await pt2.locator('.hx-forge-tabs').boundingBox();
    const camA = await pt2.evaluate(async () => { const { state } = await import('/explorer/state.js'); return `${state.camera.x},${state.camera.y},${state.camera.zoom}`; });
    const cdp2 = await ctxT2.newCDPSession(pt2);
    const fx = Math.round(sbox.x + sbox.width * 0.8); const fy = Math.round(sbox.y + sbox.height / 2);
    await cdp2.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fx, y: fy }] });
    for (let i = 1; i <= 12; i++) { await cdp2.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: fx - (260 * i) / 12, y: fy }] }); await sleep(16); }
    await cdp2.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(700);
    const sw = await pt2.evaluate(async () => { const { state } = await import('/explorer/state.js'); const t = document.querySelector('.hx-forge-tabs'); const tb = t.getBoundingClientRect(); const r = t.querySelector('[data-forge-kind="deploys"]').getBoundingClientRect(); return { left: Math.round(t.scrollLeft), whole: r.left >= tb.left - 1 && r.right <= tb.right + 1, cam: `${state.camera.x},${state.camera.y},${state.camera.zoom}` }; });
    check('on a phone, a finger swiping the strip brings Deploys whole into it, and moves neither the map nor anything else', sw.left > 0 && sw.whole && sw.cam === camA && Math.abs((await pt2.locator('.hx-forge-tabs').boundingBox()).y - sbox.y) < 1, JSON.stringify(sw));
    await pt2.evaluate(() => { document.querySelector('.hx-forge-tabs').scrollLeft = 0; });
    await sleep(300);
    await pt2.evaluate(() => document.querySelector('[data-forge-kind="deploys"]').click());
    await sleep(1400);
    const sp = await pt2.evaluate(() => { const t = document.querySelector('.hx-forge-tabs'); const d = t.querySelector('[data-forge-kind="deploys"]'); const tb = t.getBoundingClientRect(); const r = d.getBoundingClientRect(); return { cw: t.clientWidth, sw: t.scrollWidth, left: Math.round(t.scrollLeft), inside: r.left >= tb.left - 1 && r.right <= tb.right + 1, pressed: d.getAttribute('aria-pressed') }; });
    check('on a phone, with the list expanded, a tab pressed (Deploys) is whole in the strip', sp.cw > 0 && sp.sw > sp.cw && sp.inside && sp.pressed === 'true', JSON.stringify(sp));
    await shot(SHOTS, 'phone-tabs', pt2);
    await ctxT2.close();

    check('no error on the page', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    rig.stop();
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`);
  if (failed.length) { console.log(`FAILED:\n${failed.map((c) => `  ${c.name}`).join('\n')}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
