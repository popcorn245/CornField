/**
 * @module explorer/plugins
 *
 * The sources a repo's cornfield.config.js names, loaded in the browser. The server says which in
 * `/cornfield/config.json` (`sources: { live, house, devices, checker }`, each `{ module, options }` or
 * null); each module exports `create(options)` returning any of `{ liveSource, floorRenderer, checker }`,
 * or those names directly. The explorer takes:
 *
 *   liveSource     the live layer (live.js): the first of live, house, devices that has one; when several
 *                  do, their answers are laid over each other (`combineSources`)
 *   floorRenderer  the House view's floor plan (house.js): the house source's, else any other's
 *   checker        the scenario permission checks (check.js): the checker source's, else any other's
 *
 * A source that fails to load is left out with one console warning; the map works without any.
 */

import { escHtml } from './state.js';
import { initThemePicker } from './theme-names.js';
import { setStrings, applyStrings, t } from './strings.js';

/** What the live layer shows when the repo names no live source */
export const NO_SOURCE = Object.freeze({
  name: 'no live source',
  async load() {
    const err = new Error('no live source is configured');
    Object.assign(err, { reason: 'unavailable', hint: 'no live source is set in cornfield.config.js (sources)' });
    throw err;
  },
});

/** The config the server hands the browser; a page opened without the server reads as none */
export async function loadClientConfig(fetcher = (...a) => globalThis.fetch(...a)) {
  try {
    const res = await fetcher('/cornfield/config.json', { cache: 'no-store' });
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

/** An <img> for a brand image (the server's same-origin URL): decorative, the button it sits in carries the name; `alt` only shows if it fails to load */
function brandImage(doc, src, kind, alt = '') {
  const img = doc.createElement('img');
  img.setAttribute('src', src);
  img.setAttribute('alt', alt);
  img.setAttribute('data-corn', `brand-${kind}`);
  img.setAttribute('style', `height:${kind === 'logo' ? 22 : 18}px;width:auto;max-width:${kind === 'logo' ? 48 : 160}px;display:block`);
  return img;
}

/**
 * The repo's brand in the header (docs/config.md#brand): the logo takes the brand mark's place and the wordmark the title text, inside
 * the same button, so its accessible name stays. The header text stays the repo's own title; `appName` replaces "cornfield" where
 * cornfield names itself: the button's accessible name and the page's heading (the tab title and the manifest are the server's).
 */
function applyBrand(doc, brand, title) {
  const button = doc.getElementById('cf-brand');
  if (button && brand.appName) button.setAttribute('aria-label', `${brand.appName}: reset the view`);
  const text = doc.getElementById('cf-title');
  if (brand.logo && typeof doc.createElement === 'function') {
    const mark = doc.getElementById('cf-mark');
    if (mark) mark.replaceWith(brandImage(doc, brand.logo, 'logo'));
  }
  if (brand.wordmark && text && typeof doc.createElement === 'function') {
    text.textContent = '';
    text.appendChild(brandImage(doc, brand.wordmark, 'wordmark', title || brand.appName || ''));
  }
  const heading = doc.getElementById('cf-heading');
  if (heading && brand.appName) heading.textContent = `${brand.appName}: the map`;
}

/** The footer line of the account menu: "powered by cornfield 0.14.0". A link to cornfield when the brand names where it leads */
function paintFooter(doc, config) {
  const foot = doc.getElementById('cf-powered');
  if (!foot) return;
  const words = [t('poweredBy'), typeof config.version === 'string' ? config.version : ''].filter(Boolean).join(' ');
  const home = config.brand && typeof config.brand.poweredBy === 'string' && /^https:\/\//.test(config.brand.poweredBy) ? config.brand.poweredBy : '';
  foot.innerHTML = home ? `<a href="${escHtml(home)}" target="_blank" rel="noreferrer">${escHtml(words)}</a>` : escHtml(words);
}

const FORGE_NAMES = { github: 'GitHub', forgejo: 'Forgejo' };

/** The link rows of the account menu: the config's links, the forge (unless a link already leads there), and cornfield's docs */
function linkRows(config) {
  const rows = (Array.isArray(config.links) ? config.links : [])
    .filter((l) => l && typeof l.label === 'string' && /^(https?:\/\/|\/)/.test(String(l.href)))
    .map((l) => ({ label: l.label, href: l.href }));
  const forge = config.forge;
  if (forge && typeof forge.url === 'string' && /^https:\/\//.test(forge.url) && typeof forge.repo === 'string') {
    const href = `${forge.url.replace(/\/+$/, '')}/${forge.repo}`;
    if (!rows.some((r) => r.href === href || String(r.href).startsWith(`${href}/`))) rows.push({ label: FORGE_NAMES[forge.type] || 'Forge', href });
  }
  if (typeof config.docs === 'string' && /^https:\/\//.test(config.docs)) rows.push({ label: 'Docs', href: config.docs });
  return rows.map((r) => `<a class="hx-account-item" href="${escHtml(r.href)}" target="_blank" rel="noreferrer" data-corn="link"><span>${escHtml(r.label)}</span><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 3h7v7M13 3L7 9" /></svg></a>`).join('');
}

/** Puts the repo's title, brand and links in the header, and who is signed in, with Sign out, in the account menu */
export function applyBranding(doc, config) {
  if (!config || !doc) return;
  // The repo's words (core/strings.js) first: what is built below reads them, and the static markup is filled now
  setStrings(config.strings);
  applyStrings(doc);
  const title = doc.getElementById('cf-title');
  if (title && config.title) title.textContent = config.title;
  const heading = doc.getElementById('cf-heading');
  if (heading && config.title) heading.textContent = `${config.title}: the map`;
  if (config.brand) applyBrand(doc, config.brand, config.title);
  initThemePicker(doc, config.theme);
  paintAccount(doc, config);
}

/** The account button's initial, the line saying who is signed in, the links, Sign out and the footer */
function paintAccount(doc, config) {
  const login = config.signIn && typeof config.signIn.login === 'string' ? config.signIn.login : '';
  const initial = doc.getElementById('account-initial');
  if (initial) initial.textContent = login ? [...login][0].toUpperCase() : '';
  const btn = doc.getElementById('account-btn');
  if (btn) btn.setAttribute('aria-label', login ? `Account menu, signed in as ${login}` : 'Account menu');
  const who = doc.getElementById('account-who');
  if (who) {
    who.hidden = !login;
    // Only a maintainer gets past the sign-in (server/auth.js), so whoever is here is one
    who.textContent = login ? `${login} · maintainer` : '';
  }
  paintFooter(doc, config);
  const links = doc.getElementById('cf-links');
  if (!links) return;
  // A plain form: signing out is a same-origin POST (server/auth.js), no script needed
  const signOut = login
    ? `<form class="cf-sign-out" method="post" action="/auth/sign-out" data-corn="sign-out"><button type="submit" class="hx-account-item" title="Signed in as ${escHtml(login)}" data-corn-kind="quiet">${escHtml(t('signOut'))}</button></form>`
    : '';
  links.innerHTML = linkRows(config) + signOut;
}

/**
 * Several live sources as one: every answer is asked for at once and laid over each other (nodes and edges
 * joined, accounts and notes joined, the first plan). One that fails is a note; all failing is the first failure.
 * @param {{ name?: string, load: Function, image?: Function, token?: object }[]} sources
 */
export function combineSources(sources) {
  if (sources.length === 1) return sources[0];
  return {
    name: sources.map((s) => s.name || 'a source').join(' + '),
    token: sources.find((s) => s.token)?.token,
    async load(opts) {
      const settled = await Promise.allSettled(sources.map((s) => s.load(opts)));
      const ok = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      if (!ok.length) throw settled[0].reason;
      const notes = [...ok.flatMap((a) => a.notes || []), ...settled.filter((r) => r.status === 'rejected').map((r) => `A source did not answer: ${r.reason?.hint || r.reason?.message || r.reason}`)];
      return {
        at: ok.map((a) => a.at).filter(Boolean).sort().pop() || new Date().toISOString(),
        nodes: ok.flatMap((a) => a.nodes || []),
        edges: ok.flatMap((a) => a.edges || []),
        accounts: ok.flatMap((a) => a.accounts || []),
        hardware: ok.flatMap((a) => a.hardware || []),
        notes,
        unplaced: ok.flatMap((a) => a.unplaced || []),
        plan: ok.find((a) => a.plan)?.plan || null,
        resolve: (nodes, edges) => {
          const out = { edges: [], nodes: {} };
          for (const a of ok) {
            if (typeof a.resolve !== 'function') continue;
            const r = a.resolve(nodes, edges) || {};
            out.edges.push(...(r.edges || []));
            Object.assign(out.nodes, r.nodes || {});
          }
          return out;
        },
      };
    },
    async image(url, o) {
      for (const s of sources) if (typeof s.image === 'function') { const b = await s.image(url, o); if (b) return b; }
      return null;
    },
  };
}

/**
 * Loads the sources a config names.
 * @param {{ sources?: Record<string, { module: string, options?: object } | null> }} config
 * @param {(url: string) => Promise<any>} [importer]
 * @returns {Promise<{ liveSource: object, floorRenderer: object|null, checker: object|null }>}
 */
export async function loadSources(config, importer = (url) => import(url)) {
  const loaded = {};
  for (const [slot, s] of Object.entries((config && config.sources) || {})) {
    if (!s || typeof s.module !== 'string' || !s.module.startsWith('/')) continue;
    try {
      const mod = await importer(s.module);
      loaded[slot] = typeof mod.create === 'function' ? (await mod.create(s.options || {})) || {} : mod;
    } catch (err) {
      console.warn(`The ${slot} source (${s.module}) did not load; the map works without it`, err);
    }
  }
  const pick = (key, order) => order.map((slot) => loaded[slot] && loaded[slot][key]).find(Boolean) || null;
  const lives = ['live', 'house', 'devices'].map((slot) => loaded[slot] && loaded[slot].liveSource).filter(Boolean);
  return {
    liveSource: lives.length ? combineSources(lives) : NO_SOURCE,
    floorRenderer: pick('floorRenderer', ['house', 'live', 'devices']),
    checker: pick('checker', ['checker', 'live', 'house', 'devices']),
  };
}
