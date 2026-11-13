/**
 * @module explorer/pieces/scope-proposal
 *
 * The proposal a `<corn-scope>` holds for every piece in it (spec 0011 D4, D5, D6): the sketch puts `proposal` (and `source` and `view`) on the scope, so
 * the review's sections (`<corn-proposal>`, `<corn-changes>`, `<corn-decision>`) and the map beside them follow one proposal. This is the same opening
 * `corn-review` does in its one root (pieces/review.js `applyProposal`), on the scope's instance and with no piece of its own: it asks the engine
 * (engine/proposal.js: `GET /proposals/<name>.json` through `credentialed`, so the session goes only to the server's own origin), and the pieces that
 * are there draw what the instance says (`proposal:draw`, `proposal:bar`). It is a chunk of its own, loaded the first time a scope has a proposal:
 * a scope or a map that never has one does not carry it.
 *
 *   const held = holdProposal(inst, options)    -> { update, sync, destroy }
 *
 * Options (and what `update(next)` takes, only the keys present):
 *   proposal   a name (read from the server), the proposal object (shown for reading: a decision needs the name), or null: closes it. Held while
 *              there is no map with nodes to lay it over, and opened when there is (a map that comes later, or is put back: `map:ready`, `map:topology`)
 *   source     which copy of it: `checkout`, `pull/31`, a worktree; none: the server answers with the first it lists
 *   view       `before`, `diff` or `after`
 *   blocked    the scope's `src` is not an address: a name is asked of nobody (the scope says so)
 *   pageUrl    () => the page's address, for the sign-in's way back
 *   onNavigate ({ proposal, source, view, change })  the open proposal or its view changed: what cornfield's own page puts in its address bar (the host decides what
 *              to do with it); `change`: 'opened' | 'view' | 'closed'. Said once, whoever changed it: a host's property, a button on the bar, a way on from a bad link
 *   onDecision ({ outcome, proposal, source, open, review })  the server took a review; once, after its answer, whichever `<corn-decision>` was pressed
 *   onAuth     ({ status, signIn, during })  a read or a press was refused for want of a sign-in (`during`: 'proposal', 'facts', 'review', 'send', 'landing')
 *   onError    ({ kind: 'proposal', message })  the proposal asked for did not open
 *
 * What it does for the pieces besides opening: it answers `map:set` (a proposal's nodes are laid out beside the map's, engine/topology.js `setMap`) and
 * `proposal:specs-list` (there is no list of specs to open in another app's page), and it hears a click on an edge of the map (engine/proposal.js
 * `bindEdgePicking`, on the map's canvas) so that a marked edge opens in the node panel whether or not a `<corn-proposal>` is there. It reads no address and
 * writes none.
 */

import { openProposal, showProposal, closeProposal, setProposalView, rebuildProposalMap, bindEdgePicking, setMessage } from '../engine/proposal.js';
import { setMap } from '../engine/topology.js';
import { scopeOf } from '../engine/piece.js';
import { signInUrl } from '../engine/source-address.js';
import { PROPOSAL_VIEWS, isProposalName, notANameWords } from '../proposal-model.js';

/**
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst the scope's instance
 * @param {object} [options] see the top of this file
 */
export function holdProposal(inst, options = {}) {
  const { state } = inst;
  const scope = scopeOf(inst);
  let ended = false;
  /** What the host asked for; `shown` is the key of the proposal this has opened (or is opening), so a repeat of the same ask opens nothing again */
  const current = { proposal: null, source: null, view: null, shown: null };
  const hasMap = () => !!inst.map && state.nodes.length > 0;
  const blocked = !!options.blocked;
  /** No server to ask (no `src`): a name is never asked of the page's own origin in its place, as the review's is not */
  const serverless = () => !inst.base;

  /** Opens, shows or closes what the host asked for, once there is a map to lay it over */
  function sync() {
    if (ended) return undefined;
    const wanted = current.proposal;
    if (wanted === null || wanted === undefined || wanted === '') {
      current.shown = null;
      if (state.proposal && inst.map) closeProposal(inst);
      return undefined;
    }
    if (!hasMap()) return undefined; // a proposal is laid over a map: it opens when there is one
    const view = current.view;
    if (typeof wanted === 'string' && blocked) return undefined; // there is no server to ask (the scope says why)
    if (typeof wanted === 'string' && serverless()) {
      const key = `${wanted}\u0000${current.source || ''}`;
      if (current.shown === key) return undefined;
      current.shown = key;
      const message = isProposalName(wanted) ? `${wanted} cannot be opened here: there is no cornfield server to read it from (the scope has no src).` : notANameWords(wanted);
      setMessage(inst, message, true, []);
      inst.emit('proposal:failed', { slug: wanted, source: current.source, status: 0, notFound: false, message });
      return undefined;
    }
    if (typeof wanted === 'string') {
      // The proposal that is open already, asked for again by its name (a host that heard `cornNavigate` and set what it said): nothing opens again
      if (state.proposal && state.proposalSlug === wanted && (!current.source || current.source === state.proposalSource)) {
        current.shown = `${wanted}\u0000${current.source || ''}`;
        if (PROPOSAL_VIEWS.includes(view) && state.proposalView !== view) setProposalView(inst, view, { quiet: true });
        return undefined;
      }
      const key = `${wanted}\u0000${current.source || ''}`;
      if (current.shown === key) return undefined; // asked already: open, opening, or said why not
      current.shown = key;
      return openProposal(inst, wanted, current.source).then((ok) => {
        if (ok && !ended && current.shown === key && PROPOSAL_VIEWS.includes(view) && state.proposalView !== view) setProposalView(inst, view, { quiet: true });
        return ok;
      });
    }
    if (current.shown === wanted && state.proposal) return undefined;
    current.shown = wanted;
    const source = current.source || null;
    showProposal(inst, wanted, { slug: null, source, pinSource: !!source, view: PROPOSAL_VIEWS.includes(view) ? view : 'diff', sha256: null });
    return undefined;
  }

  // -- what the pieces need of whoever holds the proposal -------------------------------------------------------------------------------
  // The review lays the map out from what the engine hands over (a proposal's nodes and edges are the base with marks): nodes that were there keep their place
  scope.on('map:set', ({ nodes, edges }) => { setMap(inst, nodes, edges); return true; });
  scope.on('proposal:specs-list', () => false);

  // -- the map comes, changes its data, or is put back ------------------------------------------------------------------------------------
  let stopEdges = () => {};
  const bindEdges = () => {
    stopEdges();
    stopEdges = inst.map && state.canvas ? bindEdgePicking(inst, (target, type, fn) => scope.listen(target, type, fn)) : () => {};
  };
  scope.own(() => stopEdges());
  scope.on('map:ready', () => { bindEdges(); sync(); });
  scope.on('map:canvas', bindEdges);
  scope.on('map:gone', () => { stopEdges(); stopEdges = () => {}; });
  scope.on('map:topology', () => {
    // A new base map: an open proposal is laid over it again, as the review does; a proposal still waiting for a map opens
    if (state.proposal && inst.map) rebuildProposalMap(inst, undefined, { fit: true });
    sync();
  });

  // -- what a host hears --------------------------------------------------------------------------------------------------------------------
  scope.on('proposal', ({ change, slug, source, pinSource, view }) => {
    // The reviewer's own act (the bar's Close or View, a way on from a bad link) is the host's property too: asked for again it opens nothing
    if (change === 'closed') { current.proposal = null; current.shown = null; } else if (change === 'opened' && slug) {
      current.proposal = slug;
      if (pinSource) current.source = source;
      current.shown = `${slug}\u0000${current.source || ''}`;
    }
    if (view) current.view = view;
    if (options.onNavigate) options.onNavigate({ proposal: slug, source: pinSource ? source : null, view: change === 'closed' ? null : view, change });
  });
  const signInOf = () => (inst.base ? signInUrl(inst.base, typeof options.pageUrl === 'function' ? options.pageUrl() : '') : '');
  /** The facts are read again every half minute: a sign-in that is still needed is said once, not every time (a press, or a decision taken, is said each time) */
  let factsRefused = '';
  scope.on('auth', ({ status, during }) => {
    if (during === 'facts') { if (factsRefused === `${status}`) return; factsRefused = `${status}`; } else factsRefused = '';
    if (options.onAuth) options.onAuth({ status, signIn: signInOf(), during });
  });
  scope.on('decision', ({ outcome, review, slug, source, open }) => {
    factsRefused = '';
    if (options.onDecision) options.onDecision({ outcome, proposal: slug, source, open, review });
  });
  scope.on('proposal:failed', ({ message }) => { if (options.onError) options.onError({ kind: 'proposal', message }); });

  const held = {
    /** Takes the keys that changed; returns a promise of whether the proposal opened, when a name was fetched */
    update(next = {}) {
      if (ended) return undefined;
      let asked = false;
      if ('source' in next && (next.source || null) !== current.source) { current.source = next.source || null; asked = true; }
      if ('proposal' in next && (next.proposal ?? null) !== current.proposal) { current.proposal = next.proposal ?? null; current.shown = null; asked = true; }
      if ('view' in next && PROPOSAL_VIEWS.includes(next.view) && next.view !== current.view) {
        current.view = next.view;
        if (state.proposal && !asked) setProposalView(inst, next.view, { quiet: true }); // a reviewer's own choice is the same value: nothing changes
      }
      return asked ? sync() : undefined;
    },
    sync,
    destroy() { if (ended) return; ended = true; scope.destroy(); },
  };
  held.update({ proposal: options.proposal, source: options.source, view: options.view });
  bindEdges();
  sync();
  return held;
}
