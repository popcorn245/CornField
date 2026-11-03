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
  releaseNotes: { breakingLabel: 'breaking' },
  hooks: [{ url: 'https://chat.example.org/hooks/cornfield', events: ['spec.ready', 'spec.approved'] }],
  links: [{ label: 'Docs', href: 'https://example.org/docs' }],
  proxy: { '/api/': 'http://127.0.0.1:3245' },
  importMap: {},
  dataDir: null,
};
```

| Key | What it is |
|---|---|
| `title` | the explorer's title (default: the package name) |
| `derivers` | built-in names (`starter`, `personas`, `compose`, `world`, `openapi`, `cloud`, `docs`), paths (`./tools/deriver.js`), or `{ use, options }`; run in order. [derivers.md](derivers.md) |
| `sources` | browser modules for the live layer, the house, devices and the permission checker (below) |
| `forge` | `{ type: 'github' \| 'forgejo', url, repo: 'owner/name', mergeMethod?, baseBranch? }`: where issues, PRs and (v1) sign-in live; with it the explorer has the [issues and PRs panel](issues-and-prs.md). `mergeMethod` is how the panel lands a green pull request: `merge` (the default), `squash` or `rebase`, the way the repo lands its own. `baseBranch` is the branch the pipeline's "Start a spec" branches from and opens its draft pull request into (`main` when unset) |
| `port`, `host` | where `serve` listens. Without sign-in the host must be loopback; with it and an https `publicUrl`, any address ([sign-in](sign-in.md)) |
| `publicUrl` | the origin people open it at; sign-in needs it (the OAuth callback is `<publicUrl>/auth/callback`) |
| `worktrees` | a folder of git worktrees; each one's proposals are listed too, as drafts |
| `deploys` | `{ workflows: ['*deploy*'], restarts: { 'Deploy web': ['stack-web'] } }`: which workflow runs are deploys, and the map nodes each restarts; with a `forge` the panel's Deploys list lights them ([deploys](deploys.md)) |
| `proposals` | where proposal files live, in the checkout, in each worktree and (with a `forge` and sign-in) in open pull requests |
| `topology` | the map file |
| `agents` | what marks work as made by an agent: `authors`, `labels`, `branchPrefixes` (lists, empty by default) and `bots` (default true: `[bot]` accounts count). The Agents tab of the issues and PRs panel uses it: [agents](agents.md) |
| `personas` | `roles`: the roles a persona may have (null: any kebab-case role); `parent`: the node the personas file hangs under |
| `cloud` | `parent`: the node the cloud file hangs under |
| `releaseNotes` | `breakingLabel`: the pull request label that lists a change under "Breaking" in the [release notes](issues-and-prs.md#release-notes) (default `breaking`) |
| `hooks` | `[{ url, events }]`: where cornfield posts a signed JSON event when something happens, and which events (a non-empty list of the five names, or `'*'`). [Hooks](#hooks) |
| `links` | extra links in the explorer's header |
| `proxy` | same-origin paths for a source's own API: `{ '/api/': 'http://127.0.0.1:3245' }` |
| `importMap` | bare imports a repo-local source module needs: `{ name: '/repo/path/to/module.js' }` |
| `dataDir` | cornfield's own state: `cornfield.db`, its SQLite file (private to its owner: it holds sessions). Default: `~/.cornfield/<repo folder>`, never inside the checkout |

Env vars win over the file: `CORNFIELD_PORT` (or `PORT`), `CORNFIELD_HOST`, `CORNFIELD_PUBLIC_URL`, `CORNFIELD_DATA`, `CORNFIELD_CONFIG`. Sign-in is env only, never the file: `CORNFIELD_GITHUB_CLIENT_ID` and `CORNFIELD_GITHUB_CLIENT_SECRET` (or the `FORGEJO` pair) and `CORNFIELD_SESSION_SECRET` ([sign-in](sign-in.md)). `CORNFIELD_HOOK_SECRET` signs the [hooks](#hooks) and, like the sign-in secrets, is never in the file. `CORNFIELD_HA_URL` and `CORNFIELD_HA_TOKEN` are read only by the server, for the `home-assistant` house source; with both set and no `sources.house`, the house comes from Home Assistant ([house.md](house.md#home-assistant-directly)).

**Never put a secret in the config.** Source options are sent to the browser; v1's OAuth secrets come from env only.

## Hooks

cornfield takes in what happens on a repo; hooks send some of it out, so a team's own chat bot, pipeline or notifier can learn that a spec is waiting for review, or was approved, without polling the forge.

```js
hooks: [
  { url: 'https://chat.example.org/hooks/cornfield', events: ['spec.ready', 'spec.approved', 'spec.sentBack'] },
  { url: 'http://127.0.0.1:9000/cornfield', events: '*' },
],
```

A `url` is https; http is only for `localhost`, `127.0.0.1` and `[::1]`, and it holds no user name or password. The signing secret is `CORNFIELD_HOOK_SECRET` in env, at least 32 characters (`openssl rand -base64 48`), never the file. With `hooks` and no secret, a short one, or no [sign-in](sign-in.md), cornfield refuses to start, and says which. Without sign-in no hook could ever fire: every event comes from something a signed-in maintainer does in cornfield, or from the spec PRs cornfield lists for them.

| Event | When |
|---|---|
| `spec.ready` | a spec PR is waiting for review: a spec PR that is **not a draft** was opened, pushed to, or marked ready. A draft, a "Start a spec" stub among them, is never announced; once it is marked ready it is, at its head. cornfield has no webhook receiver, so it notices when it next lists the open spec PRs (a maintainer opening the proposals menu or the issues and PRs panel): it fires **when cornfield next looks, not at the push**. Once per (pull request, head commit, proposal), and a restart does not repeat it. **The first look after `hooks` is added announces nothing**: it records the spec PRs already open, and only what changes after it is sent |
| `spec.approved` | a maintainer approved a proposal (the review comment was posted) |
| `spec.sentBack` | a maintainer sent a proposal back |
| `build.opened` | the build issue of an approved proposal was opened (not when a second ask only found it) |
| `pr.landed` | a pull request was landed **through cornfield** (the issues and PRs panel's Land it). A merge made on the forge itself, or by anything else, sends nothing. `slug` is its proposal when it is a spec PR (the first, when it holds several), else `null` |

Each event is a POST of one JSON body:

```json
{
  "event": "spec.approved",
  "at": "2026-11-03T09:30:00.000Z",
  "slug": "0014-planner",
  "pull": 42,
  "headSha": "3f9c…",
  "proposalSha256": "9b1e…",
  "actor": "maintainer-one",
  "note": "Looks right.",
  "edits": [],
  "mapUrl": "https://cornfield.example.org"
}
```

`slug`, `pull`, `headSha`, `proposalSha256` and `actor` are `null` where they do not apply (or cannot be read). `actor` is who acted: the maintainer, or for `spec.ready` the PR's author. `note` and `edits` (the review note and what-if edits) come only on `spec.approved` and `spec.sentBack`. `mapUrl` is `publicUrl`, or `null`. An event never carries file contents, a token or an email.

Headers: `Content-Type: application/json`, `X-Cornfield-Event`, `X-Cornfield-Delivery` (a UUID, the same on every retry of one delivery), `X-Cornfield-Timestamp` (the body's `at`) and `X-Cornfield-Signature: sha256=<hex>`, the HMAC-SHA256 of the **raw body** under the secret. Check it on the raw bytes, in constant time, and refuse an old `at` (a few minutes) so a captured request cannot be replayed:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(raw, header, secret, maxAgeMs = 300_000) {
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`), got = Buffer.from(String(header));
  return want.length === got.length && timingSafeEqual(want, got) && Math.abs(Date.now() - Date.parse(JSON.parse(raw).at)) < maxAgeMs;
}
```

A hook never blocks or undoes what fired it. Events are sent in the background; a delivery that is not answered with a 2xx within 10 seconds (a redirect is not followed) is tried again after 1, 5 and 30 seconds, then dropped. Every attempt is a row in the audit table (`actions`, action `hook`; it names the hook's origin and the HTTP status, never its path, the secret or the body). Deliveries wait in memory, so a restart forgets the ones still being retried, and a receiver should answer quickly and treat `X-Cornfield-Delivery` as its dedupe key.

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
