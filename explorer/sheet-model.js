/**
 * @module explorer/sheet-model
 *
 * The state machine of the phone's bottom sheets (TOPO-18), with no DOM: which sheets exist,
 * and which one is expanded. Every sheet starts as a peek (a handle and a line or two). At most one
 * is expanded at a time: expanding one collapses the others. sheets.js puts this on the page.
 */

/**
 * @returns {{
 *   add(id: string): void, remove(id: string): void, has(id: string): boolean,
 *   expand(id: string): boolean, collapse(id: string): boolean, collapseAll(): boolean, toggle(id: string): boolean,
 *   isExpanded(id: string): boolean, expanded(): string|null, ids(): string[],
 * }} every change method answers whether anything changed
 */
export function createSheetModel() {
  const known = new Set();
  let open = null;
  return {
    add: (id) => { known.add(id); },
    remove: (id) => { known.delete(id); if (open === id) open = null; },
    has: (id) => known.has(id),
    expand(id) {
      if (!known.has(id) || open === id) return false;
      open = id;
      return true;
    },
    collapse(id) {
      if (open !== id) return false;
      open = null;
      return true;
    },
    collapseAll() {
      if (open === null) return false;
      open = null;
      return true;
    },
    toggle(id) {
      if (!known.has(id)) return false;
      open = open === id ? null : id;
      return true;
    },
    isExpanded: (id) => open === id,
    expanded: () => open,
    ids: () => [...known],
  };
}
