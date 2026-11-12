/**
 * The requests of a decision in `<corn-review>` are the requests cornfield's own page sends for the same steps (spec 0011 D1, D9: one engine, so the
 * server cannot tell which asked): this runs the same steps on both, records every request each script sends and what the person sees after each step, and
 * compares them. The allowed difference is exactly the two things another origin needs: the address is absolute (`origin=<the server>` for `origin=self`)
 * and the session is asked for (`credentials: 'include'`). Runs by hand: Playwright, Chromium, the built package; ports 3930 to 3939.
 *
 *   node test/fixtures/big/review-requests.mjs [--only approve,sendback,stale,refusals,signedout] [--json <file>]
 *
 * Two fresh rigs: cornfield's own page on 127.0.0.1:3930 (forge 4030), and the server for the host page on map.corn.localhost:3932 (forge 4032), which lists
 * the host page on tasks.corn.localhost:3933 (it loads corn-review.js from the server). Each step records: every fetch of the page's script (method, path,
 * query, headers, body, cache and credentials), each live region's text, where the focus is, and the words of the decision's foot. The steps are Approve
 * (the hold, Undo, the landing, a repeat press), Send back with a note, a push since it was shown, each refusal the server can answer (409, 403, 429, 500,
 * no answer), and a session that ended.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE = path.join(HERE, 'serve.js');
const PAGE = { base: 'http://127.0.0.1:3930', port: 3930, forge: 4030 };
const TAG = { base: 'http://map.corn.localhost:3932', port: 3932, forge: 4032, host: 'http://tasks.corn.localhost:3933', hostPort: 3933 };
const SL = ['0100-new-flow-across-apps', '0101-alerts-to-people', '0102-retire-a-feed', '0103-swap-a-provider', '0104-shared-component', '0105-second-site'];
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const only = arg('--only') ? arg('--only').split(',') : null;
const run = (name) => !only || only.includes(name);

async function loadPlaywright() {
  const tries = ['playwright', ...(process.env.PLAYWRIGHT_DIR ? [pathToFileURL(path.join(process.env.PLAYWRIGHT_DIR, 'index.mjs')).href] : []), '/opt/node-tools/node_modules/playwright/index.mjs'];
  for (const t of tries) { try { return await import(t); } catch { /* next */ } }
  throw new Error('Playwright is not installed: set PLAYWRIGHT_DIR to its folder.');
}

function startRig(name, args) {
  const child = spawn(process.execPath, [SERVE, '--forge', '--dir', path.join(os.tmpdir(), `cornfield-review-requests-${name}`), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`${name} did not start:\n${out}`)), 90_000);
    const see = (d) => { out += d; if (out.includes('Ctrl-C stops it')) { clearTimeout(timer); resolve(() => child.kill('SIGTERM')); } };
    child.stdout.on('data', see);
    child.stderr.on('data', see);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${name} exited (${code}):\n${out}`)); });
  });
}

/** The host page: it loads the tag from the server and puts it in the box the proof uses; nothing else (the recorder is the browser context's) */
function hostPage() {
  const policy = `default-src 'self'; script-src 'self' ${TAG.base}; connect-src 'self' ${TAG.base}; img-src 'self' data: ${TAG.base}; style-src 'self'`;
  const server = http.createServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    if (new URL(req.url, 'http://x').pathname === '/host.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(`const el = document.createElement('corn-review'); el.setAttribute('src', '${TAG.base}'); el.setAttribute('proposal', ${JSON.stringify(q.get('p') || '')}); el.setAttribute('source', ${JSON.stringify(q.get('s') || '')}); const box = document.querySelector('#box'); box.append(el); window.__tag = el;`); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': policy });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>host</title><link rel="stylesheet" href="/host.css"><script type="module" src="${TAG.base}/cornfield/components/corn-review.js"></script><script type="module" src="/host.js?${new URLSearchParams({ p: q.get('p') || '', s: q.get('s') || '' })}"></script></head><body><div id="box" style="width:1100px;height:680px"></div></body></html>`);
  });
  return new Promise((resolve) => server.listen(TAG.hostPort, '127.0.0.1', () => resolve(server)));
}

/** In every page: the fetch calls the page's script makes, the live regions' texts (a shadow root is watched from its first moment) */
const INIT = () => {
  window.__log = [];
  window.__R = () => (document.querySelector('corn-review') ? document.querySelector('corn-review').shadowRoot : document);
  const keep = (u) => { let p; try { p = new URL(u, location.href); } catch { return true; } return !(/\.(png|svg|woff2?|css|js|map)$/.test(p.pathname) || p.pathname.startsWith('/explorer/') || p.pathname.startsWith('/core/') || p.pathname.startsWith('/cornfield/') || p.pathname === '/topology.json'); };
  const of = window.fetch;
  window.fetch = function (input, init) {
    let url = ''; try { url = typeof input === 'string' ? input : String(input.url || input); } catch { url = ''; }
    if (keep(url)) {
      const p = new URL(url, location.href);
      const h = init && init.headers ? JSON.stringify(init.headers) : '';
      window.__log.push(`FETCH ${(init && init.method) || 'GET'} ${(p.pathname + p.search).replace(/[?&]v=\d+/, '')} origin=${p.origin === location.origin ? 'self' : p.origin} cred=${init && 'credentials' in init ? init.credentials : '-'} cache=${(init && init.cache) || '-'} h=${h} body=${init && init.body !== undefined ? init.body : '-'} keys=${init ? Object.keys(init).filter((k) => k !== 'credentials').join(',') : '-'}`);
    }
    return of.apply(this, arguments);
  };
  const live = (n) => n && (n.nodeType === 1 ? n : n.parentElement)?.closest?.('[role=status],[role=alert],[aria-live]');
  const seen = new Map();
  const mo = new MutationObserver((ms) => {
    for (const m of ms) {
      const el = live(m.target);
      if (!el) continue;
      const text = (el.textContent || '').trim();
      const key = el.id || el.getAttribute('data-corn') || [...el.attributes].map((a) => a.name).filter((n) => n.startsWith('data-')).join('|') || el.className;
      if (seen.get(el) === text) continue;
      seen.set(el, text);
      if (text) window.__log.push(`LIVE ${key}: ${text.slice(0, 160)}`);
    }
  });
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (o) { const r = attach.call(this, o); mo.observe(r, { subtree: true, childList: true, characterData: true }); return r; };
  document.addEventListener('DOMContentLoaded', () => mo.observe(document.body, { subtree: true, childList: true, characterData: true }));
};

async function record(chromium, kind, steps) {
  const tag = kind === 'tag';
  const rig = tag ? TAG : PAGE;
  const forge = (p) => fetch(`http://127.0.0.1:${rig.forge}${p}`).then((r) => r.text()).catch(() => '');
  const browser = await chromium.launch({ args: ['--disable-accelerated-2d-canvas'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => console.log(`[${kind}] PAGEERROR ${e.message}`));
  const out = [];
  const wait = (ms) => page.waitForTimeout(ms);
  async function snap(name) {
    const d = await page.evaluate(() => {
      const R = window.__R();
      let ae = R.activeElement || null;
      if (ae === document.body) ae = null;
      const desc = (e) => (e ? `${e.tagName.toLowerCase()}#${e.id}[${e.getAttribute('data-review') || e.getAttribute('data-action') || (e.hasAttribute('data-review-undo') ? 'undo' : '') || ''}] ${(e.textContent || '').trim().slice(0, 40)}` : null);
      const foot = R.getElementById('review-decision');
      const txt = (sel) => { const e = R.querySelector(sel); return e ? `${e.closest('[hidden]') ? '(hidden) ' : ''}${(e.textContent || '').trim()}` : null; };
      const btn = (sel) => { const e = R.querySelector(sel); return e ? `${e.textContent.trim()} dis=${e.getAttribute('aria-disabled')} desc=${e.getAttribute('aria-describedby')} hid=${!!e.closest('[hidden]')}` : null; };
      const log = window.__log.splice(0);
      return {
        focus: desc(ae),
        words: {
          approve: btn('[data-review="approved"]'), send: btn('[data-review="notes"]'), undo: btn('[data-review-undo]'),
          verdict: txt('[data-review-verdict]'), when: txt('[data-review-when]'), line: txt('[data-review-line]'), ask: txt('[data-review-ask]'), msg: txt('[data-review-msg]'), hint: txt('[data-review-hint]'),
          loadfail: txt('[data-review-loadfail]'), landing: txt('[data-review-landing]'), sent: txt('[data-review-sent]'), note: R.getElementById('review-note')?.value ?? null,
          title: txt('#proposal-title'), message: txt('#proposal-message'), footHidden: foot ? (foot.closest('[hidden]') ? 'hidden' : 'shown') : 'none',
        },
        log,
      };
    });
    out.push({ name, ...d });
    console.log(`[${kind}] ${name}`);
  }
  const opened = () => page.waitForFunction(() => { const R = window.__R(); const b = R.getElementById('proposal-body'); const t = R.getElementById('proposal-title'); return b && !b.hidden && t && t.textContent; }, null, { timeout: 25000 }).catch(() => {});
  const factsRead = () => page.waitForFunction(() => { const l = window.__R().querySelector('[data-review-line]'); return l && l.textContent && !/Reading|Checking/i.test(l.textContent); }, null, { timeout: 15000 }).catch(() => {});
  const byAddress = async (slug, pr) => {
    if (tag) await page.goto(`${TAG.host}/?p=${slug}&s=pull/${pr}`, { waitUntil: 'networkidle' });
    else await page.goto(`${PAGE.base}/?proposal=${slug}&source=pull/${pr}`, { waitUntil: 'networkidle' });
    await opened(); await factsRead(); await wait(500);
  };
  const press = (sel) => page.click(tag ? `corn-review >> ${sel}` : sel, { force: true }).catch(() => {});
  const putRoute = (fn) => page.route(/\/proposals\/[^/]+\/review/, async (route) => { if (route.request().method() !== 'PUT') return route.continue(); return fn(route); });
  const answer = (status, error) => (route) => route.fulfill({ status, contentType: 'application/json', headers: tag ? { 'Access-Control-Allow-Origin': TAG.host, 'Access-Control-Allow-Credentials': 'true' } : {}, body: JSON.stringify(error ? { error } : {}) });

  await forge('/__rig/runner?state=online');
  for (const pr of [21, 22, 23, 24, 25, 26]) await forge(`/__rig/checks?pr=${pr}&state=passed`);
  await page.goto(`${rig.base}/auth/start`, { waitUntil: 'networkidle' });
  const S = { forge, wait, snap, byAddress, press, putRoute, answer, page, ctx, sl: SL, factsRead };
  for (const [name, fn] of steps) if (run(name)) await fn(S);
  await browser.close();
  return out;
}

const STEPS = [
  ['approve', async ({ byAddress, press, snap, wait }) => {
    await byAddress(SL[0], 21); await snap('A open 0100');
    await press('[data-review="approved"]'); await wait(300); await snap('A hold');
    await press('[data-review-undo]'); await wait(400); await snap('A undo');
    await press('[data-review="approved"]'); await wait(1200); await snap('A hold again');
    await wait(5000); await snap('A landed');
    await wait(1000); await snap('A landed settled');
    await press('[data-review="approved"]'); await wait(800); await snap('A repeat press (done)');
  }],
  ['sendback', async ({ byAddress, press, snap, wait, page }) => {
    await byAddress(SL[1], 22);
    await press('[data-review="notes"]'); await wait(300); await snap('S note open');
    await page.keyboard.type('Please name the provider <b>first</b> & "quote".'); await wait(200);
    await press('[data-review="notes"]'); await wait(400); await snap('S hold or ask');
    if (await page.$('[data-review-ask]:not([hidden])') || await page.$('corn-review >> [data-review-ask]:not([hidden])')) { await press('[data-review="notes"]'); await wait(400); await snap('S hold'); }
    await wait(5600); await snap('S sent');
    await wait(800); await snap('S settled');
  }],
  ['stale', async ({ byAddress, press, snap, wait, forge, page }) => {
    await byAddress(SL[4], 25);
    await forge('/__rig/pull?pr=25&push=file');
    await press('[data-review="approved"]'); await wait(400);
    if (await page.$('corn-review >> [data-review-ask]:not([hidden])') || await page.$('[data-review-ask]:not([hidden])')) await press('[data-review="approved"]');
    await wait(6000); await snap('T stale at end of hold'); await wait(1000); await snap('T stale settled');
  }],
  ['refusals', async ({ byAddress, press, snap, wait, putRoute, answer, page }) => {
    for (const [status, error] of [[409, 'The proposal changed since you opened it.'], [403, 'Only a maintainer can review.'], [429, 'Too many.'], [500, '']]) {
      await byAddress(SL[3], 24);
      await putRoute(answer(status, error));
      await press('[data-review="approved"]'); await wait(6000); await snap(`R ${status}`); await wait(800); await snap(`R ${status} settled`);
      await page.unroute(/\/proposals\/[^/]+\/review/);
    }
    await byAddress(SL[3], 24);
    await putRoute((route) => route.abort());
    await press('[data-review="approved"]'); await wait(6000); await snap('R no answer');
    await page.unroute(/\/proposals\/[^/]+\/review/);
  }],
  ['signedout', async ({ byAddress, press, snap, wait, ctx, page }) => {
    await byAddress(SL[2], 23);
    await ctx.clearCookies();
    await press('[data-review="approved"]'); await wait(6000); await snap('U signed out'); await wait(800); await snap('U settled');
    void page;
  }],
];

/** The allowed difference: the address absolute to the server and the session asked for */
const norm = (l) => l
  .replace(/ origin=\S+ cred=\S+/, ' <origin,cred>')
  .replace(/"at":"[^"]+"/g, '"at":"<t>"')
  .replace(/\d+ (seconds?|minutes?) ago/g, '<ago>')
  .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '<hh:mm>');

function compare(a, b) {
  const creds = { page: new Set(), tag: new Set() };
  for (const [k, list] of [['page', a], ['tag', b]]) for (const s of list) for (const l of s.log) { const m = / origin=(\S+) cred=(\S+)/.exec(l); if (m) creds[k].add(`${m[1].replace(/:\d+$/, ':<port>')} ${m[2]}`); }
  console.log('origin,cred page:', [...creds.page], ' tag:', [...creds.tag]);
  const byName = new Map(b.map((s) => [s.name, s]));
  let diffs = 0;
  let compared = 0;
  const ours = (l) => !/\/mockups\?/.test(l) && (!l.startsWith('FETCH') || /\/proposals\/|\/landing|\/decision/.test(l)); // the page's own other pieces make requests of their own (forge lists, mockups): only the decision's routes are compared
  for (const s of a) {
    const t = byName.get(s.name);
    if (!t) { console.log(`MISSING in the tag: ${s.name}`); diffs++; continue; }
    const out = [];
    const fa = s.log.filter((l) => !l.startsWith('EVENT')).map(norm).filter(ours);
    const fb = t.log.filter((l) => !l.startsWith('EVENT')).map(norm).filter(ours);
    compared += fa.length;
    if (JSON.stringify(fa) !== JSON.stringify(fb)) out.push(`  log page:\n    ${fa.join('\n    ')}\n  log tag:\n    ${fb.join('\n    ')}`);
    if (s.focus !== t.focus) out.push(`  focus page=${s.focus} tag=${t.focus}`);
    for (const k of Object.keys(s.words)) if (norm(String(s.words[k])) !== norm(String(t.words[k]))) out.push(`  ${k}: page=${JSON.stringify(s.words[k])} tag=${JSON.stringify(t.words[k])}`);
    if (out.length) { diffs++; console.log(`== ${s.name}\n${out.join('\n')}`); }
  }
  for (const s of b) if (!a.find((x) => x.name === s.name)) console.log(`tag only: ${s.name}`);
  console.log(`\n${a.length} page steps, ${b.length} tag steps, ${compared} requests of the decision compared, ${diffs} steps differ`);
  return diffs;
}

async function main() {
  const { chromium } = await loadPlaywright();
  const stops = [];
  let host;
  try {
    stops.push(await startRig('page', ['--port', String(PAGE.port), '--forge-port', String(PAGE.forge)]));
    stops.push(await startRig('tag', ['--port', String(TAG.port), '--forge-port', String(TAG.forge), '--public', TAG.base, '--embed', TAG.host]));
    host = await hostPage();
    const page = await record(chromium, 'page', STEPS);
    const tag = await record(chromium, 'tag', STEPS);
    const json = arg('--json');
    if (json) fs.writeFileSync(json, JSON.stringify({ page, tag }, null, 1));
    const diffs = compare(page, tag);
    if (diffs) process.exitCode = 1;
  } finally {
    if (host) host.close();
    stops.forEach((stop) => stop());
  }
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
