// @vitest-environment happy-dom
/**
 * The keyboard and screen-reader pass (MAP-02), on the page's own markup (explorer/index.html) with its stylesheets:
 *
 *  - axe-core finds no violation in each state the explorer has: the map, the Layers menu, a node's panel, a
 *    proposal open with what-if editing, the scenario player. happy-dom has no layout, so the rules that need one
 *    (colour contrast) are left to a real browser: the PR runs axe in Chromium as well;
 *  - everything the pointer does on the map has a key: pan, zoom, fit, select a node, open and close its panel,
 *    move a node in Freeform, draw an edge in a what-if edit; and a screen reader is told where the keyboard landed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import axe from 'axe-core';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { setMap } from '../../explorer/view.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { selectNode, closeDrawer } from '../../explorer/panels.js';
// @ts-expect-error plain JS modules, no declarations
import { initKeyboard, resetKeyboardForTests } from '../../explorer/keyboard.js';
// @ts-expect-error plain JS modules, no declarations
import { readingOrder } from '../../explorer/keyboard-model.js';
// @ts-expect-error plain JS modules, no declarations
import { toggleLegendMenu, renderLayerToggles } from '../../explorer/layers.js';
// @ts-expect-error plain JS modules, no declarations
import { initProposals, openProposal, closeProposal } from '../../explorer/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import { initWhatIf, resetWhatIfForTests } from '../../explorer/whatif.js';
// @ts-expect-error plain JS modules, no declarations
import { initMockups, resetMockupsForTests, openMockup, closeMockup } from '../../explorer/mockups.js';
// @ts-expect-error plain JS modules, no declarations
import { initScenarioUi, playScenario, clearScenario } from '../../explorer/scenario-ui.js';

// @ts-expect-error plain JS modules, no declarations
import { initForgePanel, resetForgePanelForTests, openForge, closeForge } from '../../explorer/forge-panel.js';

const EXPLORER = path.resolve(__dirname, '../../explorer');
const page = fs.readFileSync(path.join(EXPLORER, 'index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const css = ['explorer.css', 'house.css'].map((f) => fs.readFileSync(path.join(EXPLORER, f), 'utf8')).join('\n');

const node = (id, type, x, y, extra = {}) => ({ id, type, x, y, r: 20, color: '#336699', label: id, degree: 1, ...extra });
const MAP = {
  nodes: [node('root', 'root', 0, 0), node('app-a', 'app', 200, 0), node('page-a', 'page', 300, 100, { label: '/orders' }), node('table-t', 'table', -200, 100, { label: 'orders' })],
  edges: [{ from: 'root', to: 'app-a' }, { from: 'app-a', to: 'page-a' }, { from: 'page-a', to: 'table-t', kind: 'reads', keys: ['a'], status: 'live', label: 'rows' }],
};
const PROPOSAL = {
  version: 1, title: 'Meals', summary: 'Adds /meals.',
  nodes: { add: [{ id: 'page-new', label: '/meals', type: 'page', parent: 'app-a' }] },
  scenarios: [{ id: 's', title: 'A walk', steps: [{ node: 'page-new', text: 'You open meals.' }, { node: 'table-t', text: 'It reads orders.' }] }],
};

const MOCKUPS = [
  { node: 'page-new', path: 'screens/list.png', title: 'The meal list' },
  { node: 'page-new', path: 'screens/edit.html', title: 'The edit form' },
];
const PROPOSAL_WITH_MOCKUPS = { ...PROPOSAL, mockups: MOCKUPS };

const $ = (id) => document.getElementById(id);
const key = (el, k, opts = {}) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }); el.dispatchEvent(e); return e; };
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** axe on the page as it stands, rules that need a layout off; returns the violations as "rule: target" */
async function audit() {
  // An iframe is left to its own check below: happy-dom cannot run axe across a frame
  const r = await axe.run({ include: [document.documentElement], exclude: [['iframe']] }, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, rules: { 'color-contrast': { enabled: false } } });
  return r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

function mount() {
  document.head.innerHTML = `<title>cornfield</title><style>${css}</style>`;
  document.documentElement.lang = 'en';
  document.body.innerHTML = body;
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (t) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas = $('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  Object.assign(state, { canvas, ctx, labelCanvas: null, proposal: null, proposalView: 'diff', proposalErrors: [], view: 'orbit', selectedNode: null, isFreeform: false, scenario: null, searchQuery: '' });
  state.camera = { x: 0, y: 0, zoom: 1 };
  render.resize();
  state.baseNodes = MAP.nodes.map((n) => ({ ...n }));
  state.baseEdges = MAP.edges;
  setMap(MAP.nodes.map((n) => ({ ...n })), MAP.edges);
  resetKeyboardForTests();
  initKeyboard();
  return canvas;
}

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); });
afterEach(() => { clearScenario(); closeDrawer(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('axe finds no violation', () => {
  it('on the map as it loads', async () => {
    mount();
    expect(await audit()).toEqual([]);
  });

  it('in the light theme too, the toggle named by what is on (contrast is checked in Chromium, in both themes)', async () => {
    mount();
    document.documentElement.dataset.theme = 'light';
    expect($('theme-toggle-btn').getAttribute('aria-label')).toMatch(/^Theme: /);
    expect(await audit()).toEqual([]);
    delete document.documentElement.dataset.theme;
  });

  it('with the Layers menu open, which says it is open', async () => {
    mount();
    renderLayerToggles();
    toggleLegendMenu();
    expect($('legend-toggle-btn').getAttribute('aria-expanded')).toBe('true');
    expect(await audit()).toEqual([]);
  });

  it('with a node\'s panel open; closed, the panel is inert so Tab never reaches it off screen', async () => {
    mount();
    expect($('spec-drawer').inert).toBe(true);
    await selectNode(state.nodes.find((n) => n.id === 'table-t'));
    expect($('spec-drawer').inert).toBe(false);
    expect(await audit()).toEqual([]);
    closeDrawer();
    expect($('spec-drawer').inert).toBe(true);
  });

  it('with a proposal open, what-if editing on, and the scenario player playing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = new URL(url, 'http://localhost');
      if (u.pathname === '/proposals') return { ok: true, status: 200, headers: new Headers(), json: async () => [{ slug: '0013-meals', title: 'Meals', summary: 'Adds /meals.', source: 'checkout', counts: { added: 1, changed: 0, removed: 0, scenarios: 1 }, errors: 0 }] };
      if (u.pathname.endsWith('/review')) return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
      return { ok: true, status: 200, headers: new Headers({ 'X-Proposal-Source': 'checkout' }), json: async () => structuredClone(PROPOSAL) };
    }));
    mount();
    resetWhatIfForTests();
    initWhatIf();
    await initProposals();
    initScenarioUi();
    expect(await openProposal('0013-meals', 'checkout')).toBe(true);
    await settle();
    expect(await audit()).toEqual([]);
    await selectNode(state.nodes.find((n) => n.id === 'app-a'));
    expect(await audit()).toEqual([]);
    playScenario(PROPOSAL.scenarios[0], { autoplay: false });
    await settle();
    expect(document.querySelector('.hx-player')).not.toBe(null);
    expect(await audit()).toEqual([]);
    clearScenario();
    closeProposal();
  });
});

describe('axe finds no violation with a proposal\'s mockups', () => {
  /** A node\'s panel with its mockups, then each opened in its window, in the dark and the light theme (contrast is checked in Chromium) */
  it('in a node\'s panel and in the window a picture and a page open in, in both themes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = new URL(url, 'http://localhost');
      if (u.pathname === '/proposals') return { ok: true, status: 200, headers: new Headers(), json: async () => [{ slug: '0013-meals', title: 'Meals', summary: 'Adds /meals.', source: 'checkout', counts: { added: 1, changed: 0, removed: 0, scenarios: 1 }, errors: 0 }] };
      if (u.pathname.endsWith('/review')) return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
      if (u.pathname.endsWith('/mockups')) return { ok: true, status: 200, headers: new Headers(), json: async () => [{ index: 0, state: 'approved' }, { index: 1, state: 'changed' }] };
      return { ok: true, status: 200, headers: new Headers({ 'X-Proposal-Source': 'checkout' }), json: async () => structuredClone(PROPOSAL_WITH_MOCKUPS) };
    }));
    mount();
    window.happyDOM.settings.disableIframePageLoading = true; // the frame's address is the server's; nothing is fetched here (happy-dom still logs that it declined)
    resetWhatIfForTests();
    resetMockupsForTests();
    initWhatIf();
    initMockups();
    await initProposals();
    expect(await openProposal('0013-meals', 'checkout')).toBe(true);
    await settle();
    await selectNode(state.nodes.find((n) => n.id === 'page-new'));
    const buttons = [...document.querySelectorAll('#drawer-meta-list [data-mockup]')];
    expect(buttons.map((b) => b.textContent.trim())).toEqual(['The meal list (image, opens in a window)', 'The edit form (page, opens in a window)']);
    expect(document.querySelector('#drawer-meta-list').textContent).toContain('Changed since you approved');
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') document.documentElement.dataset.theme = 'light';
      expect(await audit(), `${theme}: the panel`).toEqual([]);
      for (const b of buttons) {
        b.click();
        const dialog = document.querySelector('.hx-mockup-dialog[role="dialog"]');
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.contains(document.activeElement) || dialog === document.activeElement).toBe(true);
        const frame = dialog.querySelector('iframe');
        if (frame) expect([frame.getAttribute('sandbox'), frame.getAttribute('title')]).toEqual(['', 'The edit form']);
        else expect(dialog.querySelector('img').getAttribute('alt')).toBe('The meal list');
        expect(await audit(), `${theme}: ${b.textContent.trim()} open`).toEqual([]);
        closeMockup();
        expect(document.activeElement).toBe(b);
      }
    }
    delete document.documentElement.dataset.theme;
    resetMockupsForTests();
    clearScenario();
    closeProposal();
  });
});

describe('the issues and PRs panel', () => {
  const author = { login: 'agent-four', url: 'https://git.example.test/agent-four' };
  const pr = (number, title, extra = {}) => ({ number, title, state: 'open', draft: false, author, labels: ['agent'], head: { ref: 'b', sha: 'abc' }, base: { ref: 'main' }, url: `https://git.example.test/pull/${number}`, createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-17T11:00:00Z', mergedAt: null, ...extra });
  const DETAIL = {
    pull: pr(13, 'Lint everything'),
    files: [{ path: 'app-a', status: 'modified', previousPath: null, additions: 2, deletions: 1 }, { path: 'README.md', status: 'added', previousPath: null, additions: 5, deletions: 0 }],
    checks: [{ id: 'run:1', name: 'lint', state: 'failure', url: 'https://git.example.test/runs/1', rerunnable: true, canRerun: true }, { id: 'run:2', name: 'test', state: 'running', url: null, rerunnable: false, canRerun: false }, { id: 'status:ci', name: 'ci', state: 'failure', url: null, rerunnable: false, canRerun: false }],
  };
  const GREEN = { pull: pr(12, 'Meals page'), files: DETAIL.files, checks: [{ id: 'run:7', name: 'test', state: 'success', url: 'https://git.example.test/runs/7', rerunnable: false, canRerun: false }] };
  const NOTES = {
    since: { name: 'v0.2.0', date: '2026-10-12T09:00:00Z' }, tags: ['v0.2.0', 'v0.1.0'], suggestedTag: 'v0.3.0', count: 2, truncated: false,
    groups: [{ kind: 'area', id: 'app-a', title: 'a', items: [{ number: 13 }] }, { kind: 'other', id: 'other', title: 'Other', items: [{ number: 12 }] }],
    markdown: '### a\n\n- Lint everything ([#13](https://git.example.test/pull/13) by @agent-four) · `/orders`\n\n### Other\n\n- Meals page ([#12](https://git.example.test/pull/12))\n',
  };
  const stub = () => vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const u = new URL(url, 'http://localhost');
    if (init.method === 'POST') return { ok: true, status: 201, headers: new Headers(), json: async () => ({ ok: true, count: 2, release: { id: '1', url: 'https://git.example.test/releases/1', draft: true } }) };
    const work = {
      agents: { authors: [], labels: ['agent'], branchPrefixes: ['claude/'], bots: true },
      pulls: [pr(13, 'Lint everything', { body: 'Closes #5' }), pr(12, 'Meals page', { draft: true, labels: [], body: '' }), pr(9, 'Old work', { state: 'merged', labels: [], body: 'Closes #5' })],
      issues: [{ number: 5, title: 'Sign-in', state: 'open', author, labels: [], comments: 0, url: 'https://git.example.test/issues/5', createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z', closedAt: null }],
      branches: [{ name: 'claude/5-notes', sha: 'n', protected: false }, { name: 'claude/lone', sha: 'l', protected: false }],
      specs: [{ pull: 12, slug: '0013-meals' }], specsProblem: null,
    };
    const data = u.pathname === '/api/forge/pulls' ? { items: [pr(13, 'Lint everything'), pr(12, 'Meals page', { draft: true, labels: [] })] } : u.pathname === '/api/forge/release-notes' ? NOTES : u.pathname === '/api/forge/work' ? work : u.pathname.endsWith('/12') ? GREEN : DETAIL;
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: true, at: '2026-10-19T11:58:00.000Z', rate: '48 of 5000 GitHub calls left.', ...data }) };
  }));
  const start = () => {
    const canvas = mount();
    resetForgePanelForTests();
    initForgePanel({ forge: { type: 'github', repo: 'owner/name' }, signIn: { login: 'maintainer-one' } });
    return canvas;
  };
  afterEach(() => { closeForge({ restoreFocus: false }); resetForgePanelForTests(); delete document.documentElement.dataset.theme; });

  it('is not on the page without a forge, and the page passes as it did', async () => {
    mount();
    resetForgePanelForTests();
    expect(initForgePanel({ forge: null })).toBe(false);
    expect($('forge-btn').hidden).toBe(true);
    expect($('forge-panel').hidden).toBe(true);
    expect(await audit()).toEqual([]);
  });

  it('has no violation closed (inert off screen), open with its lists, and with a pull request selected', async () => {
    stub();
    start();
    expect($('forge-panel').inert).toBe(true);
    expect(await audit()).toEqual([]);
    openForge();
    await settle();
    expect(document.querySelectorAll('#forge-list .hx-forge-item').length).toBe(2);
    expect(await audit()).toEqual([]);
    document.querySelector('[data-forge-pr="13"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(document.querySelectorAll('.hx-forge-file').length).toBe(2);
    expect(await audit()).toEqual([]);
    document.querySelector('[data-forge-kind="issues"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(await audit()).toEqual([]);
  });

  it('has none in the light theme either (contrast is checked in Chromium, in both themes)', async () => {
    stub();
    start();
    document.documentElement.dataset.theme = 'light';
    openForge();
    await settle();
    document.querySelector('[data-forge-pr="13"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(await audit()).toEqual([]);
  });

  it('has none on the Agents tab: its groups, the marks, a selected pull request, the finished work shown (dark)', async () => {
    stub();
    start();
    openForge();
    await settle();
    document.querySelector('[data-forge-kind="work"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(document.querySelectorAll('#forge-list .hx-forge-group').length).toBe(3);
    expect(document.querySelectorAll('.hx-forge-agent').length).toBeGreaterThan(0);
    expect(await audit()).toEqual([]);
    document.querySelector('[data-forge-pr="13"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(document.querySelectorAll('.hx-forge-file').length).toBe(2);
    expect(await audit()).toEqual([]);
    const finished = $('forge-work-finished');
    finished.checked = true;
    finished.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.querySelector('[data-forge-pr="9"]')).not.toBe(null);
    expect(await audit()).toEqual([]);
  });

  it('has none on the Agents tab in the light theme either', async () => {
    stub();
    start();
    document.documentElement.dataset.theme = 'light';
    openForge();
    await settle();
    document.querySelector('[data-forge-kind="work"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(document.querySelectorAll('.hx-forge-agent').length).toBeGreaterThan(0);
    expect(await audit()).toEqual([]);
    const agents = $('forge-work-agents');
    agents.checked = true;
    agents.dispatchEvent(new Event('change', { bubbles: true }));
    expect(await audit()).toEqual([]);
  });

  it('has none with the actions shown (Re-run, the reasons why not, Land it) and with the confirm dialog open, in both themes', async () => {
    stub();
    start();
    openForge();
    await settle();
    const click = (sel) => document.querySelector(sel).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    click('[data-forge-pr="13"]');
    await settle();
    expect(document.querySelectorAll('[data-forge-rerun]').length).toBe(1);
    expect(document.querySelectorAll('.hx-forge-lights').length).toBeGreaterThan(1);
    expect(await audit()).toEqual([]);
    click('[data-forge-pr="13"]');
    click('[data-forge-pr="12"]');
    await settle();
    expect(document.querySelector('[data-forge-merge]')).not.toBe(null);
    expect(await audit()).toEqual([]);
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') document.documentElement.dataset.theme = 'light';
      click('[data-forge-merge]');
      expect($('forge-confirm').hidden).toBe(false);
      expect(document.activeElement.dataset.action).toBe('forge-confirm-cancel');
      expect(await audit()).toEqual([]);
      key(document.activeElement, 'Escape');
      expect($('forge-confirm').hidden).toBe(true);
      expect(document.activeElement).toBe(document.querySelector('[data-forge-merge]'));
    }
    expect(await audit()).toEqual([]);
  });


  /** The Release notes tab through its states: the draft, the confirm step, a message after Copy and after Post */
  async function auditNotes() {
    openForge();
    await settle();
    document.querySelector('[data-forge-kind="notes"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect($('notes-preview').value).toContain('### a');
    expect(await audit()).toEqual([]);
    $('notes-post').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect($('notes-confirm').hidden).toBe(false);
    expect(await audit()).toEqual([]);
    $('notes-confirm-yes').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect($('notes-message').textContent).toMatch(/^Draft release v0\.3\.0 created/);
    expect(await audit()).toEqual([]);
    $('notes-copy').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle(40);
    expect($('notes-message').hidden).toBe(false);
    expect(await audit()).toEqual([]);
  }

  it('has none on the Release notes tab: the draft, the confirm step, and the words after Copy and Post', async () => {
    stub();
    start();
    await auditNotes();
  });

  it('has none on the Release notes tab in the light theme either', async () => {
    stub();
    start();
    document.documentElement.dataset.theme = 'light';
    await auditNotes();
  });

  it('reaches every control of the Release notes tab with Tab, names them, and says what the draft is', async () => {
    stub();
    start();
    openForge();
    await settle();
    document.querySelector('[data-forge-kind="notes"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    $('notes-post').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    const controls = ['notes-since', 'notes-preview', 'notes-copy', 'notes-post', 'notes-tag', 'notes-confirm-yes'].map($);
    for (const el of controls) {
      expect(el.tabIndex, el.id).toBe(0);
      expect(el.disabled, el.id).toBeFalsy();
      expect(el.closest('[inert]'), el.id).toBeNull();
    }
    expect($('notes-preview').closest('label').textContent).toContain('Draft, in Markdown');
    expect($('notes-since').closest('label').textContent).toContain('Since tag');
    expect($('notes-tag').closest('label').textContent).toContain('Tag for the draft');
    expect($('notes-post').getAttribute('aria-controls')).toBe('notes-confirm');
    expect($('notes-post').getAttribute('aria-expanded')).toBe('true');
    expect($('notes-confirm').getAttribute('aria-labelledby')).toBe('notes-confirm-title');
    expect($('notes-confirm-title').textContent).toBe('Post as a draft release');
  });

  describe('with the deploys list', () => {
    const run = (id, name, state, restarts) => ({ id, workflow: 'deploy.yml', name, title: `Run ${id}`, event: 'push', branch: 'main', sha: 'abc1234', state, actor: author, url: `https://git.example.test/runs/${id}`, createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-17T11:00:00Z', restarts });
    const DEPLOYS = [run('3', 'Deploy web', 'success', ['app-a', 'ghost']), run('2', 'Deploy media', 'running', []), run('1', 'Deploy web', 'failure', ['table-t'])];
    const stubDeploys = () => vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: true, at: '2026-10-19T11:58:00.000Z', rate: '', items: new URL(url, 'http://localhost').pathname === '/api/forge/deploys' ? DEPLOYS : [] }) })));
    const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    it('has no violation listing deploys, with a mapped one selected, an unmapped one, and a failed one (dark theme)', async () => {
      stubDeploys();
      start();
      openForge();
      await settle();
      click(document.querySelector('[data-forge-kind="deploys"]'));
      await settle();
      expect(document.querySelectorAll('#forge-list .hx-forge-item').length).toBe(3);
      expect(await audit()).toEqual([]);
      for (const id of ['3', '2', '1']) {
        click(document.querySelector(`[data-forge-deploy="${id}"]`));
        await settle();
        expect(document.querySelector('#forge-detail').hidden).toBe(false);
        expect(await audit()).toEqual([]);
      }
      expect(state.forgeLit.failing.has('table-t')).toBe(true);
    });

    it('has none in the light theme either', async () => {
      stubDeploys();
      start();
      document.documentElement.dataset.theme = 'light';
      openForge();
      await settle();
      click(document.querySelector('[data-forge-kind="deploys"]'));
      await settle();
      click(document.querySelector('[data-forge-deploy="3"]'));
      await settle();
      expect(await audit()).toEqual([]);
      click(document.querySelector('[data-forge-deploy="2"]'));
      await settle();
      expect(await audit()).toEqual([]);
    });

    it('is by keyboard: the tab, the rows and Clear are buttons in the tab order, the selection is announced, Escape closes', async () => {
      stubDeploys();
      start();
      openForge();
      await settle();
      const tab = document.querySelector('[data-forge-kind="deploys"]');
      expect(tab.tagName).toBe('BUTTON');
      expect(tab.tabIndex).toBe(0);
      click(tab); // Enter and Space on a button are a click
      await settle(40);
      expect($('map-announcer').textContent).toBe('3 deploys shown');
      const row = document.querySelector('[data-forge-deploy="3"]');
      expect([row.tagName, row.tabIndex, row.getAttribute('aria-pressed')]).toEqual(['BUTTON', 0, 'false']);
      row.focus();
      click(row);
      await settle(40);
      const again = document.querySelector('[data-forge-deploy="3"]'); // the list is drawn anew; the focus is on the same row
      expect(document.activeElement).toBe(again);
      expect(again.getAttribute('aria-pressed')).toBe('true');
      expect($('map-announcer').textContent).toBe('Deploy Deploy web of main, succeeded: 1 node restarted and lit, 1 named that is not on the map.');
      const clear = document.querySelector('[data-action="clear-forge-deploy"]');
      expect([clear.tagName, clear.tabIndex]).toEqual(['BUTTON', 0]);
      expect(document.querySelector('#forge-detail').getAttribute('aria-label')).toBe('Selected deploy');
      key($('forge-title'), 'Escape');
      expect(document.activeElement).toBe($('forge-btn'));
      expect($('forge-btn-lit').textContent).toBe('deploy');
    });
  });

  // The pipeline's steps (PIPE-05): the same page for both, each step a test of its own so each fits the suite's time limit
  const pipelinePage = async () => {
    const spec = { number: 40, title: 'Meals spec', state: 'open', draft: true, author, labels: [], head: { ref: 'spec/0040-meals', sha: 'abc' }, base: { ref: 'main' }, url: 'https://git.example.test/pull/40', createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-17T11:00:00Z', mergedAt: null };
    const SPEC_PLAN = { kind: 'spec', digest: 'a'.repeat(32), issue: { number: 7, title: 'Meals page', url: 'https://git.example.test/issues/7' }, base: 'main', branch: 'spec/0007-meals-page', path: 'docs/specs/proposals/0007-meals-page.json', message: 'Start a spec for #7', title: 'Spec: Meals page', body: 'Refs #7\n\nA draft pull request.', content: '{\n  "version": 1,\n  "title": "Meals page"\n}\n', existing: null };
    const BUILD_PLAN = { kind: 'build', digest: 'b'.repeat(32), pull: { number: 40, title: 'Meals spec', url: spec.url }, slug: '0040-meals', path: 'docs/specs/proposals/0040-meals.json', sha: 'abc', review: { by: 'maintainer-one', url: 'https://git.example.test/c/1', at: '2026-10-19T10:00:00Z' }, title: 'Build: Meals', body: 'Build the approved proposal `0040-meals`.\n\n## Nodes\n\n- [ ] Add `page-meals`\n', items: 1, existing: null };
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = new URL(url, 'http://localhost');
      const data = {
        '/api/forge/pulls': { items: [spec] },
        '/api/forge/issues': { items: [pr(7, 'Meals page', { head: undefined }), pr(8, 'Closed one', { state: 'closed' })] },
        '/api/forge/issues/7/spec': { plan: SPEC_PLAN },
        '/api/forge/pulls/40/build': { plan: BUILD_PLAN },
        '/api/forge/pulls/40': { pull: spec, files: [{ path: 'docs/specs/proposals/0040-meals.json', status: 'added', previousPath: null, additions: 5, deletions: 0 }], checks: [], specs: [{ slug: '0040-meals', path: 'docs/specs/proposals/0040-meals.json', approved: true }, { slug: '0041-other', path: 'docs/specs/proposals/0041-other.json', approved: false, changed: false }, { slug: '0042-moved', path: 'docs/specs/proposals/0042-moved.json', approved: false, changed: true }] },
      }[u.pathname];
      return { ok: !!data, status: data ? 200 : 404, headers: new Headers(), json: async () => (data ? { ok: true, at: '2026-10-19T11:58:00.000Z', rate: '', ...data } : { ok: false, error: 'No.' }) };
    }));
    start();
    openForge();
    await settle();
    const click = (sel) => document.querySelector(sel).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return click;
  };

  it('has none with the pipeline\'s Start a spec on an issue, its confirm step open, in both themes', async () => {
    const click = await pipelinePage();
    click('[data-forge-kind="issues"]');
    await settle();
    expect(document.querySelectorAll('[data-forge-spec]').length).toBe(1);
    expect(await audit()).toEqual([]);
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') document.documentElement.dataset.theme = 'light';
      click('[data-forge-spec="7"]');
      await settle();
      expect($('forge-confirm').hidden).toBe(false);
      expect(document.querySelectorAll('#forge-confirm-body pre').length).toBe(2);
      expect(document.activeElement.dataset.action).toBe('forge-confirm-cancel');
      expect(await audit()).toEqual([]);
      key(document.activeElement, 'Escape');
      expect($('forge-confirm').hidden).toBe(true);
      expect(document.activeElement).toBe(document.querySelector('[data-forge-spec="7"]'));
    }
  });

  it('has none with the pipeline\'s Open the build issue on an approved spec, its confirm step open, in both themes', async () => {
    const click = await pipelinePage();
    document.documentElement.dataset.theme = 'light'; // as the spec step left it: light first, then dark
    click('[data-forge-kind="pulls"]');
    await settle();
    click('[data-forge-pr="40"]');
    await settle();
    expect(document.querySelectorAll('[data-forge-build]').length).toBe(1);
    expect(await audit()).toEqual([]);
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') delete document.documentElement.dataset.theme;
      click('[data-forge-build="0040-meals"]');
      await settle();
      expect($('forge-confirm').hidden).toBe(false);
      expect(await audit()).toEqual([]);
      key(document.activeElement, 'Escape');
      expect($('forge-confirm').hidden).toBe(true);
    }
    expect(await audit()).toEqual([]);
  });

  it('is reached by Tab (a button in the header), opens with the focus on its title, and Escape gives the focus back', async () => {
    stub();
    start();
    const btn = $('forge-btn');
    expect(btn.tabIndex).toBe(0);
    expect(btn.getAttribute('aria-controls')).toBe('forge-panel');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    btn.focus();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); // Enter and Space on a button are a click
    await settle();
    expect(document.activeElement).toBe($('forge-title'));
    expect([...$('forge-panel').querySelectorAll('button, select, input, a[href]')].every((el) => el.tabIndex >= 0)).toBe(true);
    await settle(40);
    expect($('map-announcer').textContent).toBe('2 pull requests shown');
    key($('forge-title'), 'Escape');
    expect(document.activeElement).toBe(btn);
    expect($('forge-panel').inert).toBe(true);
    await settle(40);
    expect($('map-announcer').textContent).toBe('Issues and pull requests closed');
  });
});

describe('the Threads tab and a node\'s "Mentioned in"', () => {
  const author = { login: 'agent-four', url: 'https://git.example.test/agent-four' };
  const THREADS = [
    { kind: 'idea', number: 41, title: 'Rework sign-in', state: 'open', author, labels: ['idea'], url: 'https://git.example.test/issues/41', createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-19T11:00:00Z', comments: 2, refs: ['app-a', 'page-a', 'nowhere.md'], proposals: [{ pull: 40, slug: '0040-meals' }] },
    { kind: 'proposal', number: 40, title: 'Spec: Meals', state: 'open', author, labels: [], url: 'https://git.example.test/pull/40', createdAt: '2026-10-18T10:00:00Z', updatedAt: '2026-10-19T11:30:00Z', comments: 1, refs: ['table-t'], slugs: ['0040-meals'], idea: 41 },
  ];
  const message = (id, text, extra = {}) => ({ id, author, url: `https://git.example.test/issues/41#c${id}`, createdAt: '2026-10-18T09:00:00Z', updatedAt: '2026-10-18T09:00:00Z', body: text, ...extra });
  const THREAD = {
    kind: 'idea', number: 41, title: 'Rework sign-in', state: 'open', author, url: 'https://git.example.test/issues/41', labels: ['idea'], createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-19T11:00:00Z', hidden: 0,
    proposals: [{ pull: 40, slug: '0040-meals' }],
    messages: [message('opening', 'Think about [[app-a]] and [[nowhere.md]].', { opening: true }), message('1', 'Also [[page-a]] <b>as text</b>')],
  };
  const stub = (post = { status: 201, body: { ok: true, number: 77, issue: { number: 77, title: 'x', url: 'https://git.example.test/issues/77' } } }) => vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const u = new URL(url, 'http://localhost');
    const reply = (status, data) => ({ ok: status < 400, status, headers: new Headers(), json: async () => data });
    if (init.method === 'POST') return reply(post.status, post.body);
    const at = '2026-10-19T11:58:00.000Z';
    if (u.pathname === '/api/forge/threads') return reply(200, { ok: true, at, rate: '', label: 'idea', problem: null, items: THREADS });
    if (u.pathname === '/api/forge/threads/41') return reply(200, { ok: true, at, rate: '', thread: THREAD });
    return reply(200, { ok: true, at, rate: '', items: [] });
  }));
  const start = () => {
    const canvas = mount();
    resetForgePanelForTests();
    initForgePanel({ forge: { type: 'github', repo: 'owner/name' }, signIn: { login: 'maintainer-one' }, threads: { label: 'idea' } });
    return canvas;
  };
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const type = (id, value) => { $(id).value = value; $(id).dispatchEvent(new Event('input', { bubbles: true })); };
  afterEach(() => { closeForge({ restoreFocus: false }); resetForgePanelForTests(); delete document.documentElement.dataset.theme; });

  /** Every state the tab has, audited in whichever theme is set */
  async function walk() {
    openForge();
    await settle();
    click(document.querySelector('[data-forge-kind="threads"]'));
    await settle();
    expect(document.querySelectorAll('#forge-list .hx-forge-item').length).toBe(2);
    expect(await audit()).toEqual([]);

    click(document.querySelector('[data-forge-thread="41"]'));
    await settle();
    expect(document.querySelectorAll('.hx-thread-msg').length).toBe(2);
    expect($('forge-detail').getAttribute('aria-label')).toBe('Selected thread');
    expect(await audit()).toEqual([]);

    click($('idea-open'));
    expect($('idea-form').hidden).toBe(false);
    expect(await audit()).toEqual([]);
    click(document.querySelector('[data-action="idea-send"]')); // no title: the message says so
    expect($('idea-message').hidden).toBe(false);
    expect(await audit()).toEqual([]);
    type('idea-title', 'Meal plans');
    click(document.querySelector('[data-action="idea-send"]'));
    await settle();
    expect($('idea-message').textContent).toContain('Opened idea #77');
    expect(await audit()).toEqual([]);

    closeForge({ restoreFocus: false });
    await selectNode(state.nodes.find((n) => n.id === 'page-a'));
    await settle();
    expect($('drawer-threads').textContent).toContain('Mentioned in 1 thread');
    expect(await audit()).toEqual([]);

    // The form opened from a node (Start a thread about this), prefilled
    const starter = document.querySelector('[data-thread-start="page-a"]');
    expect(starter.textContent).toBe('Start a thread about this');
    click(starter);
    await settle();
    expect($('idea-form').hidden).toBe(false);
    expect($('idea-body').value).toBe('[[page-a]]\n\n');
    expect(document.activeElement).toBe($('idea-title'));
    expect(await audit()).toEqual([]);
    click(document.querySelector('[data-action="idea-cancel"]'));
    expect(document.activeElement).toBe(document.querySelector('[data-thread-start="page-a"]'));
  }

  it('has no violation: the list, a thread open, New idea (empty, refused, sent) and a node\'s "Mentioned in" (dark)', async () => {
    stub();
    start();
    await walk();
 }, 60_000);

  it('has none in the light theme either (contrast is checked in Chromium, in both themes)', async () => {
    stub();
    start();
    document.documentElement.dataset.theme = 'light';
    await walk();
 }, 60_000);

  it('is by keyboard: the tab, the rows, Clear, New idea and the node buttons are buttons in the tab order; the fields are labelled; the thread says it is read-only', async () => {
    stub();
    start();
    openForge();
    await settle();
    const tab = document.querySelector('[data-forge-kind="threads"]');
    expect(tab.tagName).toBe('BUTTON');
    expect(tab.hidden).toBe(false);
    click(tab);
    await settle();
    expect(tab.getAttribute('aria-pressed')).toBe('true');
    const row = document.querySelector('[data-forge-thread="41"]');
    expect(row.tagName).toBe('BUTTON');
    expect(row.getAttribute('aria-pressed')).toBe('false');
    click(row);
    await settle();
    expect(document.querySelector('[data-forge-thread="41"]').getAttribute('aria-pressed')).toBe('true'); // the rows are drawn again
    const detail = $('forge-detail');
    expect(detail.querySelector('ol[aria-label="Messages"]')).not.toBe(null);
    expect(detail.textContent).toContain('Read-only here');
    expect(detail.querySelector('input, textarea')).toBe(null);
    expect([...detail.querySelectorAll('button')].every((b) => b.tabIndex >= 0 && (b.textContent.trim() !== '' || b.getAttribute('aria-label')))).toBe(true);
    await settle(40);
    expect($('map-announcer').textContent).toContain('Thread 41');
    expect($('idea-open').getAttribute('aria-controls')).toBe('idea-form');
    click($('idea-open'));
    for (const id of ['idea-title', 'idea-body']) {
      expect($(id).labels.length, id).toBe(1);
      expect($(id).tabIndex).toBe(0);
    }
    expect(document.activeElement).toBe($('idea-title'));
    // Escape in a field is the field's own; Cancel closes the form and gives the button the focus
    click(document.querySelector('[data-action="idea-cancel"]'));
    expect(document.activeElement).toBe($('idea-open'));
    key($('forge-title'), 'Escape');
    expect($('forge-panel').inert).toBe(true);
  });
});

describe('the map by keyboard', () => {
  it('is in the tab order, named, with its keys described', () => {
    const canvas = mount();
    expect(canvas.tabIndex).toBe(0);
    expect(canvas.getAttribute('aria-label')).toBe('Topology map');
    expect($(canvas.getAttribute('aria-describedby')).textContent).toContain('N and P select the next and the previous node');
  });

  it('pans with the arrows, zooms with + and -, fits with 0, and says the zoom', async () => {
    const canvas = mount();
    const before = { ...state.camera };
    expect(key(canvas, 'ArrowRight').defaultPrevented).toBe(true);
    expect(state.camera.x).toBe(before.x - 60);
    key(canvas, 'ArrowDown', { shiftKey: true });
    expect(state.camera.y).toBe(before.y - 240);
    const zoom = state.camera.zoom;
    key(canvas, '+');
    expect(state.camera.zoom).toBeCloseTo(zoom * 1.25);
    await settle(40);
    expect($('map-announcer').textContent).toMatch(/^Zoom \d+ percent$/);
    key(canvas, '-');
    expect(state.camera.zoom).toBeCloseTo(zoom);
    key(canvas, '0');
    await settle(40);
    expect($('map-announcer').textContent).toMatch(/^The whole map/);
    expect(key(canvas, 'a').defaultPrevented).toBe(false); // a key the map does not use is the page's
  });

  it('steps through the nodes in reading order with N and P, Home and End, selecting and announcing each', async () => {
    const canvas = mount();
    const order = readingOrder(state.nodes).map((n) => n.id);
    key(canvas, 'n');
    expect(state.selectedNode.id).toBe(order[0]);
    expect($('spec-drawer').classList.contains('drawer-open')).toBe(true);
    await settle(40);
    expect($('map-announcer').textContent).toBe(`${state.selectedNode.label}, ${state.selectedNode.type}, 1 connection, 1 of ${order.length}`);
    key(canvas, ']');
    expect(state.selectedNode.id).toBe(order[1]);
    key(canvas, 'p');
    expect(state.selectedNode.id).toBe(order[0]);
    key(canvas, 'End');
    expect(state.selectedNode.id).toBe(order[order.length - 1]);
    key(canvas, 'Home');
    expect(state.selectedNode.id).toBe(order[0]);
    expect(document.activeElement === canvas || document.activeElement === document.body).toBe(true); // stepping leaves the focus on the map
  });

  it('Enter goes into the panel; Escape there closes it and gives the map the focus back', async () => {
    const canvas = mount();
    canvas.focus();
    key(canvas, 'n');
    key(canvas, 'Enter');
    expect(document.activeElement).toBe($('drawer-title'));
    key($('drawer-title'), 'Escape');
    expect(state.selectedNode).toBe(null);
    expect(document.activeElement).toBe(canvas);
    await settle(40);
    expect($('map-announcer').textContent).toBe('Panel closed');
  });

  it('Escape on the map closes the panel too', () => {
    const canvas = mount();
    key(canvas, 'n');
    key(canvas, 'Escape');
    expect(state.selectedNode).toBe(null);
  });

  it('in Freeform, Alt+arrow moves the selected node, and the position is kept', () => {
    const canvas = mount();
    state.isFreeform = true;
    key(canvas, 'n');
    const n = state.selectedNode;
    const x = n.x;
    key(canvas, 'ArrowRight', { altKey: true });
    expect(n.x).toBe(x + 20);
    expect(state.freeformPositions[n.id]).toEqual({ x: n.x, y: n.y });
    state.isFreeform = false;
    key(canvas, 'ArrowRight', { altKey: true });
    expect(n.x).toBe(x + 20); // the orbit layout is fixed
  });

  it('leaves Left and Right to a playing scenario', () => {
    const canvas = mount();
    state.scenario = { id: 'x' };
    const x = state.camera.x;
    expect(key(canvas, 'ArrowLeft').defaultPrevented).toBe(false);
    expect(state.camera.x).toBe(x);
    state.scenario = null;
  });

  it('Enter in the search box selects the first match; a miss is said', async () => {
    mount();
    const input = $('node-search');
    input.value = 'orders';
    key(input, 'Enter');
    expect(state.selectedNode.label.toLowerCase()).toContain('orders');
    input.value = 'nothing like it';
    key(input, 'Enter');
    await settle(40);
    expect($('map-announcer').textContent).toBe('No node matches nothing like it');
  });

  it('Escape closes the Layers menu and puts the focus back on its button', () => {
    mount();
    renderLayerToggles();
    toggleLegendMenu();
    key(document.body, 'Escape');
    expect($('legend-dropdown').hidden).toBe(true);
    expect($('legend-toggle-btn').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe($('legend-toggle-btn'));
  });
});

describe('a what-if edge without a drag', () => {
  it('picks the other end from a list in the node\'s panel and opens the edge form', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = new URL(url, 'http://localhost');
      if (u.pathname === '/proposals') return { ok: true, status: 200, headers: new Headers(), json: async () => [] };
      if (u.pathname.endsWith('/review')) return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
      return { ok: true, status: 200, headers: new Headers({ 'X-Proposal-Source': 'checkout' }), json: async () => structuredClone(PROPOSAL) };
    }));
    mount();
    resetWhatIfForTests();
    initWhatIf();
    await initProposals();
    expect(await openProposal('0013-meals', 'checkout')).toBe(true);
    await selectNode(state.nodes.find((n) => n.id === 'page-a'));
    await settle();
    const pick = document.querySelector('[data-edge-to]');
    expect(pick).not.toBe(null);
    expect([...pick.options].map((o) => o.value)).not.toContain('page-a');
    pick.value = 'table-t';
    document.querySelector('[data-whatif="edge-to"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const form = document.querySelector('[data-form="edge"]');
    expect(form).not.toBe(null);
    expect(form.textContent).toContain('/orders → orders');
    expect(document.activeElement).toBe(form.querySelector('[name="kind"]'));
    closeProposal();
  });
});
