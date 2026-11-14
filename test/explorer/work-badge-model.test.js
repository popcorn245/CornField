// The Work layer on the Map view, its pure half (spec 0012 D4): which node open work touches, the badge's words, which badges fit, the node panel's "Open work", the Layers row.
import { describe, it, expect } from 'vitest';
import { workScene, addressOf } from '../../explorer/work-model.js';
import { WORK_BADGE_LAYER, badgeIndex, badgeText, badgeWords, badgeRowOf, openWorkHtml, placeBadges } from '../../explorer/work-badge-model.js';

const map = [
  { id: 'notifications', label: 'notifications', type: 'service', x: 5, y: 5, r: 20 },
  { id: 'api-billing', label: 'api-billing', type: 'app', x: 1, y: 1, r: 24 },
  { id: 'invoices', label: 'invoices', type: 'table', x: 2, y: 2, r: 18 },
  { id: 'auth', label: 'auth', type: 'core', x: 3, y: 3, r: 20 },
];
const item = (o) => ({ stage: 'build', state: 'open', open: true, waiting: false, updated: '2026-11-12T00:00:00Z', ...o });
const graph = {
  ok: true,
  nodes: [
    item({ id: 'thread:31', kind: 'thread', stage: 'talk', title: 'Alerts on failed payments', number: 31, updated: '2026-11-10T00:00:00Z', url: 'https://forge.example/t/31' }),
    item({ id: 'issue:14', kind: 'issue', stage: 'talk', title: 'Exports time out', number: 14, updated: '2026-11-12T00:00:00Z', url: 'javascript:alert(1)' }),
    item({ id: 'proposal:0100-flow', kind: 'proposal', stage: 'decide', title: 'A new flow', state: 'to-decide', waiting: true, slug: '0100-flow', number: 21, updated: '2026-11-11T00:00:00Z' }),
    item({ id: 'proposal:0200-draft', kind: 'proposal', stage: 'decide', title: 'Only a file', state: 'local', slug: '0200-draft', number: null }),
    item({ id: 'run:run-0123456789ABCDEFGHIJ000003', kind: 'run', title: 'code on issue #14', state: 'working', runId: 'run-0123456789ABCDEFGHIJ000003', updated: '2026-11-12T01:00:00Z' }),
    item({ id: 'pull:27', kind: 'pull', title: 'Page <b>exports</b> in chunks', number: 27, updated: '2026-11-12T02:00:00Z', url: 'https://forge.example/pull/27' }),
    item({ id: 'pull:9', kind: 'pull', title: 'Merged long ago', state: 'merged', open: false, number: 9, updated: '2026-11-12T02:30:00Z' }),
    item({ id: 'deploy:9', kind: 'deploy', stage: 'ship', title: 'api-billing restarted', state: 'success', open: false, deployId: '9', updated: '2026-11-12T03:00:00Z' }),
    { id: '/flow/start', kind: 'code', planned: true, label: '/flow/start', type: 'page' },
  ],
  edges: [
    { from: 'thread:31', to: 'notifications', rel: 'mentions' },
    { from: 'pull:27', to: 'api-billing', rel: 'changes' },
    { from: 'pull:27', to: 'invoices', rel: 'changes' },
    { from: 'pull:9', to: 'invoices', rel: 'changes' },
    { from: 'proposal:0100-flow', to: 'api-billing', rel: 'changes' },
    { from: 'proposal:0100-flow', to: '/flow/start', rel: 'adds' },
    { from: 'proposal:0200-draft', to: 'auth', rel: 'changes' },
    { from: 'issue:14', to: 'api-billing', rel: 'mentions' },
    { from: 'run:run-0123456789ABCDEFGHIJ000003', to: 'api-billing', rel: 'changes' },
    { from: 'deploy:9', to: 'api-billing', rel: 'restarts' },
    { from: 'pull:27', to: 'issue:14', rel: 'closes' },
  ],
};
const scene = workScene(graph, map);
const index = badgeIndex(scene.nodes, scene.edges);

describe('which nodes open work touches', () => {
  it('is every node of the map an open piece of work changes, adds to a proposal of, mentions or restarts', () => {
    expect([...index.keys()].sort()).toEqual(['api-billing', 'invoices', 'notifications']);
  });
  it('leaves out closed work, a local draft, a planned node and a node the map does not hold', () => {
    expect(index.has('auth')).toBe(false); // only a local draft touches it
    expect(index.has('/flow/start')).toBe(false); // planned: not on the map
    expect(index.get('invoices').map((i) => i.id)).toEqual(['pull:27']); // the merged pull request touched it too, and is closed
    expect(index.get('api-billing').map((i) => i.id)).not.toContain('deploy:9'); // a finished deploy is not open work
  });
  it('puts what waits on you first, then the newest', () => {
    expect(index.get('api-billing').map((i) => i.id)).toEqual(['proposal:0100-flow', 'pull:27', 'run:run-0123456789ABCDEFGHIJ000003', 'issue:14']);
  });
  it('is empty with no answer', () => {
    expect(badgeIndex([], []).size).toBe(0);
    expect(badgeIndex(undefined, undefined).size).toBe(0);
  });
});

describe('the words', () => {
  it('a badge says the kind and number of the most pressing item, then how many more', () => {
    expect(badgeText(index.get('invoices'))).toBe('PR #27');
    expect(badgeText(index.get('notifications'))).toBe('Thread #31');
    expect(badgeText(index.get('api-billing'))).toBe('Spec 0100 +3');
  });
  it('a run is its last six characters, as the Work view names it', () => {
    const only = badgeIndex(scene.nodes, scene.edges.filter((e) => e.from.startsWith('run:')));
    expect(badgeText(only.get('api-billing'))).toBe('Run 000003');
  });
  it('a screen reader hears the count and the items, naming the first three and what waits', () => {
    expect(badgeWords(index.get('invoices'))).toBe('1 open: PR #27');
    expect(badgeWords(index.get('api-billing'))).toBe('4 open: Spec 0100 (waiting on you), PR #27, Run 000003 and 1 more');
    expect(badgeWords(undefined)).toBe('');
    expect(badgeWords([])).toBe('');
  });
});

describe('the node panel\'s Open work', () => {
  const html = openWorkHtml(index.get('api-billing'), { color: () => '#112233', address: (id) => addressOf(scene.nodes.find((n) => n.id === id)) });
  it('lists each item as a link that opens the Work view on it, by the address a new tab would take', () => {
    expect(html).toContain('data-work-action="open-item" data-id="pull:27" href="?view=work&amp;pr=27"');
    expect(html).toContain('href="?view=work&amp;spec=0100-flow"');
    expect(html).toContain('waiting on you');
  });
  it('escapes every word the forge wrote', () => {
    expect(html).not.toContain('<b>exports</b>');
    expect(html).toContain('Page &lt;b&gt;exports&lt;/b&gt; in chunks');
  });
  it('makes a link to the forge only of an http(s) address', () => {
    expect(html).toContain('href="https://forge.example/pull/27"');
    expect(html).not.toContain('javascript:');
    expect(html.match(/target="_blank" rel="noreferrer"/g)).toHaveLength(1);
  });
});

describe('the Layers row', () => {
  it('counts the nodes once the answer is here, and says where it is until then', () => {
    expect(badgeRowOf({ status: 'ok', badges: index }, '#fff')).toMatchObject({ key: WORK_BADGE_LAYER, label: 'Work', overlay: true, countText: '3 nodes' });
    expect(badgeRowOf({ status: 'ok', badges: new Map([['a', []]]) }, '#fff').countText).toBe('1 node');
    expect(badgeRowOf({ status: 'idle' }, '#fff').countText).toBe('not read yet');
    expect(badgeRowOf({ status: 'loading' }, '#fff').countText).toBe('reading…');
    expect(badgeRowOf({ status: 'sign-in' }, '#fff').countText).toBe('sign in again');
    expect(badgeRowOf({ status: 'offline' }, '#fff').countText).toBe('offline');
    expect(badgeRowOf({ status: 'server' }, '#fff').countText).toBe('not read');
  });
  it('is not a layer of the map\'s own keys', () => {
    expect(WORK_BADGE_LAYER).toBe('work-badges');
  });
});

describe('which badges fit (the names\' own placing)', () => {
  const node = (id, x, y, extra = {}) => ({ id, type: 'service', x, y, r: 10, alpha: 1, label: id, labelAlpha: 1, labelSize: 11, labelBold: false, degree: 1, selected: false, match: false, current: false, connected: true, mark: 'none', ...extra });
  const items = (tag, waiting = false) => [{ id: `pull:${tag}`, kind: 'pull', tag: `PR #${tag}`, title: 't', waiting, state: 'Open', url: null }];
  const wide = (text, size) => text.length * size * 0.6; // a measure: 0.6 em a glyph
  const some = (nodes, ix, zoom = 1) => placeBadges({ nodes }, zoom, new Map(ix), { measure: wide });

  it('places a badge above its node, centred, at the size it has on screen', () => {
    const [b] = some([node('a', 100, 100)], [['a', items(1)]]);
    expect(b.id).toBe('a');
    expect((b.l + b.r) / 2).toBeCloseTo(100, 5);
    expect(b.b).toBeLessThan(100 - 10); // over the disc (y - r)
    expect(b.r - b.l).toBeGreaterThan(wide('PR #1', 11)); // the pill's room is in it
  });
  it('is the same wherever the camera is: the box has no camera in it', () => {
    const a = some([node('a', 100, 100)], [['a', items(1)]], 2);
    const b = some([node('a', 100, 100)], [['a', items(1)]], 2);
    expect(a).toEqual(b);
    expect((a[0].l + a[0].r) / 2).toBeCloseTo(200, 5);
  });
  it('does not stack two badges: the one that waits on you stays, the other is hidden', () => {
    const nodes = [node('plain', 100, 100), node('urgent', 110, 100)];
    const out = some(nodes, [['plain', items(1)], ['urgent', items(2, true)]]);
    expect(out.map((b) => b.id)).toEqual(['urgent']);
  });
  it('gives the selected node the first place, before one that waits on you', () => {
    const nodes = [node('waits', 100, 100), node('chosen', 110, 100, { selected: true })];
    const out = some(nodes, [['waits', items(1, true)], ['chosen', items(2)]]);
    expect(out.map((b) => b.id)).toEqual(['chosen']);
  });
  it('leaves a name where it is: a badge over a name is not drawn', () => {
    // `blocker` is a node with no badge whose name sits where a's badge would go (a name is under its disc: y + r + 3 on)
    const nodes = [node('a', 100, 100), node('blocker', 100, 57, { label: 'a long name in the way' })];
    expect(some(nodes, [['a', items(1)]])).toEqual([]);
    expect(some([node('a', 100, 100), node('blocker', 100, 300, { label: 'a long name far away' })], [['a', items(1)]]).map((b) => b.id)).toEqual(['a']);
  });
  it('draws no badge for a dimmed node, a node with no work, or none at all', () => {
    expect(some([node('a', 100, 100, { alpha: 0.07 })], [['a', items(1)]])).toEqual([]);
    expect(some([node('a', 100, 100)], [])).toEqual([]);
    expect(some([node('a', 100, 100)], [['b', items(1)]])).toEqual([]);
  });
  it('draws at most `max`', () => {
    const nodes = Array.from({ length: 10 }, (_, i) => node(`n${i}`, i * 400, 0));
    const ix = nodes.map((n) => [n.id, items(1)]);
    expect(placeBadges({ nodes }, 1, new Map(ix), { measure: wide, max: 4 })).toHaveLength(4);
    expect(placeBadges({ nodes }, 1, new Map(ix), { measure: wide })).toHaveLength(10);
  });
});
