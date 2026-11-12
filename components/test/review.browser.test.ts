/**
 * <corn-review> (spec 0011 D1, D4, D5, D6, D7, D9, D10, D12), in headless Chrome against a fake server (scripts/fake-cornfield.mjs): the one-tag review draws the
 * server's map and the proposal on it, shows each state of the load in the box with the words, hooks and parts a map with `src` has, tells the host what happened
 * in typed events and never touches its page. The real server, the cookie, CORS and the two sibling origins are held by test/fixtures/big/review-proof.mjs.
 */
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { commands } from 'vitest/browser';
import { frames, sleep } from './support';
import '../src/index';

type Review = HTMLElement & {
  componentOnReady(): Promise<Review>; src?: string; proposal?: unknown; source?: string | null; view?: string | null; node?: string | null; theme?: string; useTheme: boolean;
  topology?: unknown; config?: unknown; strings?: unknown; checker?: unknown; fit(): Promise<void>; focusNode(id: string): Promise<void>; refresh(): Promise<void>;
};

const at = (name: string) => `${location.origin}/fake/${name}`;
const TYPES = ['cornReady', 'cornSelect', 'cornNavigate', 'cornDecision', 'cornAuth', 'cornError'];
const events: Array<{ type: string; detail: any; target: string }> = [];
const record = (e: Event) => events.push({ type: e.type, detail: (e as CustomEvent).detail, target: (e.target as HTMLElement).localName });
const calls: Array<{ url: string; credentials: string | undefined; method: string }> = [];
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
    calls.push({ url: String(input instanceof Request ? input.url : input), credentials: init?.credentials, method: init?.method || 'GET' });
    return realFetch(input, init);
  }) as typeof fetch;
}
async function until(fn: () => boolean, ms = 10_000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`); await sleep(40); } }
const seen = (type: string) => events.filter((e) => e.type === type);

const WIDE = 'width: 1100px; height: 680px';
const PHONE = 'width: 390px; height: 700px';
/** A review in a host's box, with the host's own look around it */
async function review(attrs: string, style = WIDE) {
  listen();
  const host = document.createElement('main');
  host.innerHTML = `<div style="${style}"><corn-review ${attrs}></corn-review></div>`;
  document.body.append(host);
  const el = host.querySelector('corn-review') as Review;
  await el.componentOnReady();
  return el;
}
const box = (el: Element) => el.shadowRoot!.querySelector('[data-corn="review"]') as HTMLElement;
const q = (el: Element, sel: string) => el.shadowRoot!.querySelector(sel) as HTMLElement | null;
const card = (el: Element) => q(el, '[data-corn="source-status"]:not([hidden])');
const cardText = (el: Element) => (card(el)?.textContent || '').replace(/\s+/g, ' ').trim();
const title = (el: Element) => (q(el, '#proposal-title')?.textContent || '').trim();
const canvasLit = (el: Element) => {
  const c = q(el, 'canvas[data-corn="map-canvas"]') as HTMLCanvasElement | null;
  return !!c && c.width > 0 && !!title(el);
};

describe('the one tag', () => {
  it('reads the server\'s map, opens the proposal on it and says cornReady once, after both; cornNavigate says what opened', async () => {
    listen();
    const el = await review(`src="${at('ok')}" proposal="0001-fake"`);
    await until(() => seen('cornReady').length > 0);
    expect(title(el)).toBe('A fake change');
    expect(seen('cornReady')).toHaveLength(1);
    expect(seen('cornNavigate')).toEqual([{ type: 'cornNavigate', target: 'corn-review', detail: { proposal: '0001-fake', source: null, view: 'diff', change: 'opened' } }]);
    expect(q(el, '[data-corn="review-column"]') || q(el, '#review-column')).toBeTruthy();
    expect(card(el)).toBe(null);
    expect(box(el).getAttribute('role')).toBe('region');
    // the requests: the session goes to the server and nowhere else, and only the routes the server lets a listed origin read
    const gets = calls.map((c) => `${c.method} ${c.url.replace(location.origin, '')}`.replace(/[?&]v=\d+/, ''));
    expect(gets).toEqual(expect.arrayContaining(['GET /fake/ok/cornfield/config.json', 'GET /fake/ok/topology.json', 'GET /fake/ok/proposals/0001-fake.json']));
    for (const c of calls) expect(c.credentials, c.url).toBe('include');
  });

  it('Before, Diff and After follow the property both ways: a click changes it (and says cornNavigate), setting it changes the bar, neither echoes', async () => {
    listen();
    const el = await review(`src="${at('ok')}" proposal="0001-fake"`);
    await until(() => seen('cornReady').length > 0);
    const views = () => ['before', 'diff', 'after'].map((v) => q(el, `[data-view="${v}"]`)!);
    expect(views().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    views()[2].click();
    await frames(3);
    expect(el.view).toBe('after');
    expect(el.getAttribute('view')).toBe('after');
    expect(seen('cornNavigate').at(-1)!.detail).toEqual({ proposal: '0001-fake', source: null, view: 'after', change: 'view' });
    const n = seen('cornNavigate').length;
    el.view = 'before';
    await frames(3);
    expect(views().map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(seen('cornNavigate')).toHaveLength(n + 1);
    await frames(3);
    expect(seen('cornNavigate')).toHaveLength(n + 1); // set from outside, said once, not passed back
  });

  it('node selects and follows the selection, cornSelect carries the node, and focusNode() answers with a promise', async () => {
    listen();
    const el = await review(`src="${at('ok')}" proposal="0001-fake"`);
    await until(() => seen('cornReady').length > 0);
    el.node = 'beta';
    await frames(3);
    expect(seen('cornSelect').at(-1)!.detail).toEqual({ id: 'beta', kind: 'node', source: 'api' });
    expect(q(el, '#node-title, [data-corn="node-title"]')?.textContent).toMatch(/beta/i);
    await el.focusNode('alpha');
    await frames(3);
    expect(el.node).toBe('alpha');
    expect(el.getAttribute('node')).toBe('alpha');
    expect(el.fit()).toBeInstanceOf(Promise);
    expect(el.refresh()).toBeInstanceOf(Promise);
  });

  it('a proposal handed in as an object is shown for reading, with no request for it and no Approve to press', async () => {
    listen();
    const topology = await (await fetch(`${at('ok')}/topology.json`)).json();
    const config = await (await fetch(`${at('ok')}/cornfield/config.json`)).json();
    calls.length = 0;
    const proposal = await (await fetch(`${at('ok')}/proposals/0001-fake.json`)).json();
    calls.length = 0;
    const el = await review(`src="${at('ok')}"`);
    el.topology = topology;
    el.config = config;
    el.proposal = proposal;
    await until(() => seen('cornReady').length > 0);
    expect(title(el)).toBe('A fake change');
    expect(calls.filter((c) => /proposals|topology|config/.test(c.url))).toEqual([]);
    expect(q(el, '[data-review="approved"]')?.closest('[hidden]')).toBeTruthy();
    expect(q(el, '#review-line')?.textContent).toMatch(/read only|Shown/);
  });
});

describe('where the load is, in the box', () => {
  it('loading: a quiet "Loading the map …", the same words, hooks and parts a map has', async () => {
    const el = await review(`src="${at('slow')}" proposal="0001-fake"`);
    await until(() => !!card(el));
    expect(card(el)!.getAttribute('data-corn-state')).toBe('running');
    expect(cardText(el)).toBe('Loading the map …');
    expect(card(el)!.getAttribute('part')).toBe('source-status');
    await until(() => !card(el) && canvasLit(el));
  });

  it('signed out: "You are not signed in" with a real link to the server\'s sign-in, and cornAuth says 401 with the way back; nothing else is asked', async () => {
    listen();
    const el = await review(`src="${at('auth')}" proposal="0001-fake"`);
    await until(() => cardText(el).includes('Sign in'));
    const link = q(el, '[data-corn="source-sign-in"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`${at('auth')}/auth/start?returnTo=${encodeURIComponent(`${location.origin}${location.pathname}${location.search}`)}`);
    expect(link.target).toBe('_top');
    expect(seen('cornAuth')).toHaveLength(1);
    expect(seen('cornAuth')[0].detail).toEqual({ status: 401, signIn: link.getAttribute('href'), during: 'load' });
    expect(calls.map((c) => c.url)).toEqual(expect.not.arrayContaining([expect.stringMatching(/proposals/)])); // the proposal is not asked for before there is a map
    expect(seen('cornReady')).toHaveLength(0);
  });

  it('signed in as someone who is not a maintainer: the 403 card, with the same link', async () => {
    const el = await review(`src="${at('forbidden')}" proposal="0001-fake"`);
    await until(() => !!card(el) && !!q(el, '[data-corn="source-sign-in"]'));
    expect(cardText(el)).toMatch(/maintainers/);
  });

  it('a server error: its words and Retry, which reads again and says cornError server', async () => {
    listen();
    const el = await review(`src="${at('error')}" proposal="0001-fake"`);
    await until(() => !!q(el, '[data-corn="source-retry"]'));
    expect(seen('cornError').map((e) => e.detail.kind)).toEqual(['server']);
    const before = calls.length;
    (q(el, '[data-corn="source-retry"]') as HTMLElement).click();
    await until(() => calls.length > before);
  });

  it('a server that is down: "cannot be reached" with Retry, and cornError offline', async () => {
    listen();
    const el = await review('src="http://127.0.0.1:1" proposal="0001-fake"');
    await until(() => !!q(el, '[data-corn="source-retry"]'));
    expect(cardText(el)).toMatch(/cannot be reached/);
    expect(seen('cornError').map((e) => e.detail.kind)).toEqual(['offline']);
  });

  it('a page the server does not list: "not listed", with its own origin, cornError not-listed, and nothing read', async () => {
    listen();
    const other = (await (await fetch('/fake/origin.json')).json()).origin as string;
    const el = await review(`src="${other}" proposal="0001-fake"`);
    await until(() => !!q(el, '[data-corn="source-origin"]'));
    expect(cardText(el)).toMatch(/not listed by that cornfield/);
    expect(q(el, '[data-corn="source-origin"]')!.textContent).toBe(location.origin);
    expect(seen('cornError')).toEqual([{ type: 'cornError', target: 'corn-review', detail: { kind: 'not-listed', message: location.origin }, }].map((e) => expect.objectContaining(e)));
    expect(seen('cornReady')).toHaveLength(0);
    expect(calls.filter((c) => /proposals/.test(c.url))).toEqual([]);
  });

  it('a bad address is refused and said (cornError address), and nothing is fetched at all', async () => {
    listen();
    const el = await review('src="javascript:alert(1)" proposal="0001-fake"');
    await until(() => !!card(el));
    expect(cardText(el)).toMatch(/address/i);
    expect(seen('cornError').map((e) => e.detail.kind)).toEqual(['address']);
    expect(calls).toEqual([]);
  });

  it('a server of another version: a quiet notice, the review goes on, cornError version', async () => {
    listen();
    const config = await (await fetch(`${at('ok')}/cornfield/config.json`)).json();
    const el = await review(`src="${at('ok')}" proposal="0001-fake"`);
    el.config = { ...config, version: '99.1.0' };
    await until(() => !!q(el, '[data-corn="source-notice"]:not([hidden])'));
    expect(seen('cornError').some((e) => e.detail.kind === 'version')).toBe(true);
    await until(() => seen('cornReady').length > 0);
    expect(title(el)).toBe('A fake change');
  });

  it('a proposal that does not exist: said in words, with no way that goes nowhere (no Specs list), and cornError proposal', async () => {
    listen();
    const el = await review(`src="${at('ok')}" proposal="0099-nothing"`);
    await until(() => seen('cornError').length > 0);
    await until(() => /There is no proposal called 0099-nothing/.test(q(el, '#proposal-message')?.textContent || ''));
    expect(seen('cornError')[0].detail).toEqual({ kind: 'proposal', message: expect.stringMatching(/There is no proposal called 0099-nothing/) });
    expect(seen('cornError')).toHaveLength(1);
    await until(() => seen('cornReady').length > 0); // the map is drawn and the proposal has said why it is not open
    const ways = [...el.shadowRoot!.querySelectorAll('[data-action="proposal-way"]')].map((b) => b.textContent);
    expect(ways.join('|')).not.toMatch(/specs list/i);
    expect(q(el, '#proposal-menu')!.closest('[hidden]')).toBeTruthy(); // the Proposals menu is kept in a hidden spare place: nothing opens it here
  });

  it('a proposal the server could not read: Retry and Close, and Close puts the focus on the map', async () => {
    const el = await review(`src="${at('ok')}" proposal="boom"`);
    await until(() => !!q(el, '[data-way="close"]'));
    expect(q(el, '#proposal-message')!.textContent).toMatch(/could not be opened: The proposal could not be read/);
    (q(el, '[data-way="close"]') as HTMLElement).click();
    await frames(3);
    expect(el.shadowRoot!.activeElement).toBe(q(el, 'canvas[data-corn="map-canvas"]'));
  });

  it('a decision read the server refuses (a session that ended while the review was open): the same sign-in card, and cornAuth says what was refused', async () => {
    listen();
    const el = await review(`src="${at('expired')}" proposal="0001-fake" source="pull/7"`);
    await until(() => seen('cornAuth').length > 0);
    expect(['facts', 'review']).toContain(seen('cornAuth')[0].detail.during);
    expect(seen('cornAuth')[0].detail.status).toBe(401);
    await until(() => !!card(el));
    expect(cardText(el)).toMatch(/not signed in/);
    expect((q(el, '[data-corn="source-sign-in"]') as HTMLAnchorElement).getAttribute('href')).toBe(seen('cornAuth')[0].detail.signIn);
    expect(title(el)).toBe('A fake change'); // the review is still there under it
  });
});

describe('config never becomes script (D10)', () => {
  it('a config that names plugin modules, a link and a brand with a script scheme: none is fetched, imported or evaluated, and the review is as it was', async () => {
    listen();
    const scripts = document.scripts.length;
    const el = await review(`src="${at('plugins')}" proposal="0001-fake"`);
    await until(() => seen('cornReady').length > 0);
    await sleep(300);
    expect(title(el)).toBe('A fake change');
    expect(calls.filter((c) => /plugins\/(checker|logo)\.js|live\.js/.test(c.url))).toEqual([]);
    expect(document.scripts.length).toBe(scripts);
    expect(document.querySelectorAll('link[rel="modulepreload"], script[type="module"]').length).toBe(0);
    expect(el.shadowRoot!.querySelector('a[href^="javascript:"]')).toBe(null);
    expect((el as unknown as { checker?: unknown }).checker ?? null).toBe(null); // only a host hands one in
  });
});

describe('Approve and Send back', () => {
  it('Approve: the hold with Undo, then one PUT of what was on screen, and cornDecision once, built from the decision\'s own detail', async () => {
    listen();
    const el = await review(`src="${at('ok')}" proposal="0001-fake" source="pull/7"`);
    await until(() => seen('cornReady').length > 0);
    await until(() => !q(el, '[data-review="approved"]')!.hasAttribute('disabled') && /Approve/.test(q(el, '#review-line')?.textContent || ''));
    await fetch('/fake/reviews.json');
    (q(el, '[data-review="approved"]') as HTMLElement).click();
    await until(() => !(q(el, '[data-review-undo]') as HTMLElement).hidden);
    expect(seen('cornDecision')).toHaveLength(0); // said after the answer, never before
    await until(() => seen('cornDecision').length > 0, 12_000);
    expect(seen('cornDecision')).toHaveLength(1);
    expect(seen('cornDecision')[0].detail).toMatchObject({ outcome: 'approved', proposal: '0001-fake', source: 'pull/7', open: true, review: { verdict: 'approved', by: 'maintainer-one' } });
    const puts = (await (await fetch('/fake/reviews.json')).json()) as Array<{ url: string; body: any }>;
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toBe('/fake/ok/proposals/0001-fake/review?source=pull%2F7');
    expect(puts[0].body).toMatchObject({ verdict: 'approved', sha256: 'a'.repeat(63) + 'b' });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.credentials).toBe('include');
  }, 30_000);

  it('Send back needs a note, takes it with the keyboard, and cornDecision says notes', async () => {
    listen();
    const el = await review(`src="${at('ok')}" proposal="0001-fake" source="pull/7"`);
    await until(() => seen('cornReady').length > 0);
    (q(el, '[data-review="notes"]') as HTMLElement).click();
    await frames(2);
    const note = q(el, '#review-note') as HTMLTextAreaElement;
    expect(el.shadowRoot!.activeElement).toBe(note);
    await userEvent.keyboard('Please name the owner first.');
    (q(el, '[data-review="notes"]') as HTMLElement).click();
    await until(() => seen('cornDecision').length > 0, 12_000);
    expect(seen('cornDecision')[0].detail).toMatchObject({ outcome: 'notes', proposal: '0001-fake', source: 'pull/7', open: true });
  }, 30_000);
});

describe('what the tag does to its host, and what the host does to it', () => {
  const BLUNT = `
    *:not(corn-review) { box-sizing: content-box; margin: 7px; }
    button, p, h2, h3, a, textarea { all: unset; display: none !important; }
    canvas { display: none; border: 6px dashed red; }
    [data-corn], [role] { visibility: hidden !important; }
  `;

  it('a host page\'s blunt global styles do not reach in, and the review\'s styles do not leak out', async () => {
    const outside = document.createElement('button');
    outside.textContent = 'host button';
    document.body.append(outside);
    const bodyBefore = getComputedStyle(outside).cssText.length;
    const el = await review(`src="${at('ok')}" proposal="0001-fake"`);
    await until(() => seen('cornReady').length > 0 || canvasLit(el));
    await frames(3);
    const look = () => [...el.shadowRoot!.querySelectorAll('[data-corn]')].map((n) => `${n.getAttribute('data-corn')}|${getComputedStyle(n).display}|${getComputedStyle(n).visibility}|${Math.round(n.getBoundingClientRect().width)}`);
    const before = look();
    const style = document.createElement('style');
    style.textContent = BLUNT;
    document.head.append(style);
    await frames(3);
    expect(look()).toEqual(before);
    style.remove();
    // and nothing of the review's reached the host's own elements
    expect(getComputedStyle(outside).cssText.length).toBe(bodyBefore);
    expect(getComputedStyle(outside).fontFamily).not.toMatch(/inter|system-ui/i);
  });

  it('adds nothing to the host\'s body or head but the default tokens, adopted once; two reviews are independent; thirty made and removed leave nothing', async () => {
    const head = document.head.innerHTML;
    const sheets = () => document.adoptedStyleSheets.length;
    const a = await review(`src="${at('ok')}" proposal="0001-fake"`);
    const b = await review(`src="${at('other')}"`, PHONE);
    await until(() => !!title(a) && !!canvasLit(a) && !!q(b, 'canvas[data-corn="map-canvas"]'));
    expect(sheets()).toBe(1);
    expect(document.head.innerHTML).toBe(head);
    expect([...document.body.children].map((c) => c.localName)).toEqual(['main', 'main']);
    // independent: a selection in one is not in the other, a view in one is not the other's
    a.node = 'beta';
    await frames(3);
    expect(b.node ?? null).toBe(null);
    expect(title(b)).toBe('');
    a.closest('main')!.remove();
    b.closest('main')!.remove();
    await frames(2);
    for (let i = 0; i < 30; i++) {
      const el = await review(`src="${at('ok')}" proposal="0001-fake"`);
      await frames(1);
      el.parentElement!.parentElement!.remove();
    }
    await frames(3);
    expect(document.body.children).toHaveLength(0);
    expect(document.head.innerHTML).toBe(head);
    expect(sheets()).toBe(1);
  }, 60_000);

  it('a change of src is a new review; leaving the page ends the piece and coming back makes a new one', async () => {
    const el = await review(`src="${at('ok')}" proposal="0001-fake"`);
    await until(() => !!title(el));
    const first = q(el, 'canvas[data-corn="map-canvas"]');
    el.src = at('other');
    await until(() => q(el, 'canvas[data-corn="map-canvas"]') !== first && !!q(el, 'canvas[data-corn="map-canvas"]'));
    expect(title(el)).toBe(''); // the other server has no such proposal (it opens one of its own: the name is asked of that server)
    const parent = el.parentElement!;
    el.remove();
    expect(el.shadowRoot!.childElementCount).toBe(0);
    parent.append(el);
    await frames(3);
    expect(el.shadowRoot!.querySelectorAll('[data-corn="review"]')).toHaveLength(1);
  });

  it('every hook inside is a part of the same name', async () => {
    const el = await review(`src="${at('ok')}" proposal="0001-fake" source="pull/7"`);
    await until(() => seen('cornReady').length > 0 || !!title(el));
    for (const hooked of el.shadowRoot!.querySelectorAll('[data-corn]')) expect(hooked.getAttribute('part'), hooked.outerHTML.slice(0, 80)).toBe(hooked.getAttribute('data-corn'));
  });
});

describe('a box with no height of its own, and a phone', () => {
  it('is a block, never under 24rem, and fills the box a host gives it', async () => {
    const host = document.createElement('div');
    host.innerHTML = `<corn-review src="${at('ok')}"></corn-review>`;
    document.body.append(host);
    const el = host.firstElementChild as Review;
    await el.componentOnReady();
    await frames(3);
    expect(getComputedStyle(el).display).toBe('block');
    expect(el.getBoundingClientRect().height).toBeGreaterThanOrEqual(24 * 16 - 1);
    el.parentElement!.setAttribute('style', 'height: 500px');
    await frames(2);
    expect(Math.round(el.getBoundingClientRect().height)).toBe(500);
  });

  it('at 390 wide the review is the page\'s phone layout, and the targets are 44px', async () => {
    const el = await review(`src="${at('ok')}" proposal="0001-fake" source="pull/7"`, PHONE);
    await until(() => seen('cornReady').length > 0 || !!title(el));
    await frames(6);
    for (const sel of ['[data-review="approved"]', '[data-review="notes"]']) {
      const b = q(el, sel)!;
      expect(b.getBoundingClientRect().height, sel).toBeGreaterThanOrEqual(43.5);
    }
  });
});

describe('accessibility of <corn-review>', () => {
  async function audit(root: Element = document.body) {
    const result = await axe.run(root, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
    return result.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
  }
  const STATES: Array<[string, string, (el: Review) => Promise<void>]> = [
    ['open', `src="${at('ok')}" proposal="0001-fake" source="pull/7"`, async (el) => { await until(() => seen('cornReady').length > 0); await frames(3); void el; }],
    ['a node selected', `src="${at('ok')}" proposal="0001-fake" source="pull/7"`, async (el) => { await until(() => seen('cornReady').length > 0); el.node = 'beta'; await frames(4); }],
    ['loading', `src="${at('slow')}" proposal="0001-fake"`, async (el) => { await until(() => !!card(el)); }],
    ['signed out', `src="${at('auth')}"`, async (el) => { await until(() => !!q(el, '[data-corn="source-sign-in"]')); }],
    ['not a maintainer', `src="${at('forbidden')}"`, async (el) => { await until(() => !!q(el, '[data-corn="source-sign-in"]')); }],
    ['a server error', `src="${at('error')}"`, async (el) => { await until(() => !!q(el, '[data-corn="source-retry"]')); }],
    ['offline', 'src="http://127.0.0.1:1"', async (el) => { await until(() => !!q(el, '[data-corn="source-retry"]')); }],
    ['a bad address', 'src="ftp://x"', async (el) => { await until(() => !!card(el)); }],
    ['no such proposal', `src="${at('ok')}" proposal="0099-nothing"`, async (el) => { await until(() => /no proposal called/.test(q(el, '#proposal-message')?.textContent || '')); await frames(2); }],
    ['a session that ended', `src="${at('expired')}" proposal="0001-fake" source="pull/7"`, async (el) => { await until(() => !!card(el)); await frames(2); }],
  ];
  for (const scheme of ['dark', 'light'] as const) {
    for (const [name, attrs, ready] of STATES) {
      it(`axe finds nothing in the state "${name}", ${scheme}`, async () => {
        await commands.colorScheme(scheme);
        document.documentElement.setAttribute('data-theme', scheme);
        const el = await review(`${attrs} theme="${scheme}"`);
        await ready(el);
        expect(await audit(), `${name}, ${scheme}`).toEqual([]);
      }, 30_000);
    }
  }

  it('the whole flow is reached with the keyboard alone: Tab through the bar to the decision, the view by Enter, Send back opens its note and Cancel gives the focus back', async () => {
    const before = document.createElement('button');
    before.textContent = 'before';
    document.body.append(before);
    const el = await review(`src="${at('ok')}" proposal="0001-fake" source="pull/7"`);
    await until(() => seen('cornReady').length > 0);
    before.focus();
    const reached = new Set<string>();
    for (let i = 0; i < 40; i++) {
      await userEvent.tab();
      const active = el.shadowRoot!.activeElement as HTMLElement | null;
      if (!active) { if (document.activeElement !== el) break; continue; }
      reached.add(active.getAttribute('data-review') || active.getAttribute('data-view') || active.getAttribute('data-corn') || active.localName);
      if (reached.has('approved') && reached.has('notes')) break;
    }
    expect([...reached]).toEqual(expect.arrayContaining(['map-canvas', 'before', 'diff', 'after', 'notes', 'approved']));
    // the view by key
    (q(el, '[data-view="after"]') as HTMLElement).focus();
    await userEvent.keyboard('{Enter}');
    await frames(3);
    expect(el.view).toBe('after');
    expect(el.shadowRoot!.activeElement).toBe(q(el, '[data-view="after"]'));
    // Send back, then Cancel
    (q(el, '[data-review="notes"]') as HTMLElement).focus();
    await userEvent.keyboard('{Enter}');
    await frames(3);
    expect(el.shadowRoot!.activeElement).toBe(q(el, '#review-note'));
    (q(el, '[data-review-cancel]') as HTMLElement).focus();
    await userEvent.keyboard('{Enter}');
    await frames(3);
    expect(el.shadowRoot!.activeElement).toBe(q(el, '[data-review="notes"]'));
  }, 30_000);
});
