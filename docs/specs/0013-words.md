# Spec 0013: Words (a dictionary of the project's own words, as a layer that ties nodes together)

Status: **approved** (maintainer, in chat, 2026-11-26: "Okay get it right and review and merge it"), so it skips the map review gate ([ADR 0010](../adr/0010-cornfield-uses-its-own-gate.md)). The four questions put with the mock are answered as recommended (below). Its proposal is [proposals/0013-words.json](proposals/0013-words.json), with three mockups in [proposals/0013-words/](proposals/0013-words/).

## What the maintainer asked for

> Matt Pocock is doing a lot of the same stuff and this tool should be the place where noobies can do those things. There are 2 concepts that we need to make sure we have a good handle on: grill with docs is kinda there, but he has another one called AI coding dictionary. We need to add a layer of tags that is essentially this. This will allow us to pass tags and then we can use those tags to tie together nodes.

The two ideas, as their sources define them:

- **[grill-with-docs](https://github.com/mattpocock/skills/blob/main/skills/engineering/grill-with-docs/SKILL.md)** is an interview: the agent asks one question at a time until a plan is sharp, and writes down the words it settles on as it goes. Its domain-modeling half keeps a `GLOSSARY.md` (one per area, mapped from a root `GLOSSARY-MAP.md` when there are several): each word in bold, a one or two sentence meaning, and an `_Avoid_:` line of the words not to use in its place. Decisions that are hard to reverse go to `docs/adr/`.
- **[The dictionary of AI coding](https://github.com/mattpocock/dictionary-of-ai-coding)** explains AI coding words in plain English, one file per word with a short `description`, grouped into sections from the model to ways of working.

## What stands in the way today

- **Cornfield has no words of its own for a project.** A node has a name, a kind and a description. Nothing says that `invoices`, `invoice_lines`, `/api/v1/invoices/:id` and `api-billing` are all about one idea, Invoice, unless an edge happens to run between them. Nodes about one idea in different services are not tied at all.
- **The half of grill-with-docs cornfield has is the talking.** Threads (spec 0005) and proposals (the Decide lane) carry the interview and its decisions; the words it settles on land in a glossary file cornfield never reads.
- **Newcomers meet cornfield's own words cold.** Run, runner, thread, proposal, handoff: the page uses them and explains none of them.

## Decisions

### D1. A glossary in the repo is where words and their meanings live

- Cornfield reads the glossary grill-with-docs writes, in its format: `GLOSSARY.md` at the root, or per area with a `GLOSSARY-MAP.md`. Each **word** has a name, a one or two sentence meaning, the words to avoid, and its section (the `##` heading it sits under).
- Where the glossary is, is a setting with that default (`words.glossary` in `cornfield.config.js`), read like every other path: inside the repo, never run.
- A repo without a glossary has no Words layer and nothing changes.

### D2. Nodes carry words, and words tie nodes together

- A node gains an optional `words` list of word ids (`"words": ["invoice"]`), checked by `validate` against the glossary: an unknown word is reported, as an unknown kind is today.
- A deriver may fill `words` in. Cornfield itself only suggests: a node whose name holds a word, or a word to avoid, is listed as a suggestion and is not tagged until someone accepts it.
- Words can be picked from outside, as a node can: `?words=invoice,payment` in cornfield's address, and a `words` property on the components (spec 0011 D6: what the page takes from the address bar, a component takes as a property). A word the glossary does not hold is ignored, never drawn.

### D3. The Words layer on the Map and Flow views

- A layer **Words**, off by default, shows each node's words as small chips under its name.
- **Picking a word** (from the dictionary, a chip, or a host passing it in) dims all but the nodes that carry it and draws the word as a pill with a dashed tie to each of them. The tie is drawn only while the word is picked; the layout does not move.
- A node whose name uses **a word to avoid** shows that chip in the warning colour, and the dictionary counts them at the top ("1 node uses a word to avoid").
- Colours come from new theme tokens (`--corn-word`, `--corn-word-avoid`), with defaults, so a theme can set them.

Mockup: [words-layer.svg](proposals/0013-words/words-layer.svg).

### D4. The dictionary: the words, as a piece of their own

- A **Dictionary** piece, opened from the layer (where the Work list sits in the Work view): the words by section, each with its meaning, the words to avoid, the nodes tagged with it (each selects its node) and the words related to it. Search finds a word by its name, meaning or a word to avoid.
- It has two shelves: **This project** (D1) and **AI coding** (D6).

### D5. The node panel shows a node's words

- Under its kind and name: each word with its meaning. A word to avoid says so, and names the word to use instead.
- **Start a thread about this word** is [Start a thread about this](../threads.md) with the word filled in: the New idea form opens with the title `The word bill on bills` and the node's `[[node-id]]` and the word in the text, all editable, and nothing is opened until the maintainer presses Open idea. It posts through the same route, so nothing new is allowed ([ADR 0006](../adr/0006-safe-actions-only.md)). The interview of grill-with-docs then runs where threads already run: an agent asked from that thread settles the word and changes the glossary or the node's words in a pull request, as any other change.

Mockup: [node-panel-words.svg](proposals/0013-words/node-panel-words.svg).

### D6. The AI coding shelf: cornfield's own words, in plain English

- A second shelf of words that explain cornfield and AI coding to a newcomer (Agent, Context window, Run, Runner, Thread, Proposal, Handoff, Grilling, Spec), each with a meaning and where you meet it in cornfield. Written for cornfield in our own words, and shipped with it.
- The page marks these words where it uses them (a dotted underline on Work, Run, Thread, …): hovering or focusing one shows its meaning.
- These words explain; they never tag nodes.

Mockup: [ai-coding-shelf.svg](proposals/0013-words/ai-coding-shelf.svg).

## The questions, answered

1. **Shelves:** both. The project's words tag and tie nodes; the AI coding words only explain.
2. **Where words live:** the glossary holds the words and their meanings; nodes carry `words`. Cornfield suggests tags from names and never applies one by itself.
3. **Tying:** a pill and dashed ties while a word is picked. Words are not nodes, and the layout does not move.
4. **Keeping words honest:** cornfield reads and flags. Writing the glossary stays with people and agents, through a thread and a pull request.

## What gets built, in order

Each step is its own pull request and release; cornfield's page keeps working after each.

1. **Reading words** (D1, D2): `core/glossary.js` reads `GLOSSARY.md` and `GLOSSARY-MAP.md`; `words.glossary` in the config; `words` on a node in the schema; `validate` reports an unknown word and lists the suggestions; the words in the page's data; docs.
2. **The Words layer and the dictionary** (D3, D4, D5): the layer, its chips and ties, the theme tokens, the Dictionary piece with the project's shelf, the node panel's words and its thread action, search finding a word, and `?words=` with the components' `words` property.
3. **The AI coding shelf** (D6): its words, written for cornfield, and the dotted words in the page with their meaning on hover and focus.

## What is not in this spec

- Writing the glossary, or a node's words, from the page.
- Decision records (ADRs) as nodes. A later spec could put them beside the words.
- Words in other languages.
