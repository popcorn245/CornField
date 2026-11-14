/**
 * Sameness proof (spec 0012 step 4): with the Work layer off (the default) the Map and Flow views are pixel for pixel what they were before it, below the header, on a desktop and a phone, dark and
 * light, default and retro theme. Runs by hand: needs Playwright and Chromium, and a second checkout of the commit to compare with (`git worktree add /home/user/wt/<name> <sha>`).
 *
 *   node test/fixtures/big/sameness-proof.mjs --main <dir of the other checkout> [--port <n>]
 *
 * Starts the rig (signed in, with the fake forge) from each checkout, for each theme, takes the same screenshots of both (reduced motion, a fresh browser context each), and counts the pixels
 * that differ, in the page itself (a canvas compares them). It first compares the other checkout with itself, to say what noise there is. Exit code 1 when a pair differs.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const MAIN = arg('--main');
const PORT = Number(arg('--port') || 3900);
if (!MAIN) { console.error('--main <dir> is needed'); process.exit(2); }

const { chromium } = await (async () => { for (const t of ['playwright', pathToFileURL('/opt/node-tools/node_modules/playwright/index.mjs').href]) { try { return await import(t); } catch { /* next */ } } throw new Error('Playwright is not installed'); })();
function startRig(serve, port, theme) {
  const child = spawn(process.execPath, [serve, '--forge', '--layers', ...(theme ? ['--theme', theme] : []), '--port', String(port), '--forge-port', String(port + 1), '--dir', path.join(os.tmpdir(), `cornfield-same-${port}`)], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`the rig did not start:\n${out}`)); }, 90_000);
    const see = (d) => { out += d; if (out.includes('Ctrl-C stops it')) { clearTimeout(timer); resolve({ stop: () => child.kill('SIGTERM') }); } };
    child.stdout.on('data', see); child.stderr.on('data', see);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIZES = { desktop: { viewport: { width: 1440, height: 900 } }, phone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } };

async function shot(browser, base, size, scheme, view) {
  const context = await browser.newContext({ reducedMotion: 'reduce', colorScheme: scheme, ...SIZES[size] });
  try {
    const sign = await context.newPage(); await sign.goto(`${base}/auth/start`); await sign.waitForURL(`${base}/**`); await sign.close();
    const page = await context.newPage();
    await page.goto(`${base}/`);
    await page.waitForSelector('#preset-work-btn:not([hidden])', { timeout: 30_000 });
    await sleep(2500);
    if (view === 'flow') { await page.click('#preset-dataflow-btn'); await sleep(2500); }
    const top = await page.evaluate(() => Math.ceil(document.querySelector('[data-corn="header"]').getBoundingClientRect().bottom));
    const vp = SIZES[size].viewport;
    // the layer is off in both: the menu is shut and nothing is selected
    return { png: (await page.screenshot({ clip: { x: 0, y: top, width: vp.width, height: vp.height - top } })).toString('base64'), top };
  } finally { await context.close(); }
}

async function diff(browser, a, b) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ([x, y]) => {
      const load = async (b64) => { const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob(); const bmp = await createImageBitmap(blob); const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); return { w: bmp.width, h: bmp.height, d: g.getImageData(0, 0, bmp.width, bmp.height).data }; };
      const A = await load(x); const B = await load(y);
      if (A.w !== B.w || A.h !== B.h) return { differ: -1, total: 0, size: `${A.w}x${A.h} vs ${B.w}x${B.h}` };
      let n = 0;
      for (let i = 0; i < A.d.length; i += 4) if (A.d[i] !== B.d[i] || A.d[i + 1] !== B.d[i + 1] || A.d[i + 2] !== B.d[i + 2] || A.d[i + 3] !== B.d[i + 3]) n++;
      return { differ: n, total: A.w * A.h };
    }, [a, b]);
  } finally { await page.close(); }
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let bad = 0;
let pairs = 0;
let pixels = 0;
try {
  let port = PORT;
  for (const theme of [null, 'retro']) {
    const mainRig = await startRig(path.join(path.resolve(MAIN), 'test/fixtures/big/serve.js'), port, theme);
    const mineRig = await startRig(path.join(HERE, 'serve.js'), port + 10, theme);
    try {
      const baseA = `http://127.0.0.1:${port}`;
      const baseB = `http://127.0.0.1:${port + 10}`;
      for (const size of ['desktop', 'phone']) for (const scheme of ['dark', 'light']) for (const view of ['map', 'flow']) {
        const label = `${theme || 'default'} ${size} ${scheme} ${view}`;
        const a = await shot(browser, baseA, size, scheme, view);
        const b = await shot(browser, baseB, size, scheme, view);
        const d = await diff(browser, a.png, b.png);
        let noise = '';
        if (d.differ !== 0) { const a2 = await shot(browser, baseA, size, scheme, view); const n = await diff(browser, a.png, a2.png); noise = `; the other checkout against itself: ${n.differ}`; }
        pairs++; pixels += d.total || 0;
        if (d.differ !== 0) bad++;
        console.log(`${d.differ === 0 ? 'ok  ' : 'FAIL'} ${label}: ${d.differ} of ${d.total} pixels differ (below the header, from y=${a.top}${d.size ? `; ${d.size}` : ''}${noise})`);
      }
    } finally { mainRig.stop(); mineRig.stop(); }
    port += 20;
  }
} finally { await browser.close(); }
console.log(`\n${pairs - bad} of ${pairs} pairs identical (${pixels} pixels compared)`);
process.exit(bad ? 1 : 0);
