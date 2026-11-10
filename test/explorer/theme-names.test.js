// @vitest-environment happy-dom
/**
 * Named themes on the page (docs/config.md#theme): theme-boot.js puts data-theme-name on <html> before the first paint, from
 * the viewer's pick in localStorage or else the config's default; the picker in the header switches it, and the pick is
 * remembered. The page still renders if storage is unavailable.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXPLORER, explorerPage } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { THEME_NAME_STORAGE_KEY, themeNameFrom, themeNameHref } from '../../explorer/theme-model.js';
import { applyBranding } from '../../explorer/plugins.js';
import { initThemePicker } from '../../explorer/theme-names.js';

const BOOT = fs.readFileSync(path.join(EXPLORER, 'theme-boot.js'), 'utf8');
const root = () => document.documentElement;

/** (The link is not rel=stylesheet here, so happy-dom does not try to fetch it.) The page as the server sends it for names day and night: the <html> tag, the named link, the header's select */
function pageFor({ names = ['day', 'night'], fallback = 'night' } = {}) {
  root().setAttribute('data-theme-names', names.join(' '));
  if (fallback) root().setAttribute('data-theme-default', fallback); else root().removeAttribute('data-theme-default');
  root().removeAttribute('data-theme-name');
  const html = explorerPage();
  const select = html.slice(html.indexOf('<select id="theme-name-select"'), html.indexOf('</select>', html.indexOf('id="theme-name-select"')) + 9);
  document.head.innerHTML = fallback ? `<link rel="x-test-stylesheet" id="cf-theme-name-css" href="/cornfield/theme/${fallback}.css">` : '<link rel="x-test-stylesheet" id="cf-theme-name-css">';
  document.body.innerHTML = select;
}
const boot = () => new Function(BOOT)();
const link = () => document.getElementById('cf-theme-name-css');
const select = () => /** @type {HTMLSelectElement} */ (document.getElementById('theme-name-select'));

beforeEach(() => {
  window.localStorage.clear();
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  for (const a of ['data-theme', 'data-theme-name', 'data-theme-names', 'data-theme-default']) root().removeAttribute(a);
});

describe('the header', () => {
  it('has a small <select> next to the theme toggle, hidden until the config has names, with an existing class', () => {
    const html = explorerPage();
    expect(html).toMatch(/<select id="theme-name-select" class="hx-forge-select"[^>]* hidden><\/select>/);
    expect(html.indexOf('id="theme-name-select"')).toBeGreaterThan(html.indexOf('id="theme-toggle-btn"'));
    expect(html.indexOf('id="theme-name-select"')).toBeLessThan(html.indexOf('id="cf-links"'));
  });
});

describe('theme-boot.js, before the first paint', () => {
  it('sets data-theme-name to the default when nothing is stored, and points the named link at it', () => {
    pageFor();
    boot();
    expect(root().getAttribute('data-theme-name')).toBe('night');
    expect(link().getAttribute('href')).toBe('/cornfield/theme/night.css');
  });

  it('prefers the viewer\'s stored pick when it is one of the names', () => {
    pageFor();
    window.localStorage.setItem(THEME_NAME_STORAGE_KEY, 'day');
    boot();
    expect(root().getAttribute('data-theme-name')).toBe('day');
    expect(link().getAttribute('href')).toBe('/cornfield/theme/day.css');
  });

  it('ignores a stored pick that is not one of the names (a removed theme, or a made-up value)', () => {
    pageFor();
    for (const stored of ['gone', '../x', '', 'DAY']) {
      window.localStorage.setItem(THEME_NAME_STORAGE_KEY, stored);
      boot();
      expect(root().getAttribute('data-theme-name'), stored).toBe('night');
    }
  });

  it('sets nothing without names, and no name without a default or a pick', () => {
    root().removeAttribute('data-theme-names');
    boot();
    expect(root().hasAttribute('data-theme-name')).toBe(false);
    pageFor({ fallback: null });
    boot();
    expect(root().hasAttribute('data-theme-name')).toBe(false);
    expect(link().hasAttribute('href')).toBe(false);
  });

  it('still sets the default when storage is blocked', () => {
    pageFor();
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    boot();
    expect(root().getAttribute('data-theme-name')).toBe('night');
    get.mockRestore();
  });

  it('agrees with theme-model.js themeNameFrom, and does not disturb light or dark', () => {
    const names = ['day', 'night'];
    for (const [stored, fallback] of [[null, 'night'], ['day', 'night'], ['nope', 'night'], ['day', null], [null, null], [null, 'nope']]) {
      pageFor({ names, fallback });
      if (stored) window.localStorage.setItem(THEME_NAME_STORAGE_KEY, stored); else window.localStorage.removeItem(THEME_NAME_STORAGE_KEY);
      window.localStorage.setItem('topology-explorer:theme', 'light');
      boot();
      expect(root().getAttribute('data-theme-name') || '', `${stored}/${fallback}`).toBe(themeNameFrom(stored, names, fallback));
      expect(root().getAttribute('data-theme')).toBe('light');
    }
    expect(themeNameHref('night')).toBe('/cornfield/theme/night.css');
    expect(themeNameHref('../x')).toBe('');
  });
});

describe('the picker', () => {
  const config = { theme: { names: ['day', 'night'], default: 'night' } };

  it('is hidden without names, and filled with them when the config has some (through applyBranding)', () => {
    pageFor();
    applyBranding(document, { title: 'x', links: [], theme: null });
    expect(select().hidden).toBe(true);
    applyBranding(document, { title: 'x', links: [], ...config });
    expect(select().hidden).toBe(false);
    expect([...select().options].map((o) => o.value)).toEqual(['day', 'night']);
    expect(select().value).toBe('night');
  });

  it('switches data-theme-name and the stylesheet, and remembers the pick', () => {
    pageFor();
    boot();
    initThemePicker(document, config.theme);
    select().value = 'day';
    select().dispatchEvent(new Event('change'));
    expect(root().getAttribute('data-theme-name')).toBe('day');
    expect(link().getAttribute('href')).toBe('/cornfield/theme/day.css');
    expect(window.localStorage.getItem(THEME_NAME_STORAGE_KEY)).toBe('day');
    // the next visit starts on it, before paint
    root().removeAttribute('data-theme-name');
    boot();
    expect(root().getAttribute('data-theme-name')).toBe('day');
    // choosing the default again forgets the pick, so the config's default governs
    select().value = 'night';
    select().dispatchEvent(new Event('change'));
    expect(root().getAttribute('data-theme-name')).toBe('night');
    expect(window.localStorage.getItem(THEME_NAME_STORAGE_KEY)).toBeNull();
  });

  it('shows the stored pick as selected', () => {
    pageFor();
    window.localStorage.setItem(THEME_NAME_STORAGE_KEY, 'day');
    initThemePicker(document, config.theme);
    expect(select().value).toBe('day');
    expect(root().getAttribute('data-theme-name')).toBe('day');
  });

  it('offers "Standard" when there is no default, and switching to it clears the name', () => {
    pageFor({ fallback: null });
    initThemePicker(document, { names: ['day', 'night'], default: null });
    expect([...select().options].map((o) => o.textContent)).toEqual(['Standard', 'day', 'night']);
    select().value = 'day';
    select().dispatchEvent(new Event('change'));
    expect(root().getAttribute('data-theme-name')).toBe('day');
    select().value = '';
    select().dispatchEvent(new Event('change'));
    expect(root().hasAttribute('data-theme-name')).toBe(false);
  });

  it('works when storage is unavailable: the pick holds for the visit, nothing throws', () => {
    pageFor();
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    initThemePicker(document, config.theme);
    select().value = 'day';
    expect(() => select().dispatchEvent(new Event('change'))).not.toThrow();
    expect(root().getAttribute('data-theme-name')).toBe('day');
    get.mockRestore();
    set.mockRestore();
  });

  it('ignores names that are not plain, so nothing odd reaches an attribute or a URL', () => {
    pageFor();
    initThemePicker(document, { names: ['ok', '"><script>', '../x'], default: 'ok' });
    expect([...select().options].map((o) => o.value)).toEqual(['ok']);
  });
});
