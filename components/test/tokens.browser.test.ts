import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import tokensSource from '../../explorer/tokens.css?raw';
import { canvasOf, frames, mountMap, paintNodes, pixelsOf, smallTopology, steady, tokenOf } from './support';

// What explorer/tokens.css says, read from the file: nothing is copied by hand into these tests
const rule = (selector: string) => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(tokensSource)![1];
const valueIn = (block: string, name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(block)![1].trim();
const DARK = valueIn(rule(':root'), '--corn-ground');
const LIGHT = valueIn(rule(':root[data-theme="light"]'), '--corn-ground');
const GROUND = '--corn-ground';

const styles: HTMLStyleElement[] = [];
const hostRule = (css: string) => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); styles.push(s); };

beforeEach(async () => { await commands.colorScheme('dark'); });
afterEach(async () => {
  styles.splice(0).forEach((s) => s.remove());
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  await commands.colorScheme('light');
});

describe('the default tokens', () => {
  it('differ, so the tests mean something', () => { expect(DARK).not.toBe(LIGHT); });

  it('reach the element with no stylesheet of the page\'s own: dark by default, as cornfield\'s page is', async () => {
    const el = await mountMap();
    expect(tokenOf(el, GROUND)).toBe(DARK);
    expect(tokenOf(el, '--corn-accent')).toBeTruthy();
  });

  it('follow the document: its data-theme on <html>, else the system\'s setting', async () => {
    const el = await mountMap();
    expect(tokenOf(el, GROUND)).toBe(DARK);
    await commands.colorScheme('light');
    expect(tokenOf(el, GROUND)).toBe(LIGHT); // no data-theme: the system decides
    document.documentElement.setAttribute('data-theme', 'dark');
    expect(tokenOf(el, GROUND)).toBe(DARK); // <html> overrides the system
    await commands.colorScheme('dark');
    document.documentElement.setAttribute('data-theme', 'light');
    expect(tokenOf(el, GROUND)).toBe(LIGHT);
  });

  it('are added to the document once however many elements come, and every rule of the sheet has zero specificity', async () => {
    await mountMap();
    await mountMap();
    await mountMap({ theme: 'light' });
    const ours = document.adoptedStyleSheets.filter((s) => (s as any)[Symbol.for('cornfield.default-tokens')]);
    expect(ours).toHaveLength(1);
    expect(document.adoptedStyleSheets).toHaveLength(1);
    const selectors: string[] = [];
    const walk = (rules: CSSRuleList) => { for (const r of rules) { if ('selectorText' in r) selectors.push((r as CSSStyleRule).selectorText); else if ('cssRules' in r) walk((r as CSSGroupingRule).cssRules); } };
    walk(ours[0].cssRules);
    expect(selectors.length).toBeGreaterThan(5);
    for (const s of selectors) expect(s.split(/,\s*/).every((one) => /^:where\(.+\)$/.test(one)), s).toBe(true);
  });
});

describe('a map inside a shadow root of the page\'s own (a host app\'s component)', () => {
  it('still gets the defaults (they go on the document, where :root is), and its theme attribute still forces a mode', async () => {
    document.adoptedStyleSheets = []; // as on a page no corn-* element has visited
    class Shell extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }); } }
    if (!customElements.get('test-shell')) customElements.define('test-shell', Shell);
    const shell = document.createElement('test-shell');
    document.body.append(shell);
    const el = await mountMap({}, { parent: shell.shadowRoot as unknown as Element });
    expect(tokenOf(el, GROUND)).toBe(DARK);
    el.setAttribute('theme', 'light');
    await frames(2);
    expect(tokenOf(el, GROUND)).toBe(LIGHT);
    const ours = (root: Document | ShadowRoot) => root.adoptedStyleSheets.filter((x) => (x as any)[Symbol.for('cornfield.default-tokens')]).length;
    expect([ours(document), ours(shell.shadowRoot!)]).toEqual([1, 1]);
  });
});

describe('a host overrides them with an ordinary rule', () => {
  it('on :root, even one with the least specificity a rule can have', async () => {
    const el = await mountMap();
    hostRule(':root { --corn-ground: #123456; }');
    expect(tokenOf(el, GROUND)).toBe('#123456');
    expect(tokenOf(el, '--corn-accent')).toBeTruthy(); // the rest still comes from the defaults
    hostRule('html { --corn-text: #abcdef; }');
    expect(tokenOf(el, '--corn-text')).toBe('#abcdef');
  });

  it('beats the light block too: the rule wins in either mode', async () => {
    const el = await mountMap();
    hostRule(':root { --corn-ground: #123456; }');
    await commands.colorScheme('light');
    expect(tokenOf(el, GROUND)).toBe('#123456');
  });

  it('on one element: that element only', async () => {
    const a = await mountMap({ id: 'a' });
    const b = await mountMap({ id: 'b' });
    hostRule('#a { --corn-ground: #654321; }');
    expect(tokenOf(a, GROUND)).toBe('#654321');
    expect(tokenOf(b, GROUND)).toBe(DARK);
  });

  it('on a wrapper: the maps inside it', async () => {
    const wrap = document.createElement('section');
    wrap.className = 'tasks';
    document.body.append(wrap);
    const inside = await mountMap({}, { parent: wrap });
    const outside = await mountMap();
    hostRule('.tasks { --corn-ground: #0a0b0c; }');
    expect(tokenOf(inside, GROUND)).toBe('#0a0b0c');
    expect(tokenOf(outside, GROUND)).toBe(DARK);
  });
});

describe('the theme attribute', () => {
  it('theme="light" forces light on a dark page, and theme="dark" forces dark on a light one', async () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const light = await mountMap({ theme: 'light' });
    expect(tokenOf(light, GROUND)).toBe(LIGHT);
    expect(tokenOf(light, '--corn-text')).toBe(valueIn(rule(':root[data-theme="light"]'), '--corn-text'));
    expect(getComputedStyle(light).colorScheme).toBe('light');
    document.documentElement.setAttribute('data-theme', 'light');
    const dark = await mountMap({ theme: 'dark' });
    expect(tokenOf(dark, GROUND)).toBe(DARK);
    expect(getComputedStyle(dark).colorScheme).toBe('dark');
    expect(tokenOf(light, GROUND)).toBe(LIGHT);
  });

  it('a token built from others is worked out from the element\'s own mode, not the page\'s', async () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const page = await mountMap();
    const forced = await mountMap({ theme: 'light' });
    const ok = (el: HTMLElement, name: string) => tokenOf(el, name);
    expect(ok(forced, '--corn-ok')).not.toBe(ok(page, '--corn-ok'));
    // --corn-ok-soft is color-mix(--corn-ok ...): worked out from the light --corn-ok on one, the dark one on the other
    expect(ok(forced, '--corn-ok-soft')).toContain(ok(forced, '--corn-ok'));
    expect(ok(page, '--corn-ok-soft')).toContain(ok(page, '--corn-ok'));
  });

  it('auto is the same as no attribute, and the attribute can be changed at run time', async () => {
    const el = await mountMap({ theme: 'auto' });
    expect(tokenOf(el, GROUND)).toBe(DARK);
    el.setAttribute('theme', 'light');
    expect(tokenOf(el, GROUND)).toBe(LIGHT);
    el.setAttribute('theme', 'auto');
    expect(tokenOf(el, GROUND)).toBe(DARK);
  });

  it('a rule of the host on the element beats the forced mode for that token', async () => {
    const el = await mountMap({ id: 'forced', theme: 'light' });
    hostRule('#forced { --corn-ground: #222222; }');
    expect(tokenOf(el, GROUND)).toBe('#222222');
    expect(tokenOf(el, '--corn-text')).toBe(valueIn(rule(':root[data-theme="light"]'), '--corn-text'));
  });

  it('the map is drawn for the mode: forcing the other one changes the picture, and the page\'s own switch changes an element that has no theme', async () => {
    const topology = await smallTopology();
    const el = await mountMap({ renderer: 'canvas2d', theme: 'dark' }, { topology });
    const dark = pixelsOf(canvasOf(el)).hash;
    el.setAttribute('theme', 'light');
    await frames(4);
    const light = pixelsOf(canvasOf(el)).hash;
    expect(light).not.toBe(dark);
    el.removeAttribute('theme');
    document.documentElement.setAttribute('data-theme', 'dark');
    await frames(4);
    expect(pixelsOf(canvasOf(el)).hash).toBe(dark);
    document.documentElement.setAttribute('data-theme', 'light');
    await frames(4);
    expect(pixelsOf(canvasOf(el)).hash).toBe(light);
  });
});

describe('tokens reach the picture inside the shadow root', () => {
  const countOf = (canvas: HTMLCanvasElement, test: (r: number, g: number, b: number) => boolean) => {
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200 && test(data[i], data[i + 1], data[i + 2])) n++;
    return n;
  };

  it('two maps with different tokens draw each in its own colour', async () => {
    const topology = await smallTopology(30);
    hostRule(`#red { ${paintNodes('rgb(255, 0, 0)')} } #blue { ${paintNodes('rgb(0, 0, 255)')} }`);
    const red = await mountMap({ id: 'red', renderer: 'canvas2d', theme: 'dark' }, { topology });
    const blue = await mountMap({ id: 'blue', renderer: 'canvas2d', theme: 'dark' }, { topology });
    await steady(canvasOf(red));
    await steady(canvasOf(blue));
    const isRed = (r: number, g: number, b: number) => r > 200 && g < 70 && b < 70;
    const isBlue = (r: number, g: number, b: number) => b > 200 && r < 70 && g < 70;
    expect(countOf(canvasOf(red), isRed)).toBeGreaterThan(20);
    expect(countOf(canvasOf(red), isBlue)).toBe(0);
    expect(countOf(canvasOf(blue), isBlue)).toBeGreaterThan(20);
    expect(countOf(canvasOf(blue), isRed)).toBe(0);
  });

  it('a token changed at run time is read again by refresh()', async () => {
    const topology = await smallTopology(30);
    const el = await mountMap({ renderer: 'canvas2d', theme: 'dark' }, { topology });
    const before = (await steady(canvasOf(el))).hash;
    hostRule(`:root { ${paintNodes('rgb(255, 0, 255)')} }`); // a rule in the host's head: the map cannot see it arrive
    await el.refresh();
    await frames(3);
    expect((await steady(canvasOf(el))).hash).not.toBe(before);
  });
});
