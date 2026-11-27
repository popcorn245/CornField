/**
 * @module explorer/history-model
 *
 * The pure half of a node's history (spec 0014 D2): the links of a commit's trail on the forge, and the node panel's History section.
 * No DOM, no state, no fetch; explorer/history.js holds the answer of `GET /api/history` (core/history.js) and asks these.
 *
 *   forgeLinks(forge)                 { commit(sha), pull(n), issue(n) }: where each is on the forge's site, or null (only https; GitHub and Forgejo)
 *   specFiles(nodes)                  spec number -> its file (`docs/specs/0012-work-as-a-view.md`), from the map's doc pages
 *   nodeTrail(history, nodeId)        a node's commits, newest first, with what the History section counts
 *   trailHtml(commit, ctx)            a commit's trail: `Spec 0012 → Issue #283 → PR #284 → 0281cba`, a gap dashed (`no spec`, `no issue`)
 *   historySectionHtml(node, ctx)     the node panel's History section
 *   specReach(history, spec)          the nodes a spec's commits touched, and how many commits named it
 *   heatOf(history, at)               the History layer (spec 0014 D3): per node, how often it changed and how lately, as of a commit
 *   haloWidth(count, max)             a halo's width on screen (px) for how often its node changed
 *   historyRowOf(status, heat, color, { replaying })   the Layers menu's row under Overlays, with Replay on it (spec 0015 D6)
 *   specBarHtml(pick, ctx)            the bar on the map while a spec is picked: `Spec 0012 · Work as a view: 6 commits, 72 nodes`
 *   commitKind(subject)               feat, fix, docs or other: a timeline mark's colour
 *   replayFrame(history, edges, at)   Replay (spec 0014 D1): what the map holds at a commit, what was born at it and what it changed
 *   replayCount(frame, total)         the count in the corner: `212 nodes · 340 edges · commit 45 of 132 · 3 born`
 *   stepWords(frame, ctx)             what a step says to a screen reader
 *   speedMs(total, speed)             how long a commit stays on screen while Replay plays
 */

import { escapeHtml as esc } from '../core/text.js';
import { fileUrl } from './file-url.js';
import { sectionHtml } from './panel-model.js';

/** The most commits the section lists before "Show all N" (spec 0015 D4: the last five) */
export const HISTORY_CAP = 5;

/** Where a commit, a pull request and an issue are on each forge's site */
const SHAPES = {
  github: { commit: 'commit', pull: 'pull', issue: 'issues' },
  forgejo: { commit: 'commit', pull: 'pulls', issue: 'issues' },
};

/**
 * The links of a trail on the forge, or null when there is no forge cornfield can link to. Built like file-url.js: `URL`, each segment encoded,
 * only `https:`, no user name and no backslash in `forge.url`.
 * @param {{ type: string, url: string, repo: string, baseBranch?: string } | null} forge the client config's
 */
export function forgeLinks(forge) {
  const shape = forge && Object.hasOwn(SHAPES, forge.type) ? SHAPES[forge.type] : null;
  const repo = forge && typeof forge.repo === 'string' ? forge.repo.split('/') : [];
  if (!shape || repo.length !== 2 || !repo.every((s) => /^[A-Za-z0-9_.-]+$/.test(s) && s !== '.' && s !== '..')) return null;
  let base;
  try {
    base = new URL(forge.url);
    if (base.protocol !== 'https:' || base.username || base.password || String(forge.url).includes('\\')) return null;
  } catch {
    return null;
  }
  const at = (...segs) => {
    const u = new URL(base.href);
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/${[...repo, ...segs].map(encodeURIComponent).join('/')}`;
    u.search = '';
    u.hash = '';
    return u.href;
  };
  const num = (n) => Number.isInteger(n) && n > 0;
  return {
    commit: (sha) => (typeof sha === 'string' && /^[0-9a-f]{7,40}$/.test(sha) ? at(shape.commit, sha) : null),
    pull: (n) => (num(n) ? at(shape.pull, String(n)) : null),
    issue: (n) => (num(n) ? at(shape.issue, String(n)) : null),
    file: (path) => fileUrl(forge, path, forge.baseBranch),
  };
}

/** A spec's short title from its doc page: "Work as a view" from "Spec 0012: Work as a view (issues, …)"; else its number */
const titleOf = (n, num) => {
  const m = typeof n.desc === 'string' && /^Spec \d{4}:\s*([^(]+?)\s*(?:\(|$)/.exec(n.desc);
  return m ? m[1] : `Spec ${num}`;
};

/** Spec number -> its file, from the map's pages of `docs/specs/NNNN-*.md` (the docs deriver puts each doc on the map) */
export function specFiles(nodes) {
  const out = new Map();
  for (const n of nodes || []) {
    const m = n && typeof n.file === 'string' && /^docs\/specs\/(\d{4})-[^/]+\.md$/.exec(n.file);
    if (m && !out.has(m[1])) out.set(m[1], { file: n.file, label: titleOf(n, m[1]), id: n.id });
  }
  return out;
}

/**
 * A node's commits, newest first, and what the section counts of them: pull requests, the specs and issues they name, and how many name a spec or an issue.
 * @param {{ commits: object[], nodes: Record<string, { born: number, commits: number[] }> } | null} history
 * @param {string} nodeId
 */
export function nodeTrail(history, nodeId) {
  const entry = history && history.nodes && Object.hasOwn(history.nodes, nodeId) ? history.nodes[nodeId] : null;
  if (!entry) return null;
  const commits = entry.commits.map((i) => ({ ...history.commits[i], index: i })).filter((c) => c.sha).reverse();
  const uniq = (xs) => [...new Set(xs)];
  return {
    commits,
    born: history.commits[entry.born] ? { ...history.commits[entry.born], index: entry.born } : null,
    pulls: uniq(commits.map((c) => c.pr).filter((n) => n != null)),
    specs: uniq(commits.flatMap((c) => c.specs || [])),
    issues: uniq(commits.flatMap((c) => c.issues || [])),
    traced: commits.filter((c) => (c.specs && c.specs.length) || (c.issues && c.issues.length) || (c.keys && c.keys.length)).length,
  };
}

const chip = (kind, href, words, title) => (href
  ? `<a class="hx-trail-chip" data-corn="text-link" data-trail="${kind}" href="${esc(href)}" target="_blank" rel="noreferrer"${title ? ` title="${esc(title)}"` : ''}>${words}</a>`
  : `<span class="hx-trail-chip" data-trail="${kind}"${title ? ` title="${esc(title)}"` : ''}>${words}</span>`);
const gap = (what) => `<span class="hx-trail-chip" data-trail="gap">no ${what}</span>`;
const ARROW = '<span class="hx-trail-arrow" aria-hidden="true">→</span>';

/**
 * A commit's trail, from spec to issue to pull request to commit. Each a link on the forge when there is one (a spec to its file); what the commit does not name is a dashed gap.
 * @param {{ sha: string, pr: number | null, issues: number[], specs: string[], keys?: string[] }} c
 * @param {{ links: ReturnType<typeof forgeLinks>, specs: ReturnType<typeof specFiles> }} ctx
 */
export function trailHtml(c, { links, specs }) {
  const parts = [];
  if (c.specs && c.specs.length) {
    for (const s of c.specs) {
      const spec = specs.get(s);
      parts.push(chip('spec', spec && links ? links.file(spec.file) : null, `Spec ${esc(s)}`, spec ? spec.label : ''));
    }
  } else parts.push(gap('spec'));
  if (c.issues && c.issues.length) for (const n of c.issues) parts.push(chip('issue', links && links.issue(n), `Issue #${esc(n)}`));
  else if (c.keys && c.keys.length) for (const k of c.keys) parts.push(chip('issue', null, esc(k)));
  else parts.push(gap('issue'));
  if (c.pr != null) parts.push(chip('pull', links && links.pull(c.pr), `PR #${esc(c.pr)}`));
  else parts.push(gap('pull request'));
  parts.push(chip('commit', links && links.commit(c.sha), `<span class="hx-mono">${esc(String(c.sha).slice(0, 7))}</span>`, 'The commit on the forge'));
  return `<span class="hx-trail" role="group" aria-label="Spec, issue, pull request and commit">${parts.join(ARROW)}</span>`;
}

/** "26 Nov 2026": a commit's day, in the viewer's own words for it */
export const dayOf = (iso, locale) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
};

/**
 * The node panel's History section (spec 0014 D2): counts, the specs behind the node (each picks what the spec reached on the map), the issues, and its commits newest first
 * with their trails. Every word from git and the forge is escaped; only https links are made.
 * @param {{ id: string }} node
 * @param {{ history: object | null, status: 'off' | 'loading' | 'ready' | 'error', error?: string, links: ReturnType<typeof forgeLinks>, specs: ReturnType<typeof specFiles>, picked?: string | null, all?: boolean, locale?: string }} ctx
 */
export function historySectionHtml(node, ctx) {
  // A section of the panel (spec 0015 D4): its count is the commits, it starts closed (the browser remembers it open per kind of node: panel-sections.js)
  const wrap = (body, count = null) => sectionHtml({ key: 'history', title: 'History', count, body, extra: ' data-history' }).replace('class="hx-sec-block hx-psec"', 'class="hx-sec-block hx-psec hx-history"');
  if (ctx.status === 'off') return '';
  if (ctx.status === 'loading') return wrap('<p class="hx-faint" data-corn="loading">Reading the history…</p>');
  if (ctx.status === 'error') return wrap(`<p class="hx-faint" data-corn="error">${esc(ctx.error || 'The history could not be read.')}</p>`);
  const t = nodeTrail(ctx.history, node.id);
  if (!t) return wrap('<p class="hx-faint">This node is not in the history yet: run <code class="hx-code">cornfield sync</code> and commit the map.</p>');
  if (!t.commits.length) return wrap('<p class="hx-faint">No commit has changed this node\'s file yet.</p>', 0);
  const n = t.commits.length;
  const share = Math.round((t.traced / n) * 100);
  const stats = `<p class="hx-history-stats"><span><b class="hx-ms">${n}</b> ${n === 1 ? 'commit' : 'commits'}</span> · <span><b class="hx-ms">${t.pulls.length}</b> ${t.pulls.length === 1 ? 'pull request' : 'pull requests'}</span> · <span><b class="hx-ms">${share}%</b> traced to a spec or issue</span></p>`;
  const specChips = t.specs.map((s) => {
    const spec = ctx.specs.get(s);
    const on = ctx.picked === s;
    return `<button type="button" class="hx-lines-kind" data-corn-kind="quiet" data-history-spec="${esc(s)}" aria-pressed="${on}" title="Light every node spec ${esc(s)} reached">Spec ${esc(s)}${spec ? ` <span class="hx-faint">${esc(spec.label)}</span>` : ''}</button>`;
  });
  // The specs and the issues are counts that open (never all at once: a node of code can name eighty issues); a picked spec keeps its specs open, so its chip is in view
  const counted = (words, rows, open) => `<button type="button" class="hx-textbtn hx-history-count" data-sub-toggle aria-expanded="${open}" data-corn-kind="quiet">${words}</button>${rows.replace(/^<(\w+)/, `<$1${open ? '' : ' hidden'}`)}`;
  const picked = !!ctx.picked && t.specs.includes(ctx.picked);
  const specs = specChips.length
    ? counted(`${specChips.length} ${specChips.length === 1 ? 'spec' : 'specs'} behind it`, `<div class="hx-chips" role="group" aria-label="Specs behind it">${specChips.join('')}</div>`, picked)
    : '<p class="hx-faint">No commit to this node names a spec.</p>';
  const issues = t.issues.length
    ? counted(`${t.issues.length} ${t.issues.length === 1 ? 'issue' : 'issues'}`, `<p class="hx-history-issues">${t.issues.map((i) => { const href = ctx.links && ctx.links.issue(i); return href ? `<a class="hx-link" data-corn="text-link" href="${esc(href)}" target="_blank" rel="noreferrer">#${esc(i)}</a>` : `#${esc(i)}`; }).join(', ')}</p>`, false)
    : '';
  const shown = ctx.all ? t.commits : t.commits.slice(0, HISTORY_CAP);
  const rows = shown.map((c) => `<li class="hx-history-commit" data-corn="row">`
    + `<div class="hx-row-meta">${esc(dayOf(c.date, ctx.locale))} · ${c.nodes.length} ${c.nodes.length === 1 ? 'node' : 'nodes'}${t.born && c.index === t.born.index ? ' · <span class="hx-history-born">born here</span>' : ''} · <button type="button" class="hx-textbtn" data-corn-kind="quiet" data-history-at="${c.index}" aria-label="Replay the map at this commit: ${esc(c.subject)}">Replay here</button></div>`
    + `<div class="hx-history-subject">${esc(c.subject)}</div>`
    + trailHtml(c, ctx)
    + '</li>');
  const more = shown.length < n ? `<button type="button" class="hx-btn hx-btn--quiet hx-textact" data-corn="more" data-corn-kind="quiet" data-history-all>Show all ${n}</button>` : '';
  return wrap(`${stats}<div class="hx-history-counts">${specs}${issues}</div><h4 class="hx-history-k">${shown.length < n ? `The last ${shown.length} commits` : 'Commits'}, newest first</h4><ol class="hx-history-list">${rows.join('')}</ol>${more}`, n);
}

/**
 * What a spec reached: the nodes its commits touched, and how many commits named it (spec 0014 D3: picking a spec lights them).
 * @param {{ commits: { specs: string[], nodes: string[] }[] } | null} history
 * @param {string} spec
 */
export function specReach(history, spec) {
  const nodes = new Set();
  let commits = 0;
  for (const c of (history && history.commits) || []) {
    if (!c.specs || !c.specs.includes(spec)) continue;
    commits++;
    for (const id of c.nodes) nodes.add(id);
  }
  return { nodes, commits };
}

/** The History layer's key in the Layers menu and `state.activeLayers` (spec 0014 D3): an overlay, off to start */
export const HISTORY_LAYER = 'history-halos';
/** The most halos drawn at once */
export const MAX_HALOS = 600;
/** How lately a node changed, as of the timeline's commit: within a week, within a month (30 days), or before */
export const HALO_BANDS = Object.freeze(['week', 'month', 'old']);
const DAY_MS = 86_400_000;
const bandOf = (days) => (days <= 7 ? 'week' : days <= 30 ? 'month' : 'old');

/**
 * Each node's heat as of a commit: how many commits up to it changed the node, the last of them, and how many days before the commit that was.
 * The age is counted from the commit's own date, not today's, so a replay reads as it did then.
 * @param {{ commits: { date: string }[], nodes: Record<string, { commits: number[] }> } | null} history
 * @param {number | null} [at] a commit's index; the newest when it is left out or out of range
 * @returns {{ at: number, nodes: Map<string, { count: number, last: number, days: number, band: 'week' | 'month' | 'old' }>, max: number }}
 */
export function heatOf(history, at = null) {
  const commits = (history && history.commits) || [];
  const nodes = new Map();
  if (!commits.length) return { at: -1, nodes, max: 0 };
  const i = Number.isInteger(at) && at >= 0 && at < commits.length ? at : commits.length - 1;
  const now = Date.parse(commits[i].date);
  let max = 0;
  for (const [id, e] of Object.entries(history.nodes || {})) {
    let count = 0;
    let last = -1;
    for (const k of (e && e.commits) || []) { if (k > i) break; count++; last = k; }
    if (!count) continue;
    const days = Math.max(0, (now - Date.parse(commits[last].date)) / DAY_MS);
    nodes.set(id, { count, last, days, band: bandOf(days) });
    if (count > max) max = count;
  }
  return { at: i, nodes, max };
}

/** A halo's width on screen (px): from 1.5 for a node changed once to 6 for the most changed on the map (by the square root, so a few busy nodes do not flatten the rest) */
export const haloWidth = (count, max) => (max > 0 && count > 0 ? Math.round((1.5 + 4.5 * Math.sqrt(Math.min(count, max) / max)) * 10) / 10 : 0);

/**
 * The Layers menu's row for the History layer: its count in words while the history is read.
 * @param {'idle' | 'loading' | 'ready' | 'error'} status
 * @param {{ nodes: Map<string, unknown> } | null} heat
 * @param {string} color the dot's colour
 */
export function historyRowOf(status, heat, color, { replaying = false } = {}) {
  const n = heat ? heat.nodes.size : 0;
  const countText = status === 'ready' ? `${n} ${n === 1 ? 'node' : 'nodes'}` : status === 'loading' ? 'reading…' : status === 'error' ? 'not read' : 'not read yet';
  // Replay is the History layer's (spec 0015 D6): a button on its row, pressed while the timeline is open (page.js turns the layer on and opens it)
  const action = { name: 'history-replay', label: 'Replay', pressed: replaying === true, title: 'Replay the map\'s history, commit by commit' };
  return { key: HISTORY_LAYER, label: 'History', color, overlay: true, countText, action, desc: 'A halo round each node the history changed: the wider, the more often; pink this week, violet this month, grey before. Picking a spec in a node\'s History lights what it reached.' };
}

/**
 * The bar on the map while a spec is picked (spec 0014 D3): the spec, a link to its file on the forge when there is one, what it reached, and how to show the whole map again.
 * @param {{ spec: string, nodes: Set<string>, commits: number }} pick
 * @param {{ links: ReturnType<typeof forgeLinks>, specs: ReturnType<typeof specFiles> }} ctx
 */
export function specBarHtml(pick, { links, specs }) {
  const spec = specs && specs.get(pick.spec);
  const href = spec && links ? links.file(spec.file) : null;
  const name = href ? `<a class="hx-link" data-corn="text-link" href="${esc(href)}" target="_blank" rel="noreferrer">Spec ${esc(pick.spec)}</a>` : `<b>Spec ${esc(pick.spec)}</b>`;
  const label = spec ? ` · ${esc(spec.label)}` : '';
  const c = pick.commits;
  const n = pick.nodes.size;
  return `<span class="hx-history-bar-text">${name}${label}: ${c} ${c === 1 ? 'commit' : 'commits'}, ${n} ${n === 1 ? 'node' : 'nodes'}</span>`
    + `<button type="button" class="hx-btn hx-btn--quiet hx-textact" data-corn-kind="quiet" data-history-unpick>Show the whole map</button>`;
}

/** A commit's kind, from its conventional title: `feat`, `fix`, `docs`, or `other` */
export function commitKind(subject) {
  const m = /^(\w+)(?:\([^)]*\))?!?:/.exec(String(subject || ''));
  const k = m ? m[1].toLowerCase() : '';
  return k === 'feat' || k === 'fix' || k === 'docs' ? k : 'other';
}

/** The parent of each node, by its ownership edge (no kind, not dashed): where a node buds from */
export function parentsOf(edges) {
  const out = new Map();
  for (const e of edges || []) if (e && !e.dashed && !e.kind && e.from !== e.to && !out.has(e.to)) out.set(e.to, e.from);
  return out;
}

/**
 * The map at a commit (spec 0014 D1): every node born by then (a node the history does not hold, newer than it, is always there), the edges
 * between them, the nodes born at this commit and those it changed.
 * @param {{ commits: object[], nodes: Record<string, { born: number }> }} history
 * @param {{ from: string, to: string }[]} edges the map's edges
 * @param {number} at a commit's index
 */
export function replayFrame(history, edges, at) {
  const commits = history.commits;
  const i = Math.max(0, Math.min(commits.length - 1, Number.isInteger(at) ? at : commits.length - 1));
  const hidden = new Set();
  const born = [];
  for (const [id, e] of Object.entries(history.nodes || {})) {
    if (e.born > i) hidden.add(id);
    else if (e.born === i) born.push(id);
  }
  const all = Object.keys(history.nodes || {}).length;
  const shownEdges = (edges || []).filter((e) => !hidden.has(e.from) && !hidden.has(e.to)).length;
  const commit = commits[i];
  return { at: i, total: commits.length, commit, hidden, born: born.sort(), changed: (commit && commit.nodes) || [], nodes: all - hidden.size, edges: shownEdges };
}

/** The count in the corner of the timeline */
export function replayCount(f) {
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return `${plural(f.nodes, 'node', 'nodes')} · ${plural(f.edges, 'edge', 'edges')} · commit ${f.at + 1} of ${f.total}${f.born.length ? ` · ${f.born.length} born` : ''}`;
}

/**
 * What a step says to a screen reader: the commit, then what was born and what changed, by name (the first few).
 * @param {ReturnType<typeof replayFrame>} f
 * @param {{ labelOf: (id: string) => string, locale?: string }} ctx
 */
export function stepWords(f, { labelOf, locale }) {
  const c = f.commit || {};
  const names = (ids) => {
    const first = ids.slice(0, 3).map(labelOf);
    return ids.length > 3 ? `${first.join(', ')} and ${ids.length - 3} more` : first.length > 1 ? `${first.slice(0, -1).join(', ')} and ${first[first.length - 1]}` : first.join('');
  };
  const parts = [`Commit ${f.at + 1} of ${f.total}, ${dayOf(c.date, locale)}: ${c.subject || ''}.`];
  if (f.born.length) parts.push(`Born: ${names(f.born)}.`);
  const changed = f.changed.filter((id) => !f.born.includes(id));
  if (changed.length) parts.push(`Changed: ${names(changed)}.`);
  parts.push(`${f.nodes} ${f.nodes === 1 ? 'node' : 'nodes'} on the map.`);
  return parts.join(' ');
}

/** The speeds Replay plays at */
export const SPEEDS = Object.freeze([1, 2, 4]);
/** How long a commit stays on screen while Replay plays (ms): the whole history in about 40 seconds at 1×, never under 40 ms or over 700 ms a commit */
export const speedMs = (total, speed = 1) => Math.max(40, Math.min(700, 40_000 / Math.max(1, total))) / (SPEEDS.includes(speed) ? speed : 1);
