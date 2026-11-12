/**
 * @module server/components
 *
 * The web components (components/, spec 0011 D11) served from this server, at `/cornfield/components/<file>`, so a host app loads them with
 * one `<script type="module" src="https://map.example.com/cornfield/components/corn-map.js">` and always gets the build that matches the server.
 *
 * cornfield has no build step: a checkout has no built components, and then this route answers a plain 404 that says how to get them. The
 * image builds them (Dockerfile) into `components/dist` beside the server, and so does `cd components && npm ci && npm run build`. One rule:
 * the folder is `<cornfield>/components/dist`, and it is served only when `manifest.json` (written last by the build, components/scripts/manifest.mjs)
 * is there.
 *
 * What is served is what the manifest names, looked up by exact name in a map: a request path is never joined into a file path, so there is no
 * traversal to get wrong, no listing, no dotfile, and nothing the build did not produce. Only `.js`, `.css`, `.json`, `.d.ts` and `.map`.
 *
 * The route is open (before the sign-in guard): a browser fetches a module script from another origin with CORS and without the cookie. It holds
 * no secret: it is the published package. server/embed.js adds the CORS headers for a listed origin; with none listed there are none.
 *
 * Headers: the type, `nosniff`, a strong ETag (the content's hash, and the encoding's name when the answer will be compressed, so two encodings
 * are two ETags), and caching: `chunks/<name>-<hash>.js` are named by their content, so cached for a year; everything else (`corn-map.js`,
 * `index.js`, `version.json`, `tokens.css`, the types) is revalidated every time, so a host always gets this server's version.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pickEncoding } from './compress.js';
import { notFound } from './files.js';

export const COMPONENTS_PREFIX = '/cornfield/components/';

/** Plain segments, none starting with a dot (the same rule the build holds its manifest to) */
const SAFE_PATH = /^(?!\.)[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/(?!\.)[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const TYPES = [
  [/\.js$/, 'application/javascript; charset=utf-8'],
  [/\.css$/, 'text/css; charset=utf-8'],
  [/\.json$/, 'application/json; charset=utf-8'],
  [/\.map$/, 'application/json; charset=utf-8'],
  [/\.d\.ts$/, 'text/plain; charset=utf-8'],
];
/** A chunk the build named by its content */
const HASHED = /^chunks\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.js$/;
const MAX_BYTES = 4 * 1024 * 1024;
/** server/compress.js does not compress below this */
const MIN_COMPRESSED = 512;

const NOT_BUILT = 'The web components are not built here: this cornfield runs from a checkout, which has no build step.\n'
  + 'Build them with `cd components && npm ci && npm run build`, or run the Docker image (it builds them), or install @popcorn245/cornfield-components from npm.\n';

/** @param {{ dir: string }} opts the folder the build wrote (`components/dist`) */
export function createComponents({ dir }) {
  const root = path.resolve(dir);
  /** @type {{ stamp: string, names: Set<string> } | null} */
  let listed = null;
  /** @type {Map<string, { stamp: string, body: Buffer, etag: string }>} */
  const bodies = new Map();

  /** The names the manifest lists, read again when it changes; null when nothing is built (or the manifest is not one) */
  function names() {
    const file = path.join(root, 'manifest.json');
    let stats;
    try { stats = fs.lstatSync(file); } catch { return (listed = null); }
    if (!stats.isFile() || stats.size > MAX_BYTES) return (listed = null);
    const stamp = `${stats.size}:${stats.mtimeMs}`;
    if (listed?.stamp === stamp) return listed.names;
    try {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      const out = new Set();
      for (const f of Array.isArray(manifest.files) ? manifest.files : []) {
        const p = f && typeof f.path === 'string' ? f.path : '';
        if (SAFE_PATH.test(p) && TYPES.some(([re]) => re.test(p))) out.add(p);
      }
      bodies.clear();
      listed = { stamp, names: out };
      return out;
    } catch {
      return (listed = null);
    }
  }

  /** The bytes of a listed file and their ETag; null when it is not a plain file there */
  function load(name) {
    const file = path.join(root, ...name.split('/'));
    let stats;
    try { stats = fs.lstatSync(file); } catch { return null; }
    if (!stats.isFile() || stats.size > MAX_BYTES) return null;
    // lstat looks at the last segment only: a folder on the way (`chunks`) that is a link out of the build is refused too. The build folder
    // itself may be a link; what is served is what lies, really, inside it
    let real;
    try {
      real = fs.realpathSync(file);
      const realRoot = fs.realpathSync(root);
      if (real !== path.join(realRoot, ...name.split('/'))) return null;
    } catch { return null; }
    const stamp = `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}`;
    const known = bodies.get(name);
    if (known?.stamp === stamp) return known;
    try {
      const body = fs.readFileSync(real); // the path that was checked, not the one written
      const entry = { stamp, body, etag: createHash('sha256').update(body).digest('base64url').slice(0, 27) };
      bodies.set(name, entry);
      return entry;
    } catch {
      return null;
    }
  }

  return {
    dir: root,
    /** Whether the folder holds a build (a manifest) */
    built: () => names() !== null,
    /**
     * Answers a GET or HEAD under COMPONENTS_PREFIX.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {string} reqPath the decoded path
     */
    serve(req, res, reqPath) {
      const listing = names();
      if (!listing) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
        return res.end(`404 Not Found: ${reqPath}\n${NOT_BUILT}`);
      }
      const name = reqPath.slice(COMPONENTS_PREFIX.length);
      const found = listing.has(name) ? load(name) : null;
      if (!found) return notFound(res, reqPath);
      const type = TYPES.find(([re]) => re.test(name))[1];
      // The compressor (server/compress.js) will encode this answer when it is long enough and the browser accepts one: the ETag names the encoding
      const encoding = found.body.length >= MIN_COMPRESSED && /^(?:text\/|application\/(?:javascript|json))/.test(type) ? pickEncoding(req.headers['accept-encoding']) : null;
      const etag = `"${found.etag}${encoding ? `-${encoding}` : ''}"`;
      const headers = {
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': HASHED.test(name) ? 'public, max-age=31536000, immutable' : 'no-cache',
        ETag: etag,
      };
      const asked = req.headers['if-none-match'];
      if (asked && (asked.trim() === '*' || asked.split(',').some((t) => t.trim().replace(/^W\//, '') === etag))) {
        res.writeHead(304, headers);
        return res.end();
      }
      res.writeHead(200, { ...headers, 'Content-Length': found.body.length });
      return res.end(req.method === 'HEAD' ? undefined : found.body);
    },
  };
}
