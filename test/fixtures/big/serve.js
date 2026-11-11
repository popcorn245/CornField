/**
 * Serve the big map for a design review.
 *
 *   node test/fixtures/big/serve.js --port 3401                 the big map, default theme
 *   node test/fixtures/big/serve.js --theme retro --port 3402   the same map in the retro brand theme
 *
 * The repo is generated (test/fixtures/big/make.js) into a folder under the OS temp dir (or `--dir <dir>`), then served by
 * cornfield's own server on 127.0.0.1, with no sign-in, so every route answers. Ctrl-C stops it. See README.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../../core/config.js';
import { listen } from '../../../server/server.js';
import { writeBig } from './make.js';

export function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const [k, inline] = argv[i].slice(2).split('=');
    flags[k] = inline !== undefined ? inline : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return flags;
}

/** Generate the repo for a theme into `dir` (replacing what a run left there) and return its config, loaded */
export async function prepare({ theme = null, dir, seed, env = {}, configure } = {}) {
  const repo = path.resolve(dir || path.join(os.tmpdir(), `cornfield-big-${theme || 'default'}`));
  fs.rmSync(repo, { recursive: true, force: true });
  const made = writeBig(repo, { theme, seed, ...(configure ? { configure } : {}) });
  const data = `${repo}.data`;
  fs.mkdirSync(data, { recursive: true });
  const config = await loadConfig(repo, { env: { ...process.env, ...env, CORNFIELD_DATA: data } });
  return { repo, data, made, config };
}

/** What a reviewer needs on the terminal: where it is, and which proposals open what */
export function describe(made, base) {
  const rich = made.proposals.filter((s) => /^01\d\d-/.test(s));
  return [
    `  map        ${base}/`,
    `  proposals  ${made.proposals.length} (the Proposals entry of the account menu lists them)`,
    ...rich.map((s) => `  ${s.padEnd(34)} ${base}/?proposal=${s}`),
  ].join('\n');
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const theme = flags.theme && flags.theme !== true ? flags.theme : null;
  const port = Number(flags.port || 3401);
  const { repo, made, config } = await prepare({ theme, dir: flags.dir, seed: flags.seed ? Number(flags.seed) : undefined, env: { CORNFIELD_PORT: String(port) } });
  const { url } = await listen({ ...config, port });
  console.log(`\nBig map, ${theme ? `${theme} theme` : 'default theme'}: ${made.topology.nodes.length} nodes, ${made.topology.edges.length} edges, repo ${repo}`);
  console.log(`  ${url}/`);
  console.log(describe(made, url));
  console.log('\nCtrl-C stops it.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((err) => { console.error(err.message); process.exit(1); });
