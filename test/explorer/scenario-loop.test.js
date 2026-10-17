// @vitest-environment happy-dom
/**
 * The scenario player on render.js's frame loop (TOPO-10): it adds a client to the one loop
 * instead of running a timer of its own, and the loop stops when the player is idle (with the packet
 * layers off, so the loop has no other reason to run), when the tab is hidden, and it runs for the
 * player alone under prefers-reduced-motion. The modules are loaded fresh per test: the loop keeps
 * its own state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let frames                               = [];
const stubFrames = () => vi.stubGlobal('requestAnimationFrame', (cb                       ) => { frames.push(cb); return frames.length; });
/** Runs the frames asked for so far at clock `now`; returns how many ran */
const runFrame = (now        ) => { const due = frames; frames = []; due.forEach((cb) => cb(now)); return due.length; };

async function load(reduceMotion = false) {
  vi.resetModules();
  vi.stubGlobal('matchMedia', (q        ) => ({ matches: reduceMotion && q.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
  window.matchMedia = (globalThis       ).matchMedia;
  // @ts-expect-error plain JS modules, no declarations
  const { state } = await import('../../explorer/state.js');
  // @ts-expect-error plain JS modules, no declarations
  const render = await import('../../explorer/render.js');
  // @ts-expect-error plain JS modules, no declarations
  const ui = await import('../../explorer/scenario-ui.js');
  document.body.innerHTML = '<div class="hx-stage"><canvas id="graph-canvas"></canvas></div>';
  state.canvas = document.getElementById('graph-canvas');
  state.nodes = [{ id: 'a', type: 'page', x: 0, y: 0, r: 10, color: '#fff', label: 'a' }, { id: 'b', type: 'page', x: 50, y: 0, r: 10, color: '#fff', label: 'b' }];
  state.edges = [{ from: 'a', to: 'b' }];
  state.width = 800; state.height = 600; state.camera = { x: 380, y: 300, zoom: 1 }; // both nodes on screen
  state.activeLayers = { ...state.activeLayers, flow: false, table: false }; // nothing else animates
  render.setRenderer({ kind: 'stub', draw() {}, resize() {}, destroy() {} });
  return { state, render, ui };
}
const walk = { id: 's', title: 'Walk', stepMs: 300, steps: [{ node: 'a', text: 'one' }, { node: 'b', text: 'two' }] };

beforeEach(() => { frames = []; stubFrames(); });
afterEach(() => { vi.unstubAllGlobals(); Object.defineProperty(document, 'hidden', { value: false, configurable: true }); });

describe('the frame loop', () => {
  it('asks for one frame to draw the map, then no more until a scenario plays', async () => {
    await load();
    expect(frames).toHaveLength(1); // the first picture
    runFrame(1000);
    expect(frames).toHaveLength(0); // nothing animates: the loop let go
  });

  it('runs the player from its frames, and stops asking for frames once it is done', async () => {
    const { state, ui } = await load();
    ui.playScenario(walk);
    expect(frames).toHaveLength(1);
    let now = 1000;
    for (let i = 0; i < 20 && runFrame(now); i++) now += 100;
    expect(state.scenario).toMatchObject({ done: true, playing: false });
    expect(frames).toHaveLength(0); // the loop let go
  });

  it('stops asking for frames when it is paused, and starts again on play', async () => {
    const { ui } = await load();
    ui.playScenario(walk);
    runFrame(1000);
    ui.getPlayer().pause();
    runFrame(1100); // the loop sees nothing wants frames
    expect(frames).toHaveLength(0);
    document.body.querySelector             ('[data-action=scenario-toggle]') .click(); // Play
    expect(frames).toHaveLength(1);
  });

  it('stops asking for frames while the tab is hidden, and comes back with it', async () => {
    const { ui } = await load();
    ui.playScenario(walk);
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    expect(runFrame(1000)).toBe(1);
    expect(frames).toHaveLength(0);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(frames).toHaveLength(1);
  });

  it('still steps under reduced motion (the loop runs for the player alone), and the packet is not described', async () => {
    const { state, render, ui } = await load(true);
    ui.playScenario({ ...walk, steps: [{ node: 'a', text: 'one' }, { edge: { from: 'a', to: 'b' }, text: 'across' }] });
    expect(frames).toHaveLength(1);
    let now = 1000;
    for (let i = 0; i < 10 && state.scenario.index < 1 && runFrame(now); i++) now += 100;
    expect(state.scenario.index).toBe(1); // it stepped on its own
    expect(render.getScene().edges[0]).toMatchObject({ alpha: 1, glow: 14, packet: null }); // the edge step is lit, with nothing travelling
    for (let i = 0; i < 10 && runFrame(now); i++) now += 100;
    expect(state.scenario).toMatchObject({ done: true });
  });
});
