/**
 * @module core/validate
 *
 * What `cornfield validate` checks:
 *
 *  - `validateTopology(topology)`: the schema, pure. Node types and their colours, page labels, the
 *    edge kinds and which ends each may join, flows, `when` / `side`, live types and ids kept out.
 *  - `validateRepo(...)`: everything, against the repo. The schema, the paths the map cites, drift from
 *    the code (every deriver run again, `planSync` must change nothing), what the derivers themselves
 *    report, the personas file, the cloud file against the map's cloud nodes, every proposal file, and
 *    each deriver's own `validate`, and the theme's contrast (core/contrast.js: WCAG AA on the `--corn-*` pairs, light and dark).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  NODE_THEMES, FLOW_KINDS, DATA_EDGE_KINDS, SERVICE_EDGE_KINDS, STACK_EDGE_KINDS, EDGE_ENDS,
  endsAllowed, describeEnds, committedNodeProblems, callFieldProblems,
} from './schema.js';
import { mockupsOf, proposalProblems, summarize } from './proposal.js';
import { PERSONAS_FILE, validatePersonas } from './personas.js';
import { CLOUD_FILE, cloudNodeProblems } from './cloud.js';
import { deriveTopology } from './derive.js';
import { missingPaths, planSync } from './sync.js';
import { repoPaths, repoReader } from './repo.js';
import { checkThemeContrast } from './contrast.js';
import { BRAND_IMAGE_KEYS, brandAssetFile } from './brand.js';
import { MAX_THEME_BYTES, cssProblems, cssUrls, themeAssetFile, themeFileUrl, themeFiles, themeIconFileProblems, themeUrlTarget } from './theme.js';

/** How a page is produced today, and whether it is baked to a file */
export const RENDER_NOW = ['build', 'request', 'build+request', 'rom'];
export const ROM_MODES = ['bake', 'skip'];

const ONLY_REMOVES_HINT = '(A proposal that adds nothing cannot show it has been built: delete it, or close its spec, in the PR that lands it.)';

/**
 * The config's theme files (docs/config.md#theme): each one exists, is a plain file inside the repo (a link out of it is refused),
 * is at most MAX_THEME_BYTES, is CSS that keeps out of script (core/theme.js `cssProblems`), and every url() in it is a data: image
 * or an image or font the server serves beside the theme (core/theme.js `themeUrlTarget`, `themeAssetFile`), and every node icon
 * (`theme.icons`) is an .svg or .png file there (`themeIconFileProblems`).
 * @param {{ root: string, theme?: object }} config
 * @returns {string[]}
 */
export function validateThemeFiles(config) {
  const errors = [];
  let base;
  try { base = fs.realpathSync(config.root); } catch { return errors; }
  for (const { key, rel } of themeFiles(config.theme)) {
    const where = `theme.${key} (${rel})`;
    const file = path.resolve(config.root, rel);
    let real;
    try { real = fs.realpathSync(file); } catch { errors.push(`${where} does not exist.`); continue; }
    if (!real.startsWith(base + path.sep)) { errors.push(`${where} leaves the repo (a link or a path that resolves outside it).`); continue; }
    const stats = fs.statSync(real);
    if (!stats.isFile()) { errors.push(`${where} is not a file.`); continue; }
    if (stats.size > MAX_THEME_BYTES) { errors.push(`${where} is ${Math.ceil(stats.size / 1024)} KB; a theme file is at most ${MAX_THEME_BYTES / 1024} KB.`); continue; }
    const text = fs.readFileSync(real, 'utf8');
    for (const p of cssProblems(text, { fonts: config.theme.fonts })) errors.push(`${where} ${p}`);
    // Every url() leads to an image or font served beside the theme, or is a data: image (docs/config.md#theme)
    for (const ref of new Set(cssUrls(text))) {
      const target = themeUrlTarget(ref, themeFileUrl(key));
      if (target.problem) { errors.push(`${where} ${target.problem}`); continue; }
      if (target.asset) {
        const found = themeAssetFile(config.root, config.theme, target.asset);
        if ('problem' in found) errors.push(`${where} url(${ref.slice(0, 80)}): ${found.problem}`);
      }
    }
  }
  errors.push(...themeIconFileProblems(config)); // theme.icons: each file is there, served, and an image
  return errors;
}

/**
 * The config's brand images (docs/config.md#brand): each one exists, is a plain file inside the repo (a link out of it is refused),
 * has an allowed extension (.svg, .png) and first bytes that match it, and is at most MAX_BRAND_BYTES (core/brand.js `brandAssetFile`).
 * @param {{ root: string, brand?: object }} config
 * @returns {string[]}
 */
export function validateBrandFiles(config) {
  const errors = [];
  for (const key of BRAND_IMAGE_KEYS) {
    const rel = config.brand && config.brand[key];
    if (typeof rel !== 'string') continue;
    const found = brandAssetFile(config.root, rel);
    if ('problem' in found) errors.push(`brand.${key} (${rel}) ${found.problem}`);
  }
  return errors;
}

/**
 * The schema checks: no files, no derivers.
 * @param {{ nodes: any[], edges: any[] }} topology
 * @param {{ requireExternalKind?: boolean }} [opts] whether every external needs a kind (default true)
 * @returns {string[]}
 */
export function validateTopology(topology, { requireExternalKind = true } = {}) {
  const errors = [];
  if (!topology || !Array.isArray(topology.nodes) || !Array.isArray(topology.edges)) return ['topology.json must be { "nodes": [...], "edges": [...] }.'];
  const nodeIds = new Set();
  const nodeTypes = new Map();
  const nodeById = new Map();
  topology.nodes.forEach((node, idx) => {
    if (!node.id) errors.push(`Node #${idx} is missing an 'id'.`);
    if (nodeIds.has(node.id)) errors.push(`Duplicate node id: "${node.id}".`);
    nodeIds.add(node.id);
    nodeTypes.set(node.id, node.type);
    nodeById.set(node.id, node);

    const theme = NODE_THEMES[node.type];
    if (!theme) {
      errors.push(`Node "${node.id}" has unknown type: "${node.type}". Valid types: ${Object.keys(NODE_THEMES).join(', ')}`);
    } else {
      if (node.type === 'page') {
        if (node.color !== NODE_THEMES.page.color) errors.push(`Page node "${node.id}" has color "${node.color}". All pages use "${NODE_THEMES.page.color}".`);
        if (typeof node.label !== 'string' || !node.label.startsWith('/')) errors.push(`Page node "${node.id}" label "${node.label}" must start with a slash route (e.g. "/cart"). Put the file in 'file'.`);
        else if (node.label.includes('.html')) errors.push(`Page node "${node.id}" label "${node.label}" contains ".html". Use a clean route label and put the file in 'file'.`);
        if (node.render) {
          if (!RENDER_NOW.includes(node.render.now)) errors.push(`Page node "${node.id}" render.now "${node.render.now}" must be one of: ${RENDER_NOW.join(', ')}`);
          if (!ROM_MODES.includes(node.render.rom)) errors.push(`Page node "${node.id}" render.rom "${node.render.rom}" must be one of: ${ROM_MODES.join(', ')}`);
        }
      }
      if (node.type === 'table' && !node.table) errors.push(`Table node "${node.id}" needs 'table', the SQL table name.`);
    }
    // Floors, rooms, live devices and live ids are the live layer's, never committed; every external has a kind
    errors.push(...committedNodeProblems(node, { requireKind: requireExternalKind }));
  });

  topology.edges.forEach((edge, idx) => {
    if (!edge.from || !edge.to) {
      errors.push(`Edge #${idx} missing 'from' or 'to'.`);
    } else {
      if (!nodeIds.has(edge.from)) errors.push(`Edge #${idx} references non-existent 'from' node: "${edge.from}".`);
      if (!nodeIds.has(edge.to)) errors.push(`Edge #${idx} references non-existent 'to' node: "${edge.to}".`);
    }
    if (edge.kind === 'flow') {
      const where = `Flow edge #${idx} (${edge.from} -> ${edge.to})`;
      if (!FLOW_KINDS.includes(edge.flow)) errors.push(`${where} has unknown flow "${edge.flow}". Valid flows: ${FLOW_KINDS.join(', ')}`);
      if (!['live', 'proposed'].includes(edge.status)) errors.push(`${where} needs status "live" or "proposed".`);
      if (!edge.label) errors.push(`${where} needs a label describing the flow.`);
    }
    if (DATA_EDGE_KINDS.includes(edge.kind)) {
      const where = `${edge.kind} edge #${idx} (${edge.from} -> ${edge.to})`;
      const ok = edge.kind === 'reads'
        ? ['table', 'store'].includes(nodeTypes.get(edge.from)) && ['page', 'app', 'service'].includes(nodeTypes.get(edge.to))
        : ['page', 'service'].includes(nodeTypes.get(edge.from)) && ['table', 'store'].includes(nodeTypes.get(edge.to));
      if (!ok) errors.push(`${where} must go ${edge.kind === 'reads' ? 'table -> page (or app, service)' : 'page (or service) -> table'} (a store stands in for a table).`);
      if (!['live', 'proposed'].includes(edge.status)) errors.push(`${where} needs status "live" or "proposed".`);
      if (edge.kind === 'reads' && (!Array.isArray(edge.keys) || edge.keys.length === 0)) errors.push(`${where} needs 'keys', the dependency keys the page's render reads.`);
      if (edge.kind === 'writes' && !edge.label) errors.push(`${where} needs a label naming the action.`);
    }
    if (SERVICE_EDGE_KINDS.includes(edge.kind)) {
      const where = `${edge.kind} edge #${idx} (${edge.from} -> ${edge.to})`;
      const from = nodeTypes.get(edge.from);
      const to = nodeTypes.get(edge.to);
      const ok = edge.kind === 'triggers' ? ['service', 'store', 'page'].includes(from) && to === 'service' : endsAllowed(EDGE_ENDS[edge.kind], from, to);
      if (!ok) errors.push(`${where} must go ${edge.kind === 'triggers' ? 'service, store or endpoint -> service' : describeEnds(EDGE_ENDS[edge.kind])}.`);
      if (!edge.label) errors.push(`${where} needs a label.`);
    }
    if (edge.when !== undefined || edge.side !== undefined) {
      for (const problem of callFieldProblems(edge, nodeById.get(edge.from), nodeById.get(edge.to))) errors.push(`${edge.kind || 'Ownership'} edge #${idx} (${edge.from} -> ${edge.to}) ${problem}`);
    }
    if (STACK_EDGE_KINDS.includes(edge.kind)) {
      const where = `${edge.kind} edge #${idx} (${edge.from} -> ${edge.to})`;
      const appToStack = nodeTypes.get(edge.from) === 'app' && nodeTypes.get(edge.to) === 'stack';
      if (!endsAllowed(EDGE_ENDS['runs-on'], nodeTypes.get(edge.from), nodeTypes.get(edge.to))) errors.push(`${where} must go ${describeEnds(EDGE_ENDS['runs-on'])}.`);
      if (!edge.label) errors.push(`${where} needs a label.`);
      if (appToStack && (!Array.isArray(edge.mappings) || !edge.mappings.length)) errors.push(`${where} needs 'mappings', the host -> upstream rows behind it.`);
      if (!appToStack && edge.mappings !== undefined) errors.push(`${where} has 'mappings': they belong only on app -> stack; code running on a machine has none.`);
    }
    if (edge.kind === 'uses' && (nodeTypes.get(edge.to) !== 'token' || !Array.isArray(edge.vars) || !edge.vars.length)) {
      errors.push(`uses edge #${idx} (${edge.from} -> ${edge.to}) must point at a token group and list the vars it uses.`);
    }
  });
  return errors;
}

/**
 * Every proposal file in a folder (review files, `*.review.json`, are not proposals), against the map.
 * @param {{ nodes: object[], edges: object[] }} topology
 * @param {string} dir an absolute folder
 * @param {string} [root] what the file names in messages are relative to
 * @returns {string[]} one line per problem, naming the file
 */
export function validateProposalFiles(topology, dir, root = path.dirname(dir)) {
  if (!fs.existsSync(dir)) return [];
  const problems = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.review.json')).sort()) {
    const where = path.relative(root, path.join(dir, file)).split(path.sep).join('/');
    let proposal;
    try {
      proposal = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (err) {
      problems.push(`${where} is not valid JSON: ${err.message}`);
      continue;
    }
    const hint = summarize(proposal).added === 0 ? ` ${ONLY_REMOVES_HINT}` : '';
    for (const e of proposalProblems(topology, proposal).errors) problems.push(`${where}: ${e.path || '(file)'}: ${e.message}${e.state === 'missing-target' ? hint : ''}`);
    // A mockup the proposal lists must be a file beside it, so a typo fails here and not only in the explorer
    for (const m of mockupsOf(proposal)) {
      let ok = false;
      try { ok = fs.statSync(path.join(dir, ...m.path.split('/'))).isFile(); } catch { ok = false; }
      if (!ok) problems.push(`${where}: mockups[${m.index}].path: "${m.path}" is not a file in ${path.relative(root, dir).split(path.sep).join('/') || '.'}.`);
    }
  }
  return problems;
}

/**
 * The personas file of a repo, when it has one: its shape, its roles, and that no two personas count the same account.
 * @param {string} root
 * @param {string[]|null} [roles] the roles the config declares
 * @returns {string[]}
 */
export function validatePersonasFile(root, roles = null) {
  const file = path.join(root, PERSONAS_FILE);
  if (!fs.existsSync(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return [`${PERSONAS_FILE} is not valid JSON: ${err.message}`];
  }
  return validatePersonas(parsed, { roles }).map((p) => `${PERSONAS_FILE}: ${p}`);
}

/**
 * The map's cloud nodes against the repo's topology.cloud.json: every cloud node is an entry's, every entry has its node.
 * @param {{ nodes: any[] }} topology
 * @param {string} root
 * @returns {string[]}
 */
export function validateCloudNodes(topology, root) {
  const file = path.join(root, CLOUD_FILE);
  let parsed = null;
  if (fs.existsSync(file)) {
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      return [`${CLOUD_FILE} is not valid JSON: ${err.message}`];
    }
  }
  return cloudNodeProblems(topology.nodes, parsed);
}

/** The committed map of a repo, or null when there is none yet */
export function readTopology(config) {
  const file = path.join(config.root, config.topology);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Everything `cornfield validate` checks.
 * @param {{ config: object, derivers: { deriver: object, options?: object }[], topology?: object|null }} opts
 * @returns {Promise<{ errors: string[], warnings: string[], derived: object|null }>}
 */
export async function validateRepo({ config, derivers, topology = readTopology(config) }) {
  if (!topology) return { errors: [`${config.topology} is missing: run cornfield sync to make it.`], warnings: [], derived: null };
  const errors = validateTopology(topology);
  try {
    errors.push(...missingPaths(topology, repoPaths(config.root)));
  } catch (err) {
    errors.push(`Checking the paths the map cites failed: ${err.message}`);
  }
  let derived = null;
  const warnings = [];
  try {
    derived = await deriveTopology({ root: config.root, config, derivers, map: topology });
    warnings.push(...derived.warnings);
    errors.push(...derived.problems);
    const { changes } = planSync(topology, derived);
    if (changes.length) {
      errors.push(`${config.topology} is out of date with the code (${changes.length} change(s)); run: cornfield sync`);
      changes.slice(0, 15).forEach((c) => errors.push(`  drift: ${c}`));
    }
  } catch (err) {
    errors.push(`Deriving the map from the code failed: ${err.message}`);
  }
  errors.push(...validatePersonasFile(config.root, config.personas.roles));
  errors.push(...validateThemeFiles(config));
  errors.push(...validateBrandFiles(config));
  const contrast = checkThemeContrast(config);
  errors.push(...contrast.errors);
  warnings.push(...contrast.warnings);
  errors.push(...validateCloudNodes(topology, config.root));
  errors.push(...validateProposalFiles(topology, path.join(config.root, config.proposals), config.root));
  const io = repoReader(config.root);
  for (const { deriver, options } of derivers) {
    if (typeof deriver.validate !== 'function') continue;
    try {
      errors.push(...(await deriver.validate({ ...io, config, options: options || {} }, topology)));
    } catch (err) {
      errors.push(`Deriver "${deriver.name}" could not check the map: ${err.message}`);
    }
  }
  return { errors, warnings, derived };
}
