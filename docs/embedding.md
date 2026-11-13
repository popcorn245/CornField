# Embedding: letting another app of yours in

By default cornfield answers only its own page. With `embed.origins` you can list the origin of **another app of your own** (a task board, an internal portal) so that a page there can read the map and the proposals, and decide a review, as the maintainer who is signed in to cornfield in the same browser. This page has two halves. [The server's](#the-key): what it lets in, what it does not, and what listing an origin means; nothing there is on until you list an origin. [The components](#the-components): cornfield's interface as web components you put on your own page, which need no server at all when you hand them the data yourself.

## The short version: a review in your app

A maintainer opens a spec in your app (a task board, say, at `https://tasks.example.com`) and approves it or sends it back there, with their cornfield session. Five things:

1. **List your app's origin on the cornfield server** (`https://map.example.com`), in `cornfield.config.js`, and restart it. The two must be on one site (`tasks.example.com` and `map.example.com`), so the session cookie travels ([why](#what-listing-an-origin-means)):

   ```js
   export default {
     embed: { origins: ['https://tasks.example.com'] },
   };
   ```

2. **Load the tag from that server**, one line in your page (or `npm install @popcorn245/cornfield-components` and `import '@popcorn245/cornfield-components/corn-review'`):

   ```html
   <script type="module" src="https://map.example.com/cornfield/components/corn-review.js"></script>
   ```

3. **Put the tag where the review goes, and give it a height** (it fills its box; about 1100 by 680 is comfortable, under 768px wide it is the phone layout):

   ```html
   <corn-review src="https://map.example.com" proposal="0042-retire-the-old-export" source="pull/31"></corn-review>
   ```

   ```css
   corn-review { height: 680px; }   /* in your own stylesheet: a grid cell or a flex child works too */
   ```

4. **If your page has a Content-Security-Policy**, allow the server for scripts, fetches and images; nothing inline is needed ([the policy](#the-hosts-content-security-policy-for-the-components)):

   ```
   script-src 'self' https://map.example.com; connect-src 'self' https://map.example.com; img-src 'self' data: https://map.example.com; style-src 'self'
   ```

5. **Listen to what it says**, if your app wants to know: `cornDecision` (the server took Approve or Send back: `outcome`, `proposal`, `source`), `cornAuth` (the maintainer has to sign in: the review shows the link, `signIn`, and comes back to your page), `cornNavigate` (the proposal or its view changed: keep it in your own address so the way back from sign-in reopens it), `cornError` (something it could not do), `cornReady` (it is drawn).

What it does not do yet: it is not part of a `<corn-scope>`, it has no what-if editor, no mockups (they open on cornfield itself), no Work panel and no list of proposals to choose from ([the limits](#what-it-does-not-do-yet)). The rest of this page is the detail: [the server's half](#the-key) and [the components](#the-components), with [`<corn-review>`](#corn-review-the-one-tag-review) first.

## The key

`embed.origins` is a list of origins, each written exactly: a scheme, a host and an optional port, like `https://tasks.example.com` or `https://tasks.example.com:8443`.

- **No path, not even a trailing slash**, no query, no fragment, no user name, no wildcard (`https://*.example.com` is refused: list each one).
- **`https` only.** Plain `http` is allowed for this machine's own names, so a page you are building can use it: `localhost`, any `*.localhost`, `127.0.0.1` and `[::1]`.
- The scheme and host are lower-cased and a default port is dropped, so the same origin written two ways is one entry. At most 20.
- **Empty or absent by default**, which is how cornfield has always behaved: with nothing listed, every response is what it was without the key.

A wrong entry stops cornfield (and `cornfield validate`) with the entry's place and what is wrong, in words, for example `embed.origins[1] "https://tasks.example.com/" has a path, query or fragment (a trailing slash counts): list the origin only, like https://tasks.example.com.`

## What a listed origin may read

A page on a listed origin that calls `fetch(url, { credentials: 'include' })` gets an answer it can read, from these routes and no others:

| Route | |
|---|---|
| `/cornfield/config.json`, `/topology.json`, `/topology.cloud.json` | what the map is made from |
| `/proposals`, `/proposals/<slug>.json`, `/proposals/<slug>/decision`, `/proposals/<slug>/mockups` | the proposals, the facts the line above Approve is made from, and the list of a proposal's mockups (not the files) |
| `/proposals/<slug>/review` | the latest review (and, below, the one write) |
| `/api/forge/pulls/<n>` | one pull request, with its files and checks (the proposal bar reads it) |
| `/cornfield/theme.css`, `/cornfield/theme/<name>.css`, `/cornfield/theme/assets/…` | the look, so a component there can wear it |
| `/cornfield/components/<file>` | the web components themselves, as module scripts ([below](#from-the-server)); open without a session |

For a request whose `Origin` is exactly a listed origin the answer carries `Access-Control-Allow-Origin: <that origin>` (never `*`), `Access-Control-Allow-Credentials: true`, `Vary: Origin` and `Access-Control-Expose-Headers: X-Proposal-Sha256, X-Proposal-Source, X-Proposals-Forge-Error` (the headers the explorer reads from a proposal). The refusals on these routes carry them too, so the page can tell "sign in" (401) from "not found". The theme routes answer without a session and carry no `Allow-Credentials`: they hold nothing the session decides, so fetch them without credentials (the default).

The browser's preflight (`OPTIONS`) is answered, before the sign-in guard because a preflight carries no cookie, for the methods and the one request header (`Content-Type`) each route needs and no others.

**Everything else gets no CORS header, so the browser keeps it out of the page**: the routes that make or list tokens (`/api/review-tokens`, `/api/agent-tokens`), agent runs, every other `/api/forge/…` route, the explorer's own files, and the sign-in routes. Those wait for a later step and a second key.

## What a listed origin may write

Two writes, and only these:

- **`PUT /proposals/<slug>/review`**: Approve or Send back, as the signed-in maintainer.
- **`POST /api/forge/pulls/<n>/landing/cancel`**: the Undo of an approval's hold ([land on approval](proposals.md#land-on-approval)).

cornfield's own rule for a write stays: it comes from cornfield's own page. A listed origin is accepted for these two as well when **all** of these hold: the `Origin` header is there and is exactly a listed origin; `Sec-Fetch-Site` is `same-site` (or is not sent, as a browser too old to send it still sends `Origin` on a cross-origin write, and its cookie would not travel from another site anyway; any other value, `cross-site` included, is refused); the `Host` check passes; and there is a signed-in maintainer's session, which every write needs. Every other write from a listed origin is refused exactly as a stranger's is, and does nothing.

## What listing an origin means

**Every script that runs on a listed origin can ask cornfield as the maintainer who is signed in, and decide a review.** Cross-site scripting on that app, a browser extension that injects into it, a dependency that is compromised: each can read what the maintainer can read and approve what the maintainer can approve, while they are signed in to cornfield. List only an app you would trust with your own login, keep its own scripts under a Content-Security-Policy, and list as few origins as you can.

A loopback origin (`http://localhost:5173`, `http://tasks.localhost:5173`) is whatever program on this machine listens on that port, so list one only while you use it, and take it out before cornfield is shared.

**The cookie does not change.** It stays `HttpOnly`, `SameSite=Lax` and host-only (no `Domain`). So a page that is not cornfield never sees it, and it travels only on a request that is **same-site** with cornfield: the page and cornfield must share a registrable domain, like `tasks.example.com` and `map.example.com` (both `example.com`). A port is part of an origin but not of a site, so `localhost:5173` and `localhost:3350` are the same site. If the two are different sites (`tasks.example.org` and `map.example.com`), the browser does not send the cookie, a read answers `401`, and listing the origin does not change that.

**The public-suffix limit.** A "site" is the domain just under a public suffix. If both apps sit under a suffix that many unrelated people share (`a.co.uk` and `b.co.uk`, or two names under a hosting platform's shared domain, where each customer gets a name of their own), they are different sites, and the cookie will not travel; give both apps names under a domain you own. The reverse matters too: any page on a name under that same domain (`blog.example.com`) is same-site with cornfield, and a browser sends the cookie on its simple requests (a GET, a form post) even when that page is not listed. cornfield's own checks refuse such a write (the origin must be cornfield's or a listed one for two routes), and the page cannot read the answer, but if you run untrusted pages under the same domain, give cornfield a domain of its own.

## Signing in and returning

An embedded page that gets `401` sends the maintainer to cornfield to sign in, and cornfield sends them back:

```
https://map.example.com/auth/start?returnTo=https%3A%2F%2Ftasks.example.com%2Freviews%2F7
```

`returnTo` is read only when at least one origin is listed (with none, it is ignored, as it always was), and is honoured only when it is an absolute URL whose origin is cornfield's own or exactly a listed origin (the path, query and fragment are kept). Anything else (another host, `https://tasks.example.com.evil.test`, a user name in the URL, a backslash, another scheme or port, `//host`, `javascript:`) is ignored, and the sign-in ends where it always has: on cornfield's map (or on `return`, the same-origin path parameter, which keeps its rules and never takes an absolute URL).

## What does not change

- **cornfield cannot be framed**: `frame-ancestors 'none'` and `X-Frame-Options: DENY` stay on every response. A listed origin reads cornfield's data; it does not show cornfield's page in a frame.
- **The Content-Security-Policy of cornfield's own page** (everything from its own origin) is unchanged.
- **The `Host` check** (421 for any `Host` that is not a loopback name or the public URL's host) runs first, on every route, listed origin or not.
- **The session cookie** (above), and the sign-in itself.

## What the host app's own Content-Security-Policy needs

The host app's policy governs what its pages may fetch. If it has one, allow cornfield's origin for what you use:

- `connect-src https://map.example.com`: the `fetch` calls above.
- `style-src https://map.example.com` for the theme's stylesheets, `font-src https://map.example.com` for the fonts they name, and `img-src https://map.example.com` for its images (all under `/cornfield/theme…`).
- `script-src https://map.example.com` when you load the components from the server ([the exact policy](#the-hosts-content-security-policy-for-the-components)).

## Behind a reverse proxy

The proxy must pass `Origin`, `Sec-Fetch-Site` and `Host` through unchanged, answer `OPTIONS` by passing it on (cornfield answers the preflight), and must not add its own `Access-Control-*` headers: two of them make the browser refuse the answer.

## Trying it on one machine

Chromium resolves `*.localhost` to this machine, so two names are two origins that are also the same site. `node test/fixtures/big/embed-proof.mjs` ([the rig's README](../test/fixtures/big/README.md)) serves a blank host page and a cornfield on two such names, signs in, and shows what the browser sent and what came back for a listed origin, an unlisted one on the same site and a page on a different site.

## The components

cornfield's interface is also a set of web components, built with [StencilRS](https://github.com/popcorn245/StencilRS), that another app puts on its own page. Each is a thin shell over the same engine cornfield's own page runs (`explorer/pieces/`), so a map in your app is the map you see in cornfield: the same drawing, the same keys, the same way a tap selects. So far there are six: [`<corn-review>`](#corn-review-the-one-tag-review), a proposal on the map with Approve and Send back, in one tag; [`<corn-map>`](#properties-events-and-methods); [`<corn-scope>`](#corn-scope-and-src-reading-a-cornfield-server), which reads a cornfield server for the pieces inside it (`<corn-scope>` and a map's `src` come with the release after 0.48.0, `<corn-review>` with the one after that); and the three pieces that go around the map in a scope, [`<corn-node-panel>`, `<corn-layers>` and `<corn-search>`](#the-pieces-around-the-map-corn-node-panel-corn-layers-corn-search).

### Getting the components

Two ways, one build, one version number. The root package (`cornfield` on npm) has no part in either: it takes no dependency and has no build step, and a checkout that runs `node cli/cornfield.js` builds nothing.

#### From the server

Every cornfield **image** serves the components at `/cornfield/components/`, so they always match the server they talk to and a host needs one line:

```html
<script type="module" src="https://map.example.com/cornfield/components/corn-map.js"></script>
```

Your page's origin has to be in `embed.origins` (above): a browser fetches a module script from another origin with CORS, and without the cookie, and cornfield answers CORS only for a listed origin. For `https://tasks.example.com` the answer to the script and to each chunk it imports carries:

```
Access-Control-Allow-Origin: https://tasks.example.com
Vary: Origin
```

and no `Access-Control-Allow-Credentials` (the modules are fetched without the cookie). From an origin that is not listed there is no `Access-Control-Allow-Origin`, so the browser refuses the module and the tag stays an unknown element; with no origin listed at all, nothing is added to any response.

What is there (the files of the build, and only those; `manifest.json` lists them and is not itself served, a request for any other name, a folder, a dotfile or a path out of the folder is a plain 404):

| File | What it is |
|---|---|
| `corn-review.js` | registers `<corn-review>`: load this one for the review ([below](#corn-review-the-one-tag-review)) |
| `corn-map.js` | registers `<corn-map>`: load this one for the map |
| `corn-scope.js` | registers `<corn-scope>` ([below](#corn-scope-and-src-reading-a-cornfield-server)) |
| `corn-node-panel.js`, `corn-layers.js`, `corn-search.js` | register the pieces around the map ([below](#the-pieces-around-the-map-corn-node-panel-corn-layers-corn-search)) |
| `index.js` | registers every component, and exports `version` |
| `chunks/runtime-<hash>.js` | the Stencil runtime, shared by every entry |
| `chunks/engine-<hash>.js` | the engine every component shares, with the default tokens: what a map and a scope both load, one chunk |
| `chunks/map-<hash>.js` | the map piece and what it draws with: what a map and a review share, and a scope does not need |
| `chunks/corn-review-<hash>.js` | the review: the proposal's bar, the change list and the scenario player and the decision, and the engine's modules only they use (the review loads it, and nothing else does) |
| `chunks/node-panel-<hash>.js`, `chunks/layers-<hash>.js`, `chunks/sheets-<hash>.js` | the node panel, the layers' engine and the phone's sheets: what the review shares with the pieces around the map |
| `chunks/around-<hash>.js`, `chunks/corn-node-panel-<hash>.js`, `chunks/corn-layers-<hash>.js`, `chunks/corn-search-<hash>.js` | how a piece around the map joins its scope, and each of the three with its stylesheet (the search and the Layers menu hold their pieces) |
| `chunks/scope-<hash>.js` | a scope: `corn-scope.js` loads it at once, `corn-map.js` only when a map has a `src` |
| `chunks/status-<hash>.js`, `chunks/source-address-<hash>.js` | reading a server, its states and the server's theme (and the address checks): what a map with a `src`, a scope and a review with a `src` share |
| `chunks/review-source-<hash>.js` | what a review's `src` brings: loaded by `corn-review.js` only when a review has one |
| `chunks/rolldown-runtime-<hash>.js` | a few lines the bundler shares between chunks |
| `tokens.css` | cornfield's default tokens at zero specificity (optional: [Tokens](#tokens-and-the-theme-attribute)) |
| `version.json` | `{ "name": "@popcorn245/cornfield-components", "cornfield": "0.48.0" }` |
| `types/*.d.ts` | the declarations, as text |

**Caching.** Each answer has a strong `ETag` and the file's type with `nosniff`, and is compressed when the browser accepts it. `chunks/…-<hash>.js` are named by their content, so they are cached for a year (`public, max-age=31536000, immutable`). The entries (`corn-map.js`, `corn-scope.js`, `index.js` and the rest), `tokens.css`, `version.json` and the types are `no-cache`: the browser asks every time and gets a `304` when nothing changed, so a host always gets the version of the server it talks to, the moment that server is updated.

**It is open.** The route answers before the sign-in guard, like the theme's stylesheets, because a module script is fetched without the cookie. It holds no secret: it is the published package, the same files as on GitHub and npm. What anyone who can reach the server learns from it, signed in or not:

- the components' code, their type declarations and `tokens.css`;
- **which cornfield this is**: the release number is in `version.json` and in `index.js` (`export const version`); `manifest.json` carries it too but is never served. A signed-out visitor could not learn it before: `/cornfield/config.json`, which also carries it, is behind the sign-in. It is kept open on purpose: a host needs it to tell a mismatch, and the code of every version is public anyway. Keep the server updated, as with any version you publish;
- whether this server was built with the components (an image) or runs from a checkout (the `404` says so).

Nothing of the map, the proposals, the repo, the config or the session is reachable this way. `Host` is checked before this route answers (`421` for a name the server does not answer to), and only `GET` and `HEAD` are answered here: any other method on these paths goes to the sign-in guard as before.

**A checkout has no build.** cornfield has no build step, so a server started from a plain checkout has no components and answers `/cornfield/components/…` with a plain `404` that says so and how to build them (`cd components && npm ci && npm run build`: the server then serves `components/dist`, the one place it looks, beside its own `server/`). The image builds them while it is built and keeps only the result.

#### From npm

```sh
npm install @popcorn245/cornfield-components
```

```js
import '@popcorn245/cornfield-components/corn-review';  // registers <corn-review>
import '@popcorn245/cornfield-components/corn-map';     // registers <corn-map>
import '@popcorn245/cornfield-components/corn-scope';   // registers <corn-scope>; '@popcorn245/cornfield-components' registers every component
```

**On npm since 0.48.0**, published by each release with a provenance attestation ([RELEASING.md](../RELEASING.md#the-web-components-on-npm)). The package has the same files as above (`dist/`), the type declarations (`types` in its `exports`), and `"sideEffects": true`: importing a module is what registers its custom element, so a bundler must not drop an `import '…/corn-map'` that uses nothing from it (`true` tells it not to).

**One version.** The components are released with cornfield under the same number: `@popcorn245/cornfield-components@0.48.0` is the build of cornfield `0.48.0`, the one that cornfield's image serves, and `version.json`, the `version` export and the package say the same. Each release builds them with the version it just made. For a page that talks to a server, use the server's copy; if you install the package, keep it at your server's version: a scope or a map with `src` shows a notice when the two differ by a minor or more ([versions](#what-the-person-sees-and-what-is-said)).

#### Building them yourself

```sh
cd components
npm ci
npm run build        # dist/: ES modules, tokens.css, types/, version.json and manifest.json
npm run dev          # the demo page, http://localhost:3639/demo/: two maps from the synthetic fixture, one light and one dark
npm run check        # build, tests in happy-dom, tests in headless Chrome, the size budget (set CHROME_PATH where there is no Google Chrome)
```

### `<corn-review>`: the one-tag review

A maintainer reviews a proposal and presses **Approve** or **Send back** inside your own app, with one tag:

```html
<script type="module" src="https://map.example.com/cornfield/components/corn-review.js"></script>

<corn-review src="https://map.example.com" proposal="0042-retire-the-old-export"></corn-review>
```

It reads the map and the proposal from the cornfield server `src`, as the maintainer who is signed in to it in the same browser, and shows them as cornfield's own page does: the proposal on the map narrowed to the change, its bar (the proposal's name, the copy under review, what it adds, changes and removes, **Before**, **Diff**, **After**, **Whole map**), the change list with the personas and scenarios and the scenario player, the node panel for what is selected, and at the foot of the list the decision: one line that says what Approve will do in this exact state, **Send back** and **Approve**. It is one engine with cornfield's page (`explorer/pieces/review.js`): the same drawing, keys, words, hold and refusals.

**What it needs:**

- **A listed origin and a signed-in maintainer.** Your page's origin is in the server's [`embed.origins`](#the-key), the two are on one site ([signing in](#signing-in-and-returning)), and the maintainer has signed in to cornfield in this browser. Without that the review says so, in its box ([below](#what-the-person-sees-and-what-is-said-in-a-review)).
- **A height from your page.** The element is `display: block` and fills **100% of the box your page gives it**; give it a height with your own CSS (`corn-review { height: 680px }`, a grid cell, a flex child). With none it is 24rem tall (the minimum of the box inside), so a review dropped in is visible, and it is never lower than that, however much room you leave. A host page's `html { font-size }` changes what 24rem is. About **1100 by 680** is comfortable: the change list sits at the left, the bar on top, the node panel on the right. **Under 768px by its own width** (not the window's) it is cornfield's phone layout, with the bar and the list as bottom sheets; give it a tall box there (390 by 700 works).
- **The policy** of [a host that loads the components from the server](#the-hosts-content-security-policy-for-the-components): `script-src` and `connect-src` for the server's origin, and `img-src` for it and `data:` (the theme's icons, and the small inline images of a few controls). It makes no inline style and no `eval`; the styles are constructable stylesheets.
- **Nothing else of your page's**: it asks no other route and no other origin ([what it asks](#what-it-asks-and-with-what)).

| Property | Attribute | What it is |
|---|---|---|
| `src` | `src` | the server's base address (`https://map.example.com`, with an optional path). Another value is refused and said (`address`), and nothing is asked: not even the proposal, of your own page's origin in its place. With none, nothing is asked of anyone: a proposal's name says there is no server to read it from. Read when the element connects: **a new `src` is a new review** (it is made again) |
| `proposal` | `proposal` | the proposal's **name** (`0042-retire-the-old-export`), which the review reads from the server once it has the map; or, as a property only, the proposal **object**, shown for reading with no request for it (no Approve or Send back: a decision needs the name and the copy). `null` closes it. **It follows the reviewer**, as `view` does: `null` once they close the proposal in the bar, the name of a copy they open from it (an object stays the object). A value that is not a proposal's name is refused and said, and never asked for ([what it asks](#what-it-asks-and-with-what)). Not reflected |
| `source` | `source` | which copy of the proposal: `checkout`, `pull/31` (a spec PR, the only kind a decision can be made on) or a worktree's name. With none, the server answers with the first copy it lists |
| `view` | `view` (reflected) | `before`, `diff` or `after`. Set it to choose; **it follows the reviewer's own choice** on the bar, so reading it gives what is shown |
| `node` | `node` (reflected) | the id of the selected node. Set it to select; it follows a click or a key, as a map's does |
| `theme` | `theme` (reflected) | `light`, `dark`, or `auto` (the default): the ground the review is drawn for, as on `corn-map` ([Tokens](#tokens-and-the-theme-attribute)) |
| `useTheme` | `use-theme` | wear the server's theme ([below](#the-servers-theme-use-theme)): its rules go into this shadow root and its `--corn-*` tokens onto this element, and nothing into your document |
| `topology`, `config` | none | for a host that fetches for itself: the objects `topology.json` and `/cornfield/config.json` hold. With both, the review reads neither from the server (it still reads the proposal, and decides, there) |
| `strings` | none | your own words (`strings` keys to text). **When you set it, it is the words spoken**: the server's are not mixed in (as on a scope) |
| `checker` | none | the permission checker for the scenarios' checked steps, **a module your page imported itself**: `{ check(items, { signal }) }` ([plugins](config.md#sources)). A config never names one that is loaded ([config never becomes script](#corn-scope-and-src-reading-a-cornfield-server)); with none a checked step reads "Not checked" |

| Event | `detail` |
|---|---|
| `cornReady` | none: the first frame is drawn that shows the proposal asked for open, its title on the bar (or the bar saying why it is not open), once each time the element is put in the page; the line above Approve may still be reading the PR |
| `cornSelect` | once per change of the selection, whoever made it: the same as `corn-map`'s. Its fields: `id`, `kind`, `source`, `from`, `to`. `kind` is `node` or `edge`, or null when cleared; `id` is the node's id, `from->to` for an edge, or null; `source` is `tap`, `keyboard`, `api` or `state` |
| `cornNavigate` | the open proposal or its view changed: **what cornfield's own page would have put in its address bar**. Your page decides what to do with it (set its own address, keep it in state, ignore it); the component never touches `location` or `history`. Its fields: `proposal`, `source`, `view`, `change`. `proposal` is the name (null once closed, or for a proposal handed in as an object); `source` is the copy only when it was asked for by name (as the page leaves it out of the address otherwise); `view` is `before`, `diff` or `after`, or null once closed; `change` is `opened`, `view` or `closed` |
| `cornDecision` | the server took Approve or Send back, **after it answered**, once per decision. Its fields: `outcome`, `proposal`, `source`, `open`, `review`. `outcome` is `approved` or `notes`; `proposal` and `source` name the proposal **the decision was for**, read when the button was pressed (never from what is open when the answer comes); `open` is false when another proposal was opened, or this one closed, while it was sent; `review` is what the server answered: `{ verdict, at, by, posted, … }` (`posted: false` when the same approval stood already, and nothing new was posted). A refusal (409, 403, 401, 429, a failure, no answer) is never a `cornDecision`. **A review that is gone hears no answer**: an element taken out of the page, or given a new `src`, while its PUT is in flight (the second or so after the hold) says nothing, though the server may have taken it; the next review of that proposal shows the decision that stands |
| `cornAuth` | the server answered a read or the press with 401 or 403: the maintainer has to sign in. The review shows [the card](#what-the-person-sees-and-what-is-said-in-a-review); your page may show its own. Its fields: `status`, `signIn`, `during`. `signIn` is `<src>/auth/start?returnTo=<this page>`; `during` says what was refused: `load` (the map), `proposal` (opening it), `facts` (the line above Approve), `review` (reading the last decision), `send` (the press) or `landing` (Undo) |
| `cornError` | something the review could not do. Its fields: `kind`, `message`. `kind` is `not-listed`, `offline`, `server`, `address`, `version`, `theme` (as [a map's](#what-the-person-sees-and-what-is-said)) or `proposal` (the proposal did not open: there is none of that name, or the server refused or failed; `message` is what the bar says) |

Events bubble and cross the shadow root (`composed`). `cornSelect` and `cornNavigate` fire for a change you made yourself as well (`cornSelect`'s `source` is `api` then; `cornNavigate` says what changed, not who changed it); setting `proposal`, `source`, `view` or `node` to what is shown already does nothing and says nothing, so **answering an event by setting the property it describes does not loop** (set `proposal` to the name `cornNavigate` gave and the proposal stays open, whichever copy the server found). `cornAuth` with `during: 'facts'` is said once, not every half minute while the poll is refused.

| Method | What it does |
|---|---|
| `fit()` | puts the whole map in view |
| `focusNode(id)` | selects the node and brings it and what it lights into view (nothing happens when there is no such node) |
| `refresh()` | reads the tokens again and draws, as a map's does |

All three return a promise.

```js
const review = document.querySelector('corn-review');
review.addEventListener('cornNavigate', (e) => myRouter.replace({ proposal: e.detail.proposal, view: e.detail.view }));
review.addEventListener('cornDecision', (e) => {
  if (e.detail.outcome === 'approved') myTask.markReviewed(e.detail.proposal, e.detail.source);
});
review.addEventListener('cornAuth', (e) => console.info('sign in at', e.detail.signIn));
```

#### What the person sees, and what is said, in a review

The states of the load are the ones [a map shows](#what-the-person-sees-and-what-is-said) (loading, signed out, not a maintainer, not listed, offline, a server error, a bad address, and the version notice), in **the same card, with the same words, hooks, parts and `strings` keys**, in the middle of the review's stage while the review has no map; once the map is drawn they are gone. They are the load's, so a review needs nothing for them but the tag.

- **Signing in.** Signed out, the card says "You are not signed in to cornfield" and holds a real link, "Sign in to cornfield", to `<src>/auth/start?returnTo=<this page's address>`, with `target="_top"`: following it (or your page doing so with `signIn` from `cornAuth`) takes the browser to cornfield and back to your page, where the review loads and the proposal is open. A review does not navigate by itself. The server follows `returnTo` only for a listed origin, and the address the maintainer comes back to is whatever your page's address is: **put what the review needs to open (the proposal) in that address**, which `cornNavigate` gives you what to write.
- **A session that ends while a review is open.** A read or a press the server refuses with 401 or 403 puts **the same card, with the same link**, over the map (the line above Approve and the decision say it in words too, and keep what was typed: a note is not lost), and `cornAuth` says what was refused. A decision that is taken afterwards (the person signed in in another tab and pressed again) takes the card away.
- **A proposal that cannot be opened** is said in the bar, in words: "There is no proposal called 0099-nothing." (with the same name under another source, from the list the server gives, as a button, when it has one), or why the server failed, with Retry and Close. There is **no "Open the specs list"** here: that list is cornfield's own page's, and a button that goes nowhere is left out. `cornError` says `proposal` once. A session that may not read it shows the sign-in card.
- **A proposal with no copy on a spec PR** (a draft in the checkout or a worktree) can be looked at but not decided on: the foot says to push it as a spec PR to review it ([proposals](proposals.md)).

#### What a decision does

The same as on cornfield's page, one engine. **Approve** takes no note: one line above it says what it will do in this exact state (the PR, its checks, whether it lands, whether a run waits for a runner); a press with something the maintainer should know first (checks failed, a draft) asks first, in place; then a **hold of five seconds with Undo**, the focus on Undo, before anything leaves the page, and the end of the hold reads the facts once more. **Send back** opens a note field (the focus goes to it; Cancel gives the focus back to Send back) and needs a note. What is sent is what was on screen at the press, with the version it was about (`sha256` of the proposal, `headSha` of the PR): **the server refuses a version or a head the page was not shown** (409: someone pushed since), a maintainer who is one no longer (403) and a missing sign-in (401), and answers a repeat of an approval that stands with that one, posting nothing (`posted: false`). Each refusal and each failure is a line in the foot, never an `alert`, and the note stays. Closing the proposal, opening another, hiding the tab, going offline, Undo and Escape each stop a hold, and say so.

`cornDecision` is said **once the server has answered**, never before, with the answer. After an approval the proposal's PR is approved on the forge as the signed-in maintainer, and the server lands it when the checks allow (the line above Approve says if it will). After a Send back the note is posted on the PR, for the agent drafting the spec to read. What your app does with it (mark a task reviewed, move a card) is yours.

#### What it asks, and with what

Only these, every one on a route of the server's [list](#what-a-listed-origin-may-read), **to `src`'s own origin and no other**; the session (`credentials: 'include'`) goes with each but the theme's, and **none follows a redirect** (`redirect: 'error'`: cornfield answers none of these with one, and a server that did would send the request, with that other site's cookies, wherever it named; it fails instead, as a request with no answer does). `<name>` is the proposal's name, one path segment: a value that is not a proposal's name (`..`, a path, a URL, markup: a letter or digit first, then letters, digits, `.`, `_` and `-`, at most 200) is never put in a request, and the bar says "“..” is not a proposal's name." (`cornError` `proposal`). `source` is always a query parameter, encoded.

| Request | Credentials | When |
|---|---|---|
| `GET /cornfield/config.json` | the session, `cache: 'no-store'` | each load, unless you handed in both `topology` and `config` |
| `GET /topology.json?v=<time>` | the session | each load, unless you handed in `topology` |
| `GET /cornfield/theme.css`, `/cornfield/theme/<name>.css` | none (`omit`) | with `use-theme` |
| `/cornfield/theme/assets/<icon>` | none, as an image (`crossorigin="anonymous"`) | the icons the config's `theme.icons` names |
| `HEAD /cornfield/theme.css` | none, `mode: 'no-cors'` | only after a read got no answer (not listed, or offline) |
| `GET /proposals/<name>.json[?source=<source>]` | the session, `no-store` | opening the proposal |
| `GET /proposals` | the session, `no-store` | only when that answered 404: the same name under another source, offered as a button |
| `GET /api/forge/pulls/<n>` | the session | the proposal's PR, for the bar, when `source` is `pull/<n>` |
| `GET /proposals/<name>/review?source=<source>` | the session, `no-store` | the last decision, when the proposal opens |
| `GET /proposals/<name>/decision?source=<source>[&fresh=1]` | the session, `no-store` | the line above Approve: when it opens, again while it is open, and (`fresh=1`) at the end of a hold and after a decision |
| `PUT /proposals/<name>/review?source=<source>` | the session, `Content-Type: application/json`, `{"verdict","note","edits":[],"sha256","headSha"}` | Approve or Send back, once the hold is over |
| `POST /api/forge/pulls/<n>/landing/cancel` | the session, `Content-Type: application/json`, `{}` | Cancel landing, while an approval's landing waits |

With no `src` (and so no server) it asks nothing at all: a proposal handed in as an object is shown for reading, and a name says that there is no server to read it from. The requests a decision makes are byte for byte what cornfield's own page sends for the same steps (method, path, query, headers, body, and their order), but for the address being absolute, `credentials: 'include'` and `redirect: 'error'`: `node test/fixtures/big/review-requests.mjs` records both and compares them.

#### What it does not do yet

- **No what-if editor.** The page's "My edits" and its form are not in the review: a Send back carries a note, and no edits.
- **No mockups in place.** A proposal's mockups open only in cornfield's own frames. A reviewer who needs them opens the proposal on cornfield itself: `<src>/?proposal=<name>&source=<source>`, which `cornNavigate`'s fields make.
- **No Work panel**, so no threads, no "Start a run" and no "Answer" on the bar's waiting line (a reviewer sees none of these: they are not drawn), no search, no Layers menu, no account menu and no House view; the pieces of those are later components.
- **Not inside a `<corn-scope>` yet.** A review makes **its own instance**: it never asks a scope for one, and **takes its `src`, `theme` and `use-theme` from its own attributes only**, never from an enclosing scope. It does not share its selection, its camera or its proposal with the scope's other pieces or with another review. (A scope's `--corn-*` tokens still reach it, as they reach any element inside the scope, because tokens inherit.) Put `src` on the review.
- **One proposal at a time**, named by `proposal`: there is no list of proposals to choose from in the review.

Its shadow root, its parts (every `data-corn` hook inside it is a `part` of the same name: [the list](theming.md#parts)), its tokens and its keyboard are the map's and the pieces' own: a screen reader finds a region named "Proposal review" with the proposal's title at `h2`, the change list's sections at `h3` and the personas at `h4`; every control is reached with Tab and acts on Enter or Space; the map's keys act only while the focus is inside it.

### Loading it

The build is ES modules: one file per component, one for all, and a shared chunk that holds the Stencil runtime. Load it from the server (above), import it from your bundler, or copy `dist/` to where your app serves its files, and load the one you want:

```html
<script type="module" src="/vendor/cornfield/corn-map.js"></script>   <!-- or index.js: every component -->
<link rel="stylesheet" href="/vendor/cornfield/tokens.css">           <!-- optional: see Tokens below -->

<corn-map id="map"></corn-map>
<script type="module">
  const map = document.querySelector('#map');
  map.topology = await (await fetch('/my/topology.json')).json();     // the object topology.json holds: { nodes, edges }
  map.addEventListener('cornSelect', (e) => openMyPanel(e.detail.id));
</script>
```

`corn-map` with a `topology` is complete: it asks no server for anything. With a `src` it reads the map from a cornfield server instead, as the signed-in maintainer, and is as complete: `<corn-map src="https://map.example.com"></corn-map>` is one tag ([below](#corn-scope-and-src-reading-a-cornfield-server)). (Showing a proposal comes with later components.)

**Types.** The package declares the tag: `document.querySelector('corn-map')` is an `HTMLCornMapElement`, its properties are typed, `addEventListener('cornSelect', …)` gives a typed `detail` (`CornSelectDetail`), and `document.createElement('corn-map')` knows the element. For JSX, `LocalJSX.IntrinsicElements` holds the tag with its properties and an `onCornSelect` handler; merge it into your framework's own JSX namespace, for React:

```ts
import type { LocalJSX } from '@popcorn245/cornfield-components';
declare module 'react' { namespace JSX { interface IntrinsicElements extends LocalJSX.IntrinsicElements {} } }
```

### `<corn-scope>` and `src`: reading a cornfield server

A cornfield server is where a map's data comes from. A **scope** says which, once, and what is inside it shares it:

```html
<script type="module" src="/vendor/cornfield/index.js"></script>

<corn-scope src="https://map.example.com" theme="auto">
  <corn-map></corn-map>
</corn-scope>

<!-- or, with no scope: the same loading, in one tag -->
<corn-map src="https://map.example.com"></corn-map>
```

The server must list your page's origin in its [`embed.origins`](#the-key) and the maintainer must be signed in to it in the same browser, on the same site ([signing in](#signing-in-and-returning)).

`<corn-scope>` has no shadow root and shows nothing of its own:

| Property | What it is |
|---|---|
| `src` | the base address of the server: an `http` or `https` origin with an optional path (`https://map.example.com`, or `https://example.com/cornfield` behind a proxy's prefix). A user name, a query, a fragment, a space or any other scheme is refused, and said as the `address` state and `cornError` `{ kind: 'address' }`; nothing is asked |
| `theme` | `light`, `dark` or `auto` (the default): for every piece inside, as on `corn-map`. A map's own `light` or `dark` wins |
| `use-theme` | wear the server's theme: see [below](#the-servers-theme-use-theme). Off by default |
| `topology`, `config`, `strings` | for a host that fetches for itself: the objects `topology.json` and `/cornfield/config.json` hold, and your own words (`strings` win over the server's). With a `topology` **and** a `config` no request is made, and a scope with no `src` is handed everything this way |

**`src` is an address your page trusts, like a script's.** Put a server you run there, never an address built from a URL parameter, a form or anything else a stranger chooses: the server `src` names is asked as the visitor, with the visitor's cookies for that server's own site; its words, its map and its sign-in link are what your page shows; and its answers (or their absence) tell whoever chose it whether an address answers from your visitor's network.

**What the pieces inside share:** one instance of the engine: one selection, one camera, one topology, one set of words. A selection made in the map is the scope's. `cornReady` (the scope has its data), `cornAuth`, `cornError` bubble out of the scope (they cross shadow roots), and so do the pieces' own events (`cornSelect`).

**One map per scope.** The engine holds one canvas, one camera and one selection per instance, so it cannot draw two maps from one: a second `corn-map` in a scope draws nothing, says "This scope already has a map" in its own box, and the scope emits `cornError` `{ kind: 'second-map' }`. Two scopes on a page are two instances and do not touch each other (two servers, two selections). When the map that has the scope leaves, the first map that was refused and is still in the page takes the scope by itself and draws.

**How a piece finds its scope.** On connecting, a piece sends a composed, bubbling event, `corn-scope-request`, from its own element; the nearest `corn-scope` above it hears it (it crosses every shadow root between them, which `closest()` cannot) and answers with the instance, and stops it, so a scope inside a scope is the nearer one's. No answer: the piece makes a private instance, which is how `<corn-map>` alone has always worked. Everything that can change the answer sends the same message the other way, `corn-scope-changed`, at one piece, which then asks again:

- **a piece added later**: it asks as it connects, and the scope answers;
- **a scope added around pieces that are there already** (or defined after them): the scope walks its descendants, the light tree and the open shadow roots of your own components, and tells each `corn-` piece to ask again. A piece in a **closed** shadow root finds a scope that is around its component when it connects (the event crosses a closed root too), but a scope added later cannot find it: put the scope there first;
- **a scope removed**: its pieces are told and ask again, of a scope further up or of none;
- **a scope whose `src` changes**: the address is the instance's, so the scope makes a new instance for the new server, tells its pieces to take it, and ends the old one: the old server's reads still out are aborted and their answers never used. The map is drawn again (new canvases); what was selected on the old server is not carried over. A scope moved in the page does the same (it ends and starts again).

**What the answer holds.** The scope answers with a handle on its instance: the engine's state (the map, the selection), its `fetch` bound to `src`, and what the scope read (the config, with the signed-in maintainer's login, and the topology). Any script on your page can send `corn-scope-request` itself, or answer one, and get or give that handle, as it can reach the element itself. That gives it nothing it could not already have: on a listed origin it can `fetch` the same routes with the session ([what listing an origin means](#what-listing-an-origin-means)). It is one more reason to run only script you trust there.

#### What the person sees, and what is said

The map shows the state of the load in a box over itself (a polite live region says each state once and the focus is never taken); a scope with no map shows nothing, and says it through the events alone. Each word is a [`strings` key](theming.md#words) (a host or the server overrides it), each element a [hook and a part](theming.md#the-hooks) (`source-status`, `source-title`, `source-text`, `source-origin`, `source-sign-in`, `source-retry`, `source-notice`, `source-announcer`).

| State | What the server did | The words (key) | `data-corn-state` | Events |
|---|---|---|---|---|
| loading | a request is out | "Loading the map …" (`sourceLoading`), quiet: a line, no box | `running` | |
| sign in | 401 on a gated read (signed out) | "You are not signed in to cornfield" (`sourceSignedOut`), "This map is behind cornfield's sign-in." (`sourceSignInText`) and a real link "Sign in to cornfield" (`sourceSignIn`) to the server's sign-in, with `target="_top"`, `rel="noopener"` | `waiting` | `cornAuth` `{ status: 401, signIn }` |
| not a maintainer | 403 on a gated read (signed in, not as a maintainer) | "This map is for the project's maintainers" (`sourceNotMaintainer`), "You are signed in to cornfield, but not as a maintainer." (`sourceNotMaintainerText`) and the same link | `waiting` | `cornAuth` `{ status: 403, signIn }` |
| not listed | no CORS answer, from a server that is there | "This page is not listed by that cornfield" (`sourceNotListed`), "Add this origin to embed.origins on the server:" (`sourceNotListedHint`) and the page's origin, in a `source-origin`; Retry (`retry`) | `failure` | `cornError` `{ kind: 'not-listed', message: <origin> }` |
| offline | nothing answers, not even the reach test | "The map cannot be reached" (`sourceOffline`), "Check the connection, then try again." (`sourceOfflineText`); Retry | `stopped` | `cornError` `{ kind: 'offline' }` |
| server error | an answer that is not a config or a map (5xx, not JSON, no nodes) | "The map could not be loaded" (`errorTitle`) and what it answered; Retry | `failure` | `cornError` `{ kind: 'server', message }` |
| bad address | `src` is not an http(s) origin | "That is not the address of a cornfield server" (`sourceBadAddress`) and what is wrong | `failure` | `cornError` `{ kind: 'address', message }` |
| version | the server's minor or major differs from the package's | a quiet line along the bottom (not an alert): "This map and its server are different versions" (`sourceVersion`) and both numbers; the map keeps working | none | `cornError` `{ kind: 'version' }` |
| second map | a second `corn-map` in a scope | "This scope already has a map" (`sourceSecondMap`) | `failure` | `cornError` `{ kind: 'second-map' }` |

- **Not listed and offline are told apart** by a second request: a fetch the browser refuses says nothing about why, so after it the scope asks `HEAD /cornfield/theme.css` with `mode: 'no-cors'` and no credentials (no cookie; the `Referer` is your page's origin only, under the browser's default policy). An answer the page may not read (opaque) means the server is there and did not answer this origin: not listed. No answer at all, or a browser that says it is offline: offline. A `src` with a wrong path on a server that is there reads as not listed too: the server gives no CORS answer for a path it does not have. (A host's own Content-Security-Policy that blocks the connection looks like offline: [the lines it needs](#the-hosts-content-security-policy-for-the-components).)
- **Sign-in's way back** is `<src>/auth/start?returnTo=<the address of this page>`, read when the state is said (so a page that changed its address says the new one). The server follows it only for a listed origin ([signing in](#signing-in-and-returning)); a page address longer than 1,024 characters is not followed, and the sign-in then ends on the server's own page. A page that is not `http(s)` (a file) has no way back, and the link goes to the sign-in alone. **The component never sets `location`**: a person follows the link, or your page does with `signIn` from `cornAuth`.
- **Retry** asks again (the config, then the map). After a map loads from a Retry, the focus goes to the map, as the box it was on is gone. The focus is never moved otherwise.
- **The words are plain text.** `cornError`'s `message` repeats what the server answered (a status line, the two versions, the origin to list): put it in your page as text, never as markup.

**Versions.** The components are released with cornfield under one number. The scope compares its own (`version`, also in `dist/version.json`) with the server's (`config.version`): a different **minor or major** shows the notice and says `cornError` `{ kind: 'version' }`, and **keeps working**; a different patch says nothing; a version that is not `x.y.z` (with an optional `-pre` or `+build`: a dev build, or anything else) cannot be compared, says nothing and is never shown.

**Config never becomes script** ([spec 0011 D10](specs/0011-cornfield-in-another-app.md)). cornfield's own page loads the plugin modules a config names (`sources`: a live layer, a floor renderer, a checker). A component **never** does: it does not `import()` a module a config names, follows no import map and evaluates nothing from a config, so another origin's code never runs with your page's privileges. (The one `import()` in the package is a map's of the package's own `chunks/scope-<hash>.js`, from where the map itself was loaded.) It takes from a config only the words (`strings`), the project's layers, and the map's theme (icons, drawn as images). The config's `links` and `brand` are the page's header, which a component has none of. A host that wants a plugin imports it itself.

**What it asks, and with what.** Only these, all of the server's [routes a listed origin may read](#what-a-listed-origin-may-read), all with `GET` (and one `HEAD`):

| Request | Credentials | When |
|---|---|---|
| `/cornfield/config.json` | the session (`credentials: 'include'`), `cache: 'no-store'` | each load |
| `/topology.json` (with `?v=` and a time, as the page's own) | the session | each load, unless the host handed in `topology` |
| `/cornfield/theme.css`, `/cornfield/theme/<name>.css` | none (`credentials: 'omit'`): the route answers anyone, and a listed origin without `Allow-Credentials` | with `use-theme` |
| `/cornfield/theme/assets/<icon>` | none, as an image with `crossorigin="anonymous"` | the icons a config's `theme.icons` names (only paths under `/cornfield/theme/assets/`; any other is not asked for) |
| `/cornfield/theme/assets/…` | the browser's own for a CSS image (your page's cookies for that server's site) | the images the server's theme names, with `use-theme`, when a piece shows them |
| `HEAD /cornfield/theme.css` | none, `mode: 'no-cors'` | only after a read got no answer, to tell not listed from offline |

Nothing else: not `/topology.cloud.json` (the map does not use it), no proposal route, no write, no redirect followed (`redirect: 'error'` on each of these, the session's and the theme's), and nothing to any origin but `src`, whatever the config or the theme names (a theme's reference to another origin is dropped: [below](#the-servers-theme-use-theme)). The session goes only to `src`'s own origin. A path on `src` is kept. When the components themselves come from the server, a map with a `src` also fetches `chunks/scope-<hash>.js` from there, once, as a module (with CORS, without the cookie).

#### The server's theme (`use-theme`)

Off by default (a host app usually has its own look). With `use-theme` the scope fetches `<src>/cornfield/theme.css` and, when the config names a default named theme, `<src>/cornfield/theme/<name>.css`, builds **one constructable stylesheet** from the text, and gives it to the parts that need it, in two places only:

| What of the stylesheet | Goes where |
|---|---|
| its rules (`[data-corn="…"]` hook rules, element rules, `*`, `body`) | into **each piece's shadow root** (`adoptedStyleSheets`), where they apply as written. A rule on `body`, `html` or `*` reaches only that piece's own tree: a shadow root's sheet cannot match outside it. It is never adopted by your document |
| the `--corn-*` custom properties of the rules on `:root` or `html`, of the light block (`:root[data-theme="light"]`, and `:root:not([data-theme="dark"])` under `@media (prefers-color-scheme: light)`) and of the dark ones ([how a theme is written](theming.md#how-a-brand-stylesheet-works)) | onto **the scope's element**, as inline custom properties for the mode in force, which every piece inherits. They are read from the parsed sheet's `cssRules` and `CSSStyleDeclaration`s, never by cutting the text. Any other custom property is not copied. The tokens a default is made from others (a `-soft` tint mixed from `--corn-ok`) are declared on the element too, so the theme's `--corn-ok` reaches its tint |
| everything else (another `@media`, `@supports`, `@layer`, a keyframe) | stays in the sheet, in the shadow roots, nowhere else |

Nothing of it reaches your document: the sheet is not adopted there, the tokens are on one element, no `<style>` or `<link>` is added. A test loads a theme that also holds `body { display: none }`, `* { color: red }` and an `@import`, and shows your page's body, text and style sheets exactly as they were.

What a constructable stylesheet does not do, and so a theme that relied on it:

- **`@import`** is dropped by the browser (with a console warning): what the imported sheet held is not there. Put it in the theme file.
- **`@font-face`** does nothing in a shadow root's stylesheet (a shadow tree cannot define a font for the page): a theme's own fonts are not loaded and its font stack falls to the next family. **To keep them, load the fonts in your page yourself**: a `@font-face` in your own stylesheet that names the server's file (`src: url("https://map.example.com/cornfield/theme/assets/fonts/pixel.woff2")`), with the same `font-family` the theme's tokens name, and `font-src https://map.example.com` in your policy (the server answers a listed origin's font request with CORS). The `theme.fonts` links of the server's own page (Google Fonts) are in its page head, not in the theme file, and are not reached either: link them in your page if you want them.
- **A theme names nothing but its server.** A CSS image is fetched with your page's cookies for its own site, so the sheet must not send your visitors anywhere else: a reference to the server's own origin (its `/cornfield/theme/assets/…`) is made absolute (a relative one would resolve against your page), a `data:` image is kept, and **every other declaration, token or rule that names something to load is dropped** before the sheet is adopted: another origin, `//host`, another scheme, a `url()` written with CSS escapes, the strings of an `image-set()`, at any depth (`@media`, nesting, `@keyframes`, `@font-face`, `@property`). The server refuses such a theme too (`cornfield validate`), so this only matters for a server that did not check it. The theme's text is read up to 512 KB.
- **Light and dark** follow the scope's `theme`, else your `<html data-theme>`, else the system's setting, and the tokens change when they do. A rule that asks what `<html>` says cannot work inside a shadow root: make the difference through tokens.
- **A theme that fails** (not found, not CSS) leaves the default look and says `cornError` `{ kind: 'theme' }`.

### The pieces around the map: `<corn-node-panel>`, `<corn-layers>`, `<corn-search>`

Three tags that go beside a `<corn-map>` inside one `<corn-scope>`, wherever your layout puts them. Each has a shadow root of its own, each is a thin shell over the piece cornfield's own page runs (`explorer/pieces/node-panel.js`, `layers.js`, `search.js`), and they **share the scope's one instance**: one selection, one camera, one set of layers, one search.

```html
<script type="module" src="https://map.example.com/cornfield/components/index.js"></script>

<corn-scope src="https://map.example.com">
  <div class="my-grid">
    <corn-map></corn-map>
    <aside>
      <corn-search></corn-search>
      <corn-layers></corn-layers>
      <corn-node-panel></corn-node-panel>
    </aside>
  </div>
</corn-scope>
```

- **`<corn-node-panel>`** is what is selected: the node's kind and name, what it is, the lines it lights ("Frame them"), its facts, flows, data, mockups, threads and, with a proposal open, how the proposal changes it. A click or a key on the map fills it; its links select the node they name; its Close clears the selection. Opened it fills its box and scrolls inside; while nothing is selected it says "Select a node on the map to see its details" (the `empty` part).
- **`<corn-layers>`** is the Layers menu: a chip, "Layers · 14 of 22", that opens a menu of switches, one per kind of node with its count, All and None, and the key to the lines. Switching a layer redraws the map. The menu hangs under the chip; a click anywhere else in your page, or Escape, shuts it.
- **`<corn-search>`** is a field with a count, a list of what it found by kind ("Frame all 281", up to 50 rows, matches in a layer that is off last) and stepping through them (Enter, Shift+Enter, the arrows, the buttons). Choosing a match selects it on the map, flies the map to it and fills the panel.

**What each does alone.**

| Where it is | What it does |
|---|---|
| inside a scope, beside a map | all of the above |
| inside a scope with **no map** (yet, or any more) | it says what it needs and does nothing else: the panel "Select a node on the map to see its details", the other two "This needs a corn-map in the same corn-scope" (the `empty` part, words `nodePanelEmpty` and `needsMap`). A map added later brings it up; a map removed takes it down again, and the tag stays |
| beside a map that has **no data yet**: loading, signed out, not a maintainer, the server offline | the panel says what it is for, the search and the Layers menu "Waiting for the map" (`waitingForMap`): no field that would answer "No match" and no menu counting layers of a map nobody can see. The **map's card is the one place** that says what is wrong ("You are not signed in to cornfield" and its sign-in link, Retry), and the scope says `cornAuth` or `cornError` once: one card and one event for the scope, not one per tag. Signed in and back on the page, all four come up |
| a page the server **does not list**, loading the components from the server | nothing: the browser refuses the module (no CORS for that origin) and every tag stays an unknown, empty element. Installed from npm, the scope says "This page is not listed by that cornfield" on the map, with `cornError` `{ kind: 'not-listed' }` |
| **no scope** around it | it says "This needs a corn-scope around it, with a corn-map in it" (`needsScope`) and does nothing else. It makes a private instance with no map, so it reads nothing and requests nothing. A scope put around it later (a tag defined after the page, a wrapper added) is asked again, and it comes up. No `cornError` is sent: nothing here is an error until the page is done being built, and the words are on the screen |
| the tags in **any order**, a tag removed and put back | the same: a piece mounts when the instance has a map, and a panel put back is handed the selection the instance holds |
| **two scopes** on a page | two instances: nothing in one reaches the other |
| **two** panels, searches or Layers menus in one scope (a wide layout and a narrow one, one of them hidden) | one selection and one search for the scope (D5): both panels show the selected node and Enter on the map goes into the first that can take the focus; both search fields show the query and its count, and only the one last used speaks in its live region (so it is said once), but each `<corn-search>` sends `cornSearch`; both Layers menus switch the same layers |
| inside your own element's shadow root, **open or closed** | the same: the focus, the keys, the wheel and a click inside the Layers menu are known there too |
| the scripts loaded in any order (a tag defined before `corn-scope.js` or `corn-map.js`) | it says what it needs until they come, then comes up |

A second `<corn-map>` in a scope is refused, as before.

| Property | Attribute | What it is |
|---|---|---|
| `query` | `query` | what is searched for. Set it to search; it follows what the person types (not reflected: it changes with every key). `<corn-search>` only. The node panel and the Layers menu have no properties: the selection and the layers are the scope's (`node` on the map, `layers` in the config) |

| Event | `detail` |
|---|---|
| `cornSearch` | the query, or the chosen match, changed, whoever changed it (typing, `query`, Enter, a row), once per change and per `<corn-search>` in the scope. Its fields: `query`, `current`. `query` is what is searched for now, trimmed, or an empty string once cleared; `current` is the id of the chosen match, or null while none is |

The events and the method are `<corn-search>`'s (the node panel and the Layers menu have none). A tag that waits (for a scope, a map or the map's data) sends no event of its own: it is not an error while your page is being built, and the scope already says `cornAuth` or `cornError` for its server. To tell it in script, look for its `empty` part: `el.shadowRoot.querySelector('[part="empty"]')` is there exactly while it waits. `cornSelect` is **the map's alone**: it says every change of the scope's selection, whoever made it (`source` is `search` for a match chosen in `<corn-search>`, `link` for a node chosen in the panel, `tap` for the panel's Close), so one listener on the map hears it once and the panel, Layers and search never repeat it. With no map in the scope nothing is selected, so nothing is said.

| Method | What it does |
|---|---|
| `focusField()` | puts the focus in the field, its text selected: for a shortcut of your own (`/` already does it while the focus is on the map or in the search) |

**Theming.** Tokens inherit from the scope, and `theme` on the `<corn-scope>` (`light`, `dark`, `auto`) is what makes everything inside light or dark, the map's ground included; `use-theme` on the scope puts the server's theme in each tag's shadow root. These three tags have no `theme` property of their own: a `theme="dark"` attribute on one only re-declares that mode's tokens on it (the package's sheet covers every tag), so a forced-dark search field beside a light map is possible, but nothing else reads it.

**Parts.** Every `data-corn` hook of a piece is also a part of the same name: `corn-node-panel::part(node-title)`, `corn-layers::part(layers-button)`, `corn-search::part(search-input)`. The lists are in [theming.md](theming.md#parts).

**Sizing.** Each tag is `display: block` and fills the place your layout gives it; your rules on the element win (nothing of its own is `!important` but `[hidden]`). Each is a **query container on its own width** (`container: corn-box / inline-size`), so what a phone does in cornfield's page happens when *its box* is under 768px, whatever the window: controls of at least 44px, and for the search the count and the step buttons on a row of their own under the field. Nothing is sized from the window.

- **`<corn-node-panel>` is never a phone's bottom sheet.** On cornfield's page a narrow window turns the panel into a sheet docked at the bottom of the map, over the map, which only makes sense where the panel and the map share one screen and one dock. Here you place the panel: in a 360px box it is the same panel at 360px, in flow, as tall as the box you give it (give it a height to make it scroll inside; with none it grows with its content), with no dim layer and no handle. Make it a sheet, a drawer or a column with your own layout. It does not slide in from the right either, and it covers nothing of the map: the map frames a node into the whole of its own box. If your layout lays the panel over the map, the map does not know it.
- **`<corn-layers>` hangs its menu under the chip**, in a narrow box too (cornfield's page spans it across the phone's window, from the window's edges; a host's tag does not use the window). The menu has the page's ground, not the see-through surface, because it hangs over whatever your page has there. A narrow host slot does not narrow the menu below 16rem.
- **`<corn-search>`'s field is always shown.** The phone's icon and search bar are cornfield's header's; here the field is the tag, at the width of its box, and its list hangs under it, at least as wide as the field.

**Keyboard, focus and screen readers (D12) across the shadow roots.** All of it holds when the three sit in roots of their own, in the order you place them:

- On the map **Enter** moves the focus into the open panel (its title), **Escape** in the panel closes it, puts the focus back on the map and announces "Panel closed". N and P, the arrows and the other keys of the map are the map's, and act only while the focus is on it.
- **`/`** goes to the search field from the map, from the panel and from the search's own list (not while typing in a field). The keys act while the focus is inside any root of the scope's instance, never outside it.
- The **count is announced** in the search's own polite live region once typing pauses ("309 matches", or "No match for “xyz”"); a match chosen, "Framed 7 matches", a layer switched ("Apps off. 802 nodes shown.") and "Panel closed" are said by the map's live region. With **no map** the tags speak in a live region of their own instead, so a panel or a search beside no map still says them.
- The Layers chip is a button with `aria-expanded` and `aria-controls` for a menu of buttons with `aria-pressed`; the search is a combobox over a listbox; the panel is a named region (`aria-label="Node details"`), `inert` while it is closed.

**Under a strict Content-Security-Policy** (`style-src 'self'`, no `'unsafe-inline'`; loaded from the server, the policy is [the components' policy](#the-hosts-content-security-policy-for-the-components), nothing more): the pieces' stylesheets are constructable sheets, the dots of the Layers menu and the data-flow key get their colour through the CSS object model (not an inline `style="…"` that came in as a string: only a swatch's background, shadow and outline, one property at a time, never a `url()`), and nothing here uses `eval`, a worker, or a `blob:` or `data:` script. [`test/fixtures/big/around-proof.mjs`](../test/fixtures/big/around-proof.mjs) holds it in a browser.

**What it does not do yet.**

- **No phone sheet for the panel** (above): that is the host's layout.
- **A panel laid over the map by your layout is not known to the map**: it frames a node into its whole box. The page's own panel tells the map how much it covers (`panel:covers` on the instance); a tag in a box of its own covers nothing.
- **The proposal's bar, change list, decision and the Work panel** are still in `<corn-review>` and cornfield's page; their tags are the next step.
- **No `corn-explorer`** and no way to pass the node panel a node of your own: the selection is the map's.

#### How the pieces find each other (for a shell of your own)

A scope's instance has one primary root, the map's, which `inst.el(id)` searches. A piece in another shadow root **joins** the instance (`engine/roots.js` `joinRoot`), so that the instance's focus (`inst.active()`) and keys (`listenRoots`) are its own there too, and it reaches a neighbour only by an event or an `ask` on the instance, never by an id: the map answers `announce:write`, the node panel `panel:present` and `panel:covers`, the Layers menu `layers:present`, the search tells its live region `search:status`. The map says `map:ready` and `map:gone`; `explorer/pieces/around.js` mounts a piece when there is a map and ends it when there is none. The full list is in the header of `explorer/instance.js`.

### With a Content-Security-Policy

`<corn-map>` works under a strict policy such as `default-src 'self'; style-src 'self'`, with no `'unsafe-inline'` and no `'unsafe-eval'`, as long as you serve the files from your own origin (or load them from a cornfield server: [the exact policy](#the-hosts-content-security-policy-for-the-components)):

- **Scripts:** the modules, from wherever you serve `dist/` (`script-src 'self'`, or that origin). They run no `eval`, start no worker and make no `blob:` or `data:` URL.
- **Styles:** the component's own styles and the default tokens are constructable stylesheets (`adoptedStyleSheets`), which a policy does not govern, so `style-src` needs nothing for them. A `<link>` to `tokens.css` needs `style-src` to allow where it is served.
- **Connections and images:** none for a map you hand its data. With `src` or a scope (see [below](#the-hosts-content-security-policy-for-the-components)), the server's origin.

(A browser without constructable stylesheets would fall back to a `<style>` element for the default tokens, which such a policy blocks; every browser that runs the components has them.) Tried in headless Chrome with that policy as a response header and a page whose own CSS resets every element: no violation reported, and the map is styled and drawn.

### The host's Content-Security-Policy for the components

If the host page has a Content-Security-Policy and loads the components from a cornfield server (`https://map.example.com`), with a scope or a map with `src` reading that server, this is what it needs, and it is enough:

```
Content-Security-Policy: default-src 'self'; script-src 'self' https://map.example.com; connect-src 'self' https://map.example.com; img-src 'self' data: https://map.example.com; style-src 'self'
```

- `script-src https://map.example.com`: the entry and the chunks it imports. Nothing else of the components is script: no `eval`, no worker, no `blob:` or `data:` URL, and never a module a config names. When you install from npm and bundle, `script-src 'self'` is enough for the components.
- `connect-src https://map.example.com`: the config, the map, the theme and the reach test are all `fetch` calls. A blocked connection looks like [offline](#what-the-person-sees-and-what-is-said): the browser tells the page nothing more. `<corn-map>` with a `topology` and no `src` makes none.
- `img-src https://map.example.com`: the icons of a theme's `theme.icons`, which the map draws. And `img-src data:`: a few of the controls draw a small inline image (the review's view menu on a phone, a chevron), and a server's theme may hold `data:` images, which it keeps ([below](#the-servers-theme-use-theme)); without it those are refused and reported, and the rest works.
- `style-src 'self'` and **no `'unsafe-inline'`**: the components' styles and the server's theme are constructable stylesheets, and the theme's tokens are set on the scope's element from script (`style.setProperty`); `style-src` governs neither, so nothing inline is needed. Add `https://map.example.com` to `style-src` only if you link its `tokens.css` or the theme's stylesheets yourself, and to `font-src` if you load the theme's fonts yourself ([above](#the-servers-theme-use-theme)).

A page under exactly this policy loads the components from a listed origin and draws the map, in `components/test/host.test.ts`; the synthetic rig's proof (`node test/fixtures/big/scope-proof.mjs`) does the same with `src` and `use-theme`, and no violation is reported.

### Properties, events and methods

| Property | Attribute | What it is |
|---|---|---|
| `topology` | none | the map to draw: the object `topology.json` holds. It is not changed: the map works on copies. A new object replaces the map (the selection stays when the new one has the node); what is not a node or an edge is left out |
| `node` | `node` (reflected) | the id of the selected node. Set it to select; it follows a click or a key, so reading it gives the selection. A node the map has not got yet is selected when a topology brings it |
| `view` | `view` | `map` (default) or `dataflow` |
| `theme` | `theme` (reflected) | `light`, `dark`, or `auto` (the default): see Tokens |
| `renderer` | `renderer` | `auto` (WebGL2 when there is one, default) or `canvas2d` |
| `src` | `src` | the base address of a cornfield server, for a map with no `corn-scope` around it: a private scope's worth of loading in one tag. Inside a scope it is ignored; a new value is a new map (it is made again) |
| `useTheme` | `use-theme` | with `src` and no scope: wear the server's theme ([below](#the-servers-theme-use-theme)). Inside a scope the scope's decides |

| Event | `detail` |
|---|---|
| `cornSelect` | once per change of the selection, whoever made it. Its fields: `id`, `kind`, `source`, `from`, `to`. `kind` is `node` or `edge`, or null when the selection was cleared (and `id` is null). `id` is the node's id, or `from->to` for an edge, whose ends are also in `from` and `to`. `source` says who: `tap`, `keyboard`, `api` (`node` or `focusNode()`), or `state` (a new topology without the selected node) |
| `cornReady` | none: the first frame with a map in it is drawn, once each time the element is put in the page |
| `cornAuth` | with `src` and no scope (in a scope, the scope says it): the server wants the maintainer signed in. Its fields: `status`, `signIn`. `status` is 401 or 403; `signIn` is the server's sign-in, which returns to this page |
| `cornError` | with `src` and no scope: something the map could not do. Its fields: `kind`, `message`. `kind` is `not-listed`, `offline`, `server`, `address`, `version` or `theme` (see [the states](#what-the-person-sees-and-what-is-said)); `message` is a few plain words more |

Events bubble and cross the shadow root, so a listener on any ancestor hears them. `cornSelect` fires for a change you made yourself with `node` as well (`source` is `api`), and setting `node` to what is already selected does nothing and says nothing, so handling the event by setting `node` does not loop.

| Method | What it does |
|---|---|
| `fit()` | puts the whole map in view |
| `focusNode(id)` | selects the node and brings it and what it lights into view (nothing happens when there is no such node) |
| `refresh()` | reads the tokens again and draws: for a token you change at run time where the map cannot see it (a stylesheet added to your page's head, a class or a style on a wrapper) |

All three return a promise. The map follows by itself the changes it can see: its `theme`, your `<html data-theme>` or class, and the system's light or dark; `refresh()` is for the rest.

### Sizing and layout

The element is `display: block` and **fills the box its host gives it**: give `corn-map` a width and a height with your own CSS (`corn-map { height: 520px }`, a grid cell, a flex child) and the map follows it when it changes. With no height it is 16rem tall, so a map dropped in is visible. Nothing inside is sized from the window: a map in a 400px column of a wide window is a 400px map.

- **Your rules on the element win**: its display (a class with `display: none` hides it), its size, its margins. Nothing of the element's own is `!important` except `[hidden]`, which always hides it.
- **The 16rem minimum is the stage's**, inside the shadow root, so a page that resets every element (`* { all: revert }`) still gets a visible map (the element itself goes inline, as such a page asks). To make a map lower than 16rem, say so on the part too: `corn-map { height: 120px } corn-map::part(map-stage) { min-height: 0 }`.
- **It can wait unseen**: made inside a parent with `display: none`, or in a box of no size, it is fitted to its box when it gets one.
- **A parent may scale it**: a tap lands on the node under it inside a `transform: scale()` or a CSS `zoom`, in a scrolled container, and on a right-to-left page. Under a CSS `zoom` the map is drawn at its unzoomed size and scaled, so it is softer.
- **One element, one map.** Two on a page are two maps (each its own selection, camera and tokens); moved in the page, an element makes new canvases; removed, it ends its map and gives its WebGL context back, so making and removing many does not run the browser out of contexts.
- **A large map** is laid out when it is set, on the main thread: 5,000 nodes and 15,000 edges took 1.8 s before the first frame in headless Chrome on the machine the tests run on.

### The wheel and touch

On your page **the wheel is your page's while the pointer only passes over the map**: the page scrolls. The map takes the wheel, to zoom, when it has the focus (a click on it, or Tab) or while Ctrl or Cmd is held, which is also how a trackpad's pinch arrives. On a touch screen a finger on the map pans it and two fingers zoom it, so the page does not scroll from inside the map: leave room around a map that fills a phone's width. (cornfield's own page, which is all map, zooms with the wheel as always.)

### Tokens and the `theme` attribute

Every `--corn-*` token of cornfield's theme contract ([theming.md](theming.md)) inherits into the shadow root, and the map reads its own from the element, so **a map is themed like any other element: with CSS custom properties**.

- **The defaults.** The first `corn-*` element on a page adds cornfield's default tokens to the document, once (`document.adoptedStyleSheets`; a second copy of the package on the page finds the first's sheet and adds none), generated from `explorer/tokens.css` at build time with every selector at **zero specificity** (`:where(...)`). So any ordinary rule of yours overrides them: `:root { --corn-ground: #101a2e }` for every map, `.tasks { --corn-accent: #7a3e00 }` for the maps in one wrapper, `#board-map { --corn-map-node-app: #c0392b }` for one. An element inside a shadow root of your own adds the sheet to that root as well, once, for the rules on its `theme` attribute. The same sheet ships as `tokens.css` for a page that prefers a `<link>`.
- **Light and dark.** With no `theme` attribute, your page's own `<html data-theme="light|dark">`, else the system's `prefers-color-scheme`, decides, as on cornfield's own page (and the map follows when either changes). `theme="light"` or `theme="dark"` forces that mode for the element: the generated sheet declares that mode's tokens on the element itself. So to change a token for a forced element, put the rule **on that element** (`#board-map { --corn-ground: … }`); a rule on `:root` reaches an element that follows the page but not one that is forced.
- **Two maps, two sets of tokens** work: each map reads the tokens at its own element.
- **After changing a token at run time** where the map cannot see it, call `map.refresh()`. Changing the `theme` attribute, or your `<html>`'s `data-theme` or class, needs no call.
- **One limit.** Inside a shadow root a rule cannot ask what `<html>` says, so a theme that restyles a part by light or dark has to do it through tokens.

### Parts

Every `data-corn` hook inside a component is also a `part` of the same name, so your CSS can reach one element: `corn-map::part(map-stage) { background: #fff }`. `corn-map` has `map-stage` (the box the canvases sit in), `map-canvas`, `label-canvas` and `map-overlay`. A `[data-corn="…"]` rule of your page does not reach into a shadow root; a theme written against hooks needs `::part()`, or tokens. The tags, properties, events, methods and parts are public: [theming.md](theming.md#web-components-tags-properties-events-methods-and-parts) lists them, and a test holds the list against the source.

### Keyboard and screen readers

A screen reader finds an application named "Topology map", described by the map's keys, and a polite status region that says where the keyboard landed. The canvas is reached by Tab. Its keys act **only while the focus is inside the map**: arrows pan, `+` and `-` zoom, `0` fits, `N` and `P` (or `]` and `[`) select the next and the previous node and bring it into view, `Home` and `End` the first and the last, `F` frames the selected node and what it lights, `Escape` clears the selection ("Selection cleared"). These are the keys of cornfield's own page, from the same code; the page's Enter (into its node panel) and Alt with an arrow (Freeform) do nothing in a map with no panel and no Freeform. A key the map handled is marked `defaultPrevented`, and is not stopped: your own handlers still see it, and can tell by that flag that the map took it.

### The review piece in the engine (what `<corn-review>` wraps)

`explorer/pieces/review.js` is what the [`<corn-review>`](#corn-review-the-one-tag-review) tag wraps, and what a shell of your own (another framework's) would. `mount(element, null, options)` makes one box in `element` and lays out, on one instance, the map, the proposal's bar (Before, Diff, After, Whole map, without the what-if editor), the change list with the scenario player, the decision (Approve and Send back) as the list's foot, and the node panel. Cornfield's own page does not use it (the page keeps its own layout). Its pieces find each other by id inside that one box, so two reviews in one page share nothing. The box is a region named "Proposal review" (`label` names it otherwise); its headings start at `h2` (the proposal's title and the selected node's), with `h3` and `h4` under them. It has no header, Work panel, search, Layers menu, account menu or hint, and no what-if editor, mockups or sign-in screen of its own (the decision says `auth` on the instance when a read or the press is refused, and a review with a `src` shows the sign-in card for it; it never navigates). **What needs the Work panel is not there, and not a button that does nothing**: nothing answers the node panel's `threads:index` and `forge:can-start`, so it shows no Threads, no "Start a thread about this" and no "Start a run", and nothing paints the bar's waiting line, so there is no "Answer".

- **What it needs from its host.** A box with a height: the review fills 100% of its host and is never under 24rem. It declares itself the query container its stylesheets ask (`container: corn-box corn-page / size`) and is the containing block of its own `position: fixed` boxes (`contain: layout`): a phone's tap-away backdrop and the modal scrims are placed against the review's box, not the window, and the review is a stacking context, so nothing in it rises above your own layers. **Under 768px by the box's own width**, not the window's, it is the page's phone layout with its bottom sheets (a peek, expanded, a stub); wider, the bar on top of the map, the change list on the left with the decision under it, the node panel on the right.
- **In a shadow root, which is how the tag will hold it.** `mount(shadowRoot, null, options)` puts the box in the shadow root: give the host element a size (`:host { display: block; height: 100% }` in a sheet of its own, or a height from your page), adopt the stylesheets below in the shadow root as constructable sheets, and pass the package's generated tokens as `tokens` (the piece adds them to the document, where every shadow root inherits them). The box, not `:host`, carries the query container, `contain: layout` and `all: initial`, so the phone's fixed backdrop stays inside it. Then your page's rules on bare elements stop at the shadow root, the ids are the shadow root's own, focus and keys are the box's, and a page with a strict `style-src 'self'` (no inline style) works: the review makes no `<style>` and no `style` attribute from text. `test/fixtures/review/` mounts it so (`&shadow=1`, `?csp=1`), and `proof.mjs` checks all of this.
- **Stylesheets.** After the default tokens (`explorer/tokens.css`, or the package's generated `tokens.css` in a shadow root) and before a theme, the files of `explorer/css/` that the piece's exported `STYLESHEETS` names, in that order: `base.css`, `map.css`, `node-panel.css`, `proposal.css`, `changes.css`, `decision.css`, `sheets.css`, `review.css`. Never `page.css`. `review.css` is only for a host: cornfield's page does not link it.
- **What it takes** (`mount` and `update(next)`): `topology` (`{nodes, edges}`), `proposal` (a slug, which the piece fetches through `base`, or the proposal object, or `null` to close), `source`, `view` (`before`, `diff`, `after` for the proposal; `map`, `dataflow` for the map), `node`, `config` (`theme` and `layers` of `/cornfield/config.json`), `strings`, and `theme`, `checker`, `base`, `fetch`, `tokens`, `renderer`, `onSelect`, `onReady`. **With a `src`** (the server's address, for a piece that makes its own instance) it loads what it was not handed, through the same engine a map with a `src` uses (`engine/source.js`, `pieces/status.js`, `engine/theme-sheet.js`, in a chunk of their own: `pieces/review-source.js`): the config and the map, with the session, the states of the load in the box, the server's theme with `useTheme`, then the proposal by name; it also takes `useTheme`, `version`, `pageUrl` and the callbacks below. What is handed in (`topology`, `config`, `strings`) goes to that load, which asks for nothing of it. **With a topology and a proposal object and no `base` or `fetch`, no request is made at all**, and the decision's foot says so in words ("Shown to read only: there is no cornfield server here to send an approval or a send back to.") with no Approve or Send back to press; with a `base`, a proposal object is decided on only when it comes with its `slug` and a spec PR's `source` (`pull/<n>`), and `sha256` names the version on screen, as the page's fetch does. A proposal is held until there is a topology to lay it on; a topology with no nodes says "There is no map to show" (`data-corn="empty"`).
- **What a host hears** is on the instance: `selection`, `proposal`, `decision`, `auth`, `scenario:player` (listed in `explorer/instance.js`), and, as plain callbacks the tag turns into its events: `onSelect`, `onReady`, `onNavigate({ proposal, source, view, change })`, `onDecision({ outcome, proposal, source, open, review })` (from the event's own detail), `onAuth({ status, signIn, during })` and `onError({ kind, message })`.
- **Nothing leaves the box.** No listener on `document` or `window` (but the few facts an instance listens to: the tab shown or hidden, the network, the window's focus, removed with it), no element outside it, no id looked up outside it, no `location` or `history`, keys act only with the focus inside, and the wheel is your page's until the map has the focus or Ctrl or Cmd is held.
- **Limits.** Mounted in a plain element (no shadow root), the ids inside a review (`proposal-bar`, `graph-canvas`...) are the page's own, so two reviews in one document repeat them (inside one review they are unique, and a lookup never leaves its box), and your page's rules on bare elements (`button`, `h2`, `p`, `canvas`) reach in: `review.css` resets what an inherited property or a canvas border would leak, and a shadow root ends both. Two tokens still follow the window, not the box (`--corn-control-height` and `--corn-panel-pad` are larger under a phone-wide window, in `tokens.css`), and a phone sheet's height cap is read when a sheet opens or changes, so after the box grows with a sheet expanded the sheet stays at its smaller cap until it is folded or opened again (the map always keeps its share: the stylesheet bounds the cap by the box's height). It does not announce going offline or back online (cornfield's page does, in its header); a press while offline says so in the decision.

### What it does not do yet

- **Only the map reads a server through a scope.** A scope shares its instance with one map and, around it, the node panel, Layers and search ([above](#the-pieces-around-the-map-corn-node-panel-corn-layers-corn-search)). (A `<corn-review>` reads a server on its own: it is not inside a scope yet.)
- **No proposal on a map alone.** A proposal drawn on the map, with its Before, Diff and After, is the review's: [`<corn-review>`](#corn-review-the-one-tag-review).
- **No panels on a map alone.** Selecting a node says so through `cornSelect`; what to show for it is your app's, or `<corn-node-panel>`'s when the map is in a scope (the review has the node panel inside it).
- **No freeform positions.** Dragging a node and saving where it was put are cornfield's own page's; a map in your page stores nothing in your page's storage.
- **Reduced motion** is read when the map is made: under it the flow packets stand still and the camera jumps where it would glide, as on the page.

### The size it adds

The build records the gzipped size of the shared runtime, of `corn-map`, `corn-review` and each piece around the map with their engine, of each with what a `src` brings, and of `corn-scope` with what it loads, in `components/size-budget.json`, and CI fails when any grows by more than 5%: `npm run size:record` writes the new numbers when a growth is on purpose. Today (gzip, level 9, besides the shared runtime, which is 28.1 kB): **`corn-map` with its engine 74.2 kB**, which is all a map you hand its data loads; a `corn-map` with a `src` loads 11.9 kB more, once, when it first has one; **`corn-review` 146.2 kB** (the map, the proposal's bar, the change list and player, the node panel and the decision), and **155.4 kB** with a `src` (9 kB for the load, the card and the server's theme, in `chunks/review-source-<hash>.js`, loaded only for a `src`); `corn-scope` with what it loads 56.1 kB. **The pieces around the map**, each as what it adds to a page that already has the map (alone, without a map, none of them does anything): `corn-node-panel` **+29.6 kB** (it holds the renderers of every section of a node: the data, the cloud plan, the mockups, the diff); `corn-layers` **+12.4 kB**; `corn-search` **+16.5 kB**; all three together add **50.5 kB** to a page with the map, and 24.4 kB to one that has the review (which holds the node panel already). The map and the review grew when these tags came, by 1.1 kB and 3.4 kB against the 73.1 kB and 142.8 kB they were before: the map now owns its live region, says `map:ready` and `map:gone`, hands a late shell the selection, and the instance knows more than one root (about 1.1 kB, all code the map runs); the review also carries the node panel's box-of-its-own option, and the node panel, the layers' engine and the sheets are chunks it shares with the new tags now, where they were inside its own chunk (about 2.3 kB more, the price of sharing them rather than shipping them twice). The components share the engine's chunks and make no second copy of it, so a page with a review and a map loads the engine once, and a map alone loads none of the review: what only a review uses (the sheets, the bar's, the list's and the panel's words, the checks, the decision) is in modules a map does not import, as a test of the build holds.
