/**
 * @module explorer/runs-map
 *
 * Agent runs on the map (issue #82, spec 0005 D9): the nodes an open run is changing **pulse**, and a node two or more open runs are
 * changing carries a **collision** mark. The marks are a layer of their own over the map (`#run-overlay`, a DOM layer, so one drawing serves the
 * Canvas 2D and the WebGL renderer, and the pulse is plain CSS that `prefers-reduced-motion` turns into a still ring):
 *
 *   - in flight   a ring that pulses (still under reduced motion: a thicker ring, no movement)
 *   - collision   a dashed ring, a warning sign and the words "Collision" with how many runs: shape and text, never colour alone
 *
 * The layer is a toggle in the Layers menu ("Runs in flight", on unless turned off). The layer is decoration for the eye (`aria-hidden`):
 * what a screen reader gets is the Runs view, which names each run's nodes and collisions in words, and the live region, which says when a
 * state or a collision changes. The positions come from the scene the map just drew, so they follow every view, zoom and pan.
 */

import { layerOn } from './layer-model.js';
import { overlayOf } from './runs-model.js';

/** The most marks drawn at once: past this the Runs view still lists them all */
export const MAX_MARKS = 80;

/** The key of the layer in the Layers menu and `state.activeLayers` */
export const RUNS_LAYER = 'runs';

/** The words on a collision mark */
export const collisionTag = (n) => `Collision · ${n} runs`;

/**
 * The runs' marks for one instance (spec 0011 D3): what the Work piece hands the map. Nothing here is shared with another instance.
 * @param {ReturnType<import('./instance.js').createInstance>} inst
 */
export function createRunsMap(inst) {
  const { state } = inst;
  /** @type {Map<string, HTMLElement>} the marks by `<kind>:<node id>`, kept so a pulse is not restarted by every pan */
  const marks = new Map();
  /** What the marks were last placed for: a paint with the same scene, camera, runs, layer and motion moves nothing (packet frames) */
  let placed = '';
  let placedFor = null;
  let placedScene = null;
  let placedLayer = null;
  let reduce = null;
  let wired = false;

  /** Whether motion is reduced: the viewer's setting, or a test's */
  const reducedMotion = () => (reduce === null ? inst.reducedMotion : reduce);
  /** Whether the layer is on: the viewer's layer, or the review's (layer-model.js) */
  const runsLayerOn = () => layerOn(state, RUNS_LAYER);

  function clearMarks() {
    for (const el of marks.values()) el.remove();
    marks.clear();
    placed = '';
  }

  /** Says whether any run is on the map: the Layers menu shows its legend while there is */
  function paintLegend() {
    inst.emit('runs:map', { active: !!(state.runsMap && (state.runsMap.flight.size || state.runsMap.collide.size)) });
  }

  /**
   * Puts the marks on the nodes the scene drew, at the camera. Marks are kept between frames (only their place changes), so a pan does not
   * restart the pulse.
   * @param {{ nodes: { id: string, x: number, y: number, r: number, alpha: number }[], version?: number }} scene
   * @param {{ x: number, y: number, zoom: number }} camera
   */
  function sync(scene, camera) {
    const layer = inst.el('run-overlay');
    if (!layer) return;
    const map = state.runsMap;
    if (!map || !runsLayerOn() || (!map.flight.size && !map.collide.size)) { if (marks.size) clearMarks(); layer.hidden = true; placed = ''; return; }
    // The map paints every frame while packets move; the marks only move with the scene or the camera
    const key = `${scene.version}|${camera.x}|${camera.y}|${camera.zoom}|${reducedMotion()}`;
    if (key === placed && placedFor === map && placedScene === scene && placedLayer === layer) return;
    placed = key;
    placedLayer = layer;
    placedFor = map;
    placedScene = scene;
    layer.hidden = false;
    layer.classList.toggle('is-static', reducedMotion());
    const seen = new Set();
    let n = 0;
    for (const node of scene.nodes) {
      if (n >= MAX_MARKS) break;
      const runs = map.collide.get(node.id) || map.flight.get(node.id);
      if (!runs || !(node.alpha > 0.2)) continue;
      const kind = map.collide.has(node.id) ? 'collision' : 'flight';
      const key = `${kind}:${node.id}`;
      n += 1;
      seen.add(key);
      let el = marks.get(key);
      if (!el) {
        el = inst.doc.createElement('span');
        el.className = `hx-run-mark hx-run-mark--${kind}`;
        el.dataset.node = node.id;
        el.dataset.kind = kind;
        el.dataset.corn = 'run-mark';
        el.setAttribute('part', 'run-mark');
        el.innerHTML = `<span class="hx-run-ring"></span>${kind === 'collision' ? `<span class="hx-run-tag"><span class="hx-run-sign">⚠</span> ${collisionTag(runs.length)}</span>` : ''}`;
        layer.append(el);
        marks.set(key, el);
      }
      const r = Math.max(10, (node.r + 9) * camera.zoom);
      el.style.left = `${(node.x * camera.zoom + camera.x).toFixed(1)}px`;
      el.style.top = `${(node.y * camera.zoom + camera.y).toFixed(1)}px`;
      el.style.setProperty('--r', `${r.toFixed(1)}px`);
    }
    for (const [key, el] of marks) if (!seen.has(key)) { el.remove(); marks.delete(key); }
  }

  /** Follows the map's paints: once, while the instance has a map (a bare root has none, and no marks) */
  function wire() {
    if (wired || !inst.map) return;
    wired = true;
    inst.own(inst.map.onPaint((scene, camera) => sync(scene, camera)));
  }

  return {
    /** Hands the map the runs the API listed: what pulses and what collides is worked out here, and the map is drawn again */
    set(runs) {
      state.runsMap = Array.isArray(runs) && runs.length ? { ...overlayOf(runs), runs } : null;
      wire();
      paintLegend();
      if (inst.map) inst.map.render();
    },
    /** Takes the marks off (the panel ends, or there is no forge) */
    clear() {
      state.runsMap = null;
      clearMarks();
      paintLegend();
    },
    sync,
    /** For tests: force reduced motion on or off (null: follow the viewer's setting) */
    setReducedMotion(on) { reduce = on; },
  };
}
