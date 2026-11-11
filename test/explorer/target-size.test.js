/**
 * The 44px rule on a phone (0.34 review, F57): every control the review found under it, and the ones added in 0.29 to
 * 0.34, has a rule in a phone (or coarse pointer) block that gives it a 44px hit area; a change row is 28px at a desk.
 * Read from the stylesheet, because happy-dom does not lay anything out: these rules are what holds it (the real boxes were
 * measured in Chromium at 390x844 with touch when this landed).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.resolve(__dirname, '../../explorer/explorer.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Top-level blocks as { head, body }, so `@media` bodies can be read again */
function blocks(text) {
  const out = [];
  let depth = 0, start = 0, head = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { if (depth === 0) { head = text.slice(start, i).trim(); start = i + 1; } depth++; }
    else if (text[i] === '}') { depth--; if (depth === 0) { out.push({ head, body: text.slice(start, i) }); start = i + 1; } }
  }
  return out;
}
const rules = (list) => list.flatMap(({ head, body }) => (head.startsWith('@') ? [] : [{ selectors: head.split(',').map((s) => s.trim()), body }]));
const top = blocks(css);
const phone = top.filter((b) => /^@media/.test(b.head) && /max-width:\s*767px|pointer:\s*coarse/.test(b.head)).flatMap((b) => rules(blocks(b.body)));
const desk = rules(top);

/** The px a selector is given for `prop` by the last rule in `set` that names it exactly */
function px(set, selector, prop) {
  let value = null;
  for (const r of set) if (r.selectors.includes(selector)) { const m = new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+)px`).exec(r.body); if (m) value = Number(m[1]); }
  return value;
}

const TALL = ['.hx-search-btn', '.hx-search-row', '.hx-change-row', '.hx-toggle-row', '.hx-textbtn', '.hx-player-speed', '.hx-player .hx-close', '.hx-confirm .hx-btn', '.hx-confirm .hx-forge-input', '.hx-confirm .hx-forge-select', '.hx-mobile-search .hx-input', '.hx-run .hx-link', '.hx-forge-check .hx-link'];
const WIDE = ['.hx-search-btn', '.hx-textbtn', '.hx-player-speed', '.hx-player .hx-close', '.hx-confirm .hx-btn'];

describe('touch targets', () => {
  it.each(TALL)('%s is 44px tall on a phone', (sel) => { expect(px(phone, sel, 'min-height')).toBeGreaterThanOrEqual(44); });
  it.each(WIDE)('%s is 44px wide on a phone', (sel) => { expect(px(phone, sel, 'min-width')).toBeGreaterThanOrEqual(44); });
  it('the sheet handle is 44px tall on a phone (its own box: a hit area stretched past it is clipped by the sheet)', () => {
    expect(px(phone, '.hx-sheet-handle', 'height')).toBeGreaterThanOrEqual(44);
  });
  it('a change row is 28px at a desk', () => { expect(px(desk, '.hx-change-row', 'min-height')).toBeGreaterThanOrEqual(28); });
  it('a run card\'s link is 24px at a desk (its lines are closer than 24px: WCAG 2.5.8)', () => { expect(px(desk, '.hx-run .hx-link', 'min-height')).toBeGreaterThanOrEqual(24); });
});
