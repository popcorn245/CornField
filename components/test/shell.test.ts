import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sample from '../../test/fixtures/sample/topology.json';
import '../src/index';
import { version } from '../src/index';

const here = path.dirname(new URL(import.meta.url).pathname);
const rootVersion = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8')).version;

type Map = HTMLElement & { topology: unknown; node?: string | null; view: string; theme?: string; renderer: string; componentOnReady(): Promise<Map>; fit(): Promise<void>; focusNode(id: string): Promise<void>; refresh(): Promise<void> };

const ctx2d = new Proxy({}, { get: (t: any, k: string) => (k === 'measureText' ? (text: string) => ({ width: String(text).length * 6 }) : k in t ? t[k] : () => {}), set: (t: any, k: string, v: unknown) => { t[k] = v; return true; } });
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
const frames = async (n = 3) => { for (let i = 0; i < n; i++) await frame(); };
const topology = () => structuredClone(sample) as { nodes: Array<{ id: string }>; edges: unknown[] };

let realGet: unknown;
beforeEach(() => {
  realGet = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type: string) { return type === '2d' ? (ctx2d as unknown as CanvasRenderingContext2D) : null; } as typeof HTMLCanvasElement.prototype.getContext;
});
afterEach(() => {
  HTMLCanvasElement.prototype.getContext = realGet as typeof HTMLCanvasElement.prototype.getContext;
  document.body.innerHTML = '';
  document.head.querySelectorAll('style[data-corn-default-tokens]').forEach((s) => s.remove());
});

async function make(html = '<corn-map renderer="canvas2d"></corn-map>') {
  document.body.innerHTML = html;
  const el = document.body.firstElementChild as Map;
  await el.componentOnReady();
  return el;
}

describe('the shell holds no behaviour (D1)', () => {
  const dir = path.join(here, '..', 'src', 'components');
  const sources = fs.readdirSync(dir).map((name) => ({ name, file: path.join(dir, name, `${name}.tsx`) }));
  const pieces = path.resolve(here, '..', '..', 'explorer', 'pieces');
  /** What a component source may import: the Stencil runtime, the engine's pieces, and CSS */
  const allowed = (spec: string, from: string) => spec === '@stencil/core' || /\.css(\?inline)?$/.test(spec) || (/\.js$/.test(spec) && path.resolve(path.dirname(from), spec).startsWith(pieces + path.sep));

  it('has a component source for every tag, and nothing in its folder but the source and its styles', () => {
    expect(sources.length).toBeGreaterThan(0);
    for (const { name, file } of sources) {
      expect(fs.existsSync(file), file).toBe(true);
      expect(fs.readdirSync(path.join(dir, name)).filter((f) => !/\.(tsx|css)$/.test(f)), name).toEqual([]);
    }
  });

  it('imports nothing but the Stencil runtime, the engine\'s pieces and CSS', () => {
    for (const { name, file } of sources) {
      const code = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const specifiers = [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)(['"])([^'"]+)\1/gm)].map((m) => m[2]);
      expect(specifiers.length, name).toBeGreaterThan(0);
      for (const spec of specifiers) expect(allowed(spec, file), `${name} imports ${spec}`).toBe(true);
    }
  });

  it('the check is not blind: it refuses the engine\'s other modules, the bridges, a package and a helper of the package\'s own', () => {
    const from = path.join(dir, 'corn-map', 'corn-map.tsx');
    for (const spec of ['../../../../explorer/engine/render.js', '../../../../explorer/state.js', '../../../../explorer/instance.js', 'lodash', '../../util', '../../../../explorer/pieces/../state.js']) expect(allowed(spec, from), spec).toBe(false);
    for (const spec of ['@stencil/core', '../../../../explorer/pieces/map.js', './corn-map.css', '../../generated/default-tokens.css?inline']) expect(allowed(spec, from), spec).toBe(true);
  });
});

describe('<corn-map>', () => {
  it('registers, has a shadow root, and mounts the map piece in it', async () => {
    const el = await make();
    expect(customElements.get('corn-map')).toBeTruthy();
    const root = el.shadowRoot!;
    expect(root.querySelector('[data-corn="map-stage"]')).toBeTruthy();
    const canvas = root.querySelector('canvas[data-corn="map-canvas"]')!;
    expect(canvas.getAttribute('aria-label')).toBe('Topology map');
    expect(canvas.getAttribute('part')).toBe('map-canvas');
    for (const hooked of root.querySelectorAll('[data-corn]')) expect(hooked.getAttribute('part')).toBe(hooked.getAttribute('data-corn'));
    expect(root.querySelectorAll('canvas')).toHaveLength(2);
  });

  it('carries the version of cornfield it was built from', () => {
    expect(version).toBe(rootVersion);
  });

  it('takes the topology and says cornReady once, after its first frame', async () => {
    const el = await make();
    const ready = vi.fn();
    el.addEventListener('cornReady', ready);
    el.topology = topology();
    await frames();
    expect(ready).toHaveBeenCalledTimes(1);
    el.topology = topology();
    await frames(2);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('node selects and follows the selection: cornSelect carries { id, kind, source }, and the attribute is reflected both ways', async () => {
    const el = await make();
    el.topology = topology();
    await frames(2);
    const seen: unknown[] = [];
    el.addEventListener('cornSelect', (e) => seen.push((e as CustomEvent).detail));
    const [a, b] = [sample.nodes[2].id, sample.nodes[4].id];
    el.node = a;
    await frames(2);
    expect(seen).toEqual([{ id: a, kind: 'node', source: 'api' }]);
    el.node = a; // the selection already: no change, no event
    await frames(2);
    expect(seen).toHaveLength(1);
    expect(el.getAttribute('node')).toBe(a);
    await el.focusNode(b);
    await frames(2);
    expect(seen.at(-1)).toEqual({ id: b, kind: 'node', source: 'api' });
    expect(el.node).toBe(b);
    expect(el.getAttribute('node')).toBe(b);
    el.setAttribute('node', a);
    await frames(2);
    expect(seen.at(-1)).toEqual({ id: a, kind: 'node', source: 'api' });
    el.node = null;
    await frames(2);
    expect(seen.at(-1)).toEqual({ id: null, kind: null, source: 'api' });
    expect(el.hasAttribute('node')).toBe(false);
    expect(seen).toHaveLength(4);
  });

  it('an edge selection reaches cornSelect (the instance\'s selection event), clears node, and is not undone by that', async () => {
    const el = await make();
    el.topology = topology();
    await frames(2);
    const seen: Array<{ id: string | null; kind: string | null }> = [];
    el.addEventListener('cornSelect', (e) => seen.push((e as CustomEvent).detail));
    // What a proposal does on cornfield's page (proposal.js): an edge picked, by assignment. The test reaches the piece the shell holds.
    const state = (el as unknown as { piece: { inst: { state: { edges: Array<{ from: string; to: string }>; selectedEdge: unknown; selectedNode: unknown } } } }).piece.inst.state;
    const edge = state.edges[0];
    state.selectedEdge = edge;
    await frames(2);
    expect(seen).toEqual([{ id: `${edge.from}->${edge.to}`, kind: 'edge', from: edge.from, to: edge.to, source: 'state' }]);
    expect(el.node).toBe(null);
    expect(el.hasAttribute('node')).toBe(false);
    expect(state.selectedEdge).toBe(edge); // node going to null came from the map: it is not passed back to clear the edge
    el.theme = 'light'; // another render: still no echo
    await frames(2);
    expect(state.selectedEdge).toBe(edge);
    expect(seen).toHaveLength(1);
  });

  it('a key on the canvas selects, and the event is composed: a listener on any ancestor of the element hears it', async () => {
    const el = await make();
    el.topology = topology();
    await frames(2);
    const heard = vi.fn();
    document.body.addEventListener('cornSelect', heard);
    el.shadowRoot!.querySelector('canvas')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true, composed: true }));
    await frame();
    expect(heard).toHaveBeenCalledTimes(1);
    expect((heard.mock.calls[0][0] as CustomEvent).detail.kind).toBe('node');
    document.body.removeEventListener('cornSelect', heard);
  });

  it('reflects theme as an attribute, and takes view and renderer', async () => {
    const el = await make('<corn-map renderer="canvas2d" theme="dark" view="dataflow"></corn-map>');
    expect(el.theme).toBe('dark');
    expect(el.view).toBe('dataflow');
    expect(el.renderer).toBe('canvas2d');
    el.theme = 'light';
    await frames(2);
    expect(el.getAttribute('theme')).toBe('light');
  });

  it('has fit(), focusNode() and refresh(), and each answers with a promise', async () => {
    const el = await make();
    el.topology = topology();
    await frame();
    for (const result of [el.fit(), el.focusNode('nothing'), el.refresh()]) expect(result).toBeInstanceOf(Promise);
    await expect(Promise.all([el.fit(), el.focusNode('nothing'), el.refresh()])).resolves.toEqual([undefined, undefined, undefined]);
  });

  it('ends the piece when it leaves the page, and makes new canvases when it comes back', async () => {
    const el = await make();
    el.topology = topology();
    await frames(2);
    const first = el.shadowRoot!.querySelector('canvas[data-corn="map-canvas"]')!;
    el.remove();
    expect(el.shadowRoot!.childElementCount).toBe(0);
    document.body.append(el);
    await frames(2);
    const second = el.shadowRoot!.querySelector('canvas[data-corn="map-canvas"]')!;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(el.shadowRoot!.querySelectorAll('canvas[data-corn="map-canvas"]')).toHaveLength(1);
  });

  it('adds the default tokens to the document once, however many elements there are, and not again for a second copy of the package', async () => {
    await make('<corn-map renderer="canvas2d"></corn-map><corn-map renderer="canvas2d"></corn-map>');
    const sheets = document.adoptedStyleSheets?.length ?? 0;
    const styles = document.head.querySelectorAll('style[data-corn-default-tokens]').length;
    expect(sheets + styles).toBe(1);
    const { adoptDefaultTokens } = await import('../../explorer/pieces/adopt-tokens.js');
    expect(adoptDefaultTokens(document, ':where(:root){--corn-x:1}')).toBe(false); // a second copy finds the first's sheet
  });
});
