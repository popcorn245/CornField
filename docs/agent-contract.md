# The agent contract (version 1)

cornfield **asks**; the developer's own **runner** does the work. A runner is whatever starts an agent for you: a Claude Code session, a CI job, Ollama on your own machine, a shell script. cornfield runs no agent process, calls no agent platform and holds no agent credentials. This page is everything a runner needs to implement, in any language. The decisions behind it are [spec 0005](specs/0005-threads-and-agents.md) (its "The contract" section is what this page builds) and [ADR 0012](adr/0012-cornfield-asks-runners-act.md). The code that cornfield itself uses to write and read the contract is [core/agent-contract.js](../core/agent-contract.js); a [JSON Schema](agent-contract.schema.json) (draft 2020-12) describes the same JSON, and a test keeps the two in agreement. The schema ships in the npm package: `import schema from 'cornfield/agent-contract.schema.json' with { type: 'json' }`.

A test for every part of it: could you delete cornfield tomorrow and lose nothing but the view? A request is a comment on your forge that a person can write by hand, so yes.

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
| `limits` | `{ minutes?, turns?, cost? }`, optional | Hints, never enforced by cornfield. `minutes` and `cost` are numbers above zero, `turns` a whole number above zero. `cost` is in the currency the runner reports. The runner enforces them or not. |
| `nodes` | list of node ids, optional | Map nodes the run is expected to touch (`core-server-auth`), up to 100. |
| `requestedBy` | forge login | The maintainer who asked. |
| `requestedAt` | UTC time | Like `2026-11-05T09:30:00Z` (milliseconds allowed). |

**A request never carries a credential.** No token, key, secret or password: the runner pushes and opens pull requests under its **own** identity (a bot account, a deploy key, a CI token). Prose about tokens and passwords is fine; only a value shaped like one is refused. A field whose name contains `token`, `secret`, `passw`, `credential`, `api_key`, `access_key`, `private_key`, `ssh_key`, `authorization`, `bearer` or `cookie` (any case) is refused, and so is a text value shaped like a credential (a GitHub, GitLab, OpenAI or Anthropic key, an AWS key id, a Slack token, a JWT, a private key header, a bearer header, or a link with a user and password in it). The refusal names the field.

## The fenced block

A request, a report and a stop request all travel in one form, the same pattern as a review ([ADR 0005](adr/0005-reviews-are-pr-comments.md)): a line a person can read, then a fenced block whose tag is `cornfield-run` and whose info string is the run id.

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
- Which of the three it is follows its shape: a `version` makes it a request, the state `stop-requested` a stop request, any other `state` a report.
- A comment is read for at most 20 blocks, a block holds at most 60000 characters, and a comment written by cornfield is at most 60000 characters.
- When there are several blocks for a run, **the latest one wins**. A comment edited after it was posted should not be trusted, as reviews are not.

The human line above the block is for people. cornfield **defuses** it (a zero-width space after every `@`, `#`, `://` and `www.`), so it pings and links nobody; the JSON keeps every value as sent. A runner that posts a block should do the same to its own line and never put a mention in it.

## Reports and stopping

A runner may say how it is going. Reporting is optional: a run that stays silent still shows up through what it pushes. A report is a comment (or, on the later transports, a message) holding a block for the run id:

````
```cornfield-run run-01JC8Z3Q5M7VXK2RT9N4B6HDEF
{ "state": "working", "note": "tests failing on auth, retrying", "url": "https://ci.example.com/runs/42" }
```
````

| Field | | |
| --- | --- | --- |
| `state` | required | `claimed`, `working`, `done`, `failed` or `stopped`. |
| `note` | optional | Up to 4000 characters. Shown quoted. |
| `url` | optional | Where the runner keeps its logs; `http` or `https`, no user and password in it, no credential in its query. cornfield links out and never shows logs. |
| `tokens` | optional | A whole number, zero or more. |
| `cost` | optional | A number, zero or more. Shown as sent; cornfield never estimates. |

**Stopping.** cornfield asks a run to stop with the same block and `{ "state": "stop-requested" }`, with an optional `note` and nothing else. The runner decides what stopping means. cornfield shows "stop requested" until the runner reports `stopped` or the run goes quiet. `stop-requested` is not a state a runner reports.

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

A request a maintainer wrote by hand counts as much as one cornfield wrote: the whole system can be driven with cornfield switched off. Such a request bypasses cornfield's cap on open runs and its rate limits; those guard against a runaway click, not against a maintainer acting on purpose. A run's own output (its pushes, pull request, checks and reports) never starts another run.

Two further rules for a runner. Treat the brief as untrusted input: it can say anything. And only a report from a run's own runner is a report: on the forge, cornfield believes a `cornfield-run` block only from a login listed in `agents.runners` (the runners' own forge identities) or from a maintainer, and writes an audit row for each one it ignores; on push and pull, the runner token decides (spec 0005, "Reports").

## Transports

All three carry the same JSON, so a runner can switch transport without changing what it reads. The forge is the default; push and pull are built later and are described here so a runner can be written once.

1. **The forge.** "Start an agent" posts the comment above, with the maintainer's own token, on the issue or thread (or the spec pull request, for a proposal). The runner listens where the developer's automation already listens (a GitHub or Forgejo Actions workflow on `issue_comment`, a bot, anything), applies the maintainer rule, and replies with report blocks as comments. The forge shows who asked and keeps the record.
2. **Push.** cornfield sends a signed `agent.requested` event to a URL the developer configured, through its hooks. The body is the request JSON; an HMAC-SHA256 signature with a secret from the environment proves it came from cornfield, and the runner checks it. Reports and the stop request travel the same way.
3. **Pull.** cornfield keeps the request; a runner asks for queued work with a **runner token** and claims one. This works from behind NAT. A runner token, minted and revoked in the dashboard, may only read and claim requests and report on its runs. It is the runner's credential to cornfield, and never goes in a request.

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

[agent-contract.schema.json](agent-contract.schema.json) holds the shape of all three objects, the patterns, the caps, the credential-name rule and the credential-value rule, so a runner can check what it reads or writes with any JSON Schema library. It is looser than cornfield in two ways, which a schema cannot express: cornfield also refuses a `profile` that is not in the developer's configured list, and a `requestedAt` that is not a real calendar date (`2026-02-30T00:00:00Z`). The three definitions are `request`, `report` and `stopRequest`; the file as a whole accepts any one of them. Its credential-value pattern uses fixed-width lookbehind (`(?<!…)`), which JavaScript, Python and .NET support; a validator built on RE2 (Go) does not, so there, check that rule in code.

Still open in spec 0005 and decided by the build issue that needs it: whether an automatic request names the event that fired it (a trigger field), the config keys for the limit defaults and the open-run cap, and the exact bodies of the push and pull transports. A runner should refuse a key it does not know, so each of these arrives as a new contract version or an optional key documented here first.
