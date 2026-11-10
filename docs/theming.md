# Theming: the `--corn-*` tokens

Every colour, font, font size, radius, border width and shadow in the explorer's stylesheets is a custom property whose value is written in one file, [explorer/tokens.css](../explorer/tokens.css). `explorer.css` and `house.css` only read them (`var(--corn-…)`), and [test/explorer/tokens.test.js](../test/explorer/tokens.test.js) fails the build on any literal left outside `tokens.css`. A brand re-skins the explorer by loading a stylesheet after `tokens.css` that redefines some of these names; nothing else needs to change.

Dark values are on `:root`. Light values are under both `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { … } }` (the system setting, before any script) and `:root[data-theme="light"] { … }` (the page's own choice, set by `theme-boot.js` and `theme.js`). A theme-neutral token (a size, a font, the accent fill) is defined once, on `:root`. Redefine a token in both light selectors if its light value should differ.

A stylesheet of yours goes after `tokens.css` in `index.html`'s head (or is loaded by a plugin) and overrides by name:

```css
:root { --corn-accent: #0a7d4f; --corn-radius: 4px; --corn-blur: 0px; }
```

## The tokens

| Token | What it is |
|---|---|
| **Ground and surfaces** | |
| `--corn-ground` | the page behind everything; also the colour of an input's well |
| `--corn-ground-image` | what the page paints on the ground (a gradient; `none` for flat) |
| `--corn-surface-1` | a panel: the header, menus, the node panel |
| `--corn-surface-2` | a control or a row: a button, a toggle row |
| `--corn-surface-3` | pressed, hovered, disabled |
| `--corn-line` | every border |
| `--corn-line-soft` | a divider, a hover tint |
| `--corn-shadow` | a panel's whole `box-shadow` |
| `--corn-shadow-color` | the colour of any other shadow (a lift, a glow's edge) |
| `--corn-scrim` | the backdrop behind a sheet or a dialog |
| `--corn-blur` | the glass blur amount (a length; a brand may set it to `0px`) |
| **Text** | |
| `--corn-text` | titles and strong text |
| `--corn-text-2` | body and secondary text |
| `--corn-text-3` | labels and meta |
| `--corn-text-on-accent` | text on an accent fill |
| **Accent** | |
| `--corn-accent` | the accent fill (a pressed button, the primary action) |
| `--corn-accent-hover` | the accent's hover |
| `--corn-accent-text` | the accent as text, an icon or a line (lighter than the fill on dark) |
| `--corn-accent-soft` | a tinted background of the accent |
| `--corn-focus` | the focus ring |
| `--corn-brand-gradient` | the wordmark's gradient |
| **Status** (only ever means status) | |
| `--corn-ok`, `--corn-warn`, `--corn-bad`, `--corn-info` | a state, as text or a dot |
| `--corn-ok-soft`, `--corn-warn-soft`, `--corn-bad-soft`, `--corn-info-soft` | the same, as a tinted background |
| **Diff** (shared with the map) | |
| `--corn-added`, `--corn-changed`, `--corn-removed`, `--corn-edit` | what a proposal adds, changes, removes, and a what-if edit |
| **Category hues** (never status) | |
| `--corn-hue-orange`, `--corn-hue-fuchsia`, `--corn-hue-pink`, `--corn-hue-lime` | the data-flow preset, ROM, variables, the House view |
| **Type** | |
| `--corn-font`, `--corn-mono` | the families (the system's; nothing is fetched) |
| `--corn-text-2xs` | 10px, mono code and small meta |
| `--corn-text-xs` | 11px |
| `--corn-text-sm` | 12px |
| `--corn-text-md` | 13px |
| `--corn-text-base` | 14px |
| `--corn-text-lg` | 15px |
| `--corn-text-xl` | 20px |
| `--corn-leading` | 1.45 |
| **Shape** | |
| `--corn-radius-xs` | 3px, a tag |
| `--corn-radius-sm` | 6px |
| `--corn-radius` | 10px |
| `--corn-radius-lg` | 14px, a panel or a sheet |
| `--corn-radius-pill` | 999px |
| `--corn-border` | 1px |
| `--corn-space` | 4px, the spacing unit |
| **Map** | |
| `--corn-map-edge`, `--corn-map-label`, `--corn-map-lit`, `--corn-map-selected`, `--corn-map-collision` | what the picture draws and the panels repeat; the map itself is drawn by `scene.js` from the data, and takes its look from the theme (see [theme-model.js](../explorer/theme-model.js)) |
| **Other** | |
| `--corn-glyph-mix` | how much of a panel glyph's own colour is kept |

`--corn-text-2xs`, `--corn-text-base`, `--corn-radius-xs`, `--corn-ground-image`, `--corn-shadow-color`, `--corn-brand-gradient`, `--corn-accent-text`, the four `--corn-hue-*` and `--corn-glyph-mix` are the tokens beyond the core set: the stylesheets used a 10px and a 14px size, a 3px radius, a gradient ground, an accent colour lighter than its fill on dark, and four category hues, and keeping them as tokens kept the page looking as it did. `--corn-space` is defined for the next step; the spacing in the stylesheets is not yet written with it.

Where the stylesheets once had a one-off tint, they mix a token: `color-mix(in srgb, var(--corn-added) 14%, transparent)`. Where they had many near-identical greys, they now share the nearest token (the radii 8 and 12px became `--corn-radius-sm` and `--corn-radius`; the font sizes 9 and 10.5px became `--corn-text-2xs`, 16px became `--corn-text-lg`).

## The old `--hx-*` names

`tokens.css` keeps the old names as aliases for one release, so `scene.js`, `proposal.js` (which writes `--hx-mark-*` on `:root` for the map's own ground) and any plugin CSS keep working: `--hx-indigo: var(--corn-accent-text)`, `--hx-line: var(--corn-line)`, `--hx-mark-added: var(--corn-added)`, and so on. **The aliases go in the next minor release.** Write `--corn-*` in new CSS.
