/**
 * @module explorer/input
 *
 * Mouse and touch on the canvas: pan, wheel and pinch zoom, tap a node to inspect it. In
 * freeform mode a drag moves a node (remembered between visits) and a double tap inspects it.
 * The data-flow preset has fixed lanes, so there a drag always pans.
 *
 * Which node is under the pointer is answered by the spatial grid (spatial.js, built once per
 * scene in render.js), not by scanning every node. Pointer moves are coalesced: an event only
 * stores where the pointer is, and the camera or the dragged node is updated once per animation
 * frame, just before that frame's one draw (render.js `queueFrameWork`). Zoom keeps the world
 * point under the pointer, or between two fingers, still (camera.js).
 */

import { state, touchScene } from './state.js';
import { render, getSpatialIndex, queueFrameWork, screenToWorld } from './render.js';
import { saveFreeformPositions } from './layout.js';
import { selectNode, closeDrawer } from './panels.js';
import { hitTestScreen } from './spatial.js';
import { zoomAbout, pinchStart, pinchCamera } from './camera.js';

let isDragging = false;
let dragNode = null;
let lastPos = { x: 0, y: 0 };
let touchStartPos = { x: 0, y: 0 };
let touchMoved = false;
let pointerDownNode = null;
let lastTapNode = null;
let lastTapTime = 0;
let pinch = null; // the start of a two-finger gesture (camera.js pinchStart)
let downOnCanvas = false; // the press that is ending began on the map: a release elsewhere (a sheet's handle, a panel button) is not a tap on the background

// What the pointer did since the last frame; applied once per frame by applyMoves
let pendingPos = null;
let pendingPinch = null;
let pendingHover = null;
let hovering = false;
let restCursor = '';

const canDragNodes = () => state.isFreeform && state.view === 'orbit';

function getPointerPos(e) {
  const rect = state.canvas.getBoundingClientRect();
  const point = e.touches ? e.touches[0] : e;
  return { x: point.clientX - rect.left, y: point.clientY - rect.top };
}

// The topology node with this id (the grid answers with scene nodes, which are copies of the picture)
let byId = { nodes: null, size: -1, map: null };
function topologyNode(id) {
  if (byId.nodes !== state.nodes || byId.size !== state.nodes.length) {
    byId = { nodes: state.nodes, size: state.nodes.length, map: new Map(state.nodes.map((n) => [n.id, n])) };
  }
  return byId.map.get(id) || null;
}

/** The topmost visible node under a screen point (a finger gets a wider reach), or null */
function findNodeAt(screenX, screenY, isTouch) {
  const hit = hitTestScreen(getSpatialIndex(), state.camera, screenX, screenY, isTouch);
  return hit ? topologyNode(hit.id) : null;
}

const touchDistance = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
function touchMid(e) {
  const rect = state.canvas.getBoundingClientRect();
  return {
    x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
    y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top,
  };
}

function onPointerDown(e) {
  downOnCanvas = true;
  if (e.touches && e.touches.length === 2) {
    pinch = pinchStart(state.camera, touchDistance(e), touchMid(e));
    pendingPos = null;
    isDragging = false;
    dragNode = null;
    pointerDownNode = null;
    return;
  }
  const isTouch = !!(e.touches && e.touches.length > 0);
  const p = getPointerPos(e);
  touchStartPos = { x: p.x, y: p.y };
  touchMoved = false;
  pendingPos = null;
  pointerDownNode = findNodeAt(p.x, p.y, isTouch);

  if (canDragNodes() && pointerDownNode) {
    dragNode = pointerDownNode;
    if (e.cancelable) e.preventDefault();
    return;
  }
  isDragging = true; // otherwise the canvas pans
  lastPos = p;
}

/** One frame's worth of pointer movement: the pinch, the node being dragged, or the pan, from the latest position */
function applyMoves() {
  if (pendingPinch && pinch) {
    Object.assign(state.camera, pinchCamera(pinch, pendingPinch.dist, pendingPinch.mid));
  }
  pendingPinch = null;

  const p = pendingPos;
  pendingPos = null;
  if (!p) return;
  if (dragNode && canDragNodes()) {
    const world = screenToWorld(p.x, p.y);
    dragNode.x = world.x;
    dragNode.y = world.y;
    state.freeformPositions[dragNode.id] = { x: world.x, y: world.y };
    touchScene(); // positions changed: the next scene (and so the grid) is built once, from this frame's position
    saveFreeformPositions();
  } else if (isDragging) {
    state.camera.x += p.x - lastPos.x;
    state.camera.y += p.y - lastPos.y;
    lastPos = p;
  }
}

/** Hover: a pointer cursor over a node. It changes no picture, so it asks for no draw. */
function applyHover() {
  const p = pendingHover;
  pendingHover = null;
  if (!p || isDragging || dragNode) return;
  setHover(!!findNodeAt(p.x, p.y, false));
}

function setHover(over) {
  if (over === hovering || !state.canvas) return;
  if (over) restCursor = state.canvas.style.cursor;
  hovering = over;
  state.canvas.style.cursor = over ? 'pointer' : restCursor;
}

function onPointerMove(e) {
  if (e.touches && e.touches.length === 2 && pinch) {
    if (e.cancelable) e.preventDefault();
    pendingPinch = { dist: touchDistance(e), mid: touchMid(e) };
    queueFrameWork(applyMoves);
    return;
  }

  const p = getPointerPos(e);
  if (Math.hypot(p.x - touchStartPos.x, p.y - touchStartPos.y) > 8) touchMoved = true;

  if ((dragNode && canDragNodes()) || isDragging) {
    if (e.cancelable) e.preventDefault();
    pendingPos = p; // the latest position wins; the frame applies it
    queueFrameWork(applyMoves);
    return;
  }
  if (!e.touches) {
    pendingHover = p;
    queueFrameWork(applyHover, { draw: false });
  }
}

function onPointerUp(e) {
  applyMoves(); // the last position the pointer reached counts, even if no frame has run since
  const isTouch = !!(e.changedTouches && e.changedTouches.length > 0);
  const rect = state.canvas.getBoundingClientRect();
  const p = isTouch ? { x: e.changedTouches[0].clientX - rect.left, y: e.changedTouches[0].clientY - rect.top } : getPointerPos(e);

  // Only a touch or click that started and ended on the same node, without dragging, inspects it
  if (!touchMoved && downOnCanvas) {
    if (pointerDownNode) {
      const hitUp = findNodeAt(p.x, p.y, isTouch);
      if (hitUp && hitUp.id === pointerDownNode.id) {
        if (!canDragNodes()) {
          selectNode(pointerDownNode);
        } else {
          // Freeform: a double tap inspects, so dragging a node does not open the panel
          const now = Date.now();
          if (lastTapNode && lastTapNode.id === pointerDownNode.id && now - lastTapTime < 380) {
            selectNode(pointerDownNode);
            lastTapNode = null;
            lastTapTime = 0;
          } else {
            lastTapNode = pointerDownNode;
            lastTapTime = now;
          }
        }
      }
    } else if (state.selectedNode) {
      closeDrawer(); // the background was clicked: back to the normal view
    }
  }
  isDragging = false;
  dragNode = null;
  pointerDownNode = null;
  pinch = null;
  pendingPinch = null;
  downOnCanvas = false;
}

export function bindCanvasInput() {
  const { canvas } = state;
  canvas.addEventListener('mousedown', onPointerDown);
  canvas.addEventListener('mousemove', onPointerMove);
  canvas.addEventListener('mouseleave', () => { pendingHover = null; setHover(false); });
  window.addEventListener('mouseup', onPointerUp);

  canvas.addEventListener('touchstart', onPointerDown, { passive: false });
  canvas.addEventListener('touchmove', onPointerMove, { passive: false });
  window.addEventListener('touchend', onPointerUp, { passive: false });
  window.addEventListener('touchcancel', onPointerUp, { passive: false });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = getPointerPos(e);
    Object.assign(state.camera, zoomAbout(state.camera, e.deltaY < 0 ? 1.12 : 0.88, p.x, p.y));
    render(); // a camera change is cheap; the draw is one per frame however many wheel events arrive
  }, { passive: false });
}
