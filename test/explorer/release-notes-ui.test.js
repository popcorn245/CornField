// @vitest-environment happy-dom
/**
 * The Release notes view of the issues and PRs panel (PIPE-04, explorer/forge-panel.js), through the page's own markup
 * (explorer/index.html) with a fake server behind `fetch`: the third tab drafts the notes and shows them as Markdown
 * to preview; Copy uses the clipboard, else selects the text for the person to copy; "Post as draft" asks first (the
 * tag, and in words what will and will not happen) and only then sends ONE POST with the tag and nothing of the notes
 * themselves; a refusal is a line in the server's words; everything is said through the map's live region. No network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { setMap } from '../../explorer/view.js';
// @ts-expect-error plain JS modules, no declarations
import { initForgePanel, resetForgePanelForTests, openForge, closeForge, refreshForge } from '../../explorer/forge-panel.js';
// @ts-expect-error plain JS modules, no declarations
import { initKeyboard, resetKeyboardForTests } from '../../explorer/keyboard.js';
// @ts-expect-error plain JS modules, no declarations
import { initSheets } from '../../explorer/sheets.js';
// @ts-expect-error plain JS modules, no declarations
import { closeDrawer } from '../../explorer/panels.js';

const page = fs.readFileSync(path.resolve(__dirname, '../../explorer/index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');

const MAP = { nodes: [{ id: 'root', type: 'root', x: 0, y: 0, r: 20, color: '#336699', label: 'root', degree: 0 }], edges: [] };
const MARKDOWN = '### server\n\n- Meals page ([#12](https://git.example.test/owner/name/pull/12) by @agent-four) · `meals.js`\n\n### Other\n\n- Typo ([#13](https://git.example.test/owner/name/pull/13) by @maintainer-one)\n';
const NOTES = {
  ok: true, forge: 'github', repo: 'owner/name', at: '2026-10-19T11:58:00.000Z', rate: '48 of 5000 GitHub calls left.',
  since: { name: 'v0.2.0', date: '2026-10-12T09:00:00Z' }, tags: ['v0.2.0', 'v0.1.0'], suggestedTag: 'v0.3.0', breakingLabel: 'breaking',
  count: 2, truncated: false, markdown: MARKDOWN,
  groups: [{ kind: 'area', id: 'pkg-server', title: 'server', items: [{ number: 12 }] }, { kind: 'other', id: 'other', title: 'Other', items: [{ number: 13 }] }],
};

const $ = (id) => document.getElementById(id);
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (el, k) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e; };
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const said = async () => { await new Promise((r) => setTimeout(r, 50)); return $('map-announcer').textContent; };

/** A fake server behind `fetch`: the notes, the one POST, and a record of every call */
function fakeServer({ notes = NOTES, post } = {}) {
  const calls = [];
  const json = (status, data) => ({ ok: status < 400, status, headers: new Headers(), json: async () => data });
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url, 'http://localhost');
    if (u.pathname === '/api/forge/release-notes') return typeof notes === 'function' ? notes(u) : json(200, notes);
    if (u.pathname === '/api/forge/release-drafts') return post ? post(init) : json(201, { ok: true, forge: 'github', repo: 'owner/name', count: 2, release: { id: '7001', url: 'https://git.example.test/owner/name/releases/tag/untagged-7001', draft: true, tag: 'v0.3.0', name: 'v0.3.0' } });
    return json(404, { ok: false, error: 'No.' });
  }));
  return { calls, posts: () => calls.filter((c) => c.init.method === 'POST'), urls: () => calls.map((c) => c.url) };
}
const ok = (data) => ({ ok: true, status: 200, headers: new Headers(), json: async () => data });

function mount() {
  document.body.innerHTML = body;
  document.documentElement.lang = 'en';
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (t) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas = $('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  Object.assign(state, { canvas, ctx, labelCanvas: null, proposal: null, view: 'orbit', selectedNode: null, isFreeform: false, scenario: null, searchQuery: '', forgeLit: null });
  state.camera = { x: 0, y: 0, zoom: 1 };
  render.resize();
  state.baseNodes = MAP.nodes.map((n) => ({ ...n }));
  state.baseEdges = MAP.edges;
  setMap(MAP.nodes.map((n) => ({ ...n })), MAP.edges);
  resetKeyboardForTests();
  initKeyboard();
  initSheets();
  resetForgePanelForTests(() => Date.parse('2026-10-19T12:00:00Z'));
  return initForgePanel({ forge: { type: 'github', url: 'https://github.com', repo: 'owner/name' }, signIn: { login: 'maintainer-one' } });
}

/** The panel open on the Release notes tab, the draft loaded */
async function openNotes(server) {
  expect(mount()).toBe(true);
  openForge();
  await settle();
  click(document.querySelector('[data-forge-kind="notes"]'));
  await settle();
  expect(server.urls().at(-1)).toBe('/api/forge/release-notes');
}

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); });
afterEach(() => { closeForge({ restoreFocus: false }); closeDrawer(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('the Release notes tab', () => {
  it('drafts the notes when it is chosen: the Markdown to read, a line about it, the tags to start from, the filters gone', async () => {
    const server = fakeServer();
    expect(mount()).toBe(true);
    openForge();
    await settle();
    const tab = document.querySelector('[data-forge-kind="notes"]');
    expect(tab.textContent).toBe('Release notes');
    expect(tab.getAttribute('aria-pressed')).toBe('false');
    expect(server.urls()).toEqual(['/api/forge/pulls?state=open&limit=100']); // nothing is asked of the notes until the tab is chosen
    click(tab);
    await settle();
    expect(server.urls().at(-1)).toBe('/api/forge/release-notes');
    expect(tab.getAttribute('aria-pressed')).toBe('true');
    expect($('forge-notes').hidden).toBe(false);
    expect($('forge-filters').hidden).toBe(true);
    expect($('forge-list').hidden).toBe(true);
    expect($('notes-preview').value).toBe(MARKDOWN);
    expect($('notes-preview').readOnly).toBe(true);
    expect($('forge-status').textContent).toBe('2 pull requests merged since v0.2.0 (2026-10-12), in 2 groups.');
    expect([...$('notes-since').options].map((o) => [o.value, o.textContent])).toEqual([['', 'Latest tag (v0.2.0)'], ['v0.2.0', 'v0.2.0'], ['v0.1.0', 'v0.1.0']]);
    expect($('forge-rate').textContent).toBe('48 of 5000 GitHub calls left.');
    expect(await said()).toBe('Release notes drafted. 2 pull requests merged since v0.2.0 (2026-10-12), in 2 groups.');
    expect(server.posts()).toEqual([]);
  });

  it('opens on the notes tab straight away if that is where it was left, and goes back to the lists without losing them', async () => {
    const server = fakeServer();
    await openNotes(server);
    click(document.querySelector('[data-forge-kind="pulls"]'));
    await settle();
    expect($('forge-notes').hidden).toBe(true);
    expect($('forge-list').hidden).toBe(false);
    expect($('forge-filters').hidden).toBe(false);
    const asked = server.calls.length;
    click(document.querySelector('[data-forge-kind="notes"]'));
    await settle();
    expect(server.calls).toHaveLength(asked); // the draft is kept
    expect($('notes-preview').value).toBe(MARKDOWN);
    closeForge();
    openForge();
    await settle();
    expect($('forge-notes').hidden).toBe(false);
    expect(server.calls).toHaveLength(asked);
  });

  it('starts from another tag when one is chosen, and the select keeps the focus', async () => {
    const server = fakeServer();
    await openNotes(server);
    $('notes-since').focus();
    $('notes-since').value = 'v0.1.0';
    $('notes-since').dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(server.urls().at(-1)).toBe('/api/forge/release-notes?since=v0.1.0');
    expect($('notes-since').value).toBe('v0.1.0');
    expect(document.activeElement).toBe($('notes-since'));
  });

  it('says a failure in the server\'s words, and Refresh asks past the cache', async () => {
    const server = fakeServer({ notes: () => ({ ok: false, status: 404, headers: new Headers(), json: async () => ({ ok: false, error: 'owner/name has no tag named "v9.9.9".', code: 'not-found' }) }) });
    await openNotes(server);
    expect($('forge-notice').hidden).toBe(false);
    expect($('forge-notice').textContent).toBe('owner/name has no tag named "v9.9.9".');
    expect($('notes-copy').disabled).toBe(true);
    expect($('notes-post').disabled).toBe(true);
    await refreshForge();
    expect(server.calls.at(-1).init).toEqual({ cache: 'reload' });
  });

  it('says an older answer is old, and an empty draft is empty', async () => {
    const server = fakeServer({ notes: () => ok({ ...NOTES, stale: 'GitHub asked cornfield to slow down; try again in 40 seconds.', count: 0, groups: [], markdown: 'No pull requests were merged since v0.2.0.\n' }) });
    await openNotes(server);
    expect($('forge-notice').textContent).toBe('Showing an older answer. GitHub asked cornfield to slow down; try again in 40 seconds.');
    expect($('forge-status').textContent).toBe('No pull requests merged since v0.2.0 (2026-10-12).');
    click($('notes-post'));
    await settle();
    expect($('notes-confirm').hidden).toBe(true);
    expect($('notes-message').textContent).toBe('There are no merged pull requests to put in a draft.');
    expect(server.posts()).toEqual([]);
  });
});

describe('Copy', () => {
  it('uses the clipboard and says so', async () => {
    const server = fakeServer();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await openNotes(server);
    click($('notes-copy'));
    await settle();
    expect(writeText).toHaveBeenCalledWith(MARKDOWN);
    expect($('notes-message').textContent).toBe('Copied the release notes.');
    expect(await said()).toBe('Copied the release notes.');
  });

  it('selects the text and copies it the old way when there is no clipboard', async () => {
    const server = fakeServer();
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    await openNotes(server);
    click($('notes-copy'));
    await settle();
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.activeElement).toBe($('notes-preview'));
    expect($('notes-message').textContent).toBe('Copied the release notes.');
  });

  it('leaves the draft selected and says how to copy it when both are blocked', async () => {
    const server = fakeServer();
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error('blocked'); }) } });
    document.execCommand = vi.fn(() => false);
    await openNotes(server);
    click($('notes-copy'));
    await settle();
    expect($('notes-message').textContent).toBe('Copying was blocked. The draft is selected: press Ctrl+C, or Command+C on a Mac.');
    expect($('notes-message').classList.contains('hx-forge-msg--bad')).toBe(true);
    expect(document.activeElement).toBe($('notes-preview'));
    expect(await said()).toBe('Copying was blocked. The draft is selected: press Ctrl+C, or Command+C on a Mac.');
  });
});

describe('Post as draft', () => {
  it('asks first: nothing is sent until the draft is confirmed, and the confirm says what will and will not happen', async () => {
    const server = fakeServer();
    await openNotes(server);
    const button = $('notes-post');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect($('notes-confirm').hidden).toBe(true);
    click(button);
    await settle();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect($('notes-confirm').hidden).toBe(false);
    expect($('notes-confirm').getAttribute('role')).toBe('group');
    expect($('notes-confirm-words').textContent).toBe('This creates a draft release on GitHub for owner/name, with the notes of 2 pull requests. It stays a draft: nothing is published and no tag is made. Publishing it is done on GitHub.');
    expect($('notes-tag').value).toBe('v0.3.0');
    expect(document.activeElement).toBe($('notes-tag'));
    expect(server.posts()).toEqual([]);
    expect(await said()).toBe('Post as a draft release. Check the tag, then create the draft.');
  });

  it('sends one POST with the tag and nothing of the notes, then says the draft is there with a link to it', async () => {
    const server = fakeServer();
    await openNotes(server);
    click($('notes-post'));
    await settle();
    $('notes-tag').value = ' v0.3.1 ';
    click($('notes-confirm-yes'));
    await settle();
    expect(server.posts()).toHaveLength(1);
    const [post] = server.posts();
    expect(post.url).toBe('/api/forge/release-drafts');
    expect(post.init.method).toBe('POST');
    expect(post.init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(post.init.body)).toEqual({ tag: 'v0.3.1' });
    expect($('notes-confirm').hidden).toBe(true);
    expect($('notes-post').getAttribute('aria-expanded')).toBe('false');
    expect($('notes-message').textContent).toBe('Draft release v0.3.1 created on GitHub, with 2 pull requests. It is not published. Open the draft on GitHub (new tab)');
    const link = $('notes-message').querySelector('a');
    expect(link.href).toBe('https://git.example.test/owner/name/releases/tag/untagged-7001');
    expect(link.rel).toBe('noreferrer');
    expect(document.activeElement).toBe($('notes-post'));
    expect(await said()).toBe('Draft release v0.3.1 created on GitHub, with 2 pull requests. It is not published.');
  });

  it('starts from the tag chosen, and Enter in the tag field creates the draft', async () => {
    const server = fakeServer();
    await openNotes(server);
    $('notes-since').value = 'v0.1.0';
    $('notes-since').dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    click($('notes-post'));
    await settle();
    expect(key($('notes-tag'), 'Enter').defaultPrevented).toBe(true);
    await settle();
    expect(server.posts().map((p) => JSON.parse(p.init.body))).toEqual([{ tag: 'v0.3.0', since: 'v0.1.0' }]);
  });

  it('is sent once however many times the button is pressed', async () => {
    let release;
    const server = fakeServer({ post: () => new Promise((resolve) => { release = () => resolve({ ok: true, status: 201, headers: new Headers(), json: async () => ({ ok: true, count: 2, release: { url: 'https://git.example.test/r/1', draft: true } }) }); }) });
    await openNotes(server);
    click($('notes-post'));
    await settle();
    click($('notes-confirm-yes'));
    click($('notes-confirm-yes'));
    key($('notes-tag'), 'Enter');
    await settle();
    expect($('notes-confirm-yes').textContent).toBe('Creating …');
    expect(server.posts()).toHaveLength(1);
    release();
    await settle();
    expect(server.posts()).toHaveLength(1);
  });

  it('Cancel, or Escape inside the confirm, sends nothing and gives the focus back; the panel stays open', async () => {
    const server = fakeServer();
    await openNotes(server);
    click($('notes-post'));
    await settle();
    click(document.querySelector('[data-action="cancel-notes"]'));
    await settle();
    expect($('notes-confirm').hidden).toBe(true);
    expect(document.activeElement).toBe($('notes-post'));
    expect(await said()).toBe('Cancelled. Nothing was posted.');
    click($('notes-post'));
    await settle();
    key($('notes-tag'), 'Escape');
    expect($('notes-confirm').hidden).toBe(true);
    expect(document.activeElement).toBe($('notes-post'));
    expect($('forge-panel').classList.contains('forge-open')).toBe(true);
    key($('notes-post'), 'Escape'); // outside the confirm, Escape closes the panel as it always did
    expect($('forge-panel').classList.contains('forge-open')).toBe(false);
    expect(server.posts()).toEqual([]);
  });

  it('will not send a tag that is not a tag name, and says so', async () => {
    const server = fakeServer();
    await openNotes(server);
    click($('notes-post'));
    await settle();
    for (const bad of ['', 'v 1', '../x', '-x']) {
      $('notes-tag').value = bad;
      click($('notes-confirm-yes'));
      await settle();
      expect($('notes-message').textContent, JSON.stringify(bad)).toBe('Give the tag the draft is for, like v0.2.0: letters, digits, dots, dashes and slashes, no spaces.');
      expect(document.activeElement).toBe($('notes-tag'));
    }
    expect(server.posts()).toEqual([]);
  });

  it('keeps the confirm open and says the server\'s words when it refuses, and when it cannot be reached', async () => {
    const refused = { ok: false, status: 403, headers: new Headers(), json: async () => ({ ok: false, error: 'maintainer-one does not maintain owner/name on GitHub (any more), so cornfield will not post for them.', code: 'forbidden' }) };
    const server = fakeServer({ post: () => refused });
    await openNotes(server);
    click($('notes-post'));
    await settle();
    click($('notes-confirm-yes'));
    await settle();
    expect($('notes-message').textContent).toBe('maintainer-one does not maintain owner/name on GitHub (any more), so cornfield will not post for them.');
    expect($('notes-message').classList.contains('hx-forge-msg--bad')).toBe(true);
    expect($('notes-confirm').hidden).toBe(false);
    expect(document.activeElement).toBe($('notes-tag'));
    expect($('notes-confirm-yes').textContent).toBe('Create the draft');
    expect(await said()).toContain('does not maintain owner/name');

    vi.stubGlobal('fetch', vi.fn(async (url) => { if (String(url).includes('release-drafts')) throw new TypeError('Failed to fetch'); return ok(NOTES); }));
    click($('notes-confirm-yes'));
    await settle();
    expect($('notes-message').textContent).toBe('cornfield could not be reached; check that it is still running, then refresh.');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, headers: new Headers(), json: async () => ({ ok: false, error: 'Not signed in.' }) })));
    click($('notes-confirm-yes'));
    await settle();
    expect($('notes-message').textContent).toBe('Your sign-in has ended. Sign in again to post a draft.');
  });

  it('shows no link for an address that is not the forge\'s web address', async () => {
    const server = fakeServer({ post: () => ({ ok: true, status: 201, headers: new Headers(), json: async () => ({ ok: true, count: 2, release: { url: 'javascript:alert(1)', draft: true } }) }) });
    await openNotes(server);
    click($('notes-post'));
    await settle();
    click($('notes-confirm-yes'));
    await settle();
    expect($('notes-message').textContent).toContain('Draft release v0.3.0 created');
    expect($('notes-message').querySelector('a')).toBeNull();
  });

  it('closes the confirm when the draft is loaded again, so what was confirmed is what is on screen', async () => {
    const server = fakeServer();
    await openNotes(server);
    click($('notes-post'));
    await settle();
    expect($('notes-confirm').hidden).toBe(false);
    await refreshForge();
    expect($('notes-confirm').hidden).toBe(true);
    expect(server.posts()).toEqual([]);
  });
});
