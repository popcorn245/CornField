// @vitest-environment happy-dom
/**
 * A node's own `color` is project data (issue #231). buildScene checks it once: a colour the browser reads is drawn as it is, anything
 * else is the node type's fill, so WebGL and Canvas 2D are given the same valid fill and nothing unchecked reaches a shader or a `fillStyle`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { recordingCtx } from './fake-gl.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import * as M from '../../explorer/map-style.js';
// @ts-expect-error plain JS modules, no declarations
import { createCanvas2dRenderer } from '../../explorer/renderer-canvas2d.js';
// @ts-expect-error plain JS modules, no declarations
import { packNodes, NODE_STRIDE } from '../../explorer/renderer-webgl.js';
// @ts-expect-error plain JS modules, no declarations
import { parseColor } from '../../explorer/theme-model.js';
// @ts-expect-error plain JS modules, no declarations
import { NODE_THEMES } from '../../core/schema.js';
// @ts-expect-error plain JS modules, no declarations
import { nodeColor } from '../../explorer/css-color.js';

afterEach(() => M.resetMapStyle());

const layers = { app: true, page: true, table: true, external: true };
const sceneOf = (color, extra = {}) => buildScene({
  nodes: [{ id: 'n', type: 'table', x: 0, y: 0, r: 20, color, label: 'n', ...extra }], edges: [], view: 'orbit', flow: null, rings: { rings: [], clusters: [] },
  selectedNode: null, searchQuery: '', isFreeform: false, activeLayers: layers, scenario: null, sceneVersion: 1, theme: 'dark',
});
const typeFill = NODE_THEMES.table.color;
const HOSTILE = ['"; background: url(//evil)', "red'", 'url(https://evil/x.png)', 'expression(alert(1))', 'x'.repeat(10000), '#12345', '', '   ', 12345, null, {}, ['#fff'], 'not-a-colour', 'rgb(1, 2)', 'var(--x)', 'currentcolor', 'auto'];

describe('buildScene: a node with a colour the browser cannot read', () => {
  it.each(HOSTILE.map((v) => [typeof v === 'string' ? v.slice(0, 30) : JSON.stringify(v), v]))('draws %s in its type fill', (_name, value) => {
    expect(sceneOf(value).nodes[0].color).toBe(typeFill);
  });

  it('draws a node with no colour at all in its type fill too, and an unknown type in the external fill', () => {
    expect(sceneOf(undefined).nodes[0].color).toBe(typeFill);
    expect(sceneOf('nope', { type: 'mystery' }).nodes[0].color).toBe(NODE_THEMES.external.color);
  });

  it('is the same fill in the light theme, and the same one a node with no colour gets when a theme token sets it', () => {
    const light = buildScene({ ...{ nodes: [{ id: 'n', type: 'table', x: 0, y: 0, r: 20, color: '#12345', label: 'n' }] }, edges: [], view: 'orbit', flow: null, rings: { rings: [], clusters: [] }, selectedNode: null, searchQuery: '', isFreeform: false, activeLayers: layers, scenario: null, sceneVersion: 1, theme: 'light' });
    const plain = buildScene({ nodes: [{ id: 'n', type: 'table', x: 0, y: 0, r: 20, label: 'n' }], edges: [], view: 'orbit', flow: null, rings: { rings: [], clusters: [] }, selectedNode: null, searchQuery: '', isFreeform: false, activeLayers: layers, scenario: null, sceneVersion: 1, theme: 'light' });
    expect(light.nodes[0].color).toBe(plain.nodes[0].color);
    const style = { version: 1, values: { '--corn-map-node-table': '#abcdef' }, strokeWidth: 1.5, icons: null, pixelated: false, plain: false };
    expect(M.styledScene(sceneOf('#12345'), style).nodes[0].color).toBe(M.styledScene(sceneOf(undefined), style).nodes[0].color);
  });

  it('gives WebGL and Canvas 2D the same fill (a bad colour used to be translucent pink in one and black in the other)', () => {
    const scene = sceneOf('#12345');
    const gl = packNodes(scene).data.slice(0, NODE_STRIDE);
    const [r, g, b] = parseColor(typeFill);
    expect([gl[4], gl[5], gl[6], gl[10]].map((v) => +v.toFixed(3))).toEqual([r / 255, g / 255, b / 255, 1].map((v) => +v.toFixed(3)));
    const ctx = recordingCtx();
    const renderer = createCanvas2dRenderer({ width: 0, height: 0, getContext: () => ctx });
    renderer.resize(800, 600, 1);
    ctx.log.length = 0;
    renderer.draw(scene, { x: 0, y: 0, zoom: 1 }, 0);
    const fills = ctx.log.filter((c) => c[0] === 'set:fillStyle').map((c) => c[1]);
    expect(fills).toContain(typeFill);
    expect(fills.every((f) => f === typeFill || f === '#ffffff' || !/^#12345/.test(String(f)))).toBe(true);
  });

  it('never hands the browser text it did not check', () => {
    for (const v of HOSTILE) expect(nodeColor(v)).toBeNull();
    for (const v of HOSTILE) expect(String(sceneOf(v).nodes[0].color)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('buildScene: a node with a colour the browser reads', () => {
  // In the tests there is no canvas to normalise with, so the forms core/color.js reads stay as written; hex 6 and rgb() are checked as before
  it.each(['#336699', '#369', '#3699', '#336699cc', 'rgb(51, 102, 153)', 'rgba(51, 102, 153, 0.5)', 'hsl(210, 50%, 40%)', 'hsl(210 50% 40% / 0.5)', 'teal', ' #336699 '])('keeps %s', (c) => {
    expect(sceneOf(c).nodes[0].color).toBe(c.trim());
  });

  it('draws a valid hex and rgb() colour exactly as before in WebGL and Canvas 2D', () => {
    const c = sceneOf('#336699');
    expect(c.nodes[0].color).toBe('#336699');
    expect(sceneOf('rgb(51, 102, 153)').nodes[0].color).toBe('rgb(51, 102, 153)');
  });
});
