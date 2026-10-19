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

/** Puts the repo's title and links in the header */
export function applyBranding(doc, config) {
  if (!config || !doc) return;
  const title = doc.getElementById('cf-title');
  if (title && config.title) title.textContent = config.title;
  const heading = doc.getElementById('cf-heading');
  if (heading && config.title) heading.textContent = `${config.title}: the map`;
  const links = doc.getElementById('cf-links');
  if (links && Array.isArray(config.links)) {
    links.innerHTML = config.links
      .filter((l) => l && typeof l.label === 'string' && /^(https?:\/\/|\/)/.test(String(l.href)))
      .map((l) => `<a class="hx-chip-link hx-chip-link--indigo hx-only-xl" href="${escHtml(l.href)}" target="_blank" rel="noreferrer"><span class="hx-dot-sm"></span> ${escHtml(l.label)}</a>`)
      .join('');
  }
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
