// @vitest-environment happy-dom
/**
 * The header (CF-41): brand, the View switch with Fit, the Layers chip with its count, search with its hint, the Work toggle and the
 * one account menu. What the header lost (the Proposals and Review tokens buttons, the zoom buttons, the theme cycle button and the
 * loose theme select) is not in the page, and what moved is in the account menu.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { explorerPage } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { renderLayerToggles, LAYER_DEFS } from '../../explorer/layers.js';
// @ts-expect-error plain JS modules, no declarations
import { syncViewUi } from '../../explorer/view.js';
// @ts-expect-error plain JS modules, no declarations
import { applyBranding } from '../../explorer/plugins.js';

const html = explorerPage();
const body = /<body>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const $ = (id) => document.getElementById(id);
const header = () => document.querySelector('[data-corn="header"]');

beforeEach(() => { document.body.innerHTML = body; Object.assign(state, { nodes: [], edges: [], activeLayers: {}, theme: 'dark', view: 'orbit', runsMap: null }); });

describe('the header, left to right', () => {
  it('has the brand, the View switch, the Layers chip, search, Work and the account menu, in that order', () => {
    const order = ['cf-brand', 'preset-map-btn', 'preset-dataflow-btn', 'preset-house-btn', 'fit-btn', 'legend-toggle-btn', 'node-search', 'forge-btn', 'account-btn'];
    const at = order.map((id) => [...header().querySelectorAll('*')].indexOf($(id)));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('is a switch of three, one of which is on, with Fit at its end', () => {
    const group = document.querySelector('[role="group"][aria-label="View"]');
    expect([...group.querySelectorAll('button')].map((b) => b.id)).toEqual(['preset-map-btn', 'preset-dataflow-btn', 'preset-house-btn', 'fit-btn']);
    expect(group.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    expect($('fit-btn').getAttribute('aria-label')).toBe('Fit to the screen');
    expect($('fit-btn').dataset.action).toBe('fit');
  });

  it('follows the view in aria-pressed', () => {
    const on = () => [...document.querySelectorAll('.hx-view-btn')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.id);
    syncViewUi();
    expect(on()).toEqual(['preset-map-btn']);
    state.view = 'dataflow'; syncViewUi();
    expect(on()).toEqual(['preset-dataflow-btn']);
    state.view = 'house'; syncViewUi();
    expect(on()).toEqual([]); // house.js sets its own button
    state.view = 'orbit'; syncViewUi();
    expect(on()).toEqual(['preset-map-btn']);
  });

  it('says how many layers are on, on the Layers chip, and keeps the name its own words', () => {
    renderLayerToggles();
    const chip = $('legend-toggle-btn');
    expect(chip.textContent).toBe(`Layers · ${LAYER_DEFS.length} of ${LAYER_DEFS.length}`);
    state.activeLayers = { app: false, pkg: false, page: false };
    renderLayerToggles();
    expect(chip.textContent).toBe(`Layers · ${LAYER_DEFS.length - 3} of ${LAYER_DEFS.length}`);
    expect(chip.hasAttribute('aria-label')).toBe(false); // named by what it says
    expect(chip.getAttribute('aria-controls')).toBe('legend-dropdown');
  });

  it('has the search with a / hint, and the brand button that resets the view', () => {
    expect(document.querySelector('[data-corn="search"] kbd').textContent).toBe('/');
    expect($('node-search').getAttribute('aria-keyshortcuts')).toBe('/');
    expect($('cf-brand').dataset.action).toBe('reset-view');
  });
});

describe('what the header lost', () => {
  it('has no zoom buttons, no theme cycle button, no loose theme select and no Proposals or Review tokens button outside the menu', () => {
    expect(document.querySelector('[data-corn="zoom"]')).toBeNull();
    for (const a of ['zoom-in', 'zoom-out', 'cycle-theme']) expect(document.querySelector(`[data-action="${a}"]`), a).toBeNull();
    expect($('theme-toggle-btn')).toBeNull();
    for (const id of ['proposal-btn', 'tokens-btn', 'theme-name-select', 'freeform-toggle-btn', 'reset-positions-btn', 'cf-links', 'cf-powered']) expect($(id).closest('#account-menu'), id).not.toBeNull();
    expect(header().querySelectorAll('[data-action="reset-view"]')).toHaveLength(1);
  });
});

describe('the account menu', () => {
  it('holds who, Theme, Freeform layout (a switch, Reset positions under it), Review tokens, Proposals, the links and the footer, in that order', () => {
    const menu = $('account-menu');
    expect(menu.hidden).toBe(true);
    expect($('account-btn').getAttribute('aria-expanded')).toBe('false');
    expect($('account-btn').getAttribute('aria-controls')).toBe('account-menu');
    const order = ['account-who', 'theme-label', 'theme-name-select', 'freeform-toggle-btn', 'reset-positions-btn', 'tokens-btn', 'proposal-btn', 'cf-links', 'cf-powered'];
    const at = order.map((id) => [...menu.querySelectorAll('*')].indexOf($(id)));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect($('freeform-toggle-btn').getAttribute('role')).toBe('switch');
    expect($('freeform-toggle-btn').getAttribute('aria-checked')).toBe('false');
    expect($('reset-positions-btn').hidden).toBe(true);
  });

  it('says who is signed in and their role, with the initial on the button, and the version in the footer', () => {
    applyBranding(document, { title: 'x', version: '0.14.0', links: [], signIn: { login: 'popcorn245' } });
    expect($('account-initial').textContent).toBe('P');
    expect($('account-who').hidden).toBe(false);
    expect($('account-who').textContent).toBe('popcorn245 · maintainer');
    expect($('account-btn').getAttribute('aria-label')).toBe('Account menu, signed in as popcorn245');
    expect($('cf-powered').textContent).toBe('powered by cornfield 0.14.0');
  });

  it('with nobody signed in says no one, and has no Sign out', () => {
    applyBranding(document, { title: 'x', version: '0.14.0', links: [], signIn: false });
    expect($('account-who').hidden).toBe(true);
    expect($('account-initial').textContent).toBe('');
    expect(document.querySelector('[data-corn="sign-out"]')).toBeNull();
  });

  it('lists the config\'s links, the forge unless a link is already there, and Docs, then Sign out', () => {
    applyBranding(document, { title: 'x', links: [{ label: 'Wiki', href: 'https://wiki.example.test/' }], forge: { type: 'forgejo', url: 'https://forge.example.test/', repo: 'o/n' }, docs: 'https://docs.example.test/', signIn: { login: 'm' } });
    const rows = [...$('cf-links').children].map((e) => e.textContent.trim());
    expect(rows).toEqual(['Wiki', 'Forgejo', 'Docs', 'Sign out']);
    expect($('cf-links').querySelector('a[href="https://forge.example.test/o/n"]')).not.toBeNull();
    applyBranding(document, { title: 'x', links: [{ label: 'Code', href: 'https://forge.example.test/o/n/src' }], forge: { type: 'forgejo', url: 'https://forge.example.test', repo: 'o/n' }, signIn: false });
    expect([...$('cf-links').children].map((e) => e.textContent.trim())).toEqual(['Code']);
  });
});
