/**
 * @module explorer/page-address
 *
 * The address bar, for cornfield's own page (spec 0011 D2): `?proposal=`, `?source=` and `?proposalView=` belong to the page shell, not to a piece. Reading
 * them makes the same calls a host app would make (`openFromAddress`: open this proposal, in this view); writing them follows the instance, which says when a
 * proposal opened, changed view or closed (`keepAddress`). Page code: it reads `location` and writes `history`. (test/explorer/instance-tripwires.test.js
 * holds the pieces and the engine to not doing either.)
 */

import { parseProposalQuery, malformedLinkWords, viewWords } from './proposal-model.js';
import { announce } from './engine/keyboard.js';
import { openProposal, setProposalView, setMessage, pinnedSource, titleOf } from './engine/proposal.js';
import { t } from './engine/strings.js';

/** `?proposal=` (and `source`, `proposalView`) follow the open proposal, without a new history entry; other parameters stay */
function syncAddress(inst) {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  const { state } = inst;
  try {
    const params = new URLSearchParams(location.search);
    ['proposal', 'source', 'proposalView'].forEach((k) => params.delete(k));
    if (state.proposal && state.proposalSlug) {
      params.set('proposal', state.proposalSlug);
      if (pinnedSource(inst) && state.proposalSource) params.set('source', state.proposalSource);
      if (state.proposalView !== 'diff') params.set('proposalView', state.proposalView);
    }
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  } catch { /* the address is a convenience */ }
}

/** The address follows the open proposal: written when the instance says one opened, changed view or closed. Once per instance; returns how to stop. */
export function keepAddress(inst) {
  const mem = inst.slot('page-address', () => ({ off: null }));
  if (mem.off) return mem.off;
  const off = inst.on('proposal', () => syncAddress(inst));
  mem.off = () => { off(); mem.off = null; };
  return mem.off;
}

/**
 * Opens what the address asks for, as a host would: a proposal by name (and the copy and the view), or a line that says the link is not a proposal's name.
 * @returns {Promise<boolean>} whether a proposal from the address opened (false when it asked for none)
 */
export async function openFromAddress(inst, search) {
  const asked = parseProposalQuery(search);
  if (!asked) {
    // A link whose `proposal` is not a proposal's name: said plainly (the value as text, never markup or a link), with the Specs list
    const bad = malformedLinkWords(search);
    if (bad) setMessage(inst, bad, true, [{ label: t(inst, 'openSpecsList'), way: 'specs' }]);
    return false;
  }
  const ok = await openProposal(inst, asked.slug, asked.source);
  if (ok && asked.view) {
    setProposalView(inst, asked.view, { quiet: true });
    announce(inst, `${inst.ask('changes:opened-line', titleOf(inst.state)) || ''} ${viewWords(inst.state.proposalView)}.`);
  }
  return ok;
}
