/**
 * @module explorer/frame
 *
 * When to draw (spec 0012 A4, TOPO-06). No DOM and no `window`: the clock and
 * `requestAnimationFrame` are handed in, so every rule here is tested without a browser.
 *
 * The map draws on demand. Something asks for a frame (the camera moved, the scene changed, the
 * canvas was resized: `markDirty`), one `requestAnimationFrame` callback runs, and it draws once.
 * It asks for the next frame only while something animates: flow packets that are on screen, the
 * tab is shown, motion is allowed, and the visitor did something in the last 30 seconds. An
 * untouched map with no packets therefore draws nothing, and an idle one with packets stops.
 *
 * Input that moves the camera or a node is queued (`queue`) and applied at the start of the frame,
 * so a burst of pointer events costs one camera update and one draw, not one each.
 */

/** Packets stop this long after the last pointer, wheel, touch or key event */
export const IDLE_MS = 30_000;
/** Packet-only frames are capped at about 30 per second (a frame asked for by a change is not) */
export const PACKET_FRAME_MS = 33;

/**
 * What one frame does.
 * @param {{ dirty: boolean, packetsVisible: boolean, hidden: boolean, reduceMotion: boolean, idleMs: number, clientsWant?: boolean }} s
 *   `clientsWant`: a frame client (render.js addFrameClient: the scenario player) asked for more frames; they come whatever the motion or idle rules say
 * @returns {{ draw: boolean, again: boolean }} `draw`: paint now. `again`: ask for another frame.
 */
export function frameDecision({ dirty, packetsVisible, hidden, reduceMotion, idleMs, clientsWant = false }) {
  if (hidden) return { draw: false, again: false }; // nothing is seen; the change is drawn when the tab shows
  const animating = (packetsVisible && !reduceMotion && idleMs < IDLE_MS) || clientsWant;
  return { draw: dirty || animating, again: animating };
}

/**
 * Whether any packet of the scene is inside the viewport (the packet edges' bounding boxes, with
 * room for the dot and its glow). An unknown viewport (0 by 0) counts as everything.
 * @param {{ edges: object[] }} scene
 * @param {{ x: number, y: number, zoom: number }} camera
 * @param {number} width css px
 * @param {number} height
 */
export function packetsOnScreen(scene, camera, width, height) {
  const packetEdges = packetEdgesOf(scene);
  if (packetEdges.length === 0) return false;
  if (!(width > 0) || !(height > 0)) return true;
  const left = -camera.x / camera.zoom;
  const top = -camera.y / camera.zoom;
  const right = (width - camera.x) / camera.zoom;
  const bottom = (height - camera.y) / camera.zoom;
  for (const e of packetEdges) {
    const cx = e.curve ? e.curve.cx : e.x1;
    const cy = e.curve ? e.curve.cy : e.y1;
    const m = e.packet.radius + e.packet.glow;
    if (Math.max(e.x1, e.x2, cx) + m < left || Math.min(e.x1, e.x2, cx) - m > right) continue;
    if (Math.max(e.y1, e.y2, cy) + m < top || Math.min(e.y1, e.y2, cy) - m > bottom) continue;
    return true;
  }
  return false;
}

const packetEdgeLists = new WeakMap();
/** The scene's edges that carry a packet, found once per scene object */
function packetEdgesOf(scene) {
  let list = packetEdgeLists.get(scene);
  if (!list) {
    list = scene.edges.filter((e) => e.packet);
    packetEdgeLists.set(scene, list);
  }
  return list;
}

/**
 * The frame scheduler.
 * @param {object} deps
 * @param {() => void} deps.draw        paint the current picture
 * @param {() => boolean} deps.packetsVisible  whether any packet is on screen
 * @param {() => boolean} deps.isHidden the tab is hidden
 * @param {() => boolean} deps.reduceMotion
 * @param {() => boolean} [deps.extraDirty]  something changed that nobody called `markDirty` for (the scene version)
 * @param {(t: number) => boolean} [deps.tickClients]  runs the frame clients for this frame and says whether any wants another
 * @param {() => boolean} [deps.clientsWant]  whether any frame client wants frames, without running them (for `shown`)
 * @param {() => number} deps.now       milliseconds, monotonic
 * @param {(cb: (t: number) => void) => number} deps.raf
 * @param {(id: number) => void} deps.caf
 */
export function createFrameScheduler(deps) {
  const { draw, packetsVisible, isHidden, reduceMotion, extraDirty, tickClients, clientsWant: peekClients, now, raf, caf } = deps;
  let dirty = true;
  let rafId = null;
  let lastDrawAt = -Infinity;
  let lastInputAt = now();
  let held = false;
  const work = new Set();

  const runWork = () => {
    if (work.size === 0) return;
    const jobs = [...work];
    work.clear();
    jobs.forEach((job) => job());
  };

  const schedule = () => {
    if (!held && rafId === null) rafId = raf(frame);
  };

  function frame(t) {
    rafId = null;
    runWork();
    // The clients run first (not while the tab is hidden, like the packets), so a change they make is drawn in this frame
    const clientsWant = tickClients && !isHidden() ? tickClients(t) : false;
    const isDirty = dirty || (extraDirty ? extraDirty() : false);
    const { draw: wantsDraw, again } = decide(isDirty, clientsWant);
    // A frame asked for by a change always draws; a packet-only frame waits for its 30 fps slot
    if (wantsDraw && (isDirty || t - lastDrawAt >= PACKET_FRAME_MS - 2)) {
      dirty = false;
      lastDrawAt = t;
      scheduler.draws++;
      draw();
    }
    scheduler.frames++;
    if (again) schedule();
  }

  /** The rules of frame.js on the state now: `clientsWant` from the caller, which either ran the clients or only asked them */
  const decide = (isDirty, clientsWant) => frameDecision({
    dirty: isDirty,
    packetsVisible: packetsVisible(),
    hidden: isHidden(),
    reduceMotion: reduceMotion(),
    idleMs: now() - lastInputAt,
    clientsWant,
  });

  const scheduler = {
    /** Frames that ran, and how many of them drew (for the bench and the tests) */
    frames: 0,
    draws: 0,

    /** Something changed: draw it in the next frame */
    markDirty() {
      dirty = true;
      schedule();
    },

    /**
     * Run `job` at the start of the next frame (once, however often it is queued). A job that
     * changes the picture draws after it; `{ draw: false }` is for one that does not (hover).
     */
    queue(job, { draw: wantsDraw = true } = {}) {
      work.add(job);
      if (wantsDraw) scheduler.markDirty();
      else schedule();
    },

    /** Make sure a frame is coming; it decides whether to draw and whether to go on (ensureFlowLoop) */
    wake() {
      schedule();
    },

    /** The visitor did something. After a long quiet spell this starts the packets again. */
    noteInput() {
      const t = now();
      const wasIdle = t - lastInputAt >= IDLE_MS;
      lastInputAt = t;
      if (wasIdle) schedule();
    },

    /**
     * The tab was shown again: that is input too. A change skipped while it was hidden is still dirty, so a
     * frame is asked for when there is something to draw or to animate, and not otherwise.
     */
    shown() {
      lastInputAt = now();
      const isDirty = dirty || (extraDirty ? extraDirty() : false);
      const { draw: wantsDraw, again } = decide(isDirty, peekClients ? peekClients() : false);
      if (wantsDraw || again) schedule();
    },

    /** Draw right now, for a caller that needs the pixels (a test, a screenshot) */
    drawNow() {
      runWork();
      dirty = false;
      lastDrawAt = now();
      scheduler.draws++;
      draw();
    },

    /**
     * Stop asking for frames (`on`) or start again. While held nothing but `drawNow` draws, so the
     * bench's own scripted draws are the only ones; letting go draws whatever is dirty.
     */
    hold(on) {
      held = !!on;
      if (held) scheduler.cancel();
      else scheduler.markDirty();
    },

    /** Whether a frame is waiting */
    get pending() {
      return rafId !== null;
    },

    cancel() {
      if (rafId !== null) caf(rafId);
      rafId = null;
    },
  };
  return scheduler;
}
