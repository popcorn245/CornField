# Agents, tracked

cornfield follows coding agents by what they leave on the forge: branches, spec pull requests, pull requests. It groups them by the issue and the proposal they belong to, and marks the ones an agent made. It does not start an agent; that is a later issue ([roadmap](roadmap.md), [ADR 0007](adr/0007-track-agents-do-not-launch.md)). An agent started anywhere else shows up as soon as it pushes.

It is the **Agents** tab of the [issues and PRs panel](issues-and-prs.md), so it needs the same things: a `forge` in the [config](config.md) and a signed-in maintainer ([sign-in](sign-in.md)). Without them the tab is not there.

## What the tab shows

Groups, in this order:

1. **Proposal `<slug>`**: the open spec pull request that adds the proposal ([proposals](proposals.md)), and work whose branch name holds the slug.
2. **`#n` and the issue's title**: the pull requests and branches that belong to the issue, newest change first; a link out to the issue. An issue with no work is not listed.
3. **Not linked to an issue or a proposal**: everything else that is agent-made or a pull request.

Under each heading, a line counts what it holds ("2 pull requests, 1 branch, 2 by agents"). A pull request is a row like the one in the Pull requests tab: select it and its files and checks light the map. A branch that has no pull request yet is a row without a link. Work an agent made carries an **Agent** mark and the reason in words ("listed author claude-bot", "bot account dependabot[bot]", "label agent", "branch starts with claude/").

Two switches under the tabs: **Agent-made only**, and **Include merged and closed** (off: the open work only, which is what is in flight).

## Which work is linked to what

A pull request belongs to an issue when:

- its text says "Closes #n", "Fixes #n" or "Resolves #n" (also "closed", "fixed", "resolved", and lists such as "Closes #3, #4"; an issue in another repo, `owner/name#n`, is not this repo's, and a number that is one of the listed pull requests is not an issue, as the two share numbers); or
- its branch name starts a segment with the issue's number, like `claude/10-agents-tracked`, `fix/issue-10` or `10-agents`, and that number is an issue the forge listed (a date in `release/2026-10-19` is not an issue).

A pull request that names several issues is in the first one's group, and its row says "Also closes #4". A branch with no pull request is linked by its name in the same way.

A pull request belongs to a proposal when it is the **spec PR** of one (it adds or changes a proposal file in the proposals folder, as the Proposals menu lists them), or, with no issue, when its branch name holds the proposal's slug as whole words (`claude/0013-meals-impl` for `0013-meals`). A spec PR goes with its proposal even when it also closes an issue.

A branch with no pull request is listed only when it is agent-made or linked to an issue or a proposal; the rest of a repo's branches are not work in flight. A protected branch and the branch pull requests merge into are never listed.

## Which work is agent-made

The rule is yours to set in the config. All of it is empty by default, except that bot accounts count:

```js
export default {
  forge: { type: 'github', url: 'https://github.com', repo: 'owner/name' },
  agents: {
    authors: ['claude-bot'],         // pull requests opened by these accounts (case does not matter)
    labels: ['agent'],               // pull requests carrying one of these labels
    branchPrefixes: ['claude/'],     // branches (a pull request's head, or a branch with no pull request) starting so
    bots: true,                      // a bot account: a login ending in "[bot]", or what the forge calls a Bot (GitHub's user type)
  },
};
```

Work is agent-made when any of those holds, and the mark names the first that does, in this order: a listed author, a bot account, a label, a branch prefix. A branch with no pull request has no author or label in the forge's answers, so only its prefix can mark it. `validate` fails on a mistake in `agents` (an unknown key, a name with a space, `bots` that is not true or false).

With the defaults, then, `dependabot[bot]` and `renovate[bot]` are marked and nothing else; name your own agents' account, label or branch prefix to see theirs. `bots: false` leaves bot accounts unmarked.

Which accounts the forge calls bots: on GitHub, a user whose type is `Bot` (apps such as Dependabot). On Forgejo, a user whose `type` is `Bot` where the instance sends the type (Gitea's API does; an instance that does not simply marks no one that way), and always the Actions system user (id -2), which is who a workflow acts as. A login ending in `[bot]` counts on either forge.

## What it reads

One read-only route, behind the sign-in guard like the others in [issues and PRs](issues-and-prs.md#who-it-asks-as):

| Route | Answers |
|---|---|
| `GET /api/forge/work` | the newest 100 pull requests (any state, their text cut to 4000 characters), the newest 200 issues (any state), up to 300 branches, the open spec pull requests (`{ pull, slug }`), and the config's `agents` |

It is asked as the signed-in maintainer with their own token and kept for a minute in `forge_cache` like the lists, with an ETag; **Refresh** asks the forge again, and a rate-limited forge shows the last answer marked old. Nothing writes to the forge and nothing starts an agent: there is no new route that changes anything.

What is not seen: work older than the newest 100 pull requests, and an issue older than the newest 200 (a pull request that says "Closes #n" for one is still grouped, under "Issue #n", without its title; a branch name's number counts only for an issue that was listed). If the spec pull requests could not all be read, the panel says so and lists the rest.

## By keyboard and screen reader

The tab is a button in the panel's Show group, like the other two. Each group is a heading with the list under it, so a screen reader can move by headings; the two switches are checkboxes. Loading, a switch changing and a failure are said through the map's live region ([accessibility](accessibility.md)); the mark is the word "Agent" and its reason, not a colour. On a phone it is the same bottom sheet.
