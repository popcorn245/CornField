/**
 * @module core/contrast
 *
 * The theme's contrast check, for `cornfield validate` (docs/theming.md#the-contrast-check). A tiny CSS custom-property resolver
 * and the list of `--corn-*` pairs that are read against each other. No dependencies, no browser: it reads stylesheet text.
 *
 *   resolveProps(sheets, state)          the custom properties in force for a page: `{ mode, system?, name? }` over `[css, …]` in load order
 *   expand(value, props)                 a value with its var()s replaced, or { problem } naming the property and why (capped: never a hang)
 *   resolveColor(props, name | value)    a token (or a value) as [r, g, b, a], or { problem } when it cannot be worked out
 *   contrastPairs()                      every pair explorer.css paints, text at 4.5:1 and the state-bearing UI at 3:1
 *   contrastProblems(themes)             every pair below WCAG AA, for light and dark, on either system setting, over the ground and its image
 *   themesToCheck(config)                what a repo's check reads: tokens.css, then `theme.css`, then each `theme.names` file
 *   checkThemeContrast(config)           the check for `cornfield validate`, always run (cornfield's own tokens when there is no theme)
 *
 * What is read of a stylesheet: custom-property declarations in `:root`, `html`, `[data-theme="…"]`, `[data-theme-name="…"]` rules
 * (with `:not()`), at the top level and inside `@media (prefers-color-scheme: light|dark)`. A rule for anything else (a class, a
 * descendant) is not the root's and is ignored; so are other at-rules. Specificity, `!important` and source order decide, as in a browser.
 * `var(--x, fallback)` chains are followed (a cycle is as good as unset, so its fallback is used).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_MIX_DEPTH, readColor, over, toHex, luminance, ratio, splitTop } from './color.js';
import { MAX_THEME_BYTES, cssProblems, withoutComments } from './theme.js';
import { NODE_THEMES } from './schema.js';
import { LAYER_KEY_RE, MAX_KEY, parseKindToken } from './layers.js';
import { DIFF_MARK_COLORS, DIFF_LABEL_ALPHA, markOpacity } from '../explorer/diff-marks.js';
import { lightColor } from '../explorer/theme-model.js';

/** WCAG 2.1 AA: text, and large text and user-interface parts */
export const MIN_TEXT = 4.5;
export const MIN_UI = 3;
export const CONTRAST_MODES = Object.freeze(['error', 'warn']);

/** cornfield's own token file: what a theme is applied over */
export const TOKENS_FILE = fileURLToPath(new URL('../explorer/tokens.css', import.meta.url));

// ---------------------------------------------------------------------------
//  Stylesheet → rules
// ---------------------------------------------------------------------------

/** Index of the `}` that closes the block opened just before `from` (strings and nested blocks skipped), or -1 */
function closeOf(text, from) {
  let depth = 1;
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote || ch === '\n') quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** The `--name: value` declarations at the top level of a rule's body (nested blocks skipped): [{ name, value, important }] */
function declarationsOf(body) {
  const out = [];
  let depth = 0;
  let quote = null;
  let from = 0;
  const flush = (end) => {
    const m = /^\s*(--[^\s:]+)\s*:([\s\S]*)$/.exec(body.slice(from, end));
    if (m) {
      const imp = /!\s*important\s*$/i.test(m[2]);
      out.push({ name: m[1], value: m[2].replace(/!\s*important\s*$/i, '').trim(), important: imp });
    }
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote || ch === '\n') quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '{') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === '}') { depth = Math.max(0, depth - 1); if (depth === 0) from = i + 1; }
    else if (ch === ';' && depth === 0) { flush(i); from = i + 1; }
  }
  flush(body.length);
  return out;
}

/**
 * The rules of a stylesheet that can set a custom property: `[{ selector, decls, media }]` in source order, `media` the condition of
 * the `@media` it sits in (null at the top level). Other at-rules are skipped.
 * @param {string} css
 * @returns {{ selector: string, decls: { name: string, value: string, important: boolean }[], media: string | null }[]}
 */
export function parseRules(css) {
  const out = [];
  const walk = (text, media, depth) => {
    let from = 0;
    let i = 0;
    let quote = null;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (quote) { if (ch === quote || ch === '\n') quote = null; i++; continue; }
      if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
      if (ch === ';') { from = i + 1; i++; continue; } // an at-rule with no block (@import, @charset)
      if (ch === '}') { from = i + 1; i++; continue; }
      if (ch !== '{') { i++; continue; }
      const end = closeOf(text, i + 1);
      const prelude = text.slice(from, i).trim();
      const body = text.slice(i + 1, end < 0 ? text.length : end);
      if (/^@media\b/i.test(prelude)) { if (depth < 4) walk(body, prelude.replace(/^@media\b/i, '').trim(), depth + 1); }
      else if (/^@layer\b/i.test(prelude) || /^@supports\b/i.test(prelude)) { if (depth < 4) walk(body, media, depth + 1); }
      else if (prelude && !prelude.startsWith('@')) {
        const decls = declarationsOf(body);
        if (decls.length) out.push({ selector: prelude, decls, media });
      }
      if (end < 0) break;
      i = end + 1;
      from = i;
    }
  };
  walk(withoutComments(String(css), ' '), null, 0);
  return out;
}

// ---------------------------------------------------------------------------
//  Which rules apply to the page
// ---------------------------------------------------------------------------

/** Whether an `@media` condition holds when the system's colour scheme is `scheme`: only `prefers-color-scheme` (and `all`, `screen`) are known */
function mediaMatches(cond, scheme) {
  if (cond === null) return true;
  return splitTop(cond, ',').some((q) => q.trim().split(/\s+and\s+/i).every((part) => {
    const t = part.trim().toLowerCase();
    if (t === 'all' || t === 'screen') return true;
    const m = /^\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)$/.exec(t);
    return !!m && m[1] === scheme;
  }));
}

/** Specificity as one number (ids, classes/attributes/pseudo-classes, types) */
const spec = (a, b, c) => a * 1e6 + b * 1e3 + c;
/** How deep `:not()` may nest in a selector the resolver reads; deeper, the rule is not read (it is never one a theme needs) */
const MAX_NOT_DEPTH = 4;
const maxOf = (values, floor) => values.reduce((m, v) => (v > m ? v : m), floor);

/**
 * The specificity of a compound selector on the root element, or null when it does not match the page `attrs`. A compound is
 * `:root` / `html` / `*` with `[attr]`, `[attr="v"]` and `:not(…)` parts. A combinator, a class or any other pseudo-class is not the
 * root's, so it never matches; nor does a compound with `:not()` nested more than MAX_NOT_DEPTH deep (it is not read).
 * @param {string} sel
 * @param {Record<string, string>} attrs
 * @returns {number | null}
 */
export function matchRoot(sel, attrs) {
  const r = matchCompound(sel, attrs, 0);
  return r === false ? null : r;
}

/** matchRoot's work: a specificity, null (does not match) or false (not read: too deep, so the whole rule is left out) */
function matchCompound(sel, attrs, depth) {
  const s = sel.trim();
  if (!s) return null;
  let total = 0;
  let i = 0;
  while (i < s.length) {
    let m;
    const rest = s.slice(i, i + 256);
    if ((m = /^:root\b/i.exec(rest))) { total += spec(0, 1, 0); i += m[0].length; }
    else if ((m = /^html\b/i.exec(rest))) { total += spec(0, 0, 1); i += m[0].length; }
    else if ((m = /^\*/.exec(rest))) i += 1;
    else if ((m = /^\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*(?:[is]\s*)?)?\]/i.exec(rest))) {
      const want = m[2] ?? m[3] ?? m[4];
      const have = attrs[m[1].toLowerCase()];
      if (have === undefined || (want !== undefined && have !== want)) return null;
      total += spec(0, 1, 0);
      i += m[0].length;
    } else if ((m = /^:not\(/i.exec(rest))) {
      if (depth >= MAX_NOT_DEPTH) return false;
      let level = 1;
      let j = i + m[0].length;
      for (; j < s.length && level; j++) { if (s[j] === '(') level++; else if (s[j] === ')') level--; }
      if (level) return null;
      const args = splitTop(s.slice(i + m[0].length, j - 1), ',');
      for (const a of args) {
        const inner = matchCompound(a, attrs, depth + 1);
        if (inner === false) return false;
        if (inner !== null) return null; // the argument matches, so :not() does not
      }
      // :not() counts as its most specific argument, matching or not
      total += maxOf(args.map((a) => specificityOf(a)), 0);
      i = j;
    } else return null;
  }
  return total;
}

/** The specificity a compound would have, whether or not it matches (for the argument of :not()) */
function specificityOf(sel) {
  let total = 0;
  for (const _m of sel.matchAll(/:root\b|\[[^\]]*\]/gi)) total += spec(0, 1, 0);
  if (/(^|[^\w-])html\b/i.test(sel)) total += spec(0, 0, 1);
  return total;
}

/**
 * The custom properties in force on <html> for a page: `mode` is the page's light or dark (`data-theme`, which theme-boot.js always
 * sets), `system` the viewer's system setting (`prefers-color-scheme`; the same as `mode` unless the viewer picked the other one), and
 * `name` the named theme when one is on; the stylesheets in the order the page loads them.
 * @param {string[]} sheets
 * @param {{ mode: 'light' | 'dark', system?: 'light' | 'dark', name?: string }} state
 * @returns {Map<string, string>}
 */
export function resolveProps(sheets, { mode, system = mode, name } = { mode: 'dark' }) {
  const attrs = { 'data-theme': mode };
  if (name) attrs['data-theme-name'] = name;
  const best = new Map(); // custom property -> { rank, value }
  let order = 0;
  for (const css of sheets) {
    for (const rule of parseRules(css)) {
      if (!mediaMatches(rule.media, system)) continue;
      const specificity = maxOf(splitTop(rule.selector, ',').map((s) => matchRoot(s, attrs) ?? -1), -1);
      if (specificity < 0) continue;
      for (const d of rule.decls) {
        const rank = [d.important ? 1 : 0, specificity, order++];
        const had = best.get(d.name);
        if (!had || rank[0] > had.rank[0] || (rank[0] === had.rank[0] && (rank[1] > had.rank[1] || (rank[1] === had.rank[1] && rank[2] > had.rank[2])))) best.set(d.name, { rank, value: d.value });
      }
    }
  }
  return new Map([...best].map(([k, v]) => [k, v.value]));
}

// ---------------------------------------------------------------------------
//  var() and colours
// ---------------------------------------------------------------------------

/** How many var()s deep a value is followed (a reference or a fallback inside a fallback), the longest a value may grow by
 *  substitution, and how many var()s one token may take to work out: past any of them the token is unresolved, never a hang */
export const MAX_VAR_DEPTH = 32;
export const MAX_VALUE_CHARS = 2048;
export const MAX_VAR_STEPS = 2000;

/**
 * `value` with every `var()` replaced: `{ text }`, or `{ problem }` naming the custom property that had nothing to give and why
 * (unset, a cycle, nested too deep, too long). A property that is unset or in a cycle is as good as unset, so a fallback is used.
 * @param {string} value
 * @param {Map<string, string>} props
 * @returns {{ text: string } | { problem: string }}
 */
export function expand(value, props) {
  return expandIn(String(value), props, [], 0, { steps: MAX_VAR_STEPS });
}

const LIMIT = /more than|longer than|grows past/;

function expandIn(value, props, stack, depth, budget) {
  const who = () => (stack.length ? stack[0] : 'the value');
  const at = () => (stack.length > 1 ? ` (at ${stack[stack.length - 1]})` : '');
  const fail = (problem) => ({ problem });
  if (depth > MAX_VAR_DEPTH) return fail(`${who()}: var() is followed more than ${MAX_VAR_DEPTH} deep${at()}`);
  if (value.length > MAX_VALUE_CHARS) return fail(`${who()}: a value is longer than ${MAX_VALUE_CHARS} characters${at()}`);
  const re = /(?<![\w-])var\(/gi;
  let out = '';
  let i = 0;
  for (let m; (m = re.exec(value)); re.lastIndex = i) {
    if (--budget.steps < 0) return fail(`${who()}: it takes more than ${MAX_VAR_STEPS} var() substitutions to work out`);
    let level = 1;
    let j = m.index + m[0].length;
    for (; j < value.length && level; j++) { if (value[j] === '(') level++; else if (value[j] === ')') level--; }
    if (level) return fail(`${stack.length ? stack[stack.length - 1] : 'the value'}: a var() is not closed`);
    const inner = value.slice(m.index + m[0].length, j - 1);
    const comma = inner.indexOf(',');
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
    let got;
    if (!/^--[\w-]+$/.test(name)) got = fail(`${stack.length ? stack[stack.length - 1] : 'the value'}: "var(${name.slice(0, 40)})" does not name a custom property`);
    else if (stack.includes(name)) got = fail(`${who()}: a var() cycle, ${[...stack.slice(stack.indexOf(name)), name].join(' → ')}`);
    else if (!props.has(name)) got = fail(`${[...stack, name].join(' → ')} is not set`);
    else got = expandIn(props.get(name), props, [...stack, name], depth + 1, budget);
    if (got.problem && fallback !== null) {
      const alt = expandIn(fallback, props, stack, depth + 1, budget);
      // a fallback that cannot be worked out either: the first reason is the one to fix, unless a limit stopped the fallback
      if (!alt.problem || LIMIT.test(alt.problem)) got = alt;
    }
    if (got.problem) return got;
    out += value.slice(i, m.index) + got.text;
    if (out.length > MAX_VALUE_CHARS) return fail(`${who()}: a value grows past ${MAX_VALUE_CHARS} characters as its var()s are replaced${at()}`);
    i = j;
  }
  return { text: out + value.slice(i) };
}

/**
 * A value with every `var()` replaced, or null when one has nothing to give (expand() says why).
 * @param {string} value
 * @param {Map<string, string>} props
 * @returns {string | null}
 */
export function substitute(value, props) {
  const r = expand(value, props);
  return 'text' in r ? r.text : null;
}

/** The custom property whose own value a chain of plain `var(--x)`s hands on, for saying where an unreadable colour was written */
function origin(props, name) {
  let at = name;
  for (let n = 0; n < MAX_VAR_DEPTH; n++) {
    const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec((props.get(at) || '').trim());
    if (!m || !props.has(m[1])) break;
    at = m[1];
  }
  return at;
}

const READS = 'hex, rgb(), hsl(), color-mix(in srgb, …), transparent and the basic colour names';

/**
 * A token (`--corn-text`) or a value (`color-mix(…)`) as `[r, g, b, a]`, or `{ problem }` naming the custom property that could not
 * be worked out and why: unset, a cycle (with its path), a colour syntax cornfield does not read (`oklch()`, `calc()`, `auto`), or
 * past one of the limits above.
 * @param {Map<string, string>} props
 * @param {string} nameOrValue
 * @returns {number[] | { problem: string }}
 */
export function resolveColor(props, nameOrValue) {
  const isName = /^--[\w-]+$/.test(nameOrValue);
  if (isName && !props.has(nameOrValue)) return { problem: `${nameOrValue} is not set` };
  const r = expand(isName ? `var(${nameOrValue})` : nameOrValue, props);
  if ('problem' in r) return { problem: r.problem };
  const color = readColor(r.text);
  if (color) return color;
  const shown = r.text.trim().slice(0, 60) + (r.text.trim().length > 60 ? '…' : '');
  const fn = /^([a-z-]+)\(/i.exec(r.text.trim());
  const why = !fn ? 'that is not a colour cornfield reads'
    : fn[1].toLowerCase() === 'color-mix' ? `that is a color-mix() cornfield cannot work out (it mixes in srgb only, colours it reads, at most ${MAX_MIX_DEPTH} deep)`
      : `${fn[1].toLowerCase()}() is not a colour cornfield reads`;
  if (!isName) return { problem: `${nameOrValue} is "${shown}": ${why} (it reads ${READS})` };
  const from = origin(props, nameOrValue);
  return { problem: `${from === nameOrValue ? nameOrValue : `${nameOrValue} → ${from}`} is "${shown}": ${why} (it reads ${READS})` };
}

// ---------------------------------------------------------------------------
//  The pairs
// ---------------------------------------------------------------------------

const SURFACES = ['--corn-surface-1', '--corn-surface-2', '--corn-surface-3'];
const GROUND = '--corn-ground';
/** A tint as explorer.css writes it: the token at a share over what is beneath */
const tint = (token, pct) => `color-mix(in srgb, var(${token}) ${pct}%, transparent)`;
/** A hue pulled toward the text colour, as explorer.css writes it for a hue that must read as text */
const toText = (token, pct) => `color-mix(in srgb, var(${token}) ${pct}%, var(--corn-text))`;

/** Text tokens: read on the ground and on every surface */
export const TEXT_TOKENS = Object.freeze(['--corn-text', '--corn-text-2', '--corn-text-3', '--corn-accent-text', '--corn-ok', '--corn-warn', '--corn-bad', '--corn-info', '--corn-added-text', '--corn-edit-text',
  '--corn-run-requested', '--corn-run-claimed', '--corn-run-working', '--corn-run-waiting', '--corn-run-done', '--corn-run-failed', '--corn-run-stopped']);
/** The tinted backgrounds, with the text that sits on each */
export const SOFT_PAIRS = Object.freeze([
  ['--corn-ok', '--corn-ok-soft'],
  ['--corn-accent-text', '--corn-accent-soft'], ['--corn-hue-orange-text', '--corn-hue-orange-soft'],
  ['--corn-run-waiting-ink', '--corn-run-waiting'], // the waiting pill is solid: its word and icon in the ink, on the fill
]);
/** Solid fills that carry `--corn-ground` as their text (a pressed data-flow button, a chip, the What-if toggle, the House chip) */
export const SOLID_FILLS = Object.freeze(['--corn-ok', '--corn-warn', '--corn-bad', '--corn-info', '--corn-hue-orange', '--corn-hue-lime', '--corn-added-text', '--corn-edit-text']);
/**
 * Text that explorer.css paints on something other than a token surface: a category hue as text, or text on a tint it mixes itself.
 * `[fg, bg, where]`, each the value explorer.css writes (test/core/contrast.test.js holds this list to explorer.css).
 */
export const PAINTED_TEXT = Object.freeze([
  ['--corn-hue-fuchsia', GROUND, 'ROM, a milestone, a link button'], ['--corn-hue-fuchsia', '--corn-surface-1', ''], ['--corn-hue-fuchsia', '--corn-surface-2', ''],
  ['--corn-hue-pink', GROUND, 'a variable'], ['--corn-hue-pink', '--corn-surface-1', ''],
  ['--corn-hue-orange', '--corn-surface-2', 'the data-flow button'],
  [toText('--corn-hue-orange', 60), tint('--corn-hue-orange', 15), 'the data-flow button, hovered'],
  [toText('--corn-hue-fuchsia', 60), tint('--corn-hue-fuchsia', 20), 'the ROM button'],
  ['--corn-hue-lime', tint('--corn-hue-lime', 6), 'a room on the House plan'],
  ['--corn-accent-text', tint('--corn-accent-hover', 10), 'a header link'],
  ['--corn-hue-pink', tint('--corn-hue-pink', 10), 'a header link'],
  ['--corn-edit-text', tint('--corn-edit', 10), 'a header link'],
  ['--corn-text', tint('--corn-added', 12), 'the current proposal'], ['--corn-added-text', tint('--corn-added', 12), 'the current proposal'],
  ['--corn-added-text', tint('--corn-added', 14), 'the proposals button, hovered'],
  ['--corn-added-text', tint('--corn-added', 20), 'the open proposals button, the approve button hovered'],
  ['--corn-text', tint('--corn-edit', 30), 'a What-if number'],
  ['--corn-text-2', tint('--corn-removed', 10), 'a proposal\'s errors'], ['--corn-bad', tint('--corn-removed', 10), 'a proposal\'s errors'],
  ['--corn-bad', tint('--corn-removed', 12), 'a What-if or review message'],
  ['--corn-bad', tint('--corn-removed', 16), 'a refused check'],
  ['--corn-warn', tint('--corn-changed', 16), 'a mismatched check'],
  ['--corn-text-2', tint('--corn-text-3', 12), 'a verdict, a cloud badge'], ['--corn-text-3', tint('--corn-text-3', 12), 'a cloud plan not known'],
  ['--corn-text-2', tint('--corn-text-3', 10), 'a check'],
  ['--corn-text-2', tint('--corn-text-2', 12), 'a web badge'],
  ['--corn-text-2', '--corn-line-soft', 'a text button, hovered'],
  ['--corn-map-collision', GROUND, 'a collision tag on the map'],
]);
/**
 * The parts of the interface a person needs to see to use it (WCAG 1.4.11), at 3:1: `[fg, bg, what]`. The focus indicators, and the
 * borders and marks that alone say a state: which row is selected, which proposal is current, which layers are on, a run's state.
 * `--corn-line` is not here: it is a divider, never the only sign of anything.
 */
export const UI_PAIRS = Object.freeze([
  ...[GROUND, ...SURFACES].map((bg) => ['--corn-focus', bg, 'the focus ring']),
  ['--corn-edit-text', GROUND, 'a What-if field\'s focus ring'], ['--corn-edit-text', '--corn-surface-1', 'a What-if field\'s focus ring'],
  ['--corn-added-text', GROUND, 'the review note\'s focus ring'], ['--corn-added-text', '--corn-surface-1', 'the review note\'s focus ring'],
  ['--corn-accent-text', '--corn-surface-3', 'the selected row\'s border'], ['--corn-accent-text', '--corn-surface-1', 'the selected row\'s border'],
  ['--corn-accent-text', GROUND, 'a pressed button\'s border'], ['--corn-accent-text', '--corn-surface-1', 'a pressed button\'s border'],
  ['--corn-added-text', tint('--corn-added', 12), 'the current proposal\'s border'], ['--corn-added-text', '--corn-surface-1', 'the current proposal\'s border'],
  ['--corn-ok', '--corn-surface-2', 'a layer\'s tick'], ['--corn-ok', '--corn-surface-3', 'a layer\'s tick'],
  ...['--corn-ok', '--corn-edit-text', '--corn-bad', '--corn-warn', '--corn-text-3'].flatMap((fg) => ['--corn-surface-2', '--corn-surface-3'].map((bg) => [fg, bg, 'a state pill\'s border'])),
]);

/** The dots that name a diff mark in the bar, the change list and the legend (explorer.css `.hx-mark-dot--*`), each a ring on the ground */
const DIFF_DOT_PAIRS = Object.freeze(['added', 'changed', 'removed', 'edit'].map((m) => [`--corn-${m}`, GROUND, `the ${m} mark's dot`]));

/**
 * Every pair that is read against each other: `{ fg, bg, min, kind, use? }`, `fg` and `bg` each a token or a CSS colour value. A pair
 * listed twice is checked once, at the higher minimum. How a translucent `bg` is composited: see checkState.
 * @returns {{ fg: string, bg: string, min: number, kind: 'text' | 'ui', use?: string }[]}
 */
export function contrastPairs() {
  const pairs = new Map();
  const add = (fg, bg, min, kind, use) => {
    const key = `${fg}\n${bg}`;
    const had = pairs.get(key);
    if (!had || had.min < min) pairs.set(key, { fg, bg, min, kind, ...(use ? { use } : {}) });
  };
  for (const fg of TEXT_TOKENS) for (const bg of [GROUND, ...SURFACES]) add(fg, bg, MIN_TEXT, 'text');
  for (const bg of ['--corn-accent', '--corn-accent-hover']) add('--corn-text-on-accent', bg, MIN_TEXT, 'text');
  for (const [fg, bg] of SOFT_PAIRS) add(fg, bg, MIN_TEXT, 'text');
  for (const bg of SOLID_FILLS) add(GROUND, bg, MIN_TEXT, 'text');
  for (const [fg, bg] of PAINTED_TEXT) add(fg, bg, MIN_TEXT, 'text');
  for (const [fg, bg, use] of UI_PAIRS) add(fg, bg, MIN_UI, 'ui', use);
  for (const [fg, bg, use] of DIFF_DOT_PAIRS) add(fg, bg, MIN_UI, 'ui', use);
  return [...pairs.values()];
}

/**
 * @typedef {object} ContrastFinding
 * @property {string} theme `standard` or the named theme
 * @property {'light'|'dark'} mode
 * @property {'light'|'dark'} [system] set when the worst case is with the system setting the other way (the viewer picked `mode`)
 * @property {boolean} [groundImage] set when the worst case is over the brightest colour of the ground image
 * @property {string} fg @property {string} bg the two tokens (or values)
 * @property {string} [use] what the pair is, for a UI pair
 * @property {string} [fgValue] @property {string} [bgValue] the two colours as shown (translucent ones composited)
 * @property {number} [ratio] @property {number} min
 * @property {'text'|'ui'} kind
 * @property {string} [problem] set when the pair could not be worked out (then there is no ratio)
 */

const isColor = (v) => Array.isArray(v);

/**
 * The colours the ground can show beneath a panel: `--corn-ground`, and the ground with each layer of `--corn-ground-image` at its most
 * opaque colour stop over it (a radial glow at its centre). An image (`url()`) or a value that cannot be read adds nothing.
 * @returns {{ color: number[], image: boolean }[]}
 */
function groundsOf(props, ground) {
  const out = [{ color: ground, image: false }];
  if (!props.has('--corn-ground-image')) return out;
  const r = expand('var(--corn-ground-image)', props);
  if (!('text' in r)) return out;
  for (const layer of layerTexts(r.text).slice(0, 16)) {
    let peak = null;
    for (const c of colorsIn(layer, 0)) if (!peak || c[3] > peak[3]) peak = c;
    if (peak && peak[3] > 0) out.push({ color: over(peak, ground), image: true });
  }
  return out;
}

/** The layers of a background-image value (split at its top-level commas) */
function layerTexts(text) {
  return splitTop(text, ',').map((t) => t.trim()).filter(Boolean);
}

/** The colours written in a value: a colour, or the colours inside a function like linear-gradient() (two levels deep at most) */
function colorsIn(text, depth) {
  const out = [];
  for (const part of splitTop(text, ',')) {
    for (const word of splitTop(part.trim().replace(/\s+/g, ' '), ' ').map((w) => w.trim()).filter(Boolean)) {
      const c = readColor(word);
      if (c) { out.push(c); continue; }
      const m = /^[a-z-]+\((.*)\)$/is.exec(word);
      if (m && depth < 2 && !/^url\(/i.test(word)) out.push(...colorsIn(m[1], depth + 1));
    }
  }
  return out;
}

// ===========================================================================
//  The map's colours (CF review F48): node fills and labels, against the ground
//  Its own block: the pairs above are fixed lists, these depend on the tokens a theme sets (a kind, its group, the outline).
// ===========================================================================

/** The `--corn-map-group-*` a node type can sit in (explorer/scene.js `groupOf`): its own name, the house for a floor and a room, cloud or web for an outside system */
const MAP_GROUPS_OF = (type) => (type === 'floor' || type === 'room' ? ['house'] : type === 'external' ? ['cloud', 'web'] : [type]);
/** A node's outline and label are drawn on the map's own canvas: a fill under 3:1 needs the outline (WCAG 1.4.11) to be seen */
export const MAP_FILL_MIN = MIN_UI;
/** "a" or "an", for the type named after it (an atom, an app, a table) */
const anOf = (word) => (/^[aeiou]/i.test(word) ? 'an' : 'a');
/** What a map colour token holds: a colour, `auto` (the map keeps its own), or a problem naming why it cannot be read */
function mapToken(props, name) {
  if (!props.has(name)) return { auto: true };
  const raw = expand(`var(${name})`, props);
  if ('problem' in raw) return { problem: raw.problem };
  if (!raw.text.trim() || raw.text.trim().toLowerCase() === 'auto') return { auto: true };
  const c = resolveColor(props, name);
  return isColor(c) ? { color: c } : { problem: c.problem };
}
/** The worst ratio of a colour (composited over the ground) against each ground the page can show, with the colour it was worked out on */
function worstOnGrounds(c, grounds) {
  let worst = null;
  for (const { color: ground, image } of grounds) {
    const fg = over(c, ground);
    const r = ratio(luminance(fg), luminance(ground));
    if (!worst || r < worst.ratio) worst = { ratio: r, fgValue: toHex(fg), bgValue: toHex(ground), image };
  }
  return worst;
}
/**
 * The map's pairs for one page state: for each node type, its fill (the kind's token, else its group's, else the node's own colour from
 * core/schema.js, deepened for the light ground) against the ground; the outline carries a fill under 3:1 when it is itself 3:1 against
 * the fill and the ground; the label colour against the ground and against its halo. Always the same findings in the same order
 * (checkSheets lines the two system settings up by position).
 */
function mapFindings(props, theme, mode, grounds, extra = []) {
  const out = [];
  if (!grounds.length) return out;
  const base = { theme, mode };
  const ground = grounds[0].color;
  const stroke = mapToken(props, '--corn-map-stroke');
  const widthText = props.has('--corn-map-stroke-width') ? substitute(props.get('--corn-map-stroke-width'), props) : '1.5px';
  const strokeOn = isColor(stroke.color) && !(Number.parseFloat(widthText) === 0);
  for (const type of Object.keys(NODE_THEMES)) {
    for (const group of MAP_GROUPS_OF(type)) {
      const names = [`--corn-map-node-${type}`, `--corn-map-group-${group}`];
      let name = null;
      let fill = null;
      let problem = null;
      for (const n of names) {
        const t = mapToken(props, n);
        if (t.problem) { name = n; problem = t.problem; break; }
        if (t.color) { name = n; fill = t.color; break; }
      }
      const label = type === 'external' ? `${type}, in the ${group} group` : type;
      if (problem) { out.push({ ...base, fg: name, bg: GROUND, min: MAP_FILL_MIN, kind: 'ui', use: `the fill of ${anOf(label)} ${label} node`, problem }); continue; }
      const own = !fill;
      if (own) { name = names[0]; fill = readColor(mode === 'light' ? lightColor(NODE_THEMES[type].color) : NODE_THEMES[type].color); }
      const shown = own ? `${name}, auto: the node's own colour` : name;
      const f = worstOnGrounds(fill, grounds);
      const finding = { ...base, fg: name, bg: GROUND, min: MAP_FILL_MIN, kind: 'ui', use: `the fill of ${anOf(label)} ${label} node`, fgValue: f.fgValue, bgValue: f.bgValue, ratio: f.ratio, ...(f.image ? { groundImage: true } : {}) };
      if (f.ratio >= MAP_FILL_MIN || !strokeOn) {
        out.push(f.ratio >= MAP_FILL_MIN ? finding : { ...finding, fg: shown, use: `the fill of ${anOf(label)} ${label} node; set --corn-map-stroke, an outline at ${MAP_FILL_MIN}:1 on the fill and on the ground, or a deeper fill` });
        continue;
      }
      // Under 3:1: acceptable only when the outline is itself 3:1 against both the fill and the ground
      const onGround = worstOnGrounds(stroke.color, grounds);
      const onFill = ratio(luminance(over(stroke.color, over(fill, ground))), luminance(over(fill, ground)));
      const weakest = onGround.ratio <= onFill ? { r: onGround.ratio, on: '--corn-ground', value: onGround.bgValue } : { r: onFill, on: name, value: toHex(over(fill, ground)) };
      out.push({ ...base, fg: '--corn-map-stroke', bg: weakest.on, min: MAP_FILL_MIN, kind: 'ui', use: `the outline that carries the fill of ${anOf(label)} ${label} node, which is ${fmt(f.ratio)} on its own`, fgValue: onGround.fgValue, bgValue: weakest.value, ratio: weakest.r });
    }
  }
  // The tokens a theme sets for a finer kind (`--corn-map-kind-<type>-<kind>`) and a project layer (`--corn-map-group-<key>`): the same fill
  // check, for each one the theme sets (an `auto` one draws the type's own colour, which is checked above)
  for (const name of extra) {
    const t = mapToken(props, name);
    if (t.auto) continue;
    const kind = parseKindToken(name);
    const what = kind ? `the fill of ${anOf(kind.type)} ${kind.type} node of the kind "${kind.kind}"` : `the fill of a node in the "${name.slice('--corn-map-group-'.length)}" layer`;
    if (t.problem) { out.push({ ...base, fg: name, bg: GROUND, min: MAP_FILL_MIN, kind: 'ui', use: what, problem: t.problem }); continue; }
    const f = worstOnGrounds(t.color, grounds);
    const finding = { ...base, fg: name, bg: GROUND, min: MAP_FILL_MIN, kind: 'ui', use: what, fgValue: f.fgValue, bgValue: f.bgValue, ratio: f.ratio, ...(f.image ? { groundImage: true } : {}) };
    if (f.ratio >= MAP_FILL_MIN) { out.push(finding); continue; }
    if (!strokeOn) { out.push({ ...finding, use: `${what}; set --corn-map-stroke, an outline at ${MAP_FILL_MIN}:1 on the fill and on the ground, or a deeper fill` }); continue; }
    const onGround = worstOnGrounds(stroke.color, grounds);
    const onFill = ratio(luminance(over(stroke.color, over(t.color, ground))), luminance(over(t.color, ground)));
    const weakest = onGround.ratio <= onFill ? { r: onGround.ratio, on: '--corn-ground', value: onGround.bgValue } : { r: onFill, on: name, value: toHex(over(t.color, ground)) };
    out.push({ ...base, fg: '--corn-map-stroke', bg: weakest.on, min: MAP_FILL_MIN, kind: 'ui', use: `the outline that carries ${what}, which is ${fmt(f.ratio)} on its own`, fgValue: onGround.fgValue, bgValue: weakest.value, ratio: weakest.r });
  }
  // Labels are text: the colour against the ground, and against the halo under it (the halo is the ground's own colour at `auto`)
  const label = mapToken(props, '--corn-map-label');
  const haloTok = mapToken(props, '--corn-map-label-halo');
  const labelColor = label.color || (label.problem ? null : readColor(mode === 'light' ? lightColor('#f8fafc') : '#f8fafc'));
  if (label.problem) out.push({ ...base, fg: '--corn-map-label', bg: GROUND, min: MIN_TEXT, kind: 'text', use: 'a node\'s label', problem: label.problem }, { ...base, fg: '--corn-map-label', bg: '--corn-map-label-halo', min: MIN_TEXT, kind: 'text', use: 'a node\'s label', problem: label.problem });
  else {
    const name = label.color ? '--corn-map-label' : '--corn-map-label (auto)';
    const w = worstOnGrounds(labelColor, grounds);
    out.push({ ...base, fg: name, bg: GROUND, min: MIN_TEXT, kind: 'text', use: 'a node\'s label on the ground', fgValue: w.fgValue, bgValue: w.bgValue, ratio: w.ratio, ...(w.image ? { groundImage: true } : {}) });
    if (haloTok.problem) out.push({ ...base, fg: name, bg: '--corn-map-label-halo', min: MIN_TEXT, kind: 'text', use: 'a node\'s label on its halo', problem: haloTok.problem });
    else {
      const bg = haloTok.color ? over(haloTok.color, ground) : ground;
      const fgc = over(labelColor, bg);
      out.push({ ...base, fg: name, bg: '--corn-map-label-halo', min: MIN_TEXT, kind: 'text', use: 'a node\'s label on its halo', fgValue: toHex(fgc), bgValue: toHex(bg), ratio: ratio(luminance(fgc), luminance(bg)) });
    }
  }
  return out;
}

/** Pair results for one page state: one per pair, the worst over the ground and the ground image */
function checkState(props, theme, mode, extra = []) {
  const out = [];
  const canvas = mode === 'dark' ? [0, 0, 0, 1] : [255, 255, 255, 1];
  const cache = new Map();
  const color = (v) => { if (!cache.has(v)) cache.set(v, resolveColor(props, v)); return cache.get(v); };
  const g = color(GROUND);
  const grounds = isColor(g) ? groundsOf(props, over(g, canvas)) : [];
  const panel = color('--corn-surface-1');
  for (const p of contrastPairs()) {
    const finding = { theme, mode, fg: p.fg, bg: p.bg, min: p.min, kind: p.kind, ...(p.use ? { use: p.use } : {}) };
    const fg0 = color(p.fg);
    const bg0 = p.bg === GROUND ? g : color(p.bg);
    const bad = [isColor(g) ? null : g, isColor(bg0) ? null : bg0, isColor(fg0) ? null : fg0].find(Boolean);
    if (bad) { out.push({ ...finding, problem: bad.problem }); continue; }
    let worst = null;
    for (const { color: ground, image } of grounds) {
      // A surface sits on the ground; a tint sits on the ground or on the panel (--corn-surface-1) it is drawn in
      const beneath = p.bg === GROUND || SURFACES.includes(p.bg) || !isColor(panel) ? [ground] : [over(panel, ground)];
      for (const under of beneath) {
        const bg = p.bg === GROUND ? ground : over(bg0, under);
        const fg = over(fg0, bg);
        const r = ratio(luminance(fg), luminance(bg));
        if (!worst || r < worst.ratio) worst = { fgValue: toHex(fg), bgValue: toHex(bg), ratio: r, image };
      }
    }
    const { image, ...rest } = worst;
    out.push({ ...finding, ...rest, ...(image ? { groundImage: true } : {}) });
  }
  out.push(...mapFindings(props, theme, mode, grounds, extra)); // the map's node fills and labels (their block above)
  out.push(...diffMapFindings(props, theme, mode, grounds, isColor(g) ? over(g, canvas) : null));
  return out;
}

// ---------------------------------------------------------------------------
//  The map's diff marks and dimmed labels (0.34 review, F19 and F23)
//
//  The canvas draws a proposal's marks in `--corn-map-added|changed|removed|edit` (`auto` is the default look, explorer/diff-marks.js)
//  and a label a diff dims at DIFF_LABEL_ALPHA. Each is read at 3:1 against every ground the map draws: the ground, each glow of
//  `--corn-ground-image` at its strongest, and all of them laid over each other (the darkest and the lightest the map shows), at the
//  opacity it is drawn at (a removed mark is faded, an edge is never fainter than EDGE_MIN_ALPHA). Nothing here reads node fills:
//  those are another check.
// ---------------------------------------------------------------------------

/** Every ground the map can show: the page ground, each glow at its peak over it, and all the glows stacked */
function mapGrounds(grounds, base, props) {
  const out = grounds.map((x) => ({ ...x }));
  if (base && props.has('--corn-ground-image')) {
    const r = expand('var(--corn-ground-image)', props);
    if ('text' in r) {
      let stack = base;
      for (const layer of layerTexts(r.text).slice(0, 16)) {
        let peak = null;
        for (const c of colorsIn(layer, 0)) if (!peak || c[3] > peak[3]) peak = c;
        if (peak && peak[3] > 0) stack = over(peak, stack);
      }
      if (stack !== base) out.push({ color: stack, image: true });
    }
  }
  return out;
}

/** The pairs the map's diff marks make: `[token, default colour (auto), opacity, what it is]` */
const DIFF_MAP_PAIRS = (mode) => [
  ...['added', 'changed', 'removed', 'edit'].map((m) => [`--corn-map-${m}`, DIFF_MARK_COLORS[mode][m], markOpacity(m), `the ${m} mark on the map, drawn at ${Math.round(markOpacity(m) * 100)}% opacity`]),
  ['--corn-map-label', mode === 'light' ? lightColor('#f8fafc', 'text') : '#f8fafc', DIFF_LABEL_ALPHA, `a label the diff dims, drawn at ${Math.round(DIFF_LABEL_ALPHA * 100)}% opacity`],
];

function diffMapFindings(props, theme, mode, grounds, base) {
  const out = [];
  const list = mapGrounds(grounds, base, props);
  for (const [token, auto, opacity, use] of DIFF_MAP_PAIRS(mode)) {
    const finding = { theme, mode, fg: token, bg: GROUND, min: MIN_UI, kind: 'ui', use };
    const raw = (props.get(token) || 'auto').trim();
    const fg0 = raw.toLowerCase() === 'auto' ? readColor(auto) : resolveColor(props, token);
    if (!isColor(fg0)) { out.push({ ...finding, problem: fg0 ? fg0.problem : `${token} is not a colour cornfield reads` }); continue; }
    if (!list.length) continue;
    let worst = null;
    for (const { color: ground, image } of list) {
      const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * opacity], ground);
      const r = ratio(luminance(fg), luminance(ground));
      if (!worst || r < worst.ratio) worst = { fgValue: toHex(fg), bgValue: toHex(ground), ratio: r, image };
    }
    const { image, ...rest } = worst;
    out.push({ ...finding, ...rest, ...(image ? { groundImage: true } : {}) });
  }
  return out;
}

/**
 * Every pair, for light and dark, with the stylesheets applied in load order: one finding per pair, theme and mode, the worst of the
 * two system settings (a viewer can pick light on a dark system) and of the ground and its image. `themes` is one entry per theme to
 * check: `{ theme, sheets, name? }`.
 * @param {{ theme: string, sheets: string[], name?: string }[]} themes
 * @returns {ContrastFinding[]}
 */
export function checkSheets(themes) {
  const out = [];
  for (const { theme, sheets, name } of themes) {
    const extra = mapExtraTokens(sheets);
    for (const mode of ['light', 'dark']) {
      const other = mode === 'light' ? 'dark' : 'light';
      const same = checkState(resolveProps(sheets, { mode, system: mode, name }), theme, mode, extra);
      const flipped = checkState(resolveProps(sheets, { mode, system: other, name }), theme, mode, extra);
      same.forEach((f, i) => {
        // The same findings in the same order, but for a kind or layer token that is `auto` on one system setting only: then by what it is about
        const g = flipped.length === same.length ? flipped[i] : flipped.find((x) => x.fg === f.fg && x.bg === f.bg && x.use === f.use) || f;
        const worse = (f.problem === undefined && g.problem !== undefined) || (f.ratio !== undefined && g.ratio !== undefined && g.ratio < f.ratio && g.ratio < g.min && f.ratio >= f.min);
        out.push(worse ? { ...g, system: other } : f);
      });
    }
  }
  return out;
}

/** Every custom property a stylesheet declares, anywhere in it, once each */
export function declaredProps(sheets) {
  const names = new Set();
  for (const css of sheets) for (const rule of parseRules(css)) for (const d of rule.decls) names.add(d.name);
  return names;
}

/** The groups the standard tokens have (a type's own, and cloud, web and the house): any other `--corn-map-group-*` is a project layer's */
const BUILTIN_GROUPS = new Set([...Object.keys(NODE_THEMES), 'cloud', 'web', 'house']);

/** A project layer's group token: `--corn-map-group-<key>` with a key that passes the layer-key pattern and is not a starting group */
export function projectGroupOf(name) {
  const m = /^--corn-map-group-(.+)$/.exec(name);
  return m && m[1].length <= MAX_KEY && LAYER_KEY_RE.test(m[1]) && !BUILTIN_GROUPS.has(m[1]) ? m[1] : null;
}

/** The kind and project-layer fill tokens a theme's stylesheets set (spec 0009 D6), sorted: what the contrast check reads besides the fixed list */
export function mapExtraTokens(sheets) {
  return [...declaredProps(sheets)].filter((n) => parseKindToken(n) || projectGroupOf(n)).sort();
}

/** The pairs under their minimum: { fails, unresolved } */
export function contrastProblems(themes) {
  const all = checkSheets(themes);
  return { fails: all.filter((f) => f.ratio !== undefined && f.ratio < f.min), unresolved: all.filter((f) => f.problem), total: all.length };
}

const fmt = (r) => `${(Math.floor(r * 100) / 100).toFixed(2)}:1`;
const kindWord = (f) => (f.kind === 'ui' ? 'the UI minimum' : 'AA for text');

/** One line for a finding */
export function describeFinding(f) {
  const who = f.theme === 'standard' ? 'standard theme' : `named theme "${f.theme}"`;
  const where = `${who} (${f.mode}${f.system ? `, on a system set to ${f.system}` : ''})`;
  const fg = f.use ? `${f.fg} (${f.use})` : f.fg;
  if (f.problem) return `${where}: ${fg} on ${f.bg} could not be checked: ${f.problem}.`;
  const bgWord = f.groundImage ? `${f.bg} over the ground image` : f.bg;
  return `${where}: ${fg} (${f.fgValue}) on ${bgWord} (${f.bgValue}) is ${fmt(f.ratio)}, below ${f.min}:1 (${kindWord(f)}).`;
}

/** A theme file's text, or null when validateThemeFiles refuses it (missing, outside the repo, over the size cap, not CSS): it reports that */
function readThemeFile(root, rel, fonts) {
  try {
    const base = fs.realpathSync(root);
    const real = fs.realpathSync(path.resolve(root, rel));
    if (!real.startsWith(base + path.sep)) return null;
    const stats = fs.statSync(real);
    if (!stats.isFile() || stats.size > MAX_THEME_BYTES) return null;
    const text = fs.readFileSync(real, 'utf8');
    return cssProblems(text, { fonts }).length ? null : text;
  } catch {
    return null;
  }
}

/**
 * What the contrast check of a repo reads: `explorer/tokens.css`, then `theme.css`, as the standard theme; then each named theme with
 * its file loaded after both. With no theme it is cornfield's own tokens, so the defaults are held by every `validate`. A theme file
 * validateThemeFiles refuses is not read here (that is its error to report); with a refused `theme.css` there is nothing to check (null).
 * @param {{ root: string, theme?: { css?: string|null, names?: Record<string,string>, fonts?: string[] } }} config
 * @returns {{ theme: string, sheets: string[], name?: string }[] | null}
 */
export function themesToCheck(config) {
  const theme = config.theme || {};
  const base = [fs.readFileSync(TOKENS_FILE, 'utf8')];
  if (theme.css) {
    const css = readThemeFile(config.root, theme.css, theme.fonts);
    if (css === null) return null;
    base.push(css);
  }
  const themes = [{ theme: 'standard', sheets: base }];
  for (const [name, rel] of Object.entries(theme.names || {})) {
    const css = readThemeFile(config.root, rel, theme.fonts);
    if (css !== null) themes.push({ theme: name, name, sheets: [...base, css] });
  }
  return themes;
}

/** The one line `validate` prints about the check (docs/theming.md#the-contrast-check): how many pairs, which themes, both levels, and what held */
export function contrastSummary(themes, total, failed = 0, unchecked = 0) {
  const named = themes.length - 1;
  const what = `${total} pairs of the standard theme${named > 0 ? ` and ${named} named theme${named > 1 ? 's' : ''}` : ''}, in light and dark`;
  const rest = [failed ? `${failed} under their minimum` : '', unchecked ? `${unchecked} that could not be worked out` : ''].filter(Boolean).join(', ');
  return `theme contrast: ${what}: ${rest ? rest : `all at or above their minimum (${MIN_TEXT}:1 for text, ${MIN_UI}:1 for the parts of the interface and the map's fills)`}.`;
}

/**
 * The contrast check of a repo, for `cornfield validate`: every pair under its minimum is an error (a warning with
 * `theme.contrast: 'warn'`), and a pair that could not be worked out is a warning naming the token and why.
 * @param {{ root: string, theme?: { css?: string|null, names?: Record<string,string>, fonts?: string[], contrast?: string } }} config
 * @returns {{ errors: string[], warnings: string[], summary?: string }} `summary`: the one line of what was checked (absent when there was nothing to read)
 */
export function checkThemeContrast(config) {
  const themes = themesToCheck(config);
  if (!themes) return { errors: [], warnings: [] };
  const { fails, unresolved, total } = contrastProblems(themes);
  const lines = fails.map((f) => `theme contrast: ${describeFinding(f)}`);
  const warnings = unresolved.map((f) => `theme contrast: ${describeFinding(f)}`);
  const summary = contrastSummary(themes, total, fails.length, unresolved.length);
  return (config.theme || {}).contrast === 'warn' ? { errors: [], warnings: [...lines, ...warnings], summary } : { errors: lines, warnings, summary };
}
