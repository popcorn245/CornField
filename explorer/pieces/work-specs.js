/**
 * @module explorer/pieces/work-specs
 *
 * The Specs tab: the proposals the server finds, merged into one row each, and the number of those that wait on a decision. Part of the Work piece (pieces/work.js): `install(ctx)` makes this part's functions for one mount, and hands the ones other parts call
 * to `ctx.fn`; nothing is shared between two mounts.
 */

import { mergeSpecs } from '../proposal-model.js';
import { waiting, specGroups } from '../waiting-model.js';
import { plural, SPECS_POLL_MS } from './work-common.js';

export function install(ctx) {
  const { inst, ui, m, fn, $ } = ctx;
  const { announce, t, proposalListing, loadProposalList, setT } = ctx.h;

  /** The proposals the Proposals menu lists (proposal.js reads them), as a list of the panel's own shape; null before the first answer */

  function specsList() {
    const { entries, problem, forgeProblem, at } = proposalListing();
    // One row for a proposal, however many places it is in: its spec PR and the copy in a checkout or a worktree are one (mergeSpecs)
    if (entries && m.merged.entries !== entries) m.merged = { entries, items: mergeSpecs(entries) };
    return entries ? { items: m.merged.items, at: at ? new Date(at).toISOString() : '', rate: '', stale: '', problem: problem || forgeProblem || '' } : null;
  }

  /** What waits on the maintainer now (spec 0010 D1): the specs to decide and the runs that wait on an answer, from what has been read */
  const waitingNow = () => waiting({ specs: specsList() && specsList().items, runs: ui.runs && ui.runs.data ? ui.runs.data.runs : null });

  /** Loads the Specs tab: the proposals the server finds (the list the header's Proposals menu shows, proposal.js); always asked again, worktrees come and go */
  async function loadSpecs(token, quiet) {
    ui.loading = true;
    ui.error = '';
    fn.paint();
    await loadProposalList();
    if (token !== m.listToken) return;
    ui.loading = false;
    const { entries, problem } = proposalListing();
    if (!entries) ui.error = `Could not load the proposals. ${problem || 'cornfield did not answer.'}`;
    if (!quiet) announce(ui.error || specsShownWords());
    fn.paint();
  }

  /** What the Specs tab says when it is read or searched: how many rows show, and how many of them wait on a decision */
  function specsShownWords() {
    const list = fn.current();
    if (!list) return 'Looking for proposals';
    const shown = specGroups(list.items, { query: ui.specQuery }).reduce((n, g) => n + g.shown, 0);
    if (ui.specQuery.trim() && !shown) return `No spec matches ${ui.specQuery.trim()}`;
    const decide = waitingNow().specs;
    return `${plural(shown, 'spec')} shown${decide ? `, ${decide} ${t('toDecide').toLowerCase()}` : ''}`;
  }

  /** Reads the proposals now, quietly (the number and the list follow); one read at a time */
  async function readSpecsQuiet() {
    if (m.specsReading) return;
    m.specsReading = true;
    try { await loadProposalList(); } finally { m.specsReading = false; }
    fn.paintWaiting();
  }

  /** The specs part of the number is read again every `SPECS_POLL_MS`, never while the page is hidden or put away; one timer at most */
  function syncSpecsPoll() {
    if (m.specsTimer || !ui.config) return;
    m.specsTimer = setT(async () => {
      m.specsTimer = 0;
      if (!m.pageAway && !(inst.hidden())) await readSpecsQuiet();
      syncSpecsPoll();
    }, SPECS_POLL_MS);
  }

  Object.assign(fn, { specsList, waitingNow, loadSpecs, specsShownWords, readSpecsQuiet, syncSpecsPoll });
}
