/**
 * @module server/compress
 *
 * Compresses the text the server sends (the page, JS, CSS, JSON, SVG) with Node's own zlib: brotli when the browser
 * accepts it, gzip otherwise, never for what is already compressed (images, fonts) or streamed (event streams), and never
 * on top of an answer that already carries a `Content-Encoding` (a proxied upstream, or a proxy in front that did it).
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
  const ok = (e) => (q.has(e) ? q.get(e) > 0 : q.has('*') && q.get('*') > 0);
  if (ok('br')) return 'br';
  if (ok('gzip') || ok('x-gzip')) return 'gzip';
  return null;
}

/** Whether a `Content-Type` is one of the compressible kinds */
export const isCompressible = (type) => typeof type === 'string' && COMPRESSIBLE.test(type.trim());

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
    const extra = rest.find((x) => x && typeof x === 'object');
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
        const noTransform = /no-transform/i.test(String(header(extra, 'cache-control') || ''));
        if (encoding && status !== 304 && !done && !noTransform && !(Number.isFinite(length) && length > 0 && length < MIN_BYTES)) {
          if (extra && !Array.isArray(extra)) { delete extra['Content-Length']; delete extra['content-length']; extra['Content-Encoding'] = encoding; } else res.setHeader('Content-Encoding', encoding);
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
