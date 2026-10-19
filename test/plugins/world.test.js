/**
 * @vitest-environment node
 *
 * The world deriver (plugins/world): the machines of stacks/world.json and the `runs-on` edges to them,
 * hostnames only, and the tailnet evidence the cloud deriver reads from them.
 */
import { describe, it, expect } from 'vitest';
import compose from '../../plugins/compose/index.js';
import cloud from '../../plugins/cloud/index.js';
import world from '../../plugins/world/index.js';
import { checkDeriver, runDeriver, runProblems } from '../../core/deriver-kit.js';
import { deriveTopology } from '../../core/derive.js';
import { planSync } from '../../core/sync.js';
import { DEFAULTS, loadConfig, loadDerivers } from '../../core/config.js';
import { SAMPLE, loadSample } from '../helpers.js';

const STACK = 'services:\n  web:\n    image: nginx:1\n    ports:\n      - 192.168.1.5:8080:80\n    volumes:\n      - /home/someone/data:/data\n    environment:\n      - SECRET=do-not-read-me\n';
const WORLD = { version: 1, hosts: { 'server-1': { tailnet: true }, 'engine-1': { virtual: true, on: 'server-1' } }, runs: { 'stacks/app': 'engine-1' } };
const files = (extra = {}, w = WORLD) => ({ 'package.json': { name: 'lab' }, 'stacks/app/compose.yml': STACK, 'stacks/world.json': w, ...extra });
const edgeRows = (edges) => edges.map((e) => `${e.from} -> ${e.to}${e.kind ? ` (${e.kind}: ${e.label})` : ''}`);

describe('the world file', () => {
  it('makes a machine per host, a virtual machine on its host, and the stack on its machine', async () => {
    const run = await checkDeriver(world, { files: files(), before: ['starter', 'compose'] });
    expect(run.nodes).toEqual([
      { id: 'machine-server-1', label: 'server-1', type: 'machine', file: 'stacks/world.json', hostname: 'server-1' },
      { id: 'machine-engine-1', label: 'engine-1', type: 'machine', file: 'stacks/world.json', hostname: 'engine-1', virtual: true, code: ['stacks/app'] },
    ]);
    expect(edgeRows(run.edges)).toEqual([
      'root -> machine-server-1', 'root -> machine-engine-1',
      'machine-engine-1 -> machine-server-1 (runs-on: a virtual machine on server-1)',
      'stack-app -> machine-engine-1 (runs-on: runs on engine-1)',
    ]);
    expect(run.info.machines).toEqual([
      { id: 'machine-server-1', hostname: 'server-1', virtual: false, tailnet: true, file: 'stacks/world.json' },
      { id: 'machine-engine-1', hostname: 'engine-1', virtual: true, tailnet: false, file: 'stacks/world.json' },
    ]);
  });

  it('puts a package on a machine too, and reads the file and parent the options name', async () => {
    const run = await checkDeriver(world, {
      files: { 'package.json': { name: 'lab', workspaces: ['packages/*'] }, 'packages/api/package.json': { name: 'api' }, 'lab.json': { version: 1, hosts: { nas: {} }, runs: { './packages/api/': 'nas' } } },
      before: ['starter'], options: { file: 'lab.json', parent: 'pkg-api' },
    });
    expect(run.nodes.map((n) => [n.id, n.code])).toEqual([['machine-nas', ['packages/api']]]);
    expect(edgeRows(run.edges)).toEqual(['pkg-api -> machine-nas', 'pkg-api -> machine-nas (runs-on: runs on nas)']);
  });

  it('makes nothing without the file', async () => {
    const run = await runDeriver(world, { files: { 'README.md': 'nothing' } });
    expect(run.nodes).toEqual([]);
    expect(run.edges).toEqual([]);
    expect(run.info).toEqual({ machines: [] });
  });

  it('is a problem, not a guess, when a folder is neither a stack nor a package', async () => {
    const run = await runDeriver(world, { files: files({ 'stacks/world.json': { ...WORLD, runs: { 'stacks/gone': 'engine-1' } } }), before: ['starter', 'compose'] });
    expect(runProblems(run).join('\n')).toMatch(/runs "stacks\/gone" on engine-1, but no stack or package is in that folder/);
  });

  it('is not one of the default derivers: a repo opts in', () => {
    expect(DEFAULTS.derivers).not.toContain('world');
  });
});

describe('what the file may hold', () => {
  const fails = async (w, message) => {
    await expect(runDeriver(world, { files: { 'stacks/world.json': w } })).rejects.toThrow(message);
  };

  it('refuses an address as a hostname, an IPv4, an IPv6 or a MAC', async () => {
    await fails({ version: 1, hosts: { '192.168.1.5': {} } }, /"192.168.1.5" is not a hostname/);
    await fails({ version: 1, hosts: { '::1': {} } }, /"::1" is not a hostname/);
    await fails({ version: 1, hosts: { 'fe80::1ff:fe23:4567:890a': {} } }, /is not a hostname/);
    await fails({ version: 1, hosts: { '00:1a:2b:3c:4d:5e': {} } }, /is not a hostname/);
  });

  it('refuses a key that could hold an address, a MAC, a folder or a secret, and says only its name', async () => {
    for (const key of ['ip', 'address', 'mac', 'dataDir', 'env']) {
      await expect(runDeriver(world, { files: { 'stacks/world.json': { version: 1, hosts: { 'server-1': { [key]: 'do-not-read-me' } } } } })).rejects.toThrow(new RegExp(`has a key "${key}": a host has only virtual, tailnet, on, never an address or a folder`));
    }
    await expect(runDeriver(world, { files: { 'stacks/world.json': { version: 1, hosts: { a: {} }, ip: '10.0.0.1' } } })).rejects.not.toThrow(/10\.0\.0\.1/);
  });

  it('refuses a folder that leaves the repo, and a host that is not listed', async () => {
    await fails({ version: 1, hosts: { a: {} }, runs: { '../elsewhere': 'a' } }, /"..\/elsewhere" is not a folder of the repo/);
    await fails({ version: 1, hosts: { a: {} }, runs: { '/home/someone/stack': 'a' } }, /is not a folder of the repo/);
    await fails({ version: 1, hosts: { a: {} }, runs: { stack: 'b' } }, /runs on a host that is not in "hosts"/);
  });

  it('wants a virtual machine to name its host, and no loop of hosts', async () => {
    await fails({ version: 1, hosts: { vm: { virtual: true } } }, /is virtual and needs "on"/);
    await fails({ version: 1, hosts: { a: { on: 'b' }, b: {} } }, /has "on" and is not virtual/);
    await fails({ version: 1, hosts: { vm: { virtual: true, on: 'nope' } } }, /runs on "nope", which is not in "hosts"/);
    await fails({ version: 1, hosts: { a: { virtual: true, on: 'b' }, b: { virtual: true, on: 'a' } } }, /runs on itself through/);
  });

  it('refuses the wrong version, unknown file keys, no hosts and broken JSON', async () => {
    await fails({ version: 2, hosts: { a: {} } }, /version must be 1/);
    await fails({ version: 1, hosts: { a: {} }, addresses: {} }, /unknown key "addresses"/);
    await fails({ version: 1 }, /"hosts" must list at least one machine/);
    await fails('{ nope', /stacks\/world.json is not valid JSON/);
  });
});

describe('privacy', () => {
  it('lets no address, MAC, host folder or environment value reach the map', async () => {
    const run = await checkDeriver(cloud, {
      files: files({ 'topology.cloud.json': { version: 1, services: [{ id: 'tailscale', label: 'Tailscale', roles: ['runtime'], desc: 'The tailnet.', breaks: 'Now: no remote access.', plan: { tier: 'free' }, match: { tailnet: true, registries: ['docker.io/'] } }] } }),
      before: ['starter', 'compose', world], config: { cloud: { parent: 'root' } },
    });
    const everything = JSON.stringify([run.derived, run.topology, run.changes]);
    expect(everything).toContain('machine-server-1');
    expect(everything).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    expect(everything).not.toMatch(/(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/i);
    expect(everything).not.toContain('/home/someone');
    expect(everything).not.toContain('do-not-read-me');
  });
});

describe('the tailnet detector of the cloud deriver', () => {
  const entry = { id: 'tailscale', label: 'Tailscale', roles: ['runtime', 'account'], desc: 'The tailnet every machine joins.', breaks: 'Now: no remote access.', plan: { tier: 'free' }, match: { tailnet: true, registries: ['docker.io/'] } };
  const registry = { 'topology.cloud.json': { version: 1, services: [entry] } };

  it('draws a calls edge from each machine that joined the tailnet to the entry that claims it', async () => {
    const run = await checkDeriver(cloud, { files: files(registry), before: ['starter', 'compose', world] });
    expect(run.result.evidence.filter((e) => e.match.kind === 'tailnet')).toEqual([{ match: { kind: 'tailnet', value: 'server-1' }, from: 'machine-server-1', label: 'joins the tailnet', file: 'stacks/world.json' }]);
    expect(edgeRows(run.edges.filter((e) => e.kind === 'calls' && e.from.startsWith('machine-'))).join()).toBe('machine-server-1 -> ext-tailscale (calls: joins the tailnet)');
  });

  it('wants an entry to claim the tailnet, like any other evidence', async () => {
    const err = await checkDeriver(cloud, { files: files({ 'topology.cloud.json': { version: 1, services: [{ ...entry, match: { hosts: ['api.tailscale.com'], registries: ['docker.io/'] }, uses: [{ from: 'machine-server-1', label: 'joins', why: 'Set up on the machine' }] }] } }), before: ['starter', 'compose', world] }).catch((e) => e);
    expect(err.message).toMatch(/reaches tailnet "server-1"; no entry in topology.cloud.json matches it/);
  });

  it('reads nothing without the world deriver, and says an entry matched only by the tailnet waits', async () => {
    const only = { 'package.json': { name: 'lab' }, 'topology.cloud.json': { version: 1, services: [{ ...entry, match: { tailnet: true } }] } };
    const run = await runDeriver(cloud, { files: only, before: ['starter'] });
    expect(run.result.evidence.filter((e) => e.match.kind === 'tailnet')).toEqual([]);
    expect(run.warnings.join()).toMatch(/matched only by evidence no detector reads yet \(.*tailnet.*\)/);
  });
});

describe('the sample repo', () => {
  it('gets its machines and their runs-on edges from stacks/world.json, and its map matches', async () => {
    const config = await loadConfig(SAMPLE, { env: {} });
    const committed = loadSample();
    const derived = await deriveTopology({ root: SAMPLE, config, derivers: await loadDerivers(config), map: committed });
    expect(derived.nodes.filter((n) => n.type === 'machine').map((n) => n.id)).toEqual(['machine-server-1', 'machine-engine-1']);
    expect(planSync(committed, derived).changes).toEqual([]);
    const edges = committed.edges.map((e) => `${e.from}|${e.to}|${e.kind}`);
    expect(edges).toContain('stack-app-stack|machine-engine-1|runs-on');
    expect(edges).toContain('machine-engine-1|machine-server-1|runs-on');
    expect(edges).toContain('machine-server-1|ext-tailscale|calls');
  });
});
