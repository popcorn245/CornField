/**
 * @module explorer/pieces/work-specs
 *
 * The Specs tab: the proposals the server finds, merged into one row each, the number of those that wait on a decision, and a proposal's actions in the node panel. Part of the Work piece (pieces/work.js): `install(ctx)` makes this part's functions for one mount, and hands the ones other parts call
 * to `ctx.fn`; nothing is shared between two mounts.
 */

import { mergeSpecs } from '../proposal-model.js';
import { waiting, specGroups } from '../waiting-model.js';
import { plural, SPECS_POLL_MS } from './work-common.js';
import { escapeHtml as escHtml } from '../../core/text.js';
import { sectionHtml } from '../panel-model.js';

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

  /** The entry of the proposals list a node of the graph is: the open spec PR when it has a number, else the copy that is only a file in a checkout (where Review opens it from) */
  function specEntry(item) {
    const list = specsList();
    const items = list ? list.items : [];
    return items.find((e) => e.slug === item.slug && (item.number ? e.pull && e.pull.number === item.number : !e.pull)) || items.find((e) => e.slug === item.slug) || null;
  }

  /**
   * A proposal's part of the node panel (spec 0015 D4): Review (opens it over the map; Approve and Send back are the review's) is the primary action while it waits on you, Land it
   * while its green spec pull request is all that is left; Start an agent on it when the config lets a run start. Its spec pull request's Land it, Next line, checks, files and build
   * issue follow (pieces/work-prs.js), and what the Work list's card used to say of it: its summary, what it adds, changes and removes, and its scenarios.
   */
  function proposalParts(item) {
    const entry = specEntry(item);
    const source = (entry && entry.source) || item.source || '';
    const pull = Number.isInteger(item.number) ? fn.detailParts({ self: true }) : null;
    const review = `<button type="button" class="hx-btn hx-btn--approve hx-forge-act" data-corn-kind="approve" data-work-action="review" data-slug="${escHtml(item.slug)}" data-source="${escHtml(source)}">Review …</button>`;
    const quietReview = review.replace('hx-btn hx-btn--approve hx-forge-act" data-corn-kind="approve"', 'hx-btn hx-forge-act" data-corn-kind="secondary"');
    const agent = fn.canStartAgent() ? `<button data-corn-kind="secondary" type="button" class="hx-btn hx-forge-act" data-forge-agent="proposal:${escHtml(item.slug)}" aria-label="${escHtml(t('startAgent'))} on proposal ${escHtml(item.slug)}">${escHtml(t('startAgent'))} …</button>` : '';
    // Land it leads once nothing is left to decide and its checks are green; until then Review does, and Land it waits beside it
    const landFirst = !!(pull && pull.land && pull.green && !item.waiting && !pull.next);
    const primary = landFirst ? pull.land : review;
    const others = landFirst ? [quietReview, agent, pull.open] : [pull ? pull.land : '', agent, pull ? pull.open : ''];
    const c = (entry && entry.counts) || {};
    const changes = [c.added ? `+${c.added} added` : '', c.changed ? `~${c.changed} changed` : '', c.removed ? `−${c.removed} removed` : ''].filter(Boolean).join(' · ');
    const lead = entry && (entry.summary || changes)
      ? `<div class="hx-work-lead">${entry.summary ? `<p class="hx-work-sum">${escHtml(entry.summary)}</p>` : ''}${changes ? `<p class="hx-faint hx-work-changes">${escHtml(changes)}</p>` : ''}</div>`
      : '';
    const scenarios = Number.isInteger(c.scenarios)
      ? sectionHtml({ key: 'scenarios', title: 'Scenarios', count: c.scenarios, body: `<p class="hx-faint">${c.scenarios ? `${plural(c.scenarios, 'scenario')} to play. Review plays ${c.scenarios === 1 ? 'it' : 'them'} over the map, step by step.` : 'It has no scenario yet.'}</p>` })
      : '';
    // In spec 0015 D4's order: (Connected is the panel's) its pull request's checks and files, the scenarios, the build issue
    return { primary, others, next: pull ? pull.next : '', notes: `${lead}${pull ? pull.notes : ''}`, sections: [...(pull ? pull.sections : []), scenarios, pull ? pull.build : ''] };
  }

  Object.assign(fn, { specsList, waitingNow, loadSpecs, specsShownWords, readSpecsQuiet, syncSpecsPoll, specEntry, proposalParts });
}
