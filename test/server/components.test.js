/**
 * @vitest-environment node
 *
 * The web components served by the cornfield server (spec 0011 D11, server/components.js), from the outside, on a folder built by hand
 * (the tests need no build; components/test/host.test.ts proves the real one in a browser). Held here:
 *
 *   - a checkout with no build answers `/cornfield/components/…` with a plain 404 that says how to build, and nothing else changes
 *   - only what the manifest lists is served: no listing, no stray file, no dotfile, no traversal, no link out, only the five kinds
 *   - types, `nosniff`, a strong ETag (per encoding), 304, long caching for hashed chunks only, revalidation for corn-map.js, index.js and version.json
 *   - the route is open: 200 with no session on a server with sign-in, while every other route is 401
 *   - CORS: a listed origin is answered with exactly itself and no credentials; an unlisted one, and no list at all, with no CORS header
 *   - with no origin listed the route adds nothing to any answer (the "unchanged when empty" test in embed.test.js covers the rest of the routes)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
// @ts-expect-error plain JS module, no declarations
import { createCornfieldServer } from '../../server/server.js';
// @ts-expect-error plain JS module, no declarations
import { loadConfig } from '../../core/config.js';
import { SAMPLE } from '../helpers.js';

const SIGN_IN = { CORNFIELD_GITHUB_CLIENT_ID: 'test-client-id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: 'x'.repeat(40) };
const LISTED = 'http://tasks.corn.localhost:3711';
const BASE = '/cornfield/components/';
const BIG = `export const runtime = "${'a'.repeat(900)}";\n`;
const FILES = {
  'index.js': 'import "./chunks/runtime-AbCd1234.js";\nexport const version = "9.9.9";\n',
  'corn-map.js': 'import "./chunks/runtime-AbCd1234.js";\n',
  'chunks/runtime-AbCd1234.js': BIG,
  'chunks/corn-map-Zz9_-8Xy.js': 'export default 1;\n',
  'tokens.css': ':where(:root) { --corn-ground: #fff; }\n',
  'version.json': '{"name":"@popcorn245/cornfield-components","cornfield":"9.9.9"}\n',
  'index.js.map': '{"version":3}\n',
  'types/index.d.ts': 'export declare const version: string;\n',
};

function raw(port, method, target, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)), agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
const text = (r) => r.body.toString('utf8');

describe('the web components route', () => {
  const dirs = [];
  const closers = [];
  let dist;

  async function boot({ origins, signIn = false, componentsDir = dist } = {}) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-components-data-'));
    dirs.push(data);
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    if (origins) config.embed = { origins }; else delete config.embed;
    if (signIn) Object.assign(config, { forge: { type: 'github', url: 'http://127.0.0.1:1', repo: 'owner/name' }, publicUrl: 'http://127.0.0.1:3350' });
    const server = createCornfieldServer(config, { env: signIn ? SIGN_IN : {}, componentsDir });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
    return /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  }

  beforeAll(() => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-components-dist-'));
    dirs.push(dist);
    for (const [name, body] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(dist, name)), { recursive: true });
      fs.writeFileSync(path.join(dist, name), body);
    }
    // In the folder but not built by the build: never served
    fs.writeFileSync(path.join(dist, 'stray.js'), 'export const stray = 1;\n');
    fs.writeFileSync(path.join(dist, '.hidden.js'), 'export const hidden = 1;\n');
    fs.writeFileSync(path.join(dist, 'notes.txt'), 'notes\n');
    // A link out of the folder, named by the manifest all the same
    fs.symlinkSync(path.join(os.tmpdir(), 'cornfield-components-secret.js'), path.join(dist, 'linked.js'));
    fs.writeFileSync(path.join(os.tmpdir(), 'cornfield-components-secret.js'), 'export const secret = 1;\n');
    const listed = [...Object.keys(FILES), 'linked.js', 'notes.txt', '.hidden.js', '../outside.js', 'a/../../b.js', '/abs.js', 'types', 'bad name.js', 'x.html'];
    fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify({ name: 'x', cornfield: '9.9.9', files: listed.map((p) => ({ path: p, bytes: 1, sha256: 'x' })) }));
  });
  afterAll(async () => {
    for (const close of closers) await close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), 'cornfield-components-secret.js'), { force: true });
  });

  describe('in a checkout with no build', () => {
    it('answers a plain 404 that says how to get them, for the page and for a file, GET and HEAD', async () => {
      const port = await boot({ componentsDir: path.join(os.tmpdir(), 'cornfield-no-such-dist') });
      for (const target of [`${BASE}corn-map.js`, `${BASE}version.json`, BASE, '/cornfield/components/x/y.js']) {
        const res = await raw(port, 'GET', target);
        expect(res.status, target).toBe(404);
        expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(text(res)).toContain('npm run build');
        expect(text(res)).toContain('Docker image');
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
        expect((await raw(port, 'HEAD', target)).status).toBe(404);
      }
    });
    it('is a folder with files but no manifest too: nothing is served on a guess', async () => {
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-components-bare-'));
      dirs.push(bare);
      fs.writeFileSync(path.join(bare, 'corn-map.js'), 'export {};\n');
      const port = await boot({ componentsDir: bare });
      const res = await raw(port, 'GET', `${BASE}corn-map.js`);
      expect(res.status).toBe(404);
      expect(text(res)).toContain('npm run build');
    });
    it('leaves every other route as it was', async () => {
      const a = await boot({ componentsDir: path.join(os.tmpdir(), 'cornfield-no-such-dist') });
      const b = await boot({ componentsDir: dist });
      for (const target of ['/', '/healthz', '/explorer/main.js', '/nope', '/cornfield/theme.css', '/cornfield/components', '/cornfield/componentsx/a.js']) {
        const [x, y] = [await raw(a, 'GET', target), await raw(b, 'GET', target)];
        expect(y.status, target).toBe(x.status);
        expect(y.body.equals(x.body), target).toBe(true);
      }
    });
  });

  describe('built', () => {
    let port;
    beforeAll(async () => { port = await boot({}); });

    it('serves each listed file with its type, nosniff and a strong ETag, and the same security headers as the explorer\'s files', async () => {
      const own = await raw(port, 'GET', '/explorer/main.js');
      const types = { 'index.js': 'application/javascript; charset=utf-8', 'tokens.css': 'text/css; charset=utf-8', 'version.json': 'application/json; charset=utf-8', 'index.js.map': 'application/json; charset=utf-8', 'types/index.d.ts': 'text/plain; charset=utf-8' };
      for (const [name, type] of Object.entries(types)) {
        const res = await raw(port, 'GET', BASE + name);
        expect(res.status, name).toBe(200);
        expect(res.headers['content-type'], name).toBe(type);
        expect(res.headers['x-content-type-options'], name).toBe('nosniff');
        expect(res.headers.etag, name).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
        expect(text(res), name).toBe(FILES[name]);
        for (const h of ['content-security-policy', 'x-frame-options', 'referrer-policy']) expect(res.headers[h], `${name} ${h}`).toBe(own.headers[h]);
      }
      expect((await raw(port, 'GET', `${BASE}index.js`)).headers.etag).toBe(`"${createHash('sha256').update(FILES['index.js']).digest('base64url').slice(0, 27)}"`);
    });

    it('caches a chunk named by its content for a year, and makes corn-map.js, index.js, version.json and the rest revalidate', async () => {
      for (const name of ['chunks/runtime-AbCd1234.js', 'chunks/corn-map-Zz9_-8Xy.js']) expect((await raw(port, 'GET', BASE + name)).headers['cache-control'], name).toBe('public, max-age=31536000, immutable');
      for (const name of ['index.js', 'corn-map.js', 'version.json', 'tokens.css', 'types/index.d.ts', 'index.js.map']) expect((await raw(port, 'GET', BASE + name)).headers['cache-control'], name).toBe('no-cache');
    });

    it('answers 304 to a matching If-None-Match, with the headers, and 200 to a stale one', async () => {
      const first = await raw(port, 'GET', `${BASE}version.json`);
      const again = await raw(port, 'GET', `${BASE}version.json`, { headers: { 'if-none-match': first.headers.etag } });
      expect(again.status).toBe(304);
      expect(again.body.length).toBe(0);
      expect(again.headers.etag).toBe(first.headers.etag);
      expect(again.headers['cache-control']).toBe('no-cache');
      expect((await raw(port, 'GET', `${BASE}version.json`, { headers: { 'if-none-match': '"other"' } })).status).toBe(200);
    });

    it('names the encoding in the ETag when it will be compressed, so two encodings are two ETags, and the bytes come back whole', async () => {
      const plain = await raw(port, 'GET', `${BASE}chunks/runtime-AbCd1234.js`);
      const gz = await raw(port, 'GET', `${BASE}chunks/runtime-AbCd1234.js`, { headers: { 'accept-encoding': 'gzip' } });
      const br = await raw(port, 'GET', `${BASE}chunks/runtime-AbCd1234.js`, { headers: { 'accept-encoding': 'br' } });
      expect(gz.headers['content-encoding']).toBe('gzip');
      expect(br.headers['content-encoding']).toBe('br');
      expect(zlib.gunzipSync(gz.body).toString()).toBe(BIG);
      expect(zlib.brotliDecompressSync(br.body).toString()).toBe(BIG);
      expect(new Set([plain.headers.etag, gz.headers.etag, br.headers.etag]).size).toBe(3);
      expect(gz.headers.vary).toMatch(/Accept-Encoding/);
      const revalidated = await raw(port, 'GET', `${BASE}chunks/runtime-AbCd1234.js`, { headers: { 'accept-encoding': 'gzip', 'if-none-match': gz.headers.etag } });
      expect(revalidated.status).toBe(304);
      // a short file is not compressed, and its ETag says so
      const small = await raw(port, 'GET', `${BASE}version.json`, { headers: { 'accept-encoding': 'gzip' } });
      expect(small.headers['content-encoding']).toBeUndefined();
      expect(small.headers.etag).toBe((await raw(port, 'GET', `${BASE}version.json`)).headers.etag);
    });

    it('answers HEAD with the headers and no body', async () => {
      const head = await raw(port, 'HEAD', `${BASE}index.js`);
      expect(head.status).toBe(200);
      expect(head.body.length).toBe(0);
      expect(head.headers['content-length']).toBe(String(FILES['index.js'].length));
    });

    it('serves nothing but what the manifest lists, as one of the five kinds, and nothing that leaves the folder', async () => {
      const refused = [
        'manifest.json', 'stray.js', 'notes.txt', '.hidden.js', 'linked.js', 'x.html', 'types', 'types/', 'chunks/', 'chunks', '', 'nope.js', 'bad%20name.js', 'index.js/', 'INDEX.JS', 'index.js%00', 'chunks/runtime-AbCd1234.js.gz',
        '../manifest.json', '../../package.json', '..%2f..%2fpackage.json', '%2e%2e/%2e%2e/package.json', '..%5cpackage.json', '%2fetc%2fpasswd', '/etc/passwd', '.%2e/x.js',
      ];
      for (const name of refused) {
        const res = await raw(port, 'GET', BASE + name);
        expect([404, 400], name).toContain(res.status);
        expect(text(res), name).not.toMatch(/export const (secret|stray|hidden)/);
      }
      // …as it is sent on the wire (an HTTP client would tidy the dots away)
      for (const target of ['/cornfield/components/../../package.json', '/cornfield/components/./../../package.json', '/cornfield/components/chunks/../../manifest.json']) {
        const res = await raw(port, 'GET', target);
        expect(res.status, target).toBe(404);
        expect(text(res), target).not.toContain('"cornfield"');
      }
    });

    it('takes only GET and HEAD: a write goes on to the guard as for any route', async () => {
      const open = await boot({});
      for (const method of ['POST', 'PUT', 'DELETE']) expect((await raw(open, method, `${BASE}index.js`)).status, method).not.toBe(200);
      const guarded = await boot({ signIn: true });
      const plain = await raw(guarded, 'POST', '/nope');
      expect((await raw(guarded, 'POST', `${BASE}index.js`)).status).toBe(plain.status);
    });
  });

  describe('the route is open', () => {
    it('answers with no session on a server with sign-in, where every other route is 401', async () => {
      const port = await boot({ signIn: true });
      for (const target of ['/', '/topology.json', '/cornfield/config.json', '/explorer/main.js']) expect((await raw(port, 'GET', target)).status, target).toBe(401);
      for (const name of ['corn-map.js', 'version.json', 'chunks/runtime-AbCd1234.js']) {
        const res = await raw(port, 'GET', BASE + name);
        expect(res.status, name).toBe(200);
        expect(res.headers['set-cookie']).toBeUndefined();
      }
      // …and what it does not hold is still behind the sign-in
      expect((await raw(port, 'GET', `${BASE}manifest.json`)).status).toBe(404);
      expect((await raw(port, 'GET', '/cornfield/componentsx')).status).toBe(401);
    });
  });

  describe('CORS', () => {
    it('answers a listed origin with exactly that origin, Vary: Origin and no credentials header, on every file and on a 304', async () => {
      const port = await boot({ origins: [LISTED], signIn: true });
      for (const name of Object.keys(FILES)) {
        const res = await raw(port, 'GET', BASE + name, { headers: { origin: LISTED } });
        expect(res.status, name).toBe(200);
        expect(res.headers['access-control-allow-origin'], name).toBe(LISTED);
        expect(res.headers.vary, name).toMatch(/(^|, )Origin(,|$)/);
        expect(res.headers['access-control-allow-credentials'], name).toBeUndefined();
        expect(res.headers['access-control-expose-headers'], name).toBeUndefined();
        expect(Object.keys(res.headers).filter((k) => k.startsWith('access-control-')), name).toEqual(['access-control-allow-origin']);
      }
      const first = await raw(port, 'GET', `${BASE}index.js`, { headers: { origin: LISTED } });
      const again = await raw(port, 'GET', `${BASE}index.js`, { headers: { origin: LISTED, 'if-none-match': first.headers.etag } });
      expect(again.status).toBe(304);
      expect(again.headers['access-control-allow-origin']).toBe(LISTED);
    });

    it('answers the preflight of a listed origin for GET only, and no one else\'s', async () => {
      const port = await boot({ origins: [LISTED], signIn: true });
      const ok = await raw(port, 'OPTIONS', `${BASE}index.js`, { headers: { origin: LISTED, 'access-control-request-method': 'GET' } });
      expect(ok.status).toBe(204);
      expect(ok.headers['access-control-allow-origin']).toBe(LISTED);
      expect(ok.headers['access-control-allow-methods']).toBe('GET, HEAD');
      expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
      for (const [origin, method] of [[LISTED, 'PUT'], ['https://evil.example', 'GET']]) {
        const res = await raw(port, 'OPTIONS', `${BASE}index.js`, { headers: { origin, 'access-control-request-method': method } });
        expect(res.headers['access-control-allow-origin'], `${origin} ${method}`).toBeUndefined();
      }
    });

    it('gives an origin that is not listed no CORS header (the browser then refuses the module), only Vary: Origin', async () => {
      const port = await boot({ origins: [LISTED] });
      for (const origin of ['https://evil.example', 'http://tasks.corn.localhost:3712', LISTED.toUpperCase(), `${LISTED}/`, undefined]) {
        const res = await raw(port, 'GET', `${BASE}index.js`, { headers: { origin } });
        expect(res.status).toBe(200);
        expect(Object.keys(res.headers).filter((k) => k.startsWith('access-control-')), String(origin)).toEqual([]);
        expect(res.headers.vary).toMatch(/(^|, )Origin(,|$)/);
      }
    });

    it('with no origin listed, adds no CORS header and no Vary: Origin, whoever asks', async () => {
      const port = await boot({});
      for (const origin of [LISTED, 'https://evil.example', undefined]) {
        const res = await raw(port, 'GET', `${BASE}index.js`, { headers: { origin } });
        expect(res.status).toBe(200);
        expect(Object.keys(res.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
        expect(res.headers.vary ?? '').not.toMatch(/Origin/);
      }
    });
  });
});
