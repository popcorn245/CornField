/**
 * @module plugins/world
 *
 * The world deriver: which machine each stack runs on. It reads a world file, `stacks/world.json` (or
 * `options.file`), and makes the machines of the repo's home lab: hostnames only, never an address.
 *
 *   {
 *     "version": 1,
 *     "hosts": { "server-1": { "tailnet": true }, "engine-1": { "virtual": true, "on": "server-1" } },
 *     "runs": { "stacks/app-stack": "engine-1" }
 *   }
 *
 *  - **hosts.** A machine per key, named by its hostname. `virtual: true` with `on` (another host) is a
 *    virtual machine on that host; `tailnet: true` says the machine has joined the tailnet. Nothing else is
 *    allowed on a host: a key that could hold an address, a MAC, a folder or a secret fails with its name.
 *  - **runs.** The repo folder of a stack (the folder of its compose file) or of a package, and the host it
 *    runs on. A folder that is neither is a problem, so the file cannot drift from the code.
 *
 * What it makes:
 *
 *   machine-<hostname>        a machine: label and hostname the host's name, file the world file, virtual,
 *                             code (the folders that run on it). A hand-written description stays.
 *   stack → machine           `runs-on`, "runs on <host>" (package → machine the same)
 *   machine → host            `runs-on`, "a virtual machine on <host>"
 *
 * Without the world file it makes nothing. `info.world.machines` lists each machine's id, hostname, virtual
 * and tailnet, for the tailnet detector of the cloud deriver.
 *
 * List it after `compose` (the stacks) and `starter` (the packages) and before `cloud`. It is not in the
 * default derivers: a repo that names it adds machines to its map.
 *
 * Options: `{ file?: string, parent?: string }` (`parent`: the node machines hang from, default `root`).
 */

import { slug } from '../compose/index.js';

export const WORLD_FILE = 'stacks/world.json';
const FILE_KEYS = ['version', 'hosts', 'runs'];
const HOST_KEYS = ['virtual', 'tailnet', 'on'];
/** A hostname: letters, digits and dashes, in dot-separated labels (so never an IPv6 address or a MAC) */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;
/** Four numbers with dots is an address, however it passes for a hostname */
const IPV4 = /^\d+(?:\.\d+){3}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const hostnameProblem = (name) => (!HOSTNAME.test(name) || IPV4.test(name) ? `${JSON.stringify(name)} is not a hostname (letters, digits and dashes; never an address).` : null);
const machineId = (host) => `machine-${slug(host)}`;

/** A repo folder as written in `runs`: no leading `./` or trailing slash, `` for the root (`.`); null when it leaves the repo */
function folderOf(key) {
  const dir = key.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (dir === '.' || dir === '') return '';
  return /^[\w@.-]+(?:\/[\w@.-]+)*$/.test(dir) && !dir.split('/').some((p) => p === '..' || p === '.') ? dir : null;
}

const world = {
  name: 'world',
  contract: 1,
  owns: ['machine'],

  derive(ctx) {
    const options = ctx.options || {};
    const file = options.file || WORLD_FILE;
    const parent = options.parent || 'root';
    if (!ctx.exists(file)) return { nodes: [], edges: [], warnings: [], problems: [], info: { machines: [] } };

    let doc;
    try { doc = JSON.parse(ctx.read(file)); } catch (err) { throw new Error(`${file} is not valid JSON: ${err.message}`); }
    if (!isObject(doc)) throw new Error(`${file} must be an object like { "version": 1, "hosts": {…}, "runs": {…} }.`);

    // 1. The file itself: anything that could carry an address, a folder or a secret fails with the key's name
    const bad = [];
    if (doc.version !== 1) bad.push(`version must be 1 (got ${JSON.stringify(doc.version)}).`);
    for (const key of Object.keys(doc)) if (!FILE_KEYS.includes(key)) bad.push(`unknown key ${JSON.stringify(key)}: the file has ${FILE_KEYS.join(', ')}.`);
    const hosts = isObject(doc.hosts) ? doc.hosts : {};
    const runs = isObject(doc.runs) ? doc.runs : {};
    if (!Object.keys(hosts).length) bad.push('"hosts" must list at least one machine, like { "server-1": {} }.');
    if (doc.runs !== undefined && !isObject(doc.runs)) bad.push('"runs" must map a folder to a host, like { "stacks/app": "server-1" }.');

    const ids = new Map();
    for (const [name, def] of Object.entries(hosts)) {
      const problem = hostnameProblem(name);
      if (problem) { bad.push(`hosts: ${problem}`); continue; }
      if (ids.has(machineId(name))) { bad.push(`hosts: ${JSON.stringify(name)} and ${JSON.stringify(ids.get(machineId(name)))} are the same machine (${machineId(name)}).`); continue; }
      ids.set(machineId(name), name);
      if (!isObject(def)) { bad.push(`hosts ${JSON.stringify(name)} must be an object (use {} for a plain machine).`); continue; }
      for (const key of Object.keys(def)) if (!HOST_KEYS.includes(key)) bad.push(`hosts ${JSON.stringify(name)} has a key ${JSON.stringify(key)}: a host has only ${HOST_KEYS.join(', ')}, never an address or a folder.`);
      for (const key of ['virtual', 'tailnet']) if (def[key] !== undefined && typeof def[key] !== 'boolean') bad.push(`hosts ${JSON.stringify(name)}: "${key}" is true or false.`);
      if (def.virtual === true && typeof def.on !== 'string') bad.push(`hosts ${JSON.stringify(name)} is virtual and needs "on": the host it runs on.`);
      if (def.virtual !== true && def.on !== undefined) bad.push(`hosts ${JSON.stringify(name)} has "on" and is not virtual.`);
      if (typeof def.on === 'string' && !has(hosts, def.on)) bad.push(`hosts ${JSON.stringify(name)} runs on ${JSON.stringify(def.on)}, which is not in "hosts".`);
    }
    for (const name of Object.keys(hosts)) {
      const seen = new Set([name]);
      for (let at = isObject(hosts[name]) ? hosts[name].on : null; typeof at === 'string' && isObject(hosts[at]); at = hosts[at].on) {
        if (seen.has(at)) { bad.push(`hosts ${JSON.stringify(name)} runs on itself through ${JSON.stringify(at)}.`); break; }
        seen.add(at);
      }
    }
    for (const [dir, host] of Object.entries(runs)) {
      if (folderOf(dir) === null) bad.push(`runs: ${JSON.stringify(dir)} is not a folder of the repo.`);
      if (typeof host !== 'string' || !has(hosts, host)) bad.push(`runs: ${JSON.stringify(dir)} runs on a host that is not in "hosts".`);
    }
    if (bad.length) throw new Error(`${file}: ${bad.join(' ')}`);

    // 2. What can run on a machine: the stacks compose found, the packages already on the map
    const targets = new Map();
    for (const s of (ctx.info.compose && ctx.info.compose.stacks) || []) targets.set(s.dir, s.id);
    for (const n of ctx.nodes) if (n.type === 'pkg' && typeof n.file === 'string') targets.set(n.file.replace(/\/+$/, ''), n.id);

    const problems = [];
    const code = new Map(Object.keys(hosts).map((h) => [h, []]));
    const runsOn = [];
    for (const [key, host] of Object.entries(runs)) {
      const dir = folderOf(key);
      if (!targets.has(dir)) { problems.push(`world: ${file} runs "${key}" on ${host}, but no stack or package is in that folder (list compose and starter before world).`); continue; }
      code.get(host).push(dir || '.');
      runsOn.push({ from: targets.get(dir), to: machineId(host), kind: 'runs-on', label: `runs on ${host}` });
    }

    // 3. The machines, and where each hangs
    const nodes = [];
    const edges = [];
    for (const [name, def] of Object.entries(hosts)) {
      const here = code.get(name).sort();
      nodes.push({ id: machineId(name), label: name, type: 'machine', file, hostname: name, ...(def.virtual ? { virtual: true } : {}), ...(here.length ? { code: here } : {}) });
      edges.push({ from: parent, to: machineId(name) });
    }
    for (const [name, def] of Object.entries(hosts)) {
      if (def.virtual) edges.push({ from: machineId(name), to: machineId(def.on), kind: 'runs-on', label: `a virtual machine on ${def.on}` });
    }

    return {
      nodes, edges: [...edges, ...runsOn], warnings: [], problems,
      info: { machines: Object.entries(hosts).map(([name, def]) => ({ id: machineId(name), hostname: name, virtual: def.virtual === true, tailnet: def.tailnet === true, file })) },
    };
  },
};

export default world;
