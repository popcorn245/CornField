/**
 * @module server/proxy
 *
 * Same-origin paths for a live source: `proxy: { '/api/': 'http://127.0.0.1:3245' }` in the config sends
 * `/api/*` on to that upstream and pipes the answer back, so a browser module can call its own API
 * without cross-origin requests. The browser's `Authorization` header rides along; nothing is added.
 * An upstream that cannot answer is a 502 with a JSON body.
 *
 * cornfield's own cookies (the session and the sign-in state, `OWN_COOKIES`) never reach the upstream, and the
 * upstream cannot set them: they are taken out of the `Cookie` header going up and out of `Set-Cookie` coming back.
 * The session is a bearer credential for the whole dashboard, and the upstream is someone else's server.
 */

import http from 'node:http';
import https from 'node:https';

/** The cookies that are cornfield's (server/auth.js names them), with and without the `__Host-` prefix */
export const OWN_COOKIES = Object.freeze(['cornfield', 'cornfield-oauth', '__Host-cornfield', '__Host-cornfield-oauth']);

const cookieName = (pair) => pair.slice(0, pair.indexOf('=') < 0 ? pair.length : pair.indexOf('=')).trim();

/** A `Cookie` header without cornfield's own cookies, or undefined when nothing is left */
export function withoutOwnCookies(header) {
  if (header === undefined) return undefined;
  const kept = String(header).split(';').map((p) => p.trim()).filter((p) => p && !OWN_COOKIES.includes(cookieName(p)));
  return kept.length ? kept.join('; ') : undefined;
}

/** The upstream's `Set-Cookie` values without any that would set one of cornfield's own cookies */
export function withoutOwnSetCookies(values) {
  if (values === undefined) return undefined;
  const kept = (Array.isArray(values) ? values : [values]).filter((v) => !OWN_COOKIES.includes(cookieName(String(v).split(';')[0])));
  return kept.length ? kept : undefined;
}

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
  const headers = { ...req.headers, host: `${url.hostname}:${port}` };
  const cookie = withoutOwnCookies(req.headers.cookie);
  if (cookie === undefined) delete headers.cookie;
  else headers.cookie = cookie;
  const upstream = client.request({
    protocol: url.protocol,
    hostname: url.hostname,
    port,
    path: req.url,
    method: req.method,
    headers,
  }, (answer) => {
    const back = { ...answer.headers };
    const setCookie = withoutOwnSetCookies(back['set-cookie']);
    if (setCookie === undefined) delete back['set-cookie'];
    else back['set-cookie'] = setCookie;
    res.writeHead(answer.statusCode || 502, back);
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
