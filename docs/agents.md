# Agents: asked for, and tracked

cornfield follows coding agents by what they leave on the forge: branches, spec pull requests, pull requests. It groups them by the issue and the proposal they belong to, and marks the ones an agent made. It can also **ask** for a run ([launching](#launching-a-run)), but it never starts one: the developer's own runner does the work, with its own identity ([ADR 0012](adr/0012-cornfield-asks-runners-act.md), which supersedes [ADR 0007](adr/0007-track-agents-do-not-launch.md)). An agent started anywhere else shows up as soon as it pushes.

It is the **Agents** tab of the [issues and PRs panel](issues-and-prs.md), so it needs the same things: a `forge` in the [config](config.md) and a signed-in maintainer ([sign-in](sign-in.md)). Without them the tab is not there.

## What the tab shows

Groups, in this order:

1. **Proposal `<slug>`**: the open spec pull request that adds the proposal ([proposals](proposals.md)), and work whose branch name holds the slug.
2. **`#n` and the issue's title**: the pull requests and branches that belong to the issue, newest change first; a link out to the issue. An issue with no work is not listed.
3. **Not linked to an issue or a proposal**: everything else that is agent-made or a pull request.

Under each heading, a line counts what it holds ("2 pull requests, 1 branch, 2 by agents"). A pull request is a row like the one in the Pull requests tab: select it and its files and checks light the map. A branch that has no pull request yet is a row without a link. Work an agent made carries an **Agent** mark and the reason in words ("listed author claude-bot", "bot account dependabot[bot]", "label agent", "branch starts with claude/").

Two switches under the tabs: **Agent-made only**, and **Include merged and closed** (off: the open work only, which is what is in flight).

## Which work is linked to what

A pull request belongs to an issue when:

- its text says "Closes #n", "Fixes #n" or "Resolves #n" (also "closed", "fixed", "resolved", and lists such as "Closes #3, #4"; an issue in another repo, `owner/name#n`, is not this repo's, and a number that is one of the listed pull requests is not an issue, as the two share numbers); or
- its branch name starts a segment with the issue's number, like `claude/10-agents-tracked`, `fix/issue-10` or `10-agents`, and that number is an issue the forge listed (a date in `release/2026-10-19` is not an issue).

A pull request that names several issues is in the first one's group, and its row says "Also closes #4". A branch with no pull request is linked by its name in the same way.

A pull request belongs to a proposal when it is the **spec PR** of one (it adds or changes a proposal file in the proposals folder, as the Proposals menu lists them), or, with no issue, when its branch name holds the proposal's slug as whole words (`claude/0013-meals-impl` for `0013-meals`). A spec PR goes with its proposal even when it also closes an issue.

A branch with no pull request is listed only when it is agent-made or linked to an issue or a proposal; the rest of a repo's branches are not work in flight. A protected branch and the branch pull requests merge into are never listed.

## Which work is agent-made

The rule is yours to set in the config. All of it is empty by default, except that bot accounts count:

```js
export default {
  forge: { type: 'github', url: 'https://github.com', repo: 'owner/name' },
  agents: {
    authors: ['claude-bot'],         // pull requests opened by these accounts (case does not matter)
    labels: ['agent'],               // pull requests carrying one of these labels
    branchPrefixes: ['claude/'],     // branches (a pull request's head, or a branch with no pull request) starting so
    bots: true,                      // a bot account: a login ending in "[bot]", or what the forge calls a Bot (GitHub's user type)
  },
};
```

Work is agent-made when any of those holds, and the mark names the first that does, in this order: a listed author, a bot account, a label, a branch prefix. A branch with no pull request has no author or label in the forge's answers, so only its prefix can mark it. `validate` fails on a mistake in `agents` (an unknown key, a name with a space, `bots` that is not true or false).

With the defaults, then, `dependabot[bot]` and `renovate[bot]` are marked and nothing else; name your own agents' account, label or branch prefix to see theirs. `bots: false` leaves bot accounts unmarked.

Which accounts the forge calls bots: on GitHub, a user whose type is `Bot` (apps such as Dependabot). On Forgejo, a user whose `type` is `Bot` where the instance sends the type (Gitea's API does; an instance that does not simply marks no one that way), and always the Actions system user (id -2), which is who a workflow acts as. A login ending in `[bot]` counts on either forge.

## What it reads

One read-only route, behind the sign-in guard like the others in [issues and PRs](issues-and-prs.md#who-it-asks-as):

| Route | Answers |
|---|---|
| `GET /api/forge/work` | the newest 100 pull requests (any state, their text cut to 4000 characters), the newest 200 issues (any state), up to 300 branches, the open spec pull requests (`{ pull, slug }`), and the config's `agents` |

It is asked as the signed-in maintainer with their own token and kept for a minute in `forge_cache` like the lists, with an ETag; **Refresh** asks the forge again, and a rate-limited forge shows the last answer marked old. Nothing in this route writes to the forge. The runs come from `GET /api/agent-runs`, which reads cornfield's own file (and, on Refresh, the forge).

What is not seen: work older than the newest 100 pull requests, and an issue older than the newest 200 (a pull request that says "Closes #n" for one is still grouped, under "Issue #n", without its title; a branch name's number counts only for an issue that was listed). If the spec pull requests could not all be read, the panel says so and lists the rest.

## Launching a run

Starting an agent only **asks**. The request is the [contract's](agent-contract.md) JSON, posted as a comment on the forge by the maintainer who clicked, with their own token, so the forge shows who asked. Your runner (a Forgejo or GitHub Actions workflow on `issue_comment`, a bot, a script) picks it up; see [the maintainer rule](agent-contract.md#who-may-ask-the-maintainer-rule) it must apply first. cornfield holds no agent credentials, and a request never carries a credential.

**Where to start one.** **Start an agent …** is on an open issue in the Issues tab, and on an issue or proposal group of the Agents tab. A dialog asks for the kind of run (`code`, `summary`, `brief`, `proposal`), a profile if the config lists any, and a brief, says in words where the comment will go, and posts once. Or call the [request API](#the-request-api).

**Where the comment goes.** On the issue (or the thread: the issue or pull request whose conversation it is). For a proposal, on its open spec pull request. Without a live sign-in for the maintainer the answer is 401, as for reviews.

**What cornfield enforces**, because it controls the asking (a request written by hand on the forge bypasses all of this; the rules guard against a runaway click, not a maintainer acting on purpose). A refusal says why:

| Rule | Default | Refusal |
|---|---|---|
| open runs per repo | `agents.maxOpen`: 3 | 409 `cap-reached`, naming the runs in the way. `force` never lifts it |
| one open run per issue or proposal **and profile** | on | 409 `run-open`. `"force": true` asks for another on purpose. The same request under two profiles is two runs |
| requests per person | 6 a minute, and the panel's usual 20 actions a minute and 5 seconds between repeats | 429 with `Retry-After` |

**What counts as open.** A run is open until the runner reports `done`, `failed` or `stopped`, or its pull request is merged or closed, or nothing has happened for `agents.quietAfter` (24h): no report, no push, no pull request activity. A **quiet** run is shown as quiet and counts toward neither rule; a later report or push makes it open again.

**Config** (all under `agents`, see [config](config.md#agents)): `on` (the [triggers](#triggers)), `maxOpen`, `profiles` (names the runner maps to a model; cornfield only knows the names), `runners` (forge logins whose reports count, besides maintainers), `quietAfter`, `limits` (`{ minutes, turns, cost }`, hints the runner may enforce, shown beside what it reports) and `transport` (`'forge'` by default, or `'push'` or `'pull'`: [transports](#transports)).

### Following a run

cornfield records each request in a `runs` table and follows the run by what the forge shows plus what the runner reports:

- **The run id.** A pull request carrying `Cornfield-Run: run-…` in its body, else in a commit message, else the id in its branch name, is linked to the run. Anyone can write a trailer, so a pull request whose author is not a runner, a listed `agents.authors` account or a maintainer is linked but marked unverified, and moves nothing.
- **Reports.** A `cornfield-run` block in a comment on the run's issue or pull request (or its linked pull request) moves the state, but only from a login in `agents.runners` or a maintainer, and not from a comment edited after it was posted. A stop request is believed only from a maintainer. Every block ignored is a row in the audit table, as is every one accepted.
- **Branches.** For a run with no pull request yet, a branch whose name holds the run id is the run's, and each time its head moves that is activity (it keeps the run from going quiet). The forge does not say who pushed a branch, so this holds whoever pushed it; only a pull request is checked for a trusted author.
- **State** is derived: the runner's latest report, else the pull request (merged, closed), else quiet, with **stop requested** shown until the runner says `stopped` or the run goes quiet. A run that never reports is seen through its pull request or a branch holding its id. Checks on the pull request are shown, not counted.
- **When.** On the spec poll's timer (`hookPoll.specs`, 5 minutes by default; [hook poll](config.md#hook-poll)), and when you press **Refresh** in the Agents tab. The poll starts when a run is asked for, or after a restart that finds one to follow, and asks the forge nothing while there is none. With `hookPoll: false` runs are followed only on Refresh.
- **Restarts.** Everything seen is kept in the data file: a restart re-reads the forge, judges no comment twice and sends no [hook](config.md#hooks) twice.
- **Requests written by hand** on the forge (a maintainer's own `cornfield-run` request block, which a runner may act on with cornfield switched off) are not discovered yet: cornfield follows only the runs it asked for. Finding those is [#82](https://github.com/popcorn245/CornField/issues/82).

The Agents tab lists the runs: state, kind, what it is about, who asked and when, profile, limits beside the runner's reported tokens and cost, the runner's note, links to the request, the pull request and the runner's own logs, and **Stop**. Stop posts a `stop-requested` block in the same place, as you; the runner decides what that means. (The fuller Runs view is a later issue.) On push and pull there is no comment to post: Stop is recorded, and the runner learns of it as [below](#stopping-on-push-and-pull).

### Triggers

By default a run starts only when a maintainer asks (the button or the API). A repo may **opt in** to a few automatic requests, off unless set, in the same spirit as [`proposals.approveLands`](config.md#proposals):

```js
agents: {
  profiles: ['claude'],
  on: {
    'spec.approved': { kind: 'code', profile: 'claude' },        // approving a spec asks for a run on that proposal
    'build.opened': { kind: 'code', profile: 'claude' },         // opening the build issue asks for a run on that issue
    'thread.message': { kind: 'summary', profile: 'claude' },    // a maintainer's `/agent` comment asks for a run in that thread
  },
},
```

A trigger fires **only on something a maintainer did**, and the request names them: it is posted as that maintainer, with their own sign-in, by the same code as the button, so the forge shows who asked and **the cap, the rate limit and the one-run-per-subject rule apply unchanged**. Every automatic request also records what caused it in the [`trigger`](agent-contract.md#what-caused-an-automatic-request) field of the request: `{ event, by, ref }`, and its run is marked `trigger` in the runs list.

| Event | The request | Posted on |
|---|---|---|
| `spec.approved` | `kind` from the config, about the approved proposal | the proposal's open spec pull request |
| `build.opened` | about the build issue the maintainer just opened | that issue |
| `thread.message` | about the thread, with the `/agent` line's text as the brief | the thread |

**`/agent`.** In a thread comment (an idea's, or a spec pull request's), a line that **starts** with `/agent` is a command, and the rest of that line is the brief (`/agent summarise this for the release notes`; with none, the trigger's own `brief` if it has one). It is honoured only if all of these hold: the commenter is a maintainer **as the forge says now**; the comment was **not edited** (a few seconds of the forge's own touch-up aside); it has not been honoured before (once per comment, remembered in `cornfield.db`, so a restart does not repeat it); and it is not code. A line inside a code span, a fenced block, a quote or an indented block is never read, nor is `/agentic`. Anyone else's `/agent` does nothing at all. It is noticed when cornfield next reads the threads (the [spec poll](config.md#hook-poll), within its interval), and a trigger on `thread.message` makes that poll run even with no hook configured. Comments that were already there when the trigger was first switched on are not acted on.

**No chaining.** Nothing a run produces can start another run. This is checked three ways. Each posts nothing and sends no hook, but writes a `trigger-ignored` row to the audit table with the reason (`machine`, `run-block`, `edited` or `run-output`), so you can see why an act of yours started nothing. A comment with no `/agent` command in it writes nothing at all.

1. *Structure.* Only the three events above are wired to triggers. A run's pushes, pull request, checks, reports and state changes (`run.*`, `agent.requested`) are not, and the module that follows runs does not know triggers exist.
2. *Who.* A trigger never fires when the actor is a login in `agents.runners` or a bot account (`[bot]`, or the forge's Bot type), or when the comment holds a `cornfield-run` block.
3. *What.* A trigger never fires on a run's **output**: a run's linked pull request (in any state, whether the run is open or long over), or a pull request or issue that carries a `Cornfield-Run` id, or was written by a runner or a bot. So a run's pull request is reviewed by a person first, and the approval of **that** pull request starts nothing by itself.

A run's **target** (the thread, issue or spec pull request it was requested on) is not its output. Once every run on it is over (finished: `done`, `failed`, `stopped`, or its pull request merged or closed; or quiet), a maintainer's fresh `/agent` there, or the approval of a new head of that spec pull request, fires again. While a run on it is still open, under any profile, the trigger is skipped with `run-open`: a `trigger-skipped` row and the `trigger.skipped` hook, never in silence. A repeat of the same approval (the same head) is deduped silently. An `/agent` from someone whose permission cannot be confirmed (no maintainer signed in to ask the forge with, or the forge does not answer) is dropped with a line in the log.

**No live sign-in.** If the maintainer whose act caused the trigger is not signed in to cornfield, nothing is requested (cornfield holds no forge token of its own, and another maintainer's would put words in their name). Instead it writes a `trigger-skipped` row to the audit table, sends the [`trigger.skipped`](config.md#hooks) hook event (`reason: "no-session"`), and the Agents tab shows **"A trigger was skipped: sign in to let triggers request runs."** for the next 24 hours. A request that the cap or a limit refuses ends the same way, with that refusal as the reason (`cap-reached`, `run-open`, `rate-limited`, `forbidden`, `invalid`), and nothing is posted.

**With `proposals.approveLands`.** An approval can land the spec pull request before the trigger's request reads it. The request then finds no open proposal, and the trigger is skipped with `not-found` (the audit row and the hook). The proposal is on the default branch by then: ask for the run with the button, or set the `build.opened` trigger, which fires when the build issue is opened.

### The request API

`POST /api/agent-requests` with `Authorization: Bearer cf_at_…`, so a chat bridge can start runs. An **agent token** is made by a signed-in maintainer (the tokens dialog in the header, kind *Agent*; or `POST /api/agent-tokens { label, days? }`, same origin, shown once). It works like a [review token](proposals.md): it is the maintainer's, ends in 30 days unless asked (90 at most), can be revoked, and works only while they are signed in, as a maintainer. It is stored with the review tokens (same hashing and limits) under a *scope*: **a review token is refused here, and an agent token is refused by `POST /api/reviews`** (403, and a row in the audit table). The body is the request without what cornfield writes (`version`, `runId`, `requestedAt`) and with `force`:

```json
{ "kind": "code", "refs": { "issue": 12 }, "profile": "claude", "brief": "Add the meals page.", "limits": { "minutes": 30 }, "force": false }
```

The answer is 201 `{ ok, run, request, comment }`. `requestedBy` is the token's owner and is never taken from the body. A body with a credential in it, by key or by value, is 400 and nothing is posted. The dashboard's own routes are `GET /api/agent-runs[?follow=1]`, `GET /api/agent-runs/<runId>`, `POST /api/agent-runs` and `POST /api/agent-runs/<runId>/stop`, for a signed-in maintainer from cornfield's own page.

## Transports

`agents.transport` says how a request reaches the runner. All three carry the same [request JSON](agent-contract.md), so a runner can change transport without changing what it reads. The cap (`maxOpen`), the rate limit and the one-open-run-per-issue-or-proposal rule apply the same on every transport, and a run goes quiet after `quietAfter` on every transport.

| `transport` | what cornfield does with a request | how the runner learns of it | how it reports |
| --- | --- | --- | --- |
| `'forge'` (default) | posts it as a comment, as the maintainer who asked | a workflow, bot or script listening on the forge | a `cornfield-run` comment |
| `'push'` | records it, and sends it as a signed `agent.requested` hook event | the hook's delivery | `POST /api/runs/<runId>` with a runner token |
| `'pull'` | records it, and keeps it queued | it lists the queue with a runner token and claims one | `POST /api/runs/<runId>` with a runner token |

With `push` or `pull` **nothing is posted to the forge**: the request is a row in cornfield's data file and, on push, a hook delivery. (The run still shows on the map, and a pull request that carries its `Cornfield-Run:` trailer is linked and followed as always.) `push` and `pull` need the same things asking does, sign-in and a forge, or the server will not start; `push` also needs a hook that subscribes to `agent.requested` (or `'*'`), or the server will not start and `validate` fails. A run keeps the transport it was asked for with, so changing `agents.transport` does not strand runs in flight. **On push and pull, `cornfield-run` comments on the forge are ignored** for that run: its reports come only from the runner token that holds it.

### Runner tokens

A **runner token** (`cf_nt_…`) is the runner's credential to cornfield. A signed-in maintainer makes one in the tokens dialog (kind *Runner*) or with `POST /api/runner-tokens { label, days? }` from cornfield's own page; it is shown once, lasts 30 days unless asked (90 at most), and is revoked in the same dialog (`POST /api/runner-tokens/<id>/revoke`) at once and for good. It is stored with the other tokens under its own scope, and the scopes are kept apart both ways:

- a runner token can **list the queue, claim a request, and read and report on the runs it holds**, and nothing else. On any other route (the review API, the agent API, the dashboard's routes, the page itself) it gets 403, and a row in the audit table;
- a review or an agent token on a runner route gets 403.

The routes take the bearer token and nothing else: they read no cookie, ignore the sign-in, keep the `Host` check, and need no same-origin header. **Unlike review and agent tokens, a runner token does not act as its owner on the forge**, so cornfield does not ask the forge about the owner on each call and the owner's forge sign-in may end: the runner has its own identity. What bounds a runner token is its scope, its expiry, revoking it, and its owner staying a maintainer: **when cornfield learns an owner no longer maintains the repo** (they sign in as a reader, the 15-minute re-check of their sign-in, or any question cornfield puts to the forge with their token), **all their API tokens, runner, agent and review, are revoked at once**, with a row in the audit table; and each runner call also refuses, and revokes, when the owner's newest sign-in on record says they are not a maintainer. No sign-in on record is no answer, so a runner keeps working while its owner is away. A revoked token stays revoked if they are made a maintainer again: they make a new one.

**The queue is the repo's, not a token's:** every live runner token of the repo, whichever maintainer made it, sees every queued request and may claim it. A request holds no credential (the contract refuses one by key and by value, and the queue checks each request again before it is offered), so the queue shows what a maintainer asked for and nothing else. Treat a runner token like the forge token the runner holds: anyone with it can claim the repo's queued requests. A runner token is never in a request, a report, a hook or an answer.

### Pull

A runner asks, claims, works and reports. Every answer is JSON `{ ok, … }`, or `{ ok: false, error, code }`.

1. `GET /api/agent-requests?state=queued` lists the requests waiting: `{ ok, requests: [<request JSON>, …], limit }`, oldest first, at most 50. A request is queued until it is claimed, asked to stop, or goes quiet. (Poll every 15 to 60 seconds; a token may call 120 times a minute. An empty read is written to the audit table at most once in ten minutes.)
2. `POST /api/agent-requests/<runId>/claim` claims one, atomically. The answer is 200 `{ ok, request, run }`, and the run is now `claimed`, held by that token. **A second claim of the same request is 409** (`already-claimed`), whoever makes it, even the winner; two runners racing for one request cannot both get it. 409 also says when the request is not a pull request, was stopped, or has gone quiet.
3. `POST /api/runs/<runId>` reports, with the [report JSON](agent-contract.md#reports-and-stopping): `{ "state": "working", "note": "…", "url": "https://…/logs" }`. It is checked by the contract (an unknown state or key, a bad `url`, a count below zero, or anything shaped like a credential, by key or by value, is 400, and nothing changes). **Only the token that claimed a run may report on it or read it** (403 for another). A run that is `done`, `failed` or `stopped` takes no more reports (409). The answer is `{ ok, run }`.
4. Do the work under the runner's own identity and carry the run id forward as a `Cornfield-Run: run-…` trailer in the pull request or its commits.

A claimed run with no report within `agents.quietAfter` goes quiet as usual; a later report makes it open again. The `run.claimed`, `run.state` and `run.finished` [hooks](config.md#hooks) fire for these reports as they do for reports on the forge (the actor is `runner:<token label>`).

### Push

The existing `agent.requested` hook is the push: a POST of `{ event, at, request, actor, mapUrl }` to the configured URL, signed with `CORNFIELD_HOOK_SECRET`, retried as every hook is (see [hooks](config.md#hooks)). The runner verifies it with two checks, in this order, before it does anything:

1. **The signature.** `X-Cornfield-Signature` is `sha256=` and the hex HMAC-SHA256 of the **raw body** under the secret. Compare in constant time, on the raw bytes (not on re-serialised JSON), and refuse an `at` more than a few minutes old.
2. **The request.** `request` is the contract's request. Check it with the JSON Schema (`cornfield/agent-contract.schema.json`) (or `validateRequest` from `cornfield/core/agent-contract.js`), refuse a `version` you do not know, and apply the [maintainer rule](agent-contract.md#who-may-ask-the-maintainer-rule): the signature stands in for the author.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
import { validateRequest } from 'cornfield/core/agent-contract.js';

export function verifyPush(secret, raw, signature, maxAgeMs = 5 * 60_000) {
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  const got = Buffer.from(String(signature ?? ''));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const event = JSON.parse(raw.toString('utf8'));
  if (event.event !== 'agent.requested' || Math.abs(Date.now() - Date.parse(event.at)) > maxAgeMs) return null;
  const checked = validateRequest(event.request);
  return checked.ok ? checked.value : null;
}
```

A push has no forge comment to reply in, so the runner reports with `POST /api/runs/<runId>` and a **runner token**, the same JSON as on pull. Nothing tells a push run apart from a token (the hook went to a URL), so **the first token to report on a push run holds it**, and another token gets 403 on it; claim does not apply (409). If the delivery fails after its retries, the run stays recorded and goes quiet after `quietAfter`.

### Stopping on push and pull

A maintainer's Stop is recorded and cornfield sends the `run.stopRequested` hook (on push, the runner's own hook subscription can listen for it). A runner does not have to be pushed it: **`GET /api/runs/<runId>`** with its token answers `{ ok, run: { runId, state, reported, stopRequested, stopRequestedAt?, open, finished } }`. `state` is what cornfield shows (`claimed`, `working`, `stop-requested`, `quiet`, `done`, …) and `stopRequested` is true once a maintainer asked, so a runner checks it between steps; every report's answer carries the same `run`. The runner decides what stopping means and reports `stopped` when it has. A pull request nobody has claimed yet has no runner to ask: cornfield stops it itself (the one `stopped` it writes) and it leaves the queue. The stop's `note` is only carried on the forge transport.

### A recipe

[`examples/runner/pull-runner.mjs`](../examples/runner/pull-runner.mjs) in the repository is a dependency-free Node pull loop: it claims a request, asks an Ollama model (`POST /api/generate`, base URL from `OLLAMA_URL`) for the change, writes it as a branch, a commit and a pull request under the runner's own git identity and forge token, and reports. Read the top of the file for its environment variables. It checks every request with the contract beside it (`examples/runner/agent-contract.js`, a byte-for-byte copy of cornfield's) before it claims one, so a credential, an unknown key or an unsafe branch name is never claimed; it never pushes to the base branch and never forces a push (a branch that is already there makes it fail); it does not write through a link in its clone; and neither the runner token nor the forge token goes in the model's prompt or a note. It is a recipe, not a dependency, and is not part of the package.

## By keyboard and screen reader

The tab is a button in the panel's Show group, like the other two. Each group is a heading with the list under it, so a screen reader can move by headings; the two switches are checkboxes. Loading, a switch changing and a failure are said through the map's live region ([accessibility](accessibility.md)); the mark is the word "Agent" and its reason, not a colour. The Start an agent dialog is modal: the focus stays in it, Escape and Cancel close it and give the focus back to the button, and a refusal is read out as an alert. A run's state is a word, not a colour. On a phone it is the same bottom sheet.
