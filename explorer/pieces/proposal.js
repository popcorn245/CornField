/**
 * @module explorer/pieces/proposal
 *
 * The proposal's bar as a piece (spec 0011 D3, D4: `corn-proposal`): the open proposal's title and the copy under review, the counts, Before / Diff /
 * After, Whole map, the ⋯ menu with Close, the problems the proposal has, the one line that says why a proposal did not open, and the waiting line
 * (a run waits on the proposal). And, where the host has a place for it, the Proposals menu that lists what the server finds.
 *
 *   mount(root, inst, options) -> { update, destroy, ... }
 *
 * The piece makes its own markup (`markup()`: `bar` and `menu`) and puts it in `root`, or before the nodes `options.slots` names. Opening a proposal is
 * the instance's (engine/proposal.js); this piece shows it, and its buttons ask the engine: Before, Diff, After, Whole map, Close, a row of the menu.
 * It reads no address and writes none. What it tells and asks of its neighbours is listed at the top of engine/proposal.js.
 *
 * @param {ParentNode} root where the elements go when `options.slots` names no place
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst the instance; its map must be made (engine/render.js)
 * @param {{ slots?: { bar?: Node, menu?: Node }, edit?: boolean, inline?: boolean }} [options] `edit: false` leaves out the what-if editor's two buttons (My edits, Edit):
 *   a host without the editor has nothing to put behind them. `inline` is the piece in a box of its own, in a root of its own (`<corn-proposal>`, pieces/around.js): the
 *   bar is a block that fills the box, not a panel over the map: no phone sheet, no Proposals menu, no what-if buttons, its keys and clicks are its own root's, and the picking of an
 *   edge on the map is the scope's (pieces/scope-proposal.js), whose proposal this is
 * @returns {{ update: (props?: { proposal?: string | object | null, source?: string | null, view?: string, slug?: string | null, sha256?: string | null }) => Promise<boolean> | void, destroy: () => void, elements: Element[], renderBar: Function, paintWaitingLine: Function, toggleMenu: Function, closeMenu: Function }}
 *   `update({ proposal })` opens a proposal: a slug (fetched through `inst.fetch`, with `source` to name the copy), or the proposal itself (nothing is fetched:
 *   `slug`, `source` and `sha256` name it); `null` closes it. `update({ view })` switches Before, Diff or After. `update()` draws the bar again.
 */

import { escapeHtml as escHtml } from '../../core/text.js';
import { summarize } from '../../core/proposal.js';
import { PROPOSAL_VIEWS, chipText, barCounts, proposalPanelHtml, yoursText, sourceChip, pullNumberOf, malformedLinkWords } from '../proposal-model.js';
import { reviewWords } from '../review-model.js';
import { waitingLineWords } from '../waiting-model.js';
import { markStateAttr } from '../corn-state.js';
import { looksWith, mapStyleOf } from '../engine/map-style.js';
import { looksFor } from '../scene.js';
import { registerSheet, unregisterSheet, initSheets, collapseSheet } from '../engine/sheets.js';
import { setWholeMap } from '../engine/layers.js';
import { announce } from '../engine/keyboard.js';
import { t } from '../engine/strings.js';
import { credentialed } from '../engine/connection.js';
import { scopeOf, place, addParts } from '../engine/piece.js';
import { onPageClick } from '../engine/roots.js';
import {
  openProposal, showProposal, closeProposal, setProposalView, drawBar, loadProposalList, proposalListing, setMessage, messageOf, bindEdgePicking, pinnedSource,
} from '../engine/proposal.js';

/** The markup of the piece: the bar (a sheet in the dock on a phone), and the Proposals menu the account menu holds. `bar` and `menu` are the two places */
export const markup = ({ edit = true } = {}) => ({
  bar: '<section id="proposal-bar" class="hx-proposal-bar glass" aria-label="Open proposal" hidden data-corn="proposal-bar">'
    + '<p id="proposal-message" class="hx-proposal-message" data-corn="message" role="status" hidden></p>'
    + '<div id="proposal-ways" class="hx-proposal-ways" role="group" aria-label="Ways on" data-corn="proposal-ways" hidden></div>'
    + '<div id="proposal-body">'
    + '<div class="hx-proposal-head" data-corn="proposal-head" role="group" aria-label="Proposal actions">'
    + '<h2 id="proposal-title" class="hx-proposal-name" data-corn="proposal-title"></h2>'
    + '<a id="proposal-source" class="hx-proposal-source" data-corn="proposal-source" hidden></a>'
    + '<div class="hx-proposal-counts">'
    + '<div id="proposal-chip" class="hx-proposal-chip" data-corn="proposal-counts"></div>'
    + '<p id="proposal-peek" class="hx-proposal-peek"></p>'
    + '<button type="button" id="proposal-mode" class="hx-proposal-mode" data-corn="proposal-mode" data-action="toggle-proposal-mode" data-peek-ok aria-expanded="false" aria-controls="proposal-seg" title="Before, Diff or After"></button>'
    + '</div>'
    + '<div id="proposal-seg" class="hx-seg" data-corn="compare" role="group" aria-label="Compare">'
    + '<button data-corn="compare-option" type="button" class="hx-seg-btn" data-action="proposal-view" data-view="before" aria-pressed="false" data-corn-string="before">Before</button>'
    + '<button data-corn="compare-option" type="button" class="hx-seg-btn" data-action="proposal-view" data-view="diff" aria-pressed="true" data-corn-string="diff">Diff</button>'
    + '<button data-corn="compare-option" type="button" class="hx-seg-btn" data-action="proposal-view" data-view="after" aria-pressed="false" data-corn-string="after">After</button>'
    + '</div>'
    + '<div class="hx-proposal-tools">'
    // The review narrows the map to the change; this puts the whole map back, as Diff always was (engine/layers.js setWholeMap). Off at every opening.
    // Its words are "Whole map", which read right pressed or not; its name and tooltip are the full "Show the whole map". On a desk it sits beside
    // the title, so the bar keeps its rows (css/proposal.css)
    + '<button data-corn="whole-map" data-corn-kind="secondary" type="button" id="proposal-whole" class="hx-btn" data-action="proposal-whole" aria-pressed="false" aria-label="Show the whole map" title="Show the whole map" data-peek-ok data-corn-string="wholeMap" data-corn-string-aria-label="showWholeMap">Whole map</button>'
    // The what-if editor's two buttons (whatif.js): My edits is shown only while there are edits
    + (edit ? '<button data-corn-kind="secondary" type="button" id="proposal-myedits" class="hx-btn" aria-pressed="true" data-peek-ok data-corn-string="myEdits" hidden>My edits</button>'
      + '<button data-corn-kind="secondary" type="button" id="proposal-edit" class="hx-btn" aria-expanded="false" aria-controls="whatif" title="Try a change: add a node or an edge, reword a scenario">Edit</button>' : '')
    + '</div>'
    + '<div class="hx-proposal-more">'
    + '<button type="button" id="proposal-more" class="hx-btn hx-btn--icon" data-action="toggle-proposal-more" aria-haspopup="menu" aria-expanded="false" aria-controls="proposal-more-menu" aria-label="More" data-corn-kind="icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg></button>'
    + '<div id="proposal-more-menu" class="hx-proposal-more-menu glass" data-corn="proposal-menu" role="menu" aria-label="More" hidden>'
    + '<button type="button" role="menuitem" class="hx-btn hx-btn--quiet" data-action="close-proposal" title="Close the proposal and go back to the map" data-corn-kind="quiet" data-corn-string="closeProposal">Close</button>'
    + '</div>'
    + '</div>'
    + '</div>'
    + '<details id="proposal-errors" class="hx-proposal-errors" data-corn="proposal-errors" hidden>'
    + '<summary data-corn="summary" id="proposal-errors-count"></summary>'
    + '<ul id="proposal-errors-list"></ul>'
    + '<p class="hx-faint">The map shows what it can.</p>'
    + '</details>'
    + '</div>'
    + '</section>',
  menu: '<div id="proposal-wrap">'
    + '<button type="button" id="proposal-btn" class="hx-account-item" data-action="toggle-proposals-menu" aria-haspopup="true" aria-expanded="false" title="Open a proposal: what a change would add, change and remove" data-corn="proposals-button"><span data-corn-string="proposals">Proposals</span><span class="hx-faint" aria-hidden="true">▾</span></button>'
    + '<div id="proposal-menu" class="hx-menu hx-menu--proposals" hidden data-corn="proposals-menu"></div>'
    + '</div>',
});

/** The problems a proposal has, as the bar lists them (at most `max`, then "and N more") */
export function problemsHtml(errors, max = 8) {
  const shown = errors.slice(0, max).map((e) => `<li>${e.path ? `<code class="hx-code">${escHtml(e.path)}</code> ` : ''}${escHtml(e.message)}</li>`);
  if (errors.length > max) shown.push(`<li class="hx-faint">and ${errors.length - max} more</li>`);
  return shown.join('');
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const safeHref = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

/** Where a proposal in the picker is: "Spec PR #23 (draft) by someone", "In the checkout", "In worktree x" */
function where(entry) {
  if (entry.pull) return `Spec PR #${entry.pull.number}${entry.pull.draft ? ' (draft)' : ''}${entry.pull.author ? ` by ${entry.pull.author}` : ''}`;
  return entry.source === 'checkout' ? 'In the checkout' : `In worktree ${entry.source}`;
}

/** One row of the picker */
export function proposalRowHtml(entry, current) {
  const mine = current && current.slug === entry.slug && current.source === entry.source;
  const head = `<span class="hx-proposal-title">${escHtml(entry.title || entry.slug)}</span>`;
  const meta = [`<span class="hx-proposal-where">${escHtml(where(entry))}</span>`];
  if (entry.spec) meta.push(`<span>spec ${escHtml(entry.spec)}</span>`);
  if (entry.error) {
    return `<div class="hx-proposal-item is-broken" data-corn="row">${head}<span class="hx-proposal-sum hx-error-text">${escHtml(entry.error)}</span><span class="hx-proposal-meta">${meta.join('')}</span></div>`;
  }
  if (entry.counts) meta.push(`<span>${escHtml(chipText(entry.counts))}</span>`);
  const reviewed = reviewWords(entry.review, Date.now()); // "Approved 3 minutes ago", from the listing
  if (reviewed) meta.push(`<span class="hx-proposal-reviewed">${escHtml(reviewed)}</span>`);
  if (entry.errors) meta.push(`<span class="hx-warn">${escHtml(plural(entry.errors, 'problem'))}</span>`);
  return `<button type="button" class="hx-proposal-item${mine ? ' is-current' : ''}" data-action="open-proposal" data-slug="${escHtml(entry.slug)}" data-source="${escHtml(entry.source)}" data-corn="row">${head}${entry.summary ? `<span class="hx-proposal-sum">${escHtml(entry.summary)}</span>` : ''}<span class="hx-proposal-meta">${meta.join('')}</span></button>`;
}

/** Mounts the proposal's bar; see the top of this file */
export function mount(root, inst, options = {}) {
  const { state } = inst;
  const scope = scopeOf(inst);
  const inline = !!options.inline;
  const html = markup({ edit: options.edit !== false && !inline });
  const made = [
    ...place(inst, root, html.bar, options.slots, 'bar'),
    ...(inline ? [] : place(inst, root, html.menu, options.slots, 'menu')),
  ];
  /** What hears the clicks and keys of this piece: the instance's root, which holds the Work panel's Specs list too (cornfield's page), or the box's own root */
  const hear = inline ? root : inst.root;
  /** An element of this piece by id (the piece's own, whatever else the root holds) */
  const own = (id) => {
    for (const el of made) {
      if (el.id === id) return el;
      const found = el.querySelector(`[id="${id}"]`);
      if (found) return found;
    }
    return null;
  };
  scope.keepParts(...made);
  const bar = own('proposal-bar');
  /** The waiting line and the problems list are made later: their hooks get their parts too */
  let waitingEl = null;
  let waitingSaid = null;
  let gone = false;

  // ---------------------------------------------------------------------------
  //  One line in the bar instead of a proposal
  // ---------------------------------------------------------------------------
  function paintMessage({ text, isError, ways }) {
    bar.hidden = false;
    bar.classList.toggle('is-error', isError);
    own('proposal-body').hidden = true;
    const msg = own('proposal-message');
    msg.hidden = false;
    msg.textContent = text;
    const box = own('proposal-ways');
    box.hidden = ways.length === 0;
    box.innerHTML = ways.map((w) => `<button type="button" class="hx-btn" data-action="proposal-way" data-way="${escHtml(w.way)}"${w.slug ? ` data-slug="${escHtml(w.slug)}"` : ''}${w.source ? ` data-source="${escHtml(w.source)}"` : ''} data-peek-ok data-corn-kind="quiet">${escHtml(w.label)}</button>`).join('');
    addParts(box);
  }

  // ---------------------------------------------------------------------------
  //  Which copy is open: the chip after the title
  // ---------------------------------------------------------------------------
  /** The spec PRs read for the chip, by number: `{ pull, checks }` of `GET /api/forge/pulls/<n>`; kept, so a proposal opened again shows it at once and then asks again */
  const pullInfo = inst.slot('proposal-pulls', () => new Map());
  let pullAskedFor = null;

  function paintSource() {
    const chip = own('proposal-source');
    const source = state.proposal ? state.proposalSource : null;
    chip.hidden = !source;
    if (!source) return;
    const n = pullNumberOf(source);
    const known = n ? pullInfo.get(n) : null;
    const listing = proposalListing(inst).entries;
    const entry = n && Array.isArray(listing) ? listing.find((e) => e.slug === state.proposalSlug && e.source === source) : null;
    const words = sourceChip(source, (known && known.pull) || (entry && entry.pull) || null, known ? known.checks : null);
    chip.textContent = words.text;
    if (words.state) chip.dataset.cornState = words.state; else delete chip.dataset.cornState;
    const href = safeHref(words.href);
    if (href) { chip.setAttribute('href', href); chip.setAttribute('target', '_blank'); chip.setAttribute('rel', 'noreferrer'); chip.title = 'Open this pull request'; } else {
      chip.removeAttribute('href'); chip.removeAttribute('target'); chip.removeAttribute('rel'); chip.title = words.label;
    }
    const key = `${source}/${state.proposalSlug}`;
    if (n && pullAskedFor !== key) { pullAskedFor = key; loadPullInfo(n); }
  }

  /** Reads the PR's state and checks once for this opening of the bar (the server keeps its own short cache); a forge that cannot say leaves the chip as it is */
  async function loadPullInfo(n) {
    try {
      const res = await credentialed(inst)(`/api/forge/pulls/${n}`);
      const body = res.ok ? await res.json() : null;
      if (gone) return;
      if (body && body.ok !== false && body.pull) pullInfo.set(n, { pull: body.pull, checks: Array.isArray(body.checks) ? body.checks : null });
      if (body && body.pull && pullNumberOf(state.proposalSource) === n) inst.emit('proposal:pull-head', body.pull.head && typeof body.pull.head.sha === 'string' ? body.pull.head.sha : ''); // what was seen is kept per PR head
    } catch { /* no forge, or not signed in: the chip keeps what it has */ }
    if (!gone && state.proposal && pullNumberOf(state.proposalSource) === n) paintSource();
  }

  // ---------------------------------------------------------------------------
  //  The bar: title, counts chip, Before / Diff / After, problems, Close
  // ---------------------------------------------------------------------------
  function renderBar({ open = !!state.proposal } = {}) {
    bar.hidden = !open;
    if (!open) { closeMore(); toggleMode(false); if (!inline) collapseSheet(inst, 'proposal'); return; }

    bar.classList.remove('is-error');
    own('proposal-message').hidden = true;
    own('proposal-body').hidden = false;
    const p = state.proposal;
    const title = own('proposal-title');
    title.textContent = (p && typeof p.title === 'string' && p.title) || state.proposalSlug || 'Proposal';
    paintSource();
    const summary = (p && typeof p.summary === 'string' && p.summary) || '';
    title.title = summary; // the bar stays one row: the summary is also the title's tooltip, and leads the review column

    const chip = own('proposal-chip');
    // The counts name their lists: the changes part shows the Changes section, "5 scenarios" the Scenarios section (the review column, pieces/changes.js)
    const parts = barCounts(summarize(p));
    chip.innerHTML = parts.map((c) => {
      const dot = c.mark ? `<span class="hx-mark-dot hx-mark-dot--${c.mark}" data-corn="mark-dot"${markStateAttr(c.mark)} aria-hidden="true"></span>` : '';
      if (!c.mark && /scenarios?$/.test(c.text)) return `<button type="button" class="hx-proposal-count" data-action="review-show-scenarios" data-corn-kind="quiet" title="Show the personas and their scenarios">${escHtml(c.text)}</button>`;
      return `<button type="button" class="hx-proposal-count" data-action="review-show-changes" data-corn-kind="quiet" title="Show the list of changes">${dot}${escHtml(c.text)}</button>`;
    }).join('<span class="hx-proposal-sep" aria-hidden="true"> · </span>');
    // The reviewer's own edits are a part of their own, never added to the proposal's numbers (spec 0007 D5)
    const yours = yoursText(state.whatIf && state.whatIf.edits, !!state.whatIfOff);
    if (yours) chip.insertAdjacentHTML('beforeend', `<span class="hx-proposal-sep" aria-hidden="true"> · </span><span class="hx-proposal-count hx-proposal-yours"><span class="hx-mark-dot hx-mark-dot--edit" data-corn="mark-dot" data-corn-state="edit" aria-hidden="true"></span>${escHtml(yours)}</span>`);
    addParts(chip);
    own('proposal-mode').textContent = t(inst, state.proposalView);

    for (const btn of bar.querySelectorAll('[data-action="proposal-view"]')) {
      const on = btn.dataset.view === state.proposalView;
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('is-on', on);
    }

    const whole = own('proposal-whole'); // the switch is the review's: off at every opening, kept across Before, Diff and After
    const on = !!(state.review && state.review.whole);
    whole.setAttribute('aria-pressed', String(on));
    whole.title = t(inst, 'showWholeMap'); // the words are short ("Whole map"); the tooltip says it in full, as its name does
    whole.classList.toggle('hx-btn--active', on);

    const errors = state.proposalErrors || [];
    const box = own('proposal-errors');
    box.hidden = errors.length === 0;
    if (errors.length) {
      own('proposal-errors-count').textContent = `${plural(errors.length, 'problem')} in this proposal`;
      own('proposal-errors-list').innerHTML = problemsHtml(errors);
    }
  }

  // ---------------------------------------------------------------------------
  //  The waiting line: a run waits on the open proposal (spec 0010 D2)
  // ---------------------------------------------------------------------------
  /** The line is its own element, added after the bar's head once, so the bar's own markup is not touched; the runner's words are set as text, never as HTML */
  function waitingLine() {
    const body = own('proposal-body');
    if (waitingEl && waitingEl.isConnected) return waitingEl;
    waitingEl = inst.doc.createElement('p');
    waitingEl.className = 'hx-waiting-line';
    waitingEl.dataset.corn = 'waiting-line';
    waitingEl.setAttribute('part', 'waiting-line');
    waitingEl.dataset.cornState = 'waiting';
    waitingEl.hidden = true;
    waitingEl.innerHTML = '<span data-waiting-words></span> <button type="button" class="hx-btn hx-forge-act" data-waiting-answer data-peek-ok data-corn-kind="secondary"></button>';
    const head = body.querySelector('.hx-proposal-head');
    if (head) head.after(waitingEl); else body.append(waitingEl);
    return waitingEl;
  }

  /**
   * Shows the line for `run` (the run waiting on the open proposal), or hides it for null. The first time a run is shown for a proposal it is said
   * through the live region once; a repaint of the same run says nothing.
   */
  function paintWaitingLine(run, key) {
    const el = waitingLine();
    el.hidden = !run;
    if (!run) { waitingSaid = null; return; }
    const words = waitingLineWords(run);
    el.querySelector('[data-waiting-words]').textContent = words;
    const button = el.querySelector('[data-waiting-answer]');
    button.textContent = t(inst, 'answer');
    button.dataset.waitingAnswer = run.runId;
    button.setAttribute('aria-label', `${t(inst, 'answer')}: ${words}`);
    const said = `${key}|${run.runId}`;
    if (waitingSaid !== said) { waitingSaid = said; announce(inst, words); }
  }

  // ---------------------------------------------------------------------------
  //  The ⋯ menu (a menu button) and the phone's Before / Diff / After switcher
  // ---------------------------------------------------------------------------
  const moreItems = () => [...bar.querySelectorAll('#proposal-more-menu [role="menuitem"]')];
  const moreOpen = () => { const menu = own('proposal-more-menu'); return !!menu && !menu.hidden; };

  /** Closes the ⋯ menu; `refocus` puts focus back on its button (Escape, or a choice made) */
  function closeMore(refocus = false) {
    own('proposal-more-menu').hidden = true;
    const btn = own('proposal-more');
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus();
  }

  function openMore(which = 'first') {
    own('proposal-more-menu').hidden = false;
    own('proposal-more').setAttribute('aria-expanded', 'true');
    const items = moreItems();
    (which === 'last' ? items[items.length - 1] : items[0])?.focus();
  }

  /** On a phone the mode button shows the compare switcher under the counts; from 768px the switcher is always there */
  function toggleMode(force) {
    const on = typeof force === 'boolean' ? force : bar.dataset.modeOpen !== 'true';
    bar.dataset.modeOpen = String(on);
    own('proposal-mode').setAttribute('aria-expanded', String(on));
  }

  function onMoreKey(e) {
    const btn = own('proposal-more');
    if (e.target === btn && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); openMore(e.key === 'ArrowUp' ? 'last' : 'first'); return; }
    if (!moreOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); closeMore(true); return; }
    if (e.key === 'Tab') { closeMore(); return; }
    const items = moreItems();
    const at = items.indexOf(inst.active());
    if (at < 0) return;
    const next = { ArrowDown: (at + 1) % items.length, ArrowUp: (at - 1 + items.length) % items.length, Home: 0, End: items.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    items[next].focus();
  }

  // ---------------------------------------------------------------------------
  //  The picker
  // ---------------------------------------------------------------------------
  const menuOpen = () => { const menu = own('proposal-menu'); return !!menu && !menu.hidden; };

  function closeMenu() {
    const menu = own('proposal-menu');
    if (!menu) return; // a bar in a box of its own has no Proposals menu
    menu.hidden = true;
    own('proposal-btn').setAttribute('aria-expanded', 'false');
  }

  async function toggleMenu() {
    const menu = own('proposal-menu');
    if (!menu) return undefined;
    if (menuOpen()) return closeMenu();
    menu.hidden = false;
    own('proposal-btn').setAttribute('aria-expanded', 'true');
    if (!proposalListing(inst).entries) renderMenu(true);
    await loadProposalList(inst); // always ask again: worktrees come and go
  }

  function renderMenu(loading = false) {
    const menu = own('proposal-menu');
    if (!menu) return;
    const { entries: listing, problem: listingProblem, forgeProblem } = proposalListing(inst);
    const current = state.proposal ? { slug: state.proposalSlug, source: state.proposalSource } : null;
    let body;
    if (loading && !listing) body = '<p class="hx-faint hx-proposal-empty">Looking for proposals …</p>';
    else if (listingProblem) body = `<p class="hx-error-text hx-proposal-empty">The list could not be loaded: ${escHtml(listingProblem)}</p>`;
    else if (!listing || listing.length === 0) body = '<p class="hx-faint hx-proposal-empty">No proposals</p>';
    else body = `<div class="hx-proposal-list" role="list">${listing.map((e) => `<div role="listitem">${proposalRowHtml(e, current)}</div>`).join('')}</div>`;
    const forge = forgeProblem && !listingProblem ? `<p class="hx-error-text hx-proposal-empty">The spec PRs could not be listed: ${escHtml(forgeProblem)}</p>` : '';
    menu.innerHTML = `<div class="hx-menu-title hx-menu-head" data-corn="menu-title"><span>${escHtml(t(inst, 'proposals'))}</span></div>${forge}${body}`;
    addParts(menu);
  }

  // ---------------------------------------------------------------------------
  //  What the buttons do
  // ---------------------------------------------------------------------------
  /** Retry, after a proposal failed to open: the bar is drawn anew either way, so the focus goes somewhere stated, the proposal's name once it opened or the new Retry if it failed again */
  async function retryOpen(slug, source) {
    const opened = await openProposal(inst, slug, source);
    if (gone) return;
    const to = opened ? own('proposal-title') : bar.querySelector('#proposal-ways [data-way="retry"]');
    if (!to) return;
    if (opened) to.tabIndex = -1;
    to.focus();
  }

  /** Close, after a proposal failed to open: the bar goes, and the focus goes to the map, never the page */
  function closeAfterFailure() {
    closeProposal(inst);
    if (state.canvas) state.canvas.focus();
  }

  /** A bad link's way on: the Work panel's Specs tab when there is one, else the header's Proposals menu */
  function openSpecs() {
    if (inst.ask('work:open-specs') === true) return;
    if (!menuOpen()) toggleMenu();
  }

  const ACTIONS = {
    'toggle-proposals-menu': () => toggleMenu(),
    'open-proposal': (el) => openProposal(inst, el.dataset.slug, el.dataset.source || null),
    'close-proposal': () => { closeProposal(inst); if (inline && state.canvas) state.canvas.focus(); }, // the bar is gone with the proposal: the focus goes to the map, never to the page
    'proposal-whole': () => { setWholeMap(inst, !(state.review && state.review.whole)); drawBar(inst); }, // "Show the whole map": announced by engine/layers.js, the focus stays on the switch
    'proposal-view': (el) => { setProposalView(inst, el.dataset.view); toggleMode(false); },
    'toggle-proposal-mode': () => toggleMode(),
    'toggle-proposal-more': () => (moreOpen() ? closeMore() : openMore()),
    'review-show-changes': () => inst.emit('changes:show', 'changes'),
    'review-show-scenarios': () => inst.emit('changes:show', 'scenarios'),
    'proposal-way': (el) => (el.dataset.way === 'open' ? openProposal(inst, el.dataset.slug, el.dataset.source || null) : el.dataset.way === 'retry' ? retryOpen(el.dataset.slug, el.dataset.source || null) : el.dataset.way === 'close' ? closeAfterFailure() : openSpecs()),
  };

  // The root hears every control: the bar's, the menu's and a row of the Work panel's Specs list (`open-proposal`), as the document did
  scope.listen(hear, 'click', (e) => {
    const target = e.target.closest ? e.target.closest('[data-action]') : null;
    const action = target && Object.hasOwn(ACTIONS, target.dataset.action) && ACTIONS[target.dataset.action];
    if (action) action(target);
    // A choice in the ⋯ menu closes it back onto its button (Close may stop at the what-if confirm); a click anywhere else just closes it
    if (moreOpen() && !(target && target.dataset.action === 'toggle-proposal-more')) closeMore(!!(target && target.closest('#proposal-more-menu')));
    // Any click outside the picker closes it
    const wrap = own('proposal-wrap');
    if (menuOpen() && wrap && !wrap.contains(e.target) && !(target && target.dataset.action === 'proposal-way')) closeMenu(); // (a bad link's Specs list opens it from outside)
  });
  // In a box of its own the root hears only the bar's clicks: a click anywhere else in the page (the map, the host's own page, another section) closes the ⋯ menu
  // too, as it does on cornfield's page. Whether it came through this root is marked on its way in, and decided once it has passed (in a host's closed shadow
  // root the document's path stops at that root's host: the Layers menu does the same)
  if (inline) {
    const inside = new WeakSet();
    scope.listen(hear, 'click', (e) => { inside.add(e); }, true);
    scope.own(onPageClick(inst, (e) => { if (moreOpen() && !inside.has(e)) closeMore(); }, { capture: false }));
  }
  // Answer, on the bar's line (a run waits on this proposal): the Work panel opens on that run with its reply field focused (work:answer)
  scope.listen(bar, 'click', (e) => {
    const go = e.target.closest && e.target.closest('[data-waiting-answer]');
    if (go) { e.preventDefault(); e.stopPropagation(); inst.emit('work:answer', { run: go.dataset.waitingAnswer }); }
  }, true);
  // With the Work panel on, its Specs tab lists the proposals: the account menu's Proposals entry is only for a cornfield without it (no forge, or no sign-in)
  const proposalsEntry = (workOn) => { const wrap = own('proposal-wrap'); if (wrap) wrap.hidden = !!workOn; };
  scope.on('work:available', ({ on }) => proposalsEntry(on));
  if (inst.ask('work:on')) proposalsEntry(true); // the Work panel started before this piece was mounted: it said so to nobody
  scope.listen(hear, 'keydown', (e) => {
    if (e.key === 'Escape' && menuOpen()) closeMenu();
    onMoreKey(e);
  });

  // ---------------------------------------------------------------------------
  //  The marks' colours for the legend and the panel (the --hx-mark-* variables), the same the map draws on this ground
  // ---------------------------------------------------------------------------
  function setMarkColours() {
    const el = inst.tokenElement();
    if (!el || !el.style) return;
    const { mark: looks } = looksWith(looksFor(state.theme), mapStyleOf(inst).get()); // the theme's --corn-map-added|changed|removed|edit, when it sets them
    for (const mark of Object.keys(looks)) el.style.setProperty(`--hx-mark-${mark}`, looks[mark].color);
  }
  setMarkColours();
  scope.on('theme', setMarkColours);
  scope.own(mapStyleOf(inst).onChange(() => setMarkColours())); // a theme stylesheet that finishes loading later

  // ---------------------------------------------------------------------------
  //  Following the instance
  // ---------------------------------------------------------------------------
  scope.on('proposal:draw', ({ open }) => renderBar({ open }));
  scope.on('changes:peek', (text) => { own('proposal-peek').textContent = text; }); // the review column's count line, for the phone's peek
  scope.on('proposal:focus-title', () => { const title = own('proposal-title'); title.tabIndex = -1; title.focus(); }); // the decision hands the focus to the proposal's name
  scope.on('proposal:message', (m) => paintMessage(m));
  scope.on('proposal:listing', () => { renderMenu(); if (state.proposal) paintSource(); });
  scope.on('proposal:waiting', ({ run, key }) => paintWaitingLine(run, key));
  scope.on('proposal:waiting-reset', () => { waitingSaid = null; waitingEl = null; });
  scope.on('proposal', ({ change }) => { if (change === 'opened') closeMenu(); });
  if (!inline) {
    scope.own(bindEdgePicking(inst, (target, type, fn) => scope.listen(target, type, fn)));
    initSheets(inst);
    registerSheet(inst, 'proposal', bar, { stub: () => ({ title: (own('proposal-title') && own('proposal-title').textContent) || 'Proposal' }) });
    scope.own(() => unregisterSheet(inst, 'proposal'));
    // What the bar answers its neighbours in a box of one root: the part of the map it covers (the map frames into what is left), where the review column
    // goes (under it, or in its body on a phone), and how far down it reaches (the column starts there)
    scope.on('proposal:covers', () => (bar.hidden || !bar.isConnected ? undefined : { bottom: bar.getBoundingClientRect().bottom }));
    scope.on('proposal:bar-bottom', () => (bar.hidden ? undefined : Math.round(bar.offsetTop + bar.offsetHeight + 8)));
    scope.on('proposal:seat-column', ({ column, phone }) => {
      const body = own('proposal-body');
      if (phone && body) { if (column.parentElement !== body) body.appendChild(column); return true; }
      if (bar.parentElement && column.parentElement !== bar.parentElement) bar.after(column);
      return true;
    });
    const RO = inst.win && inst.win.ResizeObserver;
    if (typeof RO === 'function') { const ro = new RO(() => inst.emit('proposal:bar-resize')); ro.observe(bar); scope.own(() => ro.disconnect()); }
  }
  scope.on('popup:open', () => (moreOpen() ? true : undefined)); // the player's Escape leaves a menu that has its own

  scope.own(() => {
    gone = true;
    made.forEach((el) => el.remove());
  });

  renderBar();
  const said = messageOf(inst);
  if (said && !state.proposal) paintMessage(said);

  return {
    elements: made,
    renderBar: () => drawBar(inst),
    paintWaitingLine,
    toggleMenu,
    closeMenu,
    setMessage: (text, isError, ways) => setMessage(inst, text, isError, ways),
    /** A link whose `proposal` is not a proposal's name: said plainly, with the Specs list (the page calls this for `?proposal=` it cannot read) */
    sayBadLink: (search) => { const bad = malformedLinkWords(search); if (bad) setMessage(inst, bad, true, [{ label: t(inst, 'openSpecsList'), way: 'specs' }]); return !!bad; },
    update(props) {
      if (!props || !('proposal' in props || 'view' in props)) { drawBar(inst); return undefined; }
      let result;
      if ('proposal' in props) {
        const p = props.proposal;
        if (p === null) closeProposal(inst);
        else if (typeof p === 'string') {
          const same = state.proposal && state.proposalSlug === p && (props.source || null) === (state.proposalSource || null) && !!state.proposal;
          result = same ? Promise.resolve(true) : openProposal(inst, p, props.source || null);
        } else if (p && typeof p === 'object') {
          showProposal(inst, p, { slug: props.slug || null, source: props.source || null, pinSource: !!props.source, view: PROPOSAL_VIEWS.includes(props.view) ? props.view : 'diff', sha256: props.sha256 || null });
        }
      }
      if ('view' in props && PROPOSAL_VIEWS.includes(props.view) && !(typeof props.proposal === 'string' && result)) setProposalView(inst, props.view, { quiet: true });
      else if ('view' in props && result) result = result.then((ok) => { if (ok && PROPOSAL_VIEWS.includes(props.view)) setProposalView(inst, props.view, { quiet: true }); return ok; });
      return result;
    },
    pinnedSource: () => pinnedSource(inst),
    destroy: () => scope.destroy(),
  };
}
