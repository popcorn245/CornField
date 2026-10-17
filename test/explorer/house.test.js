/**
 * @vitest-environment node
 *
 * The House view's layout (spec 0029 section 7, PHY-11): the pure half (explorer/house-model.js) on the
 * recorded house answer laid over a code map, and the house plugin's floor hook (plugins/house `createFloorRenderer`).
 * Devices and linked machines inside their room's box, an unlinked machine in the tray, one floor at a time
 * with the other floor's machines beside the plan, the bands, the "+N" fold, the phone layout, a step's `at`
 * finding its floor, and the default plan while the live layer is unavailable.
 */
import { describe, it, expect } from 'vitest';
import { recordedHouse, testFloorHook } from '../helpers.js';

const floorRenderer = await testFloorHook();
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { worldToLive } from '../../plugins/house/browser.js';
// @ts-expect-error plain JS modules, no declarations
import { mergeLive } from '../../explorer/live-model.js';
import {
  layoutHouse, applyHouseLayout, pickPlan, floorsOf, defaultFloor, roomCells, houseShowsNode, houseEdgeStyle, decorateHouseScene,
  floorOfStep, personaChips, plainFloorSvg, trayNotes, newHouseState, houseEditHref, HOUSE_SCALE, HOUSE_SIZES, ROOM_CELL,
  // @ts-expect-error plain JS modules, no declarations
} from '../../explorer/house-model.js';

const recorded = recordedHouse();
const live = worldToLive(recorded.data);

const n = (id        , type        , extra         = {}) => ({ id, type, label: id, x: 0, y: 0, r: 20, ...extra });
/** The code map as main holds it: personas, machines (one virtual), the camera, stacks with containers, apps, a package */
function codeMap() {
  const nodes        = [
    n('root', 'root'),
    n('persona-admin', 'persona', { label: 'Admin', role: 'admin', groups: ['family'] }),
    n('persona-adult', 'persona', { label: 'Adult', role: 'adult', groups: ['family'] }),
    n('persona-child', 'persona', { label: 'Child', role: 'child', groups: ['family'] }),
    n('persona-guest', 'persona', { label: 'Guest (no account)', account: false }),
    n('machine-server-1', 'machine', { label: 'server-1', hostname: 'server-1' }),
    n('machine-engine-1', 'machine', { label: 'engine-1', hostname: 'engine-1', virtual: true }),
    n('machine-workstation-1', 'machine', { label: 'workstation-1', hostname: 'workstation-1' }),
    n('device-camera-porch_cam', 'device', { kind: 'camera', camera: 'porch_cam', file: 'stacks/camera-stack/cameras.yml', label: 'Camera porch_cam' }),
    n('stack-app-stack', 'stack', { label: 'app-stack' }),
    n('stack-home-stack', 'stack', { label: 'home-stack' }),
    n('container-backend', 'container', { label: 'backend' }),
    n('container-caddy', 'container', { label: 'caddy' }),
    n('container-homeassistant', 'container', { label: 'homeassistant' }),
    n('app-tasks', 'app', { label: 'tasks.example.test' }),
    n('app-ha', 'app', { label: 'ha.example.test' }),
    n('pkg-game-agent', 'pkg', { label: 'game-agent' }),
    n('page-x', 'page'),
    n('table-tasks', 'table'),
  ];
  const edges        = [
    { from: 'stack-app-stack', to: 'container-backend' }, { from: 'stack-app-stack', to: 'container-caddy' },
    { from: 'stack-home-stack', to: 'container-homeassistant' },
    { from: 'stack-app-stack', to: 'machine-engine-1', kind: 'runs-on' },
    { from: 'stack-home-stack', to: 'machine-engine-1', kind: 'runs-on' },
    { from: 'machine-engine-1', to: 'machine-server-1', kind: 'runs-on' },
    { from: 'pkg-game-agent', to: 'machine-workstation-1', kind: 'runs-on' },
    { from: 'app-tasks', to: 'stack-app-stack', kind: 'runs-on' },
    { from: 'app-ha', to: 'stack-home-stack', kind: 'runs-on' },
    { from: 'device-camera-porch_cam', to: 'container-nvr', kind: 'delivers' },
    { from: 'page-x', to: 'table-tasks', kind: 'writes' },
  ];
  return { nodes, edges };
}

function merged() {
  const { nodes, edges } = codeMap();
  return mergeLive(nodes, edges, live);
}

const lay = (opts         = {}) => {
  const m = merged();
  return { m, out: layoutHouse({ nodes: m.nodes, edges: m.edges, plan: live.plan, layers: { app: true, pkg: true }, notes: live.unplaced, ...opts }) };
};
const inside = (p     , box     ) => p.x > box.x && p.x < box.x + box.w && p.y > box.y && p.y < box.y + box.h;
const worldBox = (r     ) => ({ x: r.x * HOUSE_SCALE, y: r.y * HOUSE_SCALE, w: r.w * HOUSE_SCALE, h: r.h * HOUSE_SCALE });
const room = (id        ) => live.plan.rooms.find((r     ) => r.id === id);

describe('the plan and its floors', () => {
  it('orders the floors highest first and starts on level 0', () => {
    expect(floorsOf(live.plan).map((f     ) => f.id)).toEqual(['main', 'basement']);
    expect(defaultFloor(live.plan)).toBe('main');
    expect(defaultFloor(live.plan, 'basement')).toBe('basement');
    expect(defaultFloor(live.plan, 'attic')).toBe('main');
  });

  it('draws the live plan, else the default one, else none', () => {
    const fallback = floorRenderer.defaultPlan();
    expect(pickPlan(live, fallback)).toEqual({ plan: live.plan, source: 'live' });
    expect(pickPlan(null, fallback)).toEqual({ plan: fallback, source: 'default' });
    expect(pickPlan(null, null)).toEqual({ plan: null, source: 'none' });
  });

  it('lays the plan out at twice the floor viewBox', () => {
    const { out } = lay();
    expect(out.plan).toEqual({ x: 0, y: 0, w: 800 * HOUSE_SCALE, h: 600 * HOUSE_SCALE });
  });
});

describe('in their rooms', () => {
  it('puts the kitchen\'s devices and linked camera inside the kitchen\'s box, the room node at its centre without a label', () => {
    const { out } = lay();
    const box = worldBox(room('kitchen'));
    for (const id of ['live-device-home-assistant-ha-1', 'live-device-nfc-tag-tag-1', 'device-camera-porch_cam']) {
      expect(out.shown.has(id), id).toBe(true);
      expect(inside(out.pos.get(id), box), id).toBe(true);
    }
    expect(out.pos.get('live-room-kitchen')).toEqual({ x: box.x + box.w / 2, y: box.y + box.h / 2, r: HOUSE_SIZES.room });
    // a linked camera first, then the rest by kind
    expect(out.pos.get('device-camera-porch_cam') .y).toBeLessThanOrEqual(out.pos.get('live-device-home-assistant-ha-1') .y);
  });

  it('puts the server in the Basement from its inventory item, a size larger, with its engine beside it', () => {
    const { out } = lay({ floor: 'basement' });
    const box = worldBox(room('basement'));
    const machine = out.pos.get('machine-server-1');
    const engine = out.pos.get('machine-engine-1');
    expect(inside(machine, box)).toBe(true);
    expect(inside(engine, box)).toBe(true);
    expect(machine.r).toBeGreaterThan(HOUSE_SIZES.device);
    expect(Math.hypot(engine.x - machine.x, engine.y - machine.y)).toBeLessThanOrEqual(2 * ROOM_CELL.w);
    expect(out.floorOf.get('machine-server-1')).toBe('basement');
    expect(out.floorOf.get('machine-engine-1')).toBe('basement');
  });

  it('shows one floor at a time: the other floor\'s rooms and devices are not drawn, its machines wait beside the plan', () => {
    const main = lay({ floor: 'main' }).out;
    expect(main.shown.has('live-room-basement')).toBe(false);
    expect(main.shown.has('live-room-kitchen')).toBe(true);
    expect(main.elsewhere.get('basement')).toEqual(['machine-server-1', 'machine-engine-1']);
    const machine = main.pos.get('machine-server-1');
    expect(machine.x).toBeGreaterThan(main.plan.x + main.plan.w); // right of the plan, before the software
    const base = lay({ floor: 'basement' }).out;
    expect(base.shown.has('live-room-kitchen')).toBe(false);
    expect(base.shown.has('live-device-home-assistant-ha-1')).toBe(false);
    expect(base.floorOf.get('live-device-home-assistant-ha-1')).toBe('main');
  });

  it('folds what does not fit into a "+N", and an opened room places them all', () => {
    const m = merged();
    const extra = Array.from({ length: 6 }, (_, i) => n(`live-device-nfc-tag-x${i}`, 'device', { kind: 'nfc-tag', live: true }));
    const nodes = [...m.nodes, ...extra];
    const edges = [...m.edges, ...extra.map((d) => ({ from: 'live-room-kitchen', to: d.id }))];
    const kitchen = worldBox(room('kitchen'));
    const cells = roomCells(kitchen).length;
    const closed = layoutHouse({ nodes, edges, plan: live.plan });
    const inKitchen = [...closed.shown].filter((id) => closed.roomOf?.get(id) === 'live-room-kitchen' && id !== 'live-room-kitchen');
    expect(inKitchen.length).toBe(cells - 1);
    expect(closed.more).toEqual([expect.objectContaining({ room: 'live-room-kitchen', count: 9 - (cells - 1) })]);
    const opened = layoutHouse({ nodes, edges, plan: live.plan, open: new Set(['live-room-kitchen']) });
    expect(opened.more).toEqual([]);
    expect([...opened.shown].filter((id) => opened.roomOf.get(id) === 'live-room-kitchen').length).toBe(9);
  });

  it('keeps a room\'s grid clear of its own node at the box centre', () => {
    const box = { x: 0, y: 0, w: 700, h: 500 };
    const cells = roomCells(box);
    expect(cells.length).toBeGreaterThan(1);
    expect(cells.every((c     ) => !(Math.abs(c.x - 350) < 10 && Math.abs(c.y - 250) < 10))).toBe(true);
    expect(roomCells({ x: 0, y: 0, w: 40, h: 40 })).toHaveLength(1);
  });
});

describe('the Unplaced tray', () => {
  it('holds an unlinked machine, a device with no room, and a room with no box, by kind, under the plan, with the line', () => {
    const { out } = lay();
    expect(out.tray.get('machine')).toEqual(['machine-workstation-1']);
    expect(out.tray.get('home-assistant')).toEqual(['live-device-home-assistant-ha-2']);
    expect(out.tray.get('nfc-tag')).toEqual(['live-device-nfc-tag-tag-2']);
    expect(out.tray.get('room')).toEqual(['live-room-office']);
    const below = out.plan.y + out.plan.h;
    for (const id of ['machine-workstation-1', 'live-device-home-assistant-ha-2', 'live-room-office']) expect(out.pos.get(id).y, id).toBeGreaterThan(below);
    const tray = out.lanes.find((l     ) => l.title.text === 'Unplaced');
    expect(tray.note.text).toBe('HA areas with no room: Shed · No inventory item: workstation-1');
    expect(out.lanes.map((l     ) => l.title.text)).toEqual(expect.arrayContaining(['Machines', 'Home Assistant devices', 'NFC tags', 'Rooms with no box']));
  });

  it('with no live answer: the default plan, nothing placed, every machine and the camera in the tray', () => {
    const { nodes, edges } = codeMap();
    const plan = floorRenderer.defaultPlan();
    const out = layoutHouse({ nodes, edges, plan, notes: trayNotes(null) });
    expect(out.floors.map((f     ) => f.name)).toEqual(['Main Floor', 'Basement']);
    expect(out.tray.get('machine')).toEqual(['machine-server-1', 'machine-workstation-1']);
    expect(out.tray.get('camera')).toEqual(['device-camera-porch_cam']);
    expect(out.shown.has('machine-engine-1')).toBe(true); // beside its host, in the tray
    expect(out.lanes[0].note.text).toMatch(/live layer unavailable/i);
  });

  it('the tray says why nothing is placed, in the source\'s words, and where to fix it', () => {
    const noToken = { reason: 'no-token', hint: 'no token in this browser' };
    expect(trayNotes(null, noToken, { settable: true })).toEqual(["Live layer off: no token in this browser, so machines can't be placed. Set one in the Live menu."]);
    expect(trayNotes(null, { reason: 'forbidden', hint: "that token is not an admin's (or was revoked)" }, { settable: true }))
      .toEqual(["Live layer off: that token is not an admin's (or was revoked), so machines can't be placed. Set another in the Live menu."]);
    expect(trayNotes(null, { reason: 'unavailable', status: 502, hint: 'the source answered HTTP 502' }))
      .toEqual(["Live layer unavailable: the source answered HTTP 502, so machines can't be placed. Refresh in the Live menu to try again."]);
    // an answer: its own lines, whatever a later refresh said
    expect(trayNotes({ unplaced: ['No inventory item: x'] }, noToken)).toEqual(['No inventory item: x']);
    const { nodes, edges } = codeMap();
    const out = layoutHouse({ nodes, edges, plan: floorRenderer.defaultPlan(), notes: trayNotes(null, noToken, { settable: true }) });
    expect(out.lanes[0].title.text).toBe('Unplaced');
    expect(out.lanes[0].note.text).toBe("Live layer off: no token in this browser, so machines can't be placed. Set one in the Live menu.");
  });

  it('applyHouseLayout reads the failure off the live snapshot', () => {
    const { nodes, edges } = codeMap();
    const state      = {
      nodes, edges, activeLayers: {}, house: { ...newHouseState(), defaultPlan: floorRenderer.defaultPlan() },
      live: { status: 'failed', answer: null, error: { reason: 'forbidden', hint: 'that token was refused' }, canSetToken: true },
    };
    const out = applyHouseLayout(state);
    expect(out.lanes.find((l     ) => l.title.text === 'Unplaced').note.text).toBe("Live layer off: that token was refused, so machines can't be placed. Set another in the Live menu.");
  });
});

describe('the bands', () => {
  it('people left of the plan with their counts and their phones beside them', () => {
    const { out } = lay();
    for (const id of ['persona-admin', 'persona-adult', 'persona-child', 'persona-guest']) expect(out.pos.get(id).x, id).toBeLessThan(out.plan.x);
    const adult = out.pos.get('persona-adult');
    const phone = out.pos.get('live-device-phone-sub-1');
    expect(phone.y).toBe(adult.y);
    expect(phone.x).toBeLessThan(adult.x);
    expect(out.lanes.some((l     ) => l.title.text === 'People')).toBe(true);
  });

  it('software right of the plan: each stack, its containers beside it, the apps it serves with the Apps layer, and packages on a machine', () => {
    const { out } = lay();
    const right = out.plan.x + out.plan.w;
    for (const id of ['stack-app-stack', 'container-backend', 'container-caddy', 'app-tasks', 'pkg-game-agent']) expect(out.pos.get(id).x, id).toBeGreaterThan(right);
    const stack = out.pos.get('stack-app-stack');
    expect(out.pos.get('container-backend').x).toBeGreaterThan(stack.x);
    expect(out.pos.get('app-tasks').x).toBeGreaterThan(out.pos.get('container-caddy').x);
    // pages and tables are the other views'
    expect(out.shown.has('page-x')).toBe(false);
    expect(out.shown.has('table-tasks')).toBe(false);
    expect(out.shown.has('root')).toBe(false);
    const noApps = lay({ layers: { app: false, pkg: true } }).out;
    expect(noApps.shown.has('app-tasks')).toBe(false);
    expect(noApps.shown.has('container-caddy')).toBe(true);
  });

  it('draws runs-on and delivers as flows and a phone under its persona as a link; leaves out placements and ownership in the house', () => {
    const t = (type        ) => ({ type });
    expect(houseEdgeStyle({ from: 'a', to: 'b', kind: 'runs-on' }, t('stack'), t('machine'))).toBe('flow');
    expect(houseEdgeStyle({ from: 'a', to: 'b', kind: 'delivers' }, t('device'), t('container'))).toBe('flow');
    expect(houseEdgeStyle({ from: 'a', to: 'b' }, t('persona'), t('device'))).toBe('link');
    expect(houseEdgeStyle({ from: 'a', to: 'b' }, t('room'), t('device'))).toBe(null);
    expect(houseEdgeStyle({ from: 'a', to: 'b', dashed: true }, t('room'), t('machine'))).toBe(null);
    expect(houseEdgeStyle({ from: 'a', to: 'b', kind: 'writes' }, t('page'), t('table'))).toBe(null);
  });
});

describe('the phone layout (under 768 px)', () => {
  it('draws no people (they are chips), hides the software until its toggle is on, and fits the plan', () => {
    const { out } = lay({ phone: true });
    expect(out.shown.has('persona-adult')).toBe(false);
    expect(out.shown.has('live-device-phone-sub-1')).toBe(false);
    expect(out.shown.has('stack-app-stack')).toBe(false);
    expect(out.fit.maxX - out.fit.minX).toBeLessThanOrEqual(out.plan.w + 20);
    // the plan's width; room above it for the chips, and what waits below it without narrowing the plan
    expect(out.fit.minY).toBeLessThan(out.plan.y - 200);
    expect(out.fit.maxY).toBeGreaterThan(out.plan.y + out.plan.h);
    expect(out.fit.maxY).toBeLessThanOrEqual(out.plan.y + out.plan.h + 900);
    // the tray and the other floor's machines below the plan
    expect(out.pos.get('machine-workstation-1').y).toBeGreaterThan(out.plan.h);
    expect(out.pos.get('machine-server-1').y).toBeGreaterThan(out.plan.h);
  });

  it('with Software on, lays the stacks out below the plan in one column, below the tray', () => {
    const { out } = lay({ phone: true, software: true });
    const stack = out.pos.get('stack-app-stack');
    const home = out.pos.get('stack-home-stack');
    expect(stack.x).toBe(home.x);
    expect(stack.y).toBeGreaterThan(out.pos.get('machine-workstation-1').y);
    expect(out.pos.get('container-caddy').x).toBeLessThan(out.plan.x + out.plan.w);
  });

  it('makes persona chips with counts only', () => {
    const m = merged();
    expect(personaChips(m.nodes)).toEqual([
      { id: 'persona-admin', text: 'Admin · 1' }, { id: 'persona-adult', text: 'Adult · 2' },
      { id: 'persona-child', text: 'Child · 1' }, { id: 'persona-guest', text: 'Guest (no account)' },
    ]);
  });
});

describe('the state\'s side', () => {
  function houseState(answer      = live, extra         = {}) {
    const { nodes, edges } = answer ? merged() : codeMap();
    const state      = { view: 'house', nodes, edges, activeLayers: { app: true, pkg: true }, live: answer ? { answer } : null, rings: { rings: [1], clusters: [] }, house: { ...newHouseState(), defaultPlan: floorRenderer.defaultPlan(), ...extra } };
    applyHouseLayout(state);
    return state;
  }

  it('writes positions and sizes on the shown nodes, clears the rings, and remembers the floor', () => {
    const state = houseState(live, { floor: 'basement' });
    const machine = state.nodes.find((x     ) => x.id === 'machine-server-1');
    expect(machine.r).toBe(HOUSE_SIZES.machine);
    expect(state.rings.rings).toEqual([]);
    expect(state.house.floor).toBe('basement');
    expect(state.house.planSource).toBe('live');
    expect(houseShowsNode(state, machine)).toBe(true);
    expect(houseShowsNode(state, { id: 'page-x' })).toBe(false);
  });

  it('falls back to the default plan with the live layer unavailable', () => {
    const state = houseState(null);
    expect(state.house.planSource).toBe('default');
    expect(state.house.floor).toBe('main');
    expect(state.house.floors.map((f     ) => f.id)).toEqual(['main', 'basement']);
  });

  it('finds the floor of a step\'s place: a basement step switches to the basement', () => {
    const state = houseState(live, { floor: 'main' });
    expect(floorOfStep(state, { at: 'live-room-basement', node: 'machine-server-1', text: '' })).toBe('basement');
    expect(floorOfStep(state, { node: 'machine-server-1', text: '' })).toBe('basement');
    expect(floorOfStep(state, { at: 'live-floor-main', text: '' })).toBe('main');
    expect(floorOfStep(state, { node: 'page-x', text: '' })).toBe(null);
  });

  it('decorates the scene: the bands as lanes, no rings, rooms without a label, anchors keep theirs', () => {
    const state = houseState();
    const scene      = { nodes: [{ id: 'live-room-kitchen', type: 'room', label: 'Kitchen', labelKeep: true }, { id: 'persona-adult', type: 'persona', label: 'Adult · 2 people', labelKeep: false }], edges: [], decor: { grid: null, rings: [{}], lanes: [] } };
    decorateHouseScene(scene, state);
    expect(scene.decor.rings).toEqual([]);
    expect(scene.decor.lanes).toBe(state.house.lanes);
    expect(scene.nodes[0].label).toBe('');
    expect(scene.nodes[1].labelKeep).toBe(true);
  });
});

describe('the live chip in the House view', () => {
  it('says the default plan is drawn while there is no answer, with the failure in its menu', async () => {
    // @ts-expect-error plain JS modules, no declarations
    const { chipModel } = await import('../../explorer/live-model.js');
    const failed = { status: 'failed', answer: null, error: { reason: 'unavailable' }, lastOkAt: null };
    expect(chipModel(failed, { house: true })).toMatchObject({ tone: 'error', text: 'Default plan, live layer unavailable', lines: ["Live layer unavailable: the live source is not answering, so machines can't be placed."] });
    const noToken = { ...failed, error: { reason: 'no-token', hint: 'no token in this browser', detail: 'Tokens are saved per address: this is a:1.', href: '/pipeline' } };
    expect(chipModel(noToken, { house: true })).toMatchObject({
      tone: 'off', text: 'Default plan, live layer off', lines: ["Live layer off: no token in this browser, so machines can't be placed."],
      note: 'Tokens are saved per address: this is a:1.', href: '/pipeline',
    });
    expect(chipModel(failed, { house: false }).text).toBe('Live layer unavailable: the live source is not answering');
    const ok = { status: 'ok', answer: { at: '2026-10-11T18:00:00.000Z', notes: [] }, error: null, lastOkAt: 1 };
    expect(chipModel(ok, { house: true }).text).toMatch(/^Live · /);
  });
});

describe('the house plugin\'s floor hook', () => {
  it('draws a floor as plain room boxes with their names: one box per room on that floor, nothing to follow', () => {
    const svg = floorRenderer.render(live.plan, 'main');
    expect(floorRenderer.element).toBe('div');
    expect(svg).toContain('data-floor="main"');
    expect(svg).toContain('data-room="kitchen"');
    expect(svg).toContain('>Kitchen<');
    expect(svg).not.toContain('data-room="basement"');
    expect(svg).not.toContain('href');
  });

  it('falls back to the plan it was given, every room boxed; with none given, a small generic house', async () => {
    const plan = floorRenderer.defaultPlan();
    expect(plan.viewBox).toEqual({ width: 800, height: 600 });
    expect(plan.rooms).toHaveLength(3);
    expect(plan.rooms.filter((r) => r.floor_id === 'main')).toHaveLength(2);
    expect(plan.rooms.find((r) => r.id === 'basement')).toEqual({ id: 'basement', floor_id: 'basement', name: 'Basement', x: 40, y: 40, w: 500, h: 400 });
    const { floorRenderer: sample, SAMPLE_PLAN } = await import('../../plugins/house/browser.js');
    expect(sample.defaultPlan().rooms).toHaveLength(SAMPLE_PLAN.rooms.length);
    expect(sample.defaultPlan().floors.map((f) => f.name)).toEqual(['Ground floor', 'Upstairs']);
    expect(sample.defaultPlan().rooms.every((r) => [r.x, r.y, r.w, r.h].every((v) => typeof v === 'number'))).toBe(true);
    expect(sample.editUrl).toBeUndefined();
  });

  it('sends "Edit layout" where the source says the plan is edited, on the floor in view', () => {
    expect(floorRenderer.editUrl('main')).toBe('https://plan.example.test/house?floor=main');
    expect(floorRenderer.editUrl('basement')).toBe('https://plan.example.test/house?floor=basement');
    expect(floorRenderer.editUrl('')).toBe('https://plan.example.test/house');
    expect(houseEditHref(floorRenderer, 'main')).toBe('https://plan.example.test/house?floor=main');
  });

  it('the tool takes the edit link from the hook only: a string or a function, an http(s) URL, else none', () => {
    expect(houseEditHref({ editUrl: 'https://example.test/plan' }, 'main')).toBe('https://example.test/plan');
    expect(houseEditHref({ editUrl: (f        ) => `http://localhost:3000/plan/${f}` }, 'up')).toBe('http://localhost:3000/plan/up');
    expect(houseEditHref({ editUrl: 'javascript:alert(1)' }, 'main')).toBeNull();
    expect(houseEditHref({ editUrl: () => { throw new Error('no'); } }, 'main')).toBeNull();
    expect(houseEditHref({ render: () => '' }, 'main')).toBeNull();
    expect(houseEditHref(null, 'main')).toBeNull();
  });

  it('the tool draws plain boxes when no plugin gives a renderer', () => {
    const svg = plainFloorSvg(live.plan, 'main');
    expect(svg).toContain('data-room="kitchen"');
    expect(svg).toContain('>Kitchen<');
    expect(svg).not.toContain('data-room="office"'); // no box, nothing to draw
  });
});
