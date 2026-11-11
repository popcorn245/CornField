// @vitest-environment happy-dom
/**
 * The scenario player in a DOM (TOPO-10): the bar, the keyboard, the camera, what the review column
 * needs of it (spec 0006) and the demo. The renderer is a stub (there is no canvas in CI) and the test
 * is the frame loop: it hands `tickScenario` the time it wants.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadSample } from '../helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain JS modules, no declarations
import { state, touchScene } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { setRenderer } from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { initSheets, sheetState, expandSheet, measureCovered } from '../../explorer/sheets.js';
import {
  clearScenario, demoScenario, getPlayer, initScenarioUi, maybeStartDemo, onPlayerChange, playScenario, setCloseFocus, setNextScenario, stopScenario, tickScenario, wantsFrames,
  // @ts-expect-error plain JS modules, no declarations
} from '../../explorer/scenario-ui.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const topology = loadSample();

const nodes = [
  { id: 'a', type: 'page', x: 100, y: 100, r: 20, color: '#fff', label: 'a' },
  { id: 'b', type: 'page', x: 300, y: 100, r: 20, color: '#fff', label: 'b' },
  { id: 'far', type: 'page', x: 3000, y: 2000, r: 20, color: '#fff', label: 'far' },
];
const edges = [{ from: 'a', to: 'b', kind: 'calls' }];
const scenario = (extra         = {}) => ({
  id: 's', title: 'Saving a meal', stepMs: 1000,
  steps: [
    { node: 'a', text: 'The page opens.' },
    { edge: { from: 'a', to: 'b', kind: 'calls' }, text: 'The page calls POST /meals.' },
    { node: 'b', text: 'The API checks the meal.' },
    { node: 'far', text: 'A long way off.' },
  ],
  ...extra,
});

const q = (sel        ) => document.querySelector(sel)               ;
const bar = () => q('.hx-player');
const text = () => q('.hx-player-text').textContent .replace(/\s+/g, ' ').trim();
const key = (k        , target              = document.body, init         = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, code: k === ' ' ? 'Space' : k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
/** The frame loop: 100 ms frames from one clock reading to another (the player cuts a frame longer than a quarter second short, see below) */
const frames = (from        , to        ) => { for (let t = from; t <= to; t += 100) tickScenario(t); };
const click = (action        ) => (q(`[data-action=${action}]`)                     ).click();

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('requestAnimationFrame', () => 0); // the test is the frame loop
  document.body.innerHTML = '<div class="hx-stage"><canvas id="graph-canvas"></canvas></div><input id="node-search">';
  state.canvas = document.getElementById('graph-canvas');
  state.nodes = structuredClone(nodes);
  state.edges = structuredClone(edges);
  state.width = 800;
  state.height = 600;
  state.camera = { x: 0, y: 0, zoom: 1 };
  state.proposal = undefined;
  state.scenario = null;
  state.coveredBottom = 0;
  setRenderer({ kind: 'stub', draw() {}, resize() {}, destroy() {} });
  initScenarioUi();
  clearScenario();
});
afterEach(() => { clearScenario(); vi.unstubAllGlobals(); });

describe('the bar', () => {
  it('shows the title, the step count with its text, and the controls, in plain words', () => {
    playScenario(scenario(), { autoplay: false });
    expect(bar().getAttribute('role')).toBe('region');
    expect(q('.hx-player-title').textContent).toBe('Saving a meal');
    expect(text()).toBe('1 of 4 · The page opens.');
    // one bar: Previous, Pause or Play, Next, then the speed and Close (the glyphs are drawn by the stylesheet, so the names are the words)
    expect([...bar().querySelectorAll('button:not(.hx-sheet-handle):not([hidden])')].map((b) => b.textContent .trim())).toEqual(['Previous', 'Play', 'Next', '✕']);
    expect(q('[data-action=scenario-close]').getAttribute('aria-label')).toBe('Close the scenario');
    // the one polite line is the step as the list says it, not the visible line again
    expect(q('.hx-player-text').hasAttribute('aria-live')).toBe(false);
    expect(q('.hx-player-says').getAttribute('aria-live')).toBe('polite');
    expect(q('.hx-player-says').textContent).toBe('Step 1 of 4: a. The page opens.');
    expect(bar().getAttribute('aria-label')).toBe('Scenario player: Saving a meal');
  });

  it('is one row under the map to the right of the review column, and a phone\'s peek keeps Previous, Pause, Next and Close in a row of 44px targets', () => {
    const css = fs.readFileSync(path.join(here, '../../explorer', 'explorer.css'), 'utf8');
    expect(css).toMatch(/\.hx-player \{ position: absolute; left: calc\(var\(--hx-col-w, 0px\) \+ 24px\); right: 12px; bottom: 12px;/);
    expect(css).toMatch(/\.hx-stage:has\(\.hx-review-column:not\(\[hidden\]\)\) \{ --hx-col-w: 400px; \}/);
    expect(css).toMatch(/\.hx-player\[data-sheet-state="peek"\] > :not\(\.hx-sheet-handle\):not\(\.hx-player-controls\):not\(\.hx-player-text\):not\(\.hx-player-side\)/);
    expect(css).toMatch(/\.hx-player-controls \.hx-btn \{ min-height: 44px; min-width: 44px;/);
  });

  it('ends with "Played to the end", Play again and Next scenario; nothing carries on by itself', () => {
    const second = scenario({ id: 't', title: 'Another' });
    setNextScenario((id) => (id === 's' ? second : null));
    playScenario(scenario(), { autoplay: false });
    expect(q('[data-action=scenario-next-scenario]').hidden).toBe(true);
    for (let i = 0; i < 4; i++) click('scenario-next');
    expect(text()).toBe('4 of 4 · Played to the end');
    expect(q('[data-action=scenario-toggle]').textContent).toBe('Play again');
    expect(q('[data-action=scenario-next-scenario]').hidden).toBe(false);
    expect(q('[data-action=scenario-next-scenario]').textContent).toBe('Next scenario');
    frames(0, 3000);
    expect(getPlayer().scenario().id).toBe('s'); // time passes: it is still this one
    click('scenario-next-scenario');
    expect(q('.hx-player-title').textContent).toBe('Another');
    expect(getPlayer().snapshot().index).toBe(0);
    setNextScenario(null);
  });

  it('puts the player\'s snapshot in state.scenario and rebuilds the scene when something moved', () => {
    const before = state.sceneVersion;
    playScenario(scenario(), { autoplay: false });
    expect(state.scenario).toMatchObject({ id: 's', index: 0, total: 4, playing: false });
    expect(state.sceneVersion).toBeGreaterThan(before);
    const v = state.sceneVersion;
    click('scenario-next');
    expect(state.scenario.index).toBe(1);
    expect(state.sceneVersion).toBeGreaterThan(v);
  });

  it('steps with the buttons, and disables Previous on the first step and Next at the end', () => {
    playScenario(scenario(), { autoplay: false });
    expect((q('[data-action=scenario-prev]')                     ).disabled).toBe(true);
    click('scenario-next');
    expect(text()).toBe('2 of 4 · The page calls POST /meals.');
    expect((q('[data-action=scenario-prev]')                     ).disabled).toBe(false);
    click('scenario-prev');
    expect(text()).toBe('1 of 4 · The page opens.');
    click('scenario-next'); click('scenario-next'); click('scenario-next');
    expect(text()).toBe('4 of 4 · A long way off.');
    click('scenario-next');
    expect((q('[data-action=scenario-next]')                     ).disabled).toBe(true);
    expect(q('[data-action=scenario-toggle]').textContent).toBe('Play again');
  });

  it('plays and pauses with the middle button, and says which it will do', () => {
    playScenario(scenario(), { autoplay: false });
    expect(q('[data-action=scenario-toggle]').textContent).toBe('Play');
    click('scenario-toggle');
    expect(q('[data-action=scenario-toggle]').textContent).toBe('Pause');
    expect(getPlayer().snapshot().playing).toBe(true);
    click('scenario-toggle');
    expect(q('[data-action=scenario-toggle]').textContent).toBe('Play');
    expect(getPlayer().snapshot().playing).toBe(false);
  });

  it('says Paused and Resumed through the live region, once each (F18)', async () => {
    const live = document.createElement('p');
    live.id = 'map-announcer';
    document.body.appendChild(live);
    const said = async () => { await new Promise((r) => setTimeout(r, 50)); return live.textContent; };
    playScenario(scenario(), { autoplay: false });
    click('scenario-toggle');
    expect(await said()).toBe('Playing');
    click('scenario-toggle');
    expect(await said()).toBe('Paused');
    live.remove();
  });

  it('says Resumed for a scenario paused part-way through its first step', async () => {
    const live = document.createElement('p');
    live.id = 'map-announcer';
    document.body.appendChild(live);
    playScenario(scenario());
    tickScenario(0);
    tickScenario(200); // part-way through step 1
    click('scenario-toggle');
    click('scenario-toggle');
    await new Promise((r) => setTimeout(r, 50));
    expect(live.textContent).toBe('Resumed');
    live.remove();
  });

  it('writes the step line (a live region) only when its words change, not on every frame', () => {
    playScenario(scenario());
    tickScenario(0);
    const line = q('.hx-player-text');
    const seen = [];
    const mo = new MutationObserver((ms) => seen.push(...ms));
    mo.observe(line, { subtree: true, childList: true, characterData: true });
    for (let t = 16; t < 200; t += 16) tickScenario(t); // frames within step 1
    mo.takeRecords().forEach((m) => seen.push(m));
    mo.disconnect();
    expect(seen).toHaveLength(0);
  });

  it('starts playing by default, and a close button takes the bar and the highlight away', () => {
    const before = state.sceneVersion;
    playScenario(scenario());
    expect(getPlayer().snapshot().playing).toBe(true);
    click('scenario-close');
    expect(bar()).toBeNull();
    expect(state.scenario).toBeNull();
    expect(getPlayer()).toBeNull();
    expect(state.sceneVersion).toBeGreaterThan(before + 1);
  });

  it('replaces the bar when another scenario is played, never stacking two', () => {
    playScenario(scenario(), { autoplay: false });
    playScenario(scenario({ title: 'Another' }), { autoplay: false });
    expect(document.querySelectorAll('.hx-player')).toHaveLength(1);
    expect(q('.hx-player-title').textContent).toBe('Another');
  });

  it('clearScenario (what selecting a node or switching view calls) ends it without redrawing', () => {
    playScenario(scenario(), { autoplay: false });
    const v = state.sceneVersion;
    clearScenario();
    expect(bar()).toBeNull();
    expect(state.scenario).toBeNull();
    expect(state.sceneVersion).toBe(v);
    stopScenario(); // nothing playing: nothing to do
    expect(state.sceneVersion).toBe(v);
  });
});

describe('the speed control', () => {
  const speed = () => q('.hx-player-speed')                     ;
  const choose = (value        ) => { speed().value = value; speed().dispatchEvent(new Event('change', { bubbles: true })); };
  /** Plays a story with no time of its own, so the viewer's speed is the one that counts */
  const playing = (opts         = {}) => playScenario(scenario({ stepMs: undefined }), opts);

  it('is a small labelled menu in the bar with 2 s, 5 s, 10 s and Manual, on 5 s to begin with', () => {
    playing({ autoplay: false });
    expect(speed().getAttribute('aria-label')).toBe('Time for each step');
    expect(bar().contains(speed())).toBe(true);
    expect([...speed().options].map((o) => o.textContent)).toEqual(['2 s', '5 s', '10 s', 'Manual']);
    expect(speed().value).toBe('5000');
    expect(state.scenario.stepMs).toBe(5000);
  });

  it('plays a step for 5 s on the default, and a scenario that sets its own time keeps it', () => {
    playing();
    frames(0, 4900);
    expect(state.scenario.index).toBe(0);
    frames(5000, 5100);
    expect(state.scenario.index).toBe(1);
    playScenario(scenario());
    expect(state.scenario.stepMs).toBe(1000);
  });

  it('changes the step time of the running player, without restarting it, and keeps the choice', () => {
    playing();
    frames(0, 3000);
    expect(state.scenario).toMatchObject({ index: 0, stepMs: 5000 });
    choose('2000');
    const p = getPlayer();
    expect(getPlayer()).toBe(p);
    expect(state.scenario).toMatchObject({ index: 0, playing: true, stepMs: 2000 });
    frames(3100, 3300);
    expect(state.scenario.index).toBe(1); // 3 s spent, 2 s asked for: on to the next step
    expect(localStorage.getItem('topology.scenarioSpeed')).toBe('2000');
    expect(speed().value).toBe('2000');
  });

  it('remembers the choice for the next scenario and the next visit', () => {
    playing({ autoplay: false });
    choose('10000');
    clearScenario();
    playing({ autoplay: false }); // the next scenario, or a reload: the bar is built again from the stored value
    expect(speed().value).toBe('10000');
    expect(state.scenario.stepMs).toBe(10_000);
    localStorage.setItem('topology.scenarioSpeed', 'manual');
    clearScenario();
    playing({ autoplay: false });
    expect(speed().value).toBe('manual');
  });

  it('treats a stored value it does not know as the default, and works without storage', () => {
    localStorage.setItem('topology.scenarioSpeed', 'ludicrous');
    playing({ autoplay: false });
    expect(speed().value).toBe('5000');
    const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    vi.stubGlobal('localStorage', broken);
    clearScenario();
    playing({ autoplay: false });
    expect(speed().value).toBe('5000');
    expect(() => choose('2000')).not.toThrow();
    expect(state.scenario.stepMs).toBe(2000); // it still applies to this player
  });

  it('Manual never advances by itself: the steps move on Next and Previous only', () => {
    playing();
    frames(0, 1000);
    choose('manual');
    expect(state.scenario).toMatchObject({ playing: false, manual: true, index: 0 });
    expect((q('[data-action=scenario-toggle]')                     ).disabled).toBe(true);
    expect(wantsFrames()).toBe(false);
    frames(1100, 60_000);
    tickScenario(1_000_000);
    expect(state.scenario.index).toBe(0);
    click('scenario-toggle');
    key(' ');
    expect(state.scenario.playing).toBe(false);
    click('scenario-next');
    expect(text()).toBe('2 of 4 · The page calls POST /meals.');
    key('ArrowRight');
    expect(state.scenario.index).toBe(2);
    click('scenario-prev');
    expect(state.scenario.index).toBe(1);
    choose('5000'); // back to a timed speed: Play comes back, and plays on from here
    expect((q('[data-action=scenario-toggle]')                     ).disabled).toBe(false);
    click('scenario-toggle');
    frames(2_000_000, 2_005_200);
    expect(state.scenario.index).toBe(2);
  });

  it('opens a scenario in Manual paused on its first step, and says nothing is playing', () => {
    localStorage.setItem('topology.scenarioSpeed', 'manual');
    playing();
    expect(state.scenario).toMatchObject({ index: 0, playing: false, manual: true });
    expect(q('[data-action=scenario-toggle]').textContent).toBe('Play');
  });

  it('is left alone by the keyboard shortcuts while it has focus (it is a form control)', () => {
    playing({ autoplay: false });
    speed().focus();
    const e = key(' ', speed());
    expect(e.defaultPrevented).toBe(false);
    expect(state.scenario.playing).toBe(false);
  });
});

describe('frames', () => {
  it('asks for them only while playing: not when paused, finished or closed', () => {
    expect(wantsFrames()).toBe(false);
    playScenario(scenario(), { autoplay: false });
    expect(wantsFrames()).toBe(false);
    click('scenario-toggle');
    expect(wantsFrames()).toBe(true);
    click('scenario-toggle');
    expect(wantsFrames()).toBe(false);
    playScenario(scenario({ steps: [{ node: 'a', text: 'one' }, { node: 'b', text: 'two' }] }));
    frames(0, 2100);
    expect(getPlayer().snapshot().done).toBe(true);
    expect(wantsFrames()).toBe(false);
    clearScenario();
    expect(wantsFrames()).toBe(false);
  });

  it('plays from the clock it is given: a step per step time, to the end', () => {
    playScenario(scenario({ steps: [{ node: 'a', text: 'one' }, { node: 'b', text: 'two' }, { node: 'a', text: 'three' }] }));
    frames(100, 900);
    expect(text()).toBe('1 of 3 · one');
    frames(1000, 1100);
    expect(text()).toBe('2 of 3 · two');
    frames(1200, 2100);
    expect(text()).toBe('3 of 3 · three');
    frames(2200, 3200);
    expect(state.scenario).toMatchObject({ done: true, playing: false });
    expect(q('[data-action=scenario-toggle]').textContent).toBe('Play again');
  });

  it('rebuilds the scene only when something the scene shows moved, not on every frame', () => {
    playScenario(scenario());
    tickScenario(0);
    const v = state.sceneVersion;
    for (let t = 16; t < 900; t += 16) tickScenario(t);
    expect(state.sceneVersion).toBe(v);
    frames(1000, 1200);
    expect(state.sceneVersion).toBeGreaterThan(v);
  });

  it('lets a slow frame count for no more than a quarter second (a tab that was hidden)', () => {
    playScenario(scenario());
    tickScenario(0);
    tickScenario(60_000);
    expect(state.scenario.index).toBe(0);
  });

  it('fills the progress bar as steps pass', () => {
    playScenario(scenario(), { autoplay: false });
    expect(q('.hx-player-fill').style.width).toBe('0%');
    click('scenario-next');
    click('scenario-next');
    expect(q('.hx-player-fill').style.width).toBe('50%');
  });
});

describe('the keyboard', () => {
  it('space plays and pauses, and the key does not also press a focused button', () => {
    playScenario(scenario(), { autoplay: false });
    const e = key(' ');
    expect(e.defaultPrevented).toBe(true);
    expect(getPlayer().snapshot().playing).toBe(true);
    key(' ', q('[data-action=scenario-next]'));
    expect(getPlayer().snapshot().playing).toBe(false);
    expect(state.scenario.index).toBe(0); // the focused Next button was not pressed by the same key
  });

  it('left and right step, and pause', () => {
    playScenario(scenario());
    key('ArrowRight');
    expect(state.scenario).toMatchObject({ index: 1, playing: false });
    key('ArrowRight');
    expect(text()).toBe('3 of 4 · The API checks the meal.');
    key('ArrowLeft');
    expect(text()).toBe('2 of 4 · The page calls POST /meals.');
  });

  it('does nothing while focus is in an input', () => {
    playScenario(scenario(), { autoplay: false });
    const input = document.getElementById('node-search') ;
    const e = key(' ', input);
    key('ArrowRight', input);
    expect(e.defaultPrevented).toBe(false);
    expect(state.scenario).toMatchObject({ index: 0, playing: false });
  });

  it('does nothing with a modifier held (the browser\'s and the system\'s shortcuts stay theirs)', () => {
    playScenario(scenario(), { autoplay: false });
    key('ArrowRight', document.body, { ctrlKey: true });
    key('ArrowRight', document.body, { metaKey: true });
    key('ArrowRight', document.body, { altKey: true });
    expect(state.scenario.index).toBe(0);
  });

  it('does nothing when no scenario is playing, and leaves other keys alone', () => {
    expect(key(' ').defaultPrevented).toBe(false);
    playScenario(scenario(), { autoplay: false });
    expect(key('a').defaultPrevented).toBe(false);
  });

  it('is not bound twice however often it is initialised', () => {
    initScenarioUi();
    initScenarioUi();
    playScenario(scenario(), { autoplay: false });
    key('ArrowRight');
    expect(state.scenario.index).toBe(1);
  });
});

describe('the camera', () => {
  it('leaves it alone while the step is on screen', () => {
    playScenario(scenario(), { autoplay: false });
    click('scenario-next');
    expect(state.camera).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(wantsFrames()).toBe(false);
  });

  it('glides to a step that is off screen, asking for frames until it arrives, and then stops asking', () => {
    playScenario(scenario(), { autoplay: false });
    const rect = (top        , bottom        ) => () => ({ top, bottom, left: 0, right: 800, width: 800, height: bottom - top, x: 0, y: top });
    state.canvas.getBoundingClientRect = rect(0, 600);
    bar().getBoundingClientRect = rect(500, 600); // the bar covers the bottom 100 px (and 8 of room)
    click('scenario-next'); click('scenario-next'); click('scenario-next');
    expect(wantsFrames()).toBe(true);
    const start = { ...state.camera };
    tickScenario(16);
    expect(state.camera.x).toBeLessThan(start.x); // moving towards the node
    for (let t = 32; t < 3000 && wantsFrames(); t += 16) tickScenario(t);
    expect(wantsFrames()).toBe(false);
    expect(state.camera.x).toBeCloseTo(400 - 3000, 5);
    expect(state.camera.y).toBeCloseTo((600 - 108) / 2 - 2005, 5); // centred in what the bar leaves (a node's label hangs below it: 5 px of that)
  });

  it('follows the step again when the bar grows after framing it (a check\'s line arrives), unless the viewer took hold of the map', () => {
    const watchers = [];
    vi.stubGlobal('ResizeObserver', class { constructor(fn) { this.fn = fn; this.els = []; watchers.push(this); } observe(el) { this.els.push(el); } disconnect() { this.gone = true; this.els = []; } });
    const grew = () => watchers.filter((w) => w.els.includes(bar())).forEach((w) => w.fn());
    const rect = (top        , bottom        ) => () => ({ top, bottom, left: 0, right: 800, width: 800, height: bottom - top, x: 0, y: top });
    state.canvas.getBoundingClientRect = rect(0, 600);
    playScenario(scenario(), { autoplay: false });
    let h = 80;
    Object.defineProperty(bar(), 'offsetHeight', { get: () => h, configurable: true });
    bar().getBoundingClientRect = () => rect(600 - h, 600)();
    click('scenario-next'); click('scenario-next'); click('scenario-next'); // the far node, framed above an 80px bar
    for (let t = 16; t < 3000 && wantsFrames(); t += 16) tickScenario(t);
    const y = () => state.camera.y + 2000 * state.camera.zoom;
    expect(y()).toBeCloseTo((600 - 88) / 2 - 5, 5);
    h = 300; // the bar grew: the step would be under it
    grew();
    for (let t = 4000; t < 7000 && wantsFrames(); t += 16) tickScenario(t);
    expect(y()).toBeCloseTo((600 - 308) / 2 - 5, 5);
    // once the viewer has moved the map, a change of the bar leaves the camera to them
    state.canvas.dispatchEvent(new Event('pointerdown'));
    h = 120;
    grew();
    expect(wantsFrames()).toBe(false);
    clearScenario();
    expect(watchers.filter((w) => !w.gone && w.els.length)).toHaveLength(0);
  });

  it('turns on the layer of a step that is on a layer that is off, says so once, and goes to it (#212)', async () => {
    const live = document.createElement('p');
    live.id = 'map-announcer';
    document.body.appendChild(live);
    state.nodes.push({ id: 'tbl', type: 'table', x: 3000, y: 2000, r: 20, color: '#fff', label: 'orders' });
    state.activeLayers = { ...(state.activeLayers || {}), table: false };
    const rect = (top        , bottom        ) => () => ({ top, bottom, left: 0, right: 800, width: 800, height: bottom - top, x: 0, y: top });
    state.canvas.getBoundingClientRect = rect(0, 600);
    playScenario(scenario({ steps: [{ node: 'a', text: 'Opens.' }, { node: 'tbl', text: 'The row is read.' }] }), { autoplay: false });
    expect(state.activeLayers.table).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(live.textContent).toBe('Turned on Tables to show this scenario\'s steps.');
    click('scenario-next');
    for (let t = 16; t < 3000 && wantsFrames(); t += 16) tickScenario(t);
    expect(state.camera.x + 3000 * state.camera.zoom).toBeCloseTo(400, 0); // the camera went to it
    live.remove();
  });

  it('is the user\'s again as soon as they take hold of the map', () => {
    playScenario(scenario(), { autoplay: false });
    click('scenario-next'); click('scenario-next'); click('scenario-next');
    expect(wantsFrames()).toBe(true);
    state.canvas.dispatchEvent(new Event('pointerdown'));
    expect(wantsFrames()).toBe(false);
  });
});

describe('what the review column needs of the player (spec 0006)', () => {
  it('opens paused on the step it is given, and says where the player is: on a step, at the end, and when it closes', () => {
    const seen = [];
    const stop = onPlayerChange((snap) => seen.push(snap && { id: snap.id, index: snap.index, done: snap.done }));
    const player = playScenario(scenario(), { step: 2 });
    expect(player.snapshot().index).toBe(2);
    expect(player.snapshot().playing).toBe(false); // choosing a step never starts the walk
    expect(seen[seen.length - 1]).toMatchObject({ index: 2, done: false });
    click('scenario-next');
    expect(seen[seen.length - 1]).toMatchObject({ index: 3 });
    click('scenario-next');
    expect(seen[seen.length - 1]).toMatchObject({ done: true });
    click('scenario-close');
    expect(seen[seen.length - 1]).toBeNull();
    stop();
  });

  it('leaves the focus where it is when asked, and gives it back to the place the list names when it closes', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    const home = document.createElement('button');
    document.body.appendChild(home);
    outside.focus();
    setCloseFocus(() => home);
    playScenario(scenario(), { autoplay: false, focus: false });
    expect(document.activeElement).toBe(outside);
    (q('[data-action=scenario-close]')                     ).focus();
    click('scenario-close');
    expect(document.activeElement).toBe(home);
    setCloseFocus(null);
    outside.remove();
    home.remove();
  });

  it('Space on a control of the review column presses it, and does not play or pause the walk', () => {
    document.body.insertAdjacentHTML('beforeend', '<aside id="review-column"><button type="button" id="a-step">step</button></aside>');
    playScenario(scenario(), { autoplay: false });
    const before = getPlayer().snapshot().playing;
    const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    document.getElementById('a-step').dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(getPlayer().snapshot().playing).toBe(before);
    document.getElementById('review-column').remove();
  });
});

describe('/?scenario-demo=1', () => {
  it('walks real nodes and edges of the map: every step of the demo is on the map', () => {
    const demo = demoScenario(topology.nodes, topology.edges);
    expect(demo.steps.length).toBeGreaterThanOrEqual(3);
    expect(demo.steps.length).toBeLessThanOrEqual(7);
    const ids = new Set(topology.nodes.map((n) => n.id));
    for (const s of demo.steps) for (const id of s.node !== undefined ? [s.node] : [s.edge.from, s.edge.to]) expect(ids.has(id), id).toBe(true);
    expect(demo.steps.some((s) => s.node) && demo.steps.some((s) => s.edge)).toBe(true);
    // every edge step names an edge that is on the map
    const keys = new Set(topology.edges.map((e) => [e.from, e.to, e.kind || ''].join('|')));
    for (const s of demo.steps.filter((x) => x.edge)) expect(keys.has([s.edge.from, s.edge.to, s.edge.kind || ''].join('|'))).toBe(true);
  });

  it('starts from the node with the most links, and gives no demo when the map has no links', () => {
    expect(demoScenario(nodes, edges).steps.map((s) => s.node || s.edge.to)).toEqual(['a', 'b', 'b']);
    expect(demoScenario([], [])).toBeNull();
    expect(demoScenario(nodes, [])).toBeNull();
    expect(demoScenario(nodes, [{ from: 'a', to: 'b' }])).toBeNull(); // ownership is not a link
  });

  it('starts only when asked, and says nothing when the map cannot show it', () => {
    state.nodes = topology.nodes.map((n) => ({ ...n, x: 0, y: 0, r: 10 }));
    state.edges = topology.edges;
    expect(maybeStartDemo('')).toBe(false);
    expect(maybeStartDemo('?scenario-demo=0')).toBe(false);
    expect(getPlayer()).toBeNull();
    expect(maybeStartDemo('?scenario-demo=1')).toBe(true);
    expect(q('.hx-player-title').textContent).toBe('A walk over the map');
    clearScenario();
    state.nodes = structuredClone(nodes);
    state.edges = [];
    expect(maybeStartDemo('?scenario-demo=1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  On a phone the bar is a bottom sheet (TOPO-18)
// ---------------------------------------------------------------------------
describe('on a phone: the bar is a bottom sheet', () => {
  const phone = (on = true) => {
    vi.stubGlobal('matchMedia', (query        ) => ({ matches: on && query.includes('767px'), addEventListener() {}, removeEventListener() {} }));
    (window       ).matchMedia = (globalThis       ).matchMedia;
  };
  const markup = '<div class="hx-stage"><canvas id="graph-canvas"></canvas><div id="sheet-dock">'
    + '<section id="proposal-bar"><div id="proposal-body"><div class="hx-proposal-head"><strong id="proposal-title">P</strong><button type="button" id="proposal-chip" data-action="toggle-proposal-changes">3 added</button></div></div></section>'
    + '<aside id="spec-drawer"></aside></div></div>';
  const handle = (el         ) => el.querySelector('.hx-sheet-handle')               ;
  const fire = (el         , type        , init         = {}) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));

  beforeEach(() => {
    phone();
    document.body.innerHTML = markup;
    state.canvas = document.getElementById('graph-canvas');
    state.coveredBottom = 0;
    initSheets();
  });
  afterEach(() => { state.coveredBottom = 0; document.body.innerHTML = ''; });

  it('opens as a peek in the dock, above the node panel, with a handle', () => {
    playScenario(scenario(), { autoplay: false });
    expect(bar().parentElement .id).toBe('sheet-dock');
    expect(bar().nextElementSibling .id).toBe('spec-drawer');
    expect(bar().dataset.sheetState).toBe('peek');
    expect(sheetState('player')).toBe('peek');
    expect(handle(bar()).getAttribute('aria-expanded')).toBe('false');
    expect(handle(bar()).getAttribute('aria-label')).toBe('Expand this panel');
  });

  it('expands on a tap on the handle and folds on the next, and on a swipe up or down', () => {
    playScenario(scenario(), { autoplay: false });
    handle(bar()).click();
    expect(bar().dataset.sheetState).toBe('expanded');
    expect(handle(bar()).getAttribute('aria-expanded')).toBe('true');
    handle(bar()).click();
    expect(bar().dataset.sheetState).toBe('peek');

    fire(handle(bar()), 'pointerdown', { clientY: 600 });
    fire(handle(bar()), 'pointerup', { clientY: 540 }); // up by 60: expand
    expect(bar().dataset.sheetState).toBe('expanded');
    fire(handle(bar()), 'click'); // the click that follows a swipe is not a tap
    expect(bar().dataset.sheetState).toBe('expanded');
    fire(handle(bar()), 'pointerdown', { clientY: 540 });
    fire(handle(bar()), 'pointerup', { clientY: 600 }); // down: collapse
    expect(bar().dataset.sheetState).toBe('peek');
  });

  it('keeps one sheet expanded at a time: expanding one folds the others', () => {
    expandSheet('proposal');
    expect(sheetState('proposal')).toBe('expanded');
    playScenario(scenario(), { autoplay: false });
    expect(sheetState('proposal')).toBe('peek'); // a scenario starting folds the others, so the map shows
    expect(sheetState('player')).toBe('peek');
    handle(bar()).click();
    expect(sheetState('player')).toBe('expanded');
    handle(q('#proposal-bar')).click();
    expect(sheetState('proposal')).toBe('expanded');
    expect(sheetState('player')).toBe('peek');
    expect(state.canvas.parentElement .dataset.sheetOpen).toBe('proposal');
  });

  it('folds on a tap on the map, and not on a tap elsewhere', () => {
    playScenario(scenario(), { autoplay: false });
    handle(bar()).click();
    fire(q('.hx-player-text'), 'mousedown');
    expect(sheetState('player')).toBe('expanded');
    fire(state.canvas, 'mousedown');
    expect(sheetState('player')).toBe('peek');
    handle(bar()).click();
    fire(state.canvas, 'touchstart');
    expect(sheetState('player')).toBe('peek');
  });

  it('expands on a tap anywhere on the peek, except on its Close, which still closes', () => {
    playScenario(scenario(), { autoplay: false });
    q('.hx-player-text').click();
    expect(sheetState('player')).toBe('expanded');
    expect(getPlayer()).not.toBeNull();
    handle(bar()).click();
    click('scenario-close');
    expect(bar()).toBeNull();
    expect(sheetState('player')).toBeUndefined(); // gone from the sheets with the bar
  });

  it('leaves the speed menu to the viewer on a peek: a tap on it does not expand the sheet', () => {
    playScenario(scenario(), { autoplay: false });
    const menu = q('.hx-player-speed');
    const e = new MouseEvent('click', { bubbles: true, cancelable: true });
    menu.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(sheetState('player')).toBe('peek');
  });

  it('shows only the title and the step in the peek: the controls are in the expanded sheet, still reachable', () => {
    playScenario(scenario(), { autoplay: false });
    handle(bar()).click();
    click('scenario-next'); // the buttons work in the expanded sheet
    expect(text()).toBe('2 of 4 · The page calls POST /meals.');
    expect(bar().dataset.sheetState).toBe('expanded');
  });

  it('follows a step into the part of the map the sheets leave: never under them', () => {
    const dock = q('#sheet-dock');
    Object.defineProperty(dock, 'offsetHeight', { value: 300, configurable: true });
    expect(measureCovered()).toBe(300);
    expect(state.coveredBottom).toBe(300);
    expect(state.canvas.parentElement .style.getPropertyValue('--hx-covered')).toBe('300px');
    playScenario(scenario(), { autoplay: false });
    key('ArrowRight'); key('ArrowRight'); key('ArrowRight'); // the far node (the keys work on a peek, whose buttons are folded away)
    for (let t = 16; t < 3000 && wantsFrames(); t += 16) tickScenario(t);
    expect(wantsFrames()).toBe(false);
    const y = state.camera.y + 2000 * state.camera.zoom;
    expect(y).toBeLessThanOrEqual(state.height - 300 - 16); // above the sheets, with a little room
    expect(y).toBeCloseTo((600 - 308) / 2 - 5, 5); // centred in what they leave (and its label: 5 px)
  });

  it('follows the step again when a sheet opens or closes and the covered height changes', () => {
    const dock = q('#sheet-dock');
    let covered = 120;
    Object.defineProperty(dock, 'offsetHeight', { get: () => covered, configurable: true });
    playScenario(scenario(), { autoplay: false });
    key('ArrowRight'); key('ArrowRight'); key('ArrowRight');
    for (let t = 16; t < 3000 && wantsFrames(); t += 16) tickScenario(t);
    const before = state.camera.y;
    covered = 400; // the sheet was expanded
    handle(bar()).click();
    for (let t = 4000; t < 7000 && wantsFrames(); t += 16) tickScenario(t);
    expect(state.camera.y).toBeLessThan(before); // the step moved up to stay in view
    expect(state.camera.y + 2000 * state.camera.zoom).toBeLessThanOrEqual(600 - 400);
  });

  it('is the desktop bar when the window is wide: the dock covers nothing', () => {
    phone(false);
    Object.defineProperty(q('#sheet-dock'), 'offsetHeight', { value: 300, configurable: true });
    expect(measureCovered()).toBe(0);
    expect(state.coveredBottom).toBe(0);
  });
});
