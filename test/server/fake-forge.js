/**
 * A fake forge for the adapter tests: an HTTP server on loopback that answers recorded requests, and remembers
 * every request it was sent. Nothing leaves the machine.
 *
 * A recording is keyed by the method and the path with its query, exactly as the adapter sends it
 * (`"GET /repos/owner/name/pulls?state=open&per_page=100"`), and answers `{ status?, headers?, body? }`: a body
 * that is a string is sent as it is, anything else as JSON. `{origin}` anywhere in a header or a string body is
 * the fake's own origin (for `Link` headers). A route may be a function `(req) => answer` instead. A request no
 * recording matches answers 404 `{ message: 'Not Found' }`, as both forges do.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { CORNFIELD } from '../helpers.js';

/** The recorded answers of one forge: test/fixtures/forge/<name>.json */
export const recordings = (name) => JSON.parse(fs.readFileSync(path.join(CORNFIELD, 'test', 'fixtures', 'forge', `${name}.json`), 'utf8'));

/**
 * @param {Record<string, any>} routes
 * @returns {Promise<{ url: string, requests: { method: string, url: string, headers: http.IncomingHttpHeaders, body: string }[], close: () => Promise<void> }>}
 */
export async function fakeForge(routes) {
  const requests = [];
  let origin = '';
  const fill = (v) => (typeof v === 'string' ? v.replaceAll('{origin}', origin) : v);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const seen = { method: req.method || '', url: req.url || '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(seen);
      const route = routes[`${seen.method} ${seen.url}`];
      const answer = typeof route === 'function' ? await route(seen) : route ?? { status: 404, body: { message: 'Not Found' } };
      const headers = Object.fromEntries(Object.entries(answer.headers || {}).map(([k, v]) => [k, fill(v)]));
      const body = answer.body === undefined ? '' : typeof answer.body === 'string' ? fill(answer.body) : JSON.stringify(answer.body);
      if (answer.body !== undefined && typeof answer.body !== 'string' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json; charset=utf-8';
      if (answer.hang) return; // never answers: the adapter's time limit has to end it
      res.writeHead(answer.status ?? 200, headers);
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: origin,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
