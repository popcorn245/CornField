/**
 * @module explorer/capped
 *
 * A long list in the node panel shows its first few items and a quiet "and 15 more" button that opens the rest in place
 * (a disclosure: `aria-expanded`). `toggleCapped` is the click handler panels.js binds once on the panel.
 */

/** Items shown before the rest folds away */
export const CAP = 5;
let counter = 0;

/**
 * The items as HTML, folded after `cap` (CAP by default) when there are more.
 * @param {string[]} items already-escaped HTML, one per item
 * @param {number} [cap]
 */
export function capped(items, cap = CAP) {
  if (items.length <= cap + 1) return items.join(''); // "and 1 more" saves nothing
  const id = `hx-more-${++counter}`;
  const rest = items.length - cap;
  return `${items.slice(0, cap).join('')}<div class="hx-more" id="${id}" hidden>${items.slice(cap).join('')}</div><button data-corn="more" data-corn-kind="quiet" type="button" class="hx-btn hx-btn--quiet hx-textact hx-more-btn" data-more="${id}" data-rest="${rest}" aria-expanded="false" aria-controls="${id}">and ${rest} more</button>`;
}

/** Opens or folds the list a "more" button belongs to; true when the click was one */
export function toggleCapped(target) {
  const button = target.closest && target.closest('[data-more]');
  if (!button) return false;
  const list = button.ownerDocument.getElementById(button.dataset.more);
  const open = button.getAttribute('aria-expanded') !== 'true';
  if (list) list.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  button.textContent = open ? 'Show fewer' : `and ${button.dataset.rest} more`;
  return true;
}
