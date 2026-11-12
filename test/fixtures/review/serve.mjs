/**
 * A tiny static server for the review harness (test/fixtures/review/index.html): the page, the explorer's modules and stylesheets as a host app would
 * load them, and the synthetic repo's topology and proposals as plain files, so a review piece can be handed objects with no cornfield server at all.
 *
 *   node test/fixtures/review/serve.mjs --port 3831 --repo <dir>    <dir>: a repo test/fixtures/big/make.js wrote (the rig's own, `--dir`)
 *
 *   /                      the harness page            /explorer/*, /core/*   cornfield's own files, read from this checkout
 *   /host.css              the host app's own styles   /tokens.css   the default tokens as the package ships them (components/scripts/tokens.mjs)
 *   /data/topology.json    the repo's map              /data/proposals/<slug>.json   one of its proposals
 *   ?csp=1 on the page     sends a strict Content-Security-Policy (no inline style or script; requests only to itself and the rig's `*.corn.localhost`)
 *
 * Listens on 127.0.0.1 only. A browser reaches it by any `*.localhost` name (Chromium resolves them to loopback), which is how the harness is a
 * sibling origin of the rig (`serve.js --embed http://tasks.corn.localhost:<port>`): test/fixtures/review/proof.mjs does that.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultTokensCss } from '../../../components/scripts/tokens.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

/** What a host page that takes no inline style or script allows: the strictest a host is likely to send, with the rig as the one other origin */
export const STRICT_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: http://*.corn.localhost:*; font-src 'self' http://*.corn.localhost:*; connect-src 'self' http://*.corn.localhost:*; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** @param {{ port: number, repo: string }} opts */
export function serveHarness({ port, repo }) {
  /** A file under `dir` for a URL path below `prefix`, or null: nothing outside `dir` is ever read */
  const under = (dir, rest) => {
    const file = path.resolve(dir, `.${path.posix.normalize(`/${decodeURIComponent(rest)}`)}`);
    return file.startsWith(dir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    let file = null;
    if (p === '/tokens.css') {
      res.writeHead(200, { 'Content-Type': TYPES['.css'], 'Cache-Control': 'no-store' });
      res.end(defaultTokensCss(fs.readFileSync(path.join(ROOT, 'explorer', 'tokens.css'), 'utf8')));
      return;
    }
    const headers = {};
    if ((p === '/' || p === '/index.html') && url.searchParams.get('csp') === '1') headers['Content-Security-Policy'] = STRICT_CSP;
    if (p === '/' || p === '/index.html') file = path.join(HERE, 'index.html');
    else if (p === '/host.css') file = path.join(HERE, 'host.css');
    else if (p === '/harness.js') file = path.join(HERE, 'harness.js');
    else if (p.startsWith('/explorer/')) file = under(path.join(ROOT, 'explorer'), p.slice('/explorer/'.length));
    else if (p.startsWith('/core/')) file = under(path.join(ROOT, 'core'), p.slice('/core/'.length));
    else if (p === '/data/topology.json') file = under(repo, 'topology.json');
    else if (p.startsWith('/data/proposals/')) file = under(path.join(repo, 'docs', 'specs', 'proposals'), p.slice('/data/proposals/'.length));
    if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...headers });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
  const port = Number(arg('port') || 3831);
  const repo = arg('repo');
  if (!repo) { console.error('usage: node test/fixtures/review/serve.mjs --port <port> --repo <dir>'); process.exit(2); }
  await serveHarness({ port, repo: path.resolve(repo) });
  console.log(`The review harness is on http://127.0.0.1:${port}/  (Ctrl-C stops it)`);
}
