/**
 * @module explorer/renderer
 *
 * Chooses the renderer for the map canvas (spec 0012 A2): WebGL2 when the canvas gives a WebGL2
 * context and the address does not say `?renderer=canvas2d`, otherwise the Canvas 2D reference
 * renderer. main.js hands the result to render.js `setRenderer`.
 *
 * HOW THE MAP IS LAYERED
 *
 *   .hx-stage
 *     #graph-canvas   WebGL2: grid, lane bands, rings, edges (lines, arrowheads,   (renderer-webgl.js)
 *                     packets), nodes. Canvas 2D draws the same on it when WebGL2
 *                     is missing or `?renderer=canvas2d`.                           (renderer-canvas2d.js)
 *     #label-canvas   transparent Canvas 2D stacked over it: ALL the text, that is  (labels.js)
 *                     node labels, lane titles and edge labels, for either renderer
 *
 * Neither renderer draws text; the label layer (labels.js, owned by render.js) is the only thing that
 * does, and it covers the edge labels under the nodes itself. Both canvases have `pointer-events:
 * none` except #graph-canvas, the element input.js listens on.
 *
 * Fallbacks. No WebGL2 context: the Canvas 2D renderer draws on the canvas itself. A context that
 * exists but whose shaders fail to compile or link: one console.warn, and the Canvas 2D renderer
 * draws on a stand-in canvas stacked over the map canvas (a canvas that has given a WebGL context
 * can never give a 2d one); the WebGL canvas underneath stays empty.
 */

import { createCanvas2dRenderer } from './renderer-canvas2d.js';
import { CONTEXT_ATTRS, createWebglRenderer } from './renderer-webgl.js';

/**
 * `?renderer=canvas2d` forces the reference renderer, `?renderer=webgl2` asks for the GPU one
 * @param {string} search a location.search
 * @returns {'canvas2d'|'webgl2'|null}
 */
export function rendererPreference(search) {
  const value = new URLSearchParams(search || '').get('renderer');
  return value === 'canvas2d' || value === 'webgl2' ? value : null;
}

/** A transparent canvas stacked right over `canvas`; CSS (`.hx-overlay`) sizes it and lets the pointer through */
function addStandIn(canvas) {
  const standIn = canvas.ownerDocument.createElement('canvas');
  standIn.className = 'hx-overlay';
  standIn.setAttribute('aria-hidden', 'true');
  canvas.after(standIn);
  return standIn;
}

/**
 * @param {HTMLCanvasElement} canvas the map canvas; it must not have a 2d context yet
 * @param {{prefer?: 'canvas2d'|'webgl2'|null, makeStandIn?: (canvas: HTMLCanvasElement) => HTMLCanvasElement}} [opts]
 *   `prefer`: default from the page's query string. `makeStandIn`: for tests.
 * @returns {import('./scene.js').Renderer}
 */
export function createRenderer(canvas, opts = {}) {
  const prefer = opts.prefer !== undefined ? opts.prefer : rendererPreference(globalThis.location && globalThis.location.search);
  if (prefer === 'canvas2d') return createCanvas2dRenderer(canvas);

  let gl = null;
  try { gl = canvas.getContext('webgl2', CONTEXT_ATTRS); } catch { /* treated as no WebGL2 */ }
  if (!gl) return createCanvas2dRenderer(canvas);

  try {
    return createWebglRenderer(canvas, { gl });
  } catch (err) {
    console.warn(`WebGL2 renderer unavailable, drawing with Canvas 2D: ${err.message}`);
    const standIn = (opts.makeStandIn || addStandIn)(canvas);
    const full = createCanvas2dRenderer(standIn);
    return { ...full, destroy() { full.destroy(); standIn.remove(); } };
  }
}
