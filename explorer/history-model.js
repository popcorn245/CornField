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
 */

import { escapeHtml as esc } from '../core/text.js';
import { fileUrl } from './file-url.js';

/** The most commits the section lists before "Show all N" */
export const HISTORY_CAP = 12;

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
  const head = '<h3 class="hx-sec-title">History</h3>';
  const wrap = (body) => `<div class="hx-sec-block hx-history" data-corn="section" data-history>${head}${body}</div>`;
  if (ctx.status === 'off') return '';
  if (ctx.status === 'loading') return wrap('<p class="hx-faint" data-corn="loading">Reading the history…</p>');
  if (ctx.status === 'error') return wrap(`<p class="hx-faint" data-corn="error">${esc(ctx.error || 'The history could not be read.')}</p>`);
  const t = nodeTrail(ctx.history, node.id);
  if (!t) return wrap('<p class="hx-faint">This node is not in the history yet: run <code class="hx-code">cornfield sync</code> and commit the map.</p>');
  if (!t.commits.length) return wrap('<p class="hx-faint">No commit has changed this node\'s file yet.</p>');
  const n = t.commits.length;
  const share = Math.round((t.traced / n) * 100);
  const stats = `<p class="hx-history-stats"><span><b class="hx-ms">${n}</b> ${n === 1 ? 'commit' : 'commits'}</span> · <span><b class="hx-ms">${t.pulls.length}</b> ${t.pulls.length === 1 ? 'pull request' : 'pull requests'}</span> · <span><b class="hx-ms">${share}%</b> traced to a spec or issue</span></p>`;
  const specChips = t.specs.map((s) => {
    const spec = ctx.specs.get(s);
    const on = ctx.picked === s;
    return `<button type="button" class="hx-lines-kind" data-corn-kind="quiet" data-history-spec="${esc(s)}" aria-pressed="${on}" title="Light every node spec ${esc(s)} reached">Spec ${esc(s)}${spec ? ` <span class="hx-faint">${esc(spec.label)}</span>` : ''}</button>`;
  });
  const specs = specChips.length ? `<div class="hx-chips" role="group" aria-label="Specs behind it">${specChips.join('')}</div>` : '<p class="hx-faint">No commit to this node names a spec.</p>';
  const issues = t.issues.length ? `<p class="hx-history-issues">Issues: ${t.issues.map((i) => { const href = ctx.links && ctx.links.issue(i); return href ? `<a class="hx-link" data-corn="text-link" href="${esc(href)}" target="_blank" rel="noreferrer">#${esc(i)}</a>` : `#${esc(i)}`; }).join(', ')}</p>` : '';
  const shown = ctx.all ? t.commits : t.commits.slice(0, HISTORY_CAP);
  const rows = shown.map((c) => `<li class="hx-history-commit" data-corn="row">`
    + `<div class="hx-row-meta">${esc(dayOf(c.date, ctx.locale))} · ${c.nodes.length} ${c.nodes.length === 1 ? 'node' : 'nodes'}${t.born && c.index === t.born.index ? ' · <span class="hx-history-born">born here</span>' : ''}</div>`
    + `<div class="hx-history-subject">${esc(c.subject)}</div>`
    + trailHtml(c, ctx)
    + '</li>');
  const more = shown.length < n ? `<button type="button" class="hx-btn hx-btn--quiet hx-textact" data-corn="more" data-corn-kind="quiet" data-history-all>Show all ${n}</button>` : '';
  return wrap(`${stats}<h4 class="hx-history-k">Specs behind it</h4>${specs}${issues}<h4 class="hx-history-k">Commits, newest first</h4><ol class="hx-history-list">${rows.join('')}</ol>${more}`);
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
