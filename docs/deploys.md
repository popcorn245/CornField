# Deploys on the map

The **Deploys** list in the [issues and PRs panel](issues-and-prs.md) shows the repo's latest deploys and, when you select one, lights the nodes it restarted. It is read-only: cornfield reads the forge's workflow runs and never starts, re-runs or cancels one ([ADR 0006](adr/0006-safe-actions-only.md)). It needs what the panel needs: a `forge` in the [config](config.md) and a maintainer signed in ([sign-in](sign-in.md)).

## What is a deploy, and what did it restart

A forge says a workflow ran; it does not say what that touched. So cornfield asks the config, in `cornfield.config.js`:

```js
export default {
  forge: { type: 'github', url: 'https://github.com', repo: 'owner/name' },
  deploys: {
    // Which workflows are deploys: a name or a file name, `*` for "anything", any case.
    // Default: ['*deploy*'], any workflow with "deploy" in its name or file.
    workflows: ['Deploy *', 'release.yml'],
    // What a deploy restarts: a workflow pattern, then the map nodes it restarts (ids or labels).
    restarts: {
      'Deploy web': ['stack-web'],       // a stack: it and its containers
      'Deploy media': ['media', 'nas'],  // a stack by its label, a machine by its label
      'deploy-*.yml': ['machine-edge'],
    },
  },
};
```

- A **pattern** is plain text with `*` for "anything", compared with the run's workflow name ("Deploy web") and its workflow file ("deploy.yml"), whatever the case. A name is never a regular expression.
- A **node** is a node id (`stack-web`, `container-web-app`, `machine-nas`: the [compose](derivers.md) and world derivers' ids;) or, when no id is that, a label (`web`, `nas`). A label shared by several nodes names all of them. A **stack** restarts its containers too (the `container` nodes whose `stack` is the stack's label).
- Every pattern in `restarts` that fits a deploy adds its nodes, each node once.
- **A deploy no pattern names is still listed**, with "Not mapped to a node"; selecting it says nothing is lit and where to say what it restarts. A node the config names that is not on the map is said too ("ghost is named in the config but not on the map"); the others still light. Nothing is dropped.

`validate` and `serve` check the shape of `deploys` and name what is wrong.

## Where the runs come from

The forge interface has one read-only call, `runs({ limit })` ([server/forge.js](../server/forge.js)): the latest workflow runs, newest first, as plain data (`id`, `workflow`, `name`, `title`, `event`, `branch`, `sha`, `state`, `actor`, `url`, `createdAt`, `updatedAt`; the state is the same `queued | running | success | failure | neutral | skipped | cancelled` as a check's). Both adapters implement it:

| Forge | Read from | Notes |
|---|---|---|
| GitHub (and Enterprise Server) | `GET /repos/<repo>/actions/runs` | `name` is the workflow's own name. Workflow runs, not the Deployments API: a deploy that never ran as a workflow is not listed. |
| Forgejo | `GET /repos/<repo>/actions/runs` | Forgejo 11 and later (Gitea 1.24 and later), with Actions on for the repo. Forgejo gives a run no name, so `name` is the workflow file's (`deploy.yaml`); match on that. On an older instance, or a repo without Actions, the panel says plainly that deploys are not read from it (the route answers 501) and the other lists work as before. |

A **plugin's deploy log** (a deriver or source that reads deploys a forge never ran, such as a script on a server) is not read yet. The seam is the same plain `Run` shape above plus `restarts`; a log that gives it can feed the same list. That is a follow-up, not this feature.

The server asks for the last 100 runs (at most 300) and keeps those whose workflow is a deploy, so a repo whose CI runs far more often than it deploys may show fewer than 100 deploys. The answer is cached per user for a minute, keyed by the `deploys` config too, so changing the mapping is never answered from what was kept for the old one.

```
GET /api/forge/deploys?limit=100    the deploys among the latest runs, each with `restarts` (the config's refs; [] when unmapped)
```

Like every `/api/forge/…` route it is a `GET`, signed-in only, and answers `{ ok: false, error, code }` in words when it cannot.

## In the panel

- **Deploys** is a third tab beside Pull requests and Issues. Each row: the workflow, what it ran for, its state (a word as well as a colour), the branch or tag, the commit, who started it and when, a link out to the run, and what it lights ("Lights 3 nodes", "Not mapped to a node"). Filters: state (succeeded, failed, running or waiting, cancelled or skipped) and a search; there are no labels or authors to pick.
- **Selecting a deploy** lights the nodes it restarted through the same paint as a pull request: amber with the search-match glow, the rest of the map faded back. A deploy that **failed** lights them red, as a failing check lights its tests. The panel lists the nodes, each with a button that selects it on the map. Select it again, or press **Clear**, to let go; closing the panel leaves the lights on and the header button says `deploy`.
- Containers, stacks and machines are on layers that start off. Selecting a deploy turns on the layers of the nodes it lights (and says which), because nothing would light otherwise; letting go leaves them as they are.
- Only one thing is lit at a time: selecting a deploy lets go of a selected pull request, and the other way round.
- **Refresh** asks the forge again.

## By keyboard, on a phone

The tab, the rows, Clear and the node buttons are buttons in the tab order; selecting a deploy, what it lights and which layers it turned on are said through the map's live region ([accessibility](accessibility.md)). On a phone the panel is the same bottom sheet; a node button collapses it so the map shows. Colours are the explorer's theme tokens, right in light and dark.
