// @vitest-environment happy-dom
/**
 * Light mode on the page (MAP-01): theme-boot.js puts the theme on <html> before the first paint, theme.js
 * follows the system and the header toggle, keeps the choice, and tells the map and the menus.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXPLORER, explorerPage } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { THEME_STORAGE_KEY, resolveTheme, themeChoiceFrom } from '../../explorer/theme-model.js';

const BOOT = fs.readFileSync(path.join(EXPLORER, 'theme-boot.js'), 'utf8');

/** A matchMedia whose `prefers-color-scheme: light` answer can be flipped, as the system would */
function fakeMedia(light) {
  const listeners = new Set();
  const mql = { matches: light, media: '(prefers-color-scheme: light)', addEventListener: (_t, fn) => listeners.add(fn), removeEventListener: (_t, fn) => listeners.delete(fn) };
  window.matchMedia = vi.fn(() => mql);
  return { flip(next) { mql.matches = next; listeners.forEach((fn) => fn({ matches: next })); } };
}

function setAddress(search) {
  window.history.replaceState(null, '', `/${search}`);
}

function pageWithToggle() {
  const html = explorerPage();
  const at = html.indexOf('<div class="hx-account-seg"');
  document.body.innerHTML = html.slice(at, html.indexOf('</div>', at) + 6);
  return document.querySelector('[data-corn="theme-toggle"]');
}

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  setAddress('');
});

describe('theme-boot.js, before the first paint', () => {
  const cases = [
    { search: '', stored: null, light: false },
    { search: '', stored: null, light: true },
    { search: '', stored: 'light', light: false },
    { search: '', stored: 'dark', light: true },
    { search: '?theme=light', stored: 'dark', light: false },
    { search: '?theme=dark', stored: 'light', light: true },
    { search: '?theme=system', stored: 'dark', light: true },
    { search: '?theme=nonsense', stored: 'nonsense', light: true },
  ];
  it.each(cases)('agrees with theme-model.js: %o', ({ search, stored, light }) => {
    setAddress(search);
    if (stored) window.localStorage.setItem(THEME_STORAGE_KEY, stored);
    fakeMedia(light);
    new Function(BOOT)();
    expect(document.documentElement.dataset.theme).toBe(resolveTheme(themeChoiceFrom(search, stored).choice, light));
  });

  it('still sets a theme when storage is blocked and there is no matchMedia', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const mm = window.matchMedia;
    window.matchMedia = undefined;
    new Function(BOOT)();
    expect(document.documentElement.dataset.theme).toBe('dark');
    window.matchMedia = mm;
    get.mockRestore();
  });
});

describe('theme.js', () => {
  it('follows the system by default, and the system as it changes', async () => {
    const media = fakeMedia(true);
    pageWithToggle();
    const { initTheme } = await import('../../explorer/theme.js');
    const { state } = await import('../../explorer/state.js');
    const before = state.sceneVersion || 0;
    expect(initTheme()).toBe('light');
    expect(state.theme).toBe('light');
    expect(state.sceneVersion).toBeGreaterThan(before); // the map is rebuilt for the new ground
    expect(document.documentElement.dataset.theme).toBe('light');
    media.flip(false);
    expect(state.theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('the System, Dark and Light segment sets the choice, keeps it, and says which is on', async () => {
    const media = fakeMedia(false);
    const seg = pageWithToggle();
    const { initTheme, setThemeChoice, themeChoice, onThemeChange } = await import('../../explorer/theme.js');
    const { state } = await import('../../explorer/state.js');
    const heard = [];
    onThemeChange((t) => heard.push(t));
    initTheme();
    const on = () => [...seg.querySelectorAll('button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.choice);
    expect(on()).toEqual(['system']);

    setThemeChoice('light');
    expect([themeChoice(), state.theme, window.localStorage.getItem(THEME_STORAGE_KEY)]).toEqual(['light', 'light', 'light']);
    expect(on()).toEqual(['light']);

    setThemeChoice('dark');
    expect([themeChoice(), state.theme, window.localStorage.getItem(THEME_STORAGE_KEY)]).toEqual(['dark', 'dark', 'dark']);
    media.flip(true); // a set choice ignores the system
    expect(state.theme).toBe('dark');
    expect(on()).toEqual(['dark']);

    setThemeChoice('system');
    expect([themeChoice(), state.theme, window.localStorage.getItem(THEME_STORAGE_KEY)]).toEqual(['system', 'light', null]);
    expect(on()).toEqual(['system']);
    expect(heard).toEqual(['light', 'dark', 'light']);
  });

  it('?theme= wins for the visit and is not kept', async () => {
    fakeMedia(false);
    setAddress('?theme=light');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    pageWithToggle();
    const { initTheme } = await import('../../explorer/theme.js');
    expect(initTheme()).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('the Layers menu draws its dots in the theme\'s colours, again when it changes', async () => {
    fakeMedia(false);
    pageWithToggle();
    document.body.insertAdjacentHTML('beforeend', '<div id="layer-toggles-container"></div><div id="flow-legend"></div><div id="cloud-legend"></div>');
    const { initTheme, setThemeChoice } = await import('../../explorer/theme.js');
    const { renderLayerToggles, LAYER_DEFS } = await import('../../explorer/layers.js');
    const { lightColor } = await import('../../explorer/theme-model.js');
    initTheme();
    renderLayerToggles();
    const dot = () => document.querySelector('[data-layer="table"] .hx-dot').getAttribute('style');
    const table = LAYER_DEFS.find((l) => l.key === 'table').color;
    expect(dot()).toContain(table);
    setThemeChoice('light');
    expect(dot()).toContain(lightColor(table));
    expect(document.querySelector('#flow-legend').innerHTML).toContain(lightColor('#fde047'));
  });
});

describe('the page', () => {
  it('has the three choices in the account menu, each a button that names its choice', () => {
    const seg = pageWithToggle();
    expect(seg.getAttribute('role')).toBe('group');
    const buttons = [...seg.querySelectorAll('button')];
    expect(buttons.map((b) => b.dataset.choice)).toEqual(['system', 'dark', 'light']);
    for (const b of buttons) { expect(b.getAttribute('type')).toBe('button'); expect(b.dataset.action).toBe('set-theme'); expect(b.textContent.trim().length).toBeGreaterThan(0); }
  });
});
