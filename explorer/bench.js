/**
 * @module explorer/bench
 *
 * The explorer's own stopwatch (TOPO-01, spec 0012 A6). `/?bench=1` runs a scripted,
 * deterministic pan-and-zoom for a fixed number of frames and measures two clocks:
 *
 *  - frame time: the gap between two requestAnimationFrame callbacks, what the eye sees. On a
 *    60 Hz display it can never be below ~16.7 ms, however fast the draw is, so it is judged
 *    against the refresh the run measures first (`refreshHz`, `slowFrames`);
 *  - draw time: the time spent inside the draw call itself, on the CPU. For the canvas this is
 *    the cost of issuing the picture, not of rasterising it; the frame gaps carry the rest.
 *
 * and shows the median, 95th percentile and worst of each, on the page and as one JSON line in
 * the console (also left on `window.__bench` for a script that drives the page). `/?fixture=5k`
 * loads the generated topology (core/fixture.js, served by the server) instead of
 * topology.json; the two together are the project's measure.
 *
 * Everything here is pure or takes what it needs as arguments (the draw call, the camera, the
 * frame source, the clock), so the statistics, the path and the run loop are tested without a
 * browser (test/explorer/explorer-bench.test.js). The page wiring is `runPageBench` in main.js.
 */

/** Frames a bare `?bench=1` runs: 5 seconds at 60 Hz */
export const BENCH_DEFAULT_FRAMES = 300;
const BENCH_MAX_FRAMES = 5000;
/** How far in the script zooms, as a multiple of the fitted view's zoom */
export const BENCH_ZOOM_FACTOR = 8;
/** A run is stopped after this long, so a renderer that takes seconds a frame still reports (see runBench) */
export const BENCH_MAX_MS = 90_000;

/** @typedef {{ zoom: number, cx: number, cy: number, width: number, height: number, zoomFactor?: number }} FittedView */

// ---------------------------------------------------------------------------
//  Statistics
// ---------------------------------------------------------------------------

/**
 * The `p`th percentile (0 to 100) by linear interpolation between the two nearest ranks of the
 * sorted samples (the method most spreadsheets call PERCENTILE.INC). NaN for no samples.
 * @param {number[]} samples not changed
 * @param {number} p
 */
export function percentile(samples, p) {
  if (!samples.length) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** @param {number[]} samples */
export function summarize(samples) {
  const count = samples.length;
  if (!count) return { count, median: NaN, p95: NaN, worst: NaN, best: NaN, mean: NaN };
  return {
    count,
    median: percentile(samples, 50),
    p95: percentile(samples, 95),
    worst: Math.max(...samples),
    best: Math.min(...samples),
    mean: samples.reduce((s, x) => s + x, 0) / count,
  };
}

// ---------------------------------------------------------------------------
//  The scripted path
// ---------------------------------------------------------------------------

/**
 * The camera for frame `frame` of `frames`, a pure function so every run draws the same
 * pictures. Zoom goes from the fitted view in to 8x (`base.zoomFactor`) and back out (a cosine ease, so the
 * velocity is smooth), while the view's centre drifts around the fitted centre on a Lissajous
 * curve a third of the fitted view across: zoomed out the whole map is in play, zoomed in
 * labels and single edges are.
 * @param {number} frame 0 to `frames` (the last one lands back on the fit)
 * @param {number} frames
 * @param {FittedView} base the fitted view: its zoom, the world point at its centre, the viewport size, and how far in the script goes (default 8, 1 is a pan only)
 * @returns {{ x: number, y: number, zoom: number }} the camera in state.camera's terms
 */
export function benchCamera(frame, frames, base) {
  const t = frame / frames;
  const zoom = base.zoom * (base.zoomFactor ?? BENCH_ZOOM_FACTOR) ** (0.5 - 0.5 * Math.cos(2 * Math.PI * t));
  const cx = base.cx + 0.3 * (base.width / 2 / base.zoom) * Math.sin(2 * Math.PI * 2 * t);
  const cy = base.cy + 0.3 * (base.height / 2 / base.zoom) * Math.sin(2 * Math.PI * 3 * t);
  return { x: base.width / 2 - cx * zoom, y: base.height / 2 - cy * zoom, zoom };
}

// ---------------------------------------------------------------------------
//  The run
// ---------------------------------------------------------------------------

/**
 * Runs the script and measures it. First `idleFrames` frames with nothing drawn, to learn the
 * display's refresh; then `warmup` draws of the first camera (so the JIT and the caches are
 * warm, not counted); then `frames` measured ones along `benchCamera`. If the measured frames take
 * longer than `maxMs` in all, the run stops there and says so (`aborted`, with `frames` the number
 * done and `framesAsked` the number asked for): a renderer that needs seconds a frame, as the Canvas
 * 2D one does zoomed in on 5,000 nodes, would otherwise never report.
 *
 * @param {object} o
 * @param {number} [o.frames] measured frames
 * @param {number} [o.warmup]
 * @param {number} [o.idleFrames]
 * @param {number} [o.maxMs]
 * @param {FittedView} o.base the fitted view
 * @param {(camera: { x: number, y: number, zoom: number }) => void} o.setCamera
 * @param {() => void} o.draw one full draw of the map (what is timed)
 * @param {(cb: (ts: number) => void) => unknown} [o.raf] requestAnimationFrame
 * @param {() => number} [o.now] a millisecond clock, for the time inside `draw`
 * @param {() => unknown} [o.before] called (and awaited) once, before anything else
 * @param {() => void} [o.after] called when it is over, also when it throws
 */
export async function runBench({
  frames = BENCH_DEFAULT_FRAMES, warmup = 30, idleFrames = 20, maxMs = BENCH_MAX_MS, base, setCamera, draw,
  raf = (cb) => requestAnimationFrame(cb), now = () => performance.now(), before, after,
}) {
  if (!Number.isInteger(frames) || frames < 1) throw new RangeError('a bench needs at least one frame');
  const nextFrame = () => new Promise((resolve) => raf(resolve));
  try {
    await before?.();
    // The display's refresh: the gap between frames when nothing is drawn
    const idle = [];
    let prev = await nextFrame();
    for (let i = 1; i < idleFrames; i++) {
      const ts = await nextFrame();
      idle.push(ts - prev);
      prev = ts;
    }
    const idleFrameMs = idle.length ? percentile(idle, 50) : NaN;

    for (let i = 0; i < warmup; i++) {
      prev = await nextFrame();
      setCamera(benchCamera(0, frames, base));
      draw();
    }

    const frameGaps = [];
    const drawTimes = [];
    const started = now();
    let aborted = false;
    for (let i = 0; i < frames; i++) {
      if (now() - started > maxMs) { aborted = true; break; }
      const ts = await nextFrame();
      frameGaps.push(ts - prev);
      prev = ts;
      setCamera(benchCamera(i, frames, base));
      const t0 = now();
      draw();
      drawTimes.push(now() - t0);
    }
    // A frame "missed a refresh" when the gap is over one and a half of them
    const slowFrames = Number.isFinite(idleFrameMs) ? frameGaps.filter((g) => g > idleFrameMs * 1.5).length : NaN;
    return {
      frames: drawTimes.length,
      framesAsked: frames,
      aborted,
      idleFrameMs,
      refreshHz: 1000 / idleFrameMs,
      slowFrames,
      frameMs: summarize(frameGaps),
      drawMs: summarize(drawTimes),
    };
  } finally {
    after?.();
  }
}

// ---------------------------------------------------------------------------
//  What was measured on
// ---------------------------------------------------------------------------

/**
 * The `meta` of a run: the map, the view and the renderer actually drawing it (`renderer` is the
 * renderer's `kind`, 'webgl2' or 'canvas2d': a page that asked for WebGL2 and fell back reports
 * what it got), so a number is never filed under the wrong renderer.
 * @param {{ nodes: number, edges: number, view: string, renderer: string, zoomFactor: number, width: number, height: number, dpr: number, search?: string }} o
 */
export function benchMeta({ nodes, edges, view, renderer, zoomFactor, width, height, dpr, search = '' }) {
  return { nodes, edges, fixture: new URLSearchParams(search).get('fixture'), view, renderer: renderer || 'unknown', zoomFactor, width, height, dpr, gpuSync: measureParams(search).benchSync };
}

// ---------------------------------------------------------------------------
//  Reporting
// ---------------------------------------------------------------------------

const ms = (x, digits) => (Number.isFinite(x) ? x.toFixed(digits) : 'n/a');
const round = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const roundAll = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === 'count' ? v : round(v)]));

/**
 * What the readout says, one string per line
 * @param {ReturnType<typeof runBench> extends Promise<infer R> ? R : never} result
 * @param {{ nodes: number, edges: number, fixture?: string|null, view: string, renderer: string, width: number, height: number, dpr: number }} meta
 */
export function readoutLines(result, meta) {
  const { frameMs: f, drawMs: d } = result;
  const size = `${meta.nodes.toLocaleString('en-US')} nodes, ${meta.edges.toLocaleString('en-US')} edges${meta.fixture ? ` (fixture ${meta.fixture})` : ''}`;
  const lines = [
    `Bench: ${result.frames} frames, ${size}`,
    `${meta.view} view, ${meta.renderer}${meta.gpuSync ? ' (waits for the GPU)' : ''}, ${meta.width}×${meta.height} at ${meta.dpr}×`,
    `Between frames (ms): median ${ms(f.median, 1)} · 95th ${ms(f.p95, 1)} · worst ${ms(f.worst, 1)}`,
    `In draw (ms): median ${ms(d.median, 2)} · 95th ${ms(d.p95, 2)} · worst ${ms(d.worst, 2)}`,
    `Display about ${ms(result.refreshHz, 0)} Hz; ${result.slowFrames} of ${result.frames} frames missed a refresh`,
  ];
  if (result.aborted) lines.push(`Stopped early: ${result.frames} of ${result.framesAsked} frames in ${BENCH_MAX_MS / 1000} s, too slow to finish`);
  return lines;
}

/** The one line of JSON the run logs to the console: the numbers and what they were measured on */
export function resultLine(result, meta) {
  return JSON.stringify({
    bench: 'topology-explorer',
    ...meta,
    frames: result.frames,
    framesAsked: result.framesAsked,
    aborted: result.aborted,
    refreshHz: round(result.refreshHz),
    idleFrameMs: round(result.idleFrameMs),
    slowFrames: result.slowFrames,
    frameMs: roundAll(result.frameMs),
    drawMs: roundAll(result.drawMs),
  });
}

/** Puts the readout on the page, a small corner panel; replaces the last one */
export function showReadout(doc, lines) {
  let el = doc.getElementById('bench-readout');
  if (!el) {
    el = doc.createElement('aside');
    el.id = 'bench-readout';
    el.className = 'bench-readout';
    el.setAttribute('role', 'status');
    doc.body.appendChild(el);
  }
  el.replaceChildren(...lines.map((line) => { const p = doc.createElement('p'); p.textContent = line; return p; }));
  return el;
}

// ---------------------------------------------------------------------------
//  The page's URL parameters
// ---------------------------------------------------------------------------

/**
 * What `?fixture=` and `?bench=` ask for. `fixture`: `5k` (or `20K`, or a bare node count) loads
 * `/topology-fixture.json` at that size with three edges per node, a bare `?fixture` is 5k, and
 * a value that cannot be read is passed to the server as it is so it answers 400 and the page shows
 * the error: a bad fixture never quietly loads the real map, which would be measured by mistake.
 * `bench`: `1` or bare is the default number of frames, another whole number is that many (to
 * a ceiling), `0` or absent is off. `zoomx` (1 to 8) is how far in the run zooms. `sync=1` makes
 * every measured draw wait for the GPU to finish (`gl.finish()`), so "in draw" is the whole frame's
 * cost and not only the time to hand the work over.
 * @param {string} search `location.search`
 * @returns {{ fixtureUrl: string|null, benchFrames: number, benchZoom: number, benchSync: boolean }}
 */
export function measureParams(search) {
  const params = new URLSearchParams(search);
  let fixtureUrl = null;
  if (params.has('fixture')) {
    const raw = params.get('fixture').trim();
    const k = /^(\d+)k$/i.exec(raw);
    const nodes = k ? Number(k[1]) * 1000 : /^\d+$/.test(raw) && raw !== '1' ? Number(raw) : raw === '' || raw === '1' ? 5000 : null;
    fixtureUrl = nodes === null
      ? `/topology-fixture.json?nodes=${encodeURIComponent(raw)}`
      : `/topology-fixture.json?nodes=${nodes}&edges=${nodes * 3}`;
    if (params.has('seed')) fixtureUrl += `&seed=${encodeURIComponent(params.get('seed'))}`;
  }
  let benchFrames = 0;
  if (params.has('bench')) {
    const raw = params.get('bench').trim();
    const n = /^\d+$/.test(raw) ? Number(raw) : 1;
    benchFrames = n === 0 ? 0 : n === 1 ? BENCH_DEFAULT_FRAMES : Math.min(n, BENCH_MAX_FRAMES);
  }
  // How far in the script zooms: `zoomx=1` is a pan only, up to 8 (the default; the same script before and after a change)
  const zoomx = Number(params.get('zoomx'));
  const benchZoom = params.has('zoomx') && zoomx >= 1 && zoomx <= BENCH_ZOOM_FACTOR ? zoomx : BENCH_ZOOM_FACTOR;
  const sync = params.get('sync');
  return { fixtureUrl, benchFrames, benchZoom, benchSync: sync !== null && sync !== '0' && sync !== 'false' };
}
