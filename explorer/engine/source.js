/**
 * @module explorer/engine/source
 *
 * Where the map's data comes from (spec 0011 D6): `/cornfield/config.json` and `/topology.json` of a cornfield server, read through an
 * instance and applied to it. The same module serves cornfield's own page (an instance with no base: the paths and the fetch options are what
 * they were, `{ cache: 'no-store' }` for the config and nothing for the topology) and a scope (pieces/scope.js) or a map with a `src`
 * (an instance with a base: the same two routes of another origin, with `credentials: 'include'`, because they are behind the maintainer's session).
 *
 *   parseSource(src)             an address ('https://map.example.com', with an optional path) -> { ok, base } or { ok: false, problem }
 *   compareVersions(a, b)        'same' | 'patch' | 'minor' | 'major' | 'unknown' (what differs between two cornfield versions)
 *   signInUrl(base, pageUrl)     the server's sign-in, which returns to `pageUrl`
 *   fetchConfig(inst, opts)      the config object, or a SourceError (kind 'auth' | 'server' | 'network')
 *   fetchTopology(inst, path)    { nodes, edges }, or a SourceError
 *   applyConfig(inst, config)    what the instance takes from a config: its words, the project's layers, the map's theme (icons)
 *   createSource(inst, opts)     the load as a small state machine that tells the instance where it is (below)
 *
 * It never `import()`s, evaluates or follows anything a config names (spec 0011 D10): `sources` (the live layer, the House view, the checker)
 * are plugin modules that only cornfield's own page loads (explorer/plugins.js), and a config's `links` and `brand` are not read here at all.
 *
 * The instance event `source` (name: detail) says where the load is. Every detail has a `state`:
 *
 *   loading      a request is out
 *   ready        the topology is there (read from the server, or handed in); `source.topology` and `source.config` hold what came
 *   sign-in      { status, signIn }  the server answered 401 or 403 to a gated read; `signIn` is its sign-in, which returns to the page
 *   not-allowed  { origin }  the server gave no CORS answer: the page's origin is not in the server's `embed.origins`
 *   offline      the server cannot be reached (or the browser is offline)
 *   server       { status, message }  the server answered, and what it said is not a config or a topology
 *   address      { problem }  `src` is not an http(s) address of a server
 *   version      { server, package, drift }  the package and the server differ by a minor version or more; the load goes on (said once)
 */

import { setStrings } from './strings.js';
import { setProjectLayers } from './layers.js';
import { mapStyleOf } from './map-style.js';

export const CONFIG_PATH = '/cornfield/config.json';
export const TOPOLOGY_PATH = '/topology.json';
/** A route that answers a listed origin without a session: the reach test for a fetch that got no answer */
export const REACH_PATH = '/cornfield/theme.css';
export const SIGN_IN_PATH = '/auth/start';
export const SOURCE_STATES = Object.freeze(['loading', 'ready', 'sign-in', 'not-allowed', 'offline', 'server', 'address', 'version']);

/** A control character, a space or a backslash (a browser reads `\` as `/`): never in an address */
const BAD_CHAR = /[\u0000- \u007f\\]/;

/**
 * An address of a cornfield server, checked: an http(s) origin with an optional path, and nothing else (no user name, no query, no fragment).
 * `base` is what the instance is made with: the origin and the path without a trailing slash.
 * @param {unknown} src
 * @returns {{ ok: true, base: string, origin: string } | { ok: false, problem: string }}
 */
export function parseSource(src) {
  if (typeof src !== 'string' || !src.trim()) return { ok: false, problem: 'is empty' };
  const text = src.trim();
  if (BAD_CHAR.test(text)) return { ok: false, problem: 'has a space, a control character or a backslash' };
  let u;
  try { u = new URL(text); } catch { return { ok: false, problem: 'is not an address (an http or https address, as the server is opened in a browser)' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, problem: 'is not http or https' };
  if (!/^https?:\/\/[^/?#]/i.test(text)) return { ok: false, problem: 'has no host' };
  if (u.username || u.password) return { ok: false, problem: 'has a user name or password' };
  if (text.includes('?') || text.includes('#')) return { ok: false, problem: 'has a query or a fragment' };
  return { ok: true, base: u.origin + u.pathname.replace(/\/+$/, ''), origin: u.origin };
}

/** The numbers of a version, or null */
const parts = (v) => {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(String(v == null ? '' : v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/**
 * What differs between two cornfield versions: the major, the minor (a different minor of the same major) or only the patch. A version that is
 * not `x.y.z` (a dev build, none at all) cannot be compared: 'unknown'.
 * @returns {'same' | 'patch' | 'minor' | 'major' | 'unknown'}
 */
export function compareVersions(a, b) {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return 'unknown';
  if (x[0] !== y[0]) return 'major';
  if (x[1] !== y[1]) return 'minor';
  return x[2] !== y[2] ? 'patch' : 'same';
}

/**
 * The server's sign-in, which ends on the page it was asked from: `<base>/auth/start?returnTo=<page URL>` (docs/sign-in.md). The server follows
 * `returnTo` only for an origin its `embed.origins` lists. A page that is not http(s) (a file, about:blank) has nothing to return to.
 * @param {string} base
 * @param {string} pageUrl
 */
export function signInUrl(base, pageUrl) {
  const back = typeof pageUrl === 'string' && /^https?:\/\//i.test(pageUrl) ? `?returnTo=${encodeURIComponent(pageUrl)}` : '';
  return `${base}${SIGN_IN_PATH}${back}`;
}

/** Why a read failed: `auth` (401 or 403: sign in), `server` (it answered, and not with what was asked for) or `network` (no answer the page may read) */
export class SourceError extends Error {
  /** @param {'auth' | 'server' | 'network'} kind @param {string} message @param {{ status?: number, cause?: unknown }} [extra] */
  constructor(kind, message, { status = 0, cause } = {}) {
    super(message);
    this.name = 'SourceError';
    this.kind = kind;
    this.status = status;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * The fetch options of a read: a server of another origin is read with the maintainer's session (`credentials: 'include'`), the page's own is
 * read as `fetch` reads it. `init` is what the call adds; nothing is added where there is nothing to add (the page's request is unchanged).
 */
function optionsOf(inst, init, signal) {
  const out = { ...init };
  if (inst.base) out.credentials = 'include';
  if (signal) out.signal = signal;
  return Object.keys(out).length ? out : undefined;
}

/** Fetches `url` through the instance and returns the response, or throws a SourceError for a network failure, 401/403 and any other non-OK status */
async function read(inst, url, init, signal) {
  let res;
  try {
    const options = optionsOf(inst, init, signal);
    res = options ? await inst.fetch(url, options) : await inst.fetch(url);
  } catch (err) {
    throw new SourceError('network', err && err.message ? err.message : String(err), { cause: err });
  }
  if (res.status === 401 || res.status === 403) throw new SourceError('auth', `GET ${url} answered ${res.status} ${res.statusText}`.trim(), { status: res.status });
  if (!res.ok) throw new SourceError('server', `GET ${url} answered ${res.status} ${res.statusText}`.trim(), { status: res.status });
  return res;
}

/**
 * The config the server hands the browser (`/cornfield/config.json`). Throws a SourceError; cornfield's own page, which works without one,
 * catches it and goes on with `{}`.
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function fetchConfig(inst, { signal } = {}) {
  const res = await read(inst, CONFIG_PATH, { cache: 'no-store' }, signal);
  let config;
  try { config = await res.json(); } catch (err) { throw new SourceError('server', `${CONFIG_PATH} is not JSON`, { status: res.status, cause: err }); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new SourceError('server', `${CONFIG_PATH} is not a config`, { status: res.status });
  return config;
}

/**
 * The map (`/topology.json`, or `path`): `{ nodes, edges }`, with at least one node. The caller keeps the object as it is (the map works on copies).
 * The address carries a cache-buster, as the page's always has.
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst
 * @param {string} [path]
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function fetchTopology(inst, path = TOPOLOGY_PATH, { signal } = {}) {
  const res = await read(inst, path + (path.includes('?') ? '&v=' : '?v=') + Date.now(), undefined, signal);
  let data;
  try { data = await res.json(); } catch (err) { throw new SourceError('server', `${path} is not JSON`, { status: res.status, cause: err }); }
  if (!data || !Array.isArray(data.nodes) || data.nodes.length === 0) throw new SourceError('server', `${path} has no nodes`, { status: res.status });
  return data;
}

/**
 * What an instance takes from a config, as cornfield's page does: the repo's words (`strings`), the project's layers, and the map's theme
 * (the icons, fetched through `inst.url()` with `crossOrigin` when the instance has a base, and the pixelated flag). The brand, the title and the
 * links are the page's header; the `sources` are plugin modules, which only the page loads. Nothing in a config becomes script here.
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst
 * @param {object} config
 */
export function applyConfig(inst, config) {
  if (!config || typeof config !== 'object') return;
  setStrings(inst, config.strings);
  mapStyleOf(inst).applyTheme(config.theme);
  setProjectLayers(inst, config.layers);
}

/**
 * The load as a state machine on an instance. It makes the requests (when the instance has a base), keeps what came, and says where it is with the
 * instance's `source` event (above); a piece that joins later reads `state()`. `destroy()` aborts what is in flight and says nothing more.
 *
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst
 * @param {object} [opts]
 * @param {string} [opts.version] the package's version, compared with the server's (`config.version`)
 * @param {() => string} [opts.pageUrl] the page's address, for the sign-in's way back
 */
export function createSource(inst, { version = '', pageUrl = () => '' } = {}) {
  let destroyed = false;
  let current = null;
  let controller = null;
  let run = 0;
  const own = { topology: null, config: null, strings: null };
  const source = {
    /** The topology in force: the host's, else the server's */
    topology: null,
    /** The config in force: the host's, else the server's */
    config: null,
    /** The last thing said about the load (`{ state, … }`, never the version notice), or null before the first */
    state: () => current,
    /** The version notice, once the server's config said a different minor or major; null until then */
    notice: null,
    say(detail) {
      if (destroyed) return;
      if (detail.state === 'version') source.notice = detail; else current = detail;
      inst.emit('source', detail);
    },
    /**
     * Takes what the host fetched for itself. A key that is `undefined` is left as it was, `null` takes the host's back. With a topology there is
     * nothing to load: no request is made for it. The host's `strings` win over the server's.
     */
    provide({ topology, config, strings } = {}) {
      if (destroyed) return;
      if (strings !== undefined) { own.strings = strings; useStrings(source.config); }
      if (config !== undefined) { own.config = config; if (config) takeConfig(config); else if (source.fetchedConfig) takeConfig(source.fetchedConfig); }
      if (topology !== undefined) {
        own.topology = topology;
        source.topology = topology || source.fetchedTopology || null;
        if (source.topology) source.say({ state: 'ready' });
      }
    },
    fetchedConfig: null,
    fetchedTopology: null,
    /** Reads the server's config and topology (what the host did not hand in). Does nothing for an instance with no base. */
    async load() {
      if (destroyed || !inst.base) return;
      if (own.config && own.topology) { source.topology = own.topology; source.say({ state: 'ready' }); return; } // the host fetched for itself: nothing to ask
      if (controller) controller.abort();
      controller = new AbortController();
      const { signal } = controller;
      const mine = ++run;
      const live = () => !destroyed && mine === run && !signal.aborted;
      source.say({ state: 'loading' });
      try {
        if (!own.config) {
          const config = await fetchConfig(inst, { signal });
          if (!live()) return;
          source.fetchedConfig = config;
          takeConfig(config);
        }
        if (own.topology) {
          source.topology = own.topology;
        } else {
          const topology = await fetchTopology(inst, TOPOLOGY_PATH, { signal });
          if (!live()) return;
          source.fetchedTopology = topology;
          source.topology = topology;
        }
        source.say({ state: 'ready' });
      } catch (err) {
        if (!live()) return;
        const detail = await failure(err, signal);
        if (live()) source.say(detail);
      }
    },
  };

  /** The words: the host's, else the config's */
  function useStrings(config) {
    setStrings(inst, own.strings || (config && config.strings));
  }

  function takeConfig(config) {
    source.config = config;
    applyConfig(inst, config);
    if (own.strings) useStrings(config);
    const drift = compareVersions(version, config.version);
    if (version && (drift === 'minor' || drift === 'major')) source.say({ state: 'version', server: String(config.version), package: version, drift });
  }

  /** What a failed read says. A fetch that was refused outright says nothing about why: the server is told apart from "not listed" by asking a route that answers anyone */
  async function failure(err, signal) {
    if (!(err instanceof SourceError)) return { state: 'server', status: 0, message: err && err.message ? err.message : String(err) };
    if (err.kind === 'auth') return { state: 'sign-in', status: err.status, signIn: signInUrl(inst.base, pageUrl()) };
    if (err.kind === 'server') return { state: 'server', status: err.status, message: err.message };
    const offline = inst.win && inst.win.navigator && inst.win.navigator.onLine === false;
    if (offline) return { state: 'offline' };
    try {
      await inst.fetch(REACH_PATH, { method: 'HEAD', mode: 'no-cors', credentials: 'omit', signal });
    } catch {
      return { state: 'offline' };
    }
    return { state: 'not-allowed', origin: originOf(pageUrl()) };
  }

  holderOf(inst).source = source;
  inst.own(() => {
    destroyed = true;
    if (controller) controller.abort();
    holderOf(inst).source = null;
  });
  return source;
}

/** The origin of a page address, or '' */
export function originOf(url) {
  try { return /^https?:/i.test(url) ? new URL(url).origin : ''; } catch { return ''; }
}

const holderOf = (inst) => inst.slot('source', () => ({ source: null }));
/** The instance's source, if a scope or a map with a `src` made one (a piece that joins late reads what it has said); else null */
export const sourceOf = (inst) => holderOf(inst).source;
