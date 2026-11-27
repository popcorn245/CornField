/**
 * @module explorer/pieces/inbox
 *
 * The Work inbox in cornfield's page (spec 0016 D1, D2, D5 to D8): the queue of what needs you, over the Work view's stage, beside the node panel. Its rules are
 * inbox-model.js (pure); work-view.js owns the read of the graph and the Inbox · Graph toggle, and mounts this once.
 *
 *   mount(stage, { pick, act, announce, refresh, colorOf, say, showOnMap, toGraph, now })  -> { paint(graph, { on, selected, scene }), focus(), destroy() }
 *
 * `pick(id)` selects a piece of work (the node panel opens on it, with its actions: spec 0015's action bar); `act(id, key)` selects it and presses the node panel's own control for
 * that action (`key`, inbox-model.js ACTIONS), with its confirm step. Every word from the forge is set as text, never as HTML. J and K (and the arrows) move through the open groups,
 * Enter acts, a group's header folds it. Nothing is filed by hand (D7): a row moves when the graph says its state moved.
 * Beside the queue, once a row is picked, is **Around it** (D5): a small drawing of the work it is linked to (left; each selects it) and the code it touches grouped by
 * app (right; solid for changes, dashed for adds; each shows it on the map), then Show in Graph. Its labels are the page's `strings` (`say`: core/strings.js).
 */

import { GROUPS, ACTIONS, inboxOf, aroundOf, headingOf, openedWords, orderOf, rowWords } from '../inbox-model.js';
import { relativeTime } from '../review-model.js';
import { tagOf } from '../work-model.js';

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
/** A scene node's tag ("Spec 0100"), from the forge's item it carries */
const rowTag = (node) => tagOf(node.item);
const make = (tag, cls, words) => { const el = document.createElement(tag); if (cls) el.className = cls; if (words != null) el.textContent = words; return el; };

/**
 * @param {HTMLElement} stage the Work view's stage (the map's box)
 * @param {{ pick: (id: string) => boolean, act: (id: string, key: string) => void, announce: (words: string) => void, now?: () => number, refresh: () => void, colorOf?: (kind: string) => string,
 *   say?: (key: string) => string, showOnMap?: (id: string) => void, toGraph?: () => void }} hooks
 */
export function mount(stage, hooks) {
  const now = hooks.now || (() => Date.now());
  /** The page's words for a key (core/strings.js), the override if the config has one */
  const t = (key) => (hooks.say ? hooks.say(key) : key);
  const titleOf = (key) => ({ waiting: t('inboxWaiting'), move: t('inboxMove'), unclaimed: t('inboxUnclaimed'), motion: t('inMotion'), done: t('inboxDone') })[key] || key;
  const ACTION_WORDS = { review: () => t('review'), answer: () => t('answer'), land: () => t('landIt'), rerun: () => t('rerunFailed'), retry: () => t('startAgain'), agent: () => t('startAgent'), reply: () => t('reply') };
  /** A row's action in the page's words; a label the row made its own ("Land PR #14") stays */
  const actionWords = (a) => (a.label === ACTIONS[a.key] && ACTION_WORDS[a.key] ? ACTION_WORDS[a.key]() : a.label);
  const color = (kind) => (hooks.colorOf ? hooks.colorOf(kind) : '');
  const root = make('section', 'hx-inbox');
  root.dataset.corn = 'inbox';
  root.setAttribute('part', 'inbox');
  root.setAttribute('aria-label', t('inbox'));
  root.hidden = true;
  const queue = make('div', 'hx-inbox-queue');
  const head = make('div', 'hx-inbox-head');
  const title = make('h2', 'hx-inbox-title', t('inbox'));
  const sub = make('span', 'hx-inbox-sub');
  head.append(title, sub);
  const list = make('div', 'hx-inbox-groups');
  queue.append(head, list);
  const side = make('div', 'hx-inbox-side');
  const aside = make('p', 'hx-inbox-pick', 'Pick a row: what it needs opens beside the queue, and what is around it here.');
  aside.dataset.corn = 'hint';
  aside.setAttribute('part', 'hint');
  side.append(aside);
  root.append(queue, side);
  stage.append(root);

  /** which groups are open: the ones GROUPS starts open, then as the viewer folds them (kept while the page is open) */
  const open = new Set(GROUPS.filter((g) => g.open).map((g) => g.key));
  let inbox = inboxOf(null);
  let selected = null;
  let was = false;

  function paint(graph, { on, selected: sel = null, scene = null } = {}) {
    root.hidden = !on;
    if (!on) { was = false; return; }
    inbox = inboxOf(graph);
    selected = sel;
    root.setAttribute('aria-label', t('inbox'));
    title.textContent = t('inbox');
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
      btn.append(make('span', 'hx-inbox-group-title', titleOf(g.key)), counted(rows.length));
      if (g.hint) btn.append(make('span', 'hx-inbox-hint', g.hint));
      group.append(btn);
      if (isOpen) {
        const ul = make('ul', 'hx-inbox-rows');
        ul.setAttribute('aria-label', titleOf(g.key));
        for (const r of rows) ul.append(rowEl(r, g.key));
        group.append(ul);
      }
      list.append(group);
    }
    if (inbox.drafts) {
      const d = make('p', 'hx-inbox-drafts');
      d.append(make('span', 'hx-inbox-group-title', t('drafts')), counted(inbox.drafts), make('span', 'hx-inbox-hint', 'in the checkout: nobody has been asked to decide them'));
      list.append(d);
    }
    const around = selected ? aroundOf(selected, scene) : null;
    root.classList.toggle('is-picked', !!around);
    paintAround(around);
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
      const go = make('button', `hx-inbox-act${group === 'waiting' ? ' is-primary' : ''}`, actionWords(r.action));
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

  /** Around it (D5), beside the queue: null while nothing is picked (the hint says what picking does) */
  function paintAround(a) {
    side.textContent = '';
    if (!a) { side.append(aside); return; }
    const box = make('section', 'hx-inbox-around');
    box.dataset.corn = 'section';
    box.setAttribute('part', 'section');
    box.dataset.group = 'around';
    const h = make('h3', 'hx-inbox-around-title', t('aroundIt'));
    h.id = 'hx-inbox-around-title';
    box.setAttribute('aria-labelledby', h.id);
    const what = make('p', 'hx-inbox-around-what');
    what.append(glyph(a.item.work, color(a.item.work)), tagged(a.item.item ? rowTag(a.item) : ''), make('span', 'hx-inbox-around-name', String(a.item.title || '')));
    box.append(h, what, drawing(a));
    const cols = make('div', 'hx-inbox-around-cols');
    const left = make('div', 'hx-inbox-around-col');
    left.append(make('h4', 'hx-inbox-around-head', 'Linked work'));
    if (a.work.length) {
      const ul = make('ul', 'hx-inbox-around-list');
      ul.dataset.corn = 'work-links';
      ul.setAttribute('part', 'work-links');
      for (const w of a.work) {
        const li = make('li', 'hx-inbox-around-item');
        li.dataset.corn = 'work-link';
        li.setAttribute('part', 'work-link');
        const b = make('button', 'hx-inbox-around-btn');
        b.type = 'button';
        b.dataset.inboxAround = w.id;
        b.append(glyph(w.kind, color(w.kind)), make('span', 'hx-inbox-around-word', w.word), tagged(w.tag), make('span', 'hx-inbox-around-name', w.title));
        li.append(b);
        ul.append(li);
      }
      left.append(ul);
      if (a.moreWork) left.append(make('p', 'hx-inbox-around-more', `and ${a.moreWork} more in the node panel`));
    } else left.append(make('p', 'hx-inbox-around-none', 'Nothing else is linked to it.'));
    const right = make('div', 'hx-inbox-around-col');
    const codeHead = make('h4', 'hx-inbox-around-head', 'Code it touches');
    if (a.code) codeHead.append(' ', counted(a.code));
    right.append(codeHead);
    if (!a.areas.length) right.append(make('p', 'hx-inbox-around-none', 'It touches no code on this map.'));
    for (const g of a.areas) {
      const area = make('div', `hx-inbox-area${g.adds ? ' is-adds' : ''}`);
      area.append(make('p', 'hx-inbox-area-name', g.label));
      const ul = make('ul', 'hx-inbox-around-list');
      ul.setAttribute('aria-label', g.label);
      for (const c of g.items) {
        const li = make('li', 'hx-inbox-around-item');
        const words = [make('span', 'hx-inbox-around-word', c.rel), make('span', 'hx-inbox-around-name', c.label)];
        if (c.mapped) {
          const b = make('button', 'hx-inbox-around-btn');
          b.type = 'button';
          b.dataset.inboxMap = c.id;
          b.title = 'Show it on the map';
          b.append(...words);
          li.append(b);
        } else { li.classList.add('is-plain'); li.append(...words, make('span', 'hx-inbox-around-planned', 'planned')); }
        ul.append(li);
      }
      area.append(ul);
      if (g.more) area.append(make('p', 'hx-inbox-around-more', `and ${g.more} more`));
      right.append(area);
    }
    if (a.moreAreas) right.append(make('p', 'hx-inbox-around-more', `and ${a.moreAreas} more apps`));
    cols.append(left, right);
    const foot = make('div', 'hx-inbox-around-foot');
    const graph = make('button', 'hx-inbox-around-graph', `Show in ${t('graph')}`);
    graph.type = 'button';
    graph.dataset.inboxGraph = '';
    foot.append(graph);
    box.append(cols, foot);
    side.append(box);
  }

  /** The picture of Around it: the work in the middle, what it is linked to on the left, the apps it touches on the right (dashed where it only adds). Decorative: the lists say it */
  function drawing(a) {
    const ns = 'http://www.w3.org/2000/svg';
    const rows = Math.max(1, a.work.length, a.areas.length);
    const H = rows * 28 + 16;
    const W = 320;
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'hx-inbox-around-map');
    svg.setAttribute('aria-hidden', 'true');
    const cy = H / 2;
    const yAt = (i, n) => (H - n * 28) / 2 + 14 + i * 28;
    const line = (x1, y1, x2, y2, dashed) => {
      const l = document.createElementNS(ns, 'line');
      for (const [k, v] of Object.entries({ x1, y1, x2, y2 })) l.setAttribute(k, String(v));
      l.setAttribute('class', `hx-inbox-around-line${dashed ? ' is-adds' : ''}`);
      svg.append(l);
    };
    const mark = (kind, x, y, size) => {
      const g = glyph(kind, color(kind));
      g.setAttribute('x', String(x - size / 2));
      g.setAttribute('y', String(y - size / 2));
      g.setAttribute('width', String(size));
      g.setAttribute('height', String(size));
      svg.append(g);
    };
    a.work.forEach((w, i) => line(W / 2, cy, 40, yAt(i, a.work.length), false));
    a.areas.forEach((g, i) => line(W / 2, cy, W - 40, yAt(i, a.areas.length), g.adds));
    a.work.forEach((w, i) => mark(w.kind, 40, yAt(i, a.work.length), 14));
    a.areas.forEach((g, i) => {
      const r = document.createElementNS(ns, 'rect');
      const y = yAt(i, a.areas.length);
      for (const [k, v] of Object.entries({ x: W - 47, y: y - 7, width: 14, height: 14, rx: 3 })) r.setAttribute(k, String(v));
      r.setAttribute('class', `hx-inbox-around-app${g.adds ? ' is-adds' : ''}`);
      svg.append(r);
    });
    mark(a.item.work, W / 2, cy, 22);
    return svg;
  }

  /** A row's action: its work and which action, for the node panel to press (work-view.js `actOn`); a row with none is only picked */
  function act(id) {
    const row = inbox.rows.find((r) => r.id === id);
    if (row && row.action) hooks.act(id, row.action.key);
    else hooks.pick(id);
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
    const el = e.target && e.target.closest ? e.target : null;
    if (!el || !root.contains(el)) return;
    const around = el.closest('[data-inbox-around]');
    if (around) { hooks.pick(around.dataset.inboxAround); return; }
    const onMap = el.closest('[data-inbox-map]');
    if (onMap) { if (hooks.showOnMap) hooks.showOnMap(onMap.dataset.inboxMap); return; }
    if (el.closest('[data-inbox-graph]')) { if (hooks.toGraph) hooks.toGraph(); return; }
    const fold = el.closest('[data-inbox-group]');
    if (fold) { const k = fold.dataset.inboxGroup; if (open.has(k)) open.delete(k); else open.add(k); hooks.refresh(); return; }
    const go = el.closest('[data-inbox-act]');
    if (go) { e.stopPropagation(); act(go.dataset.inboxAct); return; }
    const row = el.closest('.hx-inbox-row');
    if (row) choose(row.dataset.id, { focus: false });
  }

  function onKey(e) {
    if (root.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target;
    if (!el || !root.contains(el) || !queue.contains(el) || (el.closest && el.closest('input, textarea, select'))) return;
    const ids = order();
    const cur = el.closest('.hx-inbox-row') ? el.closest('.hx-inbox-row').dataset.id : selected;
    const i = ids.indexOf(cur);
    let to = null;
    if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown') to = ids[Math.min(ids.length - 1, i + 1)] ?? ids[0];
    else if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowUp') to = ids[Math.max(0, i - 1)] ?? ids[0];
    else if (e.key === 'Enter' && cur && el.closest('.hx-inbox-row')) { e.preventDefault(); act(cur); return; }
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
