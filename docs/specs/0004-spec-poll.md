# Spec 0004: spec.ready without anyone opening the dashboard

Status: built ([#72](https://github.com/popcorn245/CornField/issues/72)). It adds a module, `server/spec-poll.js`; its proposal was deleted in the PR that landed it, and `git log` keeps it.

`spec.ready` ([hooks](../config.md#hooks)) fires when cornfield lists the open spec PRs, which only happened when a maintainer opened the proposals menu or the issues and PRs panel. A team that reviews from chat never does, so its bot never heard that a spec was waiting. This lists them on a timer.

## What it adds

- **Polling, not a webhook receiver.** It needs no forge setup and is the same on GitHub and Forgejo.
- **The key.** `hookPoll: { specs: '5m' }`, separate from `hooks` (which stays a list). A duration of whole `s`, `m` or `h`, from 60s to 1h; `false` is off. On by default when some hook subscribes to `spec.ready` (by name or `'*'`), off otherwise. Validated strictly in `core/config.js`: a value under the floor, over the ceiling, not a duration, or an unknown key fails the config naming the key. `specPollMs(config)` gives the interval, or null.
- **One poller** (`server/spec-poll.js`), started when the server listens, on an injectable timer (`specPollTimer`), unref'd, stopped by `close()`. The first look is 15s after start so the repo's silent first look happens soon; then every interval. One look at a time; the next is scheduled when one ends.
- **The same detection.** Each tick calls `listPullProposals` with the hooks, as the dashboard does, so the draft rule, the silent first look, the once-per-(PR, head, proposal) rule and `hook_seen` are not forked: a poll and a dashboard look never announce one head twice.
- **Whose token.** The newest live session, via `auth.forgeForUser`, of a user the forge confirms (`me()`, `permission()`) is a maintainer now; up to five users are tried newest first. Never a token from the config. With none the tick does nothing; it logs once per stretch without a session and once when one is back.
- **Failure.** A forge error is logged, never thrown, and the next tick waits twice the interval until one succeeds.
- **Cost.** Three forge calls for a poll with nothing new (`me`, `permission`, the open PRs); a new head costs one files call, a proposal that is announced one file read; both cached by head sha as the listing already does.

## Not covered

- Nothing is looked at while no maintainer is signed in: the sign-in is what holds a token, and the config holds none.
- A push is announced within one interval (plus the back-off after a failure), not at once.
