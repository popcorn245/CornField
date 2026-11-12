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

/** The `[text](dest "title")` starting at `i` (src[i] === '['), or null */
function parseLink(src, i) {
  let depth = 0;
  let j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === '`') {
      const run = /^`+/.exec(src.slice(j))[0];
      const close = src.indexOf(run, j + run.length);
      if (close > 0) { j = close + run.length - 1; continue; }
    }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) break;
  }
  if (depth !== 0 || src[j + 1] !== '(') return null;
  const text = src.slice(i + 1, j);
  let k = j + 2;
  while (src[k] === ' ') k++;
  let dest = '';
  if (src[k] === '<') {
    const close = src.indexOf('>', k);
    if (close < 0) return null;
    dest = src.slice(k + 1, close);
    k = close + 1;
  } else {
    let parens = 0;
    for (; k < src.length; k++) {
      const c = src[k];
      if (c === '\\' && k + 1 < src.length) { dest += src[++k]; continue; }
      if (c === ' ' || (c === ')' && parens === 0)) break;
      if (c === '(') parens++;
      if (c === ')') parens--;
      dest += c;
    }
  }
  while (src[k] === ' ') k++;
  let title = null;
  const quote = src[k];
  if (quote === '"' || quote === "'") {
    const close = src.indexOf(quote, k + 1);
    if (close < 0) return null;
    title = src.slice(k + 1, close);
    k = close + 1;
    while (src[k] === ' ') k++;
  }
  if (src[k] !== ')') return null;
  return { text, dest, title, end: k + 1 };
}

const isWordChar = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/**
 * One line (or a paragraph's lines) of inline Markdown as HTML.
 * @param {string} src
 * @param {{ link: Function }} ctx
 */
export function renderInline(src, ctx) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && /[!-/:-@[-`{-~]/.test(src[i + 1] || '')) { out += esc(src[i + 1]); i += 2; continue; }
    if (c === '\n') {
      out += /  $/.test(src.slice(0, i)) ? '<br>\n' : '\n';
      i++;
      continue;
    }
    if (c === '`') {
      const run = /^`+/.exec(src.slice(i))[0];
      const close = src.indexOf(run, i + run.length);
      if (close > 0 && src[close + run.length] !== '`') {
        let code = src.slice(i + run.length, close).replace(/\n/g, ' ');
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        out += `<code>${esc(code)}</code>`;
        i = close + run.length;
        continue;
      }
      out += esc(run);
      i += run.length;
      continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      const l = parseLink(src, i + 1);
      if (l) {
        const href = safeUrl(ctx.link(l.dest, { image: true }));
        const alt = plainText(l.text);
        out += href ? `<img src="${esc(href)}" alt="${esc(alt)}"${l.title ? ` title="${esc(l.title)}"` : ''} loading="lazy">` : esc(alt);
        i = l.end;
        continue;
      }
    }
    if (c === '[') {
      const l = parseLink(src, i);
      if (l) {
        const href = safeUrl(ctx.link(l.dest, { image: false }));
        const inner = renderInline(l.text, ctx);
        out += href ? `<a href="${esc(href)}"${l.title ? ` title="${esc(l.title)}"` : ''}>${inner}</a>` : inner;
        i = l.end;
        continue;
      }
    }
    if (c === '<') {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(src.slice(i));
      if (auto) {
        out += `<a href="${esc(auto[1])}">${esc(auto[1].replace(/^mailto:/i, ''))}</a>`;
        i += auto[0].length;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      const strong = src[i + 1] === c;
      const mark = strong ? c + c : c;
      const opens = !/\s/.test(src[i + mark.length] || ' ') && (c === '*' || !isWordChar(src[i - 1]));
      if (opens) {
        let close = i + mark.length;
        for (;;) {
          close = src.indexOf(mark, close + 1);
          if (close < 0) break;
          const before = src[close - 1];
          const after = src[close + mark.length];
          // `**` must not be read as the end of a `*` run, and `_` closes only at a word's end
          if (!strong && src[close + 1] === c) { close++; continue; }
          if (/\s/.test(before) || (c === '_' && isWordChar(after))) continue;
          break;
        }
        if (close > i + mark.length) {
          const tag = strong ? 'strong' : 'em';
          out += `<${tag}>${renderInline(src.slice(i + mark.length, close), ctx)}</${tag}>`;
          i = close + mark.length;
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

/** An HTML block with only the allowed tags and attributes kept; every other tag dropped, the text escaped */
function sanitizeHtml(src, ctx) {
  let out = '';
  let last = 0;
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|<!--[\s\S]*?-->/g;
  for (const m of src.matchAll(tagRe)) {
    out += esc(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (!m[2]) continue; // a comment
    const tag = m[2].toLowerCase();
    const allowed = ALLOWED_TAGS[tag];
    if (!allowed) continue;
    if (m[1]) { if (!VOID_TAGS.has(tag)) out += `</${tag}>`; continue; }
    let attrs = '';
    for (const a of m[3].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
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

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
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
const startsBlock = (line) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || HTML_START.test(line) || (LIST_ITEM.test(line) && !isBlank(LIST_ITEM.exec(line)[4]));

/**
 * Lines of Markdown as HTML.
 * @param {string[]} lines
 * @param {{ link: Function, headings: object[], slugs: Map<string, number> }} ctx
 * @param {boolean} [tight] paragraphs without <p> (a tight list item)
 */
function renderBlocks(lines, ctx, tight = false) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    const fence = FENCE.exec(line);
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

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && !isBlank(lines[i]) && (QUOTE.test(lines[i]) || !startsBlock(lines[i]))) body.push(lines[i++].replace(QUOTE, ''));
      out.push(`<blockquote>\n${renderBlocks(body, ctx)}\n</blockquote>`);
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

    const item = LIST_ITEM.exec(line);
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
      const lis = items.map((b) => `<li>${renderBlocks(b, ctx, !loose)}</li>`).join('\n');
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
