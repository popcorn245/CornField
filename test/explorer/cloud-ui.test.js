// @vitest-environment happy-dom
/**
 * Cloud in the page (spec 0031 section 6, CLOUD-06), through the page's own markup (explorer/index.html):
 * the Layers menu has Cloud and Public web in place of Externals, each with its count, and each hides its own
 * nodes; the Cloud legend says what a call's `when` looks like, while the Cloud layer is on; selecting a cloud
 * node fills the drawer with its badge, plan, breaks line and Used by grouped by when.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { setMap } from '../../explorer/view.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { LAYER_DEFS, renderLayerToggles, toggleLayer } from '../../explorer/layers.js';
// @ts-expect-error plain JS modules, no declarations
import { selectNode, closeDrawer } from '../../explorer/panels.js';

const page = fs.readFileSync(path.resolve(__dirname, '../../explorer/index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page) [1].replace(/<script[\s\S]*?<\/script>/g, '');

const node = (id        , type        , extra         = {}) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, ...extra });
const base = {
  nodes: [
    node('root', 'root'), node('app-join', 'app', { label: 'join.example.test' }),
    node('store-cloud', 'store', { label: 'Cloud file', file: 'topology.cloud.json' }),
    node('ext-cloudflare', 'external', { label: 'Cloudflare', kind: 'cloud', roles: ['runtime', 'account'], plan: { tier: 'free' }, breaks: 'Now: names stop resolving.', desc: 'DNS for example.test.', file: 'topology.cloud.json' }),
    node('ext-docker-hub', 'external', { label: 'Docker Hub', kind: 'cloud', roles: ['software'], plan: { tier: 'free', note: 'Anonymous pulls' }, breaks: 'At the next deploy.', file: 'topology.cloud.json' }),
    node('ext-public-web', 'external', { label: 'Public web', kind: 'web', breaks: 'One site down.', file: 'topology.cloud.json' }),
    node('container-caddy', 'container', { label: 'caddy' }),
  ],
  edges: [
    { from: 'root', to: 'app-join' }, { from: 'root', to: 'store-cloud' },
    { from: 'store-cloud', to: 'ext-cloudflare' }, { from: 'store-cloud', to: 'ext-docker-hub' }, { from: 'store-cloud', to: 'ext-public-web' },
    { from: 'container-caddy', to: 'ext-cloudflare', kind: 'calls', status: 'live', label: 'DNS-01 challenge', when: 'renew' },
    { from: 'container-caddy', to: 'ext-docker-hub', kind: 'calls', status: 'live', label: 'its image', when: 'deploy' },
    { from: 'app-join', to: 'ext-cloudflare', kind: 'calls', status: 'live', label: 'the tunnel' },
  ],
};

const $ = (id        ) => document.getElementById(id)               ;
const sceneIds = () => render.getScene().nodes.map((n     ) => n.id);

function mount() {
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
  renderLayerToggles();
}

const row = (key        ) => document.querySelector(`[data-action="toggle-layer"][data-layer="${key}"]`)               ;

afterEach(() => { closeDrawer(); document.body.innerHTML = ''; });

describe('the Layers menu', () => {
  it('has Cloud and Public web in place of Externals, each with its count', () => {
    mount();
    expect(row('external')).toBeNull();
    expect(row('cloud').textContent).toContain('Cloud');
    expect(row('cloud').querySelector('.hx-count') .textContent).toBe('2');
    expect(row('web').textContent).toContain('Public web');
    expect(row('web').querySelector('.hx-count') .textContent).toBe('1');
  });

  it('hides the public web with its toggle, and the cloud with its own', () => {
    mount();
    expect(sceneIds()).toEqual(expect.arrayContaining(['ext-cloudflare', 'ext-public-web']));
    toggleLayer('web');
    expect(row('web').getAttribute('aria-pressed')).toBe('false');
    expect(sceneIds()).not.toContain('ext-public-web');
    expect(sceneIds()).toContain('ext-cloudflare');
    toggleLayer('web');
    toggleLayer('cloud');
    expect(sceneIds()).toContain('ext-public-web');
    expect(sceneIds()).not.toContain('ext-cloudflare');
    toggleLayer('cloud');
  });

  it('turns a layer the state has no entry for off on the first click, as its tick shows it on', () => {
    mount();
    delete state.activeLayers.web;
    renderLayerToggles();
    expect(row('web').getAttribute('aria-pressed')).toBe('true');
    toggleLayer('web');
    expect(row('web').getAttribute('aria-pressed')).toBe('false');
    toggleLayer('web');
  });

  it('shows the Cloud legend, solid, dashed and dotted, while the Cloud layer is on', () => {
    mount();
    const legend = $('cloud-legend');
    expect(legend.hidden).toBe(false);
    expect(legend.querySelector('.hx-swatch-when--run')).not.toBeNull();
    expect(legend.querySelector('.hx-swatch-when--deploy')).not.toBeNull();
    expect(legend.querySelector('.hx-swatch-when--renew')).not.toBeNull();
    expect(legend.textContent).toMatch(/Solid: breaks as soon as it is down/);
    expect(legend.textContent).toMatch(/Dashed: breaks at the next deploy/);
    expect(legend.textContent).toMatch(/Dotted: breaks at the next certificate renewal/);
    expect(legend.textContent).toContain('(browser)');
    toggleLayer('cloud');
    expect(legend.hidden).toBe(true);
    toggleLayer('cloud');
  });
});

describe('the cloud node panel', () => {
  it('fills the drawer: the kind badge, roles, plan, breaks line and Used by by when', async () => {
    mount();
    await selectNode(state.nodes.find((n     ) => n.id === 'ext-cloudflare'));
    expect($('drawer-badge').textContent).toBe('CLOUD');
    expect($('drawer-title').textContent).toBe('Cloudflare');
    const meta = $('drawer-meta-list');
    const badges = [...meta.querySelectorAll('.hx-cloud-badges > span')].map((b) => b.textContent);
    expect(badges).toEqual(['Cloud', 'runtime', 'account', 'Free']);
    expect(meta.querySelector('.hx-cloud-breaks') .textContent).toBe('Now: names stop resolving.');
    const groups = [...meta.querySelectorAll('.hx-cloud-when')].map((g) => g.querySelector('.hx-cloud-when-head') .textContent);
    expect(groups).toEqual(['Breaks now1', 'Breaks at the next certificate renewal1']);
    expect(meta.querySelector('.hx-cloud-when--run') .textContent).toContain('join.example.test');
    expect(meta.querySelector('.hx-cloud-when--renew') .textContent).toContain('caddy');
    expect(meta.textContent).not.toContain('Not run by this stack'); // the old external panel is not shown
  });

  it('shows the plan\'s note, and says Public web for the public web, with no plan', async () => {
    mount();
    await selectNode(state.nodes.find((n     ) => n.id === 'ext-docker-hub'));
    expect($('drawer-meta-list').querySelector('.hx-cloud-plan-note') .textContent).toBe('Anonymous pulls');
    expect($('drawer-meta-list').querySelector('.hx-cloud-when--deploy')).not.toBeNull();
    await selectNode(state.nodes.find((n     ) => n.id === 'ext-public-web'));
    expect($('drawer-badge').textContent).toBe('PUBLIC WEB');
    expect($('drawer-meta-list').querySelector('.hx-cloud-plan')).toBeNull();
    expect($('drawer-meta-list').textContent).toContain('Nothing on the map uses it.');
  });
});
