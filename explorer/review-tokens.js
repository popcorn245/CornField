/**
 * @module explorer/review-tokens
 *
 * Review tokens in the dashboard (spec 0002, server/review-api.js): a signed-in maintainer makes a token so a script or a
 * chat bot can Approve or Send back a proposal as them (`POST /api/reviews`), sees the tokens they hold and revokes one.
 * A header button opens a dialog over the map (a scrim, `aria-modal`, the focus stays in it, Escape and Close give it
 * back to the button). Shown only when the config names a forge and somebody is signed in: without sign-in there are no
 * tokens.
 *
 *   GET  /api/review-tokens              the list: label, when it ends, when it was last used
 *   POST /api/review-tokens              { label, days? } -> the new token, **in that answer only**
 *   POST /api/review-tokens/<id>/revoke  ends one
 *
 * A new token is put in a read-only field with a Copy button and the words that it is not shown again; it lives in
 * that field and nowhere else (not in a variable, a storage or an announcement for a screen reader), and Close or
 * making another empties it. The list never holds a secret; the server has only a hash.
 *
 * The words and the request are review-tokens-model.js, tested without a page.
 */

import { escHtml } from './state.js';
import { announce } from './keyboard.js';
import { trapTab } from './focusables.js';
import { tokensUrl, introWords, DEFAULT_DAYS, MAX_DAYS, makeRequest, revokeUrl, tokenLine, errorWords } from './review-tokens-model.js';

const $ = (id) => document.getElementById(id);
let wired = false;
let now = () => Date.now();
const ui = { open: false, busy: false, tokens: [], loaded: false, message: null, scope: 'review' };

const dialog = () => $('tokens-dialog');

async function request(method, url, payload) {
  try {
    const res = await fetch(url, { method, cache: 'no-store', headers: payload === undefined ? {} : { 'Content-Type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    return { ok: !!res.ok && !!body && body.ok === true, status: res.status, body };
  } catch {
    return { ok: false, status: null, body: null };
  }
}

function say(text, ok = true) {
  ui.message = text ? { text, ok } : null;
  paint();
  if (text) announce(text);
}

/** Everything the dialog shows, from `ui` */
function paint() {
  if (!dialog()) return;
  const list = $('tokens-list');
  if (!ui.loaded) list.innerHTML = '<li class="hx-faint">Loading …</li>';
  else if (!ui.tokens.length) list.innerHTML = `<li class="hx-faint">You have no ${ui.scope} tokens yet.</li>`;
  else {
    list.innerHTML = ui.tokens.map((t) => {
      const line = tokenLine(t, now());
      return `<li class="hx-tokens-item" data-state="${line.state}" data-corn="row"><span class="hx-tokens-label">${escHtml(line.label)}</span> <span class="hx-tokens-meta hx-faint">${escHtml(line.status)} · ${escHtml(line.used)}</span> ${line.canRevoke ? `<button type="button" class="hx-btn hx-btn--quiet" data-revoke="${escHtml(String(line.id))}" aria-label="Revoke ${escHtml(line.label)}"${ui.busy ? ' disabled' : ''} data-corn-kind="danger">Revoke</button>` : ''}</li>`;
    }).join('');
  }
  const intro = $('tokens-intro');
  if (intro) intro.textContent = introWords(ui.scope);
  const msg = $('tokens-msg');
  msg.hidden = !ui.message;
  msg.textContent = ui.message ? ui.message.text : '';
  msg.classList.toggle('hx-forge-msg--bad', !!ui.message && !ui.message.ok);
  if (ui.message && !ui.message.ok) msg.dataset.cornState = 'failure'; else delete msg.dataset.cornState;
  $('tokens-make').disabled = ui.busy;
}

async function load() {
  const res = await request('GET', tokensUrl(ui.scope));
  if (res.ok && Array.isArray(res.body.tokens)) {
    ui.tokens = res.body.tokens;
    ui.loaded = true;
    paint();
    return;
  }
  ui.loaded = true;
  ui.tokens = [];
  say(errorWords(res.status, res.body), false);
}

function clearSecret() {
  const box = $('tokens-secret');
  $('tokens-secret-value').value = '';
  box.hidden = true;
}

async function make(e) {
  e.preventDefault();
  if (ui.busy) return;
  const checked = makeRequest($('tokens-label').value, $('tokens-days').value);
  if (!checked.ok) { say(checked.error, false); $('tokens-label').focus(); return; }
  clearSecret();
  ui.busy = true;
  say('');
  const res = await request('POST', tokensUrl(ui.scope), checked.body);
  ui.busy = false;
  if (!res.ok || typeof res.body.secret !== 'string') { say(errorWords(res.status, res.body), false); return; }
  // The one time the secret is seen: in the field, and not in a live region
  $('tokens-secret-value').value = res.body.secret;
  $('tokens-secret').hidden = false;
  $('tokens-label').value = '';
  $('tokens-days').value = '';
  say(`Made the token "${res.body.token.label}". Copy it now: it is not shown again.`);
  $('tokens-secret-value').focus();
  $('tokens-secret-value').select();
  await load();
}

async function revoke(id) {
  if (ui.busy) return;
  ui.busy = true;
  paint();
  const res = await request('POST', revokeUrl(id, ui.scope), {});
  ui.busy = false;
  if (!res.ok) say(errorWords(res.status, res.body), false);
  else say(`Revoked "${res.body.token.label}". It no longer works.`);
  await load();
}

async function copy() {
  const field = $('tokens-secret-value');
  try {
    await navigator.clipboard.writeText(field.value);
    announce('Copied.');
    say('Copied. It is not shown again.');
  } catch {
    field.focus();
    field.select();
    say('Select the token and copy it by hand.', false);
  }
}

/** While the dialog is open the focus cannot leave it */
function keepFocusIn(e) {
  const el = dialog();
  if (ui.open && el && !el.contains(e.target)) $('tokens-title').focus();
}

export function openTokens() {
  const el = dialog();
  if (!el || ui.open) return;
  ui.open = true;
  ui.loaded = false;
  ui.message = null;
  document.addEventListener('focusin', keepFocusIn);
  el.hidden = false;
  $('tokens-btn').setAttribute('aria-expanded', 'true');
  paint();
  $('tokens-title').focus();
  load();
}

export function closeTokens({ restoreFocus = true } = {}) {
  const el = dialog();
  if (!el || !ui.open) return;
  ui.open = false;
  clearSecret();
  el.hidden = true;
  document.removeEventListener('focusin', keepFocusIn);
  $('tokens-btn').setAttribute('aria-expanded', 'false');
  // The button is in the account menu, which is shut by now: the focus goes to the menu's button then
  if (restoreFocus) ($('tokens-btn').closest('[hidden]') ? $('account-btn') : $('tokens-btn')).focus();
}

function onClick(e) {
  if (e.target === dialog()) { closeTokens(); return; } // the scrim
  const t = e.target.closest ? e.target.closest('button') : null;
  if (!t) return;
  if (t.hasAttribute('data-tokens-close')) closeTokens();
  else if (t.hasAttribute('data-tokens-copy')) copy();
  else if (t.hasAttribute('data-revoke')) revoke(t.getAttribute('data-revoke'));
}

/** Escape closes; Tab stays inside; nothing reaches the map behind */
function onKey(e) {
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); closeTokens(); return; }
  trapTab(e, dialog());
}

/**
 * Wires the button and the dialog (main.js calls this once the config is read). With no forge in the config, or nobody
 * signed in, both stay hidden, and this returns false.
 * @param {{ forge?: { type: string, repo: string } | null, signIn?: false | { login: string } }} config what `/cornfield/config.json` said
 * @param {{ clock?: () => number }} [opts] `clock` for the times shown (tests)
 * @returns {boolean} whether it is on
 */
export function initReviewTokens(config, opts = {}) {
  const btn = $('tokens-btn');
  if (!config || !config.forge || !config.signIn || !btn || !dialog()) return false;
  if (opts.clock) now = opts.clock;
  btn.hidden = false;
  $('tokens-days').placeholder = String(DEFAULT_DAYS);
  $('tokens-days-hint').textContent = `1 to ${MAX_DAYS}, ${DEFAULT_DAYS} if left empty`;
  if (!wired) {
    wired = true;
    btn.addEventListener('click', openTokens);
    dialog().addEventListener('click', onClick);
    dialog().addEventListener('keydown', onKey);
    $('tokens-form').addEventListener('submit', make);
    const scope = $('tokens-scope');
    if (scope) scope.addEventListener('change', () => { ui.scope = scope.value === 'agent' || scope.value === 'runner' ? scope.value : 'review'; ui.loaded = false; ui.tokens = []; clearSecret(); paint(); load(); });
  }
  return true;
}

/** For tests: forget the page this was wired to, and everything shown */
export function resetReviewTokensForTests(clock = () => Date.now()) {
  if (ui.open) closeTokens({ restoreFocus: false });
  wired = false;
  now = clock;
  Object.assign(ui, { open: false, busy: false, tokens: [], loaded: false, message: null, scope: 'review' });
  const scope = $('tokens-scope');
  if (scope) scope.value = 'review';
}
