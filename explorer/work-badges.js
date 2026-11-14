/**
 * @module explorer/work-badges
 *
 * The Work layer's badges on the Map view (spec 0012 D4), drawn: one small pill over each node open work touches (`PR #27`, `Issue #14 +1`), in screen space, so it reads at any zoom, in the
 * colour of its most pressing item's kind (`--corn-work-<kind>`). A DOM layer over the map like the runs' marks (runs-map.js, which is left as it is), decoration for the eye (`aria-hidden`): what a
 * screen reader gets is the words the keyboard says on landing on a badged node ("2 open: PR #27, Issue #14") and the node panel's "Open work" section. Which badges fit, and where, is
 * work-badge-model.js's (`placeBadges`: the names' own placing); this only holds the elements and moves them with the camera.
 *
 *   createWorkBadges({ stage, doc, state, style, colorOf, fontOf }) -> { sync(scene, camera), clear(), destroy() }
 *
 * `sync` is the map's paint hook: it is cheap when nothing moved (a packet frame), and does nothing while the layer is off (no element is made until the first badge).
 */

import { BADGE_PX, MAX_BADGES, placeBadges } from './work-badge-model.js';
import { labelMinOf } from './labels.js';
import { styledScene } from './engine/map-style.js';
import { FONT_NODE } from './scene.js';

/**
 * @param {{ stage: HTMLElement, state: object, style: () => object, colorOf: (kind: string) => string, wanted: () => Map<string, object[]> | null, doc?: Document }} deps
 *   `wanted`: the index to draw (`badgeIndex`), or null while the layer is off, the view is not the map, the answer is not here
 */
export function createWorkBadges({ stage, state, style, colorOf, wanted, doc = document }) {
  let layer = null;
  /** @type {Map<string, HTMLElement>} the pills by node id */
  const pills = new Map();
  let placed = null; // the placing for the scene, zoom, index and style it was made for: a pan only moves the pills
  let placedKey = '';
  let drawnKey = '';
  const widths = new Map();
  let ctx = null;

  /** The width of a text in a font (a canvas measures it once per string): a name's, in the label layer's font, and the pill's text in the page's own, so the placing leaves the room each takes */
  function measurer(family, weight) {
    if (ctx === null) { try { ctx = doc.createElement('canvas').getContext('2d') || false; } catch { ctx = false; } }
    if (!ctx) return null;
    return (text, size, bold) => {
      const key = `${bold ? 'b' : 'n'}${size}|${family}|${text}`;
      let w = widths.get(key);
      if (w === undefined) {
        if (widths.size > 4000) widths.clear();
        ctx.font = `${bold ? `${weight} ` : ''}${size}px ${family}`;
        w = ctx.measureText(text).width;
        widths.set(key, w);
      }
      return w;
    };
  }

  const ensureLayer = () => {
    if (layer && layer.isConnected) return layer;
    layer = doc.createElement('div');
    layer.className = 'hx-work-badges';
    layer.dataset.corn = 'work-badges';
    layer.setAttribute('part', 'work-badges');
    layer.setAttribute('aria-hidden', 'true');
    stage.append(layer);
    pills.clear();
    return layer;
  };

  function clear() {
    for (const el of pills.values()) el.remove();
    pills.clear();
    if (layer) layer.hidden = true;
    placed = null;
    placedKey = '';
    drawnKey = '';
  }

  /**
   * Puts the badges on the nodes the scene drew, at the camera.
   * @param {import('./scene.js').Scene} scene
   * @param {{ x: number, y: number, zoom: number }} camera
   */
  function sync(scene, camera) {
    const index = wanted();
    if (!index || !index.size) { if (layer && !layer.hidden) clear(); return; }
    const look = style();
    const key = `${scene.version}|${camera.zoom}|${look.plain ? 0 : look.version}|${state.theme}|${state.width}x${state.height}`;
    const sameScene = placed && placed.scene === scene && placed.index === index && placedKey === key;
    if (!sameScene) {
      const styled = styledScene(scene, look);
      const family = (typeof getComputedStyle === 'function' && stage.isConnected ? getComputedStyle(stage).fontFamily : '') || 'sans-serif'; // the pill is set in the page's font
      placed = { scene, index, list: placeBadges(styled, camera.zoom, index, { measure: measurer(styled.labelFont || FONT_NODE, 'bold'), measurePill: measurer(family, '600'), max: MAX_BADGES }) };
      placedKey = key;
      drawnKey = '';
    }
    const at = `${camera.x}|${camera.y}`;
    if (drawnKey === `${placedKey}|${at}`) return;
    drawnKey = `${placedKey}|${at}`;
    const host = ensureLayer();
    host.hidden = false;
    const seen = new Set();
    for (const p of placed.list) {
      const left = camera.x + (p.l + p.r) / 2;
      const top = camera.y + p.t;
      if (camera.x + p.r < 0 || camera.x + p.l > state.width || camera.y + p.b < 0 || camera.y + p.t > state.height) continue; // off the screen: no pill (one partly in is cut by the layer's edge, as a name is)
      seen.add(p.id);
      let el = pills.get(p.id);
      const first = p.items[0];
      const text = p.text;
      if (!el) {
        el = doc.createElement('span');
        el.className = 'hx-work-badge';
        el.dataset.corn = 'work-badge';
        el.setAttribute('part', 'work-badge');
        el.dataset.node = p.id;
        host.append(el);
        pills.set(p.id, el);
      }
      if (el.textContent !== text) el.textContent = text; // the forge's words go in as text, never as markup
      if (el.dataset.workKind !== first.kind) el.dataset.workKind = first.kind;
      el.classList.toggle('is-waiting', first.waiting === true);
      el.style.setProperty('--hx-badge', colorOf(first.kind));
      el.style.fontSize = `${Math.max(BADGE_PX, labelMinOf(scene))}px`;
      el.style.left = `${left.toFixed(1)}px`;
      el.style.top = `${top.toFixed(1)}px`;
    }
    for (const [id, el] of pills) if (!seen.has(id)) { el.remove(); pills.delete(id); }
  }

  return { sync, clear, destroy() { clear(); if (layer) layer.remove(); layer = null; } };
}
