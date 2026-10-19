# cornfield.config.js

One ES module in the repo's root that default-exports a plain object. Every key is optional; with no file at all cornfield maps the repo with the built-in derivers. If the repo's `package.json` is not `"type": "module"`, name it `cornfield.config.mjs` instead.

```js
export default {
  title: 'My repo',
  derivers: ['starter', 'personas', 'cloud'],
  sources: { live: null, house: null, devices: null, checker: null },
  forge: { type: 'github', url: 'https://github.com', repo: 'owner/name' },
  port: 3350,
  host: '127.0.0.1',
  publicUrl: null,
  worktrees: '.claude/worktrees',
  proposals: 'docs/specs/proposals',
  topology: 'topology.json',
  personas: { roles: ['admin', 'member'], parent: 'root' },
  cloud: { parent: 'root' },
  links: [{ label: 'Docs', href: 'https://example.org/docs' }],
  proxy: { '/api/': 'http://127.0.0.1:3245' },
  importMap: {},
  dataDir: null,
};
```

| Key | What it is |
|---|---|
| `title` | the explorer's title (default: the package name) |
| `derivers` | built-in names (`starter`, `personas`, `compose`, `cloud`, `docs`), paths (`./tools/deriver.js`), or `{ use, options }`; run in order. [derivers.md](derivers.md) |
| `sources` | browser modules for the live layer, the house, devices and the permission checker (below) |
| `forge` | `{ type: 'github' \| 'forgejo', url, repo: 'owner/name' }`: where issues, PRs and (v1) sign-in live |
| `port`, `host` | where `serve` listens. Until sign-in exists the host must be loopback |
| `publicUrl` | where people open it, once it is served for them (v1) |
| `worktrees` | a folder of git worktrees; each one's proposals are listed too, as drafts |
| `proposals` | where proposal files live, in the checkout and in each worktree |
| `topology` | the map file |
| `personas` | `roles`: the roles a persona may have (null: any kebab-case role); `parent`: the node the personas file hangs under |
| `cloud` | `parent`: the node the cloud file hangs under |
| `links` | extra links in the explorer's header |
| `proxy` | same-origin paths for a source's own API: `{ '/api/': 'http://127.0.0.1:3245' }` |
| `importMap` | bare imports a repo-local source module needs: `{ name: '/repo/path/to/module.js' }` |
| `dataDir` | cornfield's own state: reviews now, and `cornfield.db`, its SQLite file (private to its owner: it holds sessions). Default: `~/.cornfield/<repo folder>`, never inside the checkout |

Env vars win over the file: `CORNFIELD_PORT` (or `PORT`), `CORNFIELD_HOST`, `CORNFIELD_PUBLIC_URL`, `CORNFIELD_DATA`, `CORNFIELD_CONFIG`.

**Never put a secret in the config.** Source options are sent to the browser; v1's OAuth secrets come from env only.

## Sources

A source is a browser module the explorer imports. It exports `create(options)` returning any of `{ liveSource, floorRenderer, checker }` (or those names directly):

- `liveSource`: `{ name, load({ groups, signal }) → answer, image?(url), token? }`, the live layer (floors, rooms, devices, persona counts). The built-in house source's [browser.js](../plugins/house/browser.js) documents the answer.
- `floorRenderer`: `{ element, render(plan, floorId) → svg, defaultPlan(), editUrl? }`, the plan under the House view.
- `checker`: `{ apps, max, check(items) → results }`, scenario permission checks.

```js
sources: {
  // the built-in house source over a JSON file in the repo (docs/house.md)
  house: { use: 'house', options: { file: 'cornfield.house.json' } },
  // your own module, served from the repo with the files beside it
  live: { use: './tools/cornfield/live.js', options: { url: '/api/v1/world' } },
},
proxy: { '/api/': 'http://127.0.0.1:3245' },
```

A repo-local module is served at `/repo/<path>`, with the other `.js` files in its folder; nothing else of the repo is served. When several sources give a live source, their answers are laid over each other.
