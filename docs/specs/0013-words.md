# Spec 0013: Words (a dictionary of the project's own words, as a layer that ties nodes together)

Status: **draft, for alignment on the mock.** The decisions below are what the mock shows; the questions at the end are open. Its proposal is [proposals/0013-words.json](proposals/0013-words.json), with three mockups in [proposals/0013-words/](proposals/0013-words/).

## What the maintainer asked for

> Matt Pocock is doing a lot of the same stuff and this tool should be the place where noobies can do those things. There are 2 concepts that we need to make sure we have a good handle on: grill with docs is kinda there, but he has another one called AI coding dictionary. We need to add a layer of tags that is essentially this. This will allow us to pass tags and then we can use those tags to tie together nodes.

The two ideas, as their sources define them:

- **[grill-with-docs](https://github.com/mattpocock/skills/blob/main/skills/engineering/grill-with-docs/SKILL.md)** is an interview: the agent asks one question at a time until a plan is sharp, and writes down the words it settles on as it goes. Its domain-modeling half keeps a `GLOSSARY.md` (one per area, mapped from a root `GLOSSARY-MAP.md` when there are several): each word in bold, a one or two sentence meaning, and an `_Avoid_:` line of the words not to use in its place. Decisions that are hard to reverse go to `docs/adr/`.
- **[The dictionary of AI coding](https://github.com/mattpocock/dictionary-of-ai-coding)** explains AI coding words in plain English, one file per word with a short `description`, grouped into sections from the model to ways of working.

## What stands in the way today

- **Cornfield has no words of its own for a project.** A node has a name, a kind and a description. Nothing says that `invoices`, `invoice_lines`, `/api/v1/invoices/:id` and `api-billing` are all about one idea, Invoice, unless an edge happens to run between them. Nodes about one idea in different services are not tied at all.
- **The half of grill-with-docs cornfield has is the talking.** Threads (spec 0005) and proposals (the Decide lane) carry the interview and its decisions; the words it settles on land in a glossary file cornfield never reads.
- **Newcomers meet cornfield's own words cold.** Run, runner, thread, proposal, handoff: the page uses them and explains none of them.

## Decisions (as mocked)

### D1. A glossary in the repo is where words and their meanings live

- Cornfield reads the glossary grill-with-docs writes, in its format: `GLOSSARY.md` at the root, or per area with a `GLOSSARY-MAP.md`. Each **word** has a name, a one or two sentence meaning, the words to avoid, and its section (the `##` heading it sits under).
- Where the glossary is, is a setting with that default (`words.glossary` in `cornfield.config.js`), read like every other path: inside the repo, never run.
- A repo without a glossary has no Words layer and nothing changes.

### D2. Nodes carry words, and words tie nodes together

- A node gains an optional `words` list of word ids (`"words": ["invoice"]`), checked by `validate` against the glossary: an unknown word is reported, as an unknown kind is today.
- A deriver may fill `words` in. Cornfield itself only suggests: a node whose name holds a word, or a word to avoid, is listed as a suggestion and is not tagged until someone accepts it.
- A host can pass words in, as it passes a selection: `<corn-map words="invoice payment">`, and `#words=invoice,payment` in the link (the same address rules as spec 0011).

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
- Two actions, both safe in the sense of [ADR 0006](../adr/0006-safe-actions-only.md), both writing nothing in the repo themselves: **Tag it <word> instead** opens a proposal that changes this node's words; **Ask an agent to grill this word** starts a thread with the word and the node mentioned, so the interview of grill-with-docs runs where threads already run.

Mockup: [node-panel-words.svg](proposals/0013-words/node-panel-words.svg).

### D6. The AI coding shelf: cornfield's own words, in plain English

- A second shelf of words that explain cornfield and AI coding to a newcomer (Agent, Context window, Run, Runner, Thread, Proposal, Handoff, Grilling, Spec), each with a meaning and where you meet it in cornfield. Written for cornfield in our own words, and shipped with it.
- The page marks these words where it uses them (a dotted underline on Work, Run, Thread, …): hovering or focusing one shows its meaning.
- These words explain; they never tag nodes.

Mockup: [ai-coding-shelf.svg](proposals/0013-words/ai-coding-shelf.svg).

## Questions for the maintainer

1. **Shelves.** Both, as mocked? Or only the project's words, or only the AI coding words?
2. **Where words live.** The glossary for meanings plus `words` on nodes, as mocked? Or free tags with no meanings, or no tags at all and words matched against names?
3. **Tying.** A pill and dashed ties while a word is picked, as mocked? Or words as nodes of their own, with edges, always drawn?
4. **Keeping words honest.** Cornfield reads and flags, and the writing stays with an agent in a thread or a proposal, as mocked? Or cornfield writes the glossary itself, which would need a new safe action?

## What is not in this spec

- Writing the glossary from the page.
- Decision records (ADRs) as nodes. A later spec could put them beside the words.
- Words in other languages.
