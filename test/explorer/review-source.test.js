// @vitest-environment happy-dom
/**
 * Spec 0011 D1, D5, D6, D7, D9, D10: the review that loads from a server (explorer/pieces/review.js with `src`, pieces/review-source.js). The engine half of
 * the one tag `<corn-review src proposal>`: with an address and no topology handed in, it reads the config and the map through engine/source.js (the same
 * states a map with a `src` shows, in the same card), applies the config's words, layers and theme, opens the proposal by name, and tells a host what
 * happened in plain callbacks the shell turns into events. A refused decision shows the same sign-in card. Nothing here is a second copy of loading.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { loadSample, SAMPLE } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { mount } from '../../explorer/pieces/review.js';
// @ts-expect-error plain JS modules, no declarations
import { parseSource, signInUrl } from '../../explorer/engine/source-address.js';
// @ts-expect-error plain JS modules, no declarations
import * as source from '../../explorer/engine/source.js';
// @ts-expect-error plain JS modules, no declarations
import { errorOf } from '../../explorer/engine/source.js';

const sample = loadSample();
const proposal = JSON.parse(fs.readFileSync(`${SAMPLE}/docs/specs/proposals/0002-checkout.json`, 'utf8'));
const topology = () => structuredClone({ nodes: sample.nodes, edges: sample.edges });
const ctx2d = new Proxy({}, { get: (t, k) => (k === 'measureText' ? (text) => ({ width: String(text).length * 6 }) : k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
const BASE = 'http://map.example.test';
const PAGE = 'http://tasks.example.test/reviews/7';

let restore = [];
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
  const realGet = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type) { return type === '2d' ? ctx2d : null; };
  restore.push(() => { HTMLCanvasElement.prototype.getContext = realGet; });
});
afterEach(() => {
  restore.forEach((fn) => fn());
  restore = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`); await sleep(10); } }

/** A cornfield server in a function: what a listed origin may read, answered as the real one does */
function server(opts = {}) {
  const log = [];
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const fetch = vi.fn(async (url, init = {}) => {
    const u = new URL(String(url));
    log.push({ method: init.method || 'GET', path: u.pathname + u.search.replace(/[?&]v=\d+/, ''), credentials: init.credentials, origin: u.origin });
    if (opts.down) throw new TypeError('Failed to fetch');
    if (u.pathname === '/cornfield/config.json') return opts.config401 ? json(opts.config401, { error: 'no' }) : json(200, { name: 'cornfield', version: '0.0.0', strings: { approve: 'Ship it' }, layers: { add: [], off: [], order: [] }, theme: null, ...opts.config });
    if (u.pathname === '/topology.json') return opts.config401 ? json(opts.config401, { error: 'no' }) : json(200, topology());
    if (u.pathname === '/proposals') return json(200, [{ slug: '0002-checkout', source: 'pull/2' }]);
    const named = /^\/proposals\/([^/]+)\.json$/.exec(u.pathname);
    if (named) {
      if (opts.proposal401) return json(opts.proposal401, { error: 'no' });
      if (named[1] !== '0002-checkout') return json(404, { error: 'no such proposal' });
      return json(200, proposal, { 'X-Proposal-Source': 'pull%2F2', 'X-Proposal-Sha256': 'c'.repeat(64) });
    }
    if (u.pathname.endsWith('/decision')) return opts.facts401 ? json(opts.facts401, { error: 'no' }) : json(200, { pull: { number: 2, draft: false, head: 'f'.repeat(40) }, checks: { total: 1, passed: 1, running: 0, failed: [] }, lands: false, run: null });
    if (u.pathname.endsWith('/review')) return json(404, { error: 'none' });
    if (u.pathname === '/cornfield/theme.css') return new Response(opts.theme || '', { status: 200, headers: { 'Content-Type': 'text/css' } });
    return json(404, {});
  });
  return { fetch, log };
}

/** A review in a shadow root (as the tag has it), with callbacks recorded */
function make(options = {}, srv = server()) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const calls = { auth: [], error: [], navigate: [], decision: [], ready: 0 };
  const piece = mount(root, null, {
    renderer: 'canvas2d', fetch: srv.fetch, pageUrl: () => PAGE, version: '0.0.0',
    onAuth: (d) => calls.auth.push(d), onError: (d) => calls.error.push(d), onNavigate: (d) => calls.navigate.push(d), onDecision: (d) => calls.decision.push(d), onReady: () => { calls.ready++; },
    ...options,
  });
  return { host, root, piece, calls, srv };
}
const card = (root) => root.querySelector('[data-corn="source-status"]:not([hidden])');
const cardText = (root) => (card(root)?.textContent || '').replace(/\s+/g, ' ').trim();

describe('the address, apart from the load', () => {
  it('engine/source-address.js holds what a piece needs at once (the instance\'s base is made from it), and engine/source.js says the same things', () => {
    expect(parseSource('https://map.example.com/')).toEqual({ ok: true, base: 'https://map.example.com', origin: 'https://map.example.com' });
    expect(parseSource('ftp://x').ok).toBe(false);
    expect(signInUrl(BASE, PAGE)).toBe(`${BASE}/auth/start?returnTo=${encodeURIComponent(PAGE)}`);
    expect(source.parseSource).toBe(parseSource);
    expect(source.signInUrl).toBe(signInUrl);
  });

  it('errorOf says each failing state of the load as a cornError and nothing for the others', () => {
    expect(errorOf({ state: 'not-allowed', origin: 'https://t.example.com' })).toEqual({ kind: 'not-listed', message: 'https://t.example.com' });
    expect(errorOf({ state: 'offline' })).toEqual({ kind: 'offline' });
    expect(errorOf({ state: 'server', message: 'boom' })).toEqual({ kind: 'server', message: 'boom' });
    expect(errorOf({ state: 'address', problem: 'is empty' })).toEqual({ kind: 'address', message: 'is empty' });
    expect(errorOf({ state: 'version', package: '1.0.0', server: '1.2.0' })).toEqual({ kind: 'version', message: '1.0.0 / 1.2.0' });
    for (const state of ['loading', 'ready', 'sign-in']) expect(errorOf({ state })).toBe(null);
  });
});

describe('a review with a src (D1, D6)', () => {
  it('reads the config and the map, then opens the proposal by name, and every request is the server\'s with the session; onReady once, after both', async () => {
    const { piece, root, calls, srv } = make({ src: BASE, proposal: '0002-checkout' });
    expect(cardText(root)).toBe(''); // the chunk is on its way
    await until(() => calls.ready === 1);
    expect(piece.inst.state.proposal.title).toBe(proposal.title);
    expect(piece.inst.state.proposalSource).toBe('pull/2');
    expect(card(root)).toBe(null);
    const paths = srv.log.map((r) => `${r.method} ${r.path}`);
    expect(paths.slice(0, 3)).toEqual(['GET /cornfield/config.json', 'GET /topology.json', 'GET /proposals/0002-checkout.json']);
    for (const r of srv.log.filter((x) => !x.path.startsWith('/cornfield/theme'))) expect({ origin: r.origin, credentials: r.credentials }, `${r.method} ${r.path}`).toEqual({ origin: BASE, credentials: 'include' });
    expect(calls.navigate).toEqual([{ proposal: '0002-checkout', source: null, view: 'diff', change: 'opened' }]);
    expect(calls.ready).toBe(1);
    piece.destroy();
  });

  it('shows "Loading the map" in the status card while it reads, with the hooks and parts a map has', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const srv = server();
    const slow = vi.fn(async (url, init) => { await gate; return srv.fetch(url, init); });
    const { piece, root } = make({ src: BASE, proposal: '0002-checkout', fetch: slow });
    await until(() => !!card(root));
    expect(cardText(root)).toBe('Loading the map …');
    expect(card(root).getAttribute('data-corn-state')).toBe('running');
    expect(card(root).getAttribute('part')).toBe('source-status');
    release();
    await until(() => !card(root));
    piece.destroy();
  });

  it('signed out: the sign-in card with the server\'s link, onAuth says 401 during load, and the proposal is not asked for', async () => {
    const { piece, root, calls, srv } = make({ src: BASE, proposal: '0002-checkout' }, server({ config401: 401 }));
    await until(() => !!root.querySelector('[data-corn="source-sign-in"]'));
    const link = root.querySelector('[data-corn="source-sign-in"]');
    expect(link.getAttribute('href')).toBe(signInUrl(BASE, PAGE));
    expect(link.getAttribute('target')).toBe('_top');
    expect(cardText(root)).toMatch(/not signed in/i);
    expect(calls.auth).toEqual([{ status: 401, signIn: signInUrl(BASE, PAGE), during: 'load' }]);
    expect(srv.log.some((r) => r.path.startsWith('/proposals'))).toBe(false);
    expect(calls.ready).toBe(0);
    piece.destroy();
  });

  it('signed in as someone who is not a maintainer (403): the same card, in the words for that', async () => {
    const { piece, root, calls } = make({ src: BASE }, server({ config401: 403 }));
    await until(() => !!root.querySelector('[data-corn="source-sign-in"]'));
    expect(cardText(root)).toMatch(/maintainers/);
    expect(calls.auth[0].status).toBe(403);
    piece.destroy();
  });

  it('a server that cannot be reached: offline, with Retry (which reads again), and onError says offline', async () => {
    const srv = server({ down: true });
    const { piece, root, calls } = make({ src: BASE }, srv);
    await until(() => !!root.querySelector('[data-corn="source-retry"]'));
    expect(calls.error.map((e) => e.kind)).toEqual(['offline']);
    const before = srv.fetch.mock.calls.length;
    root.querySelector('[data-corn="source-retry"]').click();
    await until(() => srv.fetch.mock.calls.length > before);
    piece.destroy();
  });

  it('a bad address is refused and said, and nothing is sent anywhere, not even a proposal to the page\'s own origin', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('no')));
    vi.stubGlobal('fetch', fetch);
    const { piece, root, calls } = make({ src: 'javascript:alert(1)', proposal: '0002-checkout', topology: topology(), fetch: undefined });
    await until(() => !!card(root));
    expect(calls.error).toEqual([{ kind: 'address', message: 'is not http or https' }]);
    expect(cardText(root)).toMatch(/address/i);
    await sleep(50);
    expect(fetch).not.toHaveBeenCalled();
    expect(piece.inst.base).toBe('');
    piece.destroy();
  });

  it('a server of another version shows the notice and goes on; onError says version once', async () => {
    const { piece, root, calls } = make({ src: BASE, proposal: '0002-checkout' }, server({ config: { version: '9.9.0' } }));
    await until(() => calls.ready === 1);
    expect(root.querySelector('[data-corn="source-notice"]:not([hidden])').textContent).toMatch(/different versions/);
    expect(calls.error.filter((e) => e.kind === 'version')).toHaveLength(1);
    piece.destroy();
  });

  it('takes the config\'s words; the host\'s own words, when it hands any in, are the ones spoken (as a scope\'s strings are)', async () => {
    const own = make({ src: BASE, proposal: '0002-checkout' });
    await until(() => own.calls.ready === 1);
    expect(own.root.querySelector('[data-review="approved"]').textContent).toBe('Ship it'); // the server's
    own.piece.destroy();
    const host = make({ src: BASE, proposal: '0002-checkout', strings: { sendBack: 'Return it' } });
    await until(() => host.calls.ready === 1);
    expect(host.root.querySelector('[data-review="notes"]').textContent).toBe('Return it'); // the host's
    expect(host.root.querySelector('[data-review="approved"]').textContent).toBe('Approve'); // the server's words are not mixed in
    host.piece.destroy();
  });

  it('a host that hands in the topology and the config is asked for nothing of them (only the proposal and the decision go to the server)', async () => {
    const { piece, srv, calls } = make({ src: BASE, proposal: '0002-checkout', topology: topology(), config: { version: '0.0.0', strings: {} } });
    await until(() => calls.ready === 1);
    expect(srv.log.map((r) => r.path).filter((p) => /config|topology/.test(p))).toEqual([]);
    expect(srv.log.some((r) => r.path.startsWith('/proposals/0002-checkout.json'))).toBe(true);
    piece.destroy();
  });

  it('what is handed in while the loader is on its way is applied when it is there', async () => {
    const { piece, calls, srv } = make({ src: BASE });
    piece.update({ topology: topology(), config: { version: '0.0.0' }, proposal: '0002-checkout' });
    await until(() => calls.ready === 1);
    expect(srv.log.map((r) => r.path).filter((p) => /config|topology/.test(p))).toEqual([]);
    expect(piece.inst.state.proposal.title).toBe(proposal.title);
    piece.destroy();
  });
});

describe('a proposal that cannot be opened (D1)', () => {
  it('says so in words with the name, onError says proposal once, and there is no way on that goes nowhere: no Specs list', async () => {
    const { piece, root, calls } = make({ src: BASE, proposal: '0099-nothing' });
    await until(() => calls.error.length > 0);
    await until(() => calls.ready === 1);
    expect(calls.error).toEqual([{ kind: 'proposal', message: 'There is no proposal called 0099-nothing.' }]);
    expect(root.querySelector('#proposal-message').textContent).toBe('There is no proposal called 0099-nothing.');
    const ways = [...root.querySelectorAll('[data-action="proposal-way"]')];
    expect(ways.map((w) => w.dataset.way)).not.toContain('specs');
    // the page itself has it: with nobody saying there is none, the way is offered
    const page = make({ topology: topology(), fetch: server().fetch, base: BASE, proposal: '0099-nothing' });
    await until(() => !!page.root.querySelector('[data-action="proposal-way"][data-way="specs"]') || [...page.root.querySelectorAll('[data-action="proposal-way"]')].length >= 0);
    piece.destroy();
    page.piece.destroy();
  });

  it('a name the engine\'s own ask finds a Specs list for keeps its way (cornfield\'s page answers nothing, so it has the way)', async () => {
    const { createInstance } = await import('../../explorer/instance.js');
    const { openProposal } = await import('../../explorer/engine/proposal.js');
    const inst = createInstance({ base: BASE, fetch: server().fetch });
    const seen = [];
    inst.on('proposal:message', (m) => seen.push(m));
    await openProposal(inst, '0099-nothing');
    expect(seen.at(-1).ways.map((w) => w.way)).toContain('specs');
    const quiet = createInstance({ base: BASE, fetch: server().fetch });
    quiet.on('proposal:specs-list', () => false);
    const said = [];
    quiet.on('proposal:message', (m) => said.push(m));
    await openProposal(quiet, '0099-nothing');
    expect(said.at(-1).ways.map((w) => w.way)).not.toContain('specs');
  });

  it('a proposal the session may not read: the sign-in card and onAuth during proposal, and the bar says it in words (not "error 401")', async () => {
    const { piece, root, calls } = make({ src: BASE, proposal: '0002-checkout' }, server({ proposal401: 401 }));
    await until(() => calls.auth.length > 0);
    expect(calls.auth[0]).toEqual({ status: 401, signIn: signInUrl(BASE, PAGE), during: 'proposal' });
    await until(() => !!root.querySelector('[data-corn="source-sign-in"]'));
    expect(root.querySelector('#proposal-message').textContent).toBe('0002-checkout could not be opened: you are not signed in.');
    expect(calls.error[0].kind).toBe('proposal');
    piece.destroy();
  });
});

describe('a proposal\'s name stays one path segment on the server (D9)', () => {
  const ODD = ['..', '.', '../review', '../../cornfield/config', 'a/b', '0002-checkout/..', '0002-checkout?x=1', '0002-checkout#x', '%2e%2e', '..%2Freview', 'http://evil.test/0002-checkout', '//evil.test/x', ' 0002-checkout', '0002-checkout\\..', '<img src=x onerror="window.__x=1">', 'a'.repeat(201), '-leading-dash'];
  it('a value that is not a proposal\'s name is never put in a request: said in the bar as text, onError proposal, nothing decided', async () => {
    for (const value of ODD) {
      const { piece, root, calls, srv } = make({ src: BASE, proposal: value });
      await until(() => calls.error.length > 0 && calls.ready === 1);
      expect(srv.log.filter((r) => r.path.startsWith('/proposals') || !['/cornfield/config.json', '/topology.json'].includes(r.path))).toEqual([]);
      expect(calls.error).toEqual([{ kind: 'proposal', message: expect.stringMatching(/is not a proposal's name\.$/) }]);
      expect(root.querySelector('#proposal-message').textContent).toBe(calls.error[0].message);
      expect(root.querySelector('img')).toBeNull();
      const approve = root.querySelector('[data-review="approved"]');
      expect(!approve || !!approve.closest('[hidden]')).toBe(true); // no decision: nothing is open
      piece.destroy();
    }
    expect(window.__x).toBeUndefined();
  });

  it('the engine refuses it too, before any request (cornfield\'s page filters its links already; a listing or a host does not)', async () => {
    const { createInstance } = await import('../../explorer/instance.js');
    const { openProposal } = await import('../../explorer/engine/proposal.js');
    const fetch = vi.fn(() => Promise.reject(new Error('never')));
    const inst = createInstance({ base: BASE, fetch });
    const failed = [];
    inst.on('proposal:failed', (d) => failed.push(d));
    for (const value of ['..', 'a/b', '', null, 42]) expect(await openProposal(inst, value)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(failed.map((d) => d.message)).toEqual(['\u201c..\u201d is not a proposal\'s name.', '\u201ca/b\u201d is not a proposal\'s name.', 'That is not a proposal\'s name.', 'That is not a proposal\'s name.', '\u201c42\u201d is not a proposal\'s name.']);
  });

  it('with no src (and no base or fetch) a name is never asked of the page\'s own origin in its place: said, and nothing is sent', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('never')));
    vi.stubGlobal('fetch', fetch);
    const { piece, root, calls } = make({ proposal: '0002-checkout', topology: topology(), fetch: undefined });
    await until(() => calls.error.length > 0 && calls.ready === 1);
    await sleep(50);
    expect(fetch).not.toHaveBeenCalled();
    expect(calls.error).toEqual([{ kind: 'proposal', message: '0002-checkout cannot be opened here: there is no cornfield server to read it from (the review has no src).' }]);
    expect(root.querySelector('#proposal-message').textContent).toBe(calls.error[0].message);
    // a proposal handed in as an object still shows, for reading, with no request
    piece.update({ proposal });
    await until(() => !!root.querySelector('#proposal-title')?.textContent);
    expect(fetch).not.toHaveBeenCalled();
    piece.destroy();
  });
});

describe('a decision the server refuses (D9)', () => {
  it('shows the same card and link, and onAuth carries what was refused; the facts read again are said once, a press every time', async () => {
    const { piece, root, calls } = make({ src: BASE, proposal: '0002-checkout', source: 'pull/2' }, server({ facts401: 401 }));
    await until(() => calls.auth.length > 0);
    expect(calls.auth[0]).toEqual({ status: 401, signIn: signInUrl(BASE, PAGE), during: 'facts' });
    await until(() => !!root.querySelector('[data-corn="source-sign-in"]'));
    expect(root.querySelector('[data-corn="source-sign-in"]').getAttribute('href')).toBe(signInUrl(BASE, PAGE));
    piece.inst.emit('auth', { status: 401, during: 'facts' }); // the poll again
    expect(calls.auth.filter((a) => a.during === 'facts')).toHaveLength(1);
    piece.inst.emit('auth', { status: 401, during: 'send' });
    piece.inst.emit('auth', { status: 401, during: 'send' });
    expect(calls.auth.filter((a) => a.during === 'send')).toHaveLength(2);
    // a decision taken (the person signed in elsewhere and pressed again) takes the card away
    piece.inst.emit('decision', { outcome: 'approved', review: { verdict: 'approved' }, slug: '0002-checkout', source: 'pull/2', open: true });
    expect(card(root)).toBe(null);
    piece.destroy();
  });

  it('cornDecision is built from the event\'s own detail: the proposal that was decided on, not the one that is open now', async () => {
    const { piece, calls } = make({ src: BASE, proposal: '0002-checkout', source: 'pull/2' });
    await until(() => calls.ready === 1);
    const review = { verdict: 'notes', at: '2026-11-12T10:00:00Z', by: 'maintainer-one', posted: true };
    piece.inst.emit('decision', { outcome: 'notes', review, slug: '0001-elsewhere', source: 'pull/9', open: false });
    expect(calls.decision).toEqual([{ outcome: 'notes', proposal: '0001-elsewhere', source: 'pull/9', open: false, review }]);
    piece.destroy();
  });
});

describe('what a host hears of the open proposal (D6)', () => {
  it('onNavigate says what cornfield\'s page would put in its address bar: the name, the copy only when it was asked for by name, the view, and the change', async () => {
    const { piece, calls } = make({ src: BASE, proposal: '0002-checkout', source: 'pull/2' });
    await until(() => calls.ready === 1);
    expect(calls.navigate.at(-1)).toEqual({ proposal: '0002-checkout', source: 'pull/2', view: 'diff', change: 'opened' });
    piece.update({ view: 'after' });
    expect(calls.navigate.at(-1)).toEqual({ proposal: '0002-checkout', source: 'pull/2', view: 'after', change: 'view' });
    piece.update({ proposal: null });
    expect(calls.navigate.at(-1)).toEqual({ proposal: null, source: null, view: null, change: 'closed' });
    piece.destroy();
  });

  it('the same value again says nothing again (no echo of what the host just set)', async () => {
    const { piece, calls } = make({ src: BASE, proposal: '0002-checkout' });
    await until(() => calls.ready === 1);
    const n = calls.navigate.length;
    piece.update({ proposal: '0002-checkout' });
    piece.update({ proposal: '0002-checkout', view: 'diff' });
    await sleep(30);
    expect(calls.navigate).toHaveLength(n);
    piece.destroy();
  });
});

describe('the server\'s theme (D7)', () => {
  const THEME = ':root { --corn-accent: #123456; } [data-corn="source-title"] { letter-spacing: 3px; } body { display: none; }';

  it('with useTheme: the rules go into this shadow root, the tokens onto the host element, and nothing into the document', async () => {
    const srv = server({ theme: THEME });
    const { piece, root, host } = make({ src: BASE, proposal: '0002-checkout', useTheme: true }, srv);
    await until(() => host.style.getPropertyValue('--corn-accent') === '#123456');
    expect(root.adoptedStyleSheets.length).toBeGreaterThan(0);
    expect(document.adoptedStyleSheets.length).toBe(0);
    expect(document.head.querySelector('style')).toBe(null);
    const themeCall = srv.log.find((r) => r.path === '/cornfield/theme.css');
    expect(themeCall.credentials).toBe('omit');
    piece.update({ useTheme: false });
    await until(() => host.style.getPropertyValue('--corn-accent') === '');
    piece.destroy();
  });

  it('without it the theme is not asked for', async () => {
    const srv = server({ theme: THEME });
    const { piece, calls } = make({ src: BASE, proposal: '0002-checkout' }, srv);
    await until(() => calls.ready === 1);
    expect(srv.log.some((r) => r.path.startsWith('/cornfield/theme'))).toBe(false);
    piece.destroy();
  });
});

describe('what it leaves (D3)', () => {
  it('a review with a src, destroyed, leaves the host\'s shadow root and the document as they were', async () => {
    const before = document.body.innerHTML;
    const { piece, host, root } = make({ src: BASE, proposal: '0002-checkout' });
    await sleep(20);
    piece.destroy();
    expect(root.childElementCount).toBe(0);
    host.remove();
    expect(document.body.innerHTML).toBe(before);
  });

  it('destroyed before its loader is there, it makes nothing late', async () => {
    const { piece, root, srv } = make({ src: BASE, proposal: '0002-checkout' });
    piece.destroy();
    await sleep(60);
    expect(root.childElementCount).toBe(0);
    expect(srv.fetch).not.toHaveBeenCalled();
  });

  it('with no src it is what it was: no loader, no card, and nothing asked of any server', async () => {
    const fetch = vi.fn();
    const { piece, root } = make({ topology: topology(), proposal, fetch });
    await sleep(30);
    expect(fetch).not.toHaveBeenCalled();
    expect(root.querySelector('[data-corn="source-status"]')).toBe(null);
    piece.destroy();
  });
});

describe('what needs the Work panel is not there, and is not a button that does nothing (the review mounts no Work piece)', () => {
  it('the node panel has no Threads section, no Start a thread and no Start a run, and the bar has no Answer', async () => {
    const { piece, root, calls } = make({ src: BASE, proposal: '0002-checkout', source: 'pull/2' });
    await until(() => calls.ready === 1);
    const node = piece.inst.state.nodes.find((n) => n.mark === 'added') || piece.inst.state.nodes[0];
    piece.update({ node: node.id });
    await sleep(30);
    expect(root.querySelector('[data-thread-start], [data-thread-open]')).toBe(null);
    expect(root.querySelector('#drawer-threads').textContent.trim()).toBe('');
    expect(root.querySelector('#drawer-run-btn').closest('[hidden]')).not.toBe(null);
    expect(root.querySelector('[data-waiting-answer]')).toBe(null);
    // nobody answers the Work panel's asks, so none of them is true here
    expect(piece.inst.ask('work:on')).toBeUndefined();
    expect(piece.inst.ask('forge:can-start')).toBeUndefined();
    expect(piece.inst.ask('threads:index', node.id)).toBeUndefined();
    piece.destroy();
  });
});
