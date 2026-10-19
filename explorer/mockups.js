/**
 * @module explorer/mockups
 *
 * Opening a proposal's mockups (`proposal.mockups`, core/proposal.js) from the node they name. A node's panel lists
 * them (mockups-model.js); a click, or Enter, opens one in a window over the map: a picture in an `<img>` whose alt
 * text is the mockup's title, an HTML page in an `<iframe>`. A mockup is untrusted content from a branch, so:
 *
 *   - the iframe is `sandbox=""`: no `allow-scripts`, no `allow-same-origin`, nothing else; the page runs no script and
 *     has no access to cornfield's origin. The server says the same in a `Content-Security-Policy: sandbox` of its own
 *     (server/mockups.js), so a file opened on its own is held too;
 *   - an SVG is shown as an image (`<img>`), which never runs script;
 *   - the address is built from the position in the proposal's list, never from the path the proposal gives.
 *
 * The window is a dialog: it takes the focus (and the screen reader reads its title and where the mockup stands with
 * the review), Tab stays inside it, Escape or Close shuts it, and the focus goes back to the button that opened it.
 *
 *   GET /proposals/<slug>/mockups?source=…   where each stands with the review: state.mockupStates (by position)
 *
 * It is read when a proposal opens and again after an approval (review.js), and the panel's section is repainted.
 */

import { state } from './state.js';
import { hooks } from './proposal.js';
import { mockupsOf } from '../core/proposal.js';
import { mockupsFor, mockupsSectionHtml, stateWords } from './mockups-model.js';

const $ = (id) => document.getElementById(id);

let wired = false;
let barBefore = null;
let loadedKey = null; // `${source}/${slug}` the states below belong to
let returnTo = null; // the button that opened the window
let dialog = null;
let loading = 0; // counts requests, so only the last answer is kept

const keyOf = () => (state.proposal && state.proposalSlug ? `${state.proposalSource || ''}/${state.proposalSlug}` : null);
const announce = (text) => { const el = $('map-announcer'); if (el) el.textContent = text; };

/** The panel's mockup section, drawn again from the states now held (the node in it may have none) */
function repaintSection() {
  const section = document.querySelector('#drawer-meta-list [data-mockups]');
  const node = state.selectedNode;
  if (!section || !node) return;
  const items = mockupsFor(state.proposal, state.proposalSlug, state.proposalSource, node.id, state.mockupStates);
  const html = mockupsSectionHtml(items);
  if (!html) return;
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.mockup : undefined;
  section.outerHTML = html;
  if (focused !== undefined) {
    const again = document.querySelector(`#drawer-meta-list [data-mockup="${focused}"]`);
    if (again) again.focus();
  }
}

/**
 * Asks the server where each mockup of the open proposal stands with the review.
 * @returns {Promise<void>}
 */
export async function refreshMockups() {
  const key = keyOf();
  const mine = ++loading;
  if (!key || !state.proposal || !Array.isArray(state.proposal.mockups) || !state.proposal.mockups.length) {
    state.mockupStates = {};
    return;
  }
  const slug = encodeURIComponent(state.proposalSlug);
  try {
    const res = await fetch(`/proposals/${slug}/mockups${state.proposalSource ? `?source=${encodeURIComponent(state.proposalSource)}` : ''}`, { cache: 'no-store' });
    if (!res.ok) return;
    const list = await res.json();
    if (mine !== loading || key !== keyOf() || !Array.isArray(list)) return; // another proposal opened since
    state.mockupStates = Object.fromEntries(list.filter((m) => Number.isInteger(m.index) && typeof m.state === 'string').map((m) => [m.index, m.state]));
    repaintSection();
  } catch { /* the server is not there: every mockup reads "not reviewed yet" */ }
}

// ---------------------------------------------------------------------------
//  The window
// ---------------------------------------------------------------------------

const FOCUSABLE = 'button, [href], iframe, [tabindex]:not([tabindex="-1"])';

/** Shuts the window and gives the focus back to the button that opened it */
export function closeMockup() {
  if (!dialog) return;
  dialog.remove();
  dialog = null;
  document.removeEventListener('keydown', onKey, true);
  if (returnTo && returnTo.isConnected) returnTo.focus();
  returnTo = null;
  announce('Mockup closed');
}

function onKey(e) {
  if (!dialog) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeMockup();
  } else if (e.key === 'Tab') {
    const stops = [...dialog.querySelectorAll(FOCUSABLE)];
    const at = stops.indexOf(document.activeElement);
    const next = e.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at < 0 || at === stops.length - 1 ? 0 : at + 1);
    if (stops.length) {
      e.preventDefault();
      stops[next].focus();
    }
  }
}

/**
 * Opens the n-th mockup of the open proposal in a window over the map.
 * @param {number} index its position in the proposal's `mockups`
 * @param {HTMLElement | null} [opener] the button to give the focus back to
 * @returns {boolean} whether it opened
 */
export function openMockup(index, opener = null) {
  const listed = state.proposal ? mockupsOf(state.proposal).find((m) => m.index === index) : null;
  const item = listed ? mockupsFor(state.proposal, state.proposalSlug, state.proposalSource, listed.node, state.mockupStates).find((m) => m.index === index) : null;
  if (!item) return false;
  closeMockup();
  returnTo = opener;
  dialog = document.createElement('div');
  dialog.className = 'hx-mockup-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'mockup-title');
  dialog.setAttribute('aria-describedby', 'mockup-state');
  dialog.tabIndex = -1;
  const head = document.createElement('div');
  head.className = 'hx-mockup-head';
  const title = document.createElement('h2');
  title.id = 'mockup-title';
  title.className = 'hx-mockup-title';
  title.textContent = item.title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'hx-btn hx-mockup-close';
  close.dataset.mockupClose = '';
  close.textContent = 'Close';
  head.append(title, close);
  const status = document.createElement('p');
  status.id = 'mockup-state';
  status.className = `hx-mockup-state hx-mockup-state--${item.state}`;
  status.textContent = stateWords(item.state);
  const stage = document.createElement('div');
  stage.className = 'hx-mockup-stage';
  if (item.type === 'page') {
    const frame = document.createElement('iframe');
    frame.className = 'hx-mockup-frame';
    frame.setAttribute('sandbox', ''); // no allow-scripts, no allow-same-origin: the page is inert and cut off from cornfield
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', item.title);
    frame.setAttribute('src', item.url);
    stage.append(frame);
  } else {
    const img = document.createElement('img'); // SVG too: an image never runs script
    img.className = 'hx-mockup-img';
    img.setAttribute('alt', item.title);
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.setAttribute('src', item.url);
    stage.append(img);
  }
  dialog.append(head, status, stage);
  document.body.append(dialog);
  document.addEventListener('keydown', onKey, true);
  dialog.focus();
  announce(`Mockup: ${item.title}. ${stateWords(item.state)}. Escape closes it.`);
  return true;
}

function onClick(e) {
  const target = e.target && e.target.closest ? e.target : null;
  if (!target) return;
  if (target.closest('[data-mockup-close]')) { closeMockup(); return; }
  const open = target.closest('[data-mockup]');
  if (open) openMockup(Number(open.dataset.mockup), open);
}

/**
 * Wires the mockups to the page (main.js calls this once): clicks on a panel's mockup buttons and on the window's
 * Close, and the review states read when a proposal opens. The bar keeps whatever hook was there before.
 */
export function initMockups() {
  if (wired) return;
  wired = true;
  document.addEventListener('click', onClick);
  barBefore = hooks.bar;
  hooks.bar = (open) => {
    if (barBefore) barBefore(open);
    const key = open ? keyOf() : null;
    if (key === loadedKey) return;
    loadedKey = key;
    state.mockupStates = {};
    closeMockup();
    if (key) refreshMockups();
  };
}

/** For tests: forget the page this was wired to */
export function resetMockupsForTests() {
  if (dialog) { dialog.remove(); dialog = null; }
  document.removeEventListener('keydown', onKey, true);
  if (wired) { document.removeEventListener('click', onClick); hooks.bar = barBefore; }
  wired = false;
  loadedKey = null;
  returnTo = null;
  state.mockupStates = {};
}
