# Spec 0011: cornfield in another app (the interface as web components)

Status: **approved** (maintainer, in chat, 2026-11-12: "as recommended, go"), so it skips the map review gate ([ADR 0010](../adr/0010-cornfield-uses-its-own-gate.md)). Every open question is answered as recommended. Not yet built. Its proposal is [proposals/0011-cornfield-in-another-app.json](proposals/0011-cornfield-in-another-app.json).

A maintainer who plans work in one app and reviews it in cornfield jumps between two apps for one task. The aim is that they do not: cornfield's interface becomes a set of web components that another app puts on its own page, taking the sections it wants. The smallest case is one tag that works when dropped in.

## What the maintainer asked for

- Break the interface into web components, built with [StencilRS](https://github.com/popcorn245/StencilRS), that a user can take section by section into their own app.
- **Reviewing a proposal and viewing the map are the two biggest needs**; all of the interface is to become components in the end.
- The other app is a **sibling subdomain** of the cornfield server (for example `tasks.example.com` beside `map.example.com`).
- **A reviewer decides from inside the other app**: Approve and Send back work there, as the signed-in maintainer.
- A separate package for the components is fine, but **as much code as possible is shared** with cornfield's own page.

## What stands in the way

Counted on main at 0.45.0:

| What | Count | Why it matters |
|---|---|---|
| Modules that import the one shared `state` object | 31 of the explorer's modules | Two maps on one page would share one selection, one camera, one proposal |
| Modules that look elements up by document id | 17 (53 `getElementById` calls) | A component's elements are not in the document's id space |
| Listeners on `document` or `window` | 45 | Keys and clicks meant for the host app would reach cornfield |
| Width rules written as `@media` | 50 in `explorer.css` | A piece in a 400 px column of a 1440 px window is narrow, and the window is not |
| Markup in one `index.html` | 470 lines | No piece owns the elements it drives |
| The Work panel | 2,649 lines in one module | The largest and most entangled piece |
| The server's answer to another origin | none: no CORS headers, writes need `Sec-Fetch-Site: same-origin` | A sibling's page can read nothing and decide nothing |

What already helps: the renderers take a canvas, the scene takes its state as an argument, 22 pure `*-model.js` modules hold 6,349 of the explorer's 23,937 lines, and all data comes from a short list of routes.

## What a trial of StencilRS showed

Run on 2026-11-12 with `@popcorn245/stencilrs` 0.2.0, Vite 8.3.4 and `@stencil/core` 5.0.0-beta.25, in headless Chromium:

- The starter's six components build in 0.2 s, and its 18 tests pass.
- **A component can wrap a plain-JS module.** A trial component imported an untyped `.js` file from outside its package and drew on a canvas with it. Two instances on one page each drew their own data.
- **Tokens cross the shadow boundary; hooks do not.** A `--corn-*` value set on the page, and a different one set on one instance, each reached the canvas inside. A `::part()` rule from the page applied. A page rule on `[data-corn="…"]` did not.
- **A stylesheet from outside the package compiles in**, `@container` rule included.
- **Pieces can be taken one at a time.** Built with one entry per component, each shell is 1 to 2 kB, and they share one 98 kB runtime chunk (30 kB gzipped).
- **One gap:** a library built through the Vite plugin gets no type declarations, so a consumer's editor knows nothing of the tags, their properties or their events. Reported as [StencilRS#54](https://github.com/popcorn245/StencilRS/issues/54) (D11).

## Decisions

### D1. One engine, two shells

- **The engine** is the plain JavaScript in `explorer/` and `core/`: no build, no dependency, as today. It holds all behaviour, markup and CSS.
- **cornfield's page** is one shell: `index.html` and a small start-up module that mount the engine's pieces into the document.
- **The components** are the other shell: a new package, `components/`, of StencilRS components. Each is thin: it declares properties and events, mounts an engine piece in its root, passes property changes in, and unmounts on disconnect. A shell holds no behaviour and renders no interface of its own.
- cornfield itself keeps **no build step and zero runtime dependencies**. Vite, StencilRS and `@stencil/core` are development dependencies of `components/` alone. The root `npm test` does not need them.
- **Held by a test:** a component's source imports only from `explorer/pieces/` and `@stencil/core`.
- **Rejected:** writing the interface again in JSX (two interfaces to keep alike, and every fix made twice); building cornfield's own page from the components now (a build step for every contributor, before the pieces are proven; question 11 keeps it open).

### D2. The engine runs as an instance

Today the explorer is one program per document. It becomes something a page can make more than one of.

- `createInstance({ root, base, fetch, strings })` returns the object that holds what `state.js` holds today, plus the things a piece may reach: its root element, a fetch bound to a base address, the strings, and a way to tell the other pieces something changed.
- Modules take the instance as an argument and stop importing a shared `state`.
- Elements are found inside the instance's root, never by document id.
- Listeners go on the root. Keyboard shortcuts act only while focus is inside it. Window resize becomes a `ResizeObserver` on the root.
- Tokens are read from the root's computed style, not from `<html>`. Nothing is written to `<html>`.
- A piece never reads `location` and never writes `history`. Deep links (`?proposal=`, `?view=` and the rest) belong to cornfield's page shell, which turns them into the same properties a host app would set.
- **Held by tests:** tripwires that fail on `document.getElementById`, a `document` or `window` listener, `location`, `history`, or a fetch of a literal path, anywhere outside the page shell; and a test that runs two instances in one document and shows that selecting in one changes nothing in the other.
- cornfield's page makes exactly one instance, with the document as its root. **Nothing a user sees changes in this step.**

### D3. Each piece owns its markup and its end

- A piece is a module in `explorer/pieces/` that exports `mount(root, instance)` and returns `{ update, destroy }`. It creates its own elements; `index.html` keeps only the places they go.
- `destroy` removes every listener, timer and observer, and releases the WebGL context. **Held by a test:** mount and destroy a piece 50 times and nothing is left behind.
- This is what lets the page and a component share markup, not only logic.

### D4. The pieces

| Tag | What it is | Shadow root | Step |
|---|---|---|---|
| `corn-scope` | Where the data comes from, and what the pieces inside it share. Shows nothing itself | no | 3 |
| `corn-map` | The map: pan, zoom, select, a proposal drawn on it | yes | 2 |
| `corn-node-panel` | What is selected | yes | 4 *(built: the pieces in 4, the tags after step 5)* |
| `corn-layers` | The Layers menu | yes | 4 *(built)* |
| `corn-search` | Search, its count and its list | yes | 4 *(built)* |
| `corn-proposal` | The proposal's bar: title, Before, Diff, After, Whole map | yes | 5 |
| `corn-changes` | The change list, personas and scenarios, and the player | yes | 5 |
| `corn-decision` | Approve and Send back, and what each will do | yes | 5 |
| `corn-review` | **The one-tag review:** the six above, laid out | ~~no~~ yes (amended below) | 5 |
| `corn-work` | The Work panel; its tabs follow as pieces of their own | yes | 6 |
| `corn-explorer` | Everything cornfield's page shows | no | 7 |

- The what-if editor, the House view, the review tokens dialog and the account menu come with step 7 or later. The sign-in pages stay the server's.
- **`corn-review` has a shadow root after all, kept on purpose** (the PM, 2026-11-12, after the review piece's review, PR #248). Built without one, the review showed that a host's own rules reach in: a `button` reset, a border on every `canvas`, an indent on every paragraph restyled cornfield's controls, which is what D7 gives leaf pieces a shadow root against. So the tag mounts the whole review (`explorer/pieces/review.js`: the map, the bar, the change list and player, the node panel and the decision, on one instance) in **one** shadow root of its own, with every hook a part. It is not a layout of the leaf tags yet, and does not share a `corn-scope`'s instance (D5): `corn-proposal`, `corn-changes` and `corn-decision` as tags of their own are still to come.
- **Order:** the map, then the review, then the rest. The Work panel is last of the large pieces because it is the hardest to split, not because it matters least.

### D5. Pieces find each other through the nearest `corn-scope`

- A piece attaches to the nearest `corn-scope` around it and shares that scope's instance: one selection, one proposal, one camera.
- A piece with no scope around it makes a private one. So `<corn-map>` alone works, and so does `<corn-review src="…">`.
- **Rejected:** wiring each piece to a map by id (every host wires every piece by hand); a page-wide registry (one instance per page again).

### D6. Data in by property or by address; events out

- **By property.** `topology`, `proposal`, `config` and `strings` are plain objects the host sets. A host that fetches for itself needs no cornfield server in the browser at all. `corn-map` with a `topology` is complete.
- **By address.** `src` on a scope is the base address of a cornfield server. The scope fetches what its pieces need, with the maintainer's session (D9).
- **What the page takes from the address bar, a component takes as properties:** `proposal`, `view`, `node`.
- **Events out**, all prefixed `corn`: `cornSelect` (a node or an edge), `cornNavigate` (what cornfield's page would have put in the address bar), `cornDecision` (approved or sent back, after the server has answered), `cornAuth` (sign-in is needed). The host decides what each means for its own page.

### D7. Shadow roots, tokens that inherit, hooks that are also parts

- **Leaf pieces have a shadow root.** A host app's own styles must not restyle cornfield's controls, and cornfield's must not leak out. The composed pieces (`corn-scope`, `corn-review`, `corn-explorer`) have none: they are layouts of leaf pieces, so a host's CSS reaches each leaf directly.
- **Tokens stay the first way to theme.** `--corn-*` properties inherit through every shadow root (shown in the trial). The first piece on a page adds cornfield's default tokens to the document at zero specificity, so any ordinary rule of the host's, on `:root` or on one scope, overrides them. Light and dark follow a `theme` attribute on the scope (`light`, `dark`, `auto`).
- **Every `data-corn` hook is also a `part` of the same name.** A host styles one element with `corn-node-panel::part(panel-title)`. The test that today requires a hook on every control requires the matching part too.
- **A whole theme still works.** With the `theme` attribute set to use the server's theme, the scope fetches the project's theme stylesheet once and gives it to every leaf's shadow root, where its `[data-corn="…"]` rules apply as written. Its `--corn-*` token values are copied to the scope. Nothing else from it reaches the host's document.
- **One limit, documented:** inside a shadow root a rule cannot ask what `<html>` says, so a theme that restyles a hook by light or dark must do it through tokens. The `retro` fixture theme already does.
- **Amended for `corn-review`, kept on purpose** (the PM, 2026-11-12, after the review piece's review, PR #248): it has one shadow root, round the whole review, for the reason above: a host's global rules reached into the review without one (D4). `corn-scope` still has none.
- **Rejected:** no shadow roots, with Stencil's scoped styles (page-level hook rules would keep working, but every global rule of the host's, a `button` reset for one, lands on cornfield's controls); shadow roots with parts only (a theme written against hooks would have to be rewritten, and `::part()` cannot select a child of a part).

### D8. One stylesheet per piece, sized by its own box

- `explorer.css` (1,512 lines) is split into one file per piece. cornfield's page links them all. Each component names its own. The same files serve both.
- **Width rules become container queries** on the piece's own box. cornfield's page makes its body the container (the window's box, which holds everything: not the stage, which holds fixed boxes that a browser from before mid-2024 would pin to it), so the page lays out as it does today. `prefers-color-scheme` and `prefers-reduced-motion` stay media queries.
- Rules on `body`, `:root` and `*` move to a `page.css` that only cornfield's page loads.
- A piece fills the box its host gives it. Nothing inside is sized from the viewport.
- **Dialogs become native `<dialog>` elements**, opened modally. That puts them in the top layer from inside a shadow root and keeps focus in them, in place of today's three document-level focus traps.
- **Held by a test:** on the synthetic rig, cornfield's page at 1440×900 and 390×844, light and dark, is the same before and after the split.

### D9. The server lets a listed sibling in

One new config key: `embed: { origins: ["https://tasks.example.com"] }`. Exact origins, `https` only (plain `http` for a loopback name), checked by `validate`. **Empty by default, and empty means every response is as it is today**, held by a test.

For a listed origin:

- **Reads.** The data routes answer with `Access-Control-Allow-Origin` (that exact origin, never `*`), `Access-Control-Allow-Credentials: true` and `Vary: Origin`, answer the preflight, and expose `X-Proposal-Sha256` and `X-Proposal-Source`, which the decision needs.
- **Writes.** Today's check, same origin only, becomes: same origin, or a listed origin whose request says `Sec-Fetch-Site: same-site`. The Host check stays.
- **What a listed origin may write** is the review decision and nothing else at first (question 3).
- **The session cookie does not change:** `HttpOnly`, `SameSite=Lax`, bound to cornfield's own host. A sibling subdomain is the same *site*, so the browser sends the cookie on a credentialed request. **This is expected, not yet shown:** step 3 proves it in a browser with two names under one parent on the rig.
- **Signing in.** A piece that is refused shows "Sign in to cornfield" and emits `cornAuth`. The button takes the top window to cornfield's sign-in and back. The server returns only to cornfield itself or to a listed origin.
- **The theme's stylesheet and the images** drawn on the map are fetched with CORS, and their routes answer a listed origin. Without that the scope cannot read the stylesheet and WebGL refuses the images.
- **The host's own Content-Security-Policy** must allow cornfield's origin for connections and images, and for scripts when the components are loaded from the server. `docs/embedding.md` gives the lines.
- **Unchanged:** `frame-ancestors 'none'` and `X-Frame-Options: DENY`. Components are not frames.
- **What listing an origin means, said in the docs:** every script on that origin can ask cornfield for what the signed-in maintainer can read, and can do what a listed origin may write. A flaw in the host app becomes a flaw in cornfield's review.
- **Not supported:** two apps on a shared public suffix (two projects on one hosting provider's domain) are different sites and the cookie will not travel. The docs say so. A different site altogether is out of this spec.
- **Rejected:** an iframe of cornfield's page (the whole page or nothing, no shared layout, focus or theme, and it only needs `frame-ancestors` loosened, so it is the cheap answer to a different question); a token held by the browser (a secret in the host's page for any script to read); a cookie on the parent domain (sent to every sibling, listed or not).

### D10. In a host app, config never becomes script

- cornfield's page loads plugin modules named by the server's config (a live source, a floor renderer, a checker). **A component never does.** In a host app that would run another origin's code with the host's own privileges.
- A host that wants a plugin imports it itself and hands the module to the scope as a property.
- So the House view is not a component in this spec, and a proposal's mockups, which the server allows only in its own frames, open in a new tab on cornfield (question 7).
- Everything a component puts in the DOM is escaped as it is today; hook, part, kind and state names come from fixed lists, never from data.

### D11. How it ships

- **The package** is built by StencilRS through Vite: ES modules, one entry per piece and one for all, sharing one runtime chunk; `tokens.css`; and type declarations for every tag, property and event.
- **Type declarations are not produced by a StencilRS library build today** ([StencilRS#54](https://github.com/popcorn245/StencilRS/issues/54)). Until that lands, the package's types are written by a small script from StencilRS's own `analyze()` output, which already carries each property's type, the events and the methods, and are checked in CI.
- **One version.** The components are released with cornfield, under the same number. A scope with a `src` compares its version with the server's and says so in the piece when they differ by a minor or more. It never fails silently.
- **Two ways to get it** (question 5): from npm, for an app with a bundler; and from the cornfield server itself, at `/cornfield/components/`, so the components always match the server they talk to and a host needs one `<script>` line. A browser fetches a module script from another origin with CORS and without the cookie, so that route is open, as the theme's is, and answers a listed origin.
- **A size budget per piece**, set when the piece is built and held in CI. The shared runtime is 30 kB gzipped; the map's engine is measured in step 2.

### D12. The contract and accessibility carry over

- Tags, properties, events, parts and the `theme` attribute join the public contract in `docs/theming.md` and a new `docs/embedding.md`, each with a test, as tokens and hooks have today.
- axe runs on every component in headless Chrome, with the checks the page has: keyboard reach, focus after every action, live announcements, 44 px targets when narrow, contrast, reduced motion.
- Ids that label things stay within one shadow root, since `aria-labelledby` does not cross one.

## Sketches

The one-tag review, in a host app's page:

```html
<script type="module" src="https://map.example.com/cornfield/components/corn-review.js"></script>

<corn-review src="https://map.example.com" proposal="0042-retire-the-old-export"></corn-review>
```

```
+-- tasks.example.com ---------------------------------------------------------------+
| Tasks   Board   Calendar                                            (@) maintainer |
+----------------------+-------------------------------------------------------------+
| TASK-118             | 0042 Retire the old export       Before [Diff] After  Whole |
| Retire the old       +--------------------------------------+----------------------+
| export               |                                      | Changes   +1 ~3 -2   |
|                      |          (the map, narrowed          |  + export-v2         |
| Status  In review    |           to the change)             |  ~ importer          |
| Owner   maintainer   |                                      |  - export-v1         |
|                      |                                      | Scenarios  2         |
| Linked spec          |                                      |  > Play              |
|  0042 . PR #31       +--------------------------------------+----------------------+
|                      | Approve merges PR #31 and starts the build.                 |
|                      |                              [Send back]  [Approve]         |
+----------------------+-------------------------------------------------------------+
   the host app's own page                 <corn-review>, one tag
```

Sections taken one at a time, in the host's own layout:

```html
<corn-scope src="https://map.example.com" proposal="0042-retire-the-old-export" theme="auto">
  <main class="my-grid">
    <corn-map></corn-map>
    <aside>
      <corn-changes></corn-changes>
      <corn-decision></corn-decision>
    </aside>
  </main>
</corn-scope>
```

No server in the browser at all:

```js
const map = document.querySelector('corn-map');
map.topology = await myOwnFetch('/my/topology.json');
map.addEventListener('cornSelect', (e) => openMyPanel(e.detail.id));
```

How the code is shared:

```
                  explorer/ and core/            plain JS, no build, no dependencies
                  the engine: instance, pieces, models, CSS per piece
                     /                    \
   explorer/index.html + page.js           components/  (StencilRS, Vite)
   cornfield's own page                    <corn-map>, <corn-review>, ...
   mounts pieces in the document           each mounts one piece in its root
```

## Open questions for the maintainer

**Answered 2026-11-12:** the maintainer took every recommendation below.

1. **Thin shells over one shared engine**, not an interface written again in JSX (D1)? Recommendation: **yes**. It is the most code shared, and StencilRS still gives the properties, events, lifecycle, tests and packaging.
2. **Shadow roots on the leaf pieces**, with tokens inheriting, every hook also a part, and a whole theme handed in (D7)? Recommendation: **yes**.
3. **A listed origin may read, and may write the review decision, and nothing else at first.** Merging, starting agents and the rest arrive with `corn-work` under a second key the maintainer sets on purpose; minting review tokens is never open to another origin (D9)? Recommendation: **yes**.
4. **The server's theme inside a host app is asked for, not assumed** (D7)? Recommendation: **asked for**, since a host app usually has its own look.
5. **The package:** `@popcorn245/cornfield-components` on npm, the same version as cornfield, and also served by the cornfield server (D11)? Recommendation: **both**. Serving it means the image build gains a build stage; contributors still need none.
6. **The tag prefix is `corn-`** and events are prefixed `corn`? Recommendation: **yes**.
7. **Mockups open in a new tab** from a review in a host app, for now (D10)? Recommendation: **yes**.
8. **Plugins are handed in by the host, never loaded from config**, so the House view waits (D10)? Recommendation: **yes**.
9. **Dialogs move to native `<dialog>`** on cornfield's own page too (D8)? Recommendation: **yes**, one behaviour in both shells.
10. **The first milestone is `corn-map` and `corn-review` working in the host app** (steps 1 to 5), before the Work panel is touched? Recommendation: **yes**.
11. **Should cornfield's own page one day load the built components** in place of mounting the engine itself? Recommendation: **decide after step 5**, with two pieces in real use.

## What gets built, in order

Each step is its own release, and cornfield's page looks and behaves the same after each.

Where it stands (the PM, 2026-11-12; the pieces around the map added 2026-11-13): steps 1 to 5 are built, and with them the three tags around the map, `corn-node-panel`, `corn-layers` and `corn-search` (step 4's pieces became tags once the instance could have a root for each piece: `engine/roots.js`, and the cross-piece lookups by id became events and asks), and the JavaScript half of step 6 (the Work panel split into pieces on the instance, PR #249). What is left of steps 3 and 6, the routes a listed origin may read and write beyond the review's (the Work panel's, `corn-work`), waits on a second embed key, which is the maintainer's decision.

1. **The instance** (D2) *(built)*: `createInstance`, the map's modules moved onto it (render, scene, labels, layout, map-style, camera, input, frame), the page shell, the tripwire tests, the two-instances test.
2. **`components/` and `corn-map`** *(built)* (D1, D3, D6, D11, D12): the package, its build and tests in CI, the first piece and its shell, properties in and events out, the size budget.
3. **The server and `corn-scope`** (D5, D9) *(built; the routes beyond the review's wait on the second embed key)*: `embed.origins`, CORS, the write check, sign-in and return, theme images; the scope with `src`; a rig with two sibling names that proves the cookie travels.
4. **The pieces around the map** (D3, D7, D8) *(built)*: node panel, layers, search; the stylesheet split, container queries, parts, the theme handed in.
5. **The review** (D4, D6) *(built: `corn-review`, in one shadow root, D4)*: proposal bar, changes, player, decision, and `corn-review`. **The host app can review and decide here.**
6. **The Work panel** (D8) *(the JavaScript half built: the pieces on the instance; `corn-work` and the routes wait on the second embed key)*: `forge-panel.js` split into pieces, `corn-work`, the dialogs, and what a listed origin may do beyond the decision.
7. **The rest:** `corn-explorer`, the what-if editor, the account pieces, and question 11.

## What is not in this spec

- A host app on a different site, and any sign-in that is not cornfield's own session.
- Server-side rendering of the components, and wrappers for one framework or another. The tags are plain custom elements.
- The House view and repo plugins as components (D10).
- Any change to what the interface does or how it looks. This spec moves the interface; it does not redesign it.
- Translucent node colours between renderers ([#233](https://github.com/popcorn245/CornField/issues/233)).
