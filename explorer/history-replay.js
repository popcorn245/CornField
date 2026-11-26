/**
 * @module explorer/history-replay
 *
 * Replay (spec 0014 D1): the map grows on a timeline, commit by commit, like cells in a dish. The layout is today's and never moves; at a commit
 * the map holds only the nodes born by then and the lines between them (`state.replay`, which scene.js reads). A node being born buds out of its
 * parent and settles into its place; the nodes a commit changed pulse once. Under reduced motion nothing buds or pulses: nodes simply appear,
 * and a changed node wears a still ring for its step.
 *
 * The timeline is a strip along the bottom of the map: one mark per commit (its height how many nodes it touched, its colour its kind), the
 * playhead, Play or Pause, a step back and forward, three speeds, Now (back to the map as it is), the commit at the playhead as a trail, and a
 * count. The playhead is a range input, so the keyboard has it whole (arrows, Home, End, Page keys); a step says what was born and what changed.
 *
 *   createReplay(inst, source)   -> { start(at?), stop(), open(), repaint(), destroy() }
 *
 * `source` is history.js's: `{ ready(), history(), load(), links, specs() }`.
 */

import { announce } from './engine/keyboard.js';
import { SPEEDS, commitKind, dayOf, parentsOf, replayCount, replayFrame, speedMs, stepWords, trailHtml } from './history-model.js';
import { escapeHtml as esc } from '../core/text.js';

/** How long a node takes to bud out of its parent (ms) */
export const BUD_MS = 520;
/** The tokens a mark is drawn in, by the commit's kind; a picked spec's commits get a dot in the last */
const MARK_TOKENS = { feat: '--corn-added', fix: '--corn-warn', docs: '--corn-accent', other: '--corn-text-3', spec: '--corn-history-week' };
const ease = (t) => 1 - (1 - t) ** 3;

/**
 * @param {ReturnType<typeof import('./instance.js').createInstance>} inst
 * @param {{ ready: () => boolean, history: () => object, load: () => Promise<void>, links: object | null, specs: () => Map<string, object> }} source
 */
export function createReplay(inst, source) {
  const { state } = inst;
  let strip = null;
  let pulses = null;
  let frame = null;
  let parents = new Map();
  let playing = false;
  let speed = 1;
  let acc = 0;
  let last = null;
  /** @type {Map<string, { x: number, y: number, start: number | null }>} the nodes budding, from where */
  const buds = new Map();
  let pulsedAt = -1;
  let offFrames = null;
  let offPaint = null;

  const open = () => !!state.replay;
  const byId = (id) => state.nodes.find((n) => n.id === id);
  const labelOf = (id) => { const n = byId(id); return n ? String(n.label || n.id) : id; };
  const stage = () => (state.canvas && state.canvas.parentElement) || null;
  const button = () => inst.el('replay-btn');

  function wire() {
    if (!inst.map) return;
    if (!offFrames) offFrames = inst.map.addFrameClient({ wants: () => open() && (playing || buds.size > 0), tick });
    if (!offPaint) offPaint = inst.map.onPaint((scene, camera) => placePulses(scene, camera));
  }

  /** Each frame: the playhead moves on while playing, and the buds grow */
  function tick(now) {
    if (!open()) return;
    const dt = last === null ? 16 : Math.min(now - last, 250);
    last = now;
    if (playing) {
      acc += dt;
      const each = speedMs(frame.total, speed);
      while (acc >= each && playing) {
        acc -= each;
        if (frame.at >= frame.total - 1) { setPlaying(false); announce(inst, `The end: ${replayCount(frame)}`); break; }
        go(frame.at + 1, { bud: true });
      }
    }
    if (buds.size) {
      const bud = new Map();
      for (const [id, b] of buds) {
        if (b.start === null) b.start = now;
        const t = (now - b.start) / BUD_MS;
        if (t >= 1) buds.delete(id); else bud.set(id, { x: b.x, y: b.y, t: ease(t) });
      }
      state.replay.bud = bud;
      inst.touchScene();
    }
  }

  /**
   * Moves the playhead to a commit. `bud`: a step forward, so what was born there buds (a jump or a scrub just shows it). `say`: a screen reader hears the step.
   */
  function go(at, { bud = false, say = false } = {}) {
    const h = source.history();
    frame = replayFrame(h, state.edges, at);
    if (!bud || inst.reducedMotion) buds.clear();
    else {
      for (const id of frame.born) {
        const p = byId(parents.get(id));
        if (p && !frame.hidden.has(p.id)) buds.set(id, { x: p.x, y: p.y, start: null });
      }
    }
    state.replay = { at: frame.at, hidden: frame.hidden, bud: new Map([...buds].map(([id, b]) => [id, { x: b.x, y: b.y, t: 0 }])) };
    state.historyAt = frame.at;
    paintStrip();
    inst.touchScene();
    inst.emit('history:at');
    if (inst.map) { inst.map.render(); inst.map.ensureFlowLoop(); }
    if (say) announce(inst, stepWords(frame, { labelOf }));
  }

  function setPlaying(on) {
    playing = !!on && !!frame && frame.at < frame.total - 1;
    acc = 0;
    last = null;
    paintControls();
    if (playing && inst.map) inst.map.ensureFlowLoop();
  }

  // ---------------------------------------------------------------------------
  //  The strip
  // ---------------------------------------------------------------------------
  function buildStrip() {
    const host = stage();
    if (!host) return;
    if (strip && strip.isConnected) return;
    strip = inst.doc.createElement('div');
    strip.className = 'hx-timeline glass';
    strip.setAttribute('role', 'group');
    strip.setAttribute('aria-label', 'Replay the map\'s history');
    strip.innerHTML = `<div class="hx-timeline-bar">
        <button type="button" data-corn-kind="icon" class="hx-timeline-btn" data-replay="back" aria-label="Step back a commit" title="Step back a commit">‹</button>
        <button type="button" data-corn-kind="icon" class="hx-timeline-btn hx-timeline-play" data-replay="play" aria-label="Play">▶</button>
        <button type="button" data-corn-kind="icon" class="hx-timeline-btn" data-replay="forward" aria-label="Step forward a commit" title="Step forward a commit">›</button>
        <button type="button" data-corn-kind="icon" class="hx-timeline-btn hx-timeline-speed" data-replay="speed" aria-label="Speed 1×" title="Speed">1×</button>
        <span class="hx-timeline-count hx-faint" aria-live="off"></span>
        <button type="button" class="hx-btn hx-btn--quiet hx-textact" data-corn-kind="quiet" data-replay="now" title="Back to the map as it is now">Now</button>
      </div>
      <div class="hx-timeline-track">
        <canvas class="hx-timeline-marks" aria-hidden="true"></canvas>
        <input type="range" data-corn="control" class="hx-timeline-range" min="0" max="0" step="1" value="0" aria-label="Commit">
      </div>
      <div class="hx-timeline-line"></div>`;
    strip.addEventListener('click', onClick);
    const range = strip.querySelector('.hx-timeline-range');
    range.addEventListener('input', () => { setPlaying(false); go(Number(range.value)); });
    range.addEventListener('change', () => { if (frame) announce(inst, stepWords(frame, { labelOf })); });
    host.append(strip);
  }

  function onClick(e) {
    const b = e.target.closest('[data-replay]');
    if (!b || !frame) return;
    const what = b.getAttribute('data-replay');
    if (what === 'play') setPlaying(!playing);
    else if (what === 'back') { setPlaying(false); go(frame.at - 1, { say: true }); }
    else if (what === 'forward') { setPlaying(false); go(frame.at + 1, { bud: true, say: true }); }
    else if (what === 'speed') { speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; acc = 0; paintControls(); announce(inst, `Speed ${speed}×`); }
    else if (what === 'now') stop();
  }

  function paintControls() {
    if (!strip) return;
    const play = strip.querySelector('[data-replay="play"]');
    play.textContent = playing ? '❚❚' : '▶';
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    const sp = strip.querySelector('[data-replay="speed"]');
    sp.textContent = `${speed}×`;
    sp.setAttribute('aria-label', `Speed ${speed}×`);
  }

  function paintStrip() {
    if (!strip || !frame) return;
    const c = frame.commit || {};
    const range = strip.querySelector('.hx-timeline-range');
    range.max = String(frame.total - 1);
    range.value = String(frame.at);
    range.setAttribute('aria-valuetext', `Commit ${frame.at + 1} of ${frame.total}, ${dayOf(c.date)}: ${c.subject || ''}`);
    strip.querySelector('.hx-timeline-count').textContent = replayCount(frame);
    strip.querySelector('[data-replay="back"]').disabled = frame.at <= 0;
    strip.querySelector('[data-replay="forward"]').disabled = frame.at >= frame.total - 1;
    strip.querySelector('.hx-timeline-line').innerHTML = `<span class="hx-faint">${esc(dayOf(c.date))}</span> <span class="hx-timeline-subject">${esc(c.subject || '')}</span> ${trailHtml(c, { links: source.links, specs: source.specs() })}`;
    paintControls();
    paintMarks();
  }

  /** The marks: one per commit, its height how many nodes it touched, its colour its kind; those after the playhead faint; a picked spec's commits dotted */
  function paintMarks() {
    const canvas = strip && strip.querySelector('.hx-timeline-marks');
    if (!canvas || !frame) return;
    const w = canvas.clientWidth || 0;
    const hgt = canvas.clientHeight || 0;
    let ctx = null;
    try { ctx = w && hgt ? canvas.getContext('2d') : null; } catch { ctx = null; }
    if (!ctx) return;
    const ratio = (inst.doc.defaultView && inst.doc.defaultView.devicePixelRatio) || 1;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(hgt * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const read = inst.tokenReader();
    const colour = (k) => (read && read(MARK_TOKENS[k]).trim()) || 'gray';
    const colours = Object.fromEntries(Object.keys(MARK_TOKENS).map((k) => [k, colour(k)]));
    const commits = source.history().commits;
    const n = commits.length;
    const most = Math.max(1, ...commits.map((x) => (x.nodes ? x.nodes.length : 0)));
    const pick = state.historyPick ? state.historyPick.spec : null;
    const step = n > 1 ? (w - 4) / (n - 1) : 0;
    const barW = Math.max(1, Math.min(4, step * 0.7));
    for (let i = 0; i < n; i++) {
      const x = 2 + i * step;
      const k = commits[i].nodes ? commits[i].nodes.length : 0;
      const h = Math.max(2, (hgt - 8) * Math.sqrt(k / most));
      ctx.globalAlpha = i <= frame.at ? 1 : 0.3;
      ctx.fillStyle = colours[commitKind(commits[i].subject)];
      ctx.fillRect(x - barW / 2, hgt - h, barW, h);
      if (pick && commits[i].specs && commits[i].specs.includes(pick)) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = colours.spec;
        ctx.beginPath();
        ctx.arc(x, 3, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------------------
  //  The pulses: a ring on each node the commit at the playhead changed, once
  // ---------------------------------------------------------------------------
  function placePulses(scene, camera) {
    if (!open() || !frame) { if (pulses) { pulses.remove(); pulses = null; } return; }
    const host = stage();
    if (!host) return;
    if (!pulses || !pulses.isConnected) {
      pulses = inst.doc.createElement('div');
      pulses.className = 'hx-replay-pulses';
      pulses.setAttribute('aria-hidden', 'true');
      host.append(pulses);
      pulsedAt = -1;
    }
    pulses.classList.toggle('is-static', !!inst.reducedMotion);
    if (pulsedAt !== frame.at) { pulses.innerHTML = ''; pulsedAt = frame.at; }
    const want = new Set(frame.changed);
    const have = new Map([...pulses.children].map((el) => [el.dataset.node, el]));
    for (const node of scene.nodes) {
      if (!want.has(node.id)) continue;
      let el = have.get(node.id);
      if (!el) {
        el = inst.doc.createElement('span');
        el.className = 'hx-replay-pulse';
        el.dataset.node = node.id;
        if (frame.born.includes(node.id)) el.dataset.born = '';
        pulses.append(el);
      }
      el.style.left = `${(node.x * camera.zoom + camera.x).toFixed(1)}px`;
      el.style.top = `${(node.y * camera.zoom + camera.y).toFixed(1)}px`;
      el.style.setProperty('--r', `${(Math.max(6, node.r * camera.zoom) + 4).toFixed(1)}px`);
    }
  }

  // ---------------------------------------------------------------------------
  //  Opening and closing
  // ---------------------------------------------------------------------------
  async function start(at = 0) {
    if (state.view !== 'orbit') return;
    if (!source.ready()) {
      announce(inst, 'Reading the history…');
      await source.load();
      if (!source.ready()) { announce(inst, 'The history could not be read, so there is nothing to replay.'); return; }
    }
    const h = source.history();
    if (!h.commits.length) { announce(inst, 'The history has no commit to replay.'); return; }
    parents = parentsOf(state.edges);
    wire();
    buildStrip();
    const btn = button();
    if (btn) btn.setAttribute('aria-pressed', 'true');
    go(at, { say: true });
    setPlaying(!inst.reducedMotion && at === 0);
    if (strip) strip.querySelector(playing ? '[data-replay="play"]' : '.hx-timeline-range').focus();
  }

  function stop() {
    if (!open()) return;
    const had = strip && strip.contains(inst.active());
    setPlaying(false);
    buds.clear();
    state.replay = null;
    state.historyAt = null;
    frame = null;
    if (strip) { strip.remove(); strip = null; }
    if (pulses) { pulses.remove(); pulses = null; }
    const btn = button();
    if (btn) { btn.setAttribute('aria-pressed', 'false'); if (had) btn.focus(); }
    inst.touchScene();
    inst.emit('history:at');
    if (inst.map) inst.map.render();
    announce(inst, 'Back to the map as it is now');
  }

  return {
    start,
    stop,
    open,
    /** The strip again: a pick changed (its commits' dots), or the theme */
    repaint: () => paintStrip(),
    destroy() {
      stop();
      if (offFrames) { offFrames(); offFrames = null; }
      if (offPaint) { offPaint(); offPaint = null; }
    },
  };
}
