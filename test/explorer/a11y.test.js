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
import { initAccountMenu, resetAccountMenuForTests } from '../../explorer/account-menu.js';
// @ts-expect-error plain JS modules, no declarations
import { applyBranding } from '../../explorer/plugins.js';
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
const css = ['tokens.css', 'explorer.css', 'house.css'].map((f) => fs.readFileSync(path.join(EXPLORER, f), 'utf8')).join('\n');

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

/**
 * The regions a test audits. axe's cost is the computed style of every element it visits, and happy-dom recomputes
 * all of them after each change to the page (about 2.5 s for this page, 60 ms for one panel), so a test about a panel
 * audits that panel (plus the controls that name its state) and the two whole-page audits below (one per theme) keep
 * the page-level rules (landmarks, duplicate ids, the order of headings) running.
 */
const FORGE = ['#forge-btn', '#forge-panel', '#forge-confirm'];
const DRAWER = ['#spec-drawer'];
const LAYERS = ['#legend-toggle-btn', '#legend-dropdown'];
const PROPOSAL_REGION = ['#proposal-wrap', '#proposal-bar', '#sheet-dock', '#spec-drawer'];
const MOCKUP_WINDOW = ['.hx-mockup-dialog'];

/**
 * axe on the regions given (CSS selectors; each must match, so a renamed id fails loudly), or on the whole page with
 * none. Only the rules that need a layout are off (colour contrast: happy-dom has none); returns the violations as
 * "rule: target"
 */
async function audit(...regions) {
  for (const sel of regions) if (!document.querySelector(sel)) throw new Error(`audit: nothing matches ${sel}`);
  // An iframe is left to its own check below: happy-dom cannot run axe across a frame
  const include = regions.length ? regions : [document.documentElement];
  const r = await axe.run({ include, exclude: [['iframe']] }, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, rules: { 'color-contrast': { enabled: false } } });
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
  resetAccountMenuForTests();
  initAccountMenu();
  return canvas;
}

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); });
afterEach(() => { clearScenario(); closeDrawer(); resetMockupsForTests(); delete document.documentElement.dataset.theme; vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('axe finds no violation', () => {
  it('on the map as it loads', async () => {
    mount();
    expect(await audit()).toEqual([]);
  });

  it('in the light theme too (contrast is checked in Chromium, in both themes)', async () => {
    mount();
    document.documentElement.dataset.theme = 'light';
    expect(await audit()).toEqual([]);
    delete document.documentElement.dataset.theme;
  });

  it('with the Layers menu open, which says it is open', async () => {
    mount();
    renderLayerToggles();
    toggleLegendMenu();
    expect($('legend-toggle-btn').getAttribute('aria-expanded')).toBe('true');
    expect(await audit(...LAYERS)).toEqual([]);
  });

  it('with the account menu open, signed in, with a forge, the links and a named theme: a menu button, its parts named', async () => {
    mount();
    applyBranding(document, { title: 'Acme', version: '1.2.3', links: [{ label: 'Wiki', href: 'https://wiki.example.test/' }], forge: { type: 'forgejo', url: 'https://forge.example.test', repo: 'o/n' }, docs: 'https://docs.example.test/', signIn: { login: 'maint' }, theme: { names: ['day', 'night'], default: null }, brand: { poweredBy: 'https://example.test/' } });
    $('tokens-btn').hidden = false;
    expect($('account-btn').getAttribute('aria-expanded')).toBe('false');
    $('account-btn').click();
    expect($('account-btn').getAttribute('aria-expanded')).toBe('true');
    expect($('account-menu').hidden).toBe(false);
    expect($('account-who').textContent).toBe('maint · maintainer');
    expect([...document.querySelectorAll('#cf-links a')].map((a) => a.textContent)).toEqual(['Wiki', 'Forgejo', 'Docs']);
    expect(await audit('.hx-account')).toEqual([]);
  });

  it('with a node\'s panel open; closed, the panel is inert so Tab never reaches it off screen', async () => {
    mount();
    expect($('spec-drawer').inert).toBe(true);
    await selectNode(state.nodes.find((n) => n.id === 'table-t'));
    expect($('spec-drawer').inert).toBe(false);
    expect(await audit(...DRAWER)).toEqual([]);
    closeDrawer();
    expect($('spec-drawer').inert).toBe(true);
  });

  describe('with a proposal open and what-if editing on', () => {
    beforeEach(async () => {
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
    });
    afterEach(() => { clearScenario(); closeProposal(); });

    it('the proposal bar, its changes and the what-if toolbar', async () => {
      expect(document.querySelector('#whatif [role="toolbar"]')).not.toBe(null);
      expect(await audit(...PROPOSAL_REGION)).toEqual([]);
    });

    it('the toolbar with Edit, the scenario list, the ⋯ menu and the review note open, in both themes', async () => {
      const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(document.querySelector('.hx-proposal-head').getAttribute('role')).toBe('group');
      expect(document.querySelector('.hx-proposal-head').getAttribute('aria-label')).toBeTruthy();
      click(document.getElementById('proposal-edit'));
      click(document.getElementById('proposal-more'));
      expect(document.getElementById('proposal-more-menu').hidden).toBe(false);
      for (const theme of ['dark', 'light']) {
        if (theme === 'light') document.documentElement.dataset.theme = 'light';
        expect(await audit(...PROPOSAL_REGION)).toEqual([]);
      }
    });

    it('and a node\'s panel open beside them', async () => {
      await selectNode(state.nodes.find((n) => n.id === 'app-a'));
      expect(await audit(...PROPOSAL_REGION)).toEqual([]);
    });

    it('and the scenario player playing', async () => {
      await selectNode(state.nodes.find((n) => n.id === 'app-a'));
      playScenario(PROPOSAL.scenarios[0], { autoplay: false });
      await settle();
      expect(document.querySelector('.hx-player')).not.toBe(null);
      expect(await audit(...PROPOSAL_REGION)).toEqual([]);
    });
  });
});

describe('axe finds no violation with a proposal\'s mockups', () => {
  /** A node's panel with its mockups in a theme; returns the buttons that open them */
  const mockupsPanel = async (theme) => {
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
    if (theme === 'light') document.documentElement.dataset.theme = 'light';
    return buttons;
  };

  for (const theme of ['dark', 'light']) {
    it(`in a node's panel (${theme})`, async () => {
      await mockupsPanel(theme);
      expect(await audit(...DRAWER), `${theme}: the panel`).toEqual([]);
    });

    for (const [at, what] of [[0, 'a picture'], [1, 'a page']]) {
      it(`in the window ${what} opens in (${theme})`, async () => {
        const b = (await mockupsPanel(theme))[at];
        b.click();
        const dialog = document.querySelector('.hx-mockup-dialog[role="dialog"]');
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.contains(document.activeElement) || dialog === document.activeElement).toBe(true);
        const frame = dialog.querySelector('iframe');
        if (frame) expect([frame.getAttribute('sandbox'), frame.getAttribute('title')]).toEqual(['', 'The edit form']);
        else expect(dialog.querySelector('img').getAttribute('alt')).toBe('The meal list');
        expect(await audit(...MOCKUP_WINDOW, ...DRAWER), `${theme}: ${b.textContent.trim()} open`).toEqual([]);
        closeMockup();
        expect(document.activeElement).toBe(b);
      });
    }
  }
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
  const SPECS = [
    { slug: '0013-meals', title: 'Meals', summary: 'Adds /meals, read from the basket.', spec: '0013', source: 'pull/12', pull: { number: 12, draft: false, author: 'agent-four' }, counts: { added: 4, changed: 1, removed: 0, scenarios: 3 }, errors: 0, review: null },
    { slug: '0014-draft', title: 'Draft idea', summary: '', spec: '0014', source: 'w-1', counts: { added: 1, changed: 0, removed: 2, scenarios: 0 }, errors: 1, review: null },
    { slug: '0016-broken', title: '0016-broken', source: 'checkout', error: 'It is not valid JSON.' },
  ];
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
    if (u.pathname === '/proposals') return { ok: true, status: 200, headers: new Headers(), json: async () => SPECS };
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
    expect(await audit('#forge-btn', '#forge-panel')).toEqual([]);
  });

  const press = (sel) => document.querySelector(sel).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const light = () => { document.documentElement.dataset.theme = 'light'; };

  // Every state is a test of its own: axe recomputes the style of every element once after each change (the cost of an
  // audit, about 2 s here), so a test with one audit stays far inside the time limit even on a loaded machine. A state
  // that follows another is reached by the same steps, which are quick (no audit)
  const listsOpen = async () => {
    stub();
    start();
    openForge({ tab: 'pulls' });
    await settle();
  };
  const prSelected = async (n = 13) => {
    press(`[data-forge-pr="${n}"]`);
    await settle();
  };

  it('has no violation closed (inert off screen)', async () => {
    stub();
    start();
    expect($('forge-panel').inert).toBe(true);
    expect(await audit(...FORGE)).toEqual([]);
  });

  it('has none on Specs, the tab it opens on (dark)', async () => {
    stub();
    start();
    openForge();
    await settle();
    expect(document.querySelectorAll('#forge-list .hx-forge-item').length).toBe(3);
    expect(await audit(...FORGE)).toEqual([]);
  });

  it('has none on Specs in the light theme', async () => {
    stub();
    start();
    light();
    openForge();
    await settle();
    expect(document.querySelectorAll('#forge-list .hx-forge-item').length).toBe(3);
    expect(await audit(...FORGE)).toEqual([]);
  });

  it('has none with the Filter chip open and a filter on', async () => {
    await listsOpen();
    press('#forge-filter-chip');
    $('forge-text').value = 'meals';
    $('forge-text').dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect($('forge-filter-chip').getAttribute('aria-expanded')).toBe('true');
    expect($('forge-filter-chip').getAttribute('aria-label')).toBe('Filter, 1 filter on');
    expect(await audit(...FORGE)).toEqual([]);
  });

  it('has none open with its lists', async () => {
    await listsOpen();
    expect(document.querySelectorAll('#forge-list .hx-forge-item').length).toBe(2);
    expect(await audit(...FORGE)).toEqual([]);
  });

  it('has none with a pull request selected', async () => {
    await listsOpen();
    await prSelected();
    expect(document.querySelectorAll('.hx-forge-file').length).toBe(2);
    expect(await audit(...FORGE)).toEqual([]);
  });

  it('has none on the issues list', async () => {
    await listsOpen();
    await prSelected();
    press('[data-forge-kind="issues"]');
    await settle();
    expect(await audit(...FORGE)).toEqual([]);
  });

  it('has none in the light theme either (contrast is checked in Chromium, in both themes)', async () => {
    stub();
    start();
    light();
    openForge({ tab: 'pulls' });
    await settle();
    await prSelected();
    expect(await audit(...FORGE)).toEqual([]);
  });

  const agentsTab = async (theme) => {
    await listsOpen();
    if (theme === 'light') light();
    press('[data-forge-kind="work"]');
    await settle();
    expect(document.querySelectorAll('.hx-forge-agent').length).toBeGreaterThan(0);
  };

  it('has none on the Agents tab: its groups and the marks (dark)', async () => {
    await agentsTab('dark');
    expect(document.querySelectorAll('#forge-list .hx-forge-group').length).toBe(3);
    expect(await audit(...FORGE)).toEqual([]);
  });

  it('has none on the Agents tab with a pull request selected (dark)', async () => {
    await agentsTab('dark');
    await prSelected();
    expect(document.querySelectorAll('.hx-forge-file').length).toBe(2);
    expect(await audit(...FORGE)).toEqual([]);
  });

  it('has none on the Agents tab with the finished work shown (dark)', async () => {
    await agentsTab('dark');
    await prSelected();
    const finished = $('forge-work-finished');
    finished.checked = true;
    finished.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.querySelector('[data-forge-pr="9"]')).not.toBe(null);
    expect(await audit(...FORGE)).toEqual([]);
  });

  it('has none on the Agents tab in the light theme either', async () => {
    await agentsTab('light');
    expect(await audit(...FORGE)).toEqual([]);
  });

  it('has none on the Agents tab in the light theme with the agents filter changed', async () => {
    await agentsTab('light');
    const agents = $('forge-work-agents');
    agents.checked = true;
    agents.dispatchEvent(new Event('change', { bubbles: true }));
    expect(await audit(...FORGE)).toEqual([]);
  });

  it('has none with the actions shown (Re-run, the reasons why not)', async () => {
    await listsOpen();
    await prSelected(13);
    expect(document.querySelectorAll('[data-forge-rerun]').length).toBe(1);
    expect(document.querySelectorAll('.hx-forge-lights').length).toBeGreaterThan(1);
    expect(await audit(...FORGE)).toEqual([]);
  });

  it('has none with the actions shown (Land it)', async () => {
    await listsOpen();
    await prSelected(13);
    press('[data-forge-pr="13"]');
    await prSelected(12);
    expect(document.querySelector('[data-forge-merge]')).not.toBe(null);
    expect(await audit(...FORGE)).toEqual([]);
  });

  /** The confirm dialog opened on Land it, then closed with Escape, in a theme */
  const confirmPage = async (theme) => {
    await listsOpen();
    await prSelected(12);
    if (theme === 'light') light();
    press('[data-forge-merge]');
    expect($('forge-confirm').hidden).toBe(false);
    expect(document.activeElement.dataset.action).toBe('forge-confirm-cancel');
  };
  const confirmClosed = () => {
    key(document.activeElement, 'Escape');
    expect($('forge-confirm').hidden).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('[data-forge-merge]'));
  };

  for (const theme of ['dark', 'light']) {
    it(`has none with the confirm dialog open (${theme})`, async () => {
      await confirmPage(theme);
      expect(await audit(...FORGE)).toEqual([]);
      confirmClosed();
    });
  }

  it('has none with the confirm dialog closed again (light)', async () => {
    await confirmPage('light');
    confirmClosed();
    expect(await audit(...FORGE)).toEqual([]);
  });

  /** The Release notes tab through its states: the draft, the confirm step, a message after Post and after Copy; each state a test, in either theme */
  const NOTES_STEPS = [
    ['the draft', async () => {
      openForge({ tab: 'pulls' });
      await settle();
      press('[data-action="open-notes"]');
      await settle();
      expect($('notes-preview').value).toContain('### a');
    }],
    ['the confirm step', async () => {
      press('#notes-post');
      await settle();
      expect($('notes-confirm').hidden).toBe(false);
    }],
    ['the words after Post', async () => {
      press('#notes-confirm-yes');
      await settle();
      expect($('notes-message').textContent).toMatch(/^Draft release v0\.3\.0 created/);
    }],
    ['the words after Copy', async () => {
      press('#notes-copy');
      await settle(40);
      expect($('notes-message').hidden).toBe(false);
    }],
  ];

  for (const theme of ['dark', 'light']) {
    NOTES_STEPS.forEach(([name], at) => {
      it(`has none on the Release notes tab: ${name} (${theme})`, async () => {
        stub();
        start();
        if (theme === 'light') light();
        for (const [, step] of NOTES_STEPS.slice(0, at + 1)) await step();
        expect(await audit(...FORGE)).toEqual([]);
      });
    });
  }

  it('reaches every control of the Release notes tab with Tab, names them, and says what the draft is', async () => {
    stub();
    start();
    openForge({ tab: 'pulls' });
    await settle();
    document.querySelector('[data-action="open-notes"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

    const deploysList = async (theme) => {
      stubDeploys();
      start();
      if (theme === 'light') light();
      openForge({ tab: 'pulls' });
      await settle();
      click(document.querySelector('[data-forge-kind="deploys"]'));
      await settle();
    };
    const deploySelected = async (id) => {
      click(document.querySelector(`[data-forge-deploy="${id}"]`));
      await settle();
      expect(document.querySelector('#forge-detail').hidden).toBe(false);
    };

    it('has no violation listing deploys (dark theme)', async () => {
      await deploysList('dark');
      expect(document.querySelectorAll('#forge-list .hx-forge-item').length).toBe(3);
      expect(await audit(...FORGE)).toEqual([]);
    });

    for (const [id, what] of [['3', 'a mapped one'], ['2', 'an unmapped one'], ['1', 'a failed one']]) {
      it(`has none with ${what} selected (dark theme)`, async () => {
        await deploysList('dark');
        await deploySelected(id);
        expect(await audit(...FORGE)).toEqual([]);
        if (id === '1') expect(state.forgeLit.failing.has('table-t')).toBe(true);
      });
    }

    it('has none in the light theme either', async () => {
      await deploysList('light');
      await deploySelected('3');
      expect(await audit(...FORGE)).toEqual([]);
    });

    it('has none in the light theme with an unmapped one selected', async () => {
      await deploysList('light');
      await deploySelected('3');
      await deploySelected('2');
      expect(await audit(...FORGE)).toEqual([]);
    });

    it('is by keyboard: the tab, the rows and Clear are buttons in the tab order, the selection is announced, Escape closes', async () => {
      stubDeploys();
      start();
      openForge({ tab: 'pulls' });
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
      // The selection replaces the list: the focus moves to its back control, which has a name
      const back = document.querySelector('#forge-detail .hx-forge-back');
      expect(document.activeElement).toBe(back);
      expect(back.textContent.trim()).toBe('All deploys');
      expect(document.querySelector('#forge-list').hidden).toBe(true);
      expect($('map-announcer').textContent).toBe('Deploy Deploy web of main, succeeded: 1 node restarted and lit, 1 named that is not on the map.');
      expect([back.tagName, back.tabIndex]).toEqual(['BUTTON', 0]);
      expect(back.getAttribute('data-action')).toBe('clear-forge-deploy');
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
    openForge({ tab: 'pulls' });
    await settle();
    const click = (sel) => document.querySelector(sel).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return click;
  };

  /** Start a spec on an issue: the list, then its confirm step open in a theme */
  const specPage = async () => {
    const click = await pipelinePage();
    click('[data-forge-kind="issues"]');
    await settle();
    expect(document.querySelectorAll('[data-forge-spec]').length).toBe(1);
    return click;
  };

  it('has none with the pipeline\'s Start a spec on an issue', async () => {
    await specPage();
    expect(await audit(...FORGE)).toEqual([]);
  });

  for (const theme of ['dark', 'light']) {
    it(`has none with the pipeline's Start a spec on an issue, its confirm step open (${theme})`, async () => {
      const click = await specPage();
      if (theme === 'light') light();
      click('[data-forge-spec="7"]');
      await settle();
      expect($('forge-confirm').hidden).toBe(false);
      expect(document.querySelectorAll('#forge-confirm-body pre').length).toBe(2);
      expect(document.activeElement.dataset.action).toBe('forge-confirm-cancel');
      expect(await audit(...FORGE)).toEqual([]);
      key(document.activeElement, 'Escape');
      expect($('forge-confirm').hidden).toBe(true);
      expect(document.activeElement).toBe(document.querySelector('[data-forge-spec="7"]'));
    });
  }

  /** Open the build issue on an approved spec: the pull request selected (light first, then dark), its confirm step open */
  const buildPage = async () => {
    const click = await pipelinePage();
    light();
    click('[data-forge-kind="pulls"]');
    await settle();
    click('[data-forge-pr="40"]');
    await settle();
    expect(document.querySelectorAll('[data-forge-build]').length).toBe(1);
    return click;
  };
  const buildConfirm = async (click, theme) => {
    if (theme === 'dark') delete document.documentElement.dataset.theme;
    click('[data-forge-build="0040-meals"]');
    await settle();
    expect($('forge-confirm').hidden).toBe(false);
  };

  it('has none with the pipeline\'s Open the build issue on an approved spec', async () => {
    await buildPage();
    expect(await audit(...FORGE)).toEqual([]);
  });

  for (const theme of ['light', 'dark']) {
    it(`has none with its confirm step open (${theme})`, async () => {
      const click = await buildPage();
      await buildConfirm(click, theme);
      expect(await audit(...FORGE)).toEqual([]);
      key(document.activeElement, 'Escape');
      expect($('forge-confirm').hidden).toBe(true);
    });
  }

  it('has none with the confirm step closed again (dark)', async () => {
    const click = await buildPage();
    await buildConfirm(click, 'light');
    key(document.activeElement, 'Escape');
    await buildConfirm(click, 'dark');
    key(document.activeElement, 'Escape');
    expect($('forge-confirm').hidden).toBe(true);
    expect(await audit(...FORGE)).toEqual([]);
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
    expect($('map-announcer').textContent).toBe('3 specs shown, 1 to decide');
    key($('forge-title'), 'Escape');
    expect(document.activeElement).toBe(btn);
    expect($('forge-panel').inert).toBe(true);
    await settle(40);
    expect($('map-announcer').textContent).toBe('Work closed');
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

  /** Every state the tab has, in the order a visitor reaches them: each is audited by a test of its own (in each theme) after the steps before it */
  const WALK = [
    ['the list', FORGE, async () => {
      openForge({ tab: 'pulls' });
      await settle();
      click(document.querySelector('[data-forge-kind="threads"]'));
      await settle();
      expect(document.querySelectorAll('#forge-list .hx-forge-item').length).toBe(2);
    }],
    ['a thread open', FORGE, async () => {
      click(document.querySelector('[data-forge-thread="41"]'));
      await settle();
      expect(document.querySelectorAll('.hx-thread-msg').length).toBe(2);
      expect($('forge-detail').getAttribute('aria-label')).toBe('Selected thread');
    }],
    ['New idea, empty', FORGE, async () => {
      click($('idea-open'));
      expect($('idea-form').hidden).toBe(false);
    }],
    ['New idea, refused (no title)', FORGE, async () => {
      click(document.querySelector('[data-action="idea-send"]')); // no title: the message says so
      expect($('idea-message').hidden).toBe(false);
    }],
    ['New idea, sent', FORGE, async () => {
      type('idea-title', 'Meal plans');
      click(document.querySelector('[data-action="idea-send"]'));
      await settle();
      expect($('idea-message').textContent).toContain('Opened idea #77');
    }],
    ['a node\'s "Mentioned in"', DRAWER, async () => {
      closeForge({ restoreFocus: false });
      await selectNode(state.nodes.find((n) => n.id === 'page-a'));
      await settle();
      expect($('drawer-threads').textContent).toContain('Threads');
    }],
  ];

  for (const theme of ['dark', 'light']) {
    WALK.forEach(([name, region], at) => {
      it(`has no violation: ${name} (${theme}; contrast is checked in Chromium, in both themes)`, async () => {
        stub();
        start();
        if (theme === 'light') document.documentElement.dataset.theme = 'light';
        for (const [, , step] of WALK.slice(0, at + 1)) await step();
        expect(await audit(...region)).toEqual([]);
      });
    });
  }

  // Its own test for each theme, not more steps in the walk
  for (const theme of ['dark', 'light']) {
    it(`has none with the form opened from a node (Start a thread about this), prefilled (${theme})`, async () => {
      stub();
      start();
      if (theme === 'light') document.documentElement.dataset.theme = 'light';
      await selectNode(state.nodes.find((n) => n.id === 'page-a'));
      await settle();
      const starter = document.querySelector('[data-thread-start="page-a"]');
      expect(starter.textContent).toBe('Start a thread about this');
      click(starter);
      await settle();
      expect($('idea-form').hidden).toBe(false);
      expect($('idea-body').value).toBe('[[page-a]]\n\n');
      expect(document.activeElement).toBe($('idea-title'));
      expect(await audit(...FORGE, ...DRAWER)).toEqual([]);
      click(document.querySelector('[data-action="idea-cancel"]'));
      expect(document.activeElement).toBe(document.querySelector('[data-thread-start="page-a"]'));
    });
  }

  it('is by keyboard: the tab, the rows, Clear, New idea and the node buttons are buttons in the tab order; the fields are labelled; the thread says it is read-only', async () => {
    stub();
    start();
    openForge({ tab: 'pulls' });
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

  it('the account menu is a menu button: Escape closes it with the focus back on the button, and so does a click outside it', () => {
    mount();
    $('account-btn').focus();
    $('account-btn').click();
    $('freeform-toggle-btn').focus();
    key($('freeform-toggle-btn'), 'Escape');
    expect($('account-menu').hidden).toBe(true);
    expect($('account-btn').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe($('account-btn'));
    $('account-btn').click();
    document.body.click();
    expect($('account-menu').hidden).toBe(true);
    $('account-btn').click(); // the button opens it and shuts it
    $('account-btn').click();
    expect($('account-menu').hidden).toBe(true);
  });

  it('Theme, Freeform layout and the Proposals list keep the menu open; a link or Review tokens end it', () => {
    mount();
    $('account-btn').click();
    document.querySelector('[data-action="set-theme"][data-choice="dark"]').click();
    $('freeform-toggle-btn').click();
    expect($('account-menu').hidden).toBe(false);
    const link = document.createElement('a');
    link.href = 'https://x.example.test/';
    $('cf-links').append(link);
    link.click();
    expect($('account-menu').hidden).toBe(true);
  });

  it('/ goes to the search from anywhere but a field, and types a slash in one', () => {
    mount();
    const canvas = $('graph-canvas');
    const e = key(canvas, '/');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe($('node-search'));
    expect(key($('node-search'), '/').defaultPrevented).toBe(false);
  });

  it('/ does nothing while a dialog is open, and on a phone opens the search bar, or goes into it when it is open', () => {
    mount();
    const canvas = $('graph-canvas');
    $('tokens-dialog').hidden = false;
    expect(key(canvas, '/').defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe($('node-search'));
    $('tokens-dialog').hidden = true;
    document.querySelector('[data-corn="search"]').style.display = 'none'; // a phone: no search box in the header
    let opened = 0;
    $('mobile-search-toggle').addEventListener('click', () => { opened++; $('mobile-search-bar').hidden = false; });
    key(canvas, '/');
    expect(opened).toBe(1);
    key(canvas, '/'); // the bar is open: the key goes into it, and does not shut it
    expect(opened).toBe(1);
    expect(document.activeElement).toBe($('mobile-node-search'));
  });

  it('a Tab out of the account menu closes it', () => {
    mount();
    $('account-btn').click();
    $('freeform-toggle-btn').focus();
    $('freeform-toggle-btn').dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: $('theme-name-select') }));
    expect($('account-menu').hidden).toBe(false); // still inside
    $('freeform-toggle-btn').dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: $('graph-canvas') }));
    expect($('account-menu').hidden).toBe(true);
    expect($('account-btn').getAttribute('aria-expanded')).toBe('false');
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
    expect(document.querySelector('[data-edge-to]')).toBe(null); // behind the toolbar's Edit
    $('proposal-edit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const pick = document.querySelector('[data-edge-to]');
    expect(pick).not.toBe(null);
    expect(pick.closest('.hx-whatif-edgeto').querySelector('[data-whatif="edge-to"]')).not.toBe(null); // the select and Draw on one row
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
