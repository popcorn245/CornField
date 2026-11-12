// A fake cornfield server for the tests of corn-scope and a corn-map with a `src` (components/test/scope*.test.ts): routes under /fake/<name>/ on the
// dev server, and a second server on another origin that gives no CORS answer (the page that is not listed). It answers what the real one answers, as
// far as a test needs: the config, the topology, the theme, a 401, a 500, a slow answer. Nothing generated is committed.
//
//   /fake/ok/…         a signed-in maintainer: config (version = this package's), topology, theme
//   /fake/other/…      the same server with another map (three nodes), for two scopes on one page
//   /fake/auth/…       401 on every gated read, as a signed-out visitor
//   /fake/error/…      500
//   /fake/slow/…       as ok, after 600 ms
//   /fake/plugins/…    a config that names plugin modules (sources) and a link and a brand with a script scheme: none may become script
//   /fake/hostile/…    a theme with a body rule, a star rule, an @import, an @font-face, a hook rule, tokens, a non-corn custom property
//   /fake/gate/…       401 until /fake/gate/open is asked, then ok (a retry test)
//   /fake/origin.json  { origin }: the address of the other server, which answers with no CORS header at all
import http from 'node:http';

const THEME = `
@import url("/fake/ok/imported.css");
@font-face { font-family: "Fake Pixel"; src: url("/cornfield/theme/assets/fonts/fake.woff2") format("woff2"); }
:root { --corn-accent: #c8102e; --corn-ok: #118833; --corn-ground: #1a1640; --brand-private: 12px; --corn-ground-image: url("/cornfield/theme/assets/bg.png"); }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { --corn-ground: #fdf3dc; --corn-accent: #b00b1e; } }
:root[data-theme="light"] { --corn-ground: #fdf3dc; --corn-accent: #b00b1e; }
body { display: none !important; background: red; }
* { color: rgb(255, 0, 0); }
[data-corn="map-stage"] { outline: 3px solid rgb(0, 128, 0); }
[data-corn="source-title"] { letter-spacing: 3px; }
.not-ours { color: blue; }
`;

const TOPOLOGY = (names) => ({ nodes: names.map((id, i) => ({ id, label: id, type: i === 0 ? 'root' : 'core', x: 0, y: 0 })), edges: names.slice(1).map((to) => ({ from: names[0], to, type: 'owns' })) });
const SMALL = TOPOLOGY(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']);
const OTHER = TOPOLOGY(['one', 'two', 'three']);

/** @param {string} version the package's version, which `ok` reports */
export function fakeCornfield(version) {
  let other = null;
  let gateOpen = false;
  const json = (res, status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const config = (extra = {}) => ({ name: 'cornfield', version, title: 'Fake', strings: {}, layers: { add: [], off: [], order: [] }, theme: null, signIn: { login: 'maintainer-one' }, ...extra });

  async function handle(req, res, next) {
    const m = /^\/fake\/([a-z]+)(\/.*)$/.exec(req.url.split('?')[0]);
    if (!m) return next();
    const [, name, route] = m;
    if (name === 'gate' && route === '/open') { gateOpen = true; return json(res, 200, { ok: true }); }
    if (name === 'gate' && route === '/close') { gateOpen = false; return json(res, 200, { ok: true }); }
    const gated = route === '/cornfield/config.json' || route === '/topology.json';
    if (name === 'auth' && gated) return json(res, 401, { ok: false, error: 'Sign in first.' });
    if (name === 'gate' && gated && !gateOpen) return json(res, 401, { ok: false, error: 'Sign in first.' });
    if (name === 'error' && gated) return json(res, 500, { error: 'boom' });
    if (name === 'slow') await sleep(600);
    if (route === '/cornfield/config.json') return json(res, 200, name === 'plugins'
      ? config({ sources: { live: { module: '/repo/plugins/live.js', options: {} }, checker: { module: '/fake/plugins/checker.js', options: {} } }, links: [{ label: 'x', href: 'javascript:alert(1)' }], brand: { logo: '/fake/plugins/logo.js', appName: 'Hostile' }, forge: { type: 'github', url: 'https://example.test', repo: 'a/b' } })
      : config());
    if (route === '/topology.json') return json(res, 200, name === 'other' ? OTHER : SMALL);
    if (route === '/cornfield/theme.css') { res.statusCode = 200; res.setHeader('Content-Type', 'text/css'); return res.end(name === 'hostile' || name === 'ok' ? THEME : ''); }
    if (route === '/imported.css') { res.setHeader('Content-Type', 'text/css'); return res.end(':root { --corn-text: #00ff00; }'); }
    res.statusCode = 404;
    res.end('no');
  }

  return {
    name: 'corn-fake-cornfield',
    async configureServer(devServer) {
      devServer.middlewares.use((req, res, next) => {
        if (req.url === '/fake/origin.json') {
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({ origin: other ? `http://127.0.0.1:${other.address().port}` : null }));
        }
        handle(req, res, next).catch((err) => { res.statusCode = 500; res.end(String(err)); });
      });
      // The other origin: it answers a page's no-cors reach test and nothing else, and gives no CORS header: the page that is not listed
      other = http.createServer((req, res) => { res.statusCode = 200; res.setHeader('Content-Type', 'text/css'); res.end(''); });
      await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
      devServer.httpServer?.once('close', () => other.close());
    },
  };
}
