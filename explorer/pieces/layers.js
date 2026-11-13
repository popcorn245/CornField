/**
 * @module explorer/pieces/layers
 *
 * The Layers menu as a piece (spec 0011 D3): one toggle per kind of node (apps, pages, tables, services, ...) with its count, plus the legend
 * of what the lines mean. The data-flow preset ignores the toggles. What the layers are, which are on and what a review shows is the instance's
 * (engine/layers.js); this is the chip, the menu and its rows.
 *
 *   mount(root, inst, options) -> { update, destroy, ... }
 *
 * The piece makes its own markup (`markup()`) and puts it in `root`, or before the node `options.slots.menu`. It draws itself again on
 * `layers:redraw` (a layer, the nodes or a review changed: engine/layers.js), on `theme` (the host says light or dark changed), and when the
 * map's own style changes; it follows `view` (the chip dims while the data-flow view is on). Its buttons are its own: the chip, All, None, a
 * row, a row's kinds. A click anywhere in the root outside the menu closes it, and Escape inside the root closes it with the focus back on the
 * chip. `options.storageKey` is where the viewer's choices are kept in their browser (`cornfield:layers` by default, `null` for nowhere).
 * `destroy()` takes back every listener and removes the elements.
 *
 * @param {ParentNode} root where the menu goes when `options.slots` names no place
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst the instance; its map must be made (engine/render.js)
 * @param {{ slots?: { menu?: Node }, storageKey?: string | null }} [options]
 * @returns {{ update: (props?: { layers?: unknown }) => void, destroy: () => void, elements: Element[], renderToggles: () => void, renderEdgeKey: () => void, renderCloudLegend: () => void, toggleMenu: (open?: boolean) => void, closeMenu: () => void, toggleKinds: (key: string) => void }}
 *   `update({ layers })` takes the project's layers (the config's `layers`) and draws; `update()` draws again
 */

import { escapeHtml as escHtml } from '../../core/text.js';
import { WHEN_STYLES } from '../cloud-model.js';
import { edgeKeyHtml, keySwatch } from '../edge-key.js';
import { kindLetters } from '../../core/layers.js';
import { reviewHides, rowKeyOf, shownByProposal } from '../layer-model.js';
import { layerShows } from '../scene.js';
import { STROKE_TOKEN, kindToken, mapStyleOf } from '../engine/map-style.js';
import { over, parseColor, contrast, toHex } from '../../core/color.js';
import { DARK_GROUND, LIGHT_GROUND } from '../theme-model.js';
import { t } from '../engine/strings.js';
import { renderFlowLegend } from '../engine/flow-legend.js';
import { isOn, keepLayersIn, layerRows, redrawing, setProjectLayers, swatch, toggleAllLayers, toggleLayer } from '../engine/layers.js';
import { layerOn } from '../layer-model.js';
import { scopeOf, place, addParts } from '../engine/piece.js';
import { listenRoots, onPageClick } from '../engine/roots.js';

/** The markup of the piece: the chip and its menu (its one place is `menu`) */
export const markup = () => ({
  menu: `<div class="hx-menu-wrap hx-layers">
  <button type="button" id="legend-toggle-btn" class="hx-layers-chip" data-action="toggle-layers-menu" aria-expanded="false" aria-controls="legend-dropdown" data-corn="layers-button"><span data-corn-string="layers">Layers</span><span id="layers-count" class="hx-layers-count" data-corn="count"></span></button>
  <div id="legend-dropdown" class="hx-menu glass" hidden data-corn="layers-menu">
    <div class="hx-menu-title hx-menu-head" data-corn="menu-title">
      <span>Section Toggles</span>
      <span class="hx-menu-links">
        <button type="button" class="hx-textbtn hx-textbtn--accent" data-action="layers-all" data-corn="layers-all" data-corn-kind="quiet" data-corn-string="layersAll">All</button>
        <span class="hx-faint">•</span>
        <button type="button" class="hx-textbtn" data-action="layers-none" data-corn="layers-none" data-corn-kind="quiet" data-corn-string="layersNone">None</button>
      </span>
    </div>
    <div class="hx-menu-body">
    <p id="layers-preset-note" class="hx-note" data-corn="notice" hidden>The data-flow view shows its own tiers and ignores these toggles. Switch it off to use them.</p>
    <div id="layer-toggles-container" class="hx-toggles"></div>
    <div id="flow-legend" hidden></div>
    <div id="edge-key" class="hx-menu-section" data-corn="legend-key"></div>
    <div id="cloud-legend" class="hx-menu-section" data-corn="menu-section" hidden></div>
    <div id="runs-legend" class="hx-menu-section" data-corn="menu-section" hidden>
      <div class="hx-menu-title" data-corn="menu-title"><span>Agent runs</span></div>
      <div class="hx-legend-row"><span class="hx-run-swatch hx-run-swatch--flight" aria-hidden="true"></span><span>In flight: a pulsing ring (still under reduced motion)</span></div>
      <div class="hx-legend-row"><span class="hx-run-swatch hx-run-swatch--collision" aria-hidden="true"></span><span>Collision: dashed ring, ⚠ and the words, where two open runs change one node</span></div>
    </div>
    <div id="proposal-legend" class="hx-menu-section" data-corn="menu-section" hidden>
      <div class="hx-menu-title" data-corn="menu-title"><span>Proposal marks</span></div>
      <div class="hx-legend-row"><span class="hx-mark-dot hx-mark-dot--added" data-corn="mark-dot" data-corn-state="added"></span><span>Added: dashed ring</span></div>
      <div class="hx-legend-row"><span class="hx-mark-dot hx-mark-dot--changed" data-corn="mark-dot" data-corn-state="changed"></span><span>Changed: solid ring</span></div>
      <div class="hx-legend-row"><span class="hx-mark-dot hx-mark-dot--removed" data-corn="mark-dot" data-corn-state="removed"></span><span>Removed: faded ring, label struck through</span></div>
      <div class="hx-legend-row"><span class="hx-mark-dot hx-mark-dot--edit" data-corn="mark-dot" data-corn-state="edit"></span><span>Your edit: dotted ring, long-dashed line</span></div>
    </div>
    </div>
  </div>
</div>`,
});

/** "1 link", "3 in flight", else the number */
const UNIT = Object.assign(Object.create(null), { flow: (n) => `${n} ${n === 1 ? 'link' : 'links'}`, runs: (n) => `${n} in flight` });

/** Mounts the Layers menu; see the top of this file */
export function mount(root, inst, options = {}) {
  const { state } = inst;
  const scope = scopeOf(inst);
  const made = place(inst, root, markup().menu, options.slots, 'menu');
  /** An element of this piece by id */
  const own = (id) => {
    for (const el of made) {
      if (el.id === id) return el;
      const found = el.querySelector(`[id="${id}"]`);
      if (found) return found;
    }
    return null;
  };
  scope.keepParts(...made);
  const wrap = made[0];
  const menu = own('legend-dropdown');
  const btn = own('legend-toggle-btn');
  /** The rows whose kinds are open ("5 kinds"), by key: kept across redraws */
  const openKinds = new Set();
  const style = () => mapStyleOf(inst).get();
  if ('storageKey' in options) keepLayersIn(inst, options.storageKey);

  // -- the menu open or shut, and its chip saying which (aria-expanded) -----------------------------------------------------------
  function setMenu(open) {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open && options.inline) alignMenu();
  }
  /** In a box of its own (`<corn-layers>`) the menu hangs from the chip's start; where that runs past the window's end (a chip at the right of a host's
   * toolbar) and there is room the other way, it hangs from the chip's end instead (`hx-menu--end`) */
  function alignMenu() {
    menu.classList.remove('hx-menu--end');
    const room = inst.win ? inst.win.innerWidth : 0;
    const r = menu.getBoundingClientRect();
    if (room && r.width && r.right > room && wrap.getBoundingClientRect().right - r.width >= 0) menu.classList.add('hx-menu--end');
  }
  const toggleMenu = (open) => setMenu(open === undefined ? menu.hidden : !!open);
  const closeMenu = () => setMenu(false);

  // -- the dots ------------------------------------------------------------------------------------------------------------------
  /** The ground of the menu: its surface laid over the page, as `--corn-surface-1` and `--corn-ground` say, else the theme's own ground */
  function menuSurface() {
    const fallback = state.theme === 'light' ? LIGHT_GROUND : DARK_GROUND;
    const read = inst.tokenReader();
    if (!read) return fallback;
    const ground = parseColor(read('--corn-ground'));
    const surface = parseColor(read('--corn-surface-1'));
    if (!ground[3] || !surface[3]) return fallback;
    const [r, g, b] = over(surface, over(ground, [0, 0, 0, 1]));
    return `rgb(${r}, ${g}, ${b})`;
  }
  /** The outline a dot or swatch gets when its fill (as it shows over the menu) is under 3:1 on the menu: the map's own outline colour when the theme sets one, else the CSS default (`.is-ringed`). The fill is never changed */
  function ringOf(color, surface) {
    if (contrast(toHex(over(parseColor(color), parseColor(surface))), surface) >= 3) return null; // a translucent fill is seen over the menu, as the node is over the ground
    const stroke = style().values[STROKE_TOKEN];
    return { stroke: stroke ? swatch(stroke) : '' };
  }
  /** A swatch of `color` on this menu: the fill, a soft glow on a dark ground, and the outline when it is needed. `extra` is more attributes (a kind's is `aria-hidden`) */
  function dot(color, on, surface, extra = '') {
    const ring = ringOf(color, surface);
    const glow = on && state.theme !== 'light' ? (/^#[0-9a-f]{6}$/i.test(color) ? `0 0 8px ${color}90` : `0 0 8px color-mix(in srgb, ${color} 56%, transparent)`) : 'none';
    const css = `background-color: ${color}; box-shadow: ${glow}${ring && ring.stroke ? `; --hx-dot-ring: ${ring.stroke}` : ''}`;
    return `<span class="hx-dot${extra ? ' hx-kind-swatch' : ''}${ring ? ' is-ringed' : ''}" data-corn="swatch"${extra} data-style="${escHtml(css)}"></span>`;
  }

  // -- the kinds of a row ---------------------------------------------------------------------------------------------------------
  /** The finer kinds of each row: `{ key: [{ kind, letters, n }] }`, by name, from the nodes the row holds (an outside node's kind is its layer, not a finer one) */
  function kindsByRow(rowOf) {
    const letters = kindLetters(state.nodes);
    const rows = new Map();
    state.nodes.forEach((n) => {
      if (typeof n.kind !== 'string' || !n.kind || n.type === 'external') return;
      const key = rowOf(n);
      if (!key) return;
      if (!rows.has(key)) rows.set(key, new Map());
      const id = `${n.type}\u0000${n.kind}`;
      const entry = rows.get(key).get(id) || { type: n.type, kind: n.kind, letters: letters.get(n.type).get(n.kind), n: 0 };
      entry.n++;
      rows.get(key).set(id, entry);
    });
    return new Map([...rows].map(([k, m]) => [k, [...m.values()].sort((a, b) => a.kind.localeCompare(b.kind))]));
  }

  /** The swatch of a kind: the theme's `--corn-map-kind-<type>-<kind>`, as the map draws that kind, or nothing when the token is unset (the node then has its type's colour, which is the row's dot). Decoration: the letters and the name say which kind it is */
  function kindSwatch(k, surface, pad) {
    const fill = style().values[kindToken(k.type, k.kind)];
    if (!fill) return pad ? '<span class="hx-dot hx-kind-swatch is-blank" aria-hidden="true"></span>' : ''; // nothing to see, but the letters of the rows stay in line
    return dot(swatch(fill), true, surface, ' aria-hidden="true"');
  }

  /** What a viewer sees as "kinds" for a row: the disclosure button and, when open, the key rows. A key is a key, not a toggle (spec 0009 D5) */
  function kindsHtml(layer, kinds, surface) {
    if (!kinds || !kinds.length) return '';
    const open = openKinds.has(layer.key);
    const id = `layer-kinds-${layer.key}`;
    const words = `${kinds.length} ${kinds.length === 1 ? 'kind' : 'kinds'}`;
    const padded = kinds.some((k) => style().values[kindToken(k.type, k.kind)]);
    const list = open ? `<ul class="hx-kind-keys" id="${escHtml(id)}">${kinds.map((k) => `<li class="hx-kind-key" data-corn="kind-key">${kindSwatch(k, surface, padded)}<span class="hx-kind-letter" aria-hidden="true">${escHtml(k.letters)}</span><span class="hx-kind-name">${escHtml(k.kind)}</span><span class="hx-count" data-corn="count">${k.n}</span></li>`).join('')}</ul>` : '';
    return `<div class="hx-kinds"><button type="button" class="hx-textbtn hx-kinds-btn" data-action="toggle-layer-kinds" data-layer="${escHtml(layer.key)}" aria-expanded="${open}" aria-controls="${escHtml(id)}" data-corn="layer-kinds" data-corn-kind="quiet">${open ? '▾' : '▸'} ${escHtml(words)}</button>${list}</div>`;
  }

  // -- the rows ------------------------------------------------------------------------------------------------------------------
  /** The chip says how many layers are on: " · 13 of 20". An overlay (Runs in flight) is not a layer: it is not counted */
  function paintCount() {
    const el = own('layers-count');
    if (!el) return;
    const { layers } = layerRows(inst);
    const on = layers.filter((l) => isOn(inst, l.key)).length;
    el.textContent = ` · ${on} of ${layers.length}`;
  }

  function renderLayerToggles() {
    paintCount();
    const container = own('layer-toggles-container');
    if (!container) return;

    // Nodes by row. Data Flow has no nodes of its own: it counts its links, and says so; Runs in flight counts runs
    const rowOf = (n) => rowKeyOf(state, n);
    // Keyed by layer key: a project's key may be any word, "constructor" too, so these have no prototype to read through
    const counts = Object.create(null);
    const byProposal = Object.create(null);
    state.nodes.forEach((n) => {
      const key = rowOf(n);
      if (!key) return;
      counts[key] = (counts[key] || 0) + 1;
      if (!layerShows(state, n) && shownByProposal(state, n)) byProposal[key] = (byProposal[key] || 0) + 1;
    });
    counts.flow = state.edges.filter((e) => e.kind === 'flow').length;
    counts.runs = state.runsMap ? state.runsMap.flight.size : 0;
    const kinds = kindsByRow(rowOf);
    const { layers, overlays } = layerRows(inst);
    const surface = menuSurface();

    const row = (layer) => {
      const on = isOn(inst, layer.key);
      const shown = byProposal[layer.key] ? `<span class="hx-faint hx-layer-note" data-corn="layer-note">+${byProposal[layer.key]} shown by the proposal</span>` : '';
      // A row the review hid says so under its name (there is no room beside it): it can still be turned on, for the review
      const hid = !shown && counts[layer.key] && reviewHides(state, layer.key) ? `<span class="hx-faint hx-layer-note" data-corn="layer-note">${escHtml(t(inst, 'hiddenWhileReviewing'))}</span>` : '';
      const name = `<span class="hx-toggle-name">${escHtml(layer.label)}</span>`;
      return `
      <button type="button" class="hx-toggle-row${on ? '' : ' is-off'}" data-action="toggle-layer" data-layer="${escHtml(layer.key)}" aria-pressed="${on}" title="${escHtml(layer.desc)}" data-corn="row">
        <span class="hx-toggle-label">
          ${dot(swatch(layer.color), on, surface)}
          ${hid ? `<span class="hx-toggle-text">${name}${hid}</span>` : name}${layer.live ? '<span class="hx-live-tag" data-corn="live-tag">live</span>' : ''}
        </span>
        <span class="hx-toggle-meta">${shown}
          <span class="hx-count" data-corn="count">${layer.countText || (UNIT[layer.key] || String)(counts[layer.key] || 0)}</span>
          <span class="hx-tick">${on ? '✓' : '—'}</span>
        </span>
      </button>${kindsHtml(layer, kinds.get(layer.key), surface)}`;
    };

    // The focus stays where it was across the redraw: the same row or disclosure, found again by what it names
    const focused = inst.active();
    const active = focused && container.contains(focused) ? focused : null;
    const was = active ? { action: active.getAttribute('data-action'), layer: active.getAttribute('data-layer') } : null;
    container.innerHTML = layers.map(row).join('')
      + (overlays.length ? `<div class="hx-menu-title hx-overlays" data-corn="overlays"><span>${escHtml(t(inst, 'overlays'))}</span></div>${overlays.map(row).join('')}` : '');
    addParts(container);
    if (was) {
      const again = [...container.querySelectorAll('[data-action]')].find((el) => el.getAttribute('data-action') === was.action && el.getAttribute('data-layer') === was.layer);
      if (again && typeof again.focus === 'function') again.focus({ preventScroll: true });
    }
    renderFlowLegend(inst, own('flow-legend'));
    renderEdgeKey();
    renderCloudLegend();
    addParts(own('flow-legend'));
  }

  /** The Key (spec 0008 D7): each kind of line as the map draws it (edge-key.js) */
  function renderEdgeKey() {
    const el = own('edge-key');
    if (el) { el.innerHTML = edgeKeyHtml(); addParts(el); }
  }

  /** What a call into a cloud node looks like for its `when` (spec 0031 section 6), while the Cloud layer is on */
  function renderCloudLegend() {
    const el = own('cloud-legend');
    if (!el) return;
    if (!layerOn(state, 'cloud')) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `
    <div class="hx-menu-title" data-corn="menu-title"><span>Cloud: when an outage bites</span></div>
    ${Object.entries(WHEN_STYLES).map(([when, s]) => `<div class="hx-legend-row"><span class="hx-legend-swatch hx-legend-swatch--wide hx-swatch-when--${when}">${keySwatch({ end: 'triangle', ticks: s.ticks })}</span><span>${s.legend}</span></div>`).join('')}
    <div class="hx-legend-row"><span class="hx-legend-swatch"></span><span class="hx-faint"><span class="hx-cloud-browser">(browser)</span> the visitor's browser makes the call, not our server</span></div>`;
    addParts(el);
  }

  /** Opens or closes the kinds of one row ("5 kinds"); the focus stays on its button */
  function toggleKinds(key) {
    if (openKinds.has(key)) openKinds.delete(key); else openKinds.add(key);
    renderLayerToggles();
  }

  /** The chip dims and the note shows while the data-flow view is on (it has its own tiers and ignores the toggles) */
  function syncView() {
    const preset = state.view === 'dataflow';
    btn.classList.toggle('hx-layers-chip--dim', preset);
    own('layers-preset-note').hidden = !preset;
    own('edge-key').hidden = state.view === 'work'; // the map's kinds of line: the Work view has its own words on its lines
  }

  // -- the piece's own buttons, and the clicks and keys around the menu ------------------------------------------------------------
  const ACTIONS = {
    'toggle-layers-menu': () => toggleMenu(),
    'layers-all': () => toggleAllLayers(inst, true, { viewer: true }),
    'layers-none': () => toggleAllLayers(inst, false, { viewer: true }),
    'toggle-layer': (el) => toggleLayer(inst, el.dataset.layer, { viewer: true }),
    'toggle-layer-kinds': (el) => toggleKinds(el.dataset.layer),
  };
  scope.listen(wrap, 'click', (e) => {
    const target = e.target.closest && e.target.closest('[data-action]');
    if (!target) return;
    const action = ACTIONS[target.dataset.action];
    if (action) action(target);
  });
  // Any click outside the menu closes it; a click on one of its rows does not. Whether it was inside is known before the action (a row's action draws the
  // rows again, the clicked node is then out of the page, and asking afterwards would take a click on a row for one outside): the menu's own element hears
  // the click on its way in, and the page decides once the click has passed. The page's own path is not enough: in a host's closed shadow root the
  // document's `composedPath()` stops at that root's host, so a click on a row would look like one outside
  const inside = new WeakSet();
  scope.listen(wrap, 'click', (e) => { inside.add(e); }, true);
  scope.own(onPageClick(inst, (e) => {
    if (menu.hidden || inside.has(e)) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
    if (!path.includes(wrap)) closeMenu();
  }, { capture: false }));
  // Escape with the menu open closes it, and its chip has the focus again (a key in any root of the instance: the map's too)
  scope.own(listenRoots(inst, 'keydown', (e) => {
    if (e.key !== 'Escape' || menu.hidden) return;
    closeMenu();
    btn.focus();
  }));

  // -- following the instance ------------------------------------------------------------------------------------------------------
  scope.on('layers:present', () => true); // the map's keys know there is a menu to turn a layer on in
  scope.on('popup:open', () => (!menu.hidden ? true : undefined)); // the scenario player's Escape leaves a menu that has its own
  scope.on('layers:redraw', renderLayerToggles);
  scope.on('theme', renderLayerToggles); // the dots and the legends are drawn in the theme's colours
  scope.on('view', syncView);
  scope.on('runs:map', ({ active }) => { const legend = own('runs-legend'); if (legend) legend.hidden = !active; }); // runs are on the map (the Work panel): the legend says what each mark is
  // The marks legend is there while a proposal is open (the proposal's bar says so: engine/proposal.js)
  const showLegend = (open) => { const legend = own('proposal-legend'); if (legend) legend.hidden = !open; };
  scope.on('proposal:draw', ({ open }) => showLegend(open));
  // ... and when the map's own tokens change (a named theme, its stylesheet arriving, light and dark): the same signal the map is drawn again on
  scope.own(mapStyleOf(inst).onChange(() => { if (!redrawing(inst)) renderLayerToggles(); }));
  scope.own(() => made.forEach((el) => el.remove()));

  syncView();
  renderLayerToggles();
  showLegend(!!inst.state.proposal);

  return {
    elements: made,
    renderToggles: renderLayerToggles,
    renderEdgeKey,
    renderCloudLegend,
    toggleMenu,
    closeMenu,
    toggleKinds,
    update(props) {
      if (props && 'layers' in props) setProjectLayers(inst, props.layers);
      else renderLayerToggles();
    },
    destroy: () => scope.destroy(),
  };
}
