/**
 * Serve the big map for a design review.
 *
 *   node test/fixtures/big/serve.js --port 3401                 the big map, default theme
 *   node test/fixtures/big/serve.js --theme retro --port 3402   the same map in the retro brand theme
 *   node test/fixtures/big/serve.js --from <topology dir> [--dir <out>]   a repo generated from any topology folder, served
 *   node test/fixtures/big/serve.js --repo <dir> [--theme retro]            a repo already generated (make.js --from), served
 *
 * The repo is generated (test/fixtures/big/make.js) into a folder under the OS temp dir (or `--dir <dir>`), then served by
 * cornfield's own server on 127.0.0.1, with no sign-in, so every route answers. Ctrl-C stops it. See README.md.
 *
 *   node test/fixtures/big/serve.js --forge --port 3403 [--runner offline]   the same, with sign-in against a fake GitHub: sign in as a maintainer
 *     (open /auth/start), PRs, issues, threads, checks, a spec PR per rich proposal, and runs in every state (forge.js)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../../core/config.js';
import { listen } from '../../../server/server.js';
import { writeBig, configText, retroTheme } from './make.js';
import { startForgeWorld, readRepoFiles, SIGN_IN_ENV, REPO, MAINTAINER } from './forge.js';

export function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const [k, inline] = argv[i].slice(2).split('=');
    flags[k] = inline !== undefined ? inline : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return flags;
}

/**
 * The repo to serve, with its config loaded:
 *  - `repo`: an existing repo folder, served as it is (with `theme`, its config and tools/cornfield/ are rewritten for that theme)
 *  - `from`: a topology folder (topology.json, and its cloud and personas files): a repo is generated from it into `dir`
 *  - neither: the synthetic big map is generated into `dir`
 */
export async function prepare({ theme = null, dir, repo: existing, from, seed, env = {}, configure } = {}) {
  let repo;
  let made = null;
  if (existing) {
    repo = path.resolve(existing);
    if (theme) {
      const retro = retroTheme();
      fs.writeFileSync(path.join(repo, 'cornfield.config.js'), configText({ theme, retro }));
      for (const [rel, text] of Object.entries(retro.files)) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); }
    }
    const topology = JSON.parse(fs.readFileSync(path.join(repo, 'topology.json'), 'utf8'));
    const proposalsDir = path.join(repo, 'docs', 'specs', 'proposals');
    const slugs = fs.existsSync(proposalsDir) ? fs.readdirSync(proposalsDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort() : [];
    made = { topology, proposals: slugs };
  } else {
    repo = path.resolve(dir || path.join(os.tmpdir(), `cornfield-big-${theme || 'default'}`));
    fs.rmSync(repo, { recursive: true, force: true });
    made = writeBig(repo, { theme, seed, from: from ? path.resolve(from) : null, ...(configure ? { configure } : {}) });
  }
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
  const opts = { theme, dir: flags.dir, repo: flags.repo && flags.repo !== true ? flags.repo : null, from: flags.from && flags.from !== true ? flags.from : null, seed: flags.seed ? Number(flags.seed) : undefined, env: { CORNFIELD_PORT: String(port) } };
  const { repo, made, config, data } = await prepare(opts);
  let world = null;
  let serverConfig = { ...config, port };
  let env = process.env;
  if (flags.forge) {
    world = await startForgeWorld({ repoFiles: readRepoFiles(repo), slugs: made.proposals, port: port + 100, runner: ['offline', 'none'].includes(flags.runner) ? flags.runner : 'online', dataDir: data });
    serverConfig = { ...serverConfig, agents: { ...serverConfig.agents, maxOpen: 10, transport: 'pull' }, forge: { type: 'github', url: world.forge.url, repo: REPO }, publicUrl: `http://127.0.0.1:${port}` };
    env = { ...process.env, ...SIGN_IN_ENV };
  }
  const { url } = await listen(serverConfig, { env });
  console.log(`\n${flags.repo || flags.from ? 'Map' : 'Big map'}, ${config.theme && config.theme.css ? 'themed' : 'default theme'}${world ? ', signed-in states with a fake forge' : ''}: ${made.topology.nodes.length} nodes, ${made.topology.edges.length} edges, repo ${repo}`);
  console.log(`  ${url}/`);
  console.log(describe(made, url));
  if (world) {
    const first = world.specs[0];
    console.log(`\n  Signed in as ${MAINTAINER} (a maintainer of ${REPO}, in the fake forge): open ${url}/auth/start once, or follow the sign-in page; it lands back on the map.`);
    console.log(`  Signed out, cold open through the real sign-in page: ${url}/?proposal=${first.slug}&source=pull/${first.n}`);
    console.log(`  Spec PRs (open one with ?proposal=<slug>&source=pull/<n>): ${world.specs.map((s) => `#${s.n} ${s.slug}`).join(', ')}`);
    console.log(`  Runs in every state are in the Work panel, Runs tab. Runner: ${['offline', 'none'].includes(flags.runner) ? flags.runner.toUpperCase() : 'online'}; switch: curl ${world.forge.url}/__rig/runner?state=online|offline|none`);
  }
  console.log('\nCtrl-C stops it.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((err) => { console.error(err.message); process.exit(1); });
