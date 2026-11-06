# The agent contract (version 1)

cornfield **asks**; the developer's own **runner** does the work. A runner is whatever starts an agent for you: a Claude Code session, a CI job, Ollama on your own machine, a shell script. cornfield runs no agent process, calls no agent platform and holds no agent credentials. This page is everything a runner needs to implement, in any language. The decisions behind it are [spec 0005](specs/0005-threads-and-agents.md) (its "The contract" section is what this page builds) and [ADR 0012](adr/0012-cornfield-asks-runners-act.md). The code that cornfield itself uses to write and read the contract is [core/agent-contract.js](../core/agent-contract.js); a [JSON Schema](../core/agent-contract.schema.json) (draft 2020-12) describes the same JSON, and a test keeps the two in agreement. The schema ships in the npm package: `import schema from 'cornfield/agent-contract.schema.json' with { type: 'json' }`.

A test for every part of it: could you delete cornfield tomorrow and lose nothing but the view? A request is a comment on your forge that a person can write by hand, so yes. Two complete runners, for Forgejo Actions and GitHub Actions, are in [Example runners](runners.md).

## Run ids

Every request has a run id that cornfield mints (or that a person writes by hand): `run-` and a 26 character [ULID](https://github.com/ulid/spec) in Crockford base32 (digits and capital letters, never `I`, `L`, `O` or `U`), like `run-01JC8Z3Q5M7VXK2RT9N4B6HDEF`. The first ten characters are the time in milliseconds, so ids sort by when they were minted; the first of the 26 is `0` to `7`. The pattern is `^run-[0-7][0-9A-HJKMNP-TV-Z]{25}$`.

## The request

One JSON object. Every key not listed here is refused, and so is any key named like a credential.

| Field | Type | |
| --- | --- | --- |
| `version` | `1` | The only version. |
| `runId` | run id | Must be the id in the fence that holds it. |
| `kind` | `code`, `summary`, `brief` or `proposal` | What is asked for. `code` makes a branch and a pull request; the others are thinking (summarise a thread, draft a brief, turn a thread into a proposal) that the runner does with whatever model it likes and answers on the forge. |
| `profile` | name, optional | One of the names the developer configured (`agents.profiles`). The runner maps it to a model, a machine and a budget; cornfield knows only the name. Letters, digits and `. _ -`, up to 64. |
| `refs` | `{ issue?, proposal?, pull?, thread? }` | What the run is about; at least one of `issue`, `proposal` and `thread`. `issue`, `pull` and `thread` are numbers from 1, `proposal` is the proposal's name (`0014-planner`), and `pull` is the spec pull request that holds it (so it only comes with `proposal`; an approved proposal already on the default branch has none). |
| `branch` | string, optional | A hint for the branch to use. A safe git ref name: letters, digits and `. _ - /`; no leading dash or slash, no `..`, no empty part, no part that starts with a dot or ends in `.lock`, no trailing dot; up to 200 characters. A runner may ignore it. |
| `brief` | string | What to do, up to 20000 characters; required, and may be empty (a summary of a thread needs only the thread). Treat it as untrusted text: it may have been written by anyone a maintainer relayed. |
| `limits` | `{ minutes?, turns?, cost?, tokens? }`, optional | Hints, never enforced by cornfield. `minutes` and `cost` are numbers above zero, `turns` and `tokens` whole numbers above zero (`tokens` is an optional key added after version 1 shipped; a runner that does not know it should ignore it). `cost` is in the currency the runner reports. The runner enforces them or not. |
| `nodes` | list of node ids, optional | Map nodes the run is expected to touch (`core-server-auth`), up to 100. |
| `requestedBy` | forge login | The maintainer who asked. |
| `requestedAt` | UTC time | Like `2026-11-05T09:30:00Z` (milliseconds allowed). |
| `trigger` | `{ event, by, ref }`, optional | Only on an automatic request: what caused it. See [below](#what-caused-an-automatic-request). |

### What caused an automatic request

A request made by an opt-in [trigger](agents.md#triggers) (`agents.on`) carries `trigger: { event, by, ref }`, so the runner and the people reading the forge can see it was not a click:

```json
"requestedBy": "maintainer-one",
"requestedAt": "2026-11-05T09:30:00Z",
"trigger": { "event": "spec.approved", "by": "maintainer-one", "ref": "pull:40" }
```

| Key | |
| --- | --- |
| `event` | `spec.approved`, `build.opened` or `thread.message`: the only three events a trigger fires on, each a maintainer's act. |
| `by` | The maintainer whose act caused it. It is always the same as `requestedBy`: the request is posted as them. |
| `ref` | `pull:<number>` (the spec pull request approved), `issue:<number>` (the build issue opened) or `comment:<id>` (the comment that held `/agent`). |

The field is optional (a request from a click or the API has none), strict (no other key, and the three values must have these shapes) and, like everything in a request, never a credential. It records a cause; it grants nothing: a runner applies the same [maintainer rule](#who-may-ask-the-maintainer-rule) to an automatic request as to any other, and cornfield only ever writes `trigger` itself (a body sent to the dashboard or the request API with a `trigger` key is refused). A runner must never treat a run's own output as a cause: cornfield does not.

**A request never carries a credential.** No token, key, secret or password: the runner pushes and opens pull requests under its **own** identity (a bot account, a deploy key, a CI token). Prose about tokens and passwords is fine; only a value shaped like one is refused. A field whose name contains `token`, `secret`, `passw`, `credential`, `api_key`, `access_key`, `private_key`, `ssh_key`, `authorization`, `bearer` or `cookie` (any case) is refused, and so is a text value shaped like a credential (a GitHub, GitLab, OpenAI or Anthropic key, an AWS key id, a Slack token, a JWT, a private key header, a bearer header, or a link with a user and password in it). The refusal names the field.

## The fenced block

A request, a report, a stop request and an answer all travel in one form, the same pattern as a review ([ADR 0005](adr/0005-reviews-are-pr-comments.md)): a line a person can read, then a fenced block whose tag is `cornfield-run` and whose info string is the run id.

````
Asked for a code run `run-01JC8Z3Q5M7VXK2RT9N4B6HDEF` on issue #12 (maintainer-one, in cornfield).

```cornfield-run run-01JC8Z3Q5M7VXK2RT9N4B6HDEF
{
  "version": 1,
  "runId": "run-01JC8Z3Q5M7VXK2RT9N4B6HDEF",
  "kind": "code",
  "refs": { "issue": 12 },
  "requestedBy": "maintainer-one",
  "requestedAt": "2026-11-05T09:30:00Z"
}
```
````

Reading is tolerant of the text around a block and strict about what is inside:

- The fence starts a line (a quoted `> ```cornfield-run` or an indented one is not a block), is exactly three backticks, names a run id, and ends with a line of three or more backticks and nothing else. Windows line endings are fine. A block nobody closed is not one.
- Fences are read as Markdown reads them: a block **inside another fence** (an example in a ```` fence or a `~~~` one, or text in a ```` ```js ```` block) is part of that fence's text, never a block of its own. So a comment can show an example without asking for a run.
- A block holds **exactly one JSON object**: a list, two objects, text that is not JSON, an unknown key or a bad value refuses the whole block. A refused block is skipped, never half-read.
- Which of the four it is follows its shape: a `version` makes it a request, the state `stop-requested` a stop request, the state `answered` an answer, any other `state` a report.
- A comment is read for at most 20 blocks, a block holds at most 60000 characters, and a comment written by cornfield is at most 60000 characters.
- When there are several blocks for a run, **the latest one wins**. A comment edited after it was posted should not be trusted, as reviews are not.

The human line above the block is for people. cornfield **defuses** it (a zero-width space after every `@`, `#`, `://` and `www.`), so it pings and links nobody; the JSON keeps every value as sent. A runner that posts a block should do the same to its own line and never put a mention in it.

## Reports, stopping and waiting

A runner may say how it is going. Reporting is optional: a run that stays silent still shows up through what it pushes. A report is a comment (or, on push and pull, the same JSON sent to `POST /api/runs/<runId>` with a runner token, without the fence) holding a block for the run id:

````
```cornfield-run run-01JC8Z3Q5M7VXK2RT9N4B6HDEF
{ "state": "working", "note": "tests failing on auth, retrying", "url": "https://ci.example.com/runs/42" }
```
````

| Field | | |
| --- | --- | --- |
| `state` | required | `claimed`, `working`, `waiting`, `done`, `failed` or `stopped`. |
| `note` | optional | Up to 4000 characters. Shown quoted. |
| `url` | optional | Where the runner keeps its logs; `http` or `https`, no user and password in it, no credential in its query. cornfield links out and never shows logs. |
| `tokens` | optional | A whole number, zero or more: what the run has used so far. |
| `cost` | optional | A number, zero or more: what the run has cost so far, in your currency. Shown as sent; cornfield never estimates. |

A report's `tokens` and `cost` are the run's totals so far, not an increment: a later report replaces an earlier one (a report that leaves one out keeps the earlier value). cornfield adds the runs up per proposal and per day ([agents](agents.md#totals-of-tokens-and-cost)); send the same running total each time, and each run counts once.

**Stopping.** cornfield asks a run to stop with the same block and `{ "state": "stop-requested" }`, with an optional `note` and nothing else. The runner decides what stopping means. cornfield shows "stop requested" until the runner reports `stopped` or the run goes quiet. `stop-requested` is not a state a runner reports.

**Waiting.** A runner that has to stop and ask ("plan ready, approve to build", "needs a decision") reports `waiting`, with the usual `note` (the question) and `url` (a link to the plan or the question). Like every state beyond `claimed` and `done` it is optional: a runner that never waits never sends it, and the contract version stays 1. A waiting run is **open**: it is not finished, it counts toward the cap, and it is **exempt from `agents.quietAfter` while it waits**, because a human owes it an answer, so it never goes quiet however long the answer takes and the runner need not report again to keep it. Quiet applies again once the runner reports anything else (`working`, `done`, `failed`, …) or a maintainer asks it to stop. cornfield shows it as the word "Waiting" with the note and the link. `waiting` is not a stop, and nothing in cornfield times it out.

**Answering.** A maintainer answers from the Runs view with **Continue**, **Stop** or a **Reply** (text). The answer is the same block, one more shape: `{ "state": "answered", "action": "continue" | "stop" | "reply", "text"? }`, with nothing else. A `reply` must have a `text` (up to 4000 characters); on the other two it is optional. The text is the maintainer's words to the runner and stays with the run: it travels in the block only (the comment's human line says the action, never the words), and it is never in a hook or an audit row. It carries no credential, like every block: a key named like a credential or a value shaped like one refuses it. What it asks: `continue` go on; `reply` go on, with the maintainer's words; `stop` the same as a stop request (cornfield also sends the stop request itself, so a runner that only knows how to stop need not read answers). The runner decides what each means and reports `working` (or `stopped`, `failed`, `done`) when it has the answer.

- **Forge.** cornfield posts the answer block as a comment on the run's thread, as the maintainer who clicked (a Stop is posted as the stop request). Anyone else's answer block is ignored; so is an edited comment, and one for a run that is not waiting. A maintainer may also answer by hand with such a block.
- **Pull and push.** The answer is kept on the run and comes back the way a stop does, through `GET /api/runs/<runId>`: `answer: { action, text?, at, by }`, where `at` is when it was given and `by` the maintainer. Every report's answer carries the same `run`. There is one answer at a time: **a second answer replaces the first**, until the runner reports something other than `waiting`. The answer stays readable after that, so a runner that reads late still sees it; a **new** wait (a `waiting` report after another state) clears it, and a `waiting` report while already waiting (a heartbeat) keeps it. A runner compares `at` with the last answer it handled.
- A run that is not waiting takes no answer (409), nor does one that is over or was asked to stop; a Stop answer to a run that is not waiting is that 409 too, not a stop (a plain Stop is the way). One answer to a run is taken at a time: a second sent while the first is being taken is 429, and sent again it replaces the first; the timeline keeps both.

## The trailer

The runner carries the run id forward so cornfield can tell which pull request a run made. In the pull request body, or in any of its commit messages, on a line of its own:

```
Cornfield-Run: run-01JC8Z3Q5M7VXK2RT9N4B6HDEF
```

The key is read in any case; the line holds nothing else (a quoted line, or a line with other words, does not count); a line inside a fenced code block, or indented as code (a tab, or four spaces), does not count either, so a pull request can show the trailer as an example; when there are several, the last one wins. cornfield looks for the trailer in the pull request body first, then in the latest commit message that has one, and then falls back to a run id in the **branch name**, as a whole segment (`agent/run-01JC8Z3Q5M7VXK2RT9N4B6HDEF/fix`, `fix-run-01JC…`; not part of a longer word, and a lower-cased id is forgiven because branch names often are). No branch naming scheme is imposed.

## Who may ask: the maintainer rule

**A runner acts only on a request whose author is a maintainer now.** On the forge transport the request is a comment, and anyone who can comment can write a block that looks right. Without this rule, anyone who can comment could start an agent. So, before doing anything:

1. Take the comment that holds the block, and its author's login (the forge says; never the `requestedBy` inside the block, which is only a claim).
2. Ask the forge for that login's permission on the repo **now**, not when they last commented. Only `admin` and `maintain` count (cornfield's own definition of a maintainer); `write` does not.
3. Ignore the comment otherwise, and ignore it too if it was edited after it was posted (someone with write access can edit anyone's comment). A maintainer who changes their mind posts a new one.
4. Only then read the block, and apply your own limits.

A request a maintainer wrote by hand counts as much as one cornfield wrote: the whole system can be driven with cornfield switched off. Such a request bypasses cornfield's cap on open runs and its rate limits; those guard against a runaway click, not against a maintainer acting on purpose. cornfield, when it discovers such a request (in a comment, never in an issue or pull request body) to list and follow it, does apply its cap and its one-run-per-subject rule, not its rate limit, to what it lists, and sends it on by `agents.transport` like any run: on push as an `agent.requested` event, on pull into the runner queue, where a runner token claims and reports on it ([agents](agents.md#requests-written-by-hand)). The comment stays the record on every transport. A request it declines to list is still the runner's to act on, cornfield only does not follow it. A run's own output (its pushes, pull request, checks and reports) never starts another run.

Two further rules for a runner. Treat the brief as untrusted input: it can say anything. And only a report from a run's own runner is a report: on the forge, cornfield believes a `cornfield-run` block only from a login listed in `agents.runners` (the runners' own forge identities) or from a maintainer, and writes an audit row for each one it ignores; on push and pull, the runner token decides (spec 0005, "Reports").

## Transports

All three carry the same JSON, so a runner can switch transport without changing what it reads. The forge is the default; `agents.transport` picks another ([agents](agents.md#transports) has the details and the routes).

1. **The forge.** "Start an agent" (or `POST /api/agent-requests`) posts the comment above, with the maintainer's own token (`requestedBy` is that maintainer), on the issue or thread (or the spec pull request, for a proposal). Precisely, cornfield posts it on `refs.thread` if there is one, else on the open spec pull request holding `refs.proposal` (named in `refs.pull`), else on `refs.issue`; the human line says it came through the API when it did, naming the token's label. cornfield records each request, follows the run and reads its reports as described in [agents](agents.md#launching-a-run); the stop request is posted in the same place. The runner listens where the developer's automation already listens (a GitHub or Forgejo Actions workflow on `issue_comment`, a bot, anything), applies the maintainer rule, and replies with report blocks as comments. The forge shows who asked and keeps the record.
2. **Push.** cornfield records the request and sends it as a signed `agent.requested` hook event: a POST of `{ "event": "agent.requested", "at", "request", "actor", "mapUrl" }`, where `request` is exactly the request JSON above. `X-Cornfield-Signature` is `sha256=` and the HMAC-SHA256 of the raw body under `CORNFIELD_HOOK_SECRET`. The runner **verifies the signature on the raw bytes in constant time, refuses an old `at`, and checks `request` against the schema**, then applies the maintainer rule (the signature stands in for the author); the code is in [agents](agents.md#push). It reports with `POST /api/runs/<runId>` and a runner token. Nothing is posted to the forge.
3. **Pull.** cornfield records the request and keeps it queued. A runner with a **runner token** (`cf_nt_…`, made in the dashboard) lists it with `GET /api/agent-requests?state=queued` (the request JSON, oldest first), claims it with `POST /api/agent-requests/<runId>/claim` (atomic: a second claim is 409), and reports with `POST /api/runs/<runId>`, the report JSON above, checked by `validateReport`; only the token that claimed a run may report on it. It learns of a stop by `GET /api/runs/<runId>` (`state`, `stopRequested`), and of an answer to a `waiting` report in the same read (`answer`). This works from behind NAT. A runner token reaches only these routes, and is never in a request, a report or a hook: it is the runner's credential to cornfield.

On push and pull a `cornfield-run` comment on the forge does not move the run: the runner token decides. cornfield's own tokens (`cf_rt_`, `cf_at_`, `cf_nt_`) are credential-shaped like the rest, so a request or a report holding one is refused.

## A worked example

A maintainer, `maintainer-one`, presses **Start an agent** on issue 12 with the profile `claude`. cornfield posts, as them:

````
Asked for a code run `run-01JC8Z3Q5M7VXK2RT9N4B6HDEF` on issue #12 with the profile claude (maintainer-one, in cornfield).

```cornfield-run run-01JC8Z3Q5M7VXK2RT9N4B6HDEF
{
  "version": 1,
  "runId": "run-01JC8Z3Q5M7VXK2RT9N4B6HDEF",
  "kind": "code",
  "profile": "claude",
  "refs": { "issue": 12 },
  "branch": "agent/retry-login",
  "brief": "Make the login retry once on a timeout. Keep it small.",
  "limits": { "minutes": 30, "turns": 40 },
  "nodes": ["core-server-auth"],
  "requestedBy": "maintainer-one",
  "requestedAt": "2026-11-05T09:30:00Z"
}
```
````

The runner, a workflow on `issue_comment`, finds the block, checks that the comment's author is a maintainer now, and replies:

````
Run `run-01JC8Z3Q5M7VXK2RT9N4B6HDEF`: claimed.

```cornfield-run run-01JC8Z3Q5M7VXK2RT9N4B6HDEF
{ "state": "claimed" }
```
````

It does the work under its own bot account on `agent/retry-login`, and opens a pull request whose body ends with:

```
Closes #12

Cornfield-Run: run-01JC8Z3Q5M7VXK2RT9N4B6HDEF
```

cornfield finds the pull request by the trailer, shows it beside the run, and lights the nodes its branch changes. The maintainer presses **Stop**, and cornfield posts `{ "state": "stop-requested" }` in a block for the same id. The runner finishes what it is doing, pushes what it has, and reports:

````
Run `run-01JC8Z3Q5M7VXK2RT9N4B6HDEF`: stopped.

```cornfield-run run-01JC8Z3Q5M7VXK2RT9N4B6HDEF
{ "state": "stopped", "note": "stopped after the second turn", "url": "https://ci.example.com/runs/42", "tokens": 18400, "cost": 0.31 }
```
````

## The limits, and what the schema cannot say

| What | Limit |
| --- | --- |
| `brief` | 20000 characters |
| `note` | 4000 characters |
| `url` | 2000 characters |
| `nodes` | 100 ids, 200 characters each |
| `branch` | 200 characters |
| `profile` | 64 characters |
| a block | 60000 characters; 20 blocks read per comment |
| a comment cornfield writes | 60000 characters |

Lengths count characters (UTF-16 code units in cornfield; a few emoji can make the two differ from a schema validator that counts code points, which only matters at the edge of a cap).

[agent-contract.schema.json](../core/agent-contract.schema.json) holds the shape of all four objects, the patterns, the caps, the credential-name rule and the credential-value rule, so a runner can check what it reads or writes with any JSON Schema library. It is looser than cornfield in four ways, which a schema cannot express: cornfield also refuses a `profile` that is not in the developer's configured list, a `requestedAt` that is not a real calendar date (`2026-02-30T00:00:00Z`), a `trigger.by` that is not the request's `requestedBy`, and a `reply` with no `text`. The four definitions are `request`, `report`, `stopRequest` and `answer`; the file as a whole accepts any one of them. Its credential-value pattern uses fixed-width lookbehind (`(?<!…)`), which JavaScript, Python and .NET support; a validator built on RE2 (Go) does not, so there, check that rule in code.

Still open in spec 0005 and decided by the build issue that needs it: whether an automatic request names the event that fired it (a trigger field), the config keys for the limit defaults and the open-run cap (the push body and the pull routes are settled and documented above). A runner should refuse a key it does not know, so each of these arrives as a new contract version or an optional key documented here first.
