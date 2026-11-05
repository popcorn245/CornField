# Spec 0005: threads, agents and how they plug in (v2)

Status: **approved** (maintainer, 2026-11-05: "yes, get this built"). All ten questions are answered below, and [the contract](#the-contract) at the end gathers what a runner and cornfield must agree on. Per [ADR 0010](../adr/0010-cornfield-uses-its-own-gate.md), each build issue that adds or changes a module, a route, a store or a flow still carries its proposal on the map.

Issues: [#14 PIPE-01 Alignment threads](https://github.com/popcorn245/CornField/issues/14), [#19 PIPE-06 Launching agents](https://github.com/popcorn245/CornField/issues/19).

## The rule everything answers to

> The developer owns the stack. cornfield is a visual layer on top of their stuff: it shows, and it orchestrates changes to their coding system. It does not become the system.

A test for every decision below: *could the developer delete cornfield tomorrow and lose nothing but the view?*

## Decisions

### D1. cornfield asks; the developer's runner does the work (2026-11-05)

Starting an agent from cornfield only **asks**: cornfield publishes a request (the issue or proposal, the branch to use, the brief). The developer's own runner picks it up and starts whatever it likes: a Claude Code session, a CI job, Ollama on their own machine, a shell script. cornfield runs no agent process, calls no agent platform and holds no agent credentials. It sees a run by what the run leaves on the forge, plus anything the runner chooses to report back.

- **Generic by design:** the request is a documented, versioned contract that any runner in any language can implement. cornfield may ship small example runners as recipes in the docs, never as dependencies.
- **Rejected:** cornfield running a configured command (it becomes a process supervisor holding the agent's environment); cornfield calling agent platforms directly (credentials, budgets and lock-in to each vendor).
- **Passes the test:** delete cornfield and the runner, the agent and the forge are untouched.

### D2. One request schema, three transports; the forge is the default (2026-11-05)

A request reaches the runner in one of three ways, all carrying the **same versioned JSON request**, so a runner can switch transport without changing what it reads:

1. **The forge (default).** "Start an agent" leaves the request on the forge itself, where the developer's existing automation already listens (Forgejo or GitHub Actions on `issue_comment`, a bot, anything). The request is visible and audited on the forge even with cornfield gone. The exact carrier (a comment with a fenced block, a label, or both) is settled in the contract.
2. **Push.** A signed `agent.requested` event to a configured URL, through the hooks that exist (#66). Its body carries the request, so like `session.expiring` it has a body of its own rather than the proposal fields the other events share.
3. **Pull.** cornfield keeps the request; a runner asks for queued work with a runner token and claims one. Works from behind NAT.

- **Why the forge first:** it is the one thing every stack already has, and it keeps cornfield a view on top rather than a hub everything must pass through.

### D3. A run id travels as a trailer; reporting is optional and looks the same everywhere (2026-11-05)

Every request carries a **run id** that cornfield mints (`run-<ulid>`).

- **Identity:** the runner carries the id forward as a `Cornfield-Run: run-…` trailer in the PR body or its commits, the same trick as `Closes #n`. A branch name holding the id is a fallback: cornfield matches the trailer first, then the branch name. No branch naming scheme is imposed.
- **Reporting, optional:** a runner may say how it is going with a fenced block, the same pattern as reviews (ADR 0005):

  ````
  ```cornfield-run run-01JC…
  { "state": "working", "note": "tests failing on auth, retrying", "url": "https://…/logs" }
  ```
  ````

  On the forge transport it is a comment on the request; on push or pull it is the same JSON sent to cornfield with the runner token. States: `claimed`, `working`, `done`, `failed`, `stopped`.
- **A silent runner is fine:** a run that never reports still appears through what it pushes.

### D4. cornfield asks to stop and limits how often it asks; the runner enforces the rest (2026-11-05)

- **Stop** sends a stop request for the run id over the same transport and in the same block (`"state": "stop-requested"`). The runner decides what stopping means; cornfield shows "stop requested" until the runner reports `stopped` or the run goes quiet.
- **Limits are hints:** a request carries optional `limits: { minutes, turns, cost }` from config defaults, editable per request. The runner enforces them or not; cornfield shows them beside what the runner reports.
- **What cornfield enforces, because it controls the asking:**
  - **at most 3 open runs per repo by default** (configurable); a request past the cap is refused with the reason;
  - a per-maintainer rate limit on requests, like the review flood limits;
  - **one open run per issue or proposal** unless the maintainer asks for another on purpose.
- **Cost** is shown only when the runner reports `tokens` or `cost`. cornfield never estimates.

### D5. No credentials in a request; the forge's permissions are the boundary (2026-11-05)

- **A request carries no credentials.** The runner pushes and opens pull requests under its **own** identity (a bot account, a deploy key, a CI token), which is also what the Agents tab marks as agent-made.
- **A request is made as the maintainer who clicked.** On the forge transport it is posted with that maintainer's own token, as reviews are, so the forge shows who asked and keeps the record.
- **The runner acts only on a request whose author is a maintainer now.** This is the same rule reviews follow. The example recipes check it in their first lines, and the docs say it plainly: without it, anyone who can comment could start an agent.
- **A request written by hand on the forge counts.** Any maintainer-authored request block is a real request, so the whole system can be driven with cornfield switched off. cornfield is only a convenient way to write one. Such a request bypasses all three of D4's limits (the cap, the rate limit and one run per issue or proposal), since cornfield never sees it before the runner does; they guard against a runaway click, not against a maintainer acting on purpose. cornfield still shows the run once it sees it, collision marks included (D9).
- **Push and pull:** requests are HMAC-signed with a secret from the environment, as hooks are (`CORNFIELD_HOOK_SECRET`, #66). Pull uses **runner tokens**, minted and revoked in the dashboard like review tokens (#67), that may only read and claim requests and report on their runs.

### D6. A thread is a forge conversation, and every step has a hook (2026-11-05)

This changes the earlier plan (the vision, the roadmap, #14 and [ADR 0003](../adr/0003-own-server-sqlite-forge-adapters.md), which listed threads among what the SQLite file holds) to keep threads in cornfield's SQLite file. That would fail the test above. ADR 0003 carries an amendment saying so.

- **An idea is an issue, and its thread is that issue's comments.** A proposal's thread is its spec pull request's conversation. cornfield adds structure with fenced blocks, as reviews and runs do. SQLite only caches.
- **Writing into a thread needs nothing from cornfield.** People, agents and bridges comment on the forge as themselves. A busy agent posts summaries and links to its own logs (`url`), not every step.
- **Every step is a hook**, so programs can wire threads, runs and reviews into anything (a chat, a pipeline, a notifier). These events are added to the hooks of #66, with the same signing, retries and audit:
  - **Threads:** `thread.opened`, `thread.message`, `thread.linked` (a thread now points at nodes, a proposal or a run).
  - **Runs:** `agent.requested`, `run.claimed`, `run.state` (any reported change), `run.stopRequested`, `run.finished`.
  - **Already shipped:** `spec.ready`, `spec.approved`, `spec.sentBack`, `build.opened`, `pr.landed`, `session.expiring`.

  Where cornfield only learns of a forge event by looking, it fires the hook when it next looks, as `spec.ready` does with the spec poll (#72). That poll grows to cover threads and runs.

### D7. Threads point at the map with mentions; links are conventions, not machinery (2026-11-05)

- **People write `[[…]]` in prose,** holding a node id (`[[core-server-auth]]`) or a repo path (`[[server/auth.js]]`). cornfield resolves either to its node. A mention that resolves to nothing stays plain text. It still reads sensibly on the forge without cornfield.
- **Tools and agents may write a fenced block,** `cornfield-thread { "nodes": [...], "proposal": "<slug>" }`, for precise links.
- **Links are conventions:**
  - a spec pull request names its thread with `Thread: #n` or `Closes #n`;
  - a run started from a thread posts its request *in* that thread, so the comment is the link;
  - viewing a thread lights every node it mentions, and a node's panel lists the threads that mention it.

### D8. cornfield holds no model; thinking is a run, and models are profiles the runner resolves (2026-11-05)

- **No model config in cornfield, ever:** no provider, no `baseUrl`, no keys.
- **What cornfield would "think" about is a request too.** Summarising a thread, drafting a brief or turning a thread into a proposal is a request with a `kind` (`code`, `summary`, `brief`, `proposal`) that the runner does with whatever model it likes.
- **Requests carry an optional `profile`** from a list the developer names (`agents.profiles: ['claude', 'local-qwen']`). The runner maps each name to a model, a machine and a budget; cornfield only knows the name.
- **Side by side:** the same request started under two profiles is two runs, shown next to each other (branches, checks, any reported cost, and their diffs on the map). That answers the #14 comment about starting on Claude, moving to Ollama, and running both in parallel to compare.

### D9. What cornfield shows of a run: the map in flight, never the logs (2026-11-05)

- **Runs in flight on the map.** Nodes an open run is changing pulse, worked out from the branch diff each time it pushes. Before the first push, the nodes come from what the request was about (the proposal, or the thread's mentions).
- **Collisions.** Two open runs touching the same node both carry a warning mark. Refusing a request whose nodes overlap an open run is an option, **off by default**.
- **A Runs view** in the Agents tab. It shows each run's state, profile, limits beside what was reported, the thread it came from, its branch and pull request, and its checks. Runs of the same request under two profiles sit side by side.
- **A timeline per run:** requested, claimed, the runner's reports, pushes, the pull request, checks, review, landed. It is built from forge events plus whatever the runner reports.
- **Not shown:** live logs, because the runner's `url` links out to its own; and chat with an agent inside cornfield, because talking to a run is commenting in its thread on the forge (D6).

### D10. Requests by click, by API, or by opt-in trigger; a run never triggers another (2026-11-05)

- **By click or by API.** A maintainer requests a run with a button, or with a request API that a maintainer-minted token can call, as the review API does (#67), so a chat bridge can start runs.
- **Opt-in triggers,** off by default, in the same pattern as `approveLands`:

  ```js
  agents: { on: { 'spec.approved': { kind: 'code', profile: 'claude' } } }
  ```

  A trigger may fire only on an event a maintainer caused: `spec.approved`, `build.opened`, or a `thread.message` holding an explicit `/agent` command from a maintainer. Every automatic request names the maintainer whose act caused it, and the cap and the one-run-per-issue rule still apply.
- **No chaining.** A run's own output (its pushes, pull request, checks or reports) never fires another automatic request. A run's pull request is reviewed by a person, or through the review API, before anything else fires. That is how a fleet is kept from talking to itself.
- **ADRs.** ADR 0007 ("tracks agents, does not launch them") is superseded by [ADR 0012](../adr/0012-cornfield-asks-runners-act.md), accepted with this spec. [ADR 0006](../adr/0006-safe-actions-only.md) gains two safe actions, recorded there as an amendment: ask a runner to start or stop a run, and open an idea issue or post a request in a thread. Each is posted as the maintainer and only ever asks.

## The questions, as they were asked

Each was answered in turn; the answers are the decisions above.

1. ~~Where an agent runs, and what "launch" means for cornfield.~~ D1.
1a. ~~How a request reaches the runner.~~ D2.
2. ~~What an agent run is, as cornfield sees it.~~ D3.
3. ~~How a run is stopped, limited and paid for.~~ D4.
4. ~~Whose credentials an agent uses.~~ D5.
5. ~~What a thread is, and where its messages live.~~ D6.
6. ~~Who writes in a thread, and how.~~ D6: anyone, on the forge, as themselves.
7. ~~How a thread connects to issues, nodes, proposals and runs.~~ D7.
8. ~~Models.~~ D8.
9. ~~What cornfield shows of a run while it is going.~~ D9.
10. ~~The safe-actions line for v2, and automation.~~ D10.

## The contract

What D2 to D5, D8 and D10 imply, gathered for whoever builds a runner or cornfield's side of it. It restates the decisions, plus three points the PM settled when the spec was approved (marked **PM, 2026-11-05**). Anything still open is marked **settle in build**: the first build issue that needs it decides it, and writes it into the runner docs.

### The request (JSON, version 1)

One JSON object, the same on every transport (D2):

| Field | What it is | From |
|---|---|---|
| `version` | `1`. A runner refuses a version it does not know. | D2 |
| `runId` | `run-<ulid>`, minted by cornfield, or by whoever writes the request by hand. | D3 |
| `kind` | `code`, `summary`, `brief` or `proposal`. | D8 |
| `profile` | optional: one name from `agents.profiles`, which the runner maps to a model, a machine and a budget. cornfield knows only the name. | D8 |
| `issue`, `proposal`, `thread` | what the run is about: an issue number, a proposal slug (with its spec PR), a thread (the issue or PR whose comments it is). At least one; which combinations are allowed is **settle in build**. | D1, D7 |
| `branch` | optional: a branch hint. The runner may use another; cornfield imposes no naming scheme. | D1, D3 |
| `brief` | the text the runner hands to its agent. | D1 |
| `limits` | optional: `{ minutes, turns, cost }`, hints from config defaults, editable per request. The runner enforces them or not. | D4 |
| `requestedBy` | the maintainer who asked: the one who clicked, the token's owner (API), or whose act fired a trigger. | D5, D10 |

A request never holds a credential (D5). Still **settle in build**: the config keys for the limit defaults and the open-run cap; whether an automatic request also names the event that fired it; a timestamp field; and the field names for the issue, proposal and thread references.

### Where a request is put

- **Forge (default).** Posted as a comment by the requesting maintainer, with their own forge token, as reviews are (D5). That needs the maintainer's live sign-in, as review tokens do (#67, #73); `session.expiring` warns a day ahead. The carrier (a fenced block, a label, or both) is **settle in build** (D2 leaves it open). Where the comment goes: in the thread it came from (D7). For a request made elsewhere, the issue or the spec PR it is about is **settle in build**.
- **Push.** The `agent.requested` hook event, signed with `CORNFIELD_HOOK_SECRET` like every hook (#66), its body holding the request. The exact body is **settle in build**.
- **Pull.** cornfield keeps the request; a runner token lists queued requests and claims one (D2, D5). The endpoints are **settle in build**.
- **The runner's rule:** act only on a request whose author is a maintainer of the repo *now* (D5), the rule reviews follow (ADR 0005). On push and pull, the signature or the token stands in for the author.

### The run id on the forge

The runner carries the id forward as a trailer in the pull request's body or in its commits:

```
Cornfield-Run: run-01JC…
```

cornfield matches the trailer first, then a branch name that holds the id (D3).

### Reports: the `cornfield-run` block

A fenced block whose info string names the run, holding one JSON object (D3):

````
```cornfield-run run-01JC…
{ "state": "working", "note": "tests failing on auth, retrying", "url": "https://…/logs" }
```
````

- `state` (required): one of `claimed`, `working`, `done`, `failed`, `stopped`, written by the runner. `stop-requested` is the one state cornfield writes (below).
- `note` and `url` are optional, and so are `tokens` and `cost`, the only figures cornfield shows about cost; it never estimates (D4).
- On the forge it is a comment on the request; on push or pull it is the same JSON sent to cornfield with the runner token.
- Reporting is optional: a silent run is seen through its pushes (D3).
- **Whose reports count (PM, 2026-11-05).** On the forge transport, cornfield believes a `cornfield-run` block only from an account listed in a new config key, `agents.runners: ['login', …]` (the runners' own forge identities), or from a maintainer. A block from anyone else is ignored, and the ignoring is a row in the audit table. On push and pull, the runner token decides instead.
- **When a run stops counting as open (PM, 2026-11-05):** after `done`, `failed` or `stopped`; when its pull request is merged or closed; or after a quiet period with no report, push or pull request activity, `agents.quietAfter`, by default **24h**. A quiet run is shown as **quiet** and no longer counts toward the cap or the one-run-per-issue rule. A later report or push makes it open again.

### Stopping a run

A stop is the same block with `"state": "stop-requested"`, sent for the run id over the transport the request used, as the maintainer who clicked (D4). The runner decides what stopping means. cornfield shows "stop requested" until the runner reports `stopped` or the run goes quiet (`agents.quietAfter`, below). A runner should honour a stop only from a maintainer, as it does a request (D5).

### What cornfield enforces, and what it only shows

- **Enforced, on requests cornfield makes** (button, API, trigger): at most 3 open runs per repo by default (configurable), a per-maintainer rate limit, and one open run per issue or proposal unless asked on purpose (D4, D10). A refusal says why. A request written by hand on the forge bypasses all three (D5).
- **Triggers** fire only on `spec.approved`, `build.opened`, or a maintainer's `thread.message` holding `/agent`; never on a run's own output (D10). A `thread.message` is seen when cornfield next looks (D6), so a trigger fires within the poll interval, and the request is posted as the maintainer whose act caused it. **When that maintainer has no live sign-in (PM, 2026-11-05)**, the trigger does nothing: no request is made, and an audit row says so. The PM asked for a comment in the thread or issue as well ("sign in to cornfield to let this trigger request a run"), as landing on approval does; but landing on approval posts nothing in that case, because cornfield holds no forge token of its own and posting with another maintainer's would put words in their name. So the comment is **settle in build**: post it once that maintainer next signs in, or show the notice in the dashboard instead.
- **Shown, never enforced:** the limits beside what the runner reports, cost only as reported, and stop requested (D4).
