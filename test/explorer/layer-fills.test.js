// @vitest-environment happy-dom
/**
 * The Layers menu as a legend of the map's fills (issue #229): a row's dot is the fill the map draws for the row's nodes (one resolver,
 * map-style.js `fillOf`), a kind's key row shows a swatch of `--corn-map-kind-<type>-<kind>` (nothing when unset), both repaint when the
 * theme's tokens change, and no colour reaches markup unchecked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { explorerPage } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { LAYER_DEFS, renderLayerToggles, setProjectLayers, toggleLayerKinds } from '../../explorer/layers.js';
// @ts-expect-error plain JS modules, no declarations
import * as M from '../../explorer/map-style.js';
// @ts-expect-error plain JS modules, no declarations
import { parseColor } from '../../explorer/theme-model.js';
// @ts-expect-error plain JS modules, no declarations
import { contrast } from '../../core/color.js';
// @ts-expect-error plain JS modules, no declarations
import { NODE_THEMES } from '../../core/schema.js';
// @ts-expect-error plain JS modules, no declarations
import { mapFillNames } from '../../core/layers.js';

const body = /<body>([\s\S]*)<\/body>/.exec(explorerPage())[1].replace(/<script[\s\S]*?<\/script>/g, '');
const builtIn = (key) => (LAYER_DEFS.find((l) => l.key === ({ floor: 'house', room: 'house', external: 'cloud' })[key] || l.key === key) || {}).color;
const node = (id, type, extra = {}) => ({ id, type, x: 0, y: 0, r: 20, color: NODE_THEMES[type] ? NODE_THEMES[type].color : '#336699', label: id, ...extra }); // as sync writes it
const row = (key) => document.querySelector(`[data-action="toggle-layer"][data-layer="${key}"]`);
const dotOf = (key) => row(key).querySelector('[data-corn="swatch"]');
const fillOfDot = (el) => parseColor(el.style.backgroundColor);
const same = (a, b) => expect(a.map(Math.round)).toEqual(b.map(Math.round));
let setNow = [];
const setTokens = (tokens) => {
  const root = document.documentElement;
  for (const k of setNow) root.style.removeProperty(k);
  setNow = Object.keys(tokens);
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
  M.refreshMapStyle();
};
/** The colour the map draws for node `id`: the real scene through the real styler */
const mapFill = (id) => parseColor(M.styledScene(buildScene({ ...state, selectedNode: null, searchQuery: '', isFreeform: false, scenario: null, sceneVersion: 1, rings: { rings: [], clusters: [] } })).nodes.find((n) => n.id === id).color);

const nodes = [node('root', 'root'), node('c', 'core'), node('s', 'store'), node('t', 'table'), node('a', 'app'), node('p', 'page'), node('svc', 'service', { kind: 'timer' }), node('svc2', 'service', { kind: 'job' }), node('fl', 'floor'), node('rm', 'room'), node('cl', 'external', { kind: 'saas' })];
const openKinds = (key) => { if (!row(key).nextElementSibling.querySelector('ul')) toggleLayerKinds(key); };
const show = (extra = {}) => {
  Object.assign(state, { nodes, edges: [], theme: 'dark', view: 'orbit', runsMap: null, proposal: null, flow: null, ...extra, activeLayers: {} });
  setProjectLayers(extra.__layers || undefined);
  Object.assign(state.activeLayers, extra.activeLayers || {});
  renderLayerToggles();
};

beforeEach(() => { document.body.innerHTML = body; });
afterEach(() => { setTokens({}); M.resetMapStyle(); document.body.innerHTML = ''; });

describe('a row\'s dot is the fill the map draws for a node on that row', () => {
  it('a starting layer with a type token (the issue: core red, stores gold)', () => {
    setTokens({ '--corn-map-node-core': '#e53e3e', '--corn-map-node-store': '#ffc940' });
    show();
    same(fillOfDot(dotOf('core')), parseColor('#e53e3e'));
    same(fillOfDot(dotOf('store')), parseColor('#ffc940'));
    same(fillOfDot(dotOf('core')), mapFill('c'));
    same(fillOfDot(dotOf('store')), mapFill('s'));
  });
  it('a starting layer with a group token only', () => {
    setTokens({ '--corn-map-group-table': '#112233' });
    show();
    same(fillOfDot(dotOf('table')), parseColor('#112233'));
    same(fillOfDot(dotOf('table')), mapFill('t'));
  });
  it('a type token beats the group token, as on the map', () => {
    setTokens({ '--corn-map-group-app': '#112233', '--corn-map-node-app': '#aa5500' });
    show();
    same(fillOfDot(dotOf('app')), parseColor('#aa5500'));
    same(fillOfDot(dotOf('app')), mapFill('a'));
  });
  it('a starting layer with neither: the built-in colour, as the node has it', () => {
    show();
    same(fillOfDot(dotOf('page')), parseColor(builtIn('page')));
    same(fillOfDot(dotOf('page')), mapFill('p'));
  });
  it('light: the built-in colour is the one the map draws on the light ground, and a token is used as written', () => {
    setTokens({ '--corn-map-node-app': '#4b2fe0' });
    show({ theme: 'light' });
    same(fillOfDot(dotOf('page')), mapFill('p'));
    same(fillOfDot(dotOf('table')), mapFill('t'));
    same(fillOfDot(dotOf('app')), mapFill('a'));
  });
  it('an outside row: the type token reaches Cloud (the map does the same), the group token tells Cloud from the Public web', () => {
    setTokens({ '--corn-map-group-cloud': '#445566' });
    show();
    same(fillOfDot(dotOf('cloud')), mapFill('cl'));
    same(fillOfDot(dotOf('cloud')), parseColor('#445566'));
  });
  it('a project layer: its token, else its first node\'s fill (a type token, else its colour)', () => {
    const layers = { add: [{ key: 'timers', label: 'Timers', match: { type: 'service', kind: 'timer' } }] };
    show({ __layers: layers });
    same(fillOfDot(dotOf('timers')), mapFill('svc')); // neither: the node's own colour
    setTokens({ '--corn-map-node-service': '#007755' });
    show({ __layers: layers });
    same(fillOfDot(dotOf('timers')), parseColor('#007755'));
    same(fillOfDot(dotOf('timers')), mapFill('svc'));
    setTokens({ '--corn-map-node-service': '#007755', '--corn-map-group-timers': '#cc0066' });
    show({ __layers: layers });
    same(fillOfDot(dotOf('timers')), parseColor('#cc0066'));
    same(fillOfDot(dotOf('timers')), mapFill('svc'));
  });
  it('a kind\'s own token never colours its row\'s dot (a dot is the row\'s)', () => {
    setTokens({ '--corn-map-kind-service-timer': '#ff00ff' });
    show();
    same(fillOfDot(dotOf('service')), parseColor(builtIn('service')));
  });
  it('a row of two types (House) shows its first type\'s fill, floors', () => {
    setTokens({ '--corn-map-node-floor': '#101010', '--corn-map-node-room': '#eeeeee' });
    show({ activeLayers: { house: true } });
    same(fillOfDot(dotOf('house')), mapFill('fl'));
  });
  it('... and the type the map holds when the first is not there (rooms only): the house group token, else the room\'s own', () => {
    show({ nodes: nodes.filter((n) => n.type !== 'floor'), activeLayers: { house: true } });
    same(fillOfDot(dotOf('house')), mapFill('rm'));
    setTokens({ '--corn-map-group-house': '#a0522d' });
    show({ nodes: nodes.filter((n) => n.type !== 'floor'), activeLayers: { house: true } });
    same(fillOfDot(dotOf('house')), parseColor('#a0522d'));
    same(fillOfDot(dotOf('house')), mapFill('rm'));
  });
  it('with no token, a starting row\'s built-in dot is its type\'s colour in core/schema.js: one table of default colours, not two', () => {
    for (const l of LAYER_DEFS) {
      const type = l.match && l.match.type ? [].concat(l.match.type)[0] : null;
      if (type) expect([l.key, l.color]).toEqual([l.key, NODE_THEMES[type].color]);
    }
  });
});

describe('one order of fills', () => {
  it('the map, the menu and the contrast check read the one list (core/layers.js mapFillNames): kind, project layer, type, starting group', () => {
    expect(M.fillNames).toBe(mapFillNames);
    expect(mapFillNames({ type: 'service', kind: 'timer', layer: 'jobs', group: 'service' })).toEqual(['--corn-map-kind-service-timer', '--corn-map-group-jobs', '--corn-map-node-service', '--corn-map-group-service']);
    expect(mapFillNames({ type: 'external', group: 'cloud' })).toEqual(['--corn-map-node-external', '--corn-map-group-cloud']);
    expect(fs.readFileSync(path.join(__dirname, '../../core/contrast.js'), 'utf8')).toContain('mapFillNames({ type, group })');
  });
});

describe('the kind key shows each kind\'s swatch', () => {
  it('a swatch of the kind token, aria-hidden, with the letters and the name still there; nothing for a kind with no token', () => {
    setTokens({ '--corn-map-kind-service-timer': '#ff00ff' });
    show();
    openKinds('service');
    const keys = [...document.querySelectorAll('[data-corn="kind-key"]')];
    const timer = keys.find((k) => k.textContent.includes('timer'));
    const job = keys.find((k) => k.textContent.includes('job'));
    const sw = timer.querySelector('[data-corn="swatch"]');
    same(fillOfDot(sw), parseColor('#ff00ff'));
    expect(sw.getAttribute('aria-hidden')).toBe('true');
    expect(timer.querySelector('.hx-kind-letter').textContent).not.toBe('');
    expect(timer.querySelector('.hx-kind-name').textContent).toBe('timer');
    expect(job.querySelector('[data-corn="swatch"]')).toBeNull(); // no token, no swatch (a hidden spacer keeps the letters in line)
    // and it is the colour the map draws that kind in
    same(fillOfDot(sw), mapFill('svc'));
  });
});

describe('they repaint when the theme changes', () => {
  it('the dots and swatches follow a token change with no other draw', () => {
    show();
    openKinds('service');
    same(fillOfDot(dotOf('core')), parseColor(builtIn('core')));
    setTokens({ '--corn-map-node-core': '#e53e3e', '--corn-map-kind-service-job': '#00aaee' });
    same(fillOfDot(dotOf('core')), parseColor('#e53e3e'));
    const job = [...document.querySelectorAll('[data-corn="kind-key"]')].find((k) => k.textContent.includes('job'));
    same(fillOfDot(job.querySelector('[data-corn="swatch"]')), parseColor('#00aaee'));
    setTokens({});
    same(fillOfDot(dotOf('core')), parseColor(builtIn('core')));
  });
});

describe('a colour never becomes markup', () => {
  it('a token value or a node colour that is not a colour gives the neutral grey, and no attribute breaks out', () => {
    setTokens({ '--corn-map-node-core': 'red" onmouseover="alert(1)" data-x="' });
    const odd = [node('root', 'root'), node('a', 'service', { kind: 'timer', color: 'red" onmouseover="alert(1)" data-x="' })];
    show({ nodes: odd, __layers: { add: [{ key: 'ok', label: 'Ok', match: { type: 'service' } }] } });
    expect(document.querySelector('#layer-toggles-container [onmouseover]')).toBeNull();
    expect(dotOf('ok').style.backgroundColor).not.toContain('onmouseover');
  });
  it('a node colour that only looks like one (five hex digits, an rgb() of a thousand numbers) is the grey, and short', () => {
    for (const bad of ['#12345', `rgb(${'1,'.repeat(4999)}1)`, 'rgb(1, 2, 3); background: url(x)']) {
      const odd = [node('root', 'root'), node('a', 'service', { kind: 'timer', color: bad })];
      show({ nodes: odd, __layers: { add: [{ key: 'ok', label: 'Ok', match: { type: 'service' } }] } });
      same(fillOfDot(dotOf('ok')), parseColor('#94a3b8'));
      expect(dotOf('ok').getAttribute('style').length).toBeLessThan(120);
    }
  });
  it('a token the map reads as a colour in another form (the browser\'s rgba(), the space syntax) reaches the dot as the map has it', () => {
    setTokens({ '--corn-map-node-core': 'rgba(26, 162, 230, 0.5)', '--corn-map-node-store': 'rgb(10 20 200 / 50%)' });
    show();
    expect(dotOf('core').style.backgroundColor.replace(/\s/g, '')).toBe('rgba(26,162,230,0.5)');
    if (M.getMapStyle().values['--corn-map-node-store']) expect(dotOf('store').style.backgroundColor).not.toBe('');
  });
});

describe('a fill too close to the menu keeps its colour and gets an outline', () => {
  it('a pale dot on a light surface is ringed, a strong one is not', () => {
    document.documentElement.style.setProperty('--corn-ground', '#fdf3dc');
    document.documentElement.style.setProperty('--corn-surface-1', '#ffffff');
    setTokens({ '--corn-map-node-table': '#f2c500', '--corn-map-node-app': '#4b2fe0', '--corn-map-stroke': '#1a1640' });
    show({ theme: 'light' });
    expect(contrast('#f2c500', '#ffffff')).toBeLessThan(3);
    expect(dotOf('table').classList.contains('is-ringed')).toBe(true);
    same(fillOfDot(dotOf('table')), parseColor('#f2c500'));
    expect(dotOf('table').getAttribute('style')).toContain('--hx-dot-ring');
    expect(dotOf('app').classList.contains('is-ringed')).toBe(false);
    document.documentElement.style.removeProperty('--corn-ground');
    document.documentElement.style.removeProperty('--corn-surface-1');
  });
});

describe('the retro fixture theme', () => {
  it('its map tokens colour the dots, light and dark', () => {
    const css = fs.readFileSync(path.join(__dirname, '../fixtures/themes/retro/theme.css'), 'utf8');
    const want = /--corn-map-node-store:\s*(#[0-9a-f]{6})/i.exec(css)[1];
    setTokens({ '--corn-map-node-store': want });
    show();
    same(fillOfDot(dotOf('store')), parseColor(want));
    same(fillOfDot(dotOf('store')), mapFill('s'));
  });
});
