import { afterEach, describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { sleep } from './support';

afterEach(() => { document.body.innerHTML = ''; });

async function openDemo(width = 1000, height = 800) {
  const frame = document.createElement('iframe');
  frame.style.cssText = `width: ${width}px; height: ${height}px; border: 0`;
  frame.src = '/demo/index.html';
  const errors: string[] = [];
  document.body.append(frame);
  await new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
  frame.contentWindow!.addEventListener('error', (e) => errors.push(e.message));
  for (let i = 0; i < 200 && frame.contentDocument!.querySelectorAll('corn-map[data-ready]').length < 2; i++) await sleep(100);
  return { frame, doc: frame.contentDocument!, win: frame.contentWindow!, errors };
}

describe('the demo page', () => {
  it('shows two maps side by side from the synthetic fixture, one forced light and one dark, inside a page with its own styles', async () => {
    await commands.colorScheme('dark');
    const { doc, win, errors } = await openDemo();
    const [light, dark] = [doc.querySelector('#light')!, doc.querySelector('#dark')!];
    expect(doc.querySelectorAll('corn-map[data-ready]')).toHaveLength(2);
    const [a, b] = [light.getBoundingClientRect(), dark.getBoundingClientRect()];
    expect(a.left).toBeLessThan(b.left);
    expect(Math.abs(a.top - b.top)).toBeLessThan(2); // side by side
    expect(a.right).toBeLessThanOrEqual(b.left + 1);
    expect(win.getComputedStyle(light).getPropertyValue('--corn-ground').trim()).toBe('#f4f6fa');
    expect(win.getComputedStyle(dark).getPropertyValue('--corn-ground').trim()).toBe('#101a2e'); // the page's own rule on #dark beats cornfield's default
    // the page's `canvas { border }` and `button` rules are the page's: they do not reach the maps
    const canvas = light.shadowRoot!.querySelector('canvas')!;
    expect(win.getComputedStyle(canvas).borderTopWidth).toBe('0px');
    expect(win.getComputedStyle(doc.querySelector('#fit')!).fontStyle).toBe('italic');
    expect(errors).toEqual([]);
  });

  it('shows a review under the maps: a proposal of the fixture on its map, handed in as objects, read only', async () => {
    const { doc, win, errors } = await openDemo();
    const review = doc.querySelector('#review')!;
    for (let i = 0; i < 100 && !review.hasAttribute('data-ready'); i++) await sleep(100);
    expect(review.hasAttribute('data-ready')).toBe(true);
    for (let i = 0; i < 50 && !(review.shadowRoot!.querySelector('#proposal-title')?.textContent || '').length; i++) await sleep(100);
    expect(review.shadowRoot!.querySelector('#proposal-title')!.textContent!.length).toBeGreaterThan(3);
    expect(review.shadowRoot!.querySelector('#review-line')!.textContent).toMatch(/read only/);
    expect(win.getComputedStyle(review.shadowRoot!.querySelector('button')!).fontStyle).not.toBe('italic'); // the page's `button` rule is the page's
    expect(review.getBoundingClientRect().height).toBeGreaterThanOrEqual(600);
    expect(errors).toEqual([]);
  });

  it('keeps the two maps on one screen at a phone\'s width, stacked, without a sideways scroll', async () => {
    const { doc, win } = await openDemo(390, 844);
    const [a, b] = [doc.querySelector('#light')!.getBoundingClientRect(), doc.querySelector('#dark')!.getBoundingClientRect()];
    expect(b.top).toBeGreaterThan(a.bottom - 1);
    expect(doc.documentElement.scrollWidth).toBeLessThanOrEqual(win.innerWidth);
  });
});
