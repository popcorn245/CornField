/**
 * @module explorer/layers
 *
 * A bridge (spec 0011 D2 and D3, step 4): the layers are now the instance's (engine/layers.js) and the Layers menu is a piece
 * (pieces/layers.js). This file keeps the old names for the modules that are not yet on an instance (check.js, forge-panel.js, house.js, live.js,
 * proposal.js, review-column.js, scenario-ui.js, view.js, page.js), bound to the page's instance, and tells the piece when the theme changes
 * (theme.js is not on an instance). It goes when the last of those callers is converted.
 */

import { pageInstance } from './state.js';
import { pageMap } from './render.js';
import { onThemeChange } from './theme.js';
import { ensurePagePieces, pagePiece } from './page-pieces.js';
import * as L from './engine/layers.js';

export { LAYER_DEFS } from './engine/layers.js';

/** The page's instance, with its map and its pieces there: what the layers act on */
const page = () => { pageMap(); ensurePagePieces(); return pageInstance(); };

/** Calls `fn` after a layer goes on or off (live.js starts or stops the live layer). Returns how to stop. */
export const onLayersChange = (fn) => L.onLayersChange(pageInstance(), fn);

export const toggleLegendMenu = () => { const p = pagePiece('layers'); if (p) p.toggleMenu(); };
export const closeLegendMenu = () => { const p = pagePiece('layers'); if (p) p.closeMenu(); };

/**
 * A click anywhere on the page: runs its action (`act`), then closes the Layers menu if the click was outside it. Whether it was inside is
 * read BEFORE the action: a row's action draws the rows again, the clicked node is then out of the page, and asking afterwards would take a
 * click on a row for a click outside the menu.
 * @param {EventTarget | null} target the click's target
 * @param {() => void} act
 */
export function clickWithLegendMenu(target, act) {
  const inst = pageInstance();
  const menu = inst.el('legend-dropdown');
  const btn = inst.el('legend-toggle-btn');
  const inside = !!menu && target instanceof Node && (menu.contains(target) || (!!btn && btn.contains(target)));
  act();
  if (menu && !menu.hidden && !inside) closeLegendMenu();
}

export const renderLayerToggles = () => L.redrawLayers(page());
export const renderEdgeKey = () => { const p = pagePiece('layers'); if (p) p.renderEdgeKey(); };
export const renderCloudLegend = () => { const p = pagePiece('layers'); if (p) p.renderCloudLegend(); };
export const setProjectLayers = (raw) => L.setProjectLayers(page(), raw);
export const setLayer = (key, on, opts) => L.setLayer(page(), key, on, opts);
export const toggleLayer = (key, opts) => L.toggleLayer(page(), key, opts);
export const toggleAllLayers = (on, opts) => L.toggleAllLayers(page(), on, opts);
export const beginReview = () => L.beginReview(pageInstance());
export const endReview = () => L.endReview(page());
export const reviewLayersLine = () => L.reviewLayersLine(pageInstance());
export const setWholeMap = (on) => L.setWholeMap(page(), on);
export const clearStepLayers = () => L.clearStepLayers(page());
export const toggleLayerKinds = (key) => { const p = pagePiece('layers'); if (p) p.toggleKinds(key); };

// The dots and the legends are drawn in the theme's colours: the piece draws them again when it changes (theme.js)
onThemeChange(() => pageInstance().emit('theme'));
