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

/** How long the typing must pause before "No match" is shown: a live region that changed on every key would be read out on every key */
export const NO_MATCH_DELAY_MS = 400;
let pending = null;

/**
 * Sets the status for a search: nothing for an empty query or a match (at once), "No match for …" when the query found
 * no node, once the typing pauses, so a screen reader says it once and not for every letter.
 * @param {string} query the trimmed query
 * @param {boolean} found whether a shown node matched
 */
export function updateSearchStatus(query, found) {
  clearTimeout(pending);
  pending = null;
  if (!query || found) { showSearchStatus(''); return; }
  const text = noMatchText(query);
  pending = setTimeout(() => { pending = null; showSearchStatus(text); }, NO_MATCH_DELAY_MS);
}
