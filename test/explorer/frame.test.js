/**
 * When the map draws (TOPO-06): the decision for one frame, and the scheduler that asks for
 * frames only while something changes or animates. Node environment; time is faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { frameDecision, packetsOnScreen, createFrameScheduler, IDLE_MS, PACKET_FRAME_MS } from '../../explorer/frame.js';


const base        = { dirty: false, packetsVisible: false, hidden: false, reduceMotion: false, idleMs: 0 };

describe('frameDecision', () => {
  const rows                                                                = [
    ['nothing changed, no packets: no draw, no next frame', {}, { draw: false, again: false }],
    ['dirty, no packets: one draw, no next frame', { dirty: true }, { draw: true, again: false }],
    ['packets on screen, not dirty: draw, and go on', { packetsVisible: true }, { draw: true, again: true }],
    ['packets on screen and dirty: draw, and go on', { packetsVisible: true, dirty: true }, { draw: true, again: true }],
    ['tab hidden, dirty: wait until it is shown', { hidden: true, dirty: true }, { draw: false, again: false }],
    ['tab hidden, packets: nothing', { hidden: true, packetsVisible: true }, { draw: false, again: false }],
    ['reduced motion, packets: they stand still, no loop', { reduceMotion: true, packetsVisible: true }, { draw: false, again: false }],
    ['reduced motion, dirty: still draws the change', { reduceMotion: true, dirty: true, packetsVisible: true }, { draw: true, again: false }],
    ['idle just under 30 s, packets: still animating', { packetsVisible: true, idleMs: IDLE_MS - 1 }, { draw: true, again: true }],
    ['idle 30 s, packets: they stop', { packetsVisible: true, idleMs: IDLE_MS }, { draw: false, again: false }],
    ['idle 30 s, packets, dirty: draws the change, then stops', { packetsVisible: true, idleMs: IDLE_MS, dirty: true }, { draw: true, again: false }],
    ['idle for ages, nothing animating, dirty: draws', { dirty: true, idleMs: 1e9 }, { draw: true, again: false }],
  ];
  it.each(rows)('%s', (_name, over, expected) => {
    expect(frameDecision({ ...base, ...over })).toEqual(expected);
  });

  it('covers every combination without an unexpected answer (draw is dirty-or-animating, again is animating)', () => {
    for (const dirty of [false, true]) for (const packetsVisible of [false, true]) for (const hidden of [false, true]) {
      for (const reduceMotion of [false, true]) for (const idleMs of [0, IDLE_MS - 1, IDLE_MS, 10 * IDLE_MS]) {
        const animating = packetsVisible && !hidden && !reduceMotion && idleMs < IDLE_MS;
        const expected = { draw: !hidden && (dirty || animating), again: animating };
        expect(frameDecision({ dirty, packetsVisible, hidden, reduceMotion, idleMs })).toEqual(expected);
      }
    }
  });
});

describe('packetsOnScreen', () => {
  const edge = (x1        , y1        , x2        , y2        , packet = true, curve      = null) =>
    ({ x1, y1, x2, y2, curve, packet: packet ? { radius: 3.5, glow: 10 } : null });
  const cam = { x: 0, y: 0, zoom: 1 };

  it('is false for a scene without packets', () => {
    expect(packetsOnScreen({ edges: [edge(0, 0, 100, 100, false)] }, cam, 800, 600)).toBe(false);
    expect(packetsOnScreen({ edges: [] }, cam, 800, 600)).toBe(false);
  });
  it('is true when a packet edge is inside the viewport, false when it is off to a side', () => {
    expect(packetsOnScreen({ edges: [edge(100, 100, 300, 100)] }, cam, 800, 600)).toBe(true);
    expect(packetsOnScreen({ edges: [edge(2000, 100, 2300, 100)] }, cam, 800, 600)).toBe(false);
    expect(packetsOnScreen({ edges: [edge(-900, 100, -300, 100)] }, cam, 800, 600)).toBe(false);
    expect(packetsOnScreen({ edges: [edge(100, 900, 300, 900)] }, cam, 800, 600)).toBe(false);
  });
  it('follows the camera: pan and zoom bring it in or out', () => {
    const scene = { edges: [edge(2000, 100, 2300, 100)] };
    expect(packetsOnScreen(scene, { x: -1900, y: 0, zoom: 1 }, 800, 600)).toBe(true);
    expect(packetsOnScreen(scene, { x: 0, y: 0, zoom: 0.25 }, 800, 600)).toBe(true); // zoomed out: at 500..575 px
    expect(packetsOnScreen({ edges: [edge(5000, 100, 5300, 100)] }, { x: 0, y: 0, zoom: 0.25 }, 800, 600)).toBe(false); // 1250 px: still off
  });
  it('counts a curve through its control point, and the glow around the edge', () => {
    // a straight run along the top whose curve bows down into view
    expect(packetsOnScreen({ edges: [edge(0, -200, 100, -200, true, { cx: 50, cy: 100 })] }, cam, 800, 600)).toBe(true);
    // 8 px past the viewport edge, but the dot's glow (13.5) reaches in
    expect(packetsOnScreen({ edges: [edge(808, 100, 900, 100)] }, cam, 800, 600)).toBe(true);
    expect(packetsOnScreen({ edges: [edge(830, 100, 900, 100)] }, cam, 800, 600)).toBe(false);
  });
  it('treats an unknown viewport as everything', () => {
    expect(packetsOnScreen({ edges: [edge(5000, 5000, 5100, 5100)] }, cam, 0, 0)).toBe(true);
  });
});

describe('createFrameScheduler', () => {
  let drawn = 0;
  let hidden = false;
  let reduce = false;
  let packets = false;
  let dirtyExternally = false;
  let sched     ;

  const make = () => createFrameScheduler({
    draw: () => { drawn++; },
    packetsVisible: () => packets,
    isHidden: () => hidden,
    reduceMotion: () => reduce,
    extraDirty: () => dirtyExternally,
    now: () => performance.now(),
    // a 60 Hz display: a frame every 16 ms, given the clock the frame ran at
    raf: (cb                     ) => setTimeout(() => cb(performance.now()), 16)                     ,
    caf: (id        ) => clearTimeout(id),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    drawn = 0; hidden = false; reduce = false; packets = false; dirtyExternally = false;
    sched = make();
  });
  afterEach(() => { sched.cancel(); vi.useRealTimers(); });

  it('an idle map schedules no frames at all', () => {
    expect(sched.pending).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(sched.frames).toBe(0);
    expect(drawn).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a change draws once, however many times it is asked for in the frame, and then goes quiet', () => {
    for (let i = 0; i < 50; i++) sched.markDirty();
    expect(drawn).toBe(0); // not synchronous
    expect(vi.getTimerCount()).toBe(1); // one frame waiting
    vi.advanceTimersByTime(16);
    expect(drawn).toBe(1);
    expect(sched.pending).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(drawn).toBe(1);
    expect(sched.frames).toBe(1);
  });

  it('queued input runs once at the start of the frame, before the draw', () => {
    const order           = [];
    const job = () => order.push('job');
    sched = createFrameScheduler({ ...{ draw: () => order.push('draw') }, packetsVisible: () => false, isHidden: () => false, reduceMotion: () => false, now: () => performance.now(), raf: (cb     ) => setTimeout(() => cb(performance.now()), 16), caf: clearTimeout });
    for (let i = 0; i < 20; i++) sched.queue(job);
    vi.advanceTimersByTime(16);
    expect(order).toEqual(['job', 'draw']);
  });

  it('a change nobody announced (the scene version moved) is drawn by the next frame someone asks for', () => {
    dirtyExternally = true;
    sched.wake();
    vi.advanceTimersByTime(16);
    expect(drawn).toBe(1);
  });

  it('packets on screen keep it drawing at about 30 frames a second, and it stops after 30 s without input', () => {
    packets = true;
    sched.markDirty();
    vi.advanceTimersByTime(1000);
    expect(drawn).toBeGreaterThanOrEqual(25);
    expect(drawn).toBeLessThanOrEqual(31);
    const at1s = drawn;
    vi.advanceTimersByTime(IDLE_MS); // well past 30 s
    expect(drawn).toBeGreaterThan(at1s);
    const stopped = drawn;
    expect(stopped).toBeLessThan(Math.ceil(IDLE_MS / PACKET_FRAME_MS) + 60); // about 30 a second for 30 s, not more
    vi.advanceTimersByTime(20_000);
    expect(drawn).toBe(stopped); // asleep: no further frames
    expect(vi.getTimerCount()).toBe(0);
  });

  it('input wakes the packets again, and keeps them going for another 30 s', () => {
    packets = true;
    sched.markDirty();
    vi.advanceTimersByTime(IDLE_MS + 1000);
    const asleep = drawn;
    vi.advanceTimersByTime(5000);
    expect(drawn).toBe(asleep);

    sched.noteInput();
    vi.advanceTimersByTime(1000);
    expect(drawn).toBeGreaterThan(asleep + 20);

    // input during the 30 s keeps pushing the deadline out
    const awake = drawn;
    for (let i = 0; i < 4; i++) { vi.advanceTimersByTime(20_000); sched.noteInput(); }
    expect(drawn).toBeGreaterThan(awake + 100);
    expect(sched.pending).toBe(true);
  });

  it('noteInput on a map that is not asleep costs nothing: no frame, no draw', () => {
    for (let i = 0; i < 100; i++) sched.noteInput();
    expect(sched.pending).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(drawn).toBe(0);
  });

  it('reduced motion: packets never animate', () => {
    packets = true;
    reduce = true;
    sched.markDirty();
    vi.advanceTimersByTime(5000);
    expect(drawn).toBe(1);
    expect(sched.pending).toBe(false);
  });

  it('a hidden tab draws nothing, and showing it again draws the change and restarts the packets', () => {
    packets = true;
    hidden = true;
    sched.markDirty();
    vi.advanceTimersByTime(5000);
    expect(drawn).toBe(0);
    expect(sched.pending).toBe(false);
    hidden = false;
    sched.shown();
    vi.advanceTimersByTime(1000);
    expect(drawn).toBeGreaterThan(20);
  });

  it('the tab shown after more than 30 s away does not come back frozen', () => {
    packets = true;
    sched.markDirty();
    vi.advanceTimersByTime(IDLE_MS + 5000);
    const frozen = drawn;
    hidden = true;
    vi.advanceTimersByTime(60_000);
    hidden = false;
    sched.shown();
    vi.advanceTimersByTime(1000);
    expect(drawn).toBeGreaterThan(frozen + 20);
  });

  it('drawNow paints synchronously, runs the queued input first, and clears the dirty mark', () => {
    const order           = [];
    sched = createFrameScheduler({ draw: () => order.push('draw'), packetsVisible: () => false, isHidden: () => false, reduceMotion: () => false, now: () => performance.now(), raf: (cb     ) => setTimeout(() => cb(performance.now()), 16), caf: clearTimeout });
    sched.queue(() => order.push('job'));
    sched.drawNow();
    expect(order).toEqual(['job', 'draw']);
    vi.advanceTimersByTime(16); // the frame that was waiting finds nothing left to do
    expect(order).toEqual(['job', 'draw']);
  });

  it('hold stops every frame, packets included, until it is let go, and drawNow still paints (the bench)', () => {
    packets = true;
    sched.shown();
    vi.advanceTimersByTime(100);
    const before = drawn;
    expect(before).toBeGreaterThan(0);
    sched.hold(true);
    expect(sched.pending).toBe(false);
    sched.markDirty();
    sched.wake();
    vi.advanceTimersByTime(1000);
    expect(drawn).toBe(before); // nothing drew, and no timer is waiting
    expect(vi.getTimerCount()).toBe(0);
    sched.drawNow();
    expect(drawn).toBe(before + 1);
    sched.hold(false); // letting go draws what is dirty and picks the packets up again
    vi.advanceTimersByTime(200);
    expect(drawn).toBeGreaterThan(before + 3);
  });
});
