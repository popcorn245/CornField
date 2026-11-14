/**
 * @module explorer/pieces/work-threads
 *
 * The Threads tab: the list, a thread's messages, and the New idea form. Part of the Work piece (pieces/work.js): `install(ctx)` makes this part's functions for one mount, and hands the ones other parts call
 * to `ctx.fn`; nothing is shared between two mounts.
 */

import { withParts } from '../engine/piece.js';
import { runOnThread, threadRunWords } from '../runs-model.js';
import { runPillHtml } from '../runs-view.js';
import { defaultFilters, threadsUrl, threadUrl, IDEAS_URL, threadKindWords, threadMeta, mentionsIndex, ideaRequest, ideaWords } from '../forge-panel-model.js';
import { cornStateAttr } from '../corn-state.js';
import { relativeTime } from '../review-model.js';
import { escapeHtml as escHtml } from '../../core/text.js';
import { plural, safeUrl, backHtml, threadOf, MENTIONABLE } from './work-common.js';

export function install(ctx) {
  const { inst, ui, m, fn, state, root, $ } = ctx;
  const { announce, t, render, touchScene, repaintThreads } = ctx.h;

  /** Forgets the selected thread without painting: another thing is being selected */
  function dropThread() {
    ui.runSel = null;
    m.threadToken++;
    ui.thread = null;
    ui.threadDetail = null;
    ui.threadError = '';
    ui.litThread = null;
  }

  async function selectThread(n) {
    const token = ++m.threadToken;
    m.pullToken++;
    ui.runSel = null;
    ui.selected = null;
    ui.detail = null;
    ui.detailError = '';
    ui.lit = null;
    ui.landing = null;
    ui.deploy = null;
    ui.deployItem = null;
    ui.litDeploy = null;
    ui.thread = n;
    ui.threadDetail = null;
    ui.threadError = '';
    ui.litThread = null;
    state.forgeLit = null;
    touchScene();
    render();
    fn.paint();
    const res = await fn.request(threadUrl(n), false);
    if (token !== m.threadToken) return;
    // An answer without a thread in it is a failure too: nothing to show or light
    const thread = threadOf(res);
    if (!thread) {
      ui.threadError = res.ok ? `Thread ${n} could not be read: the answer had no thread in it. Refresh to ask again.` : fn.failWords(res, `thread ${n}`);
      announce(ui.threadError);
      fn.paint();
      return;
    }
    ui.threadDetail = { thread, at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '' };
    fn.relight();
    $('forge-panel').querySelector('.hx-forge-body').scrollTop = 0; // the thread's messages are what was asked for, not the row that was tapped
    announce(threadSelectionWords());
  }

  /** Lets go of the selected thread: nothing is lit any more */
  function clearThread() {
    const had = ui.thread;
    dropThread();
    state.forgeLit = null;
    touchScene();
    render();
    fn.paint();
    if (had !== null) announce(`Thread ${had} cleared`);
  }

  /** What a screen reader hears when a thread is selected */
  function threadSelectionWords() {
    const { thread } = ui.threadDetail;
    const lit = ui.litThread ? ui.litThread.nodes.length : 0;
    const off = ui.litThread ? ui.litThread.unresolved.length : 0;
    return `Thread ${thread.number}, ${thread.title}: ${plural(thread.messages.length, 'message')}, ${lit ? `${plural(lit, 'node')} lit` : 'no node mentioned'}${off ? `, ${off} named that ${off === 1 ? 'is' : 'are'} not on the map` : ''}. Read-only: reply on ${fn.forgeName()}.`;
  }

  /** Shows a thread from the map (a node's "Mentioned in"): the panel opens on the Threads tab with that thread selected */
  function openThread(n) {
    if (ui.kind !== 'threads') {
      ui.kind = 'threads';
      ui.actNote = null;
      ui.filters = defaultFilters('threads');
    }
    fn.openForge({ tab: 'threads' }); // named, so a closed panel does not open on the tab with the oldest thing waiting instead
    fn.paintFilters();
    selectThread(n);
  }

  /** The threads list for the node panel's "Mentioned in", read once (quietly) when a node is first selected, and when the Threads tab loads it */
  function ensureThreadsList() {
    if (!ui.config || ui.config.threads === false || ui.lists['threads|open'] || m.indexLoading) return;
    m.indexLoading = true;
    const token = ++m.indexToken;
    fn.request(threadsUrl('open'), false).then((res) => {
      m.indexLoading = false;
      if (token !== m.indexToken || !res.ok || ui.lists['threads|open']) return;
      ui.lists['threads|open'] = { items: res.body.items || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '', problem: res.body.problem || '' };
      repaintThreads();
      if (ui.open && ui.kind === 'threads') fn.paint();
    });
  }

  /** The threads that mention a node on the map now, or null while the list has not been read */
  function threadsFor(nodeId) {
    const list = ui.lists['threads|open'];
    if (!list) return null;
    if (!m.indexCache || m.indexCache.items !== list.items || m.indexCache.nodes !== state.nodes) m.indexCache = { items: list.items, nodes: state.nodes, map: mentionsIndex(list.items, state.nodes) };
    return m.indexCache.map.get(nodeId) || [];
  }

  /** Opens or closes the form; the focus goes to the title, or back to the button */
  function toggleIdea(open) {
    ui.idea.open = open;
    if (open) { ui.idea.message = ''; ui.idea.opener = ''; ui.idea.node = null; }
    paintIdea();
    if (open) $('idea-title').focus(); else focusIdeaOpener();
  }

  /** Puts the focus back on what opened the form: the node panel's button while it is still there, else the New idea button */
  function focusIdeaOpener() {
    const from = ui.idea.opener ? [...root.querySelectorAll('[data-thread-start]')].find((b) => b.dataset.threadStart === ui.idea.opener) : null;
    (from && !from.closest('[inert]') ? from : $('idea-open')).focus();
  }

  /** "Start a thread about this" (a node's panel): the New idea form, with the node's label as the title and its mention in the text */
  function startThread(node) {
    if (!node || ui.idea.busy || !ui.config || ui.config.threads === false) return;
    if (ui.kind !== 'threads') {
      ui.kind = 'threads';
      ui.actNote = null;
      ui.filters = defaultFilters('threads');
    }
    fn.openForge({ tab: 'threads' });
    fn.paintFilters();
    ui.idea.open = true;
    ui.idea.message = '';
    ui.idea.bad = false;
    ui.idea.link = null;
    ui.idea.node = { id: node.id, label: node.label };
    ui.idea.opener = node.id;
    // Never lose a draft: a title already typed stays, and text already typed stays under the mention, which is added once (`.value` is
    // text, never markup, so the label and the id need no escaping here)
    const title = $('idea-title');
    if (title.value.trim() === '') title.value = String(node.label || node.id).slice(0, 256);
    const text = $('idea-body');
    const mention = MENTIONABLE.test(node.id) ? `[[${node.id}]]` : '';
    if (mention && !text.value.includes(mention)) text.value = text.value.trim() === '' ? `${mention}\n\n` : `${mention}\n\n${text.value}`;
    paintIdea();
    $('idea-title').focus();
  }

  /** The one write: a POST to cornfield's own server, which opens an issue with the label as the maintainer */
  async function sendIdea() {
    if (ui.idea.busy) return;
    const asked = ideaRequest($('idea-title').value, $('idea-body').value);
    if (!asked) {
      ui.idea.message = 'Give the idea a title.';
      ui.idea.bad = true;
      ui.idea.link = null;
      paintIdea();
      announce(ui.idea.message);
      $('idea-title').focus();
      return;
    }
    ui.idea.busy = true;
    ui.idea.message = '';
    paintIdea();
    announce(`Opening the idea on ${fn.forgeName()}`);
    const res = await fn.post(IDEAS_URL, asked);
    ui.idea.busy = false;
    ui.idea.message = ideaWords(fn.forgeName(), res);
    ui.idea.bad = !res.ok;
    ui.idea.link = res.ok && res.body.issue ? res.body.issue.url : null;
    if (res.ok) {
      ui.idea.open = false;
      $('idea-title').value = '';
      $('idea-body').value = '';
    }
    paintIdea();
    announce(ui.idea.message);
    if (res.ok) await afterIdea(res);
    else $('idea-title').focus();
  }

  /**
   * After an idea is opened: the list read again, the new thread selected (so what it mentions lights), the focus back on what opened
   * the form, and all of it said once. The idea is on the forge whatever happens here, so a failure is said, never thrown.
   */
  async function afterIdea(res) {
    const about = ui.idea.node;
    const n = res.body && res.body.number;
    let trouble = '';
    try {
      // The new thread is shown where threads are: an idea opened from Specs goes on to the Threads tab
      if (ui.kind !== 'threads') { ui.kind = 'threads'; ui.actNote = null; ui.filters = defaultFilters('threads'); fn.paintFilters(); }
      ui.lists = {};
      m.primed.clear(); // the tabs' counts are read again
      m.indexCache = null;
      await fn.loadList(true, true);
      if (ui.open) fn.primeCounts();
      ensureThreadsList();
      // The new thread is selected in the list, so what it mentions lights on the map once its messages are in
      if (Number.isInteger(n)) await selectThread(n);
    } catch (err) {
      trouble = ` The list could not be read again (${err instanceof Error ? err.message : err}); Refresh asks for it.`;
    }
    // Then the focus goes back to what opened the form: after the selection, which draws the node's panel (and its button) again
    try { focusIdeaOpener(); } catch { /* the page moved on */ }
    ui.idea.opener = '';
    ui.idea.node = null;
    const shown = ui.thread === n && ui.threadDetail && ui.threadDetail.thread ? ` ${threadSelectionWords()}` : ui.thread === n && ui.threadError ? ` ${ui.threadError}` : '';
    // Opened from a node: say that its "Mentioned in" lists the new thread
    const listed = about && (threadsFor(about.id) || []).some((t) => t.number === n);
    announce(`${ui.idea.message}${shown}${listed ? ` It is listed under Threads for ${about.label}.` : ''}${trouble}`);
  }

  /** The New idea bar and form, from `ui.idea`; typed text and the focus are left alone */
  function paintIdea() {
    const bar = $('forge-idea');
    if (!bar) return;
    // An idea is a thread: with threads off (`threads: false`) there is no New idea, on Specs either
    bar.hidden = (ui.kind !== 'threads' && ui.kind !== 'specs') || !!fn.detailKey() || !ui.config || ui.config.threads === false;
    $('idea-open').setAttribute('aria-expanded', String(ui.idea.open));
    $('idea-form').hidden = !ui.idea.open;
    $('idea-send').textContent = ui.idea.busy ? 'Opening …' : 'Open the idea';
    $('idea-send').disabled = ui.idea.busy;
    if (ui.idea.open) {
      const label = (ui.config && ui.config.threads && ui.config.threads.label) || 'idea';
      $('idea-words').textContent = `This opens an issue labelled "${label}" on ${fn.forgeName()}, as you. The conversation lives there; cornfield keeps no copy of it.`;
    }
    const message = $('idea-message');
    message.hidden = !ui.idea.message;
    message.classList.toggle('hx-forge-msg--bad', ui.idea.bad);
    if (ui.idea.bad) message.dataset.cornState = 'failure'; else delete message.dataset.cornState;
    message.textContent = ui.idea.message;
    if (ui.idea.message && ui.idea.link && safeUrl(ui.idea.link)) {
      const link = inst.doc.createElement('a');
      link.className = 'hx-link';
      link.dataset.corn = 'text-link';
      link.href = ui.idea.link;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = `Open it on ${fn.forgeName()} (new tab)`;
      message.append(' ', link);
    }
  }

  /** One thread in the list: a row that opens it, and a link out to the forge */
  function threadHtml(t) {
    const link = safeUrl(t.url);
    const out = link ? `<a data-corn="out-link" class="hx-forge-out" href="${escHtml(link)}" target="_blank" rel="noreferrer" aria-label="Open thread ${t.number} on ${escHtml(fn.forgeName())} (new tab)">↗</a>` : '';
    const note = [t.proposals && t.proposals.length ? `Proposal ${t.proposals.map((p) => p.slug).join(', ')}` : '', t.idea ? `Idea #${t.idea}` : ''].filter(Boolean).join(' · ');
    // The run that is about this thread, as a word (issue #104): the Agents tab's list, read for every tab, says it; the row only names its state
    const runs = ui.runs && ui.runs.data ? ui.runs.data.runs : null;
    const run = runOnThread(runs, t.number);
    const runWord = run ? `${runPillHtml({ esc: escHtml }, run, threadRunWords(runs, t.number), ` data-thread-run="${escHtml(run.runId)}"`)} ` : '';
    return `<li class="hx-forge-item"><button type="button" class="hx-forge-row" data-forge-thread="${t.number}" aria-pressed="${ui.thread === t.number}" data-corn="row">
      <span class="hx-forge-title">${escHtml(t.title)}</span>
      <span class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(t.state)}" data-corn="state-pill"${cornStateAttr(t.state)}>${escHtml(t.state === 'open' ? 'Open' : 'Closed')}</span> ${runWord}<span class="hx-forge-label" data-corn="tag">${escHtml(threadKindWords(t))}</span> ${escHtml(threadMeta(t, m.now()))}</span>${note ? `<span class="hx-forge-meta">${escHtml(note)}</span>` : ''}</button>${out}</li>`;
  }

  /** The selected thread: read-only, its messages as written, a way to reply on the forge, and the nodes its text lights */
  function threadDetailHtml() {
    const head = (title) => `${backHtml('clear-forge-thread', 'All threads')}<h3 class="hx-forge-detail-title" data-corn="detail-title">${title}</h3>`;
    if (ui.threadError) return `${head(`Thread ${ui.thread}`)}<p class="hx-forge-notice" data-corn="notice">${escHtml(ui.threadError)}</p>`;
    if (!ui.threadDetail) return `${head(`Thread ${ui.thread}`)}<p class="hx-faint">Loading its messages …</p>`;
    const { thread: t, stale } = ui.threadDetail;
    const lit = ui.litThread;
    const url = safeUrl(t.url);
    const reply = url ? `<a data-corn="text-link" class="hx-link" href="${escHtml(url)}" target="_blank" rel="noreferrer">Reply on ${escHtml(fn.forgeName())} (new tab)</a>` : '';
    const named = [
      ...(t.proposals || []).map((p) => `Proposal <code class="hx-code">${escHtml(p.slug)}</code> in pull request #${p.pull}`),
      ...(t.kind === 'proposal' ? [`Spec pull request for <code class="hx-code">${escHtml((t.slugs || []).join(', '))}</code>`] : []),
      ...(t.idea ? [`Names idea #${t.idea}`] : []),
    ];
    const msgs = t.messages.map((msg) => {
      const own = lit.perMessage.get(msg.id) || { nodes: [], unresolved: [] };
      const link = safeUrl(msg.url) ? ` <a data-corn="out-link" class="hx-link" href="${escHtml(msg.url)}" target="_blank" rel="noreferrer" aria-label="Open this message on ${escHtml(fn.forgeName())} (new tab)">↗</a>` : '';
      const chips = own.nodes.length || own.unresolved.length
        ? `<span class="hx-forge-nodes hx-thread-nodes">${own.nodes.map(fn.nodeButton).join('')}${own.unresolved.length ? `<span class="hx-faint">not on the map: ${own.unresolved.map((r) => `<code class="hx-code">${escHtml(r)}</code>`).join(' ')}</span>` : ''}</span>`
        : '';
      return `<li class="hx-thread-msg" data-corn="thread-message"><p class="hx-forge-meta"><strong class="hx-strong">${escHtml(msg.author ? msg.author.login : 'someone')}</strong>${msg.opening ? ' opened this' : ''} · ${escHtml(relativeTime(msg.createdAt, m.now()))}${link}</p><p class="hx-thread-body">${escHtml(msg.body.trim() === '' ? '(no text)' : msg.body)}${msg.cut ? '\n… (cut here; the rest is on the forge)' : ''}</p>${chips}</li>`;
    }).join('');
    const key = lit.nodes.length ? `<p class="hx-forge-key hx-faint"><span class="hx-mark-dot hx-mark-dot--changed" data-corn="mark-dot" data-corn-state="changed" aria-hidden="true"></span>a node this thread mentions</p>` : '';
    return `${head(`#${t.number} ${escHtml(t.title)}`)}
      <p class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(t.state)}" data-corn="state-pill"${cornStateAttr(t.state)}>${t.state === 'open' ? 'Open' : 'Closed'}</span> ${escHtml(threadKindWords(t))} · ${escHtml(threadMeta({ ...t, comments: t.messages.length - (t.kind === 'idea' ? 1 : 0) + (t.hidden || 0) }, m.now()))}</p>
      <p class="hx-forge-why hx-faint">Read-only here: a thread is a conversation on ${escHtml(fn.forgeName())}, so you reply there. ${reply}</p>
      ${named.length ? `<p class="hx-forge-meta">${named.join(' · ')}</p>` : ''}
      ${stale ? `<p class="hx-forge-notice" data-corn="notice">${escHtml(`This is an older answer. ${stale}`)}</p>` : ''}
      <h4 class="hx-forge-sub">${escHtml(`Mentions: ${plural(lit.nodes.length, 'node')} on the map`)}</h4>
      ${key}
      ${lit.nodes.length ? `<span class="hx-forge-nodes hx-thread-nodes">${lit.nodes.map(fn.nodeButton).join('')}</span>` : '<p class="hx-faint">No message mentions a node. Write [[node-id]] or [[repo/path]] in a message to point at the map.</p>'}
      ${lit.unresolved.length ? `<p class="hx-forge-notice" data-corn="notice">${escHtml(lit.unresolved.join(', '))} ${lit.unresolved.length === 1 ? 'is' : 'are'} mentioned but not on the map, so ${lit.unresolved.length === 1 ? 'it stays' : 'they stay'} text.</p>` : ''}
      <h4 class="hx-forge-sub">${escHtml(plural(t.messages.length, 'message'))}</h4>
      ${t.hidden ? `<p class="hx-forge-why hx-faint">${escHtml(plural(t.hidden, 'earlier message'))} not shown; they are on ${escHtml(fn.forgeName())}.</p>` : ''}
      <ol class="hx-thread-msgs" aria-label="Messages">${msgs}</ol>`;
  }

  Object.assign(fn, { dropThread, selectThread, clearThread, threadSelectionWords, openThread, ensureThreadsList, threadsFor, toggleIdea, focusIdeaOpener, startThread, sendIdea, afterIdea, paintIdea, threadHtml: (...a) => withParts(threadHtml(...a)), threadDetailHtml: (...a) => withParts(threadDetailHtml(...a)) });
}
