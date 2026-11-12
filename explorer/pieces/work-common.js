/**
 * @module explorer/pieces/work-common
 *
 * What the parts of the Work piece (pieces/work.js and work-*.js) share and that holds nothing of one mount: words, small pure helpers, and the
 * shape of the two forms' state. No instance, no page.
 */

import { escapeHtml as escHtml } from '../../core/text.js';
import { defaultFilters } from '../forge-panel-model.js';
import { withParts } from '../engine/piece.js';

export const FORGE_NAMES = { github: 'GitHub', forgejo: 'Forgejo' };
export const SEARCH_ANNOUNCE_MS = 500;
/** How often the runs are read again while one is open */
export const RUNS_POLL_MS = 60_000;
/** How often the specs are read again for the number while the page is open (spec 0010 D2: at most every 5 minutes; the server keeps what it read by PR head) */
export const SPECS_POLL_MS = 5 * 60_000;
/** The tabs, in the order of the loop */
export const TABS = ['specs', 'pulls', 'issues', 'threads', 'work', 'deploys'];
/** A node id that reads back as one mention: no brackets or line breaks, as core/mentions.js parses them */
export const MENTIONABLE = /^[^[\]\r\n]{1,200}$/;

export const plural = (n, word, more = `${word}s`) => `${n} ${n === 1 ? word : more}`;
/** A link only if it is the forge's web address: a forge's JSON is data, not trusted markup */
export const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
export const option = (value, label, on) => `<option value="${escHtml(value)}"${on ? ' selected' : ''}>${escHtml(label)}</option>`;
/** The back control of a detail: an arrow and the name of the list it returns to ("All pull requests") */
export const backHtml = (action, words) => withParts(`<button data-corn="back" type="button" class="hx-forge-back" data-action="${action}"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg><span class="hx-forge-back-text">${escHtml(words)}</span></button>`);
/** The thread a successful answer holds, or null (a failure, or an answer without one) */
export const threadOf = (res) => (res && res.ok && res.body && res.body.thread && typeof res.body.thread === 'object' && Array.isArray(res.body.thread.messages) ? res.body.thread : null);

/** The Release notes view: the draft loaded for a tag, and where the confirm step is */
export function freshNotes() {
  return { since: '', data: null, loading: false, error: '', confirm: false, posting: false, message: '', bad: false, link: null };
}

/** The New idea form: whether it is open, one send in flight, and what the last send came to */
export function freshIdea() {
  // `opener` is the id of the node whose panel button that opened the form ('' when the bar's own button did), `node` the node it was about
  return { open: false, busy: false, message: '', bad: false, link: null, opener: '', node: null };
}

/** What is shown: the lists loaded, the filters, the selected pull request with its files and checks */
export function freshUi() {
  return {
    config: null,
    open: false,
    kind: 'specs', // the tab: specs | pulls | issues | threads | work (Runs) | deploys; 'notes' is the Release notes view, reached from the PRs list
    filtersOpen: false, // the Filter chip's box
    filters: defaultFilters(),
    lists: {}, // `${kind}|${server state}` -> { items, at, rate, stale }
    work: null, // { grouped, problem, at, rate, stale } of the Agents tab
    specQuery: '', // the Specs tab's search (spec 0010 D5)
    draftsOpen: null, // the Drafts group opened (true) or folded (false) by hand; null: as the model has it (folded past 10 rows)
    workFilters: { agentsOnly: false, finished: false },
    loading: false,
    error: '',
    selected: null, // the pull request's number
    selectedOn: '', // the tab it was selected on ('pulls' or 'work')
    detail: null, // { pull, files, checks, at, rate, stale } of the selected one
    landing: null, // what waits to land on its approval for the selected pull request ({ slug, by, since }), or null
    detailError: '',
    lit: null, // litFor(detail, nodes)
    thread: null, // the selected thread's number (Threads tab)
    threadDetail: null, // { thread, at, rate, stale } of the selected one: its messages, as written
    threadError: '',
    litThread: null, // litForThread(thread, nodes)
    idea: freshIdea(), // the New idea form
    deploy: null, // the selected deploy's id; the deploy itself is `deployItem`
    deployItem: null,
    litDeploy: null, // litForDeploy(deployItem, nodes)
    nodesSeen: null, // the `state.nodes` the lights were worked out for
    busy: '', // the action in flight ('merge', or 'rerun:<check id>'), so a second click does nothing
    note: null, // { text, ok }: what the last action came to, for the selected pull request
    confirm: null, // { opener: selector, kind: 'merge' | 'spec' | 'build', plan?, n?, slug? } while the confirm dialog is open
    actNote: null, // { text, ok, url }: what the last pipeline step came to
    notes: freshNotes(), // the Release notes view
    runs: null, // { data, error } of the Agents tab's runs: what /api/agent-runs answered
    runNote: null, // { text, ok }: what the last Stop came to
    runSel: null, // the run lit on the map (Light on the map), by id
    runnerSaid: null, // the runner state last shown ('online', 'offline', 'none'; null off the pull transport), so a change is said once
    runTimelines: new Set(), // the runs whose timeline is open
    runReplies: new Map(), // the reply typed so far for each waiting run, so a repaint (the runs are looked at again) keeps it
    agent: null, // { opener, refs, posting, retryOf, filled } while the Start an agent dialog is open
    threadsOn: true, // `threads: false` in the config turns the Threads tab off
    retrying: false, // a Start again reading its run's whole brief, so a second click does nothing
  };
}
