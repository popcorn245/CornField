// @vitest-environment happy-dom
/**
 * The chrome contract of the 0.34 design review (E): the hint (its words by pointer, gone once a node is picked, never over a panel),
 * the header that fits its wordmark, the House view offered only where there is a house, the neutral live chip, the numbers' hook,
 * and the stylesheet rules that make a flat brand reach the panels, sheets, dialog scrim, avatar, search icon and mode caret, keep a
 * focus ring from being cut, and stop the panels sliding under reduced motion (read from explorer.css as text: a browser holds the rest,
 * the Playwright pass in the PR).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXPLORER, explorerPage } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { setStrings, resetStringsForTests } from '../../explorer/strings.js';
// @ts-expect-error plain JS modules, no declarations
import { hintText, hintWords, syncHint, dismissHint, resetHintForTests, mapCovered, HINT_STORAGE_KEY, watchHint } from '../../explorer/hint.js';
// @ts-expect-error plain JS modules, no declarations
import { fitLeft, SHORT_ATTR, OVERFLOW_ATTR } from '../../explorer/header-fit.js';
// @ts-expect-error plain JS modules, no declarations
import { revealInStrip, watchFocusRoom } from '../../explorer/focus-room.js';
// @ts-expect-error plain JS modules, no declarations
import { houseOffered } from '../../explorer/house-model.js';
// @ts-expect-error plain JS modules, no declarations
import { initHouse } from '../../explorer/house.js';
// @ts-expect-error plain JS modules, no declarations
import { chipModel, failureWords } from '../../explorer/live-model.js';
// @ts-expect-error plain JS modules, no declarations
import { NO_SOURCE } from '../../explorer/plugins.js';

const html = explorerPage();
const body = /<body>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const css = fs.readFileSync(path.join(EXPLORER, 'explorer.css'), 'utf8');
const rule = (selector) => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  return css.slice(at, css.indexOf('}', at) + 1);
};
const $ = (id) => document.getElementById(id);
const hint = () => document.querySelector('[data-corn="hint"]');

beforeEach(() => {
  document.body.innerHTML = body;
  Object.assign(state, { nodes: [], edges: [], view: 'orbit', isFreeform: false, proposal: null });
  resetStringsForTests();
  resetHintForTests();
});
afterEach(() => { resetStringsForTests(); resetHintForTests(); });

describe('the hint (F56)', () => {
  it('says Click with a mouse and Tap with a finger, and the repo\'s own words where it set only the plain key', () => {
    expect(hintText(false)).toBe('Click a node to see what it is');
    expect(hintText(true)).toBe('Tap a node to see what it is');
    state.isFreeform = true;
    expect(hintText(false)).toBe('Drag nodes to move • Double-click to inspect');
    expect(hintText(true)).toBe('Drag nodes to move • Double-tap to inspect');
    state.isFreeform = false;
    setStrings({ hintInspect: 'Poke a node' });
    expect(hintText(false)).toBe('Poke a node');
    expect(hintText(true)).toBe('Poke a node'); // a brand that set one line gets it on both
    setStrings({ hintInspect: 'Poke a node', hintInspectTouch: 'Press a node' });
    expect(hintText(true)).toBe('Press a node');
    state.view = 'dataflow';
    expect(hintText(true)).toBe('Data flow: browser → servers → API → tables → services → outside');
    expect(hintWords({ text: 'a', set: false }, { text: 'b', set: false }, false)).toBe('a');
  });

  it('has an icon with a hook of its own, drawn as an SVG, not a character', () => {
    const icon = hint().querySelector('[data-corn="hint-icon"]');
    expect(icon.querySelector('svg')).not.toBeNull();
    expect(hint().textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('goes once a node is picked, for the session, and stays for the Flow view\'s own description', () => {
    syncHint();
    expect(hint().hidden).toBe(false);
    dismissHint();
    expect(hint().hidden).toBe(true);
    expect(window.sessionStorage.getItem(HINT_STORAGE_KEY)).toBe('1');
    state.view = 'dataflow';
    syncHint();
    expect(hint().hidden).toBe(false);
    state.view = 'orbit';
    syncHint();
    expect(hint().hidden).toBe(true);
  });

  it('is never over an open proposal, the node panel, the Work panel or a playing scenario', () => {
    syncHint();
    expect(hint().hidden).toBe(false);
    const bar = $('proposal-bar');
    bar.hidden = false;
    expect(mapCovered()).toBe(true);
    syncHint();
    expect(hint().hidden).toBe(true);
    bar.hidden = true;
    syncHint();
    expect(hint().hidden).toBe(false);
    for (const [id, cls] of [['spec-drawer', 'drawer-open'], ['forge-panel', 'forge-open']]) {
      $(id).classList.add(cls);
      syncHint();
      expect(hint().hidden, id).toBe(true);
      $(id).classList.remove(cls);
      syncHint();
      expect(hint().hidden, id).toBe(false);
    }
    const player = document.createElement('div');
    player.dataset.corn = 'scenario-player';
    $('sheet-dock').appendChild(player);
    syncHint();
    expect(hint().hidden).toBe(true);
  });

  it('follows the panels by itself once watched', async () => {
    const stop = watchHint(document);
    $('spec-drawer').classList.add('drawer-open');
    await new Promise((r) => setTimeout(r, 0));
    expect(hint().hidden).toBe(true);
    $('spec-drawer').classList.remove('drawer-open');
    await new Promise((r) => setTimeout(r, 0));
    expect(hint().hidden).toBe(false);
    stop();
  });
});

describe('the header fits its wordmark (F46)', () => {
  const sized = (el, scroll, client) => { Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => scroll() }); Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => client }); };
  const left = () => document.querySelector('.hx-header-left');

  it('drops the wordmark when it does not fit, and shows the logo alone', () => {
    const l = left();
    const wm = document.createElement('img');
    wm.dataset.corn = 'brand-wordmark';
    l.querySelector('#cf-title').appendChild(wm);
    sized(l, () => (l.hasAttribute(SHORT_ATTR) ? 228 : 271), 228);
    expect(fitLeft(l)).toEqual({ short: true, overflow: false });
    expect(l.hasAttribute(SHORT_ATTR)).toBe(true);
    expect(l.hasAttribute(OVERFLOW_ATTR)).toBe(false);
  });

  it('keeps the wordmark where it fits, and shows an edge where even the logo does not (a row that scrolls is never silent)', () => {
    const l = left();
    const wm = document.createElement('img');
    wm.dataset.corn = 'brand-wordmark';
    l.querySelector('#cf-title').appendChild(wm);
    sized(l, () => 200, 228);
    expect(fitLeft(l)).toEqual({ short: false, overflow: false });
    sized(l, () => 300, 228);
    expect(fitLeft(l)).toEqual({ short: true, overflow: true });
    expect(l.hasAttribute(OVERFLOW_ATTR)).toBe(true);
    sized(l, () => 200, 228);
    fitLeft(l);
    expect(l.hasAttribute(OVERFLOW_ATTR)).toBe(false); // measured again each time
  });

  it('has the rules that hide the wordmark and fade the scrolling edge', () => {
    expect(css).toMatch(/\.hx-header-left\[data-brand-short\] \.hx-title \{ display: none; \}/);
    expect(css).toMatch(/\.hx-header-left\[data-overflow\] \{[^}]*mask/);
  });
});

describe('a tab brought into view keeps its ring (F54)', () => {
  it('asks for the scroll of a control focused inside the Work tabs, and of nothing else', () => {
    const calls = [];
    const tab = document.querySelector('.hx-forge-tab[data-forge-kind="deploys"]');
    tab.scrollIntoView = (o) => calls.push(o);
    expect(revealInStrip(tab)).toBe(true);
    expect(calls).toEqual([{ block: 'nearest', inline: 'nearest' }]);
    const other = $('fit-btn');
    other.scrollIntoView = (o) => calls.push(o);
    expect(revealInStrip(other)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(revealInStrip(null)).toBe(false);
  });

  it('follows focus once watched', () => {
    const stop = watchFocusRoom(document);
    const tab = document.querySelector('.hx-forge-tab[data-forge-kind="deploys"]');
    let n = 0;
    tab.scrollIntoView = () => { n++; };
    tab.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
    expect(n).toBe(1);
    stop();
    tab.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
    expect(n).toBe(1);
  });

  it('keeps the strip\'s own room for the ring: scroll-padding on the strip', () => {
    expect(css).toMatch(/\.hx-forge-tabs \{ scroll-padding-inline: var\(--corn-space-4\); \}/);
  });
});

describe('the House view is offered only where there is a house (F47)', () => {
  it('needs a source that can answer for a house, or a floor or a room in the map', () => {
    expect(houseOffered(false, [{ type: 'app' }, { type: 'page' }, { type: 'device' }, { type: 'persona' }])).toBe(false); // devices and people come from code: no plan to put them on
    expect(houseOffered(false, [])).toBe(false);
    expect(houseOffered(true, [])).toBe(true);
    for (const type of ['floor', 'room']) expect(houseOffered(false, [{ type: 'app' }, { type }]), type).toBe(true);
    expect(houseOffered(false, undefined)).toBe(false);
  });

  it('hides the House button when it is not offered, and not otherwise', () => {
    initHouse({ offered: false });
    expect($('preset-house-btn').hidden).toBe(true);
    initHouse({});
    expect($('preset-house-btn').hidden).toBe(false);
  });

  it('is not an error for a repo to name no live source: the chip is neutral and says so in plain words', () => {
    const err = Object.assign(new Error('no live source is configured'), { reason: 'unavailable', notConfigured: true, hint: 'no live source is set in cornfield.config.js (sources)' });
    expect(failureWords(err)).toMatchObject({ tone: 'off', text: 'No live layer: no live source is set in cornfield.config.js (sources)' });
    const snap = { status: 'failed', answer: null, error: err, lastOkAt: null };
    expect(chipModel(snap, { house: true })).toMatchObject({ tone: 'off', text: 'Default plan, no live layer' });
    expect(chipModel(snap).tone).toBe('off');
    // a real failure is still an error
    expect(chipModel({ ...snap, error: { reason: 'unavailable', hint: 'timed out' } }).tone).toBe('error');
  });

  it('marks the no-source error the explorer\'s own source throws', async () => {
    await expect(NO_SOURCE.load()).rejects.toMatchObject({ notConfigured: true });
  });
});

describe('numbers have a hook and a face (F51)', () => {
  it('puts data-corn="count" on the tab counts, the Layers count and the Work button\'s lit tag', () => {
    expect(document.querySelectorAll('.hx-forge-count[data-corn="count"]').length).toBe(document.querySelectorAll('.hx-forge-count').length);
    expect($('layers-count').getAttribute('data-corn')).toBe('count');
    expect($('forge-btn-lit').getAttribute('data-corn')).toBe('count');
  });

  it('sets numbers in --corn-font-num, with tabular figures', () => {
    expect(css).toMatch(/\.hx-count, [^{]*\.hx-forge-count[^{]*\.hx-row-meta, \.hx-run-limits dd \{ font-family: var\(--corn-font-num\); font-variant-numeric: tabular-nums; \}/);
    // and no earlier rule still names the code face for them (it would only be overridden)
    for (const sel of ['.hx-count', '.hx-forge-lit', '.hx-ms']) expect(css, sel).not.toMatch(new RegExp(`\\n\\${sel} \\{[^}]*--corn-mono`));
  });
});

describe('what a flat brand reaches (F49) and what never clips or moves (F54, F55)', () => {
  it('draws the panels\' edges and dividers from --corn-line and --corn-line-soft, not the surface', () => {
    for (const sel of ['hx-drawer', 'hx-forge']) expect(css).toMatch(new RegExp(`\\.${sel} \\{[^}]*border-color: var\\(--corn-line\\);`));
    expect(css).not.toMatch(/border-color: var\(--corn-surface-2\)/);
    expect(css).toMatch(/\.hx-forge-head \{[^}]*border-bottom: var\(--corn-border\) solid var\(--corn-line-soft\)/);
    expect(css).toMatch(/\.hx-drawer-foot \{[^}]*border-top: var\(--corn-border\) solid var\(--corn-line-soft\)/);
  });

  it('takes the phone sheet\'s shadow, the dialog scrim and the avatar\'s shape from tokens', () => {
    expect(css).not.toMatch(/0 -8px 24px/);
    expect(css).toMatch(/\.hx-dock > \.hx-sheet \{[^}]*box-shadow: var\(--corn-shadow-sheet\)/);
    expect(rule('.hx-confirm-scrim')).toContain('background: var(--corn-scrim);');
    expect(rule('.hx-avatar')).toContain('border-radius: var(--corn-radius-pill);');
  });

  it('draws the search icon and the mode caret from the text colour as masks, not a fixed picture or two borders', () => {
    expect(css).not.toMatch(/stroke='%2364748b'/);
    expect(rule('.hx-input')).not.toContain('url(');
    expect(css).toMatch(/\.hx-mobile-search::before \{[^}]*background: var\(--corn-text-3\);[^}]*mask:/);
    expect(css).toMatch(/\.hx-proposal-mode::after \{[^}]*background: currentColor;[^}]*mask:/);
    // Forced colours repaint backgrounds: the two masked icons take the system text colour there, or they would vanish
    expect(css).toMatch(/@media \(forced-colors: active\) \{\s*\.hx-mobile-search::before, \.hx-proposal-mode::after \{ background: CanvasText; \}/);
    expect(css).not.toMatch(/\.hx-proposal-mode::after \{[^}]*border:/);
    expect(css).not.toMatch(/\.hx-proposal-mode::after \{[^}]*border-width/);
  });

  it('never cuts a focus ring: inset rings are the ring\'s own width inside, and scroll containers stop a row short of the edge', () => {
    expect(css).not.toMatch(/outline-offset: -?\d+px/);
    expect(rule('.hx-forge-tab:focus-visible, .hx-forge-chip:focus-visible, .hx-forge-back:focus-visible')).toContain('outline-offset: calc(var(--corn-focus-width) * -1)');
    expect(css).toMatch(/\.hx-forge-body[^{]*\{ scroll-padding-block: calc\(var\(--corn-focus-width\) \+ var\(--corn-focus-offset\)/);
    expect(css).toMatch(/outline-offset: var\(--corn-focus-offset\)/);
  });

  it('stops the panels, sheets and menus sliding under reduced motion', () => {
    const at = css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('No panel, sheet or menu slides')); // the chrome contract's block, wherever other sections add theirs
    const block = css.slice(at, css.indexOf('\n}', at));
    for (const sel of ['.hx-drawer', '.hx-forge', '.hx-input', '.hx-menu', '.hx-sheet']) expect(block).toContain(sel);
    expect(block).toMatch(/transition: none;/);
  });
});
