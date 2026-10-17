/**
 * @module server/proxy
 *
 * Same-origin paths for a live source: `proxy: { '/api/': 'http://127.0.0.1:3245' }` in the config sends
 * `/api/*` on to that upstream and pipes the answer back, so a browser module can call its own API
 * without cross-origin requests. The browser's `Authorization` header rides along; nothing is added.
 * An upstream that cannot answer is a 502 with a JSON body.
 */

import http from 'node:http';
import https from 'node:https';

/**
 * Forwards `req` to `target` (an origin) and pipes the answer back.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} target like `http://127.0.0.1:3245`
 */
export function proxyTo(req, res, target) {
  const url = new URL(target);
  const client = url.protocol === 'https:' ? https : http;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const upstream = client.request({
    protocol: url.protocol,
    hostname: url.hostname,
    port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${url.hostname}:${port}` },
  }, (answer) => {
    res.writeHead(answer.statusCode || 502, answer.headers);
    answer.pipe(res);
  });
  upstream.on('error', (err) => {
    if (res.headersSent) { res.end(); return; }
    if (res.destroyed) return;
    console.error(`[proxy] ${url.host} did not answer: ${err.message}`);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Bad Gateway: the upstream did not answer' }));
  });
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
}
