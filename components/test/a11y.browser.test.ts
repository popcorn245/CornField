import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { canvasOf, frames, mountMap, smallTopology } from './support';

afterEach(() => { document.body.innerHTML = ''; });

async function audit(root: Element = document.body) {
  const result = await axe.run(root, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
  return result.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

describe('accessibility of <corn-map>', () => {
  it('axe finds nothing on a map in a page, dark and light, empty and drawn', async () => {
    const main = document.createElement('main');
    document.body.append(main);
    for (const theme of ['dark', 'light']) {
      const el = await mountMap({ theme, renderer: 'canvas2d' }, { topology: await smallTopology(), parent: main });
      expect(await audit(), theme).toEqual([]);
      await el.focusNode((await smallTopology()).nodes[1].id);
      await frames(2);
      expect(await audit(), `${theme}, a node selected`).toEqual([]);
      el.remove();
    }
    await mountMap({}, { parent: main });
    expect(await audit(), 'empty').toEqual([]);
  });

  it('the canvas has a name and a description, and is reached by Tab', async () => {
    const main = document.createElement('main');
    document.body.append(main);
    const before = document.createElement('button');
    before.textContent = 'before';
    main.append(before);
    const el = await mountMap({ renderer: 'canvas2d' }, { topology: await smallTopology(), parent: main });
    const canvas = canvasOf(el);
    expect(canvas.getAttribute('aria-label')).toBe('Topology map');
    expect(canvas.getAttribute('role')).toBe('application');
    const described = el.shadowRoot!.getElementById(canvas.getAttribute('aria-describedby')!);
    expect(described?.textContent).toMatch(/Arrow keys pan/);
    before.focus();
    await userEvent.tab();
    expect(el.shadowRoot!.activeElement).toBe(canvas);
    expect(getComputedStyle(canvas).outlineStyle).not.toBe('none'); // the focus ring (:focus-visible after a key)
    expect(parseFloat(getComputedStyle(canvas).outlineWidth)).toBeGreaterThan(0);
  });

  it('says where the keyboard landed in a polite live region', async () => {
    const el = await mountMap({ renderer: 'canvas2d' }, { topology: await smallTopology() });
    canvasOf(el).focus();
    await userEvent.keyboard('n');
    await new Promise((r) => setTimeout(r, 120));
    const live = el.shadowRoot!.querySelector('[aria-live="polite"]')!;
    expect(live.getAttribute('role')).toBe('status');
    expect(live.textContent).toMatch(/1 of 14/);
  });
});
