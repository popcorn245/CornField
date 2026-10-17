/**
 * @vitest-environment node
 *
 * The live layer (spec 0029 sections 4 and 9, PHY-09): this repo's adapter over `GET /api/v1/world`
 * (plugins/house/browser.js) run on recorded answers, and the tool's pure half (explorer/live-model.js):
 * the merge (live ids only, no collisions, the code map untouched), persona counts, phones under personas,
 * linked hardware, placement, the chip's words for every state, and the runner's refresh and 10-minute drop.
 * The recorded answer carries PHY-08's `hardware` / `unlinked` shapes (PR ) before that PR merges.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { recordedHouse } from '../helpers.js';

/** The live source as an API-backed repo sets it up: its world route through a proxy path, a token, and where to make one */
const apiSource = (opts = {}) => createLiveSource({ url: '/api/v1/world', tokenHref: '/pipeline', tokenHelp: 'Make one on the server: `api-admin token create <you>` (admins only)', ...opts });
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { worldToLive, createLiveSource, TOKEN_KEY, TOKEN_HELP, HA_CONTAINER_ID } from '../../plugins/house/browser.js';
import {
  mergeLive, placeLiveNodes, chipModel, failureWords, createLiveRunner, liveDetailsHtml, linkedNodeId, layerOf, liveWanted, groupsOf, countLabel,
  LIVE_POLL_MS, LIVE_DROP_MS,
  // @ts-expect-error plain JS modules, no declarations
} from '../../explorer/live-model.js';
// @ts-expect-error plain JS modules, no declarations
import { parseLiveId } from '../../core/schema.js';

const recorded = recordedHouse();
const world = recorded.data;

/** The code-derived map as main holds it after PHY-02 and PHY-03: personas, machines, a camera, the HA container */
function codeMap() {
  const nodes        = [
    { id: 'root', type: 'root', label: 'root', x: 0, y: 0, r: 28 },
    { id: 'persona-admin', type: 'persona', label: 'Admin', role: 'admin', x: 100, y: 0, r: 22 },
    { id: 'persona-adult', type: 'persona', label: 'Adult', role: 'adult', groups: ['family'], x: 120, y: 40, r: 22 },
    { id: 'persona-child', type: 'persona', label: 'Child', role: 'child', groups: ['family'], x: 140, y: 80, r: 22 },
    { id: 'persona-contributor', type: 'persona', label: 'Outside contributor', role: 'adult', groups: [], x: 160, y: 120, r: 22 },
    { id: 'persona-guest', type: 'persona', label: 'Guest (no account)', account: false, x: 180, y: 160, r: 22 },
    { id: 'machine-server-1', type: 'machine', label: 'server-1', hostname: 'server-1', x: -200, y: 0, r: 26 },
    { id: 'machine-engine-1', type: 'machine', label: 'engine-1', hostname: 'engine-1', virtual: true, x: -260, y: 0, r: 26 },
    { id: 'machine-workstation-1', type: 'machine', label: 'workstation-1', hostname: 'workstation-1', x: -300, y: 0, r: 26 },
    { id: 'device-camera-porch_cam', type: 'device', kind: 'camera', camera: 'porch_cam', file: 'stacks/camera-stack/cameras.yml', label: 'Camera porch_cam', x: 0, y: 300, r: 14 },
    { id: HA_CONTAINER_ID, type: 'container', label: 'homeassistant', x: 0, y: -300, r: 12 },
  ];
  const edges        = [{ from: 'root', to: 'persona-admin' }];
  return { nodes, edges };
}

describe('the house adapter on a recorded answer', () => {
  const live = worldToLive(world);
  const ids = live.nodes.map((n     ) => n.id);

  it('makes floors, rooms, phones, tags and HA devices with live ids only', () => {
    expect(ids).toEqual([
      'live-floor-basement', 'live-floor-main',
      'live-room-basement', 'live-room-kitchen', 'live-room-office',
      'live-device-phone-sub-1', 'live-device-phone-sub-2',
      'live-device-nfc-tag-tag-1', 'live-device-nfc-tag-tag-2',
      'live-device-home-assistant-ha-1', 'live-device-home-assistant-ha-2',
    ]);
    for (const n of live.nodes) expect(parseLiveId(n.id), n.id).not.toBeNull();
    expect(live.at).toBe(world.at);
  });

  it('keeps each room\'s box, and none when the room has no box', () => {
    const room = (id        ) => live.nodes.find((n     ) => n.id === `live-room-${id}`);
    expect(room('kitchen').box).toEqual({ x: 510, y: 190, w: 137, h: 110 });
    expect(room('office').box).toBeNull();
  });

  it('hangs rooms under floors, tags and HA devices under rooms, and HA devices deliver to the HA container', () => {
    const has = (from        , to        , kind         ) => live.edges.some((e     ) => e.from === from && e.to === to && (e.kind || undefined) === kind);
    expect(has('root', 'live-floor-main')).toBe(true);
    expect(has('live-floor-main', 'live-room-kitchen')).toBe(true);
    expect(has('live-room-kitchen', 'live-device-nfc-tag-tag-1')).toBe(true);
    expect(live.edges.some((e     ) => e.to === 'live-device-nfc-tag-tag-2')).toBe(false); // stuck nowhere
    expect(has('live-room-kitchen', 'live-device-home-assistant-ha-1')).toBe(true);
    expect(has('live-device-home-assistant-ha-1', HA_CONTAINER_ID, 'delivers')).toBe(true);
  });

  it('labels a device by what it is, never by whose it is', () => {
    const label = (id        ) => live.nodes.find((n     ) => n.id === id).label;
    expect(label('live-device-phone-sub-1')).toBe('Phone · Apple');
    expect(label('live-device-home-assistant-ha-1')).toBe('Kitchen light · 6 entities');
    expect(label('live-device-home-assistant-ha-2')).toBe('Shed sensor · 1 entity');
    expect(live.nodes.find((n     ) => n.id === 'live-device-phone-sub-1').account).toEqual({ role: 'adult', groups: ['family'] });
  });

  it('passes accounts and hardware through, with the room name, and turns the rest into chip lines', () => {
    expect(live.accounts).toEqual(world.accounts);
    expect(live.hardware[0].roomName).toBe('Basement');
    expect(live.hardware[0].contents_total).toBe(5);
    expect(live.notes).toEqual(['HA areas with no room: Shed', '1 machine has no inventory item: workstation-1']);
    expect(live.plan.rooms).toHaveLength(3);
  });

  it('says Home Assistant is off, or what went wrong', () => {
    expect(worldToLive({ ...world, home_assistant: { status: 'off', note: 'x', devices: [], unmatched_areas: [] } }).notes[0]).toBe('Home Assistant off: x');
    expect(worldToLive({ ...world, home_assistant: { status: 'error', note: 'Home Assistant refused the token', devices: [], unmatched_areas: [] } }).notes[0]).toBe('Home Assistant: Home Assistant refused the token');
  });

  it('reads an answer from before PHY-08 (empty hardware, no unlinked note) without trouble', () => {
    const old = worldToLive({ ...world, hardware: [], unlinked: { hosts: [], cameras: [] } });
    expect(old.hardware).toEqual([]);
    expect(old.notes).toEqual(['HA areas with no room: Shed']);
  });
});

describe('the adapter\'s load', () => {
  const okFetch = (status        , body         ) => vi.fn(async () => ({ ok: status < 400, status, json: async () => body, blob: async () => new Blob(['x']) }));
  const storage = (token               ) => ({ getItem: (k        ) => (k === TOKEN_KEY ? token : null) });

  it('asks /api/v1/world for the deciding groups with the board\'s token, no-store', async () => {
    const fetch = okFetch(200, recorded);
    const src = apiSource({ fetch, storage: storage('tok') });
    const answer = await src.load({ groups: ['family'] });
    expect(answer.nodes.length).toBe(11);
    const [url, init] = (fetch.mock.calls[0]         );
    expect(url).toBe('/api/v1/world?groups=family');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.cache).toBe('no-store');
  });

  it('fails as no-token without a token: in this browser, at this address, the board as a second way', async () => {
    const fetch = okFetch(200, recorded);
    const src = apiSource({ fetch, storage: storage(null), host: 'localhost:4455' });
    await expect(src.load({})).rejects.toMatchObject({
      reason: 'no-token', hint: 'no token in this browser', detail: 'Tokens are saved per address: this is localhost:4455.', href: '/pipeline',
    });
    expect(fetch).not.toHaveBeenCalled();
    // no address to name (node, a test): no detail rather than "this is undefined"
    await expect(apiSource({ fetch, storage: storage(null), host: '' }).load({})).rejects.not.toHaveProperty('detail');
  });

  it('fails as forbidden on 401 and 403, and unavailable on 502, a network error or a timeout, each with its reason', async () => {
    await expect(apiSource({ fetch: okFetch(401, {}), storage: storage('t') }).load({})).rejects.toMatchObject({ reason: 'forbidden', hint: "that token is not an admin's (or was revoked)", detail: 'The source answered 401.' });
    await expect(apiSource({ fetch: okFetch(403, {}), storage: storage('t') }).load({})).rejects.toMatchObject({ reason: 'forbidden', hint: "that token is not an admin's (or was revoked)" });
    await expect(apiSource({ fetch: okFetch(502, {}), storage: storage('t') }).load({})).rejects.toMatchObject({ reason: 'unavailable', status: 502, hint: 'the source answered HTTP 502' });
    await expect(apiSource({ fetch: vi.fn(async () => { throw new TypeError('fetch failed'); }), storage: storage('t') }).load({})).rejects.toMatchObject({ reason: 'unavailable', hint: 'the source could not be reached (fetch failed)' });
    const hang = vi.fn((_u        , init     ) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    await expect(apiSource({ fetch: hang, storage: storage('t'), timeoutMs: 5 }).load({})).rejects.toMatchObject({ reason: 'unavailable', message: 'timeout', hint: 'the source did not answer in time (timeout)' });
  });

  describe('its token setting', () => {
    /** A Storage-shaped fake that records every write */
    function recording(initial                         = {}) {
      const data = new Map(Object.entries(initial));
      const writes           = [];
      return {
        writes, data,
        getItem: (k        ) => (data.has(k) ? data.get(k)  : null),
        setItem: (k        , v        ) => { writes.push(`set ${k}`); data.set(k, String(v)); },
        removeItem: (k        ) => { writes.push(`remove ${k}`); data.delete(k); },
      };
    }

    it('names the field and says where a token comes from, the command in backticks', () => {
      const { token } = apiSource({ storage: recording() });
      expect(token.label).toBe('Token');
      expect(token.help).toMatch(/api-admin token create/);
      expect(createLiveSource({ storage: recording() }).token.help).toBe(TOKEN_HELP);
    });

    it('saves under the board\'s key (trimmed), says it has one, and forgets it; nothing else is written', () => {
      const store = recording();
      const { token } = apiSource({ storage: store });
      expect(token.has()).toBe(false);
      expect(token.save('  abc123  ')).toBe(true);
      expect(store.data.get(TOKEN_KEY)).toBe('abc123');
      expect(token.has()).toBe(true);
      token.forget();
      expect(token.has()).toBe(false);
      expect(store.writes).toEqual([`set ${TOKEN_KEY}`, `remove ${TOKEN_KEY}`]);
    });

    it('saves nothing for an empty field, and says so when storage is blocked', () => {
      const store = recording();
      const { token } = apiSource({ storage: store });
      expect(token.save('   ')).toBe(false);
      expect(store.writes).toEqual([]);
      const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
      const b = apiSource({ storage: blocked }).token;
      expect(b.save('x')).toBe(false);
      expect(b.has()).toBe(false);
      expect(() => b.forget()).not.toThrow();
    });

    it('a load after a save sends the saved token: the token is read on every load', async () => {
      const store = recording();
      const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => recorded }));
      const src = apiSource({ fetch, storage: store });
      await expect(src.load({})).rejects.toMatchObject({ reason: 'no-token' });
      src.token.save('fresh');
      await src.load({});
      expect((fetch.mock.calls[0]         )[1].headers.Authorization).toBe('Bearer fresh');
    });
  });

  it('fetches a photo with the token, and only an /api/ one', async () => {
    const fetch = okFetch(200, {});
    const src = apiSource({ fetch, storage: storage('tok') });
    expect(await src.image('https://elsewhere.example/x.png')).toBeNull();
    expect(await src.image('/api/v1/files/f-1')).toBeInstanceOf(Blob);
    expect((fetch.mock.calls[0]         )[1].headers.Authorization).toBe('Bearer tok');
  });
});

describe('merging a live answer into the map', () => {
  const answer = worldToLive(world);

  it('with no answer gives the map back untouched', () => {
    const { nodes, edges } = codeMap();
    const out = mergeLive(nodes, edges, null);
    expect(out.nodes).toBe(nodes);
    expect(out.edges).toBe(edges);
  });

  it('adds the live nodes themed and flagged, and never changes a code node in place', () => {
    const { nodes, edges } = codeMap();
    const before = JSON.stringify(nodes);
    const out = mergeLive(nodes, edges, answer);
    expect(JSON.stringify(nodes)).toBe(before);
    const room = out.nodes.find((n     ) => n.id === 'live-room-kitchen');
    expect(room).toMatchObject({ type: 'room', live: true, color: '#bef264', r: 16 });
    expect(out.nodes.filter((n     ) => n.live)).toHaveLength(11);
    expect(out.edges.slice(0, edges.length)).toEqual(edges);
  });

  it('counts accounts onto the persona nodes, counts only, and keeps the rest as Other accounts', () => {
    const out = mergeLive(codeMap().nodes, [], answer);
    const label = (id        ) => out.nodes.find((n     ) => n.id === id).label;
    expect(label('persona-admin')).toBe('Admin · 1 person');
    expect(label('persona-adult')).toBe('Adult · 2 people');
    expect(label('persona-child')).toBe('Child · 1 person');
    expect(label('persona-contributor')).toBe('Outside contributor · 0 people');
    expect(label('persona-guest')).toBe('Guest (no account)');
    expect(out.other).toBe(3); // three children outside the family match no persona
    expect(out.counts['persona-adult']).toBe(2);
  });

  it('hangs each phone under the persona its account counts toward, and leaves an unmatched one loose', () => {
    const out = mergeLive(codeMap().nodes, [], answer);
    expect(out.edges.some((e     ) => e.from === 'persona-adult' && e.to === 'live-device-phone-sub-1' && !e.kind)).toBe(true);
    expect(out.edges.some((e     ) => e.to === 'live-device-phone-sub-2')).toBe(false);
  });

  it('refuses a node without a live id, one already on the map, and an edge that joins no live node', () => {
    const bad = { ...answer, nodes: [...answer.nodes, { id: 'room-x', type: 'room', label: 'x' }, { id: 'live-room-kitchen', type: 'room', label: 'again' }], edges: [...answer.edges, { from: 'root', to: 'persona-admin' }] };
    const { nodes, edges } = codeMap();
    const out = mergeLive(nodes, edges, bad);
    expect(out.rejected).toEqual(['room-x: not a live id', 'live-room-kitchen: already on the map', 'root -> persona-admin: joins no live node']);
    expect(out.nodes.filter((n     ) => n.id === 'live-room-kitchen')).toHaveLength(1);
  });

  it('leaves out an edge to a node the map does not have (no HA container before PHY-03)', () => {
    const { nodes } = codeMap();
    const out = mergeLive(nodes.filter((n) => n.id !== HA_CONTAINER_ID), [], answer);
    expect(out.edges.some((e     ) => e.kind === 'delivers')).toBe(false);
  });

  it('links hardware to the machine by hostname and the camera by name, placed dashed in its room', () => {
    const out = mergeLive(codeMap().nodes, [], answer);
    expect([...out.linked.keys()]).toEqual(['machine-server-1', 'device-camera-porch_cam']);
    expect(out.edges.find((e     ) => e.to === 'machine-server-1')).toMatchObject({ from: 'live-room-basement', dashed: true, live: true });
    expect(out.edges.find((e     ) => e.to === 'device-camera-porch_cam')).toMatchObject({ from: 'live-room-kitchen', dashed: true });
    expect(linkedNodeId(codeMap().nodes, { kind: 'machine', link: 'nowhere' })).toBeNull();
  });
});

describe('placing the live nodes', () => {
  it('puts the house below the placed map, rooms around their floor, children beside their parent, and moves no code node', () => {
    const { nodes } = codeMap();
    const out = mergeLive(nodes, [], worldToLive(world));
    const codeAt = out.nodes.filter((n     ) => !n.live).map((n     ) => [n.id, n.x, n.y]);
    placeLiveNodes(out.nodes, out.edges);
    expect(out.nodes.filter((n     ) => !n.live).map((n     ) => [n.id, n.x, n.y])).toEqual(codeAt);
    const at = (id        ) => out.nodes.find((n     ) => n.id === id);
    for (const n of out.nodes.filter((x     ) => x.live)) { expect(Number.isFinite(n.x), n.id).toBe(true); expect(Number.isFinite(n.y), n.id).toBe(true); }
    const extent = Math.max(...codeAt.map(([, x, y]     ) => Math.hypot(x, y)));
    expect(at('live-floor-basement').y).toBeGreaterThan(extent);
    expect(at('live-floor-basement').x).toBeLessThan(at('live-floor-main').x); // by level
    const d = (a     , b     ) => Math.hypot(a.x - b.x, a.y - b.y);
    expect(d(at('live-room-kitchen'), at('live-floor-main'))).toBeLessThan(d(at('live-room-kitchen'), at('live-floor-basement')));
    expect(d(at('live-device-nfc-tag-tag-1'), at('live-room-kitchen'))).toBeLessThan(80);
    expect(d(at('live-device-phone-sub-1'), at('persona-adult'))).toBeLessThan(80);
  });

  it('is exact: the same answer places the same way', () => {
    const place = () => { const o = mergeLive(codeMap().nodes, [], worldToLive(world)); placeLiveNodes(o.nodes, o.edges); return o.nodes.map((n     ) => [n.id, n.x, n.y]); };
    expect(place()).toEqual(place());
  });
});

describe('layers and groups', () => {
  it('maps floors and rooms to the House layer and asks for the deciding groups of the personas', () => {
    expect(['floor', 'room', 'device', 'machine', 'persona', 'container'].map(layerOf)).toEqual(['house', 'house', 'device', 'machine', 'persona', 'container']);
    expect(liveWanted({ container: true })).toBe(false);
    expect(liveWanted({ house: true })).toBe(true);
    expect(groupsOf(codeMap().nodes)).toEqual(['family']);
    expect(countLabel({ label: 'Guest', account: false }, 4)).toBe('Guest');
  });
});

describe('the chip', () => {
  const at = Date.parse('2026-10-11T18:00:00.000Z');
  const answer = { at: '2026-10-11T18:00:00.000Z', notes: ["Home Assistant off: no token in the API's env"] };

  it('is hidden until a live layer was turned on, and says it is loading the first time', () => {
    expect(chipModel({ status: 'idle', answer: null, error: null, lastOkAt: null }).hidden).toBe(true);
    expect(chipModel({ status: 'loading', answer: null, error: null, lastOkAt: null }).text).toBe('Live layer: loading…');
  });

  it('loaded: the answer\'s time, the notes and the Other accounts line', () => {
    const chip = chipModel({ status: 'ok', answer, error: null, lastOkAt: at }, { other: 3, now: at });
    expect(chip.tone).toBe('ok');
    expect(chip.text).toMatch(/^Live · \d\d:\d\d$/);
    expect(chip.lines).toEqual(["Home Assistant off: no token in the API's env", 'Other accounts · 3']);
  });

  it('says each failure in the spec\'s words', () => {
    const fail = (error        ) => chipModel({ status: 'failed', answer: null, error, lastOkAt: null });
    expect(fail({ reason: 'no-token', href: '/pipeline' })).toMatchObject({ text: 'Live layer off: no token', href: '/pipeline', tone: 'off' });
    expect(fail({ reason: 'forbidden', status: 403 })).toMatchObject({ text: "Live layer off: the token is not an admin's", tone: 'off', note: 'The source answered 403.' });
    expect(fail({ reason: 'unavailable', status: 502 })).toMatchObject({ text: 'Live layer unavailable: the live source is not answering', tone: 'error' });
  });

  it('says the source\'s own words when it gives them: its hint for why, its detail under it', () => {
    const fail = (error        ) => chipModel({ status: 'failed', answer: null, error, lastOkAt: null });
    expect(fail({ reason: 'no-token', hint: 'no token in this browser', detail: 'Tokens are saved per address: this is a:1.' }))
      .toMatchObject({ text: 'Live layer off: no token in this browser', tone: 'off', note: 'Tokens are saved per address: this is a:1.' });
    expect(fail({ reason: 'forbidden', status: 401, hint: 'that token was refused', detail: 'The source answered 401.' }))
      .toMatchObject({ text: 'Live layer off: that token was refused', note: 'The source answered 401.' });
    // the hint already says the status: no second note repeating it
    expect(fail({ reason: 'unavailable', status: 502, hint: 'the source answered HTTP 502' })).toMatchObject({ text: 'Live layer unavailable: the source answered HTTP 502', tone: 'error', note: null });
    expect(failureWords({ reason: 'unavailable', hint: 'the source did not answer in time (timeout)' }).short).toBe('the source did not answer in time (timeout)');
  });

  it('says what a failure means in the House view: why nothing is placed, and where to fix it', () => {
    expect(failureWords({ reason: 'no-token', hint: 'no token in this browser' }).house).toBe("Live layer off: no token in this browser, so machines can't be placed.");
    expect(failureWords({ reason: 'no-token' }, { settable: true }).fix).toBe('Set one in the Live menu.');
    expect(failureWords({ reason: 'forbidden' }, { settable: true }).fix).toBe('Set another in the Live menu.');
    expect(failureWords({ reason: 'no-token' }).fix).toBe(''); // a source with no token setting: nothing to point at
    expect(failureWords({ reason: 'unavailable' }).fix).toBe('Refresh in the Live menu to try again.');
  });

  it('a failed refresh after a good answer: as of how long ago, and why', () => {
    const chip = chipModel({ status: 'failed', answer, error: { reason: 'unavailable' }, lastOkAt: at }, { now: at + 3 * 60_000 });
    expect(chip).toMatchObject({ tone: 'stale', text: 'Live · as of 3 min ago (the live source is not answering)' });
  });
});

describe('the runner', () => {
  afterEach(() => vi.useRealTimers());

  function rig(load     , { wanted = true, visible = true } = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-11T18:00:00.000Z'));
    const flags = { wanted, visible };
    const changes        = [];
    const runner = createLiveRunner({ source: { load }, groups: () => ['family'], wanted: () => flags.wanted, visible: () => flags.visible, onChange: (s     ) => changes.push(s) });
    return { runner, flags, changes };
  }

  it('loads nothing while no live layer is on', async () => {
    const load = vi.fn(async () => ({ at: 'x', nodes: [] }));
    const { runner } = rig(load, { wanted: false });
    runner.sync();
    await vi.advanceTimersByTimeAsync(5 * LIVE_POLL_MS);
    expect(load).not.toHaveBeenCalled();
  });

  it('loads when a live layer goes on, then every 60 s while the tab is visible, with the deciding groups', async () => {
    const load = vi.fn(async () => ({ at: 'x', nodes: [] }));
    const { runner, flags } = rig(load);
    runner.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect((load.mock.calls[0]         )[0].groups).toEqual(['family']);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
    expect(load).toHaveBeenCalledTimes(2);
    flags.visible = false;
    runner.sync();
    await vi.advanceTimersByTimeAsync(5 * LIVE_POLL_MS);
    expect(load).toHaveBeenCalledTimes(2);
    flags.visible = true;
    runner.sync(); // back on the tab, long overdue: at once
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(3);
    expect(runner.snapshot().status).toBe('ok');
    runner.stop();
  });

  it('keeps the last answer through a failed refresh, and drops it 10 minutes after the last good one', async () => {
    let up = true;
    const load = vi.fn(async () => { if (!up) throw Object.assign(new Error('down'), { reason: 'unavailable' }); return { at: 'x', nodes: [] }; });
    const { runner } = rig(load);
    runner.sync();
    await vi.advanceTimersByTimeAsync(0);
    up = false;
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
    expect(runner.snapshot()).toMatchObject({ status: 'failed', error: { reason: 'unavailable' } });
    expect(runner.snapshot().answer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(LIVE_DROP_MS - LIVE_POLL_MS - 1000);
    expect(runner.snapshot().answer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(runner.snapshot().answer).toBeNull();
    runner.stop();
  });

  it('drops an old answer even while nothing refreshes (the layer off, the tab hidden)', async () => {
    const load = vi.fn(async () => ({ at: 'x', nodes: [] }));
    const { runner, flags } = rig(load);
    runner.sync();
    await vi.advanceTimersByTimeAsync(0);
    flags.wanted = false;
    runner.sync();
    await vi.advanceTimersByTimeAsync(LIVE_DROP_MS + 1);
    expect(runner.snapshot().answer).toBeNull();
    runner.stop();
  });

  it('a failed first load is a failure, not data, and Refresh asks again at once', async () => {
    let n = 0;
    const load = vi.fn(async () => { n++; if (n === 1) throw Object.assign(new Error('no'), { reason: 'no-token' }); return { at: 'x', nodes: [] }; });
    const { runner } = rig(load);
    runner.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.snapshot()).toMatchObject({ status: 'failed', answer: null, error: { reason: 'no-token' } });
    await runner.refresh();
    expect(runner.snapshot()).toMatchObject({ status: 'ok', error: null });
    runner.stop();
  });
});

describe('the node panel\'s live section', () => {
  const esc = (s        ) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const answer = worldToLive(world);
  const merged = mergeLive(codeMap().nodes, [], answer);
  const live = { answer, linked: merged.linked };
  const node = (id        ) => merged.nodes.find((n     ) => n.id === id);

  it('lists a linked machine\'s photo slot, room, contents (indented, and how many more) and sets', () => {
    const html = liveDetailsHtml(node('machine-server-1'), live, esc);
    expect(html).toContain('The server');
    expect(html).toContain('data-live-photo="/api/v1/files/f-1"');
    expect(html).toContain('data-id="live-room-basement"');
    expect(html).toContain('Graphics card');
    expect(html).toMatch(/padding-left:14px">Fan/);
    expect(html).toContain('and 3 more');
    expect(html).toContain('Server rack');
  });

  it('says an unlinked machine has no item with its hostname, and a virtual one follows its host', () => {
    expect(liveDetailsHtml(node('machine-workstation-1'), live, esc)).toContain('No inventory item has hostname workstation-1');
    expect(liveDetailsHtml(node('machine-engine-1'), live, esc)).toContain('virtual machine');
  });

  it('gives a persona its count only, and says to turn a live layer on without an answer', () => {
    expect(liveDetailsHtml(node('persona-adult'), live, esc)).toContain('>2</span> accounts');
    expect(liveDetailsHtml(node('persona-adult'), null, esc)).toContain('Turn on a live layer');
  });
});
