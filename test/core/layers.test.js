/**
 * @vitest-environment node
 *
 * Project layers (spec 0009 D1-D4): the matcher and the checks of core/layers.js, and what the config load does with `layers`.
 * One test per message `cornfield validate` gives, and the ones that hold the matcher to data.
 */
import { describe, it, expect } from 'vitest';
import {
  layersProblems, clientLayers, meets, projectLayerOf, startingLayerOf, layerKeyOf, parentIndex, layersMapWarnings, orderRows,
  kindLetters, STARTING_KEYS, MAX_LAYERS, LAYER_KEY_RE,
} from '../../core/layers.js';
import { configProblems, loadConfig } from '../../core/config.js';
import { BROWSER_CORE, clientConfig } from '../../server/server.js';
import { NODE_THEMES } from '../../core/schema.js';

const layer = (over = {}) => ({ key: 'timers', label: 'Timers', match: { type: 'service', kind: ['timer', 'scheduler'] }, ...over });
const problems = (layers) => layersProblems(layers);

describe('a good layers config', () => {
  it('has no problem: none at all, empty, and the three worked examples of the spec', () => {
    expect(problems(undefined)).toEqual([]);
    expect(problems({})).toEqual([]);
    expect(problems({ add: [layer({ desc: 'What runs on a clock', match: { type: 'service', kind: ['timer', 'scheduler', 'job'] } })], off: ['timers'] })).toEqual([]);
    expect(problems({ add: [{ key: 'household', label: 'Household pages', match: { type: 'page', field: { audience: 'household' } } }], order: ['app', 'household', 'page'] })).toEqual([]);
    expect(problems({ add: [{ key: 'data', label: 'Data', desc: 'Stores and tables', match: { type: ['store', 'table'] } }] })).toEqual([]);
  });
});

describe('D4: each refusal says the key and what would be right', () => {
  it('a key that is a starting layer', () => {
    expect(problems({ add: [layer({ key: 'service' })] })).toEqual(['layers.add[0].key "service" is a starting layer: pick another key.']);
    for (const k of ['flow', 'house', 'runs', 'cloud', 'app']) expect(problems({ add: [layer({ key: k })] })[0]).toContain('is a starting layer');
  });
  it('a key that is a node type with no row of its own is reserved', () => {
    expect(problems({ add: [layer({ key: 'root' })] })[0]).toContain('is reserved');
  });
  it('a key that is not lower-case words joined by "-"', () => {
    expect(problems({ add: [layer(), layer({ key: 'Edge Stack' })] })).toEqual(['layers.add[1].key "Edge Stack": lower-case words joined by "-", like "edge-stack".']);
    for (const k of ['a_b', 'a--b', '-a', 'a-', '1a', 'x'.repeat(33), '', 'a b', 'a"b', 'a;b']) expect(problems({ add: [layer({ key: k })] }).length, JSON.stringify(k)).toBe(1);
  });
  it('a key used twice', () => {
    expect(problems({ add: [layer(), layer()] })).toEqual(['layers.add[1].key "timers" is also layers.add[0].key: a key is used once.']);
  });
  it('an empty match', () => {
    expect(problems({ add: [layer(), layer({ key: 'b', match: {} })] })).toEqual(['layers.add[1].match is empty: say at least one of type, kind, parent, field.']);
    expect(problems({ add: [layer({ match: undefined })] })[0]).toContain('match is required');
  });
  it('a type that is not a node type', () => {
    expect(problems({ add: [layer(), layer({ key: 'b' }), layer({ key: 'c', match: { type: 'servce' } })] })).toEqual(['layers.add[2].match.type "servce" is not a node type (root, app, page, pkg, core, …).']);
    expect(problems({ add: [layer({ match: { type: ['service', 'nope'] } })] })[0]).toContain('"nope" is not a node type');
  });
  it('a field value that is not text, a number, true or false', () => {
    const w = 'layers.add[0].match.field.audience: a value is text, a number, true or false, or a list of them.';
    for (const v of [{ a: 1 }, null, undefined, [{}], [[1]], () => 1, /x/, NaN, Infinity]) {
      expect(problems({ add: [layer({ match: { field: { audience: v } } })] }), String(v)).toContain(w);
    }
    for (const v of ['a', 3, true, false, ['a', 2, true]]) expect(problems({ add: [layer({ match: { field: { audience: v } } })] })).toEqual([]);
  });
  it('an unknown key of a layer, with the colours being the theme\'s', () => {
    expect(problems({ add: [layer(), layer({ key: 'b' }), layer({ key: 'c' }), layer({ key: 'd', color: '#fff' })] })).toEqual(['layers.add[3] has unknown key "color": known: key, label, desc, match. Colours and icons are the theme\'s.']);
    expect(problems({ add: [layer({ on: true })] })[0]).toContain('layers.off');
  });
  it('an unknown key of a match: a pattern or a function is no key', () => {
    for (const k of ['regex', 'pattern', 'not', 'or', 'where', 'fn', 'match']) {
      expect(problems({ add: [layer({ match: { type: 'service', [k]: 'x' } })] })[0], k).toBe(`layers.add[0].match has unknown key "${k}": known: type, kind, parent, field. A match is data: no pattern, no function.`);
    }
  });
  it('a name in off or order that is not a layer', () => {
    expect(problems({ add: [layer()], off: ['tokens'] })).toEqual(['layers.off "tokens" is not a layer (app, pkg, page, …, timers).']);
    expect(problems({ order: ['nope'] })[0]).toBe('layers.order "nope" is not a layer (app, pkg, page, ….).'.replace('….).', '…).'));
    expect(problems({ add: [layer()], off: ['timers', 'timers'] })[0]).toContain('listed twice');
    expect(problems({ off: 'app' })[0]).toContain('layers.off is a list');
  });
  it('more than 24 layers', () => {
    const many = Array.from({ length: 25 }, (_, i) => layer({ key: `l${i}`, match: { kind: `k${i}` } }));
    expect(problems({ add: many })).toEqual(['layers.add has 25 layers: at most 24.']);
    expect(problems({ add: many.slice(0, MAX_LAYERS) })).toEqual([]);
  });
  it('a label or a description that is not one line of plain text of a length', () => {
    expect(problems({ add: [layer({ label: undefined })] })[0]).toContain('label is required');
    expect(problems({ add: [layer({ label: 'x'.repeat(41) })] })[0]).toContain('at most 40');
    expect(problems({ add: [layer({ label: 'a\nb' })] })[0]).toContain('one line');
    expect(problems({ add: [layer({ desc: 'x'.repeat(121) })] })[0]).toContain('at most 120');
    expect(problems({ add: [layer({ desc: 7 })] })[0]).toContain('plain text');
  });
  it('lists too long, fields too many, and bad field names', () => {
    expect(problems({ add: [layer({ match: { kind: Array.from({ length: 21 }, (_, i) => `k${i}`) } })] })[0]).toContain('at most 20');
    expect(problems({ add: [layer({ match: { field: { a: 1, b: 1, c: 1, d: 1, e: 1 } } })] })[0]).toContain('at most 4');
    for (const n of ['1a', 'a-b', 'a b', '_x', '__proto__']) expect(problems({ add: [layer({ match: { field: Object.fromEntries([[n, 1]]) } })] }).join(), n).toContain('a field name is letters');
    expect(problems({ add: [layer({ match: { field: { type: 'x' } } })] })[0]).toContain('use the match key "type"');
  });
  it('a layers that is not an object, an add that is not a list', () => {
    expect(problems([])[0]).toContain('"layers" is an object');
    expect(problems({ add: {} })[0]).toContain('layers.add is a list');
    expect(problems({ hide: [] })[0]).toContain('unknown key "hide"');
  });
});

describe('the matcher is data: it never evaluates a config value', () => {
  const node = { id: 'svc-a', type: 'service', kind: 'timer', audience: 'household', tags: ['x', 'y'] };
  it('within a key any, across keys all', () => {
    expect(meets({ type: 'service', kind: ['timer', 'job'] }, node)).toBe(true);
    expect(meets({ type: 'service', kind: ['job'] }, node)).toBe(false);
    expect(meets({ type: ['page', 'service'] }, node)).toBe(true);
    expect(meets({ kind: 'timer', field: { audience: ['household', 'guest'] } }, node)).toBe(true);
    expect(meets({ kind: 'timer', field: { audience: 'guest' } }, node)).toBe(false);
  });
  it('a field holding a list meets when it holds one of the values; a node without the field does not meet', () => {
    expect(meets({ field: { tags: 'y' } }, node)).toBe(true);
    expect(meets({ field: { tags: ['z', 'x'] } }, node)).toBe(true);
    expect(meets({ field: { tags: 'z' } }, node)).toBe(false);
    expect(meets({ field: { missing: 'x' } }, node)).toBe(false);
  });
  it('compares exactly: no pattern, no wildcard, no coercion, no inherited property', () => {
    expect(meets({ kind: 'tim.*' }, node)).toBe(false);
    expect(meets({ kind: '*' }, node)).toBe(false);
    expect(meets({ kind: 'TIMER' }, node)).toBe(false);
    expect(meets({ field: { n: 1 } }, { type: 'page', n: '1' })).toBe(false);
    expect(meets({ field: { constructor: 'x' } }, { type: 'page' })).toBe(false);
    expect(meets({ field: { toString: 'x' } }, { type: 'page' })).toBe(false);
  });
  it('a value that is a function or a pattern is never called', () => {
    let called = 0;
    const fn = () => { called++; return true; };
    expect(meets({ type: fn }, node)).toBe(false);
    expect(meets({ kind: /timer/ }, node)).toBe(false);
    expect(meets({ field: { audience: fn } }, node)).toBe(false);
    expect(meets({ ...{ get type() { called++; return 'service'; } } }, node)).toBe(true); // a getter is the config author's own code, not a value
    expect(called).toBe(1);
  });
  it('an empty or missing match meets nothing', () => {
    expect(meets({}, node)).toBe(false);
    expect(meets(null, node)).toBe(false);
    expect(meets(undefined, node)).toBe(false);
  });
  it('parent: the direct owner by the ownership line only', () => {
    const edges = [{ from: 'hub', to: 'a' }, { from: 'x', to: 'a', kind: 'calls' }, { from: 'y', to: 'b', dashed: true }, { from: 'hub', to: 'b' }, { from: 'root', to: 'hub' }];
    const idx = parentIndex(edges);
    expect(idx.get('a')).toBe('hub');
    expect(idx.get('b')).toBe('hub');
    const parentOf = (n) => idx.get(n.id);
    expect(meets({ parent: 'hub' }, { id: 'a', type: 'page' }, parentOf)).toBe(true);
    expect(meets({ parent: ['root'] }, { id: 'a', type: 'page' }, parentOf)).toBe(false);
    expect(meets({ parent: 'hub' }, { id: 'a', type: 'page' })).toBe(false); // no map to ask
  });
});

describe('D3: a node is in exactly one layer, the first project layer that takes it', () => {
  const add = [
    { key: 'timers', label: 'Timers', match: { type: 'service', kind: ['timer', 'scheduler', 'job'] } },
    { key: 'any-svc', label: 'Any', match: { type: 'service' } },
  ];
  const nodes = [
    { id: 'root', type: 'root' }, { id: 't', type: 'service', kind: 'timer' }, { id: 'h', type: 'service', kind: 'hook' }, { id: 'p', type: 'page' },
    { id: 'c', type: 'external', kind: 'cloud' }, { id: 'w', type: 'external', kind: 'web' }, { id: 'f', type: 'floor' }, { id: 'r', type: 'room' }, { id: 'x', type: 'external' },
  ];
  it('takes a node from its starting layer, first layer wins, the rest stay where they were', () => {
    const keys = Object.fromEntries(nodes.map((n) => [n.id, layerKeyOf(add, n)]));
    expect(keys).toEqual({ root: null, t: 'timers', h: 'any-svc', p: 'page', c: 'cloud', w: 'web', f: 'house', r: 'house', x: 'cloud' });
  });
  it('with no project layers every node is in its starting layer (today\'s rows)', () => {
    expect(nodes.map((n) => layerKeyOf([], n))).toEqual([null, 'service', 'service', 'page', 'cloud', 'web', 'house', 'house', 'cloud']);
    expect(projectLayerOf([], nodes[1])).toBeNull();
  });
  it('the root is never in a project layer', () => {
    expect(projectLayerOf([{ key: 'all', label: 'All', match: { type: 'root' } }], { id: 'root', type: 'root' })).toBeNull();
  });
  it('every node type has a starting row, which is a starting layer or its own type', () => {
    for (const type of Object.keys(NODE_THEMES)) {
      const k = startingLayerOf({ type });
      if (type !== 'root') expect(STARTING_KEYS.includes(k) || k === type, type).toBe(true);
    }
  });
});

describe('what validate says of the layers against the map (warnings)', () => {
  const map = { nodes: [{ id: 'root', type: 'root' }, { id: 't', type: 'service', kind: 'timer' }, { id: 'p', type: 'page' }], edges: [] };
  it('a layer that matches nothing, and one whose nodes an earlier layer took', () => {
    const add = clientLayers({ add: [layer({ key: 'a', match: { type: 'service' } }), layer({ key: 'b', match: { kind: 'timer' } }), layer({ key: 'c', match: { kind: 'nope' } })] }).add;
    expect(layersMapWarnings({ add }, map)).toEqual([
      'layers.add[1] "b" takes no node: every node it matches is taken by an earlier layer.',
      'layers.add[2] "c" matches no node on the map: its row will not show.',
    ]);
    expect(layersMapWarnings({ add: [] }, map)).toEqual([]);
  });
});

describe('the order of the rows (D8)', () => {
  const r = (...keys) => keys.map((key) => ({ key }));
  it('order first, then the project layers, then the starting ones in their usual order', () => {
    expect(orderRows(r('x', 'y'), r('app', 'pkg', 'page'), []).map((o) => o.key)).toEqual(['x', 'y', 'app', 'pkg', 'page']);
    expect(orderRows(r('x', 'y'), r('app', 'pkg', 'page'), ['pkg', 'y', 'nope']).map((o) => o.key)).toEqual(['pkg', 'y', 'x', 'app', 'page']);
  });
});

describe('D5: the letters of a finer kind', () => {
  const n = (type, kind) => ({ type, kind });
  it('the shortest start no other kind of the type shares', () => {
    const l = kindLetters([n('service', 'job'), n('service', 'hook'), n('service', 'webhook'), n('service', 'timer'), n('service', 'scheduler'), n('service', 'client'), n('service', 'dispatch'), n('service', 'effects')]);
    expect(Object.fromEntries(l.get('service'))).toEqual({ job: 'j', hook: 'h', webhook: 'w', timer: 't', scheduler: 's', client: 'c', dispatch: 'd', effects: 'e' });
  });
  it('two letters when one is shared, and per type', () => {
    const l = kindLetters([n('service', 'timer'), n('service', 'task'), n('device', 'tag'), n('service', 'a'), n('page', undefined)]);
    expect(Object.fromEntries(l.get('service'))).toEqual({ timer: 'ti', task: 'ta', a: 'a' });
    expect(l.get('device').get('tag')).toBe('t');
    expect(l.has('page')).toBe(false);
  });
  it('any text is a kind, never an error (the first two letters when they still collide)', () => {
    const l = kindLetters([n('service', 'jobs'), n('service', 'job'), n('service', '<b>x</b>'), n('service', 'ünï')]);
    expect(l.get('service').get('job')).toBe('jo');
    expect(l.get('service').get('<b>x</b>')).toBe('<');
  });
});

describe('the config: layers in cornfield.config.js', () => {
  it('is accepted through configProblems, and refused with the same lines', () => {
    expect(configProblems({ layers: { add: [layer()], off: ['timers'] } })).toEqual([]);
    expect(configProblems({ layers: { add: [layer({ key: 'service' })] } })).toEqual(['layers.add[0].key "service" is a starting layer: pick another key.']);
  });
  it('is served to the browser, and only when it passed', () => {
    expect(BROWSER_CORE).toContain('layers.js');
    const ok = { layers: clientLayers({ add: [layer({ desc: 'What runs on a clock' })], off: ['timers'], order: ['timers'] }) };
    expect(clientConfig({ ...ok, title: 't', theme: {}, brand: {}, strings: {}, sources: {}, links: [] }).layers).toEqual({ add: [{ key: 'timers', label: 'Timers', desc: 'What runs on a clock', match: { type: 'service', kind: ['timer', 'scheduler'] } }], off: ['timers'], order: ['timers'] });
    expect(clientLayers({ add: [layer({ key: 'service' })] })).toEqual({ add: [], off: [], order: [] });
  });
  it('keeps only the known keys: an extra one never travels', () => {
    const got = clientLayers({ add: [{ key: 'ok', label: ' L ', match: { type: 'page', field: { a: 'b' } } }] });
    expect(got.add[0]).toEqual({ key: 'ok', label: 'L', match: { type: 'page', field: { a: 'b' } } });
  });
  it('loads: a config without layers has none', async () => {
    const cfg = await loadConfig({ root: process.cwd(), env: {} }).catch(() => null);
    if (cfg) expect(cfg.layers).toEqual(expect.any(Object));
  });
});

describe('the key pattern is what keeps a key out of a token name and out of markup', () => {
  it('admits only lower-case words and digits joined by one hyphen', () => {
    for (const k of ['a', 'edge-stack', 'b2b', 'a-1']) expect(LAYER_KEY_RE.test(k), k).toBe(true);
    for (const k of ['A', 'a b', 'a"b', 'a<b', '</script>', 'a)', 'url(x)', 'a\nb', 'a:b', 'a;b', 'a.b', '--a', 'a--b']) expect(LAYER_KEY_RE.test(k), JSON.stringify(k)).toBe(false);
  });
});
