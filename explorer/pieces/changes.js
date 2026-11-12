/**
 * @module explorer/pieces/changes
 *
 * The review column as a piece (spec 0011 D3, D4: `corn-changes`), with the scenario player and its checks (spec 0006 D1, D2, D4, D5): while a proposal
 * is open, one panel that holds what the proposal changes and, persona by persona, the scenarios that apply to them, so neither is behind a button. From
 * 768px it is docked on the left of the map, below the proposal bar (400px wide, 320px under 1024), the two lists one under the other; on a phone it is
 * the expanded proposal sheet's body, with a two-part switch at its top (Changes | Scenarios). The decision (pieces/decision.js) is its foot, where the
 * host puts it: the markup keeps a place for it (`<!--corn-piece:decision/foot-->`).
 *
 *   Changes · 6                          one row for each marked node and edge: a button that selects it and frames it
 *   Personas and scenarios · 3           an h4 for each persona, then its scenarios; a scenario is a disclosure
 *     Adult · 1 scenario
 *       ▾ An adult pays for the basket   its steps as a numbered list: who acts, the node, its mark, the text, the verdict
 *   Not in any scenario: Child           the personas on the map that act in no scenario of this proposal
 *
 * Choosing a step opens the player (engine/player.js) paused on it, and the camera goes to the step's node in the part of the map the column leaves free
 * (engine/sheets.js `visibleMapRect`). The list follows the player: its current step is `aria-current="step"`. Focus never falls to the page: a repaint puts
 * it back on the same control, and closing the player gives it to the step it was on.
 *
 * The lists are drawn from `scenario-list-model.js` (pure, tested in Node). Every word a project's files supplied (persona labels, scenario titles, step
 * text) is escaped on the way in; an id that reaches an element id or a `data-*` value is made safe first. What was seen (a tick per scenario) is kept in the
 * browser's storage, per proposal and PR head: information only, never in the review.
 *
 *   mount(root, inst, options) -> { update, destroy, ... }
 *
 * What it follows: `proposal:draw` (the column draws), `proposal:pull-head` (the PR head the record is keyed by), `changes:show` ('changes' | 'scenarios'),
 * `layers` (a step's "Layer off"), `scenario:clear`. What it answers: `changes:opened-line` (title -> "Opened X: 6 changes, 3 scenarios for 2 personas."),
 * `changes:played-line` (-> "2 of 3 scenarios played"). What it says: `changes:paint` (the lists were drawn again: the decision line follows what was
 * played) and `scenario:player` (engine/player.js).
 *
 * @param {ParentNode} root where the column goes when `options.slots` names no place
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst the instance; its map must be made (engine/render.js)
 * @param {{ slots?: { column?: Node }, checker?: object | null }} [options] `checker`: a plugin's checker for the scenarios' permission checks (none: "Not checked")
 * @returns {{ update: (props?: { checker?: object | null }) => void, destroy: () => void, playScenario: Function, stopScenario: Function, getPlayer: Function, elements: Element[] }}
 *   `update({ checker })` hands over the checker; `update()` draws the lists again.
 */

import { escapeHtml as escHtml } from '../../core/text.js';
import { t } from '../engine/strings.js';
import { markStateAttr } from '../corn-state.js';
import { isPhone, expandSheet, PHONE_QUERY, visibleMapRect } from '../engine/sheets.js';
import { pullNumberOf } from '../proposal-model.js';
import { clearSelection } from '../engine/selection.js';
import { onLayersChange } from '../engine/layers.js';
import { createChecks } from '../engine/checks.js';
import { createScenarioPlayer, layersHiding } from '../engine/player.js';
import { buildScenarioList, changeRows, stepSentence, reviewCounts, reviewOpenedWords, seenKey, readSeen, writeSeen } from '../scenario-list-model.js';
import { focusChange } from '../engine/proposal.js';
import { scopeOf, place, addParts } from '../engine/piece.js';

const TAB_KEY = 'cornfield.reviewTab';
/** The narrowest map area that holds the column (400px), the player bar and the node panel (480px) side by side */
const PLAYER_BESIDE_PANEL = 1360;

const asList = (v) => (Array.isArray(v) ? v : []);

/** The markup of the piece: the column. `column` is its one place; it keeps a place of its own for the decision's foot */
export const markup = () => ({
  column: '<aside id="review-column" class="hx-review-column glass" aria-label="Review" data-corn="review-column" hidden>'
    + '<div class="hx-rc-scroll">'
    + '<p id="proposal-summary" class="hx-proposal-summary" hidden></p>'
    + '<div id="review-lists" class="hx-rc-lists"></div>'
    + '</div>'
    + '<!--corn-piece:decision/foot-->'
    + '</aside>',
});

/** "Changes · 6": a dot for the eye and a comma for a screen reader, so the heading reads "Changes, 6" */
const countHeading = (label, n) => `${escHtml(label)}<span aria-hidden="true"> · </span><span class="hx-sr-only">, </span><span data-corn="count">${n}</span>`;

function changeRowHtml(r) {
  const label = `${r.word} ${r.name}, ${r.type}`;
  return `<li><button type="button" class="hx-change-row" data-action="proposal-focus" data-kind="${r.kind}" data-key="${escHtml(r.key)}" data-focus-key="ch:${escHtml(r.kind)}:${escHtml(r.key)}" data-corn="row" aria-label="${escHtml(label)}"><span class="hx-mark-dot hx-mark-dot--${r.mark}" data-corn="mark-dot"${markStateAttr(r.mark)} aria-hidden="true"></span><span class="hx-change-what">${escHtml(r.word)}</span><span class="hx-name">${escHtml(r.name)}</span><span class="hx-faint">${escHtml(r.type)}</span></button></li>`;
}

/** Mounts the review column and the player; see the top of this file */
export function mount(root, inst, options = {}) {
  const { state } = inst;
  const scope = scopeOf(inst);
  const made = place(inst, root, markup().column, options.slots, 'column');
  /** An element of this piece by id */
  const own = (id) => {
    for (const el of made) {
      if (el.id === id) return el;
      const found = el.querySelector(`[id="${id}"]`);
      if (found) return found;
    }
    return null;
  };
  scope.keepParts(...made);
  const col = own('review-column');
  let gone = false;

  const checks = createChecks(inst, { checker: options.checker });
  const player = createScenarioPlayer(inst, scope, checks);
  scope.own(() => checks.close());

  /** What the column shows apart from the proposal: the scenario whose steps are open, the phone's tab, the PR head the record is keyed by */
  const ui = { checks: 0, open: null, tab: null, tabNow: null, tabFor: '', openFor: '', head: '', headFor: '', current: null, lastStep: null, seen: { played: [], read: [] }, seenFor: '', pending: [] };
  const storage = { getItem: (k) => inst.store.get(k), setItem: (k, v) => inst.store.set(k, v) };
  const saved = inst.store.get(TAB_KEY);
  if (saved === 'changes' || saved === 'scenarios') ui.tab = saved;

  // ---------------------------------------------------------------------------
  //  What is shown, from the open proposal
  // ---------------------------------------------------------------------------
  /** The open proposal's scenarios, with the maintainer's what-if edits in */
  const scenariosNow = () => {
    const p = state.effectiveProposal || state.proposal;
    return p && Array.isArray(p.scenarios) ? p.scenarios : [];
  };

  /** The open proposal, as the record and the phone's tab know it: its source and its name */
  const proposalKey = () => `${state.proposalSource || ''}/${state.proposalSlug || ''}`;

  /**
   * The browser key the open proposal's record is kept under, or null while it cannot be known: a PR's copy is kept per PR head,
   * and until the PR has been read its head is not known (what is seen meanwhile is held in memory, then kept under the head)
   */
  function recordKey() {
    if (pullNumberOf(state.proposalSource)) return ui.headFor === proposalKey() && ui.head ? seenKey(state.proposalSource, state.proposalSlug, ui.head) : null;
    return seenKey(state.proposalSource, state.proposalSlug, '');
  }

  /** The record of what this browser saw, read again when the proposal (or its PR head) is another */
  function refreshSeen() {
    const key = recordKey();
    const id = key || `pending:${proposalKey()}`;
    if (ui.seenFor === id) return;
    const was = ui.seenFor;
    ui.seenFor = id;
    if (!key) { ui.seen = { played: [], read: [] }; ui.pending = []; return; }
    ui.seen = readSeen(storage, key);
    // what was seen of this proposal before its PR head was known is kept under the head now
    if (was === `pending:${proposalKey()}`) for (const [scenario, how] of ui.pending) ui.seen = writeSeen(storage, key, scenario, how);
    ui.pending = [];
  }

  /** Adds a scenario to the record: kept in the browser once the key is known, held in memory until then */
  function markSeen(scenarioId, how) {
    refreshSeen();
    if (ui.seenFor.startsWith('pending:')) {
      ui.pending.push([String(scenarioId), how]);
      ui.seen = writeSeen(null, '', scenarioId, how, ui.seen);
    } else ui.seen = writeSeen(storage, ui.seenFor, scenarioId, how);
  }

  /** The PR head the record is keyed by: the bar hands it over when it has read the open proposal's PR */
  function setPullHead(sha) {
    const head = typeof sha === 'string' ? sha : '';
    if (head === ui.head && ui.headFor === proposalKey()) return;
    ui.head = head;
    ui.headFor = proposalKey();
    if (state.proposal) repaint();
  }

  function model() {
    refreshSeen();
    const verdicts = new Map();
    const id = checks.checkedScenarioId();
    if (id !== null) verdicts.set(id, checks.verdicts());
    const proposal = state.effectiveProposal || state.proposal;
    const words = { notChecked: t(inst, 'notChecked') };
    const byId = new Map(state.nodes.map((n) => [n.id, n]));
    const hidden = (nodeId) => byId.has(nodeId) && layersHiding(inst, byId.get(nodeId)).length > 0;
    return buildScenarioList({ scenarios: scenariosNow(), nodes: state.nodes, edges: state.edges, proposal, verdicts, seen: ui.seen, words, hidden });
  }

  /** The proposal's own changes: the reviewer's what-if edits are a group of their own (spec 0007 D5), never counted into them */
  const theirRows = (proposal) => changeRows(state.nodes, state.edges, proposal).filter((r) => r.mark !== 'edit');

  /** What opening a proposal says: "Opened Checkout: 6 changes, 3 scenarios for 2 personas." */
  function openedLine(title) {
    const proposal = state.effectiveProposal || state.proposal;
    return reviewOpenedWords(title, theirRows(proposal).length, model());
  }

  /** The phone's peek line: "6 changes · 3 scenarios for 2 personas" */
  function peekLine() {
    const proposal = state.effectiveProposal || state.proposal;
    return reviewCounts(theirRows(proposal).length, model());
  }

  // ---------------------------------------------------------------------------
  //  Markup
  // ---------------------------------------------------------------------------
  function stepHtml(sc, step, group, total) {
    const current = ui.current && ui.current.index === sc.index && ui.current.step === step.index && ui.current.id === sc.id;
    const pill = step.verdict ? `<span class="hx-step-verdict" data-corn="state-pill" data-tone="${escHtml(step.verdict.tone)}"${step.verdict.state ? ` data-corn-state="${step.verdict.state}"` : ''}>${escHtml(step.verdict.words)}</span>` : '';
    const mark = step.mark ? `<span class="hx-step-mark"><span class="hx-mark-dot hx-mark-dot--${step.mark}" data-corn="mark-dot"${markStateAttr(step.mark)} aria-hidden="true"></span>${escHtml(step.markWord)}</span>` : '';
    const who = step.actorLabel ? `<span class="hx-step-who">As ${escHtml(step.actorLabel)}</span>` : '';
    return `<li><button type="button" class="hx-step" data-corn="step" data-action="scenario-step" data-scenario-index="${sc.index}" data-step-index="${step.index}" data-focus-key="st:${group.key}:${sc.key}:${step.index}" aria-label="${escHtml(stepSentence(step, total))}"${current ? ' aria-current="step"' : ''}>`
      + `<span class="hx-step-n" aria-hidden="true">${step.number}</span><span class="hx-step-body"><span class="hx-step-line">${who}<span class="hx-step-where">${escHtml(step.where)}</span>${mark}${step.layerOff ? '<span class="hx-step-off">Layer off: shown when played</span>' : ''}</span>`
      + `<span class="hx-step-text">${escHtml(step.text)}</span></span>${pill}</button></li>`;
  }

  function scenarioHtml(sc, group) {
    const open = ui.open === sc.id;
    const stepsId = `rc-steps-${group.key}-${sc.key}`;
    const tick = sc.seen ? `<span class="hx-sc-seen" data-seen="${sc.seen}">${sc.seen === 'played' ? '✓ Played' : '✓ Read'}</span>` : '';
    const done = sc.verdictSummary ? ` · ${escHtml(sc.verdictSummary)}` : '';
    // its checks are asked when it is opened, but while another scenario plays the checks are that one's: say so rather than show steps with no verdict
    const waits = open && playingOther(sc.id) && sc.steps.some((st) => st.actor) ? '<p class="hx-faint hx-rc-note hx-sc-waits" data-corn="notice">Not checked while another scenario plays. Close the player, or choose a step here to play this one.</p>' : '';
    return `<li class="hx-sc" data-open="${open}"><button type="button" class="hx-sc-row" data-corn="row" data-action="scenario-open" data-scenario-index="${sc.index}" data-focus-key="sc:${group.key}:${sc.key}" aria-expanded="${open}" aria-controls="${stepsId}">`
      + `<span class="hx-sc-caret" aria-hidden="true">${open ? '▾' : '▸'}</span><span class="hx-sc-main"><span class="hx-sc-title">${escHtml(sc.title)}</span><span class="hx-sc-meta">${escHtml(sc.summary)}${done}</span></span>${tick}</button>${waits}`
      + `<ol class="hx-steps" id="${stepsId}" data-corn="step-list" aria-label="${escHtml(t(inst, 'steps'))}: ${escHtml(sc.title)}"${open ? '' : ' hidden'}>${open ? sc.steps.map((s) => stepHtml(sc, s, group, sc.steps.length)).join('') : ''}</ol></li>`;
  }

  function groupHtml(g) {
    const n = g.scenarios.length;
    const name = g.anyone ? t(inst, 'anyone') : g.label;
    const heading = `${escHtml(name)}<span aria-hidden="true"> · </span><span class="hx-sr-only">, </span>${n} ${n === 1 ? 'scenario' : 'scenarios'}`;
    return `<div class="hx-persona" data-corn="persona-group" data-persona="${escHtml(g.key)}"><h4 class="hx-persona-name">${heading}</h4><ul class="hx-sc-list">${g.scenarios.map((sc) => scenarioHtml(sc, g)).join('')}</ul></div>`;
  }

  /** Everything the two lists say, as markup (the foot is the decision's) */
  function listsHtml() {
    const proposal = state.effectiveProposal || state.proposal;
    const everyRow = changeRows(state.nodes, state.edges, proposal);
    const rows = everyRow.filter((r) => r.mark !== 'edit');
    const mine = everyRow.filter((r) => r.mark === 'edit'); // "Your edits · 1": the first group, not the last row
    const list = model();
    const phone = isPhone(inst);
    // the phone's tab: the reviewer's last choice, or Scenarios when there are any; a proposal with none opens on its changes
    if (ui.tabFor !== proposalKey()) { ui.tabFor = proposalKey(); ui.tabNow = list.total ? (ui.tab || 'scenarios') : 'changes'; }
    const tab = ui.tabNow || 'changes';
    const personas = state.nodes.some((n) => n.type === 'persona');

    const tabs = `<div class="hx-rc-tabs" role="tablist" aria-label="Review" data-corn="tabs"${phone ? '' : ' hidden'}>`
      + `<button type="button" role="tab" id="rc-tab-changes" class="hx-rc-tab" data-corn="tab" data-action="review-tab" data-tab="changes" aria-selected="${tab === 'changes'}" aria-controls="rc-changes" tabindex="${tab === 'changes' ? 0 : -1}">${escHtml(t(inst, 'changes'))} · ${rows.length}</button>`
      + `<button type="button" role="tab" id="rc-tab-scenarios" class="hx-rc-tab" data-corn="tab" data-action="review-tab" data-tab="scenarios" aria-selected="${tab === 'scenarios'}" aria-controls="rc-scenarios" tabindex="${tab === 'scenarios' ? 0 : -1}">${escHtml(t(inst, 'scenarios'))} · ${list.total}</button></div>`;

    const changes = `<section id="rc-changes" class="hx-rc-section" data-corn="proposal-changes"${phone ? ` role="tabpanel" aria-labelledby="rc-tab-changes"${tab === 'changes' ? '' : ' hidden'}` : ' aria-labelledby="rc-changes-h"'}>`
      + `<h3 id="rc-changes-h" class="hx-rc-h" tabindex="-1">${countHeading(t(inst, 'changes'), rows.length)}</h3>`
      + (mine.length ? `<h4 class="hx-rc-sub">${countHeading(t(inst, 'yourEdits'), mine.length)}</h4><ul class="hx-change-list">${mine.map(changeRowHtml).join('')}</ul>` : '')
      + (rows.length ? `<ul class="hx-change-list">${rows.map(changeRowHtml).join('')}</ul>` : '<p class="hx-faint hx-rc-empty">This proposal changes nothing on the map.</p>')
      + '</section>';

    let body;
    if (!list.total) body = '<p class="hx-faint hx-rc-empty">This proposal has no scenarios: there is nothing to walk through, and its changes are all it shows.</p>';
    else {
      body = list.groups.map(groupHtml).join('');
      if (!personas) body += `<p class="hx-faint hx-rc-note">This map has no personas (topology.personas.json), so every scenario is listed under ${escHtml(t(inst, 'anyone'))}.</p>`;
      if (list.coverage) body += `<p class="hx-rc-coverage" data-corn="notice">${escHtml(t(inst, 'notInAnyScenario'))}: ${list.notInAny.map(escHtml).join(', ')}</p>`;
    }
    const scenarios = `<section id="rc-scenarios" class="hx-rc-section" data-corn="scenario-list"${phone ? ` role="tabpanel" aria-labelledby="rc-tab-scenarios"${tab === 'scenarios' ? '' : ' hidden'}` : ' aria-labelledby="rc-scenarios-h"'}>`
      + `<h3 id="rc-scenarios-h" class="hx-rc-h" tabindex="-1">${countHeading(t(inst, 'personasAndScenarios'), list.total)}</h3><div class="hx-rc-sbody">${body}</div></section>`;
    return `${tabs}${changes}${scenarios}`;
  }

  // ---------------------------------------------------------------------------
  //  Painting: focus and scroll survive it
  // ---------------------------------------------------------------------------
  /** Where the column goes: after the proposal bar in the dock from 768px, at the end of the sheet's body on a phone */
  function mountColumn() {
    const dock = inst.el('sheet-dock');
    const body = inst.el('proposal-body');
    if (isPhone(inst) && body) { if (col.parentElement !== body) body.appendChild(col); } else if (dock) {
      const bar = inst.el('proposal-bar');
      if (bar && col.parentElement !== dock) bar.after(col);
    }
    return col;
  }

  /** The column starts under the bar, whatever height the bar has (the counts wrap, the edit controls open): from 768px; a phone's has no place of its own */
  function placeColumn() {
    const bar = inst.el('proposal-bar');
    if (!bar || isPhone(inst) || bar.hidden) return;
    col.style.setProperty('--hx-column-top', `${Math.round(bar.offsetTop + bar.offsetHeight + 8)}px`);
  }

  /** Draws the column for the open proposal, or hides it when none is open */
  function renderColumn() {
    if (gone) return;
    mountColumn();
    const open = !!state.proposal;
    col.hidden = !open;
    if (!open) { ui.open = null; ui.current = null; ui.lastStep = null; closeChecksIfIdle(); const lists = own('review-lists'); if (lists) lists.innerHTML = ''; return; }
    repaint();
    placeColumn();
  }

  /**
   * From 768px both lists share the column's height. The changes take what they need, up to 40% while the scenarios need the rest;
   * when the scenarios are few, the changes take the room they leave (no gap under a short list while the changes scroll). Measured,
   * because the split depends on how tall the scenario list is: the result is two CSS variables on the column.
   */
  function shareRoom() {
    const lists = own('review-lists');
    const sc = own('rc-scenarios');
    if (!lists || !sc || col.hidden || isPhone(inst)) return;
    const h = lists.clientHeight;
    if (!h) return;
    const gap = parseFloat(inst.win.getComputedStyle(lists).rowGap) || 0;
    const head = sc.querySelector('.hx-rc-h');
    const body = sc.querySelector('.hx-rc-sbody');
    const need = Math.ceil((head ? head.offsetHeight + (parseFloat(inst.win.getComputedStyle(head).marginBottom) || 0) : 0) + (body ? body.scrollHeight : 0));
    col.style.setProperty('--hx-scenarios-need', `${need}px`);
    col.style.setProperty('--hx-changes-max', `${Math.floor(Math.max(0.4 * h, h - need - gap))}px`);
  }

  function repaint() {
    const lists = own('review-lists');
    if (gone || !lists || !state.proposal) return;
    // another proposal: nothing of the last one's list is open (two proposals may name a scenario alike)
    if (ui.openFor !== proposalKey()) { ui.openFor = proposalKey(); if (!player.getPlayer()) { ui.open = null; ui.current = null; ui.lastStep = null; } }
    // a scenario that is no longer in the proposal (a what-if edit deleted it) is not open any more
    if (ui.open !== null && !scenariosNow().some((s) => s.id === ui.open)) ui.open = null;
    // an edit to the open scenario (what-if) plans its checks again: the verdicts are of the steps it has now
    const openScenario = ui.open !== null && !player.getPlayer() ? scenariosNow().find((s) => s.id === ui.open) : null;
    if (openScenario && checks.checkedScenarioId() === openScenario.id) checks.open(openScenario, () => repaint());
    const active = inst.active();
    const key = active && lists.contains(active) && active.getAttribute ? active.getAttribute('data-focus-key') : null;
    const scroll = lists.scrollTop;
    lists.innerHTML = listsHtml();
    addParts(lists);
    // the summary leads the column (the bar has it as the title's tooltip)
    const p = state.proposal;
    const summary = own('proposal-summary');
    summary.textContent = (p && typeof p.summary === 'string' && p.summary) || '';
    summary.hidden = !summary.textContent;
    lists.scrollTop = scroll;
    const peek = inst.el('proposal-peek');
    if (peek) peek.textContent = peekLine();
    if (key) {
      const again = [...lists.querySelectorAll('[data-focus-key]')].find((el) => el.getAttribute('data-focus-key') === key);
      if (again) again.focus();
    }
    shareRoom();
    inst.emit('changes:paint');
  }

  // ---------------------------------------------------------------------------
  //  Doing things
  // ---------------------------------------------------------------------------
  const scenarioAt = (el) => scenariosNow()[Number(el.dataset.scenarioIndex)] || null;

  /** Whether a player plays a scenario other than the one a disclosure would check (the checks are the player's then) */
  const playingOther = (id) => { const p = player.getPlayer(); return !!p && p.scenario().id !== id; };

  function closeChecksIfIdle() { if (!player.getPlayer()) checks.close(); }

  /** A scenario's disclosure: opens its steps (asking its checks, once, as one batch) or folds them; one is open at a time */
  function toggleScenario(sc) {
    if (ui.open === sc.id) {
      ui.open = null;
      if (!player.getPlayer()) checks.close();
    } else {
      ui.open = sc.id;
      markSeen(sc.id, 'read');
      if (!playingOther(sc.id)) checks.open(sc, () => repaint());
    }
    repaint();
  }

  /** A step was chosen: the player opens paused on it, the list stays open and the focus stays on the step (on a phone the sheet folds, so the player takes it) */
  function chooseStep(sc, index) {
    ui.open = sc.id;
    // Under 1360px the column, the node panel and the player bar do not fit side by side: the node panel closes, the player takes its room
    const drawer = inst.el('spec-drawer');
    const stage = state.canvas && state.canvas.parentElement;
    if (!isPhone(inst) && drawer && drawer.classList.contains('drawer-open') && stage && stage.clientWidth < PLAYER_BESIDE_PANEL) clearSelection(inst, { source: 'api' });
    player.play(sc, { autoplay: false, step: index, focus: isPhone(inst) });
    repaint();
  }

  function showTab(tab, { focus = false } = {}) {
    ui.tab = tab;
    ui.tabNow = tab;
    ui.tabFor = proposalKey();
    inst.store.set(TAB_KEY, tab);
    repaint();
    if (focus) own(`rc-tab-${tab}`)?.focus();
  }

  /** The counts' parts open their section: the switch moves to it on a phone; from 768px it scrolls into view and takes the focus */
  function showSection(which) {
    if (!state.proposal) return;
    if (isPhone(inst)) { showTab(which); expandSheet(inst, 'proposal'); }
    const section = own(which === 'scenarios' ? 'rc-scenarios' : 'rc-changes');
    const heading = own(which === 'scenarios' ? 'rc-scenarios-h' : 'rc-changes-h');
    if (section && typeof section.scrollIntoView === 'function') section.scrollIntoView({ block: 'start' });
    if (heading) heading.focus();
  }

  scope.listen(col, 'click', (e) => {
    const el = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'scenario-open') { const sc = scenarioAt(el); if (sc) toggleScenario(sc); } else if (action === 'scenario-step') { const sc = scenarioAt(el); if (sc) chooseStep(sc, Number(el.dataset.stepIndex)); } else if (action === 'review-tab') showTab(el.dataset.tab, { focus: false }); else if (action === 'proposal-focus') focusChange(inst, el.dataset.kind, el.dataset.key);
  });
  /** Arrow keys move between the phone's two tabs */
  scope.listen(col, 'keydown', (e) => {
    const tab = e.target.closest ? e.target.closest('[role="tab"]') : null;
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    showTab(tab.dataset.tab === 'changes' ? 'scenarios' : 'changes', { focus: true });
  });

  // ---------------------------------------------------------------------------
  //  The player and the list follow each other
  // ---------------------------------------------------------------------------
  /** Called with each change of the player: the step it is on (null when closed), whether it reached the end */
  function onPlayer(snap) {
    if (!snap) {
      // closed: the list keeps the scenario open, without a current step, and its steps keep their verdicts (the checks are the list's again)
      const sc = ui.open !== null && state.proposal && ui.openFor === proposalKey() ? scenariosNow().find((s) => s.id === ui.open) : null;
      if (sc) checks.open(sc, () => repaint());
      if (ui.current || sc) { ui.current = null; repaint(); }
      return;
    }
    const scenarios = scenariosNow();
    const index = scenarios.findIndex((s) => s.id === snap.id);
    const next = { id: snap.id, index, step: Math.min(snap.index, Math.max(snap.total - 1, 0)) };
    ui.lastStep = next;
    if (snap.done) {
      refreshSeen();
      if (!ui.seen.played.includes(snap.id)) markSeen(snap.id, 'played');
    }
    const same = ui.current && ui.current.id === next.id && ui.current.step === next.step;
    ui.current = next;
    if (ui.open !== snap.id) ui.open = snap.id; // playing a scenario opens its list
    if (!same || snap.done || snap.checks !== ui.checks) { ui.checks = snap.checks; repaint(); }
  }

  /** The step button the player was on, to give the focus back when it closes (a phone's sheet opens again first) */
  function stepToFocus() {
    const at = ui.lastStep;
    if (!at) return null;
    if (isPhone(inst)) expandSheet(inst, 'proposal');
    const lists = own('review-lists');
    return lists ? lists.querySelector(`[data-action="scenario-step"][data-scenario-index="${at.index}"][data-step-index="${at.step}"]`) : null;
  }

  /** The scenario after `id` in the order the list reads (the personas' order, each scenario once), or null at the end of the list */
  function nextScenarioAfter(id) {
    const order = [];
    for (const g of model().groups) for (const sc of g.scenarios) if (!order.includes(sc.id)) order.push(sc.id);
    const at = order.indexOf(id);
    const next = at >= 0 ? order[at + 1] : undefined;
    return next === undefined ? null : scenariosNow().find((s) => String(s.id) === next) || null;
  }

  scope.own(player.onChange(onPlayer));
  player.setCloseFocus(stepToFocus);
  player.setNextScenario(nextScenarioAfter);
  player.setKeepChecksOnClose((id) => ui.open === id && !!state.proposal);
  scope.own(onLayersChange(inst, () => { if (state.proposal) repaint(); })); // a step's "Layer off" follows the Layers menu

  scope.on('proposal:draw', () => renderColumn());
  scope.on('proposal:pull-head', (sha) => setPullHead(sha));
  scope.on('changes:show', (which) => showSection(which));
  const RO = inst.win && inst.win.ResizeObserver;
  const watch = (el, fn) => { if (el && typeof RO === 'function') { const ro = new RO(fn); ro.observe(el); scope.own(() => ro.disconnect()); } };
  watch(inst.el('proposal-bar'), () => placeColumn());
  watch(col, () => shareRoom()); // the window's height changed
  if (inst.win && typeof inst.win.matchMedia === 'function') {
    const mq = inst.win.matchMedia(PHONE_QUERY);
    if (mq && mq.addEventListener) {
      const onPhone = () => { if (state.proposal) renderColumn(); };
      mq.addEventListener('change', onPhone);
      scope.own(() => mq.removeEventListener('change', onPhone));
    }
  }

  scope.own(() => {
    gone = true;
    made.forEach((el) => el.remove());
  });

  renderColumn();

  // The answers the neighbours ask for: the bar's announcement and the decision's line
  scope.on('changes:opened-line', (title) => (state.proposal ? openedLine(title) : undefined));
  scope.on('changes:played-line', () => (state.proposal ? model().playedLine : ''));

  return {
    elements: made,
    playScenario: player.play,
    stopScenario: player.stop,
    clearScenario: player.clear,
    playOutage: player.playOutage,
    getPlayer: player.getPlayer,
    wantsFrames: player.wantsFrames,
    setCloseFocus: player.setCloseFocus,
    setNextScenario: player.setNextScenario,
    setKeepChecksOnClose: player.setKeepChecksOnClose,
    tickScenario: player.tick,
    demo: player.demo,
    layersHiding: (node) => layersHiding(inst, node),
    checks,
    renderColumn,
    shareRoom,
    setPullHead,
    openedLine,
    peekLine,
    update(props) {
      if (props && 'checker' in props) checks.setChecker(props.checker);
      if (state.proposal) repaint();
    },
    destroy: () => scope.destroy(),
  };
}
