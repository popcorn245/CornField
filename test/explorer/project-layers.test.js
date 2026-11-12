// @vitest-environment happy-dom
/**
 * Project layers in the explorer (spec 0009 steps 2 and 3): one code path for the starting layers and a project's, membership
 * (D3), a proposal's nodes always drawn, and the Layers menu (D8): the rows, their order, the chip's count, All and None, the overlays,
 * the viewer's changes kept, the kinds key. And the case that matters most to a project that never heard of any of this: with no
 * `layers` in the config the map and the menu are exactly what they were.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadSample, explorerPage } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { parseColor, themed } from '../../explorer/theme-model.js';
// @ts-expect-error plain JS modules, no declarations
import { NODE_THEMES } from '../../core/schema.js';
// @ts-expect-error plain JS modules, no declarations
import { buildTopology, EXAMPLE_LAYERS } from '../fixtures/big/make.js';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { isNodeVisible, buildScene } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { LAYER_DEFS, clickWithLegendMenu, renderLayerToggles, setProjectLayers, toggleLayer, toggleAllLayers, toggleLayerKinds } from '../../explorer/layers.js';
// @ts-expect-error plain JS modules, no declarations
import { externalLayer } from '../../explorer/cloud-model.js';
// @ts-expect-error plain JS modules, no declarations
import { layerOf } from '../../explorer/live-model.js';

import { explorerCss } from './stylesheets.js';
const body = /<body>([\s\S]*)<\/body>/.exec(explorerPage())[1].replace(/<script[\s\S]*?<\/script>/g, '');
const $ = (id) => document.getElementById(id);
const rows = () => [...document.querySelectorAll('#layer-toggles-container [data-action="toggle-layer"]')];
const rowKeys = () => rows().map((r) => r.dataset.layer);
const row = (key) => document.querySelector(`[data-action="toggle-layer"][data-layer="${key}"]`);
const countOf = (key) => row(key).querySelector('.hx-count').textContent;
const chip = () => $('layers-count').textContent.trim();

/** The visible rule and the rows as they were before project layers (explorer/scene.js and explorer/layers.js at 0.36): the reference the new code must equal with no `layers` */
const oldVisible = (s, node) => {
  const a = s.activeLayers;
  if (node.type === 'root') return true;
  if (node.type === 'core') return (a.pkg || a.atom) && a.core !== false;
  if (node.type === 'store') return a.flow !== false && a.store !== false;
  if (node.type === 'rom') return a.rom !== false && a.flow !== false;
  if (node.type === 'floor' || node.type === 'room') return a.house !== false;
  if (node.type === 'external') return a[externalLayer(node)] !== false;
  return a[node.type] !== false;
};
const oldRowKey = (n) => (n.type === 'external' ? externalLayer(n) : layerOf(n.type));

const base = () => ({ view: 'orbit', flow: null, proposal: null, proposalView: 'diff', projectLayers: [], layerOrder: [], layerDefaults: {}, edges: [] });
const mk = (nodes, edges = [], extra = {}) => ({ ...base(), nodes, edges, activeLayers: {}, ...extra });
const node = (id, type, extra = {}) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, ...extra });

const sample = loadSample();
const big = buildTopology();

describe('with no layers in the config, nothing changes', () => {
  const maps = { 'the sample map': sample, 'the big map (922 nodes)': big };
  const toggles = [{}, { page: false }, { pkg: false, atom: false }, { flow: false }, { store: false }, { core: false, rom: false }, { cloud: false, web: false }, { service: false, table: false, app: false }];
  for (const [name, map] of Object.entries(maps)) {
    it(`draws the same nodes as before, whichever layers are off (${name})`, () => {
      for (const t of toggles) {
        const s = mk(map.nodes, map.edges, { activeLayers: { stack: false, machine: false, container: false, device: false, house: false, persona: false, ...t } });
        const before = map.nodes.filter((n) => oldVisible(s, n)).map((n) => n.id);
        const now = map.nodes.filter((n) => isNodeVisible(s, n)).map((n) => n.id);
        expect(now, JSON.stringify(t)).toEqual(before);
      }
    });
  }
});

describe('the Layers menu with no layers in the config', () => {
  beforeEach(() => { localStorage.clear(); document.body.innerHTML = body; });
  afterEach(() => { setProjectLayers(undefined); localStorage.clear(); });
  for (const [name, map] of Object.entries({ 'the sample map': sample, 'the big map': big })) {
    it(`has the rows and the counts it had (${name}), the overlay under its own heading`, () => {
      Object.assign(state, { nodes: map.nodes.map((n) => ({ ...n })), edges: map.edges, theme: 'dark', view: 'orbit', runsMap: null, proposal: null });
      setProjectLayers(undefined);
      const counts = {};
      map.nodes.forEach((n) => { const k = oldRowKey(n); if (k !== 'root') counts[k] = (counts[k] || 0) + 1; });
      counts.flow = map.edges.filter((e) => e.kind === 'flow').length;
      const defs = LAYER_DEFS.filter((l) => !l.overlay).map((l) => l.key);
      const extra = Object.keys(counts).filter((k) => !defs.includes(k) && k !== 'flow');
      expect(rowKeys()).toEqual([...defs, ...extra, 'runs']);
      for (const key of defs) expect(countOf(key), key).toBe(key === 'flow' ? `${counts.flow} ${counts.flow === 1 ? 'link' : 'links'}` : String(counts[key] || 0));
      expect(chip()).toBe(`· ${defs.length - 6} of ${defs.length + extra.length}`); // the six that start off (Infra, Machines, Containers, Devices, House, People) are not on
      expect($('layer-toggles-container').querySelector('[data-corn="overlays"]').textContent).toBe('Overlays');
    });
  }
});

describe('D3: a node is in exactly one layer, the first project layer that takes it', () => {
  const timers = { key: 'timers', label: 'Timers', match: { type: 'service', kind: ['timer', 'scheduler'] } };
  const nodes = [node('root', 'root'), node('s1', 'service', { kind: 'timer' }), node('s2', 'service', { kind: 'hook' }), node('s3', 'service', { kind: 'scheduler' }), node('p', 'page')];
  const s = (add, on = {}) => mk(nodes, [], { projectLayers: add, activeLayers: { service: true, page: true, ...on } });

  it('draws a project layer\'s nodes when it is on, and not when it is off; its nodes leave their starting layer', () => {
    expect(nodes.filter((n) => isNodeVisible(s([timers], { timers: true }), n)).map((n) => n.id)).toEqual(['root', 's1', 's2', 's3', 'p']);
    expect(nodes.filter((n) => isNodeVisible(s([timers], { timers: false }), n)).map((n) => n.id)).toEqual(['root', 's2', 'p']);
    // Services off hides only what Services holds: the timers stay, and the row's count is not a lie
    expect(nodes.filter((n) => isNodeVisible(s([timers], { service: false }), n)).map((n) => n.id)).toEqual(['root', 's1', 's3', 'p']);
  });
  it('None, then Timers shows the timers (not nothing)', () => {
    const st = s([timers], { service: false, page: false, timers: true });
    expect(nodes.filter((n) => isNodeVisible(st, n)).map((n) => n.id)).toEqual(['root', 's1', 's3']);
  });
  it('the first project layer wins, and the root is always drawn', () => {
    const first = { key: 'first', label: 'First', match: { type: 'service' } };
    const st = s([first, timers], { first: false, timers: true });
    expect(nodes.filter((n) => isNodeVisible(st, n)).map((n) => n.id)).toEqual(['root', 'p']);
    expect(isNodeVisible(s([{ key: 'all', label: 'All', match: { type: ['root', 'page'] } }], { all: false }), nodes[0])).toBe(true);
  });
  it('a match by parent reads the ownership line, not a call', () => {
    const edges = [{ from: 'root', to: 'hub' }, { from: 'hub', to: 'k1' }, { from: 'x', to: 'k2', kind: 'calls' }];
    const ns = [node('root', 'root'), node('hub', 'app'), node('k1', 'page'), node('k2', 'page')];
    const st = mk(ns, edges, { projectLayers: [{ key: 'kids', label: 'Kids', match: { parent: 'hub' } }], activeLayers: { kids: false } });
    expect(ns.filter((n) => isNodeVisible(st, n)).map((n) => n.id)).toEqual(['root', 'hub', 'k2']);
  });
  it('the scene is drawn from the same rule', () => {
    const st = { ...s([timers], { timers: false }), camera: { x: 0, y: 0, zoom: 1 }, width: 800, height: 600, selectedNode: null, searchQuery: '', isFreeform: false, rings: { rings: [], clusters: [] }, scenario: null, sceneVersion: 1 };
    expect(buildScene(st).nodes.map((n) => n.id)).toEqual(['root', 's2', 'p']);
  });
});

describe('a proposal\'s nodes are always drawn', () => {
  const timers = { key: 'timers', label: 'Timers', match: { type: 'service', kind: 'timer' } };
  const nodes = [node('root', 'root'), node('t-old', 'service', { kind: 'timer' }), node('t-new', 'service', { kind: 'timer', mark: 'added' }), node('pg', 'page', { mark: 'changed' }), node('pg2', 'page'), node('far', 'page')];
  const edges = [{ from: 'pg2', to: 'far', mark: 'added', kind: 'calls' }];
  const st = (extra = {}) => mk(nodes, edges, { projectLayers: [timers], proposal: { name: 'x' }, activeLayers: { timers: false, page: false }, ...extra });

  it('draws a node the proposal marks whatever its layer says, and the ends of a line it marks; not the rest of an off layer', () => {
    const drawn = nodes.filter((n) => isNodeVisible(st(), n)).map((n) => n.id);
    expect(drawn).toEqual(['root', 't-new', 'pg', 'pg2', 'far']);
    expect(drawn).not.toContain('t-old');
  });
  it('is only while the proposal is open', () => {
    expect(nodes.filter((n) => isNodeVisible(st({ proposal: null }), n)).map((n) => n.id)).toEqual(['root']);
  });
  it('Before still hides what is added', () => {
    expect(isNodeVisible(st({ proposalView: 'before' }), nodes[2])).toBe(false);
  });
});

describe('the menu with project layers', () => {
  const add = [
    { key: 'timers', label: 'Timers and schedules', desc: 'What runs on a clock', match: { type: 'service', kind: ['timer', 'scheduler', 'job'] } },
    { key: 'data', label: 'Data', match: { type: ['store', 'table'] } },
    { key: 'empty', label: 'Nothing here', match: { kind: 'never' } },
  ];
  const nodes = [
    node('root', 'root'), node('app', 'app'),
    node('j1', 'service', { kind: 'job' }), node('t1', 'service', { kind: 'timer' }), node('h1', 'service', { kind: 'hook' }), node('h2', 'service', { kind: 'hook' }), node('c1', 'service', { kind: 'client' }),
    node('tb', 'table'), node('st', 'store'), node('p1', 'page'),
  ];
  const open = (cfg) => {
    document.body.innerHTML = body;
    Object.assign(state, { nodes: nodes.map((n) => ({ ...n })), edges: [], theme: 'dark', view: 'orbit', runsMap: null, proposal: null });
    setProjectLayers(cfg);
  };
  beforeEach(() => localStorage.clear());
  afterEach(() => { setProjectLayers(undefined); localStorage.clear(); });

  it('puts project rows first (in add order), then the starting ones, and leaves a layer with no node out', () => {
    open({ add, off: ['timers'] });
    const keys = rowKeys();
    expect(keys.slice(0, 2)).toEqual(['timers', 'data']);
    expect(keys).not.toContain('empty');
    expect(keys.slice(2, 5)).toEqual(['app', 'pkg', 'page']);
    expect(keys.at(-1)).toBe('runs');
  });
  it('`order` goes first of all', () => {
    open({ add, order: ['page', 'data', 'app'] });
    expect(rowKeys().slice(0, 4)).toEqual(['page', 'data', 'app', 'timers']);
  });
  it('counts what a project layer took away from the starting layer, so the rows add up to the map', () => {
    open({ add, off: ['timers'] });
    expect(countOf('timers')).toBe('2');
    expect(countOf('service')).toBe('3');
    expect(countOf('data')).toBe('2');
    expect(row('table')).toBeNull(); // Data took every table and store: their rows go (spec example 3)
    expect(row('store')).toBeNull();
    expect(row('atom')).not.toBeNull(); // a starting row nothing was taken from stays, empty as it is
    const total = rows().filter((r) => !['flow', 'runs'].includes(r.dataset.layer)).reduce((n, r) => n + Number(r.querySelector('.hx-count').textContent), 0);
    expect(total).toBe(nodes.length - 1); // every node but the root
  });
  it('starts a layer the config turns off off, and the chip counts layers on of all (not overlays, not empty rows)', () => {
    open({ add, off: ['timers'] });
    expect(row('timers').getAttribute('aria-pressed')).toBe('false');
    expect(row('data').getAttribute('aria-pressed')).toBe('true');
    const all = rows().filter((r) => r.dataset.layer !== 'runs');
    const on = all.filter((r) => r.getAttribute('aria-pressed') === 'true');
    expect(chip()).toBe(`· ${on.length} of ${all.length}`);
    expect(isNodeVisible(state, nodes[3])).toBe(false);
    toggleLayer('timers');
    expect(isNodeVisible(state, nodes[3])).toBe(true);
    expect(chip()).toBe(`· ${on.length + 1} of ${all.length}`);
  });
  it('All and None switch every layer, never an overlay; the root stays drawn', () => {
    open({ add });
    state.activeLayers.runs = true;
    toggleAllLayers(false);
    expect(rows().filter((r) => r.dataset.layer !== 'runs').every((r) => r.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(state.activeLayers.runs).toBe(true);
    expect(nodes.filter((n) => isNodeVisible(state, n)).map((n) => n.id)).toEqual(['root']);
    toggleAllLayers(true);
    expect(state.activeLayers.timers).toBe(true);
    expect(state.activeLayers.runs).toBe(true);
  });
  it('says Overlays over the Runs row, from the strings', () => {
    open({ add });
    const h = document.querySelector('[data-corn="overlays"]');
    expect(h.textContent).toBe('Overlays');
    expect(h.nextElementSibling.dataset.layer).toBe('runs');
  });
  it('stays open after a click on a row, though the row is drawn again; a click outside closes it', () => {
    open({ add });
    const menu = $('legend-dropdown');
    menu.hidden = false;
    const name = row('page').querySelector('.hx-toggle-name'); // what a pointer lands on
    clickWithLegendMenu(name, () => toggleLayer('page', { viewer: true }));
    expect(name.isConnected).toBe(false); // the row it was in has been replaced
    expect(row('page').getAttribute('aria-pressed')).toBe('false');
    expect(menu.hidden).toBe(false);
    clickWithLegendMenu($('graph-canvas') || document.body, () => {});
    expect(menu.hidden).toBe(true);
  });
  it('on a phone, an open menu is over the sheets (the dock), so a proposal\'s sheet never hides its last rows', () => {
    const css = explorerCss();
    const phone = css.slice(css.indexOf('Project layers and finer kinds (spec 0009)'));
    const dock = Number(/\.hx-dock \{[^}]*z-index: (\d+)/.exec(css)[1]);
    const over = /\.hx-header:has\(\.hx-layers \.hx-menu:not\(\[hidden\]\)\) \{ z-index: (\d+); \}/.exec(phone);
    expect(over).not.toBeNull();
    expect(Number(over[1])).toBeGreaterThan(dock);
  });
  it('has the All and None buttons with their hooks, and they stay at the head of the menu while the rows scroll', () => {
    open({ add });
    expect(document.querySelector('[data-corn="layers-all"]').textContent).toBe('All');
    expect(document.querySelector('[data-corn="layers-none"]').textContent).toBe('None');
    const menu = $('legend-dropdown');
    const head = menu.querySelector('.hx-menu-head');
    expect(head.parentElement).toBe(menu);
    expect(menu.querySelector('.hx-menu-body').contains($('layer-toggles-container'))).toBe(true);
    expect(menu.querySelector('.hx-menu-body').contains(head)).toBe(false);
  });

  describe('what the viewer changed is kept, and only the changes', () => {
    it('keeps a menu choice, not the config\'s own defaults, and brings a later layer with its default', () => {
      open({ add, off: ['timers'] });
      expect(localStorage.getItem('cornfield:layers')).toBeNull();
      toggleLayer('page', { viewer: true });
      toggleLayer('timers', { viewer: true });
      expect(JSON.parse(localStorage.getItem('cornfield:layers'))).toEqual({ page: false, timers: true });
      toggleLayer('page', { viewer: true }); // back to its default: no longer a change
      expect(JSON.parse(localStorage.getItem('cornfield:layers'))).toEqual({ timers: true });
      // a new visit: the same config, then the config adds a layer that starts off, and the viewer's change still holds
      const later = [...add, { key: 'extra', label: 'Extra', match: { type: 'page' } }];
      open({ add: later, off: ['timers', 'extra'] });
      expect(state.activeLayers.timers).toBe(true);
      expect(state.activeLayers.extra).toBe(false);
      expect(state.activeLayers.page).toBe(true);
    });
    it('does not keep a layer the app turns on by itself (a deploy lights a stack)', () => {
      open({ add });
      toggleLayer('stack');
      expect(localStorage.getItem('cornfield:layers')).toBeNull();
    });
    it('survives storage that is blocked or holds rubbish', () => {
      localStorage.setItem('cornfield:layers', '{"page": "no", "a b": true, "__proto__": true, "app": false}');
      open({ add });
      expect(state.activeLayers.app).toBe(false);
      expect(state.activeLayers.page).not.toBe(false);
      localStorage.setItem('cornfield:layers', 'not json');
      open({ add });
      expect(state.activeLayers.app).toBe(true);
    });
  });

  describe('the kinds key', () => {
    it('offers a disclosure on a row with kinds, counted from what the row holds (a layer takes its kinds from the starting one)', () => {
      open({ add });
      const kinds = (key) => row(key).nextElementSibling;
      expect(kinds('service').querySelector('[data-corn="layer-kinds"]').textContent).toContain('2 kinds'); // hook, client: job and timer went to Timers
      expect(kinds('timers').querySelector('[data-corn="layer-kinds"]').textContent).toContain('2 kinds');
      expect(row('page').nextElementSibling.matches('[data-action="toggle-layer"]')).toBe(true); // the next row: no kinds under Pages
    });
    it('opens the key rows: the letters, the name and the count; not toggles', () => {
      open({ add });
      const btn = row('service').nextElementSibling.querySelector('button');
      expect(btn.getAttribute('aria-expanded')).toBe('false');
      expect(document.querySelectorAll('[data-corn="kind-key"]')).toHaveLength(0);
      btn.focus();
      toggleLayerKinds('service');
      const again = row('service').nextElementSibling.querySelector('button');
      expect(again.getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(again); // the focus stays on the disclosure
      const keys = [...row('service').nextElementSibling.querySelectorAll('[data-corn="kind-key"]')].map((k) => [...k.children].map((c) => c.textContent));
      expect(keys).toEqual([['c', 'client', '1'], ['h', 'hook', '2']]);
      expect(row('service').nextElementSibling.querySelector('[data-corn="kind-key"] button')).toBeNull();
      expect(again.getAttribute('aria-controls')).toBe(row('service').nextElementSibling.querySelector('ul').id);
    });
    it('keeps the focus on a row after it is toggled', () => {
      open({ add });
      row('page').focus();
      toggleLayer('page', { viewer: true });
      expect(document.activeElement).toBe(row('page'));
    });
    it('writes a kind that is markup as text', () => {
      document.body.innerHTML = body;
      Object.assign(state, { nodes: [node('root', 'root'), node('x', 'service', { kind: '<img src=x onerror=alert(1)>' })], edges: [], theme: 'dark', view: 'orbit', runsMap: null, proposal: null });
      setProjectLayers(undefined);
      if (!document.querySelector('[data-corn="kind-key"]')) toggleLayerKinds('service');
      expect(document.querySelector('#layer-toggles-container img')).toBeNull();
      expect(document.querySelector('[data-corn="kind-key"] .hx-kind-name').textContent).toBe('<img src=x onerror=alert(1)>');
    });
  });

  describe('the "+N shown by the proposal" note', () => {
    it('says how many nodes of an off row are drawn only because the proposal touches them', () => {
      open({ add, off: ['timers'] });
      state.nodes = state.nodes.map((n) => (n.id === 't1' ? { ...n, mark: 'added' } : n));
      state.proposal = { name: 'p' };
      renderLayerToggles();
      expect(row('timers').querySelector('[data-corn="layer-note"]').textContent).toBe('+1 shown by the proposal');
      expect(row('data').querySelector('[data-corn="layer-note"]')).toBeNull();
      expect(isNodeVisible(state, state.nodes.find((n) => n.id === 't1'))).toBe(true);
      expect(isNodeVisible(state, state.nodes.find((n) => n.id === 'j1'))).toBe(false);
    });
  });
});

describe('a hostile config cannot reach markup, a style or a selector', () => {
  const hostile = ['"><img src=x onerror=alert(1)>', '</script><script>alert(1)</script>', 'a"b\'c', 'url(javascript:1)', 'a\nb', '<b>x</b>', '`${x}`', '{{x}}'];
  beforeEach(() => { localStorage.clear(); document.body.innerHTML = body; });
  afterEach(() => { setProjectLayers(undefined); localStorage.clear(); });
  const nodes = [node('root', 'root'), node('a', 'service', { kind: 'timer' })];

  it('a hostile key never becomes a layer: it is refused before it can name a token, a hook or a selector', () => {
    for (const key of hostile) {
      Object.assign(state, { nodes, edges: [], theme: 'dark', view: 'orbit', runsMap: null, proposal: null });
      setProjectLayers({ add: [{ key, label: 'Fine', match: { type: 'service' } }] });
      expect(state.projectLayers, JSON.stringify(key)).toEqual([]);
      expect(document.querySelector('#layer-toggles-container').innerHTML).not.toContain('Fine');
    }
  });
  it('a hostile label or description is text: escaped in the row, its title and the announcement', () => {
    for (const label of hostile.filter((l) => !l.includes('\n'))) {
      Object.assign(state, { nodes, edges: [], theme: 'dark', view: 'orbit', runsMap: null, proposal: null });
      setProjectLayers({ add: [{ key: 'ok', label, desc: label, match: { type: 'service' } }] });
      const r = row('ok');
      expect(r.querySelector('.hx-toggle-name').textContent, label).toBe(label.trim());
      expect(r.getAttribute('title')).toBe(label.trim());
      expect(document.querySelector('#layer-toggles-container img, #layer-toggles-container script, #layer-toggles-container b')).toBeNull();
      expect(r.querySelectorAll('*').length).toBeLessThan(12);
    }
  });
  it('a key that is a name every object has ("constructor") is a layer like any other: its count is a count, with no note', () => {
    Object.assign(state, { nodes, edges: [], theme: 'dark', view: 'orbit', runsMap: null, proposal: null });
    setProjectLayers({ add: [{ key: 'constructor', label: 'Builders', match: { type: 'service' } }] });
    expect(state.projectLayers.map((l) => l.key)).toEqual(['constructor']);
    expect(countOf('constructor')).toBe('1');
    expect(row('constructor').querySelector('[data-corn="layer-note"]')).toBeNull();
    expect(row('constructor').textContent).not.toContain('function');
  });
  it('a node colour that is not a colour never reaches the dot\'s style: a project layer\'s dot is its first node\'s fill, its type\'s when the colour is bad (#231)', () => {
    for (const theme of ['dark', 'light']) {
      const odd = [node('root', 'root'), node('a', 'service', { kind: 'timer', color: 'red" onmouseover="alert(1)" data-x="' })];
      Object.assign(state, { nodes: odd, edges: [], theme, view: 'orbit', runsMap: null, proposal: null });
      setProjectLayers({ add: [{ key: 'ok', label: 'Ok', match: { type: 'service' } }] });
      expect(document.querySelector('#layer-toggles-container [onmouseover]'), theme).toBeNull();
      const want = parseColor(themed(NODE_THEMES.service.color, theme));
      expect(parseColor(row('ok').querySelector('[data-corn="swatch"]').style.backgroundColor).map(Math.round), theme).toEqual(want.map(Math.round));
    }
  });
  it('a label with a line break is refused whole', () => {
    Object.assign(state, { nodes, edges: [], theme: 'dark', view: 'orbit', runsMap: null, proposal: null });
    setProjectLayers({ add: [{ key: 'ok', label: 'a\nb', match: { type: 'service' } }] });
    expect(state.projectLayers).toEqual([]);
  });
  it('a match that is a function, a pattern or an unknown key is refused whole, never run', () => {
    let ran = 0;
    for (const match of [{ type: () => { ran++; return true; } }, { kind: /./ }, { type: 'service', where: 'x' }, { type: 'service', field: { a: () => 1 } }]) {
      Object.assign(state, { nodes, edges: [], theme: 'dark', view: 'orbit', runsMap: null, proposal: null });
      setProjectLayers({ add: [{ key: 'ok', label: 'Ok', match }] });
      expect(state.projectLayers).toEqual([]);
    }
    expect(ran).toBe(0);
  });
  it('the example the rig uses is a good one', () => {
    setProjectLayers(EXAMPLE_LAYERS);
    expect(state.projectLayers.map((l) => l.key)).toEqual(['jobs', 'outside-calls', 'data']);
  });
});

describe('the theme\'s kind and layer tokens are read for what is on the map', () => {
  // @ts-expect-error plain JS modules, no declarations
  const M = import('../../explorer/map-style.js');
  it('reads --corn-map-kind-<type>-<kind> and --corn-map-group-<key> once the map and the config have that kind and layer', async () => {
    const map = await M;
    const style = document.createElement('style');
    style.textContent = ':root { --corn-map-kind-service-timer: #123456; --corn-map-kind-service-hook: #654321; --corn-map-group-jobs: #0a0b0c; --corn-map-group-gone: #0d0e0f; }';
    document.head.appendChild(style);
    document.body.innerHTML = body;
    Object.assign(state, { nodes: [node('root', 'root'), node('t', 'service', { kind: 'timer' })], edges: [], theme: 'dark', view: 'orbit', runsMap: null, proposal: null });
    try {
      setProjectLayers({ add: [{ key: 'jobs', label: 'Jobs', match: { kind: 'timer' } }] });
      expect(map.getMapStyle().values['--corn-map-kind-service-timer']).toBe('#123456');
      expect(map.getMapStyle().values['--corn-map-group-jobs']).toBe('#0a0b0c');
      expect(map.getMapStyle().values['--corn-map-kind-service-hook']).toBeUndefined(); // no service of that kind on the map
      expect(map.getMapStyle().values['--corn-map-group-gone']).toBeUndefined(); // no such layer in the config
    } finally { style.remove(); map.resetMapStyle(); setProjectLayers(undefined); }
  });
});
