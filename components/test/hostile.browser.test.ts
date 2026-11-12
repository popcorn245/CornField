import { afterEach, describe, expect, it } from 'vitest';
import { canvasOf, frames, mountMap, pixelsOf, smallTopology } from './support';

afterEach(() => { document.head.querySelectorAll('style[data-hostile]').forEach((s) => s.remove()); document.body.innerHTML = ''; });

const HOSTILE = `
  * { all: revert; }
  * { box-sizing: content-box; margin: 7px; padding: 5px; border: 3px solid red; }
  div, p, span { display: none; }
  canvas { display: none; width: 3px; height: 3px; position: static; cursor: crosshair; border: 6px dashed red; }
  button, [role="application"], [aria-live] { display: none; outline: 5px solid red; }
  [data-corn] { display: none; visibility: hidden; }
  canvas, p, div { all: unset; }
`;

/** What the elements inside the shadow root look like, and where they are: the things a page's CSS could change if it reached them */
function look(el: HTMLElement) {
  const out: Record<string, unknown> = {};
  for (const node of el.shadowRoot!.querySelectorAll('[data-corn], p, canvas')) {
    const cs = getComputedStyle(node);
    const r = node.getBoundingClientRect();
    out[`${node.tagName}#${node.id || node.getAttribute('data-corn')}`] = [cs.display, cs.position, cs.boxSizing, cs.margin, cs.padding, cs.borderTopWidth, cs.cursor, cs.visibility, cs.outlineStyle, Math.round(r.width), Math.round(r.height)].join('|');
  }
  return out;
}

describe('a host page with hostile global CSS', () => {
  it('does not change the map: the same elements, the same boxes, the same picture', async () => {
    const topology = await smallTopology(40);
    // The host's box is the host's own (an inline style: what a page sets on the element it places); everything inside is the map's
    const el = await mountMap({ renderer: 'canvas2d', theme: 'dark' }, { topology, style: 'width: 420px; height: 300px' });
    await frames(3);
    const before = { look: look(el), pixels: pixelsOf(canvasOf(el)), box: el.getBoundingClientRect().toJSON() };
    expect(Object.keys(before.look).length).toBeGreaterThanOrEqual(5);

    const style = document.createElement('style');
    style.setAttribute('data-hostile', '');
    style.textContent = HOSTILE;
    document.head.append(style);
    await frames(3);
    await el.fit();
    await frames(4);

    expect(look(el)).toEqual(before.look);
    expect(pixelsOf(canvasOf(el))).toEqual(before.pixels);
    expect(getComputedStyle(el).display).toBe('block'); // `all: revert` on the host would make it inline: the one thing it keeps for itself
    const canvas = canvasOf(el).getBoundingClientRect(); // the host's own border and padding (the page's rule) are the host's: what is inside is 420 by 300 still
    expect([canvas.width, canvas.height]).toEqual([420, 300]);
  });

  it('and still takes input and says what it selects', async () => {
    const topology = await smallTopology(40);
    const el = await mountMap({ renderer: 'canvas2d' }, { topology });
    const style = document.createElement('style');
    style.setAttribute('data-hostile', '');
    style.textContent = HOSTILE;
    document.head.append(style);
    let id: string | null = null;
    el.addEventListener('cornSelect', (e) => { id = (e as CustomEvent).detail.id; });
    el.node = topology.nodes[2].id;
    await frames(3);
    expect(id).toBe(topology.nodes[2].id);
    expect(canvasOf(el).getBoundingClientRect().width).toBeGreaterThan(100);
  });
});
