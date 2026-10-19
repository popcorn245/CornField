#!/usr/bin/env node
/**
 * @module cli/cornfield
 *
 * The cornfield command, run against a repo (the current folder, or `--repo <dir>`):
 *
 *   cornfield serve              the dev dashboard on http://127.0.0.1:3350 (loopback only unless sign-in is configured)
 *   cornfield sync               derive the map from the code and write topology.json
 *   cornfield validate           the schema, drift from the code, the personas and cloud files, every proposal
 *   cornfield status             what the map holds, the warnings, and the validation
 *   cornfield proposal <file>    one proposal against the map: its summary, its errors, what has landed
 *   cornfield review <slug>      the last review of a proposal (approve or send back, with the edits)
 *   cornfield docs               the docs as a static site, from the docs deriver's map of them (--out, default _site)
 *   cornfield help | --version
 *
 * Options: `--repo <dir>`, `--config <file>`, `--port <n>`. Env: CORNFIELD_PORT, CORNFIELD_HOST,
 * CORNFIELD_PUBLIC_URL, CORNFIELD_DATA, CORNFIELD_CONFIG (core/config.js).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadDerivers } from '../core/config.js';
import { deriveTopology } from '../core/derive.js';
import { planSync, placeholderCounts } from '../core/sync.js';
import { validateRepo, readTopology } from '../core/validate.js';
import { proposalProblems, proposalStatus, summarize } from '../core/proposal.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

const HELP = `cornfield ${PKG.version}: the topology map and dev dashboard for a repo

Usage: cornfield <command> [options]

Commands:
  serve              run the dashboard on this machine (http://127.0.0.1:3350)
  sync               derive the map from the code into topology.json
  validate           check the map, its drift from the code, and every proposal (exit 1 on a problem)
  status             what the map holds, the warnings, and the validation
  proposal <file>    check one proposal against the map
  review <slug>      print the last review of a proposal (--source <worktree> for a worktree's copy)
  docs               build the docs as a static site from their map (--out <dir>, default _site)
  help               this text

Options:
  --repo <dir>       the repo to work on (default: the current folder)
  --config <file>    the config file (default: cornfield.config.js in the repo)
  --port <n>         the port for serve (default 3350, or CORNFIELD_PORT)
  --version          print the version
`;

/** `--name value` pairs and the rest */
export function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version' || a === '-v') flags.version = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      flags[k] = inline !== undefined ? inline : argv[++i];
    } else rest.push(a);
  }
  return { flags, rest };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function setup(flags) {
  const root = path.resolve(flags.repo || process.cwd());
  const env = { ...process.env, ...(flags.port ? { CORNFIELD_PORT: String(flags.port) } : {}) };
  const config = await loadConfig(root, { env, file: flags.config });
  const derivers = await loadDerivers(config);
  return { config, derivers };
}

function saveTopology(config, data) {
  const file = path.join(config.root, config.topology);
  fs.writeFileSync(file, `${JSON.stringify({ version: data.version || '1.0.0', ...data, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
}

async function sync(flags) {
  const { config, derivers } = await setup(flags);
  const current = readTopology(config) || { version: '1.0.0', nodes: [], edges: [] };
  const derived = await deriveTopology({ root: config.root, config, derivers, map: current });
  derived.warnings.forEach((w) => console.warn(`  warning: ${w}`));
  const { next, changes } = planSync(current, derived);
  if (!changes.length) {
    console.log(`\n${config.topology} already matches the code.\n`);
    return 0;
  }
  saveTopology(config, next);
  changes.slice(0, 200).forEach((c) => console.log(`  ${c}`));
  if (changes.length > 200) console.log(`  … and ${changes.length - 200} more`);
  console.log(`\nSynced ${plural(changes.length, 'change')} from the code into ${config.topology}.\n`);
  return 0;
}

async function validate(flags) {
  const { config, derivers } = await setup(flags);
  const { errors, warnings } = await validateRepo({ config, derivers });
  warnings.forEach((w) => console.warn(`  warning: ${w}`));
  if (errors.length) {
    console.error(`\nValidation failed with ${plural(errors.length, 'error')}:`);
    errors.forEach((e) => console.error(`  - ${e}`));
    console.error('');
    return 1;
  }
  console.log(`\nValid: the schema holds, ${config.topology} matches the code, and every proposal checks out.\n`);
  return 0;
}

async function status(flags) {
  const { config, derivers } = await setup(flags);
  const data = readTopology(config);
  if (!data) {
    console.log(`\n${config.topology} is not there yet: run cornfield sync.\n`);
    return 1;
  }
  console.log(`\n${config.title}: ${plural(data.nodes.length, 'node')}, ${plural(data.edges.length, 'edge')}`);
  const byType = Object.entries(Object.groupBy(data.nodes, (n) => n.type)).sort((a, b) => b[1].length - a[1].length);
  for (const [type, nodes] of byType) console.log(`  ${type.padEnd(10)} ${String(nodes.length).padStart(5)}  ${nodes.slice(0, 6).map((n) => n.label).join(', ')}${nodes.length > 6 ? ', …' : ''}`);
  const cloud = data.nodes.filter((n) => n.type === 'external' && n.kind === 'cloud');
  if (cloud.length) {
    const tiers = Object.entries(Object.groupBy(cloud, (n) => n.plan?.tier || 'unknown')).map(([t, ns]) => `${ns.length} ${t}`).join(', ');
    console.log(`\nCloud: ${plural(cloud.length, 'service')} (${tiers})`);
  }
  const placeholders = placeholderCounts(data);
  if (placeholders.size) {
    const total = [...placeholders.values()].reduce((s, c) => s + c, 0);
    console.log(`\n${plural(total, 'node')} still have the description sync wrote; write a real one in ${config.topology}.`);
  }
  const { errors, warnings } = await validateRepo({ config, derivers, topology: data });
  if (warnings.length) {
    console.log(`\n${plural(warnings.length, 'warning')} from the code:`);
    warnings.forEach((w) => console.log(`  - ${w}`));
  }
  if (errors.length) {
    console.log(`\n${plural(errors.length, 'validation error')}:`);
    errors.forEach((e) => console.log(`  - ${e}`));
  } else console.log('\nValid: the schema holds and the map matches the code.');
  console.log(`\nMap: cornfield serve, then http://127.0.0.1:${config.port}\n`);
  return errors.length ? 1 : 0;
}

async function proposal(flags, file) {
  if (!file) {
    console.error('Usage: cornfield proposal <file>');
    return 1;
  }
  const { config } = await setup(flags);
  let p;
  try {
    p = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (err) {
    console.error(`\n${file}: ${err.code === 'ENOENT' ? 'no such file' : `not valid JSON (${err.message})`}\n`);
    return 1;
  }
  const topology = readTopology(config) || { nodes: [], edges: [] };
  const { errors, building } = proposalProblems(topology, p);
  const s = summarize(p);
  console.log(`\n${p?.title || path.basename(file)}${p?.spec ? ` (spec ${p.spec})` : ''}`);
  if (p?.summary) console.log(`  ${p.summary}`);
  console.log(`  ${s.added} added · ${s.changed} changed · ${s.removed} removed · ${plural(s.scenarios, 'scenario')}`);
  if (errors.length) {
    console.log(`\n${plural(errors.length, 'error')}:`);
    errors.forEach((e) => console.log(`  - ${e.path || '(file)'}: ${e.message}`));
    console.log('');
    return 1;
  }
  const { items, summary } = proposalStatus(topology, p);
  console.log(`\n  Against ${config.topology}: ${summary.landed} landed · ${summary.pending} pending · ${summary.diverged} diverged${summary.live ? ` · ${summary.live} live` : ''}${building ? ' (the build has begun)' : ''}`);
  for (const i of items) console.log(`  ${i.status.padEnd(8)} ${i.op.padEnd(6)} ${i.kind.padEnd(4)} ${i.key}`);
  console.log('\nThe proposal is valid.\n');
  return 0;
}

async function review(flags, slug) {
  if (!slug) {
    console.error('Usage: cornfield review <slug> [--source <worktree>]');
    return 1;
  }
  const { config } = await setup(flags);
  const { findProposalFile, reviewFilePath } = await import('../server/files.js');
  const entry = findProposalFile({ root: config.root, proposals: config.proposals, worktrees: config.worktrees }, slug, flags.source || null);
  if (!entry) {
    console.error(`\nNo proposal "${slug}" in ${config.proposals}${config.worktrees ? ` or the worktrees in ${config.worktrees}` : ''}.\n`);
    return 1;
  }
  const file = reviewFilePath(entry, config.dataDir);
  if (!file || !fs.existsSync(file)) {
    console.log(`\nNo review of ${slug} (${entry.source}) yet.\n`);
    return 0;
  }
  process.stdout.write(fs.readFileSync(file, 'utf8'));
  return 0;
}

async function docs(flags) {
  const { config, derivers } = await setup(flags);
  const { buildSite } = await import('../plugins/docs/site.js');
  const out = path.resolve(config.root, flags.out || '_site');
  const { pages, files, warnings, problems } = await buildSite({ config, derivers, out });
  warnings.forEach((w) => console.warn(`  warning: ${w}`));
  problems.forEach((p) => console.warn(`  problem: ${p}`));
  console.log(`\nBuilt ${plural(pages, 'page')} (${plural(files.length, 'file')}) into ${path.relative(process.cwd(), out) || out}.\n`);
  return 0;
}

async function serve(flags) {
  const { config } = await setup(flags);
  const { listen } = await import('../server/server.js');
  const { url, signIn } = await listen(config);
  console.log(`\ncornfield ${PKG.version} is serving ${config.title}`);
  console.log(`  ${url}${signIn && config.publicUrl ? `, opened at ${config.publicUrl}` : ''}`);
  if (signIn) console.log(`  Sign-in with ${config.forge.type === 'github' ? 'GitHub' : 'Forgejo'}: only the maintainers of ${config.forge.repo} see the dashboard.\n`);
  else console.log('  Loopback only: sign-in is not configured (docs/sign-in.md), so nothing else can reach it.\n');
  return null; // keeps running
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, rest } = parseArgs(argv);
  const [command = 'help', arg] = rest;
  if (flags.version) { console.log(PKG.version); return 0; }
  if (flags.help || command === 'help') { console.log(HELP); return 0; }
  const commands = { serve, sync, validate, status, proposal: (f) => proposal(f, arg), review: (f) => review(f, arg), docs };
  if (!commands[command]) {
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    return 1;
  }
  return commands[command](flags);
}

const isMain = process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  main().then((code) => { if (code !== null) process.exitCode = code; }).catch((err) => {
    console.error(`\ncornfield: ${err.message}\n`);
    process.exitCode = 1;
  });
}
