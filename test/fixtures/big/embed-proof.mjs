/**
 * The proof in a browser that a listed sibling origin can read and decide as the signed-in maintainer (spec 0011 D9, docs/embedding.md):
 * the session cookie travels on a same-site cross-origin request, and nothing else does. Runs by hand, needs Playwright and Chromium and no
 * network (everything is on 127.0.0.1; Chromium resolves `*.localhost` to loopback, so two names are two origins on one machine).
 *
 *   node test/fixtures/big/embed-proof.mjs [--json <file>]
 *
 * Two rigs (serve.js --forge --embed …) and three blank host pages, all on ports 3710 to 3729:
 *
 *   map.corn.localhost:3711    cornfield, lists only http://tasks.corn.localhost:3713
 *   map2.corn.localhost:3712   cornfield, also lists http://tasks.other.localhost:3715 (a different site)
 *   tasks.corn.localhost:3713  a host page on the same site (corn.localhost) as both, and listed
 *   tasks2.corn.localhost:3714 a host page on the same site, not listed
 *   tasks.other.localhost:3715 a host page on a different site (other.localhost), not listed by map, listed by map2
 *
 * The browser signs in on each cornfield, then each host page, with `fetch(..., { credentials: 'include' })`, asks for a gated read, the proposal
 * (to read its headers), a review PUT, and a write that is not allowed. What the browser sent (Cookie, Origin, Sec-Fetch-Site, from the network
 * stack itself, preflights included) and what came back is printed. Playwright is looked for as `playwright`, then at $PLAYWRIGHT_DIR, then in /opt/node-tools.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE = path.join(HERE, 'serve.js');
const SLUG = '0100-new-flow-across-apps';
const PULL = 21;

const MAP1 = { name: 'map', host: 'map.corn.localhost', port: 3711, forge: 3721, embed: ['http://tasks.corn.localhost:3713'] };
const MAP2 = { name: 'map2', host: 'map2.corn.localhost', port: 3712, forge: 3722, embed: ['http://tasks.corn.localhost:3713', 'http://tasks.other.localhost:3715'] };
const HOSTS = [
  { name: 'listed, same site', host: 'tasks.corn.localhost', port: 3713 },
  { name: 'not listed, same site', host: 'tasks2.corn.localhost', port: 3714 },
  { name: 'not listed (map) / listed (map2), different site', host: 'tasks.other.localhost', port: 3715 },
];
const CASES = [
  [MAP1, HOSTS[0]], [MAP1, HOSTS[1]], [MAP1, HOSTS[2]], [MAP2, HOSTS[2]],
];

async function loadPlaywright() {
  const tries = ['playwright', ...(process.env.PLAYWRIGHT_DIR ? [pathToFileURL(path.join(process.env.PLAYWRIGHT_DIR, 'index.mjs')).href] : []), '/opt/node-tools/node_modules/playwright/index.mjs'];
  for (const t of tries) {
    try { return await import(t); } catch { /* next */ }
  }
  throw new Error('Playwright is not installed: set PLAYWRIGHT_DIR to its folder.');
}

/** Starts a rig and resolves when it listens; `stop` ends it */
function startRig(rig) {
  const origin = `http://${rig.host}:${rig.port}`;
  const args = [SERVE, '--forge', '--port', String(rig.port), '--forge-port', String(rig.forge), '--public', origin, '--embed', rig.embed.join(','), '--dir', path.join(os.tmpdir(), `cornfield-embed-proof-${rig.port}`)];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`${rig.name} did not start:\n${out}`)), 60_000);
    const see = (d) => { out += d; if (out.includes('Ctrl-C stops it')) { clearTimeout(timer); resolve({ origin, stop: () => child.kill('SIGTERM') }); } };
    child.stdout.on('data', see);
    child.stderr.on('data', see);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${rig.name} exited (${code}):\n${out}`)); });
  });
}

/** A blank page on its own port */
function hostPage(port) {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>host</title><p>a blank host page</p>'); });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const pick = (h, names) => Object.fromEntries(names.map((n) => [n, Object.entries(h || {}).find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1]]).filter(([, v]) => v !== undefined));
const cookieNote = (c) => (c === undefined ? 'none' : `${c.split('=')[0]}=… (${c.length} chars)`);

async function runCase(browser, context, [map, host], origins) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const seen = new Map();
  const entry = (id) => { if (!seen.has(id)) seen.set(id, {}); return seen.get(id); };
  cdp.on('Network.requestWillBeSent', (e) => Object.assign(entry(e.requestId), { method: e.request.method, url: e.request.url }));
  cdp.on('Network.requestWillBeSentExtraInfo', (e) => Object.assign(entry(e.requestId), { requestHeaders: e.headers }));
  cdp.on('Network.responseReceived', (e) => Object.assign(entry(e.requestId), { status: e.response.status }));
  cdp.on('Network.responseReceivedExtraInfo', (e) => Object.assign(entry(e.requestId), { responseHeaders: e.headers, status: e.statusCode }));
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });

  await page.goto(`http://${host.host}:${host.port}/`);
  const base = origins[map.name];
  const calls = [
    ['gated read: GET /cornfield/config.json', `/cornfield/config.json`, {}],
    ['gated read: GET the proposal (headers)', `/proposals/${SLUG}.json?source=pull%2F${PULL}`, {}],
    ['review PUT (notes)', `/proposals/${SLUG}/review?source=pull%2F${PULL}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verdict: 'notes', note: `from ${host.host}`, edits: [] }) }],
    ['not allowed: POST /api/review-tokens', '/api/review-tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'from a host page' }) }],
  ];
  const results = [];
  for (const [label, target, init] of calls) {
    seen.clear();
    const js = await page.evaluate(async ([url, init]) => {
      try {
        const r = await fetch(url, { credentials: 'include', ...init });
        const text = await r.text();
        return { reached: true, status: r.status, sha256: r.headers.get('X-Proposal-Sha256'), body: text.slice(0, 110).replace(/\s+/g, ' ') };
      } catch (e) {
        return { reached: false, error: String(e && e.message || e) };
      }
    }, [`${base}${target}`, init]);
    await new Promise((r) => setTimeout(r, 150));
    const wire = [...seen.values()].filter((r) => r.url && r.url.startsWith(base)).map((r) => ({
      method: r.method, status: r.status,
      sent: { ...pick(r.requestHeaders, ['Origin', 'Sec-Fetch-Site', 'Sec-Fetch-Mode', 'Access-Control-Request-Method', 'Access-Control-Request-Headers']), Cookie: cookieNote(pick(r.requestHeaders, ['Cookie']).Cookie) },
      got: pick(r.responseHeaders, ['Access-Control-Allow-Origin', 'Access-Control-Allow-Credentials', 'Access-Control-Allow-Methods', 'Access-Control-Allow-Headers', 'Access-Control-Expose-Headers', 'Vary']),
    }));
    results.push({ label, target, js, wire });
  }
  await page.close();
  return { cornfield: base, host: `http://${host.host}:${host.port}`, hostKind: host.name, listed: map.embed.includes(`http://${host.host}:${host.port}`), results, consoleErrors };
}

async function main() {
  const jsonAt = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
  const { chromium } = await loadPlaywright();
  const rigs = [];
  const pages = [];
  let browser;
  try {
    for (const m of [MAP1, MAP2]) rigs.push([m, await startRig(m)]);
    for (const h of HOSTS) pages.push(await hostPage(h.port));
    browser = await chromium.launch();
    const context = await browser.newContext();
    // Signed in on each cornfield, in the same browser: the fake forge's authorize step redirects straight back
    const origins = {};
    for (const [m, rig] of rigs) {
      origins[m.name] = rig.origin;
      const p = await context.newPage();
      await p.goto(`${rig.origin}/auth/start`);
      await p.waitForURL(`${rig.origin}/**`);
      const me = await p.evaluate(() => fetch('/auth/me').then((r) => r.json()));
      if (!me.ok) throw new Error(`sign-in on ${rig.origin} did not work: ${JSON.stringify(me)}`);
      const cookie = (await context.cookies(rig.origin)).find((c) => c.name === 'cornfield');
      console.log(`signed in on ${rig.origin} as ${me.login}; cookie: httpOnly=${cookie.httpOnly} sameSite=${cookie.sameSite} secure=${cookie.secure} domain=${cookie.domain} (host-only: ${!cookie.domain.startsWith('.')})`);
      await p.close();
    }
    const out = [];
    for (const c of CASES) out.push(await runCase(browser, context, c, origins));
    for (const r of out) {
      console.log(`\n=== cornfield ${r.cornfield}, host page ${r.host} (${r.hostKind}; listed by this cornfield: ${r.listed}) ===`);
      for (const x of r.results) {
        console.log(`- ${x.label}`);
        console.log(`    page saw: ${JSON.stringify(x.js)}`);
        for (const w of x.wire) console.log(`    wire: ${w.method} -> ${w.status}\n      browser sent: ${JSON.stringify(w.sent)}\n      server said:  ${JSON.stringify(w.got)}`);
        if (!x.wire.length) console.log('    wire: no request reached the server');
      }
      if (r.consoleErrors.length) console.log(`  console: ${r.consoleErrors.join(' | ')}`);
    }
    if (jsonAt) fs.writeFileSync(jsonAt, JSON.stringify(out, null, 2));
  } finally {
    await browser?.close();
    for (const s of pages) s.close();
    for (const [, rig] of rigs) rig.stop();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
