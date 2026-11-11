/**
 * @module explorer/proposal-model
 *
 * The pure half of the proposal overlay (spec 0012 B2, TOPO-09): no DOM, no `window`, no
 * fetch. scene.js (what the three views show and dim), panels.js (the before / after rows) and the
 * tests import it; proposal.js is the half that touches the page (the picker, the chip, the
 * Before / Diff / After control).
 *
 * A loaded proposal turns the map into `applyProposal(base, proposal)` (core/proposal.js):
 * every node and edge carries a `mark` (`none | added | changed | removed`, later `edit`), and a
 * changed one a `before` (the old value of each field it changes) and a `why`. What the viewer
 * shows of that is a function of the VIEW:
 *
 *   before  the map as it is: what the proposal adds is hidden, the changed fields read as they were, no marks
 *   diff    everything, marks on, everything the proposal does not touch dimmed (but still visible)
 *   after   the map as it would be: what the proposal removes is hidden, no marks
 *
 * Switching the view never moves a node: all three draw the same positions.
 */

import { escHtml } from './state.js';
import { markStateAttr, stateIconHtml } from './corn-state.js';
import { specStateOf, specStateWords, SPEC_STATE_WORDS, SPEC_STATE_CORN } from './waiting-model.js';

export const PROPOSAL_VIEWS = ['before', 'diff', 'after'];

/** The marks a proposal puts on the map, in the order the counts chip and the legend list them */
export const MARKS = ['added', 'changed', 'removed'];

const hasMark = (item) => !!item && !!item.mark && item.mark !== 'none';

/**
 * What a marked item IS, under the mark it is drawn with: a what-if `edit` (whatif-model.js) is drawn in violet
 * but is still an addition or a removal (`editOp`), and the views and the layout treat it as one.
 * @returns {'none'|'added'|'changed'|'removed'}
 */
export const kindOfMark = (item) => (item.mark === 'edit' ? item.editOp || 'none' : item.mark || 'none');

// ---------------------------------------------------------------------------
//  What each view shows
// ---------------------------------------------------------------------------

/** Is this node drawn in `view`? (`view` null = no proposal is open: everything is) */
export function showsNode(view, node) {
  if (view === 'before') return kindOfMark(node) !== 'added';
  if (view === 'after') return kindOfMark(node) !== 'removed';
  return true;
}

/** Is this edge drawn in `view`? The same rule: Before hides what is added, After what is removed */
export function showsEdge(view, edge) {
  return showsNode(view, edge);
}

/**
 * The mark a scene carries in `view`: the proposal's own in Diff and none in Before and After; a
 * what-if `edit` is the maintainer's own and shows in all three.
 * @returns {'none'|'added'|'changed'|'removed'|'edit'}
 */
export function markIn(view, item) {
  const mark = item.mark || 'none';
  if (mark === 'edit') return 'edit';
  return view === 'diff' ? mark : 'none';
}

/**
 * A changed node or edge as it was before the proposal: each field in `before` is put back
 * (`null` there means the item did not have it, so it is dropped). Anything else comes back as it is.
 */
export function beforeOf(item) {
  if (item.mark !== 'changed' || !item.before) return item;
  const out = { ...item };
  for (const [field, value] of Object.entries(item.before)) {
    if (value === null) delete out[field];
    else out[field] = value;
  }
  return out;
}

/**
 * Which nodes a proposal touches, for dimming and for fitting the camera.
 *  - `touched`: nodes with a mark, and both ends of a marked edge: what Diff keeps bright
 *  - `near`: `touched` and what they connect to, except the children a touched node owns (a touched
 *    app would otherwise bring all its hundreds of pages): what the camera fits
 * @param {{id:string, mark?:string}[]} nodes
 * @param {{from:string, to:string, kind?:string, dashed?:boolean, mark?:string}[]} edges
 */
export function touchedIds(nodes, edges) {
  const touched = new Set();
  for (const n of nodes) if (hasMark(n)) touched.add(n.id);
  for (const e of edges) if (hasMark(e)) { touched.add(e.from); touched.add(e.to); }
  const near = new Set(touched);
  for (const e of edges) {
    const owns = !e.kind && !e.dashed;
    if (touched.has(e.from) && !(owns && !touched.has(e.to))) near.add(e.to);
    if (touched.has(e.to)) near.add(e.from);
  }
  return { touched, near };
}

// ---------------------------------------------------------------------------
//  The counts chip, the legend, the address
// ---------------------------------------------------------------------------

/**
 * "4 nodes, 2 edges added · 1 node changed" (the bar's words, without the scenarios), or "3 added · 1 changed" for counts
 * without the split: zero counts are left out; nothing at all reads "No changes".
 * @param {{added?:number, changed?:number, removed?:number}} counts `summarize(proposal)`
 */
export function chipText(counts) {
  const parts = barCounts({ ...counts, scenarios: 0 }).filter((c) => c.mark).map((c) => c.text.replace(/^\+/, ''));
  return parts.length ? parts.join(' · ') : 'No changes';
}

/**
 * The counts on the toolbar as parts, so each mark can carry its dot: "+4 added", "1 changed", "1 removed", then
 * "3 scenarios". Zero counts are left out; nothing at all reads "No changes".
 * @param {{added?:number, changed?:number, removed?:number, scenarios?:number}} counts `summarize(proposal)`
 * @returns {{mark: string|null, text: string}[]}
 */
export function barCounts(counts) {
  const n = (k) => counts?.[k] || 0;
  // with the split (`summarize` gives it) the chip says what it counts: "4 nodes, 2 edges added"; without, the bare number
  const unit = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
  const what = (m) => {
    const ns = counts?.nodes?.[m] || 0;
    const es = counts?.edges?.[m] || 0;
    if (!counts?.nodes || ns + es !== n(m)) return `${m === 'added' ? '+' : ''}${n(m)} ${m}`;
    return `${[ns && unit(ns, 'node'), es && unit(es, 'edge')].filter(Boolean).join(', ')} ${m}`;
  };
  const parts = MARKS.filter((m) => n(m) > 0).map((m) => ({ mark: m, text: what(m) }));
  if (n('scenarios') > 0) parts.push({ mark: null, text: `${n('scenarios')} ${n('scenarios') === 1 ? 'scenario' : 'scenarios'}` });
  return parts.length ? parts : [{ mark: null, text: 'No changes' }];
}

/** What a screen reader hears when a view is picked: "Diff view" */
export const viewWords = (view) => `${view === 'before' ? 'Before' : view === 'after' ? 'After' : 'Diff'} view`;

/**
 * What it hears when a proposal has loaded: its title and counts, and the view it is in
 * ("Proposal Alerts: 4 nodes and 2 edges added, 1 node changed, 3 scenarios. Diff view.": in speech a comma would split a part in two).
 * @param {string} title
 * @param {object} counts `summarize(proposal)`
 * @param {'before'|'diff'|'after'} view
 */
export const openedWords = (title, counts, view) => `Proposal ${title}: ${barCounts(counts).map((c) => c.text.replace(/^\+/, '').replace(', ', ' and ')).join(', ')}. ${viewWords(view)}.`;

/** What a click on a change row did: the node (or edge) the camera went to, and what the proposal does to it */
export const jumpWords = (markWord, name) => `${name}, ${String(markWord).toLowerCase()}. The map is on it.`;

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * What `/?proposal=<slug>&source=<where>&proposalView=<view>` asks for, or null when it does not
 * ask for a proposal (or asks for one that cannot be a file name: the server would refuse it anyway).
 * @param {string} search `location.search`
 * @returns {{slug: string, source: string|null, view: 'before'|'diff'|'after'|null}|null}
 */
export function parseProposalQuery(search) {
  const params = new URLSearchParams(search || '');
  const slug = params.get('proposal');
  if (!slug || !SLUG.test(slug)) return null;
  const source = params.get('source');
  const view = params.get('proposalView');
  return { slug, source: source || null, view: PROPOSAL_VIEWS.includes(view) ? view : null };
}

// ---------------------------------------------------------------------------
//  The panel: why, and what changes
// ---------------------------------------------------------------------------

/** A value as the panel prints it: text as it is, anything else as compact JSON, `null` as nothing */
export function showValue(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Fields the panel does not list for an added item: how it is drawn and what only the map uses */
const HIDDEN_FIELDS = ['mark', 'editOp', 'before', 'why', 'x', 'y', 'r', 'baseR', 'degree', 'scaleDelta', 'color', 'from', 'to'];

/**
 * The rows the panel shows for a marked node or edge.
 *  - added:   each field it was written with, `before` empty
 *  - changed: each field that changed, with its old and new value
 *  - removed: none (its `why` says it all)
 * @returns {{field: string, before: string, after: string}[]}
 */
export function fieldRows(item) {
  if (kindOfMark(item) === 'added') {
    return Object.keys(item)
      .filter((k) => !HIDDEN_FIELDS.includes(k) && item[k] !== undefined)
      .map((field) => ({ field, before: '', after: showValue(item[field]) }));
  }
  if (item.mark === 'changed' && item.before) {
    return Object.keys(item.before).map((field) => ({ field, before: showValue(item.before[field]), after: showValue(item[field]) }));
  }
  return [];
}

/** The verb the panel uses for a mark */
export const MARK_WORDS = { added: 'Added', changed: 'Changed', removed: 'Removed', edit: 'Your edit' };

/**
 * The panel's "Proposal" block for a marked node or edge: what it is (added, changed, removed),
 * why, and the fields; for a change each field before and after. Empty for something the proposal
 * does not touch. All text is escaped.
 */
export function proposalPanelHtml(item) {
  if (!hasMark(item)) return '';
  const rows = fieldRows(item);
  const body = rows.map((r) => (item.mark === 'changed'
    ? `<div class="hx-change" data-corn="field-change"><span class="hx-change-field">${escHtml(r.field)}</span><span class="hx-change-before">${escHtml(r.before) || '<em>nothing</em>'}</span><span class="hx-change-arrow" aria-hidden="true">→</span><span class="hx-change-after">${escHtml(r.after) || '<em>nothing</em>'}</span></div>`
    : `<div class="hx-change" data-corn="field-change"><span class="hx-change-field">${escHtml(r.field)}</span><span class="hx-change-after">${escHtml(r.after)}</span></div>`)).join('');
  return `<div class="hx-sec hx-proposal-sec hx-proposal-sec--${escHtml(item.mark)}" data-proposal-mark="${escHtml(item.mark)}" data-corn="section">
    <strong class="hx-strong"><span class="hx-mark-dot hx-mark-dot--${escHtml(item.mark)}" data-corn="mark-dot"${markStateAttr(item.mark)}></span>${escHtml(item.mark === 'edit' ? `${item.editOp === 'removed' ? 'Removed' : 'Added'} by your edit` : `${MARK_WORDS[item.mark] || item.mark} by this proposal`)}</strong>
    ${item.why ? `<div class="hx-why">${escHtml(item.why)}</div>` : ''}
    ${body}
  </div>`;
}

// ---------------------------------------------------------------------------
//  A proposal as a row of the Work panel's Specs tab
// ---------------------------------------------------------------------------

/** Where a listing entry is, as a line of meta: "PR #11", or the checkout or worktree it is in; a proposal that is also somewhere else says so ("PR #11, and a copy in the checkout") */
export function specWhere(entry) {
  const place = (source) => (source === 'checkout' ? 'the checkout' : `worktree ${source}`);
  const copies = Array.isArray(entry.also) ? entry.also : [];
  if (entry.pull) return `PR #${entry.pull.number}${copies.length ? `, and a copy in ${copies.map(place).join(' and ')}` : ''}`;
  return `in ${place(entry.source)}${copies.length ? `, and in ${copies.map(place).join(' and ')}` : ''}`;
}

/**
 * One row for each proposal. A proposal that is a draft in a checkout or a worktree and also on a spec PR is listed twice by the server (the two
 * are different sources); here it is one row, the PR's (the one that can be reviewed), which says there is a local copy too (`also`: the sources
 * of the copies). Local copies only (a checkout and a worktree) are one row as well. An entry that could not be read is never hidden behind
 * another: its row stays and says why. Spec PRs come first (open, then draft), then local drafts; within each, the listing's order.
 * @template T
 * @param {T[]} entries the server's listing
 * @returns {T[]}
 */
export function mergeSpecs(entries) {
  const groups = new Map();
  for (const entry of entries || []) groups.set(entry.slug, [...(groups.get(entry.slug) || []), entry]);
  const out = [];
  for (const group of groups.values()) {
    const read = group.filter((e) => !e.error);
    const prs = read.filter((e) => e.pull);
    const locals = read.filter((e) => !e.pull);
    const also = (list) => (list.length ? { also: list.map((e) => e.source) } : {});
    if (prs.length) out.push({ ...prs[0], ...also(locals) }, ...prs.slice(1));
    else if (locals.length) out.push({ ...locals[0], ...also(locals.slice(1)) });
    out.push(...group.filter((e) => e.error)); // a copy that could not be read keeps its own row, with why
  }
  // The ones a maintainer can review come first: open spec PRs, then draft ones, then the drafts in a checkout (in the listing's order within each)
  const rank = (e) => (e.pull ? (e.pull.draft ? 1 : 0) : 2);
  return out.map((e, i) => [e, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([e]) => e);
}

/**
 * One row: title, a pill that says its review state (To decide, Changed since approved, Sent back, Approved, Draft PR, Local, spec 0010 D4),
 * who and when beside it ("Approved by maintainer-one \u00b7 2 hours ago", "Waiting 2 days"), a line of what it is for, and the meta (spec number,
 * where it is, +added ~changed \u2212removed, scenarios). A review that could not be read says so, with a way to try again, and never looks
 * unreviewed. A proposal that could not be read is a row that says why and opens nothing. Same `open-proposal` action as the Proposals menu's row.
 * What the forge said (a login, a date) is escaped; the pill's state is one of a fixed list.
 * @param {{ slug: string, source: string, title?: string, summary?: string, spec?: string, pull?: {number: number, draft?: boolean}, review?: object | null, counts?: {added?: number, changed?: number, removed?: number, scenarios?: number}, errors?: number, error?: string }} entry
 * @param {{ current?: {slug: string, source: string} | null, nowMs?: number }} [opts] the proposal that is open now; the clock
 */
export function specRowHtml(entry, { current = null, nowMs = Date.now() } = {}) {
  const head = `<span class="hx-forge-title">${escHtml(entry.title || entry.slug)}</span>`;
  if (entry.error) {
    return `<li class="hx-forge-item"><div class="hx-forge-row hx-forge-spec" data-corn="row">${head}<span class="hx-forge-sum hx-error-text">${escHtml(entry.error)}</span><span class="hx-forge-meta">${escHtml(specWhere(entry))}</span></div></li>`;
  }
  const { state } = specStateOf(entry);
  const corn = SPEC_STATE_CORN[state];
  const pill = `<span class="hx-forge-state hx-forge-state--${corn}" data-corn="review-state" data-corn-state="${corn}">${stateIconHtml(corn)}${escHtml(SPEC_STATE_WORDS[state])}</span>`;
  const c = entry.counts || {};
  const said = specStateWords(entry, nowMs);
  const meta = [
    entry.spec ? `<span>spec ${escHtml(entry.spec)}</span>` : '',
    `<span>${escHtml(specWhere(entry))}</span>`,
    said ? `<span class="hx-forge-reviewed">${escHtml(said)}</span>` : '',
    c.added ? `<span class="hx-forge-add" title="${c.added} added">+${c.added}</span>` : '',
    c.changed ? `<span class="hx-forge-chg" title="${c.changed} changed">~${c.changed}</span>` : '',
    c.removed ? `<span class="hx-forge-del" title="${c.removed} removed">\u2212${c.removed}</span>` : '',
    c.scenarios ? `<span>${c.scenarios} ${c.scenarios === 1 ? 'scenario' : 'scenarios'}</span>` : '',
    entry.errors ? `<span class="hx-warn">${entry.errors} ${entry.errors === 1 ? 'problem' : 'problems'}</span>` : '',
  ].filter(Boolean).join('');
  const mine = !!current && current.slug === entry.slug && (current.source === entry.source || (Array.isArray(entry.also) && entry.also.includes(current.source)));
  const unread = state === 'unknown' ? `<p class="hx-forge-meta hx-forge-unread" data-corn="message" data-corn-state="failure">${escHtml(entry.review && entry.review.error ? entry.review.error : 'The forge could not be asked.')} <button type="button" class="hx-btn hx-forge-act" data-corn-kind="quiet" data-action="retry-forge" aria-label="Try again: ${escHtml(entry.title || entry.slug)}">Try again</button></p>` : '';
  return `<li class="hx-forge-item"><button type="button" class="hx-forge-row hx-forge-spec" data-action="open-proposal" data-slug="${escHtml(entry.slug)}" data-source="${escHtml(entry.source)}" aria-pressed="${mine}" data-corn="row">`
    + `<span class="hx-forge-line">${head}${pill}</span>`
    + `${entry.summary ? `<span class="hx-forge-sum">${escHtml(entry.summary)}</span>` : ''}<span class="hx-forge-meta hx-forge-facts">${meta}</span></button>${unread}</li>`;
}

// ---------------------------------------------------------------------------
//  Which copy is open: the chip on the bar, and a link that finds nothing
// ---------------------------------------------------------------------------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The checks on a PR's head in words, for the bar's source chip: "no checks", "1 check running", "2 checks failed, 1 check running",
 * "all 3 checks passed". Failed first, then cancelled, then the ones still going.
 * @param {{ state: string }[]} checks
 */
export function checksLine(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return 'no checks';
  const n = (states) => checks.filter((c) => states.includes(c.state)).length;
  const failed = n(['failure']);
  const cancelled = n(['cancelled']);
  const waiting = n(['running', 'queued']);
  const parts = [];
  if (failed) parts.push(`${plural(failed, 'check')} failed`);
  if (cancelled) parts.push(`${plural(cancelled, 'check')} cancelled`);
  if (waiting) parts.push(`${plural(waiting, 'check')} running`);
  if (parts.length) return parts.join(', ');
  return checks.length === 1 ? '1 check passed' : `all ${checks.length} checks passed`;
}

/** `pull/<n>` to n, or null (the same shape the server reads, server/proposal-pulls.js) */
export function pullNumberOf(source) {
  const m = typeof source === 'string' ? /^pull\/([1-9]\d{0,8})$/.exec(source) : null;
  return m ? Number(m[1]) : null;
}

/** Where a source is, in words: "PR #21", "the checkout", "worktree <name>" */
export function sourceWhere(source) {
  const n = pullNumberOf(source);
  if (n) return `PR #${n}`;
  if (!source || source === 'checkout') return 'the checkout';
  return `worktree ${source}`;
}

/**
 * What the bar's source chip says of the copy under review. A spec PR's copy: "PR #24 · draft · 1 check running" (the state and the checks
 * are left out until known: `pull` is the listing's entry, `checks` the PR's checks, or null when they could not be read). A copy in the checkout
 * or a worktree: "Local draft · in the checkout". `href` is the PR's address when it has one (the caller checks the scheme). `state` is the
 * public `data-corn-state` of the copy (docs/theming.md): the PR's `open`, `draft`, `merged` or `closed`, and `draft` for a local copy (a
 * branch with no pull request yet is `draft`); '' while the PR is not known yet.
 * @param {string|null} source `pull/<n>`, `checkout` or a worktree's name
 * @param {{ draft?: boolean, url?: string, state?: string }|null} [pull]
 * @param {{ state: string }[]|null} [checks]
 * @returns {{ text: string, href: string|null, state: ''|'open'|'draft'|'merged'|'closed', label: string }}
 */
export function sourceChip(source, pull = null, checks = null) {
  const n = pullNumberOf(source);
  if (!n) {
    const where = !source || source === 'checkout' ? 'in the checkout' : `in worktree ${source}`;
    return { text: `Local draft \u00b7 ${where}`, href: null, state: 'draft', label: `This is a local draft, ${where}, not a pull request` };
  }
  const parts = [`PR #${n}`];
  const state = !pull ? '' : pull.state === 'merged' || pull.state === 'closed' ? pull.state : typeof pull.draft === 'boolean' ? (pull.draft ? 'draft' : 'open') : '';
  if (state) parts.push(state);
  if (Array.isArray(checks)) parts.push(checksLine(checks));
  return {
    text: parts.join(' \u00b7 '),
    href: pull && typeof pull.url === 'string' ? pull.url : null,
    state,
    label: `Reviewing spec pull request: ${parts.join(', ')}`,
  };
}

/**
 * What to say when a link names a proposal the server does not have: what was not found, said plainly. The place is named only when it is
 * one: a PR number, the checkout, or a worktree the listing has (`sources`); anything else the link says is not repeated back.
 * @param {string} slug (it passed the slug pattern)
 * @param {string|null} source
 * @param {Set<string>|null} [sources] the sources the listing knows, when it has been read
 */
export function notFoundWords(slug, source, sources = null) {
  if (!source) return `There is no proposal called ${slug}.`;
  if (pullNumberOf(source) || source === 'checkout' || (sources && sources.has(source) && SLUG.test(source))) return `There is no proposal called ${slug} in ${sourceWhere(source)}.`;
  return `There is no proposal called ${slug}. This link's source is not a PR, the checkout or a worktree.`;
}

/**
 * What to say when `?proposal=` holds something that is not a proposal's name (a typo, a cut-off link), or null when it is a name or absent.
 * The value is shown as text, cut to 60 characters; the caller sets it with `textContent`.
 * @param {string} search `location.search`
 * @returns {string|null}
 */
export function malformedLinkWords(search) {
  const params = new URLSearchParams(search || '');
  if (!params.has('proposal')) return null;
  const raw = params.get('proposal') || '';
  if (SLUG.test(raw)) return null;
  const shown = raw.length > 60 ? `${raw.slice(0, 59)}\u2026` : raw;
  return shown.trim() ? `This link does not name a proposal: \u201c${shown}\u201d is not a proposal's name.` : 'This link does not name a proposal.';
}

/**
 * The ways on from a link that found nothing: the same slug under another source, from the listing (a spec PR's copy before a local one),
 * each as `{ slug, source, label }`. The Specs list is offered by the caller, always.
 * @param {{ slug: string, source: string, error?: string, pull?: object }[]|null} listing
 * @param {string} slug
 * @param {string|null} source the one that was asked for (left out)
 */
export function otherCopies(listing, slug, source) {
  if (!Array.isArray(listing)) return [];
  return listing
    .filter((e) => e && e.slug === slug && e.source !== source && !e.error)
    .sort((a, b) => (pullNumberOf(b.source) ? 1 : 0) - (pullNumberOf(a.source) ? 1 : 0))
    .map((e) => ({ slug: e.slug, source: e.source, label: pullNumberOf(e.source) ? `Open the copy in PR #${pullNumberOf(e.source)}${e.pull && e.pull.draft ? ' (draft)' : ''}` : `Open the copy ${e.source === 'checkout' ? 'in the checkout' : `in worktree ${e.source}`}` }));
}

// ---------------------------------------------------------------------------
//  Where an added node sits
// ---------------------------------------------------------------------------

/** An ownership edge: a solid line with no kind (the parent → child link) */
const isOwnership = (e) => !e.kind && !e.dashed;

/**
 * Gives every node marked `added` a position, next to the node it hangs off: its parent when it has
 * one, else something it connects to, else a spot on a ring around the centre. Existing nodes never
 * move: the base layout is pinned, which is why the Before view and the Diff view show the same
 * picture. The spot is the first free one on widening rings around the anchor, starting on the side
 * facing away from the centre, where the map has room. Writes `x` and `y`; touches nothing else.
 * @param {{id:string, x:number, y:number, mark?:string}[]} nodes the applied nodes; the existing ones already have x and y
 * @param {{from:string, to:string, kind?:string, dashed?:boolean}[]} edges
 * @param {{gap?: number}} [opts] `gap`: the closest two nodes may sit (world units)
 */
export function placeAddedNodes(nodes, edges, { gap = 74 } = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const placed = nodes.filter((n) => kindOfMark(n) !== 'added');
  const added = nodes.filter((n) => kindOfMark(n) === 'added');
  if (!added.length) return;
  const done = new Set(placed.map((n) => n.id));

  const anchorOf = (n) => {
    const own = edges.find((e) => isOwnership(e) && e.to === n.id && byId.has(e.from));
    if (own) return own.from;
    const other = edges.find((e) => (e.from === n.id && byId.has(e.to)) || (e.to === n.id && byId.has(e.from)));
    return other ? (other.from === n.id ? other.to : other.from) : null;
  };

  const free = (x, y) => placed.every((p) => Math.hypot(p.x - x, p.y - y) >= gap);
  const put = (n, ax, ay) => {
    const out = Math.atan2(ay, ax) || -Math.PI / 2; // away from the centre
    const base = ax === 0 && ay === 0 ? -Math.PI / 2 : out;
    let fallback = null;
    for (let r = 96; r <= 96 + 40 * 12; r += 40) {
      const steps = Math.max(8, Math.round((2 * Math.PI * r) / gap));
      for (let k = 0; k < steps; k++) {
        // 0, +1, -1, +2, -2 ... steps either side of the outward direction
        const turn = Math.ceil(k / 2) * (k % 2 ? 1 : -1) * ((2 * Math.PI) / steps);
        const x = ax + Math.cos(base + turn) * r;
        const y = ay + Math.sin(base + turn) * r;
        if (!fallback) fallback = { x, y };
        if (free(x, y)) { n.x = x; n.y = y; return; }
      }
    }
    n.x = fallback.x; n.y = fallback.y;
  };

  // Parents first: an added node can hang off another added node, in any order in the file
  let pending = added.slice();
  for (let pass = 0; pass <= added.length && pending.length; pass++) {
    const next = [];
    for (const n of pending) {
      const anchor = byId.get(anchorOf(n));
      if (anchor && done.has(anchor.id)) {
        put(n, anchor.x, anchor.y);
        placed.push(n);
        done.add(n.id);
      } else {
        next.push(n); // its anchor is another added node not placed yet, or it has none (settled below)
      }
    }
    if (next.length === pending.length) break;
    pending = next;
  }
  // No anchor, or an anchor that never got a place: a spot beside the centre
  for (const n of pending) {
    put(n, 0, 0);
    placed.push(n);
  }
}

/**
 * The data-flow lanes fill a column in order; an added node goes last in its column, so the nodes
 * that were there keep their rows. Reorders each tier's `nodes` in place, stably.
 * @param {{tiers: {nodes: {mark?:string}[]}[]}|null} flow `buildDataFlow` result
 */
export function orderAddedLast(flow) {
  if (!flow) return;
  for (const tier of flow.tiers) {
    tier.nodes = [...tier.nodes.filter((n) => kindOfMark(n) !== 'added'), ...tier.nodes.filter((n) => kindOfMark(n) === 'added')];
  }
}

/** The distance between two rows of a lane (layout.js `LANE_ROW`) */
const LANE_ROW = 50;

/**
 * The data-flow lanes while a proposal is open: the base map's lane layout is pinned and the added
 * nodes take free cells of their lane, so no node that was there moves (laying the lanes out again
 * would re-flow a whole lane when one node more tips it into another row). An added node goes in the
 * free cells at the foot of its lane's last column, then in new rows below it; `flow.top` moves up
 * so the lane bands still cover them.
 *
 * Writes `x`, `y`, `r` of each existing node from `baseFlow`'s node of the same id, `x` and `y` of each
 * added one, and `flow.headers` / `flow.top`. `flow` is the applied map's flow (`buildDataFlow` over
 * the applied nodes, added nodes last in their tier), `baseFlow` the base map's, already laid out.
 * @param {{tiers: {key:string, nodes: object[]}[], headers?: object[], top?: number}} flow
 * @param {{tiers: {key:string, nodes: object[]}[], headers: object[], top: number}} baseFlow
 * @returns {boolean} false when the lanes cannot be pinned (a tier has nodes now that had none, so it has no column
 *   to join): the caller lays the lanes out afresh
 */
export function pinLanes(flow, baseFlow) {
  const baseTier = new Map(baseFlow.tiers.map((t) => [t.key, t]));
  if (flow.tiers.some((t) => t.nodes.length && !baseTier.get(t.key)?.nodes.length)) return false;

  // `headers` has one entry per tier that has nodes, in tier order
  const headerOf = new Map(baseFlow.tiers.filter((t) => t.nodes.length).map((t, i) => [t.key, baseFlow.headers[i]]));
  const was = new Map(baseFlow.tiers.flatMap((t) => t.nodes).map((n) => [n.id, n]));
  flow.headers = baseFlow.headers.map((h) => ({ ...h }));
  let top = baseFlow.top;

  for (const tier of flow.tiers) {
    if (!tier.nodes.length) continue;
    const kept = tier.nodes.filter((n) => was.has(n.id));
    const added = tier.nodes.filter((n) => !was.has(n.id));
    for (const n of kept) { const b = was.get(n.id); n.x = b.x; n.y = b.y; n.r = b.r; }
    if (!added.length) continue;

    const rows = headerOf.get(tier.key).rows;
    const lastX = Math.max(...kept.map((n) => n.x));
    const rowY = (k) => (k - (rows - 1) / 2) * LANE_ROW;
    const taken = new Set(kept.filter((n) => n.x === lastX).map((n) => Math.round(n.y)));
    let k = 0;
    for (const n of added) {
      while (taken.has(Math.round(rowY(k)))) k++;
      n.x = lastX;
      n.y = rowY(k);
      taken.add(Math.round(n.y));
      top = Math.min(top, -(n.y + 40)); // the bands run from `top` down to `-top + 40`
    }
  }
  flow.top = top;
  return true;
}

/**
 * The reviewer's own what-if edits, counted apart from the proposal's (spec 0007 D5): "yours: +1 node, 1 step changed". Never added to the proposal's
 * numbers, so the reviewer can still tell what the agent proposed. Empty for no edits.
 * @param {{ op?: string }[]} edits the applied edits (whatif-model.js)
 * @param {boolean} [hidden] My edits is off: the map does not show them
 * @returns {string}
 */
export function yoursText(edits, hidden = false) {
  const list = Array.isArray(edits) ? edits : [];
  if (!list.length) return '';
  const n = (ops) => list.filter((e) => e && ops.includes(e.op)).length;
  const unit = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
  const parts = [];
  if (n(['add-node'])) parts.push(`+${unit(n(['add-node']), 'node')}`);
  if (n(['add-edge'])) parts.push(`+${unit(n(['add-edge']), 'edge')}`);
  if (n(['remove-node'])) parts.push(`\u2212${unit(n(['remove-node']), 'node')}`);
  if (n(['remove-edge'])) parts.push(`\u2212${unit(n(['remove-edge']), 'edge')}`);
  const steps = n(['add-step', 'reword-step', 'delete-step', 'move-step']);
  if (steps) parts.push(`${unit(steps, 'step')} changed`);
  const rest = list.length - n(['add-node', 'add-edge', 'remove-node', 'remove-edge', 'add-step', 'reword-step', 'delete-step', 'move-step']);
  if (rest > 0) parts.push(unit(rest, 'other edit'));
  return `yours: ${parts.join(', ')}${hidden ? ' (hidden)' : ''}`;
}
