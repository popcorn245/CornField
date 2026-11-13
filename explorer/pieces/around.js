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
 *             while there is no map: `needsMap`, or the panel's own empty state), onSearch ({ query, current }, the instance's `search` event)
 *
 * What it does so that three roots can share one instance:
 *   - the root joins the instance (`joinRoot`, engine/roots.js): its keys and its focus are the instance's, so `/` pressed on the map reaches the search and a click in the
 *     host's page outside the Layers menu closes it;
 *   - the server's theme is adopted into the root (`use-theme` on the scope), after the tag's own styles;
 *   - the piece mounts when the instance has a map with nodes (`map:ready`, then the `scene` its data brings) and ends when it has none (`map:gone`): the
 *     pieces read the map's camera, scene and visibility, so with none they say what they need in its place (`needsMap`), and while the map waits on its
 *     server (loading, signed out, offline: the map's own card says which) that they wait for it (`waitingForMap`). Tags can come in any order;
 *   - it has a live region of its own, said in only when no map has one (`announce:fallback`): a panel or a search beside no map still speaks.
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
 * @param {{ tokens?: string, piece?: object, initial?: object, noMap?: string, onSearch?: (d: { query: string, current: string | null }) => void }} [options]
 */
export function mountAround(piece, root, inst, options = {}) {
  const ownsInstance = !inst;
  if (ownsInstance) inst = createInstance({ root });
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

  let real = null;
  let note = [];
  let pending = { ...(options.initial || {}) };
  let ended = false;

  const dropNote = () => { for (const el of note) el.remove(); note = []; };
  /** The map is there and has nodes: a map still loading, refused by its server (signed out, not a maintainer) or offline has none, and a search or a
   * Layers menu over nothing would say "No match" or count layers of a map nobody can see. The map's own card says what is wrong, once */
  const hasMap = () => !!inst.map && inst.state.nodes.length > 0;
  const showNote = (gone = false) => {
    if (ended) return;
    const words = !info ? t(inst, 'needsScope') : options.noMap === 'nodePanelEmpty' ? t(inst, 'nodePanelEmpty') : inst.map && !gone ? t(inst, 'waitingForMap') : t(inst, 'needsMap');
    if (note.length && note[0].textContent === words) return;
    dropNote();
    note = place(inst, root, `<p class="hx-needs" data-corn="empty">${escapeHtml(words)}</p>`, null, 'needs');
  };
  const mountReal = () => {
    if (real || ended) return;
    if (!hasMap()) { showNote(); return; }
    dropNote();
    real = piece.mount(root, inst, { ...(options.piece || {}), inline: true, phone: false });
    if (Object.keys(pending).length) { real.update(pending); pending = {}; }
  };
  const unmountReal = () => { if (real) { real.destroy(); real = null; } };

  scope.on('map:ready', mountReal);
  scope.on('scene', () => { if (!real) mountReal(); }); // the map's data came (its server answered, or the host handed it in)
  scope.on('map:gone', () => { unmountReal(); showNote(true); }); // (said while the map ends: the instance may still hold it)
  if (options.onSearch) scope.on('search', (d) => options.onSearch(d));
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
      scope.destroy();
      if (ownsInstance) inst.destroy();
    },
  };
}
