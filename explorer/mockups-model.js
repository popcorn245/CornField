/**
 * @module explorer/mockups-model
 *
 * The pure half of a proposal's mockups (screens listed in `proposal.mockups`, core/proposal.js): which ones belong to
 * a node, what to say of each, the address of its file, and the section of the node's panel that opens them. No DOM, no
 * network; mockups.js is the half that touches the page. Every piece of text from the proposal is escaped.
 *
 *   mockupsFor        the mockups of one node: [{ index, node, path, title, type, url, state }]
 *   stateWords        "Reviewed", "Changed since you approved", "Not reviewed yet", "File not found"
 *   mockupsSectionHtml the "Mockups" section of a node's panel
 *   mockupUrl         where the server serves one (by its position in the proposal, never by path)
 */

import { state, escHtml } from './state.js';
import { mockupsOf } from '../core/proposal.js';

const STATE_WORDS = {
  approved: 'Reviewed',
  changed: 'Changed since you approved',
  unreviewed: 'Not reviewed yet',
  missing: 'File not found',
};

/** What a mockup's review state says, in plain words */
export const stateWords = (state) => STATE_WORDS[state] || STATE_WORDS.unreviewed;

/** The kind of a mockup: HTML is a page (shown in a sandboxed frame), anything else a picture */
export const typeOf = (file) => (/\.html$/i.test(String(file)) ? 'page' : 'image');

/** The address of the n-th mockup of a proposal the server lists as `slug` in `source` */
export function mockupUrl(slug, source, index) {
  return `/proposals/${encodeURIComponent(slug)}/mockups/${index}${source ? `?source=${encodeURIComponent(source)}` : ''}`;
}

/**
 * The mockups a proposal lists for one node, with their review state from the server's list (`states`, by index;
 * a mockup it has not said anything of is "not reviewed yet").
 * @param {object | null} proposal
 * @param {string | null} slug
 * @param {string | null} source
 * @param {string} nodeId
 * @param {Record<number, string>} [states]
 */
export function mockupsFor(proposal, slug, source, nodeId, states = {}) {
  if (!proposal || !slug) return [];
  return mockupsOf(proposal)
    .filter((m) => m.node === nodeId)
    .map((m) => ({ ...m, type: typeOf(m.path), url: mockupUrl(slug, source, m.index), state: states[m.index] || 'unreviewed' }));
}

/**
 * The section of a node's panel: one button per mockup, which opens it, and where it stands with the review. Empty
 * for a node with none.
 * @param {ReturnType<typeof mockupsFor>} items
 */
export function mockupsSectionHtml(items) {
  if (!items.length) return '';
  const rows = items.map((m) => `<li class="hx-mockup-item">
      <button type="button" class="hx-btn hx-mockup-open" data-mockup="${m.index}" aria-haspopup="dialog">${escHtml(m.title)}<span class="hx-sr-only"> (${m.type === 'page' ? 'page' : 'image'}, opens in a window)</span></button>
      <span class="hx-mockup-state hx-mockup-state--${escHtml(m.state)}">${escHtml(stateWords(m.state))}</span>
    </li>`).join('');
  return `<div class="hx-sec hx-mockups" data-mockups>
    <strong class="hx-strong" id="hx-mockups-h">${items.length === 1 ? 'Mockup' : 'Mockups'}</strong>
    <ul class="hx-mockup-list" aria-labelledby="hx-mockups-h">${rows}</ul>
  </div>`;
}

/**
 * The section for a node of the proposal that is open now, from `state.proposal` and the review states the server
 * last gave (`state.mockupStates`, by index). Empty when no proposal is open or the node has no mockups.
 * @param {string} nodeId
 */
export function nodeMockupsHtml(nodeId) {
  return mockupsSectionHtml(mockupsFor(state.proposal, state.proposalSlug, state.proposalSource, nodeId, state.mockupStates || {}));
}
