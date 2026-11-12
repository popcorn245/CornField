/**
 * explorer.css is one stylesheet per piece (spec 0011 D8), so a piece can be mounted in a shadow root in another app with its own file and
 * base.css. These hold what that needs, on every file of explorer/css/ but page.css (the one only cornfield's page loads):
 *   - no rule asks the document: no `:root`, `html`, `body` or `[data-theme]` in a selector;
 *   - nothing is sized from the window: no `vw`, `vh`, `dvh`... (a piece fills its box; a size is `cqw`, `cqh` or a percentage);
 *   - no `position: fixed`, but the few marked on purpose below (a dialog and a phone's menu: a native <dialog> takes them in a later step);
 *   - no width or height `@media`: a size rule is a container query on `corn-box` (the piece's box) or `corn-page` (the screen's height);
 *   - index.html links every file, once, in an order that is the cascade (it is the order the one file had).
 * And what keeps cornfield's page the same: page.css makes the body and the stage the containers those queries ask.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CSS_DIR, EXPLORER_DIR, linkedPieces, pieceFiles, readPiece } from './stylesheets.js';

const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const pieces = pieceFiles().filter((f) => f !== 'page.css');

/** Every rule as { selectors, body, ctx } with the at-rules it sits in as `ctx` strings (a keyframes block is a rule of its own, skipped) */
function rules(text) {
  const out = [];
  const walk = (src, ctx) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) break;
      const head = src.slice(i, open).trim();
      let depth = 1; let j = open + 1; let q = null;
      while (j < src.length && depth) {
        const ch = src[j];
        if (q) { if (ch === '\\') j++; else if (ch === q) q = null; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '{') depth++; else if (ch === '}') depth--;
        j++;
      }
      const body = src.slice(open + 1, j - 1);
      if (/^@(media|container|supports)\b/.test(head)) walk(body, [...ctx, head]);
      else if (!head.startsWith('@')) out.push({ selectors: head.split(/,(?![^()]*\))/).map((s) => s.trim()), body, ctx });
      i = j;
    }
  };
  walk(text, []);
  return out;
}

describe('every piece has a file, and the page links each once', () => {
  it('has the files the pieces need', () => {
    expect(pieceFiles()).toEqual(expect.arrayContaining(['base.css', 'page.css', 'map.css', 'header.css', 'layers.css', 'search.css', 'node-panel.css', 'proposal.css', 'changes.css', 'decision.css', 'whatif.css', 'work.css', 'dialogs.css', 'sheets.css', 'account.css']));
    expect(fs.existsSync(path.join(EXPLORER_DIR, 'explorer.css'))).toBe(false); // split, not copied
  });

  it('links every file of explorer/css/ in index.html exactly once, base first and page last', () => {
    const linked = linkedPieces();
    expect([...linked].sort()).toEqual(pieceFiles());
    expect(new Set(linked).size).toBe(linked.length);
    expect(linked[0]).toBe('base.css');
    expect(linked.at(-1)).toBe('page.css');
    const html = fs.readFileSync(path.join(EXPLORER_DIR, 'index.html'), 'utf8');
    expect(html).not.toMatch(/explorer\/explorer\.css/);
    // the order is the cascade: tokens before them all, house.css after (and a theme after that: test/server/theme.test.js)
    const at = (name) => html.indexOf(`/explorer/${name}"`);
    expect(at('tokens.css')).toBeLessThan(at('css/base.css'));
    expect(at('css/page.css')).toBeLessThan(at('house.css'));
  });

  it('keeps the order the one file had where it is the cascade: the sheets after the node panel and before the Work panel', () => {
    // a phone's dock rules (`.hx-dock > *`, `.hx-sheet-handle`) used to sit after the node panel's base rules and before the Work panel's, whose later
    // `pointer-events: none` and `touch-action` they were written to lose to: swapping the files changes what a closed sheet takes
    const linked = linkedPieces();
    expect(linked.indexOf('sheets.css')).toBeGreaterThan(linked.indexOf('node-panel.css'));
    expect(linked.indexOf('sheets.css')).toBeLessThan(linked.indexOf('work.css'));
  });
});

describe('no piece asks the document, or the window', () => {
  for (const file of pieces) {
    const css = strip(readPiece(file));
    const all = rules(css);

    it(`${file}: no selector names :root, html, body or a theme on an ancestor`, () => {
      const bad = all.flatMap((r) => r.selectors).filter((s) => /:root|\[data-theme|(?<![\w.#-])(html|body)(?![\w-])/.test(s));
      expect(bad).toEqual([]);
    });

    it(`${file}: nothing is sized from the window (vw, vh, dvh, vmin, vmax…)`, () => {
      const decls = css.replace(/url\(\s*(["']?)data:[\s\S]*?\1\s*\)/gi, 'url()');
      const bad = [...decls.matchAll(/(?<![\w.#-])-?(\d*\.)?\d+(v[whib]|[dsl]v[whib]|v(min|max)|[dsl]v(min|max))(?![\w-])/gi)].map((m) => m[0]);
      expect(bad).toEqual([]);
    });
  }

  it('page.css is where the rules on body and :root are', () => {
    const page = rules(strip(readPiece('page.css'))).flatMap((r) => r.selectors);
    expect(page).toContain('body');
    expect(page).toContain(':root[data-pixelated]');
  });

  it('turns <html data-pixelated> into a property that inherits, which a piece reads (a shadow root cannot see <html>)', () => {
    expect(strip(readPiece('page.css'))).toMatch(/:root\[data-pixelated\]\s*\{\s*--hx-pixelated:\s*pixelated/);
    expect(strip(readPiece('base.css'))).toMatch(/img\s*\{\s*image-rendering:\s*var\(--hx-pixelated,\s*auto\)/);
  });
});

/** Where a piece may still be `position: fixed`, and why: each is marked in its file by a comment starting `fixed (spec 0011 D8)` */
const FIXED = {
  'dialogs.css': { '.hx-mockup-dialog': 'a modal over the whole window: a native <dialog> in a later step', '.hx-confirm-scrim': 'the scrim of that kind of modal' },
  'node-panel.css': { '.hx-backdrop': 'a phone\'s tap-away covers the window, the header too' },
  'layers.css': { '.hx-layers .hx-menu': 'a phone\'s menu spans the window under a chip in the header\'s corner' },
  'live.css': { '.hx-menu--live': 'the same, under the live chip' },
  'proposal.css': { '.hx-menu--proposals': 'the same, in a phone\'s account menu' },
};

describe('position: fixed is only where it cannot move without changing the page, and says so', () => {
  const found = {};
  for (const file of pieces) {
    const raw = readPiece(file);
    const masked = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length)); // same offsets, the comments blanked
    for (const m of masked.matchAll(/position:\s*fixed/g)) {
      // the rule it is in: the selector before the `{` that opened it, and the text between the previous `}` / `{` and that selector (where the comment is)
      const open = masked.lastIndexOf('{', m.index);
      const start = Math.max(masked.lastIndexOf('}', open - 1), masked.lastIndexOf('{', open - 1)) + 1;
      const lead = raw.slice(start, open);
      const selector = strip(lead).trim().split(',').map((s) => s.trim()).filter(Boolean).at(-1);
      (found[file] ||= []).push({ selector, marked: /\/\*\s*fixed \(spec 0011 D8\)/.test(lead) });
    }
  }

  it('is in the allow-list, marked in its file, and nowhere else', () => {
    const actual = Object.fromEntries(Object.entries(found).map(([f, l]) => [f, l.map((x) => x.selector).sort()]));
    const allowed = Object.fromEntries(Object.entries(FIXED).map(([f, o]) => [f, Object.keys(o).sort()]));
    expect(actual).toEqual(allowed);
    for (const [f, l] of Object.entries(found)) for (const x of l) expect(x.marked, `${f}: ${x.selector} needs a "fixed (spec 0011 D8)" comment saying why`).toBe(true);
  });
});

/** The width and height `@media` a piece may keep, as `file: [condition]`, with why. None today: a size rule is a container query. */
const MEDIA_ALLOWED = {};

describe('a size rule is a container query on the piece\'s own box', () => {
  for (const file of pieces) {
    const all = rules(strip(readPiece(file)));
    it(`${file}: every width or height @media is on the allow-list (none is)`, () => {
      const bad = all.flatMap((r) => r.ctx).filter((c) => c.startsWith('@media') && /\b(min|max)-(width|height)|\b(width|height)\s*[<>]|aspect-ratio|orientation/.test(c));
      expect([...new Set(bad)].filter((c) => !(MEDIA_ALLOWED[file] || []).includes(c))).toEqual([]);
    });

    it(`${file}: every @container asks corn-box for a width or corn-page for a height, and styles what is inside it`, () => {
      for (const r of all) for (const c of r.ctx.filter((x) => x.startsWith('@container'))) {
        const m = /^@container\s+(corn-box|corn-page)\s+(\(.*\))$/.exec(c);
        expect(m, c).not.toBeNull();
        if (m[1] === 'corn-box') expect(m[2], c).not.toMatch(/height/);
        else expect(m[2], c).not.toMatch(/width/);
      }
      // a container query cannot style its own container: nothing in one is the stage or the body itself
      const own = all.filter((r) => r.ctx.some((c) => c.startsWith('@container'))).flatMap((r) => r.selectors).filter((s) => /^\.hx-stage(?![\w-])(:[\w-]+(\([^)]*\))?)*$/.test(s));
      expect(own).toEqual([]);
    });
  }

  it('has page.css name the two containers: the body for the screen and for what sits outside the stage, the stage for the rest', () => {
    const page = readPiece('page.css');
    expect(page).toMatch(/body\s*\{[^}]*container:\s*corn-page corn-box\s*\/\s*size/);
    expect(page).toMatch(/\.hx-stage\s*\{[^}]*container:\s*corn-box\s*\/\s*inline-size/);
  });

  it('keeps the stage-wide properties the panels read in page.css, where a width rule may still be a media query', () => {
    const page = rules(strip(readPiece('page.css')));
    const decl = page.filter((r) => /--hx-(forge-w|col-w)\s*:/.test(r.body));
    expect(decl.length).toBeGreaterThan(5);
    for (const f of pieces) expect(strip(readPiece(f)), f).not.toMatch(/--hx-(forge-w|col-w)\s*:/);
  });
});
