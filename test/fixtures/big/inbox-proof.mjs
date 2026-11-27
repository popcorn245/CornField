/**
 * The proof in a browser of the Work inbox (spec 0016), against the rig with the fake forge. Runs by hand: needs Playwright and Chromium.
 *
 *   node test/fixtures/big/inbox-proof.mjs [--shots <dir>] [--port <n>]
 *
 * Signs in and opens the Work view: it opens on the Inbox (D1), with the groups the rig's work puts in it, the heading's count the Work button's badge, and Waiting on you
 * left to the Graph. A run that asks about a spec that also waits rides in the spec's row (D4). By keyboard: Tab reaches the first row, J and K move and select (the node
 * panel opens on each, Around it beside the queue), a group's heading folds it (D6). Around it (D5): the work it is linked to selects that work, Show in Graph switches with the
 * selection kept, and a node of code it touches shows it on the map. G switches Inbox and Graph and is remembered across a reload; `?view=work&as=graph` opens the Graph.
 * A row's action selects its work and presses the node panel's own control for it: Re-run failed presses the failed check's Re-run (not the panel's first control, which
 * opens the forge), a Land it that is off is not pressed and says why, and a done run offers Land PR #n only when the graph holds that pull request. On a phone the queue takes the width, under
 * the Layers chip and the view's controls, with nothing wider than the screen (D8). axe finds no violation with a row picked, in both themes and on a phone.
 * Screenshots (synthetic fixture only) go in `--shots`. Exit code 1 when a check fails.
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
const PORT = Number(arg('--port') || 3850);
const BASE = `http://127.0.0.1:${PORT}`;

async function loadPlaywright() {
  for (const t of ['playwright', pathToFileURL('/opt/node-tools/node_modules/playwright/index.mjs').href]) { try { return await import(t); } catch { /* next */ } }
  throw new Error('Playwright is not installed');
}
function startRig(port) {
  const child = spawn(process.execPath, [SERVE, '--forge', '--port', String(port), '--forge-port', String(port + 1), '--dir', path.join(os.tmpdir(), `cornfield-inbox-proof-${port}`)], { stdio: ['ignore', 'pipe', 'pipe'] });
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
async function until(page, fn, arg, timeout = 30_000) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn, arg)) return true;
    if (Date.now() - t0 > timeout) return false;
    await sleep(150);
  }
}

/** What the inbox shows: its heading, its groups (open or folded, with their counts), its rows, the selection, Around it */
const inboxNow = (page) => page.evaluate(async () => {
  const { state } = await import('/explorer/state.js');
  const box = document.querySelector('[data-corn="inbox"]');
  const groups = [...box.querySelectorAll('[data-corn="section"][data-group]:not([data-group="around"])')].map((g) => ({ key: g.dataset.group, open: g.querySelector('[data-inbox-group]').getAttribute('aria-expanded') === 'true', count: Number(g.querySelector('[data-corn="count"]').textContent) }));
  const around = box.querySelector('[data-group="around"]');
  return {
    shown: !box.hidden,
    heading: box.querySelector('.hx-inbox-sub').textContent,
    groups,
    rows: [...box.querySelectorAll('[data-corn="row"]')].map((r) => r.dataset.id),
    also: [...box.querySelectorAll('.hx-inbox-also')].map((a) => a.closest('[data-corn="row"]').dataset.id),
    selected: state.selectedNode ? state.selectedNode.id : null,
    current: [...box.querySelectorAll('[aria-current="true"]')].map((b) => b.closest('[data-corn="row"]').dataset.id),
    focused: document.activeElement && document.activeElement.closest('[data-corn="row"]') ? document.activeElement.closest('[data-corn="row"]').dataset.id : null,
    around: around ? { work: [...around.querySelectorAll('[data-inbox-around]')].map((b) => b.dataset.inboxAround), code: [...around.querySelectorAll('[data-inbox-map]')].map((b) => b.dataset.inboxMap) } : null,
    panel: document.querySelector('#spec-drawer .hx-drawer-title, #spec-drawer [data-corn="node-title"]')?.textContent || '',
    view: state.view,
    as: document.querySelector('[data-work-as="graph"]').getAttribute('aria-pressed') === 'true' ? 'graph' : 'inbox',
    waitingShown: !document.querySelector('[data-work-toggle="waiting"]').hidden,
    badge: Number(document.querySelector('#preset-work-btn [data-corn="waiting-badge"]')?.textContent || 0),
  };
});

async function main() {
  const { chromium } = await loadPlaywright();
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const rig = await startRig(PORT);
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  const axeSource = fs.readFileSync(path.join(HERE, '..', '..', '..', 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
  const runAxe = async (pg) => {
    await pg.route('**/__axe.js', (route) => route.fulfill({ body: axeSource, contentType: 'application/javascript' })); // a script of the page's own origin: its CSP does not allow an inline one
    await pg.addScriptTag({ url: `${BASE}/__axe.js` });
    return pg.evaluate(async () => { const r = await window.axe.run(document.querySelector('[data-corn="inbox"]'), { resultTypes: ['violations'] }); return r.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0].target.join(' ')}`); });
  };
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
    await page.click('#preset-work-btn');
    await page.waitForSelector('[data-corn="inbox"]:not([hidden]) [data-corn="row"]', { timeout: 60_000 });
    await sleep(500);

    // D1, D2, D4: what it opens on
    let s = await inboxNow(page);
    check('the Work view opens on the Inbox, Inbox pressed, Waiting on you left to the Graph', s.shown && s.as === 'inbox' && !s.waitingShown && s.view === 'work');
    check('the groups are Waiting on you, Your move and Nobody on it open, In motion and Done lately folded', ['waiting', 'move', 'unclaimed'].every((k) => s.groups.find((g) => g.key === k && g.open)) && s.groups.filter((g) => ['motion', 'done'].includes(g.key)).every((g) => !g.open), JSON.stringify(s.groups));
    const n = Number((/^(\d+) waiting on you/.exec(s.heading) || [])[1] || 0);
    check('the heading\'s number is the Work button\'s badge', n > 0 && n === s.badge, `${s.heading} · badge ${s.badge}`);
    check('a run that asks about a waiting spec rides in the spec\'s row, not a row of its own', s.also.length >= 1 && s.also.every((id) => id.startsWith('proposal:')), s.also.join(', '));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'inbox.png') });

    // D6: by keyboard
    await page.focus('[data-corn="inbox"] [data-inbox-open][tabindex="0"]');
    s = await inboxNow(page);
    const first = s.rows[0];
    check('the first row takes the focus (one tab stop for the queue)', s.focused === first, `${s.focused}`);
    await page.keyboard.press('j'); await sleep(600);
    s = await inboxNow(page);
    check('J moves to the next row and selects it: the node panel opens on it', s.selected === s.rows[1] && s.focused === s.rows[1] && s.current.includes(s.rows[1]) && s.panel.length > 0, `${s.selected} · ${s.panel}`);
    await page.keyboard.press('k'); await sleep(600);
    s = await inboxNow(page);
    check('K moves back', s.selected === first);
    await page.click('[data-inbox-group="move"]'); await sleep(300);
    s = await inboxNow(page);
    check('a group\'s heading folds it', s.groups.find((g) => g.key === 'move') && !s.groups.find((g) => g.key === 'move').open);
    await page.click('[data-inbox-group="move"]'); await sleep(300);

    // D5: Around it
    const spec = s.also[0] || s.rows.find((id) => id.startsWith('proposal:'));
    await page.click(`[data-corn="row"][data-id="${spec}"] [data-inbox-open]`); await sleep(700);
    s = await inboxNow(page);
    check('picking a row shows Around it beside the queue: the work it is linked to, and the code it touches', !!s.around && s.around.work.length > 0 && s.around.code.length > 0, s.around ? `${s.around.work.length} linked, ${s.around.code.length} code` : 'none');
    const around = await page.evaluate(() => { const a = document.querySelector('[data-group="around"]').getBoundingClientRect(); const p = document.querySelector('#spec-drawer').getBoundingClientRect(); const q = document.querySelector('.hx-inbox-queue').getBoundingClientRect(); return { clear: a.right <= p.left + 1 && a.left >= q.right - 1 }; });
    check('Around it sits between the queue and the node panel, under neither', around.clear);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'inbox-picked.png') });
    const axeDark = await runAxe(page);
    check('axe: no violation in the Inbox with a row picked (dark)', axeDark.length === 0, axeDark.join(' | '));
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); await sleep(300);
    const axeLight = await runAxe(page);
    check('axe: none in light', axeLight.length === 0, axeLight.join(' | '));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'inbox-light.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });

    const linked = s.around.work[0];
    await page.click(`[data-inbox-around="${linked}"]`); await sleep(600);
    s = await inboxNow(page);
    check('a piece of work in Around it selects it', s.selected === linked, `${s.selected}`);
    await page.click(`[data-corn="row"][data-id="${spec}"] [data-inbox-open]`); await sleep(600);
    await page.click('[data-inbox-graph]'); await sleep(900);
    s = await inboxNow(page);
    check('Show in Graph switches to the Graph with the selection kept', s.as === 'graph' && !s.shown && s.selected === spec && s.waitingShown);
    await page.keyboard.press('Escape'); await page.locator('body').click({ position: { x: 5, y: 890 } }).catch(() => {});
    await page.keyboard.press('g'); await sleep(600);
    s = await inboxNow(page);
    check('G switches back to the Inbox', s.as === 'inbox' && s.shown);
    await page.click(`[data-corn="row"][data-id="${spec}"] [data-inbox-open]`); await sleep(600);
    s = await inboxNow(page);
    const code = s.around.code[0];
    await page.click(`[data-inbox-map="${CSSescape(code)}"]`); await sleep(900);
    s = await inboxNow(page);
    check('a node of code in Around it shows it on the map, selected', s.view !== 'work' && s.selected === code, `${s.view} · ${s.selected}`);

    // A row's action: the node panel's own first action, pressed
    await page.click('#preset-work-btn'); await page.waitForSelector('[data-corn="inbox"]:not([hidden]) [data-corn="row"]', { timeout: 30_000 }); await sleep(500);
    const failing = await page.evaluate(() => { const r = [...document.querySelectorAll('[data-corn="inbox"] [data-corn="row"]')].find((x) => x.dataset.id.startsWith('pull:') && x.querySelector('[data-inbox-act]')); return r ? r.dataset.id : null; });
    if (failing) {
      // the press is seen where it lands: a click on a button of the node panel's action bar
      await page.evaluate(() => { window.__pressed = ''; document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('[data-corn="node-panel"] button'); if (b) window.__pressed = b.textContent.trim(); }, true); });
      await page.click(`[data-corn="row"][data-id="${failing}"] [data-inbox-act]`, { force: true });
      const pressed = await until(page, () => !!window.__pressed, null, 10_000);
      const which = await page.evaluate(() => window.__pressed);
      s = await inboxNow(page);
      check('Re-run failed presses the failed check\'s Re-run in the node panel (not the first control there, which opens the forge)', s.selected === failing && pressed && /^re-?run/i.test(which), `${failing} · pressed "${which}"`);
    } else check('a pull request with failed checks has a row with its action', false);
    // a run that is done lands its pull request: the pull request is what is selected
    const doneRun = await page.evaluate(() => { const r = [...document.querySelectorAll('[data-corn="inbox"] [data-corn="row"]')].find((x) => x.dataset.id.startsWith('run:') && /^Land PR #\d+$/.test(x.querySelector('[data-inbox-act]')?.textContent || '')); return r ? { id: r.dataset.id, n: /#(\d+)/.exec(r.querySelector('[data-inbox-act]').textContent)[1] } : null; });
    if (doneRun) {
      await page.click(`[data-corn="row"][data-id="${doneRun.id}"] [data-inbox-act]`, { force: true }); await sleep(1500);
      s = await inboxNow(page);
      check('a done run\'s Land PR #n selects that pull request, where Land it is', s.selected === `pull:${doneRun.n}`, `${doneRun.id} -> ${s.selected}`);
      await page.keyboard.press('Escape');
    } else {
      // the rig's done run points at PR #14, which the graph does not hold: nothing here can land it, so the row says so and offers no button
      const row = await page.evaluate(() => { const r = [...document.querySelectorAll('[data-corn="inbox"] [data-corn="row"]')].find((x) => x.dataset.id.startsWith('run:') && /^Done: PR #\d+ is open/.test(x.querySelector('.hx-inbox-why')?.textContent || '')); return r ? { id: r.dataset.id, act: !!r.querySelector('[data-inbox-act]') } : null; });
      check('a done run whose pull request the graph does not hold says so, with no Land button', !!row && !row.act, JSON.stringify(row));
    }
    // Land it that cannot be done yet says why, and presses nothing
    const approved = await page.evaluate(() => { const r = [...document.querySelectorAll('[data-corn="inbox"] [data-corn="row"]')].find((x) => x.dataset.id.startsWith('proposal:') && (x.querySelector('[data-inbox-act]')?.textContent || '') === 'Land it'); return r ? r.dataset.id : null; });
    if (approved) {
      await page.evaluate(() => { window.__pressed = ''; });
      await page.click(`[data-corn="row"][data-id="${approved}"] [data-inbox-act]`, { force: true });
      await until(page, () => document.activeElement && document.activeElement.matches('[data-forge-merge]') || /land|check|wait/i.test(document.querySelector('#map-announcer')?.textContent || ''), null, 5_000);
      const said = await page.evaluate(() => ({ live: document.querySelector('#map-announcer')?.textContent || '', pressed: window.__pressed, off: !!document.querySelector('[data-corn="node-panel"] [data-forge-merge][disabled]') }));
      check('a Land it that cannot be done yet is not pressed, and says why', (!said.off || !said.pressed) && (said.off ? /land|check|wait|finish/i.test(said.live) : true), `${approved} · ${said.live.slice(0, 90)}`);
    }

    // D1: remembered, and the address
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('g'); await sleep(400);
    await page.reload(); await page.waitForSelector('#preset-work-btn:not([hidden])'); await page.click('#preset-work-btn'); await sleep(2500);
    s = await inboxNow(page);
    check('the choice of Graph is remembered across a reload', s.as === 'graph' && !s.shown);
    await page.keyboard.press('g'); await sleep(400);
    await page.goto(`${BASE}/?view=work&as=graph`); await until(page, async () => (await import('/explorer/state.js')).state.view === 'work', null, 60_000); await sleep(1500);
    s = await inboxNow(page);
    check('?view=work&as=graph opens the Graph', s.as === 'graph' && !s.shown);

    // D8: a phone
    const phoneCtx = await newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: 'dark' });
    const phone = await phoneCtx.newPage();
    listen(phone);
    await phone.goto(`${BASE}/?view=work&as=inbox`);
    await phone.waitForSelector('[data-corn="inbox"]:not([hidden]) [data-corn="row"]', { timeout: 60_000 }); await sleep(600);
    const fit = await phone.evaluate(() => {
      const q = document.querySelector('.hx-inbox-queue').getBoundingClientRect();
      const bars = ['[data-corn="view-controls"]', '.hx-layers-chip'].map((x) => document.querySelector(x)).filter((e) => e && e.offsetParent !== null).map((e) => e.getBoundingClientRect().bottom);
      return { under: bars.every((b) => q.top >= b - 1), wide: document.documentElement.scrollWidth <= window.innerWidth + 1, full: q.width >= document.documentElement.clientWidth - 2, q: Math.round(q.width), vw: document.documentElement.clientWidth, iw: window.innerWidth };
    });
    check('on a phone the queue takes the width, under the Layers chip and the view\'s controls, nothing wider than the screen', fit.under && fit.wide && fit.full, JSON.stringify(fit));
    if (SHOTS) await phone.screenshot({ path: path.join(SHOTS, 'inbox-phone.png') });
    const axePhone = await runAxe(phone);
    check('axe: none on a phone', axePhone.length === 0, axePhone.join(' | '));

    check('no page error', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    rig.stop();
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`);
  if (failed.length) process.exit(1);
}

/** CSS.escape for an attribute value written in a selector here (ids of code hold slashes and colons) */
function CSSescape(v) { return String(v).replace(/["\\]/g, '\\$&'); }

main().catch((e) => { console.error(e); process.exit(1); });
