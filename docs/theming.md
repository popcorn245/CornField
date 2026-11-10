# Theming: the `--corn-*` tokens

Every colour, font, font size, radius, border and outline width, shadow and spacing in the explorer's stylesheets is a custom property whose value is written in one file, [explorer/tokens.css](../explorer/tokens.css). `explorer.css` and `house.css` only read them (`var(--corn-…)`), and [test/explorer/tokens.test.js](../test/explorer/tokens.test.js) fails the build on any literal left outside `tokens.css`. A brand restyles the explorer with one stylesheet, loaded after cornfield's, that redefines some of these names. It is CSS only: no script, no fork.

## How a brand stylesheet works

- **Load it after cornfield's stylesheets.** `theme.css` in `cornfield.config.js` ([#117](https://github.com/popcorn245/CornField/issues/117)) will serve a repo-local stylesheet after `house.css`. Until then, add a `<link rel="stylesheet">` after `house.css` in `explorer/index.html`.
- **Set tokens on `:root`.** A token that is made from another one (`--corn-font-display` is `var(--corn-font)`, the `*-soft` tints mix their colour) is worked out on `:root`, so a value set on `body` or a panel does not reach it.
- **Use cornfield's three selectors.** Dark values, and everything both themes share, are on `:root`. Light values are under both `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { … } }` (the system setting, before any script runs) and `:root[data-theme="light"] { … }` (the viewer's choice, which `theme-boot.js` puts on `<html>`). Those two are more specific than `:root`, so a token cornfield sets for light has to be set in your light blocks too, or cornfield's light value wins on the light ground. Repeat the same selectors in your file; as it loads later, yours win.
- **Keep text readable.** Text on `--corn-accent` is `--corn-text-on-accent`; the solid fills of a status or a hue (a pressed data-flow button, a pressed House chip, a sandbox chip) put `--corn-ground` on the hue. [#122](https://github.com/popcorn245/CornField/issues/122) will check a theme's pairs in `validate`; until then, check them against WCAG AA (4.5:1).

## A complete brand stylesheet

A square-cornered, retro look: no radius anywhere, hard offset shadows, thick borders, its own fonts, a red accent, in both themes. Load it after cornfield's stylesheets and every panel, button, menu and dialog takes it. [test/explorer/tokens.test.js](../test/explorer/tokens.test.js) checks that every name in it is a token and that the light blocks match.

```css
/* brand.css: an example brand. Every value below is the brand's own; nothing else changes. */
@font-face { font-family: "Example Pixel"; src: url("./fonts/example-pixel.woff2") format("woff2"); font-display: swap; }
@font-face { font-family: "Example Rounded"; src: url("./fonts/example-rounded.woff2") format("woff2"); font-display: swap; }

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

What it does not reach yet: the map itself (the nodes, edges and labels on the canvas) is drawn by `scene.js` from the topology's own colours, and takes `--corn-map-*` tokens in [#120](https://github.com/popcorn245/CornField/issues/120). The dots, rings and run marks are round (`50%`) in any theme, as a node is.

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

## The old `--hx-*` names

`tokens.css` keeps the old names as aliases for one release, so `scene.js`, `proposal.js` (which writes `--hx-mark-*` on `:root` for the map's own ground) and any plugin CSS keep working: `--hx-indigo: var(--corn-accent-text)`, `--hx-line: var(--corn-line)`, `--hx-mark-added: var(--corn-added)`, and so on. **The aliases go in the next minor release.** Write `--corn-*` in new CSS.
