/**
 * @module explorer/connection
 *
 * Whether the browser is online, said once and in one place. `isOffline()` is `navigator.onLine === false`; when it changes a banner
 * (`#offline-banner`, index.html) says "You are offline" or "You are back online" and the live region announces it once. Every failure
 * that has no answer from the server (a failed fetch) is worded by the caller with `isOffline()`: offline it is "You are offline", not
 * "cornfield could not be reached", and an action says it was not sent and keeps what the person typed.
 */

import { announce } from './keyboard.js';

export const OFFLINE_WORDS = 'You are offline. Nothing is sent until you are back; what you have typed is kept.';
export const ONLINE_WORDS = 'You are back online.';
/** How long "back online" stays on the banner */
export const BACK_MS = 5000;

let wired = false;
let hideTimer = 0;

/** Whether the browser says it has no network */
export const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** The words for an action that got no answer: offline, it was not sent (and what was typed is still there); online, the server did not answer */
export function notSentWords(what) {
  return isOffline() ? `You are offline. ${what} was not sent; what you typed is kept. Try again when you are back.` : `cornfield did not answer. ${what} was not sent; what you typed is kept.`;
}

function paint(said) {
  const el = document.getElementById('offline-banner');
  if (!el) return;
  clearTimeout(hideTimer);
  el.hidden = false;
  el.textContent = said;
  el.dataset.cornState = isOffline() ? 'failure' : 'success';
  if (!isOffline()) hideTimer = setTimeout(() => { el.hidden = true; }, BACK_MS);
}

function onChange() {
  const words = isOffline() ? OFFLINE_WORDS : ONLINE_WORDS;
  paint(words);
  announce(words);
}

/** Listens for the browser going offline and coming back (once); says so now if the page opened offline */
export function initConnection() {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  window.addEventListener('offline', onChange);
  window.addEventListener('online', onChange);
  if (isOffline()) paint(OFFLINE_WORDS);
}

/** For tests: forget the wiring */
export function resetConnectionForTests() {
  if (wired && typeof window !== 'undefined') {
    window.removeEventListener('offline', onChange);
    window.removeEventListener('online', onChange);
  }
  wired = false;
  clearTimeout(hideTimer);
  hideTimer = 0;
}
