// @vitest-environment happy-dom
/**
 * Spec 0011 D5, D6, D11: what a person sees while a map loads from a server and when it cannot (explorer/pieces/status.js): the words of each state
 * are `strings` keys with their defaults, every element has a hook and a part, nothing from the server reaches the page as markup, the sign-in link is
 * a real http(s) link with target _top and never a script, a polite region says each state once, and the focus is never taken but by the person's own Retry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXPLORER, CORNFIELD } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { createInstance } from '../../explorer/instance.js';
// @ts-expect-error plain JS modules, no declarations
import { createSource } from '../../explorer/engine/source.js';
// @ts-expect-error plain JS modules, no declarations
import { mount, cardHtml, announcement } from '../../explorer/pieces/status.js';
// @ts-expect-error plain JS modules, no declarations
import { setStrings } from '../../explorer/engine/strings.js';
// @ts-expect-error plain JS modules, no declarations
import { STRINGS } from '../../core/strings.js';

let root;
let stage;
let inst;
beforeEach(() => {
  document.body.innerHTML = '<div id="root"><div id="stage"></div></div>';
  root = document.getElementById('root');
  stage = document.getElementById('stage');
  inst = createInstance({ root, base: 'https://map.example.com', fetch: vi.fn() });
});
const card = () => stage.querySelector('[data-corn="source-status"]');
const live = () => stage.querySelector('[data-corn="source-announcer"]');
const notice = () => stage.querySelector('[data-corn="source-notice"]');
const words = () => (card().hidden ? '' : card().textContent);

describe('the words (strings keys with defaults)', () => {
  it('holds a default for every word the states say, as one line of plain text', () => {
    for (const key of ['sourceLoading', 'sourceSignIn', 'sourceSignInText', 'sourceNotListed', 'sourceNotListedHint', 'sourceOffline', 'sourceOfflineText', 'sourceBadAddress', 'sourceVersion', 'sourceSecondMap']) expect(typeof STRINGS[key], key).toBe('string');
    expect(STRINGS.sourceSignIn).toBe('Sign in to cornfield');
    expect(STRINGS.sourceNotListed).toBe('This page is not listed by that cornfield');
  });
  it('every key the status reads is in the table, and none is spelled in the module', () => {
    const code = fs.readFileSync(path.join(EXPLORER, 'pieces', 'status.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const read = [...code.matchAll(/t\(inst, '(\w+)'\)/g)].map((m) => m[1]);
    expect(read.length).toBeGreaterThanOrEqual(10);
    for (const key of read) expect(Object.hasOwn(STRINGS, key), key).toBe(true);
    expect(code).not.toMatch(/Sign in to cornfield|not listed by that/); // the words are the table's
  });
  it('speaks in the instance\'s own voice', () => {
    setStrings(inst, { sourceSignIn: 'Connect to Tasks', sourceSignInText: 'Please connect.' });
    expect(cardHtml(inst, { state: 'sign-in', status: 401, signIn: 'https://map.example.com/auth/start' })).toContain('Connect to Tasks');
    expect(announcement(inst, { state: 'sign-in' })).toBe('Connect to Tasks. Please connect.');
  });
});

describe('each state', () => {
  it('loading: a quiet line, `running`, and nothing to press', () => {
    const source = createSource(inst, {});
    mount(stage, inst, {});
    source.say({ state: 'loading' });
    expect(words()).toBe('Loading the map …');
    expect(card().getAttribute('data-corn-state')).toBe('running');
    expect(card().querySelector('a, button')).toBe(null);
  });
  it('sign in: a link to the server\'s sign-in, target _top, rel noopener, a primary kind, and a sentence', () => {
    const source = createSource(inst, {});
    mount(stage, inst, {});
    const signIn = 'https://map.example.com/auth/start?returnTo=https%3A%2F%2Ftasks.example.com%2F';
    source.say({ state: 'sign-in', status: 401, signIn });
    const link = card().querySelector('a');
    expect(link.getAttribute('href')).toBe(signIn);
    expect(link.getAttribute('target')).toBe('_top');
    expect(link.getAttribute('rel')).toBe('noopener');
    expect(link.getAttribute('data-corn')).toBe('source-sign-in');
    expect(link.getAttribute('data-corn-kind')).toBe('primary');
    expect(card().getAttribute('data-corn-state')).toBe('waiting');
    expect(words()).toContain("This map is behind cornfield's sign-in.");
  });
  it('not listed: the origin it should list in a code element, and Retry', () => {
    const source = createSource(inst, {});
    mount(stage, inst, {});
    source.say({ state: 'not-allowed', origin: 'https://tasks.example.com' });
    expect(words()).toContain('This page is not listed by that cornfield');
    expect(card().querySelector('code[data-corn="source-origin"]').textContent).toBe('https://tasks.example.com');
    expect(card().getAttribute('data-corn-state')).toBe('failure');
    expect(card().querySelector('button[data-corn="source-retry"]').textContent).toBe('Retry');
  });
  it('offline, a server error and a bad address', () => {
    const source = createSource(inst, {});
    mount(stage, inst, {});
    source.say({ state: 'offline' });
    expect(words()).toContain('The map cannot be reached');
    expect(card().getAttribute('data-corn-state')).toBe('stopped');
    source.say({ state: 'server', status: 500, message: 'GET /topology.json answered 500' });
    expect(words()).toContain('The map could not be loaded');
    expect(words()).toContain('answered 500');
    source.say({ state: 'address', problem: 'is not http or https' });
    expect(words()).toContain('That is not the address of a cornfield server');
    expect(words()).toContain('is not http or https');
    expect(card().querySelector('button')).toBe(null); // there is nothing to retry
  });
  it('ready takes the card away; the version notice is a line of its own that stays, and says both numbers', () => {
    const source = createSource(inst, {});
    mount(stage, inst, {});
    source.say({ state: 'loading' });
    source.say({ state: 'version', server: '0.9.0', package: '0.8.0', drift: 'minor' });
    expect(notice().hidden).toBe(false);
    expect(notice().textContent).toBe('This map and its server are different versions (0.8.0 / 0.9.0)');
    source.say({ state: 'ready' });
    expect(card().hidden).toBe(true);
    expect(notice().hidden).toBe(false);
  });
  it('a second map is refused in its own box and follows nothing', () => {
    const source = createSource(inst, {});
    const piece = mount(stage, inst, { follow: false });
    piece.refuse('second-map');
    expect(words()).toBe('This scope already has a map');
    expect(card().getAttribute('data-corn-state')).toBe('failure');
    source.say({ state: 'ready' });
    expect(words()).toBe('This scope already has a map'); // the load is the first map's
  });
});

describe('what the server says is never markup, and a link is only a web link', () => {
  it('escapes the origin, a server\'s message and a bad address\'s problem', () => {
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    for (const detail of [{ state: 'not-allowed', origin: hostile }, { state: 'server', status: 500, message: hostile }, { state: 'address', problem: hostile }]) {
      const html = cardHtml(inst, detail);
      expect(html).not.toContain('<img');
      expect(html).not.toContain('<script');
      const box = document.createElement('div');
      box.innerHTML = html;
      expect(box.querySelector('img, script')).toBe(null);
      expect(box.textContent).toContain(hostile);
    }
  });
  it('puts no link in the page that is not http(s): a sign-in that is a script URL is left out', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.test/', '/auth/start', 'https://x.test/ a', 'https://x.test/\\y', '', null]) {
      expect(cardHtml(inst, { state: 'sign-in', status: 401, signIn: bad }), String(bad)).not.toContain('<a ');
    }
    expect(cardHtml(inst, { state: 'sign-in', status: 401, signIn: 'https://map.example.com/auth/start?returnTo=x"onclick="alert(1)' })).not.toContain('onclick="alert');
  });
  it('every element made has a data-corn hook from the fixed list, and a part of the same name', () => {
    const source = createSource(inst, {});
    mount(stage, inst, {});
    const seen = new Set();
    for (const detail of [{ state: 'sign-in', status: 401, signIn: 'https://map.example.com/auth/start' }, { state: 'not-allowed', origin: 'https://t.example.com' }, { state: 'server', status: 500, message: 'x' }, { state: 'version', server: '1.0.0', package: '0.9.0', drift: 'minor' }]) {
      source.say(detail);
      for (const el of stage.querySelectorAll('*')) { expect(el.getAttribute('part'), el.outerHTML).toBe(el.getAttribute('data-corn')); seen.add(el.getAttribute('data-corn')); }
    }
    expect([...seen].sort()).toEqual(['source-announcer', 'source-notice', 'source-origin', 'source-retry', 'source-sign-in', 'source-status', 'source-text', 'source-title']);
    const docs = fs.readFileSync(path.join(CORNFIELD, 'docs', 'theming.md'), 'utf8');
    for (const hook of seen) expect(docs, hook).toContain(`\`${hook}\``);
  });
});

describe('what a screen reader is told, and where the focus goes', () => {
  it('a polite status region says each state once, not again for the same state', () => {
    const source = createSource(inst, {});
    mount(stage, inst, {});
    expect(live().getAttribute('role')).toBe('status');
    expect(live().getAttribute('aria-live')).toBe('polite');
    const observer = new MutationObserver(() => {});
    observer.observe(live(), { childList: true, characterData: true, subtree: true });
    source.say({ state: 'loading' });
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    expect(live().textContent).toBe('Loading the map …');
    source.say({ state: 'not-allowed', origin: 'https://t.example.com' });
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    expect(live().textContent).toBe('This page is not listed by that cornfield. Add this origin to embed.origins on the server:. https://t.example.com');
    source.say({ state: 'not-allowed', origin: 'https://t.example.com' }); // the same again: said once
    expect(observer.takeRecords().length).toBe(0);
  });
  it('never takes the focus when a state comes', () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    const source = createSource(inst, {});
    mount(stage, inst, {});
    for (const detail of [{ state: 'loading' }, { state: 'sign-in', status: 401, signIn: 'https://map.example.com/auth/start' }, { state: 'offline' }, { state: 'ready' }]) {
      source.say(detail);
      expect(document.activeElement).toBe(outside);
    }
  });
  it('Retry asks again (onRetry) and keeps the focus with the card; when the map comes the focus goes to the map', () => {
    const source = createSource(inst, {});
    const onRetry = vi.fn();
    const focusMap = vi.fn();
    mount(stage, inst, { onRetry, focusMap });
    source.say({ state: 'offline' });
    const retry = card().querySelector('button');
    retry.focus();
    expect(document.activeElement).toBe(retry);
    retry.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    source.say({ state: 'loading' });
    expect(card().contains(document.activeElement) || document.activeElement === card()).toBe(true); // not dropped to the page
    source.say({ state: 'ready' });
    expect(focusMap).toHaveBeenCalledTimes(1);
  });
  it('a piece that joins late shows where the load is now', () => {
    const source = createSource(inst, { pageUrl: () => 'https://t.example.com/' });
    source.say({ state: 'sign-in', status: 401, signIn: 'https://map.example.com/auth/start' });
    source.say({ state: 'version', server: '1.0.0', package: '0.9.0', drift: 'minor' });
    mount(stage, inst, {});
    expect(words()).toContain('Sign in to cornfield');
    expect(notice().hidden).toBe(false);
  });
  it('ends cleanly: the elements go and the instance has nothing left of it', () => {
    const source = createSource(inst, {});
    const piece = mount(stage, inst, {});
    source.say({ state: 'offline' });
    piece.destroy();
    expect(stage.children.length).toBe(0);
    source.say({ state: 'sign-in', status: 401, signIn: 'https://map.example.com/auth/start' });
    expect(stage.children.length).toBe(0);
    piece.destroy(); // twice is safe
  });
});
