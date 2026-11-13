/**
 * @module explorer/pieces/around
 *
 * The pieces around the map (node panel, Layers menu, search) as a component mounts them (spec 0011 D4, D5, D7): each in a shadow root of its own, on the
 * instance of the `<corn-scope>` it sits in, beside a `<corn-map>` that has a root of its own too. This is what a shell of those tags calls; cornfield's page
 * and `<corn-review>` mount the same pieces themselves, in one root, and do not use it.
 *
 *   const around = mountAround(piece, root, inst, options)    -> { inst, update, destroy, focusField }
 *
 *   piece     the piece's module (`explorer/pieces/node-panel.js`, `layers.js`, `search.js`): its `mount(root, inst, options)`
 *   root      the shadow root of the tag
 *   inst      the scope's instance, or null: no scope around the tag, so a private instance with no map, which this says (`needsScope`)
 *   options   tokens (the default `--corn-*` CSS text), piece (the options the piece is mounted with), initial (its first `update`), noMap (the `strings` key said
 *             while there is no map: `needsMap`, or the panel's own empty state), onSearch ({ query, current }, the instance's `search` event),
 *             exclusive (a name: the piece holds state of its own, so a scope holds one of it; see below), signIn ({ during: string[], clear: string }: the instance's
 *             `auth` events whose `during` is listed put the scope's sign-in card in this tag's own root, and the event `clear` takes it away)
 *
 * What it does so that three roots can share one instance:
 *   - the root joins the instance (`joinRoot`, engine/roots.js): its keys and its focus are the instance's, so `/` pressed on the map reaches the search and a click in the
 *     host's page outside the Layers menu closes it;
 *   - the server's theme is adopted into the root (`use-theme` on the scope), after the tag's own styles;
 *   - the piece mounts when the instance has a map with nodes (`map:ready`, then the `scene` its data brings) and ends when it has none (`map:gone`): the
 *     pieces read the map's camera, scene and visibility, so with none they say what they need in its place (`needsMap`), and while the map waits on its
 *     server (loading, signed out, offline: the map's own card says which) that they wait for it (`waitingForMap`). Tags can come in any order;
 *   - it has a live region of its own, said in only when no map has one (`announce:fallback`): a panel or a search beside no map still speaks;
 *   - an `exclusive` piece (the proposal's bar, the change list with its player, the decision) is one per scope: each has a state of its own (a hold, a
 *     note, a playing scenario, a line that is said once), which two could not share. The first to join holds the name; a second says `secondPiece` in its own
 *     place, tells the scope (`piece:refused`, which is `cornError` `second-piece`), and takes over when the first leaves.
 * Nothing here reads the page: no `document`, no id of a neighbour. It never throws for a missing scope or map.
 */

import { createInstance } from '../instance.js';
import { scopeOf, place } from '../engine/piece.js';
import { joinRoot } from '../engine/roots.js';
import { speaker } from '../engine/keyboard.js';
import { t } from '../engine/strings.js';
import { escapeHtml } from '../../core/text.js';
import { adoptDefaultTokens } from './adopt-tokens.js';
import { scopeInfo } from './scope-link.js';

/** The document, and the shadow root the tag's host sits in if it is in one: where the default tokens go (as pieces/map.js does) */
function adoptTokens(root, css) {
  const host = root.nodeType === 11 ? root.host : root;
  const where = host && typeof host.getRootNode === 'function' ? host.getRootNode() : null;
  if (!where || !css) return;
  adoptDefaultTokens(where.nodeType === 9 ? where : where.ownerDocument, css);
  if (where.nodeType === 11) adoptDefaultTokens(where, css);
}

/**
 * @param {{ mount: Function }} piece
 * @param {ShadowRoot|Element} root
 * @param {ReturnType<typeof createInstance>|null} inst
 * @param {{ tokens?: string, piece?: object, initial?: object, noMap?: string, onSearch?: (d: { query: string, current: string | null }) => void, exclusive?: string, signIn?: { during: string[], clear: string } }} [options]
 */
export function mountAround(piece, root, inst, options = {}) {
  const ownsInstance = !inst;
  if (ownsInstance) inst = createInstance({ root });
  const exclusive = typeof options.exclusive === 'string' ? options.exclusive : '';
  const info = scopeInfo(inst);
  const scope = scopeOf(inst);
  adoptTokens(root, options.tokens);
  scope.own(joinRoot(inst, root));
  if (info && info.serverTheme) scope.own(info.serverTheme.adopt(root));
  // A live region for the words this piece says when no map is there to say them
  const [region] = place(inst, root, '<p class="hx-sr-only" role="status" aria-live="polite"></p>', null, 'announcer');
  const say = speaker(inst, region);
  scope.on('announce:fallback', (text) => { say(text); return true; });
  scope.own(() => region.remove());

  /** Who holds each exclusive name in this instance (this call is the token) */
  const holders = exclusive ? inst.slot('exclusive', () => new Map()) : null;
  const token = {};
  const second = () => !!holders && holders.has(exclusive) && holders.get(exclusive) !== token;
  const takeName = () => { if (!holders) return true; if (second()) return false; holders.set(exclusive, token); return true; };
  let real = null;
  let note = [];
  let told = false;
  let pending = { ...(options.initial || {}) };
  let ended = false;

  const dropNote = () => { for (const el of note) el.remove(); note = []; };
  /** The map is there and has nodes: a map still loading, refused by its server (signed out, not a maintainer) or offline has none, and a search or a
   * Layers menu over nothing would say "No match" or count layers of a map nobody can see. The map's own card says what is wrong, once */
  const hasMap = () => !!inst.map && inst.state.nodes.length > 0;
  const showNote = (gone = false) => {
    if (ended) return;
    const words = second() ? t(inst, 'secondPiece') : !info ? t(inst, 'needsScope') : options.noMap === 'nodePanelEmpty' ? t(inst, 'nodePanelEmpty') : inst.map && !gone ? t(inst, 'waitingForMap') : t(inst, 'needsMap');
    if (note.length && note[0].textContent === words) return;
    dropNote();
    note = place(inst, root, `<p class="hx-needs" data-corn="empty">${escapeHtml(words)}</p>`, null, 'needs');
  };
  const mountReal = () => {
    if (real || ended) return;
    if (!takeName()) {
      showNote();
      if (!told) { told = true; inst.emit('piece:refused', { piece: exclusive, reason: 'second-piece', message: `A scope holds one ${exclusive}.` }); }
      return;
    }
    if (!hasMap()) { showNote(); return; }
    dropNote();
    real = piece.mount(root, inst, { ...(options.piece || {}), inline: true, phone: false });
    if (Object.keys(pending).length) { real.update(pending); pending = {}; }
  };
  const unmountReal = () => { if (real) { real.destroy(); real = null; } };

  scope.on('map:ready', mountReal);
  scope.on('exclusive:released', (d) => { if (d && d.name === exclusive) mountReal(); }); // the one that held the name left: this one may have it
  scope.on('scene', () => { if (!real) mountReal(); }); // the map's data came (its server answered, or the host handed it in)
  scope.on('map:gone', () => { unmountReal(); showNote(true); }); // (said while the map ends: the instance may still hold it)
  if (options.onSearch) scope.on('search', (d) => options.onSearch(d));
  // A refusal for want of a sign-in, said where the person is working (the scope says it once to the host: `cornAuth`)
  if (options.signIn && info && info.mountStatus) {
    const [slot] = place(inst, root, '<div class="hx-signin-slot"></div>', null, 'signin');
    const card = info.mountStatus(slot, inst, { follow: false });
    scope.on('auth', ({ status, during }) => { if (options.signIn.during.includes(during)) card.show({ state: 'sign-in', status, signIn: info.signIn() }); });
    scope.on(options.signIn.clear, () => card.clear());
    scope.own(() => { card.destroy(); slot.remove(); });
  }
  mountReal();

  return {
    inst,
    /** Takes the properties that changed; one that arrives before the piece is mounted is applied when it is */
    update(next = {}) {
      if (ended) return;
      if (real) real.update(next); else Object.assign(pending, next);
    },
    /** The search's field takes the focus (nothing when the piece is not mounted, or is not a search) */
    focusField() { if (real && typeof real.focusField === 'function') real.focusField(); },
    destroy() {
      if (ended) return;
      ended = true;
      unmountReal();
      dropNote();
      const held = holders && holders.get(exclusive) === token;
      if (held) holders.delete(exclusive);
      scope.destroy();
      if (held && !inst.ended) inst.emit('exclusive:released', { name: exclusive });
      if (ownsInstance) inst.destroy();
    },
  };
}
