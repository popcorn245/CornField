// @vitest-environment happy-dom
/**
 * The map's styling from the theme (docs/theming.md, "The map"): the `--corn-map-*` tokens read from the computed style, what they do to
 * a scene, to the halos and mark rings, to both renderers (a recording 2d context, a fake GL) and to the label layer, how they follow a
 * theme change, the icons per node kind, and `theme.pixelated`. `auto` keeps today's colours exactly.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fakeGl, fakeCanvas, callsOf, recordingCtx } from './fake-gl.js';
// @ts-expect-error plain JS modules, no declarations
import * as M from '../../explorer/map-style.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene, looksFor, HALO, MARK } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { lightColor } from '../../explorer/theme-model.js';
// @ts-expect-error plain JS modules, no declarations
import { createCanvas2dRenderer } from '../../explorer/renderer-canvas2d.js';
// @ts-expect-error plain JS modules, no declarations
import { createWebglRenderer, packNodes, packIcons, packStrokes, styleTables, EXTRA_PASSES, NODE_STRIDE, ICON_STRIDE, RING_STRIDE } from '../../explorer/renderer-webgl.js';
// @ts-expect-error plain JS modules, no declarations
import { chooseLabels, createLabelLayer } from '../../explorer/labels.js';

afterEach(() => M.resetMapStyle());

// ---------------------------------------------------------------------------
//  A small map, built by the real buildScene
// ---------------------------------------------------------------------------
const node = (id, type, x, y, extra = {}) => ({ id, type, x, y, r: 20, color: '#336699', label: id, ...extra });
const nodes = [
  node('root', 'root', 0, 0), node('app', 'app', 100, 0), node('page', 'page', 200, 0), node('tbl', 'table', 300, 0),
  node('cl', 'external', 400, 0, { kind: 'saas' }), node('web', 'external', 500, 0, { kind: 'web' }), node('rm', 'room', 600, 0),
];
const edges = [
  { from: 'root', to: 'app' }, { from: 'app', to: 'page' }, { from: 'app', to: 'tbl', kind: 'flow', flow: 'api', status: 'live', label: 'calls the API' },
  { from: 'page', to: 'tbl', dashed: true },
];
const layers = { app: true, page: true, table: true, external: true, room: true, house: true, cloud: true, web: true, flow: true };
const mk = (extra = {}) => ({ nodes, edges, view: 'orbit', flow: null, rings: { rings: [], clusters: [] }, selectedNode: null, searchQuery: '', isFreeform: false, activeLayers: layers, scenario: null, sceneVersion: 1, theme: 'dark', ...extra });
const dark = () => buildScene(mk());
const light = () => buildScene(mk({ theme: 'light' }));
const byId = (scene, id) => scene.nodes.find((n) => n.id === id);

let versions = 0;
/** A style as map-style.js hands it, from a map of token values */
function styleOf(values = {}, extra = {}) {
  const v = {};
  for (const [k, c] of Object.entries(values)) v[k] = M.cssColor(c);
  const plain = !Object.keys(v).length && !(extra.icons && extra.icons.anyReady()) && !extra.font && extra.edgeWidth == null && extra.glow == null && extra.labelMin == null;
  return { version: ++versions, values: v, strokeWidth: M.DEFAULT_STROKE_WIDTH, icons: null, pixelated: false, plain, ...extra };
}
/** A reader of custom properties from a table, as getComputedStyle(...).getPropertyValue would give them */
const reader = (table) => (name) => table[name] ?? '';

describe('the tokens', () => {
  it('lists a fill token for every node kind and every group, one outline and one label, and a token per edge kind and state', () => {
    expect(M.MAP_KINDS).toEqual(expect.arrayContaining(['root', 'app', 'page', 'table', 'external', 'room', 'persona']));
    expect(M.nodeToken('page')).toBe('--corn-map-node-page');
    expect(M.groupToken('cloud')).toBe('--corn-map-group-cloud');
    expect(M.MAP_COLOR_TOKENS).toEqual(expect.arrayContaining(['--corn-map-stroke', '--corn-map-label', '--corn-map-label-halo']));
    expect(M.MAP_COLOR_TOKENS.filter((t) => /-(stroke|label)$/.test(t) && t !== '--corn-map-stroke' && t !== '--corn-map-label')).toEqual([]);
    expect(M.mapTokenNames()).toHaveLength(M.MAP_KINDS.length + M.MAP_GROUPS.length + M.MAP_EDGE_KINDS.length + 2 + 2 + 8 + 4 + 1 + 2);
    expect(M.mapTokenNames()).toHaveLength(69); // 64 colours, widths and marks (the glyph ink and the review's grey among them), and the font, the edge width, the glow, the smallest label and the grey's opacity
    expect(M.edgeToken('runs-on')).toBe('--corn-map-edge-runs-on');
    expect(M.MAP_COLOR_TOKENS).toEqual(expect.arrayContaining(['--corn-map-added', '--corn-map-changed', '--corn-map-removed', '--corn-map-edit', '--corn-map-selected', '--corn-map-match', '--corn-map-lit']));
    expect(new Set(M.mapTokenNames()).size).toBe(M.mapTokenNames().length);
    expect(M.mapTokenNames()).toEqual(expect.arrayContaining(['--corn-map-stroke-width', '--corn-map-collision']));
  });

  it('knows a group for every node a scene draws, and an edge kind for every kind it draws', () => {
    const scene = dark();
    for (const n of scene.nodes) if (!['root', 'core', 'store'].includes(n.type)) expect(M.MAP_GROUPS, n.id).toContain(n.group); // the root, the core and the store have a kind but no layer of their own
    for (const e of scene.edges) expect(M.MAP_EDGE_KINDS, e.key).toContain(e.kind);
    expect([byId(scene, 'cl').group, byId(scene, 'web').group, byId(scene, 'rm').group, byId(scene, 'tbl').group]).toEqual(['cloud', 'web', 'house', 'table']);
  });

  it('reads auto, nothing and a non-colour as no override, and a colour as it is written', () => {
    for (const v of ['auto', ' AUTO ', '', '   ', undefined, 'not-a-colour', '12px', 'rgb(1.2.3, 0, 0)', 'rgb(300, 0, 0)', 'rgba(1, 2, 3, 5)', '#12345']) expect(M.cssColor(v), String(v)).toBeNull(); // no browser to read them here: none is passed on as written
    expect(M.cssColor('#e53e3e')).toBe('#e53e3e');
    expect(M.cssColor(' rgb(1, 2, 3) ')).toBe('rgb(1, 2, 3)');
    expect(M.cssColor('rgba(1, 2, 3, 0.5)')).toBe('rgba(1, 2, 3, 0.5)');
    expect(M.cssColor('transparent')).toBe('rgba(0, 0, 0, 0)');
  });

  it('keeps the original alpha of a faint thing when it is given a colour', () => {
    expect(M.withAlphaOf('#ff0000', '#ffffff')).toBe('#ff0000');
    expect(M.withAlphaOf('#ff0000', 'rgba(255, 255, 255, 0.16)')).toBe('rgba(255, 0, 0, 0.16)');
    expect(M.withAlphaOf('rgba(255, 0, 0, 0.5)', 'rgba(255, 255, 255, 0.5)')).toBe('rgba(255, 0, 0, 0.25)');
  });

  it('reads only the colour tokens that are set, and the width as a length', () => {
    const got = M.readMapTokens(reader({ '--corn-map-node-app': '#112233', '--corn-map-node-page': 'auto', '--corn-map-edge-flow': 'oops', '--corn-map-stroke-width': '3px' }));
    expect(got).toEqual({ values: { '--corn-map-node-app': '#112233' }, strokeWidth: 3, font: null, edgeWidth: null, glow: null, labelMin: null, greyAlpha: null });
    expect(M.readMapTokens(reader({ '--corn-map-stroke-width': 'wide' })).strokeWidth).toBe(M.DEFAULT_STROKE_WIDTH);
    expect(M.readMapTokens(reader({ '--corn-map-stroke-width': '0' })).strokeWidth).toBe(0);
  });
});

describe('the smallest label (spec 0008 D2, --corn-map-label-min)', () => {
  const read = (v) => M.readMapTokens(reader(v));

  it('reads a length in px from 9 to 24, and auto, a typo, a wrong unit or anything under 9px as nothing (the map then uses 11px)', () => {
    expect(read({ '--corn-map-label-min': '13px' }).labelMin).toBe(13);
    expect(read({ '--corn-map-label-min': '9' }).labelMin).toBe(9);
    expect(read({ '--corn-map-label-min': '24px' }).labelMin).toBe(24);
    for (const v of ['auto', '', 'big', '8px', '8.9px', '0', '-12px', '25px', '1em', '99px']) expect(read({ '--corn-map-label-min': v }).labelMin, v).toBeNull();
  });

  it('puts it on the scene, where the label layer reads it, and draws nothing different at auto', () => {
    const scene = buildScene(mk());
    expect(M.styledScene(scene, styleOf({}, { labelMin: null }))).toBe(scene);
    expect(M.styledScene(scene, styleOf({}, { labelMin: 14 })).labelMin).toBe(14);
  });
});

describe('the font, the edge width and the glow (CF review F51)', () => {
  const read = (v) => M.readMapTokens(reader(v));

  it('reads a font list as a list of families, and refuses anything that could carry script or a URL', () => {
    expect(M.cssFontList('"Nunito", ui-rounded, sans-serif')).toBe('"Nunito", ui-rounded, sans-serif');
    expect(M.cssFontList("Pixelify Sans, 'Courier New', monospace")).toBe('"Pixelify Sans", "Courier New", monospace');
    // cornfield's own --corn-font, as a theme gets it from var(--corn-font): the system keywords stay bare
    expect(M.cssFontList('system-ui, -apple-system, "Segoe UI", Roboto, sans-serif')).toBe('system-ui, -apple-system, "Segoe UI", "Roboto", sans-serif');
    expect(M.cssFontList('BlinkMacSystemFont, sans-serif')).toBe('BlinkMacSystemFont, sans-serif');
    expect(M.cssFontList('--x, sans-serif')).toBeNull();
    for (const v of ['auto', ' AUTO ', '', '   ', undefined, 'url(https://evil.example/x.woff)', '"A"; background: url(x)', 'Nunito, var(--x)', 'a{b}', '"x"</style><script>', 'Nunito\\9', 'expression(alert(1))', '@import "x"', 'a/b', 'x:y', '12px Nunito', 'Nunito,', ',', 'x'.repeat(201), Array.from({ length: 9 }, (_, i) => `f${i}`).join(', ')]) {
      expect(M.cssFontList(v), String(v)).toBeNull();
    }
  });

  it('reads the edge width as a length in px and the glow as a factor, and auto, a typo or a wrong unit as nothing', () => {
    expect(read({ '--corn-map-edge-width': '3px', '--corn-map-glow': '0' })).toMatchObject({ edgeWidth: 3, glow: 0 });
    expect(read({ '--corn-map-edge-width': '2', '--corn-map-glow': '1.5' })).toMatchObject({ edgeWidth: 2, glow: 1.5 });
    expect(read({ '--corn-map-glow': '0px' }).glow).toBe(0);
    for (const v of ['auto', '', 'thick', '2em', '-1px', '0', '0px', '40px', '1e3']) expect(read({ '--corn-map-edge-width': v }).edgeWidth, v).toBeNull();
    for (const v of ['auto', '', 'big', '8px', '-1', '99']) expect(read({ '--corn-map-glow': v }).glow, v).toBeNull();
    expect(read({ '--corn-map-font': '"Nunito", sans-serif' }).font).toBe('"Nunito", sans-serif');
    expect(read({ '--corn-map-font': 'url(x)' }).font).toBeNull();
  });

  it('draws nothing different at auto, and scales the line and the glow when set', () => {
    const scene = dark();
    expect(M.styledScene(scene, styleOf({}, { edgeWidth: null, glow: null, font: null }))).toBe(scene);
    const out = M.styledScene(scene, styleOf({}, { edgeWidth: 3.2, glow: 0 }));
    expect(out).not.toBe(scene);
    scene.edges.forEach((e, i) => { expect(out.edges[i].width).toBeCloseTo(e.width * 2); expect(out.edges[i].glow).toBe(0); });
    scene.nodes.forEach((n, i) => expect(out.nodes[i].glow).toBe(0));
    const twice = M.styledScene(scene, styleOf({}, { glow: 2 }));
    scene.nodes.forEach((n, i) => expect(twice.nodes[i].glow).toBe(n.glow * 2));
    expect(M.styledScene(scene, styleOf({}, { font: '"Nunito", sans-serif' })).labelFont).toBe('"Nunito", sans-serif');
    expect(M.styledScene(scene, styleOf({}, { glow: 1 })).labelFont).toBeUndefined();
  });
});

describe('styledScene', () => {
  it('hands back the scene itself when nothing is set: auto is today\'s map', () => {
    const scene = dark();
    expect(M.styledScene(scene, styleOf())).toBe(scene);
    expect(M.styledScene(scene, M.getMapStyle())).toBe(scene);
    expect(M.looksWith(looksFor('dark'), styleOf())).toBe(looksFor('dark'));
  });

  it('colours a kind\'s fill, and nothing else', () => {
    const scene = dark();
    const out = M.styledScene(scene, styleOf({ '--corn-map-node-page': '#e53e3e' }));
    const page = byId(out, 'page');
    expect(page.color).toBe('#e53e3e');
    expect(page.labelColor).toBe(byId(scene, 'page').labelColor);
    expect(page.stroke).toBeUndefined();
    expect(byId(out, 'app')).toBe(byId(scene, 'app'));
    expect(out.edges).toEqual(scene.edges);
    expect(scene.nodes.find((n) => n.id === 'page').color).toBe('#336699'); // the scene is not touched
    expect(out.version).toBe(scene.version);
  });

  it('colours by group, a kind winning over its group, and tells cloud from web and a room from the house', () => {
    const out = M.styledScene(dark(), styleOf({
      '--corn-map-group-cloud': '#111111', '--corn-map-group-house': '#222222', '--corn-map-node-external': '#333333', '--corn-map-node-room': '#444444',
    }));
    // external: the kind (333) beats the group (111) for the cloud node; the web node has no group token, so the kind's applies
    expect([byId(out, 'cl').color, byId(out, 'web').color]).toEqual(['#333333', '#333333']);
    expect(byId(out, 'rm').color).toBe('#444444');
    const groups = M.styledScene(dark(), styleOf({ '--corn-map-group-cloud': '#111111', '--corn-map-group-house': '#222222' }));
    expect([byId(groups, 'cl').color, byId(groups, 'web').color, byId(groups, 'rm').color]).toEqual(['#111111', '#336699', '#222222']);
  });

  it('uses the token as written in the light theme too, where auto is the deepened colour', () => {
    const auto = byId(light(), 'page').color;
    expect(auto).toBe(lightColor('#336699'));
    const out = M.styledScene(light(), styleOf({ '--corn-map-node-page': '#e53e3e' }));
    expect(byId(out, 'page').color).toBe('#e53e3e');
    expect(byId(M.styledScene(light(), styleOf({ '--corn-map-node-app': '#e53e3e' })), 'page').color).toBe(auto);
  });

  it('keeps a dimmed node dim: the label token keeps the alpha it had, a stroke is drawn at the node\'s alpha', () => {
    const scene = buildScene(mk({ selectedNode: nodes[1] }));
    const dim = scene.nodes.find((n) => !n.connected);
    expect(dim.labelColor).toBe('rgba(255, 255, 255, 0.3)');
    const out = M.styledScene(scene, styleOf({ '--corn-map-label': '#00ff00' }));
    expect(byId(out, dim.id).labelColor).toBe('rgba(0, 255, 0, 0.3)');
    expect(byId(out, dim.id).alpha).toBe(dim.alpha);
  });

  it('leaves alone the node and the edge a painter coloured (an outage, a verdict, a pull request)', () => {
    const scene = dark();
    scene.nodes.find((n) => n.id === 'page').color = '#f87171';
    scene.painted = { nodes: new Set(['page']), edges: new Set([scene.edges[0].key]) };
    const out = M.styledScene(scene, styleOf({ '--corn-map-node-page': '#00ff00', '--corn-map-edge-ownership': '#00ff00', '--corn-map-stroke': '#0000ff' }));
    expect(byId(out, 'page').color).toBe('#f87171');
    expect(byId(out, 'page').stroke).toBeTruthy(); // an outline is not a state colour
    expect(out.edges[0]).toBe(scene.edges[0]);
    expect(out.edges[1].color).toBe('rgba(0, 255, 0, 0.16)');
  });

  it('marks the nodes a real painter coloured, in buildScene', () => {
    const scene = buildScene(mk({ forgeLit: { changed: new Set(['tbl']), failing: new Set(['tbl']) } }));
    expect([...scene.painted.nodes]).toContain('tbl');
    expect(buildScene(mk()).painted.nodes.size).toBe(0);
  });

  it('draws no outline when the width is 0, and uses the width token otherwise', () => {
    const t = { '--corn-map-stroke': '#000000' };
    expect(byId(M.styledScene(dark(), styleOf(t, { strokeWidth: 0 })), 'page').stroke).toBeUndefined();
    expect(byId(M.styledScene(dark(), styleOf(t, { strokeWidth: 4 })), 'page').stroke).toEqual({ color: '#000000', width: 4 });
  });

  it('colours an edge kind, keeping a faint line faint, and the lit links with --corn-map-lit', () => {
    const out = M.styledScene(dark(), styleOf({ '--corn-map-edge-flow': '#ecc94b', '--corn-map-edge-ownership': '#ff0000' }));
    expect(out.edges.find((e) => e.kind === 'flow').color).toBe('#ecc94b');
    expect(out.edges.find((e) => e.kind === 'ownership').color).toBe('rgba(255, 0, 0, 0.16)');
    expect(out.edges.find((e) => e.kind === 'usage').color).toBe(dark().edges.find((e) => e.kind === 'usage').color);

    const lit = buildScene(mk({ selectedNode: nodes[1] }));
    const own = lit.edges.find((e) => e.from === 'root');
    expect([own.color, own.glow]).toEqual(['#ffffff', 10]);
    const styled = M.styledScene(lit, styleOf({ '--corn-map-lit': '#fbd38d', '--corn-map-edge-ownership': '#ff0000' }));
    const e = styled.edges.find((x) => x.from === 'root');
    expect([e.color, e.glowColor]).toEqual(['#fbd38d', 'rgba(251, 211, 141, 0.8)']);
    // without the lit token the kind's colour reaches the lit line too
    expect(M.styledScene(lit, styleOf({ '--corn-map-edge-ownership': '#ff0000' })).edges.find((x) => x.from === 'root').color).toBe('#ff0000');
  });

  it('gives a marked edge its diff colour, and not its kind\'s', () => {
    const scene = dark();
    scene.edges[0] = { ...scene.edges[0], mark: 'added', color: MARK.added.color, glowColor: null };
    const out = M.styledScene(scene, styleOf({ '--corn-map-added': '#48bb78', '--corn-map-edge-ownership': '#ff0000' }));
    expect(out.edges[0].color).toBe('#48bb78');
    expect(M.styledScene(scene, styleOf({ '--corn-map-edge-ownership': '#ff0000' })).edges[0]).toBe(scene.edges[0]);
  });

  it('is the same object for the same scene and style, a new one for a new style', () => {
    const scene = dark();
    const a = styleOf({ '--corn-map-node-app': '#ff0000' });
    expect(M.styledScene(scene, a)).toBe(M.styledScene(scene, a));
    expect(M.styledScene(scene, { ...a, version: 2 })).not.toBe(M.styledScene(scene, a));
  });
});

describe('looksWith: the halos and the diff marks', () => {
  it('replaces the selected and search halos, keeping the translucent disc translucent', () => {
    const looks = M.looksWith(looksFor('dark'), styleOf({ '--corn-map-selected': '#63b3ed', '--corn-map-match': '#ff00ff' }));
    expect(looks.halo.selected.ring).toBe('#63b3ed');
    expect(looks.halo.selected.fill).toBe('rgba(99, 179, 237, 0.55)');
    expect(looks.halo.match.ring).toBe('#ff00ff');
    expect(looks.halo.match.fill).toBe('rgba(255, 0, 255, 0.4)');
    expect(looks.halo.child).toBe(HALO.child);
    expect(looks.mark).toEqual(looksFor('dark').mark);
  });

  it('replaces each diff mark\'s ring colour, in both themes, and no other part of the look', () => {
    for (const theme of ['dark', 'light']) {
      const base = looksFor(theme);
      const looks = M.looksWith(base, styleOf({ '--corn-map-added': '#48bb78', '--corn-map-removed': '#f56565', '--corn-map-edit': '#805ad5', '--corn-map-changed': '#ecc94b' }));
      expect([looks.mark.added.color, looks.mark.changed.color, looks.mark.removed.color, looks.mark.edit.color]).toEqual(['#48bb78', '#ecc94b', '#f56565', '#805ad5']);
      expect(looks.mark.added.ringDash).toEqual(base.mark.added.ringDash);
      expect(looks.core).toBe(base.core);
      expect(looks.labelOutline).toBe(base.labelOutline);
    }
  });
});

describe('the style in force: read on load and again on a theme change', () => {
  it('starts as nothing set, and reads the tokens it is given', () => {
    expect(M.getMapStyle().plain).toBe(true);
    expect(M.refreshMapStyle(reader({ '--corn-map-node-app': '#112233' }))).toBe(true);
    const style = M.getMapStyle();
    expect([style.plain, style.values['--corn-map-node-app']]).toEqual([false, '#112233']);
  });

  it('says whether anything changed, and tells the listeners only then', () => {
    const seen = [];
    const stop = M.onMapStyleChange((s) => seen.push(s.version));
    const read = reader({ '--corn-map-node-app': '#112233' });
    expect(M.refreshMapStyle(read)).toBe(true);
    expect(M.refreshMapStyle(read)).toBe(false);
    expect(M.refreshMapStyle(reader({ '--corn-map-node-app': '#445566' }))).toBe(true);
    expect(M.refreshMapStyle(reader({}))).toBe(true);
    expect(M.getMapStyle().plain).toBe(true);
    stop();
    M.refreshMapStyle(read);
    expect(seen.length).toBe(3);
  });

  it('follows the page: the computed token differs by data-theme and data-theme-name, and a watcher reads it again', async () => {
    const style = document.createElement('style');
    style.textContent = [
      ':root { --corn-map-node-app: auto; --corn-map-added: #00aa00; }',
      ':root[data-theme="light"] { --corn-map-node-app: #aa0000; }',
      ':root[data-theme-name="night"] { --corn-map-node-app: #0000aa; }',
    ].join('\n');
    document.head.appendChild(style);
    const root = document.documentElement;
    root.removeAttribute('data-theme');
    root.removeAttribute('data-theme-name');
    try {
      const seen = [];
      M.onMapStyleChange((s) => seen.push({ ...s.values }));
      const stop = M.watchMapStyle(document);
      expect(M.getMapStyle().values).toEqual({ '--corn-map-added': '#00aa00' });
      root.setAttribute('data-theme', 'light');
      await new Promise((r) => setTimeout(r, 0));
      expect(M.getMapStyle().values['--corn-map-node-app']).toBe('#aa0000');
      root.setAttribute('data-theme-name', 'night');
      await new Promise((r) => setTimeout(r, 0));
      expect(M.getMapStyle().values['--corn-map-node-app']).toBe('#0000aa');
      root.removeAttribute('data-theme-name');
      root.setAttribute('data-theme', 'dark');
      await new Promise((r) => setTimeout(r, 0));
      expect(M.getMapStyle().values).toEqual({ '--corn-map-added': '#00aa00' });
      expect(seen.length).toBeGreaterThanOrEqual(4);
      stop();
      root.setAttribute('data-theme', 'light');
      await new Promise((r) => setTimeout(r, 0));
      expect(M.getMapStyle().values['--corn-map-node-app']).toBeUndefined(); // stopped
    } finally {
      style.remove();
      root.removeAttribute('data-theme');
    }
  });

  it('reads the tokens again when a stylesheet finishes loading (a named theme\'s file arrives after the first draw)', () => {
    const style = document.createElement('style');
    style.textContent = ':root { --corn-map-node-page: #123456; }';
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    const stop = M.watchMapStyle(document);
    try {
      expect(M.getMapStyle().plain).toBe(true);
      document.head.appendChild(style);
      link.dispatchEvent(new Event('load')); // not attached, so it does not reach the document: attach it first
      document.head.appendChild(link);
      link.dispatchEvent(new Event('load'));
      expect(M.getMapStyle().values['--corn-map-node-page']).toBe('#123456');
    } finally { stop(); style.remove(); link.remove(); }
  });
});

describe('the Canvas 2D renderer', () => {
  const canvasOf = (ctx) => ({ width: 0, height: 0, getContext: () => ctx });
  const draw = (scene, style) => {
    const ctx = recordingCtx();
    const r = createCanvas2dRenderer(canvasOf(ctx), { mapStyle: () => style });
    r.resize(800, 600, 1);
    ctx.log.length = 0;
    r.draw(scene, { x: 0, y: 0, zoom: 1 }, 0);
    return ctx.log;
  };
  const fills = (log) => log.filter((c) => c[0] === 'set:fillStyle').map((c) => c[1]);
  const strokes = (log) => log.filter((c) => c[0] === 'set:strokeStyle').map((c) => c[1]);

  it('draws exactly what it drew before when nothing is set (auto)', () => {
    const scene = dark();
    const ctx = recordingCtx();
    const r = createCanvas2dRenderer(canvasOf(ctx)); // no style handed in: the page's, which has nothing set
    r.resize(800, 600, 1);
    ctx.log.length = 0;
    r.draw(scene, { x: 0, y: 0, zoom: 1 }, 0);
    expect(ctx.log).toEqual(draw(scene, styleOf()));
    expect(fills(ctx.log)).toContain('#336699');
    expect(ctx.log.some((c) => c[0] === 'drawImage')).toBe(false);
  });

  it('follows a token override in both themes', () => {
    const style = styleOf({ '--corn-map-node-page': '#e53e3e' });
    for (const scene of [dark(), light()]) {
      const log = draw(scene, style);
      expect(fills(log)).toContain('#e53e3e');
      // the node, and its glow's soft disc when it glows (a halo in its own colour: renderer-canvas2d.js, no shadowBlur)
      expect(fills(log).filter((f) => f === '#e53e3e').length).toBe(scene.nodes.some((n) => n.glow) ? 2 : 1);
    }
    expect(fills(draw(light(), styleOf()))).toContain(lightColor('#336699'));
  });

  it('follows a change of the style between two draws of the same scene', () => {
    const scene = dark();
    let style = styleOf();
    const ctx = recordingCtx();
    const r = createCanvas2dRenderer(canvasOf(ctx), { mapStyle: () => style });
    r.resize(800, 600, 1);
    r.draw(scene, { x: 0, y: 0, zoom: 1 }, 0);
    expect(fills(ctx.log)).not.toContain('#e53e3e');
    style = styleOf({ '--corn-map-node-page': '#e53e3e' }, {});
    ctx.log.length = 0;
    r.draw(scene, { x: 0, y: 0, zoom: 1 }, 0);
    expect(fills(ctx.log)).toContain('#e53e3e');
  });

  it('draws the diff, selected and search rings in their tokens', () => {
    const style = styleOf({ '--corn-map-selected': '#63b3ed', '--corn-map-added': '#48bb78', '--corn-map-match': '#ff00ff' });
    const scene = dark();
    scene.nodes[1] = { ...scene.nodes[1], halo: 'selected', mark: 'added' };
    scene.nodes[2] = { ...scene.nodes[2], halo: 'match' };
    const s = strokes(draw(scene, style));
    expect(s).toEqual(expect.arrayContaining(['#63b3ed', '#48bb78', '#ff00ff']));
    const base = strokes(draw(scene, styleOf()));
    expect(base).toEqual(expect.arrayContaining([HALO.selected.ring, MARK.added.color, HALO.match.ring]));
  });

  it('draws every node\'s outline just inside its edge, in the token\'s colour and width', () => {
    const style = styleOf({ '--corn-map-stroke': '#101010' }, { strokeWidth: 3 });
    const log = draw(dark(), style);
    const ats = log.map((c, i) => (c[0] === 'set:strokeStyle' && c[1] === '#101010' ? i : -1)).filter((i) => i >= 0);
    expect(ats).toHaveLength(dark().nodes.length);
    const page = byId(dark(), 'page');
    expect(ats.some((at) => log.slice(at - 3, at).some((c) => c[0] === 'arc' && c[1] === page.x && c[3] === page.r - 1.5))).toBe(true);
    for (const at of ats) expect(log[at + 1]).toEqual(['set:lineWidth', 3]);
    expect(strokes(draw(dark(), styleOf()))).not.toContain('#101010');
  });

  it('draws the icon of a kind inside the node, and nothing for a kind without one or one that has not loaded', () => {
    const image = { naturalWidth: 16 };
    const icons = { get: (k) => (k === 'page' ? image : null), anyReady: () => true };
    const log = draw(dark(), styleOf({}, { icons }));
    const calls = log.filter((c) => c[0] === 'drawImage');
    const page = byId(dark(), 'page');
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 2)).toEqual(['drawImage', image]);
    const side = page.r * M.ICON_RATIO;
    expect(calls[0].slice(2)).toEqual([page.x - side / 2, page.y - side / 2, side, side]);
    // a style whose icons have not loaded draws no image, and is otherwise the plain picture
    const loading = { get: () => null, anyReady: () => false };
    expect(draw(dark(), styleOf({}, { icons: loading }))).toEqual(draw(dark(), styleOf()));
  });

  it('samples without smoothing when the theme is pixelated, and smooths otherwise', () => {
    const icons = { get: () => ({}), anyReady: () => true };
    const flagBefore = (log) => log.slice(0, log.findIndex((c) => c[0] === 'drawImage')).filter((c) => c[0] === 'set:imageSmoothingEnabled').pop();
    expect(flagBefore(draw(dark(), styleOf({}, { icons, pixelated: true })))).toEqual(['set:imageSmoothingEnabled', false]);
    expect(flagBefore(draw(dark(), styleOf({}, { icons, pixelated: false })))).toEqual(['set:imageSmoothingEnabled', true]);
  });
});

describe('the WebGL renderer', () => {
  const make = (style) => {
    const gl = fakeGl();
    const holder = { style };
    const r = createWebglRenderer(fakeCanvas({ webgl2: gl }), { mapStyle: () => holder.style });
    r.resize(800, 600, 2);
    return { gl, r, holder };
  };
  const camera = { x: 0, y: 0, zoom: 1 };
  const nodeRow = (scene, id) => Array.from(packNodes(scene).data.slice(scene.nodes.findIndex((n) => n.id === id) * NODE_STRIDE, (scene.nodes.findIndex((n) => n.id === id) + 1) * NODE_STRIDE));
  const nodeUploads = (gl) => callsOf(gl, 'bufferData').filter((c) => c[2] instanceof Float32Array && c[2].length % NODE_STRIDE === 0 && c[2].length > 0);

  it('packs a node\'s token colour into its row, and a plain scene exactly as before', () => {
    const scene = dark();
    const out = M.styledScene(scene, styleOf({ '--corn-map-node-page': '#ff0000' }));
    const row = nodeRow(out, 'page');
    expect(row.slice(4, 7)).toEqual([1, 0, 0]);
    expect(nodeRow(M.styledScene(scene, styleOf()), 'page')).toEqual(nodeRow(scene, 'page'));
  });

  it('draws a plain scene with the passes it always had, and builds no program for an outline or an icon', () => {
    const { gl, r } = make(styleOf());
    r.draw(dark(), camera, 0);
    expect(callsOf(gl, 'createProgram')).toHaveLength(8);
    expect(callsOf(gl, 'createTexture')).toHaveLength(0);
  });

  it('draws again with the new colours when the style changes, on the same scene', () => {
    const scene = dark();
    const { gl, r, holder } = make(styleOf());
    r.draw(scene, camera, 0);
    const before = nodeUploads(gl).length;
    r.draw(scene, camera, 16);
    expect(nodeUploads(gl).length).toBe(before); // a frame uploads nothing
    holder.style = styleOf({ '--corn-map-node-page': '#ff0000' }, {});
    r.draw(scene, camera, 32);
    const last = nodeUploads(gl).pop()[2];
    const i = scene.nodes.findIndex((n) => n.id === 'page');
    expect(Array.from(last.slice(i * NODE_STRIDE + 4, i * NODE_STRIDE + 7))).toEqual([1, 0, 0]);
  });

  it('puts the theme\'s halo and mark colours in the style tables, and sets them again when the style changes', () => {
    const plain = styleTables('dark');
    const themed = styleTables('dark', styleOf({ '--corn-map-selected': '#00ff00', '--corn-map-added': '#0000ff' }));
    expect(Array.from(themed.haloRing.slice(4, 7))).toEqual([0, 1, 0]);
    expect(Array.from(themed.markColor.slice(4, 7))).toEqual([0, 0, 1]);
    expect(Array.from(plain.haloRing.slice(4, 7))).not.toEqual([0, 1, 0]);
    expect(styleTables('dark', styleOf())).toEqual(plain);

    const { gl, r, holder } = make(styleOf());
    r.draw(dark(), camera, 0);
    const sets = () => callsOf(gl, 'uniform4fv').filter((c) => c[1].uniform === 'u_haloRing').length;
    const n = sets();
    r.draw(dark(), camera, 16);
    expect(sets()).toBe(n);
    holder.style = styleOf({ '--corn-map-selected': '#00ff00' }, {});
    r.draw(dark(), camera, 32);
    expect(sets()).toBe(n + 1);
    expect(Array.from(callsOf(gl, 'uniform4fv').filter((c) => c[1].uniform === 'u_haloRing').pop()[2].slice(4, 7))).toEqual([0, 1, 0]);
  });

  it('packs an outline for every node as a ring row inside the node\'s edge, at its alpha', () => {
    const scene = buildScene(mk({ selectedNode: nodes[1] }));
    const out = M.styledScene(scene, styleOf({ '--corn-map-stroke': '#0000ff' }, { strokeWidth: 4 }));
    const p = packStrokes(out);
    expect(p.count).toBe(out.nodes.length);
    const i = out.nodes.findIndex((n) => n.id === 'page');
    const page = out.nodes[i];
    expect(Array.from(p.data.slice(i * RING_STRIDE, i * RING_STRIDE + 4))).toEqual([page.x, page.y, page.r - 2, 4]);
    expect(p.data[i * RING_STRIDE + 7]).toBeCloseTo(page.alpha, 6);
    const dim = out.nodes.findIndex((n) => !n.connected);
    expect(p.data[dim * RING_STRIDE + 7]).toBeCloseTo(out.nodes[dim].alpha, 6);
    expect(packStrokes(scene).count).toBe(0);
  });

  it('draws the outlines and the icons after the nodes, one call each, building those programs only then', () => {
    const image = { naturalWidth: 8 };
    const icons = { get: (k) => (k === 'page' || k === 'app' ? image : null), anyReady: () => true };
    const { gl, r } = make(styleOf({ '--corn-map-stroke': '#0000ff' }, { icons }));
    r.draw(dark(), camera, 0);
    expect(callsOf(gl, 'createProgram')).toHaveLength(10);
    const draws = callsOf(gl, 'drawArraysInstanced').map((c) => c.slice(1));
    const tail = draws.slice(-4);
    expect(tail[0]).toEqual(['TRIANGLE_STRIP', 0, 4, 7]); // the nodes
    expect(tail[1]).toEqual(['TRIANGLE_STRIP', 0, 4, 7]); // every node's outline
    expect(tail.slice(2)).toEqual([['TRIANGLE_STRIP', 0, 4, 1], ['TRIANGLE_STRIP', 0, 4, 1]]); // one icon draw per kind
    expect(callsOf(gl, 'createTexture')).toHaveLength(2);
    expect(callsOf(gl, 'texImage2D').every((c) => c[6] === image)).toBe(true);
  });

  it('groups the icons by kind, in scene order, and skips a kind whose image has not loaded', () => {
    const scene = M.styledScene(buildScene(mk()), styleOf({}, { icons: { get: () => ({}), anyReady: () => true } }));
    scene.nodes.forEach((n) => { n.icon = n.type === 'page' || n.type === 'table' ? n.type : null; });
    const p = packIcons(scene, (k) => k !== 'table' && !k.startsWith('glyph:')); // the type glyphs have their own test (glyphs.test.js)
    expect(p.groups).toEqual([{ kind: 'page', first: 0, count: 1, minR: 20, maxR: 20 }]);
    expect(p.stride).toBe(ICON_STRIDE);
    const page = byId(scene, 'page');
    expect(Array.from(p.data)).toEqual([page.x, page.y, Math.fround(page.r * M.ICON_RATIO), page.alpha]);
    expect(Object.keys(EXTRA_PASSES)).toEqual(['strokes', 'icons']);
  });

  it('samples icons with NEAREST when the theme is pixelated, and smoothly otherwise', () => {
    const icons = { get: () => ({}), anyReady: () => true };
    const filters = (gl) => callsOf(gl, 'texParameteri').filter((c) => c[2] === 'TEXTURE_MIN_FILTER' || c[2] === 'TEXTURE_MAG_FILTER').map((c) => [c[2], c[3]]);
    const crisp = make(styleOf({}, { icons, pixelated: true }));
    crisp.r.draw(dark(), camera, 0);
    expect(filters(crisp.gl).length).toBeGreaterThan(0);
    expect(filters(crisp.gl).every(([, v]) => v === 'NEAREST')).toBe(true);
    const smooth = make(styleOf({}, { icons, pixelated: false }));
    smooth.r.draw(dark(), camera, 0);
    expect(filters(smooth.gl).some(([, v]) => v === 'NEAREST')).toBe(false);
    expect(filters(smooth.gl)).toContainEqual(['TEXTURE_MAG_FILTER', 'LINEAR']);
  });

  it('samples again when only the pixelated flag changes, without uploading the image twice', () => {
    const image = {};
    const icons = { get: () => image, anyReady: () => true };
    const { gl, r, holder } = make(styleOf({}, { icons, pixelated: false }));
    const scene = dark();
    r.draw(scene, camera, 0);
    const uploaded = callsOf(gl, 'texImage2D').length;
    holder.style = styleOf({}, { icons, pixelated: true });
    r.draw(scene, camera, 16);
    expect(callsOf(gl, 'texImage2D')).toHaveLength(uploaded);
    expect(callsOf(gl, 'texParameteri').filter((c) => c[2] === 'TEXTURE_MIN_FILTER').pop()[3]).toBe('NEAREST');
  });

  it('deletes every icon texture when the icons are replaced or dropped, so none outlives its store', () => {
    const first = { get: (k) => (k === 'page' || k === 'app' ? {} : null), anyReady: () => true };
    const { gl, r, holder } = make(styleOf({}, { icons: first }));
    r.draw(dark(), camera, 0);
    const made = callsOf(gl, 'createTexture').map((c) => c.length);
    expect(made).toHaveLength(2);
    const second = { get: (k) => (k === 'page' ? {} : null), anyReady: () => true };
    holder.style = styleOf({}, { icons: second });
    r.draw(dark(), camera, 16);
    expect(callsOf(gl, 'deleteTexture')).toHaveLength(2); // the app's too, though no new icon replaces it
    expect(callsOf(gl, 'createTexture')).toHaveLength(3);
    holder.style = styleOf();
    r.draw(dark(), camera, 32);
    expect(callsOf(gl, 'deleteTexture')).toHaveLength(3);
  });

  it('draws without an icon for a kind that has none, and recovers its textures after the context is restored', () => {
    const icons = { get: (k) => (k === 'page' ? {} : null), anyReady: () => true };
    const canvas = fakeCanvas({ webgl2: fakeGl() });
    const gl = canvas.getContext('webgl2');
    const r = createWebglRenderer(canvas, { mapStyle: () => styleOf({}, { icons }) });
    r.resize(800, 600, 2);
    r.draw(dark(), camera, 0);
    expect(callsOf(gl, 'createTexture')).toHaveLength(1);
    canvas.fire('webglcontextlost');
    r.draw(dark(), camera, 16);
    canvas.fire('webglcontextrestored');
    expect(callsOf(gl, 'createTexture')).toHaveLength(2);
  });
});

/** A 2d context that records, and measures text (the label layer asks) */
function measuringCtx() {
  const log = [];
  return new Proxy({}, {
    get: (_t, key) => (key === 'log' ? log : key === 'measureText' ? (text) => ({ width: text.length * 6 }) : (...args) => { log.push([key, ...args]); }),
    set: (_t, key, value) => { log.push([`set:${key}`, value]); return true; },
  });
}

describe('the label layer', () => {
  it('draws a node\'s label in the token\'s colour', () => {
    const ctx = measuringCtx();
    const layer = createLabelLayer({ width: 0, height: 0, getContext: () => ctx }, { mapStyle: () => styleOf({ '--corn-map-label': '#ffeeaa' }) });
    layer.resize(800, 600, 1);
    ctx.log.length = 0;
    expect(layer.draw(buildScene(mk()), { x: 0, y: 0, zoom: 1 })).toBe(true);
    const fillsOf = ctx.log.filter((c) => c[0] === 'set:fillStyle').map((c) => c[1]);
    expect(fillsOf).toContain('#ffeeaa');
    const labels = chooseLabels(M.styledScene(buildScene(mk()), styleOf({ '--corn-map-label': '#ffeeaa' })), { x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 });
    expect(labels.find((l) => l.id === 'app').color).toBe('#ffeeaa');
    expect(labels.find((l) => l.id === 'page').color).toBe('#ffeeaa'); // one label colour for the whole map
  });

  it('draws the outline under every label in --corn-map-label-halo, at the widths it had, and the ground\'s own at auto', () => {
    const view = [{ x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 }];
    const plain = chooseLabels(buildScene(mk()), ...view).find((l) => l.kind === 'node').outline;
    expect(plain).toEqual(looksFor('dark').labelOutline.node);
    const out = M.styledScene(buildScene(mk()), styleOf({ '--corn-map-label-halo': 'rgba(0, 0, 0, 0.5)' }));
    expect(out.labelOutline).toEqual({ node: { color: 'rgba(0, 0, 0, 0.5)', width: looksFor('dark').labelOutline.node.width }, edge: { color: 'rgba(0, 0, 0, 0.5)', width: looksFor('dark').labelOutline.edge.width } });
    expect(chooseLabels(out, ...view).find((l) => l.kind === 'node').outline.color).toBe('rgba(0, 0, 0, 0.5)');
    const lightOut = M.styledScene(light(), styleOf({ '--corn-map-label-halo': '#000000' }));
    expect(lightOut.labelOutline.node.width).toBe(looksFor('light').labelOutline.node.width);
  });

  it('draws again when the style changes, and not when nothing did', () => {
    let style = styleOf();
    const ctx = measuringCtx();
    const layer = createLabelLayer({ width: 0, height: 0, getContext: () => ctx }, { mapStyle: () => style });
    layer.resize(800, 600, 1);
    const scene = buildScene(mk());
    const cam = { x: 0, y: 0, zoom: 1 };
    expect(layer.draw(scene, cam)).toBe(true);
    expect(layer.draw(scene, cam)).toBe(false);
    style = styleOf({ '--corn-map-label': '#ffeeaa' }, {});
    expect(layer.draw(scene, cam)).toBe(true);
    expect(layer.draw(scene, cam)).toBe(false);
  });
});

describe('icons per node kind', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('loads one image per kind and hands it out once it has loaded', async () => {
    const changes = vi.fn();
    const store = M.createIconStore({ app: '/cornfield/theme/assets/a.svg', page: '/cornfield/theme/assets/p.png' }, { load: async (url) => ({ url }), onChange: changes, warn: () => {} });
    expect(store.kinds).toEqual(['app', 'page']);
    expect(store.get('app')).toBeNull();
    expect([store.status('app'), store.status('table')]).toEqual(['loading', 'none']);
    await tick();
    expect(store.get('app')).toEqual({ url: '/cornfield/theme/assets/a.svg' });
    expect(store.get('page')).toEqual({ url: '/cornfield/theme/assets/p.png' });
    expect(store.get('table')).toBeNull();
    expect(store.anyReady()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('falls back cleanly: a missing or broken file is no icon for its kind, one warning, and the others still load', async () => {
    const warn = vi.fn();
    const load = async (url) => { if (url.includes('gone')) throw new Error('did not load'); return { url }; };
    const store = M.createIconStore({ app: '/cornfield/theme/assets/gone.svg', page: '/cornfield/theme/assets/p.png' }, { load, warn });
    await tick();
    expect([store.get('app'), store.status('app')]).toEqual([null, 'failed']);
    expect(store.get('page')).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/Map icon for "app" not drawn: did not load/);
  });

  it('never loads from anywhere but the theme assets route, or for something that is not a node kind', async () => {
    const load = vi.fn(async (url) => ({ url }));
    const store = M.createIconStore({ app: 'https://evil.example/a.svg', page: '/elsewhere/p.png', table: '/cornfield/theme/assets/../../x.png', widget: '/cornfield/theme/assets/w.png', tool: '/cornfield/theme/assets/ok.png', root: 5 }, { load });
    await tick();
    expect(store.kinds).toEqual(['tool']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('wires the config\'s icons into the style: not plain once one has loaded, pixelated and <html data-pixelated> from the flag', async () => {
    const seen = [];
    const stop = M.onMapStyleChange((s) => seen.push(s.plain));
    M.applyMapTheme(document, { icons: { app: '/cornfield/theme/assets/a.svg' }, pixelated: true }, { load: async (url) => ({ url }) });
    expect(M.getMapStyle().pixelated).toBe(true);
    expect(M.getMapStyle().plain).toBe(true); // still loading: the picture is the plain one
    expect(document.documentElement.hasAttribute('data-pixelated')).toBe(true);
    await tick();
    expect(M.getMapStyle().plain).toBe(false);
    expect(M.getMapStyle().icons.get('app')).toEqual({ url: '/cornfield/theme/assets/a.svg' });
    expect(seen.at(-1)).toBe(false);
    M.applyMapTheme(document, null);
    expect(document.documentElement.hasAttribute('data-pixelated')).toBe(false);
    expect([M.getMapStyle().icons, M.getMapStyle().pixelated, M.getMapStyle().plain]).toEqual([null, false, true]);
    stop();
  });

  it('puts an icon on a node of the kind in the styled scene, and none on the others', () => {
    const icons = { get: (k) => (k === 'page' ? {} : null), anyReady: () => true };
    const out = M.styledScene(dark(), styleOf({}, { icons }));
    expect(out.nodes.filter((n) => n.icon).map((n) => n.id)).toEqual(['page']);
    expect(byId(out, 'page').icon).toBe('page');
  });
});
