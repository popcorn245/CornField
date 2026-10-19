/**
 * @module plugins/openapi
 *
 * The OpenAPI deriver: an API's endpoints on the map from its description file, with zero plugin code.
 * One page node per path, with its methods, under the API's app.
 *
 *  - **OpenAPI 3.x and Swagger 2.0**, JSON or YAML: each path of `paths` with the operations it has. The
 *    label is the path under the API's base (`basePath`, or the path of the first `servers` URL, or the
 *    option `prefix`), so `/orders` under `https://api.example.com/v1` is `/v1/orders`.
 *  - **OpenCollection** (and Bruno-like collections), YAML or JSON: every request in `items` (folders
 *    nested), its method and the path of its URL, with `{{baseUrl}}`-style variables and the origin taken
 *    off and `:id` or `{{id}}` path variables written `{id}`.
 *
 * Which files: `options.specs: [{ file, app?, prefix? }]`, or `options.file`, else the one file in the repo
 * named `openapi.*`, `swagger.*`, `*.openapi.*` or `opencollection.*` (`.json`, `.yaml`, `.yml`). Several
 * found and none named is a warning, and nothing is drawn.
 *
 * What it makes:
 *
 *   page-<app>-<path>         an endpoint: label the path, file the spec, methods (GET, POST, …)
 *   app-api                   the API's app (or `app`), only when no deriver makes it and the map has
 *                             none: label the spec's title, file the spec
 *
 * The app's pages are this deriver's (`pageOwners`): an endpoint gone from the spec leaves the map, and a
 * hand-written page under that app is removed. YAML needs the optional dependency js-yaml.
 */

const SPEC_FILE = /(?:^|\/)(?:openapi|swagger|[\w.-]+\.openapi|opencollection)\.(?:json|ya?ml)$/i;
const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'];
export const DEFAULT_APP = 'app-api';

/** js-yaml when it is installed (an optional dependency), else null */
async function loadYaml() {
  try {
    const mod = await import('js-yaml');
    return mod.default || mod;
  } catch {
    return null;
  }
}

/** A path as an id part: lower-case words joined by dashes; `root` for `/` */
export const pathSlug = (p) => String(p).toLowerCase().replace(/[{}]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root';

/** A base path: a leading slash, no trailing one, '' for the root */
export function basePath(p) {
  const s = String(p || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  return s.startsWith('/') ? s : `/${s}`;
}

/** The path of a server URL (`https://api.example.com/v1` → `/v1`, `{scheme}://{host}/v2` → `/v2`, `/api` → `/api`) */
export function serverPath(url) {
  if (typeof url !== 'string') return '';
  const rest = url.replace(/^[^/]*:\/\/[^/]*/, '');
  return basePath(rest.replace(/[?#].*$/, ''));
}

/** The methods in their usual order, upper case, once each */
const ordered = (methods) => [...new Set(methods.map((m) => m.toUpperCase()))].sort((a, b) => METHOD_ORDER.indexOf(a) - METHOD_ORDER.indexOf(b));

/**
 * The endpoints of an OpenAPI 3.x or Swagger 2.0 document.
 * @param {any} doc
 * @param {{ prefix?: string }} [opts]
 * @returns {{ path: string, key: string, methods: string[], summary: string | null }[]} `path` with the base, `key` without
 */
export function openApiEndpoints(doc, { prefix } = {}) {
  const base = prefix !== undefined ? basePath(prefix) : doc.swagger ? basePath(doc.basePath) : serverPath(Array.isArray(doc.servers) && doc.servers[0] ? doc.servers[0].url : '');
  const out = [];
  for (const [p, item] of Object.entries(doc.paths || {})) {
    if (!item || typeof item !== 'object') continue;
    const methods = Object.keys(item).filter((k) => METHOD_ORDER.includes(k.toUpperCase()) && item[k] && typeof item[k] === 'object');
    if (!methods.length) continue;
    const ops = ordered(methods);
    const first = item[ops.map((m) => m.toLowerCase()).find((m) => item[m])];
    const summary = typeof first?.summary === 'string' && first.summary.trim() ? first.summary.trim() : null;
    const own = p.startsWith('/') ? p : `/${p}`;
    out.push({ path: `${base}${own}`.replace(/\/+$/, '') || '/', key: own, methods: ops, summary });
  }
  return out;
}

/** A request URL's path: variables before the first slash and the origin off, `:id` and `{{id}}` as `{id}`, no query */
export function requestPath(url) {
  let s = typeof url === 'string' ? url : url && typeof url.raw === 'string' ? url.raw : '';
  s = s.trim().replace(/[?#].*$/, '');
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  s = s.replace(/^(?:\{\{[^}]+\}\})+/, '');
  s = s.replace(/^[^/]*:\/\/[^/]*/, '');
  if (!s.startsWith('/')) s = s.includes('/') ? s.slice(s.indexOf('/')) : '';
  s = s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, '{$1}').replace(/\/:([\w.-]+)/g, '/{$1}');
  return s.replace(/\/+$/, '') || '/';
}

/**
 * The endpoints of an OpenCollection (or a Bruno-like collection): every request in `items`, folders nested.
 * @param {any} doc
 * @param {{ prefix?: string }} [opts]
 */
export function collectionEndpoints(doc, { prefix } = {}) {
  const byPath = new Map();
  const visit = (items) => {
    for (const it of Array.isArray(items) ? items : []) {
      if (!it || typeof it !== 'object') continue;
      const req = it.http || it.request;
      if (req && typeof req.method === 'string' && req.url) {
        const key = requestPath(req.url);
        const p = `${basePath(prefix)}${key}`.replace(/\/+$/, '') || '/';
        const name = (it.info && it.info.name) || it.name;
        if (!byPath.has(p)) byPath.set(p, { path: p, key, methods: [], summary: typeof name === 'string' ? name : null });
        byPath.get(p).methods.push(req.method);
      }
      visit(it.items);
    }
  };
  visit(doc.items);
  return [...byPath.values()].map((e) => ({ ...e, methods: ordered(e.methods).filter((m) => METHOD_ORDER.includes(m)) })).filter((e) => e.methods.length);
}

/** Which kind of document it is: 'openapi', 'collection', or null */
export function specKind(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if ((typeof doc.openapi === 'string' || typeof doc.swagger === 'string') && doc.paths && typeof doc.paths === 'object') return 'openapi';
  if (Array.isArray(doc.items)) return 'collection';
  return null;
}

/** The specs to read: `[{ file, app, prefix }]` */
function specsOf(ctx, options, warnings) {
  if (Array.isArray(options.specs)) return options.specs.map((s) => ({ app: DEFAULT_APP, ...s }));
  if (typeof options.file === 'string') return [{ file: options.file, app: options.app || DEFAULT_APP, prefix: options.prefix }];
  const found = ctx.walk('', (f) => SPEC_FILE.test(f));
  if (found.length > 1) {
    warnings.push(`openapi: ${found.length} API description files (${found.join(', ')}); name the ones to draw: { use: 'openapi', options: { specs: [{ file, app }] } }.`);
    return [];
  }
  return found.map((file) => ({ file, app: options.app || DEFAULT_APP, prefix: options.prefix }));
}

const openapi = {
  name: 'openapi',
  contract: 1,

  async derive(ctx) {
    const options = ctx.options || {};
    const warnings = [];
    const specs = specsOf(ctx, options, warnings);
    const nodes = [];
    const edges = [];
    const ownedIds = [];
    const pageOwners = [];
    const mapNodes = (ctx.map && ctx.map.nodes) || [];
    let yaml;
    for (const spec of specs) {
      if (!spec.file || !ctx.exists(spec.file)) throw new Error(`API description ${spec.file} does not exist.`);
      const text = ctx.read(spec.file);
      let doc;
      if (/\.json$/i.test(spec.file)) {
        try { doc = JSON.parse(text); } catch (err) { throw new Error(`${spec.file} is not valid JSON: ${err.message}`); }
      } else {
        yaml = yaml || (await loadYaml());
        if (!yaml) throw new Error(`${spec.file} is YAML and there is no YAML reader: install the optional dependency js-yaml (npm install js-yaml).`);
        try { doc = yaml.load(text); } catch (err) { throw new Error(`${spec.file} is not valid YAML: ${err.message}`); }
      }
      const kind = specKind(doc);
      if (!kind) throw new Error(`${spec.file} is neither an OpenAPI document (openapi or swagger, and paths) nor a collection (items).`);
      const endpoints = kind === 'openapi' ? openApiEndpoints(doc, spec) : collectionEndpoints(doc, spec);

      // The app: another deriver's, the map's, or this deriver's own (an app whose file is the spec)
      const app = spec.app;
      const onMap = mapNodes.find((n) => n.id === app);
      if (!ctx.nodes.some((n) => n.id === app) && !nodes.some((n) => n.id === app) && (!onMap || onMap.file === spec.file)) {
        const title = (doc.info && (doc.info.title || doc.info.name)) || 'API';
        nodes.push({ id: app, label: String(title), type: 'app', file: spec.file });
        edges.push({ from: options.parent || 'root', to: app });
        ownedIds.push(app);
      }
      if (pageOwners.includes(app)) throw new Error(`two API descriptions draw app "${app}": give each its own app.`);
      pageOwners.push(app);

      const short = app.replace(/^app-/, '');
      const used = new Set();
      for (const e of endpoints) {
        // The id leaves the base out, so moving the API to /v2 keeps its pages
        let id = `page-${short}-${pathSlug(e.key)}`;
        for (let k = 2; used.has(id); k++) id = `page-${short}-${pathSlug(e.key)}-${k}`;
        used.add(id);
        nodes.push({ id, label: e.path, type: 'page', file: spec.file, methods: e.methods, desc: `${e.methods.join(' · ')} ${e.path}${e.summary ? `: ${e.summary}` : ''}` });
        edges.push({ from: app, to: id });
      }
      if (!endpoints.length) warnings.push(`openapi: ${spec.file} describes no endpoints.`);
    }
    return { nodes, edges, warnings, ownedIds, pageOwners, info: { specs: specs.map((s) => ({ file: s.file, app: s.app })) } };
  },
};

export default openapi;
