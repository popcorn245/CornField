/**
 * @vitest-environment node
 *
 * The server serves an allowlist, not the checkout: the explorer, the modules it loads, the repo's map,
 * registry, house file and proposals answer 200; .env files, sources, cornfield's own Node modules and
 * traversal attempts answer 404; no response carries a CORS header; every page has a Content-Security-Policy;
 * and without sign-in it refuses to listen on anything but loopback. Runs `cornfield serve` on the sample repo.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { CORNFIELD, SAMPLE, freePort } from '../helpers.js';

const CLI = path.join(CORNFIELD, 'cli', 'cornfield.js');

/** A request with its path sent exactly as given (fetch would tidy a `..` away) */
function raw(port, method, target, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const get = (port, target) => raw(port, 'GET', target);

describe('cornfield serve', () => {
  let child;
  let port;
  let data;

  beforeAll(async () => {
    port = await freePort();
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-data-'));
    child = spawn(process.execPath, [CLI, 'serve', '--repo', SAMPLE, '--port', String(port)], { env: { ...process.env, CORNFIELD_DATA: data }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`cornfield serve exited with ${code}`)));
      child.stdout.on('data', (d) => { if (String(d).includes('http://')) resolve(); });
    });
  });

  afterAll(() => {
    child.kill();
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('serves the explorer, its modules, the repo\'s map and what the sources need, without a CORS header', async () => {
    for (const p of ['/', '/topology.json', '/topology.cloud.json', '/cornfield/config.json', '/cornfield/house.json', '/explorer/main.js', '/explorer/explorer.css', '/explorer/house.css', '/explorer/scene.js', '/explorer/plugins.js', '/core/proposal.js', '/core/schema.js', '/core/personas.js', '/core/cloud.js', '/core/text.js', '/plugins/house/browser.js', '/proposals']) {
      const res = await get(port, p);
      expect(res.status, p).toBe(200);
      expect(res.headers['access-control-allow-origin'], p).toBeUndefined();
    }
  });

  it('puts a strict Content-Security-Policy on the page: this origin only, nothing inline but the import map', async () => {
    const res = await get(port, '/');
    const csp = res.headers['content-security-policy'];
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).toMatch(/script-src 'self'(;|$)/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.body).not.toContain('<!--@importmap-->');
    expect(res.body).toMatch(/<title>Acme home · cornfield<\/title>/);
  });

  it('serves every module the page\'s module graph reaches, and nothing it imports is outside this origin', async () => {
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const specifiers = (src) => {
      const code = strip(src);
      const out = [];
      for (const re of [/\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g]) {
        for (const m of code.matchAll(re)) out.push(m[1]);
      }
      return out;
    };
    const html = (await get(port, '/')).body;
    const queue = [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)].map((m) => [m[1], '/']);
    const config = JSON.parse((await get(port, '/cornfield/config.json')).body);
    for (const s of Object.values(config.sources)) if (s) queue.push([s.module, 'the config']);
    const seen = new Set();
    while (queue.length) {
      const [file, from] = queue.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      const res = await get(port, file);
      expect(res.status, `${file} (imported by ${from})`).toBe(200);
      for (const s of specifiers(res.body)) {
        expect(s.startsWith('/') || s.startsWith('.'), `${file} imports ${s}`).toBe(true);
        queue.push([new URL(s, `http://cornfield${file}`).pathname, file]);
      }
    }
    expect(seen.size).toBeGreaterThan(30);
  });

  it('tells the browser only what it needs of the config, never a path on this machine', async () => {
    const res = await get(port, '/cornfield/config.json');
    const config = JSON.parse(res.body);
    expect(config).toMatchObject({ name: 'cornfield', title: 'Acme home', signIn: false, forge: { type: 'forgejo', url: 'https://forge.example.test', repo: 'acme/home' } });
    expect(config.sources.house).toEqual({ module: '/plugins/house/browser.js', options: { file: 'cornfield.house.json' } });
    expect(res.body).not.toContain(data.replace(/\\/g, '\\\\'));
    expect(res.body).not.toContain(SAMPLE.replace(/\\/g, '\\\\'));
  });

  it('serves the house file as an answer with its time, and the registry without its env var names', async () => {
    const house = JSON.parse((await get(port, '/cornfield/house.json')).body);
    expect(house.ok).toBe(true);
    expect(house.data.house.floors.length).toBeGreaterThan(0);
    expect(new Date(house.data.at).toISOString()).toBe(house.data.at);
    const registry = (await get(port, '/topology.cloud.json')).body;
    expect(JSON.parse(registry).services.length).toBeGreaterThan(5);
    expect(registry).not.toContain('CF_API_TOKEN');
  });

  it('generates the synthetic topology in memory at /topology-fixture.json', async () => {
    const res = await get(port, '/topology-fixture.json?nodes=300&edges=900&seed=4');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const t = JSON.parse(res.body);
    expect([t.nodes.length, t.edges.length]).toEqual([300, 900]);
    expect((await get(port, '/topology-fixture.json?nodes=300&edges=900&seed=4')).body).toBe(res.body);
    expect((await get(port, '/topology-fixture.json?nodes=300&edges=900&seed=5')).body).not.toBe(res.body);
    for (const q of ['nodes=abc', 'nodes=5', 'nodes=50001', 'nodes=1000&edges=10', 'seed=1.5']) expect((await get(port, `/topology-fixture.json?${q}`)).status, q).toBe(400);
    expect((await raw(port, 'POST', '/topology-fixture.json')).status).toBe(405);
  });

  it('answers 404 for env files, sources, its own Node modules and traversal', async () => {
    for (const p of ['/.env', '/package.json', '/cornfield.config.js', '/packages/api/src/server.js', '/stacks/app-stack/compose.yml', '/core/config.js', '/core/derive.js', '/server/server.js', '/cli/cornfield.js', '/plugins/cloud/index.js', '/explorer/index.html', '/explorer/../package.json', '/explorer/..%2fpackage.json', '/core/..%2fcli/cornfield.js', '/repo/package.json', '/repo/packages/api/src/server.js', '/repo/..%2f..%2fpackage.json']) {
      expect((await raw(port, 'GET', p)).status, p).toBe(404);
    }
  });

  it('lists proposals as JSON, and answers 404 for any slug it did not list', async () => {
    const list = await get(port, '/proposals');
    expect(list.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(list.body).map((e) => e.slug)).toEqual(['0002-checkout']);
    for (const p of ['/proposals/nope.json', '/proposals/..%2fpackage.json', '/proposals/%2e%2e%2f%2e%2e%2f.env', '/proposals/../../.env', '/proposals/0002-checkout.json?source=../..']) {
      expect((await raw(port, 'GET', p)).status, p).toBe(404);
    }
    expect((await raw(port, 'PUT', '/proposals/0002-checkout.json')).status).toBe(405);
  });

  it('serves a proposal\'s mockups under their own sandbox policy, not the page\'s, and lets only cornfield\'s page frame them', async () => {
    const page = await get(port, '/');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    const list = JSON.parse((await get(port, '/proposals/0002-checkout/mockups?source=checkout')).body);
    expect(list.map((m) => [m.node, m.type, m.state])).toEqual([['page-web-checkout', 'image', 'unreviewed'], ['page-api-checkout', 'page', 'unreviewed'], ['page-web-cart', 'image', 'unreviewed']]);
    const svg = await get(port, list[0].url);
    const html = await get(port, list[1].url);
    expect(svg.headers['content-type']).toBe('image/svg+xml');
    expect(html.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(svg.body).toContain('<svg');
    for (const r of [svg, html, await get(port, list[2].url)]) {
      expect(r.status).toBe(200);
      expect(r.headers['content-security-policy']).toMatch(/^sandbox; default-src 'none'/);
      expect(r.headers['content-security-policy']).not.toContain('script-src');
      expect(r.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('takes no review of a draft that is not on a PR: a review is a PR comment, so nothing is written in the data folder or the repo', async () => {
    const ok = JSON.stringify({ verdict: 'approved', note: '', edits: [] });
    const own = { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' };
    const res = await raw(port, 'PUT', '/proposals/0002-checkout/review', own, ok);
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/comment on a spec PR/);
    expect(fs.existsSync(path.join(data, 'reviews'))).toBe(false);
    expect(fs.readdirSync(path.join(SAMPLE, 'docs/specs/proposals'))).toEqual(['0002-checkout', '0002-checkout.json']);
    expect((await raw(port, 'GET', '/proposals/0002-checkout/review')).status).toBe(404);
  });

  it('answers 400 for a malformed escape and sends no CORS preflight allowance', async () => {
    expect((await raw(port, 'GET', '/%')).status).toBe(400);
    const pre = await raw(port, 'OPTIONS', '/topology.json');
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('without sign-in', () => {
  it('refuses to listen on anything but loopback, and says why', () => {
    for (const host of ['0.0.0.0', '::', '192.0.2.10']) {
      const res = spawnSync(process.execPath, [CLI, 'serve', '--repo', SAMPLE, '--port', '0'], { env: { ...process.env, CORNFIELD_HOST: host }, encoding: 'utf8', timeout: 20000 });
      expect(res.status, host).toBe(1);
      expect(res.stderr, host).toMatch(/will not listen on .*sign-in is not configured/);
    }
  });
});
