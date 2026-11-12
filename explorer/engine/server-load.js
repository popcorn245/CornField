/**
 * @module explorer/engine/server-load
 *
 * The load from a cornfield server and its theme, on one instance (spec 0011 D6, D7): what a scope (pieces/scope.js) and a review with a `src`
 * (pieces/review-source.js) both start, written once. It makes the load (engine/source.js: the config and the map with the session, the states)
 * and the server's theme (engine/theme-sheet.js: its tokens on `host`, its rules for the shadow roots that adopt it, light or dark as the element's
 * `theme`, the page's `data-theme` or the system's say), and turns the instance's `source` and `theme` events into the callbacks a host hears.
 *
 *   const link = connectServer(inst, { host, tokens, version, pageUrl, theme: () => choice, useTheme: () => on, onConfig, onReady, onAuth, onError, onMode, onSheet })
 *     -> { source, theme, follow, setUseTheme(on), destroy }
 *
 * `onReady()` the load is ready (each time it is); `onAuth({ status, signIn })` a sign-in is needed; `onError({ kind, message })` a state that is a
 * failure (engine/source.js `errorOf`) or a theme that failed (`theme`); `onMode()` the light or dark the tokens are for changed; `onSheet(detail)` the
 * theme's sheet came, went or failed (the instance's `theme` event). Ends with `destroy()`.
 */

import { createSource, errorOf } from './source.js';
import { createServerTheme, modeOf, watchMode } from './theme-sheet.js';

/**
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst
 * @param {object} o see the top of this file
 */
export function connectServer(inst, o) {
  const call = (fn, ...args) => { if (!ended && typeof fn === 'function') fn(...args); };
  let ended = false;
  const theme = createServerTheme(inst, { defaults: o.tokens || '' });
  theme.tokensOn(o.host);
  const mode = () => modeOf(inst, o.theme());
  /** The element's choice, the page's or the system's light and dark changed: the tokens follow */
  const follow = () => { if (ended) return; theme.setMode(mode()); call(o.onMode); };
  const source = createSource(inst, {
    version: o.version || '',
    pageUrl: o.pageUrl,
    onConfig: (config) => { call(o.onConfig, config); if (!ended && o.useTheme()) theme.load(config); },
  });
  const offs = [
    inst.on('source', (detail) => {
      if (detail.state === 'ready') { call(o.onReady); return; }
      if (detail.state === 'sign-in') { call(o.onAuth, { status: detail.status, signIn: detail.signIn }); return; }
      const error = errorOf(detail);
      if (error) call(o.onError, error);
    }),
    inst.on('theme', (detail) => {
      call(o.onSheet, detail);
      if (detail.state === 'failed') call(o.onError, { kind: 'theme', message: detail.reason });
    }),
  ];
  watchMode(inst, follow);
  theme.setMode(mode());
  return {
    source,
    theme,
    follow,
    /** The server's theme on or off */
    setUseTheme(on) { if (ended) return; if (on) { if (source.config) theme.load(source.config); } else theme.unload(); },
    destroy() {
      if (ended) return;
      ended = true;
      offs.forEach((off) => off());
      theme.destroy();
    },
  };
}
