/**
 * A tiny static server for the review harness (test/fixtures/review/index.html): the page, the explorer's modules and stylesheets as a host app would
 * load them, and the synthetic repo's topology and proposals as plain files, so a review piece can be handed objects with no cornfield server at all.
 *
 *   node test/fixtures/review/serve.mjs --port 3831 --repo <dir>    <dir>: a repo test/fixtures/big/make.js wrote (the rig's own, `--dir`)
 *
 *   /                      the harness page            /explorer/*, /core/*   cornfield's own files, read from this checkout
 *   /data/topology.json    the repo's map              /data/proposals/<slug>.json   one of its proposals
 *
 * Listens on 127.0.0.1 only. A browser reaches it by any `*.localhost` name (Chromium resolves them to loopback), which is how the harness is a
 * sibling origin of the rig (`serve.js --embed http://tasks.corn.localhost:<port>`): test/fixtures/review/proof.mjs does that.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

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
    if (p === '/' || p === '/index.html') file = path.join(HERE, 'index.html');
    else if (p === '/harness.js') file = path.join(HERE, 'harness.js');
    else if (p.startsWith('/explorer/')) file = under(path.join(ROOT, 'explorer'), p.slice('/explorer/'.length));
    else if (p.startsWith('/core/')) file = under(path.join(ROOT, 'core'), p.slice('/core/'.length));
    else if (p === '/data/topology.json') file = under(repo, 'topology.json');
    else if (p.startsWith('/data/proposals/')) file = under(path.join(repo, 'docs', 'specs', 'proposals'), p.slice('/data/proposals/'.length));
    if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
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
