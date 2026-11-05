/**
 * @module server/server
 *
 * cornfield's HTTP server: zero dependencies, Node's own `http`. It serves the explorer, the target
 * repo's map and proposals, and, with sign-in, posts a maintainer's review as a comment on a spec PR. What it answers:
 *
 *   GET  /healthz                       { ok: true } and nothing else: the image's health check, open without a session
 *   *    /auth/…                        sign-in (server/auth.js), when it is configured
 *   GET  /                              the explorer (explorer/index.html), with the config's import map
 *   GET  /explorer/…, /core/…, /plugins/<name>/browser.js
 *                                       cornfield's own browser modules (an allowlist, never a folder of the repo)
 *   GET  /topology.json                 the repo's map (cornfield sync writes it)
 *   GET  /topology.cloud.json           the repo's cloud registry, without its env var names
 *   GET  /topology-fixture.json?nodes=… a synthetic map to measure the explorer on, made in memory
 *   GET  /cornfield/config.json         what the browser needs of the config: title, links, forge, sources
 *   GET  /cornfield/house.json          the repo's house file, when `sources.house` is the built-in house source;
 *                                       Home Assistant's floors, areas and devices, when it is `home-assistant`
 *   GET  /repo/<path>.js                a browser module the config names (and the files in its folder)
 *   GET  /api/forge/…                   issues, pull requests, their files and checks, release notes: read from the forge (server/forge-routes.js)
 *   POST /api/forge/pulls/<n>/merge|rerun   land a green pull request, re-run a failed check (server/forge-actions.js)
 *   POST /api/forge/issues/<n>/spec, /pulls/<n>/build   the pipeline's steps (server/pipeline.js, server/forge-actions.js)
 *   POST /api/forge/release-drafts      the release notes kept as a DRAFT release on the forge (never published, no tag made)
 *   POST /api/reviews                   Approve or Send back with a review token (`Authorization: Bearer cf_rt_…`), no cookie: the one
 *                                       route that answers before the sign-in guard, and takes the token alone (server/review-api.js)
 *   *    /api/review-tokens…, /api/agent-tokens…
 *                                       make, list and revoke review tokens, and agent tokens: the signed-in maintainer only (server/review-api.js)
 *   POST /api/agent-requests            ask for an agent run with an agent token (`Authorization: Bearer cf_at_…`), no cookie: before the guard too (server/agent-api.js)
 *   *    /api/agent-runs…               the dashboard's runs: list, one, start, stop; the signed-in maintainer only (server/agent-api.js, server/agent-runs.js)
 *   *    /proposals…                    server/proposals.js (with sign-in, the open spec PRs too: server/proposal-pulls.js,
 *                                       and a review is a comment on one: server/reviews.js)
 *   *    <proxy path>/…                 server/proxy.js, for each path the config's `proxy` names
 *
 * Before any route, `Host` must be a loopback name, or with sign-in the public URL's host too (else 421): a page on
 * another site could otherwise reach this server by DNS rebinding (server/bind.js `hostAllowed`).
 * With sign-in configured, every route but /healthz and /auth/… passes the admins-only guard first (server/auth.js):
 * no session is the sign-in page or a 401, a non-maintainer the "ask a maintainer" page or a 403. Without it, `listen`
 * only binds to loopback (server/bind.js); with it and an https public URL, it may bind to any address.
 *
 * No CORS headers: the explorer and its sources are all same-origin, so no other site's page has any
 * business reading what cornfield serves.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { browserSources, BUILTIN_SOURCES, parseDuration, specPollMs, triggersOf, DEFAULTS, ideaLabel } from '../core/config.js';
import { CLOUD_FILE } from '../core/cloud.js';
import { decodePath, inside, notFound, sendFile } from './files.js';
import { serveProposals } from './proposals.js';
import { serveForge } from './forge-routes.js';
import { hasAdapter } from './forge.js';
import { createRuns } from './agent-runs.js';
import { REQUESTS_PATH, serveAgentCall, serveRunRoutes } from './agent-api.js';
import { REVIEWS_PATH, serveReviewCall, serveTokenRoutes } from './review-api.js';
import { proxyTo } from './proxy.js';
import { HA_ENV, homeAssistantHouse } from '../plugins/house/home-assistant.js';
import { assertBind, hostAllowed } from './bind.js';
import { createAuth, signInSettings } from './auth.js';
import { createHooks, hooksSettings } from './hooks.js';
import { createLander } from './lander.js';
import { createSpecPoll } from './spec-poll.js';
import { createTriggers } from './triggers.js';

export const CORNFIELD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPLORER_DIR = path.join(CORNFIELD_DIR, 'explorer');
/** The pure core modules the explorer imports (no Node built-ins, no files): the only ones of core/ served */
export const BROWSER_CORE = ['schema.js', 'proposal.js', 'personas.js', 'cloud.js', 'text.js', 'mentions.js'];
/** cornfield's own browser sources, by request path */
const BROWSER_PLUGINS = new Map(Object.values(BUILTIN_SOURCES).map((p) => [p, path.join(CORNFIELD_DIR, p)]));
const PKG = JSON.parse(fs.readFileSync(path.join(CORNFIELD_DIR, 'package.json'), 'utf8'));

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
const sendJson = (res, status, body) => { res.writeHead(status, JSON_HEADERS); res.end(JSON.stringify(body)); };
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The import map the page carries: the config's (repo-local modules a source needs) */
function importMapOf(config) {
  const imports = { ...(config.importMap || {}) };
  return Object.keys(imports).length ? JSON.stringify({ imports }) : '';
}

/**
 * The Content-Security-Policy of every page: everything from this origin, nothing from anywhere else
 * (the explorer runs offline from any CDN). An import map is inline, so it is allowed by its hash.
 */
function cspOf(importMap) {
  const hash = importMap ? ` 'sha256-${createHash('sha256').update(importMap).digest('base64')}'` : '';
  return [
    "default-src 'self'", `script-src 'self'${hash}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "connect-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
  ].join('; ');
}

/** The browser modules the config names from the repo: each one's folder may be served (its .js files only) */
function repoModuleDirs(config) {
  const dirs = [];
  for (const s of Object.values(browserSources(config))) {
    if (s && s.module.startsWith('/repo/')) dirs.push(path.posix.dirname(s.module.slice('/repo/'.length)));
  }
  const files = Object.values(config.importMap || {}).map((v) => String(v).slice('/repo/'.length));
  return { dirs: [...new Set(dirs)], files };
}

/**
 * What `/cornfield/config.json` says: only what the browser needs, never the data folder or a path on this machine.
 * `signIn` is false without sign-in, else who is signed in.
 * @param {object} config
 * @param {false | { login: string }} [signIn]
 */
export function clientConfig(config, signIn = false) {
  return {
    name: 'cornfield',
    version: PKG.version,
    title: config.title,
    links: config.links || [],
    forge: config.forge ? { type: config.forge.type, url: config.forge.url || (config.forge.type === 'github' ? 'https://github.com' : null), repo: config.forge.repo, mergeMethod: config.forge.mergeMethod || 'merge', ...(config.approveLands ? { approveLands: true } : {}) } : null,
    // Threads (docs/threads.md): the idea label, or false when `threads: false` turns the Threads tab off
    threads: config.threads === false ? false : { label: ideaLabel(config) },
    sources: browserSources(config),
    signIn,
  };
}

/** The registry without what the browser never needs: the env var names a detector matches by */
function publicRegistry(text) {
  const file = JSON.parse(text);
  for (const s of Array.isArray(file.services) ? file.services : []) if (s && s.match && 'env' in s.match) delete s.match.env;
  return JSON.stringify(file);
}

/** How long a Home Assistant answer is reused before the registries are read again */
export const HA_CACHE_MS = 30_000;

/**
 * The server for one repo. It does not listen: `listen(config)` does, where server/bind.js allows.
 * @param {object} config a loaded config (core/config.js `loadConfig`)
 * @param {Parameters<typeof createAuth>[1] & { homeAssistant?: object, hookFetch?: typeof fetch, hookTimer?: { setTimeout: Function, clearTimeout: Function }, landTimer?: { setTimeout: Function, clearTimeout: Function }, specPollTimer?: { setTimeout: Function, clearTimeout: Function } }} [opts] what sign-in reads (`env`, and tests' fakes;
 *   see server/auth.js); the Home Assistant URL and token are read from the same `env`, and `homeAssistant` is what
 *   `homeAssistantHouse` is handed besides them (the tests' fake WebSocket); `hookFetch` and `hookTimer` are the
 *   tests' fake network and clock for the event hooks (server/hooks.js); `landTimer` is the clock of landing on approval (server/lander.js); `specPollTimer` is the clock of the `spec.ready` poll (server/spec-poll.js)
 * @returns {import('node:http').Server}
 */
export function createCornfieldServer(config, opts = {}) {
  const { env = process.env, homeAssistant = {} } = opts;
  const auth = createAuth(config, opts);
  // Hooks listed without a secret (or without sign-in) are a startup error, like a half-configured sign-in
  const hookSettings = hooksSettings(config, env, auth.enabled);
  // Opt-in triggers (agents.on, server/triggers.js) act as the maintainer whose act caused them and read the forge: both need sign-in and a forge
  const triggerList = triggersOf(config);
  if (triggerList.length && !auth.enabled) throw new Error('The config says agents.on, but sign-in is not set up. A trigger requests a run as the maintainer whose act caused it, with their own sign-in, so without sign-in nothing would ever fire: set up sign-in (docs/sign-in.md), or remove agents.on.');
  if (triggerList.length && !(config.forge && hasAdapter(config.forge.type))) throw new Error('The config says agents.on, but there is no forge to ask on. Set up `forge` (docs/config.md#forge), or remove agents.on.');
  // With triggers and no hook listed, the hooks object has no destination: it is only the moments the triggers subscribe to (and the thread look's memory)
  const hooks = hookSettings || triggerList.length
    ? createHooks({ hooks: hookSettings ? config.hooks : [], secret: hookSettings ? hookSettings.secret : randomBytes(32).toString('hex'), fetch: opts.hookFetch, record: (entry) => auth.record(entry), store: auth.store, now: opts.now, publicUrl: config.publicUrl, timer: opts.hookTimer })
    : null;
  hooks?.watchSessions();
  // Landing on approval needs somebody signed in to land as, like the hooks' events: a half-set key is a startup error
  if (config.approveLands && !auth.enabled) throw new Error('The config says proposals.approveLands, but sign-in is not set up. An approval is a signed-in maintainer\'s, and it lands as them, so without sign-in nothing would ever land: set up sign-in (docs/sign-in.md), or remove approveLands.');
  const root = config.root;
  const importMap = importMapOf(config);
  const csp = cspOf(importMap);
  const repoModules = repoModuleDirs(config);
  const publicHost = config.publicUrl ? new URL(config.publicUrl).hostname : null;
  const where = { root, proposals: config.proposals, worktrees: config.worktrees, topology: config.topology, dataDir: config.dataDir, publicHost };
  const fixtureCache = new Map();
  const lander = config.approveLands ? createLander({ config, where, auth, hooks, now: opts.now, timer: opts.landTimer }) : null;
  if (lander) {
    // What a restart left waiting: looked at again, in the background
    lander.resume().catch((err) => console.error(`[cornfield] pending landings could not be picked up: ${err instanceof Error ? err.message : err}`));
  }
  // Agent runs (server/agent-runs.js) need a signed-in maintainer to ask as and a forge to ask on; the runs are followed on the spec poll's tick
  const runs = config.forge && auth.enabled && hasAdapter(config.forge.type) ? createRuns({ config, where, auth, hooks, now: opts.now, onAsk: () => specPoll?.start() }) : null;
  // Triggers subscribe to the hooks' moments and call the runs' own request path; nothing a run produces is wired to them (server/triggers.js)
  if (runs && hooks && triggerList.length) createTriggers({ config, auth, runs, hooks, now: opts.now });
  runs?.resume().catch((err) => console.error(`[cornfield] agent runs could not be picked up: ${err instanceof Error ? err.message : err}`));
  // Looks at the open spec PRs on a timer when a hook wants spec.ready (config `hookPoll`); started when the server listens. The same timer follows
  // agent runs: it is started for them when there is a run to follow, or as one is asked for, and does nothing while there is none
  const specMs = hooks ? specPollMs(config) : null;
  const runsEvery = config.hookPoll === undefined ? DEFAULTS.hookPoll.specs : config.hookPoll.specs;
  const pollMs = specMs ?? (runs && runsEvery !== false ? parseDuration(runsEvery) : null);
  const specPoll = pollMs ? createSpecPoll({ config, where, auth, hooks, runs, specs: specMs !== null, intervalMs: pollMs, now: opts.now, timer: opts.specPollTimer }) : null;
  let serverClosed = false;
  const proxies = Object.entries(config.proxy || {});
  const houseSource = config.sources.house && (config.sources.house === 'house' || config.sources.house.use === 'house') ? config.sources.house : null;
  const houseFile = houseSource && houseSource.options && houseSource.options.file ? inside(root, houseSource.options.file) : null;
  const haSource = config.sources.house && (config.sources.house === 'home-assistant' || config.sources.house.use === 'home-assistant') ? config.sources.house : null;
  const haOptions = (haSource && typeof haSource === 'object' && haSource.options) || {};
  const haFile = haOptions.file ? inside(root, haOptions.file) : null;
  let haCache = null; // { until, promise }
  /** Home Assistant's house answer, over the house file's plan and other parts when there is one; reused for HA_CACHE_MS */
  const haHouse = () => {
    const now = Date.now();
    if (haCache && haCache.until > now) return haCache.promise;
    let file = null;
    if (haFile && fs.existsSync(haFile)) {
      try { file = JSON.parse(fs.readFileSync(haFile, 'utf8')); } catch { file = null; }
    }
    const promise = homeAssistantHouse({ url: haOptions.url || env[HA_ENV.url], token: env[HA_ENV.token], file, ...homeAssistant });
    haCache = { until: now + HA_CACHE_MS, promise };
    return promise;
  };

  const page = () => {
    const html = fs.readFileSync(path.join(EXPLORER_DIR, 'index.html'), 'utf8')
      .replace('<!--@importmap-->', importMap ? `<script type="importmap">${importMap}</script>` : '')
      .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(config.title)} · cornfield</title>`);
    return html;
  };

  const server = http.createServer(async (req, res) => {
    try {
      await answer(req, res);
    } catch (err) {
      // The path only: a query can carry what must not be logged (the sign-in's code and state)
      console.error(`[cornfield] ${req.method} ${String(req.url).split('?')[0]}: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Something went wrong in cornfield; the log says what.' });
      else res.end();
    }
  });
  server.on('listening', () => {
    if (specMs !== null) specPoll?.start();
    else if (specPoll && runs) {
      // Runs asked for before a restart are followed again from the start
      runs.hasWork().then((work) => { if (work && !serverClosed) specPoll.start(); }).catch(() => {});
    }
  });
  server.on('close', () => { serverClosed = true; specPoll?.close(); lander?.close(); hooks?.close(); auth.close(); });
  return server;

  async function answer(req, res) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    // The first thing: before the guard and the proxies, so no route (/healthz included) answers a foreign `Host`
    // One `Host` only (Node keeps the first of several), and a request target in absolute form (`GET http://name/…`),
    // which outranks `Host`, must name an allowed host too
    const hosts = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'host').length;
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(req.url || '') ? /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(req.url)[1] : null;
    const allowedHost = (h) => hostAllowed(h, auth.enabled ? publicHost : null);
    if (hosts !== 1 || !allowedHost(req.headers.host) || (absolute !== null && !allowedHost(absolute))) {
      req.resume();
      res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('421 Misdirected Request: cornfield answers only to localhost, or to its public URL when sign-in is on');
    }
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('400 Bad Request');
    }
    const reqPath = decodePath(url.pathname);
    if (reqPath === null) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('400 Bad Request');
    }

    if (reqPath === '/healthz') {
      req.resume();
      return sendJson(res, 200, { ok: true });
    }
    // The review API takes a token, not a session: it is the one route before the guard (and it reads no cookie)
    if (reqPath === REVIEWS_PATH) return serveReviewCall(req, res, { config, where, auth, hooks, lander, now: opts.now });
    // …and so does asking for a run: an agent token, not a session
    if (reqPath === REQUESTS_PATH) return serveAgentCall(req, res, { config, auth, runs, now: opts.now });
    const gate = await auth.gate(req, res, reqPath, url);
    if (gate.done) return;
    const signedIn = gate.session ? { login: gate.session.login } : false;

    // Before the proxies: a repo's `/api/` proxy must not swallow the panel's own routes
    if (await serveTokenRoutes(req, res, reqPath, { config, where, auth, session: gate.session, now: opts.now, publicHost })) return;
    if (await serveRunRoutes(req, res, reqPath, { config, auth, runs, session: gate.session, now: opts.now, publicHost })) return;
    if (await serveForge(req, res, reqPath, url, { config, where, session: gate.session, auth, hooks, lander, now: opts.now, publicHost })) return;
    for (const [prefix, target] of proxies) if (reqPath.startsWith(prefix)) return proxyTo(req, res, target);
    const session = gate.session;
    const forgeFor = session ? () => auth.forgeFor(session) : null;
    const reviewer = session ? { login: session.login, userId: session.userId, repo: config.forge.repo, record: (entry) => auth.record(entry), limits: { auth, now: opts.now }, hooks, lander } : null;
    if (serveProposals(req, res, reqPath, url, where, forgeFor, reviewer)) return;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.resume();
      res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });
      return res.end('405 Method Not Allowed');
    }

    if (reqPath === '/' || reqPath === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : page());
    }
    if (reqPath === '/cornfield/config.json') return sendJson(res, 200, clientConfig(config, signedIn));
    if (reqPath === '/topology.json') {
      const file = inside(root, config.topology);
      if (!file || !fs.existsSync(file)) return sendJson(res, 404, { error: `${config.topology} is not there yet: run cornfield sync` });
      return sendFile(req, res, file, reqPath);
    }
    if (reqPath === '/topology.cloud.json') {
      const file = inside(root, CLOUD_FILE);
      if (!file || !fs.existsSync(file)) return notFound(res, reqPath);
      try {
        res.writeHead(200, JSON_HEADERS);
        return res.end(req.method === 'HEAD' ? undefined : publicRegistry(fs.readFileSync(file, 'utf8')));
      } catch {
        return sendJson(res, 422, { error: `${CLOUD_FILE} is not valid JSON` });
      }
    }
    if (reqPath === '/cornfield/house.json' && haSource) return sendJson(res, 200, { ok: true, data: await haHouse() });
    if (reqPath === '/cornfield/house.json') {
      if (!houseFile || !fs.existsSync(houseFile)) return sendJson(res, 404, { ok: false, error: 'No house file is configured (sources.house.options.file)' });
      try {
        const data = JSON.parse(fs.readFileSync(houseFile, 'utf8'));
        const at = data.at || fs.statSync(houseFile).mtime.toISOString();
        return sendJson(res, 200, { ok: true, data: { ...data, at } });
      } catch (err) {
        return sendJson(res, 422, { ok: false, error: `The house file is not valid JSON: ${err.message}` });
      }
    }
    if (reqPath === '/topology-fixture.json') {
      const { generateTopology, parseFixtureQuery } = await import('../core/fixture.js');
      let size;
      try {
        size = parseFixtureQuery(url.searchParams);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(`400 ${err.message}`);
      }
      const key = `${size.nodes}|${size.edges}|${size.seed}`;
      if (!fixtureCache.has(key)) {
        if (fixtureCache.size >= 3) fixtureCache.delete(fixtureCache.keys().next().value);
        fixtureCache.set(key, JSON.stringify(generateTopology(size)));
      }
      res.writeHead(200, JSON_HEADERS);
      return res.end(req.method === 'HEAD' ? undefined : fixtureCache.get(key));
    }
    if (reqPath.startsWith('/explorer/')) {
      const file = inside(EXPLORER_DIR, reqPath.slice('/explorer'.length));
      if (!file || !/\.(?:js|css)$/.test(file)) return notFound(res, reqPath);
      return sendFile(req, res, file, reqPath);
    }
    if (reqPath.startsWith('/core/')) {
      const name = reqPath.slice('/core/'.length);
      return BROWSER_CORE.includes(name) ? sendFile(req, res, path.join(CORNFIELD_DIR, 'core', name), reqPath) : notFound(res, reqPath);
    }
    if (BROWSER_PLUGINS.has(reqPath)) return sendFile(req, res, BROWSER_PLUGINS.get(reqPath), reqPath);
    if (reqPath.startsWith('/repo/')) {
      const rel = reqPath.slice('/repo/'.length);
      const file = inside(root, rel);
      const relNorm = file ? path.relative(root, file).split(path.sep).join('/') : null;
      const allowed = relNorm && relNorm.endsWith('.js') && (repoModules.files.includes(relNorm) || repoModules.dirs.some((d) => relNorm.startsWith(`${d}/`)));
      return allowed ? sendFile(req, res, file, reqPath) : notFound(res, reqPath);
    }
    return notFound(res, reqPath);
  }
}

/**
 * Starts the server on the config's port and host, where server/bind.js allows. Resolves with the address it
 * listens on, and whether sign-in guards it.
 * @param {object} config
 * @param {Parameters<typeof createAuth>[1]} [opts]
 * @returns {Promise<{ server: import('node:http').Server, url: string, signIn: boolean }>}
 */
export function listen(config, opts = {}) {
  const signIn = signInSettings(config, opts.env) !== null;
  assertBind(config.host, { signIn, publicUrl: config.publicUrl });
  const server = createCornfieldServer(config, opts);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      const host = config.host === '::1' ? '[::1]' : config.host;
      resolve({ server, url: `http://${host}:${port}`, signIn });
    });
  });
}
