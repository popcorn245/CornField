/**
 * The camera maths behind wheel and pinch zoom (TOPO-06): the world point under the pointer
 * stays still. Pure, so the node environment.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { zoomAbout, pinchStart, pinchCamera, clampZoom, ZOOM_MIN, ZOOM_MAX, ZOOM_FLOOR, panIntoView } from '../../explorer/camera.js';


const toWorld = (c     , sx        , sy        ) => ({ x: (sx - c.x) / c.zoom, y: (sy - c.y) / c.zoom });
const toScreen = (c     , wx        , wy        ) => ({ x: c.x + wx * c.zoom, y: c.y + wy * c.zoom });

describe('zoomAbout', () => {
  it('keeps the world point under the pointer where it is, for any zoom, pan and pointer', () => {
    for (const cam of [{ x: 0, y: 0, zoom: 1 }, { x: 310, y: -120, zoom: 0.4 }, { x: -900, y: 250, zoom: 2.2 }]) {
      for (const [px, py] of [[0, 0], [400, 300], [1399, 20], [-30, 700]]) {
        for (const factor of [1.12, 0.88, 1.25, 0.8, 1.5]) {
          const before = toWorld(cam, px, py);
          const next = zoomAbout(cam, factor, px, py);
          const after = toScreen(next, before.x, before.y);
          expect(after.x).toBeCloseTo(px, 6);
          expect(after.y).toBeCloseTo(py, 6);
        }
      }
    }
  });

  it('scales by the factor, within the limits, and does not move when clamped', () => {
    expect(zoomAbout({ x: 0, y: 0, zoom: 1 }, 1.12, 10, 10).zoom).toBeCloseTo(1.12, 10);
    const atMax = zoomAbout({ x: 5, y: 6, zoom: 2.9 }, 2, 100, 100);
    expect(atMax.zoom).toBe(ZOOM_MAX);
    const stuck = zoomAbout({ x: 5, y: 6, zoom: ZOOM_MAX }, 1.12, 100, 100);
    expect(stuck).toEqual({ x: 5, y: 6, zoom: ZOOM_MAX });
    expect(zoomAbout({ x: 5, y: 6, zoom: 0.26 }, 0.5, 100, 100).zoom).toBe(ZOOM_MIN);
    expect(clampZoom(10)).toBe(ZOOM_MAX);
    expect(clampZoom(0)).toBe(ZOOM_MIN);
  });

  it('does not change the camera it was given', () => {
    const cam = { x: 1, y: 2, zoom: 1 };
    zoomAbout(cam, 1.5, 50, 50);
    expect(cam).toEqual({ x: 1, y: 2, zoom: 1 });
  });
});

describe('pinchCamera', () => {
  const start = pinchStart({ x: 100, y: 50, zoom: 1 }, 100, { x: 400, y: 300 });

  it('zooms by the ratio of the finger distances', () => {
    expect(pinchCamera(start, 200, { x: 400, y: 300 }).zoom).toBeCloseTo(2, 10);
    expect(pinchCamera(start, 50, { x: 400, y: 300 }).zoom).toBeCloseTo(0.5, 10);
    expect(pinchCamera(start, 100000, { x: 400, y: 300 }).zoom).toBe(ZOOM_MAX);
  });

  it('keeps the world point that was between the fingers between them, wherever they go', () => {
    const anchor = toWorld({ x: 100, y: 50, zoom: 1 }, 400, 300);
    for (const [dist, mx, my] of [[200, 400, 300], [150, 380, 340], [60, 500, 100], [100, 450, 280]]) {
      const next = pinchCamera(start, dist, { x: mx, y: my });
      const on = toScreen(next, anchor.x, anchor.y);
      expect(on.x).toBeCloseTo(mx, 6);
      expect(on.y).toBeCloseTo(my, 6);
    }
  });

  it('is a pure pan when the fingers keep their distance', () => {
    const next = pinchCamera(start, 100, { x: 430, y: 290 });
    expect(next).toEqual({ x: 130, y: 40, zoom: 1 });
  });

  it('agrees with zoomAbout when the middle stays put', () => {
    const viaPinch = pinchCamera(start, 130, { x: 400, y: 300 });
    const viaZoom = zoomAbout({ x: 100, y: 50, zoom: 1 }, 1.3, 400, 300);
    expect(viaPinch.x).toBeCloseTo(viaZoom.x, 8);
    expect(viaPinch.y).toBeCloseTo(viaZoom.y, 8);
    expect(viaPinch.zoom).toBeCloseTo(viaZoom.zoom, 8);
  });
});

describe('the zoom floor of a big map (F22)', () => {
  it('goes as low as the map needs, never above the default floor, never below the absolute one', () => {
    expect(clampZoom(0.01, 0.04)).toBe(0.04);
    expect(clampZoom(0.5, 0.04)).toBe(0.5);
    expect(clampZoom(0.1, 0.9)).toBe(ZOOM_MIN); // a small map keeps the default
    expect(clampZoom(0.0001, 0.00001)).toBe(ZOOM_FLOOR);
  });

  it('zooms out to the map\'s floor by wheel and by pinch', () => {
    const cam = { x: 0, y: 0, zoom: 1 };
    let z = cam;
    for (let i = 0; i < 80; i++) z = zoomAbout(z, 0.88, 100, 100, 0.04);
    expect(z.zoom).toBeCloseTo(0.04, 10);
    expect(pinchCamera(pinchStart(cam, 400, { x: 0, y: 0 }), 4, { x: 0, y: 0 }, 0.04).zoom).toBeCloseTo(0.04, 10);
  });

  it('never zooms in when asked to zoom out, even from below the floor', () => {
    expect(zoomAbout({ x: 0, y: 0, zoom: 0.03 }, 0.88, 10, 10, 0.05).zoom).toBeLessThanOrEqual(0.03);
    expect(zoomAbout({ x: 0, y: 0, zoom: 0.03 }, 1.12, 10, 10, 0.05).zoom).toBeGreaterThanOrEqual(0.05);
  });
});

describe('panIntoView: a node under the phone\'s sheet (F32)', () => {
  const box = { left: 0, top: 0, right: 390, bottom: 338 }; // the part of the map the expanded sheet leaves
  it('leaves the camera alone when the point is in the box', () => {
    expect(panIntoView({ x: 100, y: 100, zoom: 1 }, { x: 50, y: 50 }, box, 20)).toBeNull();
  });
  it('puts a point under the sheet in the middle of the part still showing, without zooming', () => {
    const cam = { x: 195, y: 446, zoom: 0.5 }; // the node at world (0, 0) is at y 446: under the sheet
    const next = panIntoView(cam, { x: 0, y: 0 }, box, 20);
    expect(next).not.toBeNull();
    expect(next.zoom).toBe(0.5);
    expect(next.x).toBe(195); // x was fine
    expect(next.y).toBeCloseTo(169, 6); // the middle of 0..338
    expect(next.y + 0 * next.zoom).toBeLessThanOrEqual(box.bottom);
  });
  it('also pans sideways for a point off the side', () => {
    const next = panIntoView({ x: -50, y: 100, zoom: 1 }, { x: 0, y: 0 }, box, 20);
    expect(next.x).toBe(195);
    expect(next.y).toBe(100);
  });
});
