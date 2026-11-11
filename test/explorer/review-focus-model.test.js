// @vitest-environment happy-dom
/**
 * The review narrows the map to the change (issue #232), as a model: which layers a proposal touches, the layers a review draws (the viewer's state
 * with the untouched off, plus what the reviewer and a scenario turned on), that the viewer's own state is never written, and the greying of what
 * the change does not involve (a greyed node has no hue; glyphs, silhouettes and labels stay; the same colours in both renderers).
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { touchedLayerKeys, reviewLayers, layersOf, layerOn, reviewHides, greying, rowKeyOf } from '../../explorer/layer-model.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene, isNodeVisible, GREY_ALPHA, PROPOSAL_DIM_ALPHA } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { styledScene, greyOf } from '../../explorer/map-style.js';
// @ts-expect-error plain JS modules, no declarations
import { parseColor, LIGHT_GROUND, DARK_GROUND, lightColor } from '../../explorer/theme-model.js';
// @ts-expect-error plain JS modules, no declarations
import { contrast } from '../../core/color.js';
// @ts-expect-error plain JS modules, no declarations
import { NODE_THEMES } from '../../core/schema.js';
// @ts-expect-error plain JS modules, no declarations
import { GREY_MIN_RATIO, DIFF_LABEL_ALPHA } from '../../explorer/diff-marks.js';
// @ts-expect-error plain JS modules, no declarations
import { makeBig } from '../fixtures/big/make.js';
// @ts-expect-error plain JS modules, no declarations
import { applyProposal } from '../../core/proposal.js';

const node = (id, type, extra = {}) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, ...extra });
const own = (from, to, extra = {}) => ({ from, to, ...extra });
const LAYERS = { app: true, pkg: true, page: true, atom: true, molecule: true, token: true, tool: true, flow: true, table: true, rom: true, service: true, cloud: true, web: true, stack: false, machine: false, container: false, device: false, house: false, persona: false };

/** A small map: a root, an app with two pages, a table, a service, an outside system; the proposal changes a page and adds a table edge */
const nodes = () => [
  node('root', 'root'), node('app1', 'app'), node('p1', 'page', { mark: 'changed' }), node('p2', 'page'),
  node('t1', 'table'), node('s1', 'service'), node('x1', 'external', { kind: 'cloud' }), node('k1', 'store'), node('m1', 'machine'),
];
const edges = () => [own('root', 'app1'), own('app1', 'p1'), own('app1', 'p2'), { from: 'p1', to: 't1', kind: 'reads' }, { from: 's1', to: 'x1', kind: 'calls' }];

const stateOf = (extra = {}) => ({
  nodes: nodes(), edges: edges(), view: 'orbit', flow: null, projectLayers: [], layerOrder: [], layerDefaults: {},
  rings: { rings: [], clusters: [] }, camera: { x: 0, y: 0, zoom: 1 }, width: 800, height: 600, selectedNode: null, searchQuery: '', isFreeform: false,
  activeLayers: { ...LAYERS }, scenario: null, sceneVersion: 1, theme: 'dark',
  proposal: { title: 'p' }, proposalView: 'diff', review: { whole: false, manual: {}, step: {}, rev: 0 },
  ...extra,
});

describe('touchedLayerKeys', () => {
  const rowOf = (n) => rowKeyOf({ projectLayers: [], edges: [] }, n);
  it('holds the layer of a node the proposal marks, whichever the mark (added, changed, removed, a what-if edit)', () => {
    for (const mark of ['added', 'changed', 'removed', 'edit']) {
      const ns = [node('root', 'root'), node('a', 'service', { mark }), node('b', 'page')];
      expect([...touchedLayerKeys({ nodes: ns, edges: [], rowOf })], mark).toEqual(['service']);
    }
  });
  it('holds the layers of both ends of a changed edge and no other', () => {
    const ns = [node('root', 'root'), node('a', 'page'), node('b', 'table'), node('c', 'service')];
    const keys = touchedLayerKeys({ nodes: ns, edges: [{ from: 'a', to: 'b', kind: 'reads', mark: 'added' }], rowOf });
    expect([...keys].sort()).toEqual(['page', 'table']);
  });
  it('a proposal that touches nothing (no marks) touches no layer; the root has no layer', () => {
    expect(touchedLayerKeys({ nodes: [node('root', 'root'), node('a', 'page')], edges: [], rowOf }).size).toBe(0);
    expect(touchedLayerKeys({ nodes: [node('root', 'root', { mark: 'changed' })], edges: [], rowOf }).size).toBe(0);
  });
  it('an overlay follows the same rule: Data Flow when a changed edge is a flow, Runs when a touched node has a run in flight', () => {
    const ns = [node('root', 'root'), node('a', 'service', { mark: 'changed' }), node('b', 'page')];
    expect(touchedLayerKeys({ nodes: ns, edges: [], rowOf, flight: new Set(['a']) }).has('runs')).toBe(true);
    expect(touchedLayerKeys({ nodes: ns, edges: [], rowOf, flight: new Set(['b']) }).has('runs')).toBe(false);
    expect(touchedLayerKeys({ nodes: ns, edges: [{ from: 'a', to: 'b', kind: 'flow', mark: 'added' }], rowOf }).has('flow')).toBe(true);
    expect(touchedLayerKeys({ nodes: ns, edges: [{ from: 'a', to: 'b', kind: 'flow' }], rowOf }).has('flow')).toBe(false);
  });
  it('keeps what a touched layer cannot be drawn without: a store needs Data Flow, Core needs Packages', () => {
    const ns = [node('root', 'root'), node('a', 'store', { mark: 'changed' }), node('b', 'core', { mark: 'added' })];
    expect([...touchedLayerKeys({ nodes: ns, edges: [], rowOf })].sort()).toEqual(['core', 'flow', 'pkg', 'store']);
  });
});

describe('reviewLayers: what a review draws', () => {
  const universe = ['app', 'page', 'table', 'service', 'stack'];
  const touched = new Set(['page', 'stack']);
  it('is the viewer\'s state with the untouched off, and a touched layer the viewer had off on', () => {
    const out = reviewLayers({ active: { app: true, page: true, table: true, service: false, stack: false }, touched, universe, review: { whole: false, manual: {}, step: {} } });
    expect(out).toMatchObject({ app: false, page: true, table: false, service: false, stack: true });
  });
  it('lets what the reviewer turned on by hand, and what a scenario turned on, show, and never the other way round without a say', () => {
    const out = reviewLayers({ active: { app: true, page: true }, touched, universe, review: { whole: false, manual: { app: true, page: false }, step: { table: true } } });
    expect(out).toMatchObject({ app: true, page: false, table: true, service: false });
  });
  it('"the whole map" is the viewer\'s state, with only the hand and the scenario laid over it', () => {
    const active = { app: true, page: false, table: true, service: false, stack: false };
    expect(reviewLayers({ active, touched, universe, review: { whole: true, manual: {}, step: {} } })).toEqual(active);
    expect(reviewLayers({ active, touched, universe, review: { whole: true, manual: { service: true }, step: {} } }).service).toBe(true);
  });
  it('never changes the viewer\'s own object', () => {
    const active = { app: true, page: true };
    Object.freeze(active);
    expect(() => reviewLayers({ active, touched, universe, review: { whole: false, manual: {}, step: {} } })).not.toThrow();
  });
});

describe('what is drawn while a proposal is under review', () => {
  it('hides the untouched layers (starting and project layers alike) and draws the touched ones', () => {
    const s = stateOf();
    const shown = s.nodes.filter((n) => isNodeVisible(s, n)).map((n) => n.id);
    // page and table are touched (a changed page, and the end of its reads edge... only if the edge is marked): the page is
    expect(shown).toContain('p1');
    expect(shown).toContain('p2'); // the changed page's own layer stays drawn, whole
    expect(shown).not.toContain('s1');
    expect(shown).not.toContain('x1');
    expect(shown).not.toContain('app1');
    expect(shown).toContain('root');
  });
  it('writes nothing to the viewer\'s layers: they are what they were, and closing the review gives them back exactly', () => {
    const s = stateOf({ activeLayers: { ...LAYERS, page: false, odd: false, service: true } });
    const before = JSON.stringify(s.activeLayers);
    s.sceneVersion++;
    const effective = layersOf(s);
    expect(effective).not.toBe(s.activeLayers);
    expect(effective.page).toBe(true); // a proposal on a layer the viewer had off: on for the review
    expect(JSON.stringify(s.activeLayers)).toBe(before);
    s.review = null;
    expect(layersOf(s)).toBe(s.activeLayers); // closed: the viewer's own object, and the same picture
    expect(JSON.stringify(s.activeLayers)).toBe(before);
  });
  it('with no proposal open the review is ignored (the map is exactly the viewer\'s)', () => {
    const s = stateOf({ proposal: null });
    expect(layersOf(s)).toBe(s.activeLayers);
    expect(greying(s)).toBe(false);
  });
  it('a proposal that touches every layer hides nothing', () => {
    const ns = nodes().map((n) => (n.type === 'root' ? n : { ...n, mark: 'changed' }));
    const s = stateOf({ nodes: ns });
    const effective = layersOf(s);
    for (const key of ['app', 'page', 'table', 'service', 'cloud']) expect(effective[key], key).toBe(true);
    expect(['app', 'page', 'table', 'service', 'cloud'].some((k) => reviewHides(s, k))).toBe(false);
  });
  it('an edge-only change keeps the layers of its two ends', () => {
    const s = stateOf({ nodes: nodes().map((n) => ({ ...n, mark: undefined })), edges: [...edges(), { from: 'p2', to: 's1', kind: 'calls', mark: 'added' }] });
    const e = layersOf(s);
    expect(e.page).toBe(true);
    expect(e.service).toBe(true);
    expect(e.table).toBe(false);
  });
  it('a what-if edit that adds a node on a hidden layer brings its layer on', () => {
    const s = stateOf();
    s.activeLayers.machine = false;
    expect(layerOn(s, 'machine')).toBe(false);
    s.nodes = [...s.nodes, node('m2', 'machine', { mark: 'edit' })];
    s.sceneVersion++;
    expect(layerOn(s, 'machine')).toBe(true);
  });
  it('says which rows the review hid, and not those the viewer already had off or turned on by hand', () => {
    const s = stateOf();
    expect(reviewHides(s, 'service')).toBe(true);
    expect(reviewHides(s, 'stack')).toBe(false); // the viewer's own off
    expect(reviewHides(s, 'page')).toBe(false); // touched
    s.review.manual.service = true; s.review.rev++;
    expect(reviewHides(s, 'service')).toBe(false);
    expect(layerOn(s, 'service')).toBe(true);
  });
  it('a scenario\'s layers go with the scenario: clearing `step` returns the focused view', () => {
    const s = stateOf();
    s.review.step.service = true; s.review.rev++;
    expect(layerOn(s, 'service')).toBe(true);
    s.review.step = {}; s.review.rev++;
    expect(layerOn(s, 'service')).toBe(false);
  });
  it('Before and After keep the same layers hidden', () => {
    const base = stateOf();
    const keys = (view) => { const s = stateOf({ proposalView: view }); return JSON.stringify(layersOf(s)); };
    expect(keys('before')).toBe(keys('diff'));
    expect(keys('after')).toBe(keys('diff'));
    expect(base.proposalView).toBe('diff');
  });
  it('a proposal\'s own node is drawn whatever the review says about its layer (spec 0009 D3)', () => {
    const s = stateOf();
    s.review.manual.page = false; s.review.rev++;
    expect(isNodeVisible(s, s.nodes.find((n) => n.id === 'p1'))).toBe(true);
    expect(isNodeVisible(s, s.nodes.find((n) => n.id === 'p2'))).toBe(false);
  });
  it('the Flow and House views draw their own sets: the review does not change them', () => {
    const s = stateOf({ view: 'dataflow', flow: { ids: new Set(['p2']), edges: [] } });
    expect(isNodeVisible(s, s.nodes.find((n) => n.id === 'p2'))).toBe(true);
    expect(isNodeVisible(s, s.nodes.find((n) => n.id === 's1'))).toBe(false);
  });
});

describe('greying what the change does not involve', () => {
  const grey = (s) => buildScene(s);
  it('greys a visible node the change does not involve, in Before and After as in Diff, and keeps the involved ones in colour', () => {
    for (const view of ['before', 'diff', 'after']) {
      const s = stateOf({ proposalView: view });
      s.review.manual.service = true; s.review.manual.app = true; s.review.rev++;
      const scene = grey(s);
      const by = (id) => scene.nodes.find((n) => n.id === id);
      expect(by('p1').greyed, view).toBeUndefined();
      expect(by('p2').greyed, view).toBe(true);
      expect(by('app1').greyed, view).toBe(true);
      expect(by('p2').alpha).toBeLessThanOrEqual(GREY_ALPHA);
      expect(by('p1').alpha).toBe(1);
      expect(scene.greying).toBe(true);
    }
  });
  it('greys the edges that are not changed, and leaves a changed edge and its marks alone', () => {
    const s = stateOf({ nodes: nodes().map((n) => ({ ...n, mark: undefined })), edges: [...edges(), { from: 'p2', to: 's1', kind: 'calls', mark: 'added' }] });
    s.review.manual.app = true; s.review.rev++;
    const scene = grey(s);
    const marked = scene.edges.find((e) => e.mark === 'added');
    expect(marked.greyed).toBeUndefined();
    expect(scene.edges.filter((e) => e.mark === 'none').every((e) => e.greyed === true)).toBe(true);
    expect(scene.edges.filter((e) => e.greyed).every((e) => e.alpha <= PROPOSAL_DIM_ALPHA + 1e-9)).toBe(true);
  });
  it('is the old Diff view with "Show the whole map" on: dimmed, coloured, nothing greyed', () => {
    const s = stateOf();
    s.review.whole = true; s.review.manual.service = true; s.review.rev++;
    const scene = grey(s);
    expect(scene.greying).toBe(false);
    expect(scene.nodes.some((n) => n.greyed)).toBe(false);
    expect(scene.nodes.find((n) => n.id === 'p2').alpha).toBe(PROPOSAL_DIM_ALPHA);
  });
  it('without a review (a proposal opened without one) nothing is greyed and Diff dims as it did', () => {
    const s = stateOf({ review: null });
    const scene = grey(s);
    expect(scene.greying).toBe(false);
    expect(scene.nodes.find((n) => n.id === 'p2').alpha).toBe(PROPOSAL_DIM_ALPHA);
  });
  it('a greyed node has no hue once drawn: its colour is r = g = b, with no theme and with a theme\'s own fill, and its label stays readable', () => {
    const s = stateOf();
    s.review.manual.service = true; s.review.manual.app = true; s.review.rev++;
    const scene = grey(s);
    const themed = (values) => ({ version: 7, values, plain: false, strokeWidth: 1.5, font: null, edgeWidth: null, glow: null, labelMin: null, greyAlpha: null, icons: null, pixelated: false });
    for (const style of [themed({}), { ...themed({}), plain: true }, themed({ '--corn-map-node-page': '#ff0000', '--corn-map-stroke': '#00ff00' })]) {
      const out = styledScene(scene, style);
      for (const n of out.nodes.filter((x) => x.greyed)) {
        const [r, g, b] = parseColor(n.color);
        expect(r === g && g === b, `${n.id} ${n.color}`).toBe(true);
        if (n.stroke) { const [a, c, d] = parseColor(n.stroke.color); expect(a === c && c === d).toBe(true); }
        expect(n.labelAlpha).toBeGreaterThanOrEqual(DIFF_LABEL_ALPHA); // the label of a greyed node stays at the dimmed-label opacity the contrast check holds
        expect(n.type).toBeTruthy(); // its silhouette is its type's: nothing is taken from the node but its hue
        expect(n.shape).toBeTruthy();
      }
      for (const e of out.edges.filter((x) => x.greyed)) { const [r, g, b] = parseColor(e.color); expect(r === g && g === b, `${e.key} ${e.color}`).toBe(true); }
      // the involved ones keep their colour
      expect(out.nodes.find((n) => n.id === 'p1').color).not.toBe(greyOf(out.nodes.find((n) => n.id === 'p1').color));
    }
  });
  it('a theme\'s `--corn-map-grey` and `--corn-map-grey-alpha` replace the defaults; a painted node keeps its colour', () => {
    const s = stateOf();
    s.review.manual.service = true; s.review.manual.app = true; s.review.rev++;
    const scene = buildScene(s);
    const style = { version: 9, values: { '--corn-map-grey': '#777777' }, plain: false, strokeWidth: 1.5, font: null, edgeWidth: null, glow: null, labelMin: null, greyAlpha: 0.7, icons: null, pixelated: false };
    const out = styledScene(scene, style);
    const n = out.nodes.find((x) => x.id === 'p2');
    expect(n.color).toBe('#777777');
    expect(n.alpha).toBeCloseTo(0.7, 5);
    scene.painted.nodes.add('p2');
    const kept = styledScene({ ...scene }, { ...style, version: 10 });
    expect(kept.nodes.find((x) => x.id === 'p2').color).toBe(scene.nodes.find((x) => x.id === 'p2').color);
  });
  it('the default grey, faded, is still told from the ground, for every built-in colour, on both grounds (the map must still read as a map)', () => {
    for (const [theme, ground] of [['dark', DARK_GROUND], ['light', LIGHT_GROUND]]) {
      for (const [type, { color }] of Object.entries(NODE_THEMES)) {
        const fill = theme === 'light' ? lightColor(color) : color;
        const [r, g, b] = parseColor(greyOf(fill));
        const a = GREY_ALPHA;
        const [gr, gg, gb] = parseColor(ground);
        const over = `rgb(${Math.round(r * a + gr * (1 - a))}, ${Math.round(g * a + gg * (1 - a))}, ${Math.round(b * a + gb * (1 - a))})`;
        expect(contrast(over, ground), `${type} on ${theme}`).toBeGreaterThanOrEqual(GREY_MIN_RATIO);
      }
    }
  });
});

describe('the big fixture\'s six rich proposals', () => {
  const made = makeBig({ layers: true });
  const topo = made.topology;
  const proposals = made.proposals.filter((p) => /^01\d\d-/.test(p));
  it('each shows fewer layers than the map has, and every node the proposal changes is drawn', () => {
    expect(proposals).toHaveLength(6);
    for (const slug of proposals) {
      const proposal = JSON.parse(made.files[`docs/specs/proposals/${slug}.json`]);
      const applied = applyProposal({ nodes: topo.nodes.map((n) => ({ ...n })), edges: topo.edges }, proposal);
      const s = stateOf({ nodes: applied.nodes, edges: applied.edges, projectLayers: [], activeLayers: { ...LAYERS } });
      const effective = layersOf(s);
      const total = new Set(applied.nodes.map((n) => rowKeyOf(s, n)).filter(Boolean));
      const on = [...total].filter((k) => effective[k] !== false).length;
      expect(on, slug).toBeLessThan(total.size);
      for (const n of applied.nodes.filter((x) => x.mark && x.mark !== 'none')) expect(isNodeVisible(s, n), `${slug} ${n.id}`).toBe(true);
    }
  });
});
