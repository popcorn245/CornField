// @vitest-environment happy-dom
/**
 * The node panel says a finer kind in its badge ("Service · timer", spec 0009 D5) and no longer has a Kind row; a kind is text.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { explorerPage } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { setMap } from '../../explorer/view.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { selectNode, closeDrawer } from '../../explorer/panels.js';

const body = /<body>([\s\S]*)<\/body>/.exec(explorerPage({ pieces: ['map'] }))[1].replace(/<script[\s\S]*?<\/script>/g, '');
const $ = (id) => document.getElementById(id);
const node = (id, type, extra = {}) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, ...extra });
const nodes = [
  node('root', 'root'), node('app', 'app'),
  node('svc-nightly', 'service', { label: 'nightly-report', kind: 'timer', desc: 'Runs on an interval: builds the nightly report.', summary: 'Runs on an interval' }),
  node('svc-odd', 'service', { label: 'odd', kind: '<img src=x onerror=alert(1)>' }),
  node('pg', 'page', { label: 'home' }),
];
const edges = [{ from: 'root', to: 'app' }, { from: 'app', to: 'svc-nightly' }, { from: 'app', to: 'svc-odd' }, { from: 'app', to: 'pg' }];

function mount() {
  document.body.innerHTML = body;
  const ctx = new Proxy({}, { get: (_t, key) => (key === 'measureText' ? (t) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas = document.getElementById('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  Object.assign(state, { canvas, ctx, proposal: null, view: 'orbit', selectedNode: null, live: null, house: null, scenario: null });
  state.baseNodes = nodes.map((n) => ({ ...n }));
  state.baseEdges = edges;
  render.resize();
  setMap(state.baseNodes.map((n) => ({ ...n })), state.baseEdges);
}

afterEach(() => { closeDrawer(); document.body.innerHTML = ''; });

describe('the node panel and a finer kind', () => {
  it('puts the kind in the badge after a dot, and drops the Kind row', async () => {
    mount();
    await selectNode(state.nodes.find((n) => n.id === 'svc-nightly'));
    expect($('drawer-badge').textContent).toBe('Service · timer');
    expect($('drawer-meta-list').textContent).not.toMatch(/Kind:/);
    expect($('drawer-description').textContent).toContain('builds the nightly report');
  });
  it('leaves a node with no kind as it was', async () => {
    mount();
    await selectNode(state.nodes.find((n) => n.id === 'pg'));
    expect($('drawer-badge').textContent).toBe('Page');
  });
  it('shows a kind that is markup as text', async () => {
    mount();
    await selectNode(state.nodes.find((n) => n.id === 'svc-odd'));
    expect($('drawer-badge').textContent).toBe('Service · <img src=x onerror=alert(1)>');
    expect($('drawer-badge').querySelector('img')).toBeNull();
    expect($('drawer-panel') ? $('drawer-panel').querySelector('img') : null).toBeNull();
  });
});
