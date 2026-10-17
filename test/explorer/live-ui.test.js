// @vitest-environment happy-dom
/**
 * The live layer in the page (PHY-09, spec 0029 section 4), through the page's own markup
 * (explorer/index.html) with an API-backed house source over a fake `/api/v1/world`: a live layer going on
 * loads it, the live nodes reach the scene, persona labels carry counts, the chip says each state with
 * Refresh, a failure leaves the code map as it was, the panel lists a linked machine's item, and nothing
 * live is ever written to localStorage, sessionStorage or IndexedDB.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { recordedHouse } from '../helpers.js';

/** The live source as an API-backed repo sets it up: its world route through a proxy path, a token, and where to make one */
const apiSource = (opts = {}) => createLiveSource({ url: '/api/v1/world', tokenHref: '/pipeline', tokenHelp: 'Make one on the server: `api-admin token create <you>` (admins only)', ...opts });
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { setMap } from '../../explorer/view.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { toggleLayer, LAYER_DEFS } from '../../explorer/layers.js';
// @ts-expect-error plain JS modules, no declarations
import { initLive, stopLive, refreshLive } from '../../explorer/live.js';
// @ts-expect-error plain JS modules, no declarations
import { selectNode } from '../../explorer/panels.js';
// @ts-expect-error plain JS modules, no declarations
import { createLiveSource, TOKEN_KEY, CLOUD_PATH } from '../../plugins/house/browser.js';

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
  ],
  edges: [{ from: 'root', to: 'app-a' }, { from: 'root', to: 'persona-adult' }, { from: 'root', to: 'persona-child' }, { from: 'root', to: 'machine-server-1' }],
};

const $ = (id        ) => document.getElementById(id)               ;
const click = (el         ) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const sceneIds = () => render.getScene().nodes.map((n     ) => n.id);
const sceneNode = (id        ) => render.getScene().nodes.find((n     ) => n.id === id);


function fakeApi(answer              ) {
  const calls           = [];
  const auth           = []; // the Authorization header of each call, in order
  const fetchMock = vi.fn(async (url        , init      = {}) => {
    // The cloud registry is the hub's file, not the API (CLOUD-11): not counted, and none here
    if (url === CLOUD_PATH) return { ok: false, status: 404, json: async () => ({}), blob: async () => new Blob([]) };
    calls.push(url);
    auth.push(init.headers ? init.headers.Authorization : '');
    const a = answer();
    if (a === 'network') throw new TypeError('fetch failed');
    return { ok: a.status < 400, status: a.status, json: async () => structuredClone(a.body), blob: async () => new Blob(['png']) };
  });
  return { calls, auth, fetchMock };
}

function mount(api                            , token                = 'admin-token', storage          ) {
  document.body.innerHTML = body;
  const ctx      = new Proxy({}, { get: (_t, key        ) => (key === 'measureText' ? (t        ) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas      = document.getElementById('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  state.canvas = canvas;
  state.ctx = ctx;
  state.proposal = null;
  state.view = 'orbit';
  state.selectedNode = null;
  state.live = null;
  for (const l of LAYER_DEFS) state.activeLayers[l.key] = !['stack', 'machine', 'container', 'device', 'house', 'persona'].includes(l.key);
  state.baseNodes = base.nodes.map((n) => ({ ...n }));
  state.baseEdges = base.edges;
  render.resize();
  setMap(state.baseNodes.map((n     ) => ({ ...n })), state.baseEdges);
  const store = storage || { getItem: (k        ) => (k === TOKEN_KEY ? token : null) };
  initLive({ source: apiSource({ fetch: api.fetchMock, storage: store }), onSelectionGone: () => {} });
}

afterEach(() => { stopLive(); document.body.innerHTML = ''; vi.restoreAllMocks(); window.localStorage.clear(); window.sessionStorage.clear(); });

describe('turning a live layer on', () => {
  it('fetches nothing while every live layer is off, and the chip stays hidden', async () => {
    const api = fakeApi(() => ({ status: 200, body: recorded }));
    mount(api);
    await settle();
    expect(api.calls).toEqual([]);
    expect($('live-wrap').hidden).toBe(true);
    expect(sceneIds()).not.toContain('persona-adult'); // People starts off
  });

  it('the House layer loads the world: rooms and floors in the scene, flagged live, with their box', async () => {
    const api = fakeApi(() => ({ status: 200, body: recorded }));
    mount(api);
    toggleLayer('house');
    await settle();
    expect(api.calls).toEqual(['/api/v1/world?groups=family']);
    expect(sceneIds()).toEqual(expect.arrayContaining(['live-floor-main', 'live-floor-basement', 'live-room-kitchen']));
    expect(sceneNode('live-room-kitchen')).toMatchObject({ live: true, box: { x: 510, y: 190, w: 137, h: 110 } });
    expect(sceneNode('app-a')).toMatchObject({ live: false, box: null });
    expect(sceneIds()).not.toContain('live-device-nfc-tag-tag-1'); // Devices is still off
    expect($('live-wrap').hidden).toBe(false);
    expect($('live-chip-text').textContent).toMatch(/^Live · \d\d:\d\d$/);
    expect($('live-wrap').dataset.tone).toBe('ok');
  });

  it('People shows the counts on the persona nodes and Other accounts on the chip, never a name', async () => {
    const api = fakeApi(() => ({ status: 200, body: recorded }));
    mount(api);
    toggleLayer('persona');
    await settle();
    expect(sceneNode('persona-adult').label).toBe('Adult · 2 people');
    expect(sceneNode('persona-child').label).toBe('Child · 1 person');
    click($('live-chip'));
    expect($('live-menu').hidden).toBe(false);
    expect($('live-menu').textContent).toContain('Other accounts · 4'); // the admin (no Admin persona here) and three children outside the family
    expect($('live-menu').textContent).toContain('HA areas with no room: Shed');
  });

  it('Devices and People together hang a phone under its persona', async () => {
    const api = fakeApi(() => ({ status: 200, body: recorded }));
    mount(api);
    toggleLayer('persona');
    toggleLayer('device');
    await settle();
    const e = render.getScene().edges.find((x     ) => x.from === 'persona-adult' && x.to === 'live-device-phone-sub-1');
    expect(e).toMatchObject({ kind: 'ownership', live: true });
  });

  it('Machines and House place a linked machine dashed in its room, and the panel lists its item', async () => {
    const api = fakeApi(() => ({ status: 200, body: recorded }));
    mount(api);
    toggleLayer('machine');
    toggleLayer('house');
    await settle();
    expect(render.getScene().edges.find((x     ) => x.from === 'live-room-basement' && x.to === 'machine-server-1')).toMatchObject({ kind: 'usage', live: true });
    await selectNode(state.nodes.find((n     ) => n.id === 'machine-server-1'));
    await settle();
    const panel = $('drawer-live');
    expect(panel.textContent).toContain('The server');
    expect(panel.textContent).toContain('Graphics card');
    expect(panel.textContent).toContain('Server rack');
    expect(api.calls).toContain('/api/v1/files/f-1');
  });
});

describe('the chip\'s failure states', () => {
  it('no token: off, in this browser, at this address, and the code map is as it was', async () => {
    const api = fakeApi(() => ({ status: 200, body: recorded }));
    mount(api, null);
    const before = sceneIds();
    toggleLayer('house');
    await settle();
    expect(api.calls).toEqual([]);
    expect($('live-chip-text').textContent).toBe('Live layer off: no token in this browser');
    click($('live-chip'));
    expect($('live-menu').textContent).toContain(`Tokens are saved per address: this is ${window.location.host}.`);
    // the board is a second way, not the main one: a small link under the field
    expect(($('live-menu').querySelector('a')                     ).getAttribute('href')).toBe('/pipeline');
    expect($('live-menu').textContent).not.toContain('Where to set a token');
    expect(sceneIds()).toEqual(before);
  });

  it('403: the token is not an admin\'s, or was revoked', async () => {
    mount(fakeApi(() => ({ status: 403, body: {} })));
    toggleLayer('house');
    await settle();
    expect($('live-chip-text').textContent).toBe("Live layer off: that token is not an admin's (or was revoked)");
  });

  it('the API stopped: unavailable, red, and Refresh asks again', async () => {
    let up = false;
    const api = fakeApi(() => (up ? { status: 200, body: recorded } : 'network'));
    mount(api);
    toggleLayer('house');
    await settle();
    expect($('live-chip-text').textContent).toBe('Live layer unavailable: the source could not be reached (fetch failed)');
    expect($('live-wrap').dataset.tone).toBe('error');
    expect(sceneIds()).toEqual(['root', 'app-a']); // the code map as it was (Machines and People are off)
    up = true;
    click($('live-chip'));
    click($('live-menu').querySelector('[data-live="refresh"]') );
    await settle();
    expect(api.calls).toHaveLength(2);
    expect($('live-wrap').dataset.tone).toBe('ok');
  });

  it('a failed refresh after a good answer keeps the nodes and says how old they are', async () => {
    let up = true;
    mount(fakeApi(() => (up ? { status: 200, body: recorded } : { status: 502 })));
    toggleLayer('house');
    await settle();
    up = false;
    await refreshLive();
    await settle();
    expect($('live-chip-text').textContent).toBe('Live · as of 1 min ago (the source answered HTTP 502)');
    expect(sceneIds()).toContain('live-room-kitchen');
  });
});

describe('setting the token on the map', () => {
  const field = () => $('live-menu').querySelector('input[data-live="token-input"]')                           ;
  const btn = (name        ) => $('live-menu').querySelector(`[data-live="${name}"]`)                            ;
  const type = (value        ) => { const f = field() ; f.value = value; f.dispatchEvent(new Event('input', { bubbles: true })); };

  it('no token: a password field "Token" with Save and where to make one, and no Forget', async () => {
    mount(fakeApi(() => ({ status: 200, body: recorded })), null, window.localStorage);
    toggleLayer('house');
    await settle();
    click($('live-chip'));
    const f = field() ;
    expect(f.type).toBe('password');
    expect(f.getAttribute('autocomplete')).toBe('off');
    expect(f.value).toBe('');
    expect($('live-menu').querySelector(`label[for="${f.id}"]`) .textContent).toBe('Token');
    expect(btn('token-save') .textContent).toBe('Save');
    expect(btn('token-forget')).toBeNull();
    const help = $('live-menu').querySelector('.hx-live-help') ;
    expect(help.textContent).toBe('Make one on the server: api-admin token create <you> (admins only)');
    expect(help.querySelector('code') .textContent).toBe('api-admin token create <you>');
  });

  it('Save stores it under the board\'s key, loads at once with it as the Bearer, and the field goes', async () => {
    const api = fakeApi(() => ({ status: 200, body: recorded }));
    mount(api, null, window.localStorage);
    toggleLayer('house');
    await settle();
    click($('live-chip'));
    type('  new-admin-token ');
    click(btn('token-save') );
    await settle();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe('new-admin-token');
    expect(api.auth).toEqual(['Bearer new-admin-token']);
    expect($('live-wrap').dataset.tone).toBe('ok');
    expect(field()).toBeNull();
    expect(btn('token-forget')).not.toBeNull(); // one is set now
    expect(document.body.innerHTML).not.toContain('new-admin-token'); // never echoed
    expect(window.location.href).not.toContain('new-admin-token');
  });

  it('Enter in the field saves too, and an empty field saves nothing', async () => {
    const api = fakeApi(() => ({ status: 200, body: recorded }));
    mount(api, null, window.localStorage);
    toggleLayer('house');
    await settle();
    click($('live-chip'));
    click(btn('token-save') );
    await settle();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(api.calls).toEqual([]);
    type('by-enter');
    field() .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    expect(api.auth).toEqual(['Bearer by-enter']);
  });

  it('forbidden: the field again to set another, and Forget clears it and says no token', async () => {
    window.localStorage.setItem(TOKEN_KEY, 'revoked');
    const api = fakeApi(() => ({ status: 401, body: {} }));
    mount(api, null, window.localStorage);
    toggleLayer('house');
    await settle();
    click($('live-chip'));
    expect(field()).not.toBeNull();
    expect($('live-menu').textContent).toContain('The source answered 401.');
    click(btn('token-forget') );
    await settle();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect($('live-chip-text').textContent).toBe('Live layer off: no token in this browser');
    expect(btn('token-forget')).toBeNull();
    expect(api.calls).toHaveLength(1); // the second ask stopped at "no token": nothing sent
  });

  it('Refresh reads the token again: one set elsewhere (the board, in another tab) is used', async () => {
    const api = fakeApi(() => ({ status: 200, body: recorded }));
    mount(api, null, window.localStorage);
    toggleLayer('house');
    await settle();
    expect(api.calls).toEqual([]);
    window.localStorage.setItem(TOKEN_KEY, 'from-the-board');
    click($('live-chip'));
    click(btn('refresh') );
    await settle();
    expect(api.auth).toEqual(['Bearer from-the-board']);
  });

  it('a repaint while typing keeps the field and what is in it', async () => {
    mount(fakeApi(() => ({ status: 200, body: recorded })), null, window.localStorage);
    toggleLayer('house');
    await settle();
    click($('live-chip'));
    const f = field() ;
    type('half-typ');
    await refreshLive(); // the runner asks again (no token still) and repaints the chip
    await settle();
    expect(field()).toBe(f);
    expect(f.value).toBe('half-typ');
  });

  it('writes the token key and nothing else, to no storage but localStorage', async () => {
    // happy-dom's Storage does not go through Storage.prototype, so the source's storage records its writes,
    // and both of the page's storages are read back whole
    const writes              = [];
    const ls = window.localStorage;
    const recordingLocal = {
      getItem: (k        ) => ls.getItem(k),
      setItem: (k        , v        ) => { writes.push(['set', k, v]); ls.setItem(k, v); },
      removeItem: (k        ) => { writes.push(['remove', k]); ls.removeItem(k); },
    }                      ;
    const idb = (globalThis       ).indexedDB;
    const open = idb ? vi.spyOn(idb, 'open') : null;
    const everything = () => JSON.stringify({ local: { ...window.localStorage }, session: { ...window.sessionStorage } });
    mount(fakeApi(() => ({ status: 200, body: recorded })), null, recordingLocal);
    for (const key of ['house', 'device', 'persona', 'machine']) toggleLayer(key);
    await settle();
    click($('live-chip'));
    type('tok');
    click(btn('token-save') );
    await settle();
    expect(everything()).toBe(JSON.stringify({ local: { [TOKEN_KEY]: 'tok' }, session: {} }));
    click(btn('token-forget') );
    await settle();
    expect(writes).toEqual([['set', TOKEN_KEY, 'tok'], ['remove', TOKEN_KEY]]);
    expect(everything()).toBe(JSON.stringify({ local: {}, session: {} }));
    if (open) expect(open).not.toHaveBeenCalled();
  });

  it('logs nothing', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug']         ).map((m) => vi.spyOn(console, m));
    mount(fakeApi(() => ({ status: 403, body: {} })), null, window.localStorage);
    toggleLayer('house');
    await settle();
    click($('live-chip'));
    type('secret-ish');
    click(btn('token-save') );
    await settle();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe('nothing live is stored', () => {
  it('writes nothing to localStorage, sessionStorage or IndexedDB through a load, a refresh and the panel', async () => {
    const local = vi.spyOn(Storage.prototype, 'setItem');
    const idb = (globalThis       ).indexedDB;
    const open = idb ? vi.spyOn(idb, 'open') : null;
    mount(fakeApi(() => ({ status: 200, body: recorded })));
    for (const key of ['house', 'device', 'persona', 'machine']) toggleLayer(key);
    await settle();
    await refreshLive();
    await selectNode(state.nodes.find((n     ) => n.id === 'machine-server-1'));
    await settle();
    expect(local).not.toHaveBeenCalled();
    if (open) expect(open).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('Kitchen');
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('Kitchen');
  });
});
