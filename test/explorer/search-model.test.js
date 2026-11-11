// @vitest-environment node
/**
 * What a search finds and in what order (explorer/search-model.js, spec 0008 D3 and D4): the fields it reads, the rank, the groups, the
 * count words and stepping. Pure: nodes in, matches out. The big synthetic map holds the claims at the size they were made for.
 */
import { describe, it, expect } from 'vitest';
import { makeBig } from '../fixtures/big/make.js';
// @ts-expect-error plain JS modules, no declarations
import { MAX_ROWS, OFF_GROUP, RANK, TYPE_NAMES, countText, groupName, matchIds, moreLine, noMatchLine, rankOf, searchNodes, stepIndex } from '../../explorer/search-model.js';

const N = (id, type, label, extra = {}) => ({ id, type, label, ...extra });

describe('what a search reads (D3)', () => {
  const orders = N('page-orders', 'page', '/orders', { file: 'apps/shop/routes/checkout.js', kind: 'route' });
  it('reads the label, the id, the file, the type as a word, the layer name and the kind; case does not matter', () => {
    expect(rankOf(orders, 'orders')).toBeLessThanOrEqual(RANK.label);
    expect(rankOf(N('x-1', 'page', 'Home', { file: 'apps/shop/routes/checkout.js' }), 'CHECKOUT')).toBe(RANK.idOrFile);
    expect(rankOf(N('billing-ledger', 'table', 'ledger_entries'), 'billing')).toBe(RANK.idOrFile);
    expect(rankOf(N('s', 'service', 'sync-worker'), 'service')).toBe(RANK.typeOrKind); // the type as a word
    expect(rankOf(N('s', 'service', 'sync-worker'), 'SERVICES')).toBe(RANK.typeOrKind); // as its layer's name
    expect(rankOf(N('p', 'page', 'x'), 'routes')).toBe(RANK.typeOrKind); // "Pages & Routes"
    expect(rankOf(N('s', 'service', 'sync-worker', { kind: 'webhook' }), 'webhook')).toBe(RANK.typeOrKind); // the finer kind
    expect(rankOf(N('e', 'external', 'Mail provider', { kind: 'cloud' }), 'cloud')).toBe(RANK.typeOrKind);
    expect(rankOf(N('a', 'app', 'Admin'), 'zzz')).toBe(-1);
    expect(rankOf(N('a', 'app', 'Admin'), '')).toBe(-1);
  });

  it('does not read descriptions (a common word in one would match hundreds of nodes)', () => {
    expect(rankOf(N('a', 'app', 'Admin', { desc: 'Takes the payment webhook.' , summary: 'payment' }), 'payment')).toBe(-1);
  });

  it('names a type as the Layers menu does, and an unknown type by itself with a capital', () => {
    expect(TYPE_NAMES.service).toBe('Services');
    expect(groupName(N('a', 'page', 'x'))).toBe('Pages & Routes');
    expect(groupName(N('a', 'gizmo', 'x'))).toBe('Gizmo');
    expect(groupName(N('r', 'room', 'x'))).toBe('House');
  });
});

describe('the rank (D3)', () => {
  it('puts a label that starts with the term, then a word of the label that does, then a label that contains it, then the id or file, then the type or kind', () => {
    const nodes = [
      N('t', 'page', 'worker', { kind: 'sync' }), // kind
      N('f', 'page', '/home', { file: 'lib/sync.js' }), // file
      N('c', 'page', 'async_jobs'), // contains
      N('w', 'page', 'Orders sync'), // a word
      N('s', 'page', 'Sync worker'), // starts with
    ];
    const r = searchNodes(nodes, 'sync');
    expect(r.matches.map((m) => m.node.id)).toEqual(['s', 'w', 'c', 'f', 't']);
    expect(r.matches.map((m) => m.rank)).toEqual([RANK.labelStart, RANK.wordStart, RANK.label, RANK.idOrFile, RANK.typeOrKind]);
  });

  it('orders equal ranks by label then id, whatever order the nodes came in', () => {
    const a = [N('2', 'page', '/b-sync'), N('1', 'page', '/a-sync'), N('3', 'page', '/a-sync')];
    const r1 = searchNodes(a, '/').matches.map((m) => m.node.id);
    const r2 = searchNodes([...a].reverse(), '/').matches.map((m) => m.node.id);
    expect(r1).toEqual(['1', '3', '2']);
    expect(r2).toEqual(r1);
  });
});

describe('the groups and the list (D4)', () => {
  const nodes = [
    ...Array.from({ length: 6 }, (_, i) => N(`p${i}`, 'page', `/sync/p${i}`)),
    N('s1', 'service', 'sync-worker'), N('s2', 'service', 'resync'),
    N('t1', 'table', 'sync_state'),
    N('x1', 'machine', 'sync box'),
  ];
  const opts = { visible: (n) => n.type !== 'machine', parentLabel: (n) => (n.type === 'page' ? 'Orders app' : '') };

  it('groups by type under the layer name, the group of the best match first (ties by name), with counts and each row\'s parent', () => {
    const r = searchNodes(nodes, 'sync', opts);
    expect(r.total).toBe(10);
    expect(r.groups.map((g) => [g.name, g.count])).toEqual([['Services', 2], ['Tables', 1], ['Pages & Routes', 6], [OFF_GROUP, 1]]);
    expect(r.groups[2].rows[0].parent).toBe('Orders app');
  });

  it('puts matches in layers that are off last, in one group, and counts them apart', () => {
    const r = searchNodes(nodes, 'sync', opts);
    expect(r.groups.at(-1)).toMatchObject({ name: OFF_GROUP, off: true, count: 1 });
    expect(r.groups.at(-1).rows[0]).toMatchObject({ on: false, group: 'Machines' });
    expect(r.onMap).toBe(9);
    expect(r.off).toBe(1);
    expect(r.matches.at(-1).node.id).toBe('x1');
  });

  it('lists at most 50 rows, says how many more, and still steps through every match', () => {
    const many = Array.from({ length: 62 }, (_, i) => N(`n${i}`, 'page', `/p${String(i).padStart(2, '0')}`));
    const r = searchNodes(many, '/p');
    expect(MAX_ROWS).toBe(50);
    expect(r.total).toBe(62);
    expect(r.groups.flatMap((g) => g.rows)).toHaveLength(50);
    expect(r.rows).toBe(50);
    expect(r.more).toBe(12);
    expect(r.matches).toHaveLength(62);
    expect(moreLine(12)).toBe('and 12 more: type more to narrow');
  });

  it('cuts the 50 in the order of the list: what is on the map is listed before what is off it', () => {
    const many = [...Array.from({ length: 50 }, (_, i) => N(`on${i}`, 'page', `/s${i}`)), N('off', 'machine', 's-box')];
    const r = searchNodes(many, 's', { visible: (n) => n.type !== 'machine' });
    expect(r.groups.map((g) => g.name)).toEqual(['Pages & Routes']);
    expect(r.more).toBe(1);
  });

  it('finds nothing for nothing, and says so in words', () => {
    const r = searchNodes(nodes, 'zzzz');
    expect(r.total).toBe(0);
    expect(r.groups).toEqual([]);
    expect(countText(r, null)).toBe('No match');
    expect(noMatchLine('zzzz')).toBe('No node matches “zzzz”. Search reads names, files, types and kinds.');
    expect(searchNodes(nodes, '  ').matches).toEqual([]);
    expect(countText(searchNodes(nodes, ''), null)).toBe('');
  });
});

describe('the count and stepping (D4)', () => {
  const nodes = ['a', 'b', 'c'].map((x) => N(x, 'page', `/s-${x}`));
  const r = searchNodes(nodes, 's-');

  it('says how many matches, and "3 of 33" once one is chosen', () => {
    expect(countText(r, null)).toBe('3 matches');
    expect(countText(searchNodes(nodes, 's-a'), null)).toBe('1 match');
    expect(countText(r, 'b')).toBe('2 of 3');
    expect(countText(r, 'gone')).toBe('3 matches');
  });

  it('steps forward and back through the matches in list order, wrapping round, and starts at the first (or the last going back)', () => {
    expect(stepIndex(r.matches, null, 1)).toBe(0);
    expect(stepIndex(r.matches, null, -1)).toBe(2);
    expect(stepIndex(r.matches, 'a', 1)).toBe(1);
    expect(stepIndex(r.matches, 'c', 1)).toBe(0);
    expect(stepIndex(r.matches, 'a', -1)).toBe(2);
    expect(stepIndex([], 'a', 1)).toBe(-1);
  });

  it('matchIds is the set the map halos', () => {
    expect([...matchIds(nodes, 's-b')]).toEqual(['b']);
    expect(matchIds(nodes, '').size).toBe(0);
  });
});

describe('on the big synthetic map', () => {
  const nodes = makeBig({ seed: 245 }).topology.nodes;

  it('finds every service of a kind by that kind (a label-only search finds the ones that say it in their name)', () => {
    const services = nodes.filter((n) => n.type === 'service');
    for (const kind of new Set(services.map((n) => n.kind))) {
      const found = new Set(searchNodes(nodes, kind).matches.map((m) => m.node.id));
      for (const n of services.filter((x) => x.kind === kind)) expect(found.has(n.id), `${kind}: ${n.id}`).toBe(true);
    }
  });

  it('puts the best match first and gives a four-letter term a count, a list under 50 rows and a "more" line', () => {
    const r = searchNodes(nodes, 'view');
    expect(r.total).toBeGreaterThan(MAX_ROWS);
    expect(r.rows).toBe(MAX_ROWS);
    expect(r.more).toBe(r.total - MAX_ROWS);
    expect(r.matches[0].rank).toBe(Math.min(...r.matches.map((m) => m.rank)));
    expect(r.groups[0].rows[0].rank).toBe(r.matches[0].rank);
  });
});
