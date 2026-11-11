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
import { isPhone } from './sheets.js';
import { centreTarget, announce } from './keyboard.js';
import { flyTo } from './fly.js';
import { groupOf } from './scene.js';
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

function rowHtml(m, off) {
  const type = off ? ` · ${escHtml(m.group)}` : '';
  const parent = m.parent ? escHtml(m.parent) : '';
  const current = state.searchCurrent === m.node.id;
  return `<button type="button" class="hx-search-row" data-corn="search-result" data-search-id="${escHtml(m.node.id)}" tabindex="-1"${current ? ' aria-current="true"' : ''}><span class="hx-search-row-label">${escHtml(m.node.label)}</span><span class="hx-search-row-parent">${parent}${type}</span></button>`;
}

/** The list's markup for a result: Frame all, the groups, the "and N more", or the no-match words */
export function resultsHtml(result) {
  if (!result.query) return '';
  if (!result.total) return `<p class="hx-search-empty" data-corn="search-empty">${escHtml(noMatchLine(result.query))}</p>`;
  const frame = result.onMap ? `<button type="button" class="hx-search-row hx-search-frame" data-corn="search-result" data-search-frame tabindex="-1">Frame all ${result.onMap}</button>` : '';
  const groups = result.groups.map((g) => `<div class="hx-search-group" role="group" aria-label="${escHtml(g.name)}, ${g.count}" data-corn="search-group"><div class="hx-search-group-title" aria-hidden="true">${escHtml(g.name)} <span class="hx-search-group-count">${g.count}</span></div>${g.rows.map((m) => rowHtml(m, g.off)).join('')}</div>`).join('');
  const more = result.more ? `<p class="hx-search-more">${escHtml(moreLine(result.more))}</p>` : '';
  return `${frame}${groups}${more}`;
}

/** Paints the count, the step buttons and the list of both fields from the current result */
export function paintSearch({ keepOpen = true } = {}) {
  const result = currentResult();
  const text = countText(result, state.searchCurrent);
  for (const field of FIELDS) {
    const count = $(field.count);
    if (count) { count.textContent = text; count.dataset.empty = result.query && !result.total ? 'true' : 'false'; }
    const steps = $(field.steps);
    if (steps) steps.hidden = !result.query;
    const list = listOf(field);
    if (!list) continue;
    const input = $(field.input);
    const open = !!result.query && keepOpen && (document.activeElement === input || list.contains(document.activeElement) || list.dataset.open === 'true');
    // A row that has the focus is repainted: the focus goes to the same row again, so a keyboard user keeps their place
    const held = list.contains(document.activeElement) ? document.activeElement : null;
    const heldId = held ? held.dataset.searchId || (held.hasAttribute('data-search-frame') ? '' : null) : null;
    list.innerHTML = open ? resultsHtml(result) : '';
    if (held && open && heldId !== null) {
      const again = rowsOf(list).find((r) => (heldId === '' ? r.hasAttribute('data-search-frame') : r.dataset.searchId === heldId));
      if (again) again.focus();
    }
    list.hidden = !open;
    list.dataset.open = open ? 'true' : 'false';
    if (input) {
      input.setAttribute('aria-expanded', String(open));
      input.setAttribute('aria-controls', field.results);
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

/** What the live region says for a result: the count, and for none the no-match words (after the typing pauses, search-status.js) */
function announceResult(result) {
  if (!result.query) { updateSearchStatus('', false); return; }
  if (!result.total) { updateSearchStatus(result.query, false); return; }
  updateSearchStatus(result.query, true);
  showSearchStatus(countText(result, state.searchCurrent));
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
  const tries = [groupOf(node), node.type === 'store' || node.type === 'rom' ? 'flow' : null, node.type === 'core' ? 'pkg' : null, node.type === 'core' ? 'core' : null];
  for (const key of tries) {
    if (isNodeVisible(node)) return;
    if (key && state.activeLayers[key] === false) toggleLayer(key);
  }
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
  flyTo(centreTarget(node, Math.max(state.camera.zoom, MATCH_ZOOM)));
  paintSearch();
  const words = `${at + 1} of ${result.total}: ${node.label}${match.parent ? `, in ${match.parent}` : ''}`;
  showSearchStatus(words);
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
  const words = `Framed ${ids.size} ${ids.size === 1 ? 'match' : 'matches'}`;
  showSearchStatus(words);
  announce(words);
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
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'none');
    input.setAttribute('aria-expanded', 'false');
    input.addEventListener('input', (e) => setQuery(e.target.value));
    input.addEventListener('keydown', (e) => onFieldKey(e, field));
    input.addEventListener('focus', () => { const list = listOf(field); if (list && state.searchQuery) { list.dataset.open = 'true'; paintSearch(); } });
    const box = input.closest('[data-corn="search"], [data-corn="mobile-search"]');
    if (box) box.addEventListener('focusout', (e) => onFocusOut(e, field));
    const list = listOf(field);
    if (list) {
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
