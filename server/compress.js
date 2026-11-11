/**
 * @module server/compress
 *
 * Compresses the text the server sends (the page, JS, CSS, JSON, SVG) with Node's own zlib: brotli when the browser
 * accepts it, gzip otherwise, never for what is already compressed (images, fonts) or streamed (event streams), and never
 * on top of an answer that already carries a `Content-Encoding`, never a proxied upstream's answer or a range, and never
 * an answer marked `Cache-Control: no-store` (what may hold a secret: sign-in, tokens, the agent and runner APIs; BREACH).
 * Every compressible answer says `Vary: Accept-Encoding`, so a cache keeps the two apart. ETags are weak (files.js) and
 * the same for every encoding, so a conditional request still gets its 304.
 *
 * Used by wrapping the response once, at the top of the request: `compressResponse(req, res)`.
 */

import zlib from 'node:zlib';

/** Content types worth compressing: text, JSON (and `+json`), JavaScript, XML, SVG */
const COMPRESSIBLE = /^(?:text\/(?!event-stream)|application\/(?:json|javascript|ecmascript|xml|manifest\+json|[\w.+-]+\+(?:json|xml))|image\/svg\+xml)/i;
/** Below this many bytes (when the length is known) compressing costs more than it saves */
const MIN_BYTES = 512;

/**
 * The encoding to answer with, from an `Accept-Encoding` header: `br`, `gzip`, or null. A `q=0` refuses one.
 * @param {string|undefined} header
 * @returns {'br'|'gzip'|null}
 */
export function pickEncoding(header) {
  if (!header) return null;
  const q = new Map();
  for (const part of String(header).split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const m = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    q.set(name.trim(), m ? Number(m.slice(2)) : 1);
  }
  const weight = (e) => { const v = q.has(e) ? q.get(e) : q.has('*') ? q.get('*') : 0; return Number.isFinite(v) && v > 0 ? v : 0; };
  const br = weight('br');
  const gzip = Math.max(weight('gzip'), weight('x-gzip'));
  if (!br && !gzip) return null;
  return br >= gzip ? 'br' : 'gzip'; // the one the browser prefers; brotli on a tie
}

/** Whether a `Content-Type` is one of the compressible kinds */
export const isCompressible = (type) => typeof type === 'string' && COMPRESSIBLE.test(type.trim());

const SKIP = Symbol('cornfield.noCompress');

/**
 * Leaves this answer as it is: a proxied upstream's answer (it may be a stream, or a range, and the upstream saw the
 * request's Accept-Encoding itself).
 * @param {import('node:http').ServerResponse} res
 */
export function skipCompression(res) { /** @type {any} */ (res)[SKIP] = true; }

const hasVary = (v, name) => String(v || '').split(',').some((t) => t.trim().toLowerCase() === name.toLowerCase() || t.trim() === '*');

/**
 * Wraps `res` so a compressible answer goes out compressed when the request allows it. Safe to call on every request:
 * it changes nothing until `writeHead` (or the first write) shows a compressible body.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function compressResponse(req, res) {
  const encoding = pickEncoding(req.headers['accept-encoding']);
  const origWriteHead = res.writeHead.bind(res);
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  let decided = false;
  let writeImpl = origWrite;
  let endImpl = origEnd;
  // Sending a body without `writeHead` first (Node adds the head itself): decide before it goes
  res.write = (...a) => { if (!decided) res.writeHead(res.statusCode); return writeImpl(...a); };
  res.end = (...a) => { if (!decided) res.writeHead(res.statusCode); return endImpl(...a); };

  const header = (extra, name) => {
    if (extra && !Array.isArray(extra)) {
      const key = Object.keys(extra).find((k) => k.toLowerCase() === name.toLowerCase());
      if (key !== undefined) return extra[key];
    }
    return res.getHeader(name);
  };

  res.writeHead = (status, ...rest) => {
    // The caller's headers may be a constant it sends again (server.js JSON_HEADERS): change a copy, never that
    const at = rest.findIndex((x) => x && typeof x === 'object');
    if (at >= 0 && !Array.isArray(rest[at])) rest[at] = { ...rest[at] };
    const extra = at >= 0 ? rest[at] : undefined;
    if (!decided) {
      decided = true;
      const type = header(extra, 'content-type');
      const bodyless = status < 200 || status === 204 || (status === 304 && !isCompressible(type));
      if (!bodyless && isCompressible(type)) {
        // The answer varies by the request's Accept-Encoding whether or not this one is compressed (a 304 too)
        const vary = header(extra, 'vary');
        if (!hasVary(vary, 'accept-encoding')) {
          if (extra && !Array.isArray(extra)) extra.Vary = vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding';
          else res.setHeader('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
        }
        const length = Number(header(extra, 'content-length'));
        const done = header(extra, 'content-encoding');
        // `no-store` marks what the server treats as secret (sign-in pages, tokens, the agent and runner APIs): a body
        // that may hold a secret beside what the request sent is never compressed (the BREACH class of attack)
        const cache = String(header(extra, 'cache-control') || '');
        const keep = /no-transform|no-store/i.test(cache) || /** @type {any} */ (res)[SKIP]
          || status === 206 || header(extra, 'content-range') !== undefined;
        if (encoding && status !== 304 && !done && !keep && !(Number.isFinite(length) && length > 0 && length < MIN_BYTES)) {
          if (extra && !Array.isArray(extra)) {
            Object.keys(extra).filter((k) => k.toLowerCase() === 'content-length').forEach((k) => { delete extra[k]; });
            extra['Content-Encoding'] = encoding;
          } else res.setHeader('Content-Encoding', encoding);
          res.removeHeader('Content-Length');
          if (req.method !== 'HEAD') startStream();
        }
      }
    }
    return origWriteHead(status, ...rest);
  };

  function startStream() {
    const stream = encoding === 'br'
      // Quality 4 is the cheap end: about as fast as gzip, and smaller
      ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT } })
      : zlib.createGzip({ level: 6 });
    stream.on('data', (chunk) => origWrite(chunk));
    stream.on('end', () => origEnd());
    stream.on('error', () => res.destroy());
    stream.on('drain', () => res.emit('drain'));
    writeImpl = (chunk, enc, cb) => stream.write(chunk, enc, cb);
    endImpl = (chunk, enc, cb) => {
      if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
      if (chunk !== undefined && chunk !== null) stream.end(chunk, typeof enc === 'string' ? enc : undefined, cb);
      else stream.end(cb);
      return res;
    };
  }
}
