# Threads

A thread is a conversation about an idea or a spec, and it lives on your forge. cornfield shows it next to the map, points it at the nodes it is about, and says when something new is said. It keeps none of it: delete cornfield and every thread is still there, on the forge, with the people and the tools that wrote it ([spec 0005](specs/0005-threads-and-agents.md), decisions D6 and D7).

It needs what the [issues and PRs panel](issues-and-prs.md) needs: a `forge` in the [config](config.md) and a signed-in maintainer ([sign-in](sign-in.md)). `threads: false` in the config turns it all off.

## What a thread is

- **An idea** is an issue with the label `idea`. Its thread is the issue's text and its comments. Name another label with `threads: { label: 'rfc' }` in the config (`false` turns threads off). An issue without the label is not a thread; a label added to an old issue makes it one from then on.
- **A proposal's thread** is the conversation of its spec pull request: an open pull request that adds or changes a [proposal](proposals.md).
- **A spec PR names its idea** with `Thread: #41` or `Closes #41` in its description (outside code; an issue of another repo does not count). The idea then lists its proposals, and the proposal's thread says which idea it names.

Writing in a thread needs nothing from cornfield: people, agents and bridges comment on the forge as themselves. cornfield adds structure only with conventions in the text.

## Pointing a thread at the map

| Write | It means |
|---|---|
| `[[core-server-auth]]` | the node with that id |
| `[[server/auth.js]]` | the node whose `file` is exactly that path; else the node that owns it (the deepest `file` that is the path or a folder above it, the rule a pull request's files light nodes by). A file that holds several nodes lights them all |
| `[[server/auth.js#L10]]`, `[[./server/auth.js]]` | the same: a line suffix and a leading `./` are dropped |
| a `cornfield-thread` block | precise links from a tool or an agent (below) |

A mention that resolves to nothing stays plain text; it reads sensibly on the forge without cornfield. Mentions inside a code span or a fenced block are not links, so a thread can talk about `[[the syntax]]` without lighting anything. At most 50 distinct mentions are read from one message, and a mention is at most 200 characters.

A tool or an agent that knows exactly what it means can write a fenced block, which an id or a path in `nodes` and a proposal's slug:

````
```cornfield-thread
{ "nodes": ["core-server-auth", "server/hooks.js"], "proposal": "0013-meals" }
```
````

The first well-formed block in a message is read; a block that is not that shape is ignored, and the message is read as prose.

Mentions are resolved against the map **on screen**, so a proposal opened on the map, or a node that has moved, changes which nodes a thread names. The server hands the page the references as written (never a resolved copy), and the [hooks](#hooks) resolve them against the checkout's `topology.json`.

## In the dashboard

- **The Threads tab** of the Work list lists the threads, newest activity first (the last comment, or the issue's last change): an idea or a spec conversation, its state, who opened it, how many comments, and which proposal it is tied to. State and search filters work as on the other tabs. The list is read through cornfield's server like the others, kept for a minute with an ETag, and **Refresh** asks the forge again.
- **Opening a thread** shows its messages as they were written, read-only, oldest first: plain text (no Markdown is rendered and nothing in a message is made into markup or a link), cut at 20,000 characters a message, the latest 200 messages. There is nothing to type into: **Reply on GitHub** (or Forgejo) opens the thread on the forge, because that is where it is written.
- **A thread in the node panel** (a row of the Threads tab selects its node in the Work view; a thread older than the view's 14 days opens in the node panel alone) shows its messages, read-only, **Reply on GitHub** (or Forgejo) and the nodes its messages mention, each a button that selects the node on the map; a mention on no node is listed as "not on the map". In the Work view a `mentions` line joins the thread to each node it names.
- **A node's panel** has **Threads** with the threads that mention the node (open ones). Each is a button that shows the thread in the node panel (its node in the Work view). The list is read once, when you first select a node, and shared with the tab.
- **Start a thread about this** is a button in a node's panel, under **Threads**. It opens the Work view with the Work list on the Threads tab and the New idea form (below), filled in for that node: the node's label as the title, and `[[node-id]]` on the first line of the text with an empty line under it to write in. Both are editable. The focus goes into the form; closing it (Cancel, or after the idea is opened) puts the focus back on the button. It posts through the same route as New idea, so nothing new is allowed: the idea is an `idea` issue whose text mentions the node. Once it is opened the list is read again from the forge, so the node's **Threads** lists the new thread without a reload, and the live region says so. The button shows only when threads are on and a maintainer is signed in, the same rule as the Threads tab. If the form already holds a draft, nothing of it is lost: a title already typed stays, and the text stays under the `[[node-id]]` line, which is added once. Once the idea is opened it is shown in the node panel, with the nodes it mentions.
- **New idea** opens an issue with the label as you, with a title and a text (the text may be left empty). It says exactly what it will do before it does it. Only the page's own POST can open one (below); the issue shows in the list within a minute, and the answer links to it. The idea is as you typed it: cornfield adds nothing to it. If the repo has no label of that name yet, the label is made with the issue, as you: on GitHub the forge makes it; on Forgejo cornfield makes it first (plain grey), and the answer and its [audit row](issues-and-prs.md#the-audit) say `labelsMade`. Nothing else ever writes: reading threads, the list and the poll only read.

### What New idea asks of the server

`POST /api/forge/threads { title, body }` is guarded like the other [actions](issues-and-prs.md#what-the-server-checks-again), in this order: POST only; a signed-in maintainer; the same origin (a refusal here is not counted toward the ceiling that follows, and is written down at most once a minute); a ceiling of attempts of any kind per person per minute (counted before anything is written down); a row in the audit (`actions`, action `idea`, **before** the forge is asked, with the title and the text's length, never the text); JSON of at most 96 KB; not twice (the same title is not asked again for a few seconds, and 20 actions a minute per person); and the permission asked of the forge **now** with the maintainer's own token, so one removed a minute ago is refused. It only adds an issue; it changes and removes nothing.

## Hooks

Three [hook](config.md#hooks) events say that a thread moved:

| Event | When |
|---|---|
| `thread.opened` | an idea was first seen |
| `thread.message` | a comment was added to a thread (an idea's, or a spec PR's conversation). Once per comment |
| `thread.linked` | a thread now points at the map or at a proposal: a message holds a mention that resolves, or a `cornfield-thread` block, or a spec PR names the thread with `Thread: #n`. Once per message that links, and once per spec PR that names it |

```json
{
  "event": "thread.linked",
  "at": "2026-11-05T09:30:00.000Z",
  "thread": 41,
  "comment": "9102",
  "actor": "maintainer-one",
  "nodes": ["core-server-auth"],
  "proposal": "0013-meals",
  "mapUrl": "https://cornfield.example.org"
}
```

- **No words.** The body never holds a comment's text: a receiver reads it from the forge itself, with its own token. `comment` is the forge's comment id (not present on `thread.opened`, nor on a link made by a spec PR); `actor` is who wrote it (`null` for a spec PR's link, or an author the forge no longer knows); `nodes` and `proposal` come on `thread.linked` only, `nodes` as ids on the checkout's map.
- **Same signing and delivery as the other events:** `X-Cornfield-Signature`, retries, the audit rows ([config](config.md#hooks)).
- **When.** cornfield has no webhook receiver, so it fires when it next looks: when someone opens the Threads tab, or on [its own timer](config.md#hook-poll), which now looks at threads in the same tick as the spec PRs when a hook subscribes to a `thread.*` event (or to `'*'`) and threads are on. One interval (`hookPoll.specs`), one sign-in, one backoff.
- **Once per comment, across restarts.** The comments already announced are in the `thread_seen` table of `cornfield.db`, keyed by repo, thread and comment (the same idea as `hook_seen` for spec PRs). **The first look at a repo announces nothing**: it records what is there, and only what is new after it is sent. A comment that is edited is not announced again; one edited to add a mention is announced as `thread.linked` once.
- **What a look costs.** A tick with nothing new costs the issue listing (one call a page, labelled `idea`), the open PR listing the spec poll makes already, and one call for each open spec PR's comments (since the last one seen). An idea whose last-update time has not moved since the previous look is not read again; one that has is read from its newest seen comment on (`since`).
- **A thread is only a thread when the label says so.** An issue that gets the label later is first seen then, so its existing comments are announced once. The poll reads the newest 200 ideas.

## Runs in a thread

A [run](agents.md) asked for from a thread (or an issue, or a proposal) is about that conversation, and the thread hears of it: cornfield keeps **one status comment per run** in it and edits it as the run moves, so a thread shows where its run stands, and a proposal's thread shows the run's pull request once it opens. The comment is written as a maintainer, defused like every comment cornfield posts, and holds no `cornfield-run` block, so it can start no run; [how, and why one edited comment](agents.md#a-thread-for-every-run). In the Threads tab the row of a thread names the state of its run (`Run: Working`). The status comment is an ordinary comment to the threads: it is a `thread.message` like any other, and it holds no mention, so it lights nothing on the map.

## What cornfield stores

Nothing of a thread's. `cornfield.db` has the kept answers (`forge_cache`, a minute's cache so a page load is not a dozen calls), the audit of what cornfield did (`actions`), and `thread_seen`: which comments a hook was told about and when each thread was last looked at. Delete it and no thread, message or link is lost; a hook may announce again what it announced before, once.

## Forge calls it adds

Both adapters (GitHub, Forgejo) behind the [forge interface](../server/forge.js) gained `editComment(id, body)` (the one edit cornfield makes: its own run status comment, [above](#runs-in-a-thread)) and two earlier things: `comments(n, { since })` returns only the comments created or edited after a time, and `createIssue({ title, body, labels })` puts labels on the new issue (GitHub by name; Forgejo takes ids, so the adapter looks the label up and makes it when the repo lacks it). Listing issues by label and commenting were there already.
