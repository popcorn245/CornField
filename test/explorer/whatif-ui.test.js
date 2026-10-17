// @vitest-environment happy-dom
/**
 * What-if editing in a page (TOPO-11): the toolbar, the add-node form, the drag that draws an edge (synthesised pointer events),
 * the edits list, undo and redo and the keys, the step controls and the scenario player following them, localStorage and the
 * confirm on Close. Driven through the page's own markup (explorer/index.html) with a recording canvas, so what a click does to the
 * state and the DOM is what is read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { setMap } from '../../explorer/view.js';
// @ts-expect-error plain JS modules, no declarations
import { initProposals, showProposal, closeProposal, setProposalView, showEdgePanel } from '../../explorer/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import { selectNode } from '../../explorer/panels.js';
// @ts-expect-error plain JS modules, no declarations
import { initScenarioUi, clearScenario, getPlayer, playScenario, tickScenario } from '../../explorer/scenario-ui.js';
// @ts-expect-error plain JS modules, no declarations
import { initWhatIf, resetWhatIfForTests, getEdits, getEffectiveProposal, clearEdits, onEditsChange, undoEdit } from '../../explorer/whatif.js';
// @ts-expect-error plain JS modules, no declarations
import { storageKey } from '../../explorer/whatif-model.js';

const page = fs.readFileSync(path.resolve(__dirname, '../../explorer/index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page) [1].replace(/<script[\s\S]*?<\/script>/g, '');

const node = (id        , type        , extra         = {}) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, ...extra });
const base = {
  nodes: [node('root', 'root'), node('app-a', 'app', { label: 'tasks' }), node('page-old', 'page', { label: '/old' }), node('page-keep', 'page', { label: '/keep' }), node('table-t', 'table', { label: 'meals' })],
  edges: [
    { from: 'root', to: 'app-a' }, { from: 'app-a', to: 'page-old' }, { from: 'app-a', to: 'page-keep' },
    { from: 'page-old', to: 'table-t', kind: 'reads', keys: ['a'], status: 'live', label: 'renders rows' },
  ],
};
const robot = () => ({
  version: 1, spec: '0013', title: 'Meals', summary: 'Adds /meals.',
  nodes: { add: [{ id: 'page-meals', label: '/meals', type: 'page', parent: 'app-a' }], change: [], remove: [] },
  edges: { add: [{ from: 'page-meals', to: 'table-t', kind: 'writes', label: 'meals.add' }] },
  scenarios: [{ id: 'add-a-meal', title: 'Add a meal', steps: [{ node: 'page-meals', text: 'You open /meals.' }, { edge: { from: 'page-meals', to: 'table-t', kind: 'writes' }, text: 'It writes a row.' }] }],
});
const KEY = storageKey('0013-meals', 'checkout');

const $ = (id        ) => document.getElementById(id)               ;
const q = (sel        ) => document.querySelector(sel)               ;
const qa = (sel        ) => [...document.querySelectorAll(sel)]                 ;
const click = (el         ) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const tool = (name        ) => q(`#whatif [data-whatif="${name}"]`)                     ;
const msg = (where        ) => q(`[data-msg="${where}"]`);
const key = (k        , init         = {}, target              = document.body) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
const names = () => state.nodes.map((n     ) => n.id);
const markOf = (id        ) => state.nodes.find((n     ) => n.id === id)?.mark;
const sceneNode = (id        ) => render.getScene().nodes.find((n     ) => n.id === id);

/** Fills the add-node form and submits it */
function addNodeVia(fields                                                                      ) {
  if (!q('[data-form="node"]')) click(tool('add-node'));
  const form = q('[data-form="node"]')                   ;
  const set = (name        , value        ) => { (form.elements.namedItem(name)                    ).value = value; };
  set('nodeType', fields.nodeType ?? 'page');
  set('label', fields.label);
  set('parent', fields.parent ?? '');
  set('desc', fields.desc ?? '');
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

/** A pointer event for the canvas, at a node's place on the screen */
function pointer(type        , at                          , extra         = {}) {
  const Ctor      = (globalThis       ).PointerEvent || MouseEvent;
  const e = new Ctor(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 0, pointerId: 1, pointerType: 'mouse', ...extra });
  state.canvas.dispatchEvent(e);
  return e;
}
const screenOf = (id        ) => {
  const n = state.nodes.find((x     ) => x.id === id);
  return { x: state.camera.x + n.x * state.camera.zoom, y: state.camera.y + n.y * state.camera.zoom };
};
/** Drags from one node to another on the map */
function drag(from        , to        ) {
  const a = screenOf(from);
  const b = screenOf(to);
  const down = pointer('pointerdown', a);
  pointer('pointermove', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  pointer('pointermove', b);
  pointer('pointerup', b);
  return down;
}

async function mount({ stored }                      = {}) {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  resetWhatIfForTests();
  document.body.innerHTML = body;
  localStorage.clear();
  if (stored) localStorage.setItem(KEY, JSON.stringify(stored));
  const ctx      = new Proxy({}, { get: (_t, k        ) => (k === 'measureText' ? (t        ) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas      = document.getElementById('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  state.canvas = canvas;
  state.ctx = ctx;
  state.proposal = null;
  state.effectiveProposal = null;
  state.proposalView = 'diff';
  state.proposalErrors = [];
  state.view = 'orbit';
  state.selectedNode = null;
  state.selectedEdge = null;
  state.scenario = null;
  state.baseNodes = base.nodes.map((n) => ({ ...n }));
  state.baseEdges = base.edges;
  render.resize();
  setMap(state.baseNodes.map((n     ) => ({ ...n })), state.baseEdges);
  history.replaceState(null, '', '/');
  initScenarioUi();
  clearScenario();
  await initProposals();
  initWhatIf();
}

function open(proposal         = robot()) {
  showProposal(proposal, { slug: '0013-meals', source: 'checkout', view: 'diff', fit: true });
}

beforeEach(async () => { await mount(); });
afterEach(() => { clearScenario(); vi.unstubAllGlobals(); document.body.innerHTML = ''; localStorage.clear(); });

describe('the toolbar', () => {
  it('is hidden with no proposal, and shows with one: plain-word buttons and "Your edits (0)"', () => {
    expect($('whatif').hidden).toBe(true);
    open();
    expect($('whatif').hidden).toBe(false);
    expect($('whatif').closest('#proposal-body')).not.toBeNull();
    expect(qa('#whatif .hx-whatif-row button').map((b) => b.textContent .trim())).toEqual(['Add a node', 'Draw an edge', 'Undo', 'Redo', 'Your edits (0)', 'Steps']);
    expect(tool('undo').disabled).toBe(true);
    expect(tool('redo').disabled).toBe(true);
    closeProposal();
    expect($('whatif').hidden).toBe(true);
  });

  it('with no proposal open the map has no edit marks and the plain nodes', () => {
    expect(state.nodes.some((n     ) => n.mark === 'edit')).toBe(false);
    expect(getEdits()).toEqual([]);
  });
});

describe('adding a node', () => {
  beforeEach(() => open());

  it('opens a form with the schema\'s types and a short list of parents', () => {
    click(tool('add-node'));
    const form = q('[data-form="node"]')                   ;
    expect(form).not.toBeNull();
    const types = [...(form.elements.namedItem('nodeType')                     ).options].map((o) => o.value);
    expect(types).toEqual(expect.arrayContaining(['app', 'page', 'table', 'service', 'external']));
    const parents = [...(form.elements.namedItem('parent')                     ).options].map((o) => o.textContent);
    expect(parents).toEqual(['No parent', 'tasks']);
  });

  it('adds the node beside its parent with the violet edit mark, and never touches the robot\'s proposal', () => {
    const robotsProposal = structuredClone(state.proposal);
    addNodeVia({ nodeType: 'page', label: '/shopping', parent: 'app-a', desc: 'The list' });
    expect(names()).toContain('page-shopping');
    expect(markOf('page-shopping')).toBe('edit');
    const added = state.nodes.find((n     ) => n.id === 'page-shopping');
    const parent = state.nodes.find((n     ) => n.id === 'app-a');
    expect(Math.hypot(added.x - parent.x, added.y - parent.y)).toBeLessThan(260);
    expect(state.edges.find((e     ) => e.from === 'app-a' && e.to === 'page-shopping')).toMatchObject({ mark: 'edit' });
    expect(sceneNode('page-shopping')).toMatchObject({ mark: 'edit' });
    expect(state.proposal).toEqual(robotsProposal);
    expect(getEffectiveProposal().nodes.add.map((n     ) => n.id)).toEqual(['page-meals', 'page-shopping']);
    expect(tool('edits').textContent).toBe('Your edits (1)');
    expect(q('[data-form="node"]')).toBeNull(); // the form closes
  });

  it('keeps the robot\'s additions as they were marked, beside the new violet one', () => {
    addNodeVia({ label: '/shopping', parent: 'app-a' });
    expect(markOf('page-meals')).toBe('added');
    expect(markOf('page-shopping')).toBe('edit');
  });

  it('refuses a page label with no slash, inline next to the form, and leaves the list as it was', () => {
    addNodeVia({ nodeType: 'page', label: 'shopping', parent: 'app-a' });
    expect(msg('form').hidden).toBe(false);
    expect(msg('form').textContent).toMatch(/must start with a slash route/);
    expect(getEdits()).toEqual([]);
    expect(names()).not.toContain('page-shopping');
    expect(q('[data-form="node"]')).not.toBeNull(); // still open: fix it
  });

  it('asks for a label in plain words', () => {
    addNodeVia({ label: '  ', parent: 'app-a' });
    expect(msg('form').textContent).toBe('Give the node a label.');
  });

  it('the parent follows a node picked on the map while the form is open', () => {
    click(tool('add-node'));
    state.selectedNode = state.nodes.find((n     ) => n.id === 'table-t');
    state.selectedEdge = null;
    // what picking a node does: the scene is touched
    import('../../explorer/state.js').then(({ touchScene }) => touchScene());
    return Promise.resolve().then(() => new Promise((r) => setTimeout(r, 0))).then(() => {
      const select = q('[data-form="node"] [name="parent"]')                     ;
      expect(select.value).toBe('table-t');
    });
  });

  it('is kept in localStorage under the proposal\'s source and slug', () => {
    addNodeVia({ label: '/shopping', parent: 'app-a' });
    const stored = JSON.parse(localStorage.getItem(KEY) );
    expect(stored).toMatchObject({ version: 1, slug: '0013-meals', source: 'checkout' });
    expect(stored.edits).toHaveLength(1);
    expect(stored.edits[0]).toMatchObject({ op: 'add-node', id: 'page-shopping', label: '/shopping', type: 'page', parent: 'app-a' });
    expect(typeof stored.edits[0].at).toBe('number');
  });

  it('shows in the changes list with the others', () => {
    addNodeVia({ label: '/shopping', parent: 'app-a' });
    click($('proposal-chip'));
    expect(qa('.hx-change-row').some((r) => r.textContent .includes('Your edit') && r.textContent .includes('/shopping'))).toBe(true);
  });
});

describe('removing a node', () => {
  beforeEach(() => open());
  const pick = (id        ) => selectNode(state.nodes.find((n     ) => n.id === id));

  it('puts "Remove in this proposal" in the node panel', async () => {
    await pick('page-keep');
    expect(q('#whatif-drawer').hidden).toBe(false);
    expect(q('#whatif-drawer [data-whatif="remove-node"]').textContent).toBe('Remove in this proposal');
    expect(q('#whatif-drawer summary').textContent).toBe('Its edges (1)');
  });

  it('a base node becomes a remove edit: violet ring, faded, struck through, its edges too; After hides it', async () => {
    await pick('page-keep');
    click(q('#whatif-drawer [data-whatif="remove-node"]'));
    expect(markOf('page-keep')).toBe('edit');
    expect(state.nodes.find((n     ) => n.id === 'page-keep').editOp).toBe('removed');
    expect(sceneNode('page-keep')).toMatchObject({ mark: 'edit', labelStrike: true });
    expect(sceneNode('page-keep').alpha).toBeLessThan(0.6);
    expect(getEdits()[0]).toMatchObject({ op: 'remove-node', id: 'page-keep' });
    expect(getEffectiveProposal().nodes.remove.map((n     ) => n.id)).toEqual(['page-keep']);
    setProposalView('after');
    expect(sceneNode('page-keep')).toBeUndefined();
    setProposalView('before');
    expect(sceneNode('page-keep')).toBeDefined();
  });

  it('after removing it the panel offers to bring it back, which takes the edit out of the list', async () => {
    await pick('page-keep');
    click(q('#whatif-drawer [data-whatif="remove-node"]'));
    expect(q('#whatif-drawer [data-whatif="bring-back"]').textContent).toBe('Bring it back');
    click(q('#whatif-drawer [data-whatif="bring-back"]'));
    expect(markOf('page-keep')).toBe('none');
    expect(getEdits()).toEqual([]);
  });

  it('a node the proposal added is dropped, with what hangs on it and the steps that point at it', async () => {
    await pick('page-meals');
    click(q('#whatif-drawer [data-whatif="remove-node"]'));
    expect(names()).not.toContain('page-meals');
    expect(getEffectiveProposal().scenarios[0].steps).toEqual([]);
    expect(state.edges.some((e     ) => e.to === 'page-meals' || e.from === 'page-meals')).toBe(false);
  });

  it('refuses removing a node the proposal builds on, with the message next to the button', async () => {
    await pick('table-t'); // the robot's own edge ends here
    click(q('#whatif-drawer [data-whatif="remove-node"]'));
    expect(q('#whatif-drawer [data-msg="drawer"]').hidden).toBe(false);
    expect(q('#whatif-drawer [data-msg="drawer"]').textContent).toMatch(/is a node this proposal removes/);
    expect(getEdits()).toEqual([]);
    expect(markOf('table-t')).toBe('none');
  });

  it('removes one edge of a node from its edge list', async () => {
    await pick('page-old');
    click(q('#whatif-drawer [data-whatif="remove-edge"][data-kind="reads"]'));
    expect(state.edges.find((e     ) => e.kind === 'reads')).toMatchObject({ mark: 'edit', editOp: 'removed' });
    expect(getEdits()[0]).toMatchObject({ op: 'remove-edge', from: 'page-old', to: 'table-t', kind: 'reads' });
  });

  it('offers nothing to remove on what the proposal itself removes', async () => {
    const p      = robot();
    p.nodes.remove = [{ id: 'page-old', why: 'replaced' }];
    open(p);
    await pick('page-old');
    expect(q('#whatif-drawer').hidden).toBe(true);
  });
});

describe('the edge panel', () => {
  beforeEach(() => open());

  it('removes an edge the proposal added: it is gone', () => {
    const edge = state.edges.find((e     ) => e.from === 'page-meals' && e.kind === 'writes');
    showEdgePanel(edge);
    click(q('#whatif-drawer [data-whatif="remove-edge"]'));
    expect(state.edges.some((e     ) => e.kind === 'writes')).toBe(false);
    expect(getEdits()[0]).toMatchObject({ op: 'remove-edge', from: 'page-meals', to: 'table-t', kind: 'writes' });
  });

  it('removes a base edge: a removed edit, violet and dotted', () => {
    const edge = state.edges.find((e     ) => e.kind === 'reads');
    showEdgePanel(edge);
    click(q('#whatif-drawer [data-whatif="remove-edge"]'));
    const now = state.edges.find((e     ) => e.kind === 'reads');
    expect(now).toMatchObject({ mark: 'edit', editOp: 'removed' });
    const drawn = render.getScene().edges.find((e     ) => e.kind === 'reads');
    expect(drawn).toMatchObject({ mark: 'edit', color: '#a78bfa' });
    expect(drawn.dash).not.toBeNull();
  });
});

describe('drawing an edge', () => {
  beforeEach(() => open());

  it('turns on a mode that says what to do, and Escape turns it off', () => {
    click(tool('draw-edge'));
    expect(tool('draw-edge').getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-hint]').hidden).toBe(false);
    expect(q('[data-hint]').textContent).toBe('Drag from one node to another. Escape cancels.');
    expect(state.canvas.classList.contains('is-drawing-edge')).toBe(true);
    key('Escape');
    expect(tool('draw-edge').getAttribute('aria-pressed')).toBe('false');
    expect(q('[data-hint]').hidden).toBe(true);
    expect(state.canvas.classList.contains('is-drawing-edge')).toBe(false);
  });

  it('a drag from a node shows a rubber band, and the map\'s own handlers do not see the press', () => {
    click(tool('draw-edge'));
    const seen = vi.fn();
    state.canvas.addEventListener('mousedown', seen);
    const down = pointer('pointerdown', screenOf('page-keep'));
    expect(down.defaultPrevented).toBe(true);
    expect(q('.hx-rubber')).not.toBeNull();
    pointer('pointermove', { x: screenOf('page-keep').x + 40, y: screenOf('page-keep').y + 10 });
    expect(q('.hx-rubber-line').getAttribute('x2')).toBe(String(screenOf('page-keep').x + 40));
    expect(seen).not.toHaveBeenCalled();
    key('Escape'); // cancels the gesture
    expect(q('.hx-rubber')).toBeNull();
    expect(tool('draw-edge').getAttribute('aria-pressed')).toBe('true'); // the mode stays
  });

  it('a press on empty map is left to the map (it pans)', () => {
    click(tool('draw-edge'));
    const down = pointer('pointerdown', { x: -400, y: -400 });
    expect(down.defaultPrevented).toBe(false);
    expect(q('.hx-rubber')).toBeNull();
  });

  it('does nothing at all while the mode is off', () => {
    const down = pointer('pointerdown', screenOf('page-keep'));
    expect(down.defaultPrevented).toBe(false);
    expect(q('.hx-rubber')).toBeNull();
  });

  it('dropping on another node asks for the kind, suggested from the two ends; then adds the edge with the edit mark', () => {
    click(tool('draw-edge'));
    drag('page-keep', 'table-t');
    const form = q('[data-form="edge"]')                   ;
    expect(form).not.toBeNull();
    expect(form.querySelector('.hx-whatif-pair') .textContent).toBe('/keep → meals');
    expect(q('.hx-rubber')).not.toBeNull(); // the line stays while the kind is picked
    const kind = form.elements.namedItem('kind')                     ;
    expect(kind.value).toBe('writes');
    expect([...kind.options].map((o) => o.value)).toEqual(expect.arrayContaining(['', 'flow', 'reads', 'writes', 'calls']));
    (form.elements.namedItem('label')                    ).value = 'keep.save';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(state.edges.find((e     ) => e.from === 'page-keep' && e.kind === 'writes')).toMatchObject({ mark: 'edit', editOp: 'added', label: 'keep.save' });
    expect(getEdits()[0]).toMatchObject({ op: 'add-edge', from: 'page-keep', to: 'table-t', kind: 'writes', label: 'keep.save' });
    expect(q('.hx-rubber')).toBeNull();
    expect(tool('draw-edge').getAttribute('aria-pressed')).toBe('false');
    expect(render.getScene().edges.find((e     ) => e.from === 'page-keep' && e.kind === 'writes')).toMatchObject({ mark: 'edit', color: '#a78bfa' });
  });

  it('a flow edge asks which flow', () => {
    click(tool('draw-edge'));
    drag('page-keep', 'page-old');
    const form = q('[data-form="edge"]')                   ;
    const kind = form.elements.namedItem('kind')                     ;
    expect(form.querySelector             ('[data-flow-field]') .hidden).toBe(true);
    kind.value = 'flow';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    expect(form.querySelector             ('[data-flow-field]') .hidden).toBe(false);
    (form.elements.namedItem('flow')                     ).value = 'rom';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(getEdits()[0]).toMatchObject({ op: 'add-edge', kind: 'flow', flow: 'rom' });
  });

  it('refuses an edge the map already has, inline, and keeps the form open', () => {
    click(tool('draw-edge'));
    drag('page-old', 'table-t');
    const form = q('[data-form="edge"]')                   ;
    (form.elements.namedItem('kind')                     ).value = 'reads';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(msg('form').textContent).toMatch(/already exists in the map/);
    expect(getEdits()).toEqual([]);
    expect(q('[data-form="edge"]')).not.toBeNull();
  });

  it('Escape closes the kind picker, the line goes, and drawing is off (one Escape backs all the way out, as Cancel does)', () => {
    click(tool('draw-edge'));
    drag('page-keep', 'table-t');
    key('Escape');
    expect(q('[data-form="edge"]')).toBeNull();
    expect(q('.hx-rubber')).toBeNull();
    expect(tool('draw-edge').getAttribute('aria-pressed')).toBe('false'); // the form and the mode go together, as with the Cancel button
    expect(tool('draw-edge').getAttribute('aria-pressed')).toBe('false');
  });

  it('dropping on the same node or on nothing says why, and draws nothing', () => {
    click(tool('draw-edge'));
    const a = screenOf('page-keep');
    pointer('pointerdown', a);
    pointer('pointerup', a);
    expect(msg('toolbar').textContent).toMatch(/joins two different nodes/);
    pointer('pointerdown', a);
    pointer('pointerup', { x: -500, y: -500 });
    expect(msg('toolbar').textContent).toMatch(/Drop the edge on another node/);
    expect(q('[data-form="edge"]')).toBeNull();
    expect(getEdits()).toEqual([]);
  });

  it('a touch drag works the same, and the touch events that follow are kept from the map', () => {
    click(tool('draw-edge'));
    const a = screenOf('page-keep');
    const down = pointer('pointerdown', a, { pointerType: 'touch' });
    expect(down.defaultPrevented).toBe(true);
    const seen = vi.fn();
    state.canvas.addEventListener('touchstart', seen);
    state.canvas.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    expect(seen).not.toHaveBeenCalled();
    pointer('pointerup', screenOf('table-t'), { pointerType: 'touch' });
    expect(q('[data-form="edge"]')).not.toBeNull();
  });
});

describe('undo and redo', () => {
  beforeEach(() => open());

  it('undo takes the last edit back one at a time; redo puts it again', () => {
    addNodeVia({ label: '/one', parent: 'app-a' });
    addNodeVia({ label: '/two', parent: 'app-a' });
    expect(tool('edits').textContent).toBe('Your edits (2)');
    click(tool('undo'));
    expect(names()).toContain('page-one');
    expect(names()).not.toContain('page-two');
    expect(tool('redo').disabled).toBe(false);
    click(tool('undo'));
    expect(names()).not.toContain('page-one');
    expect(tool('undo').disabled).toBe(true);
    click(tool('redo'));
    expect(names()).toContain('page-one');
    expect(getEdits()).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(KEY) ).undone).toHaveLength(1);
  });

  it('a new edit after an undo clears what could be redone', () => {
    addNodeVia({ label: '/one', parent: 'app-a' });
    click(tool('undo'));
    addNodeVia({ label: '/two', parent: 'app-a' });
    expect(tool('redo').disabled).toBe(true);
  });

  it('Ctrl+Z undoes and Ctrl+Shift+Z redoes, when focus is not in an input', () => {
    addNodeVia({ label: '/one', parent: 'app-a' });
    const e = key('z', { ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(names()).not.toContain('page-one');
    key('z', { ctrlKey: true, shiftKey: true });
    expect(names()).toContain('page-one');
    key('z', { metaKey: true });
    expect(names()).not.toContain('page-one');
    key('y', { ctrlKey: true });
    expect(names()).toContain('page-one');
  });

  it('leaves Ctrl+Z to a text field that has focus', () => {
    addNodeVia({ label: '/one', parent: 'app-a' });
    click(tool('add-node'));
    const input = q('[data-form="node"] [name="label"]');
    const e = key('z', { ctrlKey: true }, input);
    expect(e.defaultPrevented).toBe(false);
    expect(names()).toContain('page-one');
  });

  it('does nothing with no proposal open', () => {
    closeProposal();
    expect(key('z', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(undoEdit()).toBe(false);
  });
});

describe('your edits', () => {
  beforeEach(() => open());

  it('lists one row per edit, in plain words, each with a remove', () => {
    addNodeVia({ label: '/one', parent: 'app-a' });
    addNodeVia({ nodeType: 'table', label: 'recipes' });
    click(tool('edits'));
    const rows = qa('.hx-whatif-edit');
    expect(rows.map((r) => r.querySelector('.hx-whatif-edit-text') .textContent)).toEqual(['Added the page “/one” under tasks', 'Added the table “recipes”']);
    expect(rows.every((r) => r.querySelector('[data-whatif="remove-edit"]'))).toBe(true);
    expect(tool('edits').getAttribute('aria-expanded')).toBe('true');
    click(tool('edits'));
    expect(q('[data-panel="edits"]').hidden).toBe(true);
  });

  it('says so when there are none', () => {
    click(tool('edits'));
    expect(q('[data-panel="edits"]').textContent).toContain('No edits yet');
  });

  it('removes one edit from the middle', () => {
    addNodeVia({ label: '/one', parent: 'app-a' });
    addNodeVia({ nodeType: 'table', label: 'recipes' });
    click(tool('edits'));
    click(qa('[data-whatif="remove-edit"]')[0]);
    expect(names()).not.toContain('page-one');
    expect(names()).toContain('table-recipes');
    expect(qa('.hx-whatif-edit')).toHaveLength(1);
  });

  it('refuses taking out an edit a later one builds on, with a message beside the list', () => {
    addNodeVia({ nodeType: 'service', label: 'planner', parent: 'app-a' });
    // an edge from the new service
    click(tool('draw-edge'));
    drag('service-planner', 'table-t');
    const form = q('[data-form="edge"]')                   ;
    (form.elements.namedItem('kind')                     ).value = 'calls';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(getEdits()).toHaveLength(2);
    click(tool('edits'));
    click(qa('[data-whatif="remove-edit"]')[0]);
    expect(msg('edits').hidden).toBe(false);
    expect(msg('edits').textContent).toMatch(/^A later edit builds on this one/);
    expect(getEdits()).toHaveLength(2);
  });

  it('three edits, one list (the picture the review shows)', () => {
    addNodeVia({ label: '/shopping', parent: 'app-a' });
    addNodeVia({ nodeType: 'table', label: 'recipes' });
    return selectNode(state.nodes.find((n     ) => n.id === 'page-keep')).then(() => {
      click(q('#whatif-drawer [data-whatif="remove-node"]'));
      click(tool('edits'));
      expect(qa('.hx-whatif-edit')).toHaveLength(3);
      expect(tool('edits').textContent).toBe('Your edits (3)');
    });
  });
});

describe('problems', () => {
  it('after every edit the problem list shows what validateProposal finds on the effective proposal', () => {
    const p      = robot();
    p.scenarios[0].steps.push({ node: 'page-keep', text: 'The old page.' });
    open(p);
    addNodeVia({ label: '/one', parent: 'app-a' });
    expect(state.proposalErrors).toEqual([]);
    // a step that points at a node an edit removes is allowed, and the list still reads clean (the thing is in the map)
    expect($('proposal-errors').hidden).toBe(true);
  });

  it('keeps a problem the robot\'s own proposal had in the list, and does not stop edits for it', () => {
    const p      = robot();
    p.nodes.add.push({ id: 'page-bad', label: 'no slash', type: 'page', parent: 'app-a' });
    open(p);
    expect($('proposal-errors').hidden).toBe(false);
    addNodeVia({ label: '/one', parent: 'app-a' });
    expect(names()).toContain('page-one');
    expect($('proposal-errors').hidden).toBe(false);
    expect($('proposal-errors-list').textContent).toContain('must start with a slash route');
  });
});

describe('steps', () => {
  beforeEach(() => open());
  const stepRows = () => qa('.hx-whatif-step');
  const texts = () => stepRows().map((r) => (r.querySelector('[data-step-text]')                    ).value);

  it('lists the current scenario\'s steps with what each points at', () => {
    click(tool('steps'));
    expect(texts()).toEqual(['You open /meals.', 'It writes a row.']);
    expect(stepRows().map((r) => r.querySelector('.hx-whatif-target') .textContent)).toEqual(['/meals', '/meals → meals']);
    expect((q('[data-scenario-select]')                     ).value).toBe('add-a-meal');
  });

  it('adds a step pointing at the selected node, with the words typed', async () => {
    click(tool('steps'));
    await selectNode(state.nodes.find((n     ) => n.id === 'table-t'));
    expect(q('[data-step-target]').textContent).toBe('Points at meals');
    const form = q('[data-form="step"]')                   ;
    (form.elements.namedItem('text')                    ).value = 'The row is stored.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(texts()).toEqual(['You open /meals.', 'It writes a row.', 'The row is stored.']);
    expect(getEffectiveProposal().scenarios[0].steps[2]).toEqual({ node: 'table-t', text: 'The row is stored.' });
    expect(getEdits()[0]).toMatchObject({ op: 'add-step', scenario: 'add-a-meal', step: { node: 'table-t', text: 'The row is stored.' } });
    expect(state.proposal.scenarios[0].steps).toHaveLength(2); // the robot's is untouched
  });

  it('adds a step pointing at the selected edge', () => {
    click(tool('steps'));
    showEdgePanel(state.edges.find((e     ) => e.kind === 'reads'));
    const form = q('[data-form="step"]')                   ;
    (form.elements.namedItem('text')                    ).value = 'The old page reads it.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(getEffectiveProposal().scenarios[0].steps[2]).toEqual({ edge: { from: 'page-old', to: 'table-t', kind: 'reads' }, text: 'The old page reads it.' });
  });

  it('refuses a step with nothing selected, or with no words, inline', () => {
    click(tool('steps'));
    const form = q('[data-form="step"]')                   ;
    (form.elements.namedItem('text')                    ).value = 'x';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(msg('steps').textContent).toBe('Pick a node or an edge on the map first: the step points at it.');
    expect(getEdits()).toEqual([]);
  });

  it('rewords a step when the text field changes, and puts the old words back when the new ones are empty', () => {
    click(tool('steps'));
    const input = q('[data-step-text="1"]')                    ;
    input.value = 'It saves the meal.';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(texts()[1]).toBe('It saves the meal.');
    expect(getEdits()[0]).toMatchObject({ op: 'edit-step', index: 1, step: { text: 'It saves the meal.' } });
    const again = q('[data-step-text="1"]')                    ;
    again.value = '   ';
    again.dispatchEvent(new Event('change', { bubbles: true }));
    expect(msg('steps').textContent).toBe('A step needs some words.');
    expect((q('[data-step-text="1"]')                    ).value).toBe('It saves the meal.');
    expect(getEdits()).toHaveLength(1);
  });

  it('moves a step up and down and deletes one; the first cannot go up and the last cannot go down', () => {
    click(tool('steps'));
    expect((q('[data-whatif="step-up"][data-index="0"]')                     ).disabled).toBe(true);
    expect((q('[data-whatif="step-down"][data-index="1"]')                     ).disabled).toBe(true);
    click(q('[data-whatif="step-down"][data-index="0"]'));
    expect(texts()).toEqual(['It writes a row.', 'You open /meals.']);
    click(q('[data-whatif="step-up"][data-index="1"]'));
    expect(texts()).toEqual(['You open /meals.', 'It writes a row.']);
    click(q('[data-whatif="step-delete"][data-index="0"]'));
    expect(texts()).toEqual(['It writes a row.']);
    expect(getEdits().map((e     ) => e.op)).toEqual(['move-step', 'move-step', 'remove-step']);
  });

  it('starts a new scenario from a title when there is none to add to', async () => {
    const p      = robot();
    delete p.scenarios;
    open(p);
    click(tool('steps'));
    expect((q('[data-scenario-select]')                     ).value).toBe('__new');
    await selectNode(state.nodes.find((n     ) => n.id === 'table-t'));
    const form = q('[data-form="step"]')                   ;
    (form.elements.namedItem('text')                    ).value = 'A meal is stored.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(msg('steps').textContent).toBe('Name the new scenario.');
    (form.elements.namedItem('title')                    ).value = 'Store a meal';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(getEffectiveProposal().scenarios).toEqual([{ id: 'store-a-meal', title: 'Store a meal', steps: [{ node: 'table-t', text: 'A meal is stored.' }] }]);
    expect((q('[data-scenario-select]')                     ).value).toBe('store-a-meal');
    // the scenario list on the stage follows the effective proposal
    expect(q('.hx-scenarios summary').textContent).toBe('Scenarios · 1');
  });

  it('the scenario list on the stage shows the edited scenario', async () => {
    expect(q('.hx-scenarios button').textContent).toBe('Add a meal · 2 steps');
    click(tool('steps'));
    await selectNode(state.nodes.find((n     ) => n.id === 'table-t'));
    const form = q('[data-form="step"]')                   ;
    (form.elements.namedItem('text')                    ).value = 'Stored.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(q('.hx-scenarios button').textContent).toBe('Add a meal · 3 steps');
  });

  it('a scenario that is playing takes the edit and keeps the step it was on', async () => {
    click(tool('steps'));
    await selectNode(state.nodes.find((n     ) => n.id === 'table-t')); // selecting a node ends a scenario (as it does on the map)
    // play from step 2, then edit the step list: the player is handed the new steps
    playScenario(getEffectiveProposal().scenarios[0], { autoplay: false }).goTo(1);
    tickScenario(0);
    expect(state.scenario.index).toBe(1);
    const form = q('[data-form="step"]')                   ;
    (form.elements.namedItem('text')                    ).value = 'Stored.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(getPlayer()).not.toBeNull();
    expect(state.scenario.total).toBe(3);
    expect(state.scenario.index).toBe(1);
    // reword the step being shown: the bar says the new words
    const input = q('[data-step-text="1"]')                    ;
    input.value = 'It saves a row.';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(q('.hx-player-step').textContent).toBe('It saves a row.');
    // delete the tail: the player keeps to a step that exists
    click(q('[data-whatif="step-delete"][data-index="2"]'));
    click(q('[data-whatif="step-delete"][data-index="1"]'));
    expect(state.scenario.total).toBe(1);
    expect(state.scenario.index).toBe(0);
    // the last step too: the scenario stays, empty, and the problem list says so
    click(q('[data-whatif="step-delete"][data-index="0"]'));
    expect(state.scenario.total).toBe(0);
    expect(state.proposalErrors.map((e     ) => e.message)).toContain('A scenario needs at least one step.');
  });

  it('shows a step on the map when its number is pressed, and Play plays the scenario', () => {
    click(tool('steps'));
    click(q('[data-whatif="go-step"][data-index="1"]'));
    expect(getPlayer()).not.toBeNull();
    expect(state.scenario.index).toBe(1);
    expect(state.scenario.playing).toBe(false);
    expect(q('.hx-player-step').textContent).toBe('It writes a row.');
    expect(q('.hx-whatif-step.is-current .hx-whatif-num').textContent).toBe('2');
    click(q('[data-whatif="play-scenario"]'));
    expect(getPlayer().isPlaying()).toBe(true);
  });

  it('removing a node the proposal added takes its steps out of the list, and ends a scenario when the node was the one open', () => {
    return selectNode(state.nodes.find((n     ) => n.id === 'page-meals')).then(() => {
      playScenario(getEffectiveProposal().scenarios[0], { autoplay: false });
      expect(state.scenario.total).toBe(2);
      click(q('#whatif-drawer [data-whatif="remove-node"]'));
      expect(getEffectiveProposal().scenarios[0].steps).toEqual([]);
      expect(state.scenario).toBeNull(); // the panel closed with the node it showed, as it does on the map
    });
  });
});

describe('saved edits', () => {
  it('come back when the same proposal is opened again, from the source and slug', async () => {
    await mount({
      stored: {
        version: 1, slug: '0013-meals', source: 'checkout', savedAt: 1,
        edits: [{ op: 'add-node', id: 'page-shopping', label: '/shopping', type: 'page', parent: 'app-a', at: 1 }], undone: [],
      },
    });
    open();
    expect(names()).toContain('page-shopping');
    expect(markOf('page-shopping')).toBe('edit');
    expect(tool('edits').textContent).toBe('Your edits (1)');
  });

  it('are kept apart per proposal: another source with the same slug has its own', async () => {
    open();
    addNodeVia({ label: '/shopping', parent: 'app-a' });
    showProposal(robot(), { slug: '0013-meals', source: 'topo-09', view: 'diff' });
    expect(names()).not.toContain('page-shopping');
    expect(tool('edits').textContent).toBe('Your edits (0)');
    showProposal(robot(), { slug: '0013-meals', source: 'checkout', view: 'diff' });
    expect(names()).toContain('page-shopping');
  });

  it('drop an edit the robot\'s newer proposal no longer fits, and say so', async () => {
    await mount({
      stored: {
        version: 1, slug: '0013-meals', source: 'checkout', savedAt: 1,
        edits: [{ op: 'add-node', id: 'page-meals', label: '/meals again', type: 'page', parent: 'app-a', at: 1 }, { op: 'add-node', id: 'page-ok', label: '/ok', type: 'page', parent: 'app-a', at: 2 }], undone: [],
      },
    });
    open();
    expect(names()).toContain('page-ok');
    expect(getEdits()).toHaveLength(1);
    expect(q('[data-notice]').hidden).toBe(false);
    expect(q('[data-notice]').textContent).toBe('1 edit you made no longer fits this proposal and was dropped.');
    expect(JSON.parse(localStorage.getItem(KEY) ).edits).toHaveLength(1); // the stored list is the one that fits
  });

  it('survive a browser that will not store them: a message, and the edits still work', () => {
    open();
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage') ;
    Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: () => null, removeItem: () => {}, setItem: () => { throw new Error('quota'); } } });
    try {
      addNodeVia({ label: '/shopping', parent: 'app-a' });
    } finally {
      Object.defineProperty(window, 'localStorage', real);
    }
    expect(names()).toContain('page-shopping');
    expect(msg('toolbar').textContent).toMatch(/would not keep your edits/);
  });
});

describe('closing', () => {
  beforeEach(() => open());
  const closeBtn = () => q('[data-action="close-proposal"]');

  it('closes straight away when there are no edits', () => {
    click(closeBtn());
    expect(state.proposal).toBeNull();
    expect(q('[data-panel="confirm"]').hidden).toBe(true);
  });

  it('asks first when there are edits: keep them, throw them away, or keep editing', () => {
    addNodeVia({ label: '/shopping', parent: 'app-a' });
    click(closeBtn());
    expect(state.proposal).not.toBeNull();
    const box = q('[data-panel="confirm"]');
    expect(box.hidden).toBe(false);
    expect(box.textContent).toContain('You have 1 edit on it');
    expect(qa('[data-panel="confirm"] button').map((b) => b.textContent)).toEqual(['Close and keep my edits', 'Close and throw them away', 'Keep editing']);
    click(q('[data-whatif="close-cancel"]'));
    expect(q('[data-panel="confirm"]').hidden).toBe(true);
    expect(state.proposal).not.toBeNull();
  });

  it('"keep" closes and leaves the edits in storage, where the proposal finds them again', () => {
    addNodeVia({ label: '/shopping', parent: 'app-a' });
    click(closeBtn());
    click(q('[data-whatif="close-keep"]'));
    expect(state.proposal).toBeNull();
    expect(state.nodes.some((n     ) => n.id === 'page-shopping')).toBe(false);
    expect(localStorage.getItem(KEY)).not.toBeNull();
    open();
    expect(names()).toContain('page-shopping');
  });

  it('"throw away" closes and clears them', () => {
    addNodeVia({ label: '/shopping', parent: 'app-a' });
    click(closeBtn());
    click(q('[data-whatif="close-discard"]'));
    expect(state.proposal).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    open();
    expect(names()).not.toContain('page-shopping');
  });

  it('closing the proposal puts the plain map back with no edit marks', () => {
    addNodeVia({ label: '/shopping', parent: 'app-a' });
    click(closeBtn());
    click(q('[data-whatif="close-keep"]'));
    expect(state.nodes.map((n     ) => n.id)).toEqual(base.nodes.map((n) => n.id));
    expect(state.nodes.some((n     ) => n.mark === 'edit' || n.editOp)).toBe(false);
  });
});

describe('for the review step', () => {
  beforeEach(() => open());

  it('getEdits hands out copies, onEditsChange follows every change, clearEdits empties the list and the stored copy', () => {
    const seen           = [];
    const off = onEditsChange((edits          ) => seen.push(edits.length));
    addNodeVia({ label: '/one', parent: 'app-a' });
    addNodeVia({ label: '/two', parent: 'app-a' });
    getEdits().pop(); // a copy
    expect(getEdits()).toHaveLength(2);
    clearEdits();
    expect(getEdits()).toEqual([]);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(names()).not.toContain('page-one');
    expect(seen).toEqual([1, 2, 0]);
    off();
    addNodeVia({ label: '/three', parent: 'app-a' });
    expect(seen).toEqual([1, 2, 0]);
  });
});

describe('the views', () => {
  it('Before hides what you added, After hides what you removed, and Diff draws both in violet', async () => {
    open();
    addNodeVia({ label: '/shopping', parent: 'app-a' });
    await selectNode(state.nodes.find((n     ) => n.id === 'page-keep'));
    click(q('#whatif-drawer [data-whatif="remove-node"]'));
    expect(sceneNode('page-shopping')).toMatchObject({ mark: 'edit' });
    expect(sceneNode('page-keep')).toMatchObject({ mark: 'edit' });
    setProposalView('before');
    expect(sceneNode('page-shopping')).toBeUndefined();
    expect(sceneNode('page-keep')).toBeDefined();
    setProposalView('after');
    expect(sceneNode('page-shopping')).toMatchObject({ mark: 'edit' });
    expect(sceneNode('page-keep')).toBeUndefined();
  });
});
