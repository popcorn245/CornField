/**
 * @vitest-environment happy-dom
 *
 * A theme's web font that arrives after the first draw (issue #285): the label layer measured every text in the fallback
 * face and kept the widths, because the font-family string does not change. When the fonts finish loading it measures again.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { createLabelLayer } from '../../explorer/labels.js';

const node = (id, x, y) => ({
  id, type: 'page', x, y, r: 10, color: '#336699', alpha: 1, glow: 0, halo: 'none', mark: 'none',
  selected: false, match: false, current: false, degree: 0, connected: true,
  label: id, labelSize: 11, labelBold: false, labelAlpha: 1, labelColor: '#fff', labelKeep: false,
});
const scene = () => ({ nodes: [node('alpha', 100, 100), node('beta', 200, 100)], edges: [], decor: { grid: null, rings: [], lanes: [] }, preset: false, version: 1 });

/** A canvas whose document has a fake `fonts`, and a context whose text is `face.px` px wide per character */
function rig({ withFonts = true } = {}) {
  const face = { px: 6 };
  const measured = [];
  const ctx = new Proxy({}, { get: (_t, key) => (key === 'measureText' ? (s) => { measured.push(s); return { width: s.length * face.px }; } : () => {}), set: () => true });
  const fonts = withFonts ? new EventTarget() : undefined;
  let listeners = 0;
  if (fonts) {
    const add = fonts.addEventListener.bind(fonts), remove = fonts.removeEventListener.bind(fonts);
    fonts.addEventListener = (...a) => { listeners++; add(...a); };
    fonts.removeEventListener = (...a) => { listeners--; remove(...a); };
  }
  const canvas = { width: 0, height: 0, getContext: () => ctx, ownerDocument: { fonts } };
  const layer = createLabelLayer(canvas);
  layer.resize(800, 600, 1);
  return { layer, face, measured, fonts, listeners: () => listeners };
}
const CAM = { x: 0, y: 0, zoom: 1 };

describe('label widths and a web font that arrives late', () => {
  it('measures the texts again, and lays the labels out again, when the fonts finish loading', () => {
    const { layer, face, measured, fonts } = rig();
    const s = scene();
    expect(layer.draw(s, CAM)).toBe(true);
    const first = measured.length;
    expect(first).toBeGreaterThan(0);
    expect(layer.draw(s, CAM)).toBe(false); // nothing changed: nothing drawn, nothing measured
    expect(measured.length).toBe(first);

    face.px = 9; // the web font arrives: the same text is wider
    fonts.dispatchEvent(new Event('loadingdone'));
    expect(layer.draw(s, CAM)).toBe(true); // laid out again
    expect(measured.length).toBeGreaterThan(first); // and measured again
    expect(measured.slice(first)).toContain('alpha');
  });

  it('does not measure again without a font event', () => {
    const { layer, measured } = rig();
    const s = scene();
    layer.draw(s, CAM);
    const n = measured.length;
    layer.draw(s, { x: 5, y: 5, zoom: 1 });
    expect(measured.length).toBe(n);
  });

  it('stops listening when it is destroyed', () => {
    const { layer, listeners } = rig();
    expect(listeners()).toBe(1);
    layer.destroy();
    expect(listeners()).toBe(0);
  });

  it('works where there is no document.fonts', () => {
    const { layer } = rig({ withFonts: false });
    expect(layer.draw(scene(), CAM)).toBe(true);
    expect(() => layer.destroy()).not.toThrow();
  });
});
