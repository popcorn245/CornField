/**
 * @module server/pipeline
 *
 * The pipeline's own steps (PIPE-05, ADR 0006): what the two steps between stages make, worked out from the forge's
 * own state. Landing a green pull request is the third step and is not here: it is server/forge-actions.js's merge.
 *
 *   1. **Start a spec** on an open issue: a branch `spec/<nnnn>-<slug>`, one commit adding a stub proposal
 *      `<proposals folder>/<nnnn>-<slug>.json` (`nnnn` the issue's number, four digits at least, so it reads and sorts
 *      like the other proposals, `0013-meals`), and a draft pull request "Spec: <title>" whose body says `Refs #<n>`.
 *   2. **Open the build issue** for a spec pull request whose latest review by a maintainer approves the proposal
 *      (server/reviews.js `latestReview`): an issue that links the pull request and the proposal and lists the nodes
 *      and edges to build as a checklist, from the proposal as approved (the review's edits folded in).
 *
 * Each step is a **plan** first (`planSpec`, `planBuild`): everything it would make, as plain data, read from the forge
 * now and built here, never from the request. The page shows the plan in its confirm step; asking for the action sends
 * back the plan's `digest`, and the server plans again and refuses (409) when it is not the same, so what is created is
 * what was shown. Both steps are **idempotent**: a plan says what the first run made (`existing`), and a second run
 * returns that instead of making another. What a first run made is only trusted when a maintainer made it: an open spec
 * pull request, or a build issue with the marker, by anyone else (who can open one) is not taken for it, so nobody can
 * block a step by planting one. Nothing here launches or talks to an agent (ADR 0007), and nothing changes
 * what is on the forge already: a branch, a file, a pull request and an issue are only ever added.
 *
 * Text that comes from the forge or from a proposal (a title, a node's label) is untrusted: it goes into the new issue
 * only as a code span or with its markup, mentions and references defused (`plain`, `code`).
 *
 * @typedef {{ number: number, title: string, url: string, draft: boolean, headRef: string }} PullRef
 * @typedef {{ kind: 'spec', digest: string, issue: { number: number, title: string, url: string }, base: string, branch: string, path: string, message: string, title: string, body: string, content: string, existing: PullRef | null }} SpecPlan
 * @typedef {{ kind: 'build', digest: string, pull: { number: number, title: string, url: string }, slug: string, path: string, sha: string, review: { by: string, url: string, at: string }, title: string, body: string, items: number, existing: { number: number, url: string, state: string } | null }} BuildPlan
 */

import { createHash } from 'node:crypto';
import { ForgeError, MAX_BODY, MAX_TITLE, isMaintainer } from './forge.js';
import { PROPOSAL_FILE } from './files.js';
import { findPullProposal, folderOf, readPullProposal } from './proposal-pulls.js';
import { latestReview, proposalHash } from './reviews.js';
import { applyEdits, slug as slugOf, validateProposal } from '../core/proposal.js';

/** The longest slug of a proposal's name made from an issue's title, before its number */
const MAX_SLUG = 48;
/** The most checklist lines in one build issue; the rest is counted */
export const MAX_ITEMS = 150;
/** The most a proposal read for a build issue may hold, in bytes */
const MAX_PROPOSAL = 512 * 1024;
const BASE = 'main';

const conflict = (message) => new ForgeError(message, { code: 'conflict' });
const invalid = (message) => new ForgeError(message, { code: 'invalid' });
const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/g;

/**
 * Untrusted text as one line of plain markdown text: control characters out, white space collapsed, and every character
 * that would make markup, a mention, a reference or a link an entity, so it reads as it was written and does nothing.
 */
export function plain(value, max = 200) {
  const one = String(value ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return clip(one, max).replace(/[&<>#@\\`*_[\]|~!]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Untrusted text as a code span: no backtick or control character can end it */
export function code(value, max = 100) {
  const one = clip(String(value ?? '').replace(CONTROL, ' ').replace(/`/g, "'").replace(/\s+/g, ' ').trim(), max);
  return `\`${one || ' '}\``;
}

/** The number part of a spec's name: the issue's number, four digits at least (`0007`), as the proposals are numbered */
export const specNumber = (n) => String(n).padStart(4, '0');

/** The name of the proposal an issue starts: `<nnnn>-<slug of the title>`, a plain file name in the proposals folder */
export function specSlug(n, title) {
  const words = slugOf(clip(String(title), 200)).slice(0, MAX_SLUG).replace(/-+$/, '') || 'spec';
  return `${specNumber(n)}-${words}`;
}

/** Whether something on the forge was made by a maintainer of the repo: asked once per login (a forge that cannot say throws) */
function maintainers(forge) {
  const known = new Map();
  return async (author) => {
    if (!author || typeof author.login !== 'string') return false;
    if (!known.has(author.login)) known.set(author.login, isMaintainer(await forge.permission(forge.repo, author.login)));
    return known.get(author.login);
  };
}

/** A web address the forge gave, as it is, or '' (it is the forge's data, but it is only ever linked when it is plainly one) */
const link = (u) => (typeof u === 'string' && /^https?:\/\/[^\s<>"`]+$/.test(u) && u.length <= 300 ? u : '');

/** The text of a title for a field the forge will show on one line */
const oneLine = (value, max = MAX_TITLE - 16) => clip(String(value ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim(), max);

/**
 * The stub proposal an issue starts, as the text of its file: a title and a summary that point back at the issue, and
 * nothing a proposal would claim. It holds to core/proposal.js (`validateProposal` finds nothing to say).
 * @param {{ number: number, title: string }} issue
 */
export function stubProposal(issue) {
  const proposal = { version: 1, title: oneLine(issue.title, 120) || `Issue ${issue.number}`, summary: `A stub for #${issue.number}: say in one sentence what this changes, then add the nodes and edges it adds, changes and removes.` };
  const problems = validateProposal({ nodes: [], edges: [] }, proposal);
  if (problems.length) throw invalid(`The stub proposal for #${issue.number} would not be valid: ${problems[0].message}`);
  return { proposal, text: `${JSON.stringify(proposal, null, 2)}\n` };
}

/**
 * Step 1, planned: what starting a spec on issue `n` would make, and the pull request it made already, if it did.
 * @param {import('./forge.js').Forge} forge
 * @param {{ forge: { baseBranch?: string } }} config
 * @param {{ proposals: string }} where
 * @param {number} n
 * @returns {Promise<SpecPlan>}
 */
export async function planSpec(forge, config, where, n) {
  const issue = await forge.issue(n);
  if (issue.state !== 'open') throw conflict(`Issue #${n} is closed, so no spec is started for it.`);
  const slug = specSlug(n, issue.title);
  if (!PROPOSAL_FILE.test(`${slug}.json`)) throw invalid(`"${slug}" is not a name a proposal can have.`);
  const path = `${folderOf(where)}/${slug}.json`;
  const branch = `spec/${slug}`;
  const base = (config.forge && config.forge.baseBranch) || BASE;
  const { proposal, text } = stubProposal(issue);
  const title = `Spec: ${oneLine(issue.title)}`;
  const body = [
    `Refs #${n}`,
    '',
    `The spec for ${code(oneLine(issue.title, 100))}: a draft pull request with a stub proposal, ${code(path)}.`,
    'Fill the proposal in on this branch, then send it to review in cornfield.',
    '',
    'Started from cornfield. It runs no agent and builds nothing by itself.',
  ].join('\n');
  const message = `Start a spec for #${n}`;
  const pulls = await forge.pulls({ state: 'open' });
  // The spec of this issue, whatever its title was when it was started: every branch cornfield makes for it starts
  // `spec/<nnnn>-`. Only a maintainer's pull request counts (cornfield opens it as one): anyone else's is not it
  const byMaintainer = maintainers(forge);
  let found = null;
  for (const p of pulls) {
    if ((p.head.ref === branch || p.head.ref.startsWith(`spec/${specNumber(n)}-`)) && (await byMaintainer(p.author))) { found = p; break; }
  }
  const existing = found ? { number: found.number, title: found.title, url: found.url, draft: found.draft, headRef: found.head.ref } : null;
  const facts = { n, base, branch, path, title, body, message, content: text, proposal };
  return { kind: 'spec', digest: digestOf(facts), issue: { number: n, title: issue.title, url: issue.url }, base, branch, path, message, title, body, content: text, existing };
}

/**
 * Step 1, done: the pull request that was started for the issue, made now or found. A second run finds what the first made.
 * @param {import('./forge.js').Forge} forge
 * @param {SpecPlan} plan a plan the caller has checked against what the person confirmed
 * @returns {Promise<{ created: boolean, pull: PullRef }>}
 */
export async function startSpec(forge, plan) {
  if (plan.existing) return { created: false, pull: plan.existing };
  const branches = await forge.branches();
  const base = branches.find((b) => b.name === plan.base);
  if (!base) throw conflict(`The branch ${plan.base} is not there to start from (forge.baseBranch in cornfield.config.js names it).`);
  let mine = branches.find((b) => b.name === plan.branch);
  if (!mine) {
    try {
      await forge.createBranch(plan.branch, { from: plan.base });
    } catch (err) {
      // Made a moment ago by a second attempt: it is looked at below like any branch that was there
      if (!(err instanceof ForgeError && err.code === 'conflict')) throw err;
    }
    mine = (await forge.branches()).find((b) => b.name === plan.branch);
  }
  const hasFile = (await forge.file(plan.branch, plan.path)) !== null;
  if (!hasFile) {
    // Only a branch nothing has been added to (still at the base) is written to: cornfield never commits onto work that is someone's
    if (!mine || mine.sha !== base.sha) throw conflict(`The branch ${plan.branch} is there already with other work on it and no pull request; open the pull request from the forge, or remove the branch.`);
    await forge.createFile({ branch: plan.branch, path: plan.path, content: plan.content, message: plan.message });
  }
  const pull = await forge.createPull({ title: plan.title, body: plan.body, head: plan.branch, base: plan.base, draft: true });
  return { created: true, pull: { number: pull.number, title: pull.title, url: pull.url, draft: pull.draft, headRef: pull.head.ref } };
}

// ---------------------------------------------------------------------------
//  Step 2: the build issue
// ---------------------------------------------------------------------------

/** The line in a build issue that says which spec it was made for: how a second run finds it */
export const buildMarker = (n, slug) => `<!-- cornfield-build pull/${n} ${slug} -->`;

const list = (v) => (Array.isArray(v) ? v : []);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const idOf = (v) => (isObject(v) && typeof v.id === 'string' ? v.id : '');

/**
 * The checklist of a proposal: its nodes (and the edges between them) to add, change and remove, one `- [ ]` line each.
 * Untrusted text is defused. Counts the lines past `MAX_ITEMS` rather than listing them.
 * @param {any} proposal
 * @returns {{ lines: string[], count: number }}
 */
export function checklist(proposal) {
  const nodes = isObject(proposal.nodes) ? proposal.nodes : {};
  const edges = isObject(proposal.edges) ? proposal.edges : {};
  const why = (e) => (isObject(e) && typeof e.why === 'string' && e.why.trim() ? `: ${plain(e.why, 160)}` : '');
  const end = (e) => `${code(isObject(e) ? e.from : '')} → ${code(isObject(e) ? e.to : '')}${isObject(e) && typeof e.kind === 'string' ? ` (${plain(e.kind, 30)})` : ''}`;
  const groups = [
    ['Nodes', [
      ...list(nodes.add).map((e) => `Add ${code(idOf(e))}${isObject(e) && typeof e.label === 'string' ? ` (${plain(e.label, 60)}${typeof e.type === 'string' ? `, ${plain(e.type, 30)}` : ''})` : ''}`),
      ...list(nodes.change).map((e) => `Change ${code(idOf(e))}${why(e)}`),
      ...list(nodes.remove).map((e) => `Remove ${code(idOf(e))}${why(e)}`),
    ]],
    ['Edges', [
      ...list(edges.add).map((e) => `Add ${end(e)}`),
      ...list(edges.change).map((e) => `Change ${end(e)}${why(e)}`),
      ...list(edges.remove).map((e) => `Remove ${end(e)}${why(e)}`),
    ]],
  ];
  const lines = [];
  let count = 0;
  let left = MAX_ITEMS;
  for (const [heading, items] of groups) {
    if (!items.length) continue;
    count += items.length;
    lines.push(`## ${heading}`, '');
    for (const item of items.slice(0, Math.max(0, left))) lines.push(`- [ ] ${item}`);
    if (items.length > left) lines.push(`- [ ] …and ${Math.max(0, items.length - Math.max(0, left))} more, in the proposal`);
    left -= items.length;
    lines.push('');
  }
  if (!count) lines.push('The proposal adds, changes and removes no nodes or edges: build what its summary and scenarios describe.', '');
  return { lines, count };
}

/**
 * The proposals of a spec pull request, and whether each is approved now: for the page to know whether to offer the
 * step. Only the proposal files the pull request changes are looked at; a forge that cannot say gives none.
 * @param {import('./forge.js').Forge} forge
 * @param {{ proposals: string }} where
 * @param {{ number: number }} pull
 * @param {import('./forge.js').PullFile[]} files
 * `approved` is true only when the latest maintainer review approves the file as the head holds it now; `changed` says
 * the file was approved and has changed since.
 * @returns {Promise<{ slug: string, path: string, approved: boolean, changed: boolean }[]>}
 */
export async function pullSpecs(forge, where, pull, files) {
  const folder = folderOf(where);
  const mine = files.filter((f) => f.status !== 'removed' && f.path.startsWith(`${folder}/`) && !f.path.slice(folder.length + 1).includes('/') && !f.path.endsWith('.review.json'))
    .map((f) => ({ path: f.path, slug: PROPOSAL_FILE.exec(f.path.slice(folder.length + 1))?.[1] }))
    .filter((f) => f.slug);
  if (!mine.length) return [];
  const comments = await forge.comments(pull.number);
  const out = [];
  for (const f of mine) {
    const review = await latestReview(forge, pull.number, f.slug, comments);
    const yes = Boolean(review && review.verdict === 'approved');
    const text = yes ? await forge.file(pull.head.sha, f.path) : null;
    const same = yes && text !== null && review.proposal === proposalHash(text);
    out.push({ slug: f.slug, path: f.path, approved: same, changed: yes && !same });
  }
  return out;
}

/**
 * Step 2, planned: the build issue for proposal `slug` of spec pull request `n`, and the issue the first run made.
 * @param {import('./forge.js').Forge} forge
 * @param {{ proposals: string }} where
 * @param {number} n
 * @param {string} slug
 * @returns {Promise<BuildPlan>}
 */
export async function planBuild(forge, where, n, slug) {
  if (typeof slug !== 'string' || !PROPOSAL_FILE.test(`${slug}.json`) || slug.endsWith('.review')) throw invalid('Say which proposal: its name in the proposals folder.');
  const pull = await forge.pull(n);
  if (pull.state !== 'open') throw conflict(`Pull request #${n} is ${pull.state}; the build issue is opened from an open spec pull request.`);
  const entry = await findPullProposal(forge, where, slug, n);
  if (!entry) throw conflict(`Pull request #${n} does not hold a proposal called ${slug}.`);
  const review = await latestReview(forge, n, slug);
  if (!review) throw conflict(`${slug} has no review by a maintainer yet; approve it first.`);
  if (review.verdict !== 'approved') throw conflict(`The latest review of ${slug} by a maintainer (${review.by}) sent it back; the build issue waits for an approval.`);
  const raw = await readPullProposal(forge, where, entry);
  // The approval covers the proposal as it was approved: a push that changed the file since waits for a new one
  if (review.proposal !== proposalHash(raw)) {
    throw conflict(review.proposal
      ? `${entry.path} has changed since ${review.by} approved it; the build issue waits for an approval of it as it is now.`
      : `The approval of ${slug} does not say which version of ${entry.path} it covers (it was made before cornfield recorded that); approve it again.`);
  }
  if (Buffer.byteLength(raw) > MAX_PROPOSAL) throw conflict(`${entry.path} is too large to list in an issue.`);
  let proposal;
  try {
    proposal = JSON.parse(raw);
  } catch {
    throw conflict(`${entry.path} at the head of pull request #${n} is not valid JSON.`);
  }
  if (!isObject(proposal) || proposal.version !== 1 || typeof proposal.title !== 'string' || !proposal.title.trim()) throw conflict(`${entry.path} is not a proposal (version 1, with a title).`);
  let approved = proposal;
  try {
    approved = review.edits.length ? applyEdits(proposal, review.edits) : proposal;
  } catch (err) {
    throw conflict(`The edits of the approval cannot be applied to ${entry.path}: ${err instanceof Error ? err.message : err}`);
  }
  const { lines, count } = checklist(approved);
  const title = `Build: ${oneLine(proposal.title, 160)}`;
  const body = clip([
    `Build the approved proposal ${code(slug)}.`,
    '',
    `- Spec pull request: #${n}`,
    `- Proposal: ${code(entry.path)} at ${code(entry.sha.slice(0, 12))}`,
    `- Approved by ${plain(review.by, 60)}${link(review.comment.url) ? `: ${link(review.comment.url)}` : ''}${review.edits.length ? `, with ${review.edits.length} edit${review.edits.length === 1 ? '' : 's'} folded in below` : ''}`,
    '',
    ...(typeof approved.summary === 'string' && approved.summary.trim() ? [`> ${plain(approved.summary, 300)}`, ''] : []),
    ...lines,
    'Opened from cornfield, which builds nothing and runs no agent: land the work in a pull request that closes this issue.',
    buildMarker(n, slug),
  ].join('\n'), MAX_BODY);
  const issues = await forge.issues({ state: 'all', limit: 200 });
  const marker = buildMarker(n, slug);
  // The issue the first run made: one with the marker, opened by a maintainer (anyone who can open an issue could copy it)
  const byMaintainer = maintainers(forge);
  let found = null;
  for (const i of issues) {
    if (i.body.includes(marker) && (await byMaintainer(i.author))) { found = i; break; }
  }
  const existing = found ? { number: found.number, url: found.url, state: found.state } : null;
  const facts = { n, slug, sha: entry.sha, path: entry.path, title, body, by: review.by };
  return {
    kind: 'build', digest: digestOf(facts), pull: { number: n, title: pull.title, url: pull.url }, slug, path: entry.path, sha: entry.sha,
    review: { by: review.by, url: review.comment.url, at: review.at }, title, body, items: count, existing,
  };
}

/**
 * Step 2, done: the build issue, made now or found. A second run finds what the first made.
 * @param {import('./forge.js').Forge} forge
 * @param {BuildPlan} plan a plan the caller has checked against what the person confirmed
 * @returns {Promise<{ created: boolean, issue: { number: number, url: string, state: string } }>}
 */
export async function openBuildIssue(forge, plan) {
  if (plan.existing) return { created: false, issue: plan.existing };
  const issue = await forge.createIssue({ title: plan.title, body: plan.body });
  return { created: true, issue: { number: issue.number, url: issue.url, state: issue.state } };
}
