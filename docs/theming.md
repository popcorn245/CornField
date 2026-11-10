# Theming: the `--corn-*` tokens

Every colour, font, font size, radius, border and outline width, shadow and spacing in the explorer's stylesheets is a custom property whose value is written in one file, [explorer/tokens.css](../explorer/tokens.css). `explorer.css` and `house.css` only read them (`var(--corn-…)`), and [test/explorer/tokens.test.js](../test/explorer/tokens.test.js) fails the build on any literal left outside `tokens.css`. A brand restyles the explorer with one stylesheet, loaded after cornfield's, that redefines some of these names. It is CSS only: no script, no fork.

## How a brand stylesheet works

- **Load it after cornfield's stylesheets**, with `theme` in `cornfield.config.js` (below).
- **Set tokens on `:root`.** A token that is made from another one (`--corn-font-display` is `var(--corn-font)`, the `*-soft` tints mix their colour) is worked out on `:root`, so a value set on `body` or a panel does not reach it.
- **Use cornfield's three selectors.** Dark values, and everything both themes share, are on `:root`. Light values are under both `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { … } }` (the system setting, before any script runs) and `:root[data-theme="light"] { … }` (the viewer's choice, which `theme-boot.js` puts on `<html>`). Those two are more specific than `:root`, so a token cornfield sets for light has to be set in your light blocks too, or cornfield's light value wins on the light ground. Repeat the same selectors in your file; as it loads later, yours win.
- **Keep text readable.** Text on `--corn-accent` is `--corn-text-on-accent`; the solid fills of a status or a hue (a pressed data-flow button, a pressed House chip, a sandbox chip) put `--corn-ground` on the hue. `cornfield validate` checks the pairs below against WCAG AA, in light and dark ([The contrast check](#the-contrast-check)).

## Applying a theme

A brand's tokens live in a repo theme file that `cornfield.config.js` names, and the server links it after `tokens.css`, `explorer.css` and `house.css`, so its values win: see [docs/config.md, Theme](config.md#theme) for the file, the font allow-list, the images and fonts beside it, and what `validate` checks.

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

**The pairs.** Each is what [explorer/explorer.css](../explorer/explorer.css) paints; [test/core/contrast.test.js](../test/core/contrast.test.js) fails when explorer.css sets a text colour on a background the list does not hold.

| Text (4.5:1) | On |
|---|---|
| `--corn-text`, `--corn-text-2`, `--corn-text-3`, `--corn-accent-text`, `--corn-ok`, `--corn-warn`, `--corn-bad`, `--corn-info`, `--corn-added-text`, `--corn-edit-text` | `--corn-ground`, `--corn-surface-1`, `--corn-surface-2`, `--corn-surface-3` |
| `--corn-text-on-accent` | `--corn-accent`, `--corn-accent-hover` |
| `--corn-ok`, `--corn-warn`, `--corn-bad`, `--corn-info`, `--corn-accent-text`, `--corn-hue-orange-text` | their tint: `--corn-ok-soft`, `--corn-warn-soft`, `--corn-bad-soft`, `--corn-info-soft`, `--corn-accent-soft`, `--corn-hue-orange-soft` |
| `--corn-ground` (the text on a solid fill) | `--corn-ok`, `--corn-warn`, `--corn-bad`, `--corn-info`, `--corn-hue-orange`, `--corn-hue-lime`, `--corn-added-text`, `--corn-edit-text` |
| `--corn-hue-fuchsia` (ROM, a milestone, a link button), `--corn-hue-pink` (a variable) | `--corn-ground`, `--corn-surface-1` (and fuchsia on `--corn-surface-2`) |
| `--corn-hue-orange` (the data-flow button) | `--corn-surface-2` |
| the tints explorer.css mixes itself: a hue at 6–30% over the panel | `--corn-hue-lime` on lime 6% (a room on the House plan); `--corn-accent-text`, `--corn-hue-pink`, `--corn-edit-text` on their own 10% (the header links); the orange and fuchsia buttons' text (the hue 60% with `--corn-text`) on their 15% and 20%; `--corn-added-text` on `--corn-added` 12%, 14% and 20% and `--corn-text` on 12% (the current proposal, the proposals and approve buttons); `--corn-text` on `--corn-edit` 30%; `--corn-bad` on `--corn-removed` 10%, 12% and 16%, `--corn-text-2` on 10%; `--corn-warn` on `--corn-changed` 16%; `--corn-text-2` on `--corn-text-3` 10% and 12%, on `--corn-text-2` 12% and on `--corn-line-soft`; `--corn-text-3` on `--corn-text-3` 12% |

| UI (3:1) | On |
|---|---|
| `--corn-focus`, the focus ring (and the search and token fields' focused border) | `--corn-ground`, `--corn-surface-1`, `--corn-surface-2`, `--corn-surface-3` |
| `--corn-edit-text`, a What-if field's focus ring; `--corn-added-text`, the review note's focus ring | `--corn-ground`, `--corn-surface-1` |
| `--corn-accent-text`, the selected row's border and a pressed button's border | `--corn-surface-3`, `--corn-surface-1`, `--corn-ground` |
| `--corn-added-text`, the current proposal's border | `--corn-added` 12%, `--corn-surface-1` |
| `--corn-ok`, a layer's tick; `--corn-ok`, `--corn-edit-text`, `--corn-bad`, `--corn-warn`, `--corn-text-3`, a run or PR state pill's border (its text colour) | `--corn-surface-2`, `--corn-surface-3` |

The minimums are the WCAG 2.1 ones: **4.5:1** for text, **3:1** for large text and for the parts of the interface a person needs to see (1.4.11). No token pair is large text. Most UI tokens are text tokens too, so they are held to 4.5:1 where they are: a pair listed twice is checked once, at the higher minimum. Not checked, on purpose: `--corn-line` and `--corn-line-soft` (a divider or a quiet border is decoration, never the only sign of a state); the pressed accent button's fill (its `--corn-accent-text` border carries the state); and the map, which is drawn on a canvas with its own colours.

**What a colour sits on.** The page paints the ground, then `--corn-ground-image`, then the panels, then the text, and the check composites in that order:

- a **surface** sits on the ground, and on the ground under each layer of `--corn-ground-image` at its most opaque colour stop (the centre of a radial glow): the worse of the two counts, and its line says "over the ground image";
- a **tint** (a `*-soft` token, or a tint explorer.css mixes) sits in a panel: over `--corn-surface-1` over the ground (and the image);
- a **text colour** with alpha is composited over its background.

An image in `--corn-ground-image` (`url()`) cannot be read and adds nothing; keep text-bearing panels opaque enough over it.

**Light and dark, and the system setting.** `theme-boot.js` always puts the viewer's light or dark on `<html data-theme>`, and a viewer can pick light on a dark system or dark on a light one. So each mode is resolved twice, with `prefers-color-scheme` the same and the other way, and the worse counts; a line from the second says "on a system set to …". This catches a theme that writes its light values on `:root` and its dark ones only in `@media (prefers-color-scheme: dark)`: a viewer who picks dark on a light system gets the light values on cornfield's dark ground.

**How a theme is read.** A small resolver reads the stylesheets as text (no browser): custom properties in `:root`, `html`, `[data-theme="…"]` and `[data-theme-name="…"]` rules (with `:not()`), at the top level and inside `@media (prefers-color-scheme: light|dark)`. The cascade is the browser's: `!important`, then specificity, then source order. It follows `var(--x, fallback)` chains (a property that is unset or in a cycle has nothing to give, so the fallback is used) and reads colours written as `#rgb`, `#rrggbb` (with alpha), `rgb()`/`rgba()`, `hsl()`/`hsla()` (comma or space syntax), `transparent`, the basic colour names and `color-mix(in srgb, A p%, B)` (premultiplied, as the browser mixes; shares under 100% lower the alpha). Tokens it does not know, like a `--corn-map-*` token, are ignored unless a pair above uses them.

**A token it cannot work out** is a **warning**, not an error: the pair was not checked. The line names the token and why:

```
standard theme (dark): --corn-text on --corn-ground could not be checked: --corn-text → --brand-fg is "oklch(70% 0.1 200)": oklch() is not a colour cornfield reads (it reads hex, rgb(), hsl(), color-mix(in srgb, …), transparent and the basic colour names).
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

The map itself (the nodes, edges and labels on the canvas) takes its own `--corn-map-*` tokens: see [The map](#the-map). The dots, rings and run marks are round (`50%`) in any theme, as a node is.

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
| `--corn-shadow-color` | the colour of the one shadow that is not one of the three: a phone sheet's, cast upward (light) |
| `--corn-glow` | the blur of a live dot's glow; `0px` for none (light) |
| `--corn-scrim` | the backdrop behind a sheet or a dialog (light) |
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
| `--corn-ok-soft`, `--corn-warn-soft`, `--corn-bad-soft`, `--corn-info-soft` | the same, as a tinted background |
| **Diff** (shared with the map) | |
| `--corn-added`, `--corn-changed`, `--corn-removed`, `--corn-edit` | what a proposal adds, changes, removes, and a what-if edit; the light values are [theme-model.js](../explorer/theme-model.js) `lightColor` of the dark ones, so the legend matches the map (light) |
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
| `--corn-mono` | code, ids and numbers |
| `--corn-text-2xs` | 10px, mono code and small meta |
| `--corn-text-xs` | 11px |
| `--corn-text-sm` | 12px |
| `--corn-text-md` | 13px |
| `--corn-text-base` | 14px |
| `--corn-text-lg` | 15px, a panel's title |
| `--corn-text-xl` | 20px, the node panel's heading |
| **Shape** | |
| `--corn-radius-xs` | 3px, a tag |
| `--corn-radius-sm` | 6px, a button, a field |
| `--corn-radius` | 10px, a row, a card |
| `--corn-radius-lg` | 14px, a panel or a sheet |
| `--corn-radius-pill` | 999px, a pill: a badge, a chip, a state |
| `--corn-border` | 1px, every border |
| `--corn-border-strong` | 2px, an accent: a selection bar, a ring, a mark |
| `--corn-focus-width` | 2px, the focus ring |
| **Spacing** (padding, gaps and margins are steps of this scale, or `calc()` over it) | |
| `--corn-space` | 4px, the unit |
| `--corn-space-1` | 4px (`--corn-space`) |
| `--corn-space-2` | 6px |
| `--corn-space-3` | 8px |
| `--corn-space-4` | 12px |
| `--corn-space-5` | 16px |
| `--corn-space-6` | 24px |

Where the stylesheets once had a one-off tint, they mix a token: `color-mix(in srgb, var(--corn-added) 14%, transparent)`. Where they had many near-identical values, they now share the nearest step: the radii 8 and 12px became `--corn-radius-sm` and `--corn-radius`; the font sizes 9 and 10.5px became `--corn-text-2xs`, 16px became `--corn-text-lg`; a 10px padding is `--corn-space-3` (8px), 14px and 18px are `--corn-space-4` and `-5`, a 2px gap is `calc(var(--corn-space-1) / 2)`; a 3px accent bar is `--corn-border-strong`. Lengths that are not one of these (a width, a height, a position) stay in the stylesheets.

## The map

The map canvas is drawn from tokens too. Its renderers (WebGL, and the Canvas 2D one it falls back to) and its label layer read the `--corn-map-*` custom properties below from the page's computed style when the page loads and again whenever the theme changes (`data-theme`, `data-theme-name`, a theme stylesheet finishing loading, or `prefers-color-scheme` flipping), then draw again. Both draw the same, so a token set once styles both.

- **`auto` is the default, and it is today's map.** A node is drawn in its own colour from the topology (deepened for the light ground, as it always was); every line, halo and mark keeps the colour it had. A theme that sets nothing changes nothing.
- **A colour replaces it, as written.** Both themes read the same token, so a theme sets the light ground's colour too, under `:root[data-theme="light"]` (or `@media (prefers-color-scheme: light)`).
- **A kind beats its group.** A node's *kind* is its type (`app`, `table`, ...). Its *group* is its layer in the Layers menu: the same name for most, except that the rooms and floors are `house` and an outside system is `cloud` or `web`. `--corn-map-node-table` wins over `--corn-map-group-table`. Only the fill goes by kind and group; the outline and the label are one colour for the whole map.
- **An outline is off until you set one.** `--corn-map-stroke` draws a ring just inside every node's edge, `--corn-map-stroke-width` thick. `--corn-map-label` keeps the label's own fade: a node the focus dims stays dim.
- **Colours that mean something stay.** A node or an edge an outage, a permission check or a selected pull request colours (red, amber, green) keeps that colour; the map tokens style what is otherwise drawn in the node's or the line's own colour.
- **Anything that is not a colour is `auto`.** A value is read as the browser reads a colour (`#e53e3e`, `rgb()`, `hsl()`, a name, `color-mix()`, `oklch()`), so a typo, a length or an empty value leaves that part of the map as it was rather than breaking it.
- **Icons.** `theme.icons` in the config (docs/config.md#theme) draws an image per node kind inside the node; `theme.pixelated` draws small ones crisp.

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

There are 62 map tokens: 21 node kinds and 18 groups (a fill each), 11 edge kinds, the outline (colour and width), the label (colour and halo), and 8 states.

| Token | What it is |
|---|---|
| **Outline, label and state** | |
| `--corn-map-stroke` | the outline of every node: a ring just inside its edge, at the node's own fade. `auto`: no outline, as the map has always been |
| `--corn-map-stroke-width` | the width of that outline, in the map's own pixels (`1.5px` by default; it only matters once `--corn-map-stroke` is set; `0` turns it off) |
| `--corn-map-label` | the colour of a node's label (its fade outside the focus is kept). `auto`: near-white on the dark ground, near-black on the light one |
| `--corn-map-label-halo` | the outline drawn under every label on the map (a node's, an edge's) so it reads over the lines, used as written (give it an alpha to soften it). `auto`: the ground's own colour, slightly translucent |
| `--corn-map-added`, `--corn-map-changed`, `--corn-map-removed`, `--corn-map-edit` | the diff on the map: a proposal's ring on a node and its line on an edge, and a what-if edit's. The legend and the panel's dots follow them. `auto`: `--corn-added`, `--corn-changed`, `--corn-removed` and `--corn-edit` as the map has always drawn them |
| `--corn-map-selected`, `--corn-map-match` | the halo of the selected node, and of a node a search finds (its disc is the same colour, translucent) |
| `--corn-map-lit` | the straight links the focus lights: the selection's own lines, and the step of a walk (a data-flow edge keeps its flow's colour: `--corn-map-edge-flow`) |
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

- **Public API, kept short on purpose.** The names below are documented, and **renaming or removing one is a breaking change**: it is listed under "Breaking" in the release notes (the `breaking` label). Adding one is not. The parts inside a region (a title, a label, a line of meta) have no hook: reach them from their region (`[data-corn="node-panel"] h2`), or change them with the tokens. [test/explorer/hooks.test.js](../test/explorer/hooks.test.js) fails when this list and the markup disagree, in either direction.
- **Values** are short kebab-case nouns. One element has one `data-corn` value; a component used in many places (`row`, `field`, `badge`) has the same value everywhere, so scope it by its region: `[data-corn="layers-menu"] [data-corn="row"]`.
- **Two companions:** `data-corn-kind` (a button's kind) and `data-corn-state` (a state). Their values are listed below and are public in the same way.
- **No shadow DOM.** The explorer uses none, so a stylesheet reaches everything with an ordinary selector and there are no `::part()` names.
- **CSS only.** Hooks are for selectors, never for script: a plugin or a theme must not read them to change behaviour.
- **What is on is in ARIA.** A tab, a layer row or a view button that is on has `aria-pressed="true"`; an open menu's button has `aria-expanded="true"`; a panel is open when it is not `inert` (`[data-corn="node-panel"]:not([inert])`), and a hidden one is `[hidden]`.

### Button kinds: `data-corn-kind`

Buttons have no `data-corn` of their own (unless they are a region's button, such as `layers-button`): `[data-corn-kind]` selects every button that has a kind, wherever it is, and a button with no kind is the plain one.

| Value | What it is |
|---|---|
| `primary` | the accent-filled action: Retry, Play |
| `quiet` | a low-key button: Close, Refresh, Cancel, Sign out |
| `danger` | a button that stops or removes: Stop a run, Revoke, Forget token |
| `approve` | a button that commits: Approve, Land it, Open the build issue |
| `icon` | a button that is only a symbol: ✕, Fit |

### States: `data-corn-state`

One small set, whatever word the forge, the runner or the model uses underneath; each meaning has one value. A `state-pill` always says the state of what it describes, so a run's pill and its card agree. A theme should expect only these.

| Value | What it means | Where |
|---|---|---|
| `open`, `draft`, `merged`, `closed` | a pull request, an issue or a thread (a branch with no pull request yet is `draft`) | `state-pill` |
| `queued`, `running`, `waiting` | not started yet; under way; waiting on a person (or gone quiet) | `run`, `state-pill` |
| `done`, `failed`, `stopped` | how a run ended: it finished, it failed, it was stopped; a check or deploy that was skipped is `done`, a cancelled one `stopped` | `run`, `state-pill` |
| `success`, `failure` | a result: a check, a deploy, a scenario's verdict, a mockup's review (approved, or its file is gone); a notice that went well, a message about a problem | `state-pill`, `notice`, `message` |

A mockup that is not reviewed yet, or has changed since, is `waiting`. `failed` is only ever a run; `failure` is only ever a result.

## The hooks

`brand-logo`, `brand-wordmark` and `powered-by` are made by the brand config ([docs/config.md](config.md#brand)); `link` and `sign-out`, by the config's `links` and `signIn`. They are there only when the config names them.

### The header

| Hook | What it is |
|---|---|
| `header` | the top bar |
| `brand`, `brand-logo`, `brand-wordmark`, `powered-by` | the title button (it resets the view), the brand's logo and wordmark in it, the "powered by cornfield" footer line of the account menu |
| `links`, `link`, `sign-out` | the account menu's links (the config's, the forge, Docs), one link, the Sign out form |
| `layers-button`, `layers-menu` | the Layers chip ("Layers · 13 of 20") and its dropdown (layer rows and legends) |
| `preset-dataflow`, `preset-house` | the View switch (Map, Flow, House): the Flow and House buttons |
| `proposals-button`, `proposals-menu` | the Proposals entry of the account menu and its list, there only without the Work panel (no forge, or no sign-in); with it, the panel's Specs tab lists the proposals and the entry is hidden |
| `forge-button`, `tokens-button` | the Work toggle, the Review tokens entry of the account menu |
| `account-button`, `account-menu` | the account button (the initial of who is signed in) and its menu |
| `live-chip`, `live-menu` | the live layer's chip and its dropdown |
| `search`, `search-input`, `mobile-search` | the desktop search box, a search field (desktop and phone), the phone's search bar |
| `layout-toggle` | the Freeform layout switch in the account menu |
| `theme-toggle`, `theme-picker` | the System / Dark / Light segment, the named-theme menu (both in the account menu) |

The header was reworked in CF-41. `zoom` is gone with the zoom buttons (pinch, the wheel and `+` / `-` still zoom; Fit is in the View switch), `account-button` and `account-menu` are new, and `layout-toggle`, `theme-toggle`, `theme-picker`, `tokens-button`, `proposals-button`, `links`, `link`, `sign-out` and `powered-by` moved into the account menu. The `strings` keys are the same; `dataFlow` now reads "Flow" and `issuesAndPrs` "Work" by default, and `signOut` and `poweredBy` are drawn inside the menu.

### The map stage and its layers

| Hook | What it is |
|---|---|
| `stage` | the area the map and the panels sit in |
| `map-canvas`, `label-canvas`, `map-overlay` | the map's canvas, the canvas its labels are drawn on, a canvas stacked over it (the second renderer's) |
| `run-overlay`, `run-mark` | the layer of agent-run marks over the map, one mark |
| `house-under`, `house-plan`, `house-over`, `house-bar` | the House view: the layer under the map, the floor plan, the layer over the map, its bar of floors and people |
| `dock`, `sheet-handle`, `backdrop` | the phone's bottom-sheet dock, a sheet's grab handle, the scrim behind the node panel on a phone |
| `hint`, `loading`, `error` | the hint at the map's corner, the loading line, the load-error box |

### Panels and sheets

| Hook | What it is |
|---|---|
| `node-panel` | the node panel (a slide-over, or a bottom sheet on a phone) |
| `work-panel` | the Work panel: Specs, PRs, Issues, Threads, Runs and Deploys |
| `forge-panel` | **deprecated**: the old name of `work-panel`, kept for one release. It is now on the panel's inner box (its first child), so a rule that sets the panel's position or width must move to `work-panel`; colours and type still apply |
| `proposal-bar` | the open proposal's bar |
| `review-bar`, `whatif` | in the proposal bar: the review part (the status line and the note that opens on Send back: a row under the toolbar, or on a phone under the counts, above Send back and Approve), the what-if editor (behind Edit) |
| `scenario-player` | the scenario player |

### Dialogs

| Hook | What it is |
|---|---|
| `dialog-scrim` | the scrim behind a dialog |
| `confirm-dialog`, `agent-dialog`, `tokens-dialog` | the confirm dialog (land a pull request, start a spec, open a build issue), Start an agent, Review tokens |
| `mockup-dialog` | the mockup window |

Every dialog box ends in `-dialog`, so `[data-corn$="-dialog"]` styles all of them.

### Components

| Hook | What it is |
|---|---|
| `tabs`, `tab` | a row of tabs, one tab |
| `row` | one entry of a list: a spec, pull request, issue, deploy or thread; a layer in the Layers menu; a proposal in the Proposals menu or on the Specs tab; a change in the open proposal; a scenario; a mockup; a review token |
| `run` | an agent run's card (`data-corn-state`) |
| `section` | a section of the node panel |
| `badge` | a badge: the node panel's kind, a cloud kind or role, the "Agent" mark |
| `state-pill` | a state word (`data-corn-state`) |
| `field` | a labelled form field, its control inside |
| `notice`, `message` | a notice in a panel; a status line under a form (`data-corn-state="success"` or `"failure"`) |

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

Only labels a brand would want to voice are keys (about forty). Sentences of help text, status lines and the forge's own errors stay as they are.

<!-- strings:start -->
| Key | Default |
|---|---|
| `layers` | Layers |
| `dataFlow` | Flow |
| `house` | House |
| `proposals` | Proposals |
| `issuesAndPrs` | Work |
| `searchPlaceholder` | Search... |
| `signOut` | Sign out |
| `poweredBy` | powered by cornfield |
| `before` | Before |
| `diff` | Diff |
| `after` | After |
| `closeProposal` | Close |
| `approve` | Approve |
| `sendBack` | Send back |
| `sendBackWithNote` | Send back with this note |
| `reviewNoteLabel` | Note for the drafting agent |
| `reviewNotePlaceholder` | What should change? |
| `tabSpecs` | Specs |
| `tabPulls` | PRs |
| `tabIssues` | Issues |
| `tabThreads` | Threads |
| `tabRuns` | Runs |
| `tabDeploys` | Deploys |
| `newIdea` | New idea |
| `landIt` | Land it |
| `startAgent` | Start an agent |
| `askRunner` | Ask the runner |
| `startAgain` | Start again |
| `stop` | Stop |
| `continueRun` | Continue |
| `reply` | Reply |
| `openRoute` | Open route |
| `startRun` | Start a run |
| `copySpec` | Copy Spec |
| `hintInspect` | Tap node to inspect live spec |
| `hintDrag` | Drag nodes to move • Double-tap to inspect |
| `hintDataFlow` | Data flow: browser → servers → API → tables → services → outside |
| `loading` | Loading topology.json … |
| `errorTitle` | The map could not be loaded |
| `retry` | Retry |
<!-- strings:end -->

The node panel read two more words that are gone: `propsTitle` ("Properties & Attributes") and `detailsTitle` ("Details"). The panel has no such headings any more, so a config that still sets them is refused as an unknown key; remove them. `openRoute` now says "Open route" and is the primary action; `startRun` ("Start a run") is new.

## The old `--hx-*` names

`tokens.css` keeps the old names as aliases for one release, so `scene.js`, `proposal.js` (which writes `--hx-mark-*` on `:root` for the map's own ground) and any plugin CSS keep working: `--hx-indigo: var(--corn-accent-text)`, `--hx-line: var(--corn-line)`, `--hx-mark-added: var(--corn-added)`, and so on. **The aliases go in the next minor release.** Write `--corn-*` in new CSS.
