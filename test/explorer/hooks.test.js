// @vitest-environment happy-dom
/**
 * The styling hooks (docs/theming.md, "Styling hooks"): every region and component carries a `data-corn="…"` value, and
 * the documented list is the public API. This fails when a hook is in the docs but not in the markup, when the markup has
 * a value the docs do not list, and when the real page and its panels lose the main ones.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CORNFIELD, EXPLORER, explorerPage } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { state, escHtml } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { setRenderer } from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { renderLayerToggles } from '../../explorer/layers.js';
// @ts-expect-error plain JS modules, no declarations
import { proposalRowHtml } from '../../explorer/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import { runsHtml } from '../../explorer/runs-view.js';
// @ts-expect-error plain JS modules, no declarations
import { mockupsSectionHtml } from '../../explorer/mockups-model.js';
import { initScenarioUi, playScenario, clearScenario } from '../../explorer/scenario-ui.js';

/**
 * Hooks the brand assets (CF-35, #128) put on the page. They are documented now; the markup comes with that change, so
 * they may be absent from the source until it lands. Once it has, empty this set: they are then checked like the rest.
 */
const FROM_BRAND_ASSETS = new Set(['brand', 'brand-logo', 'brand-wordmark', 'powered-by']);

const docs = fs.readFileSync(path.join(CORNFIELD, 'docs', 'theming.md'), 'utf8');
/** The first-column values (in backticks) of the tables in a section of the docs, from its heading to the next heading of its level or higher */
function tableValues(heading) {
  const level = heading.match(/^#+/)[0].length;
  const at = docs.indexOf(`\n${heading}`);
  if (at < 0) throw new Error(`docs/theming.md has no "${heading}"`);
  const rest = docs.slice(at + 1 + heading.length);
  const end = rest.search(new RegExp(`\\n#{1,${level}} `));
  const section = end < 0 ? rest : rest.slice(0, end);
  const out = [];
  for (const line of section.split('\n')) {
    const cell = /^\|\s*([^|]+?)\s*\|/.exec(line);
    if (cell && !/^-+$/.test(cell[1])) out.push(...[...cell[1].matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]));
  }
  return out;
}
// The hooks are under "## The hooks" and its "###" groups; read the whole section
const hooks = tableValues('## The hooks').filter((v, i, a) => a.indexOf(v) === i);
const kinds = tableValues('### Button kinds: `data-corn-kind`');
const states = tableValues('### States: `data-corn-state`');

const SOURCES = [path.join(EXPLORER, 'index.html'), ...fs.readdirSync(EXPLORER).filter((f) => f.endsWith('.js')).map((f) => path.join(EXPLORER, f)), path.join(CORNFIELD, 'plugins/house/browser.js')];
const source = SOURCES.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
/** Every literal value written as `data-corn="x"` or `dataset.corn = 'x'` (the attribute, in markup and in script) */
const literal = (name, re) => [...source.matchAll(re)].map((m) => m[1]);
const used = [...new Set([...literal('attr', /\bdata-corn="([^"$]+)"/g), ...literal('js', /\.dataset\.corn = '([^']+)'/g)])];
const usedKinds = [...new Set(literal('kind', /\bdata-corn-kind="([^"$]+)"/g))];
const usedStates = [...new Set([...literal('attr', /\bdata-corn-state="([^"$]+)"/g), ...literal('js', /\.dataset\.cornState = '([^']+)'/g)])];

describe('the documented list', () => {
  it('is long enough to be the list, and has no repeats', () => {
    expect(hooks.length).toBeGreaterThan(100);
    const all = tableValues('## The hooks');
    expect(all.length).toBe(hooks.length);
    expect(kinds.sort()).toEqual(['approve', 'danger', 'icon', 'primary', 'quiet']);
  });

  it('says renaming a hook is breaking, and that there is no shadow DOM', () => {
    expect(docs).toMatch(/renaming or removing one is a breaking change/);
    expect(docs).toMatch(/No shadow DOM/);
  });

  it('has every hook in index.html or the explorer source', () => {
    const missing = hooks.filter((h) => !used.includes(h) && !FROM_BRAND_ASSETS.has(h));
    expect(missing, `documented but in no markup: ${missing.join(', ')}`).toEqual([]);
  });

  it('documents the brand hooks the brand assets add', () => {
    for (const h of FROM_BRAND_ASSETS) expect(hooks, h).toContain(h);
  });
});

describe('the markup', () => {
  it('has no data-corn value that the docs do not list', () => {
    const extra = used.filter((h) => !hooks.includes(h));
    expect(extra, `in the markup but not documented: ${extra.join(', ')}`).toEqual([]);
  });

  it('has no data-corn-kind or data-corn-state value that the docs do not list', () => {
    expect(usedKinds.filter((k) => !kinds.includes(k))).toEqual([]);
    expect(usedStates.filter((s) => !states.includes(s))).toEqual([]);
  });

  it('writes every hook as a short kebab-case noun', () => {
    for (const h of [...hooks, ...used]) expect(h, h).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
  });

  it('does not use the old data-cf prefix anywhere in the explorer, the server or the core', () => {
    const files = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|html|css|md)$/.test(e.name)) files.push(p); } };
    for (const d of ['explorer', 'server', 'core']) walk(path.join(CORNFIELD, d));
    for (const f of files) expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/data-cf\b/);
  });
});

// --- The page and some panels, mounted -------------------------------------------------------------------------------

const html = explorerPage();
const body = /<body>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const $ = (sel) => document.querySelector(sel);
const hook = (name) => $(`[data-corn="${name}"]`);

describe('the mounted page', () => {
  beforeEach(() => { document.body.innerHTML = body; });

  it('has the main regions, each on its real element', () => {
    expect(hook('header').tagName).toBe('HEADER');
    expect(hook('stage').getAttribute('role')).toBe('main');
    expect(hook('map-canvas')).toBe(document.getElementById('graph-canvas'));
    expect(hook('label-canvas')).toBe(document.getElementById('label-canvas'));
    expect(hook('run-overlay')).toBe(document.getElementById('run-overlay'));
    expect(hook('search-input')).toBe(document.getElementById('node-search'));
    expect(hook('layers-button')).toBe(document.getElementById('legend-toggle-btn'));
    expect(hook('layers-menu')).toBe(document.getElementById('legend-dropdown'));
    expect(hook('preset-dataflow')).toBe(document.getElementById('preset-dataflow-btn'));
    expect(hook('preset-house')).toBe(document.getElementById('preset-house-btn'));
    expect(hook('proposals-button')).toBe(document.getElementById('proposal-btn'));
    expect(hook('forge-button')).toBe(document.getElementById('forge-btn'));
    expect(hook('theme-toggle')).toBe(document.getElementById('theme-toggle-btn'));
    expect(hook('links')).toBe(document.getElementById('cf-links'));
  });

  it('has each panel', () => {
    expect(hook('proposal-bar')).toBe(document.getElementById('proposal-bar'));
    expect(hook('forge-panel')).toBe(document.getElementById('forge-panel'));
    expect(hook('node-panel')).toBe(document.getElementById('spec-drawer'));
    expect(hook('node-badge')).toBe(document.getElementById('drawer-badge'));
    expect(hook('runs')).toBe(document.getElementById('forge-runs'));
    expect(hook('release-notes')).toBe(document.getElementById('forge-notes'));
    expect(hook('mobile-search')).toBe(document.getElementById('mobile-search-bar'));
  });

  it('has the tabs of the issues panel, one hook each', () => {
    const tabs = [...document.querySelectorAll('#forge-panel [data-corn="tab"]')];
    expect(tabs.map((t) => t.getAttribute('data-forge-kind'))).toEqual(['pulls', 'issues', 'threads', 'deploys', 'work', 'notes']);
    expect(hook('tabs').contains(tabs[0])).toBe(true);
  });

  it('has the three dialogs, each in a scrim, and every dialog box ends in -dialog', () => {
    expect(hook('confirm-dialog').closest('[data-corn="dialog-scrim"]').id).toBe('forge-confirm');
    expect(hook('agent-dialog').closest('[data-corn="dialog-scrim"]').id).toBe('agent-start');
    expect(hook('tokens-dialog').closest('[data-corn="dialog-scrim"]').id).toBe('tokens-dialog');
    const boxes = [...document.querySelectorAll('[role="dialog"]')];
    expect(boxes.length).toBe(3);
    for (const b of boxes) expect(b.getAttribute('data-corn')).toMatch(/-dialog$/);
  });

  it('gives each button kind its element', () => {
    expect($('#idea-open').getAttribute('data-corn-kind')).toBe('approve');
    expect($('[data-action="close-proposal"]').getAttribute('data-corn-kind')).toBe('quiet');
    expect($('[data-action="close-drawer"]').getAttribute('data-corn-kind')).toBe('icon');
    expect($('[data-action="retry"]').getAttribute('data-corn-kind')).toBe('primary');
    expect(document.querySelectorAll('[data-corn-kind]').length).toBeGreaterThan(10);
  });
});

describe('markup made by script', () => {
  beforeEach(() => {
    document.body.innerHTML = body;
    Object.assign(state, { nodes: [{ id: 'a', type: 'page', x: 100, y: 100, r: 20, color: '#fff', label: 'a' }, { id: 'b', type: 'app', x: 300, y: 100, r: 20, color: '#fff', label: 'b' }], edges: [{ from: 'a', to: 'b', kind: 'calls' }], width: 800, height: 600, camera: { x: 0, y: 0, zoom: 1 }, coveredBottom: 0, scenario: null, proposal: undefined, theme: 'dark', activeLayers: {} });
    state.canvas = document.getElementById('graph-canvas');
    vi.stubGlobal('requestAnimationFrame', () => 0);
    setRenderer({ kind: 'stub', draw() {}, resize() {}, destroy() {} });
  });
  afterEach(() => { clearScenario(); vi.unstubAllGlobals(); });

  it('puts a hook on each layer row, with its state', () => {
    renderLayerToggles();
    const rows = [...document.querySelectorAll('#layer-toggles-container [data-corn="layer-toggle"]')];
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) expect(['on', 'off']).toContain(r.getAttribute('data-corn-state'));
  });

  it('puts hooks on a proposal card in the Proposals menu', () => {
    const host = document.createElement('div');
    host.innerHTML = proposalRowHtml({ slug: '0001-x', source: 'checkout', title: 'Meals', summary: 'Adds meals', counts: { added: 1, changed: 0, removed: 0 } }, { slug: '0001-x', source: 'checkout' });
    const card = host.querySelector('[data-corn="proposal-item"]');
    expect(card.tagName).toBe('BUTTON');
    expect(card.getAttribute('data-corn-state')).toBe('current');
    expect(card.querySelector('[data-corn="proposal-item-title"]').textContent).toBe('Meals');
  });

  it('puts hooks on a run card: its state, its head, its buttons with their kinds', () => {
    const ctx = { esc: escHtml, safeUrl: () => false, forgeName: 'Forge', forgeType: 'github', repoUrl: null, now: Date.parse('2026-10-18T12:00:00Z'), nodes: state.nodes, selected: null, timelines: new Set(), replies: new Map(), busy: false };
    const run = { runId: 'r1', kind: 'spec', status: 'working', open: true, refs: { issue: 5 }, requestedAt: '2026-10-18T11:00:00Z', nodes: ['a'], timeline: [], checks: [] };
    const host = document.createElement('ul');
    host.innerHTML = runsHtml(ctx, [run]);
    const card = host.querySelector('[data-corn="run"]');
    expect(card.getAttribute('data-corn-state')).toBe('working');
    expect(card.querySelector('[data-corn="run-head"] [data-corn="state-pill"]').getAttribute('data-corn-state')).toBe('running');
    expect(card.querySelector('[data-forge-stop]').getAttribute('data-corn-kind')).toBe('danger');
    expect(card.querySelector('[data-corn="run-actions"]')).not.toBeNull();
  });

  it('puts hooks on the mockups section of the node panel', () => {
    const host = document.createElement('div');
    host.innerHTML = mockupsSectionHtml([{ index: 0, node: 'a', path: 'x.png', title: 'List', type: 'image', url: '/m/0', state: 'changed' }]);
    expect(host.querySelector('[data-corn="mockups"]')).not.toBeNull();
    expect(host.querySelector('[data-corn="mockup-open"]').getAttribute('data-mockup')).toBe('0');
    expect(host.querySelector('[data-corn="state-pill"]').getAttribute('data-corn-state')).toBe('changed');
  });

  it('puts hooks on the scenario player', () => {
    initScenarioUi();
    playScenario({ id: 's', title: 'Saving', stepMs: 1000, steps: [{ node: 'a', text: 'Opens.' }, { node: 'b', text: 'Saves.' }] }, { autoplay: false });
    const bar = hook('scenario-player');
    expect(bar).not.toBeNull();
    expect(bar.querySelector('[data-corn="player-title"]').textContent).toBe('Saving');
    expect(bar.querySelector('[data-corn="scenario-toggle"]').getAttribute('data-corn-kind')).toBe('primary');
    expect(bar.querySelector('[data-corn="close-button"]').getAttribute('data-corn-kind')).toBe('icon');
    expect(bar.querySelector('[data-corn="player-track"] [data-corn="player-fill"]')).not.toBeNull();
    expect(bar.querySelector('[data-corn="sheet-handle"]')).not.toBeNull(); // the bottom-sheet handle the player is given
  });
});
