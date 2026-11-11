/**
 * @module explorer/search-status
 *
 * The polite live region by each search field (F24): what a screen reader hears of a search. Once the typing pauses it says the count ("7 matches")
 * or "No match for “xyz”" (search.js, spec 0008); a match chosen or "Framed 7 matches" is said by the map's announcer (keyboard.js), once. The region is out of
 * sight: the count in the field and the list under it say it on the screen. The no-match words are the `searchNoMatch` string; the query
 * goes in as text, never as HTML.
 */

import { t } from './strings.js';

/** The two fields' status lines: the desktop box and the phone's bar */
const IDS = ['search-status', 'mobile-search-status'];

/** "No match for “query”" */
export const noMatchText = (query) => `${t('searchNoMatch')} “${query}”`;

/** Writes `text` into the region(s) at once; '' clears them */
function write(text) {
  for (const id of IDS) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
}

/** How long the typing must pause before what a search found is said: a live region that changed on every key would be read out on every key */
export const NO_MATCH_DELAY_MS = 400;
let pending = null;

/** Shows `text` by the search field(s) at once, ending any wait for what the typing found; '' clears it */
export function showSearchStatus(text) {
  clearTimeout(pending);
  pending = null;
  write(text);
}

/**
 * Sets the status for a search as it is typed: cleared at once (an empty query clears it for good), then, once the typing pauses, the
 * count (`count`, "7 matches") for a query that found something, or "No match for …" for one that found nothing; so a screen reader
 * says it once per pause, not for every letter.
 * @param {string} query the trimmed query
 * @param {boolean} found whether a node matched
 * @param {string} [count] what to say when one did (nothing is said without it)
 */
export function updateSearchStatus(query, found, count = '') {
  clearTimeout(pending);
  pending = null;
  write('');
  const text = !query ? '' : found ? count : noMatchText(query);
  if (!text) return;
  pending = setTimeout(() => { pending = null; write(text); }, NO_MATCH_DELAY_MS);
}
