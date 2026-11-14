/**
 * @module explorer/deep-link
 *
 * The link from chat that starts an agent on a proposal (issue #103, docs/agents.md "Deep links"):
 *
 *   ?proposal=<slug>&start=1      the proposal opened (proposal.js) and the Start dialog on it
 *
 * (`?run=`, `?issue=`, `?pr=`, `?thread=` and `?spec=` are the Work view's: work-view.js `followWorkAddress`, spec 0012 D8.)
 * On a phone the proposal bar it opens is expanded. A name that is not there is a line in the bar and said through the live
 * region, never a blank. A link that is followed has its `start` taken out of the address at once, so a reload does not open
 * it again; `?proposal=` stays, as it always has (it follows the open proposal).
 * Without a live sign-in the server asks for it first and returns here with the same query (server/auth.js).
 */

import { announce } from './keyboard.js';
import { isPhone, expandSheet } from './sheets.js';
import { parseProposalQuery } from './proposal-model.js';
import { openProposalStart } from './forge-panel.js';

/** The parameters a followed link gives up */
const SPENT = ['start'];

/**
 * What a query asks for, or null: `?proposal=<slug>&start=1`. A value that cannot be a name is `{ kind, bad: words }`.
 * @param {string} search
 * @returns {{ kind: 'proposal', slug: string } | { kind: string, bad: string } | null}
 */
export function parseDeepLink(search) {
  const params = new URLSearchParams(search || '');
  if (params.get('start') === '1' && params.has('proposal')) {
    const asked = parseProposalQuery(search);
    return asked ? { kind: 'proposal', slug: asked.slug } : { kind: 'proposal', bad: 'That is not a proposal name.' };
  }
  return null;
}

/** Takes the spent parameters out of the address, without a new history entry; the rest stays */
export function cleanAddress() {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  try {
    const params = new URLSearchParams(location.search);
    if (!SPENT.some((k) => params.has(k))) return;
    SPENT.forEach((k) => params.delete(k));
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  } catch { /* the address is a convenience */ }
}

/** A thing the link names that cannot be shown here at all (no forge in the config): said, so the page is not silent */
const unavailable = (words) => { announce(words); return false; };

/**
 * Follows the link in the address, once. Call it after the Work piece and the proposals are set up.
 * @param {{ search?: string, proposalOpened?: boolean, forgeOn?: boolean }} [opts]
 *   `proposalOpened`: what `initProposals()` answered; `forgeOn`: whether `initForgePanel()` found a forge in the config
 * @returns {Promise<boolean>} whether the link was followed to what it names
 */
export async function followDeepLink({ search = typeof location === 'undefined' ? '' : location.search, proposalOpened = false, forgeOn = true } = {}) {
  const link = parseDeepLink(search);
  if (!link) return false;
  cleanAddress();
  if ('bad' in link) return unavailable(link.bad);
  if (link.kind === 'proposal') {
    if (!proposalOpened) {
      // proposal.js has put the reason in the bar (a status region); it is said here too
      const bar = typeof document !== 'undefined' ? document.getElementById('proposal-message') : null;
      return unavailable((bar && bar.textContent) || `There is no proposal called ${link.slug}.`);
    }
    if (!forgeOn) return unavailable('Start an agent needs a forge in the config.');
    if (isPhone()) expandSheet('proposal');
    return openProposalStart(link.slug);
  }
  return false;
}
