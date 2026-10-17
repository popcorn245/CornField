// @vitest-environment happy-dom
/**
 * The panel of a self-hosted container (spec 0031 section 3, CLOUD-03): what the API uses it for
 * (`summary`), who calls it, and the webhook its stack sends, where the external's panel said the same.
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
import { LAYER_DEFS } from '../../explorer/layers.js';
// @ts-expect-error plain JS modules, no declarations
import { selectNode } from '../../explorer/panels.js';

const page = fs.readFileSync(path.resolve(__dirname, '../../explorer/index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page) [1].replace(/<script[\s\S]*?<\/script>/g, '');

const node = (id        , type        , extra         = {}) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, ...extra });
const SUMMARY = 'Self-hosted Nextcloud (cloud.example.test): calendars, budget and files.';
const nodes = [
  node('root', 'root'),
  node('app-api', 'app', { label: 'api.example.test' }),
  node('stack-cloud-stack', 'stack', { label: 'cloud-stack', services: [] }),
  node('container-nextcloud', 'container', { label: 'nextcloud', stack: 'cloud-stack', service: 'nextcloud', ports: [], selfHosted: true, summary: SUMMARY, desc: 'Container nextcloud: service nextcloud of cloud-stack.' }),
  node('container-nextcloud-webhooks', 'container', { label: 'nextcloud-webhooks', stack: 'cloud-stack', service: 'nextcloud-webhooks', ports: [] }),
  node('container-nextcloud-db', 'container', { label: 'nextcloud-db', stack: 'cloud-stack', service: 'nextcloud-db', ports: [] }),
  node('svc-lib-caldav', 'service', { label: 'lib/caldav.ts', kind: 'client' }),
  node('page-files', 'page', { label: '/api/v1/files' }),
  node('page-webhooks-nextcloud', 'page', { label: '/api/v1/webhooks/nextcloud' }),
];
const edges = [
  { from: 'root', to: 'app-api' }, { from: 'root', to: 'stack-cloud-stack' },
  { from: 'stack-cloud-stack', to: 'container-nextcloud' }, { from: 'stack-cloud-stack', to: 'container-nextcloud-webhooks' }, { from: 'stack-cloud-stack', to: 'container-nextcloud-db' },
  { from: 'app-api', to: 'svc-lib-caldav' }, { from: 'app-api', to: 'page-files' }, { from: 'app-api', to: 'page-webhooks-nextcloud' },
  { from: 'svc-lib-caldav', to: 'container-nextcloud', kind: 'calls', status: 'live', label: 'caldav' },
  { from: 'page-files', to: 'container-nextcloud', kind: 'calls', status: 'live', label: 'calls' },
  { from: 'container-nextcloud-webhooks', to: 'page-webhooks-nextcloud', kind: 'delivers', status: 'live', label: 'nextcloud webhook' },
];

function mount() {
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
  for (const l of LAYER_DEFS) state.activeLayers[l.key] = true;
  state.baseNodes = nodes.map((n) => ({ ...n }));
  state.baseEdges = edges;
  render.resize();
  setMap(state.baseNodes.map((n     ) => ({ ...n })), state.baseEdges);
}

afterEach(() => { document.body.innerHTML = ''; });

describe('a self-hosted container\'s panel', () => {
  it('says what the API uses it for, who calls it, and the webhook its stack sends', async () => {
    mount();
    await selectNode(state.nodes.find((n     ) => n.id === 'container-nextcloud'));
    const meta = document.getElementById('drawer-meta-list') .textContent ;
    expect(meta).toContain('Self-hosted:');
    expect(meta).toContain(SUMMARY);
    expect(meta).toMatch(/Called by services:\s*←\s*lib\/caldav\.ts · caldav/);
    expect(meta).toMatch(/Called by endpoints:\s*←\s*\/api\/v1\/files/);
    expect(meta).toMatch(/Pushes to \(webhook\):\s*→\s*\/api\/v1\/webhooks\/nextcloud\s*from nextcloud-webhooks/);
  });

  it('leaves any other container as it was', async () => {
    mount();
    await selectNode(state.nodes.find((n     ) => n.id === 'container-nextcloud-db'));
    expect(document.getElementById('drawer-meta-list') .textContent).not.toContain('Self-hosted:');
  });
});
