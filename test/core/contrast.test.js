/**
 * @vitest-environment node
 *
 * The contrast check of `cornfield validate` (docs/theming.md#the-contrast-check): core/color.js reads a colour in any of its syntaxes,
 * core/contrast.js resolves a theme's custom properties (selectors, media, var() chains) and measures the `--corn-*` pairs in light and dark.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error plain JS modules, no declarations
import { contrast, mixColors, over, parseColor, readColor, toHex } from '../../core/color.js';
// @ts-expect-error plain JS modules, no declarations
import { TOKENS_FILE, UI_PAIRS, checkSheets, checkThemeContrast, contrastPairs, contrastProblems, describeFinding, matchRoot, parseRules, resolveColor, resolveProps, substitute, themesToCheck } from '../../core/contrast.js';
// @ts-expect-error plain JS modules, no declarations
import { DEFAULTS } from '../../core/config.js';
import { CORNFIELD, EXPLORER, SAMPLE } from '../helpers.js';

const tokens = fs.readFileSync(TOKENS_FILE, 'utf8');
const rounded = (c) => readColor(c).map((v, i) => (i < 3 ? Math.round(v) : Math.round(v * 1000) / 1000));
const props = (css, state = { mode: 'dark' }) => resolveProps([css], state);

describe('colours: every syntax', () => {
  it('reads hex in 3, 4, 6 and 8 digits', () => {
    expect(readColor('#fff')).toEqual([255, 255, 255, 1]);
    expect(readColor('#818CF8')).toEqual([129, 140, 248, 1]);
    expect(rounded('#f008')).toEqual([255, 0, 0, 0.533]);
    expect(rounded('#ff000080')).toEqual([255, 0, 0, 0.502]);
  });

  it('reads rgb() and rgba(), with commas or spaces, with / alpha and with percentages', () => {
    expect(readColor('rgb(10, 20, 30)')).toEqual([10, 20, 30, 1]);
    expect(readColor('rgba(10, 20, 30, 0.5)')).toEqual([10, 20, 30, 0.5]);
    expect(readColor('rgb(10 20 30 / 25%)')).toEqual([10, 20, 30, 0.25]);
    expect(readColor('rgb(100% 0% 50%)')).toEqual([255, 0, 127.5, 1]);
    expect(readColor('RGB(300, -4, 0)')).toEqual([255, 0, 0, 1]);
  });

  it('reads hsl() and hsla()', () => {
    expect(rounded('hsl(0, 100%, 50%)')).toEqual([255, 0, 0, 1]);
    expect(rounded('hsl(120deg 100% 25%)')).toEqual([0, 128, 0, 1]);
    expect(rounded('hsla(240, 100%, 50%, 0.4)')).toEqual([0, 0, 255, 0.4]);
    expect(rounded('hsl(-120 100% 50%)')).toEqual([0, 0, 255, 1]);
    expect(rounded('hsl(0 0% 100% / 50%)')).toEqual([255, 255, 255, 0.5]);
  });

  it('reads transparent and the basic names', () => {
    expect(readColor('transparent')).toEqual([0, 0, 0, 0]);
    expect(readColor('White')).toEqual([255, 255, 255, 1]);
    expect(readColor('black')).toEqual([0, 0, 0, 1]);
  });

  it('reads color-mix(in srgb, …): percentages either side, none, nested, and with transparent', () => {
    expect(rounded('color-mix(in srgb, #000 25%, #fff)')).toEqual([191, 191, 191, 1]);
    expect(rounded('color-mix(in srgb, #000, #fff)')).toEqual([128, 128, 128, 1]);
    expect(rounded('color-mix(in srgb, #000, #fff 25%)')).toEqual([64, 64, 64, 1]);
    expect(rounded('color-mix(in srgb, 25% #000, #fff)')).toEqual([191, 191, 191, 1]);
    // transparent is premultiplied: the colour keeps its channels, only its alpha is the share
    expect(rounded('color-mix(in srgb, #4f46e5 20%, transparent)')).toEqual([79, 70, 229, 0.2]);
    expect(rounded('color-mix(in srgb, color-mix(in srgb, #000 50%, #fff) 50%, rgb(255 0 0))')).toEqual([191, 64, 64, 1]);
    // shares that add to less than 100% scale the alpha
    expect(rounded('color-mix(in srgb, #000 20%, #fff 20%)')).toEqual([128, 128, 128, 0.4]);
  });

  it('mixes premultiplied, as CSS Color 5 does (worked by hand)', () => {
    // 25% + 25%: normalised to 50/50, alpha scaled by 0.5. Premultiplied: red (127.5, 0, 0, .5), blue (0, 0, 255, 1);
    // their mean (63.75, 0, 127.5, .75); divided by .75: (85, 0, 170); alpha .75 x .5 = .375
    expect(rounded('color-mix(in srgb, rgba(255, 0, 0, 0.5) 25%, blue 25%)')).toEqual([85, 0, 170, 0.375]);
    // a fully transparent colour gives no colour, only its share of alpha: never a grey
    expect(rounded('color-mix(in srgb, rgb(255 0 0 / 0) 50%, #00f)')).toEqual([0, 0, 255, 0.5]);
    // 60% + 30%: 2/3 black and 1/3 white, at 90% alpha; shares over 100% are normalised and leave the alpha alone
    expect(rounded('color-mix(in srgb, #000 60%, #fff 30%)')).toEqual([85, 85, 85, 0.9]);
    expect(rounded('color-mix(in srgb, #000 90%, #fff 30%)')).toEqual([64, 64, 64, 1]);
    expect(readColor('color-mix(in srgb, #000 0%, #fff 0%)')).toBeNull();
  });

  it('does not read what it cannot: another colour space, calc(), currentcolor, auto, junk', () => {
    for (const c of ['oklch(60% 0.2 30)', 'color-mix(in oklab, #000, #fff)', 'rgb(calc(1 + 2) 0 0)', 'currentcolor', 'auto', 'none', '', 'rgb(1, 2)', 'hsl(0, 100, 50)', 'color-mix(in srgb, #000 120%, #fff)', 'linear-gradient(red, blue)']) {
      expect(readColor(c), c).toBeNull();
    }
    expect(parseColor('oklch(60% 0.2 30)')).toEqual([0, 0, 0, 0]);
  });

  it('composites over an opaque colour and measures WCAG contrast', () => {
    expect(over([255, 255, 255, 0.5], [0, 0, 0, 1])).toEqual([128, 128, 128, 1]);
    expect(toHex([255, 128, 0])).toBe('#ff8000');
    expect(contrast('#000', '#fff')).toBeCloseTo(21, 5);
    expect(contrast('#767676', '#fff')).toBeGreaterThan(4.5);
    expect(contrast('#777777', '#fff')).toBeLessThan(4.5);
    expect(mixColors([0, 0, 0, 1], 1, [255, 255, 255, 1], 1)).toEqual([127.5, 127.5, 127.5, 1]);
  });
});

describe('var() chains, fallbacks and cycles', () => {
  const p = (decls) => new Map(Object.entries(decls));

  it('follows a chain', () => {
    expect(substitute('var(--a)', p({ '--a': 'var(--b)', '--b': 'var(--c)', '--c': '#123456' }))).toBe('#123456');
  });

  it('uses the fallback when a variable is unset, nested fallbacks too, and a fallback with commas', () => {
    expect(substitute('var(--x, #fff)', p({}))).toBe('#fff');
    expect(substitute('var(--x, var(--y, #000))', p({}))).toBe('#000');
    expect(substitute('var(--x, rgb(1, 2, 3))', p({}))).toBe('rgb(1, 2, 3)');
    expect(substitute('var(--x, var(--y))', p({ '--y': 'red' }))).toBe('red');
  });

  it('is invalid with no fallback, and a variable inside a longer value is replaced in place', () => {
    expect(substitute('var(--gone)', p({}))).toBeNull();
    expect(substitute('color-mix(in srgb, var(--a) 40%, var(--b))', p({ '--a': '#000', '--b': '#fff' }))).toBe('color-mix(in srgb, #000 40%, #fff)');
    expect(substitute('somevar(--a) var(--a)', p({ '--a': 'x' }))).toBe('somevar(--a) x');
  });

  it('treats a cycle as unset, so its fallback is used, and otherwise leaves nothing', () => {
    const cyc = p({ '--a': 'var(--b)', '--b': 'var(--a)', '--self': 'var(--self)', '--t': 'var(--a)' });
    expect(substitute('var(--a)', cyc)).toBeNull();
    expect(substitute('var(--a, #abc)', cyc)).toBe('#abc');
    expect(substitute('var(--self, red)', cyc)).toBe('red');
    expect(resolveColor(cyc, '--a')).toEqual({ problem: '--a: a var() cycle, --a → --b → --a' });
    expect(resolveColor(cyc, '--t')).toEqual({ problem: '--t: a var() cycle, --a → --b → --a' });
  });

  it('names the token that has nothing to give, and why', () => {
    const q = p({ '--corn-ok-soft': 'color-mix(in srgb, var(--brand-ok) 15%, transparent)', '--corn-text': 'var(--brand-fg)', '--brand-fg': 'oklch(70% 0.1 200)', '--corn-x': 'calc(1px + 2px)', '--corn-y': 'color-mix(in oklab, #000, #fff)' });
    expect(resolveColor(q, '--corn-ok-soft')).toEqual({ problem: '--corn-ok-soft → --brand-ok is not set' });
    expect(resolveColor(q, '--corn-text').problem).toMatch(/^--corn-text → --brand-fg is "oklch\(70% 0\.1 200\)": oklch\(\) is not a colour cornfield reads \(it reads hex/);
    expect(resolveColor(q, '--corn-x').problem).toMatch(/^--corn-x is "calc\(1px \+ 2px\)": calc\(\) is not a colour cornfield reads/);
    expect(resolveColor(q, '--corn-y').problem).toMatch(/^--corn-y is "color-mix\(in oklab.*": that is a color-mix\(\) cornfield cannot work out \(it mixes in srgb only/);
  });

  it('never hangs or throws on hostile values: deep fallbacks, deep chains, exponential growth, deep color-mix()', () => {
    const started = Date.now();
    const deepFallback = `${'var(--x, '.repeat(200)}#fff${')'.repeat(200)}`;
    expect(resolveColor(p({}), deepFallback)).toEqual({ problem: expect.stringMatching(/var\(\) is followed more than 32 deep/) });
    const huge = `${'var(--x, '.repeat(25000)}#fff${')'.repeat(25000)}`;
    expect(resolveColor(p({ '--t': huge }), '--t')).toEqual({ problem: '--t: a value is longer than 2048 characters' });
    const chain = p(Object.fromEntries([...Array.from({ length: 5000 }, (_, i) => [`--c${i}`, `var(--c${i + 1})`]), ['--c5000', '#fff']]));
    expect(resolveColor(chain, '--c0').problem).toMatch(/^--c0: var\(\) is followed more than 32 deep/);
    // a billion laughs: each level doubles the one below
    const laughs = p(Object.fromEntries([['--l0', '#fff'], ...Array.from({ length: 30 }, (_, i) => [`--l${i + 1}`, `var(--l${i}) var(--l${i})`])]));
    expect(resolveColor(laughs, '--l30').problem).toMatch(/^--l30: a value grows past 2048 characters/);
    const wide = p({ '--w': Array.from({ length: 150 }, () => 'var(--u, #000)').join(' '), '--t': Array.from({ length: 150 }, () => 'var(--w, #000)').join(' ') });
    expect(() => resolveColor(wide, '--t')).not.toThrow();
    expect(readColor(`${'color-mix(in srgb, '.repeat(9)}#fff${', #000)'.repeat(9)}`)).toBeNull();
    expect(readColor(`${'color-mix(in srgb, '.repeat(8)}#fff${', #000)'.repeat(8)}`)).not.toBeNull();
    expect(readColor(`${'color-mix(in srgb, '.repeat(20000)}#fff${', #000)'.repeat(20000)}`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('says why a token is not a colour, and never throws on odd input', () => {
    const q = p({ '--auto': 'auto', '--ok': '#fff', '--calc': 'calc(1px + 2px)' });
    expect(resolveColor(q, '--auto')).toEqual({ problem: expect.stringMatching(/^--auto is "auto": that is not a colour cornfield reads/) });
    expect(resolveColor(q, '--nope')).toEqual({ problem: '--nope is not set' });
    expect(resolveColor(q, '--ok')).toEqual([255, 255, 255, 1]);
    expect(resolveColor(q, 'color-mix(in srgb, var(--ok) 50%, #000)')).toEqual([127.5, 127.5, 127.5, 1]);
    for (const v of ['var(', 'var(--a', 'var()', 'var(,)', 'var(--a,', ')))']) expect(() => resolveColor(q, v), v).not.toThrow();
  });
});

describe('which rules apply', () => {
  const sheet = `
    :root { --c: dark; --only-root: 1; }
    @media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { --c: light-media; } }
    :root[data-theme="light"] { --c: light-attr; }
    :root[data-theme-name="night"] { --n: night; }
    :root[data-theme-name="night"][data-theme="light"] { --n: night-light; }
    @font-face { font-family: X; --nope: 1; }
    .panel { --class: 1; }
    :root .panel { --desc: 1; }
    @media (min-width: 600px) { :root { --wide: 1; } }
    @media (prefers-color-scheme: dark) { :root { --scheme-dark: 1; } }
  `;

  it('applies the dark block in dark and both light blocks in light', () => {
    expect(props(sheet, { mode: 'dark' }).get('--c')).toBe('dark');
    expect(props(sheet, { mode: 'light' }).get('--c')).toBe('light-attr');
  });

  it('applies a named theme only when its name is on, and a more specific one over a less', () => {
    expect(props(sheet, { mode: 'dark' }).has('--n')).toBe(false);
    expect(props(sheet, { mode: 'dark', name: 'night' }).get('--n')).toBe('night');
    expect(props(sheet, { mode: 'light', name: 'night' }).get('--n')).toBe('night-light');
    expect(props(sheet, { mode: 'dark', name: 'day' }).has('--n')).toBe(false);
  });

  it('ignores what is not the root\'s: classes, descendants, other at-rules and other media', () => {
    const p = props(sheet, { mode: 'dark' });
    for (const k of ['--nope', '--class', '--desc', '--wide']) expect(p.has(k), k).toBe(false);
    expect(p.get('--scheme-dark')).toBe('1');
    expect(props(sheet, { mode: 'light' }).has('--scheme-dark')).toBe(false);
  });

  it('lets a later rule win a tie, a more specific one win over a later one, and !important win over both', () => {
    expect(props(':root{--a:1} :root{--a:2}').get('--a')).toBe('2');
    expect(props(':root[data-theme="dark"]{--a:1} :root{--a:2}').get('--a')).toBe('1');
    expect(props(':root[data-theme="dark"]{--a:1} :root{--a:2 !important}').get('--a')).toBe('2');
    expect(props('html{--a:1} :root{--a:2}').get('--a')).toBe('2');
  });

  it('reads selector lists, comments, strings with braces and declarations around nested blocks', () => {
    expect(props('/* :root{--a:x} */ html, :root[data-theme="dark"] { --a: 1; --s: "a;b}"; }').get('--a')).toBe('1');
    expect(props(':root { --a: 1; .nested { --b: 2 } --c: 3 }').get('--c')).toBe('3');
    expect(props('@import url(x.css); :root { --a: 1 }').get('--a')).toBe('1');
    // an unclosed block runs to the end of the file, as in a browser; an unknown media query never applies
    expect(props('@media (min-resolution: 2dppx) { :root { --x: 1 } ').has('--x')).toBe(false);
    expect(parseRules('@media (a) { :root { --x: 1 } ')).toHaveLength(1);
  });

  it('matches the compounds cornfield documents', () => {
    const attrs = { 'data-theme': 'light', 'data-theme-name': 'x' };
    expect(matchRoot(':root', attrs)).toBeGreaterThan(0);
    expect(matchRoot(':root:not([data-theme="dark"])', attrs)).toBeGreaterThan(matchRoot(':root', attrs));
    expect(matchRoot(':root:not([data-theme="light"])', attrs)).toBeNull();
    expect(matchRoot('[data-theme-name=x]', attrs)).not.toBeNull();
    expect(matchRoot('[data-theme-name="y"]', attrs)).toBeNull();
    expect(matchRoot('body', attrs)).toBeNull();
    expect(matchRoot(':root > body', attrs)).toBeNull();
    expect(matchRoot(':root:hover', attrs)).toBeNull();
  });

  it('never throws on a hostile selector: :not() nested deep is not read, a long selector list is fine', () => {
    const deep = `:root${':not('.repeat(20000)}[x]${')'.repeat(20000)}`;
    expect(() => props(`${deep} { --a: 1 }`)).not.toThrow();
    expect(props(`${deep} { --a: 1 }`).has('--a')).toBe(false);
    // nested within the limit, it is read: not(not(dark)) is dark
    expect(matchRoot(':root:not(:not([data-theme="dark"]))', { 'data-theme': 'dark' })).not.toBeNull();
    expect(props(`${':root,'.repeat(40000)}:root { --a: 1 }`).get('--a')).toBe('1');
  });
});

describe('a brand theme resolves as a browser would', () => {
  const on = (brand, state) => resolveProps([tokens, brand], state);

  it('a :root override after tokens.css wins in dark, and loses in light to cornfield\'s more specific light blocks', () => {
    const brand = ':root { --corn-text: #eeeeee; --corn-radius: 0; }';
    expect(on(brand, { mode: 'dark' }).get('--corn-text')).toBe('#eeeeee');
    expect(on(brand, { mode: 'light' }).get('--corn-text')).toBe('#0f172a');
    // a token cornfield does not set for light is the brand's in both
    expect(on(brand, { mode: 'light' }).get('--corn-radius')).toBe('0');
  });

  it('a [data-theme="dark"] block applies in dark only, whatever the system says', () => {
    const brand = ':root[data-theme="dark"] { --corn-ground: #101010; }';
    expect(on(brand, { mode: 'dark' }).get('--corn-ground')).toBe('#101010');
    expect(on(brand, { mode: 'dark', system: 'light' }).get('--corn-ground')).toBe('#101010');
    expect(on(brand, { mode: 'light' }).get('--corn-ground')).toBe('#f4f6fa');
  });

  it('@media (prefers-color-scheme: dark) follows the system, not the viewer\'s pick', () => {
    const brand = '@media (prefers-color-scheme: dark) { :root { --corn-ground: #101010; } }';
    expect(on(brand, { mode: 'dark' }).get('--corn-ground')).toBe('#101010');
    // the viewer picked dark on a light system: the media block is off, cornfield's dark :root stands
    expect(on(brand, { mode: 'dark', system: 'light' }).get('--corn-ground')).toBe('#090d16');
    // the viewer picked light on a dark system: the block is on, but cornfield's [data-theme="light"] is more specific
    expect(on(brand, { mode: 'light', system: 'dark' }).get('--corn-ground')).toBe('#f4f6fa');
  });

  it('a named theme with its own light and dark blocks', () => {
    const brand = `
      :root[data-theme-name="night"] { --corn-ground: #000010; }
      :root[data-theme-name="night"][data-theme="light"] { --corn-ground: #fffff0; }
      @media (prefers-color-scheme: light) { :root[data-theme-name="night"]:not([data-theme="dark"]) { --corn-ground: #fffff1; } }`;
    expect(on(brand, { mode: 'dark', name: 'night' }).get('--corn-ground')).toBe('#000010');
    // light on a light system: both light blocks match at the same specificity (0,3,0 against 0,3,0); the later wins
    expect(on(brand, { mode: 'light', name: 'night' }).get('--corn-ground')).toBe('#fffff1');
    expect(on(brand, { mode: 'light', system: 'dark', name: 'night' }).get('--corn-ground')).toBe('#fffff0');
    expect(on(brand, { mode: 'dark', name: 'day' }).get('--corn-ground')).toBe('#090d16');
  });

  it('catches a brand that writes light on :root and dark only under the system setting, when a viewer picks dark on a light system', () => {
    const brand = `
      :root { --corn-ground: #ffffff; --corn-text: #111111; --corn-surface-1: #ffffff; --corn-surface-2: #ffffff; --corn-surface-3: #ffffff; }
      @media (prefers-color-scheme: dark) { :root { --corn-ground: #111111; --corn-text: #eeeeee; --corn-surface-1: #111111; --corn-surface-2: #111111; --corn-surface-3: #111111; } }`;
    const { fails } = contrastProblems([{ theme: 'standard', sheets: [tokens, brand] }]);
    // dark on a dark system is fine; dark picked on a light system puts cornfield's dark text-2 on the brand's white
    const f = fails.find((x) => x.mode === 'dark' && x.fg === '--corn-text-2' && x.bg === '--corn-surface-1');
    expect(f).toMatchObject({ system: 'light', bgValue: '#ffffff' });
    expect(fails.filter((x) => x.mode === 'dark' && !x.system)).toEqual([]);
    expect(describeFinding(f)).toMatch(/^standard theme \(dark, on a system set to light\): --corn-text-2 /);
  });
});

describe('the diff marks and dimmed labels on the map (F19, F23)', () => {
  const MAP = ['--corn-map-added', '--corn-map-changed', '--corn-map-removed', '--corn-map-edit', '--corn-map-label'];
  const run = (...extra) => checkSheets([{ theme: 'standard', sheets: [tokens, ...extra] }]).filter((f) => MAP.includes(f.fg));
  const dot = (css) => checkSheets([{ theme: 'standard', sheets: [tokens, css] }]).filter((f) => /^--corn-(added|changed|removed|edit)$/.test(f.fg));

  it('holds every mark and the dimmed label at 3:1 in light and dark by default, over the darkest and lightest ground', () => {
    const found = run();
    expect(found).toHaveLength(10);
    for (const f of found) expect(f.ratio, describeFinding(f)).toBeGreaterThanOrEqual(3);
    expect(found.some((f) => f.groundImage)).toBe(true); // the worst case is a glow, not the plain ground
  });

  it('holds the dots of the four marks (--corn-added|changed|removed|edit) at 3:1 on the ground too', () => {
    const found = dot('');
    expect(found).toHaveLength(8);
    for (const f of found) expect(f.ratio, describeFinding(f)).toBeGreaterThanOrEqual(3);
  });

  it('measures a mark at the opacity it is drawn at: a faded removed colour fails with a plain message', () => {
    const faint = ':root, :root[data-theme="light"], :root[data-theme="dark"] { --corn-map-removed: #f3a6a6; }';
    const fails = run(faint).filter((f) => f.ratio < f.min);
    expect(fails.map((f) => f.fg)).toContain('--corn-map-removed');
    const msg = describeFinding(fails.find((f) => f.mode === 'light' && f.fg === '--corn-map-removed'));
    expect(msg).toMatch(/^standard theme \(light\): --corn-map-removed \(the removed mark on the map, drawn at 77% opacity\) \(#[0-9a-f]{6}\) on --corn-ground.* is \d\.\d\d:1, below 3:1/);
  });

  it('a solid colour that would pass is still too faint once it fades, and a deeper one passes', () => {
    const ok = ':root, :root[data-theme="light"] { --corn-map-removed: #c00000; }';
    expect(run(ok).filter((f) => f.mode === 'light' && f.fg === '--corn-map-removed' && f.ratio < f.min)).toEqual([]);
  });

  it('reads a theme\'s own label colour for the dimmed label, and says so when a colour cannot be read', () => {
    const pale = ':root, :root[data-theme="light"] { --corn-map-label: #cccccc; }';
    expect(run(pale).some((f) => f.mode === 'light' && f.fg === '--corn-map-label' && f.ratio < f.min)).toBe(true);
    const odd = ':root { --corn-map-edit: oklch(60% 0.2 300); }';
    const bad = run(odd).find((f) => f.fg === '--corn-map-edit' && f.problem);
    expect(bad.problem).toMatch(/oklch\(\) is not a colour cornfield reads/);
  });
});

describe('the default tokens', () => {
  const themes = [{ theme: 'standard', sheets: [tokens] }];

  it('resolve every pair, in light and dark, and every one passes, over the ground and its image', () => {
    const all = checkSheets(themes);
    expect(all.length).toBe((contrastPairs().length + 5) * 2); // + the map's four diff marks and a dimmed label (F19, F23)
    const { fails, unresolved } = contrastProblems(themes);
    expect(fails.map(describeFinding)).toEqual([]);
    expect(unresolved.map(describeFinding)).toEqual([]);
  });

  it('are measured against the ground the translucent surfaces sit on', () => {
    const flat = ':root, :root[data-theme="light"] { --corn-ground-image: none; }';
    const f = checkSheets([{ theme: 'standard', sheets: [tokens, flat] }]).find((x) => x.mode === 'dark' && x.fg === '--corn-text' && x.bg === '--corn-surface-1');
    // rgba(26, 34, 52, 0.72) over #090d16
    expect(f.bgValue).toBe(toHex(over(parseColor('rgba(26, 34, 52, 0.72)'), parseColor('#090d16'))));
    expect(f.groundImage).toBeUndefined();
    expect(f.ratio).toBeGreaterThan(10);
  });

  it('and over the ground image: a surface over the brightest stop of each glow, in paint order (ground, image, surface, text)', () => {
    const f = checkSheets(themes).find((x) => x.mode === 'dark' && x.fg === '--corn-text-3' && x.bg === '--corn-surface-3');
    // the first layer of the dark --corn-ground-image peaks at rgba(66, 153, 225, 0.28)
    const glow = over(parseColor('rgba(66, 153, 225, 0.28)'), parseColor('#090d16'));
    expect(f.groundImage).toBe(true);
    expect(f.bgValue).toBe(toHex(over(parseColor('rgba(51, 65, 85, 0.8)'), glow)));
    expect(f.ratio).toBeCloseTo(contrast(f.fgValue, f.bgValue), 6);
    expect(f.ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('put a tint inside the panel it is drawn in', () => {
    const flat = ':root, :root[data-theme="light"] { --corn-ground-image: none; }';
    const f = checkSheets([{ theme: 'standard', sheets: [tokens, flat] }]).find((x) => x.mode === 'dark' && x.fg === '--corn-ok' && x.bg === '--corn-ok-soft');
    const panel = over(parseColor('rgba(26, 34, 52, 0.72)'), parseColor('#090d16'));
    expect(f.bgValue).toBe(toHex(over(readColor('color-mix(in srgb, #34d399 15%, transparent)'), panel)));
  });

  it('are checked by every validate, with or without a theme', () => {
    expect(themesToCheck({ root: SAMPLE, theme: { ...DEFAULTS.theme } })).toEqual([{ theme: 'standard', sheets: [tokens] }]);
    expect(checkThemeContrast({ root: SAMPLE, theme: { ...DEFAULTS.theme } })).toEqual({ errors: [], warnings: [] });
  });
});

describe('a brand theme that fails', () => {
  // dark: text-3 nearly the surface; light: the accent-text washed out; both: white text on a pale accent
  const BRAND = `
    :root { --corn-text-3: #4a5266; --corn-accent: #a5b4fc; --corn-accent-hover: #c7d2fe; }
    :root[data-theme="light"] { --corn-accent-text: #a5b4fc; --corn-ground: #fffaf0; }
  `;
  const { fails } = contrastProblems([{ theme: 'standard', sheets: [tokens, BRAND] }]);
  const line = (mode, fg, bg) => fails.find((f) => f.mode === mode && f.fg === fg && f.bg === bg);

  it('is reported in both modes, with the two tokens, the colours and the ratio', () => {
    const dark = line('dark', '--corn-text-3', '--corn-ground');
    expect(dark).toBeTruthy();
    expect(dark.ratio).toBeLessThan(4.5);
    expect(describeFinding(dark)).toMatch(/^standard theme \(dark\): --corn-text-3 \(#4a5266\) on --corn-ground over the ground image \(#[0-9a-f]{6}\) is \d\.\d\d:1, below 4\.5:1/);
    const light = line('light', '--corn-accent-text', '--corn-ground');
    expect(light).toBeTruthy();
    expect(describeFinding(light)).toMatch(/^standard theme \(light\): --corn-accent-text \(#a5b4fc\) on --corn-ground( over the ground image)? \(#[0-9a-f]{6}\) is \d\.\d\d:1/);
    expect(fails.some((f) => f.mode === 'light' && f.fg === '--corn-text-on-accent' && f.bg === '--corn-accent')).toBe(true);
    expect(fails.some((f) => f.mode === 'dark' && f.fg === '--corn-text-on-accent' && f.bg === '--corn-accent')).toBe(true);
  });

  it('reads the ratio the way WCAG does', () => {
    const f = line('dark', '--corn-text-3', '--corn-ground');
    expect(f.ratio).toBeCloseTo(contrast(f.fgValue, f.bgValue), 6);
    expect(f.ratio).toBeLessThan(contrast('#4a5266', '#090d16'));
    expect(f.min).toBe(4.5);
  });

  it('does not report what the brand leaves alone', () => {
    expect(fails.some((f) => f.fg === '--corn-text' && f.mode === 'dark')).toBe(false);
  });

  it('holds the focus ring, and every border or mark that alone shows a state, to 3:1 (or to 4.5:1 where it is also text)', () => {
    const pairs = contrastPairs();
    for (const [fg, bg] of UI_PAIRS) expect(pairs.find((x) => x.fg === fg && x.bg === bg)?.min, `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
    // the line is a divider, never the only sign of a state
    expect(pairs.some((x) => x.fg === '--corn-line' || x.fg === '--corn-line-soft')).toBe(false);
    const r = contrastProblems([{ theme: 'standard', sheets: [tokens, ':root{--corn-focus:#1c2333}'] }]);
    const f = r.fails.find((x) => x.fg === '--corn-focus' && x.mode === 'dark' && x.bg === '--corn-ground');
    expect(f.min).toBe(3);
    expect(describeFinding(f)).toMatch(/below 3:1 \(the UI minimum\)/);
  });

  it('reports a token it cannot work out as unresolved, not as a failure; an unknown token is ignored', () => {
    const r = contrastProblems([{ theme: 'standard', sheets: [tokens, ':root{--corn-text-2: oklch(70% 0.1 200); --corn-map-fill: auto; --corn-map-x: var(--corn-map-fill)}'] }]);
    expect(r.fails).toEqual([]);
    expect(r.unresolved.length).toBeGreaterThan(0);
    expect(r.unresolved.every((f) => f.fg === '--corn-text-2' || f.fg === '--corn-run-stopped')).toBe(true);
    expect(describeFinding(r.unresolved[0])).toMatch(/could not be checked: --corn-text-2 is "oklch\(70% 0\.1 200\)": oklch\(\) is not a colour cornfield reads/);
  });
});

describe('named themes', () => {
  const NIGHT = ':root[data-theme-name="night"] { --corn-text: #3a3a4a; }';
  const result = contrastProblems([
    { theme: 'standard', sheets: [tokens] },
    { theme: 'night', name: 'night', sheets: [tokens, NIGHT] },
    { theme: 'day', name: 'day', sheets: [tokens, NIGHT] }, // a name the scoped block does not match
  ]);

  it('are checked on their own: the failure is the named theme\'s, not the standard theme\'s', () => {
    expect(result.fails.length).toBeGreaterThan(0);
    expect(new Set(result.fails.map((f) => f.theme))).toEqual(new Set(['night']));
    // the dark text fails on the dark ground; in light the theme\'s own light value (:root[data-theme="light"]) wins on specificity ties by order
    expect(result.fails.some((f) => f.mode === 'dark' && f.fg === '--corn-text')).toBe(true);
    expect(describeFinding(result.fails[0])).toMatch(/^named theme "night" \(/);
  });
});

describe('the docs\' example brand stylesheet', () => {
  const docs = fs.readFileSync(path.join(CORNFIELD, 'docs/theming.md'), 'utf8');
  const brand = [...docs.matchAll(/```css\n([\s\S]*?)```/g)].map((m) => m[1]).find((b) => b.startsWith('/* brand.css'));

  it('passes, in light and dark', () => {
    expect(brand).toBeTruthy();
    const themes = [{ theme: 'standard', sheets: [tokens, brand] }];
    expect(contrastProblems(themes).fails.map(describeFinding)).toEqual([]);
    expect(contrastProblems(themes).unresolved.map(describeFinding)).toEqual([]);
  });
});

describe('the two spots that were under AA', () => {
  const css = fs.readFileSync(path.join(EXPLORER, 'explorer.css'), 'utf8');
  const ruleFor = (selector) => {
    const out = {};
    for (const rule of parseRulesOf(css)) if (rule.selector.split(',').map((s) => s.trim()).includes(selector)) Object.assign(out, rule.decls);
    return out;
  };
  /** Ordinary rules (not only custom properties) of a stylesheet */
  function parseRulesOf(text) {
    const out = [];
    for (const [, sel, body] of text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      out.push({ selector: sel.trim(), decls: Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)].map((m) => [m[1], m[2].trim()])) });
    }
    return out;
  }
  const state = (mode) => resolveProps([tokens], { mode });
  const solid = (p, token, on) => over(resolveColor(p, token), on);

  it('keeps opacity off the text of an off layer toggle row and of the dimmed Layers chip', () => {
    for (const sel of ['.hx-toggle-row.is-off', '.hx-layers-chip--dim', '.hx-toggle-row.is-off .hx-toggle-name', '.hx-toggle-row.is-off .hx-count', '.hx-toggle-row.is-off .hx-tick']) {
      expect(ruleFor(sel).opacity, sel).toBeUndefined();
    }
    // the dimmed look is the colour, and the dot
    expect(ruleFor('.hx-toggle-row.is-off').color).toBe('var(--corn-text-3)');
    expect(ruleFor('.hx-layers-chip--dim').color).toBe('var(--corn-text-3)');
    expect(ruleFor('.hx-toggle-row.is-off .hx-dot').opacity).toBeDefined();
  });

  it('reads at least 4.5:1 for the off row\'s text on its fill and for the dimmed Layers chip, in both themes', () => {
    for (const mode of ['light', 'dark']) {
      const p = state(mode);
      const ground = solid(p, '--corn-ground', [0, 0, 0, 1]);
      const panel = solid(p, '--corn-surface-1', ground);
      // the off row: the ground at 40% over the menu panel
      const off = over(mixColors(resolveColor(p, '--corn-ground'), 0.4, [0, 0, 0, 0], 0.6), panel);
      const text3 = resolveColor(p, '--corn-text-3');
      expect(contrast(toHex(text3), toHex(off)), `${mode}: off row`).toBeGreaterThanOrEqual(4.5);
      const surface2 = solid(p, '--corn-surface-2', ground);
      expect(contrast(toHex(text3), toHex(surface2)), `${mode}: dimmed chip`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(toHex(text3), toHex(panel)), `${mode}: dimmed chip on a phone's map`).toBeGreaterThanOrEqual(4.5);
      // its hover reads --corn-text-2 on --corn-surface-2 (and the base button's hover, surface-3, in .hx-btn:hover)
      expect(contrast(toHex(resolveColor(p, '--corn-text-2')), toHex(solid(p, '--corn-surface-3', ground)))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('gives the data-flow note a text token and a tint token that pass in both themes', () => {
    const note = ruleFor('.hx-note');
    expect(note.color).toBe('var(--corn-hue-orange-text)');
    expect(note.background).toBe('var(--corn-hue-orange-soft)');
    for (const mode of ['light', 'dark']) {
      const p = state(mode);
      const ground = solid(p, '--corn-ground', [0, 0, 0, 1]);
      for (const base of [ground, solid(p, '--corn-surface-1', ground)]) {
        const tint = over(resolveColor(p, '--corn-hue-orange-soft'), base);
        const text = over(resolveColor(p, '--corn-hue-orange-text'), tint);
        expect(contrast(toHex(text), toHex(tint)), `${mode}: note`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // it is in the checked list, so a brand's own orange is held to it too
    expect(contrastPairs().some((x) => x.fg === '--corn-hue-orange-text' && x.bg === '--corn-hue-orange-soft')).toBe(true);
  });
});

describe('the pair list matches what explorer.css paints', () => {
  const pairs = new Set(contrastPairs().map((p) => `${p.fg} | ${p.bg}`));
  const norm = (v) => { const m = /^var\((--[\w-]+)\)$/.exec(v.trim()); return m ? m[1] : v.trim(); };
  /** Every rule of explorer.css and house.css, comments dropped, declarations as a map (the last of a property wins) */
  const rules = ['explorer.css', 'house.css'].flatMap((f) => [...fs.readFileSync(path.join(EXPLORER, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, sel, body]) => ({ sel: sel.trim().replace(/\s+/g, ' '), decl: Object.fromEntries([...body.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)].map((m) => [m[1], m[2].trim()])) })));
  // Rules whose colour is not text on the background of the same rule, and why each is still held
  const ELSEWHERE = {
    '.hx-chip': 'its fills are the modifiers below it: --corn-text-on-accent on --corn-accent, --corn-ground on the status fills',
    '.hx-chip--danger, .hx-chip--success, .hx-chip--warning': 'the status fills, in SOLID_FILLS',
    '.hx-swatch-when': 'a legend swatch: the colour is its fill (currentColor), not text',
    '.hx-swatch-when--run': 'a legend swatch',
    '.hx-swatch-when--deploy': 'a legend swatch',
    '.hx-swatch-when--renew': 'a legend swatch',
    '.hx-house-plan .floor-map__label, .hx-house-plan .hx-plain-room text': 'a room\'s name, on the room\'s own lime tint (listed)',
  };

  it('holds every text colour explorer.css sets with a background to that background, and every other one to the ground and a surface', () => {
    const holes = [];
    for (const { sel, decl } of rules) {
      const fg = decl.color ?? (/label|text\b/.test(sel) ? decl.fill : undefined);
      if (!fg || /^(inherit|transparent|currentColor)$/i.test(fg) || fg.includes('--glyph') || ELSEWHERE[sel]) continue;
      const F = norm(fg);
      let bg = decl['background-color'] ?? decl.background;
      if (bg === undefined || /^(none|transparent)$/i.test(bg)) {
        // text on whatever it sits in: the ground, the panel or a control
        if (!['--corn-ground', '--corn-surface-1', '--corn-surface-2'].some((b) => pairs.has(`${F} | ${b}`))) holes.push(`${sel}: ${F}`);
        continue;
      }
      // the ground mixed toward transparent lies between the ground and the panel beneath, both held
      if (/^color-mix\(in srgb, var\(--corn-ground\) \d+%, transparent\)/.test(bg)) bg = 'var(--corn-ground)';
      if (!pairs.has(`${F} | ${norm(bg)}`)) holes.push(`${sel}: ${F} on ${norm(bg)}`);
    }
    expect(holes).toEqual([]);
  });

  it('draws every focus indicator in a colour held to the UI minimum', () => {
    const ui = new Set(UI_PAIRS.map(([fg]) => fg));
    for (const { sel, decl } of rules.filter((r) => /:focus/.test(r.sel))) {
      for (const prop of ['outline', 'outline-color', 'border-color']) {
        const v = decl[prop];
        if (!v || /^none$/.test(v)) continue;
        const token = /var\((--corn-(?!focus-width)[\w-]+)\)\s*$/.exec(v)?.[1];
        expect(token && ui.has(token), `${sel} { ${prop}: ${v} }`).toBe(true);
      }
    }
  });
});

describe('cornfield validate: the contrast check', () => {
  let root;
  const CLI = path.join(CORNFIELD, 'cli', 'cornfield.js');
  const validate = () => spawnSync(process.execPath, [CLI, 'validate', '--repo', root], { encoding: 'utf8', timeout: 60_000 });
  const withTheme = (t) => {
    const base = fs.readFileSync(path.join(SAMPLE, 'cornfield.config.js'), 'utf8');
    fs.writeFileSync(path.join(root, 'cornfield.config.js'), base.replace('worktrees: \'.worktrees\',', `worktrees: '.worktrees',\n  theme: ${JSON.stringify(t)},`));
  };
  const GOOD = ':root { --corn-radius: 0; }';
  const BAD = ':root { --corn-text-3: #3b4358; }';
  const NIGHT_BAD = ':root[data-theme-name="night"] { --corn-text-2: #3b4358; }';
  beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-contrast-')); fs.cpSync(SAMPLE, root, { recursive: true }); });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('passes a good theme, and a repo with none', () => {
    fs.writeFileSync(path.join(root, 'theme.css'), GOOD);
    withTheme({ css: './theme.css' });
    expect(validate().status).toBe(0);
  });

  it('fails a theme under AA, naming the mode, the tokens and the ratio', () => {
    fs.writeFileSync(path.join(root, 'theme.css'), BAD);
    withTheme({ css: './theme.css' });
    const r = validate();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/theme contrast: standard theme \(dark\): --corn-text-3 \(#3b4358\) on --corn-ground over the ground image \(#[0-9a-f]{6}\) is \d\.\d\d:1, below 4\.5:1/);
  });

  it('downgrades to warnings with theme.contrast: "warn"', () => {
    withTheme({ css: './theme.css', contrast: 'warn' });
    const r = validate();
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/warning: theme contrast: standard theme \(dark\): --corn-text-3/);
    withTheme({ css: './theme.css', contrast: 'error' });
    expect(validate().status).toBe(1);
  });

  it('checks each named theme separately and names it', () => {
    fs.writeFileSync(path.join(root, 'theme.css'), GOOD);
    fs.writeFileSync(path.join(root, 'night.css'), NIGHT_BAD);
    fs.writeFileSync(path.join(root, 'day.css'), GOOD);
    withTheme({ css: './theme.css', names: { night: './night.css', day: './day.css' }, default: 'day' });
    const r = validate();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/named theme "night" \((light|dark)\): --corn-text-2 /);
    expect(r.stderr).not.toMatch(/named theme "day"/);
    expect(r.stderr).not.toMatch(/standard theme/);
  });

  it('checks cornfield\'s own tokens for a repo with no theme, and does not read a theme file validate refuses', () => {
    expect(themesToCheck({ root, theme: { ...DEFAULTS.theme } })).toHaveLength(1);
    expect(checkThemeContrast({ root, theme: { ...DEFAULTS.theme, css: './gone.css' } })).toEqual({ errors: [], warnings: [] });
    // over the size cap, or not CSS: validateThemeFiles reports it, and the contrast check leaves it alone
    fs.writeFileSync(path.join(root, 'big.css'), `:root { --corn-text: #000; }\n/* ${'x'.repeat(300 * 1024)} */`);
    expect(themesToCheck({ root, theme: { ...DEFAULTS.theme, css: './big.css' } })).toBeNull();
    fs.writeFileSync(path.join(root, 'html.css'), '<script>alert(1)</script> :root { --corn-text: #000; }');
    expect(themesToCheck({ root, theme: { ...DEFAULTS.theme, css: './html.css' } })).toBeNull();
    fs.writeFileSync(path.join(root, 'night.css'), ':root{--corn-text:#000}' + ' '.repeat(300 * 1024));
    expect(themesToCheck({ root, theme: { ...DEFAULTS.theme, names: { night: './night.css' } } })).toHaveLength(1);
  });
});
