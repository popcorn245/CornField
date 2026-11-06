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
  worktrees: '.claude/worktrees',   // or { dir: '.claude/worktrees', maxAgeDays: 30 }
  proposals: 'docs/specs/proposals',   // or { dir: 'docs/specs/proposals', approveLands: true }
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
| `worktrees` | a folder of git worktrees; each one's proposals that differ from the checkout's are listed too, as drafts. The folder as a string, or `{ dir?, maxAgeDays? }` ([below](#worktrees)) |
| `deploys` | `{ workflows: ['*deploy*'], restarts: { 'Deploy web': ['stack-web'] } }`: which workflow runs are deploys, and the map nodes each restarts; with a `forge` the panel's Deploys list lights them ([deploys](deploys.md)) |
| `proposals` | where proposal files live, in the checkout, in each worktree and (with a `forge` and sign-in) in open pull requests: the folder as a string, or `{ dir?, approveLands? }` ([below](#proposals)) |
| `topology` | the map file |
| `agents` | what marks work as made by an agent (`authors`, `labels`, `branchPrefixes`, `bots`), and how runs are asked for and followed (`transport`, `maxOpen`, `profiles`, `runners`, `quietAfter`, `runnerQuietAfter`, `limits`, `refuseCollisions`, `handWritten`): [agents](agents.md), [below](#agents) |
| `personas` | `roles`: the roles a persona may have (null: any kebab-case role); `parent`: the node the personas file hangs under |
| `cloud` | `parent`: the node the cloud file hangs under |
| `releaseNotes` | `breakingLabel`: the pull request label that lists a change under "Breaking" in the [release notes](issues-and-prs.md#release-notes) (default `breaking`) |
| `hooks` | `[{ url, events }]`: where cornfield posts a signed JSON event when something happens, and which events (a non-empty list of the names below, or `'*'`). [Hooks](#hooks) |
| `hookPoll` | `{ specs: '5m' }` or `false`: how often cornfield looks at the open spec PRs and the threads by itself, so `spec.ready` and the `thread.*` events fire without anyone opening the dashboard. On at 5 minutes when a hook subscribes to one of them, off otherwise. [Hook poll](#hook-poll) |
| `threads` | `{ label: 'idea' }` or `false`: an idea is an issue with this label and its thread is the issue's comments; `false` turns threads off (no tab, no routes, no `thread.*` events). Checked strictly: the only key is `label`, a name without a comma. [Threads](threads.md) |
| `links` | extra links in the explorer's header |
| `proxy` | same-origin paths for a source's own API: `{ '/api/': 'http://127.0.0.1:3245' }` |
| `importMap` | bare imports a repo-local source module needs: `{ name: '/repo/path/to/module.js' }` |
| `dataDir` | cornfield's own state: `cornfield.db`, its SQLite file (private to its owner: it holds sessions). Default: `~/.cornfield/<repo folder>`, never inside the checkout |

Env vars win over the file: `CORNFIELD_PORT` (or `PORT`), `CORNFIELD_HOST`, `CORNFIELD_PUBLIC_URL`, `CORNFIELD_DATA`, `CORNFIELD_CONFIG`. Sign-in is env only, never the file: `CORNFIELD_GITHUB_CLIENT_ID` and `CORNFIELD_GITHUB_CLIENT_SECRET` (or the `FORGEJO` pair) and `CORNFIELD_SESSION_SECRET` ([sign-in](sign-in.md)). `CORNFIELD_HOOK_SECRET` signs the [hooks](#hooks) and, like the sign-in secrets, is never in the file. `CORNFIELD_HA_URL` and `CORNFIELD_HA_TOKEN` are read only by the server, for the `home-assistant` house source; with both set and no `sources.house`, the house comes from Home Assistant ([house.md](house.md#home-assistant-directly)).

**Never put a secret in the config.** Source options are sent to the browser; v1's OAuth secrets come from env only.

## Agents

```js
agents: {
  // what marks work as made by an agent (docs/agents.md)
  authors: ['claude-bot'], labels: ['agent'], branchPrefixes: ['claude/'], bots: true,
  // asking for runs (docs/agents.md#launching-a-run)
  transport: 'forge',                  // 'forge' (default: the request is a comment), 'push' (a signed agent.requested hook event) or 'pull' (kept for a runner to claim): docs/agents.md#transports
  maxOpen: 3,                          // the most open runs per repo cornfield asks for (1 to 100)
  profiles: ['claude', 'local-qwen'],  // names a request may carry; the runner maps each to a model, a machine and a budget
  runners: ['claude-bot'],             // forge logins whose reports count, besides maintainers
  quietAfter: '24h',                   // a run with no report, push or pull request activity this long is quiet and counts toward nothing ('5m' to '720h')
  runnerQuietAfter: '3m',              // pull transport: no runner token has polled this long and no runner is online ("1m" to "60m"; docs/agents.md#is-a-runner-there)
  limits: { minutes: 30, turns: 40, cost: 5 },   // hints put in every request; a request may change them; the runner enforces them or not
  // opt-in triggers, off by default (docs/agents.md#triggers): a run requested by something a maintainer did
  on: { 'spec.approved': { kind: 'code', profile: 'claude' } },
  handWritten: true,                   // read the open issues' and pull requests' comments for request blocks a maintainer wrote by hand: true (all), 'labeled' (the threads label only) or false (docs/agents.md#requests-written-by-hand)
  refuseCollisions: false,             // true: refuse a new request whose `nodes` an open run is already changing (docs/agents.md#runs-on-the-map)
},
```

Each key is checked when the config loads and a wrong one fails start-up naming it. `profiles` are letters, digits and `. _ -`; a request naming a profile not on the list is refused (so is any profile when the list is empty). `runners` is the allow-list of the runners' own accounts: a `cornfield-run` report from anyone else who is not a maintainer is ignored and written to the audit table. `quietAfter` uses the same durations as [`hookPoll`](#hook-poll). `runnerQuietAfter` is the same kind of duration, from `1m` to `60m`: on the `pull` transport it is how long every live runner token may go without polling before cornfield says no runner is online ([agents](agents.md#is-a-runner-there)). `transport: 'push'` needs a [hook](#hooks) that subscribes to `agent.requested` (or `'*'`), or the config fails to load; `push` and `pull` also need sign-in and a forge. None of these holds a secret (a runner's token is made in the dashboard, never here), and no model, provider or key is ever configured in cornfield.

`on` maps an event to the request it makes: `{ kind, profile?, brief? }`. The keys are **only** `spec.approved`, `build.opened` and `thread.message` (a maintainer's `/agent` comment): a trigger fires on something a maintainer did, never on a run's own output, so any other event name is a start-up error. `kind` must be one of the contract's (`code`, `summary`, `brief`, `proposal`), `profile` must be one of `agents.profiles`, and a `brief` is text of at most 20000 characters with nothing shaped like a credential. `thread.message` needs threads on. Triggers need [sign-in](sign-in.md) and a `forge` (they act as the maintainer whose act caused them), and cornfield refuses to start without them. They need no `hooks` entry and no hook secret. See [triggers](agents.md#triggers) for what each does and why a run can never start another.

## Proposals

`proposals` is the proposals folder, and it has two spellings that mean the same thing for the folder:

```js
proposals: 'docs/specs/proposals',                                // the folder (the default); a string works as it always did
proposals: { dir: 'docs/specs/proposals', approveLands: true },   // or an object: the folder is `dir` (optional), and the options sit beside it
```

| Key | What it is |
|---|---|
| `dir` | the folder, inside the repo, written relative to it. Default `docs/specs/proposals` |
| `approveLands` | `true` or `false` (default **false**). When true, approving a spec (the **Approve** button, or an approval through the [review API](proposals.md)) also lands its pull request once the pull request is mergeable and every check is green: no second click. It is opt-in, for teams where approving a spec means the docs are good. [Land on approval](proposals.md#land-on-approval) says what it does and what stops it |

Nothing else is accepted: an unknown key, a `dir` that leaves the repo, or an `approveLands` that is not `true` or `false` fails the config at start-up, naming the key. `approveLands` needs [sign-in](sign-in.md) (an approval is a signed-in maintainer's, and it lands as them); with it on and no sign-in cornfield does not start, and says so.

## Worktrees

`worktrees` is the folder of git worktrees, and like `proposals` it has two spellings that mean the same thing for the folder:

```js
worktrees: '.claude/worktrees',                           // the folder (the default); a string works as it always did
worktrees: { dir: '.claude/worktrees', maxAgeDays: 30 },  // or an object: the folder is `dir` (optional), and the options sit beside it
worktrees: null,                                          // no worktrees are looked at
```

| Key | What it is |
|---|---|
| `dir` | the folder, inside the repo, written relative to it. Default `.claude/worktrees` |
| `maxAgeDays` | a number of days above 0 (default: none, every worktree is listed). A worktree whose newest proposal file was changed longer ago than this is left out. The age is the newest modification time among the worktree's proposal files, so a worktree you are still writing in always stays |

Nothing else is accepted: an unknown key, a `dir` that leaves the repo, or a `maxAgeDays` that is not a number above 0 (and at most 36500) fails the config at start-up, naming the key. How the worktrees are read, and why a slow folder cannot hold the server up, is in [proposals](proposals.md#many-worktrees-and-slow-folders).

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
| `spec.ready` | a spec PR is waiting for review: a spec PR that is **not a draft** was opened, pushed to, or marked ready. A draft, a "Start a spec" stub among them, is never announced; once it is marked ready it is, at its head. cornfield has no webhook receiver, so it notices when it lists the open spec PRs: when a maintainer opens the proposals menu or the issues and PRs panel, **or on its own timer** ([`hookPoll`](#hook-poll), every 5 minutes unless set otherwise), so it fires **within the poll interval of the push, whether or not anyone has the dashboard open**, as long as a maintainer is signed in. Once per (pull request, head commit, proposal), and a restart does not repeat it. **The first look after `hooks` is added announces nothing**: it records the spec PRs already open, and only what changes after it is sent |
| `spec.approved` | a maintainer approved a proposal (the review comment was posted) |
| `spec.sentBack` | a maintainer sent a proposal back |
| `build.opened` | the build issue of an approved proposal was opened (not when a second ask only found it) |
| `pr.landed` | a pull request was landed **through cornfield** (the issues and PRs panel's Land it). A merge made on the forge itself, or by anything else, sends nothing. `slug` is its proposal when it is a spec PR (the first, when it holds several), else `null` |
| `thread.opened` | an idea (an issue with the [threads](threads.md) label) was first seen. Fires when cornfield looks, like `spec.ready` |
| `thread.message` | a comment was added to a thread: an idea's, or a spec PR's conversation. Once per comment, across restarts. The payload never holds the text |
| `thread.linked` | a thread now points at the map or at a proposal: a message with a `[[node]]` mention that resolves or a `cornfield-thread` block, or a spec PR that names it with `Thread: #n`. Carries `nodes` and `proposal` |
| `session.expiring` | a maintainer's [sign-in](sign-in.md#how-long-a-session-lasts) ends within 24 hours, so a review token or a landing that acts with it is about to be refused. cornfield looks once an hour, so it arrives between 24 and 23 hours before the end (at once, for a 1 day session). **Once for each session**, recorded in `cornfield.db`, so a restart does not repeat it; a maintainer signed in twice (a laptop and a phone) gets one for each, each with its own `expiresAt`. A session that was signed out or has ended never sends it, nor does a signed-in reader who is not a maintainer. Its body is only `{ event, at, actor, expiresAt, mapUrl }`: `actor` is the maintainer's login, `expiresAt` when the session ends (ISO 8601). It is the only event with no `slug` or `pull` |

| `agent.requested` | a maintainer asked for an agent run (the dashboard's Start an agent, or the request API). Sent at once, on every `agents.transport`; on `push` it is how the runner gets the request ([how to verify it](agents.md#push)). Its body is its own: `{ event, at, request, actor, mapUrl }`, where `request` is the [contract's](agent-contract.md) request JSON, which holds no credential by construction (it is checked again on the way out), and `actor` is who asked |
| `run.claimed` | the run's runner reported `claimed` |
| `run.state` | a run changed state: a report with another state, its pull request found, merged or closed |
| `run.stopRequested` | a maintainer asked a run to stop (through cornfield, or by hand on the forge) |
| `run.finished` | a run ended: `done`, `failed`, `stopped`, or its pull request merged or closed |
| `trigger.skipped` | an opt-in [trigger](agents.md#triggers) (`agents.on`) did not request a run: the maintainer whose act caused it has no live sign-in (`reason: "no-session"`), or the request was refused (`cap-reached`, `run-open`, `rate-limited`, `forbidden`, `invalid`). Nothing was posted. Its body is its own: `{ event, at, trigger, by, reason, mapUrl }`, where `trigger` is `{ event, by, ref }` (the event that was going to fire it, the maintainer, and the pull request, issue or comment, as in the [contract's](agent-contract.md#what-caused-an-automatic-request) `trigger` field) and `by` the maintainer again |
| `runner.offline` | on the `pull` transport, the last live [runner token](agents.md#runner-tokens) has not polled for `agents.runnerQuietAfter` (3 minutes unless set), so a queued run will wait. Fires **once**, and again only after a runner has polled and then gone quiet again; a token revoked or expired is no runner, and a restart that finds none online announces nothing. Checked every 30 seconds, so it arrives within that of the window. Its body is its own: `{ event, at, label, lastSeen, mapUrl }`, where `label` is the runner token that polled last and `lastSeen` is when (ISO time); never a token ([agents](agents.md#is-a-runner-there)) |

The `run.*` events for a run on the forge are noticed when cornfield looks at the forge (the [spec poll](#hook-poll), or a Refresh), each once, even across a restart. For a run on push or pull they are sent as the runner's report arrives (`actor` is `runner:<token label>`). Their body is `{ "event", "at", "runId", "state", "pull"?, "issue"?, "actor", "mapUrl" }`: `state` is the state the event is about, `pull` the run's pull request and `issue` its issue or thread when there are any, and `actor` who caused it (the reporting login, the maintainer, or the pull request's author).

Each other event is a POST of one JSON body:

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

The thread events have a body of their own, `{ event, at, thread, comment?, actor, nodes?, proposal?, mapUrl }`, and never a comment's text: see [threads](threads.md#hooks). For the others, `slug`, `pull`, `headSha`, `proposalSha256` and `actor` are `null` where they do not apply (or cannot be read). `actor` is who acted: the maintainer, or for `spec.ready` the PR's author. `note` and `edits` (the review note and what-if edits) come only on `spec.approved` and `spec.sentBack`. `mapUrl` is `publicUrl`, or `null`. An event never carries file contents, a token or an email.

Headers: `Content-Type: application/json`, `X-Cornfield-Event`, `X-Cornfield-Delivery` (a UUID, the same on every retry of one delivery), `X-Cornfield-Timestamp` (the body's `at`) and `X-Cornfield-Signature: sha256=<hex>`, the HMAC-SHA256 of the **raw body** under the secret. Check it on the raw bytes, in constant time, and refuse an old `at` (a few minutes) so a captured request cannot be replayed:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(raw, header, secret, maxAgeMs = 300_000) {
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`), got = Buffer.from(String(header));
  return want.length === got.length && timingSafeEqual(want, got) && Math.abs(Date.now() - Date.parse(JSON.parse(raw).at)) < maxAgeMs;
}
```

### Hook poll

`spec.ready` is noticed by listing the open spec PRs, and the `thread.*` events by reading the threads ([threads](threads.md#hooks)). A team that reviews from chat never opens the dashboard, so cornfield also does that by itself, on a timer, in one look:

```js
hookPoll: { specs: '5m' },   // the default; '90s', '5m', '1h'… or false for none
```

- **Runs.** The same timer follows [agent runs](agents.md#following-a-run): it is started when a run is asked for (or was, before a restart), looks at the forge only while a run is waiting for a report or a push, and uses the same interval, so `hookPoll: false` leaves runs to the Refresh button. Unless `agents.handWritten` is `false`, it also reads the open issues' and pull requests' comments for [requests written by hand](agents.md#requests-written-by-hand), which starts it with no run at all.
- **When it runs.** By default, when some hook subscribes to `spec.ready` or to a `thread.*` event while threads are on (by name, or with `events: '*'`), or when `agents.on` has a `thread.message` trigger (which needs no hook): every 5 minutes, the first look 15 seconds after start. With no such hook it is off (unless `agents.handWritten` asks it to look for requests written by hand, which it does by default), and `hookPoll` changes nothing. `hookPoll: false` (or `{ specs: false }`) turns it off even then; the dashboard still triggers the event as before.
- **The interval** is a whole number with `s`, `m` or `h`, from **60s** (a floor, so the forge is not hammered) to **1h**. Anything else fails the config at start-up, naming the key. The key is separate from the `hooks` list, which stays a list.
- **Whose token.** Never one from the config. The poll looks as the newest live [sign-in](sign-in.md#the-spec-poll) of a user the forge says is a maintainer of the repo *right now* (the check the [review API](proposals.md) makes before it posts). With no such session it does nothing and keeps running: it says so once in the log, not on every tick, and says so again when a maintainer is back. The log also names whose sign-in it looks with, each time that changes. That token only ever reads: who its owner is, their permission, and the open spec PRs; someone the forge says is no longer a maintainer is asked the first two and nothing else. A restart keeps the sessions (they are in the SQLite file, the tokens encrypted), so the poll looks with them as soon as it runs.
- **The same look.** The poll calls the listing the dashboard uses, so the rules above are unchanged: a draft is never announced, the first look after `hooks` is added announces nothing, and each (pull request, head commit, proposal) is sent once. A poll and a dashboard look never announce the same head twice.
- **What it costs the forge.** A poll with nothing new makes **3 calls**: who the token's owner is, their permission on the repo, and the open pull requests (one more call per further page of 30 or so). A pull request pushed to since the last look costs one call for its changed files, and an announced proposal one call to read it, once each; what was read at a head is cached and not asked again. One poll in flight at a time: if the forge is slow the next tick waits for it.
- **Threads ride the same tick.** When a hook wants a `thread.*` event the look also reads the ideas and the spec PRs' conversations, with the same sign-in, the same timer and the same backoff; the open PRs are listed once for both. A failure in either half is the tick's failure. [Threads](threads.md#hooks) has the rules and the cost.
- **When the forge fails.** The error is logged, never thrown, and the next look waits twice the interval, until one succeeds.

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
