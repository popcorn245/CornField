// @vitest-environment happy-dom
/**
 * The old `hooks` of explorer/proposal.js, kept as accessors that register the function as a listener of the page's instance (spec 0011 step 5).
 * The modules not yet on an instance (whatif.js, mockups.js, forge-panel.js) assign and wrap them as they did: one registration per hook, the chain in
 * the order it was built, and `reviewed` silent when another proposal was opened while the review was sent, as it was.
 */
import { describe, it, expect, afterEach } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { hooks } from '../../explorer/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import { pageInstance } from '../../explorer/state.js';

const inst = pageInstance();
afterEach(() => { for (const name of Object.keys(hooks)) hooks[name] = null; });

describe('the old hooks, as listeners of the page instance', () => {
  it('a wrapped chain runs once, in the order it was built, and reads back as the last function assigned', () => {
    const order = [];
    const whatif = () => order.push('whatif');
    hooks.bar = whatif;
    expect(hooks.bar).toBe(whatif);
    for (const name of ['mockups', 'forge']) {
      const before = hooks.bar;
      const mine = (open) => { if (before) before(open); order.push(`${name}:${open}`); };
      hooks.bar = mine;
      expect(hooks.bar).toBe(mine);
    }
    inst.emit('proposal:bar', { open: true });
    expect(order).toEqual(['whatif', 'mockups:true', 'forge:true']); // each assignment took the last registration back
    hooks.bar = null;
    order.length = 0;
    inst.emit('proposal:bar', { open: false });
    expect(order).toEqual([]);
  });

  it('reviewed: after the server took a review of the open proposal, not after another one was opened while it was sent (as before)', () => {
    let n = 0;
    hooks.reviewed = () => { n++; };
    inst.emit('decision', { outcome: 'approved', slug: 'a', source: 'pull/1', open: false });
    expect(n).toBe(0);
    inst.emit('decision', { outcome: 'approved', slug: 'a', source: 'pull/1', open: true });
    expect(n).toBe(1);
  });

  it('the asks answer through them: effective, beforeClose and openSpecs', () => {
    hooks.effective = (p) => ({ ...p, edited: true });
    hooks.beforeClose = () => false;
    hooks.openSpecs = () => {};
    expect(inst.ask('proposal:effective', { title: 'x' })).toEqual({ title: 'x', edited: true });
    expect(inst.ask('proposal:before-close')).toBe(false);
    expect(inst.ask('work:open-specs')).toBe(true);
    hooks.openSpecs = null;
    expect(inst.ask('work:open-specs')).toBeUndefined();
  });
});
