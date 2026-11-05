# Spec 0005: threads, agents and how they plug in (v2)

Status: **being grilled** (maintainer and PM, from 2026-11-05). Each answer lands here as it is given; nothing is built until this is approved on the map.

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
2. **Push.** A signed `agent.requested` event to a configured URL, through the hooks that exist (#66).
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
- **A request written by hand on the forge counts.** Any maintainer-authored request block is a real request, so the whole system can be driven with cornfield switched off. cornfield is only a convenient way to write one. Such a request bypasses cornfield's cap and rate limits; those guard against a runaway click, not against a maintainer acting on purpose.
- **Push and pull:** requests are HMAC-signed with a secret from the environment, as hooks are. Pull uses **runner tokens**, minted and revoked in the dashboard like review tokens, that may only read and claim requests and report on their runs.

### D6. A thread is a forge conversation, and every step has a hook (2026-11-05)

This changes the earlier plan (the vision and #14) to keep threads in cornfield's SQLite file. That would fail the test above.

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

## Open questions

The tree, roughly in the order each answer unlocks the next:

1. ~~Where an agent runs, and what "launch" means for cornfield.~~ D1.
1a. ~~How a request reaches the runner.~~ D2.
2. ~~What an agent run is, as cornfield sees it.~~ D3.
3. ~~How a run is stopped, limited and paid for.~~ D4.
4. ~~Whose credentials an agent uses.~~ D5.
5. ~~What a thread is, and where its messages live.~~ D6.
6. ~~Who writes in a thread, and how.~~ D6: anyone, on the forge, as themselves.
7. ~~How a thread connects to issues, nodes, proposals and runs.~~ D7.
8. Models: where `models: { provider, baseUrl, model }` belongs, if anywhere.
9. What cornfield shows of a run while it is going.
10. The safe-actions line (ADR 0006) for v2.
