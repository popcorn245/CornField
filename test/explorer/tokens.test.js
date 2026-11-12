/**
 * @vitest-environment node
 *
 * The design tokens (docs/theming.md). explorer/tokens.css is the one place a colour, a font, a size, a
 * radius, a border or outline width, a shadow or a spacing is written down; every other stylesheet in explorer/ reads a
 * `--corn-*` custom property. This fails the build on any literal left outside tokens.css, and checks that
 * tokens.css defines every token the docs list, in the dark theme (:root) and in both light blocks.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXPLORER, CORNFIELD } from '../helpers.js';
import { explorerCss } from './stylesheets.js';
// @ts-expect-error plain JS modules, no declarations
import { contrast } from '../../core/color.js';
// @ts-expect-error plain JS modules, no declarations
import { EDGE_WIDTH_TOKEN, FONT_TOKEN, GLOW_TOKEN, GREY_ALPHA_TOKEN, LABEL_MIN_TOKEN, MAP_COLOR_TOKENS, STROKE_WIDTH_TOKEN, mapTokenNames } from '../../explorer/map-style.js';

const NAMED = 'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgrey darkgreen darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray grey green greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgrey lightgreen lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(' ');
const NAMED_RE = new RegExp(`(?<![\\w-])(${NAMED.join('|')})(?![\\w-])`, 'i');
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

/** A length written as a number: `12px`, `1.5REM`, `-4px` (any case, any unit); 0 alone is not one */
const LENGTH = /(?<![\w.#-])-?(\d*\.)?\d+(px|r?em|pt|pc|cm|mm|in|q|ch|ex|ic|lh|rlh|[dsl]?v(w|h|i|b|min|max)|cq(w|h|i|b|min|max))(?![\w-])/i;
const SPACING_PROPS = /^(padding|margin)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$|^(gap|row-gap|column-gap|grid-gap|grid-row-gap|grid-column-gap)$/;
const BORDER_WIDTH_PROPS = /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-width)?$|^outline(-width)?$|^column-rule(-width)?$/;

/** The value with the parts that may hold a number taken out: a token, `env()`, and `calc()` over tokens */
function withoutTokens(value) {
  let v = value.replace(/env\([^()]*\)/gi, ' ');
  v = v.replace(/var\(\s*--[\w-]+\s*\)/g, ' '); // a var() with no fallback is what we want
  return v;
}

/** The literals in one declaration: what the contract forbids outside tokens.css */
export function literalsIn(prop, rawValue) {
  const value = rawValue.replace(/\s*!\s*important\s*$/i, '').trim(); // !important hides nothing
  const bare = withoutTokens(value);
  const found = [];
  // Colours, in any property (a custom property, a vendor-prefixed one, a gradient, an SVG fill)
  if (/#[0-9a-f]{3,8}(?![\w-])/i.test(bare)) found.push('hex colour');
  if (/(?<![\w-])(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|device-cmyk)\s*\(/i.test(bare)) found.push('colour function');
  if (NAMED_RE.test(bare.replace(/\b(currentColor|transparent|inherit)\b/gi, ' ').replace(/color-mix\(\s*in [\w ]+,/gi, ' '))) found.push('named colour');
  if (/^--corn-/.test(prop)) found.push('a token defined outside tokens.css');
  if (prop === 'font-family' && !/^(inherit|var\(--corn-(font|font-display|font-num|mono)\))$/.test(value)) found.push('font-family');
  if (prop === 'font' && !/^(inherit|var\(--corn-text-[\w]+\)\/[\d.]+ var\(--corn-(font|font-display|font-num|mono)\))$/.test(value)) found.push('font shorthand');
  if (prop === 'font-size' && !/^(inherit|var\(--corn-text-[\w]+\))$/.test(value)) found.push('font-size not a token');
  if (/^border(-(top|bottom)-(left|right)|-(start|end)-(start|end))?-radius$/.test(prop) && LENGTH.test(bare)) found.push('border-radius length');
  if (prop === 'box-shadow' && value !== 'none' && value !== 'inherit' && topLevel(value).some((s) => !s.includes('var(--corn-'))) found.push('box-shadow without tokens');
  if (BORDER_WIDTH_PROPS.test(prop) && (LENGTH.test(bare) || /(?<![\w-])(thin|medium|thick)(?![\w-])/i.test(bare))) found.push('border or outline width');
  if (SPACING_PROPS.test(prop) && LENGTH.test(bare)) found.push('spacing length');
  return found;
}

// explorer.css is one file per piece in explorer/css/ (spec 0011 D8): each is held to the contract on its own, with house.css
const files = [...fs.readdirSync(path.join(EXPLORER, 'css')).filter((f) => f.endsWith('.css')).sort().map((f) => `css/${f}`), ...fs.readdirSync(EXPLORER).filter((f) => f.endsWith('.css') && f !== 'tokens.css')];

describe('no literal outside tokens.css', () => {
  it('has stylesheets to check', () => {
    expect(files).toEqual(expect.arrayContaining(['css/base.css', 'css/page.css', 'css/work.css', 'house.css']));
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

  // A light-only rule outside tokens.css would fight a brand that redefines the tokens: the theme is tokens.css's business
  for (const file of files) {
    it(`${file} names no theme`, () => {
      const css = fs.readFileSync(path.join(EXPLORER, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(css).not.toMatch(/data-theme|prefers-color-scheme/);
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
    // the ways round it: !important, upper case, a space before the bracket, the old functions, a capital name
    expect(caught('color', '#FFF !important')).toBe(true);
    expect(caught('color', 'var(--corn-text) !important')).toBe(false);
    expect(caught('background', '#ABCDEF')).toBe(true);
    expect(caught('background', 'rgb (0, 0, 0)')).toBe(true);
    expect(caught('background', 'RGBA(0, 0, 0, 0.5)')).toBe(true);
    expect(caught('color', 'hsla(0, 0%, 0%, 0.5)')).toBe(true);
    expect(caught('color', 'color(srgb 1 0 0)')).toBe(true);
    expect(caught('color', 'Red')).toBe(true);
    expect(caught('border-left-color', 'RED')).toBe(true);
    expect(caught('-webkit-text-fill-color', '#fff')).toBe(true);
    expect(caught('--my-local', 'tomato')).toBe(true);
    expect(caught('--corn-accent', 'var(--corn-ok)')).toBe(true);
    expect(caught('background', 'linear-gradient(red, var(--corn-ok))')).toBe(true);
    expect(caught('font-size', '1.2REM')).toBe(true);
    expect(caught('font-size', 'larger')).toBe(true);
    expect(caught('border-radius', '4PX')).toBe(true);
    expect(caught('border-top-left-radius', '4px')).toBe(true);
    expect(caught('font-family', 'var(--corn-font-display)')).toBe(false);
    // borders and outlines: widths are tokens
    expect(caught('border-left-width', '3px')).toBe(true);
    expect(caught('border', 'thin solid var(--corn-line)')).toBe(true);
    expect(caught('outline', '2px solid var(--corn-focus)')).toBe(true);
    expect(caught('outline', 'var(--corn-focus-width) solid var(--corn-focus)')).toBe(false);
    expect(caught('border-left', 'calc(var(--corn-border-strong) * 2) solid var(--corn-ok)')).toBe(false);
    expect(caught('outline', 'none')).toBe(false);
    // spacing: steps of the scale, 0, auto, a percentage, calc() over tokens, env()
    expect(caught('padding', '4px 10px')).toBe(true);
    expect(caught('margin-top', '-1px')).toBe(true);
    expect(caught('gap', '0.5rem')).toBe(true);
    expect(caught('padding-block', '2px')).toBe(true);
    expect(caught('padding', 'var(--corn-space-1) var(--corn-space-3)')).toBe(false);
    expect(caught('margin', '0 auto')).toBe(false);
    expect(caught('padding-left', '5%')).toBe(false);
    expect(caught('gap', 'calc(var(--corn-space-1) / 2) var(--corn-space-3)')).toBe(false);
    expect(caught('padding', 'var(--corn-space-5) var(--corn-space-5) calc(var(--corn-space-5) + env(safe-area-inset-bottom, 0px))')).toBe(false);
    expect(caught('margin', 'calc(var(--corn-space-1) * -1)')).toBe(false);
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
  // the docs mark with "(light)" each token tokens.css sets again for the light ground
  const lightMarked = new Set(docs.split('\n').filter((l) => l.startsWith('|') && l.split('|')[2]?.includes('(light)')).flatMap((l) => [...l.split('|')[1].matchAll(/`(--corn-[\w-]+)`/g)].map((m) => m[1])));

  it('lists about fifty tokens in the docs, all with the --corn- prefix', () => {
    expect(documented.length).toBeGreaterThanOrEqual(40);
    for (const t of ['--corn-ground', '--corn-surface-1', '--corn-line', '--corn-shadow', '--corn-shadow-sm', '--corn-shadow-lg', '--corn-glow', '--corn-scrim', '--corn-blur', '--corn-text', '--corn-accent', '--corn-focus', '--corn-focus-width', '--corn-ok', '--corn-added', '--corn-font', '--corn-font-display', '--corn-radius-pill', '--corn-border', '--corn-border-strong', '--corn-space', '--corn-space-1', '--corn-space-6', '--corn-house-line', '--corn-mockup-ground']) expect(documented).toContain(t);
  });

  it('defines every documented token in the dark theme, on :root', () => {
    const have = names(darkBlock);
    expect(documented.filter((t) => !have.has(t))).toEqual([]);
  });

  it('defines in both light blocks exactly the tokens the docs mark (light)', () => {
    for (const [what, block] of [['the system light setting', mediaBlock], ['data-theme="light"', attrBlock]]) {
      expect([...names(block)].sort(), what).toEqual([...lightMarked].sort());
    }
  });

  it('documents every token tokens.css defines, and every one is read by a stylesheet', () => {
    const defined = [...names(darkBlock)];
    expect(defined.filter((t) => !documented.includes(t))).toEqual([]);
    // every stylesheet in explorer/ (sign-in.css too: --corn-text-xl, once the node panel's heading, is now the sign-in pages')
    const sheets = files.map((f) => fs.readFileSync(path.join(EXPLORER, f), 'utf8')).join('\n') + tokensCss;
    // the map's colours (--corn-map-*) are read by script (explorer/map-style.js), not by a stylesheet: the module's own list says which
    const readByScript = new Set([...MAP_COLOR_TOKENS, STROKE_WIDTH_TOKEN, FONT_TOKEN, EDGE_WIDTH_TOKEN, GLOW_TOKEN, LABEL_MIN_TOKEN, GREY_ALPHA_TOKEN]);
    expect(defined.filter((t) => !readByScript.has(t) && !sheets.includes(`var(${t})`))).toEqual([]);
  });

  it('defines the three density tokens (issue #200): a control height, a panel padding and a panel head height, each read by explorer.css', () => {
    const have = names(darkBlock);
    for (const t of ['--corn-control-height', '--corn-panel-pad', '--corn-panel-head-height']) {
      expect(have.has(t), `${t} in :root`).toBe(true);
      expect(documented, `${t} in docs/theming.md`).toContain(t);
      expect(explorerCss(), `${t} read by the explorer's stylesheets`).toContain(`var(${t})`);
    }
    expect(darkBlock).toMatch(/--corn-control-height:\s*32px;/);
    expect(darkBlock).toMatch(/--corn-panel-pad:\s*calc\(var\(--corn-space-5\) \+ var\(--corn-space-1\)\);/);
    // the head is the control and a step of padding, so it follows the phone's density without a rule of its own
    expect(darkBlock).toMatch(/--corn-panel-head-height:\s*calc\(var\(--corn-control-height\) \+ var\(--corn-space-3\)\);/);
    // they are the same on either ground (not marked light), and a phone's 44px control and 16px padding are set after the light blocks
    for (const t of ['--corn-control-height', '--corn-panel-pad', '--corn-panel-head-height']) expect(lightMarked.has(t), t).toBe(false);
    expect(tokensCss).toMatch(/@media \(max-width: 767px\) \{ :root \{ --corn-control-height: 44px; \} \}/);
    expect(tokensCss).toMatch(/@media \(max-width: 639px\) \{ :root \{ --corn-panel-pad: var\(--corn-space-5\); \} \}/);
  });

  it('defines in tokens.css every map token explorer/map-style.js reads, each \`auto\` (the map as it was) but the width and the collision mark', () => {
    const have = names(darkBlock);
    expect(mapTokenNames().filter((t) => !have.has(t))).toEqual([]);
    for (const t of MAP_COLOR_TOKENS) expect(darkBlock, t).toMatch(new RegExp(`${t}:\\s*auto;`));
    expect(darkBlock).toMatch(/--corn-map-collision:\s*var\(--corn-warn\);/);
    for (const t of [FONT_TOKEN, EDGE_WIDTH_TOKEN, GLOW_TOKEN, LABEL_MIN_TOKEN, GREY_ALPHA_TOKEN]) expect(darkBlock, t).toMatch(new RegExp(`${t}:\\s*auto;`));
  });

  it('leaves the map tokens out of the light blocks: auto is right on either ground, and a theme sets its own', () => {
    for (const block of [mediaBlock, attrBlock]) expect([...names(block)].filter((t) => t.startsWith('--corn-map-'))).toEqual([]);
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

describe('the brand stylesheet in docs/theming.md', () => {
  const docs = fs.readFileSync(path.join(CORNFIELD, 'docs/theming.md'), 'utf8');
  const brand = [...docs.matchAll(/```css\n([\s\S]*?)```/g)].map((m) => m[1]).find((b) => b.startsWith('/* brand.css'));
  const tokensCss = fs.readFileSync(path.join(EXPLORER, 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const known = new Set([...tokensCss.matchAll(/(--corn-[\w-]+)\s*:/g)].map((m) => m[1]));
  const css = (brand ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  const mediaAt = css.indexOf('@media (prefers-color-scheme: light)');
  const attrAt = css.indexOf(':root[data-theme="light"] {');
  const map = (text) => new Map([...text.matchAll(/(--corn-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const root = map(css.slice(0, mediaAt));
  const media = map(css.slice(mediaAt, attrAt));
  const attr = map(css.slice(attrAt));
  const lightInTokens = new Set([...tokensCss.slice(tokensCss.indexOf(':root[data-theme="light"] {')).matchAll(/(--corn-[\w-]+)\s*:/g)].map((m) => m[1]));

  it('is there, with cornfield\'s three selectors', () => {
    expect(brand).toBeTruthy();
    expect(mediaAt).toBeGreaterThan(0);
    expect(css).toContain(':root:not([data-theme="dark"]) {');
    expect(attrAt).toBeGreaterThan(mediaAt);
  });

  it('sets only tokens that exist, and reads tokens only through var()', () => {
    for (const t of [...root.keys(), ...media.keys(), ...attr.keys()]) expect(known.has(t), t).toBe(true);
  });

  it('keeps its two light blocks the same', () => {
    expect([...media]).toEqual([...attr]);
  });

  it('sets for the light ground every token it sets that cornfield sets again for light (or cornfield would win there)', () => {
    expect([...root.keys()].filter((t) => lightInTokens.has(t) && !attr.has(t))).toEqual([]);
  });

  it('is the look it says: square, a hard shadow, its own fonts, a red accent', () => {
    for (const r of ['--corn-radius-xs', '--corn-radius-sm', '--corn-radius', '--corn-radius-lg', '--corn-radius-pill']) expect(root.get(r), r).toBe('0');
    for (const m of [root, attr]) expect(m.get('--corn-shadow')).toMatch(/^\d+px \d+px 0 #[0-9a-f]+$/);
    expect(root.get('--corn-font-display')).toMatch(/^"Example Pixel"/);
    expect(root.get('--corn-accent')).toBe('#b91c1c');
  });

  it('keeps its text readable in both themes (4.5:1)', () => {
    const lightTokens = map(tokensCss.slice(tokensCss.indexOf(':root[data-theme="light"] {')));
    const darkTokens = map(tokensCss.slice(0, tokensCss.indexOf('@media (prefers-color-scheme: light)')));
    const themes = { dark: new Map([...darkTokens, ...root]), light: new Map([...darkTokens, ...lightTokens, ...root, ...attr]) };
    for (const [name, t] of Object.entries(themes)) {
      for (const ground of ['--corn-ground', '--corn-surface-1', '--corn-surface-2']) {
        for (const text of ['--corn-text', '--corn-text-2', '--corn-text-3', '--corn-accent-text']) {
          expect(contrast(t.get(text), t.get(ground)), `${name}: ${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const fill of ['--corn-accent', '--corn-accent-hover']) expect(contrast(t.get('--corn-text-on-accent'), t.get(fill)), `${name}: on ${fill}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('every stylesheet closes what it opens', () => {
  /** Brace depth through a stylesheet, comments and quoted strings taken out: how deep it goes, where it ends, and whether it ever closes too many */
  function braces(css) {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(["'])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
    let depth = 0, deepest = 0, lowest = 0;
    for (const ch of text) {
      if (ch === '{') deepest = Math.max(deepest, ++depth);
      else if (ch === '}') lowest = Math.min(lowest, --depth);
    }
    return { end: depth, deepest, lowest };
  }
  const sheets = ['tokens.css', 'house.css', 'sign-in.css', ...fs.readdirSync(path.join(EXPLORER, 'css')).filter((f) => f.endsWith('.css')).sort().map((f) => `css/${f}`)];

  it('catches a lost closing brace', () => {
    expect(braces('@media (max-width: 1px) { .a { color: red; }\n.b { color: blue; }').end).toBe(1);
    expect(braces('.a { content: "}"; } /* } */').end).toBe(0);
    expect(braces('.a { } }').lowest).toBe(-1);
  });

  // A merge that keeps two appended sections can drop the `}` of an @media between them: every rule after it then
  // applies only inside that query, and nothing else fails. This holds the braces.
  for (const sheet of sheets) {
    it(`${sheet}: braces balance, and no block is left open`, () => {
      const b = braces(fs.readFileSync(path.join(EXPLORER, sheet), 'utf8'));
      expect(b.lowest, 'a } with nothing open').toBe(0);
      expect(b.end, 'a { never closed').toBe(0);
    });
  }
});
