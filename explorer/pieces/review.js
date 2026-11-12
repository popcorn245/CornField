/**
 * @module explorer/pieces/review
 *
 * The review as one piece (spec 0011 D3, D4, D8): the engine half of the coming `<corn-review>`. It lays out, in ONE root and on ONE instance, what a
 * review needs, and mounts the pieces of the explorer into it through their own `mount(root, inst, { slots })`: the map (pieces/map.js), the proposal's
 * bar (pieces/proposal.js, without the what-if editor's buttons: the editor is not converted), the change list with the scenario player
 * (pieces/changes.js), the decision's foot (pieces/decision.js, in the column's foot) and the node panel (pieces/node-panel.js). It is not cornfield's
 * page: no header, Work panel, search, Layers chip, account menu or hint, and cornfield's page does not use it (it keeps its own layout).
 *
 *   const review = mount(root, inst, options)    -> { update, destroy, ... }
 *
 *   root      the host's element (or shadow root): the piece makes ONE box in it (`[data-corn="review"]`), and everything it makes is inside that box
 *   inst      the instance; null makes one over the box, which `destroy()` then ends too. One instance for every piece inside: the lookups by id that
 *             still cross pieces (the dock, the bar, the review column, the node panel, the player's place) find their elements because there is one root
 *
 * Options, all optional; `update(next)` takes the same keys and applies what is present:
 *   topology   {nodes, edges}: the map. The piece does not load it: it takes what it is given (engine/topology.js `setTopology`, which the map piece calls too)
 *   proposal   a slug (fetched through `inst.fetch`, so a `base` applies; `source` names the copy), or the proposal object (nothing is fetched: `slug`,
 *              `source` and `sha256` may name it, which a decision needs; with no `base` and no `fetch` they are ignored, so nothing is sent anywhere), or null: closes it. Held until a topology is there
 *   source     where the server found the proposal ('checkout', 'pull/24', a worktree)
 *   view       'before' | 'diff' | 'after': the proposal's view; or 'map' | 'dataflow': the map's. The two sets of words do not meet
 *   node       the selected node's id (null clears it)
 *   config     { theme, layers }: the repo's client config as /cornfield/config.json carries it, which this piece takes and does not fetch: `theme` starts the
 *              theme's map icons (they are fetched without the session, with CORS), `layers` are the project's layers
 *   strings    the host's own words (core/strings.js keys): the instance speaks in them
 *   theme      'light' | 'dark' | 'auto' (the map's ground), checker (a plugin's checker for the scenarios), now (the decision's clock)
 *   base, fetch, tokens, renderer, onSelect, onReady   as pieces/map.js; `renderer` is read at mount only (a canvas that is replaced loses the edge picking)
 *
 * What a host hears is on the instance already (instance.js): `selection`, `proposal`, `decision`, `auth`, `scenario:player`. This piece adds nothing.
 *
 * Where it lives. The box declares itself the query container its stylesheets ask (`container: corn-box corn-page / size`, css/review.css) and is the
 * containing block of its own `position: fixed` descendants (`contain: layout`), so it needs a host that gives it a height (it fills 100% of it and is never
 * under 24rem). Under 768px by the box's own width, not the window's, it is the page's phone layout with its sheets (engine/sheets.js `setPhoneBox`).
 * The stylesheets to load, in order, after the default tokens and before a theme: `STYLESHEETS` below (explorer/css/).
 *
 * Nothing leaves the box: no listener on `document` or `window`, nothing appended outside it, no id looked up outside it, keys act only with the focus
 * inside, no `location`, no `history`; the wheel is the page's until the map has the focus or Ctrl or Cmd is held (input.js).
 *
 * Not in it: the what-if editor, the mockups, the Work panel, search, the Layers menu, the Proposals menu (its markup is kept in a spare, hidden place: the
 * proposal piece makes it), signing in (the decision says `auth`).
 *
 * @param {Element|ShadowRoot} root
 * @param {ReturnType<typeof import('../instance.js').createInstance>|null} inst
 * @param {object} [options]
 */

import { createInstance } from '../instance.js';
import { mount as mountMap } from './map.js';
import { mount as mountNodePanel } from './node-panel.js';
import { mount as mountProposal } from './proposal.js';
import { mount as mountChanges } from './changes.js';
import { mount as mountDecision } from './decision.js';
import { setTopology, layoutMap, setMap } from '../engine/topology.js';
import { closeProposal, rebuildProposalMap } from '../engine/proposal.js';
import { measureCovered, setPhoneBox } from '../engine/sheets.js';
import { setProjectLayers } from '../engine/layers.js';
import { applyStrings, setStrings } from '../engine/strings.js';
import { withParts } from '../engine/piece.js';
import { PROPOSAL_VIEWS } from '../proposal-model.js';

/**
 * The files of explorer/css/ the review needs, in the order to load them (the cascade's): after the default tokens (explorer/tokens.css, or the
 * generated sheet `tokens` hands the map) and before a theme. Never page.css, which is cornfield's own page. The shell reads this list.
 */
export const STYLESHEETS = ['base.css', 'map.css', 'node-panel.css', 'proposal.css', 'changes.css', 'decision.css', 'sheets.css', 'review.css'];

/** The keys of the map in the review: the page's, without Freeform (the review has none) */
export const KEYS_HELP = "Arrow keys pan, plus and minus zoom, 0 fits the map. N and P select the next and the previous node, Home and End the first and the last. F frames the selected node and what it lights. Enter goes to the selected node's panel, Escape closes it.";

const MAP_VIEWS = ['map', 'orbit', 'dataflow'];

/**
 * The layout: a stage (the map, and over it the dock, which holds the bar, the review column and the node panel, and the tap-away behind the panel on a
 * phone), as cornfield's page has, with each piece's place marked by a comment where its elements go before. The Proposals menu has a spare place of its own.
 */
const LAYOUT = '<div class="hx-stage" data-corn="stage">'
  + '<!--corn-piece:map/stage-->'
  + '<div id="sheet-dock" class="hx-dock" data-corn="dock">'
  + '<!--corn-piece:proposal/bar-->'
  + '<!--corn-piece:changes/column-->'
  + '<!--corn-piece:node-panel/drawer-->'
  + '</div>'
  + '<!--corn-piece:node-panel/backdrop-->'
  + '</div>'
  + '<div class="hx-review-spare" hidden><!--corn-piece:proposal/menu--></div>';

/** The marker comments under `el`, by `name/slot` */
function markersIn(doc, el) {
  const found = {};
  const walker = doc.createTreeWalker(el, 128 /* NodeFilter.SHOW_COMMENT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.data.startsWith('corn-piece:')) found[node.data.slice('corn-piece:'.length)] = node;
  }
  return found;
}

export function mount(root, inst, options = {}) {
  const doc = root.ownerDocument || root;
  // -- the box: ONE root for everything the review makes ---------------------------------------------------------------------------------
  const box = doc.createElement('div');
  box.setAttribute('data-corn', 'review');
  box.setAttribute('part', 'review');
  box.innerHTML = withParts(LAYOUT);
  root.append(box);

  const ownsInstance = !inst;
  if (ownsInstance) inst = createInstance({ root: box, base: options.base || '', fetch: options.fetch, strings: options.strings });
  else if (options.strings !== undefined) setStrings(inst, options.strings);
  const { state } = inst;
  setPhoneBox(inst, box); // a phone is a narrow box, whatever the window is (engine/sheets.js)
  applyStrings(inst, box);
  let ended = false;

  // -- the pieces, in the order the page mounts them: the map first, the node panel, the bar, the column, the decision in the column's foot -----
  const at = markersIn(doc, box);
  const mapPiece = mountMap(box, inst, {
    slots: { stage: at['map/stage'] },
    measureCovered: () => measureCovered(inst),
    keysHelp: KEYS_HELP,
    renderer: options.renderer,
    theme: options.theme,
    tokens: options.tokens,
    onSelect: options.onSelect,
    onReady: options.onReady,
  });
  const nodePanel = mountNodePanel(box, inst, { slots: { drawer: at['node-panel/drawer'], backdrop: at['node-panel/backdrop'] } });
  const proposalPiece = mountProposal(box, inst, { slots: { bar: at['proposal/bar'], menu: at['proposal/menu'] }, edit: false });
  const changesPiece = mountChanges(box, inst, { slots: { column: at['changes/column'] }, checker: options.checker });
  const foot = markersIn(doc, box)['decision/foot']; // the column keeps a place for it
  const decisionPiece = mountDecision(box, inst, { slots: { foot }, now: options.now });

  // The review lays the map out from what the engine hands over (a proposal's nodes and edges are the base with marks): nodes that were there keep their place
  const stopAsking = inst.on('map:set', ({ nodes, edges }) => { setMap(inst, nodes, edges); return true; });

  // -- what the host asked for ---------------------------------------------------------------------------------------------------------------
  /** What has been handed in, so an `update` that repeats a value changes nothing */
  const serverless = !options.base && !options.fetch;
  const current = { topology: undefined, proposal: null, source: null, slug: null, sha256: null, proposalView: null, shown: null, hasTopology: false, held: false };

  const redraw = () => { proposalPiece.update(); changesPiece.update(); decisionPiece.update(); nodePanel.update(); };

  /** The proposal asked for, opened (or closed) once there is a map to open it on */
  function applyProposal() {
    if (ended) return undefined;
    const wanted = current.proposal;
    if (wanted === null || wanted === undefined || wanted === '') {
      current.held = false;
      current.shown = null;
      if (state.proposal) closeProposal(inst);
      return undefined;
    }
    if (!current.hasTopology) { current.held = true; return undefined; } // a proposal is laid over a map: it opens when there is one
    current.held = false;
    const view = current.proposalView;
    if (typeof wanted === 'string') {
      const key = `${wanted}\u0000${current.source || ''}`;
      if (current.shown === key && state.proposal) return undefined; // already open (the piece answers true too)
      current.shown = key;
      return proposalPiece.update({ proposal: wanted, source: current.source, view });
    }
    if (current.shown === wanted && state.proposal) return undefined;
    current.shown = wanted;
    // With no server to ask (no `base`, no `fetch`) the object is all there is: its name and source would only send the pieces to the host's own origin for a PR's checks and reviews
    const named = serverless ? {} : { source: current.source, slug: current.slug, sha256: current.sha256 };
    proposalPiece.update({ proposal: wanted, ...named, view });
    return undefined;
  }

  /** The topology changed: the base map is the host's new one, laid out and fitted; an open proposal is laid over it again */
  function applyTopology(topology) {
    current.hasTopology = setTopology(inst, topology);
    if (!current.hasTopology) { inst.map.render(); return; }
    layoutMap(inst);
    if (state.proposal) rebuildProposalMap(inst, undefined, { fit: true });
    else mapPiece.fit();
    inst.map.render();
    inst.map.ensureFlowLoop();
    if (current.held) applyProposal();
  }

  /** The map's view (whole map or the data-flow lanes): laid out again, the camera fitted, a playing scenario ended (as the page's switch does) */
  function setMapView(view) {
    const next = view === 'dataflow' ? 'dataflow' : 'orbit';
    if (state.view === next) return;
    state.view = next;
    inst.emit('scenario:clear');
    inst.touchScene();
    if (state.nodes.length) {
      setMap(inst, state.mapNodes, state.mapEdges);
      mapPiece.fit();
      inst.map.ensureFlowLoop();
    }
    inst.emit('view', state.view);
  }

  /** The words of `view`: the proposal's (before, diff, after) or the map's (map, dataflow); the two sets do not meet */
  function applyView(view) {
    if (PROPOSAL_VIEWS.includes(view)) {
      current.proposalView = view;
      if (state.proposal) proposalPiece.update({ view });
    } else if (MAP_VIEWS.includes(view)) setMapView(view);
  }

  function applyConfig(config) {
    if (!config || typeof config !== 'object') return;
    if ('layers' in config) setProjectLayers(inst, config.layers);
    if (config.theme) mapPiece.applyTheme(config.theme);
  }

  /**
   * Applies what changed in `next` (the options above). Only the keys present are looked at.
   * @returns {Promise<boolean>|undefined} when a proposal is fetched: whether it opened
   */
  function update(next = {}) {
    if (ended) return undefined;
    let again = false;
    if ('strings' in next) { setStrings(inst, next.strings); applyStrings(inst, box); again = true; }
    if ('config' in next) applyConfig(next.config);
    if ('theme' in next) mapPiece.update({ theme: next.theme });
    if ('checker' in next) changesPiece.update({ checker: next.checker });
    if ('topology' in next && next.topology !== current.topology) { current.topology = next.topology; applyTopology(next.topology); }
    let result;
    const asked = ['proposal', 'source', 'slug', 'sha256'].some((k) => k in next);
    if (asked) {
      if ('source' in next) current.source = next.source || null;
      if ('slug' in next) current.slug = next.slug || null;
      if ('sha256' in next) current.sha256 = next.sha256 || null;
      if ('proposal' in next) { current.proposal = next.proposal; current.shown = null; }
      if ('view' in next && PROPOSAL_VIEWS.includes(next.view)) current.proposalView = next.view;
      result = applyProposal();
    }
    if ('view' in next && !(asked && PROPOSAL_VIEWS.includes(next.view))) applyView(next.view);
    if ('node' in next) mapPiece.update({ node: next.node });
    if (again) redraw();
    return result;
  }

  /** Ends the piece: every piece in it, the box, and the instance if the piece made it. Safe to call twice. */
  function destroy() {
    if (ended) return;
    ended = true;
    stopAsking();
    for (const piece of [decisionPiece, changesPiece, proposalPiece, nodePanel, mapPiece]) piece.destroy();
    setPhoneBox(inst, null);
    box.remove();
    if (ownsInstance) inst.destroy();
  }

  // What was handed in at mount is applied as an update, in the order update() keeps (strings, theme and the checker were taken above)
  const first = {};
  for (const key of ['config', 'topology', 'proposal', 'source', 'slug', 'sha256', 'view', 'node']) if (options[key] !== undefined) first[key] = options[key];
  update(first);

  return {
    inst,
    elements: [box],
    map: mapPiece,
    proposal: proposalPiece,
    changes: changesPiece,
    decision: decisionPiece,
    nodePanel,
    update,
    destroy,
    /** The whole map in view */
    fit: () => mapPiece.fit(),
  };
}
