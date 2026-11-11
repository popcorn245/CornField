/**
 * @module explorer/kind-letters
 *
 * The letters a finer `kind` shows in the middle of its node (spec 0009 D5): `j` for a job, `h` for a hook (core/layers.js `kindLetters`
 * chooses them; scene.js puts them on the node as `letters`). Both renderers draw the same picture, so it is made once, here: a small
 * transparent image of the letters (dark ink under a light outline, so it reads over the node's own colour and the white core in either
 * theme), and the rule for when it is drawn.
 *
 *  - Canvas 2D draws it with `drawImage` where the theme's icon would go.
 *  - WebGL uploads it as a texture and draws it in the icon pass, grouped by letters like an icon is grouped by kind (`letters:<l>`).
 *
 * A theme icon for the node's kind replaces it (the node then carries `icon`); spec 0008's type glyphs sit in this same place and can draw
 * beside or instead of it. The letters are text: an image of them is made with fillText, never markup.
 */

import { FONT_NODE } from './scene.js';

/** A node is at least this many px across (on screen) before its letters are drawn: smaller, they are a smudge */
export const LETTER_MIN_PX = 14;
/** The letters' box, as a fraction of the node's radius across (a square centred on the node, like an icon) */
export const LETTER_RATIO = 1;
/** The image's side in px: sharp up to a node several times its size on screen */
const SIDE = 96;
const KEY_PREFIX = 'letters:';

/** The key a node's letters go under in the renderers' icon tables */
export const letterKey = (letters) => `${KEY_PREFIX}${letters}`;
export const isLetterKey = (key) => typeof key === 'string' && key.startsWith(KEY_PREFIX);
export const lettersOfKey = (key) => key.slice(KEY_PREFIX.length);

/** Whether a node's letters are drawn at this zoom: it has some, no theme icon replaces them, and it is wide enough on screen */
export const showsLetters = (node, zoom) => !!node.letters && !node.icon && node.r * 2 * zoom >= LETTER_MIN_PX;

const images = new Map();
/** The most letter images made (and so WebGL textures, one each): a map's kinds are its own data, so the count is held, not trusted. A kind
 * past it draws as a plain node, as one with no letters does */
export const MAX_LETTER_IMAGES = 128;
/** Lets the images go (a test starts afresh with it) */
export const forgetLetterImages = () => images.clear();

/**
 * The image of some letters, made once (null where there is no canvas to draw one on, as in a test without a browser).
 * @param {string} letters one or two characters
 * @returns {CanvasImageSource | null}
 */
export function letterImage(letters) {
  if (typeof letters !== 'string' || !letters) return null;
  if (images.has(letters)) return images.get(letters);
  if (images.size >= MAX_LETTER_IMAGES) return null;
  let image = null;
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(SIDE, SIDE) : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: SIDE, height: SIDE }) : null;
    const ctx = canvas && canvas.getContext && canvas.getContext('2d');
    if (ctx && ctx.fillText) {
      const size = letters.length > 1 ? 56 : 72;
      ctx.font = `700 ${size}px ${FONT_NODE}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 10;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.strokeText(letters, SIDE / 2, SIDE / 2 + 3);
      ctx.fillStyle = '#0b1220';
      ctx.fillText(letters, SIDE / 2, SIDE / 2 + 3);
      image = canvas;
    }
  } catch { image = null; }
  images.set(letters, image);
  return image;
}
