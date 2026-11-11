# Spec 0009: a project defines its own layers, and finer kinds show

Status: **approved** (maintainer, in chat, 2026-11-11: "Approve all 5 go"), so it skips the map review gate ([ADR 0010](../adr/0010-cornfield-uses-its-own-gate.md)). Every open question is answered as recommended. **Built** (all five steps; spec 0008 owns search reading the kind). Its proposal was deleted when it was built (`git log` keeps it).

Issues: [#150](https://github.com/popcorn245/CornField/issues/150) (F27), [#175](https://github.com/popcorn245/CornField/issues/175) (F26), from the 0.34 design review.

The maintainer, on #150: *"We should allow the project to define the layers, we have our starting set, but we allow them to add whatever layers they want."*

What the review found on a map of 922 nodes:

- **Layers are fixed.** The 20 rows of the Layers menu are a hard-coded array keyed by node type, with three special cases. `cornfield.config.js` has no `layers` key and refuses one. A project cannot add a layer such as "timers and schedules", "pages the household uses" or "everything in one stack".
- **Finer kinds are invisible.** The 58 services carry a `kind` (21 job, 16 client, 8 dispatch, 7 hook, 2 webhook, 2 timer, 1 effects, 1 scheduler). The map, the legend, the badge and search ignore it: it shows in one panel row, which wraps mid-word. Cloud and Public web, split by kind, share one grey (ΔE2000 0).

## The rule it answers to

> Generic logic in cornfield, a repo's facts in its config and plugins. ([ADR 0009](../adr/0009-generic-here-facts-in-config.md))

A layer that names a project's kinds or fields is a fact about that repo, so it lives in its config, as data. cornfield holds only the matcher. **A config value never becomes script**: no functions, no regular expressions, no templates.

## Decisions

### D1. The config shape: `add`, `off`, `order`

```js
layers: {
  add: [{ key, label, desc?, match }],  // project layers, at most 24
  off: ['key', …],                      // layers (starting or project) that start off
  order: ['key', …],                    // the order of the rows; the rest follow as usual
}
```

- **`key`:** lower-case words joined by `-`, at most 32 characters, unique, and not a starting layer's key (`app`, `page`, `service`, `cloud` …) or a reserved one (`flow`, `house`, `runs`).
- **`label`:** plain text, one line, at most 40 characters. **`desc`:** at most 120; it is the row's title.
- **No colour, no icon, no `on`.** Colour and icons are the theme's (D6), where the contrast check sees them; whether a layer starts off is `off`, one place for both kinds of layer.
- **Starting layers become entries of the same shape** (`{ key: 'service', label: 'Services', match: { type: 'service' } }`, `{ key: 'cloud', match: { type: 'external', kind: 'cloud' } }`), so there is one code path. Batch B gives Core and Stores their own rows first, which removes the last two special cases.
- **Rejected:** the reviewer's `hide` (a layer with nodes and no row hides part of the map with no way back; `off` covers the need, and empty rows already go); an `on` per layer beside `off` (two ways to say one thing); a colour in the config (it would skip the theme's contrast check).

### D2. What `match` may say, and how matches combine

| Key | Value | A node meets it when |
|---|---|---|
| `type` | a node type, or a list | its `type` is one of them |
| `kind` | text, or a list | its finer `kind` is one of them |
| `parent` | a node id, or a list | its direct parent (the ownership line) is one of them |
| `field` | `{ name: value or [values] }`, at most 4 names | for every name, the node's field equals one of the values (a field holding a list: holds one of them) |

- **Within a key, any; across keys, all.** `{ type: 'service', kind: ['timer', 'scheduler'] }` is a service whose kind is timer or scheduler.
- **Values** are text, a number, `true` or `false`, compared exactly. A list holds at most 20. A node without the field does not match.
- **`field` names** a node field other than `type`, `kind` and `parent` (they have their own keys): letters, digits and `_`, starting with a letter.
- **Rejected:** `not`, `or` across keys and nested matches (a small language a reader must evaluate in their head; two layers do the same); a descendant match "anywhere under" (a walk per node, and a hub's children are already its direct ones); regular expressions and wildcards (a config value must stay data, and `kind: ['timer', 'scheduler']` is as short).

### D3. A node is in exactly one layer: the first project layer that takes it

- A node belongs to **the first project layer in `add` whose match it meets**; a node no project layer takes stays in its starting layer. So the counts add up to the map, and turning a layer off hides exactly the nodes its row counts.
- A project layer **takes** its nodes from their starting layer: with the Timers layer of example 1 (D7), Services counts 34, not 58.
- A node is drawn when its layer is on. The root is always drawn. **While a proposal is open, every node it touches is drawn**, and its row says "+1 shown by the proposal", so a review never hides its own change.
- **Rejected:** a node in every layer it matches, drawn when all are on (the reviewer's proposal: "None, then Timers" shows nothing, since the timers are in Services too) or when any is on (turning Services off leaves timers lit and the count lies).

### D4. Validation: refused by name, with what would be right

`cornfield validate` and the server's config load refuse, each on its own line:

```
layers.add[0].key "service" is a starting layer: pick another key.
layers.add[1].key "Edge Stack": lower-case words joined by "-", like "edge-stack".
layers.add[1].match is empty: say at least one of type, kind, parent, field.
layers.add[2].match.type "servce" is not a node type (root, app, page, pkg, core, …).
layers.add[2].match.field.audience: a value is text, a number, true or false, or a list of them.
layers.add[3] has unknown key "color": known: key, label, desc, match. Colours are the theme's.
layers.off "tokens" is not a layer (app, pkg, page, …, timers).
layers.add has 25 layers: at most 24.
```

`validate`, which reads the map too, **warns** without failing: a project layer that matches no node, and one whose every node an earlier layer took.

### D5. Finer kinds show on the map, in the legend, the panel and search

- **The map:** a node with a `kind` shows it in its core, where spec 0008 puts the type's glyph, as **one or two letters**: the shortest start of the kind's name that no other kind of that type on the map shares (`job` j, `hook` h, `webhook` w, `timer` t, `scheduler` s). It is drawn once the node is at least 14 px across. A theme icon for the kind replaces it (D6).
- **The legend:** a type's row with kinds has a disclosure, "8 kinds", with a key row per kind: its letter, its name, its count. Key rows are not toggles; a project that wants a toggle declares a layer (D7, example 1).
- **The panel:** the badge says "Service · timer", and the Kind row goes (batch B fixes its wrap).
- **Search** reads the kind (spec 0008).
- **Kinds cornfield has never heard of** are the normal case: every service kind above is a project's own word. They get all of the above and no colour of their own unless a theme gives one. A kind is never an error.
- **Rejected:** a built-in glyph per kind name (cornfield would carry one project's words); a ring per kind (rings are the halos and the diff marks); a colour per kind by default (eight greens nobody can tell apart).

### D6. The theme contract: tokens, icons and the contrast check

- **Tokens:** `--corn-map-kind-<type>-<kind>` fills a finer kind (`--corn-map-kind-service-timer`); `--corn-map-group-<key>` fills a project layer, as it already fills a starting one. Types never hold a `-`, so the name reads one way.
- **Which wins, most specific first:** the kind, the project layer, the type (`--corn-map-node-<type>`), the starting layer (`--corn-map-group-<starting key>`), then `auto`. A theme that names none of them leaves every node its type's colour.
- **Icons:** `theme.icons` keys may be `"<type>"` (today), `"<type>:<kind>"` or `"layer:<key>"`, in the same order of precedence. With no icon, a node shows its kind's letters, else its type's glyph.
- **The contrast check:** batch E's map check ([#196](https://github.com/popcorn245/CornField/issues/196)) resolves every `--corn-map-kind-*` and project `--corn-map-group-*` the theme sets against the ground, light and dark, at 3:1. `validate` also warns about a kind token for a kind not on the map, and a group token or icon for a layer not in the config: a typo would otherwise do nothing.
- **Hooks:** `layers-all`, `layers-none`, `layer-kinds` (the disclosure), `kind-key` (a key row), `overlays`. **`strings`:** `layersAll` ("All"), `layersNone` ("None"), `overlays` ("Overlays").

### D7. Three worked examples

```js
// 1. Finer kinds of one type, in a layer that starts off
layers: {
  add: [{ key: 'timers', label: 'Timers and schedules', desc: 'What runs on a clock',
          match: { type: 'service', kind: ['timer', 'scheduler', 'job'] } }],
  off: ['timers'],
}
// 2. By a field's value
layers: {
  add: [{ key: 'household', label: 'Household pages',
          match: { type: 'page', field: { audience: 'household' } } }],
  order: ['app', 'household', 'page'],
}
// 3. Several types as one layer; Tables and Stores are left empty, so their rows go
layers: {
  add: [{ key: 'data', label: 'Data', desc: 'Stores and tables',
          match: { type: ['store', 'table'] } }],
}
```

In example 1, Services counts 58 − 24 = 34 and Timers and schedules 24, off until a viewer turns it on.

### D8. The Layers menu, its counts, All and None, and what is kept

- **The chip** counts layers, on and in all: "Layers · 15 of 22". Overlays (Runs in flight) and rows with no nodes are not counted.
- **The order:** `order` first, then project layers in `add` order, then starting layers in their usual order. Overlays follow under their own heading, then the Key (spec 0008), collapsed.
- **All / None** sit at the top and switch every layer, never an overlay. The root stays drawn.
- **Off by default** means off for a viewer who has not touched that layer. A viewer's own changes are kept in their browser (only the changes), so a layer added to the config later arrives with its default.
- **Links do not carry layers.** A review link still shows its change (D3). (Open question 3.)
- **At 390** the menu spans the screen, at most 70% of its height, with All / None held at the top while the rows scroll.

## Sketches

The Layers menu at 1440, with example 1, Services' kinds open (Services, Cloud and Public web are the reviewed map's counts; the rest are made up):

```
+ Layers . 15 of 22 --------------- [ All ] [ None ] +
|  o Apps                                     48  v  |
|  o Pages & routes                          610  v  |
|  o Services                                 34  v  |
|      v 5 kinds                                     |
|        c  client                             16    |
|        d  dispatch                            8    |
|        e  effects                             1    |
|        h  hook                                7    |
|        w  webhook                             2    |
|  o Timers and schedules                     24  -  |   <- off by default (config)
|  o Tables                                   41  v  |
|  # Cloud                                    45  v  |
|  # Public web                                1  v  |
|  ...                                               |
| Overlays                                           |
|  o Runs in flight                            2  v  |
| > Key: lines, ends, marks                          |
+----------------------------------------------------+
```

At 390 the menu spans the screen; the node panel's badge carries the kind:

```
+------------------------------------+      +------------------------------------+
| Layers . 15 of 22   [All] [None] x |      | (t)  nightly-report            x   |
+------------------------------------+      | Service . timer                    |
|  o Apps                       48 v |      | Runs on an interval: builds the    |
|  o Pages & routes            610 v |      | nightly report.                    |
|  o Services                   34 v |      | Calls 2 . Reads 1 . Owns 0         |
|      > 5 kinds                     |      | [ Open file ]  [ Start a run ]     |
|  o Timers and schedules       24 - |      +------------------------------------+
|  ...  (scrolls; All / None stay)   |
+------------------------------------+
```

## Open questions for the maintainer

**Answered 2026-11-11:** the maintainer took every recommendation below.

1. **One layer per node, the first project layer that takes it** (D3), rather than a node in several layers? Recommendation: **yes**.
2. **No colour in the config**: a project layer's colour comes from the theme (`--corn-map-group-<key>`), else its nodes keep their type's colour? Recommendation: **yes**.
3. **Should a link carry which layers are on** (`?layers=`)? Recommendation: **no**; a review link always shows its change, and the viewer's own choice is kept.
4. **Kind key rows in the legend are a key, not toggles**; a toggle per kind is a declared layer? Recommendation: **yes**.
5. **Letters for kinds by default**, a theme icon to replace them? Recommendation: **yes**.

## What gets built, in order

1. **The matcher and the checks** (`core/layers.js`, pure; `core/config.js` accepts `layers`): D1, D2, D4, with tests for each message.
2. **One code path:** the starting layers as entries; membership (D3) in `scene.js` `isNodeVisible`; the proposal's nodes always drawn.
3. **The menu** (`layers.js`): project rows, the order, the chip's count, All / None, overlays, the viewer's changes kept, the 390 layout.
4. **Finer kinds:** the badge, the letters in the core, the legend's key rows.
5. **The theme contract** (`map-style.js`, `core/theme.js`): the kind and project-layer tokens and their precedence, icon keys, the contrast check and the typo warnings; `docs/theming.md` and `docs/config.md`.

## What is not in this spec

- Renaming or regrouping a starting layer (`strings` can change a label later if it is asked for).
- Layers in the data-flow and House views, which draw their own sets.
- The missing Core and Stores rows, mixed counts and the overlay counted as a layer ([#206](https://github.com/popcorn245/CornField/issues/206)), and the Kind row's wrap ([#207](https://github.com/popcorn245/CornField/issues/207)): batch B, before this.
- Labels, search, selection, edge styles and type shapes: [spec 0008](0008-reading-a-big-map.md).
