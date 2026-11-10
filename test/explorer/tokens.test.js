/**
 * @vitest-environment node
 *
 * The design tokens (docs/theming.md). explorer/tokens.css is the one place a colour, a font, a size, a
 * radius, a border width or a shadow is written down; every other stylesheet in explorer/ reads a
 * `--corn-*` custom property. This fails the build on any literal left outside tokens.css, and checks that
 * tokens.css defines every token the docs list, in the dark theme (:root) and in both light blocks.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXPLORER, CORNFIELD } from '../helpers.js';

const NAMED = 'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgrey darkgreen darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray grey green greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgrey lightgreen lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(' ');
const NAMED_RE = new RegExp(`(?<![\\w-])(${NAMED.join('|')})(?![\\w-])`, 'i');
const COLOUR_PROPS = /^(color|background|background-color|background-image|border|border-(top|right|bottom|left)(-color)?|border-color|outline|outline-color|fill|stroke|box-shadow|text-shadow|text-decoration|text-decoration-color|caret-color|accent-color|column-rule|--[\w-]+)$/;

/** Every `property: value` of a stylesheet's declarations, with comments and `url(data:...)` taken out */
export function declarations(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\(\s*(["']?)data:[\s\S]*?\1\s*\)/gi, 'url()');
  const out = [];
  for (const m of text.matchAll(/(?<![\w-])(-{0,2}[a-zA-Z][\w-]*)\s*:\s*([^;{}]+)(?=[;}])/g)) out.push([m[1].toLowerCase(), m[2].trim()]);
  return out;
}

/** A value's comma-separated parts, not splitting inside parentheses */
function topLevel(value) {
  const parts = []; let depth = 0; let at = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++; else if (value[i] === ')') depth--; else if (value[i] === ',' && !depth) { parts.push(value.slice(at, i)); at = i + 1; }
  }
  parts.push(value.slice(at));
  return parts;
}

/** The literals in one declaration: what the contract forbids outside tokens.css */
export function literalsIn(prop, value) {
  const bare = value.replace(/var\(\s*--[\w-]+\s*\)/g, ' '); // a var() with no fallback is what we want
  const found = [];
  if (COLOUR_PROPS.test(prop)) {
    if (/#[0-9a-f]{3,8}\b/i.test(bare)) found.push('hex colour');
    if (/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i.test(bare)) found.push('colour function');
    if (NAMED_RE.test(bare.replace(/\b(currentColor|transparent|inherit)\b/gi, ' ').replace(/color-mix\(in [\w ]+,/gi, ' '))) found.push('named colour');
  }
  if (prop === 'font-family' && !/^(inherit|var\(--corn-(font|mono)\))$/.test(value)) found.push('font-family');
  if (prop === 'font' && !/^(inherit|var\(--corn-text-[\w]+\)\/[\d.]+ var\(--corn-(font|mono)\))$/.test(value)) found.push('font shorthand');
  if (prop === 'font-size' && /\d(px|pt|rem|em)\b/.test(bare)) found.push('font-size length');
  if (prop === 'border-radius' && /\d(px|rem|em)\b/.test(bare)) found.push('border-radius length');
  if (prop === 'box-shadow' && value !== 'none' && value !== 'inherit' && topLevel(value).some((s) => !s.includes('var(--corn-'))) found.push('box-shadow without tokens');
  if (/^border(-top|-right|-bottom|-left)?$/.test(prop) && /(^|\s)1px\b/.test(bare)) found.push('1px border width');
  return found;
}

const files = fs.readdirSync(EXPLORER).filter((f) => f.endsWith('.css') && f !== 'tokens.css');

describe('no literal outside tokens.css', () => {
  it('has stylesheets to check', () => {
    expect(files).toEqual(expect.arrayContaining(['explorer.css', 'house.css']));
  });

  for (const file of files) {
    it(`${file} reads tokens only`, () => {
      const bad = declarations(fs.readFileSync(path.join(EXPLORER, file), 'utf8'))
        .map(([prop, value]) => [prop, value, literalsIn(prop, value)])
        .filter(([, , l]) => l.length)
        .map(([prop, value, l]) => `${prop}: ${value}  <- ${l.join(', ')}`);
      expect(bad).toEqual([]);
    });
  }

  it('catches the literals it is meant to catch', () => {
    const caught = (p, v) => literalsIn(p, v).length > 0;
    expect(caught('color', '#fff')).toBe(true);
    expect(caught('background', 'rgba(0, 0, 0, 0.5)')).toBe(true);
    expect(caught('border-color', 'rebeccapurple')).toBe(true);
    expect(caught('font-family', 'Arial, sans-serif')).toBe(true);
    expect(caught('font-size', '11px')).toBe(true);
    expect(caught('border-radius', '8px')).toBe(true);
    expect(caught('box-shadow', '0 1px 2px var(--x)')).toBe(true);
    expect(caught('border', '1px solid var(--corn-line)')).toBe(true);
    expect(caught('color', 'var(--corn-text)')).toBe(false);
    expect(caught('background', 'color-mix(in srgb, var(--corn-added) 14%, transparent)')).toBe(false);
    expect(caught('border', 'var(--corn-border) solid var(--corn-line)')).toBe(false);
    expect(caught('border', '0')).toBe(false);
    expect(caught('border-radius', '50%')).toBe(false);
    expect(caught('box-shadow', '0 0 8px color-mix(in srgb, var(--corn-ok) 50%, transparent)')).toBe(false);
    expect(caught('box-shadow', 'none')).toBe(false);
    expect(declarations('.a { background: url("data:image/svg+xml,%3Csvg stroke=\'%2364748b\'/%3E") no-repeat; }')).toEqual([['background', 'url() no-repeat']]);
  });
});

describe('tokens.css defines the documented tokens', () => {
  const tokensCss = fs.readFileSync(path.join(EXPLORER, 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const docs = fs.readFileSync(path.join(CORNFIELD, 'docs/theming.md'), 'utf8');
  const documented = [...new Set(docs.split('\n').filter((l) => l.startsWith('|')).flatMap((l) => [...l.split('|')[1].matchAll(/`(--corn-[\w-]+)`/g)].map((m) => m[1])))];
  const names = (block) => new Set([...block.matchAll(/(--corn-[\w-]+)\s*:/g)].map((m) => m[1]));
  // the three blocks: dark on :root, the light system setting, the light attribute
  const darkBlock = tokensCss.slice(tokensCss.indexOf(':root {'), tokensCss.indexOf('@media (prefers-color-scheme: light)'));
  const mediaStart = tokensCss.indexOf('@media (prefers-color-scheme: light)');
  const attrStart = tokensCss.indexOf(':root[data-theme="light"] {');
  const mediaBlock = tokensCss.slice(mediaStart, attrStart);
  const attrBlock = tokensCss.slice(attrStart, tokensCss.indexOf('\n}', attrStart));
  // the same in both themes: a brand colour, a size, a font, a shape
  const SAME = /^--corn-(accent|accent-hover|accent-soft|text-on-accent|blur|font|mono|text-(2xs|xs|sm|md|base|lg|xl)|leading|radius(-\w+)?|border|space|[\w]+-soft)$/;

  it('lists about fifty tokens in the docs, all with the --corn- prefix', () => {
    expect(documented.length).toBeGreaterThanOrEqual(40);
    for (const t of ['--corn-ground', '--corn-surface-1', '--corn-line', '--corn-shadow', '--corn-scrim', '--corn-blur', '--corn-text', '--corn-accent', '--corn-focus', '--corn-ok', '--corn-added', '--corn-font', '--corn-radius-pill', '--corn-map-collision']) expect(documented).toContain(t);
  });

  it('defines every documented token in the dark theme, on :root', () => {
    const have = names(darkBlock);
    expect(documented.filter((t) => !have.has(t))).toEqual([]);
  });

  it('defines every documented token that differs by theme in both light blocks', () => {
    for (const [what, block] of [['the system light setting', mediaBlock], ['data-theme="light"', attrBlock]]) {
      const have = names(block);
      expect(documented.filter((t) => !SAME.test(t) && !have.has(t)), what).toEqual([]);
    }
  });

  it('keeps the two light blocks in step', () => {
    const decls = (b) => [...b.matchAll(/(--corn-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => `${m[1]}=${m[2].replace(/\s+/g, ' ').trim()}`);
    expect(decls(mediaBlock)).toEqual(decls(attrBlock));
  });

  it('puts the light tokens under both selectors', () => {
    expect(tokensCss).toContain('@media (prefers-color-scheme: light) {\n  :root:not([data-theme="dark"]) {');
    expect(tokensCss).toContain(':root[data-theme="light"] {');
  });

  it('keeps the old --hx-* names as aliases of tokens', () => {
    for (const a of ['--hx-indigo', '--hx-bg', '--hx-line', '--hx-mark-added', '--hx-mark-removed', '--hx-well']) expect(tokensCss).toMatch(new RegExp(`${a}:\\s*(var\\(--corn-|color-mix\\()`));
  });
});
