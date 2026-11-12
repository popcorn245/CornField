/**
 * @module explorer/engine/theme-sheet
 *
 * The server's theme in another app's page (spec 0011 D7): `/cornfield/theme.css` (and the named theme the config makes the default), read once
 * for a scope and given to its pieces in two parts that go to two places. Nothing else of the stylesheet reaches the host's document.
 *
 *   THE RULES    One constructable `CSSStyleSheet`, built from the text with `replaceSync` and adopted into each piece's shadow root, where its
 *                `[data-corn]` hook rules apply as written (and its `::part`-less `*`, `body` and element rules reach only that piece's own tree,
 *                because a shadow root's stylesheet cannot match outside it). It is never adopted by the document.
 *   THE TOKENS   A rule on `:root` cannot match inside a shadow root, so the `--corn-*` declarations of the rules that name `:root` (and the light and
 *                dark blocks docs/theming.md documents) are copied onto the scope element, which every piece inherits from. They are found by walking
 *                the parsed sheet's `cssRules` and reading `CSSStyleDeclaration`s: the CSS text is never searched, cut or rewritten. Any other custom
 *                property, any ordinary declaration and any other rule stays in the sheet and goes nowhere else.
 *
 * What a constructable sheet does not do, and so a theme that relied on it:
 *   `@import`        dropped by the browser (with a console warning): what the imported sheet held is not there. Put it in the theme file.
 *   `@font-face`     a shadow root's stylesheet cannot define a font for the page, so a theme's own fonts are not loaded and the font stack falls to
 *                    its next family. The host can load them itself (a `@font-face` of its own that names the server's /cornfield/theme/assets/…).
 *                    The `fonts` links of the server's page (Google Fonts) are not in the theme file and are not reached either.
 *   a relative `url()` would be resolved against the host page; the ones in a value that is copied, or in a rule of the sheet, are made absolute
 *                    against the server (a `url()` is the only thing rewritten, and in the parsed declaration, not in the text).
 */

/** The longest theme text read, in characters (the server refuses a file over 256 KB) */
export const MAX_THEME_TEXT = 512 * 1024;
/** The longest value of a copied token */
const MAX_VALUE = 4096;
const TOKEN = /^--corn-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const THEME_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const THEME_PATH = '/cornfield/theme.css';
export const themePath = (name) => `/cornfield/theme/${name}.css`;

const squash = (s) => String(s).replace(/\s+/g, '');
const unwrap = (s) => { const m = /^:where\((.*)\)$/.exec(s); return m ? m[1] : s; };

/** The selectors of a rule's selector text, split on top-level commas, spaces removed, `:where()` taken off */
export function selectorParts(text) {
  const out = [];
  let depth = 0;
  let from = 0;
  const t = String(text);
  for (let i = 0; i <= t.length; i++) {
    const c = t[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if ((c === ',' && !depth) || i === t.length) { out.push(unwrap(squash(t.slice(from, i)))); from = i + 1; }
  }
  return out.filter(Boolean);
}

/**
 * Which block of the documented theme contract a selector belongs to, or null (a selector that is not the page's root):
 *
 *   base   `:root` / `html` (dark values and everything both levels share)
 *   light  `:root[data-theme="light"]`, and under `@media (prefers-color-scheme: light)` `:root:not([data-theme="dark"])`
 *   dark   `:root[data-theme="dark"]`, and under `@media (prefers-color-scheme: dark)` `:root:not([data-theme="light"])`
 *
 * A named theme (`/cornfield/theme/<name>.css`) writes the same selectors with `[data-theme-name="<name>"]` on the root; `name` says which.
 * @param {string} selector one selector, as `selectorParts` returns it
 * @param {'light' | 'dark' | null} media the `prefers-color-scheme` the rule sits under, if any
 * @param {string | null} [name]
 * @returns {'base' | 'light' | 'dark' | null}
 */
export function blockOf(selector, media, name = null) {
  const root = selector.startsWith(':root') ? ':root' : selector.startsWith('html') ? 'html' : null;
  if (!root) return null;
  let rest = selector.slice(root.length);
  const tag = name ? `[data-theme-name="${name}"]` : null;
  if (tag) {
    if (rest.includes(tag)) rest = rest.replace(tag, '');
    else return null; // a named theme's rules name the theme
  } else if (/\[data-theme-name=/.test(rest)) return null; // and the standard theme's do not
  if (rest === '') return media ? media : 'base';
  if (rest === '[data-theme="light"]') return 'light';
  if (rest === '[data-theme="dark"]') return 'dark';
  if (rest === ':not([data-theme="dark"])' && media === 'light') return 'light';
  if (rest === ':not([data-theme="light"])' && media === 'dark') return 'dark';
  return null;
}

/** Makes the `url()`s of a declaration's value absolute against `base`; a url that is not http(s) or `data:` (or cannot be read) is dropped by returning null */
export function absolutizeUrls(value, base) {
  let ok = true;
  const out = String(value).replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/gi, (_all, a, b, c) => {
    const ref = a ?? b ?? c ?? '';
    if (/^data:/i.test(ref)) return `url("${ref.replace(/"/g, '%22')}")`;
    try {
      // a path that begins with a slash is the server's own (`/cornfield/theme/assets/x.png`): under the base's path when it has one
      const at = new URL(base);
      const u = ref.startsWith('/') && !ref.startsWith('//') ? new URL(at.pathname.replace(/\/+$/, '') + ref, at) : new URL(ref, `${base}/`);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') { ok = false; return ''; }
      return `url("${u.href.replace(/"/g, '%22')}")`;
    } catch { ok = false; return ''; }
  });
  return ok ? out : null;
}

/**
 * The `--corn-*` declarations of the root rules of a parsed sheet, by block: `{ base, light, dark }`, each a Map of name to value. Only the
 * top level and `@media (prefers-color-scheme: light | dark)` are read (a token in a `@supports`, a `@layer` or another condition is not copied).
 * @param {CSSStyleSheet | { cssRules: CSSRuleList }} sheet
 * @param {{ name?: string | null, base?: string }} [opts] `name`: a named theme; `base`: the server, for the `url()`s of a copied value
 */
export function tokenBlocks(sheet, { name = null, base = '' } = {}) {
  const blocks = { base: new Map(), light: new Map(), dark: new Map() };
  const take = (rule, media) => {
    const into = selectorParts(rule.selectorText).map((s) => blockOf(s, media, name)).find(Boolean);
    if (!into) return;
    const style = rule.style;
    for (let i = 0; i < style.length; i++) {
      const prop = style[i];
      if (!TOKEN.test(prop)) continue;
      let value = style.getPropertyValue(prop).trim();
      if (!value || value.length > MAX_VALUE) continue;
      if (/url\(/i.test(value)) { value = base ? absolutizeUrls(value, base) : value; if (value === null) continue; }
      blocks[into].set(prop, value);
    }
  };
  for (const rule of Array.from(sheet.cssRules || [])) {
    if (rule.selectorText !== undefined) take(rule, null);
    else if (rule.media && rule.cssRules) {
      const m = /^\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)$/.exec(rule.media.mediaText.trim());
      if (m) for (const inner of Array.from(rule.cssRules)) if (inner.selectorText !== undefined) take(inner, m[1]);
    }
  }
  return blocks;
}

/**
 * The tokens an element is given for a mode, from blocks in order of strength: each block's `base`, then the mode's own (light over base in
 * light mode; dark over base in dark mode).
 * @param {Array<ReturnType<typeof tokenBlocks>>} layers weakest first
 * @param {'light' | 'dark'} mode
 * @returns {Map<string, string>}
 */
export function tokensFor(layers, mode) {
  const out = new Map();
  for (const b of layers) {
    for (const [k, v] of b.base) out.set(k, v);
    for (const [k, v] of b[mode]) out.set(k, v);
  }
  return out;
}

/**
 * The default tokens that are worked out from others (`--corn-ok-soft` mixes `--corn-ok`): declared on the element too, or they would keep the
 * value the document's `:root` worked out from the default `--corn-ok` and a theme's `--corn-ok` would not reach its tint. Read from the default
 * tokens' own sheet (the package generates it from explorer/tokens.css), so there is no second list.
 * @param {ReturnType<typeof tokenBlocks>} defaults
 * @returns {ReturnType<typeof tokenBlocks>}
 */
export function derivedOf(defaults) {
  const out = { base: new Map(), light: new Map(), dark: new Map() };
  for (const key of Object.keys(out)) for (const [k, v] of defaults[key]) if (/var\(/.test(v)) out[key].set(k, v);
  return out;
}

/**
 * The server's theme for one scope.
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst
 * @param {object} [opts]
 * @param {string} [opts.defaults] the default tokens' CSS text (the package's generated sheet), for the derived tokens
 */
export function createServerTheme(inst, { defaults = '' } = {}) {
  const win = inst.win;
  let destroyed = false;
  let controller = null;
  let sheet = null;
  /** Roots the sheet is adopted into */
  const roots = new Set();
  /** The element the tokens are on, the names set on it, and the mode they were set for */
  let target = null;
  let applied = [];
  let layers = [];
  let derived = null;
  let mode = 'dark';
  let state = 'none';

  const make = () => {
    if (sheet || !win || typeof win.CSSStyleSheet !== 'function' || !('replaceSync' in win.CSSStyleSheet.prototype)) return;
    sheet = new win.CSSStyleSheet();
  };

  /** The derived defaults, parsed once from the generated sheet */
  const derivedBlocks = () => {
    if (derived || !defaults) return derived;
    try {
      const probe = new win.CSSStyleSheet();
      probe.replaceSync(defaults);
      derived = derivedOf(tokenBlocks(probe));
    } catch { derived = null; }
    return derived;
  };

  const paint = () => {
    if (!target) return;
    for (const name of applied) target.style.removeProperty(name);
    applied = [];
    if (!layers.length) return;
    const all = [];
    const d = derivedBlocks();
    if (d) all.push(d);
    all.push(...layers);
    const tokens = tokensFor(all, mode);
    // a derived default is declared only where the theme does not set the token itself
    for (const [name, value] of tokens) { target.style.setProperty(name, value); applied.push(name); }
  };

  const say = (next, detail = {}) => { state = next; inst.emit('theme', { state: next, ...detail }); };

  const fetchText = async (path, signal) => {
    // The theme answers a listed origin without a session and without Allow-Credentials: asked for without credentials
    const res = await inst.fetch(path, { credentials: 'omit', signal });
    if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_THEME_TEXT) throw new Error(`${path} is larger than ${MAX_THEME_TEXT} characters`);
    return text;
  };

  const theme = {
    /** 'none' (not asked for), 'loading', 'ready' or 'failed' */
    state: () => state,
    /** The adopted sheet, once there is one */
    sheet: () => sheet,
    /**
     * Fetches the standard theme and, when the config names a default, that named theme; builds the one sheet; copies the tokens.
     * A theme that cannot be had leaves the pieces in their default look (`theme` event `failed`).
     * @param {{ theme?: { default?: string | null } | null } | null} config
     */
    async load(config) {
      if (destroyed || !inst.base) return;
      if (controller) controller.abort();
      controller = new AbortController();
      const { signal } = controller;
      say('loading');
      try {
        const name = config && config.theme && typeof config.theme.default === 'string' && THEME_NAME.test(config.theme.default) ? config.theme.default : null;
        const [standard, named] = await Promise.all([
          fetchText(THEME_PATH, signal).catch((err) => { if (signal.aborted) throw err; return null; }),
          name ? fetchText(themePath(name), signal).catch((err) => { if (signal.aborted) throw err; return null; }) : Promise.resolve(null),
        ]);
        if (destroyed || signal.aborted) return;
        if (standard === null && named === null) { say('failed'); return; }
        make();
        if (!sheet) { say('failed', { reason: 'constructable stylesheets are not available' }); return; }
        // One sheet, the standard theme first and the named one after it (it is the stronger: it names the theme on the root)
        sheet.replaceSync([standard, named].filter((x) => x !== null).join('\n'));
        fixUrls(sheet, inst.base);
        layers = [];
        const parse = (text, nm) => {
          const probe = new win.CSSStyleSheet();
          probe.replaceSync(text);
          return tokenBlocks(probe, { name: nm, base: inst.base });
        };
        if (standard !== null) layers.push(parse(standard, null));
        if (named !== null) layers.push(parse(named, name));
        paint();
        say('ready');
      } catch (err) {
        if (destroyed || signal.aborted) return;
        say('failed', { reason: err && err.message ? err.message : String(err) });
      }
    },
    /** Adopts the sheet into a root (a piece's shadow root); returns how to take it out. Adopts it as soon as it exists if it does not yet. */
    adopt(root) {
      if (!root || !('adoptedStyleSheets' in root)) return () => {};
      roots.add(root);
      const put = () => {
        if (!sheet || root.adoptedStyleSheets.includes(sheet)) return;
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      };
      put();
      const off = inst.on('theme', put);
      return () => {
        off();
        roots.delete(root);
        if (sheet && root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
      };
    },
    /** The element the tokens go on (the scope element) */
    tokensOn(el) {
      theme.release();
      target = el;
      paint();
    },
    /** The mode the tokens are for now ('light' | 'dark') */
    setMode(next) {
      const m = next === 'light' ? 'light' : 'dark';
      if (m === mode) return;
      mode = m;
      paint();
    },
    /** Takes the tokens off the element */
    release() {
      if (target) for (const name of applied) target.style.removeProperty(name);
      applied = [];
      target = null;
    },
    /** Takes the theme back out (`use-theme` turned off, or a new server): the sheet leaves every root and the tokens leave the element */
    unload() {
      if (controller) controller.abort();
      for (const root of roots) if (sheet && root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
      if (sheet) sheet.replaceSync('');
      sheet = null;
      layers = [];
      paint();
      state = 'none';
    },
    destroy() {
      destroyed = true;
      if (controller) controller.abort();
      theme.release();
      for (const root of [...roots]) if (sheet && root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
      roots.clear();
      sheet = null;
      layers = [];
    },
  };
  return theme;
}

/** Makes the `url()` of every declaration of the style rules of a sheet absolute against the server (in the parsed declaration; a `url()` that cannot be is removed) */
function fixUrls(sheet, base) {
  const visit = (rules) => {
    for (const rule of Array.from(rules)) {
      if (rule.style && rule.selectorText !== undefined) {
        const style = rule.style;
        for (const prop of Array.from({ length: style.length }, (_x, i) => style[i])) {
          const value = style.getPropertyValue(prop);
          if (!/url\(/i.test(value)) continue;
          const fixed = absolutizeUrls(value, base);
          if (fixed === null) style.removeProperty(prop);
          else if (fixed !== value) style.setProperty(prop, fixed, style.getPropertyPriority(prop));
        }
      } else if (rule.cssRules && rule.constructor && /Media|Supports|Layer|Container/.test(rule.constructor.name)) visit(rule.cssRules);
    }
  };
  visit(sheet.cssRules);
}
