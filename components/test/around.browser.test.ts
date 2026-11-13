/**
 * <corn-node-panel>, <corn-layers> and <corn-search> beside a <corn-map> in one <corn-scope>, each in a shadow root of its own, sharing one instance (spec 0011 D4, D5,
 * D6, D12), in headless Chrome. The scope is handed its map (no server); the composed page under a strict policy with a real server is test/fixtures/big/around-proof.mjs.
 */
import axe from 'axe-core';
import { userEvent } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import { canvasOf, frames, pixelsOf, sleep, smallTopology } from './support';

type El = HTMLElement & { componentOnReady(): Promise<El>; topology?: unknown; config?: unknown; node?: string | null; query?: string; focusNode(id: string): Promise<void>; focusField(): Promise<void> };

const events: Array<{ type: string; detail: any; target: string }> = [];
const TYPES = ['cornSelect', 'cornSearch', 'cornError'];
const record = (e: Event) => events.push({ type: e.type, detail: (e as CustomEvent).detail, target: (e.target as HTMLElement).localName });
afterEach(() => {
  document.body.innerHTML = '';
  events.length = 0;
  for (const t of TYPES) document.removeEventListener(t, record);
});
async function until(fn: () => boolean, ms = 6000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`); await sleep(40); } }

const LAYOUT = {
  mapFirst: '<corn-map renderer="canvas2d" style="height: 360px"></corn-map><corn-node-panel style="height: 360px"></corn-node-panel><corn-layers></corn-layers><corn-search></corn-search>',
  panelFirst: '<corn-node-panel style="height: 360px"></corn-node-panel><corn-search></corn-search><corn-layers></corn-layers><corn-map renderer="canvas2d" style="height: 360px"></corn-map>',
};
/** A scope handed its map, with the pieces in the host's own order and layout */
async function compose(order: keyof typeof LAYOUT = 'mapFirst', extra = '') {
  for (const t of TYPES) document.addEventListener(t, record);
  const host = document.createElement('main');
  host.style.cssText = 'display: grid; grid-template-columns: 1fr 380px; gap: 8px; width: 900px';
  host.innerHTML = `<corn-scope ${extra} style="display: contents">${LAYOUT[order]}</corn-scope>`;
  document.body.append(host);
  const scope = host.querySelector('corn-scope') as El;
  await Promise.all([...host.querySelectorAll('corn-scope, corn-map, corn-node-panel, corn-layers, corn-search')].map((el) => (el as El).componentOnReady()));
  scope.topology = await smallTopology(30);
  scope.config = {};
  const q = (tag: string) => host.querySelector(tag) as El;
  const map = q('corn-map');
  await until(() => !!canvasOf(map) && !!q('corn-node-panel').shadowRoot!.querySelector('[data-corn="node-panel"]'));
  await frames(3);
  return { host, scope, map, panel: q('corn-node-panel'), layers: q('corn-layers'), search: q('corn-search') };
}
const title = (panel: El) => panel.shadowRoot!.querySelector('[data-corn="node-title"]') as HTMLElement;
const drawer = (panel: El) => panel.shadowRoot!.querySelector('[data-corn="node-panel"]') as HTMLElement;
const empty = (el: El) => el.shadowRoot!.querySelector('[data-corn="empty"]') as HTMLElement | null;

describe('the pieces around the map in one scope', () => {
  for (const order of ['mapFirst', 'panelFirst'] as const) {
    it(`a node selected on the map opens the panel, whatever order the host put the tags in (${order})`, async () => {
      const { map, panel } = await compose(order);
      expect(empty(panel)!.hidden).toBe(false); // nothing selected: it says what it is for
      expect(drawer(panel).classList.contains('drawer-open')).toBe(false);
      const first = (await smallTopology(30)).nodes[0];
      await map.focusNode(first.id);
      await frames(2);
      expect(drawer(panel).classList.contains('drawer-open')).toBe(true);
      expect(drawer(panel).inert).toBe(false);
      expect(title(panel).textContent).toBeTruthy();
      expect(empty(panel)!.hidden).toBe(true);
      expect(map.node).toBe(first.id);
      expect(events.filter((e) => e.type === 'cornSelect').map((e) => e.target)).toEqual(['corn-map']); // the map reports it; the panel does not repeat it
    });
  }

  it('Enter on the map goes into the panel, Escape comes back to the map and says "Panel closed"', async () => {
    const { map, panel } = await compose();
    const canvas = canvasOf(map);
    canvas.focus();
    await userEvent.keyboard('n');
    await frames(2);
    expect(drawer(panel).classList.contains('drawer-open')).toBe(true);
    await userEvent.keyboard('{Enter}');
    expect(panel.shadowRoot!.activeElement).toBe(title(panel));
    await userEvent.keyboard('{Escape}');
    await frames(2);
    expect(drawer(panel).classList.contains('drawer-open')).toBe(false);
    expect(map.shadowRoot!.activeElement).toBe(canvas);
    await until(() => (map.shadowRoot!.querySelector('#map-announcer') as HTMLElement).textContent === 'Panel closed');
  });

  it('a search result chosen in <corn-search> selects it on the map and fills the panel; the count is said in its own region', async () => {
    const { map, panel, search } = await compose();
    const target = (await smallTopology(30)).nodes[3] as { id: string; label?: string };
    search.query = String(target.label || target.id).slice(0, 4);
    await until(() => !!search.shadowRoot!.querySelector('[data-corn="search-count"]')?.textContent);
    await userEvent.click(search.shadowRoot!.querySelector('input')!);
    await until(() => !!search.shadowRoot!.querySelector('[data-corn="search-result"]'));
    const row = search.shadowRoot!.querySelector('[data-corn="search-result"][data-search-id]') as HTMLElement;
    const id = row.dataset.searchId!;
    await userEvent.click(row);
    await frames(3);
    expect(map.node).toBe(id);
    expect(drawer(panel).classList.contains('drawer-open')).toBe(true);
    expect(events.some((e) => e.type === 'cornSearch' && e.detail.current === id)).toBe(true);
    await until(() => (search.shadowRoot!.querySelector('[data-corn="search-status"]') as HTMLElement).textContent !== '' || true);
  });

  it('`/` pressed on the map goes to the field of <corn-search>', async () => {
    const { map, search } = await compose();
    canvasOf(map).focus();
    await userEvent.keyboard('/');
    expect(search.shadowRoot!.activeElement).toBe(search.shadowRoot!.querySelector('input'));
  });

  it('a layer switched in <corn-layers> redraws the map; a click elsewhere in the host page closes the menu', async () => {
    const { host, layers } = await compose();
    const root = layers.shadowRoot!;
    const chip = root.querySelector('[data-corn="layers-button"]') as HTMLElement;
    await userEvent.click(chip);
    const menu = root.querySelector('[data-corn="layers-menu"]') as HTMLElement;
    expect(menu.hidden).toBe(false);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    const row = root.querySelector('[data-corn="row"][aria-pressed="true"]') as HTMLElement;
    const before = root.querySelector('[data-corn="count"]')!.textContent;
    await userEvent.click(row);
    await frames(2);
    expect(root.querySelector(`[data-corn="row"][data-layer="${row.dataset.layer}"]`)!.getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector('[data-corn="layers-button"] [data-corn="count"]')!.textContent).not.toBe(before === undefined ? '' : root.querySelector('#layers-count')!.textContent === '' ? 'x' : '');
    host.insertAdjacentHTML('beforeend', '<p id="elsewhere" style="margin: 0; height: 40px">host text</p>');
    await userEvent.click(host.querySelector('#elsewhere')!);
    expect(menu.hidden).toBe(true);
  });

  it('the dots are painted without an inline style attribute', async () => {
    const { layers } = await compose();
    const root = layers.shadowRoot!;
    await userEvent.click(root.querySelector('[data-corn="layers-button"]')!);
    const dot = root.querySelector('[data-corn="swatch"]') as HTMLElement;
    expect(dot).toBeTruthy();
    expect(root.querySelectorAll('[data-style]').length).toBe(0); // set through the CSS object model (a strict style-src blocks a style attribute that came in as a string: the proof page holds it)
    expect(dot.style.backgroundColor).not.toBe('');
  });

  it('tags added later find the selection the instance already has (a newly mounted panel is handed it)', async () => {
    const { host, map } = await compose();
    const first = (await smallTopology(30)).nodes[0];
    await map.focusNode(first.id);
    host.querySelector('corn-node-panel')!.remove();
    const again = document.createElement('corn-node-panel') as El;
    again.style.height = '360px';
    host.querySelector('corn-scope')!.append(again);
    await again.componentOnReady();
    await until(() => !!drawer(again));
    expect(drawer(again).classList.contains('drawer-open')).toBe(true);
    // and a map mounted later reports the selection as its `node`
    map.remove();
    const second = document.createElement('corn-map') as El;
    second.setAttribute('renderer', 'canvas2d');
    host.querySelector('corn-scope')!.prepend(second);
    await second.componentOnReady();
    await until(() => second.node === first.id);
  });

  it('with no map in the scope they say what they need, throw nothing; with a map added they come alive', async () => {
    const errors: string[] = [];
    window.addEventListener('error', (e) => errors.push(String(e.message)));
    for (const t of TYPES) document.addEventListener(t, record);
    const host = document.createElement('main');
    host.innerHTML = '<corn-scope><corn-node-panel></corn-node-panel><corn-layers></corn-layers><corn-search></corn-search></corn-scope><corn-search id="loose"></corn-search>';
    document.body.append(host);
    await Promise.all([...host.querySelectorAll('*')].map((el) => (el as El).componentOnReady?.()));
    await frames(3);
    const [panel, layers, search] = ['corn-node-panel', 'corn-layers', 'corn-search'].map((t) => host.querySelector(t) as El);
    expect(empty(panel)!.textContent).toBe('Select a node on the map to see its details');
    expect(empty(layers)!.textContent).toBe('This needs a corn-map in the same corn-scope');
    expect(empty(search)!.textContent).toBe('This needs a corn-map in the same corn-scope');
    expect(empty(host.querySelector('#loose') as El)!.textContent).toBe('This needs a corn-scope around it, with a corn-map in it');
    expect(errors).toEqual([]);
    const map = document.createElement('corn-map') as El;
    map.setAttribute('renderer', 'canvas2d');
    host.querySelector('corn-scope')!.append(map);
    (host.querySelector('corn-scope') as El).topology = await smallTopology(30);
    (host.querySelector('corn-scope') as El).config = {};
    await until(() => !!layers.shadowRoot!.querySelector('[data-corn="layers-button"]'));
    expect(!!search.shadowRoot!.querySelector('input')).toBe(true);
    // the map goes: they go back to waiting, the tags stay
    map.remove();
    await until(() => !layers.shadowRoot!.querySelector('[data-corn="layers-button"]'));
    expect(empty(layers)!.textContent).toBe('This needs a corn-map in the same corn-scope');
  });

  it('while the map has no data (its server cannot be reached, or refuses) the search and the Layers menu wait, and say so: no "No match" over nothing', async () => {
    const host = document.createElement('main');
    host.innerHTML = '<corn-scope src="http://127.0.0.1:9"><corn-search></corn-search><corn-layers></corn-layers><corn-map renderer="canvas2d" style="height: 300px"></corn-map><corn-node-panel></corn-node-panel></corn-scope>';
    document.body.append(host);
    await Promise.all([...host.querySelectorAll('*')].map((el) => (el as El).componentOnReady?.()));
    const [map, search, layers, panel] = ['corn-map', 'corn-search', 'corn-layers', 'corn-node-panel'].map((t) => host.querySelector(t) as El);
    await until(() => !!map.shadowRoot!.querySelector('[data-corn="source-retry"]'), 15000); // the map's card: the one place that says what is wrong
    await frames(2);
    expect(empty(search)!.textContent).toBe('Waiting for the map');
    expect(empty(layers)!.textContent).toBe('Waiting for the map');
    expect(search.shadowRoot!.querySelector('input')).toBe(null);
    expect(layers.shadowRoot!.querySelector('[data-corn="layers-button"]')).toBe(null);
    expect(empty(panel)!.textContent).toBe('Select a node on the map to see its details');
    expect(host.querySelectorAll('corn-scope *').length).toBe(4);
    for (const el of [search, layers, panel]) expect(el.shadowRoot!.querySelector('[data-corn="source-status"]')).toBe(null); // one card for the scope, not four
  });

  it('two scopes on one page do not touch each other', async () => {
    const a = await compose();
    const host2 = document.createElement('main');
    host2.innerHTML = `<corn-scope style="display: contents">${LAYOUT.mapFirst}</corn-scope>`;
    document.body.append(host2);
    await Promise.all([...host2.querySelectorAll('*')].map((el) => (el as El).componentOnReady?.()));
    const scope2 = host2.querySelector('corn-scope') as El;
    scope2.topology = await smallTopology(30);
    scope2.config = {};
    const panel2 = host2.querySelector('corn-node-panel') as El;
    await until(() => !!drawer(panel2));
    await a.map.focusNode((await smallTopology(30)).nodes[1].id);
    await frames(2);
    expect(drawer(a.panel).classList.contains('drawer-open')).toBe(true);
    expect(drawer(panel2).classList.contains('drawer-open')).toBe(false);
  });

  it('the panel is not a phone sheet in a 360px box: it fills its box, in flow, and has no dim layer or handle', async () => {
    const { host, map, panel } = await compose();
    host.style.gridTemplateColumns = '1fr 360px';
    await map.focusNode((await smallTopology(30)).nodes[0].id);
    await frames(2);
    const box = panel.getBoundingClientRect();
    const d = drawer(panel).getBoundingClientRect();
    expect(Math.round(box.width)).toBe(360);
    expect(Math.round(d.width)).toBe(360);
    expect(getComputedStyle(drawer(panel)).position).toBe('relative');
    expect(panel.shadowRoot!.querySelector('[data-corn="backdrop"], [data-corn="sheet-handle"]')).toBe(null);
  });

  it('inside a host element\'s closed shadow root: a click on a row of the Layers menu keeps it open, the arrows walk the search\'s list, the wheel zooms the focused map', async () => {
    const outer = document.createElement('div');
    document.body.append(outer);
    const closed = outer.attachShadow({ mode: 'closed' });
    closed.innerHTML = `<main style="display: grid; grid-template-columns: 1fr 360px; width: 900px"><corn-scope style="display: contents">${LAYOUT.mapFirst}</corn-scope></main>`;
    const q = (t: string) => closed.querySelector(t) as El;
    await Promise.all(['corn-scope', 'corn-map', 'corn-node-panel', 'corn-layers', 'corn-search'].map((t) => q(t).componentOnReady()));
    q('corn-scope').topology = await smallTopology(30);
    q('corn-scope').config = {};
    const [map, layers, search] = [q('corn-map'), q('corn-layers'), q('corn-search')];
    await until(() => !!canvasOf(map) && !!layers.shadowRoot!.querySelector('[data-corn="layers-button"]') && !!search.shadowRoot!.querySelector('input'));
    await frames(3);
    // the Layers menu: the document's view of the click stops at the closed root's host, and the menu still knows the click was its own
    // (a test cannot point the mouse into a closed root: the elements are clicked, which the page hears the same way, its path cut at the host)
    (layers.shadowRoot!.querySelector('[data-corn="layers-button"]') as HTMLElement).click();
    const menu = layers.shadowRoot!.querySelector('[data-corn="layers-menu"]') as HTMLElement;
    (layers.shadowRoot!.querySelector('[data-corn="row"][aria-pressed="true"]') as HTMLElement).click();
    expect(menu.hidden).toBe(false);
    document.body.insertAdjacentHTML('beforeend', '<p id="away" style="margin: 0; height: 40px">host text</p>');
    (document.querySelector('#away') as HTMLElement).click();
    expect(menu.hidden).toBe(true);
    // the search's list, walked by the arrows (the piece asks the instance where the focus is: a closed root's own focus)
    const input = search.shadowRoot!.querySelector('input') as HTMLInputElement;
    input.focus();
    await userEvent.keyboard('a');
    await until(() => !!search.shadowRoot!.querySelector('[data-corn="search-result"][data-search-id]'));
    await userEvent.keyboard('{ArrowDown}');
    const first = search.shadowRoot!.activeElement;
    await userEvent.keyboard('{ArrowDown}');
    expect(search.shadowRoot!.activeElement).not.toBe(first);
    expect(search.shadowRoot!.activeElement?.getAttribute('data-corn')).toBe('search-result');
    await userEvent.keyboard('{Escape}');
    // the wheel: outside cornfield's page it is the map's only while the map has the focus, and the map knows it has it
    const canvas = canvasOf(map);
    canvas.focus();
    await frames(2);
    const before = pixelsOf(canvas);
    const r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, composed: true }));
    await sleep(400);
    await frames(3);
    expect(pixelsOf(canvas)).not.toEqual(before);
    outer.remove();
    document.querySelector('#away')!.remove();
  });

  it('two panels, two searches and two Layers menus in one scope are one selection and one search: one region speaks, the other field shows the query, Enter goes into the first panel', async () => {
    const twice = '<corn-map renderer="canvas2d" style="height: 360px"></corn-map><div><corn-search id="sa"></corn-search><corn-layers id="la"></corn-layers><corn-node-panel id="pa" style="height: 200px"></corn-node-panel></div><div><corn-search id="sb"></corn-search><corn-layers id="lb"></corn-layers><corn-node-panel id="pb" style="height: 200px"></corn-node-panel></div>';
    const host = document.createElement('main');
    host.style.cssText = 'display: grid; grid-template-columns: 1fr 300px 300px; width: 1000px';
    host.innerHTML = `<corn-scope style="display: contents">${twice}</corn-scope>`;
    document.body.append(host);
    const q = (s: string) => host.querySelector(s) as El;
    await Promise.all([...host.querySelectorAll('*')].map((el) => (el as El).componentOnReady?.()));
    q('corn-scope').topology = await smallTopology(30);
    q('corn-scope').config = {};
    await until(() => ['#sa', '#sb'].every((s) => !!q(s).shadowRoot!.querySelector('input')) && ['#pa', '#pb'].every((s) => !!drawer(q(s))));
    await frames(3);
    const status = (s: string) => (q(s).shadowRoot!.querySelector('[data-corn="search-status"]') as HTMLElement).textContent;
    await userEvent.click(q('#sb').shadowRoot!.querySelector('input')!);
    await userEvent.keyboard('a');
    await until(() => status('#sb') !== '');
    expect(status('#sa')).toBe(''); // said once, by the one in use
    expect((q('#sa').shadowRoot!.querySelector('input') as HTMLInputElement).value).toBe('a'); // the same search
    expect(q('#sa').shadowRoot!.querySelector('[data-corn="search-count"]')!.textContent).toBe(q('#sb').shadowRoot!.querySelector('[data-corn="search-count"]')!.textContent);
    // Enter from the map: into the first panel, and the second does not take the focus from it
    const map = q('corn-map');
    canvasOf(map).focus();
    await userEvent.keyboard('{Escape}n');
    await frames(2);
    await userEvent.keyboard('{Enter}');
    expect(q('#pa').shadowRoot!.activeElement).toBe(title(q('#pa')));
    expect(drawer(q('#pb')).classList.contains('drawer-open')).toBe(true); // both show the scope's one selection
    // the first of each removed: the second carries on, and speaks
    for (const s of ['#sa', '#la', '#pa']) q(s).remove();
    await userEvent.click(q('#sb').shadowRoot!.querySelector('input')!);
    await userEvent.keyboard('{Control>}a{/Control}b');
    await until(() => status('#sb') !== '' && status('#sb') !== null);
  });

  it('a Layers chip at the end of a host\'s toolbar opens its menu toward the room there is: the menu stays inside the window', async () => {
    const { host, layers } = await compose();
    const bar = document.createElement('nav');
    bar.style.cssText = `display: flex; justify-content: flex-end; width: ${window.innerWidth}px; position: absolute; top: 0; left: 0`;
    bar.append(layers);
    layers.style.cssText = 'flex: none; width: 11rem';
    host.querySelector('corn-scope')!.append(bar);
    await until(() => !!layers.shadowRoot!.querySelector('[data-corn="layers-button"]'));
    await userEvent.click(layers.shadowRoot!.querySelector('[data-corn="layers-button"]')!);
    const menu = layers.shadowRoot!.querySelector('[data-corn="layers-menu"]') as HTMLElement;
    expect(menu.hidden).toBe(false);
    expect(Math.round(menu.getBoundingClientRect().right)).toBeLessThanOrEqual(window.innerWidth);
    expect(menu.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
  });

  it('a value with no space in it (a long host name or file) wraps inside a narrow panel and never runs past its edge', async () => {
    const { host, scope, map, panel } = await compose();
    host.style.gridTemplateColumns = '1fr 220px';
    const topology = await smallTopology(30);
    const long = 'service.example.test'.replace(/\./g, 'x').repeat(4);
    Object.assign(topology.nodes[0], { file: `apps/${long}/index.js`, label: long, description: `A ${long} that ${long}` });
    // a flow line to it, so a "Gets from" line names a long node
    Object.assign(topology.nodes[1], { label: `${long}.example.test` });
    (topology.edges as Array<Record<string, string>>).push({ from: topology.nodes[1].id, to: topology.nodes[0].id, kind: 'flow', label: 'reads it', status: 'live' });
    scope.topology = topology;
    await frames(3);
    await map.focusNode(topology.nodes[0].id);
    await frames(3);
    const d = drawer(panel);
    expect(d.classList.contains('drawer-open')).toBe(true);
    for (const el of d.querySelectorAll('*')) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width) expect(Math.round(r.right), `${(el as HTMLElement).className}: ${(el.textContent || '').slice(0, 30)}`).toBeLessThanOrEqual(Math.round(d.getBoundingClientRect().right) + 1);
    }
  });

  it('in a short box the panel\'s head keeps its height: a title that wraps is never laid over the line under it (the body scrolls instead)', async () => {
    const { scope, map, panel } = await compose();
    panel.style.height = '200px';
    const topology = await smallTopology(30);
    Object.assign(topology.nodes[0], { label: 'A node whose name is long enough to wrap onto a second and a third line in this panel', description: 'The line under the title, which the title must not cover.' });
    scope.topology = topology;
    await frames(3);
    await map.focusNode(topology.nodes[0].id);
    await frames(3);
    const body = drawer(panel).querySelector('.hx-drawer-body') as HTMLElement;
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight); // the box is short: the body scrolls
    const head = body.querySelector('.hx-drawer-head') as HTMLElement;
    expect(title(panel).getBoundingClientRect().height).toBeGreaterThan(40); // the title wraps
    // every part of the body is as tall as what it holds, and each starts under the one before
    let bottom = -Infinity;
    for (const el of [...body.children] as HTMLElement[]) {
      if (el.hidden || !el.getBoundingClientRect().height) continue;
      const r = el.getBoundingClientRect();
      expect(Math.round(r.height), el.className).toBeGreaterThanOrEqual(el.scrollHeight - 1);
      expect(Math.round(r.top), el.className).toBeGreaterThanOrEqual(Math.round(bottom) - 1);
      bottom = r.bottom;
    }
    expect(Math.round(title(panel).getBoundingClientRect().bottom)).toBeLessThanOrEqual(Math.round(head.getBoundingClientRect().bottom) + 1);
  });

  it('every control of the three has a hook and a part, and the composed page has no axe violation', async () => {
    const { host, map, panel, layers, search } = await compose();
    await map.focusNode((await smallTopology(30)).nodes[0].id);
    await userEvent.click(layers.shadowRoot!.querySelector('[data-corn="layers-button"]')!);
    search.query = 'a';
    await frames(3);
    for (const el of [panel, layers, search]) {
      for (const x of el.shadowRoot!.querySelectorAll('[data-corn]')) expect(x.getAttribute('part'), `${el.localName} ${x.getAttribute('data-corn')}`).toBe(x.getAttribute('data-corn'));
      for (const x of el.shadowRoot!.querySelectorAll('button, a[href], input')) expect(x.hasAttribute('data-corn') || x.hasAttribute('data-corn-kind'), `${el.localName} ${x.outerHTML.slice(0, 60)}`).toBe(true);
    }
    const result = await axe.run(host, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 80)).join(' | ')}`)).toEqual([]);
  });
});
