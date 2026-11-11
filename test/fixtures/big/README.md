# The big map and the retro theme (a review rig)

A generated repo at the scale of a big real one (922 nodes, 3,632 edges, 19 types), about 70 proposals, and a brand theme, for design reviews and tests. Nothing generated is committed; only the generators.

- `make.js`: `node test/fixtures/big/make.js --out <dir> [--seed 245] [--theme retro]` writes a servable repo, deterministic for a seed. `--from <topology dir>` builds the same kind of repo (config, stubs for every cited path, the proposals) from **any** topology folder (`topology.json`, plus `topology.cloud.json` and `topology.personas.json` when there are any), reading it and never changing it. Proposals are picked from the topology they are made for and name nothing of their own.
- `serve.js`: generates and serves, or serves a repo you made.
- `forge.js`: the fake GitHub, the sign-in and the seeded runs behind `--forge`.
- `../themes/retro/`: the `retro` brand theme. `--theme retro` wires it into the config (`theme: { css, fonts, fontHosts }` and `brand: { logo, wordmark, favicon, appName: 'Arcade' }`).

## One command each

```sh
# (a) the synthetic big map, default theme                          http://127.0.0.1:3401/
node test/fixtures/big/serve.js --port 3401
# (b) the same map in the retro theme                               http://127.0.0.1:3402/
node test/fixtures/big/serve.js --theme retro --port 3402
# (c) signed-in maintainer with a forge, PRs, issues, threads, checks and runs in every state   http://127.0.0.1:3403/
node test/fixtures/big/serve.js --forge --port 3403                 # add --theme retro, and --runner offline (or none) for no runner online
# (d) the same server, signed out: the real sign-in page, then where it lands
#     open http://127.0.0.1:3403/?proposal=0100-new-flow-across-apps&source=pull/21 in a fresh browser profile
```

Add `--layers` to any generated map to put project layers in its config (spec 0009: "Background jobs" off by default, "Outside calls", "Data"; `EXAMPLE_LAYERS` in `make.js`). Without it the config has no `layers`, which is the big map's own tests' case.

A map of your own: `node test/fixtures/big/make.js --from <topology dir> [--theme retro] --out <dir>`, then `node test/fixtures/big/serve.js --repo <dir> --port 3401` (with `--theme retro` it rewrites that repo's config and `tools/cornfield/` for the theme; with `--forge` it adds the signed-in states). Each command prints its URLs and the proposal slugs.

Every server binds to 127.0.0.1 only, whatever `CORNFIELD_HOST` says, and ignores any real sign-in or hook secret in your shell. The generated repo goes to `<tmp>/cornfield-big-<theme>-<port>` (or `--dir <dir>`, which must be empty or a repo the rig made: anything else is refused, never replaced), and cornfield's own state (sessions, runs) to another folder under the OS temp dir. This is a review rig, not something to deploy.

## The proposals

70 files in `docs/specs/proposals/`: `0001`-`0064` are small (a page, a service, a table, a change, a removal, an edge, an outside service; one to three scenarios), `0100`-`0105` are rich:

| Slug | What it shows |
|---|---|
| `0100-new-flow-across-apps` | adds, changes and removes, 5 scenarios including a long walk across the map, a **mockup** (`start.svg`) |
| `0101-alerts-to-people` | a source to a person through services and two outside providers; a push-fails scenario, an outage |
| `0102-retire-a-feed` | mostly removals (pages, an outside service and its calls), with the replacement added |
| `0103-swap-a-provider` | an outside service replaced by another; an outage of the new one |
| `0104-shared-component` | a shared package and component that many pages use; a duplicate removed |
| `0105-second-site` | a new machine, stack, containers and line; a walk that ends on the new machine |

Open one at `/?proposal=<slug>`. With `--forge` each rich one is also an open spec PR (#21 to #26, in slug order), so `/?proposal=<slug>&source=pull/<n>` opens it as a reviewer would, with Approve and Send back on.

## What is faked in (c) and (d)

The real cornfield server runs with sign-in on, against a fake GitHub on loopback (`test/server/fake-forge.js` with the recorded answers of `test/fixtures/forge/github.json`). Real: the sign-in page, the OAuth round trip (the authorize step redirects straight back, as GitHub does for an authorized app), the session, the Host check, the Work panel, the Specs tab with spec PRs, review comments. Faked: one maintainer (`maintainer-one`) of `owner/name`; the forge's PRs, issues, threads and checks (recorded answers plus the six spec PRs); the **runs** (rows written into `cornfield.db` before the server starts, one per state: requested, claimed, working, waiting, done, failed, stopped; no runner process exists) with 26-character ids as the API takes, so Reply, Continue and Stop work; the issues and deploys queries (their second pages too); the comments posted to a spec PR, kept in memory, so an approval reads back in the Work panel and on the proposal; the **runner** (a runner token whose last poll is refreshed every 20 seconds, or two days old for `--runner offline`; switch while running with `curl http://127.0.0.1:3503/__rig/runner?state=offline` (online, offline or none), the fake forge is on the server's port plus 100). Nothing leaves the machine and no token is real.

## What retro could not reach

The retro theme uses only documented tokens and `data-corn` hooks, no `!important` and no `.hx-*` selector. Since 0.35 it reaches what used to be on this list: the map's label font (`--corn-map-font`), line width and glow (`--corn-map-edge-width`, `--corn-map-glow`), the sign-in, "ask a maintainer" and 401 pages (the theme is linked in; `[data-corn="auth-page"]`, `"auth-card"`, `"auth-brand"`), the hint's icon (`[data-corn="hint-icon"]`), digits in their own face (`--corn-font-num`, `[data-corn="count"]`; `--corn-mono` is code again) and the focus ring's offset (`--corn-focus-offset`). Since the second pass of hooks it also reaches, with hooks and kinds alone (no class, no id), what used to need a class name: the pixel face on every button row (`[data-corn-kind="secondary"]` for Send back, Play, Edit, the run actions and Cancel), the Before / Diff / After control and its chosen option (`[data-corn="compare"]`, `[data-corn="compare-option"][aria-pressed="true"]`), the View switch, the avatar and the who line, the theme options, the proposal's name and counts, the Filter chip, PR labels, the out arrow, the way back and the detail's title, the nodes a pull request lights (`node-chip`), the capped list's "and N more", the node title, the diff pill and its four states, the review note, and the live chip's state. Still not reachable through tokens:

1. **Map line work**: the dash pattern, edge alpha and the selection halo's size have no tokens (the colours, the node outline, the line width and the glow do).
2. **Node shape**: nodes are circles in every theme (documented), so a square pixel node is not possible.
3. **The dark level's borders are lavender, not ink**: an ink border on deep indigo is not visible, so `--corn-line` is a light lavender in the dark level and ink only in the light level. A token for a different border colour per level is not needed; this is a choice, not a gap.

Contrast (`cornfield validate`, light and dark, the standard theme): passes, no errors and no warnings. Three pairs failed on the first draft and were darkened or lightened: light `--corn-hue-lime` on its 6% tint (4.49:1), dark `--corn-accent-text` and `--corn-bad` (`#ff8c98`) on `--corn-surface-3` (4.48:1).
