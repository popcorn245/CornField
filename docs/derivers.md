# Derivers (contract 1)

A deriver reads a repo's code and says which nodes and edges the map must hold. `cornfield sync` runs every deriver the config names, in order, and merges what they find into `topology.json`; `cornfield validate` runs them again and fails when the map has drifted. cornfield ships six: `starter`, `personas`, `compose`, `openapi`, `cloud` and `docs`. A repo adds its own by path, and tests it with the deriver kit (`cornfield/deriver-kit`, see [deriver-kit.md](deriver-kit.md)).

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

- **starter** (`plugins/starter`): packages from npm workspaces, Go modules (`go.work`, else each `go.mod`), Rust crates (a Cargo workspace's `members`, else each `Cargo.toml` with a `[package]`) and Python packages (a uv workspace's `members`, else each `pyproject.toml`, `setup.py` or `setup.cfg`); with none of these, each top-level folder with code; or `options.packages`. Then the imports between them (JavaScript `import`/`require`, Python `import`/`from … import`, Go import paths under a module's path, Rust `use` and `crate::` paths) and a dependency a manifest declares and no file imports; with `modules: true`, one node per source file with the first sentence of its doc comment (or docstring, `// Package` comment, `//!` lines) as its summary. Language build and environment folders (`target`, `.venv`, `__pycache__`, `vendor`) are skipped. Options: `{ packages, modules, tests, extensions }`.
- **personas** (`plugins/personas`): `topology.personas.json` as a store node and one persona node each. Roles come from `personas.roles` in the config (any kebab-case role when none). See [core/personas.js](../core/personas.js).
- **compose** (`plugins/compose`): a stack per Docker compose file (`compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml`, the first of them in each folder) and a container per service, with its image, its ports (never the host address they bind to) and the container paths of its volumes; environment values are never read. Every `Caddyfile` (and `*.caddyfile`) and every service's Traefik labels (`traefik.http.routers.<r>.rule` with `Host(...)`) give an app per routed host and a `runs-on` edge app → stack with the host → upstream → service mappings; a route to anything that is not a compose service is left out with a warning. An app already on the map for that host keeps its id. Whether a container is a self-hosted outside system (`selfHosted`, `summary`) stays hand-written. List it before `cloud`, which reads the containers' images. Needs the optional dependency js-yaml. Options: `{ files, caddyfiles, parent }`; `info.compose.stacks` lists each stack's id, folder and file.
- **openapi** (`plugins/openapi`): an API's endpoints from its OpenAPI 3.x or Swagger 2.0 file (JSON, or YAML with the optional js-yaml), or an OpenCollection: one page node per path, labelled with the path under the API's base (`servers[0]`, `basePath` or `prefix`), with its `methods`, under the API's app (`app-api` unless `app` names another). The app is another deriver's or the map's when it is there; else this deriver makes it from the spec's title. The app's pages are the spec's: an endpoint gone from the file leaves the map. With no options it reads the one `openapi.*`, `swagger.*`, `*.openapi.*` or `opencollection.*` file of the repo. Options: `{ file, app, prefix }`, or `{ specs: [{ file, app, prefix }] }` for several APIs.
- **cloud** (`plugins/cloud`): `topology.cloud.json` and its detectors. See [cloud.md](cloud.md).
- **docs** (`plugins/docs`): the repo's Markdown as an app (`app-docs`) with a page per document, a usage link per link between two docs, and one from a doc to each file another deriver mapped that it links to (a module, a package), so the map shows which docs describe which code. A link to a file that is not in the repo fails `validate`; a link to a missing heading is a warning. Options: `{ paths, app, label, parent }` (`paths` default `['README.md', 'docs']`). List it after the derivers whose nodes the docs point at. `cornfield docs` builds the docs as a static site from this map: see [the docs site](#the-docs-site).

## The docs site

`cornfield docs [--out _site]` runs the derivers (the docs deriver with its defaults when the config does not name it) and writes a small static site: a page per document at its route (`docs/config.md` → `docs/config.html`, a README → its folder's `index.html`), a sidebar of every page, the links around each page (what it links to, what links to it, the code it describes), and `map.html`, the map of the docs' links. Links between docs go to the other page, images are copied beside it, and a link to any other file goes to the file on the forge (`forge` in the config). Every link is relative, so the folder serves from anywhere. cornfield's own docs are built this way and published to GitHub Pages by `.github/workflows/pages.yml`.

## Testing one

`import { defineDeriver, checkDeriver } from 'cornfield/deriver-kit'`: `defineDeriver` checks a deriver against this contract when it loads and types it for the editor; `checkDeriver(deriver, { files, before, options })` runs it on a throwaway repo as `sync` and `validate` would, and throws a list of everything `validate` would fail on. The guide: [deriver-kit.md](deriver-kit.md).

## Versions

The contract number changes only when an existing deriver would break. cornfield refuses a deriver written for another contract and says which one it speaks.
