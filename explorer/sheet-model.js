/**
 * @module explorer/sheet-model
 *
 * The state machine of the phone's bottom sheets (TOPO-18, spec 0010 D7), with no DOM: which sheets exist, which are open, and which one is
 * expanded. sheets.js puts this on the page.
 *
 *  - Every sheet starts as a **peek** (a handle and a line or two). At most one is **expanded**; expanding one folds the sheets of the *other*
 *    group to a **stub** (one 44px row with a title and a badge). Tapping a stub expands it, and the one that was expanded becomes the stub.
 *  - **At most two sheets are open**: the *review* (the proposal bar, or the scenario player) and one *other* (Work, or the node panel).
 *    Opening Work displaces the node panel, and the reverse (`show` says which sheets it displaced); the node stays selected.
 *  - **The map keeps at least 35% of the screen** in every state (`sheetCap`): an expanded sheet's height is capped to leave it.
 */

/** The map keeps at least this share of the screen's height (spec 0010 D7) */
export const MAP_FLOOR = 0.35;
/** The height of a stub, in px: a row a thumb can hit */
export const STUB_PX = 44;

/** The groups: the sheets of the review, and the one other sheet (open one at a time) */
export const SHEET_GROUPS = Object.freeze({ proposal: 'review', player: 'review', forge: 'other', drawer: 'other' });
/** Groups that hold one open sheet at most: opening one displaces the other */
const EXCLUSIVE = new Set(['other']);

/** The tallest an expanded sheet may be, in px, for a screen `viewportPx` tall with `stubs` stubs under or over it: the rest is the map's 35% */
export const sheetCap = (viewportPx, stubs = 0) => Math.max(0, Math.floor(viewportPx - Math.ceil(viewportPx * MAP_FLOOR) - stubs * STUB_PX));

/** The map's smallest share of the screen, in px, for a screen `viewportPx` tall */
export const mapFloorPx = (viewportPx) => Math.ceil(viewportPx * MAP_FLOOR);

/**
 * @param {Record<string, string>} [groups] the group of each sheet id (a sheet not named is its own group)
 * @returns {{
 *   add(id: string): void, remove(id: string): void, has(id: string): boolean,
 *   show(id: string): string[], hide(id: string): void, isShown(id: string): boolean, shown(): string[],
 *   expand(id: string): boolean, collapse(id: string): boolean, collapseAll(): boolean, toggle(id: string): boolean,
 *   isExpanded(id: string): boolean, expanded(): string|null, stateOf(id: string): 'expanded'|'peek'|'stub'|'hidden'|undefined, stubs(): number, ids(): string[],
 * }} every change method answers whether anything changed (`show`: the ids it displaced)
 */
export function createSheetModel(groups = SHEET_GROUPS) {
  const known = new Set();
  const open = new Set(); // the sheets that are open (a sheet is open from `add` until `hide`)
  let expandedId = null;
  const groupOf = (id) => groups[id] || id;
  return {
    add: (id) => { known.add(id); open.add(id); },
    remove: (id) => { known.delete(id); open.delete(id); if (expandedId === id) expandedId = null; },
    has: (id) => known.has(id),
    /** Opens a sheet. In an exclusive group the other open sheet is displaced (closed): its id is returned */
    show(id) {
      if (!known.has(id)) return [];
      open.add(id);
      if (!EXCLUSIVE.has(groupOf(id))) return [];
      const gone = [...open].filter((o) => o !== id && groupOf(o) === groupOf(id));
      for (const g of gone) { open.delete(g); if (expandedId === g) expandedId = null; }
      return gone;
    },
    hide(id) { open.delete(id); if (expandedId === id) expandedId = null; },
    isShown: (id) => open.has(id),
    shown: () => [...open],
    expand(id) {
      if (!known.has(id) || !open.has(id) || expandedId === id) return false;
      expandedId = id;
      return true;
    },
    collapse(id) {
      if (expandedId !== id) return false;
      expandedId = null;
      return true;
    },
    collapseAll() {
      if (expandedId === null) return false;
      expandedId = null;
      return true;
    },
    toggle(id) {
      if (!known.has(id) || !open.has(id)) return false;
      expandedId = expandedId === id ? null : id;
      return true;
    },
    isExpanded: (id) => expandedId === id,
    expanded: () => expandedId,
    /** `stub` for an open sheet of the other group while one is expanded; `peek` otherwise; undefined for a sheet that is not known */
    stateOf(id) {
      if (!known.has(id)) return undefined;
      if (!open.has(id)) return 'hidden';
      if (expandedId === id) return 'expanded';
      return expandedId !== null && groupOf(expandedId) !== groupOf(id) ? 'stub' : 'peek';
    },
    /** How many stubs there are now */
    stubs() {
      return [...open].filter((id) => expandedId !== null && id !== expandedId && groupOf(id) !== groupOf(expandedId)).length;
    },
    ids: () => [...known],
  };
}
