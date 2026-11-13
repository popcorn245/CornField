/**
 * <corn-proposal>, <corn-changes> and <corn-decision> beside a <corn-map> in one <corn-scope> that has a `proposal` (spec 0011 D4, D5, D6, D12), in headless Chrome against
 * a fake server (scripts/fake-cornfield.mjs): the scope holds and opens the proposal, the map narrows to it, each section is a shadow root of its own on the one instance, the
 * decision makes the requests <corn-review> makes, and the scope (not a section) tells the host what happened, once. The real server, the cookie, the CORS answers and a strict
 * Content-Security-Policy are held by test/fixtures/big/review-tags-proof.mjs.
 */
import axe from 'axe-core';
import { userEvent } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import { canvasOf, frames, pixelsOf, sleep } from './support';
import '../src/index';

type El = HTMLElement & { componentOnReady(): Promise<El>; proposal?: unknown; source?: string | null; view?: string | null; src?: string; node?: string | null };

const at = (name: string) => `${location.origin}/fake/${name}`;
const TYPES = ['cornReady', 'cornSelect', 'cornNavigate', 'cornDecision', 'cornAuth', 'cornError'];
const events: Array<{ type: string; detail: any; target: string }> = [];
const record = (e: Event) => events.push({ type: e.type, detail: (e as CustomEvent).detail, target: (e.target as HTMLElement).localName });
const calls: Array<{ url: string; credentials: string | undefined; method: string; body?: unknown }> = [];
const realFetch = globalThis.fetch;

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  events.length = 0;
  calls.length = 0;
  globalThis.fetch = realFetch;
  for (const t of TYPES) document.removeEventListener(t, record);
});
function listen() {
  for (const t of TYPES) document.addEventListener(t, record);
  if (globalThis.fetch !== realFetch) return;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input instanceof Request ? input.url : input), credentials: init?.credentials, method: init?.method || 'GET', body: init?.body });
    return realFetch(input, init);
  }) as typeof fetch;
}
async function until(fn: () => boolean, ms = 10_000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`); await sleep(40); } }
const seen = (type: string) => events.filter((e) => e.type === type);

const SECTIONS = '<corn-proposal id="bar"></corn-proposal><corn-changes id="list" style="height: 320px"></corn-changes><corn-decision id="foot"></corn-decision>';
/** The sketch of docs/embedding.md: a scope, the map, and the sections in the host's own layout */
async function compose(attrs = `src="${at('ok')}" proposal="0001-fake" source="pull/7"`, inner = `<corn-map renderer="canvas2d" style="height: 400px"></corn-map><aside style="width: 420px">${SECTIONS}</aside>`) {
  listen();
  const host = document.createElement('main');
  host.style.cssText = 'display: grid; grid-template-columns: 1fr 420px; gap: 8px; width: 1000px';
  host.innerHTML = `<corn-scope ${attrs} style="display: contents">${inner}</corn-scope>`;
  document.body.append(host);
  const scope = host.querySelector('corn-scope') as El;
  await Promise.all([...host.querySelectorAll('corn-scope, corn-map, corn-proposal, corn-changes, corn-decision')].map((el) => (el as El).componentOnReady()));
  const get = (sel: string) => host.querySelector(sel) as El;
  return { host, scope, map: host.querySelector('corn-map') as El, bar: get('corn-proposal'), list: get('corn-changes'), foot: get('corn-decision') };
}
const q = (el: Element, sel: string) => el.shadowRoot!.querySelector(sel) as HTMLElement | null;
const visible = (el: Element, sel: string) => { const x = q(el, sel); return !!x && !x.hidden && !x.closest('[hidden]'); };
const said = (el: Element) => (q(el, '[data-corn="empty"]')?.textContent || '').trim();
const opened = (t: { bar: El }) => visible(t.bar, '[data-corn="proposal-title"]');

describe('the scope holds the proposal for the sections', () => {
  it('opens it by the property: the bar, the list and the decision draw it, the map narrows, and the scope tells the host once', async () => {
    const t = await compose();
    const plain = pixelsOf(canvasOf(t.map));
    await until(() => opened(t) && visible(t.list, '[data-corn="row"]') && visible(t.foot, '[data-review="approved"]'));
    await frames(4);
    expect(q(t.bar, '[data-corn="proposal-title"]')!.textContent).toBe('A fake change');
    expect(pixelsOf(canvasOf(t.map))).not.toEqual(plain);
    expect(seen('cornNavigate')).toHaveLength(1);
    expect(seen('cornNavigate')[0]).toMatchObject({ target: 'corn-scope', detail: { proposal: '0001-fake', source: 'pull/7', view: 'diff', change: 'opened' } });
    expect((t.scope as El).view).toBe('diff'); // the scope's view follows (reflected)
    expect(t.scope.getAttribute('view')).toBe('diff');
  });

  it('Before, Diff and After on the bar change the map, the scope\'s `view` follows, and the host hears each change once, from the scope', async () => {
    const t = await compose();
    await until(() => opened(t));
    await frames(4);
    const diff = pixelsOf(canvasOf(t.map));
    const choose = async (view: string) => {
      if (!visible(t.bar, `[data-view="${view}"]`)) q(t.bar, '[data-action="toggle-proposal-mode"]')!.click();
      q(t.bar, `[data-view="${view}"]`)!.click();
      await frames(3);
    };
    await choose('before');
    expect(t.scope.getAttribute('view')).toBe('before');
    expect(pixelsOf(canvasOf(t.map))).not.toEqual(diff);
    await choose('after');
    expect(t.scope.getAttribute('view')).toBe('after');
    expect(seen('cornNavigate').map((e) => `${e.detail.change}:${e.detail.view}`)).toEqual(['opened:diff', 'view:before', 'view:after']);
    expect(seen('cornNavigate').every((e) => e.target === 'corn-scope')).toBe(true);
    // the host sets it by property: the bar follows, and the property handed back says nothing more
    (t.scope as El).view = 'diff';
    await frames(3);
    expect(q(t.bar, '[data-view="diff"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(seen('cornNavigate').map((e) => e.detail.view)).toEqual(['diff', 'before', 'after', 'diff']);
  });

  it('a change selected in the list selects on the map and fills a node panel in the scope', async () => {
    const t = await compose(undefined, `<corn-map renderer="canvas2d" style="height: 400px"></corn-map><aside style="width: 420px">${SECTIONS}<corn-node-panel style="height: 260px"></corn-node-panel></aside>`);
    await until(() => visible(t.list, '[data-corn="row"]'));
    const panel = t.host.querySelector('corn-node-panel') as El;
    await panel.componentOnReady();
    const row = q(t.list, '[data-action="proposal-focus"][data-kind="node"]')!;
    row.click();
    await frames(4);
    expect(t.map.getAttribute('node')).toBe(row.dataset.key);
    await until(() => !!q(panel, '[data-corn="node-title"]')?.textContent);
    expect(seen('cornSelect').map((e) => e.target)).toEqual(['corn-map']);
  });

  it('a box too short for the list and the player cuts neither: the player keeps its controls, the column scrolls to the rest, and only to what it holds', async () => {
    const t = await compose();
    await until(() => visible(t.list, '[data-action="scenario-open"]'));
    q(t.list, '[data-action="scenario-open"]')!.click();
    await until(() => visible(t.list, '[data-action="scenario-step"]'));
    q(t.list, '[data-action="scenario-step"]')!.click();
    await until(() => visible(t.list, '.hx-player-controls'));
    const column = q(t.list, '[data-corn="review-column"]')!;
    for (const height of [90, 160, 320, 600]) {
      t.list.style.height = `${height}px`;
      await frames(3);
      const controls = q(t.list, '.hx-player-controls')!.getBoundingClientRect();
      expect(controls.height, `${height}px`).toBeGreaterThan(30);
      // what the column holds past its box is reachable: it scrolls to it (never to words for a screen reader alone, which the lists hold)
      const content = q(t.list, '.hx-rc-scroll')!.offsetHeight + q(t.list, '.hx-player-seat')!.offsetHeight;
      expect(column.scrollHeight, `${height}px`).toBeLessThanOrEqual(Math.max(column.clientHeight, content) + 1);
      q(t.list, '.hx-player-controls')!.scrollIntoView({ block: 'nearest' }); // as the focus going to Play would
      await frames(1);
      const box = column.getBoundingClientRect();
      expect(Math.round(q(t.list, '.hx-player-controls')!.getBoundingClientRect().bottom), `${height}px`).toBeLessThanOrEqual(Math.round(box.bottom) + 1);
      expect(Math.round(q(t.list, '.hx-player-controls')!.getBoundingClientRect().top), `${height}px`).toBeGreaterThanOrEqual(Math.round(box.top) - 1);
      column.scrollTop = 0;
    }
  });

  it('closes by the bar\'s Close, and by the property, and says closed once; the sections empty, the map plain, the same name asked for again opens it', async () => {
    const t = await compose();
    await until(() => opened(t));
    q(t.bar, '[data-action="toggle-proposal-more"]')!.click();
    q(t.bar, '[data-action="close-proposal"]')!.click();
    await until(() => !opened(t));
    expect(seen('cornNavigate').map((e) => e.detail.change)).toEqual(['opened', 'closed']);
    expect((t.scope as El).proposal).toBe(null);
    expect(visible(t.list, '[data-corn="row"]')).toBe(false);
    expect(visible(t.foot, '[data-review="approved"]')).toBe(false);
    expect(t.map.shadowRoot!.activeElement).toBe(canvasOf(t.map)); // the bar is gone: the focus is on the map, not on the page
    (t.scope as El).proposal = '0001-fake';
    await until(() => opened(t));
    expect(seen('cornNavigate').map((e) => e.detail.change)).toEqual(['opened', 'closed', 'opened']);
  });

  it('a proposal asked for before the map is there waits for it, and a map put back in the scope shows it again', async () => {
    const t = await compose(undefined, `<aside style="width: 420px">${SECTIONS}</aside>`);
    await frames(3);
    expect(said(t.bar)).toBe('This needs a corn-map in the same corn-scope');
    expect(calls.filter((c) => /proposals\/0001-fake\.json/.test(c.url))).toEqual([]); // nobody asked yet
    const map = document.createElement('corn-map');
    map.setAttribute('renderer', 'canvas2d');
    map.setAttribute('style', 'height: 300px');
    t.scope.prepend(map);
    await until(() => opened(t));
    expect(calls.filter((c) => /proposals\/0001-fake\.json/.test(c.url))).toHaveLength(1);
    map.remove();
    await until(() => !opened(t));
    expect(said(t.bar)).toBe('This needs a corn-map in the same corn-scope');
  });
});

describe('each section alone, with no scope, with no map and doubled', () => {
  it('with no scope each says so and asks nobody for anything', async () => {
    listen();
    document.body.innerHTML = SECTIONS;
    await Promise.all([...document.querySelectorAll('corn-proposal, corn-changes, corn-decision')].map((el) => (el as El).componentOnReady()));
    await frames(2);
    for (const el of document.querySelectorAll('corn-proposal, corn-changes, corn-decision')) expect(said(el), el.localName).toBe('This needs a corn-scope around it, with a corn-map in it');
    expect(calls).toEqual([]);
  });

  it('<corn-decision> beside a map and no other section decides; so does <corn-proposal> and so does <corn-changes>', async () => {
    const decision = await compose(undefined, '<corn-map renderer="canvas2d" style="height: 300px"></corn-map><corn-decision id="foot"></corn-decision>');
    await until(() => visible(decision.foot, '[data-review="approved"]') && /Approve/.test(q(decision.foot, '[data-review-line]')?.textContent || '')); // (the line says "Reading PR #7 …" until the facts come)
    document.body.innerHTML = '';
    const bar = await compose(undefined, '<corn-map renderer="canvas2d" style="height: 300px"></corn-map><corn-proposal></corn-proposal>');
    await until(() => opened(bar));
    document.body.innerHTML = '';
    const list = await compose(undefined, '<corn-map renderer="canvas2d" style="height: 300px"></corn-map><corn-changes></corn-changes>');
    await until(() => visible(list.list, '[data-corn="row"]'));
    q(list.list, '[data-action="proposal-focus"][data-kind="node"]')!.click();
    await frames(3);
    expect(list.map.getAttribute('node')).toBeTruthy();
  });

  it('a second of a section says so, tells the host once (cornError second-piece, from the scope), and takes over when the first leaves', async () => {
    const t = await compose();
    await until(() => visible(t.foot, '[data-review="approved"]'));
    const second = document.createElement('corn-decision');
    t.host.querySelector('aside')!.append(second);
    await (second as El).componentOnReady();
    await until(() => said(second) === 'This scope already has one of these');
    expect(q(second, '[data-review="approved"]')).toBe(null);
    expect(seen('cornError').filter((e) => e.detail.kind === 'second-piece')).toHaveLength(1);
    expect(seen('cornError')[0].target).toBe('corn-scope');
    t.foot.remove();
    await until(() => visible(second, '[data-review="approved"]'));
    expect(said(second)).toBe('');
  });
});

describe('the decision', () => {
  it('Approve: the hold with Undo, then one PUT of what was on screen, and cornDecision once, from the scope', async () => {
    const t = await compose();
    await until(() => visible(t.foot, '[data-review="approved"]') && !q(t.foot, '[data-review="approved"]')!.hasAttribute('disabled') && /Approve/.test(q(t.foot, '[data-review-line]')?.textContent || ''));
    await fetch('/fake/reviews.json');
    q(t.foot, '[data-review="approved"]')!.click();
    await until(() => !q(t.foot, '[data-review-undo]')!.hidden);
    expect(t.foot.shadowRoot!.activeElement).toBe(q(t.foot, '[data-review-undo]'));
    expect(seen('cornDecision')).toHaveLength(0); // said after the answer, never before
    await until(() => seen('cornDecision').length > 0, 12_000);
    expect(seen('cornDecision')).toHaveLength(1);
    expect(seen('cornDecision')[0]).toMatchObject({ target: 'corn-scope', detail: { outcome: 'approved', proposal: '0001-fake', source: 'pull/7', open: true, review: { verdict: 'approved', by: 'maintainer-one' } } });
    const puts = (await (await fetch('/fake/reviews.json')).json()) as Array<{ url: string; body: any }>;
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toBe('/fake/ok/proposals/0001-fake/review?source=pull%2F7');
    expect(puts[0].body).toMatchObject({ verdict: 'approved', sha256: 'a'.repeat(63) + 'b' });
    expect(calls.find((c) => c.method === 'PUT')!.credentials).toBe('include');
  }, 30_000);

  it('makes the request <corn-review> makes for the same steps: the same address, the same body, the same credentials', async () => {
    // the section's decision first
    const t = await compose();
    await until(() => visible(t.foot, '[data-review="approved"]') && !q(t.foot, '[data-review="approved"]')!.hasAttribute('disabled') && /Approve/.test(q(t.foot, '[data-review-line]')?.textContent || ''));
    await fetch('/fake/reviews.json');
    q(t.foot, '[data-review="notes"]')!.click();
    await frames(2);
    expect(t.foot.shadowRoot!.activeElement).toBe(q(t.foot, '#review-note'));
    await userEvent.keyboard('Name the owner first.');
    q(t.foot, '[data-review="notes"]')!.click();
    await until(() => seen('cornDecision').length > 0, 12_000);
    const sections = (await (await fetch('/fake/reviews.json')).json()) as Array<{ url: string; body: any }>;
    const sectionPut = calls.find((c) => c.method === 'PUT')!;
    // and the one-tag review's
    document.body.innerHTML = '';
    events.length = 0;
    calls.length = 0;
    const host = document.createElement('main');
    host.innerHTML = `<div style="width: 1100px; height: 680px"><corn-review src="${at('ok')}" proposal="0001-fake" source="pull/7"></corn-review></div>`;
    document.body.append(host);
    const review = host.querySelector('corn-review') as El;
    await review.componentOnReady();
    await until(() => seen('cornReady').length > 0);
    await until(() => !q(review, '[data-review="notes"]')!.hasAttribute('disabled'));
    q(review, '[data-review="notes"]')!.click();
    await frames(2);
    await userEvent.keyboard('Name the owner first.');
    q(review, '[data-review="notes"]')!.click();
    await until(() => seen('cornDecision').length > 0, 12_000);
    const reviews = (await (await fetch('/fake/reviews.json')).json()) as Array<{ url: string; body: any }>;
    const reviewPut = calls.find((c) => c.method === 'PUT')!;
    expect(sections).toHaveLength(1);
    expect(reviews).toHaveLength(1);
    expect(sections[0]).toEqual(reviews[0]);
    expect({ url: sectionPut.url, credentials: sectionPut.credentials, body: sectionPut.body }).toEqual({ url: reviewPut.url, credentials: reviewPut.credentials, body: reviewPut.body });
  }, 40_000);

  it('a decision read the server refuses (a session that ended while the page was open): one cornAuth from the scope saying what was refused, and the card with the link in the decision', async () => {
    const t = await compose(`src="${at('expired')}" proposal="0001-fake" source="pull/7"`);
    await until(() => seen('cornAuth').length > 0);
    expect(['facts', 'review']).toContain(seen('cornAuth')[0].detail.during);
    expect(seen('cornAuth')[0]).toMatchObject({ target: 'corn-scope', detail: { status: 401, signIn: expect.stringContaining('/auth/start?returnTo=') } });
    await until(() => visible(t.foot, '[data-corn="source-sign-in"]'));
    expect(q(t.foot, '[data-corn="source-sign-in"]')!.getAttribute('href')).toBe(seen('cornAuth')[0].detail.signIn);
    expect(q(t.foot, '[data-corn="source-title"]')!.textContent).toMatch(/not signed in/);
    expect(visible(t.bar, '[data-corn="source-sign-in"]')).toBe(false); // the bar opened the proposal: the card is where the refusal was
    expect(q(t.bar, '[data-corn="proposal-title"]')!.textContent).toBe('A fake change'); // and the proposal is still there under it
    expect(seen('cornDecision')).toHaveLength(0);
  }, 30_000);

  it('signed out: the map\'s card says it once, the sections wait for the map, and the host hears one cornAuth {during: load}', async () => {
    const t = await compose(`src="${at('auth')}" proposal="0001-fake" source="pull/7"`);
    await until(() => seen('cornAuth').length > 0);
    await frames(3);
    expect(seen('cornAuth')).toHaveLength(1);
    expect(seen('cornAuth')[0]).toMatchObject({ target: 'corn-scope', detail: { status: 401, during: 'load' } });
    for (const el of [t.bar, t.list, t.foot]) expect(said(el), el.localName).toBe('Waiting for the map');
    expect(visible(t.map, '[data-corn="source-sign-in"]')).toBe(true);
    expect(calls.filter((c) => /proposals\//.test(c.url))).toEqual([]);
  });
});

describe('the keyboard, the page and the machine', () => {
  it('Tab goes through the sections in the host\'s order, and Escape in the note and in the ⋯ menu stays in the section', async () => {
    const t = await compose();
    await until(() => visible(t.foot, '[data-review="approved"]'));
    const first = q(t.bar, '[data-action="toggle-proposal-more"]')!;
    first.focus();
    await userEvent.keyboard('{Enter}');
    expect(visible(t.bar, '[data-corn="proposal-menu"]')).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(visible(t.bar, '[data-corn="proposal-menu"]')).toBe(false);
    expect(t.bar.shadowRoot!.activeElement).toBe(first);
    q(t.foot, '[data-review="notes"]')!.focus();
    await userEvent.keyboard('{Enter}');
    expect(t.foot.shadowRoot!.activeElement).toBe(q(t.foot, '#review-note'));
    await userEvent.keyboard('{Escape}');
    expect(t.foot.shadowRoot!.activeElement).toBe(q(t.foot, '[data-review="notes"]'));
    // Tab from the bar's last control comes into the list, and from the list into the decision
    q(t.bar, '[data-action="toggle-proposal-more"]')!.focus();
    const order: string[] = [];
    for (let i = 0; i < 60; i++) {
      await userEvent.tab();
      const at = [t.bar, t.list, t.foot].find((el) => el.shadowRoot!.activeElement);
      if (at) order.push(at.localName);
      if (at === t.foot && order.filter((x) => x === 'corn-decision').length > 1) break;
    }
    expect(order.indexOf('corn-changes')).toBeGreaterThan(-1);
    expect(order.indexOf('corn-decision')).toBeGreaterThan(order.indexOf('corn-changes'));
  });

  it('the ⋯ menu closes on a click anywhere else in the page (the map, the host\'s own page, another section), as on cornfield\'s page', async () => {
    const t = await compose();
    await until(() => visible(t.foot, '[data-review="approved"]'));
    const more = q(t.bar, '[data-action="toggle-proposal-more"]')!;
    const menuOpen = () => visible(t.bar, '[data-corn="proposal-menu"]');
    for (const outside of [() => t.host.click(), () => canvasOf(t.map).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })), () => q(t.list, '[data-corn="row"]')!.click()]) {
      more.click();
      expect(menuOpen()).toBe(true);
      outside();
      expect(menuOpen()).toBe(false);
    }
  });

  it('keeps its styles in its own roots: nothing added to the host\'s head but the default tokens, and no `<style>` in a section', async () => {
    const before = document.head.querySelectorAll('style').length;
    const t = await compose();
    await until(() => visible(t.foot, '[data-review="approved"]'));
    for (const el of [t.bar, t.list, t.foot]) expect(el.shadowRoot!.querySelectorAll('style').length, el.localName).toBe(0);
    expect(document.head.querySelectorAll('style').length).toBeLessThanOrEqual(before + 1);
  });

  it('axe finds nothing on the composed page, light and dark, with the proposal open', async () => {
    const t = await compose();
    await until(() => visible(t.foot, '[data-review="approved"]') && visible(t.list, '[data-corn="row"]'));
    for (const theme of ['light', 'dark']) {
      t.scope.setAttribute('theme', theme);
      document.body.style.background = theme === 'dark' ? '#0f172a' : '#ffffff';
      await frames(4);
      const result = await axe.run(document.body, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
      expect(result.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`)), theme).toEqual([]);
    }
    document.body.style.background = '';
  }, 30_000);
});
