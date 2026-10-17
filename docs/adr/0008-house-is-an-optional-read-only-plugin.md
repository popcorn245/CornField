# ADR 0008: The house is an optional plugin, read-only from a source

Status: accepted (maintainer, 2026-10-17)

## Decision

The physical side of the map (the House view, floors and rooms, machines and containers, devices, personas as counts, the Cloud band) is open source, generic, and optional. cornfield displays a house; it never edits one. The plan and the devices come from a source plugin: a JSON file in the repo (built in, [plugins/house](../../plugins/house/browser.js)), Home Assistant directly ([roadmap](../roadmap.md)), or a private API through a private plugin. There is no floor-plan editor.

People appear only as persona counts ("Adult · 2 people"), never by name.

## Why

Most repos have no house; the ones that do already keep it somewhere (Home Assistant, an inventory, a tasks app). Reading it is enough to answer "the server restarts: what goes down?". An editor would be a product of its own.

## Costs

A house needs a source to be useful; the JSON file is the cheapest one ([docs/house.md](../house.md)).
