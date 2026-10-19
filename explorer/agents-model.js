/**
 * @module explorer/agents-model
 *
 * The agents view of the issues and PRs panel, the pure half (CF-09, ADR 0007: v1 tracks agents by what they leave,
 * it does not launch them): no DOM, no `window`, no clock. It takes what `/api/forge/work` answers (pull requests,
 * issues, branches, the open spec PRs and the config's `agents` rules) and decides three things:
 *
 *   agentMark       whether a pull request or a branch is agent-made, and why (the rule below)
 *   linksOf         which issues a pull request or branch belongs to, and which proposal
 *   groupWork       the work in groups: one per proposal, one per issue, and one for what links to neither
 *
 * **Agent-made.** The rules are the config's `agents` (core/config.js), all empty by default except `bots`:
 *   - `authors`: the pull request's author is one of these accounts (case does not matter);
 *   - `bots` (default true): the author is a bot, which is a login ending in `[bot]` or an account the forge itself
 *     calls a Bot (`author.bot`);
 *   - `labels`: the pull request has one of these labels (case does not matter);
 *   - `branchPrefixes`: the branch (a pull request's head, or a branch with no pull request) starts with one of these.
 * The first rule that holds is the reason given, in that order. A branch has no author in the forge's answers, so only
 * its name can mark it.
 *
 * **Linking.** A pull request belongs to the issue named by "Closes / Fixes / Resolves #n" in its text (also
 * "closed", "fixed", "resolved", "fix", "close", "resolve", and lists: "Closes #1, #2"; a number that is a listed pull
 * request and not a listed issue is left out, as issues and pull requests share numbers), else by an issue number at
 * the start of a segment of its branch name (`claude/10-agents-tracked`, `issue-10`, `#10`) when that number is an
 * issue the forge listed (a date in a release branch's name is not an issue). A spec PR (one the server lists
 * as adding a proposal) belongs to that proposal, and so does work whose branch name holds the proposal's slug.
 * Precedence: a spec PR goes with its proposal, otherwise an issue, otherwise a proposal by slug, otherwise it is
 * unlinked. A branch with no pull request is shown only when it is agent-made or linked: the rest is noise.
 */

import { relativeTime } from './review-model.js';

export const WORK_URL = '/api/forge/work';

/** The agent rules with every key present */
export function agentRules(agents) {
  const a = agents && typeof agents === 'object' ? agents : {};
  const list = (v) => (Array.isArray(v) ? v.filter((e) => typeof e === 'string' && e !== '') : []);
  return { authors: list(a.authors), labels: list(a.labels), branchPrefixes: list(a.branchPrefixes), bots: a.bots !== false };
}

const lower = (s) => String(s).toLowerCase();

/** Whether an author is a bot: the forge says so, or the login ends in `[bot]` */
export const isBot = (author) => !!author && (author.bot === true || /\[bot\]$/i.test(author.login));

/**
 * Why work is agent-made, or null when it is not.
 * @param {{ author?: { login: string, bot?: boolean } | null, labels?: string[], head?: { ref: string } }} item a pull request
 *   (or a branch `{ name }`, whose name is `head.ref`)
 * @param {ReturnType<typeof agentRules>} rules
 * @returns {{ by: 'author' | 'bot' | 'label' | 'branch', detail: string } | null}
 */
export function agentMark(item, rules) {
  const login = item.author ? item.author.login : null;
  if (login && rules.authors.some((a) => lower(a) === lower(login))) return { by: 'author', detail: login };
  if (rules.bots && isBot(item.author)) return { by: 'bot', detail: login };
  const label = (item.labels || []).find((l) => rules.labels.some((x) => lower(x) === lower(l)));
  if (label !== undefined) return { by: 'label', detail: label };
  const ref = item.head ? item.head.ref : '';
  const prefix = ref && rules.branchPrefixes.find((p) => ref.startsWith(p));
  if (prefix) return { by: 'branch', detail: prefix };
  return null;
}

/** The reason in words: "bot account", "listed author (claude-bot)", "label agent", "branch starts claude/" */
export function markWords(mark) {
  if (!mark) return '';
  if (mark.by === 'bot') return `bot account ${mark.detail}`;
  if (mark.by === 'author') return `listed author ${mark.detail}`;
  if (mark.by === 'label') return `label ${mark.detail}`;
  return `branch starts with ${mark.detail}`;
}

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?[ \t]+((?:#\d+)(?:[ \t]*(?:,|and|&)[ \t]*#\d+)*)/gi;

/** The issue numbers a pull request's text closes ("Closes #10", "Fixes: #3, #4"), each once, in the order written; a link to another repo's issue is not one */
export function closedIssues(text) {
  const out = [];
  for (const m of String(text || '').matchAll(CLOSING)) for (const n of m[1].matchAll(/#(\d+)/g)) if (!out.includes(Number(n[1]))) out.push(Number(n[1]));
  return out;
}

/** The numbers a branch name starts a segment with: `claude/10-agents` and `10-agents` give 10, `issue-12` and `fix/issue_12-x` give 12, `#7` gives 7 */
export function branchNumbers(ref) {
  const out = [];
  const add = (v) => { const n = Number(v); if (n > 0 && !out.includes(n)) out.push(n); };
  for (const seg of String(ref || '').split('/')) {
    const m = /^(?:issues?[-_]?|#)?(\d{1,6})(?:[-_]|$)/i.exec(seg);
    if (m) add(m[1]);
  }
  return out;
}

/** Whether a branch name holds a proposal's slug as whole words (`claude/0013-meals-spec` holds `0013-meals`) */
export const holdsSlug = (ref, slug) => new RegExp(`(?:^|[^a-z0-9])${lower(slug).replace(/[^a-z0-9]/g, '\\$&')}(?:$|[^a-z0-9])`).test(lower(ref));

/**
 * Which issues and which proposal a pull request or a branch belongs to.
 * @param {{ number?: number, body?: string, head?: { ref: string }, name?: string }} item a pull request, or a branch `{ name }`
 * @param {{ issues: Map<number, object>, pulls?: Set<number>, specs: Map<number, string[]>, slugs: string[] }} known
 *   `pulls`: the numbers of the pull requests listed, so a closing reference to one of them is not taken for an issue
 * @returns {{ issues: number[], proposal: string | null, spec: boolean, bySlug: string | null }}
 *   `issues` all it names (the first is its group), `proposal` the slug of the spec PR it is, `bySlug` the slug its branch name holds
 */
export function linksOf(item, known) {
  const ref = item.head ? item.head.ref : item.name || '';
  const issues = [];
  // Issues and pull requests share their numbers: "Fixes #51" naming a pull request the forge listed is not an issue
  const closes = closedIssues(item.body).filter((n) => known.issues.has(n) || !(known.pulls && known.pulls.has(n)));
  for (const n of [...closes, ...branchNumbers(ref).filter((n) => known.issues.has(n))]) {
    if (n !== item.number && !issues.includes(n)) issues.push(n);
  }
  const mine = item.number !== undefined && known.specs.get(item.number);
  const bySlug = known.slugs.find((s) => holdsSlug(ref, s)) || null;
  return { issues, proposal: mine && mine.length ? mine[0] : null, spec: !!(mine && mine.length), bySlug };
}

const stamp = (s) => (s ? Date.parse(s) || 0 : 0);

/**
 * The work, grouped.
 * @param {{ pulls?: object[], issues?: object[], branches?: { name: string, sha: string, protected: boolean }[], specs?: { pull: number, slug: string }[], agents?: object }} work
 *   what `/api/forge/work` answered
 * @returns {{
 *   groups: Group[], rules: ReturnType<typeof agentRules>,
 * }}
 * @typedef {{ type: 'pull', pull: object, mark: object | null, issues: number[], proposal: string | null } | { type: 'branch', branch: { name: string, sha: string }, mark: object | null, issues: number[], proposal: string | null }} Entry
 * @typedef {{ id: string, kind: 'proposal' | 'issue' | 'none', title: string, issue: object | null, number: number | null, slug: string | null, entries: Entry[], agents: number, updatedAt: string }} Group
 */
export function groupWork(work) {
  const rules = agentRules(work.agents);
  const pulls = work.pulls || [];
  const issues = new Map((work.issues || []).map((i) => [i.number, i]));
  const specs = new Map();
  for (const s of work.specs || []) specs.set(s.pull, [...(specs.get(s.pull) || []), s.slug]);
  const known = { issues, pulls: new Set(pulls.map((p) => p.number)), specs, slugs: [...new Set((work.specs || []).map((s) => s.slug))] };

  /** @type {Entry[]} */
  const entries = pulls.map((pull) => ({ type: 'pull', pull, mark: agentMark(pull, rules), ...pick(linksOf(pull, known)) }));
  const headed = new Set(pulls.map((p) => p.head.ref));
  const bases = new Set(pulls.map((p) => p.base.ref));
  for (const branch of work.branches || []) {
    if (branch.protected || headed.has(branch.name) || bases.has(branch.name)) continue; // a pull request's own branch is in its pull request; a base is not work
    const links = linksOf({ name: branch.name }, known);
    const mark = agentMark({ head: { ref: branch.name } }, rules);
    if (!mark && !links.issues.length && !links.bySlug) continue; // a branch nobody tied to anything is noise
    entries.push({ type: 'branch', branch, mark, ...pick(links) });
  }

  const groups = new Map();
  const into = (id, make, entry) => {
    if (!groups.has(id)) groups.set(id, { id, entries: [], agents: 0, updatedAt: '', ...make() });
    const g = groups.get(id);
    g.entries.push(entry);
    if (entry.mark) g.agents++;
    const at = entry.type === 'pull' ? entry.pull.updatedAt : '';
    if (stamp(at) > stamp(g.updatedAt)) g.updatedAt = at;
  };
  for (const e of entries) {
    if (e.proposal) into(`proposal:${e.proposal}`, () => proposalGroup(e.proposal), e);
    else if (e.issues.length) into(`issue:${e.issues[0]}`, () => issueGroup(e.issues[0], issues), e);
    else if (e.bySlug) into(`proposal:${e.bySlug}`, () => proposalGroup(e.bySlug), e);
    else into('none', () => ({ kind: 'none', title: 'Not linked to an issue or a proposal', issue: null, number: null, slug: null }), e);
  }
  for (const g of groups.values()) {
    g.entries.sort((a, b) => (a.type === b.type ? 0 : a.type === 'pull' ? -1 : 1) || (a.type === 'pull' ? stamp(b.pull.updatedAt) - stamp(a.pull.updatedAt) : a.branch.name.localeCompare(b.branch.name)));
  }
  const order = { proposal: 0, issue: 1, none: 2 };
  return { groups: [...groups.values()].sort((a, b) => order[a.kind] - order[b.kind] || stamp(b.updatedAt) - stamp(a.updatedAt) || a.id.localeCompare(b.id)), rules };
}

const pick = (l) => ({ issues: l.issues, proposal: l.proposal, bySlug: l.bySlug });
const proposalGroup = (slug) => ({ kind: 'proposal', title: `Proposal ${slug}`, issue: null, number: null, slug });
const issueGroup = (n, issues) => ({ kind: 'issue', title: issues.has(n) ? `#${n} ${issues.get(n).title}` : `Issue #${n}`, issue: issues.get(n) || null, number: n, slug: null });

/** Whether work is finished: a pull request merged or closed */
export const isFinished = (entry) => entry.type === 'pull' && entry.pull.state !== 'open';

/**
 * What the view shows: with `finished` off, the open work only (a pull request merged or closed is left out); with
 * `agentsOnly`, only what is agent-made. A group left with nothing is dropped.
 * @param {Group[]} groups
 * @param {{ finished?: boolean, agentsOnly?: boolean }} filters
 * @returns {Group[]}
 */
export function filterGroups(groups, filters) {
  const f = { finished: false, agentsOnly: false, ...filters };
  return groups
    .map((g) => {
      const entries = g.entries.filter((e) => (f.finished || !isFinished(e)) && (!f.agentsOnly || e.mark));
      return { ...g, entries, agents: entries.filter((e) => e.mark).length };
    })
    .filter((g) => g.entries.length);
}

/** "3 pull requests, 1 branch, 2 by agents" for a group's heading */
export function groupWords(group) {
  const pulls = group.entries.filter((e) => e.type === 'pull').length;
  const branches = group.entries.length - pulls;
  const parts = [];
  if (pulls) parts.push(`${pulls} ${pulls === 1 ? 'pull request' : 'pull requests'}`);
  if (branches) parts.push(`${branches} ${branches === 1 ? 'branch' : 'branches'}`);
  parts.push(group.agents ? `${group.agents} by ${group.agents === 1 ? 'an agent' : 'agents'}` : 'none by agents');
  return parts.join(', ');
}

/** The line under the view's tabs: "4 groups, 7 pieces of work, 5 by agents", with how old the answer is */
export function workStatus(groups, at, nowMs) {
  const n = groups.reduce((sum, g) => sum + g.entries.length, 0);
  const a = groups.reduce((sum, g) => sum + g.agents, 0);
  const g = `${groups.length} ${groups.length === 1 ? 'group' : 'groups'}`;
  const w = `${n} ${n === 1 ? 'piece' : 'pieces'} of work`;
  return `${g}, ${w}, ${a} by agents${at ? `, as of ${relativeTime(at, nowMs)}` : ''}`;
}
