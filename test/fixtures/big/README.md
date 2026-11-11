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

The retro theme uses only documented tokens and `data-corn` hooks. These parts of the explorer could not be restyled through them without fighting the CSS, so they are left as cornfield draws them:

1. **Map labels** are drawn on a canvas in a fixed stack (`FONT_NODE`, `FONT_EDGE` in `explorer/scene.js`), so Nunito and the pixel face never reach them. Needed: a `--corn-map-font` token.
2. **Map line work and halos**: edge width, dash pattern, edge alpha, the soft glow around a node and the selection halo's size have no tokens (only colours, and the node outline). Needed: `--corn-map-edge-width`, `--corn-map-glow`.
3. **The sign-in, "ask a maintainer" and 401 pages** (`server/auth.js`) carry their own inline style, no theme link, no tokens and no hook, so they stay in cornfield's look. Needed: the theme stylesheet linked in, and `[data-corn="auth-page"]`, `[data-corn="auth-card"]`.
4. **Node shape**: nodes are circles in every theme (documented), so a square pixel node is not possible.
5. **Glyphs that are text**: the hint's hand emoji is a character in the markup (`explorer/index.html`); a theme cannot swap it (it sits inside `[data-corn="hint"]` with no hook of its own). Needed: `[data-corn="hint-icon"]`.
6. **Tab counts and run-card numbers** (`.hx-forge-count`, token and cost figures) are internal classes: digits cannot be set to tabular figures or the rounded face on their own. Needed: `[data-corn="count"]`.
7. **Focus ring offset**: only the ring's width is a token. Needed: `--corn-focus-offset`.
8. **The dark level's borders are lavender, not ink**: an ink border on deep indigo is not visible, so `--corn-line` is a light lavender in the dark level and ink only in the light level. A token for a different border colour per level is not needed; this is a choice, not a gap.

Contrast (`cornfield validate`, light and dark, the standard theme): passes, no errors and no warnings. Three pairs failed on the first draft and were darkened or lightened: light `--corn-hue-lime` on its 6% tint (4.49:1), dark `--corn-accent-text` and `--corn-bad` (`#ff8c98`) on `--corn-surface-3` (4.48:1).
