import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { bigTopology, canvasOf, frames, mountMap, pixelsOf, sleep, smallTopology, steady } from './support';

afterEach(() => { document.body.innerHTML = ''; document.documentElement.removeAttribute('data-theme'); });

describe('drawing', () => {
  it('draws the topology: an element with a map shows something an element with none does not', async () => {
    const empty = await mountMap({ renderer: 'canvas2d' });
    await frames(2);
    const drawn = await mountMap({ renderer: 'canvas2d' }, { topology: await bigTopology() });
    const [none, some] = [pixelsOf(canvasOf(empty)), pixelsOf(canvasOf(drawn))];
    expect(some.hash).not.toBe(none.hash);
    expect(some.lit).toBeGreaterThan(none.lit); // nodes and lines over the grid
  });

  it('uses WebGL2 by default (the canvas cannot give a 2d context) and Canvas 2D when asked', async () => {
    const auto = await mountMap({}, { topology: await smallTopology() });
    expect(canvasOf(auto).getContext('2d')).toBe(null);
    const plain = await mountMap({ renderer: 'canvas2d' }, { topology: await smallTopology() });
    expect(canvasOf(plain).getContext('2d')).not.toBe(null);
  });

  it('fills the box its host gives it, and follows it when it changes', async () => {
    const el = await mountMap({ renderer: 'canvas2d' }, { topology: await smallTopology(), style: 'width: 500px; height: 300px' });
    const box = () => canvasOf(el).getBoundingClientRect();
    expect([box().width, box().height]).toEqual([500, 300]);
    el.style.width = '320px';
    el.style.height = '280px';
    await sleep(100);
    await frames(2);
    expect([box().width, box().height]).toEqual([320, 280]);
    expect(canvasOf(el).width).toBe(Math.round(320 * devicePixelRatio));
  });

  it('with no height of its own, is a visible box, and never as tall as the window', async () => {
    const el = await mountMap({}, { style: 'width: 400px' });
    expect(el.getBoundingClientRect().height).toBeGreaterThanOrEqual(200);
    expect(el.getBoundingClientRect().height).toBeLessThan(innerHeight);
  });

  it('draws the data-flow view differently from the map, and the map again after it', async () => {
    const el = await mountMap({ renderer: 'canvas2d' }, { topology: await bigTopology() });
    const map = (await steady(canvasOf(el))).hash;
    el.view = 'dataflow';
    const flow = (await steady(canvasOf(el))).hash;
    expect(flow).not.toBe(map);
    el.view = 'map';
    expect((await steady(canvasOf(el))).hash).toBe(map);
  });

  it('says cornReady once, after the first frame with a map in it', async () => {
    const el = await mountMap({ renderer: 'canvas2d' });
    const ready = vi.fn();
    el.addEventListener('cornReady', ready);
    await frames(3);
    expect(ready).not.toHaveBeenCalled();
    el.topology = await smallTopology();
    await sleep(150);
    expect(ready).toHaveBeenCalledTimes(1);
    el.topology = await smallTopology(10);
    await sleep(150);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('fit() brings the whole map back after the camera has been moved', async () => {
    const el = await mountMap({ renderer: 'canvas2d' }, { topology: await bigTopology() });
    const fitted = (await steady(canvasOf(el))).hash;
    canvasOf(el).focus();
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}{+}');
    expect((await steady(canvasOf(el))).hash).not.toBe(fitted);
    await el.fit();
    expect((await steady(canvasOf(el))).hash).toBe(fitted);
  });
});

describe('selection', () => {
  it('node selects, and the selection comes back: the attribute is reflected and cornSelect fires for each change, from anywhere', async () => {
    const topology = await smallTopology();
    const el = await mountMap({ renderer: 'canvas2d' }, { topology });
    const seen: Array<{ id: string | null; kind: string }> = [];
    el.addEventListener('cornSelect', (e) => seen.push((e as CustomEvent).detail));
    const [a, b] = [topology.nodes[3].id, topology.nodes[5].id];

    el.node = a;
    await frames(2);
    expect(seen).toEqual([{ id: a, kind: 'node', source: 'api' }]);
    expect(el.getAttribute('node')).toBe(a);

    await el.focusNode(b);
    await frames(2);
    expect(seen.at(-1)).toEqual({ id: b, kind: 'node', source: 'api' });
    expect(el.node).toBe(b);
    expect(el.getAttribute('node')).toBe(b);

    el.setAttribute('node', a); // the attribute is a way in too
    await frames(2);
    expect(seen.at(-1)).toEqual({ id: a, kind: 'node', source: 'api' });

    el.node = null;
    await frames(2);
    expect(seen.at(-1)).toEqual({ id: null, kind: null, source: 'api' });
    expect(el.hasAttribute('node')).toBe(false);
    expect(seen).toHaveLength(4);
  });

  it('a key selects, and the event carries the id the host can read back', async () => {
    const el = await mountMap({ renderer: 'canvas2d' }, { topology: await smallTopology() });
    const seen: Array<{ id: string | null }> = [];
    el.addEventListener('cornSelect', (e) => seen.push((e as CustomEvent).detail));
    canvasOf(el).focus();
    await userEvent.keyboard('n');
    await frames(2);
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBeTruthy();
    expect(el.node).toBe(seen[0].id);
    expect(seen[0]).toMatchObject({ kind: 'node', source: 'keyboard' });
    await userEvent.keyboard('{Escape}');
    await frames(2);
    expect(seen.at(-1)).toEqual({ id: null, kind: null, source: 'keyboard' });
  });

  it('a click on a node selects it, and a click on the bare map clears it (a real mouse)', async () => {
    const topology = await smallTopology(8);
    const el = await mountMap({ renderer: 'canvas2d' }, { topology, style: 'width: 600px; height: 400px; margin: 0' });
    const seen: Array<{ id: string | null }> = [];
    el.addEventListener('cornSelect', (e) => seen.push((e as CustomEvent).detail));
    const canvas = canvasOf(el);
    // find a node by clicking over a grid until one answers
    outer: for (let y = 60; y < 360; y += 12) for (let x = 60; x < 540; x += 12) {
      await userEvent.click(canvas, { position: { x, y } });
      if (seen.some((s) => s.id)) break outer;
    }
    expect(seen.find((s) => s.id)).toBeTruthy();
    const picked = seen.find((s) => s.id)!.id;
    expect(el.node).toBe(picked);
    expect(seen.find((s) => s.id)).toMatchObject({ kind: 'node', source: 'tap' });
    await userEvent.click(canvas, { position: { x: 3, y: 3 } });
    await frames(2);
    expect(seen.at(-1)).toEqual({ id: null, kind: null, source: 'tap' });
  });

  it('keyboard shortcuts act only while focus is inside the map', async () => {
    const el = await mountMap({ renderer: 'canvas2d' }, { topology: await smallTopology() });
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    await userEvent.keyboard('n');
    await frames(2);
    expect(el.node ?? null).toBe(null);
    canvasOf(el).focus();
    await userEvent.keyboard('n');
    await frames(2);
    expect(el.node).toBeTruthy();
  });
});

describe('two maps in one page', () => {
  it('stay independent: a selection, a camera and a topology of one change nothing in the other', async () => {
    const big = await mountMap({ renderer: 'canvas2d' }, { topology: await bigTopology(), style: 'width: 400px; height: 300px; display: inline-block' });
    const small = await mountMap({ renderer: 'canvas2d' }, { topology: await smallTopology(), style: 'width: 400px; height: 300px; display: inline-block' });
    const before = pixelsOf(canvasOf(big)).hash;
    const seenBig = vi.fn();
    big.addEventListener('cornSelect', seenBig);
    small.node = (await smallTopology()).nodes[2].id;
    canvasOf(small).focus();
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}{+}');
    await frames(3);
    expect(seenBig).not.toHaveBeenCalled();
    expect(big.node ?? null).toBe(null);
    expect(pixelsOf(canvasOf(big)).hash).toBe(before);
    expect(pixelsOf(canvasOf(small)).hash).not.toBe(pixelsOf(canvasOf(big)).hash);
    expect(canvasOf(big)).not.toBe(canvasOf(small));
  });
});

describe('a drag released outside the map', () => {
  it('ends where it was let go: moving the pointer afterwards does not pan', async () => {
    const el = await mountMap({ renderer: 'canvas2d' }, { topology: await bigTopology(), style: 'width: 400px; height: 300px; margin: 120px' });
    const canvas = canvasOf(el);
    const rect = canvas.getBoundingClientRect();
    const start = pixelsOf(canvas).hash;
    const target = document.createElement('div');
    target.style.cssText = 'position: fixed; right: 0; bottom: 0; width: 80px; height: 80px';
    document.body.append(target);
    await userEvent.dragAndDrop(canvas, target, { sourcePosition: { x: rect.width / 2, y: rect.height / 2 } });
    await frames(3);
    const dragged = pixelsOf(canvas).hash;
    expect(dragged).not.toBe(start); // it panned while the button was down
    await userEvent.hover(canvas, { position: { x: 30, y: 30 } });
    await userEvent.hover(canvas, { position: { x: 200, y: 150 } });
    await frames(3);
    expect(pixelsOf(canvas).hash).toBe(dragged); // and stopped when it was let go outside
  });
});

describe('mounting and unmounting', () => {
  it('30 times leaves nothing: no map in the page, no canvas kept by a removed element, and no "too many contexts"', async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); warn(...a); };
    const topology = await smallTopology();
    const canvases = new Set<HTMLCanvasElement>();
    for (let i = 0; i < 30; i++) {
      const el = await mountMap({}, { topology });
      const canvas = canvasOf(el);
      expect(canvases.has(canvas)).toBe(false);
      canvases.add(canvas);
      expect(canvas.getContext('2d')).toBe(null); // WebGL: a context was taken
      el.remove();
      expect(el.shadowRoot!.childElementCount).toBe(0); // nothing kept
    }
    console.warn = warn;
    expect(document.querySelectorAll('corn-map')).toHaveLength(0);
    expect(warnings.filter((w) => /too many/i.test(w))).toEqual([]);
    // and the page can still make a context of its own
    expect(document.createElement('canvas').getContext('webgl2')).not.toBe(null);
  });

  it('an element taken out and put back makes new canvases and works again', async () => {
    const topology = await smallTopology();
    const el = await mountMap({ renderer: 'canvas2d' }, { topology });
    const first = canvasOf(el);
    el.remove();
    expect(first.isConnected).toBe(false);
    const ready = new Promise<void>((resolve) => el.addEventListener('cornReady', () => resolve(), { once: true }));
    document.body.append(el);
    await ready;
    await frames(2);
    const second = canvasOf(el);
    expect(second).not.toBe(first);
    expect(el.shadowRoot!.querySelectorAll('canvas[data-corn="map-canvas"]')).toHaveLength(1);
    expect(pixelsOf(second).lit).toBeGreaterThan(200);
    canvasOf(el).focus();
    await userEvent.keyboard('n');
    expect(el.node).toBeTruthy();
  });
});
