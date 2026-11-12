// @vitest-environment happy-dom
/**
 * The Key in the Layers menu (spec 0008 D7): each kind of line drawn with its real style and end mark, one meaning per style,
 * the same shapes the renderers draw (they read the same constants), nothing from the map in it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { edgeKeyHtml, keySwatch, KEY_ROWS } from '../../explorer/edge-key.js';
// @ts-expect-error plain JS modules, no declarations
import { END_MARKS, PROPOSED_DASH, USAGE_DASH } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { renderFlowLegend } from '../../explorer/flows.js';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';

import { withMapElements } from '../helpers.js';
const page = withMapElements(fs.readFileSync(path.resolve(__dirname, '../../explorer/index.html'), 'utf8'));

describe('the Key', () => {
  it('draws a row for every family of end mark, owns, usage and proposed, each as an SVG with the real line', () => {
    document.body.innerHTML = `<div id="k">${edgeKeyHtml()}</div>`;
    const svgs = [...document.querySelectorAll('#k svg.hx-key-line')];
    expect(svgs).toHaveLength(KEY_ROWS.length);
    expect(svgs.every((s) => s.getAttribute('aria-hidden') === 'true')).toBe(true);
    for (const end of new Set(Object.values(END_MARKS))) expect(KEY_ROWS.some(([o]) => o.end === end), end).toBe(true);
    const dashes = svgs.map((s) => s.querySelector('path').getAttribute('stroke-dasharray'));
    expect(dashes.filter(Boolean).sort()).toEqual([PROPOSED_DASH.join(' '), USAGE_DASH.join(' ')].sort()); // exactly two patterns: dotted for usage, dashed for proposed
  });

  it('draws ticks across the middle of a `when` swatch: none, one, two', () => {
    const ticks = (n) => (keySwatch({ end: 'triangle', ticks: n }).match(/<path/g) || []).length;
    expect(ticks(1) - ticks(0)).toBe(1);
    expect(ticks(2) - ticks(0)).toBe(2);
  });

  it('is in the Layers menu with its hook, and the Data Flow legend no longer has its own Dashed line', () => {
    expect(page).toMatch(/id="edge-key"[^>]*data-corn="legend-key"/);
    document.body.innerHTML = '<div id="flow-legend"></div>';
    state.activeLayers.flow = true;
    renderFlowLegend();
    expect($legend().textContent).not.toMatch(/Dashed|Solid: live/);
  });
});
const $legend = () => document.getElementById('flow-legend');

describe('a dash means only "proposed" (spec 0008 D7)', () => {
  it('no proposal mark draws its line in a usage link\'s dots: a what-if edit is long-dashed, added dashed, removed short-dashed and struck', async () => {
    const { USAGE_DASH, PROPOSED_DASH } = await import('../../explorer/scene.js');
    const { MARK_SHAPES } = await import('../../explorer/diff-marks.js');
    const dashes = Object.values(MARK_SHAPES).map((m) => m.edgeDash).filter(Boolean);
    for (const d of dashes) expect(d[0], String(d)).toBeGreaterThanOrEqual(2 * USAGE_DASH[0]); // a dash, not a dot
    expect(MARK_SHAPES.edit.edgeDash).toEqual([12, 4]);
    expect(new Set(dashes.map(String)).size).toBe(dashes.length); // each mark its own rhythm
    expect(MARK_SHAPES.added.edgeDash).toEqual(PROPOSED_DASH);
  });
});

