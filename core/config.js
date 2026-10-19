/**
 * @module core/config
 *
 * cornfield.config.js: what a repo tells cornfield. One ES module in the target repo's root that
 * default-exports a plain object; every key is optional. Env vars win over the file for what differs
 * per machine (the port, the host, the public URL, the data folder).
 *
 *   export default {
 *     title: 'My repo',                       // the explorer's title
 *     derivers: ['starter', 'personas', 'cloud'],   // built-in names, or './path/to/deriver.js', or { use, options }
 *     sources: {                              // browser modules for the live layer, the house and devices
 *       live: null, house: null, devices: null, checker: null,
 *     },
 *     forge: { type: 'github', url: 'https://github.com', repo: 'owner/name' },   // or type 'forgejo'
 *     port: 3350,
 *     host: '127.0.0.1',                      // Stage 1: localhost only (server/bind.js refuses anything else)
 *     publicUrl: null,                        // where people open it, once it is served for them
 *     worktrees: '.claude/worktrees',         // a folder of git worktrees whose unpushed proposals are listed too
 *     proposals: 'docs/specs/proposals',      // where proposal files live, in the checkout and in each worktree
 *     topology: 'topology.json',
 *     personas: { roles: null },              // the roles a persona may have (null: any)
 *     links: [],                              // [{ label, href }] shown in the explorer's header
 *     proxy: {},                              // { '/api/': 'http://127.0.0.1:3245' }: same-origin paths for a live source
 *     importMap: {},                          // bare imports a repo-local browser module needs: { name: '/repo/path.js' }
 *     dataDir: null,                          // where cornfield keeps its own state (reviews; the SQLite file in v1)
 *   }
 *
 * A source is `{ use: 'house' | './path.js', options }`: a browser module that exports `create(options)`
 * returning `{ liveSource?, floorRenderer?, checker? }`, or those names directly. Its options are sent to the
 * browser, so they never hold a secret.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const CONFIG_FILE = 'cornfield.config.js';
export const CORNFIELD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The derivers cornfield ships, by name */
export const BUILTIN_DERIVERS = {
  starter: 'plugins/starter/index.js',
  personas: 'plugins/personas/index.js',
  compose: 'plugins/compose/index.js',
  openapi: 'plugins/openapi/index.js',
  cloud: 'plugins/cloud/index.js',
  docs: 'plugins/docs/index.js',
};
/** The browser sources cornfield ships, by name: the module the explorer imports */
export const BUILTIN_SOURCES = {
  house: '/plugins/house/browser.js',
};
export const SOURCE_SLOTS = ['live', 'house', 'devices', 'checker'];
export const FORGE_TYPES = ['github', 'forgejo'];

export const DEFAULTS = Object.freeze({
  title: null,
  derivers: ['starter', 'personas', 'cloud'],
  sources: { live: null, house: null, devices: null, checker: null },
  forge: null,
  port: 3350,
  host: '127.0.0.1',
  publicUrl: null,
  worktrees: '.claude/worktrees',
  proposals: 'docs/specs/proposals',
  topology: 'topology.json',
  personas: { roles: null, parent: 'root' },
  cloud: { parent: 'root' },
  links: [],
  proxy: {},
  importMap: {},
  dataDir: null,
});

const KEYS = Object.keys(DEFAULTS);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
/** A path inside the repo: relative, forward slashes, no `..` segment */
const inRepo = (p) => isText(p) && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..');

/**
 * What is wrong with a config object (as the file exports it, before defaults).
 * @param {any} c
 * @returns {string[]}
 */
export function configProblems(c) {
  const out = [];
  if (!isObject(c)) return [`${CONFIG_FILE} must export an object (export default { … }).`];
  for (const k of Object.keys(c)) if (!KEYS.includes(k)) out.push(`unknown key "${k}". Known: ${KEYS.join(', ')}.`);
  if (c.title !== undefined && c.title !== null && !isText(c.title)) out.push('"title" is text.');
  if (c.port !== undefined && !(Number.isInteger(c.port) && c.port > 0 && c.port < 65536)) out.push('"port" is a whole number from 1 to 65535.');
  if (c.host !== undefined && !isText(c.host)) out.push('"host" is text.');
  if (c.derivers !== undefined) {
    if (!Array.isArray(c.derivers)) out.push('"derivers" is a list.');
    else c.derivers.forEach((d, i) => {
      const use = typeof d === 'string' ? d : isObject(d) ? d.use : null;
      if (!isText(use)) out.push(`derivers[${i}] is a name ("starter"), a path ("./tools/deriver.js") or { use, options }.`);
      else if (!BUILTIN_DERIVERS[use] && !use.startsWith('./')) out.push(`derivers[${i}] "${use}" is not a built-in deriver (${Object.keys(BUILTIN_DERIVERS).join(', ')}) or a path starting with "./".`);
      else if (use.startsWith('./') && !inRepo(use)) out.push(`derivers[${i}] "${use}" leaves the repo.`);
      if (isObject(d) && d.options !== undefined && !isObject(d.options)) out.push(`derivers[${i}].options is an object.`);
    });
  }
  if (c.sources !== undefined) {
    if (!isObject(c.sources)) out.push('"sources" is an object: { live, house, devices, checker }.');
    else for (const [slot, s] of Object.entries(c.sources)) {
      if (!SOURCE_SLOTS.includes(slot)) { out.push(`sources.${slot}: the slots are ${SOURCE_SLOTS.join(', ')}.`); continue; }
      if (s === null) continue;
      const use = typeof s === 'string' ? s : isObject(s) ? s.use : null;
      if (!isText(use)) out.push(`sources.${slot} is null, a name ("house"), a path ("./tools/live.js") or { use, options }.`);
      else if (!BUILTIN_SOURCES[use] && !use.startsWith('./')) out.push(`sources.${slot} "${use}" is not a built-in source (${Object.keys(BUILTIN_SOURCES).join(', ')}) or a path starting with "./".`);
      else if (use.startsWith('./') && !inRepo(use)) out.push(`sources.${slot} "${use}" leaves the repo.`);
      if (isObject(s) && s.options !== undefined) {
        if (!isObject(s.options)) out.push(`sources.${slot}.options is an object.`);
        else {
          try { JSON.stringify(s.options); } catch { out.push(`sources.${slot}.options must be plain JSON: it is sent to the browser.`); }
        }
      }
    }
  }
  if (c.forge !== undefined && c.forge !== null) {
    if (!isObject(c.forge)) out.push('"forge" is { type, url, repo }.');
    else {
      if (!FORGE_TYPES.includes(c.forge.type)) out.push(`forge.type is one of ${FORGE_TYPES.join(', ')}.`);
      if (c.forge.url !== undefined && !/^https?:\/\/[^/\s]+\/?$/.test(String(c.forge.url))) out.push('forge.url is the forge\'s origin, like https://github.com.');
      if (!/^[\w.-]+\/[\w.-]+$/.test(String(c.forge.repo || ''))) out.push('forge.repo is "owner/name".');
    }
  }
  for (const key of ['worktrees', 'proposals', 'topology']) {
    if (c[key] !== undefined && c[key] !== null && !inRepo(c[key])) out.push(`"${key}" is a folder or file inside the repo, written relative to it.`);
  }
  if (c.links !== undefined) {
    if (!Array.isArray(c.links)) out.push('"links" is a list of { label, href }.');
    else c.links.forEach((l, i) => {
      if (!isObject(l) || !isText(l.label) || !/^(https?:\/\/|\/)/.test(String(l.href || ''))) out.push(`links[${i}] is { label, href } with an http(s) or same-origin href.`);
    });
  }
  if (c.proxy !== undefined) {
    if (!isObject(c.proxy)) out.push('"proxy" is { "/path/": "http://upstream" }.');
    else for (const [p, t] of Object.entries(c.proxy)) {
      if (!/^\/[\w.-]+\/$/.test(p)) out.push(`proxy "${p}": a path like "/api/" (one segment, slashes at both ends).`);
      if (!/^https?:\/\/[^/\s]+\/?$/.test(String(t))) out.push(`proxy "${p}": the target is an origin like http://127.0.0.1:3245.`);
      if (['/cornfield/', '/proposals/', '/explorer/', '/core/', '/plugins/', '/repo/'].includes(p)) out.push(`proxy "${p}" is cornfield's own path.`);
    }
  }
  if (c.importMap !== undefined && (!isObject(c.importMap) || Object.values(c.importMap).some((v) => !/^\/repo\/[\w@./-]+\.js$/.test(String(v))))) {
    out.push('"importMap" maps a bare name to a "/repo/<path>.js" module.');
  }
  if (c.personas !== undefined && (!isObject(c.personas) || (c.personas.roles != null && (!Array.isArray(c.personas.roles) || !c.personas.roles.every(isText))))) {
    out.push('"personas" is { roles: ["admin", …] | null, parent? }.');
  }
  return out;
}

/** A short, file-safe name for a repo root, for the default data folder */
function slugOf(root) {
  return path.basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

/**
 * The config of the repo at `root`: the file (when there is one) over the defaults, then env vars over that.
 * @param {string} root the target repo
 * @param {{ env?: Record<string, string|undefined>, file?: string }} [opts]
 * @returns {Promise<object>} the config, with `root` and `configFile` set
 */
export async function loadConfig(root, { env = process.env, file } = {}) {
  const absRoot = path.resolve(root);
  // cornfield.config.js, or cornfield.config.mjs in a repo whose package.json is not "type": "module"
  const fallback = !fs.existsSync(path.join(absRoot, CONFIG_FILE)) && fs.existsSync(path.join(absRoot, 'cornfield.config.mjs')) ? 'cornfield.config.mjs' : CONFIG_FILE;
  const configFile = path.resolve(absRoot, file || env.CORNFIELD_CONFIG || fallback);
  let raw = {};
  if (fs.existsSync(configFile)) {
    const mod = await import(`${pathToFileURL(configFile).href}?t=${fs.statSync(configFile).mtimeMs}`);
    raw = mod.default ?? {};
    const problems = configProblems(raw);
    if (problems.length) throw new Error(`${path.relative(absRoot, configFile) || CONFIG_FILE}:\n  ${problems.join('\n  ')}`);
  }
  const config = {
    ...structuredClone({ ...DEFAULTS, sources: { ...DEFAULTS.sources }, personas: { ...DEFAULTS.personas }, cloud: { ...DEFAULTS.cloud } }),
    ...raw,
    sources: { ...DEFAULTS.sources, ...(raw.sources || {}) },
    personas: { ...DEFAULTS.personas, ...(raw.personas || {}) },
    cloud: { ...DEFAULTS.cloud, ...(raw.cloud || {}) },
  };
  if (env.CORNFIELD_PORT) config.port = Number(env.CORNFIELD_PORT);
  if (env.PORT && !env.CORNFIELD_PORT) config.port = Number(env.PORT);
  if (env.CORNFIELD_HOST) config.host = env.CORNFIELD_HOST;
  if (env.CORNFIELD_PUBLIC_URL) config.publicUrl = env.CORNFIELD_PUBLIC_URL;
  if (env.CORNFIELD_DATA) config.dataDir = env.CORNFIELD_DATA;
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error(`The port must be a whole number from 0 to 65535 (got ${config.port}).`);
  if (!config.title) config.title = readPackageName(absRoot) || path.basename(absRoot);
  if (!config.dataDir) config.dataDir = path.join(os.homedir(), '.cornfield', slugOf(absRoot));
  config.root = absRoot;
  config.configFile = fs.existsSync(configFile) ? configFile : null;
  return config;
}

function readPackageName(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name || null;
  } catch {
    return null;
  }
}

/**
 * The derivers a config names, loaded: `[{ deriver, options }]`.
 * @param {object} config a loaded config
 */
export async function loadDerivers(config) {
  const out = [];
  for (const entry of config.derivers) {
    const use = typeof entry === 'string' ? entry : entry.use;
    const options = (typeof entry === 'object' && entry.options) || {};
    const file = BUILTIN_DERIVERS[use] ? path.join(CORNFIELD_DIR, BUILTIN_DERIVERS[use]) : path.resolve(config.root, use);
    if (!fs.existsSync(file)) throw new Error(`Deriver "${use}": ${file} does not exist.`);
    const mod = await import(pathToFileURL(file).href);
    const deriver = mod.default ?? mod.deriver;
    if (!deriver) throw new Error(`Deriver "${use}" (${file}) has no default export.`);
    out.push({ deriver, options });
  }
  return out;
}

/**
 * The sources as the browser loads them: `{ slot: { module, options } }`, with a repo-local module served under `/repo/`.
 * @param {object} config
 * @returns {Record<string, { module: string, options: object } | null>}
 */
export function browserSources(config) {
  const out = {};
  for (const slot of SOURCE_SLOTS) {
    const s = config.sources[slot];
    if (!s) { out[slot] = null; continue; }
    const use = typeof s === 'string' ? s : s.use;
    const options = (typeof s === 'object' && s.options) || {};
    out[slot] = { module: BUILTIN_SOURCES[use] || `/repo/${use.replace(/^\.\//, '')}`, options };
  }
  return out;
}
