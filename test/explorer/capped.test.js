/**
 * @vitest-environment happy-dom
 *
 * A long list in the node panel: the first five items, then a disclosure button that opens the rest in place.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { capped, toggleCapped, CAP } from '../../explorer/capped.js';

const items = (n) => Array.from({ length: n }, (_, i) => `<div>item ${i}</div>`);

describe('capped lists', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('leaves a short list alone', () => {
    expect(capped(items(CAP + 1))).not.toContain('data-more');
  });

  it('folds a long list after five and says how many more', () => {
    document.body.innerHTML = capped(items(20));
    const button = document.querySelector('[data-more]');
    expect(button.textContent).toBe('and 15 more');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(button.dataset.more).hidden).toBe(true);
  });

  it('opens and folds in place', () => {
    document.body.innerHTML = capped(items(20));
    const button = document.querySelector('[data-more]');
    expect(toggleCapped(button)).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(button.dataset.more).hidden).toBe(false);
    expect(button.textContent).toBe('Show fewer');
    toggleCapped(button);
    expect(button.textContent).toBe('and 15 more');
    expect(toggleCapped(document.body)).toBe(false);
  });
});
