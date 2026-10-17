/** The shop's pages */
import { money } from '@acme/shared';
import { cart } from './cart.js';

const FONTS = 'https://fonts.googleapis.com/css2?family=Inter';

export function shell(body) {
  return `<!doctype html><link rel="stylesheet" href="${FONTS}"><main>${body}</main><a href="https://www.openstreetmap.org/">Map</a>`;
}

export const total = (items) => money(cart(items));
