// @vitest-environment happy-dom
/**
 * The node panel's sections and its ⋯ menu (spec 0015 D4, explorer/panel-sections.js): a section's title opens and closes it, what is open is remembered
 * per kind of node (and a browser that will not store anything only remembers nothing), and ⋯ is a disclosure a keyboard can open, walk and close.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { actionBarHtml, sectionHtml, SECTIONS_KEY } from '../../explorer/panel-model.js';
import { applySections, onSectionsClick, onSectionsKey } from '../../explorer/panel-sections.js';

const btn = (name) => `<button type="button" data-name="${name}">${name}</button>`;

function panel(kind, { win = window } = {}) {
  const root = document.createElement('div');
  root.innerHTML = actionBarHtml({ primary: btn('Review'), others: [btn('Land it'), btn('Start an agent'), btn('Open'), btn('Copy link')] })
    + sectionHtml({ key: 'files', title: 'Files', count: 2, body: '<ul><li>a</li><li>b</li></ul>' })
    + sectionHtml({ key: 'checks', title: 'Checks', count: 1, body: '<p>ok</p>', open: true });
  document.body.append(root);
  const inst = { win };
  root.addEventListener('click', (e) => onSectionsClick(inst, e, kind));
  root.addEventListener('keydown', (e) => onSectionsKey(e));
  applySections(inst, root, kind);
  return { root, inst, q: (s) => root.querySelector(s) };
}
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (el, k) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e; };

describe('a section of the node panel', () => {
  beforeEach(() => { document.body.innerHTML = ''; localStorage.clear(); });

  it('opens and closes from its title, and is left so for that kind of node', () => {
    const one = panel('pull');
    const files = one.q('[data-sec-toggle="files"]');
    expect(files.getAttribute('aria-expanded')).toBe('false');
    expect(one.q('[data-sec="files"] .hx-sec-body').hidden).toBe(true);
    click(files);
    expect(files.getAttribute('aria-expanded')).toBe('true');
    expect(one.q('[data-sec="files"] .hx-sec-body').hidden).toBe(false);
    click(one.q('[data-sec-toggle="checks"]')); // the one open to start, closed by hand
    expect(JSON.parse(localStorage.getItem(SECTIONS_KEY))).toEqual({ pull: { files: true, checks: false } });
    // the next pull request is drawn as this one was left; another kind of node is not
    const two = panel('pull');
    expect(two.q('[data-sec-toggle="files"]').getAttribute('aria-expanded')).toBe('true');
    expect(two.q('[data-sec="checks"] .hx-sec-body').hidden).toBe(true);
    const other = panel('proposal');
    expect(other.q('[data-sec-toggle="files"]').getAttribute('aria-expanded')).toBe('false');
    expect(other.q('[data-sec-toggle="checks"]').getAttribute('aria-expanded')).toBe('true');
  });

  it('still opens and closes when the browser will not store anything', () => {
    const broken = { get localStorage() { throw new Error('SecurityError'); } };
    const one = panel('pull', { win: broken });
    const files = one.q('[data-sec-toggle="files"]');
    click(files);
    expect(files.getAttribute('aria-expanded')).toBe('true');
    const full = { localStorage: { getItem: () => '{broken', setItem: () => { throw new Error('QuotaExceededError'); } } };
    const two = panel('pull', { win: full });
    click(two.q('[data-sec-toggle="files"]'));
    expect(two.q('[data-sec="files"] .hx-sec-body').hidden).toBe(false);
  });
});

describe('the action bar\'s ⋯', () => {
  beforeEach(() => { document.body.innerHTML = ''; localStorage.clear(); });

  it('is a disclosure: it opens with the focus on the first action under it, and Escape closes it with the focus back on ⋯', () => {
    const { q, root } = panel('proposal');
    const more = q('[data-more-toggle]');
    const menu = q('[data-more-menu]');
    expect([...q('.hx-actions-row').children].slice(0, 3).map((b) => b.dataset.name)).toEqual(['Review', 'Land it', 'Start an agent']);
    expect([...menu.querySelectorAll('button')].map((b) => b.dataset.name)).toEqual(['Open', 'Copy link']);
    expect(more.tagName).toBe('BUTTON');
    expect(menu.hidden).toBe(true);
    more.focus();
    click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(menu.hidden).toBe(false);
    expect(document.activeElement.dataset.name).toBe('Open');
    expect(key(document.activeElement, 'Escape').defaultPrevented).toBe(true);
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(more);
    // a click anywhere else in the panel closes it too
    click(more);
    click(root.querySelector('[data-sec="files"] .hx-sec-body'));
    expect(menu.hidden).toBe(true);
  });

  it('closes once an action in it is chosen, and gives ⋯ the focus', async () => {
    const { q } = panel('proposal');
    const more = q('[data-more-toggle]');
    click(more);
    const open = q('[data-more-menu] [data-name="Open"]');
    open.focus();
    click(open);
    await new Promise((r) => setTimeout(r, 0));
    expect(q('[data-more-menu]').hidden).toBe(true);
    expect(document.activeElement).toBe(more);
  });
});
