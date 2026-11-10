// @vitest-environment happy-dom
/**
 * The brand in the header (docs/config.md#brand): explorer/plugins.js `applyBranding` puts the logo where the brand mark is and the
 * wordmark where the title text is, inside the same button, whose accessible name stays; the app name is shown; "powered by cornfield"
 * stays in the links area.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { explorerPage } from '../helpers.js';
import { applyBranding } from '../../explorer/plugins.js';

const BRAND = { logo: '/cornfield/brand/logo.svg', wordmark: '/cornfield/brand/wordmark.png', favicon: '/cornfield/brand/favicon.png', appName: 'Acme', poweredBy: 'https://github.com/popcorn245/CornField#readme' };

beforeEach(() => {
  const html = explorerPage();
  document.body.innerHTML = html.slice(html.indexOf('<header'), html.indexOf('</header>') + 9);
});

const button = () => document.getElementById('cf-brand');

describe('applyBranding with a brand', () => {
  it('puts the logo in the brand mark\'s place, inside the same button, with its accessible name and action intact', () => {
    applyBranding(document, { title: 'Acme home', links: [], signIn: false, brand: { ...BRAND, wordmark: null, appName: null } });
    const b = button();
    expect(b.tagName).toBe('BUTTON');
    expect(b.getAttribute('data-action')).toBe('reset-view');
    expect(b.getAttribute('aria-label')).toBe('cornfield: reset the view');
    const logo = b.querySelector('img[data-cf="brand-logo"]');
    expect(logo.getAttribute('src')).toBe('/cornfield/brand/logo.svg');
    expect(logo.getAttribute('alt')).toBe('');
    expect(b.querySelector('.hx-live-dot')).toBeNull();
    expect(document.getElementById('cf-title').textContent).toBe('Acme home');
  });

  it('puts the wordmark where the title text is, and names the app in the button', () => {
    applyBranding(document, { title: 'Acme home', links: [], signIn: false, brand: BRAND });
    const title = document.getElementById('cf-title');
    const word = title.querySelector('img[data-cf="brand-wordmark"]');
    expect(word.getAttribute('src')).toBe('/cornfield/brand/wordmark.png');
    expect(word.getAttribute('alt')).toBe('Acme');
    expect(title.textContent).toBe('');
    expect(button().getAttribute('aria-label')).toBe('Acme: reset the view');
    expect(document.getElementById('cf-heading').textContent).toBe('Acme: the map');
    expect(button().querySelectorAll('img')).toHaveLength(2);
  });

  it('shows appName as the header text when there is no wordmark', () => {
    applyBranding(document, { title: 'Acme home', links: [], signIn: false, brand: { ...BRAND, logo: null, wordmark: null } });
    expect(document.getElementById('cf-title').textContent).toBe('Acme');
    expect(button().querySelector('.hx-live-dot')).not.toBeNull();
  });

  it('keeps "powered by cornfield" in the links area, with Sign out after it', () => {
    applyBranding(document, { title: 'Acme home', links: [{ label: 'Repo', href: 'https://forge.example.test/acme' }], signIn: { login: 'maint' }, brand: BRAND });
    const links = document.getElementById('cf-links');
    const powered = links.querySelector('a[data-cf="powered-by"]');
    expect(powered.textContent).toBe('powered by cornfield');
    expect(powered.getAttribute('href')).toBe('https://github.com/popcorn245/CornField#readme');
    expect(powered.getAttribute('rel')).toBe('noreferrer');
    expect(links.querySelector('.cf-sign-out')).not.toBeNull();
    expect(links.querySelector('a[href="https://forge.example.test/acme"]')).not.toBeNull();
    expect(links.innerHTML.indexOf('powered by')).toBeLessThan(links.innerHTML.indexOf('cf-sign-out'));
  });

  it('puts in no image that is not the server\'s URL as given, and no markup from the name', () => {
    applyBranding(document, { title: 'x', links: [], signIn: false, brand: { ...BRAND, appName: '<img src=x onerror=alert(1)>', poweredBy: 'javascript:alert(1)' } });
    expect(document.getElementById('cf-links').innerHTML).toBe('');
    expect(document.querySelectorAll('img[onerror]')).toHaveLength(0);
    expect(document.getElementById('cf-heading').textContent).toBe('<img src=x onerror=alert(1)>: the map');
  });
});

describe('applyBranding without a brand', () => {
  it('leaves the mark, the name and the links as they were, and adds no "powered by"', () => {
    applyBranding(document, { title: 'Acme home', links: [], signIn: false, brand: null });
    expect(button().getAttribute('aria-label')).toBe('cornfield: reset the view');
    expect(button().querySelector('.hx-live-dot')).not.toBeNull();
    expect(button().querySelector('img')).toBeNull();
    expect(document.getElementById('cf-links').innerHTML).toBe('');
  });
});
