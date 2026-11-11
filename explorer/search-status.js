/**
 * @module explorer/search-status
 *
 * The polite live region by each search field (F24): what a screen reader hears of a search. It says "No match for “xyz”" for a query that
 * found nothing (once the typing pauses), and search.js (spec 0008) says the count and the match chosen through it. The region is out of
 * sight: the count in the field and the list under it say it on the screen. The no-match words are the `searchNoMatch` string; the query
 * goes in as text, never as HTML.
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
