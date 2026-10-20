/**
 * @vitest-environment node
 *
 * Release notes from the map (core/release-notes.js): the pure drafting. Which tag the notes start from, a name for the
 * next one, the merged pull requests grouped by what they changed on a map (the areas below its root, "Breaking"
 * first for a labelled one, "Other" for one that touches nothing on the map), and the Markdown, which links every
 * pull request and cannot be turned into markup by a title. The same inputs give the same notes.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BREAKING_LABEL, NODES_PER_LINE, parseTag, compareTags, latestTag, suggestTag, mapIndex, draftNotes, renderMarkdown, escapeMarkdown,
  // @ts-expect-error plain JS module, no declarations
} from '../../core/release-notes.js';

const node = (id, type, file, label = id) => ({ id, type, label, ...(file ? { file } : {}) });
const MAP = {
  nodes: [
    node('root', 'root', 'package.json', 'cornfield'),
    node('app-web', 'app', 'packages/web', 'web'),
    node('page-home', 'page', 'packages/web/src/index.js', '/'),
    node('page-cart', 'page', 'packages/web/src/cart.js', '/cart'),
    node('pkg-api', 'pkg', 'packages/api', 'api'),
    node('core-orders', 'core', 'packages/api/src/orders.js', 'orders.js'),
    node('core-geo', 'core', 'packages/api/src/geo.js', 'geo.js'),
    node('store-db', 'store', null, 'db'),
  ],
  edges: [
    { from: 'root', to: 'app-web' }, { from: 'app-web', to: 'page-home' }, { from: 'app-web', to: 'page-cart' },
    { from: 'root', to: 'pkg-api' }, { from: 'pkg-api', to: 'core-orders' }, { from: 'pkg-api', to: 'core-geo' },
    { from: 'page-cart', to: 'core-orders', kind: 'calls' }, // not ownership: ignored
  ],
};
const pull = (number, title, files, extra = {}) => ({ number, title, url: `https://forge.test/pull/${number}`, author: { login: 'agent-four' }, labels: [], mergedAt: `2026-10-${10 + number}T10:00:00Z`, files: files.map((path) => ({ path })), ...extra });

describe('tags', () => {
  it('reads semver tags and nothing else', () => {
    expect(parseTag('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: null });
    expect(parseTag('0.10.0-rc.1+build5')).toEqual({ major: 0, minor: 10, patch: 0, pre: 'rc.1' });
    for (const bad of ['nightly', 'v1.2', 'release-1.2.3', '1.2.3.4', '', null]) expect(parseTag(bad), String(bad)).toBeNull();
  });

  it('orders by number, not by text, and puts a pre-release before its release', () => {
    const names = ['v0.10.0', 'v0.2.0', 'v0.2.0-rc.2', 'v0.2.0-rc.10', 'v0.2.0-alpha', 'v1.0.0', 'v0.9.9'];
    expect([...names].sort(compareTags)).toEqual(['v0.2.0-alpha', 'v0.2.0-rc.2', 'v0.2.0-rc.10', 'v0.2.0', 'v0.9.9', 'v0.10.0', 'v1.0.0']);
  });

  it('finds the latest version tag, whatever order the forge lists them, and none when there is no version', () => {
    const tags = [{ name: 'nightly' }, { name: 'v0.2.0' }, { name: 'v0.10.0' }, { name: 'v0.9.0' }];
    expect(latestTag(tags)).toEqual({ name: 'v0.10.0' });
    expect(latestTag([{ name: 'nightly' }, { name: 'latest' }])).toBeNull();
    expect(latestTag([])).toBeNull();
  });

  it('suggests the package\'s version when it has no tag yet, else the next patch, else nothing', () => {
    const tags = [{ name: 'v0.1.0' }, { name: 'v0.2.0' }];
    expect(suggestTag(tags, '0.3.0')).toBe('v0.3.0');
    expect(suggestTag(tags, '0.2.0')).toBe('v0.2.1'); // already tagged
    expect(suggestTag(tags, '0.1.0')).toBe('v0.2.1'); // behind the latest tag
    expect(suggestTag([{ name: '1.4.0' }], null)).toBe('1.4.1'); // keeps the style of the tags
    expect(suggestTag([{ name: 'v1.0.0-rc.1' }], null)).toBe('');
    expect(suggestTag([], '0.1.0')).toBe('v0.1.0');
    expect(suggestTag([], null)).toBe('');
    expect(suggestTag([], 'not-a-version')).toBe('');
  });
});

describe('the map', () => {
  it('knows each node\'s owner from the edges with no kind, the first one winning', () => {
    const idx = mapIndex({ nodes: MAP.nodes, edges: [...MAP.edges, { from: 'root', to: 'core-geo' }] });
    expect(idx.owner.get('page-home')).toBe('app-web');
    expect(idx.owner.get('core-geo')).toBe('pkg-api');
    expect(idx.owner.has('core-orders')).toBe(true);
    expect(idx.owner.has('root')).toBe(false);
    expect(mapIndex(null).nodes).toEqual([]);
  });
});

describe('draftNotes', () => {
  const group = (notes, id) => notes.groups.find((g) => g.id === id);

  it('groups by the area a file\'s node belongs to, with the nodes changed, in the map\'s order', () => {
    const notes = draftNotes({
      topology: MAP,
      pulls: [
        pull(2, 'Cart page', ['packages/web/src/cart.js', 'packages/web/src/index.js']),
        pull(1, 'Orders and geo', ['packages/api/src/geo.js', 'packages/api/src/orders.js']),
      ],
    });
    expect(notes.count).toBe(2);
    expect(notes.groups.map((g) => [g.kind, g.title])).toEqual([['area', 'web'], ['area', 'api']]);
    expect(group(notes, 'app-web').items).toEqual([{ number: 2, title: 'Cart page', url: 'https://forge.test/pull/2', author: 'agent-four', nodes: ['/', '/cart'] }]);
    expect(group(notes, 'pkg-api').items[0].nodes).toEqual(['orders.js', 'geo.js']);
  });

  it('lists a pull request under each area it touched, and a file on the area\'s own node adds no node to the line', () => {
    const notes = draftNotes({ topology: MAP, pulls: [pull(3, 'Both', ['packages/web/README.md', 'packages/api/src/geo.js'])] });
    expect(notes.count).toBe(1);
    expect(notes.groups.map((g) => g.id)).toEqual(['app-web', 'pkg-api']);
    expect(group(notes, 'app-web').items[0].nodes).toEqual([]);
    expect(group(notes, 'pkg-api').items[0].nodes).toEqual(['geo.js']);
  });

  it('puts what touches nothing on the map under Other, last', () => {
    const notes = draftNotes({ topology: MAP, pulls: [pull(1, 'Docs', ['docs/x.md']), pull(2, 'Web', ['packages/web/src/index.js']), pull(3, 'No files', [])] });
    expect(notes.groups.map((g) => g.id)).toEqual(['app-web', 'other']);
    expect(group(notes, 'other').items.map((i) => i.number)).toEqual([1, 3]);
  });

  it('follows a rename from the old path too, since the map was drawn before the move', () => {
    const p = pull(4, 'Moved', []);
    p.files = [{ path: 'packages/api/src/geo2.js', previousPath: 'packages/api/src/geo.js' }];
    const notes = draftNotes({ topology: MAP, pulls: [p] });
    expect(group(notes, 'pkg-api').items[0].nodes).toEqual(['geo.js']);
  });

  it('puts a labelled pull request first, under Breaking, once, whatever its label\'s case', () => {
    const notes = draftNotes({ topology: MAP, pulls: [pull(1, 'Web', ['packages/web/src/index.js']), pull(2, 'Drop /cart', ['packages/web/src/cart.js', 'packages/api/src/geo.js'], { labels: ['Breaking'] })] });
    expect(notes.groups.map((g) => g.id)).toEqual(['breaking', 'app-web']);
    expect(group(notes, 'breaking').items).toEqual([{ number: 2, title: 'Drop /cart', url: 'https://forge.test/pull/2', author: 'agent-four', nodes: ['web', 'api'] }]);
    expect(group(notes, 'app-web').items.map((i) => i.number)).toEqual([1]);
    expect(notes.count).toBe(2);
  });

  it('takes another label from the config, and a breaking pull request that touches nothing is still Breaking', () => {
    const pulls = [pull(1, 'Old label', ['packages/web/src/index.js'], { labels: ['breaking'] }), pull(2, 'New label', [], { labels: ['semver-major'] })];
    expect(draftNotes({ topology: MAP, pulls }).groups.map((g) => g.id)).toEqual(['breaking', 'other']);
    const custom = draftNotes({ topology: MAP, pulls, breakingLabel: 'semver-major' });
    expect(custom.groups.map((g) => [g.id, g.items.map((i) => i.number)])).toEqual([['breaking', [2]], ['app-web', [1]]]);
    expect(draftNotes({ topology: MAP, pulls }).groups.map((g) => [g.id, g.items.map((i) => i.number)])).toEqual([['breaking', [1]], ['other', [2]]]);
    expect(DEFAULT_BREAKING_LABEL).toBe('breaking');
  });

  it('orders by merge time then number, whatever order they come in, and gives the same notes every time', () => {
    const a = pull(5, 'A', ['packages/web/src/index.js'], { mergedAt: '2026-10-15T10:00:00Z' });
    const b = pull(6, 'B', ['packages/web/src/index.js'], { mergedAt: '2026-10-14T10:00:00Z' });
    const c = pull(4, 'C', ['packages/web/src/index.js'], { mergedAt: '2026-10-14T10:00:00Z' });
    const once = draftNotes({ topology: MAP, pulls: [a, b, c] });
    expect(group(once, 'app-web').items.map((i) => i.number)).toEqual([4, 6, 5]);
    expect(draftNotes({ topology: MAP, pulls: [c, a, b] })).toEqual(once);
    expect(draftNotes({ topology: structuredClone(MAP), pulls: structuredClone([a, b, c]) })).toEqual(once);
  });

  it('works with no map at all: everything is Other', () => {
    for (const topology of [null, { nodes: [] }]) {
      expect(draftNotes({ topology, pulls: [pull(1, 'X', ['a.js'])] }).groups.map((g) => g.id)).toEqual(['other']);
    }
  });

  it('is not led astray by a loop in the ownership edges', () => {
    const loop = { nodes: [node('a', 'app', 'a'), node('b', 'page', 'a/b.js')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] };
    const notes = draftNotes({ topology: loop, pulls: [pull(1, 'X', ['a/b.js'])] });
    expect(notes.groups).toHaveLength(1);
    expect(draftNotes({ topology: loop, pulls: [pull(1, 'X', ['a/b.js'])] })).toEqual(notes);
  });

  it('keeps only a forge login that is a login, and an address that is a web address', () => {
    const notes = draftNotes({ topology: MAP, pulls: [pull(1, 'X', [], { author: { login: 'x) [evil](http://e' }, url: 'javascript:alert(1)' })] });
    expect(group(notes, 'other').items[0]).toMatchObject({ author: null, url: null });
  });
});

describe('renderMarkdown', () => {
  it('writes a heading per group and a line per pull request that links it, with its nodes', () => {
    const notes = draftNotes({ topology: MAP, pulls: [pull(1, 'Web', ['packages/web/src/index.js']), pull(2, 'Docs', ['docs/x.md'])] });
    expect(renderMarkdown(notes)).toBe([
      '### web', '',
      '- Web ([#1](https://forge.test/pull/1) by @agent-four) · `/`', '',
      '### Other', '',
      '- Docs ([#2](https://forge.test/pull/2) by @agent-four)', '',
    ].join('\n'));
  });

  it('names at most a few nodes on a line', () => {
    const many = { nodes: [node('r', 'root'), node('a', 'app', 'a'), ...Array.from({ length: 7 }, (_, i) => node(`n${i}`, 'page', `a/${i}.js`, `n${i}`))], edges: [{ from: 'r', to: 'a' }, ...Array.from({ length: 7 }, (_, i) => ({ from: 'a', to: `n${i}` }))] };
    const notes = draftNotes({ topology: many, pulls: [pull(1, 'Wide', Array.from({ length: 7 }, (_, i) => `a/${i}.js`))] });
    expect(NODES_PER_LINE).toBe(4);
    expect(renderMarkdown(notes)).toContain('· `n0`, `n1`, `n2`, `n3`, and 3 more\n');
  });

  it('says plainly when nothing was merged', () => {
    const none = draftNotes({ topology: MAP, pulls: [] });
    expect(none).toEqual({ groups: [], count: 0 });
    expect(renderMarkdown(none, { since: 'v0.2.0' })).toBe('No pull requests were merged since v0.2.0.\n');
    expect(renderMarkdown(none)).toBe('No pull requests were merged.\n');
  });

  it('cannot be made into markup, a link or a heading by a title', () => {
    const title = 'Evil](http://e) <img src=x onerror=1> `code` *bold*\n## Heading\u0000';
    const notes = draftNotes({ topology: MAP, pulls: [pull(1, title, [])] });
    const md = renderMarkdown(notes);
    const line = md.split('\n').find((l) => l.startsWith('- '));
    expect(md.split('\n').filter((l) => l.startsWith('#'))).toEqual(['### Other']);
    expect(line).toContain('- Evil\\](http://e) \\<img src=x onerror=1\\> \\`code\\` \\*bold\\* \\#\\# Heading (');
    expect(escapeMarkdown('a\r\nb')).toBe('a b');
  });

  it('shows a node whose label has a backtick without breaking out of its code span', () => {
    const odd = { nodes: [node('r', 'root'), node('a', 'app', 'a', 'a`b'), node('n', 'page', 'a/x.js', 'x`y\nz')], edges: [{ from: 'r', to: 'a' }, { from: 'a', to: 'n' }] };
    const md = renderMarkdown(draftNotes({ topology: odd, pulls: [pull(1, 'T', ['a/x.js'])] }));
    expect(md).toContain('· `x y z`');
    expect(md).toContain('### a\\`b');
  });
});
