/**
 * @module explorer/focus-room
 *
 * A control that is tabbed to inside a strip that scrolls sideways (the Work list's tabs) is brought fully into view, ring and all
 * (CF review F54). A browser scrolls a focused control only until it is "mostly" visible, and the last tab was left a few pixels under
 * the strip's edge, with its focus ring cut. `scroll-padding-inline` in css/work.css says how much room to leave; this asks for the scroll.
 * The Work piece (pieces/work.js) listens for focus in its own root and asks.
 */

/** The strips: a scroll container whose children are tabbed to */
export const STRIP = '.hx-forge-tabs';

/** Scrolls `el` into view inside its strip, if it has one, leaving the strip's scroll-padding */
export function revealInStrip(el) {
  if (!el || typeof el.closest !== 'function' || typeof el.scrollIntoView !== 'function') return false;
  const strip = el.closest(STRIP);
  if (!strip || el === strip) return false;
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}
