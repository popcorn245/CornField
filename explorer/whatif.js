/**
 * @module explorer/whatif
 *
 * What-if editing on an open proposal (spec 0012 B4, TOPO-11): the controls next to the proposal bar, the drag that draws an
 * edge, the keyboard and localStorage. The maintainer tries a change on top of what the robot proposed: add a node, remove one, draw
 * an edge, remove one, add, reword, reorder or delete a scenario step. The edits are a list of operations kept APART from the robot's
 * proposal (`state.whatIf = { edits, undone }`); the map is drawn from `applyEdits(state.proposal, edits)` and `state.proposal` is
 * never touched. All the deciding (what an intent means, refusing an edit that makes the proposal worse, undo, the mark on the
 * map, the storage format) is whatif-model.js, tested without a page; this file is the half that touches it.
 *
 *   plugs into proposal.js `hooks`: the effective proposal, the edit mark, asking before Close, redrawing with the bar
 *   state.whatIf        { edits, undone }: what is applied, what Undo took back
 *   state.effectiveProposal   what the map is drawn from (proposal.js sets it)
 *   localStorage        `topology-explorer:whatif:<source>/<slug>` -> { version: 1, slug, source, savedAt, edits, undone }
 *
 * For the review step (TOPO-12): `getEdits()` is what goes to the server as `edits`; `clearEdits()` empties the list (and the
 * stored copy) once they are sent; `onEditsChange(fn)` follows the list.
 *
 * The drag that draws an edge listens on the canvas on its own (pointer events, captured on the window so it comes before the
 * map's mouse and touch handlers); it needs nothing from input.js.
 */

import { state, touchScene, onSceneTouch, nameOf, nodeById, escHtml } from './state.js';
import { render, isNodeVisible } from './render.js';
import { hooks, rebuildProposalMap, closeProposal } from './proposal.js';
import { getPlayer, playScenario, stopScenario, tickScenario } from './scenario-ui.js';
import { kindOfMark } from './proposal-model.js';
import { edgeKey } from '../core/proposal.js';
import * as M from './whatif-model.js';

const $ = (id) => document.getElementById(id);

/** What the controls are showing; none of it is saved */
const ui = {
  panel: null, // 'edits' | 'steps' | null: the list that is open under the toolbar
  form: null, // { kind: 'node' } | { kind: 'edge', from, to } | null: the small form that is open
  drawing: false, // "Draw an edge" is on
  confirm: false, // asking whether to keep the edits on Close
  closing: false, // Close was confirmed: let it through
  scenarioId: null, // the scenario the steps list shows ('__new' for a new one)
  stepDraft: '', // the words of the step being typed
  titleDraft: '', // the title of the new scenario being typed
  notice: '', // what happened to the stored edits when this proposal opened
  messages: {}, // inline refusals by place: toolbar, form, steps, drawer
  recentParents: [],
  lastSelected: null,
};

let root = null;
let drawerBox = null;
let loadedFor = null; // the proposal object the edits belong to
let loadedKey = null;
let wired = false;
let saveWarned = false;
const listeners = new Set();

const now = () => Date.now();
const asList = (v) => (Array.isArray(v) ? v : []);
const base = () => ({ nodes: state.baseNodes, edges: state.baseEdges });
const scenariosOf = (p) => (p && Array.isArray(p.scenarios) ? p.scenarios : []);
const keyOf = () => (state.proposalSlug ? M.storageKey(state.proposalSlug, state.proposalSource) : null);
const storage = () => { try { return window.localStorage; } catch { return null; } };
const edgeName = (e) => `${nameOf(e.from)} → ${nameOf(e.to)}`;

// ---------------------------------------------------------------------------
//  The public face (for the review step) and the hooks into proposal.js
// ---------------------------------------------------------------------------

/** The edits that are applied now, oldest first: what a review sends back as `edits` (copies; changing them changes nothing) */
export const getEdits = () => structuredClone(state.whatIf.edits);
/** The proposal the map is drawn from: the robot's with the edits in */
export const getEffectiveProposal = () => state.effectiveProposal || state.proposal;
/** Follows the list of edits: `fn(edits)` after every change. Returns how to stop. */
export function onEditsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Empties the list and the stored copy (once the edits were sent) and draws the proposal as the robot wrote it */
export function clearEdits() {
  if (!state.proposal) return;
  apply({ whatIf: M.emptyWhatIf(), effective: state.proposal });
}

function load(proposal) {
  const key = keyOf();
  loadedFor = proposal;
  loadedKey = key;
  resetUi();
  let stored = M.emptyWhatIf();
  const store = storage();
  if (key && store) {
    try { stored = M.parseStored(store.getItem(key)); } catch { /* storage may refuse; no edits then */ }
  }
  const replayed = M.replay(base(), proposal, stored);
  state.whatIf = replayed.whatIf;
  if (replayed.dropped.length) {
    ui.notice = M.droppedText(replayed.dropped.length);
    save();
  }
}

/** hooks.effective: the proposal the map is drawn from. Loads this proposal's stored edits the first time it is asked about it. */
function effectiveFor(proposal) {
  if (proposal !== loadedFor || keyOf() !== loadedKey) load(proposal);
  return M.evaluate(base(), proposal, state.whatIf.edits).effective;
}

hooks.effective = effectiveFor;
hooks.mark = (applied, effective, proposal) => M.markEdits(applied, proposal, effective);
hooks.beforeClose = () => {
  if (ui.closing || !M.hasEdits(state.whatIf)) return true;
  ui.confirm = true;
  renderUi();
  return false;
};
hooks.closed = () => {
  state.whatIf = M.emptyWhatIf();
  loadedFor = null;
  loadedKey = null;
  resetUi();
  renderUi();
  emit();
};
hooks.bar = () => renderUi();

function resetUi() {
  endGesture();
  setDrawing(false);
  Object.assign(ui, { panel: null, form: null, confirm: false, closing: false, scenarioId: null, stepDraft: '', titleDraft: '', notice: '', messages: {}, lastSelected: null });
}

// ---------------------------------------------------------------------------
//  Saving
// ---------------------------------------------------------------------------

function save() {
  const key = keyOf();
  const store = storage();
  if (!key || !store) return;
  try {
    if (M.hasEdits(state.whatIf)) store.setItem(key, M.serialize(state.whatIf, { slug: state.proposalSlug, source: state.proposalSource, now: now() }));
    else store.removeItem(key);
  } catch {
    if (!saveWarned) {
      saveWarned = true;
      refuse('toolbar', 'This browser would not keep your edits. They last until you close this page.');
    }
  }
}

function emit() {
  for (const fn of listeners) fn(getEdits());
}

// ---------------------------------------------------------------------------
//  Doing things: every change goes through here
// ---------------------------------------------------------------------------

/** Lays a new list of edits over the proposal: saves it, redraws the map, and carries the scenario that is playing along */
function apply({ whatIf, effective }) {
  const before = scenariosOf(state.effectiveProposal);
  state.whatIf = whatIf;
  save();
  rebuildProposalMap(effective);
  const sync = M.scenarioSync(state.scenario ? state.scenario.id : null, before, scenariosOf(effective));
  if (sync.action === 'update') {
    const player = getPlayer();
    if (player) { player.setScenario(sync.scenario); tickScenario(performance.now()); }
  } else if (sync.action === 'stop') stopScenario();
  touchScene();
  render();
  emit();
}

const refuse = (where, text) => {
  ui.messages[where] = text;
  paintMessages();
  return false;
};
const clearMessages = () => { ui.messages = {}; };

/** An intent from a control, as an edit: refused with a message next to the control, or applied */
function doIntent(intent, where) {
  if (!state.proposal) return false;
  const effective = state.effectiveProposal || state.proposal;
  const taken = new Set([...state.baseNodes.map((n) => n.id), ...asList(effective?.nodes?.add).map((n) => n.id)]);
  const edit = M.editFromIntent(intent, { takenIds: taken, scenarios: scenariosOf(effective), now: now() });
  if (edit.error) return refuse(where, edit.error);
  const result = M.tryEdit(base(), state.proposal, state.whatIf, edit);
  if (!result.ok) return refuse(where, result.message);
  clearMessages();
  apply(result);
  return true;
}

export function undoEdit() {
  if (!state.proposal || !M.canUndo(state.whatIf)) return false;
  return step(M.undo(state.whatIf));
}
export function redoEdit() {
  if (!state.proposal || !M.canRedo(state.whatIf)) return false;
  return step(M.redo(state.whatIf));
}
function step(whatIf) {
  clearMessages();
  apply({ whatIf, effective: M.evaluate(base(), state.proposal, whatIf.edits).effective });
  return true;
}

function removeEditAt(index) {
  const result = M.tryRemoveEdit(base(), state.proposal, state.whatIf, index);
  if (!result.ok) return refuse('edits', result.message);
  clearMessages();
  apply(result);
  return true;
}

// ---------------------------------------------------------------------------
//  The toolbar and the panels under it
// ---------------------------------------------------------------------------

function mount() {
  const body = $('proposal-body');
  if (!body) return null;
  if (!root) {
    root = document.createElement('div');
    root.id = 'whatif';
    root.className = 'hx-whatif';
    root.setAttribute('aria-label', 'Try a change');
    root.innerHTML = `
      <div class="hx-whatif-row" role="toolbar" aria-label="Try a change">
        <button type="button" class="hx-btn" data-whatif="add-node" title="Add a node to this proposal">Add a node</button>
        <button type="button" class="hx-btn" data-whatif="draw-edge" aria-pressed="false" title="Drag from one node to another on the map">Draw an edge</button>
        <button type="button" class="hx-btn" data-whatif="undo" title="Undo (Ctrl+Z)">Undo</button>
        <button type="button" class="hx-btn" data-whatif="redo" title="Redo (Ctrl+Shift+Z)">Redo</button>
        <button type="button" class="hx-btn" data-whatif="edits" aria-expanded="false"></button>
        <button type="button" class="hx-btn" data-whatif="steps" aria-expanded="false" title="Add, reword, reorder or delete the steps of a scenario">Steps</button>
      </div>
      <p class="hx-whatif-hint" data-hint hidden>Drag from one node to another. Escape cancels.</p>
      <p class="hx-whatif-msg" data-msg="toolbar" role="status" hidden></p>
      <p class="hx-whatif-notice" data-notice role="status" hidden></p>
      <div class="hx-whatif-panel" data-panel="confirm" hidden></div>
      <div class="hx-whatif-panel" data-panel="form" hidden></div>
      <div class="hx-whatif-panel" data-panel="edits" hidden></div>
      <div class="hx-whatif-panel" data-panel="steps" hidden></div>`;
    body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('submit', onSubmit);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
  }
  return root;
}

const q = (sel) => (root ? root.querySelector(sel) : null);

/** Everything the controls show, from the state. The form and the step list are only drawn again when what they show changed. */
function renderUi() {
  const open = !!state.proposal;
  if (!mount()) return;
  root.hidden = !open;
  if (!open) { paintDrawer(); return; }

  const wi = state.whatIf;
  q('[data-whatif="undo"]').disabled = !M.canUndo(wi);
  q('[data-whatif="redo"]').disabled = !M.canRedo(wi);
  const draw = q('[data-whatif="draw-edge"]');
  draw.setAttribute('aria-pressed', String(ui.drawing));
  draw.classList.toggle('hx-btn--active', ui.drawing);
  q('[data-hint]').hidden = !ui.drawing;
  for (const name of ['edits', 'steps']) {
    const btn = q(`[data-whatif="${name}"]`);
    btn.setAttribute('aria-expanded', String(ui.panel === name));
    btn.classList.toggle('hx-btn--active', ui.panel === name);
  }
  q('[data-whatif="edits"]').textContent = M.editsLabel(wi.edits.length);
  const addNode = q('[data-whatif="add-node"]');
  addNode.classList.toggle('hx-btn--active', ui.form?.kind === 'node');

  const notice = q('[data-notice]');
  notice.hidden = !ui.notice;
  notice.textContent = ui.notice;

  paintConfirm();
  paintForm();
  paintEdits();
  paintSteps();
  paintMessages();
  paintDrawer();
}

/** Puts each inline refusal next to its control (and hides the ones with nothing to say) */
function paintMessages() {
  if (!root) return;
  for (const el of root.querySelectorAll('[data-msg]')) {
    const text = ui.messages[el.dataset.msg] || '';
    el.hidden = !text;
    el.textContent = text;
  }
  if (drawerBox) {
    const el = drawerBox.querySelector('[data-msg]');
    if (el) { el.hidden = !ui.messages.drawer; el.textContent = ui.messages.drawer || ''; }
  }
}

// --- the confirm on Close

function paintConfirm() {
  const box = q('[data-panel="confirm"]');
  box.hidden = !ui.confirm;
  if (!ui.confirm) { box.innerHTML = ''; return; }
  const n = state.whatIf.edits.length;
  box.innerHTML = `
    <p><strong class="hx-strong">Close this proposal?</strong> You have ${n === 1 ? '1 edit' : `${n} edits`} on it. They stay in this browser and come back when you open it again, unless you throw them away.</p>
    <div class="hx-whatif-actions">
      <button type="button" class="hx-btn hx-btn--active" data-whatif="close-keep">Close and keep my edits</button>
      <button type="button" class="hx-btn" data-whatif="close-discard">Close and throw them away</button>
      <button type="button" class="hx-btn hx-btn--quiet" data-whatif="close-cancel">Keep editing</button>
    </div>`;
}

// --- the add-node and add-edge forms

const typeOptions = (selected) => M.NODE_TYPES.map((t) => `<option value="${escHtml(t)}"${t === selected ? ' selected' : ''}>${escHtml(t)}</option>`).join('');

/** The short list the parent is chosen from: the selected node, the ones picked lately, then every app (anything else: click it on the map) */
function parentChoices() {
  const ids = [];
  const add = (id) => { if (id && !ids.includes(id) && nodeById(id)) ids.push(id); };
  if (state.selectedNode) add(state.selectedNode.id);
  ui.recentParents.forEach(add);
  state.nodes.filter((n) => n.type === 'app' && kindOfMark(n) !== 'removed').sort((a, b) => a.label.localeCompare(b.label)).forEach((n) => add(n.id));
  return ids.slice(0, 60);
}

let renderedForm = null;
function paintForm() {
  const box = q('[data-panel="form"]');
  const form = ui.form;
  box.hidden = !form;
  const key = form ? JSON.stringify(form) : '';
  if (key === renderedForm) return;
  renderedForm = key;
  if (!form) { box.innerHTML = ''; hideBand(); return; }

  if (form.kind === 'node') {
    const parent = state.selectedNode ? state.selectedNode.id : '';
    const options = [`<option value="">No parent</option>`, ...parentChoices().map((id) => `<option value="${escHtml(id)}"${id === parent ? ' selected' : ''}>${escHtml(nameOf(id))}</option>`)];
    box.innerHTML = `
      <form class="hx-whatif-form" data-form="node" autocomplete="off">
        <strong class="hx-strong">Add a node</strong>
        <label class="hx-whatif-field">Type <select name="nodeType">${typeOptions('page')}</select></label>
        <label class="hx-whatif-field">Label <input name="label" class="hx-whatif-input" placeholder="/meals" required></label>
        <label class="hx-whatif-field">Parent <select name="parent">${options.join('')}</select></label>
        <p class="hx-faint hx-whatif-help">Click a node on the map to make it the parent. A page label starts with a slash, like /meals.</p>
        <label class="hx-whatif-field">Description <input name="desc" class="hx-whatif-input" placeholder="Optional"></label>
        <div class="hx-whatif-actions">
          <button type="submit" class="hx-btn hx-btn--active">Add node</button>
          <button type="button" class="hx-btn hx-btn--quiet" data-whatif="cancel-form">Cancel</button>
        </div>
        <p class="hx-whatif-msg" data-msg="form" role="alert" hidden></p>
      </form>`;
    box.querySelector('[name="nodeType"]').value = 'page';
    box.querySelector('[name="parent"]').value = parent;
    ui.lastSelected = state.selectedNode ? state.selectedNode.id : null;
  } else {
    const from = nodeById(form.from);
    const to = nodeById(form.to);
    const suggested = M.suggestKind(from && from.type, to && to.type);
    box.innerHTML = `
      <form class="hx-whatif-form" data-form="edge" autocomplete="off">
        <strong class="hx-strong">Draw an edge</strong>
        <p class="hx-whatif-pair"><span class="hx-name">${escHtml(nameOf(form.from))}</span> → <span class="hx-name">${escHtml(nameOf(form.to))}</span></p>
        <label class="hx-whatif-field">Kind <select name="kind">${M.EDGE_CHOICES.map((c) => `<option value="${escHtml(c.value)}"${c.value === suggested ? ' selected' : ''}>${escHtml(c.label)}</option>`).join('')}</select></label>
        <label class="hx-whatif-field" data-flow-field hidden>Flow <select name="flow">${M.FLOW_KINDS.map((f) => `<option value="${escHtml(f)}">${escHtml(f)}</option>`).join('')}</select></label>
        <label class="hx-whatif-field">Label <input name="label" class="hx-whatif-input" placeholder="Optional"></label>
        <div class="hx-whatif-actions">
          <button type="submit" class="hx-btn hx-btn--active">Add edge</button>
          <button type="button" class="hx-btn hx-btn--quiet" data-whatif="cancel-form">Cancel</button>
        </div>
        <p class="hx-whatif-msg" data-msg="form" role="alert" hidden></p>
      </form>`;
    box.querySelector('[name="kind"]').value = suggested;
    syncFlowField();
  }
  paintMessages();
  const first = box.querySelector('input, select');
  if (first && form.kind === 'node' && typeof first.focus === 'function') box.querySelector('[name="label"]').focus();
}

function syncFlowField() {
  const form = q('[data-form="edge"]');
  if (!form) return;
  form.querySelector('[data-flow-field]').hidden = form.elements.kind.value !== 'flow';
}

function openForm(form) {
  ui.form = form;
  delete ui.messages.form;
  if (form.kind === 'node') setDrawing(false);
  renderUi();
}

function closeForm() {
  if (!ui.form) return;
  ui.form = null;
  delete ui.messages.form;
  renderUi();
}

/** The parent select follows a node picked on the map while the add-node form is open */
function followSelection() {
  if (ui.form?.kind !== 'node' || !state.selectedNode || state.selectedNode.id === ui.lastSelected) return;
  ui.lastSelected = state.selectedNode.id;
  const id = state.selectedNode.id;
  ui.recentParents = [id, ...ui.recentParents.filter((x) => x !== id)].slice(0, 4);
  const select = q('[data-form="node"] [name="parent"]');
  if (!select) return;
  if (![...select.options].some((o) => o.value === id)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = nameOf(id);
    select.appendChild(option);
  }
  select.value = id;
}

// --- the edits list

function paintEdits() {
  const box = q('[data-panel="edits"]');
  box.hidden = ui.panel !== 'edits';
  if (ui.panel !== 'edits') return;
  const effective = state.effectiveProposal || state.proposal;
  const words = {
    nameOf,
    scenarioTitle: (id) => (scenariosOf(effective).find((s) => s.id === id) || { title: id }).title,
  };
  const rows = state.whatIf.edits.map((edit, i) => `<li class="hx-whatif-edit"><span class="hx-mark-dot hx-mark-dot--edit"></span><span class="hx-whatif-edit-text">${escHtml(M.describeEdit(edit, words))}</span><button type="button" class="hx-textbtn" data-whatif="remove-edit" data-index="${i}" aria-label="Remove this edit: ${escHtml(M.describeEdit(edit, words))}">Remove</button></li>`);
  box.innerHTML = rows.length
    ? `<ol class="hx-whatif-list">${rows.join('')}</ol><p class="hx-whatif-msg" data-msg="edits" role="status" hidden></p>`
    : '<p class="hx-faint">No edits yet. Add a node, draw an edge or change a step, and it appears here.</p>';
  paintMessages();
}

// --- the steps

const NEW = '__new';

function paintSteps() {
  const box = q('[data-panel="steps"]');
  box.hidden = ui.panel !== 'steps';
  if (ui.panel !== 'steps') return;
  const scenarios = scenariosOf(state.effectiveProposal || state.proposal);
  if (!ui.scenarioId || (ui.scenarioId !== NEW && !scenarios.some((s) => s.id === ui.scenarioId))) ui.scenarioId = scenarios.length ? scenarios[0].id : NEW;
  const scenario = scenarios.find((s) => s.id === ui.scenarioId) || null;
  const playing = state.scenario && scenario && state.scenario.id === scenario.id ? state.scenario.index : -1;
  const target = (s) => (s.node !== undefined ? nameOf(s.node) : s.edge ? edgeName(s.edge) : '');
  const steps = asList(scenario && scenario.steps);

  const rows = steps.map((s, i) => `
    <li class="hx-whatif-step${i === playing ? ' is-current' : ''}" data-step="${i}">
      <button type="button" class="hx-whatif-num" data-whatif="go-step" data-index="${i}" title="Show this step on the map" aria-label="Show step ${i + 1} on the map">${i + 1}</button>
      <span class="hx-whatif-stepbody">
        <input class="hx-whatif-input" data-step-text="${i}" value="${escHtml(s.text || '')}" aria-label="Step ${i + 1}: what happens">
        <span class="hx-faint hx-whatif-target">${escHtml(target(s))}</span>
      </span>
      <button type="button" class="hx-textbtn" data-whatif="step-up" data-index="${i}" aria-label="Move step ${i + 1} up"${i === 0 ? ' disabled' : ''}>↑</button>
      <button type="button" class="hx-textbtn" data-whatif="step-down" data-index="${i}" aria-label="Move step ${i + 1} down"${i === steps.length - 1 ? ' disabled' : ''}>↓</button>
      <button type="button" class="hx-textbtn" data-whatif="step-delete" data-index="${i}" aria-label="Delete step ${i + 1}">✕</button>
    </li>`);

  box.innerHTML = `
    <div class="hx-whatif-form">
      <div class="hx-whatif-actions">
        <label class="hx-whatif-field">Scenario <select data-scenario-select>${scenarios.map((s) => `<option value="${escHtml(s.id)}"${s.id === ui.scenarioId ? ' selected' : ''}>${escHtml(s.title)}</option>`).join('')}<option value="${NEW}"${ui.scenarioId === NEW ? ' selected' : ''}>New scenario…</option></select></label>
        ${scenario ? '<button type="button" class="hx-btn" data-whatif="play-scenario">Play</button>' : ''}
      </div>
      ${rows.length ? `<ol class="hx-whatif-list hx-whatif-steps">${rows.join('')}</ol>` : '<p class="hx-faint">No steps yet.</p>'}
      <form class="hx-whatif-addstep" data-form="step" autocomplete="off">
        ${ui.scenarioId === NEW ? `<label class="hx-whatif-field">Title <input name="title" class="hx-whatif-input" placeholder="Add a meal" value="${escHtml(ui.titleDraft)}"></label>` : ''}
        <label class="hx-whatif-field">New step <input name="text" class="hx-whatif-input" placeholder="What happens here?" value="${escHtml(ui.stepDraft)}"></label>
        <button type="submit" class="hx-btn hx-btn--active" data-step-add>Add step</button>
        <span class="hx-faint hx-whatif-pointing" data-step-target></span>
      </form>
      <p class="hx-whatif-msg" data-msg="steps" role="alert" hidden></p>
    </div>`;
  paintStepTarget();
  paintMessages();
}

/** What a new step would point at: the node or edge selected on the map */
function selectionTarget() {
  if (state.selectedEdge) return { edge: { from: state.selectedEdge.from, to: state.selectedEdge.to, kind: state.selectedEdge.kind, flow: state.selectedEdge.flow }, name: edgeName(state.selectedEdge) };
  if (state.selectedNode) return { node: state.selectedNode.id, name: nameOf(state.selectedNode.id) };
  return null;
}

function paintStepTarget() {
  const el = q('[data-step-target]');
  if (!el) return;
  const t = selectionTarget();
  el.textContent = t ? `Points at ${t.name}` : 'Pick a node or an edge on the map first.';
}

// ---------------------------------------------------------------------------
//  The side panel: remove what is selected
// ---------------------------------------------------------------------------

function mountDrawerBox() {
  if (drawerBox && drawerBox.isConnected) return drawerBox;
  const meta = $('drawer-meta-list');
  const block = meta && meta.closest('.hx-block');
  if (!block || !block.parentElement) return null;
  drawerBox = document.createElement('div');
  drawerBox.id = 'whatif-drawer';
  drawerBox.className = 'hx-block hx-whatif-drawer';
  drawerBox.hidden = true;
  block.parentElement.insertBefore(drawerBox, block);
  drawerBox.addEventListener('click', onClick);
  return drawerBox;
}

/** The index of the edit that removed this node or edge, so "Bring it back" can take it out of the list */
function removalIndex(op, match) {
  for (let i = state.whatIf.edits.length - 1; i >= 0; i--) {
    const e = state.whatIf.edits[i];
    if (e.op === op && match(e)) return i;
  }
  return -1;
}

function paintDrawer() {
  const box = mountDrawerBox();
  if (!box) return;
  const open = !!state.proposal && (!!state.selectedNode || !!state.selectedEdge);
  box.hidden = !open;
  if (!open) { box.innerHTML = ''; return; }

  const message = '<p class="hx-whatif-msg" data-msg="drawer" role="alert" hidden></p>';
  const title = '<h3 class="hx-block-title">Try a change</h3>';
  if (state.selectedEdge) {
    const e = state.selectedEdge;
    const key = edgeKey(e);
    if (kindOfMark(e) === 'removed' && e.mark !== 'edit') { box.hidden = true; return; } // the proposal's own removal: not for an edit to undo
    if (e.mark === 'edit' && e.editOp === 'removed') {
      const i = removalIndex('remove-edge', (x) => edgeKey(x) === key);
      box.innerHTML = `${title}<p class="hx-faint">You removed this edge.</p><button type="button" class="hx-btn" data-whatif="bring-back" data-index="${i}"${i < 0 ? ' disabled' : ''}>Bring it back</button>${message}`;
    } else {
      box.innerHTML = `${title}<button type="button" class="hx-btn" data-whatif="remove-edge" data-from="${escHtml(e.from)}" data-to="${escHtml(e.to)}" data-kind="${escHtml(e.kind || '')}" data-flow="${escHtml(e.flow || '')}" title="Take this edge out of the proposal's map">Remove in this proposal</button>${message}`;
    }
    paintMessages();
    return;
  }

  const n = state.selectedNode;
  if (n.mark === 'removed') { box.hidden = true; return; } // the proposal's own removal
  if (n.mark === 'edit' && n.editOp === 'removed') {
    const i = removalIndex('remove-node', (x) => x.id === n.id);
    box.innerHTML = `${title}<p class="hx-faint">You removed this node.</p><button type="button" class="hx-btn" data-whatif="bring-back" data-index="${i}"${i < 0 ? ' disabled' : ''}>Bring it back</button>${message}`;
    paintMessages();
    return;
  }
  const edges = state.edges.filter((e) => (e.from === n.id || e.to === n.id) && kindOfMark(e) !== 'removed');
  const shown = edges.slice(0, 30);
  const rows = shown.map((e) => `<li class="hx-whatif-edit"><span class="hx-whatif-edit-text">${escHtml(edgeName(e))} <span class="hx-faint">${escHtml(e.kind === 'flow' ? `flow, ${e.flow}` : e.kind || 'ownership')}</span></span><button type="button" class="hx-textbtn" data-whatif="remove-edge" data-from="${escHtml(e.from)}" data-to="${escHtml(e.to)}" data-kind="${escHtml(e.kind || '')}" data-flow="${escHtml(e.flow || '')}" aria-label="Remove the edge ${escHtml(edgeName(e))}">Remove</button></li>`);
  const help = n.mark === 'edit' || n.mark === 'added' ? 'Takes it out of this proposal, with whatever hangs on it.' : 'Shows the map without it.';
  box.innerHTML = `${title}
    <button type="button" class="hx-btn" data-whatif="remove-node" data-id="${escHtml(n.id)}" title="${escHtml(help)}">Remove in this proposal</button>
    ${edges.length ? `<details class="hx-whatif-edges"><summary>Its edges (${edges.length})</summary><ul class="hx-whatif-list">${rows.join('')}</ul>${edges.length > shown.length ? `<p class="hx-faint">and ${edges.length - shown.length} more</p>` : ''}</details>` : ''}
    ${message}`;
  paintMessages();
}

// ---------------------------------------------------------------------------
//  Clicks, forms, typing
// ---------------------------------------------------------------------------

function setPanel(name) {
  ui.panel = ui.panel === name ? null : name;
  delete ui.messages.edits;
  renderUi();
}

const ACTIONS = {
  'add-node': () => (ui.form?.kind === 'node' ? closeForm() : openForm({ kind: 'node' })),
  'draw-edge': () => { setDrawing(!ui.drawing); if (ui.drawing && ui.form?.kind === 'node') ui.form = null; renderUi(); },
  undo: () => undoEdit(),
  redo: () => redoEdit(),
  edits: () => setPanel('edits'),
  steps: () => setPanel('steps'),
  'cancel-form': () => { closeForm(); if (ui.drawing) setDrawing(false); renderUi(); },
  'remove-edit': (el) => removeEditAt(Number(el.dataset.index)),
  'remove-node': (el) => doIntent({ type: 'remove-node', id: el.dataset.id }, 'drawer'),
  'remove-edge': (el) => doIntent({ type: 'remove-edge', edge: { from: el.dataset.from, to: el.dataset.to, kind: el.dataset.kind || undefined, flow: el.dataset.flow || undefined } }, 'drawer'),
  'bring-back': (el) => (Number(el.dataset.index) >= 0 ? removeEditAt(Number(el.dataset.index)) : false),
  'close-keep': () => { ui.closing = true; ui.confirm = false; closeProposal(); },
  'close-discard': () => {
    const key = keyOf();
    const store = storage();
    if (key && store) { try { store.removeItem(key); } catch { /* nothing kept either way */ } }
    ui.closing = true;
    ui.confirm = false;
    closeProposal();
  },
  'close-cancel': () => { ui.confirm = false; renderUi(); },
  'step-up': (el) => doIntent({ type: 'move-step', scenario: ui.scenarioId, from: Number(el.dataset.index), to: Number(el.dataset.index) - 1 }, 'steps'),
  'step-down': (el) => doIntent({ type: 'move-step', scenario: ui.scenarioId, from: Number(el.dataset.index), to: Number(el.dataset.index) + 1 }, 'steps'),
  'step-delete': (el) => doIntent({ type: 'delete-step', scenario: ui.scenarioId, index: Number(el.dataset.index) }, 'steps'),
  'go-step': (el) => goToStep(Number(el.dataset.index)),
  'play-scenario': () => {
    const scenario = scenariosOf(state.effectiveProposal || state.proposal).find((s) => s.id === ui.scenarioId);
    if (scenario) playScenario(scenario);
  },
};

function onClick(e) {
  const el = e.target.closest ? e.target.closest('[data-whatif]') : null;
  const action = el && ACTIONS[el.dataset.whatif];
  if (!action || el.disabled) return;
  action(el);
}

function goToStep(index) {
  const scenario = scenariosOf(state.effectiveProposal || state.proposal).find((s) => s.id === ui.scenarioId);
  if (!scenario) return;
  let player = getPlayer();
  if (!player || !state.scenario || state.scenario.id !== scenario.id) player = playScenario(scenario, { autoplay: false });
  player.goTo(index);
  tickScenario(performance.now());
  touchScene();
  render();
  renderUi();
}

function onSubmit(e) {
  const form = e.target.closest ? e.target.closest('form') : null;
  if (!form) return;
  e.preventDefault();
  const data = new FormData(form);
  const get = (name) => String(data.get(name) ?? '');
  if (form.dataset.form === 'node') {
    if (doIntent({ type: 'add-node', nodeType: get('nodeType'), label: get('label'), parent: get('parent'), desc: get('desc') }, 'form')) {
      if (get('parent')) ui.recentParents = [get('parent'), ...ui.recentParents.filter((x) => x !== get('parent'))].slice(0, 4);
      ui.form = null;
      renderUi();
    }
  } else if (form.dataset.form === 'edge') {
    if (doIntent({ type: 'add-edge', from: ui.form.from, to: ui.form.to, kind: get('kind'), flow: get('flow'), label: get('label') }, 'form')) {
      ui.form = null;
      setDrawing(false);
      renderUi();
    }
  } else if (form.dataset.form === 'step') {
    const target = selectionTarget();
    const intent = { type: 'add-step', scenario: ui.scenarioId === NEW ? null : ui.scenarioId, title: get('title'), text: get('text'), ...(target && target.node ? { node: target.node } : target ? { edge: target.edge } : {}) };
    if (doIntent(intent, 'steps')) {
      const edit = state.whatIf.edits[state.whatIf.edits.length - 1];
      ui.scenarioId = edit.scenario;
      ui.stepDraft = '';
      ui.titleDraft = '';
      renderUi();
    }
  }
}

function onChange(e) {
  const t = e.target;
  if (t.matches && t.matches('[data-form="edge"] [name="kind"]')) return syncFlowField();
  if (t.matches && t.matches('[data-form="node"] [name="nodeType"]')) {
    const label = q('[data-form="node"] [name="label"]');
    if (label) label.placeholder = t.value === 'page' ? '/meals' : 'Name';
    return undefined;
  }
  if (t.matches && t.matches('[data-scenario-select]')) {
    ui.scenarioId = t.value;
    delete ui.messages.steps;
    return renderUi();
  }
  if (t.dataset && t.dataset.stepText !== undefined) {
    const index = Number(t.dataset.stepText);
    const was = asList(scenariosOf(state.effectiveProposal || state.proposal).find((s) => s.id === ui.scenarioId)?.steps)[index];
    if (was && was.text === t.value.trim()) return undefined;
    if (!doIntent({ type: 'reword-step', scenario: ui.scenarioId, index, text: t.value }, 'steps')) t.value = was ? was.text : t.value;
  }
  return undefined;
}

function onInput(e) {
  const t = e.target;
  if (!t.matches) return;
  if (t.matches('[data-form="step"] [name="text"]')) ui.stepDraft = t.value;
  else if (t.matches('[data-form="step"] [name="title"]')) ui.titleDraft = t.value;
}

// ---------------------------------------------------------------------------
//  The keyboard
// ---------------------------------------------------------------------------

const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const typingIn = (target) => !!(target && target.closest && target.closest(TYPING));

function onKeydown(e) {
  if (!state.proposal) return;
  if (e.key === 'Escape') {
    if (gesture) { endGesture(); e.preventDefault(); return; }
    if (ui.confirm) { ui.confirm = false; renderUi(); return; }
    if (ui.form) {
      // backing out of the edge form backs out of drawing too, as its Cancel button does: the next Escape should not be needed
      const wasEdge = ui.form.kind === "edge";
      closeForm();
      if (wasEdge && ui.drawing) { setDrawing(false); renderUi(); }
      e.preventDefault();
      return;
    }
    if (ui.drawing) { setDrawing(false); renderUi(); e.preventDefault(); }
    return;
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey || typingIn(e.target)) return;
  const k = (e.key || '').toLowerCase();
  if (k === 'z') {
    e.preventDefault();
    if (e.shiftKey) redoEdit(); else undoEdit();
  } else if (k === 'y') {
    e.preventDefault();
    redoEdit();
  }
}

// ---------------------------------------------------------------------------
//  Drawing an edge: drag from one node to another
// ---------------------------------------------------------------------------

/** The gesture in progress: `{ from: node, id: pointerId }` or null */
let gesture = null;
let endedAt = 0;
let band = null;

function setDrawing(on) {
  ui.drawing = on;
  const canvas = state.canvas;
  if (canvas) {
    canvas.classList.toggle('is-drawing-edge', on);
    canvas.style.cursor = on ? 'crosshair' : '';
  }
  if (!on) endGesture();
}

const pointOf = (e) => {
  const rect = state.canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
};
const hit = (p, touch) => M.nodeAtPoint(state.nodes.filter((n) => isNodeVisible(n)), state.camera, p.x, p.y, touch);
const screenOf = (n) => ({ x: state.camera.x + n.x * state.camera.zoom, y: state.camera.y + n.y * state.camera.zoom });

function showBand(from, to, hovered) {
  const stage = state.canvas && state.canvas.parentElement;
  if (!stage) return;
  if (!band) {
    // parsed as HTML, so the svg needs no namespace (and the explorer names no URL outside the tailnet)
    band = document.createElement('div');
    band.className = 'hx-rubber';
    band.setAttribute('aria-hidden', 'true');
    band.innerHTML = '<svg width="100%" height="100%"><line class="hx-rubber-line"></line><circle class="hx-rubber-from" r="14"></circle><circle class="hx-rubber-to" r="16"></circle></svg>';
    stage.appendChild(band);
  }
  const a = screenOf(from);
  const line = band.querySelector('line');
  line.setAttribute('x1', String(a.x));
  line.setAttribute('y1', String(a.y));
  line.setAttribute('x2', String(to.x));
  line.setAttribute('y2', String(to.y));
  const f = band.querySelector('.hx-rubber-from');
  f.setAttribute('cx', String(a.x));
  f.setAttribute('cy', String(a.y));
  const t = band.querySelector('.hx-rubber-to');
  t.setAttribute('cx', String(to.x));
  t.setAttribute('cy', String(to.y));
  t.style.display = hovered ? '' : 'none';
}

function hideBand() {
  if (band) { band.remove(); band = null; }
}

function endGesture() {
  if (gesture) endedAt = performance.now();
  gesture = null;
  if (!ui.form || ui.form.kind !== 'edge') hideBand();
}

function onPointerDown(e) {
  if (!ui.drawing || !state.proposal || !state.canvas || e.target !== state.canvas) return;
  if (e.button !== undefined && e.button > 0) return;
  const p = pointOf(e);
  const from = hit(p, e.pointerType === 'touch');
  if (!from) return; // empty map: the map pans as ever
  e.preventDefault(); // no compatibility mouse events: the map's own handlers never see this drag
  e.stopPropagation();
  gesture = { from, id: e.pointerId };
  try { state.canvas.setPointerCapture(e.pointerId); } catch { /* not every pointer can be captured */ }
  if (ui.form?.kind === 'edge') ui.form = null;
  hideBand();
  showBand(from, p, false);
  renderUi();
}

function onPointerMove(e) {
  if (!gesture || (gesture.id !== undefined && e.pointerId !== gesture.id)) return;
  const p = pointOf(e);
  const over = hit(p, e.pointerType === 'touch');
  const target = over && over.id !== gesture.from.id ? over : null;
  showBand(gesture.from, target ? screenOf(target) : p, !!target);
}

function onPointerUp(e) {
  if (!gesture || (gesture.id !== undefined && e.pointerId !== gesture.id)) return;
  const from = gesture.from;
  const to = hit(pointOf(e), e.pointerType === 'touch');
  try { state.canvas.releasePointerCapture(e.pointerId); } catch { /* it was not held */ }
  if (to && to.id !== from.id) {
    gesture = null;
    endedAt = performance.now();
    showBand(from, screenOf(to), true);
    delete ui.messages.toolbar;
    openForm({ kind: 'edge', from: from.id, to: to.id });
  } else {
    endGesture();
    refuse('toolbar', to ? 'An edge joins two different nodes. Drop it on another one.' : 'Drop the edge on another node. Drag from a node to a node.');
  }
}

/** The map's own mouse and touch handlers must not see the drag (or the end of one): its tap would select a node or close the panel */
function swallow(e) {
  if (!ui.drawing && !gesture) return;
  if (gesture || performance.now() - endedAt < 80) {
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  }
}

function bindDrawing() {
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', () => endGesture(), true);
  for (const type of ['mousedown', 'mouseup', 'touchstart', 'touchend', 'touchcancel']) window.addEventListener(type, swallow, true);
}

// ---------------------------------------------------------------------------
//  Wiring (main.js calls this once, before any proposal can open)
// ---------------------------------------------------------------------------

export function initWhatIf() {
  if (wired) return;
  wired = true;
  document.addEventListener('keydown', onKeydown);
  bindDrawing();
  onSceneTouch(() => {
    followSelection();
    if (ui.panel === 'steps' && root) paintStepTarget();
    paintDrawer();
  });
  renderUi();
}

/** For tests: forget everything this module remembers about the page it was wired to */
export function resetWhatIfForTests() {
  if (band) band.remove();
  root = null;
  drawerBox = null;
  band = null;
  gesture = null;
  renderedForm = null;
  loadedFor = null;
  loadedKey = null;
  saveWarned = false;
  listeners.clear();
  Object.assign(ui, { panel: null, form: null, drawing: false, confirm: false, closing: false, scenarioId: null, stepDraft: '', titleDraft: '', notice: '', messages: {}, recentParents: [], lastSelected: null });
  state.whatIf = M.emptyWhatIf();
}
