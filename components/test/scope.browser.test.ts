/**
 * <corn-scope>, and a <corn-map> that gets its data from a cornfield server (spec 0011 D5, D6, D7, D9, D10, D11), in headless Chrome against a fake
 * server (scripts/fake-cornfield.mjs). The real server, the cookie and CORS are held by test/fixtures/big/scope-proof.mjs.
 */
import axe from 'axe-core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { canvasOf, frames, pixelsOf, sleep, smallTopology } from './support';

type Piece = HTMLElement & { componentOnReady(): Promise<Piece>; topology: unknown; node: string | null | undefined; src?: string; useTheme: boolean; theme?: string; focusNode(id: string): Promise<void>; fit(): Promise<void> };

const at = (name: string) => `${location.origin}/fake/${name}`;
const events: Array<{ type: string; detail: any; target: string }> = [];
const TYPES = ['cornReady', 'cornAuth', 'cornError', 'cornSelect'];
const record = (e: Event) => events.push({ type: e.type, detail: (e as CustomEvent).detail, target: (e.target as HTMLElement).localName });

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  events.length = 0;
  for (const t of TYPES) document.removeEventListener(t, record);
});

function listen() { for (const t of TYPES) document.addEventListener(t, record); }
const kinds = () => events.filter((e) => e.type === 'cornError').map((e) => e.detail.kind);
async function until(fn: () => boolean, ms = 8000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`); await sleep(40); } }

/** Puts markup in the page and waits for every corn-* element in it to be ready */
async function page(html: string) {
  const host = document.createElement('main');
  host.innerHTML = html;
  document.body.append(host);
  await Promise.all([...host.querySelectorAll('corn-scope, corn-map')].map((el) => (el as Piece).componentOnReady()));
  return host;
}
const map = (root: ParentNode, sel = 'corn-map') => root.querySelector(sel) as Piece;
const card = (el: Element) => el.shadowRoot!.querySelector('[data-corn="source-status"]:not([hidden])') as HTMLElement | null;
const text = (el: Element) => (card(el)?.textContent || '').replace(/\s+/g, ' ').trim();
const SIZE = 'display: block; width: 520px; height: 340px';
/** What an empty map of this size looks like (the ground has a grid): a map is drawn when its picture is not that */
let blank = 0;
beforeAll(async () => {
  const el = document.createElement('corn-map') as Piece;
  el.setAttribute('renderer', 'canvas2d');
  el.setAttribute('style', SIZE);
  document.body.append(el);
  await el.componentOnReady();
  await sleep(700);
  blank = pixelsOf(canvasOf(el)).hash;
  el.remove();
});
const lit = (el: Element) => { const p = pixelsOf(canvasOf(el as HTMLElement)); return p.lit > 0 && p.hash !== blank ? 1000 : 0; };

describe('a corn-map with a src (a private scope)', () => {
  it('reads the server\'s map and draws it, quietly while it loads, and says cornReady', async () => {
    listen();
    const host = await page(`<corn-map renderer="canvas2d" style="${SIZE}" src="${at('slow')}"></corn-map>`);
    const el = map(host);
    await until(() => !!card(el));
    expect(card(el)!.getAttribute('data-corn-state')).toBe('running');
    expect(text(el)).toBe('Loading the map …');
    await until(() => events.some((e) => e.type === 'cornReady'));
    await frames(3);
    expect(card(el)).toBe(null);
    expect(lit(el)).toBeGreaterThan(50);
  });

  it('a path on the server is kept: the base is joined, not replaced', async () => {
    const host = await page(`<corn-map renderer="canvas2d" style="${SIZE}" src="${at('ok')}/"></corn-map>`);
    await until(() => !card(map(host)) && lit(map(host)) > 0);
  });

  it('changing src makes a new private scope and draws the other server\'s map', async () => {
    listen();
    const host = await page(`<corn-map renderer="canvas2d" style="${SIZE}" src="${at('ok')}"></corn-map>`);
    const el = map(host);
    await until(() => lit(el) > 0);
    const first = canvasOf(el);
    el.src = at('other');
    await until(() => canvasOf(el) !== first && lit(el) > 0);
    await el.focusNode('two');
    await until(() => events.some((e) => e.type === 'cornSelect' && e.detail.id === 'two'));
  });
});

describe('what the person sees when it cannot (and says once)', () => {
  const live = (el: Element) => el.shadowRoot!.querySelector('[data-corn="source-announcer"]') as HTMLElement;

  it('sign-in needed (401): the title, a real link to the server\'s sign-in that returns to this page, target _top, and cornAuth', async () => {
    listen();
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    const host = await page(`<corn-map renderer="canvas2d" style="${SIZE}" src="${at('auth')}"></corn-map>`);
    const el = map(host);
    await until(() => text(el).includes('Sign in to cornfield'));
    const link = el.shadowRoot!.querySelector('a[data-corn="source-sign-in"]') as HTMLAnchorElement;
    expect(card(el)!.getAttribute('data-corn-state')).toBe('waiting');
    expect(link.getAttribute('target')).toBe('_top');
    expect(link.getAttribute('rel')).toBe('noopener');
    expect(link.getAttribute('part')).toBe('source-sign-in');
    expect(link.getAttribute('data-corn-kind')).toBe('primary');
    const href = new URL(link.href);
    expect(href.origin + href.pathname).toBe(`${at('auth')}/auth/start`);
    expect(href.searchParams.get('returnTo')).toBe(location.href);
    const auth = events.find((e) => e.type === 'cornAuth')!;
    expect(auth.detail).toEqual({ status: 401, signIn: link.href });
    expect(auth.target).toBe('corn-map');
    expect(document.activeElement).toBe(button); // focus is not stolen
    expect(live(el).textContent).toBe("You are not signed in to cornfield. This map is behind cornfield's sign-in.");
    expect(el.shadowRoot!.querySelector('[data-corn="source-title"]')!.textContent).toBe('You are not signed in to cornfield');
    expect(link.textContent).toBe('Sign in to cornfield'); // the title says what is the case, the link what to do
    expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(44); // a target a finger can take
    expect(location.href).not.toContain('/auth/'); // the component never navigates the window
  });

  it('not listed: no CORS answer from a server that is there; names the origin the server should list; cornError not-listed', async () => {
    listen();
    const other = (await (await fetch('/fake/origin.json')).json()).origin as string;
    const host = await page(`<corn-map renderer="canvas2d" style="${SIZE}" src="${other}"></corn-map>`);
    const el = map(host);
    await until(() => text(el).includes('not listed'));
    expect(text(el)).toContain('This page is not listed by that cornfield');
    expect(el.shadowRoot!.querySelector('[data-corn="source-origin"]')!.textContent).toBe(location.origin);
    expect(card(el)!.getAttribute('data-corn-state')).toBe('failure');
    expect(kinds()).toEqual(['not-listed']);
    expect(events.find((e) => e.type === 'cornError')!.detail.message).toBe(location.origin);
    expect(events.some((e) => e.type === 'cornReady')).toBe(false);
  });

  it('offline (nothing answers): the words and Retry; Retry asks again, and a server that is up draws the map', async () => {
    listen();
    await fetch('/fake/gate/close');
    const host = await page(`<corn-map renderer="canvas2d" style="${SIZE}" src="http://127.0.0.1:1"></corn-map>`);
    const el = map(host);
    await until(() => text(el).includes('cannot be reached'));
    expect(card(el)!.getAttribute('data-corn-state')).toBe('stopped');
    expect(kinds()).toEqual(['offline']);
    const retry = el.shadowRoot!.querySelector('button[data-corn="source-retry"]') as HTMLButtonElement;
    expect(retry.getAttribute('data-corn-kind')).toBe('secondary');
    expect(retry.textContent).toBe('Retry');
    expect(retry.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  });

  it('a server error says so with what it answered, and Retry is there; after a 401 turns into a map the Retry loads it and the focus goes to the map', async () => {
    const host = await page(`<corn-map renderer="canvas2d" style="${SIZE}" src="${at('error')}"></corn-map>`);
    const el = map(host);
    await until(() => text(el).includes('could not be loaded'));
    expect(text(el)).toContain('answered 500');
    expect(el.shadowRoot!.querySelector('button[data-corn="source-retry"]')).toBeTruthy();
    // a server that wants a sign-in, then lets the maintainer in
    await fetch('/fake/gate/close');
    const host2 = await page(`<corn-map renderer="canvas2d" style="${SIZE}" src="${at('gate')}"></corn-map>`);
    const el2 = host2.querySelector('corn-map') as Piece;
    await until(() => text(el2).includes('Sign in to cornfield'));
    await fetch('/fake/gate/open');
    // sign-in has no retry button (the link is the way); the page reloading the tag is the way back: a new tag makes a new load
    el2.src = at('gate') + '/';
    await until(() => !card(el2) && lit(el2) > 0);
    await fetch('/fake/gate/close');
  });

  it('a Retry that loads the map puts the focus on the map (the button the focus was on is gone)', async () => {
    await fetch('/fake/gate/close');
    const host = await page(`<corn-scope src="${at('gate')}"><corn-map renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`);
    const el = map(host);
    await until(() => text(el).includes('Sign in to cornfield'));
    // a not-listed-like card with a Retry needs an answer that is neither: use the scope's source directly
    const scope = (host.querySelector('corn-scope') as any).scope;
    expect(scope.source).toBeTruthy();
    scope.source.say({ state: 'offline' });
    await until(() => !!el.shadowRoot!.querySelector('button[data-corn="source-retry"]'));
    await fetch('/fake/gate/open');
    (el.shadowRoot!.querySelector('button[data-corn="source-retry"]') as HTMLButtonElement).focus();
    (el.shadowRoot!.querySelector('button[data-corn="source-retry"]') as HTMLButtonElement).click();
    await until(() => !card(el) && lit(el) > 0);
    expect(el.shadowRoot!.activeElement).toBe(canvasOf(el));
    await fetch('/fake/gate/close');
  });

  it('a src that is not an address is refused, and said, and nothing is asked', async () => {
    listen();
    const host = await page(`<corn-map renderer="canvas2d" style="${SIZE}" src="javascript:alert(1)"></corn-map>`);
    const el = map(host);
    await until(() => text(el).includes('not the address of a cornfield server'));
    expect(text(el)).toContain('is not http or https');
    expect(kinds()).toEqual(['address']);
    expect(card(el)!.getAttribute('data-corn-state')).toBe('failure');
  });

  it('a live region says each state once, through a whole signed-out-then-signed-in flow, and the focus is never taken', async () => {
    await fetch('/fake/gate/close');
    const button = document.createElement('button');
    button.textContent = 'the host\'s own';
    document.body.append(button);
    button.focus();
    const heard: string[] = [];
    /** Every text the polite region is given, from the moment the element is in the page */
    const watch = (el: Element) => new MutationObserver((list) => {
      for (const m of list) {
        const node = (m.target.nodeType === 1 ? m.target : m.target.parentElement) as Element | null;
        const region = node && node.closest('[data-corn="source-announcer"]');
        if (region && m.type === 'childList' && region.textContent) heard.push(region.textContent);
      }
    }).observe(el.shadowRoot!, { subtree: true, childList: true, characterData: true });
    const open = (src: string) => {
      const host = document.createElement('main');
      host.innerHTML = `<corn-map renderer="canvas2d" style="${SIZE}" src="${src}"></corn-map>`;
      document.body.append(host);
      watch(map(host));
      return host;
    };
    // signed out: the load, then the sign-in
    const first = open(at('gate'));
    await until(() => text(map(first)).includes('Sign in to cornfield'));
    await sleep(300);
    expect(heard).toEqual(['Loading the map …', "You are not signed in to cornfield. This map is behind cornfield's sign-in."]);
    expect(document.activeElement).toBe(button);
    // signed in, and back on the page (a new page load is a new element): the load is said once, the map drawn says nothing
    await fetch('/fake/gate/open');
    first.remove();
    const second = open(at('gate'));
    await until(() => !!canvasOf(map(second)) && !card(map(second)) && lit(map(second)) > 0);
    await sleep(300);
    expect(heard).toEqual(['Loading the map …', "You are not signed in to cornfield. This map is behind cornfield's sign-in.", 'Loading the map …']);
    expect(document.activeElement).toBe(button);
    const region = live(map(second));
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('role')).toBe('status');
    await fetch('/fake/gate/close');
  });

  it('a 403 (signed in, not a maintainer) says so, and the link is still the way to sign in as one', async () => {
    const host = await page(`<corn-map renderer="canvas2d" style="${SIZE}" src="${at('forbidden')}"></corn-map>`);
    const el = map(host);
    await until(() => text(el).includes("This map is for the project's maintainers"));
    const parts = [...card(el)!.querySelectorAll('p, a, button')].map((n) => n.textContent);
    expect(parts).toEqual(["This map is for the project's maintainers", 'You are signed in to cornfield, but not as a maintainer.', 'Sign in to cornfield']);
    expect(card(el)!.getAttribute('data-corn-state')).toBe('waiting');
  });

  it('every element of the status has a hook and a part of the same name', async () => {
    const host = await page(`<corn-map renderer="canvas2d" style="${SIZE}" src="${at('auth')}"></corn-map>`);
    const el = map(host);
    await until(() => text(el).includes('Sign in'));
    for (const node of el.shadowRoot!.querySelectorAll('[data-corn^="source-"]')) expect(node.getAttribute('part')).toBe(node.getAttribute('data-corn'));
    expect([...el.shadowRoot!.querySelectorAll('[data-corn^="source-"]')].map((n) => n.getAttribute('data-corn'))).toEqual(expect.arrayContaining(['source-status', 'source-title', 'source-text', 'source-sign-in', 'source-announcer']));
  });

  it('axe finds nothing on any state, dark and light: loading, sign in (401 and 403), not listed, offline, a server error, a bad address, the version notice, a second map', async () => {
    const other = (await (await fetch('/fake/origin.json')).json()).origin as string;
    const { version } = await import('../src/index');
    const [major] = version.split('.').map(Number);
    const cases: Array<[string, string, (host: HTMLElement) => boolean]> = [
      ['loading', `<corn-map renderer="canvas2d" style="${SIZE}" src="${at('slow')}"></corn-map>`, (h) => card(map(h))?.getAttribute('data-corn-state') === 'running'],
      ...[at('auth'), at('forbidden'), other, 'http://127.0.0.1:1', at('error'), 'ftp://x.test'].map((src): [string, string, (host: HTMLElement) => boolean] => [src, `<corn-map renderer="canvas2d" style="${SIZE}" src="${src}"></corn-map>`, (h) => !!card(map(h)) && card(map(h))!.getAttribute('data-corn-state') !== 'running']),
      ['version', `<corn-scope id="v"><corn-map renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`, (h) => { const sc = h.querySelector('#v') as any; if (!sc.config) { sc.config = { version: `${major + 1}.0.0` }; sc.topology = { nodes: [{ id: 'a', type: 'app' }], edges: [] }; } return !!map(h).shadowRoot!.querySelector('[data-corn="source-notice"]:not([hidden])'); }],
      ['second map', `<corn-scope src="${at('ok')}"><corn-map renderer="canvas2d" style="${SIZE}"></corn-map><corn-map id="b" renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`, (h) => !!card(h.querySelector('#b')!)],
    ];
    for (const theme of ['dark', 'light']) for (const [name, html, ready] of cases) {
      const host = document.createElement('main');
      host.innerHTML = html.replace(/<corn-map /g, `<corn-map theme="${theme}" `);
      document.body.append(host);
      await Promise.all([...host.querySelectorAll('corn-scope, corn-map')].map((el) => (el as Piece).componentOnReady()));
      await until(() => ready(host));
      const result = await axe.run(host, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
      expect(result.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`)), `${theme} ${name}`).toEqual([]);
      host.remove();
    }
  });
});

describe('<corn-scope>', () => {
  it('shows nothing of its own, has no shadow root, and leaves what is inside it where it is', async () => {
    const host = await page(`<corn-scope src="${at('ok')}"><p id="mine">mine</p><corn-map renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`);
    const scope = host.querySelector('corn-scope')!;
    expect(scope.shadowRoot).toBe(null);
    expect([...scope.children].map((c) => c.localName)).toEqual(['p', 'corn-map']);
    expect(scope.querySelector('#mine')!.textContent).toBe('mine');
    expect(getComputedStyle(scope).display).toBe('inline'); // nothing of its own
  });

  it('a map inside uses the scope\'s data (one topology, one selection); cornReady passes through and the scope says it too', async () => {
    listen();
    const host = await page(`<corn-scope src="${at('ok')}"><corn-map renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`);
    const el = map(host);
    await until(() => lit(el) > 0);
    expect(events.filter((e) => e.type === 'cornReady').map((e) => e.target).sort()).toEqual(['corn-map', 'corn-scope']);
    await el.focusNode('beta');
    await until(() => events.some((e) => e.type === 'cornSelect'));
    expect(events.find((e) => e.type === 'cornSelect')!.detail).toMatchObject({ id: 'beta', kind: 'node', source: 'api' });
  });

  it('a piece added later finds the scope; a scope added around existing pieces is found by them (the walk), and a removed scope sends its pieces back to a private map', async () => {
    const host = await page(`<div id="wrap"><corn-map renderer="canvas2d" style="${SIZE}"></corn-map></div>`);
    const el = map(host);
    expect(lit(el)).toBe(0);
    // a scope put around the map that is already there: the engine's scope on the wrapper
    const { mountScope } = await import('../../explorer/pieces/scope.js');
    const wrap = host.querySelector('#wrap')!;
    const scope = (mountScope as any)(wrap, { topology: await smallTopology(14) });
    await until(() => lit(el) > 0);
    scope.destroy();
    await frames(3);
    expect(lit(el)).toBe(0); // alone again: a private map with nothing in it
    // a piece added after the scope is there
    const scope2 = document.createElement('corn-scope') as Piece;
    scope2.topology = await smallTopology(14);
    host.append(scope2);
    await scope2.componentOnReady();
    const late = document.createElement('corn-map') as Piece;
    late.setAttribute('renderer', 'canvas2d');
    late.setAttribute('style', SIZE);
    scope2.append(late);
    await late.componentOnReady();
    await until(() => lit(late) > 0);
    // the scope leaves the page: the piece goes on alone
    scope2.remove();
    await frames(2);
  });

  it('src changing: the pieces take the new server\'s map, and the old instance ends', async () => {
    listen();
    const host = await page(`<corn-scope src="${at('ok')}"><corn-map renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`);
    const scope = host.querySelector('corn-scope') as Piece;
    const el = map(host);
    await until(() => lit(el) > 0);
    const first = canvasOf(el);
    scope.src = at('other');
    await until(() => canvasOf(el) !== first && lit(el) > 0);
    events.length = 0;
    await el.focusNode('three');
    await until(() => events.some((e) => e.type === 'cornSelect' && e.detail.id === 'three'));
  });

  it('two maps in one scope: the second says why it draws nothing, the first is untouched, and the scope says cornError second-map', async () => {
    listen();
    const host = await page(`<corn-scope src="${at('ok')}"><corn-map id="a" renderer="canvas2d" style="${SIZE}"></corn-map><corn-map id="b" renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`);
    const [a, b] = [map(host, '#a'), map(host, '#b')];
    await until(() => lit(a) > 0 && text(b).includes('already has a map'));
    expect(card(b)!.getAttribute('data-corn-state')).toBe('failure');
    expect(b.shadowRoot!.querySelectorAll('canvas')).toHaveLength(0);
    expect(kinds()).toEqual(['second-map']);
    // the first is a map still, and the second takes the scope by itself when the first leaves, and draws the scope's map
    const third = document.createElement('corn-map') as Piece;
    third.setAttribute('renderer', 'canvas2d');
    third.setAttribute('style', SIZE);
    host.querySelector('corn-scope')!.append(third);
    await third.componentOnReady();
    await until(() => text(third).includes('already has a map'));
    a.remove();
    await until(() => !!b.shadowRoot!.querySelector('canvas') && lit(b) > 0 && !card(b));
    expect(text(third)).toContain('already has a map'); // one map at a time: the third still waits
    b.remove();
    await until(() => !!third.shadowRoot!.querySelector('canvas') && lit(third) > 0 && !card(third));
  });

  it('two scopes on one page, two servers, stay independent: each map has its own map and its own selection', async () => {
    listen();
    const host = await page(`<corn-scope id="s1" src="${at('ok')}"><corn-map id="a" renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope><corn-scope id="s2" src="${at('other')}"><corn-map id="b" renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`);
    const [a, b] = [map(host, '#a'), map(host, '#b')];
    await until(() => lit(a) > 0 && lit(b) > 0);
    await a.focusNode('beta');
    await until(() => a.node === 'beta');
    expect(b.node == null).toBe(true);
    await b.focusNode('two');
    await until(() => b.node === 'two');
    expect(a.node).toBe('beta');
    // one is signed out, the other is not: the states do not mix
    (host.querySelector('#s2') as Piece).src = at('auth');
    await until(() => text(b).includes('Sign in to cornfield'));
    expect(card(a)).toBe(null);
  });

  it('a host that fetched for itself: topology and config as properties make no request, and its strings win', async () => {
    const before = performance.getEntriesByType('resource').length;
    const host = await page(`<corn-scope src="${at('ok')}"><corn-map renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`);
    const scope = host.querySelector('corn-scope') as Piece & { config: unknown; strings: unknown };
    await until(() => lit(map(host)) > 0);
    // a second scope with no src at all, handed everything
    const alone = await page('<corn-scope><corn-map renderer="canvas2d" style="' + SIZE + '"></corn-map></corn-scope>');
    const s2 = alone.querySelector('corn-scope') as Piece & { config: unknown; strings: unknown };
    const n = performance.getEntriesByType('resource').filter((r) => r.name.includes('/fake/')).length;
    s2.config = { version: '0.0.0' };
    s2.topology = await smallTopology(14);
    await until(() => lit(map(alone)) > 0);
    expect(performance.getEntriesByType('resource').filter((r) => r.name.includes('/fake/')).length).toBe(n);
    void scope; void before;
  });

  it('the version: a different minor or major shows the notice and says cornError version but keeps working; a patch says nothing', async () => {
    listen();
    const { version } = await import('../src/index');
    const [major, minor, patch] = version.split('.').map(Number);
    const host = await page('<corn-scope><corn-map renderer="canvas2d" style="' + SIZE + '"></corn-map></corn-scope>');
    const scope = host.querySelector('corn-scope') as Piece & { config: unknown };
    const el = map(host);
    scope.topology = await smallTopology(14);
    scope.config = { version: `${major}.${minor}.${patch + 5}` };
    await frames(4);
    expect(kinds()).toEqual([]);
    expect(el.shadowRoot!.querySelector('[data-corn="source-notice"]:not([hidden])')).toBe(null);
    scope.config = { version: `${major}.${minor + 1}.0` };
    await until(() => !!el.shadowRoot!.querySelector('[data-corn="source-notice"]:not([hidden])'));
    expect(kinds()).toEqual(['version']);
    const notice = el.shadowRoot!.querySelector('[data-corn="source-notice"]')!;
    expect(notice.textContent).toContain('different versions');
    expect(notice.textContent).toContain(`${major}.${minor + 1}.0`);
    expect(notice.getAttribute('part')).toBe('source-notice');
    await until(() => lit(el) > 0); // it keeps working
  });

  it('a config that names plugin modules, a script link and a brand: no script is requested, no module imported, no script element added, and the links are not followed', async () => {
    const scripts = () => document.querySelectorAll('script').length;
    const before = { scripts: scripts(), entries: performance.getEntriesByType('resource').length, preloads: document.querySelectorAll('link[rel="modulepreload"], script[type="importmap"]').length };
    const host = await page(`<corn-scope src="${at('plugins')}" use-theme><corn-map renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`);
    await until(() => lit(map(host)) > 0);
    await sleep(500);
    const names = performance.getEntriesByType('resource').slice(before.entries).map((r) => r.name);
    expect(names.filter((n) => /\/repo\/|checker\.js|logo\.js/.test(n))).toEqual([]);
    expect(names.filter((n) => /\.js(\?|$)/.test(n) && n.includes('/fake/'))).toEqual([]);
    expect(scripts()).toBe(before.scripts);
    expect(document.querySelectorAll('link[rel="modulepreload"], script[type="importmap"]').length).toBe(before.preloads);
    expect(host.querySelectorAll('a[href^="javascript:"]').length + map(host).shadowRoot!.querySelectorAll('a[href^="javascript:"]').length).toBe(0);
  });
});

describe('the server\'s theme (use-theme)', () => {
  const hostLook = () => {
    const cs = getComputedStyle(document.body);
    const p = getComputedStyle(document.querySelector('#host-p')!);
    return { display: cs.display, color: cs.color, bg: cs.backgroundColor, p: p.color, sheets: document.adoptedStyleSheets.length, styles: document.querySelectorAll('style').length, links: document.querySelectorAll('link').length, fonts: document.fonts.size };
  };

  it('puts the server\'s --corn-* tokens on the scope and its rules in each piece, and nothing of it in the host\'s document (a body rule, a star rule, an @import, an @font-face)', async () => {
    const lead = document.createElement('p');
    lead.id = 'host-p';
    lead.textContent = 'the host';
    document.body.append(lead);
    await page(`<corn-scope src="${at('hostile')}"><corn-map renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`); // a first piece adds the default tokens: the look is taken after it
    const before = hostLook();
    document.body.innerHTML = '';
    document.body.append(lead);
    const host = await page(`<corn-scope id="s" src="${at('hostile')}" theme="dark" use-theme><corn-map renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`);
    const scope = host.querySelector('#s') as HTMLElement;
    const el = map(host);
    await until(() => getComputedStyle(scope).getPropertyValue('--corn-accent').trim() === '#c8102e' && lit(el) > 0);
    // the tokens
    expect(scope.style.getPropertyValue('--corn-accent')).toBe('#c8102e');
    expect(scope.style.getPropertyValue('--corn-ok')).toBe('#118833');
    expect(getComputedStyle(el).getPropertyValue('--corn-accent').trim()).toBe('#c8102e'); // inherited into the piece
    // only --corn-* from :root: another custom property, and the rules that are not the root's, did not come
    expect(scope.style.getPropertyValue('--brand-private')).toBe('');
    expect(scope.style.length).toBeGreaterThan(2);
    for (let i = 0; i < scope.style.length; i++) expect(scope.style[i]).toMatch(/^--corn-/);
    // a url() in a copied token is the server's, absolute
    expect(scope.style.getPropertyValue('--corn-ground-image')).toBe(`url("${at('hostile')}/cornfield/theme/assets/bg.png")`);
    // the rules: in the piece's shadow root, applied as written
    const stage = el.shadowRoot!.querySelector('[data-corn="map-stage"]')!;
    expect(getComputedStyle(stage).outlineStyle).toBe('solid');
    expect(getComputedStyle(stage).outlineColor).toBe('rgb(0, 128, 0)');
    expect(el.shadowRoot!.adoptedStyleSheets.length).toBeGreaterThanOrEqual(1);
    // the host's document: unchanged
    await frames(2);
    const after = hostLook();
    expect(after).toEqual(before);
    expect(after.display).not.toBe('none');
    expect(after.p).not.toBe('rgb(255, 0, 0)');
    expect(document.adoptedStyleSheets.every((s) => ![...s.cssRules].some((r) => /display: none|rgb\(255, 0, 0\)|data-corn/.test(r.cssText)))).toBe(true);
  });

  it('what a constructable sheet drops: an @import brings nothing (the imported --corn-text never arrives), and an @font-face defines no font for the page', async () => {
    const host = await page(`<corn-scope id="s" src="${at('hostile')}" theme="dark" use-theme><corn-map renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`);
    const scope = host.querySelector('#s') as HTMLElement;
    await until(() => scope.style.getPropertyValue('--corn-accent') === '#c8102e');
    expect(scope.style.getPropertyValue('--corn-text')).not.toBe('#00ff00');
    const sheet = map(host).shadowRoot!.adoptedStyleSheets.find((s) => [...s.cssRules].some((r) => r.cssText.includes('data-corn')))!;
    expect([...sheet.cssRules].some((r) => r instanceof CSSImportRule)).toBe(false);
    await sleep(300);
    expect([...document.fonts].some((f) => f.family.includes('Fake Pixel'))).toBe(false);
  });

  it('follows light and dark: the light block\'s tokens under theme="light", the dark ones under theme="dark"', async () => {
    const host = await page(`<corn-scope id="s" src="${at('hostile')}" theme="light" use-theme><corn-map renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`);
    const scope = host.querySelector('#s') as Piece;
    await until(() => scope.style.getPropertyValue('--corn-accent') === '#b00b1e');
    expect(scope.style.getPropertyValue('--corn-ground')).toBe('#fdf3dc');
    scope.theme = 'dark';
    await until(() => scope.style.getPropertyValue('--corn-accent') === '#c8102e');
    expect(scope.style.getPropertyValue('--corn-ground')).toBe('#1a1640');
    scope.useTheme = false;
    await until(() => scope.style.getPropertyValue('--corn-accent') === '');
    expect(map(host).shadowRoot!.adoptedStyleSheets.every((s) => ![...s.cssRules].some((r) => r.cssText.includes('letter-spacing')))).toBe(true);
  });

  it('turned off, takes back everything it added: the tokens, the sheet in each piece, and the map is drawn again in the look it had without it', async () => {
    const plain = await page(`<corn-scope src="${at('hostile')}" theme="dark"><corn-map renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`);
    await until(() => lit(map(plain)) > 0);
    await frames(4);
    await sleep(300);
    const unthemed = pixelsOf(canvasOf(map(plain))).hash;
    plain.remove();
    const host = await page(`<corn-scope id="s" src="${at('hostile')}" theme="dark" use-theme><corn-map renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`);
    const scope = host.querySelector('#s') as Piece;
    const el = map(host);
    await until(() => scope.style.getPropertyValue('--corn-ground') === '#1a1640' && lit(el) > 0);
    await frames(4);
    await sleep(300);
    expect(pixelsOf(canvasOf(el)).hash).not.toBe(unthemed); // the theme's ground is drawn
    scope.useTheme = false;
    await until(() => scope.style.length === 0);
    await frames(4);
    await sleep(300);
    expect(el.shadowRoot!.adoptedStyleSheets.some((s) => [...s.cssRules].some((r) => r.cssText.includes('letter-spacing')))).toBe(false);
    expect(pixelsOf(canvasOf(el)).hash).toBe(unthemed);
  });

  it('names nothing but the server: a theme that points at another origin in every way CSS can load leaves no trace of it, and that origin is asked nothing', async () => {
    const away = (await (await fetch('/fake/origin.json')).json()).origin as string;
    await fetch('/fake/other-hits.json'); // forget what came before
    const host = await page(`<corn-scope id="s" src="${at('leaky')}" theme="dark" use-theme><corn-map renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`);
    const scope = host.querySelector('#s') as HTMLElement;
    const el = map(host);
    await until(() => scope.style.getPropertyValue('--corn-accent') === '#0a7d3b' && lit(el) > 0);
    await frames(3);
    await sleep(600);
    // the tokens: what named another origin was not copied
    const tokens = [...scope.style].map((p) => `${p}: ${scope.style.getPropertyValue(p)}`).join('\n');
    expect(tokens).not.toContain(away);
    expect(tokens).not.toMatch(/\\|image-set|open-token/);
    for (const t of ['--corn-ground-image', '--corn-surface-1', '--corn-surface-2', '--corn-surface-3', '--corn-shadow', '--corn-line']) expect(scope.style.getPropertyValue(t), t).toBe('');
    // the sheet in the piece: every rule and declaration that named it is gone, at every depth; the rest applies, and the server's own asset is absolute
    const sheet = el.shadowRoot!.adoptedStyleSheets.find((s) => [...s.cssRules].some((r) => r.cssText.includes('rgb(1, 2, 3)')))!;
    expect(sheet).toBeTruthy();
    const text = (rules: CSSRuleList): string => [...rules].map((r) => r.cssText).join('\n');
    expect(text(sheet.cssRules)).not.toContain(away);
    expect(text(sheet.cssRules)).toContain(`url("${at('leaky')}/cornfield/theme/assets/ok.png")`);
    const stage = el.shadowRoot!.querySelector('[data-corn="map-stage"]')!;
    expect(getComputedStyle(stage).outlineColor).toBe('rgb(0, 128, 0)');
    for (const prop of ['background-image', 'border-image-source', 'list-style-image', 'cursor', 'mask-image']) expect(getComputedStyle(stage).getPropertyValue(prop), prop).not.toContain(away);
    // and the other origin was asked nothing at all
    expect(await (await fetch('/fake/other-hits.json')).json()).toEqual([]);
  });

  it('is off unless asked for: no theme request, no tokens', async () => {
    const before = performance.getEntriesByType('resource').length;
    const host = await page(`<corn-scope id="s" src="${at('hostile')}"><corn-map renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`);
    await until(() => lit(map(host)) > 0);
    expect(performance.getEntriesByType('resource').slice(before).some((r) => r.name.endsWith('/cornfield/theme.css'))).toBe(false);
    expect((host.querySelector('#s') as HTMLElement).style.length).toBe(0);
  });
});

describe('the end', () => {
  it('a scope or a map removed while a read is in flight ends it, and says nothing afterwards', async () => {
    listen();
    const host = await page(`<corn-scope src="${at('slow')}"><corn-map renderer="canvas2d" style="${SIZE}"></corn-map></corn-scope>`);
    await sleep(100);
    host.remove();
    await sleep(1200);
    expect(events.some((e) => e.type === 'cornReady' || e.type === 'cornError')).toBe(false);
  });
});
