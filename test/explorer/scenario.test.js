/**
 * @vitest-environment node
 *
 * The scenario player's pure core (TOPO-10, spec 0012 B3): a state machine over the steps of a
 * scenario, driven by injected time. No DOM, no clock: every test hands `tick` the time it wants.
 */
import { describe, it, expect } from 'vitest';
import {
  cameraFor, createPlayer, DEFAULT_STEP_MS, parseSpeed, romScenario, SPEED_CHOICES, SPEED_KEY, stepDuration,
  // @ts-expect-error plain JS modules, no declarations
} from '../../explorer/scenario.js';

const scenario = (extra         = {}) => ({
  id: 'save-a-meal',
  title: 'Saving a meal',
  steps: [
    { node: 'page-meals', text: 'The page opens.' },
    { edge: { from: 'page-meals', to: 'api-meals', kind: 'calls' }, text: 'The page calls POST /meals.' },
    { node: 'api-meals', text: 'The API checks the meal.' },
    { edge: { from: 'api-meals', to: 'table-meals', kind: 'writes' }, text: 'It writes the row.' },
    { node: 'table-meals', text: 'The row is stored.' },
  ],
  ...extra,
});

describe('a new player', () => {
  it('sits on the first step, paused, with only that step visited', () => {
    const p = createPlayer(scenario());
    const s = p.snapshot();
    expect(s).toMatchObject({ id: 'save-a-meal', title: 'Saving a meal', total: 5, index: 0, playing: false, done: false, progress: 0 });
    expect(s.current).toMatchObject({ node: 'page-meals', text: 'The page opens.' });
    expect([...s.visited.nodes]).toEqual(['page-meals']);
    expect([...s.visited.edges]).toEqual([]);
  });

  it('has the default step time of 5 s, and a step may bring its own', () => {
    expect(DEFAULT_STEP_MS).toBe(5000);
    expect(stepDuration({ node: 'a', text: 'x' })).toBe(5000);
    expect(stepDuration({ node: 'a', text: 'x' }, 1300)).toBe(1300);
    expect(stepDuration({ node: 'a', text: 'x', ms: 400 }, 1300)).toBe(400);
    expect(stepDuration({ node: 'a', text: 'x', ms: 0 }, 1300)).toBe(1300); // not a usable time
    expect(stepDuration({ node: 'a', text: 'x', ms: 'soon' }, 1300)).toBe(1300);
  });

  it('plays a step for 5 s when nothing sets a time', () => {
    const p = createPlayer(scenario());
    p.play();
    p.tick(0);
    p.tick(4999);
    expect(p.snapshot()).toMatchObject({ index: 0, stepMs: 5000 });
    p.tick(5000);
    expect(p.snapshot()).toMatchObject({ index: 1, stepMs: 5000 });
  });

  it('survives a scenario with no steps', () => {
    const p = createPlayer({ id: 'x', title: 'Empty', steps: [] });
    expect(p.snapshot()).toMatchObject({ total: 0, index: 0, done: true, playing: false, current: { text: '' } });
    p.play();
    p.tick(0);
    p.next();
    p.prev();
    expect(p.snapshot().total).toBe(0);
  });
});

describe('the speed setting', () => {
  it('offers 2 s, 5 s, 10 s and Manual, the default among them, and keeps its setting under a topology. key', () => {
    expect(SPEED_CHOICES.map((c     ) => c.label)).toEqual(['2 s', '5 s', '10 s', 'Manual']);
    expect(SPEED_CHOICES.map((c     ) => c.value)).toEqual(['2000', '5000', '10000', 'manual']);
    expect(SPEED_CHOICES.some((c     ) => c.value === String(DEFAULT_STEP_MS))).toBe(true);
    expect(SPEED_KEY).toBe('topology.scenarioSpeed');
  });

  it('reads a stored value back, and falls back to the default for anything else', () => {
    expect(parseSpeed('2000')).toBe(2000);
    expect(parseSpeed('10000')).toBe(10_000);
    expect(parseSpeed('manual')).toBe('manual');
    for (const bad of [null, undefined, '', 'fast', '0', '-5', '1234', 'NaN']) expect(parseSpeed(bad)).toBe(DEFAULT_STEP_MS);
  });
});

describe('visited', () => {
  it('collects the nodes and edges up to and including the current step', () => {
    const p = createPlayer(scenario());
    p.goTo(3);
    const v = p.snapshot().visited;
    expect([...v.nodes].sort()).toEqual(['api-meals', 'page-meals', 'table-meals']); // the edge step counts both its ends
    expect([...v.edges]).toEqual(['page-meals|api-meals|calls', 'api-meals|table-meals|writes']);
    expect(v.edgeList).toEqual([{ from: 'page-meals', to: 'api-meals', kind: 'calls' }, { from: 'api-meals', to: 'table-meals', kind: 'writes' }]);
  });

  it('tells an edge step from a node step in `current`, with the proposal\'s edge key', () => {
    const p = createPlayer(scenario());
    p.goTo(1);
    const { current } = p.snapshot();
    expect(current.node).toBeUndefined();
    expect(current.edge).toEqual({ from: 'page-meals', to: 'api-meals', kind: 'calls' });
    expect(current.edgeKey).toBe('page-meals|api-meals|calls');
    expect(current.text).toBe('The page calls POST /meals.');
  });

  it('keys a flow edge by its flow and an ownership edge as own', () => {
    const p = createPlayer({ id: 'x', title: 'X', steps: [{ edge: { from: 'a', to: 'b', kind: 'flow', flow: 'api' }, text: 'one' }, { edge: { from: 'a', to: 'c' }, text: 'two' }] });
    p.goTo(1);
    expect([...p.snapshot().visited.edges]).toEqual(['a|b|flow:api', 'a|c|own']);
  });

  it('shrinks again when stepping back', () => {
    const p = createPlayer(scenario());
    p.goTo(4);
    p.prev();
    expect(p.snapshot().visited.nodes.has('table-meals')).toBe(true); // the edge step into it still counts
    p.prev();
    expect(p.snapshot().visited.nodes.has('table-meals')).toBe(false);
  });

  it('is a new set on every snapshot, so a caller cannot change the walk', () => {
    const p = createPlayer(scenario());
    p.snapshot().visited.nodes.add('hacked');
    expect(p.snapshot().visited.nodes.has('hacked')).toBe(false);
  });
});

describe('stepping by hand', () => {
  it('next and prev move one step, stay inside the scenario and pause', () => {
    const p = createPlayer(scenario());
    p.play();
    p.tick(0);
    p.next();
    expect(p.snapshot()).toMatchObject({ index: 1, playing: false });
    p.next(); p.next(); p.next();
    expect(p.snapshot().index).toBe(4);
    p.next();
    expect(p.snapshot().index).toBe(4);
    p.prev();
    expect(p.snapshot().index).toBe(3);
    p.goTo(0);
    p.prev();
    expect(p.snapshot().index).toBe(0);
  });

  it('prev pauses a playing player too', () => {
    const p = createPlayer(scenario());
    p.goTo(2);
    p.play();
    p.tick(0);
    p.prev();
    expect(p.snapshot()).toMatchObject({ index: 1, playing: false });
  });

  it('goTo clamps to the steps and rounds down; it does not play', () => {
    const p = createPlayer(scenario());
    p.goTo(99);
    expect(p.snapshot().index).toBe(4);
    p.goTo(-3);
    expect(p.snapshot().index).toBe(0);
    p.goTo(2.9);
    expect(p.snapshot()).toMatchObject({ index: 2, playing: false });
    p.goTo(Number.NaN);
    expect(p.snapshot().index).toBe(2);
  });

  it('next on the last step finishes the walk (done), and prev reopens it', () => {
    const p = createPlayer(scenario());
    p.goTo(4);
    expect(p.snapshot().done).toBe(false); // standing on the last step is not finishing it
    p.next();
    expect(p.snapshot()).toMatchObject({ index: 4, done: true, playing: false });
    p.prev();
    expect(p.snapshot()).toMatchObject({ index: 3, done: false });
  });
});

describe('playing', () => {
  it('advances one step per step time, with time handed in', () => {
    const p = createPlayer(scenario(), { stepMs: 1000 });
    p.play();
    p.tick(10_000); // the first tick only sets the clock
    expect(p.snapshot()).toMatchObject({ index: 0, playing: true, progress: 0 });
    p.tick(10_500);
    expect(p.snapshot()).toMatchObject({ index: 0, progress: 0.5 });
    p.tick(11_000);
    expect(p.snapshot()).toMatchObject({ index: 1, progress: 0 });
    p.tick(12_250);
    expect(p.snapshot()).toMatchObject({ index: 2, progress: 0.25 });
  });

  it('takes its step time from the step, then the scenario, then the viewer\'s speed, then the default', () => {
    const steps = [{ node: 'a', text: 'one', ms: 700 }, { node: 'b', text: 'two' }];
    const at = (sc        , opts         ) => {
      const p = createPlayer({ id: 'x', title: 'X', steps, ...sc }, opts);
      return [0, 1].map((i) => { p.goTo(i); return p.snapshot().stepMs; });
    };
    expect(at({})).toEqual([700, 5000]); // the default
    expect(at({}, { stepMs: 2000 })).toEqual([700, 2000]); // the viewer's setting beats the default
    expect(at({ stepMs: 3000 }, { stepMs: 2000 })).toEqual([700, 3000]); // the scenario's own time beats the setting
    expect(at({ stepMs: 3000 }, { stepMs: 'manual' })).toEqual([700, 3000]); // still the figure shown, though nothing advances
  });

  it('applies a new speed to the running player without restarting it', () => {
    const p = createPlayer(scenario(), { stepMs: 2000 });
    p.play();
    p.tick(0);
    p.tick(1000);
    expect(p.snapshot()).toMatchObject({ index: 0, stepMs: 2000, progress: 0.5 });
    p.setSpeed(10_000);
    expect(p.snapshot()).toMatchObject({ index: 0, playing: true, stepMs: 10_000, progress: 0.1 }); // the second already spent still counts
    p.tick(9999);
    expect(p.snapshot().index).toBe(0);
    p.tick(10_000);
    expect(p.snapshot().index).toBe(1);
    p.tick(10_700);
    expect(p.snapshot().index).toBe(1);
    p.setSpeed(500); // a faster speed than the time already spent: on to the next step at the next tick
    p.tick(10_701);
    expect(p.snapshot()).toMatchObject({ index: 2, progress: 201 / 500 });
    expect(p.snapshot().playing).toBe(true);
  });

  it('does not change a step that has its own time, or a scenario that has its own step time', () => {
    const p = createPlayer(scenario({ stepMs: 300 }), { stepMs: 2000 });
    p.setSpeed(10_000);
    expect(p.snapshot().stepMs).toBe(300);
  });

  it('never advances by itself in manual speed, only on next()', () => {
    const p = createPlayer(scenario({ stepMs: 100 }), { stepMs: 'manual' });
    p.play();
    expect(p.snapshot()).toMatchObject({ playing: false, manual: true });
    p.tick(0);
    p.tick(1_000_000);
    expect(p.snapshot()).toMatchObject({ index: 0, playing: false, progress: 0 });
    p.next();
    expect(p.snapshot().index).toBe(1);
    p.tick(2_000_000);
    expect(p.snapshot().index).toBe(1);
  });

  it('stops where it is when switched to manual mid-play, and plays on when switched back', () => {
    const p = createPlayer(scenario(), { stepMs: 1000 });
    p.play();
    p.tick(0);
    p.tick(1500);
    expect(p.snapshot().index).toBe(1);
    p.setSpeed('manual');
    expect(p.snapshot()).toMatchObject({ index: 1, playing: false, manual: true });
    p.tick(9000);
    expect(p.snapshot().index).toBe(1);
    p.setSpeed(1000);
    expect(p.snapshot()).toMatchObject({ index: 1, playing: false, manual: false });
    p.play();
    p.tick(10_000);
    p.tick(11_000);
    expect(p.snapshot().index).toBe(2);
  });

  it('can skip several steps in one tick (a slow frame) and keeps the remainder', () => {
    const p = createPlayer(scenario(), { stepMs: 1000 });
    p.play();
    p.tick(0);
    p.tick(3400);
    expect(p.snapshot()).toMatchObject({ index: 3, progress: 0.4 });
  });

  it('gives each step its own time when it carries `ms`', () => {
    const s = scenario();
    (s.steps[0]       ).ms = 200;
    (s.steps[1]       ).ms = 3000;
    const p = createPlayer(s, { stepMs: 1000 });
    p.play();
    p.tick(0);
    p.tick(199);
    expect(p.snapshot().index).toBe(0);
    p.tick(200);
    expect(p.snapshot().index).toBe(1);
    p.tick(3199);
    expect(p.snapshot()).toMatchObject({ index: 1, stepMs: 3000 });
    p.tick(3200);
    expect(p.snapshot()).toMatchObject({ index: 2, stepMs: 1000 });
  });

  it('stops at the end: the last step runs its time, then done and not playing', () => {
    const p = createPlayer(scenario(), { stepMs: 100 });
    p.play();
    p.tick(0);
    p.tick(399);
    expect(p.snapshot()).toMatchObject({ index: 3, done: false, playing: true });
    p.tick(499);
    expect(p.snapshot()).toMatchObject({ index: 4, done: false, playing: true });
    p.tick(500);
    expect(p.snapshot()).toMatchObject({ index: 4, done: true, playing: false, progress: 1 });
    p.tick(900); // nothing moves any more
    expect(p.snapshot()).toMatchObject({ index: 4, done: true, playing: false });
  });

  it('play at the end starts again from the first step', () => {
    const p = createPlayer(scenario(), { stepMs: 100 });
    p.play();
    p.tick(0);
    p.tick(1000);
    expect(p.snapshot().done).toBe(true);
    p.play();
    expect(p.snapshot()).toMatchObject({ index: 0, done: false, playing: true });
    p.tick(2000);
    p.tick(2100);
    expect(p.snapshot().index).toBe(1);
  });

  it('play after a manual finish also restarts', () => {
    const p = createPlayer(scenario());
    p.goTo(4);
    p.next();
    p.play();
    expect(p.snapshot()).toMatchObject({ index: 0, done: false, playing: true });
  });

  it('pause keeps the time already spent in the step, and play carries on from it', () => {
    const p = createPlayer(scenario(), { stepMs: 1000 });
    p.play();
    p.tick(0);
    p.tick(600);
    p.pause();
    expect(p.snapshot()).toMatchObject({ index: 0, playing: false, progress: 0.6 });
    p.tick(50_000); // paused: time passing changes nothing
    expect(p.snapshot()).toMatchObject({ index: 0, progress: 0.6 });
    p.play();
    p.tick(60_000); // sets the clock again
    p.tick(60_400);
    expect(p.snapshot()).toMatchObject({ index: 1, progress: 0 });
  });

  it('says whether it is playing, without a snapshot', () => {
    const p = createPlayer(scenario());
    expect(p.isPlaying()).toBe(false);
    p.play();
    expect(p.isPlaying()).toBe(true);
    p.next();
    expect(p.isPlaying()).toBe(false);
  });

  it('play while playing, and pause while paused, change nothing', () => {
    const p = createPlayer(scenario(), { stepMs: 1000 });
    p.pause();
    expect(p.snapshot().playing).toBe(false);
    p.play();
    p.tick(0);
    p.tick(500);
    p.play();
    p.tick(600);
    expect(p.snapshot().progress).toBeCloseTo(0.6);
  });

  it('never lets one frame skip more than maxFrameMs (a tab that was hidden)', () => {
    const p = createPlayer(scenario(), { stepMs: 1000, maxFrameMs: 250 });
    p.play();
    p.tick(0);
    p.tick(100);
    p.tick(600_000); // came back after ten minutes
    expect(p.snapshot()).toMatchObject({ index: 0 });
    expect(p.snapshot().progress).toBeCloseTo(0.35);
  });

  it('says when the current step began, on the clock tick uses (for a packet that starts at the edge\'s start)', () => {
    const p = createPlayer(scenario(), { stepMs: 1000 });
    expect(p.snapshot().stepStartMs).toBeNull();
    p.play();
    p.tick(5000);
    expect(p.snapshot().stepStartMs).toBe(5000);
    p.tick(6300);
    expect(p.snapshot()).toMatchObject({ index: 1, stepStartMs: 6000 });
  });

  it('keeps the same step start across the frames of a step (so a scene built from it need not be rebuilt)', () => {
    const p = createPlayer(scenario(), { stepMs: 1000 });
    p.play();
    p.tick(5000.3);
    for (const t of [5016.7, 5033.4, 5050.1, 5300.9]) { p.tick(t); expect(p.snapshot().stepStartMs).toBe(5000.3); }
  });

  it('moves the step start when a frame was cut short (the step began later than the clock says)', () => {
    const p = createPlayer(scenario(), { stepMs: 1000, maxFrameMs: 250 });
    p.play();
    p.tick(0);
    p.tick(100);
    p.tick(600_000);
    const s = p.snapshot();
    expect(s.stepStartMs).toBeCloseTo(600_000 - s.progress * 1000);
  });

  it('forgets the step start while paused', () => {
    const p = createPlayer(scenario(), { stepMs: 1000 });
    p.play();
    p.tick(10);
    p.pause();
    expect(p.snapshot().stepStartMs).toBeNull();
  });

  it('stop pauses and goes back to the first step', () => {
    const p = createPlayer(scenario(), { stepMs: 1000 });
    p.play();
    p.tick(0);
    p.tick(2500);
    p.stop();
    expect(p.snapshot()).toMatchObject({ index: 0, playing: false, done: false, progress: 0 });
  });
});

describe('replacing the scenario (what-if editing)', () => {
  it('keeps the step it was on when it still exists, and clamps when it does not', () => {
    const p = createPlayer(scenario());
    p.goTo(3);
    p.setScenario({ ...scenario(), title: 'Edited', steps: scenario().steps.slice(0, 3) });
    expect(p.snapshot()).toMatchObject({ title: 'Edited', total: 3, index: 2 });
    p.setScenario(scenario());
    expect(p.snapshot()).toMatchObject({ total: 5, index: 2 });
  });
});

describe('the camera', () => {
  const view = { width: 1000, height: 600 };
  const at = { x: 0, y: 0, zoom: 1 };
  const nodes = new Map([
    ['near', { x: 500, y: 300, r: 20 }],
    ['near2', { x: 700, y: 300, r: 20 }],
    ['far', { x: 3000, y: 2000, r: 20 }],
    ['far2', { x: 3400, y: 2100, r: 20 }],
    ['wide1', { x: -1500, y: 0, r: 20 }],
    ['wide2', { x: 2500, y: 0, r: 20 }],
    ['huge1', { x: -20000, y: 0, r: 20 }],
    ['huge2', { x: 20000, y: 0, r: 20 }],
  ]);

  it('leaves the camera alone while the step is on screen', () => {
    expect(cameraFor({ node: 'near', text: '' }, at, view, nodes)).toBeNull();
    expect(cameraFor({ edge: { from: 'near', to: 'near2' }, text: '' }, at, view, nodes)).toBeNull();
  });

  it('centres a node that is off screen, at the same zoom', () => {
    const cam = cameraFor({ node: 'far', text: '' }, at, view, nodes);
    expect(cam).toEqual({ x: 500 - 3000, y: 300 - 2000, zoom: 1 });
  });

  it('centres an edge that is off screen but fits, at the same zoom', () => {
    const cam = cameraFor({ edge: { from: 'far', to: 'far2' }, text: '' }, at, view, nodes);
    expect(cam.zoom).toBe(1);
    expect(cam.x + 3200).toBeCloseTo(500); // the middle of the two ends is the middle of the screen
    expect(cam.y + 2050).toBeCloseTo(300);
  });

  it('zooms out to fit an edge too long for the screen', () => {
    const cam = cameraFor({ edge: { from: 'wide1', to: 'wide2' }, text: '' }, at, view, nodes);
    expect(cam.zoom).toBeLessThan(1);
    expect(cam.zoom).toBeGreaterThanOrEqual(0.18);
    const screenX = (x        ) => cam.x + x * cam.zoom;
    expect(screenX(-1500)).toBeGreaterThanOrEqual(0);
    expect(screenX(2500)).toBeLessThanOrEqual(1000);
  });

  it('never zooms out below 0.18, the zoom fit-to-screen stops at', () => {
    expect(cameraFor({ edge: { from: 'huge1', to: 'huge2' }, text: '' }, at, view, nodes).zoom).toBe(0.18);
  });

  it('does nothing for a step whose node is not in the map', () => {
    expect(cameraFor({ node: 'ghost', text: '' }, at, view, nodes)).toBeNull();
    expect(cameraFor({ edge: { from: 'ghost', to: 'near' }, text: '' }, at, view, nodes)).toBeNull();
  });

  it('does nothing before the viewport has a size', () => {
    expect(cameraFor({ node: 'far', text: '' }, at, { width: 0, height: 0 }, nodes)).toBeNull();
  });
});

describe('the ROM walk as a scenario', () => {
  const stages = [
    { stage: 'write', node: 'table-meals', label: 'meals row committed', ms: 1 },
    { stage: 'lookup', node: 'rom-deps', label: 'receipts: 2 baked files read keys this row matches', ms: 1 },
    { stage: 'coalesce', node: 'rom-renderer', label: 'wait out the burst window', ms: 50 },
    { stage: 'render', node: 'rom-renderer', label: 're-run 2 render functions', ms: 2 },
    { stage: 'stream', node: 'page-changes', label: 'open tabs get the row', ms: 5 },
  ];
  const path = ['table-meals', 'store-audit-log', 'rom-deps', 'rom-renderer', 'page-changes'];
  const labelOf = (id        ) => ({ 'store-audit-log': 'Audit log' }                          )[id] || id;

  it('is the path nodes in order, the stage labels as their text, one every 420 ms', () => {
    const s = romScenario({ table: 'meals', path, stages, labelOf });
    expect(s.steps.map((x     ) => x.node)).toEqual(path);
    expect(s.steps[0].text).toBe('meals row committed');
    expect(s.steps[3].text).toBe('wait out the burst window, then re-run 2 render functions'); // two stages in one node
    expect(s.steps[1].text).toBe('Audit log'); // a node with no stage keeps its name
    expect(s.title).toBe('A write to meals through ROM');
    expect(s.linkNodes).toBe(true);
    expect(s.stepMs).toBe(420);
  });

  it('plays to the same set the old walk lit: every path node, once the last step is done', () => {
    const s = romScenario({ table: 'meals', path, stages, labelOf });
    const p = createPlayer(s, { stepMs: s.stepMs });
    p.play();
    p.tick(0);
    p.tick(420 * path.length);
    const end = p.snapshot();
    expect(end).toMatchObject({ done: true, playing: false });
    expect([...end.visited.nodes]).toEqual(path);
  });
});
