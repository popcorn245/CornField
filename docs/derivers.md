# Derivers (contract 1)

A deriver reads a repo's code and says which nodes and edges the map must hold. `cornfield sync` runs every deriver the config names, in order, and merges what they find into `topology.json`; `cornfield validate` runs them again and fails when the map has drifted. cornfield ships four: `starter`, `personas`, `compose` and `cloud`. A repo adds its own by path.

```js
// cornfield.config.js
export default {
  derivers: [
    'starter',
    { use: './tools/cornfield/routes.js', options: { app: 'app-api' } },
    'personas',
    'compose', // the stacks, containers and routed apps of the compose files
    'cloud', // last: it reads what the others made
  ],
};
```

## The shape

```js
// tools/cornfield/routes.js
export default {
  name: 'routes',          // shown in messages
  contract: 1,             // the contract it was written for (core/derive.js DERIVER_CONTRACT)
  owns: ['page'],          // types it derives every node of: sync removes any other node of them
  derive(ctx) {            // may be async
    const pages = ctx.walk('apps/api/routes', (f) => f.endsWith('.js'));
    return {
      nodes: pages.map((f) => ({ id: `page-${f}`, type: 'page', label: '/' + f, file: f })),
      edges: pages.map((f) => ({ from: ctx.options.app, to: `page-${f}` })),
      warnings: [],        // printed by sync and status, never fatal
      problems: [],        // fail validate
      ownedIds: [],        // single nodes it owns even though their type is not in `owns`
      pageOwners: [],      // apps whose pages it reads: sync removes their other pages
      evidence: [],        // outside services the code reaches, for the cloud registry
      info: {},            // anything, handed to later derivers as ctx.info.routes
    };
  },
  validate(ctx, topology) { return []; }, // optional: more checks on the committed map
};
```

## What `ctx` holds

| Field | What it is |
|---|---|
| `root` | the repo's folder |
| `read(rel)`, `exists(rel)`, `isDir(rel)`, `list(rel)`, `walk(rel, test)` | readers rooted at the repo, forward-slash paths, text read as LF; `walk` skips `node_modules`, `.git` and the like |
| `config` | the whole loaded config |
| `options` | this deriver's own options |
| `nodes`, `edges` | what the derivers before it made (read-only) |
| `evidence`, `info` | the evidence and the `info` of the derivers before it |
| `map` | the committed `topology.json` (`{ nodes, edges }`, empty before the first sync): its hand-written nodes can be pointed at |

## The rules sync applies

- A node is the derivers' when its type is in some deriver's `owns`, or its id is in an `ownedIds`, or it is a page under an app in a `pageOwners`. Such a node that no deriver makes any more is removed; its fields in [`DERIVED_FIELDS`](../core/sync.js) are kept equal to the code; everything else on it (a hand-written description, a render note) stays.
- An edge is the derivers' when its category (an ownership edge, a usage link, `reads`, a `flow` of one kind…) is one some deriver emits and it touches what they derive: an ownership edge whose child is derived, a usage link (dashed) between two derived nodes, any other kind with an end that is a node of the deriver emitting that kind, at the end (`from` or `to`) and of the type where that deriver puts its own nodes in such edges. So the cloud deriver, whose `calls` go into its externals, speaks for every `calls` into an external, and not for a hand-written `calls` into a container; the compose deriver, whose `runs-on` go from its apps into its stacks, does not speak for a hand-written `runs-on` from a stack to a machine. An edge a deriver makes exactly is always its own. Anything else is hand-written and stays until an end is gone.
- Two derivers may not make the same node id.
- A deriver that no longer recognises the code it reads should throw with a clear message rather than guess: `sync` and `validate` name the deriver that failed.

## The built-in derivers

- **starter** (`plugins/starter`): packages from npm workspaces (or each top-level folder with code, or `options.packages`), the imports between them, a dependency declared and never imported; with `modules: true`, one node per source file with the first sentence of its doc comment as its summary. Options: `{ packages, modules, tests, extensions }`.
- **personas** (`plugins/personas`): `topology.personas.json` as a store node and one persona node each. Roles come from `personas.roles` in the config (any kebab-case role when none). See [core/personas.js](../core/personas.js).
- **compose** (`plugins/compose`): a stack per Docker compose file (`compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml`, the first of them in each folder) and a container per service, with its image, its ports (never the host address they bind to) and the container paths of its volumes; environment values are never read. Every `Caddyfile` (and `*.caddyfile`) and every service's Traefik labels (`traefik.http.routers.<r>.rule` with `Host(...)`) give an app per routed host and a `runs-on` edge app → stack with the host → upstream → service mappings; a route to anything that is not a compose service is left out with a warning. An app already on the map for that host keeps its id. Whether a container is a self-hosted outside system (`selfHosted`, `summary`) stays hand-written. List it before `cloud`, which reads the containers' images. Needs the optional dependency js-yaml. Options: `{ files, caddyfiles, parent }`; `info.compose.stacks` lists each stack's id, folder and file.
- **cloud** (`plugins/cloud`): `topology.cloud.json` and its detectors. See [cloud.md](cloud.md).

## Versions

The contract number changes only when an existing deriver would break. cornfield refuses a deriver written for another contract and says which one it speaks.
