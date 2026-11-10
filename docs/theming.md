# Theming: the `--corn-*` tokens

Every colour, font, font size, radius, border and outline width, shadow and spacing in the explorer's stylesheets is a custom property whose value is written in one file, [explorer/tokens.css](../explorer/tokens.css). `explorer.css` and `house.css` only read them (`var(--corn-…)`), and [test/explorer/tokens.test.js](../test/explorer/tokens.test.js) fails the build on any literal left outside `tokens.css`. A brand restyles the explorer with one stylesheet, loaded after cornfield's, that redefines some of these names. It is CSS only: no script, no fork.

## How a brand stylesheet works

- **Load it after cornfield's stylesheets**, with `theme` in `cornfield.config.js` (below).
- **Set tokens on `:root`.** A token that is made from another one (`--corn-font-display` is `var(--corn-font)`, the `*-soft` tints mix their colour) is worked out on `:root`, so a value set on `body` or a panel does not reach it.
- **Use cornfield's three selectors.** Dark values, and everything both themes share, are on `:root`. Light values are under both `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { … } }` (the system setting, before any script runs) and `:root[data-theme="light"] { … }` (the viewer's choice, which `theme-boot.js` puts on `<html>`). Those two are more specific than `:root`, so a token cornfield sets for light has to be set in your light blocks too, or cornfield's light value wins on the light ground. Repeat the same selectors in your file; as it loads later, yours win.
- **Keep text readable.** Text on `--corn-accent` is `--corn-text-on-accent`; the solid fills of a status or a hue (a pressed data-flow button, a pressed House chip, a sandbox chip) put `--corn-ground` on the hue. [#122](https://github.com/popcorn245/CornField/issues/122) will check a theme's pairs in `validate`; until then, check them against WCAG AA (4.5:1).

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
  --corn-accent-text: #f87171;
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
| `--corn-brand-gradient` | the wordmark's gradient (light) |
| **Status** (only ever means status) | |
| `--corn-ok`, `--corn-warn`, `--corn-bad`, `--corn-info` | a state, as text, a dot or a solid fill (light) |
| `--corn-ok-soft`, `--corn-warn-soft`, `--corn-bad-soft`, `--corn-info-soft` | the same, as a tinted background |
| **Diff** (shared with the map) | |
| `--corn-added`, `--corn-changed`, `--corn-removed`, `--corn-edit` | what a proposal adds, changes, removes, and a what-if edit; the light values are [theme-model.js](../explorer/theme-model.js) `lightColor` of the dark ones, so the legend matches the map (light) |
| `--corn-added-text`, `--corn-edit-text` | added and edit as text: the mark mixed 60% with `--corn-text`, so it reads on either ground |
| **Category hues** (never status) | |
| `--corn-hue-orange`, `--corn-hue-fuchsia`, `--corn-hue-pink`, `--corn-hue-lime` | the data-flow preset, ROM, variables, the House view (light) |
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

## The old `--hx-*` names

`tokens.css` keeps the old names as aliases for one release, so `scene.js`, `proposal.js` (which writes `--hx-mark-*` on `:root` for the map's own ground) and any plugin CSS keep working: `--hx-indigo: var(--corn-accent-text)`, `--hx-line: var(--corn-line)`, `--hx-mark-added: var(--corn-added)`, and so on. **The aliases go in the next minor release.** Write `--corn-*` in new CSS.
