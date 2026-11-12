/**
 * @module plugins/docs/markdown
 *
 * A small Markdown renderer, enough for a repo's docs: headings (with GitHub-style anchors), paragraphs,
 * fenced code, block quotes, lists (nested), tables, rules, links, images, code spans, bold and italic.
 * Raw HTML is escaped, except a short allowlist of tags (`<p>`, `<img>`, `<br>`, `<details>`…) rebuilt
 * from their safe attributes. Every link and image goes through `link(href, { image })`, which the docs
 * deriver uses to read the links and the site uses to point them at its own pages.
 *
 * Pure: no files, no DOM.
 */

import { escapeHtml as esc } from '../../core/text.js';

/** Tags an HTML block may keep, and the attributes each may carry */
const ALLOWED_TAGS = {
  p: ['align'], div: ['align'], img: ['src', 'alt', 'width', 'height', 'title'], br: [], hr: [],
  details: ['open'], summary: [], sub: [], sup: [], kbd: [], b: [], i: [], em: [], strong: [], code: [], a: ['href', 'title'],
};
const VOID_TAGS = new Set(['img', 'br', 'hr']);
/** An href or src the page may keep: http(s), mailto, or a relative or anchor link */
const safeUrl = (u) => (typeof u === 'string' && (/^(https?:|mailto:)/i.test(u) || !/^[a-z][a-z0-9+.-]*:/i.test(u.trim())) ? u : null);

/**
 * The anchor GitHub gives a heading: lower case, punctuation dropped, spaces to hyphens.
 * @param {string} text the heading's plain text
 */
export function slugify(text) {
  // Letters keep their marks (the vowel signs of Devanagari, a decomposed \u00e9); only a plain space becomes a hyphen,
  // so a no-break space or a tab is dropped, as GitHub drops it
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_ -]/gu, '').replace(/ /g, '-');
}

const NAMED_ENTITIES = {
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026',
  mdash: '\u2014', ndash: '\u2013', middot: '\u00b7', bull: '\u2022', times: '\u00d7', deg: '\u00b0', laquo: '\u00ab', raquo: '\u00bb',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', larr: '\u2190', rarr: '\u2192', uarr: '\u2191', darr: '\u2193', harr: '\u2194',
};

/** A character reference's text (`&lt;`, `&#60;`, `&#x3c;`); one this does not know stays as written */
const decodeEntities = (s) => s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g, (all, dec, hex, name) => {
  if (name) return NAMED_ENTITIES[name] ?? all;
  const cp = dec ? Number(dec) : parseInt(hex, 16);
  return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : all;
});

const WORD = /[\p{L}\p{N}]/u;
const isWordAt = (s, i) => i >= 0 && i < s.length && WORD.test(String.fromCodePoint(s.codePointAt(i)));
const isWordBefore = (s, i) => isWordAt(s, i >= 2 && /[\udc00-\udfff]/.test(s[i - 1]) && /[\ud800-\udbff]/.test(s[i - 2]) ? i - 2 : i - 1);
const PUNCT = /[!-/:-@[-`{-~]/;

/**
 * Backslash escapes and code spans, in one pass from the left as CommonMark reads them: an escaped mark and a code
 * span's text are handed to `keep` (a backslash inside code is literal), an unmatched run of backticks is text.
 * Linear: a run is closed by the next run of the same length, found from the runs listed once.
 */
function codeAndEscapes(s, keep) {
  const runs = new Map();
  for (const m of s.matchAll(/`+/g)) {
    if (!runs.has(m[0].length)) runs.set(m[0].length, { at: [], next: 0 });
    runs.get(m[0].length).at.push(m.index);
  }
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && PUNCT.test(s[i + 1] || '')) { out += keep(s[i + 1]); i += 2; continue; }
    if (c !== '`') { out += c; i++; continue; }
    let n = 1;
    while (s[i + n] === '`') n++;
    const same = runs.get(n);
    // A run that starts after an escaped backtick is not in the list (it is shorter than the run it is part of)
    while (same && same.next < same.at.length && same.at[same.next] < i + n) same.next++;
    const close = same && same.next < same.at.length ? same.at[same.next] : -1;
    if (close < 0) { out += s.slice(i, i + n); i += n; continue; }
    const code = s.slice(i + n, close).replace(/\n/g, ' ');
    out += keep(/^ .*[^ ].* $/s.test(code) ? code.slice(1, -1) : code);
    i = close + n;
  }
  return out;
}

/** Each `<!-- … -->` taken out (linear: once one has no end, no later one has) */
function dropComments(s) {
  let out = '';
  let i = 0;
  for (;;) {
    const open = s.indexOf('<!--', i);
    const close = open < 0 ? -1 : s.indexOf('-->', open + 4);
    if (close < 0) return out + s.slice(i);
    out += s.slice(i, open);
    i = close + 3;
  }
}

/**
 * `_em_` and `__strong__` as their text: a mark opens only where no letter or digit is before it and closes only
 * where none is after it, so `snake_case_name` keeps its underscores. Linear: the next closing mark from each
 * place is worked out once, from the right.
 */
function dropUnderscores(s) {
  const n = s.length;
  const close1 = new Int32Array(n + 3).fill(-1);
  const close2 = new Int32Array(n + 3).fill(-1);
  const newline = new Int32Array(n + 3).fill(-1);
  for (let p = n - 1; p >= 0; p--) {
    close1[p] = s[p] === '_' && !isWordAt(s, p + 1) ? p : close1[p + 1];
    close2[p] = s[p] === '_' && s[p + 1] === '_' && !isWordAt(s, p + 2) ? p : close2[p + 1];
    newline[p] = s[p] === '\n' ? p : newline[p + 1];
  }
  let out = '';
  let i = 0;
  outer: while (i < n) {
    if (s[i] === '_' && !isWordBefore(s, i)) {
      for (const mark of s[i + 1] === '_' ? [2, 1] : [1]) {
        const start = i + mark;
        if (start >= n || /\s/u.test(s[start])) continue;
        const end = (mark === 2 ? close2 : close1)[start + 1];
        if (end < 0 || (newline[start] >= 0 && newline[start] < end)) continue;
        out += s.slice(start, end);
        i = end + mark;
        continue outer;
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

/**
 * The text a heading or link text renders to, the way GitHub reads it before it makes a heading's anchor, untrimmed:
 * a code span keeps its literal text (so `<tag>` in backticks stays, brackets and all), a real inline HTML tag
 * outside code gives only its inner text, emphasis and links give their text, an autolink its address, and a
 * character reference is its character. An image gives its alt text, or nothing with `images: false` (GitHub's
 * anchor reads the heading's text, and an image has none).
 */
function inlineText(src, { images = true } = {}) {
  // What must reach the end as written (code spans, escaped marks, autolinks) is set aside first, so no later step
  // reads it. A NUL in the source is U+FFFD (as CommonMark has it), so the source cannot forge a set-aside mark.
  const kept = [];
  const keep = (t) => `\u0000${kept.push(t) - 1}\u0000`;
  let s = codeAndEscapes(String(src).replace(/\u0000/g, '�'), keep);
  s = s.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, (_, url) => keep(url.replace(/^mailto:/i, '')));
  // A link or image: `[text](dest "title")`; the spaces are matched so that no two runs of them can trade places
  s = s.replace(/(!?)\[([^[\]]*)\]\(\s*(?:(?:<[^<>\n]*>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*|(?:"[^"]*"|'[^']*')\s*)?\)/g, (_, bang, text) => (bang && !images ? '' : text));
  s = dropComments(s).replace(/<\/?[a-zA-Z][^<>]*>/g, '').replace(/(\*\*|\*)(?=\S)(.+?)\1/g, '$2');
  return decodeEntities(dropUnderscores(s)).replace(/\u0000(\d+)\u0000/g, (_, k) => kept[k]);
}

/** A heading's or link text's plain words (see inlineText), trimmed */
export function plainText(src) {
  return inlineText(src).trim();
}

/** A heading's anchor before it is numbered: from its text as GitHub reads it, images giving nothing, untrimmed */
const headingSlug = (src) => slugify(inlineText(src, { images: false }));

// ---------------------------------------------------------------------------
//  Inline
// ---------------------------------------------------------------------------

/**
 * The deepest a link or emphasis may sit inside another, and a list or quote inside another: each level reads its
 * text again, so deeper marks stay as written (and no crafted line can run the reader out of stack)
 */
const MAX_NEST = 16;

/**
 * What a line's links and code spans need, each worked out once, from the right, so that no failed match makes a
 * later one look ahead to the end of the line again:
 * - `up[x]`: the first `]` after x that is not matched by a `[` after x (or -1), reading as a link's text is read: an
 *   escaped character and a code span (a run of backticks up to the next run at least as long) are stepped over whole.
 *   For a `[` at x, that is the `]` which closes it;
 * - `kRun[x]`: for a run of backticks that starts (or, after an escape, continues) at x, the next run after it at
 *   least as long, which a code span may close on (or -1).
 * The next run at least that long is found among the runs after the one being passed, kept as a stack in which each
 * is longer than every one nearer to it, so it is a binary search.
 */
function scanIndex(src) {
  const n = src.length;
  const rs = [];
  const re = [];
  for (let p = 0; p < n; p++) {
    if (src.charCodeAt(p) !== 96) continue;
    let q = p + 1;
    while (src.charCodeAt(q) === 96) q++;
    rs.push(p);
    re.push(q);
    p = q - 1;
  }
  const up = new Int32Array(n + 1).fill(-1);
  const kRun = new Int32Array(n + 1).fill(-1);
  const stack = []; // runs after the one passed, the nearest last; each longer than all nearer ones
  // The last of the stack with a length of at least m (there is one when m is at most the longest)
  const nearest = (m) => {
    let lo = 0;
    let hi = stack.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (re[stack[mid]] - rs[stack[mid]] >= m) lo = mid; else hi = mid - 1;
    }
    return stack[lo];
  };
  let r = rs.length - 1;
  for (let x = n - 1; x >= 0; x--) {
    const c = src.charCodeAt(x);
    let next = x + 1; // where the bracket scan goes on from x
    if (c === 92) next = Math.min(x + 2, n);
    else if (c === 96) {
      const len = re[r] - x;
      const longest = stack.length ? re[stack[0]] - rs[stack[0]] : 0;
      if (!longest) next = re[r];
      else {
        // A code span that finds no end gives the scan one character on, and the run one shorter to try; so the scan
        // lands after the nearest run that is as long as the longest it can use
        const use = Math.min(len, longest);
        const k = nearest(use);
        next = rs[k] + use;
        if (len <= longest) kRun[x] = k;
      }
    }
    // From `next`: a `]` is the answer; a `[` opens a pair of its own, closed at up[next], and the scan goes on after
    // that `]` (which up[] at the `]` gives); anything else, the scan goes on from it
    const cn = next < n ? src.charCodeAt(next) : 0;
    if (next >= n) up[x] = -1;
    else if (cn === 93) up[x] = next;
    else if (cn === 91) up[x] = up[next] < 0 ? -1 : up[up[next]];
    else up[x] = up[next];
    if (c === 96 && x === rs[r]) {
      while (stack.length && re[stack[stack.length - 1]] - rs[stack[stack.length - 1]] <= re[r] - rs[r]) stack.pop();
      stack.push(r--);
    }
  }
  return { up, kRun, rs, re };
}

/** For the ends of a link, each a table over the places in the line, worked out once from the right (see parseLink) */
function linkTables(src) {
  const n = src.length;
  const skip = new Int32Array(n + 3); // the first place at or after x that is not a space
  const gt = new Int32Array(n + 3).fill(-1); // the next `>`
  const dq = new Int32Array(n + 3).fill(-1); // the next `"`
  const sq = new Int32Array(n + 3).fill(-1); // the next `'`
  const stop = new Int32Array(n + 3); // where a bare destination read from x ends
  for (let x = n; x < n + 3; x++) { skip[x] = x; stop[x] = n; }
  for (let x = n - 1; x >= 0; x--) {
    const c = src.charCodeAt(x);
    skip[x] = c === 32 ? skip[x + 1] : x;
    gt[x] = c === 62 ? x : gt[x + 1];
    dq[x] = c === 34 ? x : dq[x + 1];
    sq[x] = c === 39 ? x : sq[x + 1];
    if (c === 92 && x + 1 < n) stop[x] = stop[x + 2]; // an escaped character is stepped over
    else if (c === 32 || c === 41) stop[x] = x; // a space, or a `)` that closes no `(` of the destination
    else if (c === 40) {
      // A `(` is closed by the first `)` its own text leaves unclosed; the destination goes on after that
      const m = stop[x + 1];
      stop[x] = m >= n || src.charCodeAt(m) === 32 ? m : stop[m + 1];
    } else stop[x] = stop[x + 1];
  }
  return { skip, gt, dq, sq, stop };
}

/**
 * The `[text](dest "title")` starting at `i` (src[i] === '['), or null. `index` and `tables` give what scanIndex and
 * linkTables worked out for `src`, each built when first asked for.
 */
function parseLink(src, i, index, tables) {
  const j = index().up[i];
  if (j < 0 || src[j + 1] !== '(') return null;
  const t = tables();
  const text = src.slice(i + 1, j);
  let k = t.skip[j + 2];
  let dest;
  let bare = -1;
  if (src[k] === '<') {
    const close = t.gt[k];
    if (close < 0) return null;
    dest = src.slice(k + 1, close);
    k = close + 1;
  } else {
    bare = k;
    k = t.stop[k];
  }
  const destEnd = k;
  k = t.skip[k];
  let title = null;
  const quote = src[k];
  if (quote === '"' || quote === "'") {
    const close = (quote === '"' ? t.dq : t.sq)[k + 1];
    if (close < 0) return null;
    title = src.slice(k + 1, close);
    k = t.skip[close + 1];
  }
  if (src[k] !== ')') return null;
  if (bare >= 0) {
    dest = '';
    for (let p = bare; p < destEnd; p++) {
      if (src[p] === '\\' && p + 1 < src.length) p++;
      dest += src[p];
    }
  }
  return { text, dest, title, end: k + 1 };
}

const isWordChar = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/**
 * Where the mark that opens at some place is closed (`close[from]`, or -1), for a mark of one character or two, from
 * the place the search starts: the first mark from there that has no space before it, is not (for `_`) followed by a
 * letter or digit, and (for one character) is not the first of two. A pair is stepped over whole.
 */
function closers(src, c, strong) {
  const n = src.length;
  const close = new Int32Array(n + 4).fill(-1);
  for (let q = n - 1; q >= 0; q--) {
    if (src[q] !== c || (strong && src[q + 1] !== c)) close[q] = close[q + 1];
    else if (!strong && src[q + 1] === c) close[q] = close[q + 2];
    else close[q] = /\s/.test(src[q - 1]) || (c === '_' && isWordChar(src[q + (strong ? 2 : 1)])) ? close[q + 1] : q;
  }
  return close;
}

const AUTOLINK = /<((?:https?:\/\/|mailto:)[^\s<>]+)>/iy;

/**
 * One line (or a paragraph's lines) of inline Markdown as HTML. Linear in the length of the line (times the depth
 * to which marks sit inside one another, at most MAX_NEST).
 * @param {string} src
 * @param {{ link: Function }} ctx
 */
export function renderInline(src, ctx) {
  return inline(src, ctx, 0);
}

function inline(src, ctx, depth) {
  let ix = null;
  let lt = null;
  const index = () => (ix ??= scanIndex(src));
  const tables = () => (lt ??= linkTables(src));
  const marks = {};
  let linkAt = -1; // the link parsed at this place, for the image attempt and then the link attempt at the same `[`
  let link = null;
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && /[!-/:-@[-`{-~]/.test(src[i + 1] || '')) { out += esc(src[i + 1]); i += 2; continue; }
    if (c === '\n') {
      out += i >= 2 && src[i - 1] === ' ' && src[i - 2] === ' ' ? '<br>\n' : '\n';
      i++;
      continue;
    }
    if (c === '`') {
      const { kRun, rs, re } = index();
      let n = 1;
      while (src[i + n] === '`') n++;
      const k = kRun[i];
      if (k >= 0 && re[k] - rs[k] === n) {
        let code = src.slice(i + n, rs[k]).replace(/\n/g, ' ');
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        out += `<code>${esc(code)}</code>`;
        i = re[k];
        continue;
      }
      out += esc(src.slice(i, i + n));
      i += n;
      continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      if (linkAt !== i + 1) { link = parseLink(src, i + 1, index, tables); linkAt = i + 1; }
      const l = link;
      if (l) {
        const href = safeUrl(ctx.link(l.dest, { image: true }));
        const alt = plainText(l.text);
        out += href ? `<img src="${esc(href)}" alt="${esc(alt)}"${l.title ? ` title="${esc(l.title)}"` : ''} loading="lazy">` : esc(alt);
        i = l.end;
        continue;
      }
    }
    if (c === '[' && depth < MAX_NEST) {
      if (linkAt !== i) { link = parseLink(src, i, index, tables); linkAt = i; }
      const l = link;
      if (l) {
        const href = safeUrl(ctx.link(l.dest, { image: false }));
        const inner = inline(l.text, ctx, depth + 1);
        out += href ? `<a href="${esc(href)}"${l.title ? ` title="${esc(l.title)}"` : ''}>${inner}</a>` : inner;
        i = l.end;
        continue;
      }
    }
    if (c === '<') {
      AUTOLINK.lastIndex = i;
      const auto = AUTOLINK.exec(src);
      if (auto) {
        out += `<a href="${esc(auto[1])}">${esc(auto[1].replace(/^mailto:/i, ''))}</a>`;
        i += auto[0].length;
        continue;
      }
    }
    if ((c === '*' || c === '_') && depth < MAX_NEST) {
      const strong = src[i + 1] === c;
      const size = strong ? 2 : 1;
      const opens = !/\s/.test(src[i + size] || ' ') && (c === '*' || !isWordChar(src[i - 1]));
      if (opens) {
        // `**` is not the end of a `*` run, and `_` closes only at a word's end (see closers)
        const close = (marks[c + size] ??= closers(src, c, strong))[i + size + 1];
        if (close >= 0) {
          const tag = strong ? 'strong' : 'em';
          out += `<${tag}>${inline(src.slice(i + size, close), ctx, depth + 1)}</${tag}>`;
          i = close + size;
          continue;
        }
      }
    }
    out += esc(c);
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
//  HTML blocks
// ---------------------------------------------------------------------------

const isSpaceCode = (c, ch) => c === 32 || (c >= 9 && c <= 13) || (c >= 128 && /\s/.test(ch));

/**
 * The tags and comments of an HTML block, as `/<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|<!--[\s\S]*?-->/g`
 * finds them, but in linear time (that expression starts again at every `<` and reads to the end of the block each
 * time). A tag's attributes are read the one way the expression can read them (it has no other that matches), and
 * where the rest of the attributes lead from a place is worked out once; a comment's end is looked for once.
 * @returns {{ index: number, end: number, closing: string, tag: string, attrs: string, comment: boolean }[]}
 */
function* htmlTokens(src) {
  const n = src.length;
  let tables = null;
  const build = () => {
    // From each place: the next that is not a space, not a name's character, not an unquoted value's; the next quote
    const skip = new Int32Array(n + 2);
    const name = new Int32Array(n + 2);
    const bare = new Int32Array(n + 2);
    skip[n] = skip[n + 1] = name[n] = name[n + 1] = bare[n] = bare[n + 1] = n;
    for (let x = n - 1; x >= 0; x--) {
      const ch = src[x];
      const c = src.charCodeAt(x);
      const space = isSpaceCode(c, ch);
      skip[x] = space ? skip[x + 1] : x;
      name[x] = space || ch === '=' || ch === '>' || ch === '/' ? x : name[x + 1];
      bare[x] = space || ch === '"' || ch === "'" || ch === '=' || ch === '<' || ch === '>' || ch === '`' ? x : bare[x + 1];
    }
    return { skip, name, bare, memo: new Int32Array(n + 2).fill(-2) };
  };
  // Where the attributes that can be read from q end (the place after the last), or -1 when they lead to no `>`
  const attrsEnd = (q0) => {
    const { skip, name, bare, memo } = (tables ??= build());
    const seen = [];
    let q = q0;
    let result;
    for (;;) {
      if (memo[q] !== -2) { result = memo[q]; break; }
      seen.push(q);
      const w = skip[q];
      if (w > q && w < n && name[w] > w) {
        const e = name[w];
        const z = skip[e];
        if (src[z] !== '=') { q = e; continue; }
        const v = skip[z + 1];
        let vEnd = -1;
        if (src[v] === '"' || src[v] === "'") {
          const close = src.indexOf(src[v], v + 1);
          if (close >= 0) vEnd = close + 1;
        } else if (bare[v] > v) vEnd = bare[v];
        if (vEnd < 0) { result = -1; break; }
        q = vEnd;
        continue;
      }
      // No more attributes: a `>`, or a `/` and then a `>`, after any spaces
      result = src[w] === '>' || (src[w] === '/' && src[w + 1] === '>') ? q : -1;
      break;
    }
    for (const x of seen) tables.memo[x] = result;
    return result;
  };
  const head = /<(\/?)([a-zA-Z][\w-]*)/y;
  let noCommentEnd = false;
  let p = src.indexOf('<');
  while (p >= 0) {
    head.lastIndex = p;
    const m = head.exec(src);
    if (m) {
      const e = p + m[0].length;
      const a = attrsEnd(e);
      if (a >= 0) {
        const w = tables.skip[a];
        const end = (src[w] === '/' ? w + 1 : w) + 1;
        yield { index: p, end, closing: m[1], tag: m[2], attrs: src.slice(e, a), comment: false };
        p = src.indexOf('<', end);
        continue;
      }
    } else if (!noCommentEnd && src.startsWith('<!--', p)) {
      const close = src.indexOf('-->', p + 4);
      if (close < 0) noCommentEnd = true; // no later `<!--` has an end either
      else {
        yield { index: p, end: close + 3, comment: true };
        p = src.indexOf('<', close + 3);
        continue;
      }
    }
    p = src.indexOf('<', p + 1);
  }
}

/** An HTML block with only the allowed tags and attributes kept; every other tag dropped, the text escaped */
function sanitizeHtml(src, ctx) {
  let out = '';
  let last = 0;
  for (const m of htmlTokens(src)) {
    out += esc(src.slice(last, m.index));
    last = m.end;
    if (m.comment) continue;
    const tag = m.tag.toLowerCase();
    const allowed = ALLOWED_TAGS[tag];
    if (!allowed) continue;
    if (m.closing) { if (!VOID_TAGS.has(tag)) out += `</${tag}>`; continue; }
    let attrs = '';
    for (const a of m.attrs.matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const name = a[1].toLowerCase();
      if (!allowed.includes(name)) continue;
      let value = a[2] ?? a[3] ?? a[4] ?? '';
      if (name === 'src' || name === 'href') {
        value = safeUrl(ctx.link(value, { image: name === 'src' }));
        if (value === null) continue;
      }
      attrs += ` ${name}="${esc(value)}"`;
    }
    out += `<${tag}${attrs}${tag === 'img' ? ' loading="lazy"' : ''}>`;
  }
  return out + esc(src.slice(last));
}

// ---------------------------------------------------------------------------
//  Blocks
// ---------------------------------------------------------------------------

const FENCE_MARK = /^ {0,3}(`{3,}|~{3,})/;
/**
 * A fence line's `[line, mark, info word]`, or null: the mark, then no backtick in the rest of the line. (Checked
 * once; a single expression for it, `/^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/`, reads a long run of spaces again from each one.)
 */
function fenceOf(line) {
  const m = FENCE_MARK.exec(line);
  if (!m || line.includes('`', m[0].length)) return null;
  return [line, m[1], /^\s*([^`\s]*)/.exec(line.slice(m[0].length))[1]];
}
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
const HTML_START = /^ {0,3}<\/?(p|div|img|br|hr|details|summary|table|picture|center|section|!--)(?=[\s/>]|$)/i;
const TABLE_SEP = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const isBlank = (l) => /^\s*$/.test(l);
const indentOf = (l) => /^ */.exec(l.replace(/\t/g, '    '))[0].length;

/** A table row's cells, split on the pipes outside code spans */
function cells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out = [];
  let cur = '';
  let code = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') code = code ? 0 : 1;
    if (c === '|' && !code) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** Whether a line starts a block other than a paragraph (it interrupts a paragraph) */
const startsBlock = (line) => fenceOf(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || HTML_START.test(line) || (LIST_ITEM.test(line) && !isBlank(LIST_ITEM.exec(line)[4]));

/**
 * Lines of Markdown as HTML.
 * @param {string[]} lines
 * @param {{ link: Function, headings: object[], slugs: Map<string, number> }} ctx
 * @param {boolean} [tight] paragraphs without <p> (a tight list item)
 * @param {number} [depth] how many lists and quotes these lines sit in (from MAX_NEST on, a list or quote is text)
 */
function renderBlocks(lines, ctx, tight = false, depth = 0) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    const fence = fenceOf(line);
    if (fence) {
      const [, mark, lang] = fence;
      const indent = indentOf(line);
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${mark[0]}{${mark.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ''));
        i++;
      }
      i++;
      out.push(`<pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(body.join('\n'))}${body.length ? '\n' : ''}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2] || '';
      const base = headingSlug(text);
      const n = ctx.slugs.get(base) || 0;
      ctx.slugs.set(base, n + 1);
      const id = n ? `${base}-${n}` : base;
      ctx.headings.push({ level, text: plainText(text), id });
      out.push(`<h${level} id="${esc(id)}"><a class="anchor" href="#${esc(id)}" aria-hidden="true">#</a>${renderInline(text, ctx)}</h${level}>`);
      i++;
      continue;
    }

    if (RULE.test(line)) { out.push('<hr>'); i++; continue; }

    if (QUOTE.test(line) && depth < MAX_NEST) {
      const body = [];
      while (i < lines.length && !isBlank(lines[i]) && (QUOTE.test(lines[i]) || !startsBlock(lines[i]))) body.push(lines[i++].replace(QUOTE, ''));
      out.push(`<blockquote>\n${renderBlocks(body, ctx, false, depth + 1)}\n</blockquote>`);
      continue;
    }

    if (HTML_START.test(line)) {
      const body = [];
      while (i < lines.length && !isBlank(lines[i])) body.push(lines[i++]);
      out.push(sanitizeHtml(body.join('\n'), ctx));
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      const cell = (tag, text, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${renderInline(text, ctx)}</${tag}>`;
      i += 2;
      const rows = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
        const row = cells(lines[i++]);
        rows.push(`<tr>${head.map((_, k) => cell('td', row[k] ?? '', k)).join('')}</tr>`);
      }
      out.push(`<div class="table"><table>\n<thead><tr>${head.map((h, k) => cell('th', h, k)).join('')}</tr></thead>\n<tbody>\n${rows.join('\n')}\n</tbody>\n</table></div>`);
      continue;
    }

    const item = depth < MAX_NEST && LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const kind = ordered ? item[2].slice(-1) : item[2];
      const start = ordered ? parseInt(item[2], 10) : 1;
      const items = [];
      let loose = false;
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (!m || (/\d/.test(m[2]) ? m[2].slice(-1) : m[2]) !== kind) break;
        const contentIndent = m[1].length + m[2].length + Math.min(m[3].length || 1, 4);
        const body = [m[4]];
        i++;
        let sawBlank = false;
        while (i < lines.length) {
          const l = lines[i];
          if (isBlank(l)) { sawBlank = true; body.push(''); i++; continue; }
          if (indentOf(l) >= contentIndent) {
            if (sawBlank && body.filter((b) => b !== '').length) loose = loose || !LIST_ITEM.test(l.slice(contentIndent));
            body.push(l.replace(/\t/g, '    ').slice(contentIndent));
            sawBlank = false;
            i++;
            continue;
          }
          // A lazy continuation of the item's paragraph
          if (!sawBlank && !startsBlock(l) && !LIST_ITEM.test(l)) { body.push(l.trim()); i++; continue; }
          break;
        }
        while (body.length && body[body.length - 1] === '') body.pop();
        if (sawBlank && i < lines.length && LIST_ITEM.test(lines[i])) loose = true;
        items.push(body);
      }
      const tag = ordered ? 'ol' : 'ul';
      const lis = items.map((b) => `<li>${renderBlocks(b, ctx, !loose, depth + 1)}</li>`).join('\n');
      out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>\n${lis}\n</${tag}>`);
      continue;
    }

    // A paragraph: until a blank line or a line that starts another block
    const para = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) para.push(lines[i++].trim());
    const html = renderInline(para.join('\n'), ctx);
    out.push(tight ? html : `<p>${html}</p>`);
  }
  return out.join('\n');
}

/**
 * A Markdown document as HTML, with its headings.
 * @param {string} text the Markdown
 * @param {{ link?: (href: string, info: { image: boolean }) => string | null }} [opts] what each link and
 *   image points at (default: as written); null renders the text without a link
 * @returns {{ html: string, title: string | null, headings: { level: number, text: string, id: string }[] }}
 */
export function renderMarkdown(text, { link = (href) => href } = {}) {
  const ctx = { link, headings: [], slugs: new Map() };
  const html = renderBlocks(String(text).replace(/\r\n?/g, '\n').split('\n'), ctx);
  const h1 = ctx.headings.find((h) => h.level === 1);
  return { html, title: h1 ? h1.text : null, headings: ctx.headings };
}

/**
 * Every link and image target in a Markdown document, in order (code is skipped, as the renderer skips it).
 * @param {string} text
 * @returns {{ href: string, image: boolean }[]}
 */
export function markdownLinks(text) {
  const out = [];
  renderMarkdown(text, { link: (href, { image }) => { out.push({ href, image }); return href; } });
  return out;
}
