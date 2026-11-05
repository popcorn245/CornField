# Spec 0005: threads, agents and how they plug in (v2)

Status: **being grilled** (maintainer and PM, from 2026-11-05). Each answer lands here as it is given; nothing is built until this is approved on the map.

Issues: [#14 PIPE-01 Alignment threads](https://github.com/popcorn245/CornField/issues/14), [#19 PIPE-06 Launching agents](https://github.com/popcorn245/CornField/issues/19).

## The rule everything answers to

> The developer owns the stack. cornfield is a visual layer on top of their stuff: it shows, and it orchestrates changes to their coding system. It does not become the system.

A test for every decision below: *could the developer delete cornfield tomorrow and lose nothing but the view?*

## Decisions

*(empty: filled in as questions are answered)*

## Open questions

The tree, roughly in the order each answer unlocks the next:

1. **Where an agent runs, and what "launch" means for cornfield.**
2. What an agent run is, as cornfield sees it (identity, lifecycle, what it leaves).
3. How a run is stopped, limited and paid for.
4. Whose credentials an agent uses.
5. What a thread is, and where its messages live.
6. Who writes in a thread (people, agents, the chat bridge), and how.
7. How a thread connects to issues, nodes, proposals and runs.
8. Models: where `models: { provider, baseUrl, model }` belongs, if anywhere.
9. What cornfield shows of a run while it is going.
10. The safe-actions line (ADR 0006) for v2.
