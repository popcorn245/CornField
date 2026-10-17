/** What is in the basket */
export const cart = (items) => items.reduce((s, i) => s + i.cents, 0);
