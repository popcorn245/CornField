// @vitest-environment happy-dom
/**
 * Spec 0011 D6, D10, D11: where the map's data comes from (explorer/engine/source.js). The pure parts (the address, the versions, the way back
 * from sign-in), the reads through an instance (cornfield's own page asks exactly what it always asked; a server of another origin is asked with
 * the session), the states the load tells the instance, two sources on one page that do not touch each other, and an end that leaves nothing
 * in flight. The browser proof (test/fixtures/big/scope-proof.mjs) holds the same against a real server.
 */
import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { createInstance } from '../../explorer/instance.js';
// @ts-expect-error plain JS modules, no declarations
import { CONFIG_PATH, TOPOLOGY_PATH, SourceError, applyConfig, compareVersions, createSource, fetchConfig, fetchTopology, originOf, parseSource, signInUrl, sourceOf } from '../../explorer/engine/source.js';
// @ts-expect-error plain JS modules, no declarations
import { t } from '../../explorer/engine/strings.js';
// @ts-expect-error plain JS modules, no declarations
import { mapStyleOf } from '../../explorer/engine/map-style.js';

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, statusText: status === 401 ? 'Unauthorized' : status === 200 ? 'OK' : 'Error', json: async () => body });
const TOPOLOGY = { nodes: [{ id: 'a', label: 'A', type: 'app' }], edges: [] };
const BASE = 'https://map.example.com';

/** A fetch stub: routes by path (query ignored), and records every call as [url, init] */
function server(routes) {
  const calls = [];
  const fetch = vi.fn(async (url, init) => {
    calls.push([String(url), init]);
    const path = new URL(String(url), BASE).pathname;
    const route = routes[path];
    if (route === 'refuse') throw new TypeError('Failed to fetch');
    if (typeof route === 'function') return route(init);
    if (!route) return json({}, 404);
    return route;
  });
  return { fetch, calls };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const said = (inst) => { const out = []; inst.on('source', (d) => out.push(d)); return out; };

describe('the address of a server', () => {
  it('is an http(s) origin with an optional path, without its trailing slash', () => {
    expect(parseSource('https://map.example.com')).toEqual({ ok: true, base: 'https://map.example.com', origin: 'https://map.example.com' });
    expect(parseSource(' https://map.example.com/ ').base).toBe('https://map.example.com');
    expect(parseSource('https://example.com/cornfield/')).toMatchObject({ ok: true, base: 'https://example.com/cornfield', origin: 'https://example.com' });
    expect(parseSource('http://map.corn.localhost:3780').base).toBe('http://map.corn.localhost:3780');
  });
  it('refuses everything else and says what is wrong', () => {
    const bad = ['', '   ', 'map.example.com', '//map.example.com', 'javascript:alert(1)', 'ftp://map.example.com', 'data:text/html,hi', 'https://user:pw@map.example.com',
      'https://map.example.com?x=1', 'https://map.example.com/#top', 'https://map.example.com\\@evil.test', 'https://map.example.com/a b', 'https://', null, undefined, 42, {}];
    for (const src of bad) {
      const r = parseSource(src);
      expect(r.ok, String(src)).toBe(false);
      expect(typeof r.problem, String(src)).toBe('string');
    }
  });
});

describe('versions (D11)', () => {
  it('a different minor or major is a drift; a patch alone is not', () => {
    expect(compareVersions('0.48.0', '0.48.0')).toBe('same');
    expect(compareVersions('0.48.0', '0.48.3')).toBe('patch');
    expect(compareVersions('0.48.0', '0.49.0')).toBe('minor');
    expect(compareVersions('1.2.0', '0.49.0')).toBe('major');
    expect(compareVersions('0.48.0', '0.47.9')).toBe('minor');
    expect(compareVersions('v1.0.0-rc.1', '1.0.0')).toBe('same');
  });
  it('cannot compare what is not x.y.z', () => {
    for (const bad of ['', 'dev', undefined, null, '1.2', '9.0.0<img src=x onerror=alert(1)>', '9.0.0 and more', '9.0.0-<b>', '1'.repeat(12) + '.0.0']) { expect(compareVersions('0.1.0', bad), String(bad)).toBe('unknown'); expect(compareVersions(bad, '0.1.0')).toBe('unknown'); }
    expect(compareVersions('0.1.0', 'v1.0.0-rc.1')).toBe('major');
    expect(compareVersions('0.1.0', ' 0.2.0+build.7 ')).toBe('minor');
  });
});

describe('the way back from sign-in', () => {
  it('is the server\'s /auth/start with returnTo set to this page', () => {
    const href = signInUrl(BASE, 'https://tasks.example.com/reviews/7?x=1#top');
    expect(href).toBe(`${BASE}/auth/start?returnTo=${encodeURIComponent('https://tasks.example.com/reviews/7?x=1#top')}`);
    expect(new URL(href).searchParams.get('returnTo')).toBe('https://tasks.example.com/reviews/7?x=1#top');
  });
  it('never sends a user name or password of the page\'s address, and keeps odd characters, queries and fragments whole', () => {
    const href = signInUrl(BASE, 'https://user:s3cret@tasks.example.com/a?b=%22<x>%22&returnTo=https://evil.test#frag/<b>?x=1');
    expect(href).not.toMatch(/s3cret|user/);
    const back = new URL(href).searchParams.get('returnTo');
    expect(back).toBe('https://tasks.example.com/a?b=%22%3Cx%3E%22&returnTo=https://evil.test#frag/%3Cb%3E?x=1');
    expect(new URL(href).origin).toBe(BASE);
    expect(new URL(href).pathname).toBe('/auth/start');
    expect([...new URL(href).searchParams.keys()]).toEqual(['returnTo']);
    expect(signInUrl(BASE, 'https://[bad')).toBe(`${BASE}/auth/start`);
  });
  it('keeps a path on the server, and has no way back for a page that is not http(s)', () => {
    expect(signInUrl('https://example.com/cornfield', 'https://t.example.com/')).toMatch(/^https:\/\/example\.com\/cornfield\/auth\/start\?returnTo=/);
    expect(signInUrl(BASE, 'file:///tmp/x.html')).toBe(`${BASE}/auth/start`);
    expect(signInUrl(BASE, '')).toBe(`${BASE}/auth/start`);
    expect(originOf('https://tasks.example.com/a/b?c')).toBe('https://tasks.example.com');
    expect(originOf('about:blank')).toBe('');
  });
});

describe('the base address of an instance', () => {
  it('joins a served path onto the path of the base', () => {
    expect(createInstance({ base: 'https://example.com/cornfield' }).url('/topology.json')).toBe('https://example.com/cornfield/topology.json');
    expect(createInstance({ base: 'https://example.com' }).url('/topology.json')).toBe('https://example.com/topology.json');
    expect(createInstance({ base: 'https://example.com/cornfield' }).url('https://elsewhere.test/x')).toBe('https://elsewhere.test/x');
  });
});

describe('cornfield\'s own page (no base) asks what it always asked', () => {
  it('reads the config with { cache: "no-store" } and nothing else, the topology with no options', async () => {
    const s = server({ [CONFIG_PATH]: json({ title: 'x' }), [TOPOLOGY_PATH]: json(TOPOLOGY) });
    const inst = createInstance({ fetch: s.fetch });
    expect(await fetchConfig(inst)).toEqual({ title: 'x' });
    expect(await fetchTopology(inst)).toEqual(TOPOLOGY);
    expect(s.calls[0]).toEqual([CONFIG_PATH, { cache: 'no-store' }]);
    expect(s.calls[1][0]).toMatch(/^\/topology\.json\?v=\d+$/);
    expect(s.calls[1][1]).toBeUndefined();
    await fetchTopology(inst, '/topology.json?fixture=5k');
    expect(s.calls[2][0]).toMatch(/^\/topology\.json\?fixture=5k&v=\d+$/);
  });
  it('says what it always said when the topology cannot be had', async () => {
    const inst = createInstance({ fetch: server({ [TOPOLOGY_PATH]: json({}, 500), '/empty.json': json({ nodes: [] }) }).fetch });
    // the words main's page said (view.js before engine/source.js): the address without the cache-buster
    await expect(fetchTopology(inst)).rejects.toThrow(/^GET \/topology\.json answered 500 Error$/);
    await expect(fetchTopology(inst, '/topology.json?fixture=5k')).rejects.toThrow(/^GET \/topology\.json\?fixture=5k answered 500 Error$/);
    await expect(fetchTopology(inst)).rejects.toMatchObject({ kind: 'server', status: 500 });
    await expect(fetchTopology(inst, '/empty.json')).rejects.toThrow('/empty.json has no nodes');
  });
});

describe('a server of another origin (a base) is asked with the session', () => {
  it('reads the config and the topology with credentials: "include", at the base', async () => {
    const s = server({ [CONFIG_PATH]: json({ title: 'x' }), [TOPOLOGY_PATH]: json(TOPOLOGY) });
    const inst = createInstance({ base: BASE, fetch: s.fetch });
    await fetchConfig(inst);
    await fetchTopology(inst);
    expect(s.calls[0]).toEqual([`${BASE}${CONFIG_PATH}`, { cache: 'no-store', credentials: 'include' }]);
    expect(s.calls[1][0]).toMatch(/^https:\/\/map\.example\.com\/topology\.json\?v=\d+$/);
    expect(s.calls[1][1]).toEqual({ credentials: 'include' });
  });
  it('sends the session only to the base\'s own origin: never to an absolute URL or a //host path elsewhere, whatever is asked', async () => {
    const s = server({ [TOPOLOGY_PATH]: json(TOPOLOGY), '/cornfield/topology.json': json(TOPOLOGY), '/other/topology.json': json(TOPOLOGY) });
    const inst = createInstance({ base: 'https://example.com/cornfield', fetch: s.fetch });
    await fetchTopology(inst, 'https://elsewhere.test/topology.json').catch(() => {});
    await fetchTopology(inst, '//elsewhere.test/topology.json').catch(() => {});
    await fetchTopology(inst, 'https://example.com/other/topology.json').catch(() => {});
    await fetchTopology(inst, TOPOLOGY_PATH);
    expect(s.calls.map(([u, init]) => [u.replace(/[?&]v=\d+/, ''), init && init.credentials])).toEqual([
      ['https://elsewhere.test/topology.json', undefined],
      ['//elsewhere.test/topology.json', undefined],
      ['https://example.com/other/topology.json', 'include'],
      ['https://example.com/cornfield/topology.json', 'include'],
    ]);
  });
  it('tells a refusal to sign in from a missing answer', async () => {
    const inst = createInstance({ base: BASE, fetch: server({ [CONFIG_PATH]: json({ ok: false }, 401), '/topology.json': json({}, 403), '/x': 'refuse' }).fetch });
    await expect(fetchConfig(inst)).rejects.toMatchObject({ kind: 'auth', status: 401 });
    await expect(fetchTopology(inst)).rejects.toMatchObject({ kind: 'auth', status: 403 });
    await expect(inst.fetch('/x')).rejects.toBeInstanceOf(TypeError);
    expect(new SourceError('network', 'x').kind).toBe('network');
  });
});

describe('what an instance takes from a config (as the page does)', () => {
  it('takes the words, the project\'s layers and the map\'s theme', () => {
    const inst = createInstance({ base: BASE });
    const icons = [];
    const style = mapStyleOf(inst);
    const spy = vi.spyOn(style, 'applyTheme').mockImplementation((theme) => { icons.push(theme); });
    applyConfig(inst, { strings: { approve: 'Ship it', notAKey: 'x' }, theme: { icons: { 'app:web': '/cornfield/theme/assets/web.svg' } }, layers: { add: [{ key: 'jobs', label: 'Background jobs', desc: 'What runs on a clock', match: { type: 'service', kind: ['timer'] } }], off: ['jobs'], order: ['app', 'jobs'] } });
    expect(t(inst, 'approve')).toBe('Ship it');
    expect(inst.strings.notAKey).toBeUndefined();
    expect(icons).toEqual([{ icons: { 'app:web': '/cornfield/theme/assets/web.svg' } }]);
    expect(inst.state.projectLayers.map((l) => l.key)).toContain('jobs');
  });
  it('loads a theme\'s icons from the base, as images asked for with CORS and without a cookie', () => {
    const urls = [];
    const inst = createInstance({ base: BASE });
    const store = mapStyleOf(inst).setIcons({ icons: { 'app:web': '/cornfield/theme/assets/web.svg' } }, { load: (u) => { urls.push(u); return Promise.resolve({}); } });
    expect(store).toBeTruthy();
    return settle().then(() => expect(urls).toEqual(['/cornfield/theme/assets/web.svg']));
  });
  it('does not touch a config\'s sources, links or brand: nothing in it becomes script or a link', () => {
    const inst = createInstance({ base: BASE });
    const config = { sources: { live: { module: '/repo/plugins/live.js', options: {} } }, links: [{ label: 'x', href: 'javascript:alert(1)' }], brand: { logo: 'https://evil.test/x.svg' } };
    const before = JSON.stringify(config);
    expect(() => applyConfig(inst, config)).not.toThrow();
    expect(JSON.stringify(config)).toBe(before);
  });
});

describe('the load, as the instance is told of it', () => {
  const OK = { [CONFIG_PATH]: json({ version: '0.1.0', strings: { approve: 'Ship it' } }), [TOPOLOGY_PATH]: json(TOPOLOGY), '/cornfield/theme.css': json({}) };

  it('loading, then ready, with the config applied and the topology kept', async () => {
    const inst = createInstance({ base: BASE, fetch: server(OK).fetch });
    const events = said(inst);
    const source = createSource(inst, { version: '0.1.0' });
    await source.load();
    expect(events.map((e) => e.state)).toEqual(['loading', 'ready']);
    expect(source.topology).toEqual(TOPOLOGY);
    expect(source.config.version).toBe('0.1.0');
    expect(source.state()).toEqual({ state: 'ready' });
    expect(t(inst, 'approve')).toBe('Ship it');
    expect(sourceOf(inst)).toBe(source);
  });

  it('a 401 on a gated read is "sign in", with the server\'s sign-in that returns to this page', async () => {
    const inst = createInstance({ base: BASE, fetch: server({ [CONFIG_PATH]: json({ ok: false }, 401) }).fetch });
    const events = said(inst);
    await createSource(inst, { pageUrl: () => 'https://tasks.example.com/board?x=1' }).load();
    expect(events.at(-1)).toEqual({ state: 'sign-in', status: 401, signIn: `${BASE}/auth/start?returnTo=${encodeURIComponent('https://tasks.example.com/board?x=1')}` });
  });

  it('a 403 is "sign in" too, wherever it comes (the topology after a good config)', async () => {
    const inst = createInstance({ base: BASE, fetch: server({ [CONFIG_PATH]: json({}), [TOPOLOGY_PATH]: json({}, 403) }).fetch });
    const events = said(inst);
    await createSource(inst, { pageUrl: () => 'https://tasks.example.com/' }).load();
    expect(events.at(-1)).toMatchObject({ state: 'sign-in', status: 403 });
  });

  it('no CORS answer, with the server there, is "not allowed", and names the origin that should be listed', async () => {
    const s = server({ [CONFIG_PATH]: 'refuse', '/cornfield/theme.css': json({}) });
    const inst = createInstance({ base: BASE, fetch: s.fetch });
    const events = said(inst);
    await createSource(inst, { pageUrl: () => 'https://tasks.example.com/board' }).load();
    expect(events.at(-1)).toEqual({ state: 'not-allowed', origin: 'https://tasks.example.com' });
    // the reach test is a request that needs no answer the page may read, and carries no cookie
    expect(s.calls.at(-1)).toEqual([`${BASE}/cornfield/theme.css`, expect.objectContaining({ method: 'HEAD', mode: 'no-cors', credentials: 'omit' })]);
  });

  it('no answer at all, even to the reach test, is "offline"', async () => {
    const inst = createInstance({ base: BASE, fetch: server({ [CONFIG_PATH]: 'refuse', '/cornfield/theme.css': 'refuse' }).fetch });
    const events = said(inst);
    await createSource(inst, {}).load();
    expect(events.at(-1)).toEqual({ state: 'offline' });
  });

  it('a browser that says it is offline is "offline" without asking again', async () => {
    const s = server({ [CONFIG_PATH]: 'refuse' });
    const inst = createInstance({ root: document.createElement('div'), base: BASE, fetch: s.fetch });
    const spy = vi.spyOn(inst.win.navigator, 'onLine', 'get').mockReturnValue(false);
    const events = said(inst);
    await createSource(inst, {}).load();
    spy.mockRestore();
    expect(events.at(-1)).toEqual({ state: 'offline' });
    expect(s.calls.length).toBe(1);
  });

  it('an answer that is not a config or a topology is a server error, with the status', async () => {
    const inst = createInstance({ base: BASE, fetch: server({ [CONFIG_PATH]: json({}, 500) }).fetch });
    const events = said(inst);
    await createSource(inst, {}).load();
    expect(events.at(-1)).toMatchObject({ state: 'server', status: 500 });
    const inst2 = createInstance({ base: BASE, fetch: server({ [CONFIG_PATH]: json({}), [TOPOLOGY_PATH]: json({ nodes: [] }) }).fetch });
    const events2 = said(inst2);
    await createSource(inst2, {}).load();
    expect(events2.at(-1)).toMatchObject({ state: 'server', status: 200 });
  });

  it('retry is another load', async () => {
    let up = false;
    const inst = createInstance({ base: BASE, fetch: server({ [CONFIG_PATH]: () => (up ? json({}) : json({}, 401)), [TOPOLOGY_PATH]: json(TOPOLOGY) }).fetch });
    const events = said(inst);
    const source = createSource(inst, {});
    await source.load();
    expect(source.state().state).toBe('sign-in');
    up = true;
    await source.load();
    expect(events.map((e) => e.state)).toEqual(['loading', 'sign-in', 'loading', 'ready']);
  });

  it('a different minor or major says so once and the load goes on; a patch says nothing', async () => {
    for (const [server$, expected] of [['0.2.0', 'minor'], ['1.0.0', 'major'], ['0.1.9', null], ['0.1.0', null]]) {
      const inst = createInstance({ base: BASE, fetch: server({ [CONFIG_PATH]: json({ version: server$ }), [TOPOLOGY_PATH]: json(TOPOLOGY) }).fetch });
      const events = said(inst);
      const source = createSource(inst, { version: '0.1.0' });
      await source.load();
      expect(events.map((e) => e.state)).toEqual(expected ? ['loading', 'version', 'ready'] : ['loading', 'ready']);
      if (expected) expect(source.notice).toEqual({ state: 'version', server: server$, package: '0.1.0', drift: expected });
      else expect(source.notice).toBe(null);
      expect(source.topology).toEqual(TOPOLOGY);
    }
  });

  it('a host that fetched for itself makes no request', async () => {
    const s = server({});
    const inst = createInstance({ base: BASE, fetch: s.fetch });
    const events = said(inst);
    const source = createSource(inst, {});
    source.provide({ config: { version: '0.1.0', strings: { approve: 'Ship it' } }, topology: TOPOLOGY });
    await source.load();
    expect(s.calls).toEqual([]);
    expect(events.map((e) => e.state)).toEqual(['ready', 'ready']);
    expect(source.topology).toBe(TOPOLOGY);
    expect(t(inst, 'approve')).toBe('Ship it');
  });

  it('the host\'s strings win over the server\'s, and the server\'s come back when the host\'s go', async () => {
    const inst = createInstance({ base: BASE, fetch: server({ [CONFIG_PATH]: json({ strings: { approve: 'Ship it', sendBack: 'Not yet' } }), [TOPOLOGY_PATH]: json(TOPOLOGY) }).fetch });
    const source = createSource(inst, {});
    source.provide({ strings: { approve: 'Go' } });
    await source.load();
    expect(t(inst, 'approve')).toBe('Go');
    expect(t(inst, 'sendBack')).toBe('Send back');
    source.provide({ strings: null });
    expect(t(inst, 'approve')).toBe('Ship it');
    expect(t(inst, 'sendBack')).toBe('Not yet');
  });

  it('an instance with no base makes no request at all', async () => {
    const s = server({});
    const inst = createInstance({ fetch: s.fetch });
    await createSource(inst, {}).load();
    expect(s.calls).toEqual([]);
  });
});

describe('two sources on one page are two sources (D5)', () => {
  it('each keeps its own server\'s map, words and states', async () => {
    const a = createInstance({ base: 'https://a.example.com', fetch: server({ [CONFIG_PATH]: json({ strings: { approve: 'Ship it' } }), [TOPOLOGY_PATH]: json({ nodes: [{ id: 'a1' }], edges: [] }) }).fetch });
    const b = createInstance({ base: 'https://b.example.com', fetch: server({ [CONFIG_PATH]: json({}, 401) }).fetch });
    const [ea, eb] = [said(a), said(b)];
    const [sa, sb] = [createSource(a, {}), createSource(b, { pageUrl: () => 'https://t.example.com/' })];
    await Promise.all([sa.load(), sb.load()]);
    expect(ea.map((e) => e.state)).toEqual(['loading', 'ready']);
    expect(eb.map((e) => e.state)).toEqual(['loading', 'sign-in']);
    expect(sa.topology.nodes[0].id).toBe('a1');
    expect(sb.topology).toBe(null);
    expect(t(a, 'approve')).toBe('Ship it');
    expect(t(b, 'approve')).toBe('Approve');
    expect(sourceOf(a)).toBe(sa);
    expect(sourceOf(b)).toBe(sb);
  });
});

describe('the end (destroy)', () => {
  it('aborts what is in flight and says nothing more, even when the answer comes after', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let signal;
    const inst = createInstance({ base: BASE, fetch: vi.fn(async (_url, init) => { signal = init.signal; await gate; return json({}); }) });
    const events = said(inst);
    const source = createSource(inst, {});
    const loading = source.load();
    await settle();
    expect(signal.aborted).toBe(false);
    inst.destroy();
    expect(signal.aborted).toBe(true);
    release();
    await loading;
    expect(events.map((e) => e.state)).toEqual(['loading']);
    expect(sourceOf(inst)).toBe(null);
    expect(source.topology).toBe(null);
  });

  it('a second load supersedes the first: only the last answer counts', async () => {
    const answers = [];
    const inst = createInstance({ base: BASE, fetch: vi.fn(async (url, init) => new Promise((resolve, reject) => { answers.push({ url: String(url), resolve, reject, init }); init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); })) });
    const events = said(inst);
    const source = createSource(inst, {});
    const first = source.load();
    await settle();
    const second = source.load();
    await first;
    expect(answers[0].init.signal.aborted).toBe(true);
    answers[1].resolve(json({ strings: { approve: 'Ship it' } }));
    await settle();
    answers[2].resolve(json(TOPOLOGY));
    await second;
    expect(events.map((e) => e.state)).toEqual(['loading', 'loading', 'ready']);
    expect(source.topology).toEqual(TOPOLOGY);
  });
});
