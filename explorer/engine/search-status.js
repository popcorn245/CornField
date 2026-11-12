/**
 * @module explorer/engine/search-status
 *
 * The polite live region by each search field (F24), on an instance: what a screen reader hears of a search. Once the typing pauses it says the
 * count ("7 matches") or "No match for “xyz”" (pieces/search.js, spec 0008); a match chosen or "Framed 7 matches" is said by the map's
 * announcer (engine/keyboard.js), once. The region is out of sight: the count in the field and the list under it say it on the screen. The
 * no-match words are the `searchNoMatch` string; the query goes in as text, never as HTML. explorer/search-status.js keeps the old names for the page.
 */

import { t } from './strings.js';

/** The two fields' status lines: the desktop box and the phone's bar */
const IDS = ['search-status', 'mobile-search-status'];

/** How long the typing must pause before what a search found is said: a live region that changed on every key would be read out on every key */
export const NO_MATCH_DELAY_MS = 400;

/** "No match for “query”" */
export const noMatchText = (inst, query) => `${t(inst, 'searchNoMatch')} “${query}”`;

const pendingOf = (inst) => inst.slot('search-status', () => {
  const m = { pending: null };
  inst.own(() => clearTimeout(m.pending));
  return m;
});

/** Writes `text` into the region(s) at once; '' clears them */
function write(inst, text) {
  for (const id of IDS) {
    const el = inst.el(id);
    if (el) el.textContent = text;
  }
}

/** Shows `text` by the search field(s) at once, ending any wait for what the typing found; '' clears it */
export function showSearchStatus(inst, text) {
  const m = pendingOf(inst);
  clearTimeout(m.pending);
  m.pending = null;
  write(inst, text);
}

/**
 * Sets the status for a search as it is typed: cleared at once (an empty query clears it for good), then, once the typing pauses, the
 * count (`count`, "7 matches") for a query that found something, or "No match for …" for one that found nothing; so a screen reader
 * says it once per pause, not for every letter.
 * @param {string} query the trimmed query
 * @param {boolean} found whether a node matched
 * @param {string} [count] what to say when one did (nothing is said without it)
 */
export function updateSearchStatus(inst, query, found, count = '') {
  const m = pendingOf(inst);
  clearTimeout(m.pending);
  m.pending = null;
  write(inst, '');
  const text = !query ? '' : found ? count : noMatchText(inst, query);
  if (!text) return;
  m.pending = setTimeout(() => { m.pending = null; write(inst, text); }, NO_MATCH_DELAY_MS);
}
