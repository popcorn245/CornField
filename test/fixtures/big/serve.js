/**
 * Serve the big map for a design review.
 *
 *   node test/fixtures/big/serve.js --port 3401                 the big map, default theme
 *   node test/fixtures/big/serve.js --theme retro --port 3402   the same map in the retro brand theme
 *   node test/fixtures/big/serve.js --from <topology dir> [--dir <out>]   a repo generated from any topology folder, served
 *   node test/fixtures/big/serve.js --repo <dir> [--theme retro]            a repo already generated (make.js --from), served
 *
 * The repo is generated (test/fixtures/big/make.js) into a folder under the OS temp dir (or `--dir <dir>`), then served by
 * cornfield's own server on 127.0.0.1 only, with no sign-in, so every route answers. Its state goes to a folder under the OS temp dir. Ctrl-C stops it. See README.md.
 *
 *   node test/fixtures/big/serve.js --forge --port 3403 --embed http://tasks.corn.localhost:3713 --public http://map.corn.localhost:3403 [--forge-port 3503]
 *     the same, with a sibling origin listed (`embed.origins`, docs/embedding.md); `--embed` takes origins separated by commas. `--public` is the URL the
 *     browser opens it at when it is not 127.0.0.1 (a `*.localhost` name: Chromium resolves it to loopback, so two names are two origins on one machine;
 *     test/fixtures/big/embed-proof.mjs uses it). It still listens on 127.0.0.1 only. `--forge-port` is the fake forge's port (default: the port + 100).
 *   node test/fixtures/big/serve.js --forge --port 3403 [--runner offline]   the same, with sign-in against a fake GitHub: sign in as a maintainer
 *     (open /auth/start), PRs, issues, threads, checks, a spec PR per rich proposal, and runs in every state (forge.js)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadConfig, embedOrigin } from '../../../core/config.js';
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

/** The shell's env without anything that would turn on real sign-in, a real hook secret or another host, URL or config */
const rigEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CORNFIELD_(GITHUB|FORGEJO|SESSION|HOOK|HOST|PUBLIC_URL|CONFIG|HA)_?/.test(k)));

/** Whether `dir` holds a repo make.js wrote (its config carries the generator's first line) */
const isGenerated = (dir) => {
  try { return fs.readFileSync(path.join(dir, 'cornfield.config.js'), 'utf8').startsWith(configText({}).split('\n')[0]); } catch { return false; }
};

/**
 * The repo to serve, with its config loaded:
 *  - `repo`: an existing repo folder, served as it is (with `theme`, its config and tools/cornfield/ are rewritten for that theme)
 *  - `from`: a topology folder (topology.json, and its cloud and personas files): a repo is generated from it into `dir`
 *  - neither: the synthetic big map is generated into `dir`
 */
export async function prepare({ theme = null, dir, repo: existing, from, seed, layers = false, env = {} } = {}) {
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
    if (fs.existsSync(repo) && fs.readdirSync(repo).length && !isGenerated(repo)) throw new Error(`${repo} is not empty and not a repo this rig made: refusing to replace it`);
    fs.rmSync(repo, { recursive: true, force: true });
    made = writeBig(repo, { theme, seed, layers, from: from ? path.resolve(from) : null });
  }
  // cornfield's own state (sessions, runs) stays in the temp dir, never beside a repo you named
  const data = path.join(os.tmpdir(), `cornfield-big-data-${createHash('sha256').update(repo).digest('hex').slice(0, 12)}`);
  fs.mkdirSync(data, { recursive: true });
  const config = await loadConfig(repo, { env: { ...rigEnv(), ...env, CORNFIELD_DATA: data } });
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

/** The URL the browser opens the rig at: 127.0.0.1 unless `--public` names a loopback or `*.localhost` name (the rig never leaves this machine) */
export function publicUrlOf(flag, port) {
  if (!flag || flag === true) return `http://127.0.0.1:${port}`;
  const u = new URL(String(flag));
  if (u.protocol !== 'http:' || u.pathname !== '/' || !(u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname === '127.0.0.1')) throw new Error('--public is an http origin on localhost, a *.localhost name or 127.0.0.1: the rig is not for anything else.');
  return u.origin;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const theme = flags.theme && flags.theme !== true ? flags.theme : null;
  const port = Number(flags.port || 3401);
  // one folder per port, so (a), (b) and (c) can run side by side without replacing each other's repo
  const opts = { theme, dir: flags.dir && flags.dir !== true ? flags.dir : path.join(os.tmpdir(), `cornfield-big-${theme || 'default'}-${port}`), repo: flags.repo && flags.repo !== true ? flags.repo : null, from: flags.from && flags.from !== true ? flags.from : null, seed: flags.seed ? Number(flags.seed) : undefined, layers: !!flags.layers, env: { CORNFIELD_PORT: String(port) } };
  const { repo, made, config, data } = await prepare(opts);
  let world = null;
  // loopback only, whatever CORNFIELD_HOST or the config says: this is a review rig, never something to deploy
  let serverConfig = { ...config, host: '127.0.0.1', port };
  let env = rigEnv();
  if (flags.forge) {
    const forgePort = flags['forge-port'] && flags['forge-port'] !== true ? Number(flags['forge-port']) : port + 100;
    world = await startForgeWorld({ repoFiles: readRepoFiles(repo), slugs: made.proposals, port: forgePort, runner: ['offline', 'none'].includes(flags.runner) ? flags.runner : 'online', dataDir: data });
    serverConfig = { ...serverConfig, agents: { ...serverConfig.agents, maxOpen: 10, transport: 'pull', ...(flags.trigger ? { profiles: ['claude'], on: { 'spec.approved': { kind: 'code', profile: 'claude' } } } : {}) }, forge: { type: 'github', url: world.forge.url, repo: REPO }, ...(flags.lands ? { approveLands: true } : {}), publicUrl: publicUrlOf(flags.public, port) };
    env = { ...env, ...SIGN_IN_ENV };
  }
  // Sibling origins that may read and decide a review (docs/embedding.md): exact origins, checked as the config checks them
  if (flags.embed && flags.embed !== true) {
    const origins = String(flags.embed).split(',').map((o) => embedOrigin(o.trim()));
    const bad = origins.find((o) => 'problem' in o);
    if (bad) throw new Error(`--embed: ${/** @type {{ problem: string }} */ (bad).problem}`);
    serverConfig = { ...serverConfig, embed: { origins: origins.map((o) => /** @type {{ origin: string }} */ (o).origin) } };
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
