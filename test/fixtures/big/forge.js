/**
 * A signed-in maintainer, with a forge, for the big map: the real cornfield server with sign-in turned on, talking to a fake GitHub
 * on loopback (test/server/fake-forge.js, the recorded answers of test/fixtures/forge/github.json), so the real sign-in page, the real
 * OAuth round trip, the Work panel (PRs, issues, threads, checks), the Specs tab (a spec PR per rich proposal) and the Runs tab work.
 *
 * Faked, and how faithfully:
 *  - the forge: GitHub's REST answers as recorded (the same ones the server tests use), plus one open spec PR for each rich proposal
 *    holding its file (and mockup) at the PR's head. The authorize step has no page: it redirects straight back, as GitHub does for an
 *    app already authorized. One maintainer, `maintainer-one`.
 *  - agent runs: rows written into cornfield.db before the server starts (every state: requested, claimed, working, waiting, done, failed,
 *    stopped). The server reads them exactly as it reads its own. No runner process exists; the runner is "online" while a runner token
 *    shows a recent poll, which this module refreshes every 20 seconds, and "offline" when the token's last poll is two days old.
 *    Toggle at run time: GET <forge origin>/__rig/runner?state=offline (or online, or none for a runner that never polled). The runs use the pull transport, so a queued run waits for a runner.
 *  - nothing is ever written to a real forge, and no token is real.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { openStore } from '../../../server/db.js';
import { fakeForge, recordings } from '../../server/fake-forge.js';
import { reviewComment, proposalHash } from '../../../server/reviews.js';

export const REPO = 'owner/name';
export const MAINTAINER = 'maintainer-one';
const API = '/api/v3';
const GH = `${API}/repos/${REPO}`;
const FOLDER = 'docs/specs/proposals';
/** Sign-in for the fake forge only: a fake client, and a session secret made fresh on each run (never stored, never reused) */
export const SIGN_IN_ENV = { CORNFIELD_GITHUB_CLIENT_ID: 'rig-client-id', CORNFIELD_GITHUB_CLIENT_SECRET: 'not-real', CORNFIELD_SESSION_SECRET: `rig-${randomBytes(24).toString('hex')}` };

const sha = (n) => createHash('sha1').update(`rig-${n}`).digest('hex');
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

/** The rich proposals each get an open spec PR: numbers 21, 22, ... in slug order */
export const SPEC_PR_FIRST = 21;

/**
 * What each spec PR looks like to the maintainer (spec 0010), by its place in slug order, so every group and state of the Specs list shows:
 *   0 ready, never reviewed, pushed 50 h ago (To decide, and the one with a run waiting)   1 a draft PR (With the agent)
 *   2 ready, approved, the file unchanged since (Approved)                                 3 ready, sent back after the last push (With the agent)
 *   4 ready, approved, then the file changed (Changed since approved, To decide)           5 a draft PR
 * `pushedHoursAgo` dates the head commit; `review` is a comment by the maintainer, as cornfield writes one.
 */
export const SPEC_LOOKS = [
  { pushedHoursAgo: 50 }, { draft: true }, { review: { verdict: 'approved', hoursAgo: 3 } }, { pushedHoursAgo: 3, review: { verdict: 'notes', note: 'Say what happens to the old export first.', hoursAgo: 1 } },
  { pushedHoursAgo: 20, review: { verdict: 'approved', hoursAgo: 30, stale: true } }, { draft: true },
];

/**
 * @param {{ repoFiles: Record<string, string>, slugs: string[], port: number, runner?: 'online'|'offline'|'none', dataDir: string, delayMs?: number }} opts
 *   `repoFiles` maps a repo path to its text (the generated repo's files: the proposals and their mockups are served from it)
 */
export async function startForgeWorld({ repoFiles, slugs, port, runner = 'online', dataDir, delayMs = 0 }) {
  const base = recordings('github');
  const rich = slugs.filter((s) => /^01\d\d-/.test(s));
  const specs = rich.map((slug, i) => ({ slug, n: SPEC_PR_FIRST + i, sha: sha(slug) }));
  const user = (login) => ({ login, html_url: `https://github.example.com/${login}` });
  const pullOf = (s) => {
    const title = JSON.parse(repoFiles[`${FOLDER}/${s.slug}.json`]).title;
    return { number: s.n, title: `Spec: ${title}`, state: 'open', draft: state.draft.has(s.n) ? state.draft.get(s.n) : !!SPEC_LOOKS[s.n - SPEC_PR_FIRST]?.draft, user: user('agent-four'), labels: [{ name: 'spec' }], head: { ref: `spec/${s.slug}`, sha: s.sha }, base: { ref: 'main', sha: sha('main') }, html_url: `https://github.example.com/${REPO}/pull/${s.n}`, created_at: minutesAgo(600 - s.n * 10), updated_at: minutesAgo(30), merged_at: null };
  };
  const mockupsOf = (slug) => Object.keys(repoFiles).filter((f) => f.startsWith(`${FOLDER}/${slug}/`));
  // `checks`: a spec PR's checks as the rig was told (GET /__rig/checks?pr=21&state=passed|running|failed|none); unset is one passed, one running.
  // `draft` and `edited`: a spec PR marked draft or ready, and a proposal file the agent pushed a change to (GET /__rig/pull, below)
  // `merged`: the heads a landing merged (the PR stays open in the rig, so it can be reviewed again; GET /__rig/pull says what was merged)
  const state = { delayMs, runner, checks: new Map(), draft: new Map(), edited: new Map(), merged: [] };
  const comments = new Map(); // issue or PR number -> the comments posted to it since the rig started
  let nextComment = 9900;
  // The reviews the looks above name, posted as comments (kept in memory, like the ones a maintainer posts while the rig runs)
  specs.forEach((sp, i) => {
    const review = SPEC_LOOKS[i]?.review;
    if (!review) return;
    const text = repoFiles[`${FOLDER}/${sp.slug}.json`];
    const at = minutesAgo(review.hoursAgo * 60);
    const body = reviewComment(sp.slug, { verdict: review.verdict, note: review.note || '', edits: [], ...(review.verdict === 'approved' ? { proposal: review.stale ? '0'.repeat(64) : proposalHash(text) } : {}) }, { login: MAINTAINER });
    comments.set(sp.n, [{ id: nextComment++, user: user(MAINTAINER), body, html_url: `https://github.example.com/${REPO}/issues/${sp.n}#issuecomment-${nextComment - 1}`, created_at: at, updated_at: at }]);
  });
  let touchRunner = () => {};

  // `delayMs`: every answer of the forge waits this long (a real repo's forge takes 100 to 200 ms a request); GET /__rig/delay?ms=150 sets it at run time
  const dispatch = async (key, req) => {
    if (state.delayMs > 0 && !key.includes('/__rig/')) await new Promise((r) => setTimeout(r, state.delayMs));
    return answer(key, req);
  };
  const answer = (key, req) => {
    const space = key.indexOf(' ');
    const method = key.slice(0, space);
    const target = key.slice(space + 1);
    const url = new URL(target, 'http://x');
    const p = decodeURIComponent(url.pathname);
    if (p === '/__rig/checks') {
      const pr = Number(url.searchParams.get('pr'));
      const want = url.searchParams.get('state');
      if (specs.some((x) => x.n === pr) && ['passed', 'running', 'failed', 'none', 'default'].includes(want)) { if (want === 'default') state.checks.delete(pr); else state.checks.set(pr, want); }
      return { body: { checks: Object.fromEntries(state.checks) } };
    }
    // The agent pushes (`push=commit`: a new head, the proposal unchanged; `push=file`: a new head that changes the proposal file), or the PR is
    // marked draft or ready (`draft=1|0`): GET /__rig/pull?pr=21&push=file&draft=0
    if (p === '/__rig/pull') {
      const spec = specs.find((x) => x.n === Number(url.searchParams.get('pr')));
      if (!spec) return { status: 404, body: { message: 'Not a spec PR of the rig' } };
      const push = url.searchParams.get('push');
      if (push === 'commit' || push === 'file') {
        spec.pushes = (spec.pushes || 0) + 1;
        spec.sha = sha(`${spec.slug}#${spec.pushes}`);
        if (push === 'file') { const file = `${FOLDER}/${spec.slug}.json`; state.edited.set(file, `${(state.edited.get(file) ?? repoFiles[file]).trimEnd()}\n${' '.repeat(spec.pushes)}\n`); }
      }
      const draft = url.searchParams.get('draft');
      if (draft === '1' || draft === '0') state.draft.set(spec.n, draft === '1');
      return { body: { pr: spec.n, head: spec.sha, draft: pullOf(spec).draft, merged: state.merged.filter((x) => x.pr === spec.n) } };
    }
    // What the server asked of the forge (the idle-cost check): the count of calls, and the last few, not counting these
    if (p === '/__rig/requests') {
      const real = forge.requests.filter((r) => !r.url.startsWith('/__rig/'));
      return { body: { count: real.length, last: real.slice(-Number(url.searchParams.get('last') || 0) || real.length).map((r) => `${r.method} ${r.url}`).slice(-50) } };
    }
    if (p === '/__rig/delay') {
      if (url.searchParams.has('ms')) state.delayMs = Math.max(0, Math.min(5000, Number(url.searchParams.get('ms')) || 0));
      return { body: { delayMs: state.delayMs } };
    }
    if (p === '/__rig/runner') {
      if (['online', 'offline', 'none'].includes(url.searchParams.get('state'))) { state.runner = /** @type {any} */ (url.searchParams.get('state')); touchRunner(); }
      return { body: { runner: state.runner } };
    }
    if (method === 'GET' && p === '/login/oauth/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri') || '');
      back.searchParams.set('code', 'rig-code');
      back.searchParams.set('state', url.searchParams.get('state') || '');
      return { status: 302, headers: { location: back.toString() } };
    }
    if (method === 'POST' && p === '/login/oauth/access_token') return { body: { access_token: 'rig-token', token_type: 'bearer' } };
    if (method === 'DELETE' && p.startsWith(`${API}/applications/`)) return { status: 204 };
    // The recorded lists page through a `Link` header that points at `/repositories/<id>/...` (outside the API prefix): the recorded second pages answer
    if (!p.startsWith(API)) return base[`${method} ${p}${url.search}`] || { status: 404, body: { message: 'Not Found' } };
    const rest = p.slice(API.length);
    if (method === 'GET' && rest === '/user') return base['GET /user'];
    if (method === 'GET' && rest === `/repos/${REPO}`) return base[`GET /repos/${REPO}`];
    let m;
    if (method === 'GET' && (m = /^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/.exec(rest))) return { body: { permission: 'write', role_name: m[1] === MAINTAINER ? 'maintain' : 'read', user: { login: m[1] } } };
    // pull requests: the recorded ones, and one spec PR per rich proposal
    if (method === 'GET' && rest === `/repos/${REPO}/pulls`) {
      const state_ = url.searchParams.get('state');
      const old = base[`GET /repos/${REPO}/pulls?state=${state_ === 'closed' ? 'closed' : 'open'}&sort=created&direction=desc&per_page=100`]?.body || [];
      return { body: state_ === 'closed' ? old : [...specs.map(pullOf), ...old] };
    }
    if ((m = new RegExp(`^/repos/${REPO}/pulls/(\\d+)(/files|/commits)?$`).exec(rest)) && method === 'GET') {
      const spec = specs.find((s) => s.n === Number(m[1]));
      if (spec) {
        if (m[2] === '/files') return { body: [{ sha: 'f1', filename: `${FOLDER}/${spec.slug}.json`, status: 'added', additions: 80, deletions: 0, changes: 80 }, ...mockupsOf(spec.slug).map((f, i) => ({ sha: `m${i}`, filename: f, status: 'added', additions: 1, deletions: 0, changes: 1 }))] };
        if (m[2] === '/commits') { const pushed = minutesAgo((SPEC_LOOKS[spec.n - SPEC_PR_FIRST]?.pushedHoursAgo ?? 0.7) * 60); return { body: [{ sha: spec.sha, commit: { message: `Spec ${spec.slug}`, author: { name: 'agent-four', date: pushed }, committer: { date: pushed } }, author: user('agent-four') }] }; }
        return { body: { ...pullOf(spec), mergeable: true, mergeable_state: 'clean', merged: false } };
      }
    }
    if (method === 'PUT' && (m = new RegExp(`^/repos/${REPO}/pulls/(\\d+)/merge$`).exec(rest)) && specs.some((s) => s.n === Number(m[1]))) {
      const spec = specs.find((s) => s.n === Number(m[1]));
      const asked = JSON.parse(req.body || '{}').sha;
      if (asked && asked !== spec.sha) return { status: 409, body: { message: 'Head branch was modified. Review and try the merge again.' } };
      state.merged.push({ pr: spec.n, sha: spec.sha, at: new Date().toISOString() });
      return { body: { sha: sha(`merge-${spec.n}-${state.merged.length}`), merged: true, message: 'Pull Request successfully merged' } };
    }
    if (method === 'GET' && (m = new RegExp(`^/repos/${REPO}/issues/(\\d+)/comments$`).exec(rest)) && specs.some((s) => s.n === Number(m[1]))) return { body: comments.get(Number(m[1])) || [] };
    // a spec PR's head holds its file and mockups; anything else at that sha is not there
    if (method === 'GET' && rest.startsWith(`/repos/${REPO}/contents/`)) {
      const file = rest.slice(`/repos/${REPO}/contents/`.length);
      const spec = specs.find((s) => s.sha === url.searchParams.get('ref'));
      const text = spec && file.startsWith(`${FOLDER}/${spec.slug}`) ? state.edited.get(file) ?? repoFiles[file] : undefined;
      if (text !== undefined) return { headers: { 'content-type': 'application/vnd.github.raw; charset=utf-8' }, body: text };
    }
    if (method === 'GET' && (m = new RegExp(`^/repos/${REPO}/commits/([0-9a-f]{40})/(check-runs|status)$`).exec(rest)) && specs.some((s) => s.sha === m[1])) {
      if (m[2] === 'status') return { body: { state: 'success', statuses: [], total_count: 0 } };
      const spec = specs.find((x) => x.sha === m[1]);
      const mode = state.checks.get(spec.n) || 'default';
      const run = (id, name, status, conclusion) => ({ id, name, status, conclusion, html_url: `https://github.example.com/${REPO}/actions/runs/9/job/${id}`, details_url: `https://github.example.com/${REPO}/actions/runs/9/job/${id}`, app: { slug: 'github-actions' } });
      const sets = {
        default: [run(51, 'validate', 'completed', 'success'), run(52, 'docs', 'in_progress', null)],
        passed: [run(51, 'validate', 'completed', 'success'), run(52, 'docs', 'completed', 'success')],
        running: [run(51, 'validate', 'completed', 'success'), run(52, 'docs', 'in_progress', null)],
        failed: [run(51, 'validate', 'completed', 'success'), run(53, 'lint', 'completed', 'failure')],
        none: [],
      };
      return { body: { total_count: sets[mode].length, check_runs: sets[mode] } };
    }
    // everything else: the recorded answers, as the server tests use them
    const recordedKey = `${method} ${rest}${url.search}`;
    const hit = base[recordedKey];
    if (hit) return hit;
    if (method === 'GET' && rest === `/repos/${REPO}/issues`) return base[`GET /repos/${REPO}/issues?state=open&sort=created&direction=desc&per_page=100`] ? { body: base[`GET /repos/${REPO}/issues?state=open&sort=created&direction=desc&per_page=100`].body } : { body: [] };
    if (method === 'GET' && /\/issues\/\d+\/comments$/.test(rest)) return { body: [] };
    if (method === 'POST' && (m = /\/issues\/(\d+)\/comments$/.exec(rest))) {
      // A comment is kept (in memory), so what is posted reads back: an approval shows in the Work panel and on the proposal
      const at = new Date().toISOString();
      const made = { id: nextComment++, user: user(MAINTAINER), body: JSON.parse(req.body || '{}').body || '', html_url: `https://github.example.com/${REPO}/issues/${m[1]}#issuecomment-${nextComment - 1}`, created_at: at, updated_at: at };
      comments.set(Number(m[1]), [...(comments.get(Number(m[1])) || []), made]);
      return { status: 201, body: made };
    }
    return { status: 404, body: { message: 'Not Found' } };
  };
  const routes = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? (req) => dispatch(key, req) : undefined) });
  const forge = await fakeForge(routes, port);

  seedRuns(dataDir, specs);
  const setRunner = () => {
    const db = openStore(dataDir);
    try {
      db.exec("DELETE FROM review_tokens WHERE scope = 'runner' AND label LIKE 'rig-runner%'");
      if (state.runner !== 'none') db.prepare("INSERT INTO review_tokens (token_hash, user_id, login, label, created_at, expires_at, last_used, scope) VALUES (?, '1001', ?, 'rig-runner', ?, ?, ?, 'runner')")
        .run(createHash('sha256').update(`rig-runner-${Date.now()}`).digest('hex'), MAINTAINER, minutesAgo(3000), new Date(Date.now() + 29 * 86_400_000).toISOString(), state.runner === 'online' ? new Date().toISOString() : minutesAgo(2 * 24 * 60));
    } finally { db.close(); }
  };
  touchRunner = setRunner;
  setRunner();
  const timer = setInterval(() => { if (state.runner === 'online') setRunner(); }, 20_000);
  timer.unref();
  return { forge, specs, close: async () => { clearInterval(timer); await forge.close(); } };
}

/** One run in each state, about issues and the spec PRs: written as the server writes them, before it starts */
export function seedRuns(dataDir, specs) {
  const db = openStore(dataDir);
  try {
    db.exec(`DELETE FROM runs WHERE repo = '${REPO}'`);
    const insert = db.prepare(`INSERT INTO runs (run_id, repo, kind, profile, issue, proposal, target, comment_id, comment_url, request, requested_by, requested_by_id, requested_at, via, state, reported_at, reported_by, note, url, tokens, cost, stop_requested_at, stop_requested_by, last_activity, transport, pull, pull_state, pull_url, pull_by, pull_trusted, branch, head_sha, checks)
      VALUES (:id, :repo, :kind, :profile, :issue, :proposal, :target, :cid, :curl, :request, :by, '1001', :at, 'dashboard', :state, :reported_at, :reported_by, :note, :url, :tokens, :cost, :stop_at, :stop_by, :last, 'pull', :pull, :pull_state, :pull_url, :pull_by, :trusted, :branch, :head, :checks)`);
    const rows = [
      ['requested', 'Make the empty states friendlier', 5, null, 4, null, null, null],
      ['claimed', 'Add the CSV export to the orders list', 5, null, 10, null, null, null],
      ['working', 'Split the settings page in two', 12, null, 20, 'working', 'Reading the page and its tests.', { pull: 13, branch: 'claude/13-lint', checks: 'running' }],
      ['waiting', `Draft the spec for ${specs[0]?.slug || 'a proposal'}`, null, specs[0]?.slug || null, 35, 'waiting', 'Plan ready: approve to build, or tell me what to change.', null],
      ['done', 'Fix the broken link in the footer', 5, null, 180, 'done', 'Merged-ready: one file changed, the checks pass.', { pull: 14, branch: 'claude/14-footer', checks: 'success' }],
      ['failed', 'Upgrade the date picker', 12, null, 240, 'failed', 'The tests fail on the new version and I could not fix them in 20 minutes.', { pull: null, branch: 'claude/upgrade-picker', checks: 'failure' }],
      ['stopped', 'Rename the orders table everywhere', 12, null, 300, 'stopped', 'Stopped by a maintainer.', null],
    ];
    rows.forEach(([name, brief, issue, proposal, ago, report, note, extra], i) => {
      const runId = `run-01RIGRUN${String(i).padStart(18, '0')}`; // 'run-' and 26 characters, as the API takes
      const at = minutesAgo(ago + 5);
      const request = { version: 1, runId, kind: proposal ? 'spec' : 'code', refs: proposal ? { proposal } : { issue }, brief, requestedBy: MAINTAINER, requestedAt: at.replace(/\.\d{3}Z$/, 'Z') };
      const stopped = name === 'stopped';
      insert.run({
        id: runId, repo: REPO, kind: request.kind, profile: i % 2 ? 'builder' : null, issue: proposal ? null : issue, proposal: proposal ?? null, target: proposal ? specs[0]?.n ?? 21 : issue, cid: '', curl: null,
        request: JSON.stringify(request), by: MAINTAINER, at, state: name,
        reported_at: report ? minutesAgo(ago) : null, reported_by: report ? 'runner:rig-runner' : null, note: note ?? null, url: report ? 'https://runner.example.test/logs/' + runId : null, tokens: report ? 41000 + i * 3000 : null, cost: report ? 0.4 + i * 0.35 : null,
        stop_at: stopped ? minutesAgo(ago) : null, stop_by: stopped ? MAINTAINER : null, last: minutesAgo(ago),
        pull: extra?.pull ?? null, pull_state: extra?.pull ? 'open' : null, pull_url: extra?.pull ? `https://github.example.com/${REPO}/pull/${extra.pull}` : null, pull_by: extra?.pull ? 'agent-four' : null, trusted: extra?.pull ? 1 : 0, branch: extra?.branch ?? null, head: extra?.pull ? sha(`run${i}`) : null, checks: extra?.checks ?? null,
      });
    });
  } finally { db.close(); }
}

/** The repo's files as the fake forge serves them: the generated repo, read back from disk */
export function readRepoFiles(repo) {
  const out = {};
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (r.startsWith(FOLDER) || FOLDER.startsWith(r)) walk(path.join(dir, e.name), r); } else if (r.startsWith(`${FOLDER}/`)) out[r] = fs.readFileSync(path.join(dir, e.name), 'utf8');
    }
  };
  walk(repo, '');
  return out;
}
