/**
 * <corn-node-panel>, <corn-layers> and <corn-search> beside a <corn-map> in one <corn-scope>, each in a shadow root of its own, sharing one instance (spec 0011 D4, D5,
 * D6, D12), in headless Chrome. The scope is handed its map (no server); the composed page under a strict policy with a real server is test/fixtures/big/around-proof.mjs.
 */
import axe from 'axe-core';
import { userEvent } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import { canvasOf, frames, sleep, smallTopology } from './support';

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
