// A fake cornfield server for the tests of corn-scope and a corn-map with a `src` (components/test/scope*.test.ts): routes under /fake/<name>/ on the
// dev server, and a second server on another origin that gives no CORS answer (the page that is not listed). It answers what the real one answers, as
// far as a test needs: the config, the topology, the theme, a 401, a 500, a slow answer. Nothing generated is committed.
//
//   /fake/ok/…         a signed-in maintainer: config (version = this package's), topology, theme
//   /fake/other/…      the same server with another map (three nodes), for two scopes on one page
//   /fake/auth/…       401 on every gated read, as a signed-out visitor
//   /fake/forbidden/…  403 on every gated read, as a signed-in visitor who is not a maintainer
//   /fake/error/…      500
//   /fake/slow/…       as ok, after 600 ms
//   /fake/plugins/…    a config that names plugin modules (sources) and a link and a brand with a script scheme: none may become script
//   /fake/hostile/…    a theme with a body rule, a star rule, an @import, an @font-face, a hook rule, tokens, a non-corn custom property
//   /fake/gate/…       401 until /fake/gate/open is asked, then ok (a retry test)
//   /fake/leaky/…      as ok, with a theme that names the other server in every way CSS can load something (tokens, rules, escapes, image-set,
//                      @keyframes, nesting, @font-face, @property, a shorthand with var(), @scope, @supports, @layer)
//   /fake/expired/…    as ok, but the decision's own reads (/proposals/<slug>/decision and /review) answer 401: a session that ended while a review was open
//   /fake/origin.json  { origin }: the address of the other server, which answers with no CORS header at all
//   /fake/reviews.json  the review PUTs the fake took since the last time this was read: { method, url, body } (and forgets them)
//   /fake/other-hits.json  what the other server was asked since the last time this was read (and forgets it)
import http from 'node:http';

const THEME = `
@import url("/fake/ok/imported.css");
@font-face { font-family: "Fake Pixel"; src: url("/cornfield/theme/assets/fonts/fake.woff2") format("woff2"); }
:root { --corn-accent: #c8102e; --corn-ok: #118833; --corn-ground: #1a1640; --corn-map-edge-width: 8; --brand-private: 12px; --corn-ground-image: url("/cornfield/theme/assets/bg.png"); }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { --corn-ground: #fdf3dc; --corn-accent: #b00b1e; } }
:root[data-theme="light"] { --corn-ground: #fdf3dc; --corn-accent: #b00b1e; }
body { display: none !important; background: red; }
* { color: rgb(255, 0, 0); }
[data-corn="map-stage"] { outline: 3px solid rgb(0, 128, 0); }
[data-corn="source-title"] { letter-spacing: 3px; }
.not-ours { color: blue; }
`;

/** A theme that tries every way to make the host page load something from another origin (`away`) */
const LEAKY = (away) => `
:root { --corn-accent: #0a7d3b; --corn-ground-image: url("${away}/token.png"); }
:root { --corn-surface-1: u\\72l(${away}/escaped-token.png); }
:root { --corn-surface-2: image-set("${away}/imgset-token.png" 1x); }
:root { --corn-surface-3: var(--nope, url(${away}/fallback-token.png)); }
:root { --corn-shadow: \\75 rl(${away}/escaped2-token.png); }
[data-corn="map-stage"] { background-image: url("${away}/rule.png"); }
[data-corn="map-stage"] { border-image: image-set("${away}/imgset-rule.png" 1x) 1; }
[data-corn="map-stage"] { --private: url(${away}/private-var.png); background-image: var(--private); }
[data-corn="map-stage"] { background: var(--nothing, red) url(${away}/shorthand.png); }
[data-corn="map-stage"] { & > * { background-image: url(${away}/nested.png); } }
@keyframes leak { from { background-image: url(${away}/keyframe.png); } to { background-image: url(${away}/keyframe2.png); } }
[data-corn="map-stage"] { animation: leak 1s infinite; }
@supports (display: grid) { [data-corn="map-stage"] { list-style-image: url(${away}/supports.png); } }
@layer x { [data-corn="map-stage"] { cursor: url(${away}/cursor.png), auto; } }
@scope ([data-corn="map-stage"]) { canvas { background-image: url(${away}/scope.png); } }
@property --leakp { syntax: '<image>'; inherits: true; initial-value: url(${away}/property.png); }
@font-face { font-family: "Leak"; src: url(${away}/font.woff2); }
[data-corn="map-stage"] { mask-image: url(${away}/mask.svg#m); }
[data-corn="map-stage"] { outline: 3px solid rgb(0, 128, 0); background-color: rgb(1, 2, 3); }
[data-corn="map-overlay"] { background-image: url("/cornfield/theme/assets/ok.png"); }
:root { --corn-line: url(${away}/open-token.png }
`;

const TOPOLOGY = (names) => ({ nodes: names.map((id, i) => ({ id, label: id, type: i === 0 ? 'root' : 'core', x: 0, y: 0 })), edges: names.slice(1).map((to) => ({ from: names[0], to, type: 'owns' })) });
const SMALL = TOPOLOGY(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']);
const OTHER = TOPOLOGY(['one', 'two', 'three']);
const SHA = 'a'.repeat(63) + 'b';
/** One proposal for SMALL: a node added under alpha, one changed, an edge added; its scenario walks the added node. It is a spec PR's (`pull/7`), so it can be decided on. */
const PROPOSAL = {
  version: 1, spec: '0001', title: 'A fake change', summary: 'Adds a node under alpha and changes beta.',
  nodes: { add: [{ id: 'eta', label: 'eta', type: 'core', parent: 'alpha', desc: 'The new node.' }], change: [{ id: 'beta', set: { desc: 'Beta, changed.' }, why: 'for the test' }] },
  edges: { add: [{ from: 'eta', to: 'beta', kind: 'calls', status: 'proposed', label: 'asks beta' }] },
  scenarios: [{ id: 'walk', title: 'A walk', steps: [{ node: 'eta', text: 'You open eta.' }, { edge: { from: 'eta', to: 'beta', kind: 'calls' }, text: 'It asks beta.' }] }],
};
const FACTS = { pull: { number: 7, draft: false, head: 'f00d'.repeat(10) }, checks: { total: 1, passed: 1, running: 0, failed: [] }, lands: false, run: null };

/** @param {string} version the package's version, which `ok` reports */
export function fakeCornfield(version) {
  let other = null;
  let gateOpen = false;
  let reviewed = false;
  const hits = [];
  const reviews = [];
  const json = (res, status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const config = (extra = {}) => ({ name: 'cornfield', version, title: 'Fake', strings: {}, layers: { add: [], off: [], order: [] }, theme: null, signIn: { login: 'maintainer-one' }, ...extra });

  async function handle(req, res, next) {
    const m = /^\/fake\/([a-z]+)(\/.*)$/.exec(req.url.split('?')[0]);
    if (!m) return next();
    const [, name, route] = m;
    if (name === 'gate' && route === '/open') { gateOpen = true; return json(res, 200, { ok: true }); }
    if (name === 'gate' && route === '/close') { gateOpen = false; return json(res, 200, { ok: true }); }
    const decisional = /^\/proposals\/[^/]+\/(?:decision|review)$/.test(route);
    const gated = route === '/cornfield/config.json' || route === '/topology.json' || route === '/proposals' || /^\/proposals\/[^/]+\.json$/.test(route) || (decisional && name !== 'expired');
    if (name === 'expired' && decisional) return json(res, 401, { ok: false, error: 'Sign in first.' });
    if (name === 'auth' && gated) return json(res, 401, { ok: false, error: 'Sign in first.' });
    if (name === 'forbidden' && gated) return json(res, 403, { ok: false, error: 'Only maintainers can open this; ask one.' });
    if (name === 'gate' && gated && !gateOpen) return json(res, 401, { ok: false, error: 'Sign in first.' });
    if (name === 'error' && gated) return json(res, 500, { error: 'boom' });
    if (name === 'slow') await sleep(600);
    if (route === '/cornfield/config.json') return json(res, 200, name === 'plugins'
      ? config({ sources: { live: { module: '/repo/plugins/live.js', options: {} }, checker: { module: '/fake/plugins/checker.js', options: {} } }, links: [{ label: 'x', href: 'javascript:alert(1)' }], brand: { logo: '/fake/plugins/logo.js', appName: 'Hostile' }, forge: { type: 'github', url: 'https://example.test', repo: 'a/b' } })
      : config());
    if (route === '/topology.json') return json(res, 200, name === 'other' ? OTHER : SMALL);
    if (route === '/cornfield/theme.css') { res.statusCode = 200; res.setHeader('Content-Type', 'text/css'); return res.end(name === 'hostile' || name === 'ok' ? THEME : name === 'leaky' ? LEAKY(`http://127.0.0.1:${other.address().port}`) : ''); }
    if (route.startsWith('/cornfield/theme/assets/')) { res.statusCode = 200; res.setHeader('Content-Type', 'image/png'); return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')); }
    // The proposals (the review's reads), of the one spec PR the fake has
    if (route === '/proposals') return json(res, 200, [{ slug: '0001-fake', source: 'pull/7', title: PROPOSAL.title }]);
    const named = /^\/proposals\/([^/]+)\.json$/.exec(route);
    if (named) {
      const wanted = new URL(req.url, 'http://x').searchParams.get('source');
      if (named[1] === 'boom') return json(res, 500, { error: 'The proposal could not be read.' });
      if (named[1] !== '0001-fake' || (wanted && wanted !== 'pull/7')) return json(res, 404, { ok: false, error: 'no such proposal' });
      res.setHeader('X-Proposal-Source', 'pull%2F7');
      res.setHeader('X-Proposal-Sha256', SHA);
      return json(res, 200, PROPOSAL);
    }
    if (/^\/proposals\/[^/]+\/decision$/.test(route)) return json(res, 200, FACTS);
    if (/^\/proposals\/[^/]+\/review$/.test(route)) {
      if (req.method === 'PUT') {
        let body = '';
        for await (const chunk of req) body += chunk;
        reviews.push({ method: 'PUT', url: req.url, body: JSON.parse(body || '{}') });
        const again = reviewed;
        reviewed = true;
        return json(res, 200, { verdict: JSON.parse(body || '{}').verdict || 'approved', at: new Date().toISOString(), by: 'maintainer-one', posted: !again });
      }
      return json(res, 404, { ok: false, error: 'no review yet' });
    }
    if (route === '/imported.css') { res.setHeader('Content-Type', 'text/css'); return res.end(':root { --corn-text: #00ff00; }'); }
    res.statusCode = 404;
    res.end('no');
  }

  return {
    name: 'corn-fake-cornfield',
    async configureServer(devServer) {
      devServer.middlewares.use((req, res, next) => {
        if (req.url === '/fake/other-hits.json') {
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify(hits.splice(0)));
        }
        if (req.url === '/fake/reviews.json') {
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify(reviews.splice(0)));
        }
        if (req.url === '/fake/origin.json') {
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({ origin: other ? `http://127.0.0.1:${other.address().port}` : null }));
        }
        handle(req, res, next).catch((err) => { res.statusCode = 500; res.end(String(err)); });
      });
      // The other origin: it answers a page's no-cors reach test and nothing else, and gives no CORS header: the page that is not listed
      other = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.statusCode = 200; res.setHeader('Content-Type', 'text/css'); res.end(''); });
      await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
      devServer.httpServer?.once('close', () => other.close());
    },
  };
}
