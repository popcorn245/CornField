// @vitest-environment happy-dom
/**
 * Mouse and touch on the map (TOPO-06): hover, click-select and drag start answered by the
 * spatial grid, pointer moves coalesced to one camera update and one draw per frame, and zoom that
 * keeps the point under the pointer still. A recording renderer and a faked clock stand in for the
 * browser.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const selectNode = vi.fn();
const closeDrawer = vi.fn();
vi.mock('../../explorer/panels.js', () => ({ selectNode: (n     ) => selectNode(n), closeDrawer: () => closeDrawer() }));

// @ts-expect-error plain JS modules, no declarations
import { state, touchScene } from '../../explorer/state.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { bindCanvasInput } from '../../explorer/input.js';

const node = (id        , type        , x        , y        , r = 20) => ({ id, type, x, y, r, color: '#336699', label: id });

let canvas                   ;
let drawn        ;

const mouse = (type        , x        , y        , target              = canvas) =>
  target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }));
const frame = () => vi.advanceTimersByTime(16);
const touch = (x        , y        ) => ({ clientX: x, clientY: y });
function touchEvent(type        , touches       , changed        = touches, target              = canvas) {
  const ev      = new Event(type, { bubbles: true, cancelable: true });
  ev.touches = touches;
  ev.changedTouches = changed;
  target.dispatchEvent(ev);
}

beforeAll(() => {
  canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} })           ;
  document.body.append(canvas);
  state.canvas = canvas;
  bindCanvasInput();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb                     ) => setTimeout(() => cb(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id        ) => clearTimeout(id));
  selectNode.mockClear();
  closeDrawer.mockClear();
  state.canvas = canvas;
  state.ctx = null;
  state.width = 800;
  state.height = 600;
  state.nodes = [node('root', 'root', 100, 100, 20), node('app', 'app', 300, 100), node('page', 'page', 500, 300, 10), node('tbl', 'table', 120, 110, 20)];
  state.edges = [];
  state.view = 'orbit';
  state.flow = null;
  state.selectedNode = null;
  state.searchQuery = '';
  state.sim = null;
  state.isFreeform = false;
  state.freeformPositions = {};
  state.camera = { x: 0, y: 0, zoom: 1 };
  state.activeLayers = { app: true, pkg: true, page: true, atom: true, molecule: true, token: true, tool: true, flow: true, table: true, rom: true, service: true, external: true, stack: false };
  canvas.style.cursor = 'grab';
  touchScene();
  drawn = 0;
  render.setRenderer({ kind: 'test', draw: () => { drawn++; }, resize() {}, destroy() {} });
  frame();
  render.cancelFrame();
  drawn = 0;
  mouse('mouseleave', 0, 0);
});

afterEach(() => {
  render.cancelFrame();
  window.dispatchEvent(new MouseEvent('mouseup', { clientX: 0, clientY: 0 }));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('hover', () => {
  it('shows a pointer cursor over a node and puts the old cursor back off it, without drawing', () => {
    mouse('mousemove', 300, 105);
    frame();
    expect(canvas.style.cursor).toBe('pointer');
    mouse('mousemove', 400, 250);
    frame();
    expect(canvas.style.cursor).toBe('grab');
    expect(drawn).toBe(0); // hover changes no picture
  });

  it('answers the topmost node where circles overlap (tbl is later than root), and reaches 6 px past the circle', () => {
    mouse('mousedown', 110, 105);
    mouse('mouseup', 110, 105, window);
    expect(selectNode).toHaveBeenCalledTimes(1);
    expect(selectNode.mock.calls[0][0]).toBe(state.nodes[3]); // tbl, drawn on top of root
    selectNode.mockClear();
    mouse('mousedown', 100 - 20 - 5, 100); // 5 px outside root's circle: inside the 6 px reach
    mouse('mouseup', 100 - 20 - 5, 100, window);
    expect(selectNode.mock.calls[0][0]).toBe(state.nodes[0]);
  });

  it('never answers a node on a hidden layer', () => {
    state.activeLayers.app = false;
    touchScene();
    mouse('mousedown', 300, 100);
    mouse('mouseup', 300, 100, window);
    expect(selectNode).not.toHaveBeenCalled();
  });

  it('builds the grid once for a hundred moves over the map', () => {
    render.getSpatialIndex();
    const built = render.spatialBuilds();
    for (let i = 0; i < 100; i++) { mouse('mousemove', 280 + (i % 40), 90 + (i % 30)); frame(); }
    expect(render.spatialBuilds()).toBe(built);
  });

  it('a hundred moves in one frame are one lookup', () => {
    const index = render.getSpatialIndex();
    const spy = vi.spyOn(index, 'nodeAt');
    for (let i = 0; i < 100; i++) mouse('mousemove', 300, 100 + (i % 3));
    expect(spy).not.toHaveBeenCalled(); // events only store the position
    frame();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('click and tap', () => {
  it('a click on a node selects it; a click on the background closes the panel when one is open', () => {
    mouse('mousedown', 300, 100);
    mouse('mouseup', 300, 100, window);
    expect(selectNode).toHaveBeenCalledWith(state.nodes[1]);
    state.selectedNode = state.nodes[1];
    mouse('mousedown', 700, 500);
    mouse('mouseup', 700, 500, window);
    expect(closeDrawer).toHaveBeenCalledTimes(1);
  });

  it('a press that did not start on the map does not count as a tap on the background: the handle of a sheet or a panel button leaves the panel open (TOPO-18)', () => {
    state.selectedNode = state.nodes[1];
    const handle = document.createElement('button');
    document.body.append(handle);
    mouse('mousedown', 400, 700, handle); // not the canvas
    mouse('mouseup', 400, 700, window);
    touchEvent('touchend', [], [touch(400, 700)], window); // a finger lifted off a sheet
    expect(closeDrawer).not.toHaveBeenCalled();
    mouse('mousedown', 700, 500); // on the map: that one is the background
    mouse('mouseup', 700, 500, window);
    expect(closeDrawer).toHaveBeenCalledTimes(1);
    handle.remove();
  });

  it('a finger reaches 16 px past the circle and at least 32 px', () => {
    touchEvent('touchstart', [touch(300 + 20 + 14, 100)]);
    touchEvent('touchend', [], [touch(300 + 20 + 14, 100)], window);
    expect(selectNode).toHaveBeenCalledWith(state.nodes[1]);
    selectNode.mockClear();
    // page has r = 10: its reach is the 32 px floor
    touchEvent('touchstart', [touch(500 + 30, 300)]);
    touchEvent('touchend', [], [touch(500 + 30, 300)], window);
    expect(selectNode).toHaveBeenCalledWith(state.nodes[2]);
    selectNode.mockClear();
    touchEvent('touchstart', [touch(500 + 40, 300)]);
    touchEvent('touchend', [], [touch(500 + 40, 300)], window);
    expect(selectNode).not.toHaveBeenCalled();
  });

  it('hit testing follows the camera', () => {
    state.camera = { x: 200, y: 50, zoom: 2 };
    // app is at world (300, 100): screen (800, 250)
    mouse('mousedown', 800, 250);
    mouse('mouseup', 800, 250, window);
    expect(selectNode).toHaveBeenCalledWith(state.nodes[1]);
  });
});

describe('pan', () => {
  it('a burst of moves in one frame is one camera update and one draw, ending where the pointer ended', () => {
    mouse('mousedown', 600, 500);
    const cam = state.camera;
    for (let i = 1; i <= 60; i++) mouse('mousemove', 600 + i, 500 + i * 2);
    expect(cam.x).toBe(0); // nothing is applied by the events themselves
    expect(drawn).toBe(0);
    frame();
    expect(cam.x).toBe(60);
    expect(cam.y).toBe(120);
    expect(drawn).toBe(1);
    // the next burst continues from there
    for (let i = 1; i <= 10; i++) mouse('mousemove', 660 + i, 620);
    frame();
    expect(cam.x).toBe(70);
    expect(cam.y).toBe(120);
    expect(drawn).toBe(2);
    mouse('mouseup', 670, 620, window);
  });

  it('releasing before a frame has run still applies the last position', () => {
    mouse('mousedown', 600, 500);
    mouse('mousemove', 650, 520);
    mouse('mouseup', 650, 520, window);
    expect(state.camera.x).toBe(50);
    expect(state.camera.y).toBe(20);
    expect(selectNode).not.toHaveBeenCalled(); // moved: not a click
  });
});

describe('node drag in freeform', () => {
  beforeEach(() => { state.isFreeform = true; });

  it('moves the node to the latest pointer position once per frame: one scene change and one draw, and the grid is rebuilt only when it is next asked for', () => {
    const app = state.nodes[1];
    render.getSpatialIndex();
    const version = state.sceneVersion;
    const grids = render.spatialBuilds();
    mouse('mousedown', 300, 100);
    for (let i = 1; i <= 40; i++) mouse('mousemove', 300 + i * 5, 100 + i);
    expect(app.x).toBe(300);
    expect(state.sceneVersion).toBe(version);
    frame();
    expect(app.x).toBe(500);
    expect(app.y).toBe(140);
    expect(state.sceneVersion).toBe(version + 1); // touchScene once, not forty times
    expect(drawn).toBe(1);
    expect(render.getScene().nodes.find((n     ) => n.id === 'app') .x).toBe(500); // the picture follows
    expect(render.spatialBuilds()).toBe(grids); // a drag frame builds no grid: only a lookup does, and only once
    render.getSpatialIndex();
    render.getSpatialIndex();
    expect(render.spatialBuilds()).toBe(grids + 1);
    mouse('mouseup', 500, 140, window);
    expect(state.freeformPositions.app).toEqual({ x: 500, y: 140 });
    expect(selectNode).not.toHaveBeenCalled();
  });

  it('after the drop, the node is found at its new place and no longer at the old one', () => {
    mouse('mousedown', 300, 100);
    mouse('mousemove', 400, 400);
    frame();
    mouse('mouseup', 400, 400, window);
    selectNode.mockClear();
    state.isFreeform = false;
    mouse('mousedown', 400, 400);
    mouse('mouseup', 400, 400, window);
    expect(selectNode).toHaveBeenCalledWith(state.nodes[1]);
    selectNode.mockClear();
    mouse('mousedown', 300, 100);
    mouse('mouseup', 300, 100, window);
    expect(selectNode).not.toHaveBeenCalled();
  });

  it('the data-flow view always pans, even over a node', () => {
    state.view = 'dataflow';
    state.flow = { ids: new Set(['app']), edges: [], top: 0, headers: [] };
    touchScene();
    mouse('mousedown', 300, 100);
    mouse('mousemove', 340, 100);
    frame();
    expect(state.camera.x).toBe(40);
    expect(state.nodes[1].x).toBe(300);
  });
});

describe('zoom keeps the point under the pointer still', () => {
  const wheel = (x        , y        , deltaY        ) => {
    const ev      = new Event('wheel', { bubbles: true, cancelable: true });
    Object.assign(ev, { clientX: x, clientY: y, deltaY });
    canvas.dispatchEvent(ev);
    return ev;
  };
  const worldAt = (sx        , sy        ) => ({ x: (sx - state.camera.x) / state.camera.zoom, y: (sy - state.camera.y) / state.camera.zoom });

  it('wheel zoom: the world point under the pointer does not move on screen, in or out, at any camera', () => {
    for (const cam of [{ x: 0, y: 0, zoom: 1 }, { x: -230, y: 80, zoom: 0.5 }, { x: 410, y: -90, zoom: 2.4 }]) {
      for (const [px, py] of [[400, 300], [30, 570], [790, 10]]) {
        for (const deltaY of [-100, 100, -100, -100]) {
          state.camera = { ...cam };
          const before = worldAt(px, py);
          const ev = wheel(px, py, deltaY);
          const after = worldAt(px, py);
          expect(ev.defaultPrevented).toBe(true);
          expect(after.x).toBeCloseTo(before.x, 6);
          expect(after.y).toBeCloseTo(before.y, 6);
        }
      }
    }
  });

  it('many wheel events in a frame are one draw', () => {
    for (let i = 0; i < 20; i++) wheel(400, 300, -100);
    expect(drawn).toBe(0);
    frame();
    expect(drawn).toBe(1);
    expect(state.camera.zoom).toBe(3); // clamped
  });

  it('pinch: the point between the fingers stays between them, and moving both fingers pans', () => {
    const anchor = worldAt(400, 300);
    touchEvent('touchstart', [touch(350, 300), touch(450, 300)]);
    touchEvent('touchmove', [touch(300, 300), touch(500, 300)]); // spread to twice the distance, same middle
    frame();
    expect(state.camera.zoom).toBeCloseTo(2, 6);
    const on = { x: state.camera.x + anchor.x * state.camera.zoom, y: state.camera.y + anchor.y * state.camera.zoom };
    expect(on.x).toBeCloseTo(400, 6);
    expect(on.y).toBeCloseTo(300, 6);
    // both fingers 50 px to the right and 20 down, same distance: a pure pan
    touchEvent('touchmove', [touch(350, 320), touch(550, 320)]);
    frame();
    expect(state.camera.zoom).toBeCloseTo(2, 6);
    const moved = { x: state.camera.x + anchor.x * state.camera.zoom, y: state.camera.y + anchor.y * state.camera.zoom };
    expect(moved.x).toBeCloseTo(450, 6);
    expect(moved.y).toBeCloseTo(320, 6);
    touchEvent('touchend', [], [touch(350, 320)], window);
  });

  it('a pinch is coalesced like a pan: many touchmoves, one draw', () => {
    touchEvent('touchstart', [touch(350, 300), touch(450, 300)]);
    for (let i = 0; i < 30; i++) touchEvent('touchmove', [touch(350 - i, 300), touch(450 + i, 300)]);
    expect(drawn).toBe(0);
    frame();
    expect(drawn).toBe(1);
    touchEvent('touchend', [], [touch(350, 300)], window);
  });
});
