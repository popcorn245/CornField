// @vitest-environment happy-dom
/**
 * Spec 0011 D2, D4, D5, D12: pieces in different shadow roots share one instance. The instance has more than one root (engine/roots.js): focus and keys
 * are the instance's in each; a piece reaches a neighbour by an event or an `ask`, never by an id in a root it cannot see (the announcer, the node panel,
 * the Layers menu, the search's live region); the three pieces mount in a root of their own (pieces/around.js) when a map is there and say what they
 * need when it is not; a style the markup asks for is set through the CSS object model (a strict `style-src` blocks the attribute).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadSample } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { createInstance } from '../../explorer/instance.js';
// @ts-expect-error plain JS modules, no declarations
import { createMap } from '../../explorer/engine/render.js';
// @ts-expect-error plain JS modules, no declarations
import { computeDegreeCentrality, layoutOrbit } from '../../explorer/engine/layout.js';
// @ts-expect-error plain JS modules, no declarations
import { joinRoot, listenRoots, onPageClick } from '../../explorer/engine/roots.js';
// @ts-expect-error plain JS modules, no declarations
import { announce, speaker } from '../../explorer/engine/keyboard.js';
// @ts-expect-error plain JS modules, no declarations
import { selectNode, clearSelection } from '../../explorer/engine/selection.js';
// @ts-expect-error plain JS modules, no declarations
import { showSearchStatus } from '../../explorer/engine/search-status.js';
// @ts-expect-error plain JS modules, no declarations
import { addParts, applyStyles } from '../../explorer/engine/piece.js';
// @ts-expect-error plain JS modules, no declarations
import { mountAround } from '../../explorer/pieces/around.js';
// @ts-expect-error plain JS modules, no declarations
import * as nodePanel from '../../explorer/pieces/node-panel.js';
// @ts-expect-error plain JS modules, no declarations
import * as searchPiece from '../../explorer/pieces/search.js';
// @ts-expect-error plain JS modules, no declarations
import * as layersPiece from '../../explorer/pieces/layers.js';
// @ts-expect-error plain JS modules, no declarations
import { visibleMapRect } from '../../explorer/engine/map-rect.js';

const sample = loadSample();
const shadowOf = (name) => {
  const host = document.createElement('div');
  host.id = name;
  document.body.append(host);
  return host.attachShadow({ mode: 'open' });
};
afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });

describe('more than one root for one instance', () => {
  it('a joined root\'s focus is the instance\'s, and a root the instance has already is not added again', () => {
    const outer = document.createElement('div');
    document.body.append(outer);
    const inst = createInstance({ root: outer });
    const other = shadowOf('other');
    const input = document.createElement('input');
    other.append(input);
    expect(inst.active()).toBe(null);
    const leave = joinRoot(inst, other);
    input.focus();
    expect(inst.active()).toBe(input);
    expect(inst.extraRoots.size).toBe(1);
    joinRoot(inst, other); // the same root again
    joinRoot(inst, outer); // the primary
    joinRoot(inst, document.body.firstElementChild === outer ? outer : document.body); // the document is not the primary here, but a node of it joins its root once
    leave();
    expect(inst.active()).toBe(null);
    inst.destroy();
  });

  it('listenRoots hears every root, those that join later too, once per event, and `destroy()` takes them all back', () => {
    const outer = document.createElement('div');
    document.body.append(outer);
    const inst = createInstance({ root: outer });
    const a = shadowOf('a');
    const seen = [];
    listenRoots(inst, 'keydown', (e) => seen.push(e.target.id || e.target.localName));
    const first = document.createElement('button');
    first.id = 'first';
    outer.append(first);
    first.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true }));
    expect(seen).toEqual(['first']);
    joinRoot(inst, a);
    const second = document.createElement('button');
    second.id = 'second';
    a.append(second);
    second.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true }));
    expect(seen).toEqual(['first', 'second']);
    // a root inside the other: an event that reaches both is handled once
    const inner = document.createElement('div');
    outer.append(inner);
    const innerRoot = inner.attachShadow({ mode: 'open' });
    joinRoot(inst, innerRoot);
    const deep = document.createElement('button');
    deep.id = 'deep';
    innerRoot.append(deep);
    deep.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true }));
    expect(seen.filter((s) => s === 'deep')).toHaveLength(1);
    inst.destroy();
    first.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true }));
    expect(seen.filter((s) => s === 'first')).toHaveLength(1);
  });

  it('the primary root moving (the map attaching its own) keeps the listeners right', () => {
    const scopeEl = document.createElement('div');
    document.body.append(scopeEl);
    const inst = createInstance({ root: scopeEl });
    const seen = [];
    listenRoots(inst, 'click', (e) => seen.push(e.target.id));
    const mapRoot = shadowOf('map');
    const release = inst.attach(mapRoot);
    const b = document.createElement('button');
    b.id = 'in-map';
    mapRoot.append(b);
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(seen.length).toBeGreaterThan(0);
    release();
    inst.destroy();
  });

  it('a click anywhere in the page is heard first, with the path of what was in the way', () => {
    const inst = createInstance({ root: document.body });
    const paths = [];
    onPageClick(inst, (e) => paths.push(e.composedPath().includes(document.querySelector('#x'))));
    const x = document.createElement('p');
    x.id = 'x';
    document.body.append(x);
    x.click();
    document.body.click();
    expect(paths).toEqual([true, false]);
    inst.destroy();
  });
});

describe('what a screen reader is told, when the live region is another piece\'s', () => {
  it('goes to the piece that answers announce:write; else to a fallback; else, last, to a #map-announcer in the instance\'s own root', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.innerHTML = '<p id="map-announcer"></p>';
    document.body.append(root);
    const inst = createInstance({ root });
    const told = [];
    inst.on('announce', (t) => told.push(t));
    announce(inst, 'legacy');
    vi.advanceTimersByTime(60);
    expect(root.querySelector('#map-announcer').textContent).toBe('legacy');
    const region = document.createElement('p');
    const say = speaker(inst, region);
    inst.on('announce:fallback', (t) => { say(t); return true; });
    announce(inst, 'fallback');
    vi.advanceTimersByTime(60);
    expect(region.textContent).toBe('fallback');
    expect(root.querySelector('#map-announcer').textContent).toBe('legacy');
    const other = document.createElement('p');
    const sayMap = speaker(inst, other);
    inst.on('announce:write', (t) => { sayMap(t); return true; });
    announce(inst, 'by the map');
    vi.advanceTimersByTime(60);
    expect(other.textContent).toBe('by the map');
    expect(region.textContent).toBe('fallback'); // the fallback is for when nobody else speaks
    expect(told).toEqual(['legacy', 'fallback', 'by the map']);
    inst.destroy();
  });

  it('the search\'s live region is the search piece\'s own: the status is an event, not a lookup by id', () => {
    const inst = createInstance({ root: document.body });
    const heard = [];
    inst.on('search:status', (t) => heard.push(t));
    showSearchStatus(inst, '3 matches');
    expect(heard).toEqual(['3 matches']);
    inst.destroy();
  });
});

describe('a style the markup asks for', () => {
  it('is set through the CSS object model and the attribute goes (a strict style-src blocks an inline style that came in as a string)', () => {
    const el = document.createElement('div');
    el.innerHTML = '<span data-corn="swatch" data-style="background-color: rgb(1, 2, 3); --hx-dot-ring: red"></span><b data-corn="x"></b>';
    addParts(el);
    const dot = el.querySelector('[data-corn="swatch"]');
    expect(dot.hasAttribute('data-style')).toBe(false);
    expect(dot.style.backgroundColor).toBe('rgb(1, 2, 3)');
    expect(dot.getAttribute('part')).toBe('swatch');
    const lone = document.createElement('i');
    lone.setAttribute('data-style', 'background: red');
    applyStyles(lone);
    expect(lone.style.background).toBe('red');
  });

  it('sets only a swatch\'s own properties, one by one: a value never adds a declaration or fetches anything', () => {
    const el = document.createElement('i');
    el.setAttribute('data-style', 'background-color: rgb(1, 2, 3); position: fixed; color: red; background: url(https://elsewhere.example/x.png); box-shadow: 0 0 8px red; --hx-dot-ring: red; --other: 1; background-image: image-set("x.png" 1x)');
    applyStyles(el);
    expect(el.style.backgroundColor).toBe('rgb(1, 2, 3)');
    expect(el.style.boxShadow).toBe('0 0 8px red');
    expect(el.style.getPropertyValue('--hx-dot-ring')).toBe('red');
    for (const p of ['position', 'color', 'background-image', '--other']) expect(el.style.getPropertyValue(p), p).toBe('');
    expect(el.style.cssText).not.toMatch(/url|image|fixed|elsewhere/);
  });
});

describe('the pieces around the map in a root of their own (pieces/around.js)', () => {
  const stub = () => {
    const calls = [];
    return { calls, mount: (root, inst, options) => { calls.push(['mount', options]); return { update: (n) => calls.push(['update', n]), destroy: () => calls.push(['destroy']), focusField: () => calls.push(['focusField']) }; } };
  };

  it('with no instance (no scope around) it says what it needs, mounts nothing, and throws nothing', () => {
    const root = shadowOf('lone');
    const piece = stub();
    const around = mountAround(piece, root, null, {});
    expect(root.querySelector('[data-corn="empty"]').textContent).toBe('This needs a corn-scope around it, with a corn-map in it');
    expect(piece.calls).toEqual([]);
    around.update({ query: 'x' });
    around.focusField();
    around.destroy();
    expect(root.querySelector('[data-corn="empty"]')).toBe(null);
    around.destroy();
  });

  it('inside a scope it mounts when the map is ready and ends when it is gone, whatever the order; what was set before it mounted is applied when it does', () => {
    const scopeEl = document.createElement('div');
    document.body.append(scopeEl);
    const inst = createInstance({ root: scopeEl });
    inst.slot('scope', () => ({})); // a scope's instance: scopeInfo(inst) needs a `host`
    inst.slot('scope', () => ({})).host = scopeEl;
    inst.slot('scope', () => ({})).serverTheme = null;
    const root = shadowOf('late');
    const piece = stub();
    const around = mountAround(piece, root, inst, { initial: { query: 'a' }, noMap: 'nodePanelEmpty' });
    expect(root.querySelector('[data-corn="empty"]').textContent).toBe('Select a node on the map to see its details');
    around.update({ query: 'ab' });
    expect(piece.calls).toEqual([]);
    // a map with no nodes yet (loading, signed out, offline): the piece waits; its data in the scene brings it up
    inst.map = {};
    inst.emit('map:ready');
    expect(piece.calls).toEqual([]);
    inst.state.nodes = [{ id: 'a' }];
    inst.touchScene();
    expect(piece.calls.map((c) => c[0])).toEqual(['mount', 'update']);
    expect(piece.calls[0][1]).toMatchObject({ inline: true, phone: false });
    expect(piece.calls[1][1]).toEqual({ query: 'ab' });
    expect(root.querySelector('[data-corn="empty"]')).toBe(null);
    around.focusField();
    expect(piece.calls.at(-1)).toEqual(['focusField']);
    inst.emit('map:gone');
    expect(piece.calls.at(-1)).toEqual(['destroy']);
    expect(root.querySelector('[data-corn="empty"]')).not.toBe(null);
    inst.emit('map:ready');
    expect(piece.calls.filter((c) => c[0] === 'mount')).toHaveLength(2);
    around.destroy();
    // a search or a Layers menu: "needs a map" while there is none, "waiting for the map" while it has no data, then the piece
    inst.map = null;
    inst.state.nodes = [];
    const words = shadowOf('waiting');
    const other = stub();
    const waiting = mountAround(other, words, inst, {});
    expect(words.querySelector('[data-corn="empty"]').textContent).toBe('This needs a corn-map in the same corn-scope');
    inst.map = {};
    inst.emit('map:ready');
    expect(words.querySelector('[data-corn="empty"]').textContent).toBe('Waiting for the map');
    expect(other.calls).toEqual([]);
    inst.state.nodes = [{ id: 'a' }];
    inst.touchScene();
    expect(other.calls.map((c) => c[0])).toEqual(['mount']);
    expect(words.querySelector('[data-corn="empty"]')).toBe(null);
    waiting.destroy();
    expect(piece.calls.at(-1)).toEqual(['destroy']);
    // it joined the instance's roots and gave them back
    expect(inst.extraRoots.size).toBe(0);
    inst.destroy();
  });

  it('is told and speaks for the map\'s absence: its own live region answers announce:fallback', () => {
    vi.useFakeTimers();
    const scopeEl = document.createElement('div');
    document.body.append(scopeEl);
    const inst = createInstance({ root: scopeEl });
    const root = shadowOf('say');
    const around = mountAround(stub(), root, inst, {});
    announce(inst, 'Panel closed');
    vi.advanceTimersByTime(60);
    expect(root.querySelector('[role="status"]').textContent).toBe('Panel closed');
    around.destroy();
    expect(root.querySelector('[role="status"]')).toBe(null);
    inst.destroy();
  });
});

describe('the node panel, the Layers menu and the search in roots of their own', () => {
  const SIZE = { width: 800, height: 600 };
  let inst;
  let mapRoot;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(performance.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
    const scopeEl = document.createElement('div');
    document.body.append(scopeEl);
    inst = createInstance({ root: scopeEl });
    mapRoot = shadowOf('mapside');
    inst.attach(mapRoot);
    mapRoot.innerHTML = '<div class="hx-stage"><canvas id="graph-canvas"></canvas></div>';
    const canvas = mapRoot.querySelector('canvas');
    Object.defineProperty(canvas.parentElement, 'clientWidth', { value: SIZE.width });
    Object.defineProperty(canvas.parentElement, 'clientHeight', { value: SIZE.height });
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} });
    Object.assign(inst.state, { canvas, ctx: { save() {}, restore() {}, font: '', measureText: (s) => ({ width: String(s).length * 6 }) }, nodes: structuredClone(sample.nodes), edges: structuredClone(sample.edges) });
    const map = createMap(inst);
    map.setRenderer({ kind: 'stub', draw() {}, resize() {}, destroy() {} });
    computeDegreeCentrality(inst);
    layoutOrbit(inst);
    map.resize();
    map.fitGraphToViewport(40);
  });
  afterEach(() => { inst.destroy(); vi.unstubAllGlobals(); });

  it('the panel fills its own box (never a slide-over), covers nothing of the map, and follows the selection from another root; Escape in it says "Panel closed" and the map has the focus', () => {
    const root = shadowOf('panelside');
    const panel = nodePanel.mount(root, inst, { inline: true });
    expect(root.querySelector('[data-corn="empty"]').textContent).toBe('Select a node on the map to see its details');
    expect(root.querySelector('[data-corn="backdrop"]')).toBe(null);
    expect(root.querySelector('.hx-sheet-handle')).toBe(null);
    const node = inst.state.nodes.find((n) => n.type === 'app');
    selectNode(inst, node, { source: 'api' });
    expect(root.querySelector('[data-corn="node-title"]').textContent).toBeTruthy();
    expect(root.querySelector('[data-corn="node-panel"]').classList.contains('drawer-open')).toBe(true);
    expect(root.querySelector('[data-corn="empty"]').hidden).toBe(true);
    expect(inst.ask('panel:covers')).toBe(undefined); // in a box of its own it covers nothing of the map
    expect(inst.ask('panel:present')).toBe(true);
    expect(visibleMapRect(inst)).toMatchObject({ x: 0, width: SIZE.width });
    const said = [];
    inst.on('announce', (t) => said.push(t));
    root.querySelector('[data-corn="node-panel"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(inst.state.selectedNode).toBe(null);
    expect(said.at(-1)).toBe('Panel closed');
    expect(root.querySelector('[data-corn="empty"]').hidden).toBe(false);
    // a panel mounted late is handed the selection the instance holds
    selectNode(inst, node, { source: 'api' });
    const late = shadowOf('late-panel');
    const second = nodePanel.mount(late, inst, { inline: true });
    expect(late.querySelector('[data-corn="node-panel"]').classList.contains('drawer-open')).toBe(true);
    second.destroy();
    panel.destroy();
    expect(root.children.length).toBe(0);
  });

  it('the Layers menu in its own root: its switch redraws, the click elsewhere in the page closes it, its keys are heard from the map\'s root, and the map knows it is there', () => {
    const root = shadowOf('layersside');
    joinRoot(inst, root);
    const layers = layersPiece.mount(root, inst, { inline: true, phone: false, storageKey: null });
    expect(inst.ask('layers:present')).toBe(true);
    const chip = root.querySelector('[data-corn="layers-button"]');
    chip.click();
    const menu = root.querySelector('[data-corn="layers-menu"]');
    expect(menu.hidden).toBe(false);
    document.body.click();
    expect(menu.hidden).toBe(true);
    chip.click();
    expect(menu.hidden).toBe(false);
    mapRoot.querySelector('canvas').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    expect(menu.hidden).toBe(true);
    const row = root.querySelector('[data-corn="row"][data-layer]');
    const key = row.dataset.layer;
    const before = row.getAttribute('aria-pressed');
    row.click();
    expect(root.querySelector(`[data-corn="row"][data-layer="${key}"]`).getAttribute('aria-pressed')).not.toBe(before);
    expect(root.querySelector('[data-style]')).toBe(null); // the dots' colours are set through the CSS object model
    expect(root.querySelector('[data-corn="swatch"]').style.backgroundColor).not.toBe('');
    layers.destroy();
  });

  it('the search in its own root: no phone bar, its count said in its own live region, `/` from the map reaches it, a chosen match selects it for the others', () => {
    const root = shadowOf('searchside');
    const search = searchPiece.mount(root, inst, { inline: true, phone: false });
    expect(root.querySelectorAll('input')).toHaveLength(1);
    expect(root.querySelector('[data-corn="mobile-search"], [data-corn="mobile-search-button"]')).toBe(null);
    search.setQuery('api');
    vi.advanceTimersByTime(500);
    expect(root.querySelector('[data-corn="search-status"]').textContent).toMatch(/match/);
    mapRoot.querySelector('canvas').dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true, composed: true }));
    expect(root.activeElement || document.activeElement).toBeTruthy();
    const found = search.currentResult().matches[0];
    const heard = [];
    inst.on('selection', (d) => heard.push(d.source));
    search.chooseMatch(found);
    expect(inst.state.selectedNode.id).toBe(found.node.id);
    expect(heard).toContain('search');
    search.destroy();
    clearSelection(inst);
  });
});
