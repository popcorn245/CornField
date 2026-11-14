/**
 * @module explorer/waiting-view
 *
 * The markup of what is waiting on the maintainer (spec 0010), as strings: the Specs tab's groups with their headers, and the Runs tab's group
 * headings. Pure: no DOM, no clock of its own. Every word from the forge is escaped (a row's own markup is proposal-model.js `specRowHtml`).
 */

import { escapeHtml as escHtml } from '../core/text.js';
import { specRowHtml } from './proposal-model.js';
import { specGroupTitle, runGroupTitle, groupCountWords } from './waiting-model.js';

/**
 * The Specs tab's groups, each a heading with its count and its rows. Drafts past ten rows are folded behind a button on the header
 * (`draftsOpen` says whether the person opened it). With a search, a group's count reads "2 of 6".
 * @param {ReturnType<import('./waiting-model.js').specGroups>} groups
 * @param {{ shown?: string | null, nowMs?: number, draftsOpen?: boolean | null, say?: (key: string) => string }} [opts]
 */
export function specGroupsHtml(groups, { shown = null, nowMs = Date.now(), draftsOpen = null, say } = {}) {
  return groups.map((g) => {
    const id = `spec-group-${g.key}`;
    const words = `${specGroupTitle(g.key, say)} · ${groupCountWords(g)}`;
    const foldable = g.key === 'drafts' && g.total > 10 && g.shown === g.total; // not while a search narrows it: then it is open
    const folded = foldable && (draftsOpen === null ? g.collapsed : !draftsOpen);
    const title = foldable
      ? `<button type="button" class="hx-forge-gtoggle" data-spec-group-toggle="${escHtml(g.key)}" aria-expanded="${!folded}" aria-controls="${id}-list" data-corn-kind="quiet">${escHtml(words)}</button>`
      : escHtml(words);
    const rows = g.rows.map((r) => specRowHtml(r.entry, { shown, nowMs })).join('');
    return `<li class="hx-forge-group hx-spec-group" data-key="${id}" data-corn="spec-group" data-group="${escHtml(g.key)}"><h3 class="hx-forge-gtitle" id="${id}">${title}</h3>`
      + `<ul class="hx-forge-list" id="${id}-list" aria-labelledby="${id}"${folded ? ' hidden' : ''}>${rows}</ul></li>`;
  }).join('');
}

/** The heading that starts a group of the Runs list: "Needs you · 1". It is an item of the flat list (a run's card is never moved into a section) */
export function runGroupHeadingHtml(g, say) {
  const id = `run-group-${g.key}`;
  return `<li class="hx-run-heading" data-key="${id}" data-corn="run-group" data-group="${escHtml(g.key)}"><h4 class="hx-forge-gtitle" id="${id}">${escHtml(`${runGroupTitle(g.key, say)} · ${g.count}`)}</h4></li>`;
}
