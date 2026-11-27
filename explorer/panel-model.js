/**
 * @module explorer/panel-model
 *
 * The node panel's shape (spec 0015 D4), as strings and plain data: the action bar that leads it, the one "Next" line under the bar, the sections that
 * fold behind their title and count, and what the browser remembers of which are open, per kind of node. Pure: no DOM, no storage of its own
 * (explorer/panel-sections.js reads and writes the browser's and wires the clicks).
 *
 *   actionBarHtml({ primary, others, next })   the bar: the one next action first, the next two beside it, the rest under ⋯
 *   nextHtml(words)                            "Then: approve, and Land it once docs finishes (1 check running)."
 *   sectionHtml({ key, title, count, note, body, open })   a section with its count, closed unless it holds the action
 *   groupLinks(links)                          a node's Connected rows grouped by relation, in the order first seen
 *   readPrefs(text), isOpen(prefs, kind, key, fallback), withOpen(prefs, kind, key, open)   what is remembered
 */

import { escapeHtml as esc } from '../core/text.js';

/** How many actions sit beside the primary one before the rest go under ⋯ */
export const BESIDE = 2;

/** The browser's key for which sections are open, per kind of node */
export const SECTIONS_KEY = 'cornfield.panel.sections';

/**
 * The action bar: the primary action, the next ones beside it, the rest under ⋯ (a disclosure: a button that shows a group of buttons, reached with Tab, closed by Escape),
 * then the Next line. Each action is the markup of a button or a link, as its part draws it today (its data attributes are what its click does). '' with nothing to show.
 * @param {{ primary?: string, others?: string[], next?: string }} parts
 */
export function actionBarHtml({ primary = '', others = [], next = '' } = {}) {
  const rest = others.filter(Boolean);
  const first = primary || rest.shift() || '';
  if (!first && !next) return '';
  const beside = rest.slice(0, BESIDE);
  const more = rest.slice(BESIDE);
  const menu = more.length
    ? `<div class="hx-actions-more"><button type="button" class="hx-btn hx-btn--quiet hx-actions-more-btn" data-corn="more" data-corn-kind="quiet" data-more-toggle aria-expanded="false" aria-label="More actions" title="More actions">⋯</button><div class="hx-actions-menu glass" data-more-menu role="group" aria-label="More actions" hidden>${more.join('')}</div></div>`
    : '';
  const row = first ? `<div class="hx-actions-row">${first}${beside.join('')}${menu}</div>` : '';
  return `<div class="hx-actions" data-corn="actions" role="group" aria-label="Actions">${row}${nextHtml(next)}</div>`;
}

/** The one line under the bar that says what comes before an action can be taken; '' when nothing waits */
export const nextHtml = (words) => (words ? `<p class="hx-next">${esc(words)}</p>` : '');

/**
 * A section of the panel: its title and count on a button that opens and closes it (`aria-expanded`), its body under it. `open` is where it starts: closed unless it holds
 * the action; the browser's memory of it, per kind of node, is put on it once it is drawn (panel-sections.js `applySections`).
 * @param {{ key: string, title: string, count?: number | null, note?: string, body: string, open?: boolean, extra?: string }} s `note`: a few words after the count ("1 failed")
 */
export function sectionHtml({ key, title, count = null, note = '', body, open = false, extra = '' }) {
  const n = Number.isInteger(count) ? ` <span class="hx-sec-count" data-corn="count">${count}</span>` : '';
  const said = note ? ` <span class="hx-sec-note">· ${esc(note)}</span>` : '';
  return `<div class="hx-sec-block hx-psec" data-corn="section" data-sec="${esc(key)}"${extra}>`
    + `<h3 class="hx-sec-title"><button type="button" class="hx-sec-toggle" data-corn-kind="quiet" data-sec-toggle="${esc(key)}" data-sec-default="${open}" aria-expanded="${open}"><span class="hx-sec-name">${esc(title)}</span>${n}${said}</button></h3>`
    + `<div class="hx-sec-body"${open ? '' : ' hidden'}>${body}</div></div>`;
}

/**
 * A node's connections grouped by relation, each group in the order its first row came: `[{ rel, rows }]`.
 * @template {{ rel: string }} T
 * @param {T[]} links
 * @returns {{ rel: string, rows: T[] }[]}
 */
export function groupLinks(links) {
  const groups = new Map();
  for (const l of links || []) {
    if (!groups.has(l.rel)) groups.set(l.rel, []);
    groups.get(l.rel).push(l);
  }
  return [...groups].map(([rel, rows]) => ({ rel, rows }));
}

/** "Discussed in", "Adds": a relation's words at the start of a row */
export const relTitle = (rel) => String(rel).charAt(0).toUpperCase() + String(rel).slice(1);

// ---------------------------------------------------------------------------
//  What the browser remembers: { [kind of node]: { [section]: open } }
// ---------------------------------------------------------------------------

/** What was stored, or nothing remembered (a broken or foreign value reads as nothing) */
export function readPrefs(text) {
  if (typeof text !== 'string' || !text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Whether a kind's section is open: what was remembered, else `fallback` */
export function isOpen(prefs, kind, key, fallback) {
  const k = prefs && Object.hasOwn(prefs, kind) ? prefs[kind] : null;
  return k && typeof k === 'object' && typeof k[key] === 'boolean' ? k[key] : !!fallback;
}

/** The prefs with one section of one kind remembered open or closed (a new object; the old is not changed) */
export function withOpen(prefs, kind, key, open) {
  const was = prefs && Object.hasOwn(prefs, kind) && prefs[kind] && typeof prefs[kind] === 'object' ? prefs[kind] : {};
  return { ...(prefs || {}), [kind]: { ...was, [key]: !!open } };
}

/** The kind of node a panel's memory is kept for: a piece of work's kind ("pull", "proposal"), else the node's type ("service") */
export const panelKind = (node) => (node && typeof node.work === 'string' && node.work ? node.work : node && typeof node.type === 'string' ? node.type : 'node');
