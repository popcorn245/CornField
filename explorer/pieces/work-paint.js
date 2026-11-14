/**
 * @module explorer/pieces/work-paint
 *
 * Drawing the Work list from its state (tabs, counts, filters, the rows) and the node panel's actions for the piece of work it shows. Part of the Work piece (pieces/work.js): `install(ctx)` makes this part's functions for one mount, and hands the ones other parts call
 * to `ctx.fn`; nothing is shared between two mounts.
 */

import { addParts } from '../engine/piece.js';
import { workStatus } from '../agents-model.js';
import { loadingRowsHtml } from '../runs-view.js';
import { STATES, defaultFilters, filterItems, facetsOf, emptyWords } from '../forge-panel-model.js';
import { relativeTime } from '../review-model.js';
import { specGroups, waitingWords, runWaitingOn } from '../waiting-model.js';
import { specGroupsHtml } from '../waiting-view.js';
import { escapeHtml as escHtml } from '../../core/text.js';
import { plural, safeUrl, option } from './work-common.js';

export function install(ctx) {
  const { inst, ui, m, fn, state, root, $ } = ctx;
  const { t, refreshStubs, paintWaitingLine } = ctx.h;

  /** How to find an element of the list or of the node panel's actions again after it is drawn anew, or null */
  function findAgain(el) {
    if (!el || !el.dataset) return null;
    if (el.dataset.workRef) return `[data-work-ref="${el.dataset.workRef}"]`;
    if (el.dataset.forgeNode) return `[data-forge-node="${el.dataset.forgeNode}"]`;
    if (el.dataset.specGroupToggle) return `[data-spec-group-toggle="${el.dataset.specGroupToggle}"]`;
    if (el.dataset.forgeMerge) return '[data-forge-merge]';
    if (el.dataset.forgeSpec) return `[data-forge-spec="${el.dataset.forgeSpec}"]`;
    if (el.dataset.forgeBuild) return `[data-forge-build="${el.dataset.forgeBuild}"]`;
    if (el.dataset.forgeRerun) return `[data-forge-rerun="${el.dataset.forgeRerun}"]`;
    if (el.dataset.forgeAgent) return `[data-forge-agent="${el.dataset.forgeAgent}"]`;
    if (el.dataset.forgeStop) return `[data-forge-stop="${el.dataset.forgeStop}"]`;
    if (el.dataset.forgeRetry) return `[data-forge-retry="${el.dataset.forgeRetry}"]`;
    if (el.dataset.forgeLandingCancel) return '[data-forge-landing-cancel]';
    if (el.dataset.runReply) return `[data-run-reply="${el.dataset.runReply}"]`;
    if (el.dataset.runAnswer) return `[data-run-answer="${el.dataset.runAnswer}"][data-run-id="${el.dataset.runId}"]`;
    if (el.dataset.runTimeline) return `[data-run-timeline="${el.dataset.runTimeline}"]`;
    return null;
  }

  /** Everything the list shows, from `ui` (a row that had the focus has it again), and the node panel's actions */
  function paint() {
    const panel = $('forge-panel');
    if (!panel) return;
    const had = panel.contains(inst.active()) ? inst.active() : null;
    const again = had ? findAgain(had) : null;
    // A list drawn again must not move what the person is looking at: the scroll of the panel stays where it was
    const scroller = panel.querySelector('.hx-forge-body');
    const scrolled = scroller ? scroller.scrollTop : 0;
    draw(panel);
    addParts(panel); // the hooks the panel was just drawn with are parts too
    if (scroller && scrolled && scroller.scrollTop !== scrolled) scroller.scrollTop = scrolled;
    const back = again && panel.querySelector(again);
    if (back && back !== inst.active() && !back.closest('[hidden]')) back.focus();
    // Retry was pressed and its notice is gone (the list is being read again): the focus goes to the list's title, never to the page
    if (had && had.dataset && had.dataset.action === 'retry-forge' && !panel.contains(inst.active())) $('forge-title').focus();
    paintDetail();
  }

  /** What the last drawing of each place of actions was, so a repaint that changes nothing leaves it (and the focus in it) alone */
  const drawn = new WeakMap();

  /**
   * The node panel's actions (`forge-detail`, work-model.js `workPanelHtml`) for the piece of work it shows: a pull request's Land it and checks, a thread's messages, a deploy's
   * restarts, an issue's Start an agent, a proposal's Review, a run's card with its answer field. The focus stays on the control that had it; a reply being typed is kept.
   */
  function paintDetail() {
    const box = $('forge-detail');
    if (!box || !ui.item) return;
    const kind = box.dataset.workKind;
    if (kind !== ui.item.kind) return; // the node panel shows another piece of work than the one read: its own draw comes with `node:painted`
    const had = box.contains(inst.active()) ? inst.active() : null;
    const again = had ? findAgain(had) : null;
    if (kind === 'run') fn.paintRunCard();
    else {
      const body = kind === 'pull' ? fn.detailHtml() : kind === 'thread' ? fn.threadDetailHtml() : kind === 'deploy' ? fn.deployDetailHtml() : kind === 'issue' ? fn.issueActionsHtml(ui.item) : kind === 'proposal' ? `${fn.proposalActionsHtml(ui.item)}${Number.isInteger(ui.item.number) ? fn.detailHtml() : ''}` : '';
      const html = `${noteHtml(kind)}${body}`;
      if (drawn.get(box) !== html) {
        box.innerHTML = html;
        drawn.set(box, html);
        addParts(box);
      }
    }
    const back = again && box.querySelector(again);
    if (back && back !== inst.active() && !back.closest('[hidden]') && !back.disabled) back.focus();
    // A control of a run card that is no longer drawn (the run went on): the focus goes to that run's card, never to the page
    const hadRun = had && !had.isConnected && had.closest('[data-run]');
    if (hadRun && !box.contains(inst.active())) {
      const card = [...box.querySelectorAll('[data-run]')].find((c) => c.dataset.run === hadRun.dataset.run);
      if (card) card.focus();
    }
  }

  /** What the last step the actions took came to (a spec started, a build issue opened: with a link to it), and what the last request of a run said */
  function noteHtml(kind) {
    const note = ui.actNote && ui.actNote.ref === ui.ref && kind !== 'thread' && kind !== 'deploy' && kind !== 'run' ? ui.actNote : null; // a step's note is its piece of work's (a link that found nothing says so in the list)
    const link = note && safeUrl(note.url);
    const done = note ? `<p class="hx-forge-notice${note.ok ? ' hx-forge-notice--ok' : ''}" data-corn="notice"${note.ok ? ' data-corn-state="success"' : ''}>${escHtml(note.text)}${link ? ` <a data-corn="text-link" class="hx-link" href="${escHtml(link)}" target="_blank" rel="noreferrer">Open on ${escHtml(fn.forgeName())} ↗</a>` : ''}</p>` : '';
    const started = ui.runNote && ui.runNote.ref === ui.ref && (kind === 'issue' || kind === 'proposal') ? `<p class="hx-forge-notice${ui.runNote.ok ? ' hx-forge-notice--ok' : ''}" data-corn="notice"${ui.runNote.ok ? ' data-corn-state="success"' : ''}>${escHtml(ui.runNote.text)}</p>` : '';
    return done + started;
  }

  /** The tabs' counts, where there is one: the proposals, the open pull requests and issues and threads, the runs still open */
  function paintCounts() {
    const open = (key) => (ui.lists[key] ? ui.lists[key].items.length : null);
    const specs = fn.specsList() && fn.specsList().items;
    const runs = ui.runs && ui.runs.data ? ui.runs.data.open : null;
    const counts = { specs: specs ? specs.length : null, pulls: open('pulls|open'), issues: open('issues|open'), threads: ui.config && ui.config.threads === false ? null : open('threads|open'), work: runs };
    // What waits on you shows as a filled badge on its tab: Specs the specs to decide, Runs the runs that need an answer (spec 0010 D2); with nothing
    // waiting, the tab shows its plain total like the others. One number a tab, and its name says so.
    const w = fn.waitingNow();
    const share = { specs: w.specs, work: w.runs };
    for (const btn of root.querySelectorAll('#forge-panel [data-forge-kind]')) {
      const kind = btn.dataset.forgeKind;
      const el = btn.querySelector('.hx-forge-count');
      if (!el) continue;
      const waits = share[kind] || 0;
      const n = waits || counts[kind];
      el.hidden = !(kind in counts); // a tab with no count at all (Deploys) shows none; the others hold their width while empty
      el.textContent = n ? String(n) : '';
      // The hook says which it is: a filled badge for what waits on you, a plain count for the total
      el.dataset.corn = waits ? 'waiting-badge' : 'count';
      el.setAttribute('part', el.dataset.corn); // the part follows the hook
      el.classList.toggle('hx-forge-count--waiting', !!waits);
      const label = btn.querySelector('[data-corn-string]');
      if (waits && label) btn.setAttribute('aria-label', `${label.textContent}, ${waitingWords(waits, t)}`); else btn.removeAttribute('aria-label');
    }
  }

  /** The one number, wherever it shows: the tabs' badges, the Work button's, and the browser tab's title; called whenever the specs or the runs were read */
  function paintWaiting() {
    paintCounts();
    paintButton();
    paintTitle();
    paintBarLine();
    refreshStubs();
  }

  /** The proposal bar's line: a run waits on the open proposal (spec 0010 D2) */
  function paintBarLine(open = !!state.proposal) {
    const run = open && state.proposalSlug && ui.runs && ui.runs.data ? runWaitingOn(ui.runs.data.runs, state.proposalSlug) : null;
    paintWaitingLine(run, `${state.proposalSource || ''}/${state.proposalSlug || ''}`);
  }

  /** What waits on you, said to the page: it puts the number before the browser tab's title (the title is the page's, never a piece's) */
  function paintTitle() {
    inst.emit('work:waiting', { total: fn.waitingNow().total });
  }

  /** Says (on the panel's top, for the CSS) that the tabs run on past an edge: a fade shows on that side, so Deploys is not simply missing on a phone */
  let tabsFor = null; // the tab the strip was last scrolled to show: the strip follows the tab that is on (and is left alone while the viewer scrolls it)
  function paintTabsMore() {
    const top = root.querySelector('#forge-panel .hx-forge-top');
    const tabs = top && top.querySelector('.hx-forge-tabs');
    if (!tabs) return;
    // The tab that is on is brought into the strip (Deploys is the sixth: a list opened on it, or a tab pressed, must not leave it under the edge). A strip that is not laid out
    // (the list shut, a phone's sheet in its peek) is asked again when it is
    const active = tabs.clientWidth ? tabs.querySelector('[aria-pressed="true"]') : null;
    if (!tabs.clientWidth) tabsFor = null;
    else if (active && tabsFor !== ui.kind) {
      tabsFor = ui.kind;
      const box = tabs.getBoundingClientRect();
      const at = active.getBoundingClientRect();
      // Clear of the fade the strip puts on an edge it runs on past (css/work.css: one and a half `--corn-space-6`); the first and the last tab go to their end of the strip
      const room = 1.5 * (parseFloat(inst.win.getComputedStyle(tabs).getPropertyValue('--corn-space-6')) || 24);
      const shown = [...tabs.children].filter((c) => !c.hidden);
      if (active === shown[0]) tabs.scrollLeft = 0;
      else if (active === shown[shown.length - 1]) tabs.scrollLeft = tabs.scrollWidth;
      else if (at.left < box.left + room) tabs.scrollLeft += at.left - box.left - room;
      else if (at.right > box.right - room) tabs.scrollLeft += at.right - box.right + room;
    }
    const more = [];
    if (tabs.scrollLeft > 1) more.push('start');
    if (tabs.scrollWidth - tabs.clientWidth - tabs.scrollLeft > 1) more.push('end');
    if (more.length) top.dataset.more = more.join(' '); else delete top.dataset.more;
    // A row given the focus is scrolled clear of the fixed top, never left under it (its height changes with the theme and the width)
    const body = top.parentElement;
    if (body) body.style.scrollPaddingTop = `${top.offsetHeight}px`;
  }

  /** A notice line: its words, and a Retry that reads the tab again (for a failure or an older answer) */
  function setNotice(el, words, retry) {
    el.hidden = !words;
    el.textContent = words;
    if (words && retry) {
      const again = inst.doc.createElement('button');
      again.type = 'button';
      again.className = 'hx-btn hx-forge-act';
      again.dataset.action = 'retry-forge';
      again.dataset.cornKind = 'quiet';
      again.textContent = 'Retry';
      el.append(' ', again);
    }
  }

  function draw(panel) {
    for (const btn of panel.querySelectorAll('[data-forge-kind]')) btn.setAttribute('aria-pressed', String(btn.dataset.forgeKind === (ui.kind === 'notes' ? 'pulls' : ui.kind)));
    paintCounts();
    const notes = ui.kind === 'notes';
    const specs = ui.kind === 'specs';
    $('forge-filters').hidden = notes || ui.kind === 'work' || specs;
    const searchBox = $('forge-specs-search');
    if (searchBox) searchBox.hidden = !specs;
    $('forge-work-filters').hidden = ui.kind !== 'work';
    paintChip();
    $('forge-list').hidden = notes;
    $('forge-notes').hidden = !notes;
    $('notes-open').hidden = ui.kind !== 'pulls';
    $('forge-foot').hidden = notes;
    if (notes) {
      fn.drawNotes();
      return;
    }

    const list = fn.current();
    const work = ui.kind === 'work';
    const groups = work ? fn.groupsShown() : [];
    const shown = list && !work && !specs ? filterItems(list.items, ui.kind, ui.filters) : [];
    const status = $('forge-status');
    if (ui.loading && !list) status.textContent = work ? `Loading the work from ${fn.forgeName()} …` : specs ? 'Looking for proposals …' : `Loading ${fn.kindWords()}s from ${fn.forgeName()} …`;
    else if (!list) status.textContent = '';
    else if (work) status.textContent = workStatus(groups, list.at, m.now());
    else if (specs) status.textContent = `${fn.waitingNow().specs ? `${fn.waitingNow().specs} ${t('toDecide').toLowerCase()} \u00b7 ` : ''}${plural(list.items.length, 'proposal')}${list.at ? `, as of ${relativeTime(list.at, m.now())}` : ''}`;
    else status.textContent = `${shown.length} of ${plural(list.items.length, fn.kindWords())}${list.at ? `, as of ${relativeTime(list.at, m.now())}` : ''}`;

    const notice = $('forge-notice');
    const words = ui.error || (list && list.stale ? `Showing an older answer. ${list.stale}` : '') || (specs && list && list.problem ? `The spec PRs could not be listed: ${list.problem}` : '') || (work && list && list.problem ? `Spec pull requests could not all be read: ${list.problem}` : '') || (ui.kind === 'threads' && list && list.problem ? `Some threads could not all be read: ${list.problem}` : '');
    setNotice(notice, words, !!words);

    const act = $('forge-act-note');
    if (act) {
      act.hidden = !ui.actNote;
      const link = ui.actNote && safeUrl(ui.actNote.url);
      act.className = `hx-forge-notice${ui.actNote && ui.actNote.ok ? ' hx-forge-notice--ok' : ''}`;
      if (ui.actNote && ui.actNote.ok) act.dataset.cornState = 'success'; else delete act.dataset.cornState;
      act.innerHTML = ui.actNote ? `${escHtml(ui.actNote.text)}${link ? ` <a data-corn="text-link" class="hx-link" href="${escHtml(link)}" target="_blank" rel="noreferrer">Open on ${escHtml(fn.forgeName())} ↗</a>` : ''}` : '';
    }

    const rows = $('forge-list');
    const empty = (words) => `<li class="hx-forge-empty hx-faint" data-corn="empty">${escHtml(words)}</li>`;
    rows.setAttribute('aria-busy', String(!!ui.loading && !list));
    // A list that is being read holds its height with rows of the right size, so nothing jumps when the data comes
    // (On Runs the list sits under the runs, whose height is not known yet: rows held there would jump when the runs arrive, so they wait. They
    // are drawn with the work's answer all the same, which loadWork paints only once the runs are read too, failed or not.)
    if (!list) rows.innerHTML = ui.loading && !(work && !(ui.runs && ui.runs.data)) ? loadingRowsHtml(4) : '';
    else if (specs) {
      const groups = specGroups(list.items, { query: ui.specQuery });
      rows.innerHTML = groups.length ? specGroupsHtml(groups, { shown: ui.ref, nowMs: m.now(), draftsOpen: ui.draftsOpen, say: t })
        : list.items.length ? `<li class="hx-forge-empty hx-faint" data-corn="empty">No spec matches \u201c${escHtml(ui.specQuery.trim())}\u201d. <button type="button" class="hx-btn hx-forge-act" data-corn-kind="quiet" data-action="clear-specs-search">Clear the search</button></li>`
          : empty(emptyWords('specs', fn.forgeName()));
    }
    else if (work) rows.innerHTML = groups.length ? fn.groupsHtml(groups) : empty(ui.work.grouped.groups.length ? 'No work matches these filters.' : emptyWords('work', fn.forgeName()));
    else rows.innerHTML = shown.length ? shown.map((i) => fn.itemHtml(i)).join('') : empty(list.items.length ? `No ${fn.kindWords()} matches these filters.` : emptyWords(ui.kind, fn.forgeName()));

    fn.paintIdea();
    $('forge-foot').hidden = $('notes-open').hidden && $('forge-idea').hidden;
    const rate = (list && list.rate) || '';
    $('forge-rate').textContent = rate;
    fn.paintRuns();
    paintButton();
    paintTabsMore();
  }

  /** The toggles that open the list (`data-action="toggle-forge"`: the Work view's List) say whether it is open */
  function paintButton() {
    for (const toggle of root.querySelectorAll('[data-action="toggle-forge"]')) toggle.setAttribute('aria-expanded', String(ui.open));
  }

  /** Whether the Filter chip applies to the view: the proposals and the release notes have nothing to filter */
  const filterable = () => ui.kind !== 'specs' && ui.kind !== 'notes';

  /** How many filters are on: a state other than the default, a label, an author, a search; on Runs, its two checkboxes */
  function activeFilters() {
    if (ui.kind === 'work') return Number(ui.workFilters.agentsOnly) + Number(ui.workFilters.finished);
    if (!filterable()) return 0;
    const f = ui.filters;
    return Number(f.state !== defaultFilters(ui.kind).state) + Number(!!f.label) + Number(!!f.author) + Number(!!f.text);
  }

  /** The Filter chip, its count, and the box behind it */
  function paintChip() {
    const chip = $('forge-filter-chip');
    const box = $('forge-filter-box');
    const on = filterable();
    const n = activeFilters();
    chip.hidden = !on;
    chip.setAttribute('aria-expanded', String(on && ui.filtersOpen));
    chip.setAttribute('aria-label', n ? `Filter, ${plural(n, 'filter')} on` : 'Filter');
    const count = chip.querySelector('.hx-forge-count');
    count.hidden = !n;
    count.textContent = String(n);
    chip.classList.toggle('is-on', n > 0);
    box.hidden = !(on && ui.filtersOpen);
  }

  /** The filters' choices: the states of the kind, the labels and authors of what is loaded */
  function paintFilters() {
    $('forge-filters').hidden = ui.kind === 'work' || !filterable();
    $('forge-work-filters').hidden = ui.kind !== 'work';
    $('forge-work-agents').checked = ui.workFilters.agentsOnly;
    $('forge-work-finished').checked = ui.workFilters.finished;
    if (ui.kind === 'work' || !filterable()) return;
    const items = fn.current() && ui.kind !== 'deploys' ? fn.current().items : [];
    const { labels, authors } = facetsOf(items);
    if (ui.filters.label && !labels.includes(ui.filters.label)) ui.filters.label = '';
    if (ui.filters.author && !authors.includes(ui.filters.author)) ui.filters.author = '';
    $('forge-state').innerHTML = STATES[ui.kind].map(([v, l]) => option(v, l, v === ui.filters.state)).join('');
    $('forge-label').innerHTML = option('', 'Any label', !ui.filters.label) + labels.map((l) => option(l, l, l === ui.filters.label)).join('');
    $('forge-author').innerHTML = option('', 'Anyone', !ui.filters.author) + authors.map((a) => option(a, a, a === ui.filters.author)).join('');
    // A deploy has no labels and no author to pick: its list is filtered by state and the search
    $('forge-label').parentElement.hidden = ui.kind === 'deploys' || ui.kind === 'threads';
    $('forge-author').parentElement.hidden = ui.kind === 'deploys';
    // …and its search reads the workflow, what it ran for, the branch and who started it, not a number or a label
    $('forge-text').placeholder = ui.kind === 'deploys' ? 'Workflow, branch, commit, who' : ui.kind === 'threads' ? 'Title, number, author' : 'Title, number, label';
  }

  Object.assign(fn, { findAgain, paint, paintDetail, paintCounts, paintWaiting, paintBarLine, paintTitle, paintTabsMore, setNotice, draw, paintButton, filterable, activeFilters, paintChip, paintFilters });
}
