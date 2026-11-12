// @vitest-environment happy-dom
/**
 * cornfield's page and its pieces (spec 0011 D3, explorer/page-pieces.js). The pieces make their markup when page.js mounts them, after the
 * scripts are loaded; the page is painted before that. So the header keeps a stand-in of the Layers chip and of the search field in
 * index.html: the first paint has them where they will be, the same size, and nothing in the header moves when the pieces come. The stand-in
 * is the piece's own markup without ids, kept the same by the test below, and goes when the piece is mounted (engine/piece.js `place`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { explorerPage, standIn, standInsOf, PIECE_MARKUP } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { ensurePagePieces } from '../../explorer/page-pieces.js';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { setRenderer } from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { selectNode, closeDrawer } from '../../explorer/panels.js';
// @ts-expect-error plain JS modules, no declarations
import { RESULT_MS } from '../../explorer/feedback.js';

const html = explorerPage();
const body = /<body>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const header = () => document.querySelector('[data-corn="header"]');
/** The hooks of the header's controls, in document order (not the rows the Layers menu draws once it is mounted) */
const headerHooks = () => [...header().querySelectorAll('button, input, [data-corn="search"]')].filter((el) => !el.closest('#layer-toggles-container')).map((el) => el.getAttribute('data-corn') || el.getAttribute('data-action'));
const squash = (s) => s.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

describe('the header before the scripts run', () => {
  beforeEach(() => { document.body.innerHTML = body; });

  it('already has the Layers chip, the search field and the phone\'s search button, where the pieces will be', () => {
    const chip = header().querySelector('[data-corn="layers-button"]');
    const field = header().querySelector('[data-corn="search"] [data-corn="search-input"]');
    const phone = header().querySelector('[data-corn="mobile-search-button"]');
    expect(chip && field && phone).toBeTruthy();
    expect(chip.textContent).toBe('Layers');
    expect(field.getAttribute('placeholder')).toBe('Search...');
    // in the header's order: the View switch, Fit, the Layers chip; then search, and Work after it
    const hooks = headerHooks();
    expect(hooks.indexOf('fit-button')).toBeLessThan(hooks.indexOf('layers-button'));
    expect(hooks.indexOf('layers-button')).toBeLessThan(hooks.indexOf('search'));
    expect(hooks.indexOf('search')).toBeLessThan(hooks.indexOf('forge-button'));
  });

  it('keeps as stand-ins exactly the pieces\' markup, without ids', () => {
    const stands = standInsOf(html);
    expect(Object.keys(stands).sort()).toEqual(['layers/menu', 'search/field']);
    for (const [place, markup] of Object.entries(stands)) {
      const [name, slot] = place.split('/');
      expect(squash(markup), place).toBe(squash(standIn(PIECE_MARKUP[name]()[slot])));
      expect(markup, place).not.toMatch(/\sid="/); // the piece's elements have the ids: a module looking one up never finds a stand-in
    }
  });
});

describe('the header once the pieces are mounted', () => {
  beforeEach(() => { document.body.innerHTML = body; });

  it('has each piece once, in the stand-in\'s place and order, and no stand-in left', () => {
    const before = headerHooks();
    ensurePagePieces();
    expect(headerHooks()).toEqual(before);
    for (const hook of ['layers-button', 'search', 'search-input', 'mobile-search-button', 'layers-menu']) expect(document.querySelectorAll(`[data-corn="${hook}"]`), hook).toHaveLength(hook === 'search-input' ? 2 : 1);
    expect(document.getElementById('legend-toggle-btn').getAttribute('data-corn')).toBe('layers-button');
    expect(document.getElementById('node-search').closest('[data-corn="search"]')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('corn-placeholder');
  });

  it('carries over what was typed in the stand-in, and its focus', () => {
    const early = header().querySelector('[data-corn="search-input"]');
    early.focus();
    early.value = 'billing';
    ensurePagePieces();
    const field = document.getElementById('node-search');
    expect(field).not.toBe(early);
    expect(field.value).toBe('billing');
    expect(document.activeElement).toBe(field);
  });
});

describe('Copy Spec\'s result in the mounted panel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    document.body.innerHTML = body;
    ensurePagePieces();
    Object.assign(state, { nodes: [{ id: 'a', type: 'page', x: 100, y: 100, r: 20, color: '#fff', label: 'Orders' }, { id: 'b', type: 'app', x: 300, y: 100, r: 20, color: '#fff', label: 'Shop' }], edges: [{ from: 'a', to: 'b', kind: 'calls' }], width: 800, height: 600, camera: { x: 0, y: 0, zoom: 1 }, coveredBottom: 0, scenario: null, proposal: undefined, theme: 'dark', activeLayers: {} });
    state.canvas = document.getElementById('graph-canvas');
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) }, onLine: true });
    setRenderer({ kind: 'stub', draw() {}, resize() {}, destroy() {} });
  });
  afterEach(() => { closeDrawer(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('goes RESULT_MS after the click and not before: closing the panel or choosing another node does not take it, as on main', async () => {
    const result = () => document.getElementById('copy-spec-result');
    await selectNode(state.nodes[0]);
    document.querySelector('#spec-drawer [data-action="copy-spec"]').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(result().hidden).toBe(false);
    expect(result().textContent).toBe('Copied the spec of Orders to the clipboard.');
    document.querySelector('#spec-drawer [data-action="close-drawer"]').click(); // Close
    await selectNode(state.nodes[1]); // another node
    document.getElementById('spec-drawer').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); // Escape in the panel
    await vi.advanceTimersByTimeAsync(RESULT_MS - 10);
    expect(result().hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(result().hidden).toBe(true);
    expect(result().textContent).toBe('');
  });
});
