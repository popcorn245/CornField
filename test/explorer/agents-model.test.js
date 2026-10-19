/**
 * @vitest-environment node
 *
 * The agents view without a page (CF-09, explorer/agents-model.js): which work is agent-made and why (authors, bot
 * accounts, labels, branch prefixes), which issue and proposal a pull request or a branch belongs to, the groups,
 * and the filters. Nothing here asks a forge or launches anything (ADR 0007).
 */
import { describe, it, expect } from 'vitest';
import {
  agentRules, isBot, agentMark, markWords, closedIssues, branchNumbers, holdsSlug, linksOf, groupWork, filterGroups, groupWords, workStatus,
  // @ts-expect-error plain JS modules, no declarations
} from '../../explorer/agents-model.js';

const user = (login, extra = {}) => ({ login, url: null, ...extra });
const pull = (number, ref, extra = {}) => ({
  number, title: `Pull ${number}`, body: '', state: 'open', draft: false, author: user('maintainer-one'), labels: [], head: { ref, sha: `sha${number}` }, base: { ref: 'main' },
  url: `https://git.example.test/pull/${number}`, createdAt: '2026-10-17T10:00:00Z', updatedAt: `2026-10-17T${10 + (number % 10)}:00:00Z`, mergedAt: null, ...extra,
});
const issue = (number, title, extra = {}) => ({ number, title, state: 'open', author: user('maintainer-one'), labels: [], comments: 0, url: `https://git.example.test/issues/${number}`, createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z', closedAt: null, ...extra });
const branch = (name, extra = {}) => ({ name, sha: 'x', protected: false, ...extra });

const RULES = agentRules({ authors: ['Claude-Bot'], labels: ['Agent'], branchPrefixes: ['claude/'] });

describe('the rules', () => {
  it('are empty by default, with bot accounts counted, and tolerate anything the config did not say', () => {
    expect(agentRules(undefined)).toEqual({ authors: [], labels: [], branchPrefixes: [], bots: true });
    expect(agentRules({ bots: false, authors: 'x', labels: [1, '', 'a'] })).toEqual({ authors: [], labels: ['a'], branchPrefixes: [], bots: false });
  });
});

describe('who is an agent', () => {
  it('a listed author, whatever the case', () => {
    expect(agentMark(pull(1, 'x', { author: user('claude-bot') }), RULES)).toEqual({ by: 'author', detail: 'claude-bot' });
  });

  it('a bot account: the [bot] suffix, or what the forge itself says', () => {
    expect(isBot(user('dependabot[bot]'))).toBe(true);
    expect(isBot(user('some-app', { bot: true }))).toBe(true);
    expect(isBot(user('maintainer-one'))).toBe(false);
    expect(isBot(null)).toBe(false);
    expect(agentMark(pull(1, 'x', { author: user('dependabot[bot]') }), RULES)).toEqual({ by: 'bot', detail: 'dependabot[bot]' });
    expect(agentMark(pull(1, 'x', { author: user('some-app', { bot: true }) }), RULES)).toMatchObject({ by: 'bot' });
  });

  it('bots can be turned off, and then only the lists count', () => {
    const off = agentRules({ bots: false });
    expect(agentMark(pull(1, 'x', { author: user('dependabot[bot]') }), off)).toBe(null);
  });

  it('a label, whatever the case', () => {
    expect(agentMark(pull(1, 'x', { labels: ['v1', 'agent'] }), RULES)).toEqual({ by: 'label', detail: 'agent' });
  });

  it('a branch that starts with a prefix, the pull request\'s head or a branch alone', () => {
    expect(agentMark(pull(1, 'claude/1-x'), RULES)).toEqual({ by: 'branch', detail: 'claude/' });
    expect(agentMark({ head: { ref: 'claude/solo' } }, RULES)).toEqual({ by: 'branch', detail: 'claude/' });
    expect(agentMark(pull(1, 'feature/claude/x'), RULES)).toBe(null);
  });

  it('nothing is an agent when no rule holds, and the first rule that does is the reason', () => {
    expect(agentMark(pull(1, 'feature/x'), RULES)).toBe(null);
    expect(agentMark(pull(1, 'feature/x', { author: null }), agentRules({}))).toBe(null);
    expect(agentMark(pull(1, 'claude/x', { author: user('claude-bot'), labels: ['agent'] }), RULES).by).toBe('author');
    expect(agentMark(pull(1, 'claude/x', { author: user('a[bot]'), labels: ['agent'] }), RULES).by).toBe('bot');
    expect(agentMark(pull(1, 'claude/x', { labels: ['agent'] }), RULES).by).toBe('label');
  });

  it('says why in words', () => {
    expect(markWords({ by: 'bot', detail: 'a[bot]' })).toBe('bot account a[bot]');
    expect(markWords({ by: 'author', detail: 'claude-bot' })).toBe('listed author claude-bot');
    expect(markWords({ by: 'label', detail: 'agent' })).toBe('label agent');
    expect(markWords({ by: 'branch', detail: 'claude/' })).toBe('branch starts with claude/');
    expect(markWords(null)).toBe('');
  });
});

describe('which issue', () => {
  it('"Closes", "Fixes" and "Resolves", in any form, with lists; another repo\'s issue is not one', () => {
    expect(closedIssues('Closes #10')).toEqual([10]);
    expect(closedIssues('fixes: #3, #4 and #5.\n\nresolved #6')).toEqual([3, 4, 5, 6]);
    expect(closedIssues('Fix #7 and close #7')).toEqual([7]);
    expect(closedIssues('Closes other/repo#9')).toEqual([]);
    expect(closedIssues('See #12, relates to #13, prefixes #14')).toEqual([]);
    expect(closedIssues('Closes the loop')).toEqual([]);
    expect(closedIssues('')).toEqual([]);
    expect(closedIssues(null)).toEqual([]);
  });

  it('a number at the start of a segment of the branch name', () => {
    expect(branchNumbers('claude/10-agents-tracked')).toEqual([10]);
    expect(branchNumbers('10-agents')).toEqual([10]);
    expect(branchNumbers('fix/issue-12')).toEqual([12]);
    expect(branchNumbers('issues/12')).toEqual([12]);
    expect(branchNumbers('bugfix/issue_12-x')).toEqual([12]);
    expect(branchNumbers('feature/#7')).toEqual([7]);
    expect(branchNumbers('claude/v2-3')).toEqual([]);
    expect(branchNumbers('feature/meals')).toEqual([]);
    expect(branchNumbers('release/2026-10-19')).toEqual([2026]); // a date is a number: linksOf only takes one that is a listed issue
  });

  it('a pull request: its text first, then its branch when the number is an issue the forge listed, never itself', () => {
    const known = { issues: new Map([[10, {}], [11, {}], [13, {}]]), specs: new Map(), slugs: [] };
    expect(linksOf(pull(20, 'claude/11-x', { body: 'Closes #10' }), known).issues).toEqual([10, 11]);
    expect(linksOf(pull(20, 'claude/99-x'), known).issues).toEqual([]);
    expect(linksOf(pull(13, 'claude/13-x'), known).issues).toEqual([]);
    expect(linksOf(pull(20, 'release/2026-10-19'), known).issues).toEqual([]);
    expect(linksOf({ name: 'claude/10-solo' }, known).issues).toEqual([10]);
  });
});

describe('which proposal', () => {
  const known = { issues: new Map(), specs: new Map([[30, ['0013-meals']]]), slugs: ['0013-meals'] };
  it('a spec PR is its proposal\'s; other work holds the slug in its branch name as whole words', () => {
    expect(linksOf(pull(30, 'spec/meals'), known)).toMatchObject({ proposal: '0013-meals', spec: true });
    expect(linksOf(pull(31, 'claude/0013-meals-impl'), known)).toMatchObject({ proposal: null, spec: false, bySlug: '0013-meals' });
    expect(linksOf(pull(32, 'claude/00130-meals'), known).bySlug).toBe(null);
    expect(holdsSlug('claude/0013-meals', '0013-meals')).toBe(true);
    expect(holdsSlug('Claude/0013-Meals', '0013-meals')).toBe(true);
    expect(holdsSlug('claude/x0013-meals', '0013-meals')).toBe(false);
  });
});

describe('the groups', () => {
  const work = {
    agents: { authors: ['claude-bot'], labels: ['agent'], branchPrefixes: ['claude/'], bots: true },
    issues: [issue(10, '[CF-09] Agents, tracked'), issue(5, 'Sign-in'), issue(2, 'Adapters', { state: 'closed' })],
    pulls: [
      pull(40, 'claude/10-agents-tracked', { body: 'Closes #10', author: user('claude-bot'), updatedAt: '2026-10-19T10:00:00Z' }),
      pull(41, 'feature/signin', { body: 'Fixes #5, #10', updatedAt: '2026-10-18T10:00:00Z' }),
      pull(42, 'dependabot/npm/vitest', { author: user('dependabot[bot]'), updatedAt: '2026-10-17T10:00:00Z' }),
      pull(43, 'spec/meals', { title: 'Meals spec', updatedAt: '2026-10-16T10:00:00Z' }),
      pull(44, 'claude/0013-meals-impl', { labels: ['agent'], updatedAt: '2026-10-15T10:00:00Z' }),
      pull(45, 'old', { state: 'merged', body: 'Resolves #2', author: user('claude-bot'), updatedAt: '2026-10-11T10:00:00Z' }),
      pull(46, 'claude/777-gone', { state: 'closed', updatedAt: '2026-10-10T10:00:00Z', body: 'Closes #777' }),
    ],
    branches: [
      branch('main', { protected: true }),
      branch('claude/10-agents-tracked'), // the head of #40: in its pull request
      branch('claude/5-signin-notes'), // agent, issue 5, no pull request yet
      branch('claude/scratch'), // agent, linked to nothing
      branch('topic/other'), // not an agent, nothing links it: left out
      branch('topic/10-human'), // not an agent but linked to #10
      branch('release/2026-10-19'), // a date, not an issue
    ],
    specs: [{ pull: 43, slug: '0013-meals' }],
  };
  const { groups } = groupWork(work);
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
  const ids = (g) => g.entries.map((e) => (e.type === 'pull' ? `#${e.pull.number}` : e.branch.name));

  it('puts proposals first, then issues by their latest change, then what links to neither', () => {
    expect(groups.map((g) => g.id)).toEqual(['proposal:0013-meals', 'issue:10', 'issue:5', 'issue:2', 'issue:777', 'none']);
  });

  it('a proposal holds its spec PR and the work whose branch names it', () => {
    expect(ids(byId['proposal:0013-meals'])).toEqual(['#43', '#44']);
    expect(byId['proposal:0013-meals']).toMatchObject({ kind: 'proposal', title: 'Proposal 0013-meals', slug: '0013-meals', agents: 1 });
    expect(byId['proposal:0013-meals'].entries[0]).toMatchObject({ proposal: '0013-meals', mark: null });
  });

  it('an issue holds its pull requests and its branches, with the agent-made ones marked and why', () => {
    const g = byId['issue:10'];
    expect(g).toMatchObject({ kind: 'issue', number: 10, title: '#10 [CF-09] Agents, tracked', agents: 1 });
    expect(g.issue.url).toBe('https://git.example.test/issues/10');
    expect(ids(g)).toEqual(['#40', 'topic/10-human']);
    expect(g.entries[0].mark).toEqual({ by: 'author', detail: 'claude-bot' });
    expect(g.entries[1].mark).toBe(null);
    expect(byId['issue:5'].entries.map((e) => [e.type === 'pull' ? e.pull.number : e.branch.name, e.mark && e.mark.by])).toEqual([[41, null], ['claude/5-signin-notes', 'branch']]);
    // #41 also closes #10: its group is the first issue, the rest is said in the row
    expect(byId['issue:5'].entries[0].issues).toEqual([5, 10]);
  });

  it('an issue the forge did not list is still a group, named by its number', () => {
    expect(byId['issue:777']).toMatchObject({ title: 'Issue #777', issue: null });
  });

  it('what links to nothing is its own group: a bot\'s pull request, an agent branch with no pull request; not a branch nobody tied to anything', () => {
    expect(ids(byId.none)).toEqual(['#42', 'claude/scratch']);
    expect(byId.none).toMatchObject({ kind: 'none', title: 'Not linked to an issue or a proposal', agents: 2 });
    expect(JSON.stringify(groups)).not.toContain('topic/other');
    expect(JSON.stringify(groups)).not.toContain('release/2026-10-19');
    expect(groups.flatMap((g) => g.entries).filter((e) => e.type === 'branch').map((e) => e.branch.name).sort()).toEqual(['claude/5-signin-notes', 'claude/scratch', 'topic/10-human']);
  });

  it('an issue with no work is not a group', () => {
    expect(groupWork({ ...work, pulls: [], branches: [], specs: [] }).groups).toEqual([]);
    expect(groupWork({}).groups).toEqual([]);
  });

  it('without any rule, only bot accounts are agents; with bots off, none', () => {
    const plain = groupWork({ ...work, agents: undefined });
    const marked = plain.groups.flatMap((g) => g.entries).filter((e) => e.mark).map((e) => e.pull.number);
    expect(marked).toEqual([42]);
    expect(groupWork({ ...work, agents: { bots: false } }).groups.flatMap((g) => g.entries).some((e) => e.mark)).toBe(false);
  });
});

describe('the filters and the words', () => {
  const work = {
    agents: { branchPrefixes: ['claude/'] },
    issues: [issue(10, 'Agents')],
    pulls: [pull(40, 'claude/10-a', { body: 'Closes #10' }), pull(41, 'human', { body: 'Closes #10', state: 'merged' }), pull(42, 'other', { state: 'closed' })],
    branches: [branch('claude/10-b')],
  };
  const { groups } = groupWork(work);

  it('shows open work only unless asked for the finished too; a group left empty goes', () => {
    const open = filterGroups(groups, {});
    expect(open.map((g) => g.id)).toEqual(['issue:10']);
    expect(open[0].entries.map((e) => (e.type === 'pull' ? e.pull.number : e.branch.name))).toEqual([40, 'claude/10-b']);
    expect(filterGroups(groups, { finished: true }).flatMap((g) => g.entries)).toHaveLength(4);
    expect(filterGroups(groups, { finished: true }).map((g) => g.id)).toEqual(['issue:10', 'none']);
  });

  it('agent-made only keeps the marked ones, and counts them', () => {
    const only = filterGroups(groups, { agentsOnly: true, finished: true });
    expect(only).toHaveLength(1);
    expect(only[0].entries).toHaveLength(2);
    expect(only[0].agents).toBe(2);
    expect(filterGroups(groupWork({ pulls: [pull(1, 'human')] }).groups, { agentsOnly: true })).toEqual([]);
  });

  it('counts a group in words, and the view in a line', () => {
    expect(groupWords(groups[0])).toBe('2 pull requests, 1 branch, 2 by agents');
    expect(groupWords({ entries: [{ type: 'pull' }], agents: 0 })).toBe('1 pull request, none by agents');
    expect(groupWords({ entries: [{ type: 'branch' }], agents: 1 })).toBe('1 branch, 1 by an agent');
    const open = filterGroups(groups, {});
    expect(workStatus(open, '2026-10-19T11:58:00.000Z', Date.parse('2026-10-19T12:00:00Z'))).toBe('1 group, 2 pieces of work, 2 by agents, as of 2 minutes ago');
    expect(workStatus([], '', 0)).toBe('0 groups, 0 pieces of work, 0 by agents');
  });
});
