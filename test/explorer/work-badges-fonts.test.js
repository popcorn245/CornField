/**
 * @vitest-environment happy-dom
 *
 * The Work layer's badges and a web font that arrives after the first paint (issue #285, as the label layer): the badges are placed with the widths of the names
 * and of the pills' text, measured once per font string and text. The family strings do not change when the font arrives, so without listening the widths of the
 * face used until then were kept. When the fonts finish loading the layer measures and places again at the next paint.
 */
import { describe, it, expect, afterEach } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { createWorkBadges } from '../../explorer/work-badges.js';
// @ts-expect-error plain JS modules, no declarations
import { PLAIN_STYLE } from '../../explorer/engine/map-style.js';

const node = (id, x, y) => ({
  id, type: 'page', x, y, r: 10, color: '#336699', alpha: 1, glow: 0, halo: 'none', mark: 'none',
  selected: false, match: false, current: false, degree: 0, connected: true,
  label: id, labelSize: 11, labelBold: false, labelAlpha: 1, labelColor: '#fff', labelKeep: false,
});
const scene = { nodes: [node('alpha', 100, 200), node('beta', 300, 200)], edges: [], decor: { grid: null, rings: [], lanes: [] }, preset: false, version: 1 };
const index = new Map([['alpha', [{ id: 'w1', kind: 'pull', tag: 'PR #27', title: 'A change', waiting: false, state: 'open' }]]]);
const CAM = { x: 0, y: 0, zoom: 1 };

let stage = null;
afterEach(() => { if (stage) stage.remove(); stage = null; });

/** A document whose canvas measures `face.px` px per character, and whose `fonts` is a fake FontFaceSet */
function rig({ withFonts = true } = {}) {
  const face = { px: 6 };
  const measured = [];
  const ctx = { font: '', measureText: (s) => { measured.push(s); return { width: s.length * face.px }; } };
  const fonts = withFonts ? new EventTarget() : undefined;
  let listeners = 0;
  if (fonts) {
    const add = fonts.addEventListener.bind(fonts), remove = fonts.removeEventListener.bind(fonts);
    fonts.addEventListener = (...a) => { listeners++; add(...a); };
    fonts.removeEventListener = (...a) => { listeners--; remove(...a); };
  }
  const doc = { fonts, createElement: (tag) => (tag === 'canvas' ? { getContext: () => ctx } : document.createElement(tag)) };
  stage = document.createElement('div');
  document.body.append(stage);
  const state = { width: 800, height: 600, theme: 'dark' };
  const badges = createWorkBadges({ stage, state, style: () => PLAIN_STYLE, colorOf: () => '#f80', wanted: () => index, doc });
  return { badges, face, measured, fonts, listeners: () => listeners };
}

describe('work badges and a web font that arrives late', () => {
  it('measures the names and the pills again, and places the badges again, when the fonts finish loading', () => {
    const { badges, face, measured, fonts } = rig();
    badges.sync(scene, CAM);
    const first = measured.length;
    expect(first).toBeGreaterThan(0);
    expect(stage.querySelectorAll('[data-corn="work-badge"]').length).toBe(1);
    badges.sync(scene, CAM); // nothing changed: nothing measured
    expect(measured.length).toBe(first);

    face.px = 9; // the web font arrives: the same text is wider
    fonts.dispatchEvent(new Event('loadingdone'));
    badges.sync(scene, CAM);
    expect(measured.length).toBeGreaterThan(first); // measured again
    expect(measured.slice(first)).toEqual(expect.arrayContaining(['alpha', 'PR #27']));
    expect(stage.querySelectorAll('[data-corn="work-badge"]').length).toBe(1); // and still drawn
  });

  it('does not measure again without a font event', () => {
    const { badges, measured } = rig();
    badges.sync(scene, CAM);
    const n = measured.length;
    badges.sync(scene, { x: 5, y: 5, zoom: 1 });
    expect(measured.length).toBe(n);
  });

  it('stops listening when it is destroyed', () => {
    const { badges, listeners } = rig();
    expect(listeners()).toBe(1);
    badges.destroy();
    expect(listeners()).toBe(0);
  });

  it('works where there is no document.fonts', () => {
    const { badges } = rig({ withFonts: false });
    badges.sync(scene, CAM);
    expect(stage.querySelectorAll('[data-corn="work-badge"]').length).toBe(1);
    expect(() => badges.destroy()).not.toThrow();
  });
});
