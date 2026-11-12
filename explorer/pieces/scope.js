/**
 * @module explorer/pieces/scope
 *
 * What the pieces inside a `<corn-scope>` share (spec 0011 D5): one instance (one selection, one camera, one topology), and where its data comes
 * from. A scope shows nothing of its own and has no shadow root; its element is only the place the instance is rooted and the tokens (and, with
 * `use-theme`, the server's) are set, which every piece inside inherits.
 *
 *   const scope = mountScope(host, options)    -> { update, destroy, instance, source }   (the `<corn-scope>` component calls it)
 *   const join = joinScope(el, onChange)       -> { inst, scope, leave }                  (a piece's shell calls it for the scope around it, if any;
 *                                                                                          it lives in pieces/scope-link.js, so a map alone does not load this module)
 *
 * HOW A PIECE FINDS ITS SCOPE. A piece dispatches `corn-scope-request`, a composed, bubbling event, from its own element when it connects. The
 * nearest scope above it hears it (it crosses every shadow root between them, which `closest()` cannot), answers by handing over a handle (the
 * instance) and stops the event, so a scope inside a scope is the nearer one's. A piece that hears no answer makes a private instance, as
 * `<corn-map>` alone always did. Three things change the answer, and each is the same message in the other direction, `corn-scope-changed`,
 * dispatched at the piece's own element (it does not bubble), after which the piece asks again:
 *
 *   a scope whose `src` changes   a new instance for the new server (the address is the instance's base and does not change): the scope makes
 *                                 it, tells every piece it holds, and ends the old one once they have left it
 *   a scope removed from the page its pieces are told and ask again (to a scope further up, or to none)
 *   a scope added around pieces   the scope walks its descendants (the light tree and the open shadow roots of other elements) and tells each `corn-`
 *   that are already there        piece it finds; a piece that connected before its scope was defined asks again and is answered
 *
 * Pieces in a closed shadow root of someone else's component cannot be found by the walk. A piece that is removed leaves (its shell calls `leave`).
 * A second map in a scope is refused (the engine holds one map per instance); when the map that has the scope leaves, the first refused map that
 * is still in the page is told to ask again, and takes it.
 *
 * It reads no `location`: the page's address is a function the shell passes in (`pageUrl`), used for the sign-in's way back and to name the
 * origin a "not listed" message asks the server to list. It never navigates the window.
 */

import { createInstance } from '../instance.js';
import { adoptDefaultTokens } from './adopt-tokens.js';
import { parseSource } from '../engine/source.js';
import { connectServer } from '../engine/server-load.js';
import { keepLayersIn } from '../engine/layers.js';
import { mount as mountStatus } from './status.js';
import { CHANGED, REQUEST, infoOf } from './scope-link.js';

export { REQUEST, CHANGED, joinScope, scopeInfo } from './scope-link.js';
/** The theme choices of a scope (and of a map) */
const THEMES = ['light', 'dark', 'auto'];


/**
 * @param {Element} host the `<corn-scope>` element
 * @param {object} [options]
 * @param {string} [options.src] the base address of a cornfield server
 * @param {'light'|'dark'|'auto'} [options.theme]
 * @param {boolean} [options.useTheme] use the server's theme (fetch `theme.css`, adopt it into every piece, copy its tokens here)
 * @param {object | null} [options.topology] @param {object | null} [options.config] @param {object | null} [options.strings]  handed in by a host that fetches for itself
 * @param {string} [options.tokens] the default `--corn-*` tokens (CSS text), added once to the document
 * @param {string} [options.version] the package's version, compared with the server's
 * @param {() => string} [options.pageUrl] the page's address
 * @param {(detail: { status: number, signIn: string }) => void} [options.onAuth] the server wants a sign-in
 * @param {(detail: { kind: 'not-listed' | 'offline' | 'server' | 'address' | 'version' | 'theme' | 'second-map', message?: string }) => void} [options.onError]
 * @param {() => void} [options.onReady] the scope has its data (loaded, or handed in)
 */
export function mountScope(host, options = {}) {
  const props = { src: options.src, theme: options.theme, useTheme: !!options.useTheme, topology: options.topology, config: options.config, strings: options.strings };
  const pageUrl = options.pageUrl || (() => '');
  /** The pieces that took this scope's answer, by their element: what is told when the instance changes */
  const handles = new Set();
  let inst = null;
  let source = null;
  let serverTheme = null;
  /** The load and the theme of the instance (engine/server-load.js) */
  let serverLink = null;
  let readyFired = false;
  let ended = false;

  // -- the answer to a piece ---------------------------------------------------------------------------------------------------------------
  const answer = (event) => {
    if (ended || !inst || !event.detail || typeof event.detail.claim !== 'function') return;
    event.stopPropagation(); // the nearest scope answers, and no other
    const handle = {
      el: event.detail.el,
      inst,
      scope: api,
      release: () => handles.delete(handle),
    };
    handles.add(handle);
    event.detail.claim(handle);
  };
  host.addEventListener(REQUEST, answer);

  /** Tells every piece this scope has handed the instance to, and every `corn-` piece below it that has not asked, to ask again (once each) */
  function tellPieces() {
    const told = new Set(piecesBelow(host));
    for (const h of [...handles]) { handles.delete(h); if (h.el) told.add(h.el); }
    for (const el of told) if (el.isConnected !== false) el.dispatchEvent(new Event(CHANGED));
  }

  // -- the mode (light or dark) the server's tokens are for ------------------------------------------------------------------------------
  /** The scope's `theme` changed: the tokens follow (the page's own light and dark, and the system's, the link follows by itself) */
  function followMode() {
    if (serverLink) serverLink.follow();
  }

  // -- one instance per server ---------------------------------------------------------------------------------------------------------------
  function build() {
    const parsed = props.src === undefined || props.src === null || props.src === '' ? null : parseSource(props.src);
    inst = createInstance({ root: host, base: parsed && parsed.ok ? parsed.base : '' });
    keepLayersIn(inst, null); // a map in another app's page keeps nothing in that page's storage
    const info = infoOf(inst);
    info.host = host;
    info.theme = THEMES.includes(props.theme) ? props.theme : 'auto';
    const mine = inst;
    // The load and the server's theme, as a review with a src starts them (engine/server-load.js): the theme's tokens onto the scope's element
    const link = connectServer(inst, {
      host, tokens: options.tokens, version: options.version, pageUrl,
      theme: () => (THEMES.includes(props.theme) ? props.theme : 'auto'), useTheme: () => props.useTheme,
      onReady: () => { if (!readyFired && inst === mine) { readyFired = true; if (options.onReady) options.onReady(); } },
      onAuth: (detail) => { if (options.onAuth) options.onAuth(detail); },
      onError: (error) => { if (options.onError) options.onError(error); },
      onMode: () => mine.emit('scope:theme'),
    });
    serverLink = link;
    const st = link.theme;
    serverTheme = st;
    info.serverTheme = st;
    inst.own(() => link.destroy());
    source = link.source;
    info.source = source;
    info.mountStatus = mountStatus;
    readyFired = false;
    // A second map waits: when the one that has the instance's root gives it back, the first that waits and is still in the page asks again
    // (after the leaving map has finished ending, so the two never hold the instance's state at once)
    const waiting = [];
    inst.on('piece:refused', (d) => {
      if (d.host && !waiting.includes(d.host)) waiting.push(d.host);
      if (options.onError) options.onError({ kind: d.reason, message: d.message });
    });
    inst.on('attach:released', () => {
      Promise.resolve().then(() => {
        if (ended || inst !== mine) return;
        while (waiting.length) {
          const el = waiting.shift();
          if (el.isConnected) { el.dispatchEvent(new Event(CHANGED)); return; }
        }
      });
    });
    if (parsed && !parsed.ok) source.say({ state: 'address', problem: parsed.problem });
    source.provide({ topology: props.topology || undefined, config: props.config || undefined, strings: props.strings || undefined });
    if (parsed && parsed.ok) source.load();
  }

  function release() {
    tellPieces(); // they leave this instance (and ask again) before it ends
    if (inst) inst.destroy();
    inst = null;
    source = null;
    serverTheme = null;
    serverLink = null;
  }

  const api = {
    /** Applies the properties that changed (only the keys present are looked at) */
    update(next = {}) {
      if (ended) return;
      let rebuild = false;
      if ('src' in next && next.src !== props.src) { props.src = next.src; rebuild = true; }
      if ('theme' in next && next.theme !== props.theme) {
        props.theme = next.theme;
        infoOf(inst).theme = THEMES.includes(props.theme) ? props.theme : 'auto';
        followMode();
      }
      if ('useTheme' in next && !!next.useTheme !== props.useTheme) {
        props.useTheme = !!next.useTheme;
        serverLink.setUseTheme(props.useTheme);
      }
      if (rebuild) {
        // The new instance is made first, the pieces are told to take it, and the old one ends once they have gone
        const previous = inst;
        serverLink.destroy(); // its theme's tokens leave this element before the new server's are put on it, and its load says nothing more
        build();
        tellPieces();
        previous.destroy();
        return;
      }
      const hand = {};
      for (const key of ['topology', 'config', 'strings']) if (key in next && next[key] !== props[key]) { props[key] = next[key]; hand[key] = next[key] === undefined ? null : next[key]; }
      if (Object.keys(hand).length) source.provide(hand);
    },
    destroy() {
      if (ended) return;
      host.removeEventListener(REQUEST, answer);
      release();
      ended = true;
      handles.clear();
    },
    /** The instance now in force (a new one after `src` changes) */
    get instance() { return inst; },
    get source() { return source; },
  };
  // The page: the default tokens, a first instance, and the pieces already below it (a scope put around pieces that are already there)
  if (options.tokens) adoptDefaultTokens(host.getRootNode(), options.tokens);
  build();
  tellPieces();
  return api;
}

/** The `corn-` elements below `root`: its light tree and the open shadow roots of other elements, not into a scope of their own */
function piecesBelow(root) {
  const out = [];
  const walk = (node) => {
    for (const el of node.children || []) {
      const tag = el.localName || '';
      if (tag.startsWith('corn-')) { if (tag === 'corn-scope') continue; out.push(el); }
      if (el.shadowRoot) walk(el.shadowRoot);
      walk(el);
    }
  };
  walk(root);
  return out;
}
