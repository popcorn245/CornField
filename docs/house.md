# The house

The House view draws the physical side of a repo: each floor's rooms, the machines and devices in them, the people (as persona counts, never names) beside the plan, the software around it, and the Cloud band above the street. It is optional, and read-only: cornfield displays a house; the plan and the devices come from a source.

## The quickest source: a JSON file in the repo

```js
// cornfield.config.js
export default {
  sources: { house: { use: 'house', options: { file: 'cornfield.house.json' } } },
};
```

The server reads the file and serves it at `/cornfield/house.json` (its modification time is the answer's `at` unless the file has one). The format (version 1), every part optional:

```json
{
  "version": 1,
  "house": {
    "viewBox": { "width": 800, "height": 600 },
    "floors": [{ "id": "ground", "name": "Ground floor", "level": 0 }],
    "rooms": [{ "id": "kitchen", "floor_id": "ground", "name": "Kitchen", "x": 480, "y": 40, "w": 280, "h": 300 }]
  },
  "accounts": [{ "role": "adult", "groups": ["family"], "count": 2 }],
  "phones": [{ "id": "p1", "platform": "apple", "role": "adult", "groups": ["family"] }],
  "nfc_tags": [{ "id": "t1", "room_id": "kitchen", "needs_rewrite": false }],
  "home_assistant": { "status": "ok", "note": null, "unmatched_areas": [],
    "devices": [{ "id": "d1", "name": "Kitchen light", "room_id": "kitchen", "area": "Kitchen", "entities": 3, "manufacturer": null, "model": null }] },
  "hardware": [{ "kind": "machine", "link": "server-1", "item": { "id": "i1", "name": "The server", "room_id": "kitchen", "image": null },
    "contents": [], "contents_total": 0, "sets": [] }],
  "unlinked": { "hosts": [], "cameras": [], "note": null }
}
```

- `accounts` are counts by role and group; the explorer matches them to `topology.personas.json`. Never a name, an id or a username.
- `hardware` places a machine node of the map (`machine-<link>`) or a camera (`device-camera-<link>`) in a room.
- A Home Assistant device with `service: true` and a `host` is software: it is placed on the container that serves that host, or on the cloud node that claims it, never in a room.

The test fixture [test/fixtures/sample/cornfield.house.json](../test/fixtures/sample/cornfield.house.json) is a complete example.

## Your own API

A source module of your repo can fetch the same answer from your API, through a same-origin `proxy` path, with an admin token kept in the browser:

```js
// tools/cornfield/live.js
import { createLiveSource, createFloorRenderer } from '/plugins/house/browser.js';
export function create(options) {
  return {
    liveSource: createLiveSource({ url: options.url, needsToken: true, tokenHelp: 'Make one with `my-api token create`' }),
    floorRenderer: createFloorRenderer(),
  };
}
```

## Home Assistant directly

On the [roadmap](roadmap.md#home-assistant-as-a-house-source).
