/**
 * @module core/contrast
 *
 * The theme's contrast check, for `cornfield validate` (docs/theming.md#the-contrast-check). A tiny CSS custom-property resolver
 * and the list of `--corn-*` pairs that are read against each other. No dependencies, no browser: it reads stylesheet text.
 *
 *   resolveProps(sheets, state)          the custom properties in force for a page: `{ mode, name? }` over `[css, …]` in load order
 *   resolveColor(props, name | value)    a token (or a value) as [r, g, b, a], or { problem } when it cannot be worked out
 *   contrastProblems(sheets, opts)       every pair below WCAG AA, for light and dark
 *   checkThemeContrast({ root, theme })  the same for a repo's config: tokens.css, then `theme.css`, then each `theme.names` file
 *
 * What is read of a stylesheet: custom-property declarations in `:root`, `html`, `[data-theme="…"]`, `[data-theme-name="…"]` rules
 * (with `:not()`), at the top level and inside `@media (prefers-color-scheme: light|dark)`. A rule for anything else (a class, a
 * descendant) is not the root's and is ignored; so are other at-rules. Specificity, `!important` and source order decide, as in a browser.
 * `var(--x, fallback)` chains are followed (a cycle is as good as unset, so its fallback is used).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readColor, over, toHex, luminance, ratio, splitTop } from './color.js';
import { themeFiles, withoutComments } from './theme.js';

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

/** Whether an `@media` condition holds when the page is in `mode`: only `prefers-color-scheme` (and `all`, `screen`) are known */
function mediaMatches(cond, mode) {
  if (cond === null) return true;
  return splitTop(cond, ',').some((q) => q.trim().split(/\s+and\s+/i).every((part) => {
    const t = part.trim().toLowerCase();
    if (t === 'all' || t === 'screen') return true;
    const m = /^\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)$/.exec(t);
    return !!m && m[1] === mode;
  }));
}

/** Specificity as one number (ids, classes/attributes/pseudo-classes, types) */
const spec = (a, b, c) => a * 1e6 + b * 1e3 + c;

/**
 * The specificity of a compound selector on the root element, or null when it does not match the page `attrs`. A compound is
 * `:root` / `html` / `*` with `[attr]`, `[attr="v"]` and `:not(…)` parts. A combinator, a class or any other pseudo-class is not the
 * root's, so it never matches.
 * @param {string} sel
 * @param {Record<string, string>} attrs
 */
export function matchRoot(sel, attrs) {
  const s = sel.trim();
  if (!s) return null;
  let total = 0;
  let i = 0;
  while (i < s.length) {
    let m;
    const rest = s.slice(i);
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
      let depth = 1;
      let j = i + m[0].length;
      for (; j < s.length && depth; j++) { if (s[j] === '(') depth++; else if (s[j] === ')') depth--; }
      if (depth) return null;
      const arg = s.slice(i + m[0].length, j - 1);
      const inner = splitTop(arg, ',').map((a) => matchRoot(a, attrs));
      if (inner.some((v) => v !== null)) return null; // the argument matches, so :not() does not
      // :not() counts as its most specific argument, matching or not
      total += Math.max(...splitTop(arg, ',').map((a) => specificityOf(a)));
      i = j;
    } else return null;
  }
  return total;
}

/** The specificity a compound would have, whether or not it matches (for the argument of :not()) */
function specificityOf(sel) {
  let total = 0;
  for (const m of sel.matchAll(/:root\b|\[[^\]]*\]/gi)) total += spec(0, 1, 0);
  if (/(^|[^\w-])html\b/i.test(sel)) total += spec(0, 0, 1);
  return total;
}

/**
 * The custom properties in force on <html> for a page in `mode` (the viewer's light/dark, as `data-theme` and the system setting
 * agree) and, when a named theme is on, `name`; the stylesheets in the order the page loads them.
 * @param {string[]} sheets
 * @param {{ mode: 'light' | 'dark', name?: string }} state
 * @returns {Map<string, string>}
 */
export function resolveProps(sheets, { mode, name } = { mode: 'dark' }) {
  const attrs = { 'data-theme': mode };
  if (name) attrs['data-theme-name'] = name;
  const best = new Map(); // custom property -> { rank, value }
  let order = 0;
  for (const css of sheets) {
    for (const rule of parseRules(css)) {
      if (!mediaMatches(rule.media, mode)) continue;
      const specificity = Math.max(-1, ...splitTop(rule.selector, ',').map((s) => matchRoot(s, attrs) ?? -1));
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

/**
 * A value with every `var()` replaced, or null when one has nothing to give (unset, no fallback; or it leads into a cycle, which is
 * as good as unset, so its fallback is used).
 * @param {string} value
 * @param {Map<string, string>} props
 * @param {string[]} [stack] the custom properties being resolved
 * @returns {string | null}
 */
export function substitute(value, props, stack = []) {
  if (stack.length > 32) return null;
  const re = /(?<![\w-])var\(/gi;
  let out = '';
  let i = 0;
  for (let m; (m = re.exec(value)); re.lastIndex = i) {
    let depth = 1;
    let j = m.index + m[0].length;
    for (; j < value.length && depth; j++) { if (value[j] === '(') depth++; else if (value[j] === ')') depth--; }
    if (depth) return null;
    const inner = value.slice(m.index + m[0].length, j - 1);
    const comma = inner.indexOf(',');
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
    let got = null;
    if (name.startsWith('--') && props.has(name) && !stack.includes(name)) got = substitute(props.get(name), props, [...stack, name]);
    if (got === null && fallback !== null) got = substitute(fallback, props, stack);
    if (got === null) return null;
    out += value.slice(i, m.index) + got;
    i = j;
  }
  return out + value.slice(i);
}

/**
 * A token (`--corn-text`) or a value (`color-mix(…)`) as `[r, g, b, a]`, or `{ problem }` saying why it cannot be worked out
 * (unset, a cycle, or a colour syntax cornfield does not read, like `oklch()` or `auto`).
 * @param {Map<string, string>} props
 * @param {string} nameOrValue
 * @returns {number[] | { problem: string }}
 */
export function resolveColor(props, nameOrValue) {
  const isName = /^--[\w-]+$/.test(nameOrValue);
  const raw = isName ? props.get(nameOrValue) : nameOrValue;
  if (raw === undefined) return { problem: `${nameOrValue} is not set` };
  const text = substitute(isName ? `var(${nameOrValue})` : raw, props);
  if (text === null) return { problem: `${isName ? nameOrValue : raw} leads to a var() with no value (unset, or a cycle)` };
  const color = readColor(text);
  if (!color) return { problem: `${isName ? nameOrValue : raw} is "${text.trim().slice(0, 60)}", which is not a colour cornfield reads (hex, rgb(), hsl(), color-mix(in srgb, …), transparent)` };
  return color;
}

// ---------------------------------------------------------------------------
//  The pairs
// ---------------------------------------------------------------------------

const SURFACES = ['--corn-surface-1', '--corn-surface-2', '--corn-surface-3'];
/** Text tokens: read on the ground and on every surface */
export const TEXT_TOKENS = Object.freeze(['--corn-text', '--corn-text-2', '--corn-text-3', '--corn-accent-text', '--corn-ok', '--corn-warn', '--corn-bad', '--corn-info', '--corn-added-text', '--corn-edit-text']);
/** The tinted backgrounds, with the text that sits on each */
export const SOFT_PAIRS = Object.freeze([
  ['--corn-ok', '--corn-ok-soft'], ['--corn-warn', '--corn-warn-soft'], ['--corn-bad', '--corn-bad-soft'], ['--corn-info', '--corn-info-soft'],
  ['--corn-accent-text', '--corn-accent-soft'], ['--corn-hue-orange-text', '--corn-hue-orange-soft'],
]);
/** Solid fills that carry `--corn-ground` as their text (a pressed data-flow button, a chip, the What-if toggle, the House chip) */
export const SOLID_FILLS = Object.freeze(['--corn-ok', '--corn-warn', '--corn-bad', '--corn-info', '--corn-hue-orange', '--corn-hue-lime', '--corn-added-text', '--corn-edit-text']);

/**
 * Every pair that is read against each other: `{ fg, bg, min, kind }`. A translucent `bg` (a surface, a tint) is composited over the ground it sits on.
 * @returns {{ fg: string, bg: string, min: number, kind: 'text' | 'ui' }[]}
 */
export function contrastPairs() {
  const pairs = [];
  for (const fg of TEXT_TOKENS) for (const bg of ['--corn-ground', ...SURFACES]) pairs.push({ fg, bg, min: MIN_TEXT, kind: 'text' });
  for (const bg of ['--corn-accent', '--corn-accent-hover']) pairs.push({ fg: '--corn-text-on-accent', bg, min: MIN_TEXT, kind: 'text' });
  for (const [fg, bg] of SOFT_PAIRS) pairs.push({ fg, bg, min: MIN_TEXT, kind: 'text' });
  for (const bg of SOLID_FILLS) pairs.push({ fg: '--corn-ground', bg, min: MIN_TEXT, kind: 'text' });
  // The focus ring is the one border a person needs to see: against the ground and the surfaces it is drawn on
  for (const bg of ['--corn-ground', ...SURFACES]) pairs.push({ fg: '--corn-focus', bg, min: MIN_UI, kind: 'ui' });
  return pairs;
}

/**
 * @typedef {object} ContrastFinding
 * @property {string} theme `standard` or the named theme
 * @property {'light'|'dark'} mode
 * @property {string} fg @property {string} bg the two tokens
 * @property {string} [fgValue] @property {string} [bgValue] the two colours as shown (translucent ones composited over the ground)
 * @property {number} [ratio] @property {number} min
 * @property {'text'|'ui'} kind
 * @property {string} [problem] set when the pair could not be worked out (then there is no ratio)
 */

/** Pair results for one page state */
function checkState(props, theme, mode) {
  const out = [];
  const canvas = mode === 'dark' ? [0, 0, 0, 1] : [255, 255, 255, 1];
  const ground = (() => {
    const g = resolveColor(props, '--corn-ground');
    return Array.isArray(g) ? over(g, canvas) : g;
  })();
  for (const p of contrastPairs()) {
    let bg = ground;
    if (p.bg !== '--corn-ground') {
      const c = resolveColor(props, p.bg);
      bg = Array.isArray(c) && Array.isArray(ground) ? over(c, ground) : (Array.isArray(c) ? ground : c);
    }
    const fg0 = resolveColor(props, p.fg);
    const finding = { theme, mode, fg: p.fg, bg: p.bg, min: p.min, kind: p.kind };
    const bad = [bg, fg0].find((v) => !Array.isArray(v));
    if (bad) { out.push({ ...finding, problem: bad.problem }); continue; }
    const fg = over(fg0, bg);
    out.push({ ...finding, fgValue: toHex(fg), bgValue: toHex(bg), ratio: ratio(luminance(fg), luminance(bg)) });
  }
  return out;
}

/**
 * Every pair, for light and dark, with the stylesheets applied in load order. `sheets` is one entry per theme to check:
 * `{ theme, sheets, name? }`.
 * @param {{ theme: string, sheets: string[], name?: string }[]} themes
 * @returns {ContrastFinding[]}
 */
export function checkSheets(themes) {
  const out = [];
  for (const { theme, sheets, name } of themes) {
    for (const mode of ['light', 'dark']) out.push(...checkState(resolveProps(sheets, { mode, name }), theme, mode));
  }
  return out;
}

/** The pairs under their minimum: { fails, unresolved } */
export function contrastProblems(themes) {
  const all = checkSheets(themes);
  return { fails: all.filter((f) => f.ratio !== undefined && f.ratio < f.min), unresolved: all.filter((f) => f.problem) };
}

const fmt = (r) => `${(Math.floor(r * 100) / 100).toFixed(2)}:1`;
const kindWord = (f) => (f.kind === 'ui' ? 'the UI minimum' : 'AA for text');

/** One line for a finding */
export function describeFinding(f) {
  const who = f.theme === 'standard' ? 'standard theme' : `named theme "${f.theme}"`;
  const where = `${who} (${f.mode})`;
  if (f.problem) return `${where}: ${f.fg} on ${f.bg} could not be checked: ${f.problem}.`;
  return `${where}: ${f.fg} (${f.fgValue}) on ${f.bg} (${f.bgValue}) is ${fmt(f.ratio)}, below ${f.min}:1 (${kindWord(f)}).`;
}

/**
 * The contrast check of a repo's theme: `explorer/tokens.css`, then `theme.css`, checked as the standard theme; then each named theme
 * with its file loaded after both. A theme file that cannot be read is left to validateThemeFiles. With neither `css` nor `names`
 * there is no theme to check (cornfield's own tokens are held by its tests).
 * @param {{ root: string, theme?: { css?: string|null, names?: Record<string,string>, contrast?: string } }} config
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkThemeContrast(config) {
  const theme = config.theme || {};
  const files = themeFiles(theme);
  if (!files.length) return { errors: [], warnings: [] };
  const read = (rel) => {
    try { return fs.readFileSync(path.resolve(config.root, rel), 'utf8'); } catch { return null; }
  };
  const tokens = fs.readFileSync(TOKENS_FILE, 'utf8');
  const base = [tokens];
  if (theme.css) { const css = read(theme.css); if (css === null) return { errors: [], warnings: [] }; base.push(css); }
  const themes = [{ theme: 'standard', sheets: base }];
  for (const [name, rel] of Object.entries(theme.names || {})) {
    const css = read(rel);
    if (css !== null) themes.push({ theme: name, name, sheets: [...base, css] });
  }
  const { fails, unresolved } = contrastProblems(themes);
  const lines = fails.map((f) => `theme contrast: ${describeFinding(f)}`);
  const warnings = unresolved.map((f) => `theme contrast: ${describeFinding(f)}`);
  return theme.contrast === 'warn' ? { errors: [], warnings: [...lines, ...warnings] } : { errors: lines, warnings };
}
