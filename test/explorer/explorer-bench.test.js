/**
 * @vitest-environment node
 *
 * The explorer's bench (TOPO-01, spec 0012 A6): the statistics, the scripted pan-and-zoom,
 * the run loop (on a virtual clock, so no browser is needed) and the URL parameters that switch
 * the fixture and the bench on. No GPU, no DOM: the page wiring is in main.js and is looked at
 * with a browser.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { percentile, summarize, benchCamera, runBench, readoutLines, resultLine, measureParams, benchMeta, BENCH_DEFAULT_FRAMES } from '../../explorer/bench.js';

describe('percentile', () => {
  it('interpolates between ranks of the sorted samples', () => {
    expect(percentile([5, 1, 3], 0)).toBe(1);
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([5, 1, 3], 100)).toBe(5);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([10, 20], 25)).toBe(12.5);
    expect(percentile([0, 100], 95)).toBeCloseTo(95, 10);
  });

  it('is the one value for one sample, and NaN for none', () => {
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
  });

  it('does not reorder the caller\'s array', () => {
    const xs = [3, 1, 2];
    percentile(xs, 50);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe('summarize', () => {
  it('gives the median, the 95th percentile, the worst, the best, the mean and the count', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(summarize(xs)).toEqual({ count: 100, median: 50.5, p95: 95.05, worst: 100, best: 1, mean: 50.5 });
  });

  it('one slow frame moves the worst, not the median', () => {
    const s = summarize([...Array.from({ length: 99 }, () => 4), 90]);
    expect(s.median).toBe(4);
    expect(s.worst).toBe(90);
    expect(s.p95).toBe(4);
  });

  it('is all NaN with a count of zero for no samples', () => {
    const s = summarize([]);
    expect(s.count).toBe(0);
    expect(s.median).toBeNaN();
    expect(s.worst).toBeNaN();
  });
});

describe('benchCamera', () => {
  const base = { zoom: 0.2, cx: 100, cy: -50, width: 1200, height: 800 };

  it('is a pure function of the frame: the same frame is the same camera', () => {
    expect(benchCamera(37, 300, base)).toEqual(benchCamera(37, 300, base));
  });

  it('starts and ends on the fitted view, and zooms in and back out between', () => {
    const start = benchCamera(0, 300, base);
    expect(start.zoom).toBeCloseTo(base.zoom, 10);
    // the view's centre is the fit's centre
    expect((base.width / 2 - start.x) / start.zoom).toBeCloseTo(base.cx, 6);
    expect((base.height / 2 - start.y) / start.zoom).toBeCloseTo(base.cy, 6);
    expect(benchCamera(300, 300, base).zoom).toBeCloseTo(base.zoom, 10);
    const zooms = Array.from({ length: 300 }, (_, i) => benchCamera(i, 300, base).zoom);
    expect(Math.max(...zooms)).toBeGreaterThan(base.zoom * 7); // deep enough that labels and edges are close up
    expect(Math.max(...zooms)).toBeLessThanOrEqual(base.zoom * 8 + 1e-9);
    expect(Math.min(...zooms)).toBeGreaterThanOrEqual(base.zoom - 1e-9);
    expect(zooms.indexOf(Math.max(...zooms))).toBeGreaterThan(100); // the peak is mid-run
    expect(zooms.indexOf(Math.max(...zooms))).toBeLessThan(200);
  });

  it('pans: the view\'s centre wanders around the fitted centre', () => {
    const centres = Array.from({ length: 300 }, (_, i) => {
      const c = benchCamera(i, 300, base);
      return { x: (base.width / 2 - c.x) / c.zoom, y: (base.height / 2 - c.y) / c.zoom };
    });
    const xs = centres.map((c) => c.x);
    const ys = centres.map((c) => c.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(100);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(100);
    // and stays inside the fitted view
    const halfW = base.width / 2 / base.zoom;
    expect(Math.max(...xs.map((x) => Math.abs(x - base.cx)))).toBeLessThan(halfW);
  });

  it('zooms in as far as the base says: 1 is a pan only', () => {
    const flat = { ...base, zoomFactor: 1 };
    for (let i = 0; i <= 300; i += 10) expect(benchCamera(i, 300, flat).zoom).toBeCloseTo(base.zoom, 10);
    const two = Array.from({ length: 300 }, (_, i) => benchCamera(i, 300, { ...base, zoomFactor: 2 }).zoom);
    expect(Math.max(...two)).toBeCloseTo(base.zoom * 2, 6);
  });

  it('only gives finite numbers', () => {
    for (let i = 0; i <= 300; i++) {
      const c = benchCamera(i, 300, base);
      expect(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.zoom)).toBe(true);
    }
  });
});

/** A virtual clock: each rAF is 16.5 ms after the last, and a draw costs what `cost(frame)` says */
function virtualClock(cost                       , vsync = 16.5) {
  let t = 1000;
  const cameras        = [];
  let draws = 0;
  return {
    cameras,
    draws: () => draws,
    now: () => t,
    raf: (cb                      ) => { Promise.resolve().then(() => { t = Math.max(t, 1000) + vsync; cb(t); }); },
    setCamera: (c     ) => { cameras.push(c); },
    draw: () => { t += cost(draws++); },
  };
}

describe('runBench', () => {
  const base = { zoom: 0.25, cx: 0, cy: 0, width: 1000, height: 700 };

  it('draws warm-up frames plus the measured ones, and moves the camera along the script for the measured ones', async () => {
    const clock = virtualClock(() => 2);
    const result = await runBench({ frames: 60, warmup: 5, idleFrames: 4, base, ...clock });
    expect(clock.draws()).toBe(65);
    expect(result.frames).toBe(60);
    // after the warm-up, camera i is the script's frame i
    expect(clock.cameras.slice(5)).toEqual(Array.from({ length: 60 }, (_, i) => benchCamera(i, 60, base)));
    // the warm-up sits on frame 0
    expect(clock.cameras.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => benchCamera(0, 60, base)));
  });

  it('measures the time inside draw apart from the time between frames', async () => {
    // A 3 ms draw every frame, and a 40 ms one on measured frame 10 (draws 0-4 are warm-up)
    const clock = virtualClock((n) => (n === 15 ? 40 : 3));
    const result = await runBench({ frames: 60, warmup: 5, idleFrames: 4, base, ...clock });
    expect(result.drawMs.count).toBe(60);
    expect(result.drawMs.median).toBeCloseTo(3, 6);
    expect(result.drawMs.worst).toBeCloseTo(40, 6);
    // the gap between two frames is the vsync step plus the draw before it, so the median is vsync + 3
    expect(result.frameMs.count).toBe(60);
    expect(result.frameMs.median).toBeCloseTo(16.5 + 3, 6);
    expect(result.frameMs.worst).toBeCloseTo(16.5 + 40, 6);
    expect(result.frameMs.p95).toBeLessThan(result.frameMs.worst);
  });

  it('estimates the display\'s refresh from frames drawn nothing on, and counts the frames that missed one', async () => {
    const clock = virtualClock((n) => (n === 20 || n === 21 ? 30 : 1));
    const result = await runBench({ frames: 60, warmup: 5, idleFrames: 6, base, ...clock });
    expect(result.idleFrameMs).toBeCloseTo(16.5, 6);
    expect(result.refreshHz).toBeCloseTo(1000 / 16.5, 6);
    expect(result.slowFrames).toBe(2);
  });

  it('calls the hooks in order around the run and reports the same numbers when run twice', async () => {
    const seen           = [];
    const run = () => runBench({ frames: 30, warmup: 2, idleFrames: 2, base, ...virtualClock(() => 2), before: () => seen.push('before'), after: () => seen.push('after') });
    const a = await run();
    const b = await run();
    expect(seen).toEqual(['before', 'after', 'before', 'after']);
    expect(b).toEqual(a);
  });

  it('waits for an async before hook, and still calls after when the draw throws', async () => {
    const seen           = [];
    const clock = virtualClock(() => 1);
    await runBench({ frames: 3, warmup: 0, idleFrames: 2, base, ...clock, before: async () => { await Promise.resolve(); seen.push('before'); }, after: () => seen.push('after') });
    expect(seen).toEqual(['before', 'after']);
    seen.length = 0;
    await expect(runBench({ frames: 3, warmup: 0, idleFrames: 2, base, ...clock, draw: () => { throw new Error('boom'); }, after: () => seen.push('after') })).rejects.toThrow('boom');
    expect(seen).toEqual(['after']);
  });

  it('stops after the time budget and reports what it measured, so a slow renderer still answers', async () => {
    // Each draw takes a second; the budget is 5.5 s of measured frames
    const clock = virtualClock(() => 1000);
    const result = await runBench({ frames: 100, warmup: 2, idleFrames: 3, maxMs: 5500, base, ...clock });
    expect(result.aborted).toBe(true);
    expect(result.framesAsked).toBe(100);
    expect(result.frames).toBeGreaterThanOrEqual(4);
    expect(result.frames).toBeLessThanOrEqual(6);
    expect(result.drawMs.count).toBe(result.frames);
    expect(result.frameMs.count).toBe(result.frames);
    // a run that finishes in time says so
    const ok = await runBench({ frames: 10, warmup: 0, idleFrames: 2, maxMs: 60000, base, ...virtualClock(() => 1) });
    expect([ok.aborted, ok.frames, ok.framesAsked]).toEqual([false, 10, 10]);
  });

  it('refuses a run of no frames', async () => {
    await expect(runBench({ frames: 0, base, ...virtualClock(() => 1) })).rejects.toThrow(RangeError);
  });
});

describe('the readout and the console line', () => {
  const result = {
    frames: 300, framesAsked: 300, aborted: false, idleFrameMs: 16.67, refreshHz: 60, slowFrames: 4,
    frameMs: { count: 300, median: 16.7, p95: 19.2, worst: 41.9, best: 16.5, mean: 17 },
    drawMs: { count: 300, median: 6.31, p95: 9.87, worst: 30.2, best: 4, mean: 6.8 },
  };
  const meta = { nodes: 5000, edges: 15000, fixture: '5k', view: 'orbit', renderer: 'canvas2d', width: 1280, height: 720, dpr: 2 };

  it('shows median, 95th percentile and worst for both clocks, in plain words', () => {
    const text = readoutLines(result, meta).join('\n');
    expect(text).toMatch(/300 frames/);
    expect(text).toMatch(/5,000 nodes/);
    expect(text).toMatch(/Between frames.*16\.7.*19\.2.*41\.9/);
    expect(text).toMatch(/In draw.*6\.31.*9\.87.*30\.2/);
    expect(text).toMatch(/60 Hz/);
    expect(text).not.toMatch(/Stopped early/);
    expect(readoutLines({ ...result, frames: 12, framesAsked: 300, aborted: true }, meta).join(String.fromCharCode(10))).toMatch(/Stopped early: 12 of 300 frames/);
  });

  it('is one line of JSON for the console, with the numbers and where they were measured', () => {
    const line = resultLine(result, meta);
    expect(line).not.toMatch(/\n/);
    const parsed = JSON.parse(line);
    expect(parsed.bench).toBe('topology-explorer');
    expect(parsed.frameMs.median).toBe(16.7);
    expect(parsed.drawMs.p95).toBe(9.87);
    expect(parsed.nodes).toBe(5000);
    expect(parsed.renderer).toBe('canvas2d');
    expect(parsed.dpr).toBe(2);
    expect(parsed.refreshHz).toBe(60);
    expect(parsed.aborted).toBe(false);
    expect(parsed.framesAsked).toBe(300);
  });
});

describe('benchMeta (what a run says it was measured on)', () => {
  const o = { nodes: 5000, edges: 15000, view: 'orbit', zoomFactor: 8, width: 1280, height: 720, dpr: 2 };

  it('reports the renderer that is drawing, whichever it is', () => {
    expect(benchMeta({ ...o, renderer: 'webgl2' }).renderer).toBe('webgl2');
    expect(benchMeta({ ...o, renderer: 'canvas2d' }).renderer).toBe('canvas2d');
  });

  it('says so when it does not know, rather than naming one', () => {
    expect(benchMeta({ ...o, renderer: undefined        }).renderer).toBe('unknown');
  });

  it('carries the renderer into the readout and the console line', () => {
    const result = { frames: 3, framesAsked: 3, aborted: false, idleFrameMs: 16, refreshHz: 62.5, slowFrames: 0, frameMs: summarize([16, 16, 17]), drawMs: summarize([1, 2, 3]) };
    const meta = benchMeta({ ...o, renderer: 'webgl2', search: '?fixture=5k&bench=1' });
    expect(readoutLines(result, meta)[1]).toContain('webgl2');
    expect(JSON.parse(resultLine(result, meta)).renderer).toBe('webgl2');
    expect(meta.fixture).toBe('5k');
  });

  it('takes the fixture from the address, and is null on the real map', () => {
    expect(benchMeta({ ...o, renderer: 'webgl2', search: '?bench=1' }).fixture).toBe(null);
    expect(benchMeta({ ...o, renderer: 'webgl2' }).fixture).toBe(null);
  });
});

describe('measureParams, sync', () => {
  it('?sync=1 asks every draw to wait for the GPU; absent, 0 and false do not', () => {
    expect(measureParams('?bench=1&sync=1').benchSync).toBe(true);
    expect(measureParams('?bench=1&sync').benchSync).toBe(true);
    expect(measureParams('?bench=1').benchSync).toBe(false);
    expect(measureParams('?bench=1&sync=0').benchSync).toBe(false);
    expect(measureParams('?bench=1&sync=false').benchSync).toBe(false);
  });

  it('is in the meta, so a number says whether it waited', () => {
    const o = { nodes: 1, edges: 1, view: 'orbit', renderer: 'webgl2', zoomFactor: 8, width: 1, height: 1, dpr: 1 };
    expect(benchMeta({ ...o, search: '?sync=1' }).gpuSync).toBe(true);
    expect(benchMeta({ ...o, search: '' }).gpuSync).toBe(false);
  });
});

describe('measureParams', () => {
  it('does nothing without parameters', () => {
    expect(measureParams('')).toEqual({ fixtureUrl: null, benchFrames: 0, benchZoom: 8, benchSync: false });
    expect(measureParams('?view=dataflow')).toEqual({ fixtureUrl: null, benchFrames: 0, benchZoom: 8, benchSync: false });
  });

  it('?fixture=5k loads the generated topology, any size in thousands, or a bare node count', () => {
    expect(measureParams('?fixture=5k').fixtureUrl).toBe('/topology-fixture.json?nodes=5000&edges=15000');
    expect(measureParams('?fixture=20K').fixtureUrl).toBe('/topology-fixture.json?nodes=20000&edges=60000');
    expect(measureParams('?fixture=1500').fixtureUrl).toBe('/topology-fixture.json?nodes=1500&edges=4500');
    expect(measureParams('?fixture').fixtureUrl).toBe('/topology-fixture.json?nodes=5000&edges=15000');
    expect(measureParams('?fixture=1').fixtureUrl).toBe('/topology-fixture.json?nodes=5000&edges=15000');
  });

  it('passes a seed on, and hands a value it cannot read to the hub, which answers 400 (never the real map by mistake)', () => {
    expect(measureParams('?fixture=5k&seed=7').fixtureUrl).toBe('/topology-fixture.json?nodes=5000&edges=15000&seed=7');
    expect(measureParams('?fixture=lots').fixtureUrl).toBe('/topology-fixture.json?nodes=lots');
  });

  it('?bench=1 runs the default number of frames; another number runs that many, to a ceiling', () => {
    expect(measureParams('?bench=1').benchFrames).toBe(BENCH_DEFAULT_FRAMES);
    expect(measureParams('?bench').benchFrames).toBe(BENCH_DEFAULT_FRAMES);
    expect(measureParams('?bench=600').benchFrames).toBe(600);
    expect(measureParams('?bench=99999999').benchFrames).toBe(5000);
    expect(measureParams('?bench=0').benchFrames).toBe(0);
    expect(measureParams('?bench=nope').benchFrames).toBe(BENCH_DEFAULT_FRAMES);
  });

  it('combines: /?fixture=5k&bench=1', () => {
    expect(measureParams('?fixture=5k&bench=1')).toEqual({ fixtureUrl: '/topology-fixture.json?nodes=5000&edges=15000', benchFrames: BENCH_DEFAULT_FRAMES, benchZoom: 8, benchSync: false });
  });

  it('?zoomx= says how far in the run zooms, 1 to 8, and falls back to 8', () => {
    expect(measureParams('?bench=1&zoomx=1').benchZoom).toBe(1);
    expect(measureParams('?bench=1&zoomx=2.5').benchZoom).toBe(2.5);
    for (const bad of ['0', '9', 'x', '']) expect(measureParams(`?bench=1&zoomx=${bad}`).benchZoom, bad).toBe(8);
  });
});
