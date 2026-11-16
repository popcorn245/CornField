/**
 * Issue #285: the map's labels, and the Work layer's badges, when a theme's web font arrives late. Runs by hand, needs Playwright and Chromium and nothing else: it serves the synthetic rig itself
 * (serve.js with --forge --layers --theme retro, loopback, port 3990), or reads one that is already up (`--url`, for another checkout: that is how main fails it).
 *
 *   node test/fixtures/big/font-late-proof.mjs [--url http://127.0.0.1:3990/] [--port 3990] [--delay 4000] [--font <file.ttf>] [--shots <dir> --tag after]
 *
 * The retro theme's two fonts come from a font service. Both requests are answered here, so the run needs no network: the style sheet at once, the font file after `--delay` ms
 * (a local face, DejaVu Sans from the system's fonts, or `--font`: no font file is in the repository). Two cases: the fallback face the container has, and a narrow one (Carlito stands in for the theme's fallback, so the web font is much wider: the
 * case where stale widths put labels over each other; skipped, and said so, when Carlito is not installed). The label canvas is watched from the page: every text the label layer measures, and every
 * label it draws; so is every text measured on another canvas (the Work layer's badges measure the names and their own text on one of their own). The Work layer is on, as a visitor left it.
 *
 * Judged once the font has arrived and the page has settled, at the first fit and at three times the zoom:
 *   - re-measured: texts measured again after the font arrived (before the fix: none);
 *   - stale: the texts whose last measure differs from what the font now in use gives, and by how much (px at most);
 *   - overlaps: pairs of drawn labels whose boxes touch, each box measured now, in the face now in use;
 *   - the same for the badges: stale widths on the other canvases, and a pill over another pill or over a drawn label.
 * Exits 1 when a case has a stale width, a pair over another, no re-measuring, no badge in view, or a web font that measures every text like the fallback (a case that shows nothing).
 * Exits 2, saying SKIP, when there is no local face to serve as the web font. Not part of `npm test`: CI does not run it.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const DELAY = +(arg('delay') || 4000);
// System faces where the common distributions put them (Debian and Ubuntu, Fedora, Arch, Alpine): read, never copied into the repository
const WEB_FONT = [arg('font'), '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf'].find((f) => f && fs.existsSync(f));
const NARROW = ['/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf', '/usr/share/fonts/google-carlito-fonts/Carlito-Regular.ttf', '/usr/share/fonts/TTF/Carlito-Regular.ttf', '/usr/share/fonts/carlito/Carlito-Regular.ttf'].find((f) => fs.existsSync(f));

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
  const lp = { measured: [], other: [], frame: [], fontsAt: 0, internal: false };
  window.__lp = lp;
  const isLabels = (ctx) => ctx.canvas && ctx.canvas.getAttribute && ctx.canvas.getAttribute('data-corn') === 'label-canvas';
  const proto = CanvasRenderingContext2D.prototype;
  const { measureText, fillText, clearRect } = proto;
  proto.measureText = function (text) {
    const m = measureText.call(this, text);
    if (!lp.internal) (isLabels(this) ? lp.measured : lp.other).push({ text, font: this.font, w: m.width, at: performance.now() });
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
  lp.internal = true;
  const scratch = document.createElement('canvas').getContext('2d');
  const widthNow = (font, text) => { scratch.font = font; return scratch.measureText(text).width; };
  const staleOf = (list) => {
    const last = new Map();
    for (const m of list) last.set(`${m.font}|${m.text}`, m);
    let n = 0, max = 0, changed = 0;
    const firstOf = new Map();
    for (const m of list) if (!firstOf.has(`${m.font}|${m.text}`)) firstOf.set(`${m.font}|${m.text}`, m);
    for (const [k, m] of last) {
      const now = widthNow(m.font, m.text);
      const d = Math.abs(now - m.w);
      if (d > 0.01) n++;
      max = Math.max(max, d);
      if (Math.abs(now - firstOf.get(k).w) > 0.01) changed++; // the web font did change this text's width: the case is not a trivial one
    }
    return { n, max, changed };
  };
  const labelsStale = staleOf(lp.measured);
  const stale = labelsStale.n, maxStale = labelsStale.max;
  const boxes = lp.frame.map((f) => {
    const px = parseFloat(/([\d.]+)px/.exec(f.font)[1]) * f.k, w = widthNow(f.font, f.text) * f.k;
    const l = f.align === 'center' ? f.x - w / 2 : f.x;
    return { text: f.text, l, r: l + w, t: f.y - px * 0.8, b: f.y + px * 0.2 };
  });
  const touch = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  let overlaps = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (touch(boxes[i], boxes[j])) overlaps++;
  // The Work layer's pills (DOM, over the same stage as the label canvas): a pill over another, or over a drawn label, in the page's coordinates
  const at = document.querySelector('[data-corn="label-canvas"]').getBoundingClientRect();
  const pills = [...document.querySelectorAll('[data-corn="work-badge"]')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0)
    .map((r) => ({ l: r.left - at.left, r: r.right - at.left, t: r.top - at.top, b: r.bottom - at.top }))
    .filter((r) => r.r > 0 && r.l < at.width && r.b > 0 && r.t < at.height);
  let pillOverlaps = 0;
  for (let i = 0; i < pills.length; i++) {
    for (let j = i + 1; j < pills.length; j++) if (touch(pills[i], pills[j])) pillOverlaps++;
    for (const b of boxes) if (touch(pills[i], b)) pillOverlaps++;
  }
  const badgesStale = staleOf(lp.other);
  const late = (m) => m.at > lp.fontsAt && lp.fontsAt > 0;
  const after = lp.measured.filter(late).length;
  const before = new Set(lp.measured.filter((m) => !late(m)).map((m) => `${m.font}|${m.text}`)).size;
  lp.internal = false;
  return {
    drawn: boxes.length, measuredBefore: before, remeasured: after, stale, maxStale: +maxStale.toFixed(2), changed: labelsStale.changed, overlaps,
    pills: pills.length, otherBefore: new Set(lp.other.filter((m) => !late(m)).map((m) => `${m.font}|${m.text}`)).size, otherAfter: lp.other.filter(late).length,
    badgesStale: badgesStale.n, badgesMaxStale: +badgesStale.max.toFixed(2), pillOverlaps,
  };
}

const url = arg('url') || `http://127.0.0.1:${arg('port') || 3990}/`;
const base = url.replace(/\/$/, '');
if (!WEB_FONT) { console.error(`SKIP: no local face to serve as the theme's web font (DejaVu Sans is not where it was looked for${arg('font') ? `, nor ${arg('font')}` : ''}); pass --font <a .ttf>. Nothing was proven.`); process.exit(2); }
let rig = null;
if (!arg('url')) rig = await startRig(+(arg('port') || 3990));
const { chromium } = await loadPlaywright();
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
let failed = 0;
const skipped = [];

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
    await context.addInitScript(() => { try { localStorage.setItem('cornfield:layers', JSON.stringify({ 'work-badges': true })); } catch { /* none */ } }); // the Work layer on, as a visitor left it
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
    const ok = first.measuredBefore > 0 && first.remeasured > 0 && first.stale === 0 && first.overlaps === 0 && zoomed.stale === 0 && zoomed.overlaps === 0
      && first.otherBefore > 0 && first.pills + zoomed.pills > 0 && [first, zoomed].every((j) => j.badgesStale === 0 && j.pillOverlaps === 0);
    // a web font that measures like the fallback would prove nothing: the case says so and does not pass
    const trivial = first.changed === 0;
    if (!ok || trivial) failed++;
    console.log(`${trivial ? 'FAIL' : ok ? 'ok  ' : 'FAIL'} ${name}: font ${DELAY} ms late (${fontRequests} font requests)${trivial ? ': the web font measures every text like the fallback, so this case shows nothing' : ''}`);
    console.log(`       first fit  drawn ${first.drawn}, measured before ${first.measuredBefore} texts (${first.changed} of them wider or narrower in the web font), re-measured ${first.remeasured}, stale ${first.stale} (max ${first.maxStale} px), overlapping pairs ${first.overlaps}`);
    console.log(`                  work badges ${first.pills}; other canvases (the badges' measurer among them) measured before ${first.otherBefore} texts, re-measured ${first.otherAfter}, stale ${first.badgesStale} (max ${first.badgesMaxStale} px), a pill over a pill or a label ${first.pillOverlaps}`);
    console.log(`       zoom x${(zoom / zoom0).toFixed(2)}  drawn ${zoomed.drawn}, re-measured ${zoomed.remeasured}, stale ${zoomed.stale} (max ${zoomed.maxStale} px), overlapping pairs ${zoomed.overlaps}`);
    console.log(`                  work badges ${zoomed.pills}, re-measured ${zoomed.otherAfter}, stale ${zoomed.badgesStale} (max ${zoomed.badgesMaxStale} px), a pill over a pill or a label ${zoomed.pillOverlaps}`);
  } finally { await context.close(); }
}

try {
  await run('container-fallback', { narrow: false });
  if (NARROW) await run('narrow-fallback', { narrow: true });
  else { skipped.push('narrow-fallback: Carlito is not installed'); console.log(`SKIP narrow-fallback: Carlito is not installed`); }
} finally {
  await browser.close();
  if (rig) rig.kill();
}
console.log(`${failed ? `${failed} case(s) failed` : 'all cases that ran hold'}${skipped.length ? `; ${skipped.length} skipped (${skipped.join('; ')})` : ''}`);
process.exit(failed ? 1 : 0);
