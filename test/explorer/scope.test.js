// @vitest-environment happy-dom
/**
 * Spec 0011 D5: a scope and the pieces inside it (explorer/pieces/scope.js), with plain elements standing for the pieces: how a piece finds its scope,
 * what happens to it when a scope comes, goes or changes its `src`, two scopes on one page with two servers, and an end that leaves nothing, in-flight
 * reads included. The map in a scope and everything a browser does is in components/test/scope.browser.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXPLORER } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { CHANGED, REQUEST, joinScope, mountScope, scopeInfo } from '../../explorer/pieces/scope.js';
// @ts-expect-error plain JS modules, no declarations
import { createInstance } from '../../explorer/instance.js';
// @ts-expect-error plain JS modules, no declarations
import { sourceOf } from '../../explorer/engine/source.js';
// @ts-expect-error plain JS modules, no declarations
import { t } from '../../explorer/engine/strings.js';

const TOPOLOGY = (ids) => ({ nodes: ids.map((id) => ({ id, label: id, type: 'core' })), edges: [] });
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, statusText: status === 401 ? 'Unauthorized' : 'OK', json: async () => body, text: async () => '' });
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A fetch by server (origin) and path; records the calls */
function network(servers) {
  const calls = [];
  const fetch = vi.fn(async (url, init) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), init });
    const route = servers[u.origin] && servers[u.origin][u.pathname];
    if (route === 'refuse') throw new TypeError('Failed to fetch');
    if (typeof route === 'function') return route(init);
    return route || json({}, 404);
  });
  return { fetch, calls };
}

/** A piece: an element that asks for its scope when it connects, as a component's shell does */
function piece(parent, id) {
  const el = document.createElement('div');
  el.id = id;
  el.localName; // eslint-disable-line no-unused-expressions
  const state = { inst: null, joins: 0, join: null };
  const join = () => { state.join = joinScope(el, () => { state.join.leave(); join(); }); state.inst = state.join.inst; state.joins++; };
  parent.append(el);
  join();
  return { el, state };
}

let net;
beforeEach(() => {
  document.body.innerHTML = '';
  net = network({
    'https://a.example.com': { '/cornfield/config.json': json({ version: '0.1.0', strings: { approve: 'Ship it' } }), '/topology.json': json(TOPOLOGY(['a1', 'a2'])) },
    'https://b.example.com': { '/cornfield/config.json': json({ version: '0.1.0' }), '/topology.json': json(TOPOLOGY(['b1'])) },
  });
  vi.stubGlobal('fetch', net.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('how a piece finds its scope', () => {
  it('asks with a composed, bubbling event from its own element, and the scope answers with its instance', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const scope = mountScope(host, { topology: TOPOLOGY(['x']) });
    const asked = [];
    document.body.addEventListener(REQUEST, (e) => asked.push(e), { once: true });
    const p = piece(host, 'p1');
    expect(p.state.inst).toBe(scope.instance);
    expect(asked).toHaveLength(0); // the scope stopped it: nothing above it heard
    expect(REQUEST).toBe('corn-scope-request');
    expect(CHANGED).toBe('corn-scope-changed');
    scope.destroy();
  });

  it('works whatever is between them: a shadow root of another element, a deep tree', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const scope = mountScope(host, { topology: TOPOLOGY(['x']) });
    const other = document.createElement('section');
    host.append(other);
    const shadow = other.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    shadow.append(inner);
    const deep = document.createElement('p');
    inner.append(deep);
    const p = piece(inner, 'deep');
    expect(p.state.inst).toBe(scope.instance);
    scope.destroy();
  });

  it('the nearest scope answers, and no other: a scope inside a scope is the inner one\'s', () => {
    const outer = document.createElement('div');
    const inner = document.createElement('div');
    outer.append(inner);
    document.body.append(outer);
    const so = mountScope(outer, { topology: TOPOLOGY(['o']) });
    const si = mountScope(inner, { topology: TOPOLOGY(['i']) });
    const p = piece(inner, 'p');
    const q = piece(outer, 'q');
    expect(p.state.inst).toBe(si.instance);
    expect(q.state.inst).toBe(so.instance);
    expect(si.instance).not.toBe(so.instance);
    si.destroy();
    so.destroy();
  });

  it('a piece with no scope around it has none: it makes a private instance', () => {
    const p = piece(document.body, 'alone');
    expect(p.state.inst).toBe(null);
  });

  it('a scope answers only a real request (a claim), and a forged event with none does nothing', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const scope = mountScope(host, {});
    expect(() => host.dispatchEvent(new CustomEvent(REQUEST, { bubbles: true, detail: null }))).not.toThrow();
    expect(() => host.dispatchEvent(new CustomEvent(REQUEST, { bubbles: true, detail: { claim: 'no' } }))).not.toThrow();
    scope.destroy();
  });

  it('a piece in a scope and one outside share nothing: the inner map\'s state is not the outer\'s', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const scope = mountScope(host, { topology: TOPOLOGY(['x']) });
    const inside = piece(host, 'in');
    const outside = piece(document.body, 'out');
    expect(inside.state.inst).toBe(scope.instance);
    expect(outside.state.inst).toBe(null);
    scope.destroy();
  });
});

describe('a scope that comes, goes and changes', () => {
  it('a scope put around pieces that are already there tells them to ask again (the walk finds them, in the light tree and in open shadow roots, not in a nested scope)', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const a = document.createElement('corn-map');
    host.append(a);
    const shadowHost = document.createElement('section');
    host.append(shadowHost);
    const shadow = shadowHost.attachShadow({ mode: 'open' });
    const b = document.createElement('corn-map');
    shadow.append(b);
    const nested = document.createElement('corn-scope');
    const c = document.createElement('corn-map');
    nested.append(c);
    host.append(nested);
    const told = [];
    for (const el of [a, b, c]) el.addEventListener(CHANGED, () => told.push(el === a ? 'a' : el === b ? 'b' : 'c'));
    const scope = mountScope(host, { topology: TOPOLOGY(['x']) });
    expect(told.sort()).toEqual(['a', 'b']);
    scope.destroy();
  });

  it('a scope that is destroyed tells the pieces it served, once each, and they ask again and are answered by no one (or by an outer scope)', () => {
    const outer = document.createElement('div');
    const inner = document.createElement('div');
    outer.append(inner);
    document.body.append(outer);
    const so = mountScope(outer, { topology: TOPOLOGY(['o']) });
    const si = mountScope(inner, { topology: TOPOLOGY(['i']) });
    const p = piece(inner, 'p');
    expect(p.state.inst).toBe(si.instance);
    si.destroy();
    expect(p.state.joins).toBe(2);
    expect(p.state.inst).toBe(so.instance); // the scope further up
    so.destroy();
    expect(p.state.joins).toBe(3);
    expect(p.state.inst).toBe(null);
  });

  it('src changing makes a new instance for the new server, tells the pieces to take it, and ends the old one', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const scope = mountScope(host, { src: 'https://a.example.com', version: '0.1.0' });
    await settle();
    const p = piece(host, 'p');
    const first = scope.instance;
    expect(p.state.inst).toBe(first);
    expect(sourceOf(first).topology.nodes.map((n) => n.id)).toEqual(['a1', 'a2']);
    const destroyed = vi.fn();
    first.own(destroyed);
    scope.update({ src: 'https://b.example.com' });
    expect(scope.instance).not.toBe(first);
    expect(p.state.inst).toBe(scope.instance);
    expect(destroyed).toHaveBeenCalledTimes(1);
    await settle();
    expect(sourceOf(scope.instance).topology.nodes.map((n) => n.id)).toEqual(['b1']);
    expect(sourceOf(first)).toBe(null); // the old instance has nothing left
    expect(t(scope.instance, 'approve')).toBe('Approve'); // the new server's words are its own (it overrides none)
    scope.destroy();
  });

  it('the same src again is no change; a new src with the same pieces keeps each told once', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const scope = mountScope(host, { src: 'https://a.example.com' });
    const p = piece(host, 'p');
    const before = p.state.joins;
    scope.update({ src: 'https://a.example.com' });
    expect(p.state.joins).toBe(before);
    scope.update({ src: 'https://b.example.com' });
    expect(p.state.joins).toBe(before + 1);
    scope.destroy();
  });
});

describe('two scopes on one page, two servers (D5)', () => {
  it('stay independent: each has its own instance, topology, words and sign-in state', async () => {
    net = network({
      'https://a.example.com': { '/cornfield/config.json': json({ strings: { approve: 'Ship it' } }), '/topology.json': json(TOPOLOGY(['a1'])) },
      'https://b.example.com': { '/cornfield/config.json': json({ ok: false }, 401) },
    });
    vi.stubGlobal('fetch', net.fetch);
    const [ha, hb] = [document.createElement('div'), document.createElement('div')];
    document.body.append(ha, hb);
    const errors = [];
    const auths = [];
    const a = mountScope(ha, { src: 'https://a.example.com', onAuth: (d) => auths.push(['a', d]), onError: (d) => errors.push(['a', d.kind]) });
    const b = mountScope(hb, { src: 'https://b.example.com', pageUrl: () => 'https://t.example.com/x', onAuth: (d) => auths.push(['b', d]), onError: (d) => errors.push(['b', d.kind]) });
    const pa = piece(ha, 'pa');
    const pb = piece(hb, 'pb');
    await settle();
    expect(pa.state.inst).toBe(a.instance);
    expect(pb.state.inst).toBe(b.instance);
    expect(a.instance).not.toBe(b.instance);
    expect(sourceOf(a.instance).topology.nodes[0].id).toBe('a1');
    expect(sourceOf(b.instance).topology).toBe(null);
    expect(t(a.instance, 'approve')).toBe('Ship it');
    expect(t(b.instance, 'approve')).toBe('Approve');
    expect(auths).toEqual([['b', { status: 401, signIn: `https://b.example.com/auth/start?returnTo=${encodeURIComponent('https://t.example.com/x')}` }]]);
    expect(errors).toEqual([]);
    a.destroy();
    b.destroy();
  });
});

describe('the scope\'s own words', () => {
  it('says cornReady once per server, cornAuth for a 401 and cornError for each refusal, with fixed kinds', async () => {
    net = network({
      'https://a.example.com': { '/cornfield/config.json': json({ version: '9.9.9' }), '/topology.json': json(TOPOLOGY(['a1'])) },
      'https://down.example.com': { '/cornfield/config.json': 'refuse', '/cornfield/theme.css': 'refuse' },
      'https://nolist.example.com': { '/cornfield/config.json': 'refuse', '/cornfield/theme.css': json({}) },
      'https://broken.example.com': { '/cornfield/config.json': json({}, 500) },
    });
    vi.stubGlobal('fetch', net.fetch);
    const log = [];
    for (const src of ['https://a.example.com', 'https://down.example.com', 'https://nolist.example.com', 'https://broken.example.com', 'ftp://nope.example.com']) {
      const host = document.createElement('div');
      document.body.append(host);
      const s = mountScope(host, { src, version: '0.1.0', pageUrl: () => 'https://t.example.com/', onReady: () => log.push([src, 'ready']), onError: (d) => log.push([src, d.kind]) });
      await settle();
      await settle();
      s.destroy();
    }
    expect(log).toEqual([
      ['https://a.example.com', 'version'], ['https://a.example.com', 'ready'],
      ['https://down.example.com', 'offline'],
      ['https://nolist.example.com', 'not-listed'],
      ['https://broken.example.com', 'server'],
      ['ftp://nope.example.com', 'address'],
    ]);
  });

  it('holds the host\'s objects: topology and config handed in make no request, even with a src', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const ready = vi.fn();
    const scope = mountScope(host, { src: 'https://a.example.com', topology: TOPOLOGY(['mine']), config: { version: '0.1.0' }, version: '0.1.0', onReady: ready });
    await settle();
    expect(net.calls).toEqual([]);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(sourceOf(scope.instance).topology.nodes[0].id).toBe('mine');
    scope.destroy();
  });

  it('stores nothing in the host page\'s storage: the viewer\'s layer choices are kept nowhere', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const scope = mountScope(host, { src: 'https://a.example.com' });
    await settle();
    expect(set).not.toHaveBeenCalled();
    scope.destroy();
    set.mockRestore();
  });
});

describe('the end: nothing is left, in-flight reads included', () => {
  it('a scope destroyed while a read is out aborts it and says nothing afterwards', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let signal;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { signal = init.signal; await gate; return json({}, 200); }));
    const host = document.createElement('div');
    document.body.append(host);
    const said = [];
    const scope = mountScope(host, { src: 'https://a.example.com', onReady: () => said.push('ready'), onError: (d) => said.push(d.kind), onAuth: () => said.push('auth') });
    await settle();
    expect(signal.aborted).toBe(false);
    scope.destroy();
    expect(signal.aborted).toBe(true);
    release();
    await settle();
    expect(said).toEqual([]);
  });

  it('removes the listeners it added to the host and the page, the observers and the instance\'s clean-ups', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const added = [];
    const removed = [];
    const add = host.addEventListener.bind(host);
    const remove = host.removeEventListener.bind(host);
    host.addEventListener = (type, fn, o) => { added.push(type); return add(type, fn, o); };
    host.removeEventListener = (type, fn, o) => { removed.push(type); return remove(type, fn, o); };
    const disconnects = [];
    const RealMutation = window.MutationObserver;
    window.MutationObserver = class extends RealMutation { disconnect() { disconnects.push(1); return super.disconnect(); } };
    const scope = mountScope(host, { src: 'https://a.example.com' });
    const inst = scope.instance;
    scope.destroy();
    window.MutationObserver = RealMutation;
    expect(added).toEqual([REQUEST]);
    expect(removed).toEqual([REQUEST]);
    expect(disconnects.length).toBeGreaterThanOrEqual(1);
    expect(sourceOf(inst)).toBe(null);
    // twice is safe
    scope.destroy();
  });

  it('makes and ends a scope with a piece fifty times and nothing is left (no listener on the host, no piece held)', () => {
    const host = document.createElement('div');
    document.body.append(host);
    let live = 0;
    const add = host.addEventListener.bind(host);
    const remove = host.removeEventListener.bind(host);
    host.addEventListener = (type, fn, o) => { live++; return add(type, fn, o); };
    host.removeEventListener = (type, fn, o) => { live--; return remove(type, fn, o); };
    for (let i = 0; i < 50; i++) {
      const scope = mountScope(host, { topology: TOPOLOGY(['x']) });
      const p = piece(host, `p${i}`);
      p.state.join.leave();
      p.el.remove();
      scope.destroy();
    }
    expect(live).toBe(0);
  });

  it('an instance given to a scope has one root for its map at a time: a second attach throws, a release gives the root back', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const scope = mountScope(host, {});
    const inst = scope.instance;
    expect(inst.root).toBe(host);
    const shadow1 = document.createElement('div').attachShadow({ mode: 'open' });
    const shadow2 = document.createElement('div').attachShadow({ mode: 'open' });
    const release = inst.attach(shadow1);
    expect(inst.root).toBe(shadow1);
    expect(() => inst.attach(shadow2)).toThrow('already has a map');
    release();
    expect(inst.root).toBe(host);
    const again = inst.attach(shadow2);
    expect(inst.root).toBe(shadow2);
    scope.destroy(); // ends the instance, which gives the root back
    expect(inst.root).toBe(host);
    again();
  });

  it('scopeInfo is there for a scope\'s instance and not for a private one', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const scope = mountScope(host, { theme: 'dark' });
    expect(scopeInfo(scope.instance).theme).toBe('dark');
    expect(scopeInfo(createInstance({ root: document.createElement('div') }))).toBe(null);
    scope.destroy();
  });
});

describe('config never becomes script (D10)', () => {
  it('a config that names plugin modules, scripts, an import map and links is only data: nothing is imported, evaluated or added to the page', async () => {
    const dynamic = vi.fn();
    const config = {
      version: '0.1.0',
      sources: { live: { module: '/repo/plugins/live.js', options: {} }, house: { module: 'https://evil.test/x.js' } },
      links: [{ label: 'x', href: 'javascript:alert(1)' }], brand: { logo: 'https://evil.test/l.js' }, docs: 'javascript:1',
      importMap: { imports: { x: '/y.js' } }, strings: { approve: 'Ship it' },
    };
    net = network({ 'https://a.example.com': { '/cornfield/config.json': json(config), '/topology.json': json(TOPOLOGY(['a1'])) } });
    vi.stubGlobal('fetch', net.fetch);
    const scriptsBefore = document.querySelectorAll('script').length;
    const create = vi.spyOn(document, 'createElement');
    const evalSpy = vi.spyOn(globalThis, 'eval');
    const host = document.createElement('div');
    document.body.append(host);
    const scope = mountScope(host, { src: 'https://a.example.com', version: '0.1.0', onReady: dynamic, tokens: '' });
    await settle();
    expect(dynamic).toHaveBeenCalled();
    expect(net.calls.map((c) => new URL(c.url).pathname)).toEqual(['/cornfield/config.json', '/topology.json']); // no module, no script
    expect(create.mock.calls.filter(([tag]) => /^(script|link|iframe|object|embed)$/i.test(String(tag)))).toEqual([]);
    expect(document.querySelectorAll('script, link, iframe').length).toBe(scriptsBefore);
    expect(evalSpy).not.toHaveBeenCalled();
    expect(t(scope.instance, 'approve')).toBe('Ship it'); // what is taken from a config is its words
    scope.destroy();
    create.mockRestore();
    evalSpy.mockRestore();
  });

  /** A dynamic import that is not a literal path of the package's own: `import(name)`, `import('https://…')`, `import(\`./${x}.js\`)` */
  const DYNAMIC_IMPORT = /\bimport\s*\(\s*(?!['"]\.\/[\w.-]+\.js['"]\s*\))/;
  it('the check for a dynamic import is not blind: a literal chunk of the package\'s own passes, a computed one or another origin\'s does not', () => {
    expect(DYNAMIC_IMPORT.test("import('./scope-proposal.js')")).toBe(false);
    for (const bad of ['import(name)', "import('https://elsewhere.example/x.js')", 'import(`./${x}.js`)', "import('../x.js')", "import ( config.plugin )"]) expect(DYNAMIC_IMPORT.test(bad), bad).toBe(true);
  });

  it('the modules that load from a server hold no way to run what a config names: no import() but of a literal chunk of the package\'s own (pieces/scope-proposal.js), eval, Function, script element, worker, blob or import map', () => {
    for (const file of ['engine/source.js', 'engine/theme-sheet.js', 'pieces/scope.js', 'pieces/status.js']) {
      const code = fs.readFileSync(path.join(EXPLORER, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/(^|\s)\/\/\s.*$/gm, '$1');
      for (const [name, re] of [['import() of anything but a chunk of the package\'s own, named by a literal path', DYNAMIC_IMPORT], ['eval', /\beval\s*\(/], ['Function', /\bnew\s+Function\b|\bFunction\s*\(/], ['a script element', /createElement\(\s*['"`]script/i], ['a worker', /\bnew\s+(?:Shared)?Worker\b/], ['a blob', /\bURL\.createObjectURL\b|\bnew\s+Blob\b/], ['an import map', /importmap|importMap/i], ['document.write', /document\.write/], ['a timer given a string', /set(?:Timeout|Interval)\(\s*['"`]/]]) {
        expect(re.test(code), `${file} has ${name}`).toBe(false);
      }
    }
  });
});
