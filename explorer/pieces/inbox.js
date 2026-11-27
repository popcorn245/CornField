/**
 * @module explorer/pieces/inbox
 *
 * The Work inbox in cornfield's page (spec 0016 D1, D2, D5 to D8): the queue of what needs you, over the Work view's stage, beside the node panel. Its rules are
 * inbox-model.js (pure); work-view.js owns the read of the graph and the Inbox · Graph toggle, and mounts this once.
 *
 *   mount(stage, { pick, act, announce, refresh, colorOf, now })  -> { paint(graph, { on, selected }), focus(), destroy() }
 *
 * `pick(id)` selects a piece of work (the node panel opens on it, with its actions: spec 0015's action bar); `act(id)` selects it and does its primary action, the
 * node panel's own button, with its confirm step. Every word from the forge is set as text, never as HTML. J and K (and the arrows) move through the open groups,
 * Enter acts, a group's header folds it. Nothing is filed by hand (D7): a row moves when the graph says its state moved.
 */

import { GROUPS, inboxOf, headingOf, openedWords, orderOf, rowWords } from '../inbox-model.js';
import { relativeTime } from '../review-model.js';

const SHAPE = { thread: 'circle', issue: 'circle', proposal: 'diamond', run: 'hexagon', pull: 'rounded', deploy: 'square' };

/** A small mark of the kind, drawn by its shape (the kind is said in words too: the row's tag) */
function glyph(kind, color) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `hx-inbox-glyph is-${kind}`);
  if (color) svg.style.setProperty('--hx-glyph', color);
  const shape = SHAPE[kind] || 'circle';
  let el;
  if (shape === 'circle') { el = document.createElementNS(ns, 'circle'); el.setAttribute('cx', '8'); el.setAttribute('cy', '8'); el.setAttribute('r', '6'); }
  else if (shape === 'diamond') { el = document.createElementNS(ns, 'rect'); el.setAttribute('x', '3.5'); el.setAttribute('y', '3.5'); el.setAttribute('width', '9'); el.setAttribute('height', '9'); el.setAttribute('transform', 'rotate(45 8 8)'); }
  else if (shape === 'hexagon') { el = document.createElementNS(ns, 'polygon'); el.setAttribute('points', '8,1.5 13.6,4.75 13.6,11.25 8,14.5 2.4,11.25 2.4,4.75'); }
  else { el = document.createElementNS(ns, 'rect'); el.setAttribute('x', '2'); el.setAttribute('y', '2'); el.setAttribute('width', '12'); el.setAttribute('height', '12'); el.setAttribute('rx', shape === 'rounded' ? '3.5' : '1.5'); }
  svg.append(el);
  return svg;
}

/** A number as data, and a kind's tag: the page's own `count` and `tag` hooks (docs/theming.md) */
const counted = (n) => { const el = make('span', 'hx-inbox-count', String(n)); el.dataset.corn = 'count'; el.setAttribute('part', 'count'); return el; };
const tagged = (words) => { const el = make('span', 'hx-inbox-tag', words); el.dataset.corn = 'tag'; el.setAttribute('part', 'tag'); return el; };
const make = (tag, cls, words) => { const el = document.createElement(tag); if (cls) el.className = cls; if (words != null) el.textContent = words; return el; };

/**
 * @param {HTMLElement} stage the Work view's stage (the map's box)
 * @param {{ pick: (id: string) => boolean, act: (id: string) => void, announce: (words: string) => void, now?: () => number, refresh: () => void, colorOf?: (kind: string) => string }} hooks
 */
export function mount(stage, hooks) {
  const now = hooks.now || (() => Date.now());
  const color = (kind) => (hooks.colorOf ? hooks.colorOf(kind) : '');
  const root = make('section', 'hx-inbox');
  root.dataset.corn = 'inbox';
  root.setAttribute('part', 'inbox');
  root.setAttribute('aria-label', 'Inbox');
  root.hidden = true;
  const queue = make('div', 'hx-inbox-queue');
  const head = make('div', 'hx-inbox-head');
  const title = make('h2', 'hx-inbox-title', 'Inbox');
  const sub = make('span', 'hx-inbox-sub');
  head.append(title, sub);
  const list = make('div', 'hx-inbox-groups');
  queue.append(head, list);
  const aside = make('p', 'hx-inbox-pick', 'Pick a row: what it needs opens beside the queue.');
  aside.dataset.corn = 'hint';
  aside.setAttribute('part', 'hint');
  root.append(queue, aside);
  stage.append(root);

  /** which groups are open: the ones GROUPS starts open, then as the viewer folds them (kept while the page is open) */
  const open = new Set(GROUPS.filter((g) => g.open).map((g) => g.key));
  let inbox = inboxOf(null);
  let selected = null;
  let was = false;

  function paint(graph, { on, selected: sel = null } = {}) {
    root.hidden = !on;
    if (!on) { was = false; return; }
    inbox = inboxOf(graph);
    selected = sel;
    sub.textContent = headingOf(inbox);
    list.textContent = '';
    if (!inbox.count) {
      const empty = make('p', 'hx-inbox-empty');
      empty.dataset.corn = 'empty';
      empty.setAttribute('part', 'empty');
      empty.append(make('strong', '', 'Nothing waits on you.'), document.createTextNode(' What is still yours to pick up is below.'));
      list.append(empty);
    }
    for (const g of GROUPS) {
      const rows = inbox.groups[g.key];
      if (!rows.length) continue;
      const isOpen = open.has(g.key);
      const group = make('div', `hx-inbox-group is-${g.key}`);
      group.dataset.corn = 'section';
      group.setAttribute('part', 'section');
      group.dataset.group = g.key;
      const btn = make('button', 'hx-inbox-group-head');
      btn.type = 'button';
      btn.dataset.inboxGroup = g.key;
      btn.setAttribute('aria-expanded', String(isOpen));
      btn.append(make('span', 'hx-inbox-group-title', g.title), counted(rows.length));
      if (g.hint) btn.append(make('span', 'hx-inbox-hint', g.hint));
      group.append(btn);
      if (isOpen) {
        const ul = make('ul', 'hx-inbox-rows');
        ul.setAttribute('aria-label', g.title);
        for (const r of rows) ul.append(rowEl(r, g.key));
        group.append(ul);
      }
      list.append(group);
    }
    if (inbox.drafts) {
      const d = make('p', 'hx-inbox-drafts');
      d.append(make('span', 'hx-inbox-group-title', 'Drafts in the checkout'), counted(inbox.drafts), make('span', 'hx-inbox-hint', 'nobody has been asked to decide them'));
      list.append(d);
    }
    aside.hidden = !!selected;
    if (!was) { hooks.announce(openedWords(inbox)); was = true; }
  }

  function rowEl(r, group) {
    const li = make('li', `hx-inbox-row${r.id === selected || (r.also && r.also.id === selected) ? ' is-selected' : ''}`);
    li.dataset.corn = 'row';
    li.setAttribute('part', 'row');
    li.dataset.id = r.id;
    const ago = relativeTime(r.item.updated, now());
    // The row is a list item holding two buttons (a row that is an option cannot hold a button): its line, which selects it and covers the row, and its action
    const top = make('button', 'hx-inbox-line');
    top.type = 'button';
    top.dataset.inboxOpen = r.id;
    top.setAttribute('aria-label', rowWords(r, ago));
    if (r.id === selected) top.setAttribute('aria-current', 'true');
    top.tabIndex = r.id === selected || (!selected && r.id === order()[0]) ? 0 : -1;
    top.append(tagged(r.tag), make('span', 'hx-inbox-row-title', String(r.item.title || '')));
    const why = make('span', `hx-inbox-why${r.bad ? ' is-bad' : ''}`, r.why);
    li.append(glyph(r.item.kind, color(r.item.kind)), top, make('span', 'hx-inbox-age', ago), why);
    if (r.action) {
      const go = make('button', `hx-inbox-act${group === 'waiting' ? ' is-primary' : ''}`, r.action.label);
      go.type = 'button';
      go.tabIndex = -1;
      go.dataset.inboxAct = r.id;
      li.append(go);
    }
    if (r.also) {
      const also = make('span', 'hx-inbox-also');
      also.append(glyph('run', color('run')), document.createTextNode(` and ${r.also.tag} waits on your answer`));
      li.append(also);
    }
    return li;
  }

  const order = () => orderOf(inbox, open);
  const rowOf = (id) => list.querySelector(`.hx-inbox-row[data-id="${CSS.escape(id)}"]`);

  function choose(id, { focus = true } = {}) {
    if (!id) return;
    hooks.pick(id);
    const el = rowOf(id);
    if (el && focus) el.querySelector('[data-inbox-open]').focus();
  }

  function onClick(e) {
    const t = e.target && e.target.closest ? e.target : null;
    if (!t || !root.contains(t)) return;
    const fold = t.closest('[data-inbox-group]');
    if (fold) { const k = fold.dataset.inboxGroup; if (open.has(k)) open.delete(k); else open.add(k); hooks.refresh(); return; }
    const go = t.closest('[data-inbox-act]');
    if (go) { e.stopPropagation(); hooks.act(go.dataset.inboxAct); return; }
    const row = t.closest('.hx-inbox-row');
    if (row) choose(row.dataset.id, { focus: false });
  }

  function onKey(e) {
    if (root.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (!t || !root.contains(t) || (t.closest && t.closest('input, textarea, select'))) return;
    const ids = order();
    const cur = t.closest('.hx-inbox-row') ? t.closest('.hx-inbox-row').dataset.id : selected;
    const i = ids.indexOf(cur);
    let to = null;
    if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown') to = ids[Math.min(ids.length - 1, i + 1)] ?? ids[0];
    else if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowUp') to = ids[Math.max(0, i - 1)] ?? ids[0];
    else if (e.key === 'Enter' && cur && t.closest('.hx-inbox-row')) { e.preventDefault(); hooks.act(cur); return; }
    else return;
    e.preventDefault();
    if (to) choose(to);
  }

  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);

  return {
    paint,
    /** The focus on the selected row, else the first */
    focus() { const el = (selected && rowOf(selected)) || list.querySelector('.hx-inbox-row'); if (el) el.querySelector('[data-inbox-open]').focus(); },
    /** The row of the selection and the next one in the order (the selection moves there after an action: D6) */
    order,
    destroy() { root.removeEventListener('click', onClick); root.removeEventListener('keydown', onKey); root.remove(); },
    el: root,
  };
}
