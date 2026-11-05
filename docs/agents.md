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

**Config** (all under `agents`, see [config](config.md#agents)): `maxOpen`, `profiles` (names the runner maps to a model; cornfield only knows the names), `runners` (forge logins whose reports count, besides maintainers), `quietAfter`, `limits` (`{ minutes, turns, cost }`, hints the runner may enforce, shown beside what it reports) and `transport` (`'forge'`; push and pull come later).

### Following a run

cornfield records each request in a `runs` table and follows the run by what the forge shows plus what the runner reports:

- **The run id.** A pull request carrying `Cornfield-Run: run-…` in its body, else in a commit message, else the id in its branch name, is linked to the run. Anyone can write a trailer, so a pull request whose author is not a runner, a listed `agents.authors` account or a maintainer is linked but marked unverified, and moves nothing.
- **Reports.** A `cornfield-run` block in a comment on the run's issue or pull request (or its linked pull request) moves the state, but only from a login in `agents.runners` or a maintainer, and not from a comment edited after it was posted. A stop request is believed only from a maintainer. Every block ignored is a row in the audit table, as is every one accepted.
- **Branches.** For a run with no pull request yet, a branch whose name holds the run id is the run's, and each time its head moves that is activity (it keeps the run from going quiet). The forge does not say who pushed a branch, so this holds whoever pushed it; only a pull request is checked for a trusted author.
- **State** is derived: the runner's latest report, else the pull request (merged, closed), else quiet, with **stop requested** shown until the runner says `stopped` or the run goes quiet. A run that never reports is seen through its pull request or a branch holding its id. Checks on the pull request are shown, not counted.
- **When.** On the spec poll's timer (`hookPoll.specs`, 5 minutes by default; [hook poll](config.md#hook-poll)), and when you press **Refresh** in the Agents tab. The poll starts when a run is asked for, or after a restart that finds one to follow, and asks the forge nothing while there is none. With `hookPoll: false` runs are followed only on Refresh.
- **Restarts.** Everything seen is kept in the data file: a restart re-reads the forge, judges no comment twice and sends no [hook](config.md#hooks) twice.
- **Requests written by hand** on the forge (a maintainer's own `cornfield-run` request block, which a runner may act on with cornfield switched off) are not discovered yet: cornfield follows only the runs it asked for. Finding those is [#82](https://github.com/popcorn245/CornField/issues/82).

The Agents tab lists the runs: state, kind, what it is about, who asked and when, profile, limits beside the runner's reported tokens and cost, the runner's note, links to the request, the pull request and the runner's own logs, and **Stop**. Stop posts a `stop-requested` block in the same place, as you; the runner decides what that means. (The fuller Runs view is a later issue.)

### The request API

`POST /api/agent-requests` with `Authorization: Bearer cf_at_…`, so a chat bridge can start runs. An **agent token** is made by a signed-in maintainer (the tokens dialog in the header, kind *Agent*; or `POST /api/agent-tokens { label, days? }`, same origin, shown once). It works like a [review token](proposals.md): it is the maintainer's, ends in 30 days unless asked (90 at most), can be revoked, and works only while they are signed in, as a maintainer. It is stored with the review tokens (same hashing and limits) under a *scope*: **a review token is refused here, and an agent token is refused by `POST /api/reviews`** (403, and a row in the audit table). The body is the request without what cornfield writes (`version`, `runId`, `requestedAt`) and with `force`:

```json
{ "kind": "code", "refs": { "issue": 12 }, "profile": "claude", "brief": "Add the meals page.", "limits": { "minutes": 30 }, "force": false }
```

The answer is 201 `{ ok, run, request, comment }`. `requestedBy` is the token's owner and is never taken from the body. A body with a credential in it, by key or by value, is 400 and nothing is posted. The dashboard's own routes are `GET /api/agent-runs[?follow=1]`, `GET /api/agent-runs/<runId>`, `POST /api/agent-runs` and `POST /api/agent-runs/<runId>/stop`, for a signed-in maintainer from cornfield's own page.

## Runs on the map

An open run's nodes **pulse** on the map, and where two open runs change the same node, both are marked. The marks are a layer of their own over the map, **Runs in flight** in the Layers menu (on unless turned off), and they follow the camera in every view.

- **Which nodes.** Once a run has a branch or a pull request from a runner, the nodes are those its changed files are on (`nodesForFile`, as for any pull request): the pull request's files, or a comparison of the branch with the base branch. The files are read once for each head sha and kept (`run_reads`), so a push is one more read. Before the first push: the `nodes` the request names, and the `[[mentions]]` in the opening post of its issue, thread or proposal's pull request. A forge that cannot list the files of a comparison (Forgejo before it does) leaves a branch with no pull request on the request's nodes.
- **Collisions.** Two open runs that share a node each carry `collidesWith: [run id]` in the API. A finished or quiet run marks nothing. On the map a collision is a **dashed ring, a ⚠ sign and the words "Collision · 2 runs"**, so it does not rest on colour; an in-flight node is a pulsing ring, which is a still, thicker ring under `prefers-reduced-motion`, never motion.
- **Refusing.** `agents.refuseCollisions: true` refuses a request whose `nodes` overlap an open run's (409, code `collision`, naming the node and the run), in the same transaction as the cap check; `force` does not lift it. Only the nodes a request names are checked, so a request with no `nodes` is never refused for this. Off by default.
- **The Runs view** (the Agents tab) shows for each run its state as a word, its profile, its limits beside what was reported (cost and tokens come from the runner's report; minutes and turns are limits the runner is asked to keep and are not reported back), its thread, branch and pull request, a checks summary, the nodes, any collision, and the runner's own link as **Runner's log**. cornfield streams no log: the runner keeps them. **Light on the map** lights the run's nodes like a pull request.
- **Side by side.** Runs of the same subject, kind and brief under different profiles, asked for within three minutes of each other, are one **compare**: two columns on a wide screen, stacked on a narrow one.
- **Timeline.** Each run's **Timeline** is an ordered list with times: requested, claimed, each report with its note (escaped), pushes, the pull request opened, checks, a stop request, landed or closed, and quiet. It is built from `run_events` (one row for each thing, so looking again adds none) and from the request itself. cornfield reads no reviews from the forge yet, so a "review" entry appears only when something records one.

The API's `GET /api/agent-runs` and `GET /api/agent-runs/<id>` carry `nodes`, `nodesFrom` (`files` or `request`), `collidesWith`, `brief` (the first 2000 characters) and `timeline` on each run.

## By keyboard and screen reader

The tab is a button in the panel's Show group, like the other two. Each group is a heading with the list under it, so a screen reader can move by headings; the two switches are checkboxes. Loading, a switch changing and a failure are said through the map's live region ([accessibility](accessibility.md)); the mark is the word "Agent" and its reason, not a colour. The Start an agent dialog is modal: the focus stays in it, Escape and Cancel close it and give the focus back to the button, and a refusal is read out as an alert. A run's state is a word, not a colour. On a phone it is the same bottom sheet.

The runs view is buttons and an ordered list: **Light on the map** is a toggle button (pressed when lit), **Timeline** a button that says whether it is expanded, and the timeline is a list named for its run, oldest first. A change of a run's state, or a collision begun or cleared, is said through the live region (the runs are read again every minute while one is open). The marks over the map are decoration (`aria-hidden`); the Runs view says the same in words.
