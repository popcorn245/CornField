/**
 * @module explorer/pieces/work-notes
 *
 * Release notes: the draft for a tag, Copy, and Post as draft. Part of the Work piece (pieces/work.js): `install(ctx)` makes this part's functions for one mount, and hands the ones other parts call
 * to `ctx.fn`; nothing is shared between two mounts.
 */

import { DRAFTS_URL, notesUrl, sinceChoices, notesSummary, validTag, confirmWords, postedWords, draftRequest } from '../forge-panel-model.js';
import { safeUrl, option } from './work-common.js';

export function install(ctx) {
  const { inst, ui, m, fn, $ } = ctx;
  const { announce } = ctx.h;

  /** Loads the draft for the tag chosen (again, past the server's cache, on a refresh) */
  async function loadNotes(refresh = false) {
    const token = ++m.notesToken;
    const n = ui.notes;
    n.loading = true;
    n.error = '';
    n.message = '';
    closeNotesConfirm(false);
    fn.paint();
    const res = await fn.request(notesUrl(n.since), refresh);
    if (token !== m.notesToken) return;
    n.loading = false;
    if (res.ok) {
      n.data = res.body;
      announce(`Release notes drafted. ${notesSummary(n.data)}${n.data.stale ? ' This is an older answer' : ''}`);
    } else {
      n.error = fn.failWords(res, 'the release notes');
      announce(n.error);
    }
    fn.paint();
  }

  /** Says something about the last Copy or Post, on the page and to a screen reader */
  function say(words, bad = false, link = null) {
    ui.notes.message = words;
    ui.notes.bad = bad;
    ui.notes.link = link;
    paintNotes();
    announce(words);
  }

  /** Copies the draft: the clipboard, else the text selected for the person to copy */
  async function copyNotes() {
    const data = ui.notes.data;
    if (!data) return;
    try {
      if (inst.win.navigator.clipboard && inst.win.navigator.clipboard.writeText) {
        await inst.win.navigator.clipboard.writeText(data.markdown);
        say('Copied the release notes.');
        return;
      }
    } catch { /* blocked: try the old way */ }
    const area = $('notes-preview');
    area.focus();
    area.select();
    let copied = false;
    try { copied = typeof inst.doc.execCommand === 'function' && inst.doc.execCommand('copy'); } catch { copied = false; }
    say(copied ? 'Copied the release notes.' : 'Copying was blocked. The draft is selected: press Ctrl+C, or Command+C on a Mac.', !copied);
  }

  /** The confirm step: what will happen in words, and the tag to ask for (the one the server suggests, to change) */
  function openNotesConfirm() {
    const n = ui.notes;
    if (!n.data || n.posting) return;
    if (!n.data.count) { say('There are no merged pull requests to put in a draft.', true); return; }
    n.confirm = true;
    n.message = '';
    $('notes-tag').value = n.data.suggestedTag || '';
    paintNotes();
    $('notes-tag').focus();
    announce('Post as a draft release. Check the tag, then create the draft.');
  }

  /** Closes the confirm step; the focus goes back to the button that opened it unless told not to */
  function closeNotesConfirm(restoreFocus = true) {
    const n = ui.notes;
    if (!n.confirm) return;
    n.confirm = false;
    paintNotes();
    if (restoreFocus) $('notes-post').focus();
  }

  /** The one write: asks the server to have the forge keep the notes as a draft release for the tag typed */
  async function postDraft() {
    const n = ui.notes;
    if (!n.confirm || n.posting || !n.data) return;
    const tag = $('notes-tag').value.trim();
    if (!validTag(tag)) { say('Give the tag the draft is for, like v0.2.0: letters, digits, dots, dashes and slashes, no spaces.', true); $('notes-tag').focus(); return; }
    n.posting = true;
    n.message = '';
    paintNotes();
    announce('Creating the draft release');
    const res = await fn.request(DRAFTS_URL, false, draftRequest(tag, n.since));
    n.posting = false;
    if (res.ok) {
      n.confirm = false;
      say(postedWords({ forge: fn.forgeName(), tag, count: res.body.count }), false, res.body.release && res.body.release.url);
      $('notes-post').focus();
      return;
    }
    say(res.status === 401 ? 'Your sign-in has ended. Sign in again to post a draft.' : fn.failWords(res), true);
    $('notes-tag').focus();
  }

  /** The Release notes view, from `ui.notes`; the typed tag and the focus are left alone */
  function paintNotes() {
    const n = ui.notes;
    const data = n.data;
    const since = $('notes-since');
    // The choices are drawn again only when they change, so the select keeps the focus while a draft is loaded for it
    const choices = (data ? sinceChoices(data) : [['', 'Latest tag']]).map(([v, l]) => option(v, l, false)).join('');
    if (since.dataset.choices !== choices) { since.innerHTML = choices; since.dataset.choices = choices; }
    since.value = n.since;
    const area = $('notes-preview');
    if (area.value !== (data ? data.markdown : '')) area.value = data ? data.markdown : '';
    $('notes-copy').disabled = !data;
    $('notes-post').disabled = !data;
    $('notes-post').setAttribute('aria-expanded', String(n.confirm));
    const confirm = $('notes-confirm');
    confirm.hidden = !n.confirm;
    if (n.confirm && data) {
      $('notes-confirm-words').textContent = confirmWords({ forge: fn.forgeName(), repo: ui.config.forge.repo, tag: '', count: data.count });
      $('notes-confirm-yes').textContent = n.posting ? 'Creating …' : 'Create the draft';
    }
    const message = $('notes-message');
    message.hidden = !n.message;
    message.classList.toggle('hx-forge-msg--bad', n.bad);
    if (n.bad) message.dataset.cornState = 'failure'; else delete message.dataset.cornState;
    message.textContent = n.message;
    if (n.message && n.link && safeUrl(n.link)) {
      const link = inst.doc.createElement('a');
      link.className = 'hx-link';
      link.dataset.corn = 'text-link';
      link.href = n.link;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = `Open the draft on ${fn.forgeName()} (new tab)`;
      message.append(' ', link);
    }
  }

  /** The panel's lines for the Release notes view: the status, a failure, the rate limit; the rest is paintNotes */
  function drawNotes() {
    const n = ui.notes;
    $('forge-status').textContent = n.loading && !n.data ? `Drafting the release notes from ${fn.forgeName()} …` : n.data ? notesSummary(n.data) : '';
    const notice = $('forge-notice');
    const words = n.error || (n.data && n.data.stale ? `Showing an older answer. ${n.data.stale}` : '');
    fn.setNotice(notice, words, !!words);
    $('forge-detail').hidden = true;
    fn.paintIdea();
    $('forge-rate').textContent = (n.data && n.data.rate) || '';
    paintNotes();
    fn.paintButton();
  }

  /** The Release notes view, from the PRs list: its own page with a way back */
  function openNotes() {
    ui.kind = 'notes';
    ui.actNote = null;
    if (ui.notes.data || ui.notes.loading) { fn.paint(); announce(`Release notes. ${ui.notes.data ? notesSummary(ui.notes.data) : ''}`); } else loadNotes();
    $('notes-title').focus();
  }

  /** Back from the Release notes to the PRs list, the focus on the button that opened them */
  function closeNotes() {
    ui.kind = 'pulls';
    fn.paint();
    $('notes-open').focus();
    announce('All pull requests');
  }

  Object.assign(fn, { loadNotes, say, copyNotes, openNotesConfirm, closeNotesConfirm, postDraft, paintNotes, drawNotes, openNotes, closeNotes });
}
