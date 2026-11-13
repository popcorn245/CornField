import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sample from '../../test/fixtures/sample/topology.json';
import checkout from '../../test/fixtures/sample/docs/specs/proposals/0002-checkout.json';
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

  it('has no member but properties, events, the lifecycle, the methods that hand a call to the piece, and the plumbing between them', () => {
    const LIFECYCLE = ['connectedCallback', 'componentWillLoad', 'componentDidLoad', 'disconnectedCallback', 'componentDidRender'];
    const PLUMBING = ['mountPiece', 'mountScope', 'unmountPiece', 'remount', 'changed', 'addressChanged'];
    for (const { name, file } of sources) {
      const code = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const body = code.slice(code.indexOf('export class'));
      const plain = [...body.matchAll(/^ {2}(?:private |public )?(?:async )?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/gm)].map((m) => m[1]);
      for (const member of plain) expect([...LIFECYCLE, ...PLUMBING].includes(member) || /@Method\(\)\s*$/.test(body.slice(0, body.indexOf(`  async ${member}(`)).trimEnd() + '\n'), `${name}: ${member}`).toBe(true);
      // every public method only hands the call to the piece, under its own name
      for (const m of body.matchAll(/@Method\(\)\s*async\s+(\w+)\([^)]*\)[^{]*\{([^}]*)\}/g)) expect(m[2].trim(), `${name}.${m[1]}`).toMatch(new RegExp(`^if \\(this\\.piece\\) this\\.piece\\.${m[1]}\\([^;]*\\);$`));
    }
  });

  /** The page's own things a shell would reach for to do something by itself: none is in a shell (the one read of the page's address, for the sign-in's way back, is handed to the piece as it is) */
  const PAGE_REACH = /\b(fetch|document|window|globalThis|self|history|location|navigator|localStorage|sessionStorage|indexedDB|setTimeout|setInterval|requestAnimationFrame|queueMicrotask|XMLHttpRequest|WebSocket|EventSource|eval|Function|innerHTML|outerHTML|insertAdjacentHTML|addEventListener|dispatchEvent|querySelector|querySelectorAll|getElementById|attachShadow|import)\b/g;
  const reachesPage = (code: string) => code
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^'"`\n]*$/gm, '')
    .replace(/^import .*$/gm, '')
    .replace("pageUrl: () => (typeof location === 'undefined' ? '' : location.href)", 'pageUrl')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''")
    .match(PAGE_REACH) || [];

  it('reaches nothing of the page by itself: no fetch, document, window, timer, storage, listener or markup of its own (the piece does all of it)', () => {
    for (const { name, file } of sources) expect(reachesPage(fs.readFileSync(file, 'utf8')), name).toEqual([]);
    // and the check is not blind: each way a shell could do something by itself is caught
    for (const bad of ["onDecision: (d) => { fetch('/x'); }", 'onReady: () => setTimeout(() => this.cornReady.emit(), 0)', 'this.el.shadowRoot.innerHTML = this.src;', "window.addEventListener('message', () => {})", 'location.assign(detail.signIn)', "document.title = 'x'", "import('./x.js')"]) expect(reachesPage(bad), bad).not.toEqual([]);
  });

  it('the check is not blind: it refuses the engine\'s other modules, the bridges, a package and a helper of the package\'s own', () => {
    const from = path.join(dir, 'corn-map', 'corn-map.tsx');
    for (const spec of ['../../../../explorer/engine/render.js', '../../../../explorer/state.js', '../../../../explorer/instance.js', 'lodash', '../../util', '../../../../explorer/pieces/../state.js']) expect(allowed(spec, from), spec).toBe(false);
    for (const spec of ['@stencil/core', '../../../../explorer/pieces/map.js', './corn-map.css', '../../generated/default-tokens.css?inline']) expect(allowed(spec, from), spec).toBe(true);
  });
});

describe('<corn-scope>', () => {
  it('registers, has no shadow root, shows nothing of its own and leaves what is in it', async () => {
    const scope = await make('<corn-scope><p>mine</p><corn-map renderer="canvas2d"></corn-map></corn-scope>') as unknown as Map & { shadowRoot: ShadowRoot | null };
    expect(customElements.get('corn-scope')).toBeTruthy();
    expect(scope.shadowRoot).toBe(null);
    expect([...scope.children].map((c) => c.localName)).toEqual(['p', 'corn-map']);
    await (scope.querySelector('corn-map') as Map).componentOnReady();
    await frames(8);
    scope.remove();
    await frames(3);
  });

  it('takes src, theme (reflected) and use-theme as attributes, and topology, config and strings as properties', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch')); // the address is only an address here
    const scope = await make('<corn-scope src="https://map.example.com" theme="dark" use-theme></corn-scope>') as unknown as HTMLElement & { src: string; theme: string; useTheme: boolean; topology: unknown; config: unknown; strings: unknown };
    expect(scope.src).toBe('https://map.example.com');
    expect(scope.theme).toBe('dark');
    expect(scope.useTheme).toBe(true);
    scope.theme = 'light';
    await frames(2);
    expect(scope.getAttribute('theme')).toBe('light');
    scope.topology = topology();
    scope.config = { version: '0.0.0' };
    scope.strings = { approve: 'Ship it' };
    await frames(2);
    vi.restoreAllMocks();
  });

  it('a bad src is refused and said (cornError address), and nothing is fetched', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch');
    const seen: unknown[] = [];
    document.addEventListener('cornError', (e) => seen.push((e as CustomEvent).detail), { once: true });
    await make('<corn-scope src="ftp://map.example.com"></corn-scope>');
    await frames(2);
    expect(seen).toEqual([{ kind: 'address', message: 'is not http or https' }]);
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
  });

  it('is told apart from a piece by the event it answers: the nearest scope hears corn-scope-request and no other', async () => {
    const outer = await make('<corn-scope id="o"><corn-scope id="i"><div id="piece"></div></corn-scope></corn-scope>') as unknown as HTMLElement;
    const heard: string[] = [];
    for (const id of ['o', 'i']) document.getElementById(id)!.addEventListener('corn-scope-request', () => heard.push(id), { capture: false });
    document.getElementById('piece')!.dispatchEvent(new CustomEvent('corn-scope-request', { bubbles: true, composed: true, detail: { el: document.getElementById('piece'), claim() {} } }));
    expect(heard).toEqual(['i']); // the inner scope answers first and stops it
    void outer;
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

type Review = HTMLElement & {
  src?: string; proposal?: unknown; source?: string | null; view?: string | null; node?: string | null; theme?: string; useTheme: boolean; topology?: unknown; config?: unknown; strings?: unknown; checker?: unknown;
  shadowRoot: ShadowRoot; componentOnReady(): Promise<Review>; fit(): Promise<void>; focusNode(id: string): Promise<void>; refresh(): Promise<void>;
};

describe('<corn-review>', () => {
  const made = async (html = '<corn-review></corn-review>') => { document.body.innerHTML = html; const el = document.body.firstElementChild as Review; await el.componentOnReady(); return el; };
  const q = (el: Review, sel: string) => el.shadowRoot.querySelector(sel) as HTMLElement | null;

  it('registers, has a shadow root, and mounts the review piece in it: one named region, every hook a part', async () => {
    const el = await made();
    expect(customElements.get('corn-review')).toBeTruthy();
    const box = q(el, '[data-corn="review"]')!;
    expect(box.getAttribute('role')).toBe('region');
    expect(box.getAttribute('aria-label')).toBe('Proposal review');
    expect(el.shadowRoot.querySelectorAll('[data-corn="review"]')).toHaveLength(1);
    for (const hooked of el.shadowRoot.querySelectorAll('[data-corn]')) expect(hooked.getAttribute('part'), hooked.outerHTML.slice(0, 60)).toBe(hooked.getAttribute('data-corn'));
    expect(el.shadowRoot.querySelectorAll('canvas').length).toBe(2);
  });

  it('takes src, source, theme (reflected), view and node (reflected, mutable) and use-theme as attributes, and topology, config, strings, checker and a proposal object as properties', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const el = await made('<corn-review src="https://map.example.com" proposal="0042-retire" source="pull/31" theme="dark" use-theme view="after" node="a"></corn-review>');
    expect(el.src).toBe('https://map.example.com');
    expect(el.proposal).toBe('0042-retire');
    expect(el.source).toBe('pull/31');
    expect(el.theme).toBe('dark');
    expect(el.useTheme).toBe(true);
    expect(el.view).toBe('after');
    el.theme = 'light';
    el.view = 'before';
    await frames(2);
    expect(el.getAttribute('theme')).toBe('light');
    expect(el.getAttribute('view')).toBe('before');
    el.proposal = { title: 'An object' };
    el.topology = topology();
    el.config = { version: '0.0.0' };
    el.strings = { approve: 'Ship it' };
    el.checker = { check: () => [] };
    await frames(2);
    vi.restoreAllMocks();
  });

  it('a bad src is refused and said (cornError address), and nothing is fetched', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch');
    const seen: unknown[] = [];
    document.addEventListener('cornError', (e) => seen.push((e as CustomEvent).detail), { once: true });
    const el = await made('<corn-review src="ftp://map.example.com" proposal="0042-retire"></corn-review>');
    // the refusal follows the lazy import of the piece that reads `src`, which a busy runner does not finish in a fixed number of frames
    for (let i = 0; i < 60 && !seen.length; i++) await frames(1);
    await frames(2); // and nothing more is said, or fetched, after it
    expect(seen).toEqual([{ kind: 'address', message: 'is not http or https' }]);
    expect(q(el, '[data-corn="source-status"]:not([hidden])')?.textContent).toMatch(/address/i);
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
  });

  it('a proposal object with a topology: cornReady once, cornNavigate says it opened, and no request is made', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch');
    const el = await made();
    const ready = vi.fn();
    const navigated: unknown[] = [];
    el.addEventListener('cornReady', ready);
    el.addEventListener('cornNavigate', (e) => navigated.push((e as CustomEvent).detail));
    el.topology = topology();
    el.proposal = structuredClone(checkout);
    await frames(4);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(navigated).toEqual([{ proposal: null, source: null, view: 'diff', change: 'opened' }]); // an object with no name has none to say
    expect(q(el, '#proposal-title')?.textContent).toBe(checkout.title);
    expect(fetched).not.toHaveBeenCalled();
    el.proposal = structuredClone(checkout); // another object: a new proposal
    await frames(2);
    expect(ready).toHaveBeenCalledTimes(1);
    fetched.mockRestore();
  });

  it('view follows the reviewer\'s own choice and a set value alike, said once as cornNavigate, never echoed; node follows the selection both ways', async () => {
    const el = await made();
    el.topology = topology();
    el.proposal = structuredClone(checkout);
    await frames(3);
    const navigated: Array<{ view: string | null; change: string }> = [];
    const selected: unknown[] = [];
    el.addEventListener('cornNavigate', (e) => navigated.push((e as CustomEvent).detail));
    el.addEventListener('cornSelect', (e) => selected.push((e as CustomEvent).detail));
    q(el, '[data-view="after"]')!.click();
    await frames(3);
    expect(el.view).toBe('after');
    expect(el.getAttribute('view')).toBe('after');
    expect(navigated).toEqual([expect.objectContaining({ view: 'after', change: 'view' })]);
    el.view = 'before';
    await frames(3);
    expect(navigated).toHaveLength(2); // once for the set value; the property following it did not say it again
    const [a, b] = [sample.nodes[2].id, sample.nodes[4].id];
    el.node = a;
    await frames(2);
    expect(selected).toEqual([{ id: a, kind: 'node', source: 'api' }]);
    el.node = a;
    await frames(2);
    expect(selected).toHaveLength(1);
    await el.focusNode(b);
    await frames(2);
    expect(el.node).toBe(b);
    expect(el.getAttribute('node')).toBe(b);
    expect(selected.at(-1)).toEqual({ id: b, kind: 'node', source: 'api' });
  });

  it('proposal follows the reviewer as view does: Close in the bar sets it to null, once; the host setting it again opens it, said once, never echoed', async () => {
    const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });
    const fetched = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = new URL(String(input));
      if (u.pathname === '/cornfield/config.json') return json({ name: 'cornfield', version: '0.0.0', strings: {}, layers: { add: [], off: [], order: [] }, theme: null });
      if (u.pathname === '/topology.json') return json(topology());
      if (u.pathname === '/proposals/0002-checkout.json') return json(checkout, { 'X-Proposal-Source': 'checkout' });
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    });
    const el = await made('<corn-review src="https://map.example.com" proposal="0002-checkout"></corn-review>');
    const navigated: Array<{ proposal: string | null; change: string }> = [];
    el.addEventListener('cornNavigate', (e) => navigated.push((e as CustomEvent).detail));
    for (let i = 0; i < 60 && !q(el, '#proposal-title')?.textContent; i++) await frames(1);
    expect(q(el, '#proposal-title')?.textContent).toBe(checkout.title);
    expect(navigated).toEqual([{ proposal: '0002-checkout', source: null, view: 'diff', change: 'opened' }]);
    el.proposal = '0002-checkout'; // the value it has: nothing happens
    await frames(3);
    expect(navigated).toHaveLength(1);
    q(el, '[data-action="close-proposal"]')!.click();
    await frames(3);
    expect(el.proposal).toBeNull();
    expect(navigated.slice(1)).toEqual([{ proposal: null, source: null, view: null, change: 'closed' }]);
    const asked = fetched.mock.calls.length;
    el.proposal = '0002-checkout'; // the host opens it again
    for (let i = 0; i < 60 && navigated.length < 3; i++) await frames(1);
    await frames(3);
    expect(navigated.slice(2)).toEqual([{ proposal: '0002-checkout', source: null, view: 'diff', change: 'opened' }]);
    expect(el.proposal).toBe('0002-checkout');
    expect(fetched.mock.calls.slice(asked).map(([u]) => new URL(String(u)).pathname)).toEqual(['/proposals/0002-checkout.json']);
    fetched.mockRestore();
  });

  it('its events bubble and cross the shadow root, and have fit(), focusNode() and refresh(), each answering with a promise', async () => {
    const el = await made();
    el.topology = topology();
    await frames(3);
    const heard = vi.fn();
    document.body.addEventListener('cornSelect', heard);
    el.node = sample.nodes[2].id;
    await frames(2);
    expect(heard).toHaveBeenCalledTimes(1);
    document.body.removeEventListener('cornSelect', heard);
    for (const result of [el.fit(), el.focusNode('nothing'), el.refresh()]) expect(result).toBeInstanceOf(Promise);
    await expect(Promise.all([el.fit(), el.focusNode('nothing'), el.refresh()])).resolves.toEqual([undefined, undefined, undefined]);
  });

  it('ends the piece when it leaves the page and makes a new one when it comes back; a new src is a new piece', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const el = await made('<corn-review src="https://map.example.com"></corn-review>');
    await frames(2);
    const first = q(el, '[data-corn="review"]');
    el.remove();
    expect(el.shadowRoot.childElementCount).toBe(0);
    document.body.append(el);
    await frames(3);
    expect(el.shadowRoot.querySelectorAll('[data-corn="review"]')).toHaveLength(1);
    expect(q(el, '[data-corn="review"]')).not.toBe(first);
    const second = q(el, '[data-corn="review"]');
    el.src = 'https://other.example.com';
    await frames(3);
    expect(q(el, '[data-corn="review"]')).not.toBe(second);
    expect(el.shadowRoot.querySelectorAll('[data-corn="review"]')).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('inside a corn-scope it works alone: it never asks the scope for its instance, and takes its src from its own attribute', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const requests: string[] = [];
    document.body.innerHTML = '<corn-scope id="s" src="https://scope.example.com"><corn-review src="https://review.example.com"></corn-review></corn-scope>';
    document.getElementById('s')!.addEventListener('corn-scope-request', () => requests.push('asked'), { capture: true });
    const el = document.querySelector('corn-review') as Review;
    await el.componentOnReady();
    el.remove();
    document.getElementById('s')!.append(el);
    await el.componentOnReady();
    await frames(3);
    expect(requests).toEqual([]);
    const urls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.startsWith('https://review.example.com/'))).toBe(true);
    vi.restoreAllMocks();
  });

  it('adds the default tokens to the document once, however many elements there are', async () => {
    await make('<corn-review></corn-review><corn-review></corn-review><corn-map renderer="canvas2d"></corn-map>');
    const sheets = document.adoptedStyleSheets?.length ?? 0;
    const styles = document.head.querySelectorAll('style[data-corn-default-tokens]').length;
    expect(sheets + styles).toBe(1);
  });
});

describe('the pieces around the map: <corn-node-panel>, <corn-layers>, <corn-search>', () => {
  type Piece = HTMLElement & { componentOnReady(): Promise<Piece>; query?: string; focusField(): Promise<void> };
  const TAGS = ['corn-node-panel', 'corn-layers', 'corn-search'];
  const empty = (el: Element) => el.shadowRoot!.querySelector('[data-corn="empty"]') as HTMLElement | null;

  it('register, each with a shadow root, and the document gets the default tokens once', async () => {
    document.body.innerHTML = TAGS.map((t) => `<${t}></${t}>`).join('');
    const els = [...document.body.children] as Piece[];
    await Promise.all(els.map((e) => e.componentOnReady()));
    for (const t of TAGS) expect(customElements.get(t), t).toBeTruthy();
    for (const el of els) expect(el.shadowRoot, el.localName).toBeTruthy();
    expect((document.adoptedStyleSheets?.length ?? 0) + document.head.querySelectorAll('style[data-corn-default-tokens]').length).toBe(1);
  });

  it('with no scope around them they say what they need, make nothing else and throw nothing', async () => {
    const errors: string[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.message);
    window.addEventListener('error', onError);
    document.body.innerHTML = TAGS.map((t) => `<${t}></${t}>`).join('');
    const els = [...document.body.children] as Piece[];
    await Promise.all(els.map((e) => e.componentOnReady()));
    await frames(3);
    for (const el of els) {
      expect(empty(el)!.textContent, el.localName).toBe('This needs a corn-scope around it, with a corn-map in it');
      expect(el.shadowRoot!.querySelector('input, button'), el.localName).toBe(null);
    }
    expect(await els[2].focusField()).toBeUndefined(); // nothing mounted: nothing happens
    els[2].query = 'x';
    await frames(2);
    for (const el of els) el.remove();
    await frames(2);
    window.removeEventListener('error', onError);
    expect(errors).toEqual([]);
  });

  it('inside a scope with no map the node panel says what it is for and the others what they need; no event, no request', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch');
    const seen: string[] = [];
    document.addEventListener('cornError', (e) => seen.push((e as CustomEvent).detail.kind));
    document.body.innerHTML = `<corn-scope>${TAGS.map((t) => `<${t}></${t}>`).join('')}</corn-scope>`;
    const els = [...document.body.firstElementChild!.children] as Piece[];
    await Promise.all(els.map((e) => e.componentOnReady()));
    await frames(3);
    expect(empty(els[0])!.textContent).toBe('Select a node on the map to see its details');
    expect(empty(els[1])!.textContent).toBe('This needs a corn-map in the same corn-scope');
    expect(empty(els[2])!.textContent).toBe('This needs a corn-map in the same corn-scope');
    expect(seen).toEqual([]);
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
  });

  it('ends what it made when it leaves the page: nothing of its own is left in the shadow root but the note and the live region', async () => {
    document.body.innerHTML = '<corn-search></corn-search>';
    const el = document.body.firstElementChild as Piece;
    await el.componentOnReady();
    await frames(2);
    const before = el.shadowRoot!.children.length;
    el.remove();
    await frames(2);
    expect(el.shadowRoot!.children.length).toBeLessThanOrEqual(before);
    document.body.append(el); // and back: made again, not doubled
    await el.componentOnReady();
    await frames(2);
    expect(el.shadowRoot!.querySelectorAll('[data-corn="empty"]')).toHaveLength(1);
    expect(el.shadowRoot!.querySelectorAll('[role="status"]')).toHaveLength(1);
  });
});

describe('the review\'s sections: <corn-proposal>, <corn-changes>, <corn-decision>', () => {
  type Section = HTMLElement & { componentOnReady(): Promise<Section> };
  const TAGS = ['corn-proposal', 'corn-changes', 'corn-decision'];
  const empty = (el: Element) => el.shadowRoot!.querySelector('[data-corn="empty"]') as HTMLElement | null;

  it('register, each with a shadow root', async () => {
    document.body.innerHTML = TAGS.map((t) => `<${t}></${t}>`).join('');
    const els = [...document.body.children] as Section[];
    await Promise.all(els.map((e) => e.componentOnReady()));
    for (const t of TAGS) expect(customElements.get(t), t).toBeTruthy();
    for (const el of els) expect(el.shadowRoot, el.localName).toBeTruthy();
    // (test/package.test.ts holds that their declarations list no property, event or method)
  });

  it('with no scope around them they say what they need, make nothing else, ask nobody for anything and throw nothing', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch');
    const errors: string[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.message);
    window.addEventListener('error', onError);
    document.body.innerHTML = TAGS.map((t) => `<${t}></${t}>`).join('');
    const els = [...document.body.children] as Section[];
    await Promise.all(els.map((e) => e.componentOnReady()));
    await frames(3);
    for (const el of els) {
      expect(empty(el)!.textContent, el.localName).toBe('This needs a corn-scope around it, with a corn-map in it');
      expect(el.shadowRoot!.querySelector('button, input, textarea'), el.localName).toBe(null);
    }
    for (const el of els) el.remove();
    await frames(2);
    window.removeEventListener('error', onError);
    expect(errors).toEqual([]);
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
  });

  it('inside a scope with no map they say what they need, make no request and send no event', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch');
    const seen: string[] = [];
    for (const type of ['cornError', 'cornNavigate', 'cornDecision', 'cornAuth']) document.addEventListener(type, (e) => seen.push(`${type}:${(e as CustomEvent).detail && (e as CustomEvent).detail.kind}`));
    document.body.innerHTML = `<corn-scope>${TAGS.map((t) => `<${t}></${t}>`).join('')}</corn-scope>`;
    const els = [...document.body.firstElementChild!.children] as Section[];
    await Promise.all(els.map((e) => e.componentOnReady()));
    await frames(3);
    for (const el of els) expect(empty(el)!.textContent, el.localName).toBe('This needs a corn-map in the same corn-scope');
    expect(seen).toEqual([]);
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
  });

  it('a second one of the same tag in a scope says so; the three are held apart; the first leaving gives the second its place', async () => {
    document.body.innerHTML = '<corn-scope><corn-proposal id="a"></corn-proposal><corn-changes id="b"></corn-changes><corn-decision id="c"></corn-decision><corn-proposal id="d"></corn-proposal></corn-scope>';
    const els = [...document.body.firstElementChild!.children] as Section[];
    await Promise.all(els.map((e) => e.componentOnReady()));
    await frames(3);
    expect(empty(els[0])!.textContent).toBe('This needs a corn-map in the same corn-scope');
    expect(empty(els[3])!.textContent).toBe('This scope already has one of these');
    els[0].remove();
    await frames(3);
    expect(empty(els[3])!.textContent).toBe('This needs a corn-map in the same corn-scope');
  });

  it('is the scope\'s that has the proposal: `proposal`, `source` and `view` are on corn-scope, and `view` is reflected', async () => {
    document.body.innerHTML = '<corn-scope proposal="0042-retire-the-old-export" source="pull/3" view="after"></corn-scope>';
    const scope = document.body.firstElementChild as HTMLElement & { componentOnReady(): Promise<HTMLElement>; proposal: unknown; source: unknown; view: unknown };
    await scope.componentOnReady();
    expect([scope.proposal, scope.source, scope.view]).toEqual(['0042-retire-the-old-export', 'pull/3', 'after']);
    scope.view = 'before';
    await frames(2);
    expect(scope.getAttribute('view')).toBe('before');
  });
});
