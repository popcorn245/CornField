/**
 * @module explorer/pieces/status
 *
 * What a person sees while a map loads from a server, and when it cannot (spec 0011 D5, D6, D11): the quiet "Loading", "Sign in to cornfield" with a
 * real link to the server's sign-in, "This page is not listed by that cornfield" with the origin it should list, offline with Retry, a server's own
 * error, a `src` that is not an address, and the notice that the package and the server are different versions. It is engine markup, mounted by the
 * map piece inside its stage (pieces/map.js); a shell holds none of it. Words are `strings` keys (core/strings.js), each element has a `data-corn`
 * hook and so a `part`, and nothing here is built from data except through `escapeHtml`, `textContent` and a link checked to be http(s).
 *
 *   const status = mount(container, inst, { onRetry })   -> { destroy, refuse }
 *
 * It follows the instance's `source` event (engine/source.js) and reads where the load is now from `sourceOf(inst)`, so a piece that joins late
 * shows the right thing. A polite live region, apart from the card, says each state once (a second `server` error says itself again: it is a
 * second answer). Focus is never taken; the one exception is the person's own Retry, after which focus goes to the card, or to the map when it loads.
 */

import { escapeHtml } from '../../core/text.js';
import { sourceOf } from '../engine/source.js';
import { t } from '../engine/strings.js';
import { withParts } from '../engine/piece.js';

/** Each state's public `data-corn-state` (docs/theming.md "States"): loading is running, a sign-in is waiting on the person, a refusal is a failure, offline is stopped */
const STATE_OF = Object.freeze({ loading: 'running', 'sign-in': 'waiting', 'not-allowed': 'failure', offline: 'stopped', server: 'failure', address: 'failure', 'second-map': 'failure' });

/** The words of a state: `title` and `text` are `strings` keys, `extra` is data the state adds (escaped when shown) */
function wordsOf(inst, detail) {
  switch (detail.state) {
    case 'loading': return { title: t(inst, 'sourceLoading'), text: '' };
    case 'sign-in': return { title: t(inst, 'sourceSignIn'), text: t(inst, 'sourceSignInText'), link: detail.signIn };
    case 'not-allowed': return { title: t(inst, 'sourceNotListed'), text: t(inst, 'sourceNotListedHint'), origin: detail.origin, retry: true };
    case 'offline': return { title: t(inst, 'sourceOffline'), text: t(inst, 'sourceOfflineText'), retry: true };
    case 'server': return { title: t(inst, 'errorTitle'), text: detail.message || '', retry: true };
    case 'address': return { title: t(inst, 'sourceBadAddress'), text: detail.problem || '' };
    case 'second-map': return { title: t(inst, 'sourceSecondMap'), text: '' };
    default: return null;
  }
}

/** A link that is safe to put in an `href`: an absolute http(s) address, as the server's sign-in is */
const safeHref = (href) => (typeof href === 'string' && /^https?:\/\/[^\s\\]+$/i.test(href) ? href : '');

/** The markup of one state (the card), escaped */
export function cardHtml(inst, detail) {
  const words = wordsOf(inst, detail);
  if (!words) return '';
  const href = words.link ? safeHref(words.link) : '';
  const parts = [`<p data-corn="source-title">${escapeHtml(words.title)}</p>`];
  if (words.text) parts.push(`<p data-corn="source-text">${escapeHtml(words.text)}</p>`);
  if (words.origin) parts.push(`<p data-corn="source-text"><code data-corn="source-origin">${escapeHtml(words.origin)}</code></p>`);
  if (href) parts.push(`<a data-corn="source-sign-in" data-corn-kind="primary" href="${escapeHtml(href)}" target="_top" rel="noopener">${escapeHtml(t(inst, 'sourceSignIn'))}</a>`);
  if (words.retry) parts.push(`<button type="button" data-corn="source-retry" data-corn-kind="secondary">${escapeHtml(t(inst, 'retry'))}</button>`);
  return parts.join('');
}

/** The words the polite region says for a state: its title and its sentence, once */
export function announcement(inst, detail) {
  const words = wordsOf(inst, detail);
  return words ? [words.title, words.text, words.origin].filter(Boolean).join('. ') : '';
}

/**
 * @param {Element} container where the card goes (the map's stage)
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst
 * @param {{ onRetry?: () => void, focusMap?: () => void, follow?: boolean }} [options] `follow: false`: the piece shows only what `refuse` tells it (a second map)
 */
export function mount(container, inst, { onRetry = () => {}, focusMap = () => {}, follow = true } = {}) {
  const doc = inst.doc;
  const active = () => { const r = container.getRootNode(); return (r && r.activeElement) || null; };
  const make = (html) => {
    const template = doc.createElement('template');
    template.innerHTML = withParts(html);
    return template.content.firstElementChild;
  };
  const card = make('<div data-corn="source-status" hidden></div>');
  const notice = make('<p data-corn="source-notice" hidden></p>');
  const live = make('<p data-corn="source-announcer" class="hx-sr-only" role="status" aria-live="polite" aria-atomic="true"></p>');
  container.append(card, notice, live);
  let shown = null;
  let ended = false;

  const render = (detail) => {
    if (ended || !detail) return;
    const words = wordsOf(inst, detail);
    const hadFocus = card.contains(active());
    if (!words) {
      card.hidden = true;
      card.textContent = '';
      shown = detail.state;
      if (hadFocus) focusMap(); // the card the focus was on is gone: it goes to the map
      return;
    }
    card.innerHTML = withParts(cardHtml(inst, detail));
    card.setAttribute('data-corn-state', STATE_OF[detail.state]);
    card.hidden = false;
    const again = shown !== detail.state || detail.state === 'server';
    shown = detail.state;
    if (again) live.textContent = announcement(inst, detail);
    if (hadFocus) { card.setAttribute('tabindex', '-1'); card.focus(); } // the person's own Retry: the focus stays with what they were doing
  };

  const showNotice = (detail) => {
    if (ended) return;
    if (!detail) { notice.hidden = true; notice.textContent = ''; return; }
    notice.textContent = `${t(inst, 'sourceVersion')} (${detail.package} / ${detail.server})`;
    notice.hidden = false;
    // The notice is a quiet line the load goes on under: it is said once, in the same region, after what the load said
    live.textContent = `${live.textContent ? `${live.textContent}. ` : ''}${notice.textContent}`;
  };

  const onClick = (event) => {
    const retry = event.target && event.target.closest ? event.target.closest('[data-corn="source-retry"]') : null;
    if (retry && card.contains(retry)) { event.preventDefault(); onRetry(); }
  };
  const offClick = inst.listen(card, 'click', onClick);

  const off = follow ? inst.on('source', (detail) => {
    if (detail.state === 'version') showNotice(detail); else render(detail);
  }) : () => {};

  // A piece that joins after the load began shows where it is now
  const source = follow ? sourceOf(inst) : null;
  if (source) {
    const current = source.state();
    if (current && current.state !== 'ready') render(current);
    if (source.notice) showNotice(source.notice);
  }

  return {
    /** Says that this piece cannot have the scope it is in (a second map): the card says why, and the piece draws nothing */
    refuse(why = 'second-map') { render({ state: why }); },
    destroy() {
      if (ended) return;
      ended = true;
      off();
      offClick();
      card.remove();
      notice.remove();
      live.remove();
    },
  };
}
