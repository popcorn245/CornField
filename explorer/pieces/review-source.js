/**
 * @module explorer/pieces/review-source
 *
 * What a review with a `src` brings (spec 0011 D1, D5, D6, D7, D9): the load from a cornfield server and the states it shows, and the server's theme.
 * It is the review's own side of what pieces/scope.js does for a scope, on the review's own instance, started by the same function (engine/server-load.js
 * `connectServer`) and with the same engine: engine/source.js
 * reads `/cornfield/config.json` and `/topology.json` (`credentials: 'include'`, only to the base's origin), pieces/status.js shows where the load is in
 * the review's stage (the same card, words, hooks and parts a map with a `src` has), and engine/theme-sheet.js gives the server's theme to the review's
 * shadow root when asked. Nothing here is a second copy of loading.
 *
 * It is a chunk of its own (pieces/review.js imports it the first time a review has a `src`): a review that is handed its data never loads it.
 *
 *   const link = attachSource(inst, options)    -> { source, provide, setUseTheme, setTheme, showSignIn, clearSignIn, destroy }
 *
 * Options: `root` (the review's shadow root, or the element it is in) and `stage` (where the status card goes), `parsed` (engine/source-address.js
 * `parseSource` of `src`), `tokens` (the default tokens, for the theme's derived ones), `version`, `pageUrl`, `useTheme`, `theme` ('light' | 'dark' | 'auto'),
 * the host's `topology`, `config` and `strings` to hand in, and the callbacks the review gives: `onTopology(topology)` (it is there: read, or handed in),
 * `onConfig(config)` (the words, layers and the map's theme are applied: the review draws them again), `onAuth({ status, signIn, during })`,
 * `onError({ kind, message })`, `onMode()` (the tokens changed: the map reads them again) and `focusMap()`.
 */

import { connectServer } from '../engine/server-load.js';
import { mount as mountStatus } from './status.js';

/**
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst the review's own instance (its base is the server's)
 * @param {object} options see the top of this file
 */
export function attachSource(inst, options) {
  const { root, stage, parsed } = options;
  const host = root.nodeType === 11 ? /** @type {ShadowRoot} */ (root).host : root;
  let useTheme = !!options.useTheme;
  let choice = options.theme;
  let signInShown = false;
  let ended = false;

  // -- the load and the server's theme, as a scope starts them (engine/server-load.js): the theme's tokens onto the review's element -----------
  const link = connectServer(inst, {
    host, tokens: options.tokens, version: options.version, pageUrl: options.pageUrl,
    theme: () => choice, useTheme: () => useTheme,
    onConfig: (config) => options.onConfig(config),
    onReady: () => { signInShown = false; if (link.source.topology) options.onTopology(link.source.topology); },
    onAuth: ({ status, signIn }) => options.onAuth({ status, signIn, during: 'load' }),
    onError: (error) => options.onError(error),
    onMode: () => options.onMode(),
    onSheet: () => options.onMode(), // the sheet is in, or out: the map reads its tokens again
  });
  const { source } = link;
  const offs = [];
  // Its rules reach only this shadow root: never the document
  if (root.nodeType === 11) offs.push(link.theme.adopt(root));
  const status = mountStatus(stage, inst, { onRetry: () => source.load(), focusMap: options.focusMap });

  source.provide({ topology: options.topology || undefined, config: options.config || undefined, strings: options.strings || undefined });
  // After what the host handed in, so the card stays: a review with no server to ask cannot open a proposal or decide, whatever map it draws
  if (parsed && !parsed.ok) source.say({ state: 'address', problem: parsed.problem });
  else if (parsed) source.load();

  return {
    source,
    /** Takes what the host fetched for itself (a key that is `undefined` is left as it was, `null` takes the host's back: engine/source.js `provide`) */
    provide: (what) => source.provide(what),
    /** The server's theme on or off */
    setUseTheme(next) {
      next = !!next;
      if (next === useTheme) return;
      useTheme = next;
      link.setUseTheme(useTheme);
    },
    /** The review's `theme` choice changed: the tokens follow */
    setTheme(next) { choice = next; link.follow(); },
    /** A decision the server refused for want of a sign-in: the same card the load shows, with the server's sign-in */
    showSignIn(detail) { signInShown = true; status.show({ state: 'sign-in', status: detail.status, signIn: detail.signIn }); },
    /** The card a refused decision put up goes (a decision was taken, or another proposal opened): the load's own state, if it has one, stays */
    clearSignIn() { if (!signInShown) return; signInShown = false; status.clear(); },
    destroy() {
      if (ended) return;
      ended = true;
      offs.forEach((off) => off());
      status.destroy();
      link.destroy();
    },
  };
}
