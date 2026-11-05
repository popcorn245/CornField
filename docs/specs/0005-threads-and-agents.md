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

## Open questions

The tree, roughly in the order each answer unlocks the next:

1. ~~Where an agent runs, and what "launch" means for cornfield.~~ D1.
1a. ~~How a request reaches the runner.~~ D2.
2. ~~What an agent run is, as cornfield sees it.~~ D3.
3. How a run is stopped, limited and paid for.
4. Whose credentials an agent uses.
5. What a thread is, and where its messages live.
6. Who writes in a thread (people, agents, the chat bridge), and how.
7. How a thread connects to issues, nodes, proposals and runs.
8. Models: where `models: { provider, baseUrl, model }` belongs, if anywhere.
9. What cornfield shows of a run while it is going.
10. The safe-actions line (ADR 0006) for v2.
