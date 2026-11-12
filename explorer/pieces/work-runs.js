/**
 * @module explorer/pieces/work-runs
 *
 * The Runs tab: the groups, a run, Stop, answer, the brief, the poll, and the runs on the map. Part of the Work piece (pieces/work.js): `install(ctx)` makes this part's functions for one mount, and hands the ones other parts call
 * to `ctx.fn`; nothing is shared between two mounts.
 */

import { withParts } from '../engine/piece.js';
import { WORK_URL, groupWork, filterGroups, groupWords, workStatus, markWords } from '../agents-model.js';
import { runsUrl, stopUrl, answerUrl, answerBody, answerWordsFor, runsStatus, runnerState, runnerWords, triggerNotice, totalsLines, handLines, stopWords, changeWords } from '../runs-model.js';
import { runsHtml, totalsHtml, loadingRowsHtml, loadingLinesHtml } from '../runs-view.js';
import { waiting } from '../waiting-model.js';
import { escapeHtml as escHtml } from '../../core/text.js';
import { safeUrl, RUNS_POLL_MS } from './work-common.js';

export function install(ctx) {
  const { inst, ui, m, fn, state, root, $ } = ctx;
  const { announce, t, sayResult, clearResult, resultOf, notSentWords, setRunsOnMap, setT, clearT } = ctx.h;

  const groupsShown = () => (ui.work ? filterGroups(ui.work.grouped.groups, ui.workFilters) : []);

  /** Loads the Agents tab: everything it groups, in one answer */
  async function loadWork(refresh, token) {
    ui.loading = true;
    ui.error = '';
    fn.paint();
    const [res] = await Promise.all([fn.request(WORK_URL, refresh), loadRuns(refresh)]);
    if (token !== m.listToken) return;
    ui.loading = false;
    if (res.ok) {
      const b = res.body;
      ui.work = { grouped: groupWork(b), problem: b.specsProblem || '', at: b.at, rate: b.rate || '', stale: b.stale || '' };
      announce(`${workStatus(groupsShown(), '', m.now())}${ui.work.stale ? '. This is an older answer' : ''}`);
    } else {
      ui.error = fn.failWords(res, 'the work');
      announce(ui.error);
    }
    fn.paint();
  }

  /** Loads the runs for the Agents tab (a refresh also has cornfield look at the forge for their reports first); a failure is a line, never a blank panel */
  async function loadRuns(refresh, { say = true } = {}) {
    const before = ui.runs && ui.runs.data ? ui.runs.data.runs : null;
    const res = await fn.request(runsUrl(refresh), refresh);
    ui.runs = res.ok && Array.isArray(res.body.runs) ? { data: res.body, error: '' } : { data: ui.runs && ui.runs.data, error: fn.failWords(res, 'the runs') };
    fn.paintWaiting(); // the number follows the runs, whether or not the panel is open
    if (!(ui.runs && ui.runs.data)) return;
    // The map shows the open runs' nodes; a run lit on the map follows its nodes; what changed is said, once the first answer is in
    setRunsOnMap(ui.runs.data.runs);
    syncRunsPoll();
    if (ui.runSel) relightRun();
    const said = say ? changeWords(before, ui.runs.data.runs) : [];
    // A runner appearing or going quiet is said once, when the state changes (the line itself is plain text, not a live region). The state last
    // shown is kept, not worked out again from the last listing: a runner that goes quiet is the same listing judged later
    const was = ui.runnerSaid;
    const is = runnerState(ui.runs.data.runnerPresence, m.now());
    ui.runnerSaid = is;
    if (say && was && is && was !== is) said.push(runnerWords(ui.runs.data.runnerPresence, m.now()));
    if (said.length) announce(said.join('. '));
  }

  /**
   * Looks at the runs again in `RUNS_POLL_MS`, but only while one is open: a run's answer that has none open disarms it, and the next answer
   * with one open (a run requested here, or a look from elsewhere) arms it again. One timer at most; never while the page is hidden or put
   * away (`pagehide`). So the marks on the map and the words follow the runs.
   */
  function syncRunsPoll() {
    const open = !!(ui.runs && ui.runs.data && ui.runs.data.open > 0);
    if (!open || m.pageAway) {
      clearT(m.runsTimer);
      m.runsTimer = 0;
      return;
    }
    if (m.runsTimer) return;
    m.runsTimer = setT(async () => {
      m.runsTimer = 0;
      if (!(inst.hidden())) {
        await loadRuns(false);
        fn.paint();
      }
      syncRunsPoll();
    }, RUNS_POLL_MS);
  }

  /** The page is being put away (closed, or into the back-forward cache): no look until it is shown again */

  function onPageHide() { m.pageAway = true; syncRunsPoll(); }

  function onPageShow() { m.pageAway = false; syncRunsPoll(); }

  /** One piece of work in a group: a pull request (a row that selects it, as in the Pull requests tab) or a branch with none */
  function workHtml(e) {
    const mark = e.mark ? `<span class="hx-forge-agentline"><span class="hx-forge-agent" title="Agent-made: ${escHtml(markWords(e.mark))}" data-corn="badge">Agent</span><span class="hx-forge-why hx-faint">${escHtml(markWords(e.mark))}</span></span>` : '';
    if (e.type === 'pull') {
      const also = e.issues.slice(1);
      const note = [e.proposal ? `Spec PR for ${e.proposal}` : '', also.length ? `Also closes ${also.map((n) => `#${n}`).join(', ')}` : ''].filter(Boolean);
      return fn.itemHtml(e.pull, mark, note.length ? `<span class="hx-forge-meta">${escHtml(note.join(' · '))}</span>` : '');
    }
    return `<li class="hx-forge-item"><div class="hx-forge-row hx-forge-branch" data-corn="row"><span class="hx-forge-title"><span class="hx-sr-only">Branch </span><code class="hx-code">${escHtml(e.branch.name)}</code></span><span class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--draft" data-corn="state-pill" data-corn-state="draft">Branch</span> no pull request yet</span>${mark}</div></li>`;
  }

  /** The Agents tab's groups, each a heading and its work */
  function groupsHtml(groups) {
    return groups.map((g, i) => {
      const link = g.issue && safeUrl(g.issue.url) ? ` <a data-corn="text-link" class="hx-link hx-forge-gout" href="${escHtml(g.issue.url)}" target="_blank" rel="noreferrer" aria-label="Open issue ${g.number} on ${escHtml(fn.forgeName())} (new tab)">↗</a>` : '';
      const startRef = g.kind === 'issue' && g.issue && g.issue.state === 'open' ? `issue:${g.number}` : g.kind === 'proposal' ? `proposal:${g.slug}` : null;
      const start = startRef ? ` <button data-corn-kind="secondary" type="button" class="hx-btn hx-forge-act" data-forge-agent="${escHtml(startRef)}" aria-label="${escHtml(t('startAgent'))} on ${escHtml(g.kind === 'issue' ? `issue ${g.number}` : `proposal ${g.slug}`)}">${escHtml(t('startAgent'))} …</button>` : '';
      return `<li class="hx-forge-group"><h3 class="hx-forge-gtitle" id="forge-group-${i}">${escHtml(g.title)}${link}</h3>${start}<p class="hx-forge-meta">${escHtml(groupWords(g))}</p><ul class="hx-forge-list" aria-labelledby="forge-group-${i}">${g.entries.map(workHtml).join('')}</ul></li>`;
    }).join('');
  }

  /** The runs of the Agents tab: state, what each is about, links, and Stop. A runner's words are escaped like any text from the forge. */
  function paintRuns() {
    const box = $('forge-runs');
    if (!box) return;
    box.hidden = ui.kind !== 'work' || !!fn.detailKey();
    if (box.hidden) return;
    const data = ui.runs && ui.runs.data;
    $('forge-runs-status').textContent = data ? runsStatus(data) : ui.loading ? 'Loading the runs …' : '';
    const note = $('forge-runs-note');
    const failed = ui.runs && ui.runs.error;
    const words = failed || (ui.runNote ? ui.runNote.text : '');
    note.className = `hx-forge-notice${!failed && ui.runNote && ui.runNote.ok ? ' hx-forge-notice--ok' : ''}`;
    if (!failed && ui.runNote && ui.runNote.ok) note.dataset.cornState = 'success'; else delete note.dataset.cornState;
    fn.setNotice(note, words, !!failed);
    paintRunner('forge-runs-runner', data);
    const waiting = !data && !failed && !!ui.loading; // the runner line and the totals hold their place while the runs load (not beside a failure)
    if (waiting) { const r = $('forge-runs-runner'); r.hidden = false; r.innerHTML = loadingLinesHtml(1); }
    const trig = $('forge-runs-trigger');
    if (trig) {
      const skipped = data ? triggerNotice(data) : '';
      trig.hidden = !skipped;
      trig.textContent = skipped;
    }
    const totals = $('forge-runs-totals');
    if (totals) {
      const lines = data ? totalsLines(data.totals) : [];
      totals.hidden = !lines.length && !waiting;
      totals.innerHTML = waiting ? loadingLinesHtml(3) : totalsHtml(viewContext(), lines);
    }
    const hand = $('forge-runs-hand');
    if (hand) {
      const lines = data ? handLines(data) : [];
      hand.hidden = !lines.length;
      hand.innerHTML = lines.map((l) => `<li>${escHtml(l)}</li>`).join('');
    }
    const list = $('forge-runs-list');
    list.setAttribute('aria-busy', String(!data && !!ui.loading));
    if (!data) { list.innerHTML = ui.loading ? loadingRowsHtml(3) : ''; return; }
    patchList(list, data.runs.length ? runsHtml(viewContext(), data.runs) : '<li class="hx-forge-empty hx-faint" data-corn="empty">No agent has been asked for yet. Start one from an issue or a proposal: Issues, then Start an agent.</li>');
  }

  /**
   * Draws a list again without disturbing what the person is doing in it. The new rows are made first and set against the old by their key
   * (a run's id, a compare group's): a row that has not changed is left alone, a row that has is replaced, and **a row that holds the focus in
   * a field, or a reply typed and not sent, is kept as it is** (its result line is the one part brought up to date), so the caret, the
   * selection, the focus and the text stay where they were. A row whose field is no longer asked for is replaced like any other.
   */
  function patchList(list, html) {
    const tpl = inst.doc.createElement('template');
    tpl.innerHTML = withParts(html);
    const fresh = [...tpl.content.children];
    const keyOf = (el) => el.dataset.key || el.dataset.run || null;
    const old = new Map([...list.children].filter((el) => keyOf(el)).map((el) => [keyOf(el), el]));
    const typing = (el) => el.contains(inst.active()) && inst.active().matches('input, textarea');
    const redraw = new Set(m.redrawRuns); // runs the page has just acted on: their cards say what the action did, so they are drawn anew (the focus is put back by hand)
    m.redrawRuns.clear();
    const unsent = (el) => [...el.querySelectorAll('[data-run-reply]')].some((f) => f.value !== '');
    const target = fresh.map((f) => {
      const was = keyOf(f) && old.get(keyOf(f));
      if (!was) return f;
      if (was.outerHTML === f.outerHTML) return was;
      const field = was.querySelector('[data-run-reply]');
      const twin = field && f.querySelector(`[data-run-reply="${field.dataset.runReply}"]`);
      if (!redraw.has(keyOf(f)) && (typing(was) || unsent(was)) && twin) {
        // The field stays (the very element, never taken out of the page, so the focus, caret, selection and a phone's keyboard stay);
        // everything around it is the new card's, so a state that changed is shown (graftAround)
        const theirs = twin.getAttribute('value') || '';
        graftAround(was, field, twin);
        // The typed text is in `ui.runReplies` as well, always (every keystroke); a field that differs from it was changed by the page itself
        if (field.value !== theirs) field.value = theirs;
        return was;
      }
      return f;
    });
    target.forEach((node, i) => {
      const at = list.children[i];
      if (at === node) return;
      if (at && keyOf(at) && keyOf(at) === keyOf(node)) at.replaceWith(node); else list.insertBefore(node, at || null);
    });
    while (list.children.length > target.length) list.lastElementChild.remove();
  }

  /**
   * Makes `root` (an old row) what `fresh` (its new drawing) is, except that `keep` (inside `root`) stays the same element in the same place,
   * standing for `twin` (its match inside `fresh`): at each level from `keep` up to `root`, the parent takes the new parent's attributes and
   * children, with the kept branch in its place. `keep` itself is never taken out of the page.
   */
  function graftAround(root, keep, twin) {
    const sync = (to, from) => {
      for (const a of [...to.attributes]) if (!from.hasAttribute(a.name) && a.name !== 'value') to.removeAttribute(a.name);
      for (const a of [...from.attributes]) if (a.name !== 'value' && to.getAttribute(a.name) !== a.value) to.setAttribute(a.name, a.value);
    };
    sync(keep, twin);
    let w = keep;
    let f = twin;
    while (w !== root && w.parentElement && f.parentElement) {
      const wp = w.parentElement;
      const fp = f.parentElement;
      sync(wp, fp);
      const kids = [...fp.childNodes];
      const at = kids.indexOf(f);
      for (const n of [...wp.childNodes]) if (n !== w) n.remove();
      for (const n of kids.slice(0, at)) wp.insertBefore(n, w);
      for (const n of kids.slice(at + 1)) wp.append(n);
      w = wp;
      f = fp;
    }
  }

  /** Whether a run would wait for a runner that is not there (pull transport only; issue #183, spec 0007 D1) */
  function runnerAway() {
    const data = ui.runs && ui.runs.data;
    const state = data ? runnerState(data.runnerPresence, m.now()) : null;
    return state === 'offline' || state === 'none';
  }

  /** The Start dialog's button: "Ask the runner", or "Queue it (no runner online)" while no runner polls, so the click says what it does */
  function askRunnerWords() {
    return runnerAway() ? `${t('queueIt')} (no runner online)` : t('askRunner');
  }

  /**
   * The one line on whether a runner is polling (pull transport only), in the Runs view and the Start dialog; hidden where it does not apply.
   * While no runner is online it is a notice at the top of the view, not the faint line: a run asked for would wait (issue #183).
   */
  function paintRunner(id, data) {
    const el = $(id);
    if (!el) return;
    const words = data ? runnerWords(data.runnerPresence, m.now()) : '';
    el.hidden = !words;
    el.textContent = words;
    const state = data ? runnerState(data.runnerPresence, m.now()) : null;
    const away = state === 'offline' || state === 'none';
    el.className = away ? 'hx-forge-notice' : 'hx-forge-meta';
    if (away) { el.dataset.corn = 'notice'; el.setAttribute('part', 'notice'); el.dataset.cornState = 'waiting'; } else { delete el.dataset.corn; el.removeAttribute('part'); delete el.dataset.cornState; }
  }

  /** What the Runs view needs to know of the page */
  function viewContext() {
    const f = ui.config && ui.config.forge;
    const base = f && safeUrl(f.url) ? f.url.replace(/\/+$/, '') : null;
    return {
      esc: escHtml, t, safeUrl, forgeName: fn.forgeName(), forgeType: f ? f.type : 'github', repoUrl: base && f.repo ? `${base}/${f.repo}` : null,
      now: m.now(), nodes: state.nodes, selected: ui.runSel, timelines: ui.runTimelines, replies: ui.runReplies, busy: !!ui.busy,
      results: { get: (id) => resultOf(id) },
    };
  }

  const runById = (id) => ((ui.runs && ui.runs.data && ui.runs.data.runs) || []).find((r) => r.runId === id) || null;

  /** The nodes of a selected run, worked out again (the runs were read again, or the map changed) */
  function relightRun() {
    if (!runById(ui.runSel)) ui.runSel = null;
    fn.relight();
  }

  /** Lights the nodes of a run on the map, like a pull request; the same button lets go of it */
  function selectRun(id) {
    const run = runById(id);
    if (!run) return;
    if (ui.runSel === id) {
      ui.runSel = null;
      fn.relight();
      announce(`Run ${id} no longer lit on the map`);
      return;
    }
    const had = ui.runSel;
    m.pullToken++;
    fn.dropThread();
    Object.assign(ui, { selected: null, detail: null, detailError: '', lit: null, landing: null, note: null, deploy: null, deployItem: null, litDeploy: null });
    ui.runSel = id;
    fn.relight();
    const n = (run.nodes || []).length;
    announce(n ? `Run ${id}: ${n} ${n === 1 ? 'node' : 'nodes'} lit on the map${had ? '' : ''}` : `Run ${id} has no node on the map yet`);
  }

  /** Opens or closes the timeline of a run (it stays open when the list is drawn again) */
  function toggleTimeline(id) {
    if (ui.runTimelines.has(id)) ui.runTimelines.delete(id); else ui.runTimelines.add(id);
    fn.paint();
  }

  /** The runs whose card is drawn anew at the next paint, whatever holds the focus in it (the page itself changed what it says) */

  /** Gives the focus to the first of `selectors` that is there and not disabled, inside the card of a run (else the card itself) */
  function focusInRun(runId, selectors) {
    const panel = $('forge-panel');
    const card = panel && [...panel.querySelectorAll('[data-run]')].find((c) => c.dataset.run === runId);
    if (!card) return;
    const to = selectors.map((sel) => card.querySelector(sel)).find((el) => el && !el.disabled) || card;
    if (to !== inst.active()) to.focus();
    if (to.matches('input') && typeof to.setSelectionRange === 'function') to.setSelectionRange(to.value.length, to.value.length); // typing goes on at the end of what is there
  }

  /** Lets go of a reply that was not sent because its run stopped waiting: the field goes, and the focus goes to the run's card */
  function discardReply(runId) {
    ui.runReplies.delete(runId);
    m.redrawRuns.add(runId);
    fn.paint();
    focusInRun(runId, []);
  }

  /** Asks a run to stop: one POST, then the runs are read again. What it came to is said in the run's own card, and to a screen reader */
  async function stopRun(runId) {
    if (ui.busy) return;
    ui.busy = 'stop';
    ui.runNote = null;
    clearResult(runId);
    announce('Asking this run to stop'); // the focus is in the run's card, whose controls name it
    fn.paint();
    const res = await fn.post(stopUrl(runId), {});
    ui.busy = '';
    sayResult(runId, res.status === null ? notSentWords('The stop request') : stopWords(res.status, res.body, 'this run'), res.ok);
    await loadRuns(false, { say: false });
    m.redrawRuns.add(runId);
    fn.paint();
    // The Stop button is gone once the stop is asked for: the focus goes to the run's row, never to the page
    focusInRun(runId, [`[data-forge-stop="${runId}"]`]);
  }

  /** Answers a waiting run: Continue, Stop, or a reply with the text typed. One POST, then the runs are read again */
  async function answerRun(runId, action) {
    if (ui.busy) return;
    const text = ui.runReplies.get(runId) || '';
    clearResult(runId);
    if (action === 'reply' && text.trim() === '') {
      sayResult(runId, 'Write a reply first.', false);
      fn.paint();
      focusInRun(runId, [`[data-run-reply="${runId}"]`]);
      return;
    }
    // Where the focus goes back to once it is sent: the reply field after a reply (empty, for the next one), the button after Continue; while the
    // buttons are disabled the focus has nowhere to stay, so it is put back by hand. A run that no longer asks (a Stop) gets its Timeline button
    const back = action === 'reply' ? `[data-run-reply="${runId}"]` : `[data-run-answer="${action}"][data-run-id="${runId}"]`;
    ui.busy = 'answer';
    ui.runNote = null;
    announce(action === 'reply' ? 'Sending your reply' : 'Sending your answer');
    fn.paint();
    const res = await fn.post(answerUrl(runId), answerBody(action, text));
    ui.busy = '';
    if (res.ok && action === 'reply') ui.runReplies.delete(runId); // sent: the field is empty for the next; a reply that was not sent stays as it was typed
    const words = res.status === null ? notSentWords(action === 'reply' ? 'Your reply' : 'The answer') : answerWordsFor(res.status, res.body, 'this run', action);
    sayResult(runId, words, res.ok);
    await loadRuns(false, { say: false });
    m.redrawRuns.add(runId);
    fn.paint();
    focusInRun(runId, [back, `[data-run-timeline="${runId}"]`]);
  }

  /** Answer, on the proposal bar's line: Work opens on Runs at that run with its reply field focused */
  async function answerFromBar(id) {
    if (!(await openRunLink(id))) return;
    const field = $('forge-runs-list').querySelector(`[data-run-reply="${id}"]`);
    if (field) field.focus();
  }

  /** Takes the person to another run of the list: the row scrolls into view and has the focus */
  function goToRun(runId) {
    fn.bringIntoView([...root.querySelectorAll('#forge-runs-list [data-run]')].find((r) => r.dataset.run === runId));
  }

  /** `?run=<runId>`: the Agents tab with that run lit and in view. A run that is not there is said, never a blank panel. */
  async function openRunLink(id) {
    if (!ui.config) return false;
    await fn.openTab('work');
    if (!(ui.runs && ui.runs.data)) await loadRuns(false, { say: false });
    let run = runById(id);
    // A run asked for a moment ago may not be in what was read before: ask once more, past the cache
    if (!run && ui.runs && ui.runs.data) { await loadRuns(true, { say: false }); run = runById(id); }
    if (!run) return fn.linkMissing(ui.runs && ui.runs.data ? `There is no run ${id}.` : (ui.runs && ui.runs.error) || 'The runs could not be read.');
    if (ui.runSel !== id) selectRun(id);
    fn.paint();
    fn.bringIntoView($('forge-runs-list').querySelector(`[data-run="${id}"]`));
    announce(`Run ${id}, in the Runs view`);
    return true;
  }

  Object.assign(fn, { groupsShown, loadWork, loadRuns, syncRunsPoll, onPageHide, onPageShow, workHtml: (...a) => withParts(workHtml(...a)), groupsHtml: (...a) => withParts(groupsHtml(...a)), paintRuns, patchList, graftAround, runnerAway, askRunnerWords, paintRunner, viewContext, runById, relightRun, selectRun, toggleTimeline, focusInRun, discardReply, stopRun, answerRun, answerFromBar, goToRun, openRunLink });
}
