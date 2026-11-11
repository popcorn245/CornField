/**
 * @module explorer/search
 *
 * Search on the page (spec 0008 D3 and D4); search-model.js decides what is found and in what order, this shows it:
 *
 *   - the count in the field ("33 matches", "3 of 33", "No match") and, under the field, a list of what was found: up to 50 rows,
 *     grouped by type (the Layers name, with a count) in rank order, each row the label and its parent's; "Frame all 33" first;
 *     what a layer that is off hides last, under "In layers that are off", and choosing one turns its layer on;
 *   - stepping: Enter and Shift+Enter in the field, the arrow keys in the list, N and P on the map (keyboard.js) and the field's
 *     ^ and v buttons. Each step selects the match and flies the camera to it, at zoom 1 or closer;
 *   - on the map the matches keep their halo and win a label (scene.js, labels.js), the rest dims.
 *
 * The desktop field and the phone's bar are two inputs on one search: the query, the matches and the current match are shared, each
 * field has its own count, buttons and list. A polite live region says what changed (search-status.js). Everything the user typed or
 * the map holds goes into the markup as text.
 */

import { state, touchScene, escHtml } from './state.js';
import { render, fitGraphToViewport, fitPadding, isNodeVisible } from './render.js';
import { toggleLayer, onLayersChange } from './layers.js';
import { selectNode } from './panels.js';
import { isPhone, visibleMapRect } from './sheets.js';
import { announce } from './keyboard.js';
import { flyTo } from './fly.js';
import { groupOf } from './scene.js';
import { layerOn, projectLayerKey } from './layer-model.js';
import { noMatchText, showSearchStatus, updateSearchStatus } from './search-status.js';
import { countText, moreLine, noMatchLine, searchNodes, stepIndex } from './search-model.js';

const $ = (id) => document.getElementById(id);

/** The two fields: the desktop's and the phone's bar. Each has its input, count, list and the live region it shares with the other */
const FIELDS = [
  { input: 'node-search', count: 'search-count', results: 'search-results', steps: 'search-steps' },
  { input: 'mobile-node-search', count: 'mobile-search-count', results: 'mobile-search-results', steps: 'mobile-search-steps' },
];

/** The zoom a chosen match is shown at, at least */
export const MATCH_ZOOM = 1;

let memo = null; // { key, result }

/** The parent's label, for the row: the node the first ownership edge into it comes from */
function parentLabeller() {
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  const parentOf = new Map();
  for (const e of state.edges) if (!e.kind && !e.dashed && !parentOf.has(e.to)) parentOf.set(e.to, e.from);
  return (node) => { const p = byId.get(parentOf.get(node.id)); return p ? String(p.label || '') : ''; };
}

/** What the current query finds (kept until the query, the nodes or the scene change) */
export function currentResult() {
  const key = `${state.searchQuery}|${state.sceneVersion}|${state.nodes.length}`;
  if (memo && memo.key === key && memo.nodes === state.nodes) return memo.result;
  const result = searchNodes(state.nodes, state.searchQuery, { visible: (n) => isNodeVisible(n), parentLabel: parentLabeller() });
  memo = { key, nodes: state.nodes, result };
  return result;
}

/** Whether a search is on and found something: N and P step through its matches then */
export const searchActive = () => !!state.searchQuery && currentResult().total > 0;

// ---------------------------------------------------------------------------
//  Drawing the count and the list
// ---------------------------------------------------------------------------

const listOf = (field) => $(field.results);

const FRAME_STOP = Symbol('frame all');

function rowHtml(m, off, stop = false) {
  const type = off ? ` · ${escHtml(m.group)}` : '';
  const parent = m.parent ? escHtml(m.parent) : '';
  const current = state.searchCurrent === m.node.id;
  return `<button type="button" role="option" class="hx-search-row" data-corn="search-result" data-search-id="${escHtml(m.node.id)}" tabindex="${stop ? 0 : -1}" aria-selected="${current}"${current ? ' aria-current="true"' : ''}><span class="hx-search-row-label">${escHtml(m.node.label)}</span><span class="hx-search-row-parent">${parent}${type}</span></button>`;
}

/**
 * The list's markup for a result: a listbox (the combobox's popup) of Frame all and the groups of rows, then the "and N more" line; or the
 * no-match words alone. The focus moves into the listbox, from option to option (each row is a button with the option role).
 * @param {ReturnType<typeof searchNodes>} result
 * @param {string} [listId] the listbox's id
 */
export function resultsHtml(result, listId = 'search-listbox') {
  if (!result.query) return '';
  if (!result.total) return `<p class="hx-search-empty" data-corn="search-empty">${escHtml(noMatchLine(result.query))}</p>`;
  // A roving tab stop: one option (the chosen match when it is listed, else the first) is in the tab order, so Tab reaches the list that scrolls
  const listed = result.groups.flatMap((g) => g.rows);
  const stop = listed.some((m) => m.node.id === state.searchCurrent) ? state.searchCurrent : result.onMap ? FRAME_STOP : listed[0].node.id;
  const frame = result.onMap ? `<button type="button" role="option" aria-selected="false" class="hx-search-row hx-search-frame" data-corn="search-result" data-search-frame tabindex="${stop === FRAME_STOP ? 0 : -1}">Frame all ${result.onMap}</button>` : '';
  const groups = result.groups.map((g) => `<div class="hx-search-group" role="group" aria-label="${escHtml(g.name)}, ${g.count}" data-corn="search-group"><div class="hx-search-group-title" aria-hidden="true">${escHtml(g.name)} <span class="hx-search-group-count">${g.count}</span></div>${g.rows.map((m) => rowHtml(m, g.off, m.node.id === stop)).join('')}</div>`).join('');
  const more = result.more ? `<p class="hx-search-more">${escHtml(moreLine(result.more))}</p>` : '';
  return `<div role="listbox" id="${escHtml(listId)}" aria-label="Search results">${frame}${groups}</div>${more}`;
}

/** Paints the count, the step buttons and the list of both fields from the current result */
export function paintSearch({ keepOpen = true } = {}) {
  const result = currentResult();
  const text = countText(result, state.searchCurrent);
  for (const field of FIELDS) {
    const count = $(field.count);
    if (count) { count.textContent = text; count.dataset.empty = result.query && !result.total ? 'true' : 'false'; }
    const steps = $(field.steps);
    if (steps) {
      steps.hidden = !result.query;
      for (const b of steps.querySelectorAll('[data-action="search-prev"], [data-action="search-next"]')) b.disabled = !result.total; // nothing to step to
    }
    const list = listOf(field);
    if (!list) continue;
    const input = $(field.input);
    const open = !!result.query && keepOpen && (document.activeElement === input || list.contains(document.activeElement) || list.dataset.open === 'true');
    // A row that has the focus is repainted: the focus goes to the same row again, so a keyboard user keeps their place
    const held = list.contains(document.activeElement) ? document.activeElement : null;
    const heldId = held ? held.dataset.searchId || (held.hasAttribute('data-search-frame') ? '' : null) : null;
    const listId = `${field.results}-listbox`;
    list.innerHTML = open ? resultsHtml(result, listId) : '';
    if (held && open && heldId !== null) {
      const again = rowsOf(list).find((r) => (heldId === '' ? r.hasAttribute('data-search-frame') : r.dataset.searchId === heldId));
      if (again) again.focus();
    }
    list.hidden = !open;
    list.dataset.open = open ? 'true' : 'false';
    if (input) {
      const options = open && result.total > 0; // the popup is the listbox: with no match there is none, only the words (and the live region says them)
      input.setAttribute('aria-expanded', String(options));
      input.setAttribute('aria-controls', options ? listId : field.results);
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
  const input = $(field.input);
  if (input) input.setAttribute('aria-expanded', 'false');
}

// ---------------------------------------------------------------------------
//  The query
// ---------------------------------------------------------------------------

/** What the live region says for a result, once the typing pauses: the count, or for none the no-match words (search-status.js) */
function announceResult(result) {
  updateSearchStatus(result.query, result.total > 0, countText(result, state.searchCurrent)); // once the typing pauses, not on every key
}

/** Sets the query (typed in either field, or cleared): the map redraws, the count and the list follow */
export function setQuery(value) {
  const query = String(value || '').trim();
  const changed = query !== state.searchQuery;
  state.searchQuery = query;
  if (changed) state.searchCurrent = null; // a new question has no current answer yet
  touchScene();
  for (const field of FIELDS) {
    const input = $(field.input);
    if (input && input.value !== value) input.value = value || '';
    const list = listOf(field);
    if (list && input && (document.activeElement === input)) list.dataset.open = 'true';
  }
  paintSearch();
  announceResult(currentResult());
  render();
}

// ---------------------------------------------------------------------------
//  Choosing a match
// ---------------------------------------------------------------------------

/** Turns on the layer that hides `node`, so it can be shown (the matches in layers that are off) */
function showLayerOf(node) {
  // A project layer that takes the node decides alone (spec 0009); else its starting layer, and what that one needs on with it
  const tries = [projectLayerKey(state, node), groupOf(node), node.type === 'store' || node.type === 'rom' ? 'flow' : null, node.type === 'core' ? 'pkg' : null, node.type === 'core' ? 'core' : null];
  for (const key of tries) {
    if (isNodeVisible(node)) return;
    if (key && !layerOn(state, key)) toggleLayer(key);
  }
}

/** The camera that puts `node` in the middle of the part of the map nothing covers (the panels, the proposal bar, the review column, a phone's sheets: sheets.js) */
export function matchTarget(node, zoom) {
  const r = visibleMapRect();
  return { x: r.x + r.width / 2 - node.x * zoom, y: r.y + r.height / 2 - node.y * zoom, zoom };
}

/** Selects a match and flies the camera to it (zoom 1 or closer): what Enter, a row and N do */
let chosen = 0;
export async function chooseMatch(match, { say = true } = {}) {
  const node = match.node;
  const mine = ++chosen;
  if (!isNodeVisible(node)) showLayerOf(node);
  state.searchCurrent = node.id;
  touchScene();
  const result = currentResult();
  const at = result.matches.findIndex((m) => m.node.id === node.id);
  await selectNode(node);
  if (mine !== chosen || state.searchCurrent !== node.id) return; // a later choice, or a new query, has taken over while the panel was filling
  flyTo(matchTarget(node, Math.max(state.camera.zoom, MATCH_ZOOM)));
  paintSearch();
  const words = `${at + 1} of ${result.total}: ${node.label}${match.parent ? `, in ${match.parent}` : ''}`;
  showSearchStatus(''); // said once, by the map's announcer: two live regions with the same words are read out twice
  if (say) announce(words);
}

/** The match `by` (+1, -1) from the current one: the first (or last) with none; false when there is nothing to step to */
export function stepMatch(by) {
  const result = currentResult();
  if (!state.searchQuery || !result.total) return false;
  const at = stepIndex(result.matches, state.searchCurrent, by);
  if (at < 0) return false;
  chooseMatch(result.matches[at]);
  return true;
}

/** Fits the camera to every match on the map ("Frame all") */
export function frameAll() {
  const result = currentResult();
  const ids = new Set(result.matches.filter((m) => m.on).map((m) => m.node.id));
  if (!ids.size) return;
  fitGraphToViewport(fitPadding(), ids);
  showSearchStatus('');
  announce(`Framed ${ids.size} ${ids.size === 1 ? 'match' : 'matches'}`);
}

// ---------------------------------------------------------------------------
//  Keys and clicks
// ---------------------------------------------------------------------------

const rowsOf = (list) => [...list.querySelectorAll('[data-corn="search-result"]')];

function onFieldKey(e, field) {
  const input = e.currentTarget;
  if (e.key === 'Enter') {
    if (e.isComposing) return;
    e.preventDefault();
    const typed = input.value.trim();
    if (typed !== state.searchQuery) setQuery(input.value);
    if (!typed) return;
    const result = currentResult();
    if (!result.total) { announce(`No node matches ${typed}`); return; }
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
    if (state.searchQuery) { e.preventDefault(); setQuery(''); announce('Search cleared'); }
  }
}

function onListKey(e, field) {
  const list = listOf(field);
  const rows = rowsOf(list);
  const at = rows.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = at + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) $(field.input).focus(); else rows[Math.min(rows.length - 1, next)].focus();
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    rows[e.key === 'Home' ? 0 : rows.length - 1].focus();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    $(field.input).focus(); // back in the field, the list still there: a second Escape shuts it
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
  const field = FIELDS.find((f) => listOf(f) === e.currentTarget);
  if (field && field.input === 'mobile-node-search' && isPhone()) {
    closeList(field);
    const next = $(field.steps) && $(field.steps).querySelector('[data-action="search-next"]');
    if (next) next.focus();
  }
}

/** The list closes when the focus leaves the field and its list (a click on the map, Tab away) */
function onFocusOut(e, field) {
  const next = e.relatedTarget;
  const box = $(field.input).closest('[data-corn="search"], [data-corn="mobile-search"]');
  if (next && box && box.contains(next)) return;
  if (!next && e.target && e.target.matches && e.target.matches('[data-corn="search-result"]')) return; // a row that left the DOM (the list repainted)
  closeList(field);
}

/** Wires both fields, their list, and the step and clear buttons (main.js, once the page is up) */
export function initSearch() {
  for (const field of FIELDS) {
    const input = $(field.input);
    if (!input || input.dataset.searchBound) continue;
    input.dataset.searchBound = '1';
    // A combobox whose popup is a listbox: its options (Frame all, then the rows) in labelled groups, reached with the down arrow and
    // walked with the arrows (the focus moves from option to option), so a screen reader hears each row and its group
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-autocomplete', 'none');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', field.results);
    input.addEventListener('input', (e) => setQuery(e.target.value));
    input.addEventListener('keydown', (e) => onFieldKey(e, field));
    input.addEventListener('focus', () => { const list = listOf(field); if (list && state.searchQuery) { list.dataset.open = 'true'; paintSearch(); } });
    const box = input.closest('[data-corn="search"], [data-corn="mobile-search"]');
    if (box) box.addEventListener('focusout', (e) => onFocusOut(e, field));
    const list = listOf(field);
    if (list) {
      // A press on a row keeps the focus where it is (some browsers do not focus a button they press): the field would lose it and shut the list before the click
      list.addEventListener('mousedown', (e) => { if (e.target.closest && e.target.closest('[data-corn="search-result"]')) e.preventDefault(); });
      list.addEventListener('click', onListClick);
      list.addEventListener('keydown', (e) => onListKey(e, field));
    }
  }
  // A layer going on or off moves matches between the list and "In layers that are off"
  onLayersChange(() => { if (state.searchQuery) paintSearch(); });
}

/** For tests: forget what was found */
export function resetSearchForTests() { memo = null; chosen++; state.searchQuery = ''; state.searchCurrent = null; }

export { noMatchText };
