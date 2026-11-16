/**
 * Issue #285: the map's labels when a theme's web font arrives late. Runs by hand, needs Playwright and Chromium and nothing else: it serves the synthetic rig itself
 * (serve.js with --forge --layers --theme retro, loopback, port 3990), or reads one that is already up (`--url`, for another checkout: that is how main fails it).
 *
 *   node test/fixtures/big/font-late-proof.mjs [--url http://127.0.0.1:3990/] [--port 3990] [--delay 4000] [--shots <dir> --tag after]
 *
 * The retro theme's two fonts come from a font service. Both requests are answered here, so the run needs no network: the style sheet at once, the font file after `--delay` ms
 * (a local face, wider than the fallback). Two cases: the fallback face the container has, and a narrow one (Carlito stands in for the theme's fallback, so the web font is much wider: the
 * case where stale widths put labels over each other; skipped when Carlito is not installed). The label canvas is watched from the page: every text the label layer measures, and every label it draws.
 *
 * Judged once the font has arrived and the page has settled, at the first fit and at three times the zoom:
 *   - re-measured: texts measured again after the font arrived (before the fix: none);
 *   - stale: the texts whose last measure differs from what the font now in use gives, and by how much (px at most);
 *   - overlaps: pairs of drawn labels whose boxes touch, each box measured now, in the face now in use.
 * Exits 1 when a case has a stale width, a pair over another, or no re-measuring.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const DELAY = +(arg('delay') || 4000);
const WEB_FONT = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf'].find((f) => fs.existsSync(f));
const NARROW = ['/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf'].find((f) => fs.existsSync(f));

async function loadPlaywright() {
  const tries = ['playwright', ...(process.env.PLAYWRIGHT_DIR ? [pathToFileURL(path.join(process.env.PLAYWRIGHT_DIR, 'index.mjs')).href] : []), '/opt/node-tools/node_modules/playwright/index.mjs'];
  for (const t of tries) { try { return await import(t); } catch { /* next */ } }
  throw new Error('Playwright is not installed: set PLAYWRIGHT_DIR to its folder.');
}

async function startRig(port) {
  const child = spawn(process.execPath, [path.join(HERE, 'serve.js'), '--forge', '--layers', '--theme', 'retro', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 40_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/topology.json`)).status) break; } catch { /* not yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error('the rig did not start'); }
    await new Promise((r) => setTimeout(r, 200));
  }
  return child;
}

/** In the page, before anything runs: watches the label canvas */
function watch() {
  const lp = { measured: [], frame: [], fontsAt: 0, internal: false };
  window.__lp = lp;
  const isLabels = (ctx) => ctx.canvas && ctx.canvas.getAttribute && ctx.canvas.getAttribute('data-corn') === 'label-canvas';
  const proto = CanvasRenderingContext2D.prototype;
  const { measureText, fillText, clearRect } = proto;
  proto.measureText = function (text) {
    const m = measureText.call(this, text);
    if (!lp.internal && isLabels(this)) lp.measured.push({ text, font: this.font, w: m.width, at: performance.now() });
    return m;
  };
  proto.clearRect = function (...a) { if (isLabels(this) && a[2] > 100) lp.frame = []; return clearRect.apply(this, a); };
  proto.fillText = function (text, x, y, ...rest) {
    if (isLabels(this)) { const t = this.getTransform(); lp.frame.push({ text, font: this.font, x: t.a * x + t.e, y: t.d * y + t.f, k: t.a, align: this.textAlign }); }
    return fillText.call(this, text, x, y, ...rest);
  };
  document.fonts.addEventListener('loadingdone', () => { lp.fontsAt = performance.now(); });
}
/** In the page: the verdict on what was watched */
function judge() {
  const lp = window.__lp;
  const scratch = document.createElement('canvas').getContext('2d');
  const widthNow = (font, text) => { scratch.font = font; return scratch.measureText(text).width; };
  const last = new Map();
  for (const m of lp.measured) last.set(`${m.font}|${m.text}`, m);
  let stale = 0, maxStale = 0;
  for (const m of last.values()) {
    const d = Math.abs(widthNow(m.font, m.text) - m.w);
    if (d > 0.01) stale++;
    maxStale = Math.max(maxStale, d);
  }
  const boxes = lp.frame.map((f) => {
    const px = parseFloat(/([\d.]+)px/.exec(f.font)[1]) * f.k, w = widthNow(f.font, f.text) * f.k;
    const l = f.align === 'center' ? f.x - w / 2 : f.x;
    return { text: f.text, l, r: l + w, t: f.y - px * 0.8, b: f.y + px * 0.2 };
  });
  let overlaps = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) overlaps++;
  }
  const after = lp.measured.filter((m) => m.at > lp.fontsAt && lp.fontsAt > 0).length;
  const before = new Set(lp.measured.filter((m) => !(m.at > lp.fontsAt && lp.fontsAt > 0)).map((m) => `${m.font}|${m.text}`)).size;
  return { drawn: boxes.length, measuredBefore: before, remeasured: after, stale, maxStale: +maxStale.toFixed(2), overlaps };
}

const url = arg('url') || `http://127.0.0.1:${arg('port') || 3990}/`;
const base = url.replace(/\/$/, '');
if (!WEB_FONT) { console.error('no local face to serve as the theme font (DejaVu Sans)'); process.exit(2); }
let rig = null;
if (!arg('url')) rig = await startRig(+(arg('port') || 3990));
const { chromium } = await loadPlaywright();
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
let failed = 0;

async function run(name, { narrow }, dsf = 1) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dsf, reducedMotion: 'reduce' });
  try {
    let fontRequests = 0;
    await context.route(/^https:\/\/fonts\.googleapis\.com\//, (route) => route.fulfill({
      contentType: 'text/css',
      body: ['Nunito', 'Pixelify Sans'].map((f) => `@font-face{font-family:'${f}';font-style:normal;font-weight:400 700;font-display:swap;src:url(https://fonts.gstatic.com/proof/${f.split(' ')[0]}.ttf) format('truetype');}`).join('\n'),
    }));
    await context.route(/^https:\/\/fonts\.gstatic\.com\//, async (route) => {
      fontRequests++;
      await new Promise((r) => setTimeout(r, DELAY));
      await route.fulfill({ contentType: 'font/ttf', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(WEB_FONT) });
    });
    if (narrow) { // the theme's fallback face, a system one, is Carlito (a system face is there at the first measure, a face from @font-face is not)
      await context.route(/\/theme\.css(\?|$)/, async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, body: (await res.text()).replaceAll('"Trebuchet MS"', 'Carlito') });
      });
    }
    await context.addInitScript(watch);
    const sign = await context.newPage(); await sign.goto(`${base}/auth/start`); await sign.waitForURL(`${base}/**`); await sign.close();
    const page = await context.newPage();
    await page.goto(`${base}/`);
    await page.waitForSelector('[data-corn="label-canvas"]', { state: 'attached', timeout: 30_000 });
    await page.waitForFunction(() => window.__lp.fontsAt > 0, null, { timeout: DELAY + 20_000 });
    await page.waitForTimeout(1200);
    const first = await page.evaluate(judge);
    const zoom0 = await page.evaluate(async () => (await import('/explorer/state.js')).state.camera.zoom);
    let zoomed = null;
    await page.mouse.move(640, 450);
    for (let i = 0; i < 40 && (await page.evaluate(async () => (await import('/explorer/state.js')).state.camera.zoom)) < zoom0 * 3; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(80); }
    await page.waitForTimeout(1200);
    zoomed = await page.evaluate(judge);
    const zoom = await page.evaluate(async () => (await import('/explorer/state.js')).state.camera.zoom);
    const shots = arg('shots');
    if (shots) {
      fs.mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, `${arg('tag') || 'run'}-${name}-zoomed.png`) });
    }
    const ok = first.measuredBefore > 0 && first.remeasured > 0 && first.stale === 0 && first.overlaps === 0 && zoomed.stale === 0 && zoomed.overlaps === 0;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: font ${DELAY} ms late (${fontRequests} font requests)`);
    console.log(`       first fit  drawn ${first.drawn}, measured before ${first.measuredBefore} texts, re-measured ${first.remeasured}, stale ${first.stale} (max ${first.maxStale} px), overlapping pairs ${first.overlaps}`);
    console.log(`       zoom x${(zoom / zoom0).toFixed(2)}  drawn ${zoomed.drawn}, re-measured ${zoomed.remeasured}, stale ${zoomed.stale} (max ${zoomed.maxStale} px), overlapping pairs ${zoomed.overlaps}`);
  } finally { await context.close(); }
}

try {
  await run('container-fallback', { narrow: false });
  if (NARROW) await run('narrow-fallback', { narrow: true });
  else console.log('skip narrow-fallback: Carlito is not installed');
} finally {
  await browser.close();
  if (rig) rig.kill();
}
console.log(failed ? `${failed} case(s) failed` : 'all cases hold');
process.exit(failed ? 1 : 0);
