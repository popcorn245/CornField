/**
 * A map alone does not carry the review (spec 0011 D11, the size budget). A bundler leaves out the exports of a module that no entry uses, but a
 * module two entries share is one chunk, so `<corn-map>` loads every export of it that `<corn-review>` uses. So what only a review uses (the
 * sheets, the proposal bar's and the panel's words, the checks, the outage scenario, a review's camera moves) lives in modules that a map does not
 * import: this walks the static imports from the `<corn-map>` shell and the map piece, as the bundler does, and fails when one of those is reached.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The modules a file reaches through its static imports and re-exports (a dynamic `import()` is a chunk of its own, loaded later) */
function reach(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/(?:^|[;\n])\s*(?:import|export)\s*(?:[^'"();]*?\sfrom\s*)?['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), m[1].replace(/\?.*$/, ''));
      if (/\.(js|ts|tsx)$/.test(target)) walk(target);
    }
  };
  walk(path.join(ROOT, entry));
  return [...seen].map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
}

/** What only a review (or cornfield's page) uses, each in a module of its own */
const REVIEW_ONLY = [
  'explorer/engine/sheets.js', // the phone's sheets (a map reads only what they cover: engine/map-rect.js)
  'explorer/proposal-model.js', // the bar's, the panel's and the list's words (a map draws with proposal-marks.js)
  'explorer/check-model.js', // the checks of a scenario's steps (a map paints a verdict with verdict-paint.js)
  'explorer/cloud-panel.js', // the node panel's facts for a cloud node
  'explorer/outage-scenario.js', // the Play button's scenario (a map paints a radius with outage-model.js)
  'explorer/camera-frame.js', // where a review's camera goes
  'explorer/selection-words.js', // the node panel's words for a selection
  'explorer/engine/proposal.js',
  'explorer/pieces/review.js',
  'explorer/pieces/node-panel.js',
  'explorer/pieces/decision.js',
];

describe('a map alone does not load the review', () => {
  const map = reach('components/src/components/corn-map/corn-map.tsx');

  it('reaches the map piece and the engine it draws with', () => {
    for (const f of ['explorer/pieces/map.js', 'explorer/scene.js', 'explorer/proposal-marks.js', 'explorer/verdict-paint.js', 'explorer/outage-model.js', 'explorer/engine/map-rect.js']) expect(map).toContain(f);
  });

  it('reaches none of what only a review uses', () => {
    expect(map.filter((f) => REVIEW_ONLY.includes(f))).toEqual([]);
  });

  it('the review reaches all of it, from the same engine', () => {
    const review = reach('components/src/components/corn-review/corn-review.tsx');
    for (const f of REVIEW_ONLY) expect(review).toContain(f);
    // and every module the map reaches but the shell itself: one engine, shared, not a copy
    for (const f of map.filter((x) => !x.startsWith('components/'))) expect(review).toContain(f);
  });

  it('the old names stay where the page and the tests import them', async () => {
    const sheets = await import('../../explorer/engine/sheets.js');
    for (const name of ['PHONE_QUERY', 'isPhone', 'measureCovered', 'visibleMapRect', 'registerSheet']) expect(typeof sheets[name]).not.toBe('undefined');
    const proposal = await import('../../explorer/proposal-model.js');
    for (const name of ['showsNode', 'showsEdge', 'markIn', 'beforeOf', 'touchedIds', 'kindOfMark', 'placeAddedNodes', 'orderAddedLast', 'pinLanes', 'chipText']) expect(typeof proposal[name]).toBe('function');
    const checks = await import('../../explorer/check-model.js');
    expect(typeof checks.paintVerdict).toBe('function');
    expect(checks.VERDICT_COLOR.refused).toBe('#ff2d55');
  });
});
