/**
 * @vitest-environment node
 *
 * The Host check (server/bind.js `hostAllowed`, run first in server/server.js): a page on another site could point its
 * own hostname at this machine (DNS rebinding) and read what cornfield answers, so a foreign `Host` is a 421 on every
 * route. Without sign-in only a loopback name passes; with it the public URL's host does too. Case, ports and IPv6
 * brackets are compared as a browser sends them; a missing `Host` and `X-Forwarded-Host` are no way in.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { createCornfieldServer } from '../../server/server.js';
// @ts-expect-error plain JS module, no declarations
import { hostAllowed } from '../../server/bind.js';
// @ts-expect-error plain JS module, no declarations
import { loadConfig } from '../../core/config.js';
import { SAMPLE } from '../helpers.js';
import { fakeForge } from './fake-forge.js';

const ENV = { CORNFIELD_GITHUB_CLIENT_ID: 'test-client-id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: 'x'.repeat(40) };

/** A request with the `Host` header as given; answers status and body */
function ask(port, host, target = '/topology.json', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: target, headers: { ...(host === undefined ? {} : { host }), ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** An HTTP/1.0 request, which sends no Host at all */
function askWithoutHost(port, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET ${target} HTTP/1.0\r\n\r\n`));
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function serverOn(config, opts) {
  const server = createCornfieldServer(config, opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  return { server, port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
}

describe('hostAllowed', () => {
  it('takes loopback names, with or without a port, in any case', () => {
    for (const h of ['localhost', 'localhost:3350', 'LocalHost:3350', '127.0.0.1', '127.0.0.1:3350', '[::1]', '[::1]:3350', 'LOCALHOST']) expect(hostAllowed(h), h).toBe(true);
  });

  it('refuses everything else: foreign names, look-alikes, a bare ::1, odd ports, junk, nothing', () => {
    for (const h of [
      'evil.example', 'evil.example:3350', 'localhost.evil.example', 'evil-localhost', 'notlocalhost', 'localhost.', 'localhost.localdomain',
      '127.0.0.1.evil.example', '127.0.0.2', '0.0.0.0', '::1', '[::2]', '[::1]x', 'localhost:', 'localhost:99999', 'localhost:abc',
      'localhost@evil.example', 'evil.example@localhost', 'localhost/', 'localhost evil.example', 'localhost,evil.example', '', undefined,
    ]) expect(hostAllowed(h), String(h)).toBe(false);
  });

  it('takes the public host too when given one, and still no other', () => {
    expect(hostAllowed('cornfield.example.org', 'cornfield.example.org')).toBe(true);
    expect(hostAllowed('CornField.Example.ORG:443', 'cornfield.example.org')).toBe(true);
    expect(hostAllowed('localhost:3350', 'cornfield.example.org')).toBe(true);
    expect(hostAllowed('evil.example', 'cornfield.example.org')).toBe(false);
    expect(hostAllowed('cornfield.example.org.evil.example', 'cornfield.example.org')).toBe(false);
    expect(hostAllowed('cornfield.example.org', null)).toBe(false);
  });
});

describe('without sign-in', () => {
  let data;
  let upstream;
  let srv;
  beforeAll(async () => {
    upstream = await fakeForge({ 'GET /api/x': () => ({ body: { ok: true } }) });
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-host-'));
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    config.proxy = { '/api/': upstream.url };
    srv = await serverOn(config, { env: {} });
  });
  afterAll(async () => {
    await srv.close();
    await upstream.close();
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('answers loopback names, with the port or without, in any case', async () => {
    for (const h of ['localhost', `localhost:${srv.port}`, 'LOCALHOST', `LocalHost:${srv.port}`, '127.0.0.1', `127.0.0.1:${srv.port}`, '[::1]', `[::1]:${srv.port}`]) {
      expect((await ask(srv.port, h)).status, h).toBe(200);
    }
  });

  it('refuses a foreign Host with 421 and a plain-text reason, on every kind of route', async () => {
    for (const h of ['evil.example', `evil.example:${srv.port}`, 'localhost.evil.example', 'EVIL.example', '127.0.0.1.evil.example', '::1']) {
      for (const p of ['/topology.json', '/', '/healthz', '/cornfield/config.json', '/explorer/main.js', '/proposals', '/proposals/0002-checkout/mockups', '/proposals/0002-checkout/mockups/0?source=checkout', '/auth/me', '/nope', '/api/x']) {
        const res = await ask(srv.port, h, p);
        expect(res.status, `${h} ${p}`).toBe(421);
        expect(res.headers['content-type']).toMatch(/^text\/plain/);
        expect(res.body).toMatch(/^421 Misdirected Request/);
        expect(res.body).not.toContain('nodes');
      }
    }
  });

  it('refuses a POST with a foreign Host before a review or a proxy sees it', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: '/proposals/x/review', headers: { host: 'evil.example', 'content-type': 'application/json' }, agent: false }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      req.on('error', reject);
      req.end('{}');
    });
    expect(res).toBe(421);
  });

  it('refuses a request with no Host (HTTP/1.0)', async () => {
    expect(await askWithoutHost(srv.port, '/topology.json')).toMatch(/^HTTP\/1\.\d 421 /);
  });

  it('refuses two Host headers, and a request target in absolute form that names another host', async () => {
    const rawAsk = (text) => new Promise((resolve, reject) => {
      const socket = net.connect(srv.port, '127.0.0.1', () => socket.write(text));
      let out = '';
      socket.on('data', (d) => { out += d; });
      socket.on('end', () => resolve(out.split('\r\n')[0]));
      socket.on('error', reject);
    });
    expect(await rawAsk('GET /topology.json HTTP/1.1\r\nHost: localhost\r\nHost: evil.example\r\nConnection: close\r\n\r\n')).toMatch(/ 421 /);
    expect(await rawAsk('GET /topology.json HTTP/1.1\r\nHost: localhost\r\nHost: localhost\r\nConnection: close\r\n\r\n')).toMatch(/ 421 /);
    expect(await rawAsk('GET http://evil.example/topology.json HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')).toMatch(/ 421 /);
    expect(await rawAsk('GET http://localhost/topology.json HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')).toMatch(/ 200 /);
    // An upgrade (a WebSocket) goes the same way: there is no upgrade handler, so it reaches the check like any request
    expect(await rawAsk('GET /topology.json HTTP/1.1\r\nHost: evil.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')).toMatch(/ 421 /);
  });

  it('does not trust X-Forwarded-Host', async () => {
    expect((await ask(srv.port, 'evil.example', '/topology.json', { 'x-forwarded-host': 'localhost' })).status).toBe(421);
    expect((await ask(srv.port, 'localhost', '/topology.json', { 'x-forwarded-host': 'evil.example' })).status).toBe(200);
  });

  it('answers a proxied path only to a loopback Host', async () => {
    expect((await ask(srv.port, 'localhost', '/api/x')).status).toBe(200);
    expect((await ask(srv.port, 'evil.example', '/api/x')).status).toBe(421);
  });

  it('is not moved by the public URL: without sign-in it is not a name to answer to', async () => {
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    config.publicUrl = 'https://cornfield.example.org';
    const plain = await serverOn(config, { env: {} });
    try {
      expect((await ask(plain.port, 'cornfield.example.org')).status).toBe(421);
      expect((await ask(plain.port, 'localhost')).status).toBe(200);
    } finally {
      await plain.close();
    }
  });
});

describe('with sign-in', () => {
  let data;
  let upstream;
  let srv;
  beforeAll(async () => {
    upstream = await fakeForge({ 'GET /api/x': () => ({ body: { ok: true } }) });
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-host-in-'));
    const config = await loadConfig(SAMPLE, { env: { CORNFIELD_DATA: data } });
    Object.assign(config, { forge: { type: 'github', repo: 'acme/home' }, publicUrl: 'https://cornfield.example.org', proxy: { '/api/': upstream.url } });
    srv = await serverOn(config, { env: ENV });
  });
  afterAll(async () => {
    await srv.close();
    await upstream.close();
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('lets the public URL\'s host through to the guard, in any case and with or without a port', async () => {
    for (const h of ['cornfield.example.org', 'CornField.Example.ORG', 'cornfield.example.org:443']) {
      expect((await ask(srv.port, h)).status, h).toBe(401);
      expect((await ask(srv.port, h, '/healthz')).status, h).toBe(200);
      expect((await ask(srv.port, h, '/api/x')).status, h).toBe(401);
    }
  });

  it('keeps loopback for the image\'s health check (it asks http://127.0.0.1:<port>/healthz), and the guard still applies there', async () => {
    expect((await ask(srv.port, `127.0.0.1:${srv.port}`, '/healthz')).status).toBe(200);
    expect((await ask(srv.port, `127.0.0.1:${srv.port}`)).status).toBe(401);
  });

  it('refuses any other Host with 421, before the guard, /healthz and /auth/ included', async () => {
    for (const h of ['evil.example', 'cornfield.example.org.evil.example', 'evilcornfield.example.org', 'example.org', 'sub.cornfield.example.org']) {
      for (const p of ['/topology.json', '/', '/healthz', '/auth/start', '/auth/me', '/api/x']) {
        const res = await ask(srv.port, h, p);
        expect(res.status, `${h} ${p}`).toBe(421);
        expect(res.headers['set-cookie']).toBeUndefined();
      }
    }
  });

  it('refuses a request with no Host, and does not trust X-Forwarded-Host', async () => {
    expect(await askWithoutHost(srv.port, '/healthz')).toMatch(/^HTTP\/1\.\d 421 /);
    expect((await ask(srv.port, 'evil.example', '/topology.json', { 'x-forwarded-host': 'cornfield.example.org' })).status).toBe(421);
  });
});
