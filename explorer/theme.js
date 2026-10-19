/**
 * @module explorer/theme
 *
 * Light and dark (MAP-01), the half that touches the page. theme-model.js decides the colours; this module
 * decides which theme is on and tells the page:
 *
 *   - the choice is `system` (the default: `prefers-color-scheme`, followed live), `light` or `dark`;
 *     the toggle in the header steps through them and keeps the choice in localStorage
 *     (THEME_STORAGE_KEY). `?theme=light|dark|system` in the address wins, for that visit, and is not kept;
 *   - the theme in force is `<html data-theme="light|dark">`: explorer.css swaps its tokens on it,
 *     theme-boot.js sets it before the first paint (so a light page never flashes dark), and this module
 *     keeps it right afterwards;
 *   - the map: `state.theme`, then `touchScene()`, so the next scene is built for the new ground (scene.js);
 *   - whatever else draws in colour from script listens with `onThemeChange` (the Layers menu's dots, the
 *     legend's mark colours).
 */

import { state, touchScene } from './state.js';
import { render } from './render.js';
import { THEME_STORAGE_KEY, nextChoice, resolveTheme, themeChoiceFrom, themeWords } from './theme-model.js';

const QUERY = '(prefers-color-scheme: light)';
let choice = 'system';
let media = null;
let bound = false;
const listeners = new Set();

/** Calls `fn(theme)` after the theme changes; returns how to stop */
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The choice on the toggle: 'system', 'light' or 'dark' */
export const themeChoice = () => choice;

const prefersLight = () => !!(media && media.matches);

function readStored() {
  try { return window.localStorage.getItem(THEME_STORAGE_KEY); } catch { return null; }
}

function store(value) {
  try {
    if (value === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch { /* storage blocked: the choice still holds for this visit */ }
}

function syncButton(theme) {
  const btn = document.getElementById('theme-toggle-btn');
  if (!btn) return;
  const words = themeWords(choice, theme);
  btn.setAttribute('aria-label', `${words}. Change theme`);
  btn.title = `${words}. Click for ${nextChoice(choice) === 'system' ? 'the system setting' : nextChoice(choice)}`;
  btn.dataset.choice = choice;
  btn.querySelectorAll('[data-icon]').forEach((g) => { g.toggleAttribute('hidden', g.dataset.icon !== choice); });
}

/** Puts the theme in force on the page and the map */
function apply() {
  const theme = resolveTheme(choice, prefersLight());
  const root = document.documentElement;
  root.dataset.theme = theme;
  syncButton(theme);
  if (state.theme === theme) return;
  state.theme = theme;
  touchScene();
  render();
  listeners.forEach((fn) => fn(theme));
}

/**
 * Reads the choice (the address, then storage), follows the system setting, and applies it. Once.
 * @returns {'light'|'dark'} the theme in force
 */
export function initTheme() {
  ({ choice } = themeChoiceFrom(window.location.search, readStored()));
  if (!bound) {
    bound = true;
    media = window.matchMedia ? window.matchMedia(QUERY) : null;
    if (media) {
      const onSystem = () => { if (choice === 'system') apply(); };
      if (media.addEventListener) media.addEventListener('change', onSystem);
      else if (media.addListener) media.addListener(onSystem);
    }
  }
  apply();
  return state.theme;
}

/**
 * Sets the choice ('system', 'light' or 'dark'), keeps it, and applies it
 * @param {string} next
 */
export function setThemeChoice(next) {
  choice = ['system', 'light', 'dark'].includes(next) ? next : 'system';
  store(choice);
  apply();
}

/** The header toggle: system, light, dark, system ... */
export const cycleTheme = () => setThemeChoice(nextChoice(choice));
