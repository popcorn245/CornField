/**
 * @vitest-environment node
 *
 * F31: the server compresses what it sends as text (brotli or gzip, with Node's own zlib), says `Vary: Accept-Encoding`,
 * leaves alone what is compressed already (images, an upstream's `Content-Encoding`, event streams) and keeps its
 * ETag and 304 behaviour.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import zlib from 'node:zlib';
import { compressResponse, pickEncoding, isCompressible } from '../../server/compress.js';

const BIG = JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => ({ id: `node-${i}`, label: `A node called ${i}` })) });

let server;
let port;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    compressResponse(req, res);
    const url = req.url || '/';
    if (url === '/json') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: 'W/"abc"' }); return res.end(BIG); }
    if (url === '/implicit') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(BIG); }
    if (url === '/streamed') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.write(BIG.slice(0, 1000)); return res.end(BIG.slice(1000)); }
    if (url === '/png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(Buffer.from(BIG)); }
    if (url === '/svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(BIG); }
    if (url === '/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end(BIG); }
    if (url === '/small') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 12 }); return res.end('{"ok":true}\n'); }
    if (url === '/already') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }); return res.end(zlib.gzipSync(BIG)); }
    if (url === '/notmodified') { res.writeHead(304, { 'Content-Type': 'application/json', ETag: 'W/"abc"' }); return res.end(); }
    if (url === '/vary') { res.writeHead(200, { 'Content-Type': 'application/json', Vary: 'Cookie' }); return res.end(BIG); }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
afterAll(() => new Promise((r) => server.close(r)));

/** A request with the Accept-Encoding exactly as given, the body left as it came */
const ask = (path, encoding, method = 'GET') => new Promise((resolve, reject) => {
  const headers = encoding === undefined ? {} : { 'Accept-Encoding': encoding };
  http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
  }).on('error', reject).end();
});

describe('pickEncoding', () => {
  it('prefers brotli, then gzip, and honours q=0', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br');
    expect(pickEncoding('gzip, deflate')).toBe('gzip');
    expect(pickEncoding('br;q=0, gzip')).toBe('gzip');
    expect(pickEncoding('gzip;q=0')).toBeNull();
    expect(pickEncoding('identity')).toBeNull();
    expect(pickEncoding('*')).toBe('br');
    expect(pickEncoding(undefined)).toBeNull();
  });
  it('knows the compressible types', () => {
    for (const t of ['text/html; charset=utf-8', 'text/css', 'application/json', 'application/javascript; charset=utf-8', 'image/svg+xml', 'application/manifest+json; charset=utf-8']) expect(isCompressible(t), t).toBe(true);
    for (const t of ['image/png', 'image/webp', 'font/woff2', 'text/event-stream', 'application/octet-stream', undefined]) expect(isCompressible(t), String(t)).toBe(false);
  });
});

describe('compressResponse', () => {
  it('sends JSON as brotli or gzip, smaller, that decodes to the same body, with Vary', async () => {
    const gz = await ask('/json', 'gzip');
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.headers.vary).toMatch(/Accept-Encoding/i);
    expect(gz.headers['content-length']).toBeUndefined();
    expect(gz.raw.length).toBeLessThan(BIG.length / 4);
    expect(zlib.gunzipSync(gz.raw).toString()).toBe(BIG);
    const br = await ask('/json', 'gzip, br');
    expect(br.headers['content-encoding']).toBe('br');
    expect(zlib.brotliDecompressSync(br.raw).toString()).toBe(BIG);
  });

  it('keeps the ETag and the cache header', async () => {
    const res = await ask('/json', 'gzip');
    expect(res.headers.etag).toBe('W/"abc"');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('compresses a body sent without writeHead, and one sent in pieces', async () => {
    const implicit = await ask('/implicit', 'gzip');
    expect(implicit.headers['content-encoding']).toBe('gzip');
    expect(zlib.gunzipSync(implicit.raw).toString()).toBe(BIG);
    const pieces = await ask('/streamed', 'br');
    expect(zlib.brotliDecompressSync(pieces.raw).toString()).toBe(BIG);
    expect((await ask('/svg', 'gzip')).headers['content-encoding']).toBe('gzip');
  });

  it('sends it as it is when the browser does not ask for compression', async () => {
    for (const enc of [undefined, 'identity', 'gzip;q=0']) {
      const res = await ask('/json', enc);
      expect(res.headers['content-encoding'], String(enc)).toBeUndefined();
      expect(res.raw.toString()).toBe(BIG);
      expect(res.headers.vary).toMatch(/Accept-Encoding/i); // still varies: a cache must not hand the plain one to a gzip client
    }
  });

  it('leaves alone images, event streams, tiny bodies and what already has a Content-Encoding', async () => {
    expect((await ask('/png', 'gzip, br')).headers['content-encoding']).toBeUndefined();
    expect((await ask('/events', 'gzip, br')).headers['content-encoding']).toBeUndefined();
    expect((await ask('/small', 'gzip, br')).headers['content-encoding']).toBeUndefined();
    const already = await ask('/already', 'gzip, br');
    expect(already.headers['content-encoding']).toBe('gzip'); // not gzipped twice
    expect(zlib.gunzipSync(already.raw).toString()).toBe(BIG);
    expect((await ask('/png', 'gzip')).headers.vary).toBeUndefined();
  });

  it('adds to a Vary the answer already has, and answers a 304 with the Vary and no body', async () => {
    expect((await ask('/vary', 'gzip')).headers.vary).toBe('Cookie, Accept-Encoding');
    const nm = await ask('/notmodified', 'gzip');
    expect(nm.status).toBe(304);
    expect(nm.raw.length).toBe(0);
    expect(nm.headers.vary).toMatch(/Accept-Encoding/i);
    expect(nm.headers['content-encoding']).toBeUndefined();
  });

  it('answers HEAD with the encoding and no body', async () => {
    const res = await ask('/json', 'gzip', 'HEAD');
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.raw.length).toBe(0);
  });
});
