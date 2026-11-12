/**
 * @module explorer/pieces/work-data
 *
 * The Work panel's asking: every request, the list a tab shows, what a selection lights on the map, the counts read quietly. Part of the Work piece (pieces/work.js): `install(ctx)` makes this part's functions for one mount, and hands the ones other parts call
 * to `ctx.fn`; nothing is shared between two mounts.
 */

import { litOfRun } from '../runs-model.js';
import { listUrl, pullUrl, filterItems, litFor, errorWords, listKeyOf, litForDeploy, threadUrl, litForThread } from '../forge-panel-model.js';
import { plural, threadOf, FORGE_NAMES } from './work-common.js';
import { credentialed } from '../engine/connection.js';

export function install(ctx) {
  const { inst, ui, m, fn, state, $ } = ctx;
  const { announce, render, touchScene, repaintThreads, isOffline } = ctx.h;

  /** Every request carries the maintainer's session to the base's own origin only (engine/connection.js) */
  const ask = credentialed(inst);
  /** An answer that comes after the piece ended is not wanted: whatever was waiting for it waits for ever, and so does nothing */
  const never = () => new Promise(() => {});

  const forgeName = () => FORGE_NAMES[ui.config && ui.config.forge && ui.config.forge.type] || 'the forge';

  const listKey = () => listKeyOf(ui.kind, ui.filters.state);

  const current = () => (ui.kind === 'work' ? ui.work : ui.kind === 'specs' ? fn.specsList() : ui.lists[listKey()]) || null;

  const kindWords = () => ({ specs: 'spec', pulls: 'pull request', issues: 'issue', threads: 'thread', deploys: 'deploy' })[ui.kind] || 'piece of work';

  /** A failed answer in words (the model's), said as offline when the browser is, and naming what could not be loaded */
  const failWords = (res, what = '') => errorWords(res.status, res.body, { offline: isOffline(), what });

  /** One GET (or the one POST, with its JSON); `{ ok, status, body }`, with a status of null when the server did not answer */
  async function request(url, refresh, post) {
    try {
      // Refresh sends `Cache-Control: no-cache`, which the server takes as "ask the forge again"
      const init = post ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(post) } : refresh ? { cache: 'reload' } : {};
      const res = await ask(url, init);
      if (ctx.dead) return never();
      let body = null;
      try { body = await res.json(); } catch { /* no body */ }
      if (ctx.dead) return never();
      return { ok: !!res.ok && !!body && body.ok !== false, status: res.status, body };
    } catch {
      if (ctx.dead) return never();
      return { ok: false, status: null, body: null };
    }
  }

  /** One POST of JSON; `{ ok, status, body }`, with a status of null when the server did not answer */
  async function post(url, payload) {
    try {
      const res = await ask(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (ctx.dead) return never();
      let body = null;
      try { body = await res.json(); } catch { /* no body */ }
      if (ctx.dead) return never();
      return { ok: !!res.ok && !!body && body.ok === true, status: res.status, body };
    } catch {
      if (ctx.dead) return never();
      return { ok: false, status: null, body: null };
    }
  }

  /** Loads the list the kind and state name (again, past the server's cache, on a refresh) */
  async function loadList(refresh = false, quiet = false) {
    const token = ++m.listToken;
    if (ui.kind === 'work') return fn.loadWork(refresh, token);
    if (ui.kind === 'specs') return fn.loadSpecs(token, quiet);
    const key = listKey();
    ui.loading = true;
    ui.error = '';
    fn.paint();
    const res = await request(listUrl(ui.kind, ui.filters.state), refresh);
    if (token !== m.listToken) return;
    ui.loading = false;
    if (res.ok) {
      ui.lists[key] = { items: res.body.items || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '', problem: res.body.problem || '' };
      if (ui.kind === 'threads') {
        repaintThreads();
        // A thread's row names the state of the run that is about it (issue #104): the runs are read, once, when the tab is the first thing opened
        if (!ui.runs) fn.loadRuns(false, { say: false }).then(() => { if (ui.open && ui.kind === 'threads') fn.paint(); }, () => {});
      }
      if (!quiet) announce(`${plural(filterItems(ui.lists[key].items, ui.kind, ui.filters).length, kindWords())} shown${ui.lists[key].stale ? '. This is an older answer' : ''}`);
    } else {
      ui.error = failWords(res, `the ${kindWords()}s`);
      if (!quiet) announce(ui.error);
    }
    fn.paintFilters();
    fn.paint();
  }

  /** The counts on the tabs, read quietly the first time the panel opens: the open pull requests and issues (the Threads and Runs counts come from what those tabs read anyway) */
  function primeCounts() {
    for (const kind of ['pulls', 'issues']) {
      const key = listKeyOf(kind, 'open');
      if (ui.lists[key] || m.primed.has(kind) || kind === ui.kind) continue;
      m.primed.add(kind);
      request(listUrl(kind, 'open'), false).then((res) => {
        if (res.ok && !ui.lists[key]) ui.lists[key] = { items: res.body.items || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '', problem: res.body.problem || '' };
        if (ui.open) fn.paint();
      });
    }
    if (!m.primed.has('threads')) { m.primed.add('threads'); fn.ensureThreadsList(); }
    if (ui.kind !== 'specs') fn.readSpecsQuiet(); // the specs part of the number is read when Work opens (spec 0010 D2)
  }

  /** What the selected pull request lights, worked out again: for the nodes now on the map */
  function relight() {
    ui.nodesSeen = state.nodes;
    if (ui.runSel) {
      const run = fn.runById(ui.runSel);
      state.forgeLit = run ? litOfRun(run) : null;
    } else if (ui.threadDetail && ui.threadDetail.thread) {
      ui.litThread = litForThread(ui.threadDetail.thread, state.nodes);
      state.forgeLit = { changed: ui.litThread.changed, failing: ui.litThread.failing };
    } else if (ui.deployItem) {
      ui.litDeploy = litForDeploy(ui.deployItem, state.nodes);
      state.forgeLit = { changed: ui.litDeploy.changed, failing: ui.litDeploy.failing };
    } else if (ui.detail) {
      ui.lit = litFor(ui.detail, state.nodes);
      state.forgeLit = { changed: ui.lit.changed, failing: ui.lit.failing };
    } else {
      ui.lit = null;
      state.forgeLit = null;
    }
    touchScene();
    render();
    fn.paint();
  }

  /** A proposal opening, or the live layer, changes the nodes: the lights follow them */
  function onNodesChange() {
    if ((ui.detail || ui.deployItem || ui.threadDetail) && state.nodes !== ui.nodesSeen) relight();
    repaintThreads();
  }

  /** Asks the forge again, past the server's cache: the list, and the selected pull request */
  async function refreshForge({ quiet = false } = {}) {
    if (!quiet) announce('Asking the forge again');
    if (ui.kind === 'notes') { await fn.loadNotes(true); return; }
    const n = ui.selected;
    await loadList(true, quiet);
    if (ui.deployItem) {
      // The list is read again: the deploy as the forge now has it (still running, now finished), else the last copy
      const again = ui.lists.deploys && ui.lists.deploys.items.find((d) => d.id === ui.deploy);
      if (again) { ui.deployItem = again; relight(); }
      return;
    }
    if (ui.thread !== null) {
      const at = ui.thread;
      const token = ++m.threadToken;
      const res = await request(threadUrl(at), true);
      const thread = threadOf(res);
      if (token !== m.threadToken || !thread) return;
      ui.threadDetail = { thread, at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '' };
      relight();
      return;
    }
    if (n !== null && ui.selected === n) {
      const token = ++m.pullToken;
      const res = await request(pullUrl(n), true);
      if (token !== m.pullToken || !res.ok) return;
      ui.detail = { pull: res.body.pull, files: res.body.files || [], checks: res.body.checks || [], specs: res.body.specs || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '' };
      relight();
      await fn.loadLanding(n, token);
    }
  }

  /** Back online: a tab that could not be read is read again, so its error does not outlive the cause (the same function each time, added once) */
  function readOnline() {
    if (ui.open && (ui.error || (ui.runs && ui.runs.error) || ui.detailError || (ui.kind === 'notes' && ui.notes.error))) refreshForge({ quiet: true });
  }

  Object.assign(fn, { forgeName, listKey, current, kindWords, failWords, request, post, loadList, primeCounts, relight, onNodesChange, refreshForge, readOnline });
}
