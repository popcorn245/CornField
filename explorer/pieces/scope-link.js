/**
 * @module explorer/pieces/scope-link
 *
 * The part of the scope protocol (pieces/scope.js) a piece needs, and nothing of the scope itself: how a piece asks for the scope around it
 * (`joinScope`), the two event names, and what a scope's instance tells its pieces (`scopeInfo`). A map that never meets a scope or a `src` loads
 * only this; the loading, the states, the server's theme (pieces/scope.js, engine/source.js, pieces/status.js, engine/theme-sheet.js) come with
 * `<corn-scope>`, or the first time a map has a `src` (pieces/map.js imports them then, as a chunk of the package's own).
 *
 *   const join = joinScope(el, onChange)    -> { inst, scope, leave }   (a piece's shell calls it for the scope around it, if any)
 *   scopeInfo(inst)                         -> { theme, serverTheme, host, source, mountStatus, signIn } for a scope's instance, else null (`signIn()`: the server's sign-in, back to the page)
 */

export const REQUEST = 'corn-scope-request';
export const CHANGED = 'corn-scope-changed';

/** What a piece may ask a scope for, per instance: set when a scope makes the instance */
export const infoOf = (inst) => inst.slot('scope', () => ({ theme: 'auto', serverTheme: null, host: null, source: null, mountStatus: null, signIn: () => '' }));
/**
 * The scope's side of an instance, or null for a private one: its `theme`, its server theme (to adopt into a root), its element, its source (the
 * load: engine/source.js) and how a piece shows the load's states (pieces/status.js `mount`)
 */
export const scopeInfo = (inst) => {
  const info = infoOf(inst);
  return info.host ? info : null;
};

/**
 * A piece's side: asks for the scope around `el`. `onChange` runs when the answer may be different (a new instance, a scope gone or come): the
 * shell leaves, ends its piece and joins again. `inst` is null when no scope answered (the piece makes a private instance); `leave` is idempotent.
 * @param {Element} el
 * @param {() => void} onChange
 * @returns {{ inst: ReturnType<typeof import('../instance.js').createInstance> | null, scope: object | null, leave: () => void }}
 */
export function joinScope(el, onChange) {
  let handle = null;
  el.dispatchEvent(new CustomEvent(REQUEST, { bubbles: true, composed: true, detail: { el, claim: (h) => { handle = h; } } }));
  const changed = () => onChange();
  el.addEventListener(CHANGED, changed);
  let left = false;
  return {
    inst: handle ? handle.inst : null,
    scope: handle ? handle.scope : null,
    leave() {
      if (left) return;
      left = true;
      el.removeEventListener(CHANGED, changed);
      if (handle) handle.release();
    },
  };
}
