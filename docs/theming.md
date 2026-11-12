# Theming: the `--corn-*` tokens

Every colour, font, font size, radius, border and outline width, shadow and spacing in the explorer's stylesheets is a custom property whose value is written in one file, [explorer/tokens.css](../explorer/tokens.css). The explorer's stylesheets, [explorer/css/](../explorer/css/) (one file per piece, below) and `house.css`, only read them (`var(--corn-…)`), and [test/explorer/tokens.test.js](../test/explorer/tokens.test.js) fails the build on any literal left outside `tokens.css`. A brand restyles the explorer with one stylesheet, loaded after cornfield's, that redefines some of these names. It is CSS only: no script, no fork.

## How a brand stylesheet works

- **Load it after cornfield's stylesheets**, with `theme` in `cornfield.config.js` (below).
- **Set tokens on `:root`.** A token that is made from another one (`--corn-font-display` is `var(--corn-font)`, the `*-soft` tints mix their colour) is worked out on `:root`, so a value set on `body` or a panel does not reach it.
- **Use cornfield's three selectors.** Dark values, and everything both themes share, are on `:root`. Light values are under both `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { … } }` (the system setting, before any script runs) and `:root[data-theme="light"] { … }` (the viewer's choice, which `theme-boot.js` puts on `<html>`). Those two are more specific than `:root`, so a token cornfield sets for light has to be set in your light blocks too, or cornfield's light value wins on the light ground. Repeat the same selectors in your file; as it loads later, yours win.
- **Keep text readable.** Text on `--corn-accent` is `--corn-text-on-accent`; the solid fills of a status or a hue (a pressed data-flow button, a pressed House chip, a sandbox chip) put `--corn-ground` on the hue. `cornfield validate` checks the pairs below against WCAG AA, in light and dark ([The contrast check](#the-contrast-check)).

## Applying a theme

A brand's tokens live in a repo theme file that `cornfield.config.js` names, and the server links it after `tokens.css`, the files of `explorer/css/` and `house.css`, so its values win: see [docs/config.md, Theme](config.md#theme) for the file, the font allow-list, the images and fonts beside it, and what `validate` checks.

```js
// cornfield.config.js
export default {
  theme: { css: './tools/cornfield/theme.css' },
};
```

A named theme (`theme.names`) is the same kind of file. Scoped to `:root[data-theme-name="night"]`, it outranks cornfield's dark `:root` block and ties with its light ones, and wins those as it loads later; to give it its own light values, scope them to `:root[data-theme-name="night"][data-theme="light"]`.

## A logo, a favicon and an app name

Images and the app's name are not tokens: they are the config's `brand` key, `{ logo, wordmark, favicon, appName, color, background }`, with images from the repo served at `/cornfield/brand/<key>.<ext>` and never inlined. The logo and wordmark sit in the header's brand button as `img[data-corn="brand-logo"]` and `img[data-corn="brand-wordmark"]`, so a theme can size them; `color` and `background` are the tab's `theme-color` and the web app manifest's colours. See [docs/config.md, Brand](config.md#brand).

## The contrast check

`cornfield validate` resolves the `--corn-*` pairs below for **light and dark**, after your theme is applied over [explorer/tokens.css](../explorer/tokens.css), and fails when a pair is under WCAG AA. It always runs: with no theme it checks cornfield's own tokens, so a change to the defaults cannot slip under AA either. It checks the standard theme (`tokens.css` and `theme.css`) and, separately, each `theme.names` entry (`tokens.css`, `theme.css`, then that file, with `data-theme-name` set). Each line names the theme, the mode, the two tokens, their resolved colours and the ratio:

```
named theme "night" (dark): --corn-text-3 (#6b7089) on --corn-surface-2 (#1e1b2e) is 3.43:1, below 4.5:1 (AA for text).
standard theme (light): --corn-ok (#2f855a) on --corn-ok-soft over the ground image (#dbe9e5) is 3.63:1, below 4.5:1 (AA for text).
standard theme (dark, on a system set to light): --corn-text-2 (#cbd5e1) on --corn-surface-1 (#ffffff) is 1.48:1, below 4.5:1 (AA for text).
```

**The pairs.** Each is what [explorer/css/](../explorer/css/) paints; [test/core/contrast.test.js](../test/core/contrast.test.js) fails when those files set a text colour on a background the list does not hold.

| Text (4.5:1) | On |
|---|---|
| `--corn-text`, `--corn-text-2`, `--corn-text-3`, `--corn-accent-text`, `--corn-ok`, `--corn-warn`, `--corn-bad`, `--corn-info`, `--corn-added-text`, `--corn-edit-text` | `--corn-ground`, `--corn-surface-1`, `--corn-surface-2`, `--corn-surface-3` |
| `--corn-text-on-accent` | `--corn-accent`, `--corn-accent-hover` |
| `--corn-ok`, `--corn-accent-text`, `--corn-hue-orange-text` | their tint: `--corn-ok-soft`, `--corn-accent-soft`, `--corn-hue-orange-soft` |
| `--corn-ground` (the text on a solid fill) | `--corn-ok`, `--corn-warn`, `--corn-bad`, `--corn-info`, `--corn-hue-orange`, `--corn-hue-lime`, `--corn-added-text`, `--corn-edit-text` |
| `--corn-hue-fuchsia` (ROM, a milestone, a link button), `--corn-hue-pink` (a variable) | `--corn-ground`, `--corn-surface-1` (and fuchsia on `--corn-surface-2`) |
| `--corn-hue-orange` (the data-flow button) | `--corn-surface-2` |
| the tints the explorer's stylesheets mix themselves: a hue at 6–30% over the panel | `--corn-hue-lime` on lime 6% (a room on the House plan); `--corn-accent-text`, `--corn-hue-pink`, `--corn-edit-text` on their own 10% (the header links); the orange and fuchsia buttons' text (the hue 60% with `--corn-text`) on their 15% and 20%; `--corn-added-text` on `--corn-added` 12%, 14% and 20% and `--corn-text` on 12% (the current proposal, the proposals and approve buttons); `--corn-text` on `--corn-edit` 30%; `--corn-bad` on `--corn-removed` 10%, 12% and 16%, `--corn-text-2` on 10%; `--corn-warn` on `--corn-changed` 16%; `--corn-text-2` on `--corn-text-3` 10% and 12%, on `--corn-text-2` 12% and on `--corn-line-soft`; `--corn-text-3` on `--corn-text-3` 12% |

| UI (3:1) | On |
|---|---|
| `--corn-focus`, the focus ring (and the search and token fields' focused border) | `--corn-ground`, `--corn-surface-1`, `--corn-surface-2`, `--corn-surface-3` |
| `--corn-edit-text`, a What-if field's focus ring; `--corn-added-text`, the review note's focus ring | `--corn-ground`, `--corn-surface-1` |
| `--corn-accent-text`, the selected row's border and a pressed button's border | `--corn-surface-3`, `--corn-surface-1`, `--corn-ground` |
| `--corn-added-text`, the current proposal's border | `--corn-added` 12%, `--corn-surface-1` |
| `--corn-ok`, a layer's tick; `--corn-ok`, `--corn-edit-text`, `--corn-bad`, `--corn-warn`, `--corn-text-3`, a run or PR state pill's border (its text colour) | `--corn-surface-2`, `--corn-surface-3` |

The minimums are the WCAG 2.1 ones: **4.5:1** for text, **3:1** for large text and for the parts of the interface a person needs to see (1.4.11). No token pair is large text. Most UI tokens are text tokens too, so they are held to 4.5:1 where they are: a pair listed twice is checked once, at the higher minimum. Not checked, on purpose: `--corn-line` and `--corn-line-soft` (a divider or a quiet border is decoration, never the only sign of a state) and the pressed accent button's fill (its `--corn-accent-text` border carries the state). The map is checked in the next section.

**The map's colours** are checked too, for light and dark, each against the ground (and its image) they are drawn on:

- **A node's fill, 3:1.** For each node type, its fill is `--corn-map-node-<kind>`, else its group's `--corn-map-group-<group>`, else `auto`, which is the node's own colour from the topology (deepened for the light ground). A fill under 3:1 on the ground passes **only if the outline carries it**: `--corn-map-stroke` is set, wider than 0, and is itself 3:1 on the fill and on the ground. Otherwise the line names the token:
  `standard theme (light): --corn-map-node-table (the fill of a table node; set --corn-map-stroke, an outline at 3:1 on the fill and on the ground, or a deeper fill) (#f2c500) on --corn-ground (#fdf3dc) is 1.49:1, below 3:1 (the UI minimum).`
- **A finer kind's and a project layer's fill, 3:1, the same rule.** Every `--corn-map-kind-<type>-<kind>` and every project `--corn-map-group-<key>` the theme sets (in a stylesheet, anywhere in it) is read against the ground in light and dark, and carried by the outline the same way. One left at `auto` draws the type's own colour, which is checked above. A finding names the token: `standard theme (light): --corn-map-kind-service-timer (the fill of a service node of the kind "timer") (#f2f0a0) on --corn-ground (#fdf3dc) is 1.13:1, below 3:1 (the UI minimum).` `cornfield validate` also **warns** about a kind or layer a theme names that is not there, since a typo would otherwise do nothing: a `--corn-map-kind-*` token for a kind no node of that type has on the map, a `--corn-map-group-<key>` for a layer the config does not have, and a `theme.icons` key `"<type>:<kind>"` or `"layer:<key>"` likewise.
- **A label, 4.5:1.** `--corn-map-label` (or the map's own near-white or near-black at `auto`) on the ground, and on `--corn-map-label-halo` (the ground's own colour at `auto`).
- Edge colours and the selection halo are not checked; the diff marks are, below.

**What `validate` prints on a pass** is one line of what was held, so a pass is not a silence: `theme contrast: 297 pairs of the standard theme, in light and dark: all at or above their minimum (4.5:1 for text, 3:1 for the parts of the interface and the map's fills).` The default theme is held to the same rules: its ground image's glow was lowered in 0.35 (dark `rgba(66, 153, 225, 0.28)` to `0.2` and `rgba(229, 62, 62, 0.22)` to `0.16`; light `0.12` to `0.06` and `0.07` to `0.04`) because six light fills and two dark ones were 2.7 to 2.9:1 under the brightest point of it.

**The map's diff marks and dimmed labels.** `--corn-map-added`, `--corn-map-changed`, `--corn-map-removed` and `--corn-map-edit` (or the default look behind `auto`), and `--corn-map-label` as a label a diff dims is drawn (60% opacity: de-emphasised, never hidden), are each read at **3:1** against the page ground, against each glow of `--corn-ground-image` at its strongest and against all the glows laid over each other: the darkest and the lightest ground the map shows. A mark that fades is read at the opacity it is drawn at (a removed mark's edge is 77% opaque, a what-if edit's removal too), so a pale `--corn-map-removed` fails even though it would pass solid. The dots of the four marks (`--corn-added`, `--corn-changed`, `--corn-removed`, `--corn-edit`) are read at 3:1 on the ground too. A finding reads: `named theme "night" (light): --corn-map-removed (the removed mark on the map, drawn at 77% opacity) (#f3b4b4) on --corn-ground over the ground image (#dfdfea) is 1.37:1, below 3:1 (the UI minimum).` Node fills are not part of this check.

**What a colour sits on.** The page paints the ground, then `--corn-ground-image`, then the panels, then the text, and the check composites in that order:

- a **surface** sits on the ground, and on the ground under each layer of `--corn-ground-image` at its most opaque colour stop (the centre of a radial glow): the worse of the two counts, and its line says "over the ground image";
- a **tint** (a `*-soft` token, or a tint the explorer's stylesheets mix) sits in a panel: over `--corn-surface-1` over the ground (and the image);
- a **text colour** with alpha is composited over its background.

An image in `--corn-ground-image` (`url()`) cannot be read and adds nothing; keep text-bearing panels opaque enough over it.

**Light and dark, and the system setting.** `theme-boot.js` always puts the viewer's light or dark on `<html data-theme>`, and a viewer can pick light on a dark system or dark on a light one. So each mode is resolved twice, with `prefers-color-scheme` the same and the other way, and the worse counts; a line from the second says "on a system set to …". This catches a theme that writes its light values on `:root` and its dark ones only in `@media (prefers-color-scheme: dark)`: a viewer who picks dark on a light system gets the light values on cornfield's dark ground.

**How a theme is read.** A small resolver reads the stylesheets as text (no browser): custom properties in `:root`, `html`, `[data-theme="…"]` and `[data-theme-name="…"]` rules (with `:not()`), at the top level and inside `@media (prefers-color-scheme: light|dark)`. The cascade is the browser's: `!important`, then specificity, then source order. It follows `var(--x, fallback)` chains (a property that is unset or in a cycle has nothing to give, so the fallback is used) and reads colours written as `#rgb`, `#rrggbb` (with alpha), `rgb()`/`rgba()`, `hsl()`/`hsla()` (comma or space syntax), `transparent`, the 148 CSS named colours and `color-mix(in srgb, A p%, B)` (premultiplied, as the browser mixes; shares under 100% lower the alpha). Tokens it does not know are ignored unless a pair above or the map check uses them.

**A token it cannot work out** is a **warning**, not an error: the pair was not checked. The line names the token and why:

```
standard theme (dark): --corn-text on --corn-ground could not be checked: --corn-text → --brand-fg is "oklch(70% 0.1 200)": oklch() is not a colour cornfield reads (it reads hex, rgb(), hsl(), color-mix(in srgb, …), transparent and the CSS named colours).
standard theme (light): --corn-ok on --corn-ok-soft could not be checked: --corn-ok-soft → --brand-ok is not set.
standard theme (dark): --corn-text on --corn-ground could not be checked: --corn-text: a var() cycle, --a → --b → --a.
```

It never hangs on a hostile file: a theme file over 256 KB or not CSS is not read (`validate` already fails it), a `var()` is followed at most 32 deep and a value may grow to 2,048 characters as its `var()`s are replaced (2,000 replacements at most for one token), `color-mix()` nests at most 8 deep and `:not()` 4 deep; past a limit the token is a warning that says which limit.

**When it fails.** `validate` exits non-zero. To keep the report but not fail on it, set [`theme.contrast: 'warn'`](config.md#theme); the lines then appear as warnings.

## A complete brand stylesheet

A square-cornered, retro look: no radius anywhere, hard offset shadows, thick borders, its own fonts, a red accent, in both themes. Saved as `tools/cornfield/theme.css` (with its two fonts in `tools/cornfield/fonts/`) and named by `theme: { css: './tools/cornfield/theme.css' }`, every panel, button, menu and dialog takes it. [test/explorer/tokens.test.js](../test/explorer/tokens.test.js) checks that every name in it is a token and that the light blocks match.

```css
/* brand.css: an example brand, as tools/cornfield/theme.css. Every value below is the brand's own; nothing else changes. */
/* Fonts beside the theme are served at /cornfield/theme/assets/ (docs/config.md#theme) */
@font-face { font-family: "Example Pixel"; src: url("/cornfield/theme/assets/fonts/example-pixel.woff2") format("woff2"); font-display: swap; }
@font-face { font-family: "Example Rounded"; src: url("/cornfield/theme/assets/fonts/example-rounded.woff2") format("woff2"); font-display: swap; }

/* Both themes: shapes, type, the accent fill. Dark values follow. */
:root {
  --corn-font: "Example Rounded", "Trebuchet MS", system-ui, sans-serif;
  --corn-font-display: "Example Pixel", "Courier New", ui-monospace, monospace;
  --corn-radius-xs: 0;
  --corn-radius-sm: 0;
  --corn-radius: 0;
  --corn-radius-lg: 0;
  --corn-radius-pill: 0;
  --corn-border: 2px;
  --corn-border-strong: 4px;
  --corn-focus-width: 3px;
  --corn-blur: 0px;
  --corn-accent: #b91c1c;
  --corn-accent-hover: #991b1b;

  /* Dark */
  --corn-ground: #14121f;
  --corn-ground-image: none;
  --corn-surface-1: #1f1b2e;
  --corn-surface-2: #2a2540;
  --corn-surface-3: #3a3356;
  --corn-line: #5b5478;
  --corn-line-soft: #3a3356;
  --corn-shadow: 4px 4px 0 #000;
  --corn-shadow-sm: 2px 2px 0 #000;
  --corn-shadow-lg: 6px 6px 0 #000;
  --corn-shadow-color: #000;
  --corn-glow: 0px;
  --corn-accent-text: #f87a7a;
  --corn-focus: #fca5a5;
  --corn-text-3: #b8b2cc;
  --corn-brand-gradient: linear-gradient(90deg, #f87171, #fbbf24);
}

/* Light, under both of cornfield's light selectors (keep the two the same) */
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --corn-ground: #fffaf0;
    --corn-ground-image: none;
    --corn-surface-1: #ffffff;
    --corn-surface-2: #fbf3e4;
    --corn-surface-3: #f1e6cf;
    --corn-line: #1f1b2e;
    --corn-line-soft: #e6dac0;
    --corn-shadow: 4px 4px 0 #1f1b2e;
    --corn-shadow-sm: 2px 2px 0 #1f1b2e;
    --corn-shadow-lg: 6px 6px 0 #1f1b2e;
    --corn-shadow-color: #1f1b2e;
    --corn-glow: 0px;
    --corn-text: #1f1b2e;
    --corn-text-2: #3d3654;
    --corn-text-3: #57506b;
    --corn-accent-text: #991b1b;
    --corn-focus: #991b1b;
    --corn-brand-gradient: linear-gradient(90deg, #b91c1c, #b45309);
  }
}
:root[data-theme="light"] {
  --corn-ground: #fffaf0;
  --corn-ground-image: none;
  --corn-surface-1: #ffffff;
  --corn-surface-2: #fbf3e4;
  --corn-surface-3: #f1e6cf;
  --corn-line: #1f1b2e;
  --corn-line-soft: #e6dac0;
  --corn-shadow: 4px 4px 0 #1f1b2e;
  --corn-shadow-sm: 2px 2px 0 #1f1b2e;
  --corn-shadow-lg: 6px 6px 0 #1f1b2e;
  --corn-shadow-color: #1f1b2e;
  --corn-glow: 0px;
  --corn-text: #1f1b2e;
  --corn-text-2: #3d3654;
  --corn-text-3: #57506b;
  --corn-accent-text: #991b1b;
  --corn-focus: #991b1b;
  --corn-brand-gradient: linear-gradient(90deg, #b91c1c, #b45309);
}
```

The map itself (the nodes, edges and labels on the canvas) takes its own `--corn-map-*` tokens: see [The map](#the-map). The dots, rings and run marks are round (`50%`) in any theme; a node is drawn in the silhouette of its family (see [The map](#the-map)).

## The tokens

`(light)` marks a token that `tokens.css` sets again for the light ground; set it in your light blocks too.

| Token | What it is |
|---|---|
| **Ground and surfaces** | |
| `--corn-ground` | the page behind everything (light); also the colour of an input's well and the text on a solid hue fill |
| `--corn-ground-image` | what the page paints over the ground: a gradient, or `none` for flat (light) |
| `--corn-surface-1` | a panel: the header, menus, the node panel (light) |
| `--corn-surface-2` | a control or a row: a button, a toggle row (light) |
| `--corn-surface-3` | pressed, hovered, disabled (light) |
| `--corn-line` | every border (light) |
| `--corn-line-soft` | a divider, a hover tint (light) |
| `--corn-shadow` | a panel's whole `box-shadow`: the header's menus, the bars, the glass (light) |
| `--corn-shadow-sm` | a small lift: a pressed button, the Open button (light) |
| `--corn-shadow-lg` | a slide-over or a dialog: the node panel, the issues panel, a confirmation (light) |
| `--corn-shadow-color` | the colour the phone sheet's shadow (below) is made from (light) |
| `--corn-shadow-sheet` | a phone's bottom sheet's whole `box-shadow`, cast upward (`0 -8px 24px` of `--corn-shadow-color` by default). A flat brand gives it a hard offset, like `0 -4px 0 #1b1636` |
| `--corn-glow` | the blur of a live dot's glow; `0px` for none (light) |
| `--corn-scrim` | the backdrop behind a dialog: a confirmation, Start an agent, Review tokens, the mockup window (light) |
| `--corn-blur` | the glass blur amount (a length; `0px` for none) |
| `--corn-mockup-ground` | the page behind a proposal's mockup image or frame (white, as a browser shows a page) |
| **Text** | |
| `--corn-text` | titles and strong text (light) |
| `--corn-text-2` | body and secondary text (light) |
| `--corn-text-3` | labels and meta (light) |
| `--corn-text-on-accent` | text on an `--corn-accent` fill |
| **Accent** | |
| `--corn-accent` | the accent fill (a pressed button, the primary action) |
| `--corn-accent-hover` | the accent's hover |
| `--corn-accent-text` | the accent as text, an icon or a line (lighter than the fill on dark) (light) |
| `--corn-accent-soft` | a tinted background of the accent |
| `--corn-focus` | the focus ring's colour (light) |
| `--corn-brand-gradient` | a brand gradient a theme may use; cornfield's own header no longer draws it (since CF-41 the title is `--corn-text`) (light) |
| **Status** (only ever means status) | |
| `--corn-ok`, `--corn-warn`, `--corn-bad`, `--corn-info` | a state, as text, a dot or a solid fill (light) |
| `--corn-ok-soft` | the same for ok, as a tinted background |
| `--corn-run-requested`, `--corn-run-claimed`, `--corn-run-working`, `--corn-run-waiting`, `--corn-run-done`, `--corn-run-failed`, `--corn-run-stopped` | the seven states of an agent run, as the colour of its pill (its word, its icon and its border). They are aliases of the status colours above (requested is `--corn-text-3`, stopped `--corn-text-2`); set one to give a state its own. They are checked as text on every surface |
| `--corn-run-waiting-ink` | the text and icon of the **waiting** pill, which is solid (a run that needs the maintainer stands out most); `--corn-ground` by default. Checked on `--corn-run-waiting` |
| **Diff** (shared with the map) | |
| `--corn-added`, `--corn-changed`, `--corn-removed`, `--corn-edit` | what a proposal adds, changes, removes, and a what-if edit; the defaults of the map's marks (`explorer/diff-marks.js`), chosen so every one is 3:1 over the darkest and lightest ground the map draws, in both levels, at the opacity it is drawn at; the legend matches the map (light) |
| `--corn-added-text`, `--corn-edit-text` | added and edit as text: the mark mixed 60% with `--corn-text`, so it reads on either ground |
| **Category hues** (never status) | |
| `--corn-hue-orange`, `--corn-hue-fuchsia`, `--corn-hue-pink`, `--corn-hue-lime` | the data-flow preset, ROM, variables, the House view (light) |
| `--corn-hue-orange-text` | the orange as text on its own tint (the data-flow note in the Layers menu): the hue itself on dark, a deeper one on the light ground (light) |
| `--corn-hue-orange-soft` | that tint: the orange hue at 12% |
| `--corn-house-line`, `--corn-house-room` | the House plan's outline and each room's (light) |
| `--corn-glyph-mix` | how much of a panel glyph's own colour is kept; the rest is `--corn-text` (light) |
| **Type** | |
| `--corn-font` | the body family (the system's; nothing is fetched) |
| `--corn-font-display` | headings and titles: the header's title, the panels' titles, the menus' headings (the body family unless set) |
| `--corn-mono` | code, file paths and ids: the code face. Numbers have their own, `--corn-font-num`; before 0.36 `--corn-mono` also set the digits, so a brand that set it to keep a pixel face off numbers can put the real monospace back |
| `--corn-font-num` | numbers shown as data: the counts on the Work tabs and in the Layers menu, the "#21" of a pull request, the step counter, a count of changes, a run's limits and what its runner reported (minutes, turns, cost, tokens). Costs and tokens inside a sentence (a run's meta line, the totals) keep the body face. A pixel or display face misreads a 2, a 5 and an 8, so a brand sets a face with clear digits here. Those elements also take tabular figures (the digits are one width). Default: `--corn-font` |
| `--corn-text-2xs` | 10px, mono code and small meta |
| `--corn-text-xs` | 11px |
| `--corn-text-sm` | 12px |
| `--corn-text-md` | 13px |
| `--corn-text-base` | 14px |
| `--corn-text-lg` | 15px, the title of every panel: the Work panel, the node panel, the proposal bar, a pull request's detail, a dialog (one size, weight 700, line height 1.25) |
| `--corn-text-xl` | 20px, a sign-in page's heading |
| **Shape** | |
| `--corn-radius-xs` | 3px, a tag |
| `--corn-radius-sm` | 6px, a button, a field |
| `--corn-radius` | 10px, a row, a card |
| `--corn-radius-lg` | 14px, a panel or a sheet |
| `--corn-radius-pill` | 999px, a pill: a badge, a chip, a state |
| `--corn-border` | 1px, every border |
| `--corn-border-strong` | 2px, an accent: a selection bar, a ring, a mark |
| `--corn-focus-width` | 2px, the focus ring |
| `--corn-focus-offset` | 2px, the gap between a control and its focus ring. A ring that sits inside its box (a Work tab, a sheet's handle, the map) is inset by the ring's width instead, so no scroll container cuts it, whatever the width and the offset |
| **Spacing** (padding, gaps and margins are steps of this scale, or `calc()` over it) | |
| `--corn-space` | 4px, the unit |
| `--corn-space-1` | 4px (`--corn-space`) |
| `--corn-space-2` | 6px |
| `--corn-space-3` | 8px |
| `--corn-space-4` | 12px |
| `--corn-space-5` | 16px |
| `--corn-space-6` | 24px |
| **Density** (one height, one padding) | |
| `--corn-control-height` | the one height of a control in a bar: the header, the proposal bar, the decision foot, the scenario player and the Work panel's top row. 32px at a desk and 44px under 768px. **On a phone a control is never under 44px**, the least target a finger needs: the stylesheet reads `max(44px, var(--corn-control-height))` there, so a brand that sets 36px on `:root` gets 36px at a desk and 44px on a phone without a media query of its own, and one that sets 48px gets 48px on both. A segmented control (View, Before / Diff / After, the theme choice) is this high outside, its buttons this less their frame |
| `--corn-panel-pad` | the padding of a panel's body, all four sides: the Work panel and the node panel share it, so their text starts at one edge. 20px, and 16px under 640px (`tokens.css` sets the phone's value in a media query, so a brand that sets this token on `:root` sets it on a phone too, unless it sets it again under `@media (max-width: 639px)`) |
| `--corn-panel-head-height` | the least height of a panel's head, the row with its title and its Close: the control height and a step of padding (40px) |

Where the stylesheets once had a one-off tint, they mix a token: `color-mix(in srgb, var(--corn-added) 14%, transparent)`. Where they had many near-identical values, they now share the nearest step: the radii 8 and 12px became `--corn-radius-sm` and `--corn-radius`; the font sizes 9 and 10.5px became `--corn-text-2xs`, 16px became `--corn-text-lg`; a 10px padding is `--corn-space-3` (8px), 14px and 18px are `--corn-space-4` and `-5`, a 2px gap is `calc(var(--corn-space-1) / 2)`; a 3px accent bar is `--corn-border-strong`. Lengths that are not one of these (a width, a height, a position) stay in the stylesheets.

**Three tokens are gone** (CF-46): `--corn-warn-soft`, `--corn-bad-soft` and `--corn-info-soft`. Only the cloud panel's old plan pills and kind badge read them, and the panel now shows its plan and roles as plain facts. A theme that still sets them breaks nothing, since an unused custom property does nothing; delete them. `--corn-ok-soft` stays.

## The map

The map canvas is drawn from tokens too. Its renderers (WebGL, and the Canvas 2D one it falls back to) and its label layer read the `--corn-map-*` custom properties below from the page's computed style when the page loads and again whenever the theme changes (`data-theme`, `data-theme-name`, a theme stylesheet finishing loading, or `prefers-color-scheme` flipping), then draw again. Both draw the same, so a token set once styles both.

- **`auto` is the default, and it is today's map.** A node is drawn in its own colour from the topology (deepened for the light ground, as it always was; a colour the browser cannot read, such as `#12345`, is the node type's fill in both renderers, and `cornfield validate` warns about the node; a form only a browser works out, such as `oklch()` or `lab()`, gets a note that validate cannot check it, not the warning); every line, halo and mark keeps the colour it had. A theme that sets nothing changes nothing.
- **A colour replaces it, as written.** Both themes read the same token, so a theme sets the light ground's colour too, under `:root[data-theme="light"]` (or `@media (prefers-color-scheme: light)`).
- **A type beats its starting group.** A node's *type* is `app`, `table`, ... (the name `--corn-map-node-<type>` uses). Its *starting group* is its layer in the Layers menu: the same name for most, except that the rooms and floors are `house` and an outside system is `cloud` or `web`. `--corn-map-node-table` wins over `--corn-map-group-table`. Only the fill goes by type, group, kind and layer; the outline and the label are one colour for the whole map. **The Layers menu is the legend of these fills.** A row's dot is the fill the map draws for that row's nodes, by the same order (the type's token, or the project layer's, then the starting group's, then the built-in colour); a row of two types (House: floors and rooms) shows the first of them the map holds, so `--corn-map-group-house` is its dot unless floors have a token of their own. With no token, a row's dot is its type's built-in colour, the one the map draws. A token's value is read as the map reads it, so a name (`rebeccapurple`), `hsl()` or `rgb()` colours the map and its dot alike; a value that is not a colour colours neither. Under a row's "kinds", each kind has a swatch of `--corn-map-kind-<type>-<kind>`, or none when that token is unset (its nodes then draw the type's colour, the row's dot). Both repaint when the theme changes. A dot or swatch under 3:1 on the menu keeps its colour and gets an outline: `--corn-map-stroke` when the theme sets one, else `--corn-text-3`. Each row of the Layers menu carries its layer's key as `data-layer` (`app`, `page`, `core`, `store`, `cloud`, `web`, `house`, `flow`, `runs`, and a project layer's own key, ...): every node type on the map has a row, `core` and `store` included (a store also needs Data Flow on, and core Packages or Atoms), and a type cornfield has no row for gets one under its own name.
- **Finer kinds and project layers have fills too (spec 0009).** A node's `kind` (a service's `timer`, a device's `camera`) is its project's own word, and a project may add its own layers in `layers` (docs/config.md#layers). `--corn-map-kind-<type>-<kind>` fills a finer kind (`--corn-map-kind-service-timer`); `--corn-map-group-<key>` fills a project layer's nodes, as it fills a starting layer's. A type never holds a `-`, so a kind token reads one way (`--corn-map-kind-service-web-hook` is the kind `web-hook` of a service). **Which wins, most specific first:** the kind, the project layer, the type (`--corn-map-node-<type>`), the starting layer (`--corn-map-group-<starting key>`), then `auto`. A theme that names none of them leaves every node its type's colour. A kind or a layer key that is not lower-case words joined by `-` (at most 32 characters) has no token; it is still a kind or a layer. The tokens are not in `tokens.css`: their names depend on the project, and the map reads only those whose kind is on the map or whose layer is in the config.
- **An outline is off until you set one.** `--corn-map-stroke` draws a ring just inside every node's edge, `--corn-map-stroke-width` thick. `--corn-map-label` keeps the label's own fade: a node the focus dims stays dim.
- **Colours that mean something stay.** A node or an edge an outage, a permission check or a selected pull request colours (red, amber, green) keeps that colour; the map tokens style what is otherwise drawn in the node's or the line's own colour.
- **Anything that is not a colour is `auto`.** A value is read as the browser reads a colour (`#e53e3e`, `rgb()`, `hsl()`, a name, `color-mix()`, `oklch()`), so a typo, a length or an empty value leaves that part of the map as it was rather than breaking it.
- **Icons.** `theme.icons` in the config (docs/config.md#theme) draws an image per node inside the node; `theme.pixelated` draws small ones crisp. A key is a node type (`"service"`), a finer kind of one (`"service:timer"`) or a project layer (`"layer:timers"`), and the most specific wins, in the same order as the fills: the kind, the layer, the type. **With no icon, a node with a finer kind shows its kind's letters in its core** (one or two letters, the shortest start of the kind's name that no other kind of that type on the map shares, drawn once the node is 14 px across; dark ink under a light outline, so it reads on any fill in either theme), else the type's glyph (spec 0008). The letters are text from the project's data: they are drawn on the canvas, never put in markup. Both renderers draw the same picture: Canvas 2D with `drawImage`, WebGL as a texture in the icon pass, one per letters.
- **A silhouette per family, a glyph per type, and one meaning per line style (spec 0008).** These carry meaning, so they are not tokens. A node is a **circle** for code (root, app, page, package, core, token, atom, molecule, tool, ROM stage, service), a **rounded square** for data (store, table), a **hexagon** for what is outside (external), a **square** for where things run (stack, machine, container, device, floor, room) and a **diamond** for people (persona). Once a node is 14px across it shows a small built-in **glyph** of its type in place of the white core dot (ink: `--corn-map-glyph`); a theme icon for the node replaces it, and a finer kind's letters take its place too (an icon, then the letters, then the glyph, then the dot). A **line**: solid and thin is ownership, **dotted** is a loose use, **dashed** is only "proposed, not built", and a call's `when` is told by **ticks** across its middle (one: the next deploy; two: the next renewal). The end at the target says its family: an open chevron for data (`flow`, `reads`, `writes`), a filled triangle for services (`calls`, `triggers`, `delivers`), a bar for places (`runs-on`), an open diamond for tokens (`uses`, `extends`), and a lit line says its kind in words. The Key in the Layers menu draws each one. A theme changes the colours, never the shapes or the dashes.
- **Types of one silhouette are kept apart by colour.** Two types that share a silhouette are told apart by colour alone, so the built-in palette keeps every such pair at least **ΔE2000 15** apart (CIEDE2000, on the dark ground and the light one: the circles are the crowded family). To meet it, seven default colours moved, each as little as it could and within its own hue: `app` (`#5168ec`), `pkg` (a deeper cyan, `#0f8293`), `token` (`#ef409b`), `atom` (a deeper emerald, `#108d4e`), `rom` (a softer pink, `#c398c6`), `stack` (`#b49fa0`, a warmer grey) and `room` (`#f7ed81`, yellow beside the floor's lime); a page is still `#38bdf8`. A project's `topology.json` takes them at its next `cornfield sync`; a theme that sets its own map colours keeps them. `cornfield validate` **warns**, and never fails, when a theme's map colours (`--corn-map-node-<type>`, `--corn-map-group-<group>`) put two of them closer, naming both types, their tokens and the distance: `named theme "night" (dark): page (--corn-map-node-page) and pkg (--corn-map-node-pkg) share the circle silhouette and are ΔE 1.6 apart, under 15`. A theme that sets `--corn-map-glyph` is held to 3:1 against every node fill, as the fills are against the ground.

Dark and light, with a brand's own map (here each `--corn-map-*` is set in the light blocks too, because its colours are for a dark ground):

```css
/* map.css: kinds, a group, the outline, the diff and the focus in a brand's colours */
:root {
  --corn-map-node-app: #e53e3e;
  --corn-map-node-page: #4299e1;
  --corn-map-group-cloud: #a0aec0;
  --corn-map-stroke: #1a202c;
  --corn-map-stroke-width: 2px;
  --corn-map-label: #fefcbf;
  --corn-map-edge-flow: #ecc94b;
  --corn-map-added: #48bb78;
  --corn-map-removed: #f56565;
  --corn-map-lit: #fbd38d;
  --corn-map-selected: #63b3ed;
}
:root[data-theme="light"] {
  --corn-map-node-app: #c53030;
  --corn-map-node-page: #2b6cb0;
  --corn-map-group-cloud: #4a5568;
  --corn-map-stroke: #1a202c;
  --corn-map-label: #1a202c;
  --corn-map-edge-flow: #975a16;
  --corn-map-added: #276749;
  --corn-map-removed: #9b2c2c;
  --corn-map-lit: #744210;
  --corn-map-selected: #2c5282;
}
```

There are 69 map tokens: 21 node kinds and 18 groups (a fill each), 11 edge kinds, the outline (colour and width), the label (colour and halo), 8 states (the collision mark among them), the glyph ink, four for type and line work (the label font, the smallest label, the line width and the glow), and two for what a review greys (its colour and how much is left).

| Token | What it is |
|---|---|
| **Outline, label and state** | |
| `--corn-map-stroke` | the outline of every node: a ring just inside its edge, at the node's own fade. `auto`: no outline, as the map has always been |
| `--corn-map-stroke-width` | the width of that outline, in the map's own pixels (`1.5px` by default; it only matters once `--corn-map-stroke` is set; `0` turns it off) |
| `--corn-map-label` | the colour of a node's label (its fade outside the focus is kept). `auto`: near-white on the dark ground, near-black on the light one |
| `--corn-map-label-halo` | the outline drawn under every label on the map (a node's, an edge's) so it reads over the lines, used as written (give it an alpha to soften it). `auto`: the ground's own colour, slightly translucent |
| `--corn-map-added`, `--corn-map-changed`, `--corn-map-removed`, `--corn-map-edit` | the diff on the map: a proposal's ring on a node and its line on an edge, and a what-if edit's. The legend and the panel's dots follow them. `auto`: `--corn-added`, `--corn-changed`, `--corn-removed` and `--corn-edit` as the map has always drawn them |
| | **The four marks differ without colour**: added is a dashed ring, changed a solid ring, removed a faded ring with the label struck through, and a what-if edit a dotted ring; on a line, added is dashed, removed short-dashed and struck, a what-if edit long-dashed, never dotted, which is a usage link's (the shape is not themeable, only the colour is). Do not give two of the marks one colour a viewer cannot tell apart, and keep each at 3:1 over your ground: `cornfield validate` checks the four, and a label a diff dims, over the ground and every glow of `--corn-ground-image` (below). |
| `--corn-map-selected`, `--corn-map-match` | the halo of the selected node, and of a node a search finds (its disc is the same colour, translucent) |
| `--corn-map-lit` | the straight links the focus lights: the selection's own lines, and the step of a walk (a data-flow edge keeps its flow's colour: `--corn-map-edge-flow`) |
| `--corn-map-font` | the font list of every label on the map, in the same stack form as `--corn-font` (`"Nunito", ui-rounded, sans-serif`). `auto` (the default) keeps the map's own stack. It is read with the other map tokens and drawn again when a web font in it has loaded. Only a plain list is taken: families by name or in quotes, up to eight and 200 characters; a value with a URL, a function, a semicolon, a brace or a backslash is `auto`. `var(--corn-font)` works (the system keywords `-apple-system` and `BlinkMacSystemFont` are kept). `validate` warns about a value the map cannot use |
| `--corn-map-edge-width` | the width of an ordinary line, in map px (`1.6px` is today's flow line). Every line is scaled by this over 1.6, so the lines the focus lights and the diff marks stay heavier than the rest. `auto`: each line's own. A length over 0 and up to 12px; anything else draws as `auto`, and `validate` warns |
| `--corn-map-glyph` | the ink of a node's built-in glyph (the small picture of its type, drawn where the white core dot is once the node is 14px across) and of a finer kind's letters. `auto`: white on a deep fill and near-black on a pale one, whichever reads on that node. A theme icon for the node's type replaces both. `cornfield validate` reads it at 3:1 against every node fill when it is set |
| `--corn-map-label-min` | the smallest a label is ever drawn on the map, in px: `auto` is `11px`. A theme may raise it (up to `24px`), never lower it: `9px` and `10px` draw at `11px`, and under `9px` is read as `auto` and `validate` warns. A cluster's title (a hub: an app, a package, a tool, a store, a ROM stage, a floor) is drawn 2px larger and bold. A label never shrinks with the map: text that would be smaller is not drawn smaller, it competes for room at this size, and one that would touch another label is not drawn (the nodes a search finds, the selection and what it lights come first); a node with no label is named by a chip while the pointer is on it |
| `--corn-map-glow` | the soft glow round nodes, lines and moving dots, as a factor: `0` for none (a flat theme), `1` as it is drawn, up to `4`. `auto`: as drawn. A length other than `0px` is not a factor and is read as `auto`, and `validate` warns |
| `--corn-map-grey` | what a review greys is drawn in this colour: the nodes and lines a proposal does not involve, while it is under review (not when "Show the whole map" is on). `auto` (the default): each node's and line's own tone with its hue taken away, so the map still reads as a map. A colour replaces it for every greyed node and line, as written, in both themes. A tinted grey is allowed (a brand's warm or cool grey): then every greyed node and line is that one colour, so keep it near neutral and away from the four diff marks' colours. "A greyed node has no hue" is the promise of `auto`, and the test holds only `auto`; a removed node is still told apart by its own marks (a faded ring and a struck-through label), never by colour alone. A greyed node keeps its silhouette, glyph and kind letters; a theme's `icons` are not drawn on it (a picture has hues). `validate` warns when the value is not a colour it can read |
| `--corn-map-grey-alpha` | how much of a greyed node is left, from `0.1` to `1` (`auto` is `0.45`); its lines are faded in the same proportion to what they are by default. Its label is not part of it: a greyed node's label is plain (a cluster's title too: not bold, not larger), placed after every other label and with more room round it, at the dimmed-label opacity on the light ground (`0.6`) and `0.5` on the dark (`--corn-map-label` is checked at both by `validate`) Under `0.1` or not a number is read as `auto`, and `validate` warns |
| `--corn-map-collision` | the dashed ring and tag of a node two open agent runs both change (a mark over the map, so a stylesheet reads it; `--corn-warn` by default) |
| **Edges by kind** | |
| `--corn-map-edge-ownership` | a solid ownership line (parent to child) |
| `--corn-map-edge-usage` | a dashed usage line |
| `--corn-map-edge-flow` | a data-flow edge, whatever its flow kind (auto: each flow kind keeps its own colour) |
| `--corn-map-edge-reads` | a table-to-page read |
| `--corn-map-edge-writes` | a page-to-table write |
| `--corn-map-edge-calls` | a call into a service or an outside system |
| `--corn-map-edge-triggers` | a trigger into a service |
| `--corn-map-edge-delivers` | a delivery to an outside system |
| `--corn-map-edge-runs-on` | code running on a stack or a machine |
| `--corn-map-edge-uses` | a use of a design token |
| `--corn-map-edge-extends` | a token group extending another |
| **Node fill by kind** | |
| `--corn-map-node-root` | the fill of a `root` node |
| `--corn-map-node-app` | the fill of an `app` node |
| `--corn-map-node-page` | the fill of a `page` node |
| `--corn-map-node-pkg` | the fill of a `pkg` node |
| `--corn-map-node-core` | the fill of a `core` node |
| `--corn-map-node-token` | the fill of a `token` node |
| `--corn-map-node-atom` | the fill of an `atom` node |
| `--corn-map-node-molecule` | the fill of a `molecule` node |
| `--corn-map-node-tool` | the fill of a `tool` node |
| `--corn-map-node-store` | the fill of a `store` node |
| `--corn-map-node-table` | the fill of a `table` node |
| `--corn-map-node-rom` | the fill of a `rom` node |
| `--corn-map-node-service` | the fill of a `service` node |
| `--corn-map-node-external` | the fill of an `external` node |
| `--corn-map-node-stack` | the fill of a `stack` node |
| `--corn-map-node-machine` | the fill of a `machine` node |
| `--corn-map-node-container` | the fill of a `container` node |
| `--corn-map-node-persona` | the fill of a `persona` node |
| `--corn-map-node-device` | the fill of a `device` node |
| `--corn-map-node-floor` | the fill of a `floor` node |
| `--corn-map-node-room` | the fill of a `room` node |
| **Node fill by group** | |
| `--corn-map-group-app` | the fill of every node in the `app` group |
| `--corn-map-group-pkg` | the fill of every node in the `pkg` group |
| `--corn-map-group-page` | the fill of every node in the `page` group |
| `--corn-map-group-atom` | the fill of every node in the `atom` group |
| `--corn-map-group-molecule` | the fill of every node in the `molecule` group |
| `--corn-map-group-token` | the fill of every node in the `token` group |
| `--corn-map-group-tool` | the fill of every node in the `tool` group |
| `--corn-map-group-table` | the fill of every node in the `table` group |
| `--corn-map-group-rom` | the fill of every node in the `rom` group |
| `--corn-map-group-service` | the fill of every node in the `service` group |
| `--corn-map-group-cloud` | the fill of every node in the `cloud` group |
| `--corn-map-group-web` | the fill of every node in the `web` group |
| `--corn-map-group-stack` | the fill of every node in the `stack` group |
| `--corn-map-group-machine` | the fill of every node in the `machine` group |
| `--corn-map-group-container` | the fill of every node in the `container` group |
| `--corn-map-group-device` | the fill of every node in the `device` group |
| `--corn-map-group-house` | the fill of every node in the `house` group |
| `--corn-map-group-persona` | the fill of every node in the `persona` group |

## Styling hooks: `data-corn`

The tokens above change what the explorer looks like; the hooks let a stylesheet single out a part of it. The regions, the repeated components and the dialogs carry a `data-corn="…"` attribute, so a theme selects `[data-corn="node-panel"]` instead of the internal `hx-*` class names, which are not public and change freely.

- **Public API.** The names below are documented, and **renaming or removing one is a breaking change**: it is listed under "Breaking" in the release notes (the `breaking` label). Adding one is not. Every control and every part that paints its own background or border has a hook, and so does a title a person lands on; plain text inside a region (a line of meta, a key) has none: reach it from its region (`[data-corn="node-panel"] p`), or change it with the tokens. [test/explorer/hooks.test.js](../test/explorer/hooks.test.js) fails when this list and the markup disagree, in either direction, and when a button, link or field in the markup has neither a `data-corn` nor a `data-corn-kind`.
- **Values** are short kebab-case nouns. One element has one `data-corn` value; a component used in many places (`row`, `field`, `badge`) has the same value everywhere, so scope it by its region: `[data-corn="layers-menu"] [data-corn="row"]`.
- **Two companions:** `data-corn-kind` (a button's kind) and `data-corn-state` (a state). Their values are listed below and are public in the same way.
- **A theme needs no `.hx-*` class, no id, no deep selector and no `!important`** to single out any part of the page: `[data-corn="compare-option"][aria-pressed="true"]` is the chosen one of Before / Diff / After, `[data-corn="diff-pill"][data-corn-state="removed"]` a node a proposal removes.
- **No shadow DOM on cornfield's own page.** The page uses none, so a stylesheet reaches everything with an ordinary selector. The map, the node panel, the Layers menu and the search are pieces (`explorer/pieces/`) that a host app can mount in a shadow root (spec 0011; the map already is one, `<corn-map>`: [docs/embedding.md](embedding.md)), and there a stylesheet outside it reaches them by `part`: every element of those pieces that has a `data-corn` hook has a `part` of the same name, on the page too (`[data-corn="layers-menu"] [data-corn="row"]` on the page, `corn-layers::part(row)` in a host). A part is the hook's name and is public in the same way.
- **CSS only.** Hooks are for selectors, never for script: a plugin or a theme must not read them to change behaviour.
- **What is on is in ARIA.** A tab, a layer row, a view button, a theme option or a Before / Diff / After option that is on has `aria-pressed="true"`; an open menu's button has `aria-expanded="true"`; a panel is open when it is not `inert` (`[data-corn="node-panel"]:not([inert])`), and a hidden one is `[hidden]`.

### Button kinds: `data-corn-kind`

A button that does an ordinary job has no `data-corn` of its own (a region's button, such as `layers-button`, does): it has a kind, and `[data-corn-kind]` selects every button that has one, wherever it is, so no button is without both. A button of a part with a name of its own (`filter-chip`, `back`, `node-chip`, `more`, `compare-option`) has that hook, and a kind when it has one.

| Value | What it is |
|---|---|
| `primary` | the accent-filled action: Retry, Play or Pause (in the scenario player), Add node, Open file |
| `secondary` | the ordinary bordered button: Send back (in the review column's decision), Edit in the proposal bar, Previous, Next and Next scenario in the scenario player, Light on the map and Timeline on a run, Start a spec, Cancel in a dialog, Start a run |
| `quiet` | a low-key button: Close, Refresh, Cancel, Sign out, "and 15 more" |
| `danger` | a button that stops or removes: Stop a run, Revoke, Forget token |
| `approve` | a button that commits: Approve, Land it, Open the build issue |
| `icon` | a button that is only a symbol: ✕, Fit, ⋯ |

### States: `data-corn-state`

One small set, whatever word the forge, the runner or the model uses underneath; each meaning has one value. A `state-pill` always says the state of what it describes, so a run's pill and its card agree. A theme should expect only these.

| Value | What it means | Where |
|---|---|---|
| `open`, `draft`, `merged`, `closed` | a pull request, an issue or a thread (a branch with no pull request yet is `draft`, and so is a proposal only in a checkout or a worktree; on the Specs tab, "Local" and "Draft PR") | `state-pill`, `proposal-source`, `review-state` |
| `requested`, `claimed`, `working`, `waiting` | a run that is asked for and not picked up yet; picked up by a runner; being worked on; waiting on a person (or gone quiet). Each has its own colour token (`--corn-run-<state>`). `waiting` is also a spec that waits on your decision (the Specs tab's "To decide" and "Changed since approved") and the proposal bar's `waiting-line` | `run`, `state-pill`, `review-state`, `waiting-line` |
| `done`, `failed`, `stopped` | how a run ended: it finished, it failed, it was stopped (a run asked to stop is `stopped` too); a check or deploy that was skipped is `done`, a cancelled one `stopped` | `run`, `state-pill` |
| `queued`, `running` | a check or deploy that has not started, and one under way (a run is never either: it has the four above) | `state-pill` |
| `success`, `failure` | a result: a check, a deploy, a scenario's verdict, a mockup's review (approved, or its file is gone); a notice that went well, a message about a problem; what an action came to; a sign-in page about a problem (`failure`); the live chip: fresh (`success`), unavailable (`failure`); a spec approved at its current version (`success`) and a review that could not be read (`failure`) on the Specs tab | `state-pill`, `notice`, `message`, `result`, `auth-card`, `live-chip`, `review-state` |
| `sent-back` | a spec a maintainer sent back and nobody has pushed to since: it waits on the agent, not on you. The Specs tab's "Sent back" pill. (A spec to decide, or one changed since it was approved, is `waiting`; an approved one is `success`; a draft PR and a local copy are `draft`; a review that could not be read is `failure`.) | `review-state` |
| `added`, `changed`, `removed`, `edit` | what a proposal does to a node, an edge or a file: the four marks of the diff (the same four as the map's rings and `--corn-added`, `--corn-changed`, `--corn-removed` and `--corn-edit`). `edit` is your own what-if edit, whether it adds or removes. Not a status: a deploy that restarts a node is `changed` | `diff-pill`, `diff-block`, `mark-dot` |

**Changed for a theme that styles the Work panel's Specs and Runs (spec 0010).** A Specs row's pill is now `[data-corn="review-state"]`, no longer `state-pill`, and says its review state in words (To decide, Changed since approved, Sent back, Approved, Draft PR, Local, Review state unknown) instead of Open, Draft and Local; a rule on a Specs row's `state-pill` becomes one on `review-state`. The list is in groups (`spec-group`), the Runs list is in groups too (`run-group` headings; the run cards are the same), a tab's count becomes a `waiting-badge` while something waits on you, the Work button carries one (`waiting-badge`, hidden at 0), and the browser tab's title starts "(3) " while three things wait. The `data-corn-state` value `sent-back` is new. On a phone a sheet's `data-sheet-state` can now be `stub`, Work opens as a peek (it used to open expanded), and the node panel and Work take turns.

A mockup that is not reviewed yet, or has changed since, is `waiting`: a `state-pill` never says `changed`, which is the diff mark's. `failed` is only ever a run; `failure` is only ever a result. The live chip is also `waiting` (its answer is a while old, "as of 6 min ago"), `stopped` (the layer is off or not set up) or `running` (loading, and before its first answer, while the chip is still hidden).

**Changed for a theme that styles runs.** Before this release a run's `data-corn-state` was `queued` (asked for, or picked up by a runner) or `running` (being worked on). It is now `requested`, `claimed` or `working`: a rule on `[data-corn="run"][data-corn-state="queued"]` or a run's `state-pill` with `queued` becomes `requested` and `claimed`, and `running` becomes `working`. `queued` and `running` still mean a check or a deploy, so a rule that styled those keeps working. The seven run states also have colour tokens (`--corn-run-<state>`): setting those is simpler than a selector per state.

**Changed for a theme that styles the map or the proposal bar (issue #232).** Opening a proposal now narrows the map to the change: the layers it does not touch are hidden for the review (the viewer's own layers and saved choices are never written, and closing gives them back exactly), and the nodes and lines still on screen that the change does not involve are greyed (their colour taken away and faded; glyphs, kind letters, silhouettes and labels stay). Two tokens are new, `--corn-map-grey` and `--corn-map-grey-alpha` (both `auto`: each tone with its hue taken away, 0.45 left); one hook is new, `whole-map` (the proposal bar's "Whole map" switch, a `secondary` button with `aria-pressed` named "Show the whole map", off at every opening: on, the map is Diff as it was); `layer-note` also marks a Layers row the review hid ("hidden while reviewing"); and three strings are new, `wholeMap`, `showWholeMap` and `hiddenWhileReviewing`. A greyed node's label recedes: plain (a cluster's title too), at the least label size and about the dimmed-label contrast, placed after every other label and with more room round it, so far fewer are drawn. A theme's `icons` are not drawn on a greyed node (a picture has hues); the House and Flow views draw their own sets and are not narrowed, though what the change does not involve in them is greyed too.

**Changed for a theme that styles the decision (spec 0007).** Send back and Approve are never `disabled` any more: a press that is refused (a draft in the checkout), held (the 5-second hold), in flight, or done (Approve reads "Approved") is `aria-disabled="true"`, so the button keeps the focus and its reason (`aria-describedby`). A rule on `[data-corn="decision"] button:disabled` (or on `[data-corn-kind="approve"]:disabled` there) becomes one on `[aria-disabled="true"]`. The held button has `data-holding="true"`. **Undo** (`data-corn-kind="secondary"`) is placed before Approve, so Approve keeps its place under the pointer; on a phone it takes a row of its own under the two. **My edits** (beside Edit in the proposal bar, shown only while you have what-if edits) is a `secondary` button with `aria-pressed`. No token, kind or state is new.

**Changed for a theme: `explorer.css` is one stylesheet per piece, and width rules are container queries (spec 0011 D8).** Nothing on cornfield's page looks or lays out differently, and your theme needs no change: it still loads after cornfield's own stylesheets, and its `[data-corn="…"]` rules, its tokens and its `@media` rules are exactly as they were. What moved is where the rules live. `explorer/explorer.css` is gone; `explorer/css/` has `base.css` (what every piece needs: buttons, inputs, the menu box, focus rings, glass, the private `--hx-*` properties), then `header.css`, `layers.css`, `search.css`, `account.css`, `live.css`, `map.css`, `node-panel.css`, `proposal.css`, `changes.css` (the review column and the scenario player), `decision.css`, `whatif.css`, `dialogs.css`, `sheets.css` (a phone's bottom sheets), `work.css` (the Work panel and its tabs) and `page.css` (what only cornfield's page loads: the rules on `body` and `:root`, the stage, the offline notice). The page links them in that order, after `tokens.css` and before `house.css` and your theme, an order that keeps the one file's cascade. A theme that named `explorer.css` anywhere (a comment, a build step that served it) now names the files above. The class names, hooks, kinds, states and tokens are unchanged. Inside cornfield's own files every width rule is a container query now: `@container corn-box (max-width: 767px)` where it was `@media (max-width: 767px)`, so a piece asks how wide **its own box** is, not the window. On cornfield's page the box is the body, which is the window, so every breakpoint falls where it did. Container queries need no newer browser than cornfield already did (`:has()` and `color-mix()` set the floor: Chrome and Edge 111, Safari 16.2, Firefox 121). Only the body is a container, so the browsers from before mid-2024 (Chrome and Edge before 129, and Safari and Firefox of that time), which also gave a container layout containment, still place every `position: fixed` box against the window. A theme that copied one of cornfield's `@media (max-width: …)` rules to change a phone's layout **still works on the page**: the window and the page are the same width. When the same piece is shown in another app's column, the window says nothing about it, so write a theme's size rules as `@container corn-box (max-width: …) { … }` (the container is named `corn-box`; the theme's `<link>` or `@import` needs nothing else). Two limits for a theme that will also reach a piece inside a shadow root: a rule cannot ask what `<html>` says (`:root[data-theme="dark"] [data-corn="…"]` matches nothing there), so a theme that restyles a hook by light or dark does it through tokens, as the `retro` fixture theme already does; and `<html data-pixelated>` reaches a piece as the inherited property `--hx-pixelated`. A theme should not set the private `--hx-vh` (the page's own 1vh, which cornfield's few window-tall heights read). No token, hook, kind or state is added or removed. The private `--hx-control-h` and `--hx-seg-inner` are now set on every element rather than on `:root`, so a theme that set `--corn-control-height` on `:root` (the documented way) is unaffected, and one that set it on a single panel now reaches the controls inside it.

**A state is never told by colour alone.** A run's or a check's pill says the state in a word and draws a `state-icon` inside it, a shape of its own: a dashed ring (requested, queued), a ring with a dot (claimed), an arc that turns (working, running), a warning triangle (waiting, solid and heavier than the rest, since it needs the maintainer), a tick (done, success), a cross (failed, failure), a square that does not move (stopped), a dash (skipped) and a slashed ring (cancelled). A theme may restyle the icon (`[data-corn="state-icon"]`) or hide it, but the word stays. A button is never drawn as a pill: a pill is a status, and a button has a square corner.

## The hooks

`brand-logo`, `brand-wordmark` and `powered-by` are made by the brand config ([docs/config.md](config.md#brand)); `link` and `sign-out`, by the config's `links` and `signIn`. They are there only when the config names them.

### The header

| Hook | What it is |
|---|---|
| `header` | the top bar |
| `brand`, `brand-logo`, `brand-wordmark`, `powered-by` | the title button (it resets the view), the brand's logo and wordmark in it, the "powered by cornfield" footer line of the account menu |
| `links`, `link`, `sign-out` | the account menu's links (the config's, the forge, Docs), one link, the Sign out form |
| `layers-button`, `layers-menu` | the Layers chip ("Layers · 13 of 20") and its dropdown (layer rows and legends) |
| `layers-all`, `layers-none` | All and None in the Layers menu's title: they switch every layer on or off, never an overlay |
| `view-switch`, `preset-map`, `preset-dataflow`, `preset-house`, `fit-button` | the View switch (Map, Flow, House, then Fit), and its four buttons; the one that is on has `aria-pressed="true"`. Fit is also `data-corn-kind="icon"` |
| `proposals-button`, `proposals-menu` | the Proposals entry of the account menu and its list, there only without the Work panel (no forge, or no sign-in); with it, the panel's Specs tab lists the proposals and the entry is hidden |
| `forge-button`, `tokens-button` | the Work toggle (its lit tag, "#21", is a `count`), the Review tokens entry of the account menu |
| `account-button`, `avatar`, `account-menu` | the account button, the initial of who is signed in inside it, and the menu |
| `account-who`, `account-row` | the line that says who is signed in; a labelled setting of the menu (Theme, with its options) |
| `live-chip`, `live-dot`, `live-menu` | the live layer's chip, the dot in it, and its dropdown. The chip has a `data-corn-state`: `success` (fresh), `waiting` (as of a while ago), `stopped` (off), `failure` (unavailable) or `running` (loading) |
| `search`, `search-input`, `search-key`, `mobile-search`, `mobile-search-button` | the desktop search box, a search field (desktop and phone), the "/" key hint in the desktop box, the phone's search bar and the icon that opens it |
| `search-status` | the polite live region of a search field: it says the count, the match chosen, and "No match for …" to a screen reader (it is out of sight; the count and the list say it on the screen) |
| `search-count`, `search-steps` | the count in a search field ("33 matches", "3 of 33", "No match"; `data-empty="true"` when nothing matched), and the group that holds it with the Previous, Next and Clear buttons (`data-corn-kind="icon"`), there only while there is a query |
| `search-results`, `search-group`, `search-result`, `search-empty` | the list under a search field: the list, one group of it (a type's name and its count, in rank order; the matches in layers that are off come last, under their own group), one row (a match: its label and its parent's; the chosen one has `aria-current="true"`; "Frame all 33" is a `search-result` too), and the line that says nothing matched |
| `layout-toggle`, `switch` | the Freeform layout row in the account menu, and the switch drawn inside it (`aria-checked` on the row says if it is on) |
| `theme-toggle`, `theme-option`, `theme-picker` | the System / Dark / Light segment, one of its three buttons (the chosen one has `aria-pressed="true"`), the named-theme menu (all in the account menu) |
| `menu-title`, `menu-section`, `swatch` | in the Layers menu and the Proposals menu: a heading row, a section (Data Flow, Agent runs, Proposal marks, Connections), and a colour sample (a layer's dot, a line style in a legend); a kind's key row has one too when the theme sets `--corn-map-kind-<type>-<kind>` for it (`aria-hidden`: the letters and the name still say which kind it is) |
| `legend-key` | the Key in the Layers menu (spec 0008 D7): each kind of line drawn as the map draws it (an SVG per row, `data-corn="swatch"`, in the legend's one ink: owns thin, usage dotted, proposed dashed, data with an open chevron, services with a filled triangle, places with a bar, tokens with an open diamond). The line styles and end marks carry meaning and are not tokens |
| `live-tag` | the "live" tag on a layer row that is fed by the live layer |

The header was reworked in CF-41. `zoom` is gone with the zoom buttons (pinch, the wheel and `+` / `-` still zoom; Fit is in the View switch), `account-button` and `account-menu` are new, and `layout-toggle`, `theme-toggle`, `theme-picker`, `tokens-button`, `proposals-button`, `links`, `link`, `sign-out` and `powered-by` moved into the account menu. The `strings` keys are the same; `dataFlow` now reads "Flow" and `issuesAndPrs` "Work" by default, and `signOut` and `poweredBy` are drawn inside the menu.

### The map stage and its layers

| Hook | What it is |
|---|---|
| `stage` | the area the map and the panels sit in |
| `overlays` | the heading over the Layers menu's overlay rows ("Overlays": Runs in flight), which are marks over the map and not layers |
| `layer-kinds`, `kind-key` | under a Layers row that holds nodes with a finer kind: the disclosure ("5 kinds") and, when open, one key row per kind (its letters, its name, its count). A key is not a toggle; a project that wants one declares a layer |
| `layer-note` | on an off Layers row, "+1 shown by the proposal" (nodes of that layer drawn only because the open proposal touches them), or "hidden while reviewing" (a layer the open proposal does not touch, which the review hid: the row still turns it on, for the review only) |
| `whole-map` | the proposal bar's "Whole map" switch (`data-corn-kind="secondary"`, `aria-pressed`; its words are `wholeMap`, its name and tooltip the full `showWholeMap`): off at every opening, kept across Before, Diff and After; on brings back every layer the viewer has on and the dimmed, coloured map Diff always showed. On a desk it sits on the title's row, beside the source; on a phone, with Edit |
| `map-stage`, `map-canvas`, `label-canvas`, `map-overlay` | the box the map's canvases sit in (made by the map piece for a component: cornfield's own page uses its `stage`), the map's canvas, the canvas its labels are drawn on, a canvas stacked over it (the second renderer's) |
| `run-overlay`, `run-mark` | the layer of agent-run marks over the map, one mark |
| `house-under`, `house-plan`, `house-over`, `house-bar` | the House view: the layer under the map, the floor plan, the layer over the map, its bar of floors and people |
| `dock`, `sheet-handle`, `sheet-grip`, `backdrop` | the phone's bottom-sheet dock, a sheet's grab handle and the bar drawn in it, the tap-to-close layer behind the node panel on a phone; it is drawn clear there, so the node the map panned into the free band stays in view |
| `sheet-stub` | on a phone, the one 44px row a sheet folds to while the other sheet is expanded: its title, and its badge (a `waiting-badge`, on Work). A button: a tap expands it and folds the other. The sheet's `data-sheet-state` is `peek`, `expanded` or `stub`; at most two sheets are open (the review, and Work or the node panel), only one is expanded, and the map keeps 35% of the screen (`--hx-sheet-cap` is written on the dock, in px) |
| `house-chip`, `house-more` | in the House view's bar: a floor, a person, Software or Cloud (the one that is on has `aria-pressed="true"`; Edit plan is one too), and a room's "+3 more" |
| `hint`, `hint-icon`, `loading`, `error` | the hint at the map's corner and its icon (an SVG, so `[data-corn="hint-icon"]` can be hidden or given another picture), the loading line, the load-error box |

### Panels and sheets

| Hook | What it is |
|---|---|
| `node-panel` | the node panel (a slide-over, or a bottom sheet on a phone) |
| `node-title`, `node-host`, `diff-pill`, `node-foot`, `open-link` | in the node panel: its heading (a file name, an id or a route, so it may hold digits), the host after the kind badge (" · app.example.test"), the pill that says what the open proposal does to the node ("Added by Checkout"; `data-corn-state` is `added`, `changed`, `removed` or `edit`; there only while a proposal is open), the foot with its actions, and Open file / Open route (`data-corn-kind` `primary`, or `quiet` for the route when there is a file). `open-link` is also the PR detail's "Open on" the forge |
| `diff-block` | the key / value rows of the node panel's "In this proposal" (`data-corn-state` as for the pill) |
| `more` | the capped list's "and 15 more" button (`data-corn-kind="quiet"`, `aria-expanded`) |
| `work-panel` | the Work panel: Specs, PRs, Issues, Threads, Runs and Deploys |
| `waiting-badge` | the one number of what waits on you (specs to decide plus runs that need an answer), as a filled badge: on the Work button ("Work 3", spoken "Work, 3 waiting on you"; hidden at 0) and on the Specs and Runs tabs (their share; a tab with nothing waiting shows its plain total, a `count`). A tab's count span changes from `count` to `waiting-badge` and back. Takes `--corn-run-waiting` and `--corn-run-waiting-ink` |
| `spec-group`, `review-state`, `specs-search` | on the Specs tab: a group of rows with its heading (`data-group` is `decide`, `agent`, `approved` or `drafts`: To decide, With the agent, Approved, Drafts; Drafts fold behind their heading past ten rows); a row's pill that says its review state in words (To decide, Changed since approved, Sent back, Approved, Draft PR, Local, Review state unknown; its `data-corn-state` is `waiting`, `sent-back`, `success`, `draft` or `failure`); the search field above the list |
| `waiting-line` | in the proposal bar, under the buttons, when a run is waiting on the open proposal: "A run is waiting on you: Plan ready: approve to build, … · Answer" (`data-corn-state="waiting"`; the runner's words are cut to 90 characters; Answer is a `secondary` button that opens Work on Runs at that run with its reply field focused) |
| `run-group` | a heading of the Runs list (`data-group` is `needs`, `motion` or `finished`: Needs you, In motion, Finished). It is an item of the flat list, so a run's card is never moved into a section |
| `work-head`, `work-title`, `work-foot` | in the Work panel: the title row (the title, Refresh, close), the title itself (focus lands on it), the foot of the list (Release notes, New idea) |
| `filter-chip`, `filters`, `check-field` | the Filter chip on a list (`aria-expanded`; its count is a `count`), the box of fields it opens, a check box with its words ("Agent-made only"; the box itself is a `control`) |
| `back`, `detail-title` | in a detail view (a pull request, a thread, a deploy, a run's issue, the release notes): the back control ("All pull requests"), and the title |
| `tag` | a short tag on an item of a list: a pull request's or an issue's label ("spec"), a thread's kind, what a deploy lights |
| `out-link`, `text-link` | the ↗ that opens an item on the forge in a new tab; a link inside text (a check's run, a thread's reply, the node's route, "Where to set a token") |
| `lines-by-kind`, `lines-kind`, `lines-switch`, `frame-button` | in the node panel (spec 0008 D5, D6): the block of what the selection lights (a `section` of its own), one chip per kind of line ("Calls 12"; `aria-pressed` while that kind is lit alone; its number is a `count`), the check box "Include its children's lines" (the `strings` key `throughChildren`; there only for a node that has children), and Frame them (`data-corn-kind="secondary"`; the `strings` key `frame`; the `F` key does the same) |
| `node-chip`, `node-link` | a button that shows a node on the map: a chip (the nodes a pull request, a thread or a deploy lights); a link-like one inside a sentence (the proposal's edge "From" and "To", a live room) |
| `file` | a changed file in a pull request's detail, with its nodes |
| `thread-message` | one message of a thread, in the Threads tab's detail |
| `field-change` | in "In this proposal" (the node panel): a field a change touches, with what it was and what it is |
| `run-actions`, `run-totals` | the buttons of a run card (Light on the map, Timeline, Stop, Reply and the rest: each has a `data-corn-kind`), the totals of what the runners reported |
| `forge-panel` | **deprecated**: the old name of `work-panel`, kept for one release. It is now on the panel's inner box (its first child), so a rule that sets the panel's position or width must move to `work-panel`; colours and type still apply |
| `proposal-bar`, `proposal-head` | the open proposal's bar, and its toolbar row |
| `proposal-title`, `proposal-counts`, `proposal-mode` | in the proposal bar: the proposal's name (an `h2`), the counts ("5 nodes, 6 edges added · 5 scenarios": its parts are `quiet` buttons that take the focus to the Changes or the Scenarios section of the review column; on a phone they move its switch. Until spec 0006 it was one button that opened the list of changes (`aria-expanded`): a rule that styled it as a button, its hover or `[aria-expanded]` now goes on `[data-corn="proposal-counts"] button`; its font and colour still apply), and on a phone the button that shows Before / Diff / After (it says which is on) |
| `compare`, `compare-option` | the Before / Diff / After group and one of its options (the chosen one has `aria-pressed="true"`) |
| `proposal-menu`, `proposal-errors` | the bar's ⋯ menu, the folded list of problems with the file |
| `whatif-toolbar` | the What-if editor's toolbar (Add a node, Draw an edge, Undo, Redo …) |
| `review-column` | the review column, open with the proposal: docked on the left of the map under the bar from 768px (400px wide, 320px under 1024px), and on a phone the expanded proposal sheet's body. It holds the two lists and the decision. Rules that place it should leave its `top`, `bottom` and `left` alone: the map is framed into what it leaves free |
| `proposal-changes`, `scenario-list` | the review column's two sections, each with its heading (`h3`) and its list: Changes (each change is a `row`, a button, in a `li`) and Personas and scenarios. Since spec 0006 both are sections of the column, not boxes of their own: `proposal-changes` was the list behind the counts in the bar, and `scenario-list` the list behind Play, a box over the map; a rule that placed or sized either (`position`, `max-height`, `top`) no longer applies the same way |
| `persona-group` | one persona's `h4` ("Adult · 1 scenario") and the scenarios that apply to it, one `row` each (a disclosure: `aria-expanded`); the last group is Anyone, the scenarios that name no persona |
| `step-list`, `step` | an opened scenario's numbered list of steps, and one step (a button: who acts, the node, its mark, the text and its verdict; the one the player is on has `aria-current="step"`). Its verdict is a `state-pill` |
| `decision` | the column's foot, a group: Send back and Approve, and above them the review status (`review-bar`), the one line that says what Approve does in this state (Approve's `aria-describedby`, `id="review-line"`), the question Approve asks in place in four states (a `message` with `data-corn-state="waiting"`, `role="alert"`), the hold's bar, and the notice of a landing that waits with its **Cancel landing**. While a press is held the pressed button reads "Approving in 5 s" (`data-holding="true"`), **Undo** (`data-corn-kind="secondary"`) sits just before Approve, and Approve reads "Approved" (`aria-disabled`) while approving again would do nothing (an approval stands at this version and, with landing on approval its landing waits) |
| `sent-edits` | under the decision after a send back: **Sent with 2 edits**, a read-only disclosure (`summary`) of the edits the review carried; they are no longer on the map, the review comment holds them |
| `mark-dot` | the dot in front of a change or a count and in a legend; `data-corn-state` is `added`, `changed`, `removed` or `edit` |
| `step-number` | in the What-if editor, the number of a scenario's step (it shows that step on the map) |
| `proposal-source`, `proposal-ways` | in the proposal bar: the chip after the title that says which copy is under review ("PR #24 · draft · 1 check running", linking to the PR; or "Local draft · in the checkout"; its `data-corn-state` is the PR's `open`, `draft`, `merged` or `closed`, and `draft` for a local copy; none until the PR is known), and the buttons a link that found nothing offers (the Specs list, the same name under another source) |
| `review-bar`, `review-label`, `review-note`, `whatif`, `whatif-panel`, `whatif-node` | the review part, in the `decision` (the status line and the note that opens on Send back, above Send back and Approve), and in the proposal bar, the note's label, the note's text field, the what-if editor (behind Edit), one of its panels (the form to add a node or an edge, the list of edits, the steps), and its editor for the selected node in the node panel |
| `scenario-player`, `scenario-check`, `scenario-track`, `scenario-fill` | the scenario player (one bar at the foot of the map area, to the right of the review column; on a phone one row of 44px targets), the line that says whether a step was allowed, and the progress bar with its fill (`style="width"`) |

### The sign-in pages

The sign-in page, the "ask a maintainer" page (403), a sign-in that did not work and "your access could not be checked" are drawn by the server before anyone is in. They link `tokens.css`, a small `sign-in.css` of their own, the config's font stylesheets and theme file, and the stored Light, Dark or System choice (`theme-boot.js`), so the tokens and hooks of the rest of this page reach them too, and carry the brand's logo, wordmark and app name. Everything they load answers without a sign-in; nothing else does ([docs/sign-in.md](sign-in.md)).

| Hook | What it is |
|---|---|
| `auth-page` | the page's `<body>` |
| `auth-card` | the card in the middle (`data-corn-state="failure"` on a page about a problem) |
| `auth-brand` | the logo and the wordmark or app name at the top of the card (`brand-logo` and `brand-wordmark` are inside it, as in the header) |
| `auth-reason` | the line that says what a proposal link was for ("You followed a link to a proposed change"), there only when the link was to a proposal |

The buttons carry `data-corn-kind` (`primary`: Sign in, Try again; `quiet`: Sign out).

### Dialogs

| Hook | What it is |
|---|---|
| `dialog-scrim` | the scrim behind a dialog |
| `confirm-dialog`, `agent-dialog`, `tokens-dialog` | the confirm dialog (land a pull request, start a spec, open a build issue), Start an agent, Review tokens |
| `mockup-dialog`, `mockup-stage` | the mockup window, and the stage in it that holds the image or the frame |
| `dialog-title`, `confirm-form`, `confirm-preview` | a dialog's heading, the box of a form in a dialog or a panel (Start an agent, New idea, Post as a draft release), and the preformatted text a confirm step shows (the files a spec will add) |

Every dialog box ends in `-dialog`, so `[data-corn$="-dialog"]` styles all of them.

### Components

| Hook | What it is |
|---|---|
| `tabs`, `tab` | a row of tabs, one tab: the Work panel's, and the review column's phone switch (Changes · 6 \| Scenarios · 3; `role="tablist"`, `aria-selected`) |
| `count` | a number shown as data: a tab's count (empty, at least `2ch` wide, until it is read, so the tabs do not move), a layer's count, the Work button's lit tag ("#21"), the step counter, a pull request's number in its detail. Takes `--corn-font-num` |
| `row` | one entry of a list: a spec, pull request, issue, deploy or thread; a layer in the Layers menu; a proposal in the Proposals menu or on the Specs tab; a change in the open proposal; a scenario in the review column; a mockup; a review token |
| `run` | an agent run's card (`data-corn-state`) |
| `section` | a section of the node panel |
| `badge` | a badge: the node panel's kind (type · host), the "Agent" mark |
| `state-pill` | a state word (`data-corn-state`); a scenario step's verdict in the review column carries `success` (allowed, or refused as expected) or `failure` (refused, or not as expected), and none when it was not checked: its words always say which |
| `state-icon` | the icon inside a run's or a check's `state-pill`: a shape for each state, drawn in the pill's colour |
| `result` | what an action came to, under the control that was used (a run's Reply, Continue or Stop; Copy spec); it stays until the next action and is also announced |
| `work-top` | the Work panel's title row and tabs, which stay in place while a list scrolls (and show a fade where the tabs run off a phone's screen) |
| `skeleton`, `empty` | a list's placeholder rows while it loads (they hold the list's height), and the placeholder lines of the Runs tab's runner line and totals while the runs load; what a list says when it has nothing, and how to make something |
| `field` | a labelled form field, its control inside |
| `control` | a text field, a number field, a select, a check box or a text area: the control inside a `field`, or on its own. The search fields are `search-input` and the note on Send back is `review-note`; the named-theme menu is `theme-picker` |
| `summary` | the line of a disclosure that opens and folds (the proposal's problems, "Its edges (3)") |
| `notice`, `message` | a notice in a panel (the Layers menu's note about the data-flow view too); a status line under a form or above the proposal bar (`data-corn-state="success"` or `"failure"`) |

## Web components: tags, properties, events, methods and parts

The explorer's pieces are also web components, for putting in another app's page ([docs/embedding.md](embedding.md) says how to load them). They are part of the public contract in the same way the tokens and the hooks are: **renaming or removing anything listed here is a breaking change**; adding one is not. [test/explorer/components-contract.test.js](../test/explorer/components-contract.test.js) fails when this section and the components' source disagree, in either direction.

- **Tokens are the first way to theme a component.** Every `--corn-*` token inherits through the shadow root, so a rule on `:root`, on a wrapper or on one element sets it for the maps inside. The default values (everything in `tokens.css`) are added to the page by the first `corn-*` element, at zero specificity, so **any ordinary rule of yours overrides them**.
- **Hooks are parts.** Inside a shadow root a page's `[data-corn="…"]` rule cannot reach, so every hook a piece makes is also a `part` of the same name: `corn-map::part(map-stage) { … }`. A `::part()` selects the element and not what is inside it.
- **Light and dark** follow the page unless the element is told: with no `theme` attribute the page's own `<html data-theme>`, else the system's `prefers-color-scheme`, decides, as on cornfield's own page. `theme="light"` or `theme="dark"` forces that mode for the element (the element declares that mode's tokens itself, so a rule of yours **on that element** sets one of them; a rule on `:root` does not reach a forced element).

### Tags

| Tag | Shadow root | What it is |
|---|---|---|
| `corn-map` | yes | The map: pan, zoom, select, from a topology the host hands in |

### Properties

| Tag | Property | Attribute | Values |
|---|---|---|---|
| `corn-map` | `topology` | none | the object `topology.json` holds, `{ nodes, edges }`; never changed by the map |
| `corn-map` | `node` | `node` (reflected) | the id of the selected node, or none; it follows a click or a key |
| `corn-map` | `view` | `view` | `map` or `dataflow` |
| `corn-map` | `theme` | `theme` (reflected) | `light`, `dark` or `auto` |
| `corn-map` | `renderer` | `renderer` | `auto` or `canvas2d` |

### Events

All events bubble and cross the shadow root (`composed`), so a listener on any ancestor hears them.

| Tag | Event | `detail` |
|---|---|---|
| `corn-map` | `cornSelect` | the selection changed, whoever changed it (a click, a key, `node`, `focusNode()`), once per change. Its fields: `id`, `kind`, `source`, `from`, `to`. `kind` is `node`, `edge`, or null when cleared; `id` is the node's id, `from->to` for an edge, or null; `source` is `tap`, `keyboard`, `api` or `state` |
| `corn-map` | `cornReady` | none: the first frame with a map in it is drawn, once each time the element is put in the page |

### Methods

| Tag | Method | What it does |
|---|---|---|
| `corn-map` | `fit()` | puts the whole map in view |
| `corn-map` | `focusNode(id)` | selects the node and brings it into view |
| `corn-map` | `refresh()` | reads the tokens again and draws, for a token changed where the map cannot see it (a stylesheet added to the page's head, a class or a style on a wrapper); the `theme` attribute, `<html data-theme>` and the system's setting it follows by itself |

All three answer with a promise.

### Parts

| Tag | Parts |
|---|---|
| `corn-map` | `map-stage`, `map-canvas`, `label-canvas`, `map-overlay` |

## Words

A brand can speak in its own voice: `strings` in `cornfield.config.js` is a flat map that overrides the visible labels, so the menus say what the brand says.

```js
strings: { approve: 'Ship it', sendBack: 'Not yet', tabPulls: 'Builds' }
```

- **A missing key keeps the default.** Say only the words you want to change.
- **An unknown key is refused**, by `cornfield validate` and when the config loads, with the key named and the known ones listed.
- **A value is plain text**: one line, at most 80 characters, not empty. HTML is not an error, it is shown as the characters you wrote (`<b>` stays `<b>`): a value reaches the page through `textContent` and attributes only, never as markup.
- **The server sends only the overridden keys**, in `strings` of `/cornfield/config.json`. The key list is one table, `STRINGS` in `core/strings.js`; the config check, the browser and this page all read it, and a test fails when this table and `STRINGS` differ.
- **Accessible names follow the words.** A control's name is its visible label: when you override a key, the visible text and the control's `aria-label` carry the same words. Where a name adds a fixed target, only the label part changes: with `stop: 'Halt'`, the button reads "Halt" and a screen reader says "Halt run 7". So a screen reader says what the screen shows. A longer word has to fit its button.

**The Work panel's keys changed** (CF-42, the panel's tabs run in the order of the loop): `tabSpecs` is new, `tabAgents` is now `tabRuns` (Runs), and `tabNotes` is gone, because Release notes is no longer a tab but a "Release notes …" action at the foot of the PRs list. `tabPulls` keeps its name and now says "PRs". A config that still sets `tabAgents` or `tabNotes` is refused by `cornfield validate` with the key named, so rename `tabAgents` to `tabRuns` and delete `tabNotes`. With the panel on, the account menu's Proposals entry (`proposals-button`, `proposals-menu`) is hidden, since Specs lists the same proposals; without a forge or a sign-in there is no panel, and the entry is how the proposals are reached.

Only labels a brand would want to voice are keys (about eighty). Sentences of help text, status lines and the forge's own errors stay as they are.

<!-- strings:start -->
| Key | Default |
|---|---|
| `layers` | Layers |
| `layersAll` | All |
| `layersNone` | None |
| `overlays` | Overlays |
| `dataFlow` | Flow |
| `house` | House |
| `proposals` | Proposals |
| `issuesAndPrs` | Work |
| `searchPlaceholder` | Search... |
| `searchNoMatch` | No match for |
| `signOut` | Sign out |
| `poweredBy` | powered by cornfield |
| `before` | Before |
| `diff` | Diff |
| `after` | After |
| `closeProposal` | Close |
| `approve` | Approve |
| `sendBack` | Send back |
| `sendBackWithNote` | Send back with this note |
| `approveAnyway` | Approve anyway |
| `sendBackAnyway` | Send back anyway |
| `undo` | Undo |
| `approved` | Approved |
| `myEdits` | My edits |
| `showWholeMap` | Show the whole map |
| `wholeMap` | Whole map |
| `hiddenWhileReviewing` | hidden while reviewing |
| `yourEdits` | Your edits |
| `cancelLanding` | Cancel landing |
| `queueIt` | Queue it |
| `reviewNoteLabel` | Note for the drafting agent |
| `reviewNotePlaceholder` | What should change? |
| `openSpecsList` | Open the Specs list |
| `changes` | Changes |
| `personasAndScenarios` | Personas and scenarios |
| `scenarios` | Scenarios |
| `anyone` | Anyone |
| `notInAnyScenario` | Not in any scenario |
| `steps` | Steps |
| `previousStep` | Previous |
| `nextStep` | Next |
| `pause` | Pause |
| `play` | Play |
| `playAgain` | Play again |
| `nextScenario` | Next scenario |
| `notChecked` | Not checked |
| `tabSpecs` | Specs |
| `tabPulls` | PRs |
| `tabIssues` | Issues |
| `tabThreads` | Threads |
| `tabRuns` | Runs |
| `tabDeploys` | Deploys |
| `waitingOnYou` | waiting on you |
| `toDecide` | To decide |
| `withAgent` | With the agent |
| `approvedGroup` | Approved |
| `drafts` | Drafts |
| `needsYou` | Needs you |
| `inMotion` | In motion |
| `finished` | Finished |
| `answer` | Answer |
| `newIdea` | New idea |
| `landIt` | Land it |
| `startAgent` | Start an agent |
| `askRunner` | Ask the runner |
| `startAgain` | Start again |
| `stop` | Stop |
| `continueRun` | Continue |
| `reply` | Reply |
| `openFile` | Open file |
| `openRoute` | Open route |
| `startRun` | Start a run |
| `copySpec` | Copy Spec |
| `frame` | Frame them |
| `throughChildren` | Include its children's lines |
| `hintInspect` | Click a node to see what it is |
| `hintInspectTouch` | Tap a node to see what it is |
| `hintDrag` | Drag nodes to move • Double-click to inspect |
| `hintDragTouch` | Drag nodes to move • Double-tap to inspect |
| `hintDataFlow` | Data flow: browser → servers → API → tables → services → outside |
| `loading` | Loading topology.json … |
| `errorTitle` | The map could not be loaded |
| `retry` | Retry |
<!-- strings:end -->

The node panel read two more words that are gone: `propsTitle` ("Properties & Attributes") and `detailsTitle` ("Details"). The panel has no such headings any more, so a config that still sets them is refused as an unknown key; remove them. `openFile` ("Open file") is the primary action when the node has a file and the config names a forge; `openRoute` ("Open route") is primary when there is no such file and the quiet second action when there is; `startRun` ("Start a run") is new.

## The old `--hx-*` names

`tokens.css` keeps the old names as aliases for one release, so `scene.js`, the proposal's bar (`explorer/pieces/proposal.js`, which writes `--hx-mark-*` on the instance's token element, `:root` on cornfield's page, for the map's own ground) and any plugin CSS keep working: `--hx-indigo: var(--corn-accent-text)`, `--hx-line: var(--corn-line)`, `--hx-mark-added: var(--corn-added)`, and so on. **The aliases go in the next minor release.** Write `--corn-*` in new CSS.
