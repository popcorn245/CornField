# Derivers (contract 1)

A deriver reads a repo's code and says which nodes and edges the map must hold. `cornfield sync` runs every deriver the config names, in order, and merges what they find into `topology.json`; `cornfield validate` runs them again and fails when the map has drifted. cornfield ships seven: `starter`, `personas`, `compose`, `world`, `openapi`, `cloud` and `docs`. A repo adds its own by path, and tests it with the deriver kit (`cornfield/deriver-kit`, see [deriver-kit.md](deriver-kit.md)).

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
| `read(rel)`, `exists(rel)`, `isDir(rel)`, `list(rel)`, `walk(rel, test)`, `inside(rel)` | readers rooted at the repo, forward-slash paths, text read as LF. Every reader judges a path by its real path, symlinks followed, and refuses one that is outside the repo (`..`, an absolute path, a symlink out, a file reached through one): `read` throws, `exists` and `isDir` say no, `list` is empty, so a deriver cannot read outside whatever it is told. A reader keeps what it found of each folder for its life, so make one per run. `walk` skips `node_modules`, `.git` and the like, does not follow a symlink that leads outside the repo or to nothing, and reads a real folder once (a link to a folder it reaches anyway by its own name is left to that folder), in silence unless given `onSkip(rel, reason)`; `inside(rel)` says whether a path is in the repo once its symlinks are followed |
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

- **starter** (`plugins/starter`): packages from npm workspaces, Go modules (`go.work`, else each `go.mod`), Rust crates (a Cargo workspace's `members`, else each `Cargo.toml` with a `[package]`) and Python packages (a uv workspace's `members`, else each `pyproject.toml`, `setup.py` or `setup.cfg`); with none of these, each top-level folder with code; or `options.packages`. Then the imports between them (JavaScript `import`/`require`, Python `import`/`from … import`, Go import paths under a module's path, Rust `use` and `crate::` paths) and a dependency a manifest declares and no file imports; with `modules: true`, one node per source file with the first sentence of its doc comment (or docstring, `// Package` comment, `//!` lines) as its summary. Language build and environment folders (`target`, `.venv`, `__pycache__`, `vendor`) are skipped. Options: `{ packages, modules, tests, extensions }`. Its walks are the repo's own (a symlink that leaves the repo, or loops, is not followed), and a `packages` entry that leaves the repo is refused: see [a path in config](#a-path-in-config-that-leaves-the-repo).
- **personas** (`plugins/personas`): `topology.personas.json` as a store node and one persona node each. Roles come from `personas.roles` in the config (any kebab-case role when none). See [core/personas.js](../core/personas.js).
- **compose** (`plugins/compose`): a stack per Docker compose file (`compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml`, the first of them in each folder) and a container per service, with its image, its ports (never the host address they bind to) and the container paths of its volumes; environment values are never read. Every `Caddyfile` (and `*.caddyfile`) and every service's Traefik labels (`traefik.http.routers.<r>.rule` with `Host(...)`) give an app per routed host and a `runs-on` edge app → stack with the host → upstream → service mappings; a route to anything that is not a compose service is left out with a warning. An app already on the map for that host keeps its id. Whether a container is a self-hosted outside system (`selfHosted`, `summary`) stays hand-written. List it before `cloud`, which reads the containers' images. Needs the optional dependency js-yaml. Options: `{ files, caddyfiles, parent }` (a path that leaves the repo is refused, see [below](#a-path-in-config-that-leaves-the-repo)); `info.compose.stacks` lists each stack's id, folder and file.
- **world** (`plugins/world`): the machines of a world file, `stacks/world.json`: `{ "version": 1, "hosts": { "server-1": { "tailnet": true }, "engine-1": { "virtual": true, "on": "server-1" } }, "runs": { "stacks/app-stack": "engine-1" } }`. A machine node per host (hostnames only: a host with an address, a MAC, a folder or any key beyond `virtual`, `on` and `tailnet` fails the sync, and the file never reaches the map beyond hostnames), a `runs-on` edge from the stack or package in each `runs` folder to its machine, and one from a virtual machine to its host. A folder that is neither a stack nor a package is a `validate` problem. A machine's description stays hand-written. A host with `tailnet: true` is evidence for the tailnet detector of the cloud deriver: a registry entry with `"tailnet": true` in its `match` claims it, and each such machine gets a `calls` edge to it. It is not in the default derivers, and is its own deriver rather than part of `compose` so that a repo already using `compose` gets no machines it did not ask for; list it after `compose` (and `starter`) and before `cloud`. Options: `{ file, parent }` (`file` stays in the repo, see [below](#a-path-in-config-that-leaves-the-repo)); `info.world.machines` lists each machine's id, hostname, virtual and tailnet.
- **openapi** (`plugins/openapi`): an API's endpoints from its OpenAPI 3.x or Swagger 2.0 file (JSON, or YAML with the optional js-yaml), or an OpenCollection: one page node per path, labelled with the path under the API's base (`servers[0]`, `basePath` or `prefix`), with its `methods`, under the API's app (`app-api` unless `app` names another). The app is another deriver's or the map's when it is there; else this deriver makes it from the spec's title. The app's pages are the spec's: an endpoint gone from the file leaves the map. With no options it reads the one `openapi.*`, `swagger.*`, `*.openapi.*` or `opencollection.*` file of the repo. Options: `{ file, app, prefix }`, or `{ specs: [{ file, app, prefix }] }` for several APIs (each `file` stays in the repo, see [below](#a-path-in-config-that-leaves-the-repo)).
- **cloud** (`plugins/cloud`): `topology.cloud.json` and its detectors. See [cloud.md](cloud.md).
- **docs** (`plugins/docs`): the repo's Markdown as an app (`app-docs`) with a page per document, a usage link per link between two docs, and one from a doc to each file another deriver mapped that it links to (a module, a package), so the map shows which docs describe which code. A link to a file that is not in the repo fails `validate`; a link to a missing heading is a warning. Options: `{ paths, app, label, parent }` (`paths` default `['README.md', 'docs']`). List it after the derivers whose nodes the docs point at. `cornfield docs` builds the docs as a static site from this map: see [the docs site](#the-docs-site).

### A path in config that leaves the repo

A deriver reads only the repo. A file or folder an option names (`compose` `files` and `caddyfiles`, `starter` `packages`, `cloud` `code` and `caddyfiles`, `openapi` `file` and `specs[].file`, `world` `file`, `docs` `paths`) that is absolute, climbs out with `..`, or reaches outside through a symlink is not read, and is a problem that fails `validate`: `compose: "../x/Caddyfile" is outside the repo; only files and folders of the repo are read.` The message gives the path as written in the config, as a JSON string; it never says where the path leads or what is there. A symlink that stays inside the repo works. A deriver of your own gets the same from the readers above, and can refuse a config path the same way with `leavesRepo(ctx, path)` and `outsideProblem('name', path)` from `core/repo.js`. A node's `file` that is reached through a symlink that stays in the repo (`docs/team/y.md`, with `docs/team` linking to `shared`) is in the repo for `validate`; one a link takes out of it is not, and without a symlink on its way a node's `file` must be one of the repo's own paths, written as they are (no `./`, trailing `/` or `.`). The same holds for the files `validate` reads itself: a `topology.cloud.json` or `topology.personas.json` that links out of the repo is as if it were not there, a proposal file or a mockup beside it that links out is reported the way an unreadable one is (`docs/specs/proposals/a.json is not valid JSON: "docs/specs/proposals/a.json" is outside the repo.`, never a line of what it holds), and a map (`topology.json`) or a `package.json` that links out is not read (`sync`, `validate` and `status` stop with `"topology.json" is outside the repo.`). `sync` writes the map only where it really lies in the repo: never through a link out of it or a link to nothing. A file the readers are asked to read that is neither a file nor a folder (a FIFO, a device) is not read: `read` throws `"x" is not a file.` rather than wait on it.

A file option (`compose` `files` and `caddyfiles`, `openapi` `file` and `specs[].file`, `world` `file`, `cloud` `caddyfiles[].file`) that names a folder (`''`, `.`, `src/`) is a problem that fails `validate`, naming the deriver, the option and the value: `compose: options.caddyfiles "src/" is a folder, not a file.` `sync` goes on without it. A list that names one place twice (`a`, `./a`, `a/`; `''` and `.` for the repo itself) reads it once, the first spelling kept: `starter` `packages`, `compose` `files` and `caddyfiles` (`eachPlaceOnce` in `core/repo.js`). A path a message prints from the config goes through `quote` in `core/text.js`: a JSON string, with a line break, an escape character and the invisible and bidirectional marks written as escapes, so it cannot forge a line of output. Use it in a deriver of your own.

## The docs site

`cornfield docs [--out _site]` runs the derivers (the docs deriver with its defaults when the config does not name it) and writes a small static site: a page per document at its route (`docs/config.md` → `docs/config.html`, a README → its folder's `index.html`), a sidebar of every page, the links around each page (what it links to, what links to it, the code it describes), and `map.html`, the map of the docs' links. Links between docs go to the other page, images are copied beside it, and a link to any other file goes to the file on the forge (`forge` in the config). Every link is relative, so the folder serves from anywhere. Links, emphasis, lists and quotes nested more than 16 deep inside one another are shown as the text written. A table row with fewer cells than its header is padded with empty cells, at most 65,536 of them in a document; a row that would pass that keeps only the cells it has. cornfield's own docs are built this way and published to GitHub Pages by `.github/workflows/pages.yml`.

The build reads only the repo and writes only the output folder, judged on real paths, after symlinks are followed. A `paths` entry that leaves the repo (`..`, an absolute path, a symlink to somewhere else) is a problem: `validate` fails on it, and nothing under it is read. In a folder, a symlink that leads outside the repo (a doc, a folder) or to nothing is not followed, and a link to a folder already read is not read again; each is a warning, named as the path is written in the repo. A link or an image whose target leads outside is a warning too, and the image is not copied. A symlink that stays inside the repo works. A doc whose page would land on a file the site writes itself (`map.md` → `map.html`) or on another doc's page (`index.md` beside a README, which keeps `index.html`) is written to the next free `-doc` name (`map-doc.html`), with a warning, and every link to it follows. The warnings and problems are printed by `validate` and `cornfield docs` (`sync` prints the warnings); no message prints what an outside file holds or where a link out leads.

## Testing one

`import { defineDeriver, checkDeriver } from 'cornfield/deriver-kit'`: `defineDeriver` checks a deriver against this contract when it loads and types it for the editor; `checkDeriver(deriver, { files, before, options })` runs it on a throwaway repo as `sync` and `validate` would, and throws a list of everything `validate` would fail on. The guide: [deriver-kit.md](deriver-kit.md).

## Versions

The contract number changes only when an existing deriver would break. cornfield refuses a deriver written for another contract and says which one it speaks.
