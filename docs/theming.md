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

## Styling hooks: `data-corn`

The tokens above change what the explorer looks like; the hooks let a stylesheet single out a part of it. Every major region and component carries a `data-corn="…"` attribute, so a theme selects `[data-corn="node-panel"]` instead of the internal `hx-*` class names, which are not public and change freely.

- **Public API.** The names below are documented, and **renaming or removing one is a breaking change**: it is listed under "Breaking" in the release notes (the `breaking` label). Adding one is not. [test/explorer/hooks.test.js](../test/explorer/hooks.test.js) fails when this list and the markup disagree, in either direction.
- **Values** are short kebab-case nouns. One element has one `data-corn` value.
- **Two companions** say more about an element: `data-corn-kind` (a button's kind) and `data-corn-state` (a state, mirroring the state classes). Their values are listed after the hooks and are public in the same way.
- **No shadow DOM.** The explorer uses none, so a stylesheet reaches everything with an ordinary selector and there are no `::part()` names.
- **CSS only.** Hooks are for selectors, never for script: a plugin or a theme must not read them to change behaviour.
- **Suffix selectors work.** Every dialog box ends in `-dialog`, so `[data-corn$="-dialog"]` styles all of them; `[data-corn-kind]` selects every button that has a kind, wherever it is.
- A panel is open when it is not `inert` (`[data-corn="node-panel"]:not([inert])`); a hidden one is `[hidden]`.
- The markup is made in `explorer/index.html` and, for lists, rows and panels filled by script, in the explorer's modules. Both carry the same hooks.

`brand`, `brand-logo`, `brand-wordmark` and `powered-by` are put on the page by the brand config ([docs/config.md](config.md)); the others are in the page and the modules as shipped.

### Button kinds: `data-corn-kind`

A button with no kind is the plain one. Put `data-corn-kind` beside its hook.

| Value | What it is |
|---|---|
| `primary` | the accent-filled action: Retry, Play |
| `quiet` | a low-key button: Close, Refresh, Cancel, Reset Layout |
| `danger` | a button that stops or removes: Stop a run, Revoke, Forget token |
| `approve` | a button that commits: Approve, Land it, Open the build issue, Ask the runner |
| `icon` | a button that is only a symbol: ✕, zoom, theme |

### States: `data-corn-state`

The value is the one the state class carries (`hx-forge-state--open`, …), so it is the forge's or the model's own word. A theme should expect others to appear.

| Value | Where |
|---|---|
| `open`, `merged`, `closed`, `draft` | a pull request, issue or thread (`state-pill`) |
| `success`, `failure`, `running`, `queued`, `neutral`, `skipped`, `cancelled` | a deploy, a check, or a run's tone (`state-pill`) |
| `requested`, `claimed`, `working`, `waiting`, `done`, `failed`, `stopped`, `stop-requested`, `quiet` | a run's status (`run`) |
| `added`, `changed`, `removed`, `edit` | a change mark (`mark`, `proposal-section`) |
| `approved`, `unreviewed` | a mockup's review state (`state-pill`); `changed` as above |
| `missing` | a mockup whose file is gone |
| `flight`, `collision` | a run mark on the map (`run-mark`) |
| `free`, `paid`, `unknown`, `off` | a cloud plan (`plan-badge`) |
| `run`, `deploy`, `renew` | when a call breaks (`cloud-when`) |
| `ok`, `bad` | a notice that went well, a message about a problem (`notice`, `message`) |
| `on` | a layer row that is on (`layer-toggle`); `off` as above |
| `current`, `broken` | the open proposal, a proposal that cannot be read (`proposal-item`) |
| `active`, `expired`, `revoked` | a review token (`token-row`) |
| `allowed`, `refused`, `mismatch`, `pending`, `unchecked`, `unavailable` | the scenario verdict (`player-verdict`, `player-check`) |
| `idle`, `stale`, `error` | the live layer (`live`); `ok` and `off` as above |

## The hooks

### Header and its controls

| Hook | What it is |
|---|---|
| `header` | the top bar |
| `header-left` | its left half: the brand, the Layers menu, the view and preset buttons |
| `header-right` | its right half: search, layout, zoom, theme, links |
| `brand` | the title button at the header's left (resets the view) |
| `brand-logo` | the logo image the brand config puts in the header |
| `brand-wordmark` | the wordmark image the brand config puts in the header |
| `powered-by` | the small "powered by cornfield" link |
| `layers-button` | the Layers button |
| `layers-menu` | the Layers dropdown (toggles and legends) |
| `layer-toggles` | the list of layer rows in it |
| `layer-toggle` | one layer row (`data-corn-state="on|off"`) |
| `live-tag` | the "live" tag on a layer row |
| `count` | a number beside a name: a layer's node count |
| `legend` | a legend block in the Layers menu (data flow, cloud, agent runs, proposal marks) |
| `legend-row` | one line of a legend |
| `preset-dataflow` | the Data flow view button |
| `preset-house` | the House view button |
| `proposals` | the wrapper of the Proposals button and menu |
| `proposals-button` | the Proposals button |
| `proposals-menu` | the Proposals dropdown |
| `forge-button` | the Issues & PRs button |
| `forge-lit` | the count of lit nodes on it |
| `tokens-button` | the Review tokens button |
| `live` | the live layer's wrapper (`data-corn-state` mirrors its tone) |
| `live-chip` | the live chip button |
| `live-chip-dot` | the dot in it |
| `live-chip-text` | the text in it |
| `live-menu` | the live layer's dropdown |
| `live-line` | a line of text in the live menu |
| `live-buttons` | the live menu's button row |
| `live-row` | the live menu's lines |
| `live-token` | the live menu's token part |
| `live-token-label` | the token field's label |
| `live-token-row` | the token field and its Save |
| `search` | the desktop search box |
| `search-input` | a search field (desktop and phone) |
| `search-toggle` | the phone's search button |
| `mobile-search` | the phone's search bar |
| `layout-toggle` | the Orbit / Freeform button |
| `layout-reset` | Reset Layout |
| `zoom` | the desktop zoom group |
| `zoom-button` | a zoom, reset or fit button (desktop and phone) |
| `mobile-zoom` | the phone's zoom group |
| `theme-toggle` | the light / dark / system button |
| `theme-picker` | the named-theme menu |
| `links` | the config's links |
| `menu-title` | a heading in a menu |
| `menu-section` | a section of a menu |
| `text-button` | a bare text button in a menu or bar |
| `note` | a note under a heading |

### The map stage

| Hook | What it is |
|---|---|
| `stage` | the area the map and the panels sit in |
| `map-canvas` | the map's canvas |
| `label-canvas` | the transparent canvas the labels are drawn on |
| `map-overlay` | a transparent canvas stacked over the map (the second renderer's) |
| `run-overlay` | the layer of agent-run marks over the map |
| `run-mark` | one run mark (`data-corn-state="flight|collision"`) |
| `run-tag` | the collision tag on a mark |
| `house-under` | the House plan's layer under the map |
| `house-plan` | the floor plan itself |
| `house-over` | the layer over the map: the "+n more" chips |
| `house-bar` | the House bar |
| `house-floors` | its floor buttons |
| `house-people` | its people and software chips |
| `house-chip` | a floor, person, software, cloud or edit chip |
| `house-tag` | a small tag in the bar: "Default plan", "No plan" |
| `house-more` | a "+n more" button on a room |
| `plain-floor` | the plain floor plan SVG |
| `plain-room` | a room in it |
| `dock` | the phone's bottom-sheet dock |
| `sheet-handle` | a bottom sheet's grab handle |
| `hint` | the hint at the map's corner |
| `hint-text` | its words |
| `loading` | the loading line |
| `error` | the load-error box |
| `backdrop` | the scrim behind the node panel on a phone |
| `rubber` | the what-if edit's rubber band |
| `rubber-line` | its line |

### Buttons, tabs and forms

| Hook | What it is |
|---|---|
| `button` | a plain button with no more specific hook; its kind is in `data-corn-kind` |
| `close-button` | a panel's close (✕) button |
| `segmented` | a group of segment buttons |
| `segment-button` | one button of it (Before, Diff, After) |
| `tabs` | a row of tabs |
| `tab` | one tab (`aria-pressed` says which is on) |
| `filters` | a panel's filter bar |
| `field` | a labelled form field |
| `fieldset` | a group of fields |
| `input` | a text or number field |
| `select` | a menu field |
| `textarea` | a multi-line field |
| `toggle` | a checkbox with its label |
| `form` | an inline form or confirm group |
| `form-title` | its title |
| `actions` | a row of buttons under a form |
| `message` | a status line under a form (`data-corn-state="bad"` for a problem) |
| `notice` | a notice in a panel (`data-corn-state="ok"` for good news) |

### Panels: issues and pull requests, agent runs

| Hook | What it is |
|---|---|
| `forge-panel` | the Issues & PRs panel |
| `forge-body` | its scrolling body |
| `forge-head` | its title row |
| `forge-title` | its title |
| `forge-status` | its status line |
| `forge-controls` | its tabs and filters |
| `list` | a list of results |
| `item` | one entry of a list |
| `row` | a result row (a pull request, issue, deploy or thread) |
| `row-title` | its title |
| `labels` | a row's labels |
| `label` | one label |
| `external-link` | the ↗ link to the forge |
| `empty` | an empty list's line |
| `rate` | the rate-limit line |
| `meta` | a line of small meta text |
| `why` | a line saying why |
| `key` | a map key line in a detail |
| `detail` | the selected pull request, deploy or thread |
| `detail-head` | its title row |
| `detail-title` | its title |
| `subheading` | a heading in a detail |
| `check-list` | a pull request's checks |
| `check` | one check |
| `file-list` | a list of files or runs |
| `file` | one entry in it |
| `file-status` | a file's status word |
| `file-deleted` | a file's deleted-lines count |
| `node-link` | a button that shows a node on the map |
| `node-links` | a group of them |
| `lights` | the "Lights …" line on a check |
| `step` | a step of the landing flow |
| `group` | one issue or proposal in the Agents tab |
| `group-title` | its title |
| `agent-line` | the agent-made line |
| `agent-badge` | the "Agent" badge |
| `idea` | the New idea section |
| `release-notes` | the Release notes section |
| `thread-messages` | a thread's messages |
| `thread-message` | one message |
| `thread-body` | its text |
| `runs` | the Agent runs section |
| `runs-title` | its title |
| `runs-totals` | the tokens and cost line |
| `runs-hand` | requests written by hand |
| `runs-list` | the list of runs |
| `run` | one run, a card (`data-corn-state` is its status) |
| `run-head` | its state and what it is about |
| `run-actions` | its buttons |
| `run-timeline` | its timeline |
| `run-collision` | its collision line |
| `run-limits` | its limits and what the runner reported |
| `run-note` | a note in its timeline |
| `run-group` | a profile comparison in the list |
| `run-compare` | the comparison section |
| `run-compare-title` | its title |
| `run-columns` | its runs side by side |

### Panels: the node panel and its sections

| Hook | What it is |
|---|---|
| `node-panel` | the node panel (a slide-over, or a bottom sheet on a phone); open when it is not `inert` |
| `node-body` | its scrolling body |
| `node-head` | its title row |
| `node-title-wrap` | the badge and the title |
| `node-badge` | the node-kind badge |
| `node-title` | its title |
| `node-description` | its description |
| `node-block` | a block of it |
| `node-block-title` | a block's title |
| `node-props` | the properties list |
| `node-meta` | the details list |
| `node-foot` | its footer |
| `node-open` | the Open link |
| `section` | a section of the panel |
| `section-title` | its title |
| `line` | a line with a glyph |
| `name` | a node or file name |
| `code` | a code span |
| `vars` | a list of variable names |
| `var` | one variable name |
| `prop` | a property row |
| `prop-head` | its head |
| `link` | a link |
| `link-button` | a button that looks like a link and selects a node |
| `cloud` | the cloud section |
| `badges` | the cloud badges row |
| `badge` | a badge: a node kind, a cloud kind |
| `plan-badge` | a cloud plan (`data-corn-state="free|paid|unknown|off"`) |
| `plan-note` | its note |
| `cloud-when` | a group of calls by when they break (`data-corn-state="run|deploy|renew"`) |
| `cloud-when-head` | its heading |
| `cloud-fold` | a folded list in it |
| `cloud-breaks` | the "if it's down" text |
| `cloud-browser` | the "(browser)" mark |
| `outage-play` | the button that plays an outage |
| `mockups` | the Mockups section |
| `mockup-list` | its list |
| `mockup-item` | one mockup |
| `mockup-open` | its button |
| `live-photo` | the live inventory photo |
| `live-list` | a live inventory list |
| `proposal-section` | a proposal's mark on a node (`data-corn-state="added|changed|removed|edit"`) |
| `change` | a field change |
| `change-field` | its field name |
| `change-before` | its old value |
| `change-after` | its new value |
| `whatif` | the what-if editor |
| `whatif-panel` | one of its panels |
| `whatif-drawer` | its block in the node panel |
| `whatif-button` | a button in it |
| `whatif-edit` | one edit in its list |
| `whatif-edit-text` | the edit's words |
| `whatif-form` | a form in it |
| `whatif-list` | a list in it |

### Proposals and review

| Hook | What it is |
|---|---|
| `proposal-bar` | the open proposal's bar |
| `proposal-message` | its message line |
| `proposal-head` | its title row |
| `proposal-title` | the proposal's name |
| `proposal-chip` | the counts chip |
| `proposal-summary` | its summary |
| `proposal-errors` | its problems |
| `proposal-changes` | its list of changes |
| `change-row` | one change (a button) |
| `change-what` | its words |
| `mark` | a change mark dot (`data-corn-state="added|changed|removed|edit"`) |
| `proposal-list` | the Proposals menu's list |
| `proposal-item` | one proposal, a card (`data-corn-state="current|broken"`) |
| `proposal-item-title` | its title |
| `proposal-item-summary` | its summary |
| `proposal-item-meta` | its meta line |
| `proposal-item-where` | where it is kept |
| `proposal-item-reviewed` | when it was reviewed |
| `review-bar` | the review bar: the note, Approve and Send back |
| `review-label` | its label |
| `review-note` | its note field |
| `review-actions` | its button row |
| `review-approve` | Approve |
| `review-send-back` | Send back |
| `review-status` | its status |
| `review-message` | its problem line |
| `review-hint` | its hint |

### Scenario player

| Hook | What it is |
|---|---|
| `scenario-list` | the list of scenarios |
| `scenario-item` | one scenario |
| `scenario-player` | the player |
| `player-head` | its title row |
| `player-title` | its title |
| `player-speed` | its speed menu |
| `player-text` | the step text |
| `player-count` | "1 of 4" |
| `player-step` | the step |
| `player-controls` | its buttons |
| `scenario-step-button` | Previous or Next |
| `scenario-toggle` | Play or Pause |
| `player-track` | its progress track |
| `player-fill` | the filled part |
| `player-verdict` | the verdict pill (`data-corn-state="allowed|refused|mismatch|pending|unchecked|unavailable"`) |
| `player-check` | the verdict line |
| `player-check-detail` | its detail |
| `player-as` | the "act as" row |
| `player-as-label` | its label |
| `player-as-menu` | its menu |
| `player-as-summary` | its summary |

### States and review tokens

| Hook | What it is |
|---|---|
| `state-pill` | a state word: a pull request, issue, deploy, check, thread, run or mockup (`data-corn-state`: see below) |
| `token-secret` | the new review token, shown once |
| `token-secret-row` | the token and its Copy |
| `token-list` | the list of review tokens |
| `token-row` | one token (`data-corn-state="active|expired|revoked"`) |
| `token-label` | its label |
| `token-meta` | its status |

### Dialogs

| Hook | What it is |
|---|---|
| `dialog-scrim` | the scrim behind any dialog |
| `confirm-dialog` | the confirm dialog (land a pull request, start a spec, open a build issue) |
| `agent-dialog` | the Start an agent dialog |
| `tokens-dialog` | the Review tokens dialog |
| `mockup-dialog` | the mockup window |
| `dialog-title` | a dialog's title |
| `dialog-body` | its body |
| `dialog-note` | a note in it |
| `dialog-facts` | a list of facts in it |
| `dialog-checks` | a list of checks in it |
| `dialog-label` | a label above a preview |
| `dialog-preview` | a preview box |
| `dialog-actions` | its buttons |
| `mockup-head` | the mockup window's title row |
| `mockup-title` | its title |
| `mockup-close` | its Close button |
| `mockup-stage` | its stage |
| `mockup-frame` | a page mockup's frame |
| `mockup-image` | an image mockup |

## The old `--hx-*` names

`tokens.css` keeps the old names as aliases for one release, so `scene.js`, `proposal.js` (which writes `--hx-mark-*` on `:root` for the map's own ground) and any plugin CSS keep working: `--hx-indigo: var(--corn-accent-text)`, `--hx-line: var(--corn-line)`, `--hx-mark-added: var(--corn-added)`, and so on. **The aliases go in the next minor release.** Write `--corn-*` in new CSS.
