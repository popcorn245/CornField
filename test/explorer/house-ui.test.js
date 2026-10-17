// @vitest-environment happy-dom
/**
 * The House view in the page (PHY-11, spec 0029 section 7), through the page's own markup
 * (explorer/index.html) with the house plugin floor hook and an API-backed live source over a fake `/api/v1/world`:
 * the preset button, the floor plan underlay holding each floor's plan and following the camera with one
 * CSS matrix(), the floor chips, a scenario step's `at` switching the floor, the default plan while the live
 * layer is unavailable, the phone's persona chips and Software toggle, and nothing written to browser storage.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { recordedHouse, testFloorHook } from '../helpers.js';

const floorRenderer = await testFloorHook();

/** The live source as an API-backed repo sets it up: its world route through a proxy path, a token, and where to make one */
const apiSource = (opts = {}) => createLiveSource({ url: '/api/v1/world', tokenHref: '/pipeline', tokenHelp: 'Make one on the server: `api-admin token create <you>` (admins only)', ...opts });
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { state, touchScene } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { setMap, setView } from '../../explorer/view.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { LAYER_DEFS } from '../../explorer/layers.js';
// @ts-expect-error plain JS modules, no declarations
import { initLive, stopLive } from '../../explorer/live.js';
// @ts-expect-error plain JS modules, no declarations
import { initHouse, openHouse, closeHouse } from '../../explorer/house.js';
// @ts-expect-error plain JS modules, no declarations
import { playScenario, stopScenario, getPlayer, tickScenario } from '../../explorer/scenario-ui.js';
// @ts-expect-error plain JS modules, no declarations
import { createLiveSource, TOKEN_KEY, CLOUD_PATH } from '../../plugins/house/browser.js';
// @ts-expect-error plain JS modules, no declarations
import { HOUSE_SCALE } from '../../explorer/house-model.js';

const page = fs.readFileSync(path.resolve(__dirname, '../../explorer/index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page) [1].replace(/<script[\s\S]*?<\/script>/g, '');
const recorded = recordedHouse();

const node = (id        , type        , extra         = {}) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, ...extra });
const base = {
  nodes: [
    node('root', 'root'), node('app-a', 'app'),
    node('persona-adult', 'persona', { label: 'Adult', role: 'adult', groups: ['family'] }),
    node('persona-child', 'persona', { label: 'Child', role: 'child', groups: ['family'] }),
    node('machine-server-1', 'machine', { label: 'server-1', hostname: 'server-1', file: 'stacks/world.json' }),
    node('stack-app-stack', 'stack', { label: 'app-stack' }),
    node('page-x', 'page'),
  ],
  edges: [{ from: 'root', to: 'app-a' }, { from: 'app-a', to: 'page-x' }, { from: 'root', to: 'persona-adult' }, { from: 'root', to: 'persona-child' }, { from: 'root', to: 'machine-server-1' }],
};

const $ = (id        ) => document.getElementById(id)               ;
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const sceneIds = () => render.getScene().nodes.map((n     ) => n.id);
const plan = () => document.querySelector('.hx-house-plan')               ;

function phone(on         ) {
  vi.stubGlobal('matchMedia', (q        ) => ({ matches: on && q.includes('767px'), addEventListener() {}, removeEventListener() {} }));
  (window       ).matchMedia = (globalThis       ).matchMedia;
}

function mount(answer                                                      , { isPhone = false, floor = floorRenderer, token = 'admin-token' }                                                            = {}) {
  phone(isPhone);
  document.body.innerHTML = body;
  const ctx      = new Proxy({}, { get: (_t, key        ) => (key === 'measureText' ? (t        ) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas      = document.getElementById('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  Object.assign(state, { canvas, ctx, proposal: null, view: 'orbit', selectedNode: null, live: null, house: null, scenario: null });
  for (const l of LAYER_DEFS) state.activeLayers[l.key] = !['stack', 'machine', 'container', 'device', 'house', 'persona'].includes(l.key);
  state.baseNodes = base.nodes.map((n) => ({ ...n }));
  state.baseEdges = base.edges;
  render.resize();
  setMap(state.baseNodes.map((n     ) => ({ ...n })), state.baseEdges);
  const fetchMock = vi.fn(async () => {
    const a = answer();
    if (a === 'network') throw new TypeError('fetch failed');
    return { ok: a.status < 400, status: a.status, json: async () => structuredClone(a.body), blob: async () => new Blob(['png']) };
  });
  const store = { getItem: (k        ) => (k === TOKEN_KEY ? token : null) };
  initLive({ source: apiSource({ fetch: fetchMock, storage: store }), onSelectionGone: () => {} });
  initHouse({ floor });
  return fetchMock;
}

afterEach(() => { stopScenario(); if (state.view === 'house') closeHouse(); stopLive(); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the House preset', () => {
  it('is a toolbar button beside Data flow, pressed while the view is open', async () => {
    mount(() => ({ status: 200, body: recorded }));
    const btn = $('preset-house-btn');
    expect(btn.previousElementSibling .id).toBe('preset-dataflow-btn');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    btn.click();
    await settle();
    expect(state.view).toBe('house');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    btn.click();
    expect(state.view).toBe('orbit');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(plan().parentElement .hidden).toBe(true);
  });

  it('opening it loads the live layer and draws the house, not the rest of the map', async () => {
    const fetchMock = mount(() => ({ status: 200, body: recorded }));
    openHouse();
    await settle();
    // the world once (and the cloud registry's hosts from the hub, CLOUD-11)
    expect((fetchMock.mock.calls                         ).map((c) => c[0]).filter((u) => u !== CLOUD_PATH)).toHaveLength(1);
    expect(sceneIds()).toEqual(expect.arrayContaining(['live-room-kitchen', 'persona-adult', 'stack-app-stack']));
    expect(sceneIds()).not.toContain('page-x');
    expect(sceneIds()).not.toContain('root');
    // rooms carry no label (the plan names them); the bands are lanes
    expect(render.getScene().nodes.find((n     ) => n.id === 'live-room-kitchen').label).toBe('');
    expect(render.getScene().decor.lanes.map((l     ) => l.title.text)).toEqual(expect.arrayContaining(['People', 'Software', 'Unplaced']));
  });
});

describe('the plan under the map', () => {
  it('is the source element holding the plan of every floor, showing the floor in its attribute, inert and under the canvas', async () => {
    mount(() => ({ status: 200, body: recorded }));
    openHouse();
    await settle();
    const map = plan();
    expect(map.tagName.toLowerCase()).toBe('div');
    expect(map.getAttribute('floor')).toBe('main');
    const floors = [...map.querySelectorAll('.floor-map__floor')]                 ;
    expect(floors.map((f) => f.dataset.floor)).toEqual(['main', 'basement']);
    expect(floors.map((f) => f.hidden)).toEqual([false, true]);
    expect(map.querySelector('[data-floor="main"] .hx-plain-room[data-room="kitchen"]')).not.toBeNull();
    const under = map.parentElement               ;
    expect(under.getAttribute('aria-hidden')).toBe('true');
    expect((under       ).inert).toBe(true);
    expect(under.compareDocumentPosition($('graph-canvas')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(map.style.width).toBe(`${800 * HOUSE_SCALE}px`);
  });

  it('follows the camera with one CSS matrix()', async () => {
    mount(() => ({ status: 200, body: recorded }));
    openHouse();
    await settle();
    Object.assign(state.camera, { x: 120, y: -40, zoom: 0.5 });
    touchScene();
    expect(plan().style.transform).toBe('matrix(0.5, 0, 0, 0.5, 120, -40)');
    Object.assign(state.camera, { x: 10, y: 20, zoom: 1.25 });
    touchScene();
    expect(plan().style.transform).toBe('matrix(1.25, 0, 0, 1.25, 10, 20)');
  });

  it('the floor chips switch the floor: the plan, the rooms drawn, the chip pressed', async () => {
    mount(() => ({ status: 200, body: recorded }));
    openHouse();
    await settle();
    const chip = document.querySelector('[data-house="floor"][data-floor="basement"]')               ;
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    chip.click();
    expect(plan().getAttribute('floor')).toBe('basement');
    expect(sceneIds()).toContain('live-room-basement');
    expect(sceneIds()).not.toContain('live-room-kitchen');
    expect((document.querySelector('[data-house="floor"][data-floor="basement"]')               ).getAttribute('aria-pressed')).toBe('true');
    // the server sits in the Basement, from its inventory item
    const machine = state.nodes.find((n     ) => n.id === 'machine-server-1');
    const box = state.nodes.find((n     ) => n.id === 'live-room-basement').box;
    expect(machine.x).toBeGreaterThan(box.x * HOUSE_SCALE);
    expect(machine.x).toBeLessThan((box.x + box.w) * HOUSE_SCALE);
  });

  it('a scenario step whose `at` is on the basement switches to the basement and marks its room on the plan', async () => {
    mount(() => ({ status: 200, body: recorded }));
    openHouse();
    await settle();
    expect(plan().getAttribute('floor')).toBe('main');
    playScenario({ id: 't', title: 'T', steps: [
      { node: 'live-room-kitchen', text: 'in the kitchen' },
      { node: 'machine-server-1', at: 'live-room-basement', text: 'the server, downstairs' },
    ] }, { autoplay: false });
    expect(plan().getAttribute('floor')).toBe('main');
    getPlayer().next();
    tickScenario(performance.now()); // the player's snapshot reaches the page on the frame loop's next tick
    expect(plan().getAttribute('floor')).toBe('basement');
    expect(plan().querySelector('[data-room="basement"]') .getAttribute('aria-current')).toBe('true');
    expect(sceneIds()).toContain('machine-server-1');
  });
});

describe('with the live layer unavailable', () => {
  it('draws the default plan, says so on the chip, and puts every code-derived machine in the tray', async () => {
    mount(() => 'network');
    openHouse();
    await settle();
    expect(state.house.planSource).toBe('default');
    expect([...plan().querySelectorAll('.floor-map__floor')].map((f     ) => f.dataset.floor)).toEqual(['main', 'basement']);
    expect(plan().querySelectorAll('.hx-plain-room').length).toBe(3);
    expect(plan().querySelectorAll('[data-floor="basement"] .hx-plain-room').length).toBe(1);
    expect($('live-chip-text').textContent).toBe('Default plan, live layer unavailable');
    expect(document.querySelector('.hx-house-tag') .textContent).toBe('Default plan');
    expect(state.house.tray.get('machine')).toEqual(['machine-server-1']);
    expect(trayNote()).toBe("Live layer unavailable: the source could not be reached (fetch failed), so machines can't be placed. Refresh in the Live menu to try again.");
    closeHouse();
    expect($('live-chip-text').textContent).toBe('Live layer unavailable: the source could not be reached (fetch failed)');
  });

  const trayNote = () => state.house.lanes.find((l     ) => l.title.text === 'Unplaced').note.text;
  const menuText = () => { ($('live-chip')               ).click(); return $('live-menu').textContent .replace(/\s+/g, ' '); };

  it('no token: the tray and the chip say so plainly, name this address, and point at the Live menu', async () => {
    const fetchMock = mount(() => ({ status: 200, body: recorded }), { token: null });
    openHouse();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.house.tray.get('machine')).toEqual(['machine-server-1']);
    expect(trayNote()).toBe("Live layer off: no token in this browser, so machines can't be placed. Set one in the Live menu.");
    expect($('live-chip-text').textContent).toBe('Default plan, live layer off');
    const menu = menuText();
    expect(menu).toContain("Live layer off: no token in this browser, so machines can't be placed.");
    expect(menu).toContain(`Tokens are saved per address: this is ${window.location.host}.`);
    expect($('live-menu').querySelector('input[type="password"]')).not.toBeNull();
  });

  it('forbidden: not an admin\'s token, or revoked', async () => {
    mount(() => ({ status: 403, body: {} }));
    openHouse();
    await settle();
    expect(trayNote()).toBe("Live layer off: that token is not an admin's (or was revoked), so machines can't be placed. Set another in the Live menu.");
    expect(menuText()).toContain('The source answered 403.');
  });

  it('unavailable: the HTTP status', async () => {
    mount(() => ({ status: 502, body: {} }));
    openHouse();
    await settle();
    expect(trayNote()).toBe("Live layer unavailable: the source answered HTTP 502, so machines can't be placed. Refresh in the Live menu to try again.");
    expect($('live-menu').querySelector('input[type="password"]')).toBeNull();
  });
});

describe('one control for the plan', () => {
  const edit = () => document.querySelector('.hx-house-floors a.hx-house-edit')                            ;

  it('links "Edit layout" to the editor the plugin names, in a new tab, on the floor in view', async () => {
    mount(() => ({ status: 200, body: recorded }));
    openHouse();
    await settle();
    const link = edit() ;
    expect(link.textContent).toBe('Edit layout');
    expect(link.getAttribute('href')).toBe('https://plan.example.test/house?floor=main');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
    (document.querySelector('[data-house="floor"][data-floor="basement"]')               ).click();
    expect(edit() .getAttribute('href')).toBe('https://plan.example.test/house?floor=basement');
  });

  it('is there on the default plan and on a phone too', async () => {
    mount(() => 'network', { isPhone: true });
    openHouse();
    await settle();
    expect(state.house.planSource).toBe('default');
    expect(edit() .getAttribute('href')).toBe('https://plan.example.test/house?floor=main');
  });

  it('is not there when the plugin names no editor', async () => {
    mount(() => ({ status: 200, body: recorded }), { floor: { ...floorRenderer, editUrl: undefined } });
    openHouse();
    await settle();
    expect(document.querySelector('[data-house="floor"]')).not.toBeNull();
    expect(edit()).toBeNull();
  });
});

describe('the phone layout', () => {
  it('folds the people into chips with counts (a tap opens the node sheet) and keeps the software behind its toggle', async () => {
    mount(() => ({ status: 200, body: recorded }), { isPhone: true });
    openHouse();
    await settle();
    const chips = [...document.querySelectorAll('[data-house="person"]')].map((b) => b.textContent);
    expect(chips).toEqual(['Adult · 2', 'Child · 1']);
    expect(sceneIds()).not.toContain('persona-adult');
    expect(sceneIds()).not.toContain('stack-app-stack');
    (document.querySelector('[data-house="person"][data-id="persona-adult"]')               ).click();
    await settle();
    expect(state.selectedNode.id).toBe('persona-adult');
    expect($('spec-drawer').classList.contains('drawer-open')).toBe(true);
    const toggle = document.querySelector('[data-house="software"]')               ;
    toggle.click();
    expect(sceneIds()).toContain('stack-app-stack');
    expect((document.querySelector('[data-house="software"]')               ).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('the Cloud band (spec 0031 section 7, CLOUD-08)', () => {
  const withCloud = () => {
    base.nodes.push(node('ext-cloudflare', 'external', { kind: 'cloud', roles: ['runtime', 'account'], label: 'Cloudflare' }));
    base.edges.push({ from: 'machine-server-1', to: 'ext-cloudflare', kind: 'calls', label: 'resolves' }       );
  };
  const withoutCloud = () => {
    base.nodes = base.nodes.filter((n) => n.id !== 'ext-cloudflare');
    base.edges = base.edges.filter((e     ) => e.to !== 'ext-cloudflare');
  };
  afterEach(withoutCloud);

  it('draws above the plan on a desktop', async () => {
    withCloud();
    mount(() => ({ status: 200, body: recorded }));
    openHouse();
    await settle();
    expect(sceneIds()).toContain('ext-cloudflare');
    expect(render.getScene().decor.lanes.map((l     ) => l.title.text)).toEqual(expect.arrayContaining(['Cloud', 'Runtime']));
    expect(document.querySelector('[data-house="cloud"]')).toBeNull();
  });

  it('a phone keeps it behind a Cloud toggle beside Software; an outage scenario turns it on', async () => {
    withCloud();
    mount(() => ({ status: 200, body: recorded }), { isPhone: true });
    openHouse();
    await settle();
    const toggle = () => document.querySelector('[data-house="cloud"]')               ;
    expect(toggle().previousElementSibling .getAttribute('data-house')).toBe('software');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(sceneIds()).not.toContain('ext-cloudflare');
    toggle().click();
    expect(sceneIds()).toContain('ext-cloudflare');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    toggle().click();
    expect(sceneIds()).not.toContain('ext-cloudflare');
    playScenario({ id: 'o', title: 'Cloudflare is down', down: ['ext-cloudflare'], steps: [{ node: 'ext-cloudflare', text: 'It is down.' }] }, { autoplay: false });
    expect(state.house.cloud).toBe(true);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(sceneIds()).toContain('ext-cloudflare');
    expect(render.getScene().nodes.find((n     ) => n.id === 'ext-cloudflare').labelStrike).toBe(true);
  });
});

describe('nothing stored', () => {
  it('writes nothing to localStorage, sessionStorage or IndexedDB while the House view is open', async () => {
    const writes           = [];
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k        ) => { writes.push(k); });
    const idb = (globalThis       ).indexedDB;
    const open = idb ? vi.spyOn(idb, 'open') : null;
    mount(() => ({ status: 200, body: recorded }));
    openHouse();
    await settle();
    (document.querySelector('[data-house="floor"][data-floor="basement"]')               ).click();
    setView('orbit');
    expect(writes).toEqual([]);
    if (open) expect(open).not.toHaveBeenCalled();
  });
});
