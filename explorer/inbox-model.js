/**
 * @module explorer/inbox-model
 *
 * The Work inbox's rules, the pure half (spec 0016 D2 to D4): no DOM, no `window`, no clock of its own. From the server's work graph
 * (server/work-graph.js: `{ nodes, edges }`) it works out which group each piece of work is in, why (in words), its one action, the order, and
 * a waiting run folded into the spec it asks about. The page draws it (explorer/pieces/inbox.js).
 *
 *   inboxOf(graph, { now })  -> { groups: { waiting, move, unclaimed, motion, done }, rows, drafts, count, rowsWaiting }
 *
 * A row: `{ id, item, group, why, bad, action, counted, also }`. `action` is `{ key, label }`, the key one of ACTIONS (what the node panel already does);
 * `counted` is spec 0010 D1's rule (`item.waiting`), so `count` is the number the Work button shows; `also` is the row of a waiting run folded into it (D4).
 * Nothing here files, archives or hides a row by hand (D7): a row moves only when the graph says its state moved.
 */

import { tagOf } from './work-model.js';

/** The groups, in the queue's order (D2), with their words, and whether each starts open */
export const GROUPS = Object.freeze([
  { key: 'waiting', title: 'Waiting on you', hint: '', open: true },
  { key: 'move', title: 'Your move', hint: 'not counted', open: true },
  { key: 'unclaimed', title: 'Nobody on it', hint: 'not counted', open: true },
  { key: 'motion', title: 'In motion', hint: '', open: false },
  { key: 'done', title: 'Done lately', hint: '', open: false },
]);
export const GROUP_KEYS = Object.freeze(GROUPS.map((g) => g.key));

/** The actions a row offers: each is one the node panel already has (spec 0012 D5), with its confirm step and server checks */
export const ACTIONS = Object.freeze({
  review: 'Review',
  'review-change': 'Review the change',
  answer: 'Answer',
  land: 'Land it',
  rerun: 'Re-run failed',
  retry: 'Start again',
  agent: 'Start an agent',
  reply: 'Reply',
  logs: 'Logs',
});
const act = (key, label = ACTIONS[key]) => ({ key, label });

const text = (v) => (typeof v === 'string' ? v : '');
const cap = (s) => text(s).replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "lint failed · test running · 1 passed", from a pull request's `checks` (server/work-graph.js `checkCounts`); '' with none */
export function checkWords(checks) {
  if (!checks) return '';
  const names = (list, n) => (list && list.length ? list.join(', ') + (n > list.length ? ` and ${n - list.length} more` : '') : plural(n, 'check'));
  return [
    checks.failed ? `${names(checks.failedNames, checks.failed)} failed` : '',
    checks.running ? `${names(checks.runningNames, checks.running)} running` : '',
    checks.passed ? `${checks.passed} passed` : '',
  ].filter(Boolean).join(' · ');
}

/**
 * A thread folded into a spec (spec 0015 D2): every line of it is `discusses` or `became` to a proposal. Such a thread is not a row.
 * @param {string} id
 * @param {{ from: string, to: string, rel: string }[]} edges
 * @param {Map<string, any>} byId
 */
export function isFoldedThread(id, edges, byId) {
  const mine = edges.filter((e) => e.from === id || e.to === id);
  if (!mine.length) return false;
  return mine.every((e) => e.from === id && (e.rel === 'discusses' || e.rel === 'became') && byId.has(e.to) && byId.get(e.to).kind === 'proposal');
}

/**
 * Where a piece of work goes, and why (D2). Null: it is not a row (a folded thread, a local draft: drafts are a count).
 * @param {any} item a node of the server's graph
 * @param {{ edges: any[], byId: Map<string, any> }} ctx
 * @returns {{ group: string, why: string, bad?: boolean, action: { key: string, label: string } | null } | null}
 */
export function placeOf(item, { edges, byId }) {
  switch (item.kind) {
    case 'proposal':
      if (item.state === 'local') return null;
      if (item.waiting && item.state === 'changed') return { group: 'waiting', why: 'Changed since you approved it', action: act('review-change') };
      if (item.waiting) return { group: 'waiting', why: 'Ready for your decision', action: act('review') };
      if (!item.open) return { group: 'done', why: cap(item.state), action: null };
      if (item.state === 'approved') return { group: 'move', why: 'Approved: landing it merges the spec', action: act('land') };
      if (item.state === 'sent-back') return { group: 'motion', why: 'Sent back: with the agent until it pushes', action: null };
      if (item.state === 'draft-pr') return { group: 'motion', why: 'A draft pull request: the agent is still writing it', action: null };
      return { group: 'motion', why: cap(item.state), action: null };
    case 'run': {
      if (item.waiting) return { group: 'waiting', why: text(item.note) || 'Waiting on your answer', action: act('answer') };
      if (item.state === 'failed') return { group: 'move', why: `Failed${item.note ? `: ${item.note}` : ''}`, bad: true, action: act('retry') };
      if (item.state === 'done' && item.pull && item.pull.state === 'open') return { group: 'move', why: `Done: PR #${item.pull.number} is open${item.note ? `. ${item.note}` : ''}`, action: act('land', `Land PR #${item.pull.number}`) };
      if (item.open) return { group: 'motion', why: `${cap(item.state)}${item.note ? `: ${item.note}` : ''}`, action: null };
      return { group: 'done', why: text(item.note) || cap(item.state), action: null };
    }
    case 'pull': {
      if (!item.open) return { group: 'done', why: cap(item.state), action: null };
      const words = checkWords(item.checks);
      if (item.checks && item.checks.failed) return { group: 'move', why: words, bad: true, action: act('rerun') };
      return { group: 'motion', why: words || (item.draft ? 'Draft' : 'Open'), action: null };
    }
    case 'issue': {
      if (!item.open) return { group: 'done', why: 'Closed', action: null };
      const live = edges.filter((e) => e.from === item.id && e.rel === 'agent-on').map((e) => byId.get(e.to)).filter((r) => r && r.open);
      if (live.length) return { group: 'motion', why: `${plural(live.length, 'agent run')} on it`, action: null };
      return { group: 'unclaimed', why: 'Nobody is on it', action: act('agent') };
    }
    case 'thread': {
      if (isFoldedThread(item.id, edges, byId)) return null;
      if (!item.open) return { group: 'done', why: 'Closed', action: null };
      const spec = edges.some((e) => e.from === item.id && (e.rel === 'became' || e.rel === 'discusses'));
      if (spec) return { group: 'motion', why: 'A spec is being written from it', action: null };
      return { group: 'unclaimed', why: 'No spec yet', action: act('reply') };
    }
    case 'deploy':
      if (item.state === 'running' || item.state === 'queued') return { group: 'motion', why: cap(item.state), action: act('logs') };
      return { group: 'done', why: item.state === 'failure' ? 'Failed' : cap(item.state), bad: item.state === 'failure', action: null };
    default: return null;
  }
}

const time = (iso) => { const t = Date.parse(text(iso)); return Number.isFinite(t) ? t : 0; };
/** Oldest first, so what has waited longest is on top (D2); Done lately newest first; then by id, so the order is the same for the same graph */
const oldest = (a, b) => time(a.item.updated) - time(b.item.updated) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const newest = (a, b) => time(b.item.updated) - time(a.item.updated) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The inbox of a work graph (D2 to D4).
 * @param {{ nodes?: any[], edges?: any[] } | null} graph the server's answer
 */
export function inboxOf(graph) {
  const nodes = (graph && Array.isArray(graph.nodes) ? graph.nodes : []).filter((n) => n && n.kind !== 'code' && typeof n.id === 'string');
  const edges = graph && Array.isArray(graph.edges) ? graph.edges : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rows = [];
  let drafts = 0;
  for (const item of nodes) {
    if (item.kind === 'proposal' && item.state === 'local') { drafts += 1; continue; }
    const place = placeOf(item, { edges, byId });
    if (!place) continue;
    rows.push({ id: item.id, item, tag: tagOf(item), group: place.group, why: place.why, bad: place.bad === true, action: place.action, counted: item.waiting === true, also: null, folded: false });
  }
  // D4: a waiting run about a spec that also waits rides in the spec's row
  for (const r of rows) {
    const slug = r.item.kind === 'run' && r.group === 'waiting' ? edges.find((e) => e.to === r.id && e.rel === 'agent-on' && byId.has(e.from) && byId.get(e.from).kind === 'proposal') : null;
    if (!slug) continue;
    const host = rows.find((x) => x.id === slug.from && x.group === 'waiting' && !x.also);
    if (host) { host.also = r; r.folded = true; }
  }
  const groups = Object.fromEntries(GROUP_KEYS.map((k) => [k, rows.filter((r) => r.group === k && !r.folded).sort(k === 'done' ? newest : oldest)]));
  const count = rows.filter((r) => r.counted).length;
  return { groups, rows, drafts, count, rowsWaiting: groups.waiting.length };
}

/** The queue's heading: "4 waiting on you in 3 rows", "1 waiting on you", "Nothing waits on you" */
export function headingOf({ count, rowsWaiting }) {
  if (!count) return 'Nothing waits on you';
  return `${count} waiting on you${rowsWaiting !== count ? ` in ${plural(rowsWaiting, 'row')}` : ''}`;
}

/** What a screen reader hears when the Inbox opens (D6): "Inbox: 4 waiting on you in 3 rows, 4 your move, 1 nobody on it." */
export function openedWords(inbox) {
  const parts = [headingOf(inbox).replace(/^Nothing waits on you$/, 'nothing waits on you')];
  if (inbox.groups.move.length) parts.push(`${inbox.groups.move.length} your move`);
  if (inbox.groups.unclaimed.length) parts.push(`${inbox.groups.unclaimed.length} nobody on it`);
  return `Inbox: ${parts.join(', ')}.`;
}

/** The ids in the order J and K move through them: the open groups' rows, top to bottom (D6) */
export function orderOf(inbox, open = new Set(GROUPS.filter((g) => g.open).map((g) => g.key))) {
  return GROUP_KEYS.filter((k) => open.has(k)).flatMap((k) => inbox.groups[k].map((r) => r.id));
}

/** The row after an action: the next one in the order, else the one before, else none (D6) */
export function nextAfter(order, id) {
  const i = order.indexOf(id);
  if (i < 0) return order[0] ?? null;
  return order[i + 1] ?? order[i - 1] ?? null;
}

/** A row read out: its tag, title, why and how long ago (D6) */
export function rowWords(row, ago) {
  return `${row.tag}, ${text(row.item.title)}. ${row.why}${row.also ? `, and ${row.also.tag} waits on your answer` : ''}. ${ago}.`;
}
