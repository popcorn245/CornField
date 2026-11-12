// @vitest-environment node
/**
 * Spec 0011 D7: the server's theme in another app's page (explorer/engine/theme-sheet.js). The parts that need no browser: which selector is which block of
 * the documented theme contract, what a copied token may hold, and what is read from a parsed sheet. Sheets are stand-ins with the shape CSSOM gives
 * (`cssRules`, `selectorText`, `style[i]`, `getPropertyValue`): the proof that the real browser does the same is components/test/scope.browser.test.ts,
 * with a theme that holds `body { display: none }`, `* { color: red }`, an `@import` and an `@font-face`.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { absolutizeUrls, blockOf, derivedOf, selectorParts, tokenBlocks, tokensFor } from '../../explorer/engine/theme-sheet.js';

/** A rule as CSSOM has it */
const rule = (selectorText, decls) => {
  const names = Object.keys(decls);
  const style = Object.assign(Object.create({ getPropertyValue: (n) => decls[n] ?? '' }), Object.fromEntries(names.map((n, i) => [i, n])), { length: names.length });
  return { selectorText, style };
};
const media = (mediaText, ...rules) => ({ media: { mediaText }, cssRules: rules });
const sheet = (...cssRules) => ({ cssRules });

describe('which block a selector is', () => {
  it('knows the three selectors the theme contract documents, for the standard theme', () => {
    expect(blockOf(':root', null)).toBe('base');
    expect(blockOf('html', null)).toBe('base');
    expect(blockOf(':root[data-theme="light"]', null)).toBe('light');
    expect(blockOf(':root[data-theme="dark"]', null)).toBe('dark');
    expect(blockOf(':root:not([data-theme="dark"])', 'light')).toBe('light');
    expect(blockOf(':root:not([data-theme="light"])', 'dark')).toBe('dark');
    expect(blockOf(':root', 'light')).toBe('light');
  });
  it('and a named theme\'s, which name the theme on the root', () => {
    expect(blockOf(':root[data-theme-name="night"]', null, 'night')).toBe('base');
    expect(blockOf(':root[data-theme-name="night"][data-theme="light"]', null, 'night')).toBe('light');
    expect(blockOf(':root[data-theme-name="night"]:not([data-theme="dark"])', 'light', 'night')).toBe('light');
    expect(blockOf(':root[data-theme-name="other"]', null, 'night')).toBe(null); // another theme's
    expect(blockOf(':root', null, 'night')).toBe(null); // a named theme's file does not name the standard theme
    expect(blockOf(':root[data-theme-name="night"]', null, null)).toBe(null);
  });
  it('is no other selector: an element, a class, a hook, a descendant, the star', () => {
    for (const s of ['body', '*', '.dark', '[data-corn="header"]', ':root .x', 'html body', ':root > body', ':host', ':root:hover', ':rooted', 'htmlx', ':root[data-x="1"]']) expect(blockOf(s, null), s).toBe(null);
    expect(blockOf(':root:not([data-theme="dark"])', null)).toBe(null); // that selector counts only under the light media query
  });
  it('splits a selector list at its top level, spaces taken out, `:where()` taken off', () => {
    expect(selectorParts(':root, html')).toEqual([':root', 'html']);
    expect(selectorParts(':where(:root:not([data-theme="dark"]))')).toEqual([':root:not([data-theme="dark"])']);
    expect(selectorParts(':root:not([data-theme = "dark"], .a), body')).toEqual([':root:not([data-theme="dark"],.a)', 'body']);
  });
});

describe('what a copied value may hold', () => {
  it('makes a url() absolute against the server, under its path when it has one, and refuses one that is not a web address', () => {
    expect(absolutizeUrls('url("/cornfield/theme/assets/bg.png")', 'https://map.example.com')).toBe('url("https://map.example.com/cornfield/theme/assets/bg.png")');
    expect(absolutizeUrls("url('/cornfield/theme/assets/bg.png')", 'https://example.com/cornfield')).toBe('url("https://example.com/cornfield/cornfield/theme/assets/bg.png")');
    expect(absolutizeUrls('url(assets/a.png)', 'https://map.example.com')).toBe('url("https://map.example.com/assets/a.png")');
    expect(absolutizeUrls('url(https://cdn.test/a.png)', 'https://map.example.com')).toBe('url("https://cdn.test/a.png")');
    expect(absolutizeUrls('linear-gradient(#000, #fff), url("/a.png")', 'https://m.test')).toBe('linear-gradient(#000, #fff), url("https://m.test/a.png")');
    expect(absolutizeUrls('url("data:image/svg+xml,%3Csvg%3E")', 'https://m.test')).toBe('url("data:image/svg+xml,%3Csvg%3E")');
    expect(absolutizeUrls('url("javascript:alert(1)")', 'https://m.test')).toBe(null);
    expect(absolutizeUrls('url("ftp://x.test/a")', 'https://m.test')).toBe(null);
    expect(absolutizeUrls('12px', 'https://m.test')).toBe('12px');
  });
});

describe('what is read from a parsed sheet: only the --corn-* tokens of the root\'s rules', () => {
  const hostile = sheet(
    rule(':root', { '--corn-accent': '#c8102e', '--brand-private': '12px', color: 'red', '--corn-ground-image': 'url("/cornfield/theme/assets/bg.png")' }),
    rule('body', { display: 'none', '--corn-body': '1' }),
    rule('*', { color: 'red', '--corn-star': '1' }),
    rule('[data-corn="map-stage"]', { '--corn-hook': '1', outline: '3px solid green' }),
    rule(':root .inner', { '--corn-inner': '1' }),
    rule('.not-ours', { '--corn-class': '1' }),
    media('(prefers-color-scheme: light)', rule(':root:not([data-theme="dark"])', { '--corn-ground': '#fdf3dc', '--no-prefix': '1' }), rule('body', { '--corn-m': '1' })),
    media('(min-width: 600px)', rule(':root', { '--corn-wide': '1' })),
    media('(prefers-color-scheme: dark)', rule(':root:not([data-theme="light"])', { '--corn-ground': '#1a1640' })),
    rule(':root[data-theme="light"]', { '--corn-ground': '#fdf3dc', '--corn-ok': '#118833' }),
    { cssRules: [], supports: true }, // an @supports or an @import: no selector, no media
  );
  const blocks = tokenBlocks(hostile, { base: 'https://map.example.com' });

  it('copies the --corn-* declarations of :root, the light block and the dark block, and nothing else', () => {
    expect([...blocks.base.keys()].sort()).toEqual(['--corn-accent', '--corn-ground-image']);
    expect([...blocks.light.keys()].sort()).toEqual(['--corn-ground', '--corn-ok']);
    expect([...blocks.dark.keys()]).toEqual(['--corn-ground']);
    const all = [...blocks.base.keys(), ...blocks.light.keys(), ...blocks.dark.keys()];
    for (const k of ['--brand-private', '--no-prefix', '--corn-body', '--corn-star', '--corn-hook', '--corn-inner', '--corn-class', '--corn-m', '--corn-wide', 'color', 'display', 'outline']) expect(all, k).not.toContain(k);
  });
  it('makes a copied url() the server\'s', () => {
    expect(blocks.base.get('--corn-ground-image')).toBe('url("https://map.example.com/cornfield/theme/assets/bg.png")');
  });
  it('drops a token whose url() is not a web address, one that is empty and one that is far too long', () => {
    const odd = tokenBlocks(sheet(rule(':root', { '--corn-a': 'url("javascript:alert(1)")', '--corn-b': '', '--corn-c': 'x'.repeat(5000), '--corn-d': '1px' })), { base: 'https://m.test' });
    expect([...odd.base.keys()]).toEqual(['--corn-d']);
  });
  it('reads a named theme by its name', () => {
    const named = tokenBlocks(sheet(rule(':root[data-theme-name="night"]', { '--corn-ground': '#000' }), rule(':root[data-theme-name="night"][data-theme="light"]', { '--corn-ground': '#fff' }), rule(':root', { '--corn-x': '1' })), { name: 'night' });
    expect([...named.base]).toEqual([['--corn-ground', '#000']]);
    expect([...named.light]).toEqual([['--corn-ground', '#fff']]);
  });
  it('lays the mode over the base, and a stronger layer over a weaker one', () => {
    const named = tokenBlocks(sheet(rule(':root[data-theme-name="n"]', { '--corn-accent': '#111' })), { name: 'n' });
    expect(Object.fromEntries(tokensFor([blocks], 'dark'))).toEqual({ '--corn-accent': '#c8102e', '--corn-ground-image': 'url("https://map.example.com/cornfield/theme/assets/bg.png")', '--corn-ground': '#1a1640' });
    expect(tokensFor([blocks], 'light').get('--corn-ground')).toBe('#fdf3dc');
    expect(tokensFor([blocks], 'light').get('--corn-ok')).toBe('#118833');
    expect(tokensFor([blocks, named], 'dark').get('--corn-accent')).toBe('#111');
  });
  it('keeps the defaults that are made from other tokens, to be worked out on the element', () => {
    const defaults = tokenBlocks(sheet(rule(':where(:root)', { '--corn-ok': '#2f855a', '--corn-ok-soft': 'color-mix(in srgb, var(--corn-ok) 14%, transparent)' }), media('(prefers-color-scheme: light)', rule(':where(:root:not([data-theme="dark"]))', { '--corn-ok': '#1f6f46', '--corn-ok-light': 'var(--corn-ok)' }))));
    const derived = derivedOf(defaults);
    expect([...derived.base.keys()]).toEqual(['--corn-ok-soft']);
    expect([...derived.light.keys()]).toEqual(['--corn-ok-light']);
    // the theme sets --corn-ok; the tint is the default's, built from the theme's value on the element; a tint the theme sets itself wins
    const theme = tokenBlocks(sheet(rule(':root', { '--corn-ok': '#118833' })));
    expect(Object.fromEntries(tokensFor([derived, theme], 'dark'))).toEqual({ '--corn-ok-soft': 'color-mix(in srgb, var(--corn-ok) 14%, transparent)', '--corn-ok': '#118833' });
    const own = tokenBlocks(sheet(rule(':root', { '--corn-ok-soft': '#cfc' })));
    expect(tokensFor([derived, own], 'dark').get('--corn-ok-soft')).toBe('#cfc');
  });
});
