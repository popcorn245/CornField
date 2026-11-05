# Example runners

A runner is whatever starts an agent when cornfield asks ([ADR 0012](adr/0012-cornfield-asks-runners-act.md), [spec 0005](specs/0005-threads-and-agents.md)). cornfield posts a request as a comment; your automation reads it, does the work under its **own** identity and answers with report comments. This page has two complete runners for the forge transport, a Forgejo Actions workflow and a GitHub Actions one, both driving [Claude Code](https://docs.claude.com/en/docs/claude-code) headless, and the one small script they share. What the runner reads and writes is the [agent contract](agent-contract.md); read its "Who may ask: the maintainer rule" first.

They are examples to copy and change, not part of the cornfield package: nothing here is installed with `npm i cornfield`, and cornfield never calls them. A runner for [Ollama](https://ollama.com) on your own machine waits for the pull transport and is not here yet.

## The security rules

1. **The maintainer check comes first.** The first step of the job asks the forge, with the login the forge reports for the comment (never the `requestedBy` inside the block), whether that person is a maintainer **now**. Nothing else runs, and nothing from the comment is read, until it says yes. Anyone who can comment can write a block that looks right.
2. **Never echo the brief into a shell unquoted.** The brief is untrusted text that anyone a maintainer relayed may have written. Never put `${{ github.event.comment.body }}` (or any event text) inside a `run:` script; pass it in `env:` and write it to a file, as the workflows do, and hand the brief to the agent on stdin from a file, never on a command line.
3. **Use the runner's own token, never a maintainer's.** The token that pushes, opens the pull request and posts the reports belongs to the runner's own account (a bot user), and that account is listed in `agents.runners` so cornfield believes its reports. A request never carries a credential and a runner never asks for one.

Two more the workflows follow: the agent step gets the model API key and **not** the forge token (checkout does not persist credentials; the push step adds the token for that one command), and the agent may only use the tools in a short allow list. The helper is copied out of the checkout before the agent runs, so the agent cannot change the code that parses the next comment.

## The helper: `cornfield-run.mjs`

[examples/runner/cornfield-run.mjs](../examples/runner/cornfield-run.mjs) is one file with no dependencies that imports nothing from cornfield, so a runner needs no cornfield install. It is a deliberately small subset of [core/agent-contract.js](../core/agent-contract.js) (it checks the shape, the safe names, the size of the brief and for credentials, and the contract module remains the full check), and a test runs it against that module in both directions ([test/examples/runner.test.js](../test/examples/runner.test.js)).

| Command | Does |
| --- | --- |
| `parse <comment-file>` | Prints the request JSON of the comment's `cornfield-run` block, or exits 1 and says why on stderr. Reads like the contract does: the latest block wins, a block inside another fence is not one, a credential is refused. |
| `stop <comment-file>` | Prints the run id if the comment holds a `stop-requested` block, else exits 1. |
| `get <json-file> <field>` | Prints one top-level field: a string as it is, anything else as JSON. |
| `report <runId> <state> [note]` | Prints the comment body for a report: a defused line, the quoted note and the block. `state` is `claimed`, `working`, `done`, `failed` or `stopped`. If `CORNFIELD_RUN_URL` is set to an `http(s)` link, it goes in the block as `url`. |
| `trailer <runId>` | Prints `Cornfield-Run: <runId>`, for the pull request body and the commit message. |

## Forgejo Actions and Claude Code

Copy [forgejo-workflow.yml](../examples/runner/forgejo-workflow.yml) to `.forgejo/workflows/cornfield-agent.yml` and the helper to `.forgejo/cornfield-run.mjs` in the repository cornfield watches. (The examples live under `examples/` and not in a `.forgejo/` or `.github/` folder of this repository, because they would run on it.) Then:

1. Make the runner's account: a bot user with write access to the repository, and a token for it (repository or user settings, Applications) with the scopes to read and write the repository, issues and pull requests.
2. In the repository's Actions settings add the secrets `RUNNER_TOKEN` (that token) and `ANTHROPIC_API_KEY`.
3. List the bot in `cornfield.config.js`: `agents: { runners: ['cornfield-agent'], profiles: ['claude', 'fast', 'deep'] }` (the profile names are your own; see below).
4. Have a Forgejo runner with the label `docker` (or change `runs-on`) and Node on its image.

The steps, in order:

| Step | What it does |
| --- | --- |
| Commenter is a maintainer now | `GET /api/v1/repos/{owner}/{repo}/collaborators/{user}/permission` with the runner's token. The answer's `permission` must be `admin` or `owner`; anything else (or any error) ends the run without a word. `write` is not enough, as in the contract. |
| Checkout | The default branch (an `issue_comment` workflow always runs the default branch's copy), with `persist-credentials: false`. |
| Read the request | The comment body goes through `env:` into a file; the helper's `stop` and then `parse` read it. A comment that is not a request is ignored. |
| Stop a run | Best effort, see below. |
| Claim | Posts `claimed`, with the link to this job as the report's `url`. A request that is not a `code` request is answered `failed`: this runner makes pull requests only. |
| Check out a branch | The request's `branch` (the helper checks it is a safe ref name) or `agent/<runId>`. |
| Choose the model | The profile mapping, below; posts `working`. |
| Work with Claude Code | `claude -p` with the brief on stdin, the model and turn limit of the profile and a short allow list of tools. Has the API key and no forge token. |
| Push and open the pull request | Commits with the trailer, pushes with the runner's token, opens the pull request with `Closes #<issue>` and the trailer in its body, posts `done` with its link. |
| Report a failure | If any step after the claim failed, posts `failed` with the reason once. |

The whole file:

```yaml
# A cornfield runner for Forgejo Actions + Claude Code. Copy this file to .forgejo/workflows/cornfield-agent.yml and
# examples/runner/cornfield-run.mjs to .forgejo/cornfield-run.mjs in the repository that cornfield watches (docs/runners.md).
#
# Secrets (repository settings, Actions): ANTHROPIC_API_KEY, and RUNNER_TOKEN: an access token of the runner's OWN account
# (a bot user: write access to the repo, issues and pull requests). List that account in agents.runners. Never a maintainer's token.
name: cornfield-agent

on:
  issue_comment:
    types: [created]

jobs:
  agent:
    # Cheap pre-filter only. It decides nothing: the first step does the real check.
    if: contains(github.event.comment.body, 'cornfield-run')
    runs-on: docker
    timeout-minutes: 60
    env:
      API: ${{ github.server_url }}/api/v1
      REPO: ${{ github.repository }}
      ISSUE: ${{ github.event.issue.number }}
      COMMENTER: ${{ github.event.comment.user.login }}
      RUNNER_TOKEN: ${{ secrets.RUNNER_TOKEN }}
    steps:
      # 1. FIRST: is the commenter a maintainer now? Ask the forge; the login comes from the event, never from the block.
      #    GET /repos/{owner}/{repo}/collaborators/{user}/permission must say admin or owner. Fails closed: any error stops the job.
      - name: Commenter is a maintainer now
        id: who
        run: |
          set -euo pipefail
          case "$COMMENTER" in ''|*[!A-Za-z0-9._-]*) echo "unexpected login"; exit 1 ;; esac
          perm=$(curl -fsS -H "Authorization: token $RUNNER_TOKEN" "$API/repos/$REPO/collaborators/$COMMENTER/permission" \
            | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).permission')
          case "$perm" in
            admin|owner) echo "ok=true" >> "$GITHUB_OUTPUT" ;;
            *) echo "$COMMENTER has permission '$perm', not a maintainer: ignoring the comment"; echo "ok=false" >> "$GITHUB_OUTPUT" ;;
          esac

      - uses: https://data.forgejo.org/actions/checkout@v4
        if: steps.who.outputs.ok == 'true'
        with:
          persist-credentials: false # the agent below must not find the runner token in .git/config

      # 2. The comment goes to a file through the environment, never into the shell text.
      - name: Read the request
        id: req
        if: steps.who.outputs.ok == 'true'
        env:
          COMMENT_BODY: ${{ github.event.comment.body }}
        run: |
          set -euo pipefail
          R="$RUNNER_TEMP"
          cp .forgejo/cornfield-run.mjs "$R/cornfield-run.mjs" # a copy the agent cannot edit
          printf '%s' "$COMMENT_BODY" > "$R/comment.txt"
          if id=$(node "$RUNNER_TEMP/cornfield-run.mjs" stop "$R/comment.txt" 2>/dev/null); then
            echo "mode=stop" >> "$GITHUB_OUTPUT"; echo "run=$id" >> "$GITHUB_OUTPUT"; exit 0
          fi
          if ! node "$RUNNER_TEMP/cornfield-run.mjs" parse "$R/comment.txt" > "$R/request.json" 2> "$R/why.txt"; then
            echo "not a valid request: $(cat "$R/why.txt")"; echo "mode=none" >> "$GITHUB_OUTPUT"; exit 0
          fi
          node "$RUNNER_TEMP/cornfield-run.mjs" get "$R/request.json" brief > "$R/brief.txt"
          echo "mode=run" >> "$GITHUB_OUTPUT"
          echo "run=$(node "$RUNNER_TEMP/cornfield-run.mjs" get "$R/request.json" runId)" >> "$GITHUB_OUTPUT"
          echo "kind=$(node "$RUNNER_TEMP/cornfield-run.mjs" get "$R/request.json" kind)" >> "$GITHUB_OUTPUT"
          echo "profile=$(node "$RUNNER_TEMP/cornfield-run.mjs" get "$R/request.json" profile)" >> "$GITHUB_OUTPUT"
          echo "branch=$(node "$RUNNER_TEMP/cornfield-run.mjs" get "$R/request.json" branch)" >> "$GITHUB_OUTPUT"

      # Helpers for the later steps: post a comment from a file (JSON built by node, so no quoting problems).
      - name: Helpers
        if: steps.req.outputs.mode == 'run' || steps.req.outputs.mode == 'stop'
        run: |
          cat > "$RUNNER_TEMP/forge.sh" <<'SH'
          post() { # post <body-file>
            node -e 'process.stdout.write(JSON.stringify({ body: require("fs").readFileSync(process.argv[1], "utf8") }))' "$1" \
              | curl -fsS -X POST -H "Authorization: token $RUNNER_TOKEN" -H 'Content-Type: application/json' --data-binary @- "$API/repos/$REPO/issues/$ISSUE/comments" > /dev/null
          }
          say() { node "$RUNNER_TEMP/cornfield-run.mjs" report "$@" > "$RUNNER_TEMP/out.md" && post "$RUNNER_TEMP/out.md"; }
          SH

      # 3. Stop: best effort. Find the run that claimed this id and ask the forge to cancel it. The forge may refuse (older
      #    Forgejo has no cancel call); then say so.
      - name: Stop a run
        if: steps.req.outputs.mode == 'stop'
        env:
          RUN_ID: ${{ steps.req.outputs.run }}
        run: |
          set -uo pipefail
          . "$RUNNER_TEMP/forge.sh"
          me=$(curl -fsS -H "Authorization: token $RUNNER_TOKEN" "$API/user" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).login')
          curl -fsS -H "Authorization: token $RUNNER_TOKEN" "$API/repos/$REPO/issues/$ISSUE/comments?limit=100" > "$RUNNER_TEMP/comments.json"
          link=$(node -e '
            const [file, me, id] = process.argv.slice(1);
            const fence = "`".repeat(3) + "cornfield-run " + id;
            let url = "";
            for (const c of JSON.parse(require("fs").readFileSync(file, "utf8"))) {
              if (c.user?.login !== me) continue;
              const i = (c.body || "").indexOf(fence);
              if (i < 0) continue;
              try { url = JSON.parse(c.body.slice(i + fence.length).split("`".repeat(3))[0]).url || url; } catch {}
            }
            console.log(url)' "$RUNNER_TEMP/comments.json" "$me" "$RUN_ID")
          n=${link##*/}
          case "$n" in ''|*[!0-9]*) say "$RUN_ID" working "stop requested, but this run's job could not be found"; exit 0 ;; esac
          if curl -fsS -X POST -H "Authorization: token $RUNNER_TOKEN" "$API/repos/$REPO/actions/runs/$n/cancel" > /dev/null; then
            say "$RUN_ID" stopped "cancelled on request"
          else
            say "$RUN_ID" working "stop requested; the forge would not cancel the job (best effort)"
          fi

      # 4. A code run.
      - name: Claim
        if: steps.req.outputs.mode == 'run'
        env:
          RUN_ID: ${{ steps.req.outputs.run }}
          KIND: ${{ steps.req.outputs.kind }}
          CORNFIELD_RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_number }}
        run: |
          . "$RUNNER_TEMP/forge.sh"
          say "$RUN_ID" claimed
          if [ "$KIND" != code ]; then echo "this runner only does code runs" > "$RUNNER_TEMP/why.txt"; exit 1; fi

      - name: Check out a branch
        if: steps.req.outputs.mode == 'run'
        env:
          RUN_ID: ${{ steps.req.outputs.run }}
          HINT: ${{ steps.req.outputs.branch }}
        run: |
          set -euo pipefail
          BRANCH="${HINT:-agent/$RUN_ID}" # the request's branch was checked by the helper as a safe ref name
          git checkout -b "$BRANCH"
          echo "BRANCH=$BRANCH" >> "$GITHUB_ENV"

      # 5. Profiles: the request names one; this maps it to a model and a budget. Unknown names are refused.
      - name: Choose the model
        if: steps.req.outputs.mode == 'run'
        env:
          RUN_ID: ${{ steps.req.outputs.run }}
          PROFILE: ${{ steps.req.outputs.profile }}
          CORNFIELD_RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_number }}
        run: |
          set -uo pipefail
          . "$RUNNER_TEMP/forge.sh"
          case "${PROFILE:-default}" in
            default|claude) MODEL=sonnet; TURNS=40 ;;
            fast)           MODEL=haiku;  TURNS=20 ;;
            deep)           MODEL=opus;   TURNS=80 ;;
            *) echo "unknown profile" > "$RUNNER_TEMP/why.txt"; exit 1 ;;
          esac
          printf 'MODEL=%s\nTURNS=%s\n' "$MODEL" "$TURNS" >> "$GITHUB_ENV"
          say "$RUN_ID" working "model $MODEL"

      # 6. Claude Code, headless. This step has the API key and NOT the forge token.
      - name: Work with Claude Code
        if: steps.req.outputs.mode == 'run'
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          RUNNER_TOKEN: ''
        run: |
          set -uo pipefail
          npm install -g @anthropic-ai/claude-code # pin a version you have tried
          # The brief is untrusted text. It goes in as a file on stdin, never into a command line.
          { echo "You are working on one task in this repository. Make the change, run the tests, and do not commit. The task:"; echo; cat "$RUNNER_TEMP/brief.txt"; } > "$RUNNER_TEMP/prompt.txt"
          claude -p --model "$MODEL" --max-turns "$TURNS" --permission-mode acceptEdits \
            --allowedTools "Read,Edit,Write,Glob,Grep,Bash(npm test:*),Bash(npm run:*),Bash(git diff:*),Bash(git status:*)" \
            < "$RUNNER_TEMP/prompt.txt" > "$RUNNER_TEMP/claude.log" 2>&1 || { echo "claude exited with status $?" > "$RUNNER_TEMP/why.txt"; exit 1; }

      # 7. Push and open the pull request, with the runner's token and the trailer.
      - name: Push and open the pull request
        if: steps.req.outputs.mode == 'run'
        env:
          RUN_ID: ${{ steps.req.outputs.run }}
          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}
          CORNFIELD_RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_number }}
        run: |
          set -uo pipefail
          . "$RUNNER_TEMP/forge.sh"
          fail() { echo "$1" > "$RUNNER_TEMP/why.txt"; exit 1; }
          trailer=$(node "$RUNNER_TEMP/cornfield-run.mjs" trailer "$RUN_ID")
          git add -A -- .
          git diff --cached --quiet && fail "the agent changed nothing"
          git -c user.name="cornfield-agent" -c user.email="agent@users.noreply.invalid" commit -q -m "chore(agent): run $RUN_ID" -m "$trailer" || fail "could not commit"
          git -c http.extraHeader="Authorization: token $RUNNER_TOKEN" push -q origin "HEAD:refs/heads/$BRANCH" || fail "could not push the branch"
          closes=$(node "$RUNNER_TEMP/cornfield-run.mjs" get "$RUNNER_TEMP/request.json" refs | node -p 'const i = JSON.parse(require("fs").readFileSync(0, "utf8")).issue; i ? "Closes #" + i : ""')
          printf '%s\n\n%s\n' "$closes" "$trailer" > "$RUNNER_TEMP/pr-body.md"
          node -e 'process.stdout.write(JSON.stringify({ title: "chore(agent): " + process.argv[1], head: process.argv[2], base: process.argv[3], body: require("fs").readFileSync(process.argv[4], "utf8") }))' \
            "$RUN_ID" "$BRANCH" "$DEFAULT_BRANCH" "$RUNNER_TEMP/pr-body.md" \
            | curl -fsS -X POST -H "Authorization: token $RUNNER_TOKEN" -H 'Content-Type: application/json' --data-binary @- "$API/repos/$REPO/pulls" > "$RUNNER_TEMP/pr.json" || fail "could not open the pull request"
          say "$RUN_ID" done "opened $(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).html_url' "$RUNNER_TEMP/pr.json")"

      # 8. Anything above that failed says so, once.
      - name: Report a failure
        if: failure() && steps.req.outputs.mode == 'run'
        env:
          RUN_ID: ${{ steps.req.outputs.run }}
          CORNFIELD_RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_number }}
        run: |
          . "$RUNNER_TEMP/forge.sh"
          why=$(cat "$RUNNER_TEMP/why.txt" 2>/dev/null || echo "the run failed; see the job log")
          say "$RUN_ID" failed "$why"
```

### Stopping

Stopping is **best effort**. A stop request is a comment like any other, so it starts another run of the same workflow; after the same maintainer check, that run finds the `url` in the `claimed` report of the run it is meant for (a comment by the runner's own account) and asks the forge to cancel that job, then posts `stopped`. It cannot work when the stop arrives before the claim, after the job has finished, or when the forge has no call to cancel a job (older Forgejo versions have none); the runner then posts a `working` report that says the stop was not carried out, and the job can be cancelled in the forge's Actions page. A cancelled job leaves the branch as it was.

## GitHub Actions and Claude Code

Copy [github-workflow.yml](../examples/runner/github-workflow.yml) to `.github/workflows/cornfield-agent.yml` and the helper to `.github/cornfield-run.mjs`. It is the same workflow with these changes, and the same secrets (`RUNNER_TOKEN` is a personal access token of the runner's own account, or a fine-grained token for it, not a maintainer's, and not the built-in `GITHUB_TOKEN`, whose pull requests start no other workflows):

- The maintainer check is `gh api repos/$REPO/collaborators/$COMMENTER/permission --jq .role_name` and the role must be `admin` or `maintain`, cornfield's own definition of a maintainer. (The field `permission` of the same answer folds `maintain` into `write`, so the workflow reads `role_name`.)
- Reports are `gh issue comment --body-file`, the pull request is `gh pr create --body-file`, the stop is `gh run cancel`. `gh` is on the hosted runners; there is no `actions/github-script` and no third-party action but `actions/checkout`.
- The push sends the token as an HTTP header for that one command, as the Forgejo workflow does, because checkout does not keep it.

## Profiles

A request names a profile (`claude`, `fast`, `deep`: whatever you configured in `agents.profiles`); cornfield knows only the name. What it means is yours, and it is a few lines in the workflow:

```sh
case "${PROFILE:-default}" in
  default|claude) MODEL=sonnet; TURNS=40 ;;
  fast)           MODEL=haiku;  TURNS=20 ;;
  deep)           MODEL=opus;   TURNS=80 ;;
  *) echo "unknown profile" > "$RUNNER_TEMP/why.txt"; exit 1 ;;
esac
```

The name is checked by the helper (letters, digits and `. _ -`) before it gets here, and an unknown one fails the run instead of falling back, so a typo never starts something you did not mean. The same `case` can choose a machine: set `runs-on` from a second job, or send `deep` to a runner label with a GPU or more memory, or hold back a budget (`--max-turns`, a timeout). The request's `limits` (minutes, turns, cost) are hints that these examples do not enforce; read them with `get` if you want to.

## What to change for your repository

- The pull request title is `chore(agent): <runId>`; change it to match your own convention (a title check on your repository may want another type).
- Pin the version of `@anthropic-ai/claude-code`, and the tools in `--allowedTools`, to what you have tried.
- The workflows are not concurrency limited on purpose (a stop would queue behind the run it should stop); cap how many runs may start in your Actions settings or in a first step that counts open runs.
- An approved proposal that is already on the default branch has no spec pull request, and a request for a `summary`, `brief` or `proposal` run is thinking, not code: these runners answer `failed` for those. Extend the `Claim` step with the model call and the comment you want.
