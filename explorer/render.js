/**
 * @module explorer/render
 *
 * A bridge (spec 0011 D2, step 1): the map's camera, scene cache and frame loop now live in engine/render.js, one per instance
 * (`createMap(inst)`). This file keeps the old names for the modules that are not yet on an instance, bound to the page's instance, so
 * `import { render, fitGraphToViewport } from './render.js'` works as it did. The page's map is made by page.js (or, for a module driven
 * on its own in a test, on first use here). A module that is converted takes `inst` and calls `inst.map.render()` instead.
 */

import { pageInstance } from './state.js';
import { createMap } from './engine/render.js';
import { measureCovered } from './sheets.js';

/** The page instance's map: made on first use when page.js has not made it */
export const pageMap = () => {
  const inst = pageInstance();
  return inst.map || createMap(inst, { measureCovered });
};

export const isNodeVisible = (node) => pageMap().isNodeVisible(node);
export const isNodeVisibleToViewer = (node) => pageMap().isNodeVisibleToViewer(node);
export const getActiveSubgraph = (...args) => pageMap().getActiveSubgraph(...args);
export const getScene = () => pageMap().getScene();
export const sceneBuilds = () => pageMap().sceneBuilds();
export const getSpatialIndex = () => pageMap().getSpatialIndex();
export const spatialBuilds = () => pageMap().spatialBuilds();
export const getRenderer = () => pageMap().getRenderer();
export const setRenderer = (next) => pageMap().setRenderer(next);
export const resize = () => pageMap().resize();
export const getMinZoom = () => pageMap().getMinZoom();
export const fitGraphToViewport = (padding, only) => pageMap().fitGraphToViewport(padding, only);
export const fitPadding = () => pageMap().fitPadding();
export const screenToWorld = (x, y) => pageMap().screenToWorld(x, y);
export const labelNodeAt = (x, y) => pageMap().labelNodeAt(x, y);
export const setHoverNode = (id) => pageMap().setHoverNode(id);
export const onPaint = (fn) => pageMap().onPaint(fn);
export const render = () => pageMap().render();
export const renderNow = () => pageMap().renderNow();
export const addFrameClient = (client) => pageMap().addFrameClient(client);
export const queueFrameWork = (job, opts) => pageMap().queueFrameWork(job, opts);
export const frameStats = () => pageMap().frameStats();
export const holdFrames = (on) => pageMap().holdFrames(on);
export const cancelFrame = () => pageMap().cancelFrame();
export const ensureFlowLoop = () => pageMap().ensureFlowLoop();
