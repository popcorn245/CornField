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
  theme: { css: './tools/cornfield/theme.css', fonts: ['https://fonts.googleapis.com/css2?family=Nunito&display=swap'], names: { day: './tools/cornfield/day.css', night: './tools/cornfield/night.css' }, default: 'day' },
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
| `agents` | what marks work as made by an agent (`authors`, `labels`, `branchPrefixes`, `bots`), and how runs are asked for and followed (`transport`, `maxOpen`, `profiles`, `runners`, `quietAfter`, `runnerQuietAfter`, `limits`, `refuseCollisions`, `handWritten`, `mirror`): [agents](agents.md), [below](#agents) |
| `personas` | `roles`: the roles a persona may have (null: any kebab-case role); `parent`: the node the personas file hangs under |
| `cloud` | `parent`: the node the cloud file hangs under |
| `releaseNotes` | `breakingLabel`: the pull request label that lists a change under "Breaking" in the [release notes](issues-and-prs.md#release-notes) (default `breaking`) |
| `hooks` | `[{ url, events }]`: where cornfield posts a signed JSON event when something happens, and which events (a non-empty list of the names below, or `'*'`). [Hooks](#hooks) |
| `hookPoll` | `{ specs: '5m' }` or `false`: how often cornfield looks at the open spec PRs and the threads by itself, so `spec.ready` and the `thread.*` events fire without anyone opening the dashboard. On at 5 minutes when a hook subscribes to one of them, off otherwise. [Hook poll](#hook-poll) |
| `threads` | `{ label: 'idea' }` or `false`: an idea is an issue with this label and its thread is the issue's comments; `false` turns threads off (no tab, no routes, no `thread.*` events). Checked strictly: the only key is `label`, a name without a comma. [Threads](threads.md) |
| `links` | extra links in the explorer's header |
| `theme` | `{ css?, fonts?, fontHosts?, names?, default?, icons?, pixelated?, contrast? }`: a repo's own look, CSS and images only. A stylesheet served same-origin and loaded after cornfield's own, an allow-list of `https:` font stylesheets, named themes with a picker in the header, an icon per node kind on the map, and a contrast check. [Theme](#theme) |
| `brand` | `{ logo?, wordmark?, favicon?, appName?, color?, background? }`: a repo's own logo, name and colours in cornfield's chrome, and a web app manifest. Images from the repo only. [Brand](#brand) |
| `strings` | `{ approve?, sendBack?, … }`: the repo's own words for about forty visible labels, plain text, one line. [Strings](#strings) |
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
  quietAfter: '24h',                   // a run with no report, push or pull request activity this long is quiet and counts toward nothing ('5m' to '720h'); never a run waiting on a maintainer
  runnerQuietAfter: '3m',              // pull transport: no runner token has polled this long and no runner is online ("1m" to "60m"; docs/agents.md#is-a-runner-there)
  limits: { minutes: 30, turns: 40, cost: 5, claude: { cost: 20, tokens: 500000 } },   // hints put in every request (a profile's own over the rest, key by key); a request may change them; the runner enforces them or not
  // opt-in triggers, off by default (docs/agents.md#triggers): a run requested by something a maintainer did
  on: { 'spec.approved': { kind: 'code', profile: 'claude' } },
  mirror: true,                        // keep one status comment per run in the thread it is about, edited as the run moves (default true; false writes none): docs/agents.md#a-thread-for-every-run
  handWritten: true,                   // read the comments of the open issues and pull requests for request blocks a maintainer wrote by hand: true (all), 'labeled' (the threads label only) or false (none, and no poll for it); a run found goes by `transport` like any (docs/agents.md#requests-written-by-hand)
  refuseCollisions: false,             // true: refuse a new request whose `nodes` an open run is already changing (docs/agents.md#runs-on-the-map)
},
```

Each key is checked when the config loads and a wrong one fails start-up naming it. `profiles` are letters, digits and `. _ -`; a request naming a profile not on the list is refused (so is any profile when the list is empty). `runners` is the allow-list of the runners' own accounts: a `cornfield-run` report from anyone else who is not a maintainer is ignored and written to the audit table. `quietAfter` uses the same durations as [`hookPoll`](#hook-poll). `runnerQuietAfter` is the same kind of duration, from `1m` to `60m`: on the `pull` transport it is how long every live runner token may go without polling before cornfield says no runner is online ([agents](agents.md#is-a-runner-there)). `transport: 'push'` needs a [hook](#hooks) that subscribes to `agent.requested` (or `'*'`), or the config fails to load; `push` and `pull` also need sign-in and a forge. None of these holds a secret (a runner's token is made in the dashboard, never here), and no model, provider or key is ever configured in cornfield.

`limits` are hints a request starts from. The keys `minutes`, `cost` (numbers above zero), `turns` and `tokens` (whole numbers above zero) apply to every profile; a key that names a profile from `agents.profiles` holds that profile's own limits (`limits: { claude: { cost: 5, minutes: 60 } }`) and wins over the flat ones key by key. A request made from the dialog, the request API or a trigger carries these defaults, and limits the request sets itself win over them key by key. An unknown profile, an unknown key or a number not above zero fails start-up naming the key. cornfield enforces none of them: the runner reads them from the request. A profile named `minutes`, `turns`, `cost` or `tokens` fails start-up, so a key of `limits` is never both. What runners report back is totalled in the Runs view: [agents](agents.md#totals-of-tokens-and-cost).

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
| `run.waiting` | a run's runner reported `waiting`: it stopped to ask a maintainer (a plan to approve, a decision). Once for each wait ([how it is answered](agents.md#waiting-and-the-answer)) |
| `run.answered` | a maintainer answered a waiting run: Continue, Stop or a reply. The body also has `action` (`continue`, `stop` or `reply`); a reply's words are never sent |
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

- **Runs.** The same timer follows [agent runs](agents.md#following-a-run): it is started when a run is asked for (or was, before a restart), looks at the forge only while a run is waiting for a report or a push, and uses the same interval, so `hookPoll: false` leaves runs to the Refresh button. Unless `agents.handWritten` is `false`, it also looks for [requests written by hand](agents.md#requests-written-by-hand) in the comments of the open issues and pull requests, which starts it with no run at all.
- **A change in behaviour (issue #98).** Because `agents.handWritten` is `true` by default, **a server with sign-in and a forge now runs this poll even with no hook and no run**, where before it asked the forge nothing until a run was asked for. On an idle repo a tick costs three small reads: the check that the sign-in it looks with is still a maintainer's (who they are, their permission), and one listing of the open issues and pull requests updated since the last look, which comes back empty; comments are read only for a conversation that changed. At the default 5 minutes that is 36 calls an hour, well under a forge's rate limit. `agents.handWritten: false` returns to the old behaviour.
- **When it runs.** By default, when some hook subscribes to `spec.ready` or to a `thread.*` event while threads are on (by name, or with `events: '*'`), or when `agents.on` has a `thread.message` trigger (which needs no hook): every 5 minutes, the first look 15 seconds after start. With no such hook it is off (unless `agents.handWritten` asks it to look for requests written by hand, which it does by default), and `hookPoll` changes nothing. `hookPoll: false` (or `{ specs: false }`) turns it off even then; the dashboard still triggers the event as before.
- **The interval** is a whole number with `s`, `m` or `h`, from **60s** (a floor, so the forge is not hammered) to **1h**. Anything else fails the config at start-up, naming the key. The key is separate from the `hooks` list, which stays a list.
- **Whose token.** Never one from the config. The poll looks as the newest live [sign-in](sign-in.md#the-spec-poll) of a user the forge says is a maintainer of the repo *right now* (the check the [review API](proposals.md) makes before it posts). With no such session it does nothing and keeps running: it says so once in the log, not on every tick, and says so again when a maintainer is back. The log also names whose sign-in it looks with, each time that changes. That token only ever reads: who its owner is, their permission, and the open spec PRs; someone the forge says is no longer a maintainer is asked the first two and nothing else. A restart keeps the sessions (they are in the SQLite file, the tokens encrypted), so the poll looks with them as soon as it runs.
- **The same look.** The poll calls the listing the dashboard uses, so the rules above are unchanged: a draft is never announced, the first look after `hooks` is added announces nothing, and each (pull request, head commit, proposal) is sent once. A poll and a dashboard look never announce the same head twice.
- **What it costs the forge.** A poll with nothing new makes **3 calls**: who the token's owner is, their permission on the repo, and the open pull requests (one more call per further page of 30 or so). A pull request pushed to since the last look costs one call for its changed files, and an announced proposal one call to read it, once each; what was read at a head is cached and not asked again. One poll in flight at a time: if the forge is slow the next tick waits for it.
- **Threads ride the same tick.** When a hook wants a `thread.*` event the look also reads the ideas and the spec PRs' conversations, with the same sign-in, the same timer and the same backoff; the open PRs are listed once for both. A failure in either half is the tick's failure. [Threads](threads.md#hooks) has the rules and the cost.
- **When the forge fails.** The error is logged, never thrown, and the next look waits twice the interval, until one succeeds.

A hook never blocks or undoes what fired it. Events are sent in the background; a delivery that is not answered with a 2xx within 10 seconds (a redirect is not followed) is tried again after 1, 5 and 30 seconds, then dropped. Every attempt is a row in the audit table (`actions`, action `hook`; it names the hook's origin and the HTTP status, never its path, the secret or the body). Deliveries wait in memory, so a restart forgets the ones still being retried, and a receiver should answer quickly and treat `X-Cornfield-Delivery` as its dedupe key.

## Theme

A repo can restyle cornfield without a fork: `theme` names stylesheets, font stylesheets and named themes. **A theme is CSS only.** It is never script, and it is never inlined into the page: every theme file is a `<link rel="stylesheet">` to a same-origin URL, so the page's Content-Security-Policy (`script-src 'self'`) is unchanged.

```js
theme: {
  css: './tools/cornfield/theme.css',                        // loaded after cornfield's own CSS
  fonts: ['https://fonts.googleapis.com/css2?family=Nunito&display=swap'],
  fontHosts: [],                                             // only for a fonts host that is not a known pair (below)
  names: { day: './tools/cornfield/day.css', night: './tools/cornfield/night.css' },
  default: 'day',                                            // must be one of `names`
  icons: { app: './tools/cornfield/icons/app.svg', page: './tools/cornfield/icons/page.png' }, // an icon per node kind, drawn inside the node on the map
  pixelated: true,                                           // draw small icons crisp (nearest-neighbour), not smoothed
  contrast: 'error',                                         // 'warn' makes a failing contrast pair a warning
}
```

| Key | What it is |
|---|---|
| `css` | one stylesheet inside the repo, written relative to it and ending in `.css`. The server serves it at `/cornfield/theme.css`, as `text/css` with `X-Content-Type-Options: nosniff`, and the page links it **after** `explorer.css` and `house.css`, so it can override them. |
| `fonts` | an allow-list (at most 8) of `https:` stylesheet URLs, such as a Google Fonts `css2?family=…` link. Each is added to the page as a `<link rel="stylesheet">` and to the CSP. Any other scheme (`http:`, `data:`, `javascript:`), a URL with credentials, an IP address or a wildcard is refused. |
| `fontHosts` | the hosts the font *files* come from, for a `fonts` host that is not a known pair. At most 8 plain host names, like `files.example.org`. Only allowed with `fonts`. |
| `names` | named themes: `{ name: './path.css' }`, at most 12. A name is lower-case letters, digits and hyphens (at most 32 characters). Each file is served at `/cornfield/theme/<name>.css`. |
| `contrast` | `'error'` (the default) or `'warn'`: what `validate` does with a theme pair under WCAG AA (4.5:1 text, 3:1 UI), in light or dark, for the standard theme and for each named theme (with no theme, for cornfield's own tokens). `'error'` fails `validate`; `'warn'` reports the same lines as warnings. See [the contrast check](theming.md#the-contrast-check). |
| `default` | the name in force until a viewer picks another. One of `names`. Without it, no named theme is on until a viewer picks one, and the picker offers "Standard" (cornfield without a named theme). |
| `icons` | an icon per node kind: `{ '<kind>': './path.svg' }`, where the kind is a node type (`root`, `app`, `page`, `pkg`, `core`, `token`, `atom`, `molecule`, `tool`, `store`, `table`, `rom`, `service`, `external`, `stack`, `machine`, `container`, `persona`, `device`, `floor`, `room`) and the file is an `.svg` or `.png` inside the repo **and inside the theme's folder** (below). It is drawn inside the node's circle on the map, in both renderers. |
| `pixelated` | `true` draws the icons without smoothing (nearest-neighbour: WebGL `NEAREST`, Canvas 2D `imageSmoothingEnabled = false`), so small pixel art stays crisp when the map is zoomed. It also sets `image-rendering: pixelated` on every `<img>` in the page (`<html data-pixelated>`). Default `false`. |

**What the CSP gets.** `style-src` gains the origin of each `fonts` URL and `font-src` gains the same origins plus the font file hosts, and nothing else is widened (`default-src`, `script-src`, `connect-src` and `img-src` stay as they were). The file hosts are known for two stylesheet hosts: `fonts.googleapis.com` (files from `fonts.gstatic.com`) and `fonts.bunny.net` (files from the same host). For any other host in `fonts`, the config is refused until `fontHosts` lists where its font files come from. A font file that a stylesheet in `fonts` names from a host the policy does not list is blocked by the browser.

**Fonts that redirect.** A `fonts` stylesheet, or a font file it names, that redirects to a host the policy does not list is blocked by the browser: the CSP is checked against where the request ends up, so it fails closed (the text falls back to the next font in the stack). List the final host in `fontHosts` if a provider redirects.

**Named themes.** With `names`, the server puts `data-theme-names` and `data-theme-default` on `<html>`, and `explorer/theme-boot.js`, a classic script that is the last thing in the page's `<head>` (after every stylesheet link, so before the body is parsed and before anything is drawn), sets `data-theme-name` on `<html>` before the first paint: the viewer's pick from `localStorage` (`cornfield:theme-name`) when it is still one of `names`, else `default`. It also points the named theme's `<link>` at that file, so a stylesheet scoped to `:root[data-theme-name="night"]` or a whole file per name both work. A small `<select>` in the header, next to the light/dark toggle, switches it and remembers the pick. If storage is blocked, the page still renders and the pick holds for that visit. `data-theme-name` is independent of the light/dark `data-theme`.

The order of stylesheets is: cornfield's own, the `fonts` links, `css`, then the current named theme. `/cornfield/config.json` carries `theme: { names, default, icons?, pixelated? }` for the picker and the map, never a file path (`icons` holds the served `/cornfield/theme/assets/…` paths).

**Images and fonts beside a theme.** A theme may use its own images (pixel-art backgrounds, border images) and self-hosted fonts. The server serves the files in the theme's folder (the folder that holds the `css` and `names` files; when they sit in different folders, the deepest folder that holds them all) at `/cornfield/theme/assets/<path under that folder>`:

- only `.png`, `.svg`, `.webp`, `.gif`, `.avif`, `.woff2` and `.woff` files, each at most **1 MB**, with their own `Content-Type` and `X-Content-Type-Options: nosniff`, same-origin (`img-src 'self'` and `font-src 'self'` already allow them);
- an SVG is sent as `image/svg+xml` with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, so opened on its own it runs and loads nothing;
- path segments are plain (letters, digits, `.`, `_`, `-`; none starting with a dot, so no `..` and no `.git`), at most 8 deep; a symlink that leads out of the theme folder, a folder (no listings) and anything else is a 404;
- nothing is served this way when the theme files sit at the top of the repo: put them in a folder, like `tools/cornfield/`.

cornfield does not rewrite the CSS, so a `url()` is read relative to where the file is **served**, not where it sits in the repo. Write it as **`/cornfield/theme/assets/<path>`**, which works in every theme file. Relative also works if it is relative to the served URL: from `css` (served at `/cornfield/theme.css`) that is `theme/assets/<path>`, and from a named theme (served at `/cornfield/theme/<name>.css`) it is `assets/<path>`. For `tools/cornfield/theme.css` and `tools/cornfield/img/bricks.png`:

```css
body { background-image: url(/cornfield/theme/assets/img/bricks.png); image-rendering: pixelated; }   /* in any theme file */
@font-face { font-family: Pixel; src: url(/cornfield/theme/assets/fonts/pixel.woff2) format("woff2"); }
```

**What `cornfield validate` checks** in each file named by `css` and `names`:

- it exists, is a plain file, and stays inside the repo (a symlink that leads out is refused);
- it is at most **256 KB**;
- it is CSS: no NUL bytes, no HTML, balanced braces;
- it keeps out of script: no `expression(`, `javascript:`, `vbscript:`, `behavior:` or `-moz-binding` (CSS escapes and comments inside the word do not hide it, nor a comment marker inside a string), and no `@import` except of an `https:` URL that is listed in `theme.fonts` (an `@import` of a bare string, with a comment before its `url(`, or with nothing after it is refused too);
- its contrast: the `--corn-*` pairs of the theme, in light and dark, for the standard theme and for each named one, are at least WCAG AA (`contrast` above; [the pairs](theming.md#the-contrast-check));
- every `url()` (and `src()`) leads, read relative to where the file is served, to an image or font beside the theme that the server would serve (above), or is a `data:` image (`data:image/png`, `gif`, `webp`, `avif` or `svg+xml`). A URL on another host is refused: the CSP would block it anyway.

**Map icons.** `icons` is served by the same route as the images beside a theme: an icon at `tools/cornfield/icons/app.svg` is fetched from `/cornfield/theme/assets/icons/app.svg`, so it must sit in the theme's folder (the folder of the `css` and `names` files) and follow the same rules (plain names, at most 1 MB, nothing served when the theme files are at the top of the repo). The browser is told only the served path of each, in `/cornfield/config.json`'s `theme.icons`. An icon is an image and nothing else: give an SVG a `width` and a `height` (it is drawn as an image, so it cannot run script or load anything). The map draws it as a square inside the node, over the node's colour; a kind with no icon, an icon that is still loading and one that fails to load all draw as a plain node, so a missing file never breaks the map. The map's colours come from `--corn-map-*` tokens in the theme's stylesheet: [docs/theming.md, The map](theming.md#the-map).

**What `cornfield validate` checks** in `icons` and `pixelated`: `pixelated` is true or false; each key is a node kind; each icon is an `.svg` or `.png` path inside the repo and inside the theme folder, that exists as a plain file there (a link out of it is refused), is at most 1 MB, and is what its extension says (a PNG with the PNG signature; an SVG with an `<svg>` element and no `<script>`, `on…=` handler or `javascript:`). `configProblems` reports the shape (a kind that is not a node type, a path outside the theme folder), `validate` the files.

The server applies the same checks when it serves a file and answers 404 for one that fails, for a file over the cap, and for any path the config does not name. Nothing else of the repo is reachable through these routes.

## Brand

A repo can put its own logo and name in cornfield's header and on the browser tab, and let a phone install the dashboard as an app. The images come from the repo and nothing else: cornfield carries no brand of its own to swap in.

```js
brand: {
  logo: './tools/cornfield/logo.svg',          // replaces the brand mark in the header
  wordmark: './tools/cornfield/wordmark.svg',  // replaces the title text in the header
  favicon: './tools/cornfield/favicon.png',    // the tab icon
  appName: 'Acme',                             // replaces "cornfield" where cornfield names itself (tab title, heading, manifest)
  color: '#e53e3e',                            // the manifest's theme_color (and the tab's theme-color)
  background: '#ffffff',                       // the manifest's background_color
}
```

Every key is optional. An unknown key is refused.

| Key | What it is |
|---|---|
| `logo` | one `.svg` or `.png` file inside the repo, written relative to it. It takes the place of the brand mark (the green dot) in the header's brand button. |
| `wordmark` | the same kind of file. It takes the place of the title text (the repo's `title`) beside the logo. On a narrow phone the title text is hidden, and so is the wordmark; the logo stays. |
| `favicon` | the same kind of file, put in the page as `<link rel="icon">`. |
| `appName` | the name of the app, up to 64 characters on one line. It replaces "cornfield" wherever cornfield names itself: the tab title (`<title>` is `<repo title> · <appName>`), the page's heading ("Acme: the map"), the name the brand button announces ("Acme: reset the view") and the manifest's `name`. It does not replace the repo's `title`, which stays the header's text unless a `wordmark` is set. |
| `color`, `background` | hex colours, `#rgb` or `#rrggbb`. They are the manifest's `theme_color` and `background_color`, and `color` is also the tab's `<meta name="theme-color">`. Anything else (a name, `rgb()`, `#rrggbbaa`) is refused. |

**How the images are served.** Each is a same-origin URL, `/cornfield/brand/logo.svg`, `/cornfield/brand/wordmark.png`, `/cornfield/brand/favicon.png` (the extension is the file's own). Only a file the config names is served; every other path under `/cornfield/brand/`, a different extension for a configured key, and a request that tries `..` is a 404. Each is sent with its own `Content-Type` (`image/svg+xml` or `image/png`) and `X-Content-Type-Options: nosniff`, is at most **512 KB**, and has to be a plain file whose real path is inside the repo (a symlink that leads out is a 404). An SVG is sent with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, so opened on its own it runs no script and loads nothing. **An SVG is never inlined into the page**: the header and the manifest only ever point at the URL with an `<img>`, where a browser runs no script in it either. `/cornfield/config.json` carries `brand: { logo, wordmark, favicon, appName, poweredBy }` as URLs and the name, never a path on the machine.

**In the header.** The brand button keeps its place, its action (reset the view) and an accessible name (it is "cornfield: reset the view", or "<appName>: reset the view" with an `appName`); the images are decorative inside it and carry the styling hooks `data-corn="brand-logo"` and `data-corn="brand-wordmark"`. A small "powered by cornfield" link (`data-corn="powered-by"`) sits in the header's links area whenever the repo sets a `brand`.

**The manifest.** The server always answers `/manifest.webmanifest` (`application/manifest+json`), so any cornfield can be installed as an app on a phone, and the page links it with `crossorigin="use-credentials"`, so it is fetched with the sign-in cookie. It holds `name` (the `appName`, else the repo's title), `short_name` (the same, cut to 12 characters), `start_url: "/"`, `display: "standalone"`, `theme_color` and `background_color` when the config sets them, and `icons` from the favicon and the logo (a PNG with its size read from the file, an SVG as `sizes: "any"`). Without a `brand` it is the repo's title and no icons (cornfield ships no favicon of its own).

**What `cornfield validate` checks** for each of `logo`, `wordmark` and `favicon`:

- it exists, is a plain file, and stays inside the repo (a symlink that leads out is refused);
- its extension is `.svg` or `.png`, and its first bytes are what the extension says: the PNG signature and then the `IHDR` chunk for `.png`, an SVG document (`<svg`, after an optional XML declaration, comments and a doctype) for `.svg`, so a page or a script renamed to `.png` is refused;
- it is at most **512 KB**.

The server applies the same checks when it serves a file and answers 404 for one that fails.

## Strings

`strings` overrides the visible labels, so the menus speak in the repo's voice: `strings: { approve: 'Ship it', sendBack: 'Not yet' }`. A missing key keeps its default, an unknown key is refused (by `cornfield validate` and when the config loads, naming the key and listing the known ones), and a value is plain text on one line of at most 80 characters, never HTML. The keys, their defaults and the rule for accessible names are in [Theming: Words](theming.md#words).

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
