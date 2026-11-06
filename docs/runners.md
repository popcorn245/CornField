# Example runners

A runner is whatever starts an agent when cornfield asks ([ADR 0012](adr/0012-cornfield-asks-runners-act.md), [spec 0005](specs/0005-threads-and-agents.md)). cornfield posts a request as a comment; your automation reads it, does the work under its **own** identity and answers with report comments. This page has two complete runners for the forge transport, a Forgejo Actions workflow and a GitHub Actions one, both driving [Claude Code](https://docs.claude.com/en/docs/claude-code) headless, and the small script they share. What the runner reads and writes is the [agent contract](agent-contract.md); read its "Who may ask: the maintainer rule" first.

They are examples to copy and change, not part of the cornfield package: nothing here is installed with `npm i cornfield`, and cornfield never calls them. A runner for [Ollama](https://ollama.com) on your own machine waits for the pull transport and is not here yet.

## The security rules

A workflow that starts an agent from issue comments is an injection target. These are the rules the examples follow; keep them when you change one.

1. **The maintainer check comes first.** The first step asks the forge, with the login the forge reports for the comment (never the `requestedBy` inside the block), whether that person is a maintainer **now**. Nothing else runs, and nothing from the comment is read, until it says yes; any error (a non-200 answer, an API failure, an unexpected role) stops the run. Anyone who can comment can write a block that looks right. The workflows run on comments being **created** only, never edited: an edit of a maintainer's comment, by someone else with write access, would otherwise run without a new check.
2. **Event text never reaches a shell as code.** The brief is untrusted text that anyone a maintainer relayed may have written. No `${{ … }}` appears inside a `run:` script: the comment goes in through `env:` and is written to a file, the helper checks it with the [contract](agent-contract.md), and only checked values (a run id, a kind, a profile name and a branch name the contract allows) become step outputs. The brief goes to the agent on stdin from a file, never on a command line.
3. **The agent never has the forge token.** The agent runs code it wrote (its tests, an `npm run` script it edited), so it can do anything the machine lets it: read the environment, change files, git config and hooks, replace tools on the path. So the work is split into three jobs on fresh machines:
   - **request** (the forge token, never the agent): the maintainer check, reading the request, the stop, and the claim;
   - **agent** (the model API key, **no** forge token): Claude Code, and its work written out as a patch;
   - **publish** (the forge token, never the agent): a clean checkout, the patch applied as text with `git apply`, commit and push with hooks off, the pull request.
   Nothing the agent left behind runs where the token is: not its scripts, not its git config, not its hooks. Secrets are given only to the steps that use them, never at job or workflow level, and checkout never keeps credentials.
4. **The agent's work cannot change the workflows or an existing branch.** A patch that touches `.forgejo/`, `.gitea/` or `.github/` is refused, because a workflow on the pushed branch would run with the repository's secrets. The push is `--force-with-lease=refs/heads/<branch>:`, which only succeeds when the branch does not exist yet, so a branch hint naming the default branch, or any branch that is there, is never moved.
5. **Use the runner's own token, never a maintainer's.** The token that pushes, opens the pull request and posts the reports belongs to the runner's own account (a bot user, not a maintainer of the repository), and that account is listed in `agents.runners` so cornfield believes its reports. A request never carries a credential and a runner never asks for one.

What these examples do not solve, and you should know:

- The agent job runs untrusted code with the model API key in its environment: it can spend that key. Give the runner a key of its own, with a spending limit.
- On GitHub, a job started by `issue_comment` runs in the default branch's context, where it can write to the Actions cache. Do not let a release workflow restore a cache the agent job could have written, or run the agent on a separate runner.
- The comments a runner posts contain `cornfield-run`, so they start the workflow too; the maintainer check ends those runs at once (the bot is not a maintainer). Keep it that way.

## The helper: `cornfield-run.mjs`

[examples/runner/cornfield-run.mjs](../examples/runner/cornfield-run.mjs) is a small command line over the agent contract itself. It sits beside three files you copy with it: `agent-contract.js` and `defuse.js`, unchanged copies of cornfield's [core/agent-contract.js](../core/agent-contract.js) and `core/defuse.js` (a test keeps them identical), and a `package.json` that marks the folder as ES modules. So the runner refuses exactly what cornfield refuses (unknown keys, anything shaped like a credential, an unsafe branch or profile name, a block in another fence) and needs no install. It also refuses anything shaped like one of cornfield's own tokens (`cf_` and two letters, such as `cf_rt_` or `cf_at_`), even a kind newer than its copy of the contract. When you update cornfield, copy the two contract files again.

| Command | Does |
| --- | --- |
| `parse <comment-file>` | Prints the request JSON of the comment's latest request block, or exits 1 and says why on stderr. |
| `stop <comment-file>` | Prints the run id if the comment holds a `stop-requested` block, else exits 1. |
| `get <json-file> <field>` | Prints one top-level field: a string as it is, anything else as JSON. |
| `report <runId> <state> [note]` | Prints the comment body for a report: a defused line, the quoted note and the block. `state` is `claimed`, `working`, `done`, `failed` or `stopped`. If `CORNFIELD_RUN_URL` is a link the contract accepts, it goes in the block as `url`. A note that looks like a credential is refused. |
| `trailer <runId>` | Prints `Cornfield-Run: <runId>`, for the pull request body and the commit message. |
| `closes <comment-file>` | Prints `Closes #<issue>` for the request's issue, or an empty line. |
| `claimed-url <comments-json> <login> <runId>` | The `url` of that login's latest report for the run, from a forge's list of comments: how a stop finds the job to cancel. |
| `body <file>`, `pr <title> <head> <base> <body-file>` | JSON for a forge's comment and pull request APIs, so no text is quoted by hand. |

## Forgejo Actions and Claude Code

Copy [forgejo-workflow.yml](../examples/runner/forgejo-workflow.yml) to `.forgejo/workflows/cornfield-agent.yml`, and the four files `cornfield-run.mjs`, `agent-contract.js`, `defuse.js` and `package.json` to `.forgejo/cornfield/`, in the repository cornfield watches. (The examples live under `examples/` and not in a `.forgejo/` or `.github/` folder of this repository, because they would run on it.) Then:

1. Make the runner's account: a bot user with write access to the repository (not admin: it must not count as a maintainer), and a token for it (user settings, Applications) with the scopes to read and write the repository, issues and pull requests.
2. In the repository's Actions settings add the secrets `RUNNER_TOKEN` (that token) and `ANTHROPIC_API_KEY`.
3. List the bot in `cornfield.config.js`: `agents: { runners: ['cornfield-agent'], profiles: ['claude', 'fast', 'deep'] }` (the profile names are your own; see below).
4. Have a Forgejo runner with the label `docker` (or change `runs-on`), whose image has Node, git and curl, and Forgejo's artifact storage on (the jobs hand the patch on as an artifact).

The jobs and steps, in order:

| Job / step | What it does |
| --- | --- |
| request: Commenter is a maintainer now | `GET /api/v1/repos/{owner}/{repo}/collaborators/{user}/permission` with the runner's token. The answer's `permission` must be `admin` or `owner`; anything else ends the run, and any error fails it. `write` is not enough, as in the contract. |
| request: checkout | The default branch (an `issue_comment` workflow always runs the default branch's copy), without credentials. |
| request: Read the request | The comment body goes through `env:` into a file; the helper's `stop` and then `parse` read it. A comment that is not a request is ignored. |
| request: Stop a run | Best effort, see below. |
| request: Claim | Refuses a request that is not a `code` request, an unknown profile, or a branch hint that names the default branch (answering `failed`); maps the profile to a model; posts `claimed` with the link to this run. |
| agent | Checks out the default branch, reads the brief again from the event, runs `claude -p` with the brief on stdin, the profile's model and turn limit and a short allow list of tools, and uploads the change as a patch. Has the API key and no forge token. If it fails, the **failed** job says so. |
| publish | A fresh checkout; applies the patch with `git apply`, refuses one that touches the workflow folders, commits with the trailer and hooks off, pushes a new branch with the runner's token (never over an existing one), opens the pull request with `Closes #<issue>` and the trailer in its body, and posts `done` with its link (or `failed`, with the reason). |

The whole file:

```yaml
# A cornfield runner for Forgejo Actions + Claude Code. Copy this file to .forgejo/workflows/cornfield-agent.yml, and the four
# files of examples/runner/ (cornfield-run.mjs, agent-contract.js, defuse.js, package.json) to .forgejo/cornfield/, in the
# repository that cornfield watches (docs/runners.md).
#
# Secrets (repository settings, Actions): ANTHROPIC_API_KEY, and RUNNER_TOKEN: an access token of the runner's OWN account
# (a bot user: write access to the repo, issues and pull requests). List that account in agents.runners. Never a maintainer's token.
#
# Three jobs, because the agent runs code it wrote (its tests): the agent job has the model key and NO forge token, and hands
# its work on as a patch; the request and publish jobs have the forge token and never run anything the agent touched.
name: cornfield-agent

on:
  issue_comment:
    types: [created] # never "edited": an edit could change a maintainer's comment after the check

env:
  API: ${{ github.server_url }}/api/v1
  REPO: ${{ github.repository }}
  ISSUE: ${{ github.event.issue.number }}
  HELPER: .forgejo/cornfield/cornfield-run.mjs
  # The link to this run, for the reports' "url"
  CORNFIELD_RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_number }}

jobs:
  request:
    # Cheap pre-filter only. It decides nothing: the first step does the real check.
    if: contains(github.event.comment.body, 'cornfield-run')
    runs-on: docker
    timeout-minutes: 10
    outputs:
      mode: ${{ steps.req.outputs.mode }}
      run: ${{ steps.req.outputs.run }}
      branch: ${{ steps.claim.outputs.branch }}
      model: ${{ steps.claim.outputs.model }}
      turns: ${{ steps.claim.outputs.turns }}
    steps:
      # 1. FIRST: is the commenter a maintainer now? Ask the forge; the login comes from the event, never from the block.
      #    GET /repos/{owner}/{repo}/collaborators/{user}/permission must say admin or owner. Fails closed: any error stops the job.
      - name: Commenter is a maintainer now
        id: who
        env:
          COMMENTER: ${{ github.event.comment.user.login }}
          RUNNER_TOKEN: ${{ secrets.RUNNER_TOKEN }}
        run: |
          set -euo pipefail
          case "$COMMENTER" in ''|*[!A-Za-z0-9._-]*) echo "unexpected login"; exit 1 ;; esac
          perm=$(curl -fsS -H "Authorization: token $RUNNER_TOKEN" "$API/repos/$REPO/collaborators/$COMMENTER/permission" \
            | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).permission')
          case "$perm" in
            admin|owner) echo "ok=true" >> "$GITHUB_OUTPUT" ;;
            *) echo "$COMMENTER has permission '$perm', not a maintainer: ignoring the comment"; echo "ok=false" >> "$GITHUB_OUTPUT" ;;
          esac

      # The default branch, as the workflow itself is: nothing an agent wrote has run here.
      - uses: https://data.forgejo.org/actions/checkout@v4.2.2
        if: steps.who.outputs.ok == 'true'
        with:
          persist-credentials: false

      # 2. The comment goes to a file through the environment, never into the shell text. The helper checks it with the
      #    agent contract; only checked values (a run id, a safe branch and profile name, a kind) become outputs.
      - name: Read the request
        id: req
        if: steps.who.outputs.ok == 'true'
        env:
          COMMENT_BODY: ${{ github.event.comment.body }}
        run: |
          set -euo pipefail
          R="$RUNNER_TEMP"
          printf '%s' "$COMMENT_BODY" > "$R/comment.txt"
          if id=$(node "$HELPER" stop "$R/comment.txt" 2>/dev/null); then
            echo "mode=stop" >> "$GITHUB_OUTPUT"; echo "run=$id" >> "$GITHUB_OUTPUT"; exit 0
          fi
          if ! node "$HELPER" parse "$R/comment.txt" > "$R/request.json" 2> "$R/why.txt"; then
            echo "not a valid request: $(cat "$R/why.txt")"; echo "mode=none" >> "$GITHUB_OUTPUT"; exit 0
          fi
          echo "mode=run" >> "$GITHUB_OUTPUT"
          echo "run=$(node "$HELPER" get "$R/request.json" runId)" >> "$GITHUB_OUTPUT"
          echo "kind=$(node "$HELPER" get "$R/request.json" kind)" >> "$GITHUB_OUTPUT"
          echo "profile=$(node "$HELPER" get "$R/request.json" profile)" >> "$GITHUB_OUTPUT"
          echo "branch=$(node "$HELPER" get "$R/request.json" branch)" >> "$GITHUB_OUTPUT"

      # 3. Stop: best effort. Find this run's job from the runner's own "claimed" report and ask the forge to cancel it. If the
      #    forge has no such call or refuses, post a "working" note that says the stop was not carried out (docs/runners.md).
      - name: Stop a run
        if: steps.req.outputs.mode == 'stop'
        env:
          RUN_ID: ${{ steps.req.outputs.run }}
          RUNNER_TOKEN: ${{ secrets.RUNNER_TOKEN }}
        run: |
          set -uo pipefail
          say() { node "$HELPER" report "$@" > "$RUNNER_TEMP/out.md" && node "$HELPER" body "$RUNNER_TEMP/out.md" \
            | curl -fsS -X POST -H "Authorization: token $RUNNER_TOKEN" -H 'Content-Type: application/json' --data-binary @- "$API/repos/$REPO/issues/$ISSUE/comments" > /dev/null; }
          me=$(curl -fsS -H "Authorization: token $RUNNER_TOKEN" "$API/user" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).login')
          curl -fsS -H "Authorization: token $RUNNER_TOKEN" "$API/repos/$REPO/issues/$ISSUE/comments?limit=100" > "$RUNNER_TEMP/comments.json"
          link=$(node "$HELPER" claimed-url "$RUNNER_TEMP/comments.json" "$me" "$RUN_ID")
          n=${link##*/}
          case "$n" in ''|*[!0-9]*) say "$RUN_ID" working "stop requested, but this run's job could not be found: cancel it in the Actions page"; exit 0 ;; esac
          if curl -fsS -X POST -H "Authorization: token $RUNNER_TOKEN" "$API/repos/$REPO/actions/runs/$n/cancel" > /dev/null; then
            say "$RUN_ID" stopped "cancelled on request"
          else
            say "$RUN_ID" working "stop requested, but the forge did not cancel the job (it may have no API for it): cancel it in the Actions page"
          fi

      # 4. Claim: only code runs, only a known profile, and never a branch that exists (the push below makes sure of that).
      - name: Claim
        id: claim
        if: steps.req.outputs.mode == 'run'
        env:
          RUN_ID: ${{ steps.req.outputs.run }}
          KIND: ${{ steps.req.outputs.kind }}
          PROFILE: ${{ steps.req.outputs.profile }}
          HINT: ${{ steps.req.outputs.branch }}
          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}
          RUNNER_TOKEN: ${{ secrets.RUNNER_TOKEN }}
        run: |
          set -uo pipefail
          say() { node "$HELPER" report "$@" > "$RUNNER_TEMP/out.md" && node "$HELPER" body "$RUNNER_TEMP/out.md" \
            | curl -fsS -X POST -H "Authorization: token $RUNNER_TOKEN" -H 'Content-Type: application/json' --data-binary @- "$API/repos/$REPO/issues/$ISSUE/comments" > /dev/null; }
          refuse() { say "$RUN_ID" failed "$1"; exit 1; }
          [ "$KIND" = code ] || refuse "this runner only does code runs"
          # Profiles: the request names one; this maps it to a model and a budget. An unknown name is refused, never guessed.
          case "${PROFILE:-default}" in
            default|claude) MODEL=sonnet; TURNS=40 ;;
            fast)           MODEL=haiku;  TURNS=20 ;;
            deep)           MODEL=opus;   TURNS=80 ;;
            *) refuse "unknown profile" ;;
          esac
          BRANCH="${HINT:-agent/$RUN_ID}" # a safe ref name: the helper checked it against the contract
          [ "$BRANCH" != "$DEFAULT_BRANCH" ] || refuse "the branch hint names the default branch"
          printf 'branch=%s\nmodel=%s\nturns=%s\n' "$BRANCH" "$MODEL" "$TURNS" >> "$GITHUB_OUTPUT"
          say "$RUN_ID" claimed "model $MODEL, branch $BRANCH"

  # The agent: the model key, NO forge token. It runs code the agent wrote, so nothing it leaves behind (files, git config,
  # hooks, the tools on this machine) is trusted after it: its work leaves only as a patch file.
  agent:
    needs: request
    if: needs.request.outputs.mode == 'run'
    runs-on: docker
    timeout-minutes: 60
    steps:
      - uses: https://data.forgejo.org/actions/checkout@v4.2.2
        with:
          persist-credentials: false

      - name: Read the brief
        env:
          COMMENT_BODY: ${{ github.event.comment.body }}
        run: |
          set -euo pipefail
          printf '%s' "$COMMENT_BODY" > "$RUNNER_TEMP/comment.txt"
          node "$HELPER" parse "$RUNNER_TEMP/comment.txt" > "$RUNNER_TEMP/request.json"
          node "$HELPER" get "$RUNNER_TEMP/request.json" brief > "$RUNNER_TEMP/brief.txt"

      - name: Work with Claude Code
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          MODEL: ${{ needs.request.outputs.model }}
          TURNS: ${{ needs.request.outputs.turns }}
        run: |
          set -uo pipefail
          npm install -g @anthropic-ai/claude-code@2.1.307
          # The brief is untrusted text. It goes in as a file on stdin, never into a command line.
          { echo "You are working on one task in this repository. Make the change, run the tests, and do not commit. The task:"; echo; cat "$RUNNER_TEMP/brief.txt"; } > "$RUNNER_TEMP/prompt.txt"
          claude -p --model "$MODEL" --max-turns "$TURNS" --permission-mode acceptEdits \
            --allowedTools "Read,Edit,Write,Glob,Grep,Bash(npm test:*),Bash(npm run:*),Bash(git diff:*),Bash(git status:*)" \
            < "$RUNNER_TEMP/prompt.txt" > "$RUNNER_TEMP/claude.log" 2>&1 || { echo "claude exited with status $?"; exit 1; }

      # The repository's hooks and config may have been changed by the agent; that is harmless here, with no forge token.
      - name: The work, as a patch
        run: |
          set -euo pipefail
          mkdir -p "$RUNNER_TEMP/out"
          git add -A -- .
          git diff --cached --binary > "$RUNNER_TEMP/out/agent.patch"

      - uses: https://data.forgejo.org/actions/upload-artifact@v3.2.2
        with:
          name: agent-patch
          path: ${{ runner.temp }}/out/agent.patch
          retention-days: 1

  # A fresh machine: the forge token, a clean checkout, and the patch applied as text. Nothing the agent wrote is run here.
  publish:
    needs: [request, agent]
    if: needs.request.outputs.mode == 'run'
    runs-on: docker
    timeout-minutes: 10
    env:
      RUN_ID: ${{ needs.request.outputs.run }}
      BRANCH: ${{ needs.request.outputs.branch }}
    steps:
      - uses: https://data.forgejo.org/actions/checkout@v4.2.2
        with:
          persist-credentials: false

      - uses: https://data.forgejo.org/actions/download-artifact@v3.1.0
        with:
          name: agent-patch
          path: ${{ runner.temp }}/in

      - name: Push and open the pull request
        env:
          COMMENT_BODY: ${{ github.event.comment.body }}
          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}
          SERVER: ${{ github.server_url }}
          RUNNER_TOKEN: ${{ secrets.RUNNER_TOKEN }}
        run: |
          set -uo pipefail
          post() { node "$HELPER" body "$1" | curl -fsS -X POST -H "Authorization: token $RUNNER_TOKEN" -H 'Content-Type: application/json' --data-binary @- "$API/repos/$REPO/$2" > "$RUNNER_TEMP/answer.json"; }
          say() { node "$HELPER" report "$@" > "$RUNNER_TEMP/out.md" && post "$RUNNER_TEMP/out.md" "issues/$ISSUE/comments"; }
          fail() { say "$RUN_ID" failed "$1"; exit 1; }
          P="$RUNNER_TEMP/in/agent.patch"
          [ -s "$P" ] || fail "the agent changed nothing"
          git apply --index "$P" || fail "the patch did not apply"
          # A change to the forge's workflows would run on the pushed branch with this repository's secrets: refused
          if git diff --cached --no-renames --name-only | grep -Eq '^\.(forgejo|gitea|github)/'; then fail "the work changes .forgejo, .gitea or .github; this runner does not push that"; fi
          trailer=$(node "$HELPER" trailer "$RUN_ID")
          git -c core.hooksPath=/dev/null -c user.name="cornfield-agent" -c user.email="agent@users.noreply.invalid" \
            commit -q -m "chore(agent): run $RUN_ID" -m "$trailer" || fail "could not commit"
          # --force-with-lease with an empty expected value: the branch must not exist yet, so an existing branch (the default
          # one included) is never moved
          git -c core.hooksPath=/dev/null -c http.extraHeader="Authorization: token $RUNNER_TOKEN" \
            push -q --force-with-lease="refs/heads/$BRANCH:" "$SERVER/$REPO.git" "HEAD:refs/heads/$BRANCH" || fail "could not push the branch (does it exist already?)"
          printf '%s' "$COMMENT_BODY" > "$RUNNER_TEMP/comment.txt"
          printf '%s\n\n%s\n' "$(node "$HELPER" closes "$RUNNER_TEMP/comment.txt")" "$trailer" > "$RUNNER_TEMP/pr-body.md"
          node "$HELPER" pr "chore(agent): $RUN_ID" "$BRANCH" "$DEFAULT_BRANCH" "$RUNNER_TEMP/pr-body.md" > "$RUNNER_TEMP/pr.json"
          curl -fsS -X POST -H "Authorization: token $RUNNER_TOKEN" -H 'Content-Type: application/json' --data-binary @"$RUNNER_TEMP/pr.json" "$API/repos/$REPO/pulls" > "$RUNNER_TEMP/answer.json" || fail "could not open the pull request"
          say "$RUN_ID" done "opened $(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).html_url' "$RUNNER_TEMP/answer.json")"

  # The agent job cannot report (it has no forge token), so its failure is said here, once. The request and publish jobs
  # report their own failures, and a stopped (cancelled) run was reported by the stop.
  failed:
    needs: [request, agent]
    if: always() && needs.request.result == 'success' && needs.request.outputs.mode == 'run' && needs.agent.result == 'failure'
    runs-on: docker
    timeout-minutes: 5
    steps:
      - uses: https://data.forgejo.org/actions/checkout@v4.2.2
        with:
          persist-credentials: false
      - name: Report a failure
        env:
          RUN_ID: ${{ needs.request.outputs.run }}
          RUNNER_TOKEN: ${{ secrets.RUNNER_TOKEN }}
        run: |
          node "$HELPER" report "$RUN_ID" failed "the run failed; see the job log" > "$RUNNER_TEMP/out.md"
          node "$HELPER" body "$RUNNER_TEMP/out.md" \
            | curl -fsS -X POST -H "Authorization: token $RUNNER_TOKEN" -H 'Content-Type: application/json' --data-binary @- "$API/repos/$REPO/issues/$ISSUE/comments" > /dev/null
```

### Stopping

Stopping is **best effort**. A stop request is a comment like any other, so it starts another run of the same workflow; after the same maintainer check, that run finds the `url` in the runner's own report for the run it is meant for and asks the forge to cancel it, then posts `stopped`. If the job cannot be found (the stop came before the claim) or the forge does not cancel it, it posts a `working` report that says the stop was not carried out, and the run can be cancelled in the forge's Actions page. A cancelled run leaves the branch as it was.

**On Forgejo, check the cancel call first.** The workflow calls `POST /api/v1/repos/{owner}/{repo}/actions/runs/{run}/cancel`. Whether your Forgejo version has that call, and whether it takes the run number the Actions page shows, could not be checked against the Forgejo documentation when this was written (forgejo.org could not be reached); if your version has no such call, every stop ends in the `working` report above, which is the intended fallback. The same goes for the other Forgejo specifics here: the `permission` values of the collaborator permission answer (`none`, `read`, `write`, `admin`, `owner`), the artifact actions (`upload-artifact@v3.2.2` and `download-artifact@v3.1.0`, the versions Forgejo's artifact storage has long supported), and the action versions at `data.forgejo.org`. Try the workflow on a test repository first.

## GitHub Actions and Claude Code

Copy [github-workflow.yml](../examples/runner/github-workflow.yml) to `.github/workflows/cornfield-agent.yml` and the four helper files to `.github/cornfield/`. It is the same workflow with these changes, and the same secrets (`RUNNER_TOKEN` is a personal access token of the runner's own account, or a fine-grained token for it, not a maintainer's, and not the built-in `GITHUB_TOKEN`, whose pull requests start no other workflows):

- The maintainer check is `gh api repos/$REPO/collaborators/$COMMENTER/permission --jq .role_name`, and the role must be `admin` or `maintain`, cornfield's own definition of a maintainer. (The field `permission` of the same answer folds `maintain` into `write`, so the workflow reads `role_name`.)
- `issue_comment` also runs for comments on pull requests from forks, with this repository's secrets. The maintainer check is what keeps a stranger out, so it is the first step and fails closed.
- Reports are `gh issue comment --body-file`, the pull request is `gh pr create --body-file`, the stop is `gh run cancel`. `gh` is on the hosted runners.
- The actions are pinned to full commit SHAs (with the version in a comment); the built-in token only reads (`permissions: contents: read`).

## Profiles

A request names a profile (`claude`, `fast`, `deep`: whatever you configured in `agents.profiles`); cornfield knows only the name. What it means is yours, and it is a few lines in the Claim step:

```sh
case "${PROFILE:-default}" in
  default|claude) MODEL=sonnet; TURNS=40 ;;
  fast)           MODEL=haiku;  TURNS=20 ;;
  deep)           MODEL=opus;   TURNS=80 ;;
  *) refuse "unknown profile" ;;
esac
```

The name is checked by the contract (letters, digits and `. _ -`) before it gets here, and an unknown one fails the run instead of falling back, so a typo never starts something you did not mean. The same `case` can choose a machine (send `deep` to a runner label with more memory) or hold back a budget (`--max-turns`, a timeout). The request's `limits` (minutes, turns, cost, tokens) are hints that these examples do not enforce; read them with `get` if you want to.

## What to change for your repository

- The pull request title is `chore(agent): <runId>`; change it to match your own convention (a title check on your repository may want another type).
- Claude Code is pinned (`@anthropic-ai/claude-code@2.1.307`); move the pin, and the tools in `--allowedTools`, to what you have tried.
- The workflows are not concurrency limited on purpose (a stop would queue behind the run it should stop); cap how many runs may start in your Actions settings or in a first step that counts open runs.
- An approved proposal that is already on the default branch has no spec pull request, and a request for a `summary`, `brief` or `proposal` run is thinking, not code: these runners answer `failed` for those. Extend the Claim step with the model call and the comment you want.
