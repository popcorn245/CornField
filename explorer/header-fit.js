/**
 * @module explorer/header-fit
 *
 * Keeps the header's left group (the brand, the View switch, the Layers chip) inside its box (CF review F46). A brand wordmark can be wider
 * than the room a phone leaves, and the group used to scroll sideways behind a scrollbar nobody could see, with House half out of sight.
 * Nothing here guesses a width: it measures. With the wordmark shown, if the group's content is wider than its box the wordmark goes
 * (`data-brand-short` on the group, css/header.css hides it and the logo stays); if the content still does not fit, `data-overflow` is set, and
 * css/header.css draws a fade at the edge it scrolls under, so a scroll is never silent. The brand button keeps its accessible name either way.
 */

export const SHORT_ATTR = 'data-brand-short';
export const OVERFLOW_ATTR = 'data-overflow';

/** Whether an element's content is wider than its box (a pixel of rounding is not) */
const wider = (el) => el.scrollWidth > el.clientWidth + 1;

/**
 * Measures the header's left group once and sets (or clears) its two attributes.
 * @param {Element} left the `.hx-header-left` group
 * @returns {{short: boolean, overflow: boolean}}
 */
export function fitLeft(left) {
  left.removeAttribute(SHORT_ATTR);
  left.removeAttribute(OVERFLOW_ATTR);
  // A menu that is open hangs under its chip and past the group's edge; that is not the group's content running over, and the fade
  // (css/header.css [data-overflow]) is a mask that would hide the menu itself. Measure with open menus out of the way, then put them back.
  const open = [...left.querySelectorAll('.hx-menu')].filter((m) => !m.hidden).map((m) => [m, m.style.display]);
  open.forEach(([m]) => { m.style.display = 'none'; });
  try { return measure(left); } finally { open.forEach(([m, was]) => { m.style.display = was; }); }
}

function measure(left) {
  let short = false;
  if (left.querySelector('[data-corn="brand-wordmark"]') && wider(left)) {
    left.setAttribute(SHORT_ATTR, '');
    short = true;
  }
  const overflow = wider(left);
  if (overflow) left.setAttribute(OVERFLOW_ATTR, '');
  return { short, overflow };
}

/**
 * Fits the header now and whenever its room or its content changes: the window resizing, the wordmark image arriving, a font arriving, a chip's text changing.
 * @param {Document} doc
 * @returns {() => void} how to stop
 */
export function watchHeaderFit(doc) {
  const left = doc.querySelector('.hx-header-left');
  const win = doc.defaultView;
  if (!left || !win) return () => {};
  let queued = false;
  const run = () => { queued = false; fitLeft(left); };
  const soon = () => {
    if (queued) return;
    queued = true;
    if (win.requestAnimationFrame) win.requestAnimationFrame(run); else run();
  };
  const stops = [];
  if (win.ResizeObserver) {
    const ro = new win.ResizeObserver(soon);
    ro.observe(doc.documentElement);
    ro.observe(left);
    stops.push(() => ro.disconnect());
  } else {
    win.addEventListener('resize', soon);
    stops.push(() => win.removeEventListener('resize', soon));
  }
  if (win.MutationObserver) {
    const mo = new win.MutationObserver(soon);
    mo.observe(left, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] }); // a chip or the House button coming or going
    stops.push(() => mo.disconnect());
  }
  left.addEventListener('load', soon, true); // the wordmark's <img>: load does not bubble, so captured
  stops.push(() => left.removeEventListener('load', soon, true));
  const fonts = doc.fonts;
  if (fonts && fonts.addEventListener) {
    fonts.addEventListener('loadingdone', soon);
    stops.push(() => fonts.removeEventListener('loadingdone', soon));
  }
  soon();
  return () => stops.forEach((fn) => fn());
}
