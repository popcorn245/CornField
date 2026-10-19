/**
 * @vitest-environment node
 *
 * Light mode, the pure half (MAP-01): theme-model.js derives every colour of the light picture from the dark
 * one, and both renderers and the label layer take their own looks for the scene's ground. No GPU: the WebGL
 * renderer runs on the fake GL and the tests read the uniforms it sets.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXPLORER, loadSample } from '../helpers.js';
import { fakeGl, fakeCanvas, callsOf, recordingCtx } from './fake-gl.js';
import {
  LIGHT_GROUND, DARK_GROUND, LINE_GAIN, MIN_CONTRAST, contrast, lightColor, lightenScene, nextChoice, parseColor, resolveTheme, themeChoiceFrom, themed, themeWords, toHsl,
  // @ts-expect-error plain JS modules, no declarations
} from '../../explorer/theme-model.js';
// @ts-expect-error plain JS modules, no declarations
import { CORE_COLOR, HALO, LABEL_OUTLINE, MARK, buildScene, looksFor } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { FLOW_STYLES } from '../../explorer/flows.js';
// @ts-expect-error plain JS modules, no declarations
import { LAYER_DEFS } from '../../explorer/layers.js';
// @ts-expect-error plain JS modules, no declarations
import { createWebglRenderer, styleTables, MARK_CODE } from '../../explorer/renderer-webgl.js';
// @ts-expect-error plain JS modules, no declarations
import { createCanvas2dRenderer } from '../../explorer/renderer-canvas2d.js';
// @ts-expect-error plain JS modules, no declarations
import { chooseLabels } from '../../explorer/labels.js';
// @ts-expect-error plain JS modules, no declarations
import { NODE_THEMES } from '../../core/schema.js';
// @ts-expect-error plain JS modules, no declarations
import { VERDICT_COLOR } from '../../explorer/check-model.js';
// @ts-expect-error plain JS modules, no declarations
import { WHEN_STYLES } from '../../explorer/cloud-model.js';

/** Contrast of a colour drawn at its alpha over the light ground (what the eye gets) */
function onLight(css) {
  const [r, g, b, a] = parseColor(css);
  const [R, G, B] = parseColor(LIGHT_GROUND);
  const mix = [r, g, b].map((v, i) => Math.round(v * a + [R, G, B][i] * (1 - a)));
  return contrast(`rgb(${mix.join(', ')})`, LIGHT_GROUND);
}
const chroma = (css) => { const [r, g, b] = parseColor(css); return (Math.max(r, g, b) - Math.min(r, g, b)) / 255; };
const hueGap = (a, b) => { const d = Math.abs(toHsl(parseColor(a))[0] - toHsl(parseColor(b))[0]) % 360; return Math.min(d, 360 - d); };

/** Every colour the dark map draws in: the node types, the layers, the flows, the marks, the halos, the outage and verdict painters */
const PALETTE = [
  ...Object.values(NODE_THEMES).map((t) => t.color),
  ...LAYER_DEFS.map((l) => l.color),
  ...Object.values(FLOW_STYLES).map((s) => s.color),
  ...Object.values(MARK).map((m) => m.color),
  HALO.selected.ring, HALO.match.ring,
  ...Object.values(VERDICT_COLOR), ...Object.values(WHEN_STYLES).map((w) => w.color),
];

describe('which theme', () => {
  it('follows the system unless the choice says light or dark', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('nonsense', true)).toBe('light');
  });

  it('takes ?theme= over the stored choice, and ignores what it cannot read', () => {
    expect(themeChoiceFrom('?theme=light', 'dark')).toEqual({ choice: 'light', fromAddress: true });
    expect(themeChoiceFrom('?renderer=canvas2d', 'dark')).toEqual({ choice: 'dark', fromAddress: false });
    expect(themeChoiceFrom('?theme=purple', 'nope')).toEqual({ choice: 'system', fromAddress: false });
    expect(themeChoiceFrom('', null)).toEqual({ choice: 'system', fromAddress: false });
  });

  it('steps system, light, dark, system on the toggle, and says what it is in words', () => {
    expect([nextChoice('system'), nextChoice('light'), nextChoice('dark')]).toEqual(['light', 'dark', 'system']);
    expect(themeWords('system', 'dark')).toBe('Theme: follows the system (dark now)');
    expect(themeWords('light', 'light')).toBe('Theme: light');
  });
});

describe('lightColor: the light palette derived from the dark one', () => {
  it('gives every colour of the map at least 3:1 on the light ground (WCAG 1.4.11)', () => {
    for (const c of PALETTE) expect(contrast(lightColor(c), LIGHT_GROUND), `${c} -> ${lightColor(c)}`).toBeGreaterThanOrEqual(3);
  });

  it('gives text at least 4.5:1 (WCAG 1.4.3)', () => {
    for (const c of [...PALETTE, '#f8fafc', '#e2e8f0', '#94a3b8']) expect(contrast(lightColor(c, 'text'), LIGHT_GROUND), c).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps each colour\'s hue: a deepened colour, not an inverted one', () => {
    for (const c of PALETTE.filter((c) => chroma(c) >= 0.16)) expect(hueGap(c, lightColor(c)), `${c} -> ${lightColor(c)}`).toBeLessThan(3);
  });

  it('leaves alone what already stands out on light, and only darkens what does not', () => {
    expect(lightColor('#4f46e5')).toBe('#4f46e5');
    for (const c of PALETTE) expect(contrast(lightColor(c), LIGHT_GROUND)).toBeGreaterThanOrEqual(Math.min(contrast(c, LIGHT_GROUND), MIN_CONTRAST.mark) - 0.01);
  });

  it('mirrors a light grey to ink and keeps its alpha; keeps a dark grey; keeps transparent', () => {
    const ink = lightColor('#f8fafc', 'text');
    expect(contrast(ink, LIGHT_GROUND)).toBeGreaterThan(12);
    expect(lightColor('rgba(255, 255, 255, 0.16)')).toMatch(/^rgba\(28, 28, 28, 0\.16\)$/);
    expect(lightColor('#050608')).toBe('#050608'); // an outage's down node: black on either ground
    expect(lightColor('rgba(0, 0, 0, 0)')).toBe('rgba(0, 0, 0, 0)');
    expect(lightColor('linear-gradient(red, blue)')).toBe('linear-gradient(red, blue)');
  });

  it('is the identity in the dark theme', () => {
    for (const c of PALETTE) expect(themed(c, 'dark')).toBe(c);
    expect(themed('#fde047', 'light')).toBe(lightColor('#fde047'));
  });

  it('keeps the dark palette as it was: the dark map\'s colours stand out on the dark ground', () => {
    // a guard for the derivation's starting point, not a change: the node types read on the dark ground
    for (const c of Object.values(NODE_THEMES).map((t) => t.color)) expect(contrast(c, DARK_GROUND), c).toBeGreaterThanOrEqual(2.5);
  });
});

// ---------------------------------------------------------------------------
//  A whole scene
// ---------------------------------------------------------------------------
function sampleState(extra = {}) {
  const map = loadSample();
  const nodes = map.nodes.map((n, i) => ({ ...n, x: (i % 12) * 60, y: Math.floor(i / 12) * 60, r: n.r || 18, color: n.color || NODE_THEMES[n.type]?.color || '#94a3b8' }));
  return {
    nodes, edges: map.edges,
    view: 'orbit', flow: null, rings: { rings: [{ x: 0, y: 0, r: 200 }], clusters: [] },
    camera: { x: 0, y: 0, zoom: 1 }, width: 800, height: 600,
    selectedNode: null, searchQuery: '', isFreeform: false,
    activeLayers: { app: true, pkg: true, page: true, atom: true, molecule: true, token: true, tool: true, flow: true, table: true, rom: true, service: true, cloud: true, web: true, stack: true },
    scenario: null, sceneVersion: 1,
    ...extra,
  };
}

describe('buildScene in the light theme', () => {
  const dark = buildScene(sampleState());
  const light = buildScene(sampleState({ theme: 'light' }));

  it('says which ground it is for', () => {
    expect(dark.theme).toBe('dark');
    expect(light.theme).toBe('light');
  });

  it('draws the same picture: the same nodes and edges in the same places, only the colours differ', () => {
    const shape = (s) => ({ nodes: s.nodes.map((n) => [n.id, n.x, n.y, n.r, n.halo, n.label]), edges: s.edges.map((e) => [e.key, e.x1, e.y1, e.x2, e.y2, e.width, e.dash]) });
    expect(shape(light)).toEqual(shape(dark));
    expect(light.nodes.some((n, i) => n.color !== dark.nodes[i].color)).toBe(true);
  });

  it('leaves the dark scene exactly as it was before light mode', () => {
    expect(dark.nodes.every((n) => n.labelColor === '#f8fafc' || n.labelColor === 'rgba(255, 255, 255, 0.3)')).toBe(true);
    expect(dark.decor.grid.color).toBe('rgba(255, 255, 255, 0.035)');
  });

  it('gives every node 3:1 and every label 4.5:1 on the light ground', () => {
    expect(light.nodes.length).toBeGreaterThan(20);
    for (const n of light.nodes) {
      expect(contrast(n.color, LIGHT_GROUND), `${n.id} ${n.color}`).toBeGreaterThanOrEqual(3);
      if (n.connected) expect(contrast(n.labelColor, LIGHT_GROUND), n.id).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('draws every line darker than the ground, and a little stronger than on dark (LINE_GAIN)', () => {
    expect(light.edges.length).toBeGreaterThan(10);
    light.edges.forEach((e, i) => {
      expect(onLight(e.color), `${e.key} ${e.color}`).toBeGreaterThan(1.1);
      if (dark.edges[i].alpha < 1) expect(e.alpha).toBeCloseTo(Math.min(1, dark.edges[i].alpha * LINE_GAIN), 5);
    });
  });

  it('themes the background: grid, rings, and a selection\'s edge labels', () => {
    expect(light.decor.grid.color).toBe('rgba(28, 28, 28, 0.035)');
    expect(light.decor.rings[0].color).not.toBe(dark.decor.rings[0].color);
    const api = sampleState({ theme: 'light' });
    const sel = api.nodes.find((n) => api.edges.some((e) => e.label && e.from === n.id && ['flow', 'calls', 'writes'].includes(e.kind)));
    const withSel = buildScene({ ...api, selectedNode: sel });
    const labelled = withSel.edges.filter((e) => e.label);
    expect(labelled.length).toBeGreaterThan(0);
    for (const e of labelled) expect(contrast(e.label.color, LIGHT_GROUND)).toBeGreaterThanOrEqual(4.5);
  });

  it('themes what a painter set after the scene was built (the House view\'s bands are lanes)', () => {
    const scene = { nodes: [], edges: [], preset: false, decor: { grid: null, rings: [], lanes: [{ x: 0, y: 0, w: 1, h: 1, radius: 1, fill: 'rgba(66, 153, 225, 0.05)', stroke: 'rgba(66, 153, 225, 0.2)', strokeWidth: 1, title: { text: 'Cloud', color: '#e2e8f0' }, note: { text: 'n', color: '#94a3b8' }, arrow: null }] } };
    lightenScene(scene);
    expect(contrast(scene.decor.lanes[0].title.color, LIGHT_GROUND)).toBeGreaterThan(10);
    expect(contrast(scene.decor.lanes[0].note.color, LIGHT_GROUND)).toBeGreaterThanOrEqual(4.5);
    expect(scene.decor.lanes[0].arrow).toBe(null);
  });
});

describe('the looks a renderer draws itself', () => {
  it('are the scene.js constants on dark, and derived from them on light', () => {
    expect(looksFor('dark')).toMatchObject({ halo: HALO, mark: MARK, core: CORE_COLOR, labelOutline: LABEL_OUTLINE });
    expect(looksFor(undefined)).toBe(looksFor('dark'));
    const light = looksFor('light');
    for (const k of Object.keys(MARK)) {
      expect(light.mark[k].color).toBe(lightColor(MARK[k].color));
      expect({ ...light.mark[k], color: 0 }).toEqual({ ...MARK[k], color: 0 }); // only the colour moves
    }
    expect(light.halo.selected.ring).toBe(lightColor(HALO.selected.ring));
    expect(light.core).toBe('#ffffff'); // the core sits on the node, not on the ground
    expect(contrast(light.labelOutline.node.color, LIGHT_GROUND)).toBeLessThan(1.05); // the ground under a dark label
  });

  it('a proposal mark is the same colour on the edge (the scene) as on the ring (the renderer)', () => {
    const st = sampleState({ theme: 'light' });
    const scene = buildScene(st);
    const markEdge = { ...scene.edges[0], mark: 'added', color: MARK.added.color };
    lightenScene({ nodes: [], edges: [markEdge], decor: { grid: null, rings: [], lanes: [] } });
    expect(markEdge.color).toBe(looksFor('light').mark.added.color);
  });

  it('the WebGL style tables follow the theme; the renderer sets them again when the scene\'s theme changes', () => {
    const dark = styleTables('dark');
    const light = styleTables('light');
    expect([...light.markColor.slice(MARK_CODE.added * 4, MARK_CODE.added * 4 + 3)].map((v) => Math.round(v * 255))).toEqual(parseColor(lightColor(MARK.added.color)).slice(0, 3));
    expect([...dark.markColor]).not.toEqual([...light.markColor]);
    expect([...dark.core]).toEqual([...light.core]);

    const gl = fakeGl();
    const r = createWebglRenderer(fakeCanvas({ webgl2: gl }), {});
    r.resize(800, 600, 1);
    const markSets = () => callsOf(gl, 'uniform4fv').filter((c) => c[1].uniform === 'u_markColor').map((c) => [...c[2]]);
    expect(markSets()).toEqual([[...dark.markColor]]);
    const scene = (theme, version) => ({ nodes: [], edges: [], decor: { grid: null, rings: [], lanes: [] }, preset: false, version, theme });
    r.draw(scene('dark', 1), { x: 0, y: 0, zoom: 1 }, 0);
    expect(markSets()).toHaveLength(1); // same theme: nothing set again
    r.draw(scene('light', 2), { x: 0, y: 0, zoom: 1 }, 0);
    expect(markSets().at(-1)).toEqual([...light.markColor]);
    r.draw(scene('light', 3), { x: 0, y: 0, zoom: 1 }, 0);
    expect(markSets()).toHaveLength(2);
    r.draw(scene('dark', 4), { x: 0, y: 0, zoom: 1 }, 0);
    expect(markSets().at(-1)).toEqual([...dark.markColor]);
  });

  it('the Canvas 2D renderer rings a marked node in the light mark colour', () => {
    const ctx = recordingCtx();
    const r = createCanvas2dRenderer({ width: 0, height: 0, getContext: () => ctx });
    r.resize(400, 300, 1);
    const n = { id: 'a', type: 'page', x: 0, y: 0, r: 10, color: '#0792d0', alpha: 1, glow: 0, halo: 'selected', mark: 'changed' };
    r.draw({ nodes: [n], edges: [], decor: { grid: null, rings: [], lanes: [] }, preset: false, version: 1, theme: 'light' }, { x: 0, y: 0, zoom: 1 }, 0);
    const strokes = ctx.log.filter((c) => c[0] === 'set:strokeStyle').map((c) => c[1]);
    expect(strokes).toContain(looksFor('light').mark.changed.color);
    expect(strokes).toContain(looksFor('light').halo.selected.ring);
    expect(strokes).not.toContain(MARK.changed.color);
  });

  it('the label layer outlines labels in the ground\'s colour', () => {
    const scene = (theme) => ({ nodes: [{ id: 'a', type: 'app', x: 0, y: 0, r: 10, label: 'a', labelSize: 12, labelBold: true, labelColor: '#000', labelAlpha: 1, labelKeep: true, alpha: 1 }], edges: [], decor: { grid: null, rings: [], lanes: [] }, preset: false, version: 1, theme });
    const outline = (theme) => chooseLabels(scene(theme), { x: 0, y: 0, zoom: 1 }, { width: 400, height: 300 }).find((t) => t.kind === 'node').outline;
    expect(outline('dark')).toEqual(LABEL_OUTLINE.node);
    expect(outline('light')).toEqual(looksFor('light').labelOutline.node);
  });
});

// ---------------------------------------------------------------------------
//  The stylesheet
// ---------------------------------------------------------------------------
describe('explorer.css: the light tokens', () => {
  const cssText = fs.readFileSync(path.join(EXPLORER, 'explorer.css'), 'utf8');
  const block = (selector) => {
    const at = cssText.indexOf(`${selector} {`);
    return cssText.slice(at, cssText.indexOf('}', at));
  };
  const tokens = (text) => new Map([...text.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const dark = tokens(block(':root'));
  const light = tokens(block(':root[data-theme="light"]'));

  it('sets a light value for every colour token of the dark theme', () => {
    const colourTokens = [...dark.keys()].filter((k) => /^(--hx-|--surface|--border|--glass-shadow|--bg-gradient|--gradient)/.test(k) && !/font|blur/.test(k));
    for (const k of colourTokens) expect(light.has(k), k).toBe(true);
  });

  it('gives the text tokens at least 4.5:1 on the light ground', () => {
    for (const k of ['--hx-text', '--hx-ink', '--hx-text-1', '--hx-text-2', '--hx-slate-300', '--hx-slate-400', '--hx-indigo', '--hx-emerald', '--hx-amber', '--hx-sky', '--hx-pink', '--hx-fuchsia', '--hx-red', '--hx-code', '--hx-orange-text', '--hx-teal-text', '--hx-violet-text', '--hx-green-text', '--hx-lime-text']) {
      expect(contrast(light.get(k), LIGHT_GROUND), `${k} ${light.get(k)}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(light.get(k), '#ffffff'), k).toBeGreaterThanOrEqual(4.5);
    }
    expect(light.get('--hx-bg')).toBe(LIGHT_GROUND);
  });

  it('keeps each accent\'s hue from dark to light', () => {
    for (const k of ['--hx-indigo', '--hx-emerald', '--hx-amber', '--hx-sky', '--hx-pink', '--hx-fuchsia', '--hx-red', '--hx-orange-text', '--hx-teal-text', '--hx-violet-text', '--hx-green-text']) {
      expect(hueGap(dark.get(k), light.get(k)), k).toBeLessThan(16);
    }
  });

  it('draws the legend swatches in the colour the light map draws', () => {
    for (const [when, s] of Object.entries(WHEN_STYLES)) expect(cssText).toContain(`.hx-swatch-when--${when} { color: ${lightColor(s.color)}; }`);
  });
});
