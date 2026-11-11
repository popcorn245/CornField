/**
 * @module explorer/search-status
 *
 * The line by the search field that says a search found nothing ("No match for “xyz”"), in a polite live region so a
 * screen reader says it too (F24). Spec 0008 builds the results list; this is only the no-match message.
 * The words are the `searchNoMatch` string; the query goes in as text, never as HTML.
 */

import { t } from './strings.js';

/** The two fields' status lines: the desktop box and the phone's bar */
const IDS = ['search-status', 'mobile-search-status'];

/** "No match for “query”" */
export const noMatchText = (query) => `${t('searchNoMatch')} “${query}”`;

/** Shows `text` by the search field(s); '' clears it */
export function showSearchStatus(text) {
  for (const id of IDS) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
}

/**
 * Sets the status for a search: nothing for an empty query or a match, "No match for …" when the query found no node.
 * @param {string} query the trimmed query
 * @param {boolean} found whether a shown node matched
 */
export function updateSearchStatus(query, found) {
  showSearchStatus(query && !found ? noMatchText(query) : '');
}
