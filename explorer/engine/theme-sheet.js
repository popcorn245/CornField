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
 *
 * WHAT A THEME MAY LOAD. Only what is on the server's own origin (its `/cornfield/theme/assets/…`) and `data:` images, which is all a theme the server
 * accepts may name (core/theme.js). A CSS image is fetched with the host page's cookies for its own site, so a reference to another origin would make
 * the host page's visitors ask that origin, as themselves: every declaration, token and rule that names one (in `url()`, `src()`, an `image-set()`
 * string, written with CSS escapes, at any depth of the sheet: `@media`, nesting, `@keyframes`, `@font-face`, `@property`) is dropped before the sheet
 * is adopted anywhere. The text is read no further than MAX_THEME_TEXT characters.
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

/** A `data:` URL a theme may name: an image (core/theme.js allows the same on the server) */
const DATA_IMAGE = /^data:image\/(?:png|gif|webp|avif|svg\+xml)[;,]/i;
/** What can load something: `url(`, `src(`, `image(` and `image-set(` (and `-webkit-image-set(`), read after CSS escapes are undone */
const LOADS = /(?<![\w-])(?:url|src|image|(?:-webkit-)?image-set)\(/i;
const REF = /(?<![\w-])(url|src)\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/gi;
const STRING = /"([^"]*)"|'([^']*)'/g;

/** CSS escapes undone, as a browser's tokenizer reads them (`u\72l(` and `\75 rl(` are `url(`) */
export function unescapeCss(text) {
  return String(text).replace(/\\([0-9a-f]{1,6})\s?|\\([^\n])/gi, (_m, hex, ch) => {
    if (hex) { const cp = parseInt(hex, 16); return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd'; }
    return ch;
  });
}

/**
 * Where a reference of the theme leads, made absolute against the server, or null when the theme may not name it: only the server's own origin
 * (its `/cornfield/theme/assets/…`, under the base's path when it has one) and a `data:` image. Another origin, another scheme, `//host`: null.
 * The server refuses such a theme too (core/theme.js), so a theme that names one did not come from a cornfield that checked it.
 */
function placeOf(ref, base) {
  if (DATA_IMAGE.test(ref)) return ref;
  try {
    const at = new URL(base);
    // a path that begins with a slash is the server's own (`/cornfield/theme/assets/x.png`): under the base's path when it has one
    const u = ref.startsWith('/') && !ref.startsWith('//') ? new URL(at.pathname.replace(/\/+$/, '') + ref, at) : new URL(ref, `${base}/`);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== at.origin) return null;
    return u.href;
  } catch { return null; }
}

/**
 * A declaration's value with every reference it may load made absolute against the server, or null when it names one the theme may not (another
 * origin, another scheme), or one that cannot be read safely: a `url(` written with CSS escapes, a `url(` that is not closed, or anything else that
 * loads (`image()`, `src()`) in a form that is not plain. The strings of an `image-set()` are references too. A value that loads nothing is returned
 * as it was.
 * @param {string} value
 * @param {string} base the server's base address (`https://map.example.com`, or with a path)
 * @returns {string | null}
 */
export function absolutizeUrls(value, base) {
  const text = String(value);
  const plain = unescapeCss(text);
  if (!LOADS.test(plain)) return text;
  if (plain !== text && LOADS.test(plain.replace(STRING, '""'))) return null; // escapes in what loads: not rewritten, dropped
  if (!base) return null;
  let ok = true;
  let out = text.replace(REF, (_all, fn, a, b, c) => {
    const place = placeOf(a ?? b ?? c ?? '', base);
    if (place === null) { ok = false; return ''; }
    return `${fn.toLowerCase()}("${place.replace(/["\\\n]/g, (ch) => encodeURIComponent(ch))}")`;
  });
  // Every function that loads must have been one of those: `url(` left open, `image(` (or `src(`) in any other form, refuse the value
  const loads = (out.replace(/(?<![\w-])(?:url|src)\("[^"]*"\)/gi, '').match(new RegExp(LOADS.source, 'gi')) || []).filter((f) => !/image-set\($/i.test(f));
  if (!ok || loads.length) return null;
  // The strings of an image-set() are addresses too (Chrome keeps them as written in a custom property)
  if (/(?:-webkit-)?image-set\(/i.test(out)) {
    out = out.replace(/((?:-webkit-)?image-set\()([^]*)$/i, (_all, head, rest) => head + rest.replace(STRING, (_s, a, b) => {
      const place = placeOf(a ?? b ?? '', base);
      if (place === null) { ok = false; return '""'; }
      return `"${place.replace(/["\\\n]/g, (ch) => encodeURIComponent(ch))}"`;
    }));
    if (!ok) return null;
  }
  return out;
}

/** Whether every reference in a value is already absolute on the server's origin, or a `data:` image (what `absolutizeUrls` leaves) */
function refsSettled(text, base) {
  const fixed = absolutizeUrls(text, base);
  return fixed !== null && fixed === text;
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
      if (base || LOADS.test(unescapeCss(value))) { value = base ? absolutizeUrls(value, base) : null; if (value === null) continue; } // a token that loads is the server's, or not copied
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
 * The text of an answer, read no further than `max` characters: a larger one is refused as soon as it is seen to be (its `Content-Length`, or the
 * bytes as they come), so a theme of any size never sits whole in the page's memory.
 * @param {Response} res
 * @param {number} max
 * @param {string} [what] what the message names
 */
export async function readCapped(res, max, what = 'the answer') {
  const tooBig = () => new Error(`${what} is larger than ${max} characters`);
  const declared = Number(res.headers && res.headers.get ? res.headers.get('content-length') : NaN);
  if (Number.isFinite(declared) && declared > max * 4) throw tooBig(); // UTF-8: at most four bytes a character
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (text.length > max) throw tooBig();
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > max) { reader.cancel().catch(() => {}); throw tooBig(); }
  }
  text += decoder.decode();
  if (text.length > max) throw tooBig();
  return text;
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
    return readCapped(res, MAX_THEME_TEXT, path);
  };

  const theme = {
    /** 'none' (not asked for, or taken back out), 'loading', 'ready' or 'failed' */
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
        settleSheet(sheet, inst.base);
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
      say('none'); // the pieces read their tokens again: the map is drawn in the look it had without the theme
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

/**
 * Makes every reference the sheet loads the server's, in the parsed rules (never in the text): each declaration of each rule, at any depth
 * (`@media`, `@supports`, `@layer`, `@container`, `@scope`, nested rules, the frames of a `@keyframes`, a `@font-face`), is made absolute against
 * the server, and one that names another origin, another scheme or an escaped `url(` is removed. A rule whose text still names something that is
 * not settled (a shorthand with a `var()` that the declarations do not show, an `@property` whose initial value loads) is removed whole.
 */
function settleSheet(sheet, base) {
  const visit = (group) => {
    const rules = group.cssRules;
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i];
      if (rule.cssRules) visit(rule);
      if (rule.style) {
        const style = rule.style;
        for (const prop of Array.from({ length: style.length }, (_x, k) => style[k])) {
          const value = style.getPropertyValue(prop);
          if (!LOADS.test(unescapeCss(value))) continue;
          const fixed = absolutizeUrls(value, base);
          if (fixed === null) style.removeProperty(prop);
          else if (fixed !== value) style.setProperty(prop, fixed, style.getPropertyPriority(prop));
        }
      }
      // What the declarations did not show (a shorthand waiting on a var(), an @property, an @import a browser kept): the rule goes. What is
      // inside it was settled first, so a group's text is its own conditions and what is left in it
      const own = rule.cssText;
      if (own && LOADS.test(unescapeCss(own)) && !refsSettled(own, base)) {
        if (typeof rule.keyText === 'string' && typeof group.deleteRule === 'function' && group.findRule) group.deleteRule(rule.keyText);
        else group.deleteRule(i);
      }
    }
  };
  visit(sheet);
}
