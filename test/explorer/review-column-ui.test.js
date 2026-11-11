// @vitest-environment happy-dom
/**
 * The review column (spec 0006, D1, D2, D4, D5): the changes and, persona by persona, the scenarios that apply to them, on screen the
 * moment a proposal opens; a scenario's steps as a list with verdicts; choosing a step opens the player paused on it. Driven through
 * the page's own markup (explorer/index.html) with a stub renderer; layout is not computed in happy-dom, so the boxes are given.
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
import { initProposals, showProposal } from '../../explorer/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import { initScenarioUi, clearScenario, tickScenario, getPlayer } from '../../explorer/scenario-ui.js';
// @ts-expect-error plain JS modules, no declarations
import { initReviewColumn, resetReviewColumnForTests } from '../../explorer/review-column.js';
// @ts-expect-error plain JS modules, no declarations
import { initWhatIf, resetWhatIfForTests } from '../../explorer/whatif.js';
// @ts-expect-error plain JS modules, no declarations
import { initReview, resetReviewForTests } from '../../explorer/review.js';
// @ts-expect-error plain JS modules, no declarations
import { initSheets, visibleMapRect, expandedSheet, expandSheet } from '../../explorer/sheets.js';
// @ts-expect-error plain JS modules, no declarations
import { initChecks } from '../../explorer/check.js';
// @ts-expect-error plain JS modules, no declarations
import { seenKey, readSeen } from '../../explorer/scenario-list-model.js';
// @ts-expect-error plain JS modules, no declarations
import { reviewBody } from '../../explorer/review-model.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const page = fs.readFileSync(path.resolve(here, '../../explorer/index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page) [1].replace(/<script[\s\S]*?<\/script>/g, '');

const node = (id        , type        , x        , y        , extra         = {}) => ({ id, type, x, y, r: 20, color: '#336699', label: id, ...extra });
const personas = (...labels            ) => labels.map((label, i) => node(`persona-${['adult', 'child', 'guest', 'admin'][i]}`, 'persona', 0, 0, { label, role: i === 2 ? undefined : 'adult', account: i === 2 ? false : undefined }));
const base = (withPersonas = true) => ({
  nodes: [
    node('root', 'root', 0, 0), node('app-a', 'app', 300, 0), node('page-old', 'page', 300, 200), node('table-t', 'table', 600, 100),
    ...(withPersonas ? personas('Adult', 'Child', 'Guest (no account)', 'Admin') : []),
  ],
  edges: [{ from: 'root', to: 'app-a' }, { from: 'app-a', to: 'page-old' }, { from: 'page-old', to: 'table-t', kind: 'reads', keys: ['a'], status: 'live', label: 'renders rows' }],
});
const robot = (extra         = {}) => ({
  version: 1, spec: '0013', title: 'Meals', summary: 'Adds /meals.',
  nodes: { add: [{ id: 'page-meals', label: '/meals', type: 'page', parent: 'app-a' }], remove: [{ id: 'page-old', why: 'replaced' }] },
  edges: { add: [{ from: 'page-meals', to: 'table-t', kind: 'writes', label: 'meals.add' }] },
  scenarios: [
    { id: 'plan', title: 'An adult plans a meal', actor: 'adult', steps: [{ node: 'page-meals', text: 'The page opens.' }, { edge: { from: 'page-meals', to: 'table-t', kind: 'writes' }, text: 'The row is stored.' }] },
    { id: 'ask', title: 'A guest asks, an admin answers', steps: [{ node: 'page-meals', actor: 'guest', text: 'Asks.' }, { node: 'table-t', actor: 'admin', text: 'Answers.' }] },
    { id: 'gone', title: 'The old page goes', steps: [{ node: 'page-old', text: 'It is removed.' }] },
  ],
  ...extra,
});

const $ = (id        ) => document.getElementById(id)               ;
const q = (sel        ) => document.querySelector(sel)               ;
const qa = (sel        ) => [...document.querySelectorAll(sel)]                          ;
const click = (el         ) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const rect = (top        , bottom        , left = 0, right = 1000) => () => ({ top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top });
const phone = (on         ) => vi.stubGlobal('matchMedia', (query        ) => ({ matches: on && /max-width: 767px/.test(query), media: query, addEventListener() {}, removeEventListener() {} }));

async function mount(topology = base(), { checker = null } = {}) {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, headers: new Headers(), json: async () => ({}) })));
  resetWhatIfForTests();
  resetReviewForTests();
  resetReviewColumnForTests();
  document.body.innerHTML = body;
  localStorage.clear();
  const ctx      = new Proxy({}, { get: (_t, k        ) => (k === 'measureText' ? (t        ) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas      = document.getElementById('graph-canvas');
  canvas.getContext = () => ctx;
  canvas.getBoundingClientRect = rect(0, 700) ;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  state.canvas = canvas;
  state.ctx = ctx;
  Object.assign(state, { proposal: null, effectiveProposal: null, proposalSlug: null, proposalSource: null, proposalView: 'diff', proposalErrors: [], view: 'orbit', selectedNode: null, selectedEdge: null, scenario: null, activeLayers: { ...(state.activeLayers || {}), persona: true } });
  state.baseNodes = topology.nodes.map((n     ) => ({ ...n }));
  state.baseEdges = topology.edges;
  render.resize();
  setMap(state.baseNodes.map((n     ) => ({ ...n })), state.baseEdges);
  history.replaceState(null, '', '/');
  initSheets();
  initScenarioUi();
  initReviewColumn();
  clearScenario();
  await initProposals();
  initWhatIf();
  initReview();
  initChecks({ checker });
}
const open = (proposal         = robot(), source = 'pull/23') => showProposal(proposal, { slug: '0013-meals', source, view: 'diff', fit: true });

beforeEach(async () => { phone(false); await mount(); });
afterEach(() => { resetReviewForTests(); clearScenario(); vi.unstubAllGlobals(); document.body.innerHTML = ''; localStorage.clear(); });

describe('on screen the moment a proposal opens (D1)', () => {
  it('shows the changes and the personas with their scenarios, without pressing Play', () => {
    expect($('review-column').hidden).toBe(true);
    open();
    expect($('review-column').hidden).toBe(false);
    expect($('proposal-play')).toBeNull();
    expect(q('#rc-changes').getAttribute('data-corn')).toBe('change-list');
    expect(q('#rc-scenarios').getAttribute('data-corn')).toBe('scenario-list');
    expect(q('#rc-changes h3').textContent.replace(/\s+/g, ' ')).toBe('Changes · , 3');
    expect(q('#rc-scenarios h3').textContent.replace(/\s+/g, ' ')).toBe('Personas and scenarios · , 3');
    expect(qa('#rc-changes li button')).toHaveLength(3);
    expect(qa('.hx-sc-row').map((b) => b.querySelector('.hx-sc-title') .textContent)).toEqual(['An adult plans a meal', 'A guest asks, an admin answers', 'A guest asks, an admin answers', 'The old page goes']);
  });

  it('closes with the proposal', () => {
    open();
    document.querySelector('[data-action="close-proposal"]') .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect($('review-column').hidden).toBe(true);
  });

  it('is the room the map is framed into: the free map leaves the column out, and a change is framed in it', () => {
    $('proposal-bar').getBoundingClientRect = rect(48, 190) ;
    $('review-column').getBoundingClientRect = rect(190, 700, 12, 412) ;
    open();
    const r = visibleMapRect();
    expect(r.x).toBeGreaterThanOrEqual(412);
    for (const n of state.nodes.filter((x     ) => ['page-meals', 'table-t'].includes(x.id))) {
      const px = state.camera.x + n.x * state.camera.zoom;
      expect(px, n.id).toBeGreaterThanOrEqual(r.x);
    }
  });
});

describe('personas first (D2) and the headings a screen reader jumps by (D5)', () => {
  it('has an h4 for each persona with its count, a ul of scenarios, Anyone last, and says which personas act in no scenario', () => {
    open();
    const h4 = qa('#rc-scenarios h4').map((h) => h.textContent.replace(/\s+/g, ' '));
    expect(h4).toEqual(['Adult · , 1 scenario', 'Guest (no account) · , 1 scenario', 'Admin · , 1 scenario', 'Anyone · , 1 scenario']);
    expect(qa('[data-corn="persona-group"]').every((g) => g.querySelector('ul'))).toBe(true);
    expect(q('.hx-rc-coverage').textContent).toBe('Not in any scenario: Child');
  });

  it('says what is shown when the proposal has no scenarios', () => {
    open(robot({ scenarios: undefined }));
    expect(q('#rc-scenarios').textContent).toMatch(/This proposal has no scenarios/);
    expect(qa('.hx-sc-row')).toHaveLength(0);
    expect($('review-decision')).not.toBeNull(); // and it still reviews
  });

  it('says what is shown when the project has no personas: every scenario is under Anyone', async () => {
    await mount(base(false));
    open();
    expect(q('.hx-rc-note').textContent).toMatch(/This map has no personas \(topology\.personas\.json\), so every scenario is listed under Anyone/);
    expect(q('.hx-rc-coverage')).toBeNull();
  });
});

describe('a scenario reads as a list of steps (D4)', () => {
  it('opens on its button (aria-expanded, aria-controls an ol), with each step: number, who, node, mark, text; and a step is a button named as one sentence', () => {
    open();
    const row = qa('.hx-sc-row')[0];
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(row.querySelector('.hx-sc-meta') .textContent).toBe('2 steps · walks 2 of 3 changes');
    click(row);
    const again = qa('.hx-sc-row')[0];
    expect(again.getAttribute('aria-expanded')).toBe('true');
    const list = document.getElementById(again.getAttribute('aria-controls') );
    expect(list.tagName).toBe('OL');
    expect(list.getAttribute('data-corn')).toBe('step-list');
    const steps = [...list.querySelectorAll('[data-corn="step"]')];
    expect(steps.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Step 1 of 2, as Adult: /meals, Added. The page opens. Not checked: nothing in this step to ask.',
      'Step 2 of 2, as Adult: /meals → table-t, Added. The row is stored. Checking…',
    ]);
    expect(steps[0].textContent).toContain('As Adult');
  });

  it('opens one at a time, and an hand-over names who acts at each step', () => {
    open();
    click(qa('.hx-sc-row')[1]);
    expect(qa('.hx-sc-row').filter((b) => b.getAttribute('aria-expanded') === 'true')).toHaveLength(2); // the same scenario under Guest and under Admin
    click(qa('.hx-sc-row')[0]);
    expect(qa('.hx-sc-row').filter((b) => b.getAttribute('aria-expanded') === 'true')).toHaveLength(1);
    click(qa('.hx-sc-row')[1]);
    const labels = qa('#rc-scenarios [data-corn="step"]').map((s) => s.getAttribute('aria-label'));
    expect(labels[0]).toContain('as Guest (no account)');
    expect(labels[1]).toContain('as Admin');
  });

  it('shows no verdict words for a step nobody acts, and not checked words when there is no checker', async () => {
    open();
    click(qa('.hx-sc-row')[3]);
    expect(q('[data-corn="step"]') .getAttribute('aria-label')).toBe('Step 1 of 1: page-old, Removed. It is removed.');
    expect(q('[data-corn="state-pill"]')).toBeNull();
    click(qa('.hx-sc-row')[3]);
    click(qa('.hx-sc-row')[0]);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(qa('[data-corn="state-pill"]').map((p) => p.textContent)).toEqual(['Not checked: nothing in this step to ask', 'Not checked: the checker did not answer (no permission checker)']);
    expect(qa('[data-corn="state-pill"]').every((p) => !p.hasAttribute('data-corn-state'))).toBe(true); // not checked: no state, the words carry it
  });

  it('asks the checks once for an opened scenario, as one batch, and shows each verdict in words with its state', async () => {
    const calls            = [];
    const checker = { name: 'test', async check(items         ) { calls.push(items.length); return items.map((i         , k         ) => ({ id: i.id, allowed: k === 0, status: k === 0 ? 200 : 403, reason: k === 0 ? '' : 'Only admins.', checked: true })); } };
    await mount(base(), { checker });
    open(robot({ scenarios: [{ id: 'plan', title: 'Plan', actor: 'adult', steps: [{ node: 'page-meals', text: 'a', check: { route: '/meals', method: 'GET' } }, { node: 'page-meals', text: 'b', check: { route: '/meals', method: 'POST' } }] }] }));
    click(qa('.hx-sc-row')[0]);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([2]);
    const pills = qa('[data-corn="state-pill"]');
    expect(pills.map((p) => p.textContent)).toEqual(['Allowed', 'Refused: Only admins.']);
    expect(pills.map((p) => p.getAttribute('data-corn-state'))).toEqual(['success', 'failure']);
    expect(qa('.hx-sc-meta')[0].textContent).toBe('2 steps · walks 1 of 3 changes · 1 allowed · 1 refused');
    // opening nothing else asks nothing more; folding and opening it again asks again (a checker may be a live API)
    expect(calls).toHaveLength(1);
  });

  it('does not check anything when the proposal opens, only when a scenario does', async () => {
    const calls            = [];
    const checker = { name: 'test', async check(items         ) { calls.push(items.length); return []; } };
    await mount(base(), { checker });
    open();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
  });
});

describe('choosing a step goes to it (D4, D6)', () => {
  it('opens the player paused on the step, the list stays open and follows the player', () => {
    open();
    click(qa('.hx-sc-row')[0]);
    click(qa('[data-corn="step"]')[1]);
    const player = getPlayer();
    expect(player.snapshot().index).toBe(1);
    expect(player.snapshot().playing).toBe(false);
    expect(qa('.hx-sc-row')[0].getAttribute('aria-expanded')).toBe('true');
    expect(qa('[data-corn="step"]').map((s) => s.getAttribute('aria-current'))).toEqual([null, 'step']);
    (q('[data-action=scenario-prev]')                     ).click();
    expect(qa('[data-corn="step"]').map((s) => s.getAttribute('aria-current'))).toEqual(['step', null]);
  });

  it('playing a scenario to its end ticks it as played (information only), kept per proposal and PR head', () => {
    open();
    click(qa('.hx-sc-row')[3]);
    click(qa('[data-corn="step"]')[0]);
    (q('[data-action=scenario-next]')                     ).click();
    expect(qa('.hx-sc-seen').map((s) => s.textContent)).toEqual(['✓ Played']);
    expect(readSeen(localStorage, seenKey('pull/23', '0013-meals', ''))).toEqual({ played: ['gone'], read: [] });
    expect(q('.hx-rc-note[data-corn="notice"]').textContent).toBe('1 of 3 scenarios played');
    // it never gates the decision, and is not part of the review
    expect((q('[data-review="approved"]')                     ).hasAttribute('aria-disabled')).toBe(false);
    expect(Object.keys(reviewBody('approved', '', [])).sort()).toEqual(['edits', 'note', 'verdict']);
  });

  it('works without storage: a store that throws changes nothing about the review', () => {
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
    try {
      open();
      click(qa('.hx-sc-row')[0]);
      expect(qa('.hx-sc-row')[0].getAttribute('aria-expanded')).toBe('true');
      expect(qa('.hx-sc-seen')).toHaveLength(1); // read, for this visit
    } finally { if (real) Object.defineProperty(window, 'localStorage', real); }
  });
});

describe('the end of a scenario (D6)', () => {
  it('offers the next scenario in the list\'s order, each scenario once, and the list follows when it starts', () => {
    open();
    click(qa('.hx-sc-row')[0]); // An adult plans a meal
    click(qa('[data-corn="step"]')[0]);
    click(q('[data-action=scenario-next]'));
    click(q('[data-action=scenario-next]'));
    expect(q('.hx-player-step').textContent).toBe('Played to the end');
    const next = q('[data-action=scenario-next-scenario]') ;
    expect(next.hidden).toBe(false);
    click(next);
    expect(q('.hx-player-title').textContent).toBe('A guest asks, an admin answers'); // Guest comes after Adult
    expect(qa('.hx-sc-row').filter((b) => b.getAttribute('aria-expanded') === 'true')).toHaveLength(2); // the list opened it, under Guest and under Admin
    // "A guest asks, an admin answers" is under two personas but comes once: the next after it is Anyone's
    click(q('[data-action=scenario-next]'));
    click(q('[data-action=scenario-next]'));
    click(q('[data-action=scenario-next-scenario]') );
    expect(q('.hx-player-title').textContent).toBe('The old page goes');
    click(q('[data-action=scenario-next]'));
    expect(q('[data-action=scenario-next-scenario]').hidden).toBe(true); // the last one has none
  });
});

describe('what a project\'s files say is data (D5, the rules)', () => {
  const hostile = '"><img src=x onerror=alert(1)></script><b id="pwn">';
  it('escapes a hostile persona label and scenario title everywhere, and makes ids safe', async () => {
    const topology = base();
    topology.nodes.push(node('persona-evil', 'persona', 0, 0, { label: hostile, role: 'adult' }));
    await mount(topology);
    open(robot({ scenarios: [{ id: 'x" onmouseover="alert(1)', title: hostile, actor: 'evil', steps: [{ node: 'page-meals', text: hostile }] }] }));
    click(qa('.hx-sc-row')[0]);
    expect(document.getElementById('pwn')).toBeNull();
    expect(document.querySelector('#review-column img')).toBeNull();
    expect(document.querySelector('#review-column [onmouseover], #review-column [onerror]')).toBeNull();
    expect(qa('.hx-persona-name')[0].textContent).toContain(hostile);
    expect(qa('.hx-sc-title')[0].textContent).toBe(hostile);
    for (const el of qa('#review-column [id]')) expect(el.id, el.id).toMatch(/^[A-Za-z0-9_-]+$/);
    for (const el of qa('#review-column [data-persona]')) expect(el.getAttribute('data-persona') ).toMatch(/^[A-Za-z0-9_-]+$/);
    const sentence = qa('[data-corn="step"]')[0].getAttribute('aria-label') ;
    expect(sentence).toContain(hostile); // as an attribute value: text, not markup
  });
});

describe('on a phone (D1)', () => {
  beforeEach(async () => { phone(true); await mount(); });

  it('is the proposal sheet\'s body with a two-part switch; opens on Scenarios when there are any, and remembers the choice', () => {
    open();
    expect($('review-column').parentElement .id).toBe('proposal-body');
    const tabs = qa('[role="tab"]');
    expect(tabs.map((t) => t.textContent)).toEqual(['Changes · 3', 'Scenarios · 3']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true']);
    expect($('rc-changes').hidden).toBe(true);
    expect($('rc-scenarios').hidden).toBe(false);
    expect($('rc-scenarios').getAttribute('role')).toBe('tabpanel');
    expect(q('[role="tablist"]') .getAttribute('data-corn')).toBe('tabs');
    expandSheet('proposal'); // a tap on a peek only expands it
    click(tabs[0]);
    expect($('rc-changes').hidden).toBe(false);
    expect(localStorage.getItem('cornfield.reviewTab')).toBe('changes');
    // another proposal opens on the tab chosen last
    open(robot(), 'pull/24');
    expect($('rc-changes').hidden).toBe(false);
  });

  it('opens on Changes for a proposal with no scenarios, and the peek reads the counts', () => {
    open(robot({ scenarios: undefined }));
    expect(qa('[role="tab"]')[0].getAttribute('aria-selected')).toBe('true');
    expect($('proposal-peek').textContent).toBe('3 changes');
    open();
    expect($('proposal-peek').textContent).toBe('3 changes · 3 scenarios for 3 personas');
  });

  it('moves between the tabs with the arrow keys', () => {
    open();
    const tab = qa('[role="tab"]')[1];
    tab.focus();
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe($('rc-tab-changes'));
  });

  it('the decision is the foot of the sheet, and the scenario player folds the sheet; closing it opens the sheet on the step again', () => {
    open();
    expect($('review-decision').closest('#proposal-body')).not.toBeNull();
    expandSheet('proposal');
    click(qa('.hx-sc-row')[0]);
    click(qa('[data-corn="step"]')[0]);
    expect(expandedSheet()).not.toBe('proposal');
    (q('[data-action=scenario-close]')                     ).focus();
    click(q('[data-action=scenario-close]'));
    expect(expandedSheet()).toBe('proposal');
    expect(document.activeElement.getAttribute('data-corn')).toBe('step');
  });
});

describe('the counts open their section (D1)', () => {
  it('"3 scenarios" takes the focus to the Scenarios heading, and the changes part to Changes', () => {
    open();
    click(q('[data-action="review-show-scenarios"]') );
    expect(document.activeElement).toBe($('rc-scenarios-h'));
    click(q('[data-action="review-show-changes"]') );
    expect(document.activeElement).toBe($('rc-changes-h'));
  });
});

describe('the whole review without the canvas (D5): the path a keyboard or a screen reader takes', () => {
  /** The controls Tab visits, in the page's order: what is visible and not disabled, in the bar and the column */
  const tabOrder = () => qa('#proposal-bar a[href], #proposal-bar button, #proposal-bar select, #review-column button, #review-column textarea')
    .filter((el) => !el.closest('[hidden]') && !el.disabled && el.tabIndex >= 0);
  const name = (el         ) => el.getAttribute('aria-label') || el.textContent .replace(/\s+/g, ' ').trim();

  it('has the headings a reader jumps by, in document order: the title, Changes, Personas and scenarios, then each persona', () => {
    open();
    const headings = qa('#proposal-bar h2, #review-column h3, #review-column h4').map((h) => `${h.tagName.toLowerCase()} ${h.textContent.replace(/\s+/g, ' ').trim()}`);
    expect(headings).toEqual(['h2 Meals', 'h3 Changes · , 3', 'h3 Personas and scenarios · , 3', 'h4 Adult · , 1 scenario', 'h4 Guest (no account) · , 1 scenario', 'h4 Admin · , 1 scenario', 'h4 Anyone · , 1 scenario']);
    // the title is in the bar's region, named "Open proposal"; the decision is the column's last group
    expect($('proposal-title').closest('[aria-label="Open proposal"]')).not.toBeNull();
    const groups = qa('#review-column [role="group"]');
    expect(groups[groups.length - 1].getAttribute('aria-label')).toBe('Decision');
  });

  it('reaches, with Tab alone, every change, every scenario, every step of an opened one and then Send back and Approve', () => {
    open();
    const row = qa('.hx-sc-row')[0];
    row.focus();
    click(row); // Enter or Space on a button is a click
    const names = tabOrder().map(name);
    const at = (text         ) => names.findIndex((n) => n.includes(text));
    // the bar first, then the changes, then the scenarios (the open one followed by its steps), then the decision
    expect(at('Edit')).toBeLessThan(at('Added /meals, page'));
    expect(at('Added /meals, page')).toBeLessThan(at('Removed page-old, page'));
    expect(at('Removed page-old, page')).toBeLessThan(at('An adult plans a meal'));
    expect(at('An adult plans a meal')).toBeLessThan(at('Step 1 of 2, as Adult'));
    expect(at('Step 1 of 2, as Adult')).toBeLessThan(at('Step 2 of 2, as Adult'));
    expect(at('Step 2 of 2, as Adult')).toBeLessThan(at('A guest asks, an admin answers'));
    expect(at('The old page goes')).toBeLessThan(at('Send back'));
    expect(at('Send back')).toBeLessThan(at('Approve'));
    expect(names[names.length - 1]).toBe('Approve');
    // and each of them is a button with a name: nothing is a bare div
    for (const el of qa('#review-column button')) expect(name(el), el.outerHTML.slice(0, 80)).not.toBe('');
  });

  it('plays the whole way through by keyboard: a step is chosen with Enter, the player takes the arrows and Space, Escape comes back to the step', () => {
    open();
    click(qa('.hx-sc-row')[0]);
    const step = qa('[data-corn="step"]')[0];
    step.focus();
    click(step); // Enter
    expect(document.activeElement.getAttribute('data-focus-key')).toBe(step.getAttribute('data-focus-key'));
    const key = (k         , target          ) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k === ' ' ? 'Space' : k, bubbles: true, cancelable: true }));
    key('ArrowRight', document.activeElement );
    expect(getPlayer().snapshot().index).toBe(1);
    expect(qa('[data-corn="step"]').map((s) => s.getAttribute('aria-current'))).toEqual([null, 'step']);
    const space = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
    document.activeElement .dispatchEvent(space);
    expect(space.defaultPrevented).toBe(false); // on a step Space presses the button, it does not start the walk
    tickScenario(0);
    key('Escape', document.activeElement );
    expect(getPlayer()).toBeNull();
    expect(document.activeElement.getAttribute('data-step-index')).toBe('1'); // on the step it was on
    expect(document.activeElement).not.toBe(document.body);
  });
});
