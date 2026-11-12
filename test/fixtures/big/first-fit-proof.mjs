/**
 * Issue #253: the map's first fit against a stage whose box is not final. Runs by hand, needs Playwright and Chromium and nothing else: it serves the
 * synthetic rig itself (serve.js, loopback, ports 3940-3949), or reads one that is already up (`--url`, for another checkout: the proof is how 0.50.1 fails).
 *
 *   node test/fixtures/big/first-fit-proof.mjs [--url http://127.0.0.1:3981/] [--port 3940] [--components]
 *
 * The page is opened in a view of 2x2 CSS px (what an embedded pane has until its app sizes it). As soon as the map has its topology (and so, before the fix,
 * has been fitted once), the view is given its size. The map must then be centred in the stage, to within a few pixels, and
 * fill it: on 0.50.1 it stays where the first fit put it, tiny at the top left. Cases: 1024x768 at a device pixel ratio of 1.25 and 1, 1440x900, and a
 * phone, 390x844. With `--components` (the package built: `cd components && npm ci && npm run build`) a `<corn-map>` in a box of 300x200 that is then
 * given 900x600 must have its labels centred in the new box (judged from a screenshot: dark pixels are the labels). Then a person pans, and a view of another size must keep the pan; and a real resize with the camera untouched fits again.
 * Exits 1 when a case fails.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const TOL = 8; // px

async function loadPlaywright() {
  const tries = ['playwright', ...(process.env.PLAYWRIGHT_DIR ? [pathToFileURL(path.join(process.env.PLAYWRIGHT_DIR, 'index.mjs')).href] : []), '/opt/node-tools/node_modules/playwright/index.mjs'];
  for (const t of tries) { try { return await import(t); } catch { /* next */ } }
  throw new Error('Playwright is not installed: set PLAYWRIGHT_DIR to its folder.');
}

async function startRig(port) {
  const child = spawn(process.execPath, [path.join(HERE, 'serve.js'), '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/topology.json`)).ok) break; } catch { /* not yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error('the rig did not start'); }
    await new Promise((r) => setTimeout(r, 200));
  }
  return child;
}

/** Where the map is on screen: the box its nodes fill, against the stage */
const read = (page) => page.evaluate(async () => {
  const { state: s } = await import('/explorer/state.js');
  const c = s.camera;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of s.nodes) { const x = n.x * c.zoom + c.x, y = n.y * c.zoom + c.y; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const box = s.canvas.parentElement;
  return { camera: [c.x, c.y, c.zoom], stage: [box.clientWidth, box.clientHeight], bbox: [x0, y0, x1, y1], width: s.width, height: s.height };
});
const centred = (r) => {
  const [w, h] = r.stage; const [x0, y0, x1, y1] = r.bbox;
  const dx = (x0 + x1) / 2 - w / 2, dy = (y0 + y1) / 2 - h / 2;
  const fills = (x1 - x0) > w * 0.5 || (y1 - y0) > h * 0.5;
  return { ok: Math.abs(dx) <= TOL && Math.abs(dy) <= TOL + 20 && fills && x0 >= 0 && x1 <= w, dx: Math.round(dx), dy: Math.round(dy), fills };
};

/** The box the dark pixels of an 8-bit PNG fill: [x0, y0, x1, y1] (just enough of a decoder: no interlacing, every filter) */
function darkBox(png) {
  let pos = 8, w = 0, h = 0, channels = 4; const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos); const type = png.toString('latin1', pos + 4, pos + 8); const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); channels = data[9] === 2 ? 3 : 4; }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)); const stride = w * channels; const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0; const b = y ? px[(y - 1) * stride + x] : 0; const c = x >= channels && y ? px[(y - 1) * stride + x - channels] : 0;
      const pr = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : (() => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; })();
      px[y * stride + x] = (row[x] + pr) & 255;
    }
  }
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * stride + x * channels; if (px[i] + px[i + 1] + px[i + 2] < 3 * 110) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
  return { w, h, x0, y0, x1, y1 };
}

/** A `<corn-map>` (the built package) in a box that is 300x200 when it gets its topology and 900x600 afterwards */
async function componentCase(browser) {
  const root = path.join(HERE, '..', '..', '..', 'components');
  if (!fs.existsSync(path.join(root, 'dist', 'index.js'))) throw new Error('build the package first: cd components && npm ci && npm run build');
  const topology = Buffer.from(await (await fetch(new URL('/topology.json', url))).arrayBuffer());
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  const srv = http.createServer((q, r) => {
    const u = q.url.split('?')[0];
    if (u === '/') { r.setHeader('content-type', 'text/html'); return r.end('<!doctype html><body style="margin:0"><div id="w" style="width:300px;height:200px"><corn-map id="m" theme="light" style="display:block;width:100%;height:100%"></corn-map></div><script type="module">import "/dist/index.js"; window.go = async () => { document.getElementById("m").topology = await (await fetch("/t.json")).json(); };</script>'); }
    if (u === '/t.json') { r.setHeader('content-type', 'application/json'); return r.end(topology); }
    const f = path.join(root, u);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.statusCode = 404; return r.end(); }
    r.setHeader('content-type', types[path.extname(f)] || 'application/octet-stream'); r.end(fs.readFileSync(f));
  }).listen(3941, '127.0.0.1');
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.goto('http://127.0.0.1:3941/');
    await page.evaluate(() => window.go());
    await page.waitForTimeout(1500);
    await page.evaluate(() => { const w = document.getElementById('w'); w.style.width = '900px'; w.style.height = '600px'; });
    await page.waitForTimeout(1200);
    const d = darkBox(await (await page.$('#w')).screenshot());
    const dx = (d.x0 + d.x1) / 2 - d.w / 2, dy = (d.y0 + d.y1) / 2 - d.h / 2;
    report('<corn-map> given a larger box after its first fit', Math.abs(dx) < d.w * 0.08 && Math.abs(dy) < d.h * 0.12 && d.x1 - d.x0 > d.w * 0.6, `labels fill ${d.x0},${d.y0} to ${d.x1},${d.y1} of ${d.w}x${d.h}`);
  } finally { srv.close(); }
}

const url = arg('url') || `http://127.0.0.1:${arg('port') || 3940}/`;
let rig = null;
if (!arg('url')) rig = await startRig(+(arg('port') || 3940));
const { chromium } = await loadPlaywright();
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
let failed = 0;
const report = (name, ok, detail) => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  ${detail}`); };

try {
  const sizes = [[1024, 768, 1.25], [1024, 768, 1], [1440, 900, 1], [390, 844, 3]];
  for (const [w, h, dpr] of sizes) {
    const ctx = await browser.newContext({ viewport: { width: 2, height: 2 }, deviceScaleFactor: dpr });
    const page = await ctx.newPage();
    await page.addInitScript(() => { import('/explorer/state.js').then((m) => { window.__state = m.state; }); });
    await page.goto(url, { waitUntil: 'commit' });
    await page.waitForFunction(() => { const s = window.__state; return !!s && s.nodes.length > 0; }, null, { timeout: 30_000, polling: 10 }); // the map has its topology (on 0.50.1 it is fitted to the 2x2 view in the same task)
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(1200);
    const r = await read(page);
    const c = centred(r);
    report(`sized after the first fit, ${w}x${h} at ${dpr}`, c.ok, `camera ${r.camera.map((v) => v.toFixed(2))}, stage ${r.stage}, off centre ${c.dx},${c.dy}`);
    if (w === 1024 && dpr === 1.25) {
      // a person pans: a new size keeps their view
      await page.evaluate(async () => { const { state: s } = await import('/explorer/state.js'); s.camera.x += 90; s.camera.y += 30; });
      const panned = (await read(page)).camera;
      await page.setViewportSize({ width: 900, height: 600 });
      await page.waitForTimeout(800);
      const after = (await read(page)).camera;
      report('a pan is kept by a new size', panned.every((v, i) => Math.abs(v - after[i]) < 1e-6), `camera ${panned.map((v) => v.toFixed(2))} -> ${after.map((v) => v.toFixed(2))}`);
    }
    await ctx.close();
  }
  { // the page loads at its size: nothing moves, a resize event changes nothing
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1.25 });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForTimeout(2500);
    const a = await read(page);
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(500);
    const b = await read(page);
    report('the normal load is centred and a resize event keeps it', centred(a).ok && a.camera.every((v, i) => v === b.camera[i]), `camera ${a.camera.map((v) => v.toFixed(2))}`);
    await ctx.close();
  }
  if (process.argv.includes('--components')) await componentCase(browser);
} finally {
  await browser.close();
  if (rig) rig.kill();
}
console.log(failed ? `${failed} case(s) failed` : 'all cases hold');
process.exit(failed ? 1 : 0);
