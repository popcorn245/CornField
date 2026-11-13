/**
 * @module explorer/pieces/search
 *
 * Search as a piece (spec 0011 D3; spec 0008 D3 and D4); search-model.js decides what is found and in what order, this shows it:
 *
 *   - the count in the field ("33 matches", "3 of 33", "No match") and, under the field, a list of what was found: up to 50 rows,
 *     grouped by type (the Layers name, with a count) in rank order, each row the label and its parent's; "Frame all 33" first;
 *     what a layer that is off hides last, under "In layers that are off", and choosing one turns its layer on;
 *   - stepping: Enter and Shift+Enter in the field, the arrow keys in the list, N and P on the map (engine/keyboard.js asks `search:active` and
 *     `search:step`) and the field's ^ and v buttons. Each step selects the match and flies the camera to it, at zoom 1 or closer;
 *   - on the map the matches keep their halo and win a label (scene.js, labels.js), the rest dims.
 *
 * The desktop field and the phone's bar are two inputs on one search: the query, the matches and the current match are shared, each
 * field has its own count, buttons and list. A polite live region says what changed (engine/search-status.js). Everything the user typed or
 * the map holds goes into the markup as text.
 *
 *   mount(root, inst, options) -> { update, destroy, ... }
 *
 * The piece makes its own markup (`markup()`: the field with its phone button, and the phone's bar) and puts it in `root`, or before the nodes
 * `options.slots` names (`field`, `bar`). It tells the instance `search` ({ query, current }) when either changes, answers `search:active` and
 * `search:step`, and follows `layers` (a layer going on or off moves matches between the list and "In layers that are off"). `/` goes to the
 * field while the focus is inside the root and not in a field. `destroy()` takes back every listener and timer and removes the elements.
 *
 * @param {ParentNode} root where the search goes when `options.slots` names no place
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst the instance; its map must be made (engine/render.js)
 * @param {{ slots?: { field?: Node, bar?: Node } }} [options]
 * @returns {{ update: (props?: { query?: string }) => void, destroy: () => void, elements: Element[], setQuery: Function, stepMatch: Function, frameAll: Function, chooseMatch: Function, currentResult: Function, searchActive: Function, paintSearch: Function, toggleMobileSearch: Function, reset: Function }}
 *   `update({ query })` sets the search; `update()` paints the count and the list again
 */

import { escapeHtml as escHtml } from '../../core/text.js';
import { toggleLayer } from '../engine/layers.js';
import { selectNode } from '../engine/selection.js';
import { isPhone, visibleMapRect } from '../engine/sheets.js';
import { announce } from '../engine/keyboard.js';
import { flyTo } from '../engine/fly.js';
import { groupOf } from '../scene.js';
import { layerOn, projectLayerKey } from '../layer-model.js';
import { showSearchStatus, updateSearchStatus } from '../engine/search-status.js';
import { countText, moreLine, noMatchLine, searchNodes, stepIndex } from '../search-model.js';
import { scopeOf, place } from '../engine/piece.js';
import { listenRoots } from '../engine/roots.js';

/** The two fields: the desktop's and the phone's bar. Each has its input, count, list and the live region it shares with the other */
const FIELDS = [
  { input: 'node-search', count: 'search-count', results: 'search-results', steps: 'search-steps' },
  { input: 'mobile-node-search', count: 'mobile-search-count', results: 'mobile-search-results', steps: 'mobile-search-steps' },
];

/** The zoom a chosen match is shown at, at least */
export const MATCH_ZOOM = 1;

const FRAME_STOP = Symbol('frame all');

/** The markup of the piece: the field with the button that opens the phone's bar (`field`), and the phone's bar (`bar`) */
export const markup = ({ phone = true } = {}) => ({
  field: `${phone ? `<button type="button" id="mobile-search-toggle" class="hx-hdr-icon hx-only-mobile" data-corn="mobile-search-button" data-action="toggle-mobile-search" aria-label="Open Search" title="Search nodes" data-corn-kind="icon">
  <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
</button>

` : ''}<div class="hx-search" role="search" data-corn="search">
  <svg class="hx-search-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
  <input type="text" id="node-search" class="hx-search-input" placeholder="Search..." data-corn-string-placeholder="searchPlaceholder" aria-label="Search nodes" aria-keyshortcuts="/" data-corn="search-input" />
  <kbd class="hx-kbd" data-corn="search-key" aria-hidden="true">/</kbd>
  <span id="search-steps" class="hx-search-steps" data-corn="search-steps" hidden>
    <span id="search-count" class="hx-search-count" data-corn="search-count" aria-hidden="true"></span>
    <button type="button" class="hx-search-btn" data-action="search-prev" aria-label="Previous match" title="Previous match (Shift+Enter)" data-corn-kind="icon"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 10.5L8 6l4.5 4.5" /></svg></button>
    <button type="button" class="hx-search-btn" data-action="search-next" aria-label="Next match" title="Next match (Enter)" data-corn-kind="icon"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 5.5L8 10l4.5-4.5" /></svg></button>
    <button type="button" class="hx-search-btn" data-action="clear-search" aria-label="Clear search" title="Clear search (Escape)" data-corn-kind="icon"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
  </span>
  <div id="search-status" class="hx-search-status" role="status" aria-live="polite" data-corn="search-status"></div>
  <div id="search-results" class="hx-search-results" data-corn="search-results" hidden></div>
</div>`,
  bar: !phone ? '' : `<div id="mobile-search-bar" class="hx-mobile-search glass-header" role="search" hidden data-corn="mobile-search">
  <input type="text" id="mobile-node-search" class="hx-input hx-input--wide" placeholder="Search nodes, apps, components..." aria-label="Search nodes" data-corn="search-input" />
  <button type="button" class="hx-textbtn" data-action="close-mobile-search" data-corn-kind="quiet">Cancel</button>
  <span id="mobile-search-steps" class="hx-search-steps" data-corn="search-steps" hidden>
        <span id="mobile-search-count" class="hx-search-count" data-corn="search-count" aria-hidden="true"></span>
        <button type="button" class="hx-search-btn" data-action="search-prev" aria-label="Previous match" title="Previous match (Shift+Enter)" data-corn-kind="icon"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 10.5L8 6l4.5 4.5" /></svg></button>
        <button type="button" class="hx-search-btn" data-action="search-next" aria-label="Next match" title="Next match (Enter)" data-corn-kind="icon"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 5.5L8 10l4.5-4.5" /></svg></button>
        <button type="button" class="hx-search-btn" data-action="clear-search" aria-label="Clear search" title="Clear search (Escape)" data-corn-kind="icon"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
      </span>
  <div id="mobile-search-status" class="hx-search-status" role="status" aria-live="polite" data-corn="search-status"></div>
  <div id="mobile-search-results" class="hx-search-results" data-corn="search-results" hidden></div>
</div>`,
});

function rowHtml(state, m, off, stop = false) {
  const type = off ? ` · ${escHtml(m.group)}` : '';
  const parent = m.parent ? escHtml(m.parent) : '';
  const current = state.searchCurrent === m.node.id;
  return `<button type="button" role="option" class="hx-search-row" data-corn="search-result" data-search-id="${escHtml(m.node.id)}" tabindex="${stop ? 0 : -1}" aria-selected="${current}"${current ? ' aria-current="true"' : ''}><span class="hx-search-row-label">${escHtml(m.node.label)}</span><span class="hx-search-row-parent">${parent}${type}</span></button>`;
}

/**
 * The list's markup for a result: a listbox (the combobox's popup) of Frame all and the groups of rows, then the "and N more" line; or the
 * no-match words alone. The focus moves into the listbox, from option to option (each row is a button with the option role).
 * @param {{ searchCurrent: string | null }} state
 * @param {ReturnType<typeof searchNodes>} result
 * @param {string} [listId] the listbox's id
 */
export function resultsHtml(state, result, listId = 'search-listbox') {
  if (!result.query) return '';
  if (!result.total) return `<p class="hx-search-empty" data-corn="search-empty">${escHtml(noMatchLine(result.query))}</p>`;
  // A roving tab stop: one option (the chosen match when it is listed, else the first) is in the tab order, so Tab reaches the list that scrolls
  const listed = result.groups.flatMap((g) => g.rows);
  const stop = listed.some((m) => m.node.id === state.searchCurrent) ? state.searchCurrent : result.onMap ? FRAME_STOP : listed[0].node.id;
  const frame = result.onMap ? `<button type="button" role="option" aria-selected="false" class="hx-search-row hx-search-frame" data-corn="search-result" data-search-frame tabindex="${stop === FRAME_STOP ? 0 : -1}">Frame all ${result.onMap}</button>` : '';
  const groups = result.groups.map((g) => `<div class="hx-search-group" role="group" aria-label="${escHtml(g.name)}, ${g.count}" data-corn="search-group"><div class="hx-search-group-title" aria-hidden="true">${escHtml(g.name)} <span class="hx-search-group-count">${g.count}</span></div>${g.rows.map((m) => rowHtml(state, m, g.off, m.node.id === stop)).join('')}</div>`).join('');
  const more = result.more ? `<p class="hx-search-more">${escHtml(moreLine(result.more))}</p>` : '';
  return `<div role="listbox" id="${escHtml(listId)}" aria-label="Search results">${frame}${groups}</div>${more}`;
}

const rowsOf = (list) => [...list.querySelectorAll('[data-corn="search-result"]')];

/** Whether the key went to something that takes typing */
const typing = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** Mounts the search; see the top of this file */
export function mount(root, inst, options = {}) {
  const { state } = inst;
  const scope = scopeOf(inst);
  const made = [
    ...place(inst, root, markup({ phone: options.phone !== false }).field, options.slots, 'field'),
    ...place(inst, root, markup({ phone: options.phone !== false }).bar, options.slots, 'bar'),
  ];
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
  /** The fields this mount has: both on cornfield's page; the field alone in a box of its own (`options.phone: false`, `<corn-search>`) */
  const fields = FIELDS.filter((f) => own(f.input));
  let memo = null; // { key, nodes, result }
  let chosen = 0;

  /** The parent's label, for the row: the node the first ownership edge into it comes from */
  function parentLabeller() {
    const byId = new Map(state.nodes.map((n) => [n.id, n]));
    const parentOf = new Map();
    for (const e of state.edges) if (!e.kind && !e.dashed && !parentOf.has(e.to)) parentOf.set(e.to, e.from);
    return (node) => { const p = byId.get(parentOf.get(node.id)); return p ? String(p.label || '') : ''; };
  }

  /** What the current query finds (kept until the query, the nodes or the scene change) */
  function currentResult() {
    const key = `${state.searchQuery}|${state.sceneVersion}|${state.nodes.length}`;
    if (memo && memo.key === key && memo.nodes === state.nodes) return memo.result;
    const result = searchNodes(state.nodes, state.searchQuery, { visible: (n) => inst.map.isNodeVisible(n), parentLabel: parentLabeller() });
    memo = { key, nodes: state.nodes, result };
    return result;
  }

  /** Whether a search is on and found something: N and P step through its matches then */
  const searchActive = () => !!state.searchQuery && currentResult().total > 0;

  // -- drawing the count and the list ---------------------------------------------------------------------------------------------
  const listOf = (field) => own(field.results);

  /** Paints the count, the step buttons and the list of both fields from the current result */
  function paintSearch({ keepOpen = true } = {}) {
    const result = currentResult();
    const text = countText(result, state.searchCurrent);
    for (const field of fields) {
      const count = own(field.count);
      if (count) { count.textContent = text; count.dataset.empty = result.query && !result.total ? 'true' : 'false'; }
      const steps = own(field.steps);
      if (steps) {
        steps.hidden = !result.query;
        for (const b of steps.querySelectorAll('[data-action="search-prev"], [data-action="search-next"]')) b.disabled = !result.total; // nothing to step to
      }
      const list = listOf(field);
      if (!list) continue;
      const input = own(field.input);
      const focused = inst.active();
      const open = !!result.query && keepOpen && (focused === input || list.contains(focused) || list.dataset.open === 'true');
      // A row that has the focus is repainted: the focus goes to the same row again, so a keyboard user keeps their place
      const held = list.contains(focused) ? focused : null;
      const heldId = held ? held.dataset.searchId || (held.hasAttribute('data-search-frame') ? '' : null) : null;
      const listId = `${field.results}-listbox`;
      list.innerHTML = open ? resultsHtml(state, result, listId) : '';
      if (open) for (const x of list.querySelectorAll('[data-corn]:not([part])')) x.setAttribute('part', x.getAttribute('data-corn'));
      if (held && open && heldId !== null) {
        const again = rowsOf(list).find((r) => (heldId === '' ? r.hasAttribute('data-search-frame') : r.dataset.searchId === heldId));
        if (again) again.focus();
      }
      list.hidden = !open;
      list.dataset.open = open ? 'true' : 'false';
      if (input) {
        const options2 = open && result.total > 0; // the popup is the listbox: with no match there is none, only the words (and the live region says them)
        input.setAttribute('aria-expanded', String(options2));
        input.setAttribute('aria-controls', options2 ? listId : field.results);
      }
    }
  }

  /** The list of a field, closed (Escape, or the focus left it) */
  function closeList(field) {
    const list = listOf(field);
    if (!list) return;
    list.hidden = true;
    list.dataset.open = 'false';
    list.innerHTML = '';
    const input = own(field.input);
    if (input) input.setAttribute('aria-expanded', 'false');
  }

  // -- the query ------------------------------------------------------------------------------------------------------------------
  /** What the live region says for a result, once the typing pauses: the count, or for none the no-match words (engine/search-status.js) */
  function announceResult(result) {
    updateSearchStatus(inst, result.query, result.total > 0, countText(result, state.searchCurrent)); // once the typing pauses, not on every key
  }

  /** Sets the query (typed in either field, or cleared): the map redraws, the count and the list follow */
  function setQuery(value) {
    const query = String(value || '').trim();
    const changed = query !== state.searchQuery;
    state.searchQuery = query;
    if (changed) state.searchCurrent = null; // a new question has no current answer yet
    inst.touchScene();
    for (const field of fields) {
      const input = own(field.input);
      if (input && input.value !== value) input.value = value || '';
      const list = listOf(field);
      if (list && input && inst.active() === input) list.dataset.open = 'true';
    }
    paintSearch();
    announceResult(currentResult());
    inst.map.render();
    if (changed) inst.emit('search', { query: state.searchQuery, current: state.searchCurrent });
  }

  // -- choosing a match -----------------------------------------------------------------------------------------------------------
  /** Turns on the layer that hides `node`, so it can be shown (the matches in layers that are off) */
  function showLayerOf(node) {
    // A project layer that takes the node decides alone (spec 0009); else its starting layer, and what that one needs on with it
    const tries = [projectLayerKey(state, node), groupOf(node), node.type === 'store' || node.type === 'rom' ? 'flow' : null, node.type === 'core' ? 'pkg' : null, node.type === 'core' ? 'core' : null];
    for (const key of tries) {
      if (inst.map.isNodeVisible(node)) return;
      if (key && !layerOn(state, key)) toggleLayer(inst, key);
    }
  }

  /** The camera that puts `node` in the middle of the part of the map nothing covers (the panels, the proposal bar, the review column, a phone's sheets: engine/sheets.js) */
  function matchTarget(node, zoom) {
    const r = visibleMapRect(inst);
    return { x: r.x + r.width / 2 - node.x * zoom, y: r.y + r.height / 2 - node.y * zoom, zoom };
  }

  /** Selects a match and flies the camera to it (zoom 1 or closer): what Enter, a row and N do */
  async function chooseMatch(match, { say = true } = {}) {
    const node = match.node;
    const mine = ++chosen;
    if (!inst.map.isNodeVisible(node)) showLayerOf(node);
    state.searchCurrent = node.id;
    inst.touchScene();
    const result = currentResult();
    const at = result.matches.findIndex((m) => m.node.id === node.id);
    selectNode(inst, node, { source: 'search' });
    if (mine !== chosen || state.searchCurrent !== node.id) return; // a later choice, or a new query, has taken over
    flyTo(inst, matchTarget(node, Math.max(state.camera.zoom, MATCH_ZOOM)));
    paintSearch();
    inst.emit('search', { query: state.searchQuery, current: state.searchCurrent });
    const words = `${at + 1} of ${result.total}: ${node.label}${match.parent ? `, in ${match.parent}` : ''}`;
    showSearchStatus(inst, ''); // said once, by the map's announcer: two live regions with the same words are read out twice
    if (say) announce(inst, words);
  }

  /** The match `by` (+1, -1) from the current one: the first (or last) with none; false when there is nothing to step to */
  function stepMatch(by) {
    const result = currentResult();
    if (!state.searchQuery || !result.total) return false;
    const at = stepIndex(result.matches, state.searchCurrent, by);
    if (at < 0) return false;
    chooseMatch(result.matches[at]);
    return true;
  }

  /** Fits the camera to every match on the map ("Frame all") */
  function frameAll() {
    const result = currentResult();
    const ids = new Set(result.matches.filter((m) => m.on).map((m) => m.node.id));
    if (!ids.size) return;
    inst.map.fitGraphToViewport(inst.map.fitPadding(), ids);
    showSearchStatus(inst, '');
    announce(inst, `Framed ${ids.size} ${ids.size === 1 ? 'match' : 'matches'}`);
  }

  // -- keys and clicks ------------------------------------------------------------------------------------------------------------
  function onFieldKey(e, field) {
    const input = e.currentTarget;
    if (e.key === 'Enter') {
      if (e.isComposing) return;
      e.preventDefault();
      const typed = input.value.trim();
      if (typed !== state.searchQuery) setQuery(input.value);
      if (!typed) return;
      const result = currentResult();
      if (!result.total) { announce(inst, `No node matches ${typed}`); return; }
      stepMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const list = listOf(field);
      if (!list || list.hidden) { if (e.key === 'ArrowDown' && state.searchQuery) { e.preventDefault(); list.dataset.open = 'true'; paintSearch(); } return; }
      const rows = rowsOf(list);
      if (!rows.length) return;
      e.preventDefault();
      (e.key === 'ArrowDown' ? rows[0] : rows[rows.length - 1]).focus();
    } else if (e.key === 'Escape') {
      const list = listOf(field);
      if (list && !list.hidden) { e.preventDefault(); closeList(field); return; }
      if (state.searchQuery) { e.preventDefault(); setQuery(''); announce(inst, 'Search cleared'); }
    }
  }

  function onListKey(e, field) {
    const list = listOf(field);
    const rows = rowsOf(list);
    const at = rows.indexOf(inst.active());
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = at + (e.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) own(field.input).focus(); else rows[Math.min(rows.length - 1, next)].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      rows[e.key === 'Home' ? 0 : rows.length - 1].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      own(field.input).focus(); // back in the field, the list still there: a second Escape shuts it
    }
  }

  function onListClick(e) {
    const row = e.target.closest && e.target.closest('[data-corn="search-result"]');
    if (!row) return;
    if (row.hasAttribute('data-search-frame')) { frameAll(); return; }
    const result = currentResult();
    const match = result.matches.find((m) => m.node.id === row.dataset.searchId);
    if (!match) return;
    chooseMatch(match);
    // On a phone the list would cover the match: it shuts, and the focus goes to the next-match button, which stays
    const field = fields.find((f) => listOf(f) === e.currentTarget);
    if (field && field.input === 'mobile-node-search' && isPhone(inst)) {
      closeList(field);
      const next = own(field.steps) && own(field.steps).querySelector('[data-action="search-next"]');
      if (next) next.focus();
    }
  }

  /** The list closes when the focus leaves the field and its list (a click on the map, Tab away) */
  function onFocusOut(e, field) {
    const next = e.relatedTarget;
    const box = own(field.input).closest('[data-corn="search"], [data-corn="mobile-search"]');
    if (next && box && box.contains(next)) return;
    if (!next && e.target && e.target.matches && e.target.matches('[data-corn="search-result"]')) return; // a row that left the DOM (the list repainted)
    closeList(field);
  }

  /** Opens or shuts the phone's search bar (its icon in the header, Cancel); opened, it takes the query and the focus */
  function toggleMobileSearch(open) {
    const bar = own('mobile-search-bar');
    const input = own('mobile-node-search');
    const willOpen = open !== undefined ? open : bar.hidden;
    bar.hidden = !willOpen;
    if (willOpen) {
      input.value = state.searchQuery;
      scope.timeout(() => input.focus(), 60);
    }
  }

  // Both fields, their list, and the step and clear buttons
  for (const field of fields) {
    const input = own(field.input);
    // A combobox whose popup is a listbox: its options (Frame all, then the rows) in labelled groups, reached with the down arrow and
    // walked with the arrows (the focus moves from option to option), so a screen reader hears each row and its group
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-autocomplete', 'none');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', field.results);
    scope.listen(input, 'input', (e) => setQuery(e.target.value));
    scope.listen(input, 'keydown', (e) => onFieldKey(e, field));
    scope.listen(input, 'focus', () => { const list = listOf(field); if (list && state.searchQuery) { list.dataset.open = 'true'; paintSearch(); } });
    const box = input.closest('[data-corn="search"], [data-corn="mobile-search"]');
    if (box) scope.listen(box, 'focusout', (e) => onFocusOut(e, field));
    const list = listOf(field);
    if (list) {
      // A press on a row keeps the focus where it is (some browsers do not focus a button they press): the field would lose it and shut the list before the click
      scope.listen(list, 'mousedown', (e) => { if (e.target.closest && e.target.closest('[data-corn="search-result"]')) e.preventDefault(); });
      scope.listen(list, 'click', onListClick);
      scope.listen(list, 'keydown', (e) => onListKey(e, field));
    }
  }

  // The piece's own buttons: the phone's search icon and Cancel, previous, next and clear
  const ACTIONS = {
    'toggle-mobile-search': () => toggleMobileSearch(),
    'close-mobile-search': () => toggleMobileSearch(false),
    'clear-search': () => { setQuery(''); const bar = own('mobile-search-bar'); (bar && !bar.hidden ? own('mobile-node-search') : own('node-search')).focus(); },
    'search-prev': () => stepMatch(-1),
    'search-next': () => stepMatch(1),
  };
  for (const el of made) {
    scope.listen(el, 'click', (e) => {
      const target = e.target.closest && e.target.closest('[data-action]');
      if (!target || !el.contains(target)) return;
      const action = ACTIONS[target.dataset.action];
      if (action) action(target);
    });
  }

  /** `/` goes to the search box, or to the phone's search bar where the box is not shown (opening the bar if it is shut) */
  function goToSearch() {
    const input = own('node-search');
    const shown = input && input.closest('.hx-search') && inst.win.getComputedStyle(input.closest('.hx-search')).display !== 'none';
    if (shown) { input.focus(); input.select(); return; }
    const bar = own('mobile-search-bar');
    if (bar && !bar.hidden) { own('mobile-node-search').focus(); return; }
    const open = own('mobile-search-toggle');
    if (open) open.click();
  }
  // On every root of the instance: with the map in another shadow root, `/` there reaches the field here
  const tree = typeof root.getRootNode === 'function' ? root.getRootNode() : root;
  scope.own(listenRoots(inst, 'keydown', (e) => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target) && !(tree.querySelector && tree.querySelector('[data-corn="dialog-scrim"]:not([hidden]), .hx-mockup-dialog'))) {
      e.preventDefault();
      // two search tags in one scope: the first that took the focus keeps it
      const now = inst.active();
      if (now && typeof now.matches === 'function' && now.matches('[data-corn="search-input"]') && !made.some((el) => el.contains(now))) return;
      goToSearch();
    }
  }));
  // What the live regions beside the fields say (engine/search-status.js tells the instance; the regions are this piece's own). A scope may hold two search
  // tags: they are one search (one query, one current match), and only one of them speaks, the one last used (else the first), so it is said once
  const voice = inst.slot('search-voice', () => ({ current: null, all: new Set() }));
  const me = {};
  voice.all.add(me);
  if (!voice.current) voice.current = me;
  for (const field of fields) scope.listen(own(field.input), 'focus', () => { voice.current = me; });
  scope.own(() => { voice.all.delete(me); if (voice.current === me) voice.current = null; });
  scope.on('search:status', (text) => {
    if (!voice.current) voice.current = me;
    for (const id of ['search-status', 'mobile-search-status']) { const el = own(id); if (el) el.textContent = voice.current === me ? text : ''; }
  });
  // ... and the other one shows what this one typed or chose (cornfield's page has one search: nothing here runs there)
  scope.on('search', () => {
    if (voice.all.size < 2 || made.some((el) => el.contains(inst.active()))) return;
    for (const field of fields) {
      const input = own(field.input);
      if (input && input.value.trim() !== state.searchQuery) input.value = state.searchQuery;
    }
    paintSearch({ keepOpen: false });
  });

  // What the neighbours ask of the search, and a layer going on or off moving matches between the list and "In layers that are off"
  scope.on('search:active', () => searchActive());
  scope.on('search:step', (by) => stepMatch(by));
  scope.on('layers', () => { if (state.searchQuery) paintSearch(); });
  scope.own(() => { chosen++; made.forEach((el) => el.remove()); });

  return {
    elements: made,
    setQuery,
    stepMatch,
    frameAll,
    chooseMatch,
    currentResult,
    searchActive,
    paintSearch,
    toggleMobileSearch,
    /** The focus goes to the field, its text selected (what `/` does) */
    focusField() { const input = own('node-search'); if (input) { input.focus(); input.select(); } },
    /** For tests: forget what was found */
    reset() { memo = null; chosen++; state.searchQuery = ''; state.searchCurrent = null; },
    update(props) {
      if (props && 'query' in props) setQuery(props.query);
      else paintSearch();
    },
    destroy: () => scope.destroy(),
  };
}
