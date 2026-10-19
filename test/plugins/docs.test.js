/**
 * @vitest-environment node
 *
 * The docs deriver and its site (plugins/docs): the Markdown renderer, the map of a repo's docs (a page per
 * document, the links between them and to the code, a broken link as a problem), and the static site built
 * from that map, on a small repo written for the test and on cornfield's own docs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderMarkdown, markdownLinks, slugify } from '../../plugins/docs/markdown.js';
import docs, { docRoute, docOutput, docPageId, resolveLink } from '../../plugins/docs/index.js';
import { buildSite, sourceUrlOf, SITE_MARKER } from '../../plugins/docs/site.js';
import { deriveTopology } from '../../core/derive.js';
import { planSync } from '../../core/sync.js';
import { validateTopology } from '../../core/validate.js';
import { loadConfig, loadDerivers } from '../../core/config.js';
import { CORNFIELD } from '../helpers.js';

describe('renderMarkdown', () => {
  it('draws headings with GitHub anchors, code, lists, tables, quotes and inline marks', () => {
    const { html, title, headings } = renderMarkdown([
      '# The title', '', '## 4. The v1 issues', '', 'Some **bold**, *em*, a snake_case_word and `a|b`.', '',
      '```js', 'const x = "<b>";', '```', '', '- one', '- two', '  1. nested', '', '> quoted', '',
      '| A | B |', '|---|--:|', '| `x|y` | [l](b.md) |', '', '---', '## The title',
    ].join('\n'));
    expect(title).toBe('The title');
    expect(headings.map((h) => h.id)).toEqual(['the-title', '4-the-v1-issues', 'the-title-1']);
    expect(html).toContain('<strong>bold</strong>, <em>em</em>, a snake_case_word and <code>a|b</code>.');
    expect(html).toContain('<pre><code class="language-js">const x = &quot;&lt;b&gt;&quot;;\n</code></pre>');
    expect(html).toMatch(/<ul>\n<li>one<\/li>\n<li>two\n<ol>\n<li>nested<\/li>\n<\/ol><\/li>\n<\/ul>/);
    expect(html).toContain('<blockquote>\n<p>quoted</p>\n</blockquote>');
    expect(html).toContain('<td><code>x|y</code></td><td style="text-align:right"><a href="b.md">l</a></td>');
    expect(html).toContain('<hr>');
  });

  it('escapes raw HTML except a short allowlist, rebuilt from safe attributes', () => {
    const { html } = renderMarkdown('<script>alert(1)</script>\n\n<p align="center"><img src="a.png" onerror="x()" alt="A"></p>\n\n[x](javascript:alert(1)) <b>inline</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<p align="center"><img src="a.png" alt="A" loading="lazy"></p>');
    expect(html).not.toMatch(/onerror|javascript:/);
    expect(html).toContain('&lt;b&gt;inline&lt;/b&gt;');
  });

  it('sends every link and image through link(), and skips the ones in code', () => {
    expect(markdownLinks('[a](a.md) ![i](i.png) `[no](x.md)`\n\n```\n[no](y.md)\n```\n<img src="h.png">')).toEqual([
      { href: 'a.md', image: false }, { href: 'i.png', image: true }, { href: 'h.png', image: true },
    ]);
    expect(renderMarkdown('[a](a.md)', { link: () => null }).html).toBe('<p>a</p>');
    expect(slugify('Stage 1: local only, until sign-in lands')).toBe('stage-1-local-only-until-sign-in-lands');
  });
});

describe('routes and links', () => {
  it('gives each doc a route, a site file and a page id; a README stands for its folder', () => {
    expect([docRoute('README.md'), docRoute('docs/adr/README.md'), docRoute('docs/config.md')]).toEqual(['/', '/docs/adr/', '/docs/config']);
    expect([docOutput('README.md'), docOutput('docs/adr/README.md'), docOutput('docs/config.md')]).toEqual(['index.html', 'docs/adr/index.html', 'docs/config.html']);
    expect(docPageId('docs/adr/0001-Home.md')).toBe('page-doc-docs-adr-0001-home');
  });

  it('resolves a link against the doc, the repo root for a leading slash, and never outside the repo', () => {
    expect(resolveLink('docs/adr/x.md', '../config.md#sources')).toEqual({ path: 'docs/config.md', hash: 'sources', folder: false });
    expect(resolveLink('docs/x.md', '/core/sync.js')).toMatchObject({ path: 'core/sync.js' });
    expect(resolveLink('docs/x.md', 'adr/')).toMatchObject({ path: 'docs/adr', folder: true });
    expect(resolveLink('docs/x.md', '#top')).toEqual({ path: '', hash: 'top' });
    expect(resolveLink('docs/x.md', 'https://example.org')).toEqual({ external: true });
    expect(resolveLink('docs/x.md', '../../up.md')).toEqual({ outside: true });
  });
});

/** A small repo: a README, two docs, an ADR folder with its index, an image, one module */
function writeRepo(root, extra = {}) {
  const files = {
    'package.json': JSON.stringify({ name: 'acme', type: 'module' }),
    'README.md': '# Acme\n\nSee [the guide](docs/guide.md) and [the decisions](docs/adr/).\n\n![map](docs/images/map.png)\n',
    'docs/guide.md': '# The guide\n\n## Setup\n\nThe code: [lib](../lib/index.js). Back [home](../README.md). [Ext](https://example.org).\n',
    'docs/adr/README.md': '# Decisions\n\n- [0001](0001-first.md)\n',
    'docs/adr/0001-first.md': '# ADR 0001: First\n\nSee [setup](../guide.md#setup).\n',
    'docs/images/map.png': 'not really a png',
    'lib/index.js': '/** The library. */\nexport const x = 1;\n',
    ...extra,
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
}

describe('the docs deriver', () => {
  let root;
  beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-docs-')); writeRepo(root); });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const code = { name: 'code', contract: 1, owns: ['root', 'core'], derive: () => ({ nodes: [{ id: 'root', type: 'root', label: 'acme', file: 'package.json' }, { id: 'core-lib', type: 'core', label: 'index.js', file: 'lib/index.js' }], edges: [{ from: 'root', to: 'core-lib' }] }) };

  it('maps each doc as a page of app-docs, its links as usage links, and links to code to the node another deriver made', async () => {
    const out = await deriveTopology({ root, derivers: [{ deriver: code }, { deriver: docs }] });
    expect(out.problems).toEqual([]);
    expect(out.warnings).toEqual([]);
    const pages = out.nodes.filter((n) => n.type === 'page');
    expect(pages.map((n) => [n.id, n.label, n.summary])).toEqual([
      ['page-doc-readme', '/', 'Acme'],
      ['page-doc-docs-adr-0001-first', '/docs/adr/0001-first', 'ADR 0001: First'],
      ['page-doc-docs-adr-readme', '/docs/adr/', 'Decisions'],
      ['page-doc-docs-guide', '/docs/guide', 'The guide'],
    ]);
    const dashed = out.edges.filter((e) => e.dashed).map((e) => `${e.from} > ${e.to}`);
    expect(dashed).toEqual([
      'page-doc-readme > page-doc-docs-guide', 'page-doc-readme > page-doc-docs-adr-readme',
      'page-doc-docs-adr-0001-first > page-doc-docs-guide', 'page-doc-docs-adr-readme > page-doc-docs-adr-0001-first',
      'page-doc-docs-guide > core-lib', 'page-doc-docs-guide > page-doc-readme',
    ]);
    expect(out.edges).toContainEqual({ from: 'root', to: 'app-docs' });
    expect(out).toMatchObject({ ownedIds: ['app-docs'], pageOwners: ['app-docs'] });
    // It syncs into a map the schema accepts, and a second sync changes nothing
    const { next } = planSync({ nodes: [], edges: [] }, out);
    expect(validateTopology(next)).toEqual([]);
    expect(next.nodes.find((n) => n.id === 'page-doc-docs-guide').desc).toBe('The guide (docs/guide.md).');
    expect(planSync(next, out).changes).toEqual([]);
  });

  it('fails on a broken link, warns on a missing heading, and removes a deleted doc on the next sync', async () => {
    const before = await deriveTopology({ root, derivers: [{ deriver: docs }] });
    const map = planSync({ nodes: [], edges: [] }, before).next;
    fs.writeFileSync(path.join(root, 'docs/guide.md'), '# The guide\n\nSee [gone](gone.md) and [no heading](adr/0001-first.md#nope).\n');
    fs.rmSync(path.join(root, 'docs/adr/0001-first.md'));
    fs.writeFileSync(path.join(root, 'docs/adr/README.md'), '# Decisions\n');
    const out = await deriveTopology({ root, derivers: [{ deriver: docs }] });
    expect(out.problems).toEqual([
      'docs: docs/guide.md links to "gone.md", but docs/gone.md is not in the repo.',
      'docs: docs/guide.md links to "adr/0001-first.md#nope", but docs/adr/0001-first.md is not in the repo.',
    ]);
    expect(planSync(map, out).changes).toContain('remove page page-doc-docs-adr-0001-first (/docs/adr/0001-first)');
    writeRepo(root);
    fs.writeFileSync(path.join(root, 'docs/guide.md'), '# The guide\n\n## Setup\n\n[no heading](adr/0001-first.md#nope)\n');
    expect((await deriveTopology({ root, derivers: [{ deriver: docs }] })).warnings).toEqual(['docs: docs/guide.md links to "adr/0001-first.md#nope", but docs/adr/0001-first.md has no heading "#nope".']);
    writeRepo(root);
  });

  it('maps nothing in a repo with no docs, and says so when the paths were asked for', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-nodocs-'));
    try {
      expect(await deriveTopology({ root: empty, derivers: [{ deriver: docs }] })).toMatchObject({ nodes: [], warnings: [] });
      expect((await deriveTopology({ root: empty, derivers: [{ deriver: docs, options: { paths: ['manual'] } }] })).warnings).toEqual(['docs: no Markdown in manual.']);
      await expect(deriveTopology({ root: empty, derivers: [{ deriver: docs, options: { paths: 'docs' } }] })).rejects.toThrow(/options.paths is a list/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('the site', () => {
  let root;
  beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-site-')); writeRepo(root); });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('builds a page per doc with relative links, copies the images, links code to the forge, and draws the map', async () => {
    const config = await loadConfig(root, { env: {} });
    config.forge = { type: 'github', url: 'https://github.com', repo: 'acme/acme' };
    const out = path.join(root, '_site');
    const res = await buildSite({ config, derivers: [], out });
    expect(res.pages).toBe(4);
    expect(res.files).toEqual([SITE_MARKER, 'docs/adr/0001-first.html', 'docs/adr/index.html', 'docs/guide.html', 'docs/images/map.png', 'index.html', 'map.html', 'site.css']);
    const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    expect(index).toContain('<a href="docs/guide.html">the guide</a>');
    expect(index).toContain('<a href="docs/adr/index.html">the decisions</a>');
    expect(index).toContain('<img src="docs/images/map.png" alt="map" loading="lazy">');
    expect(index).toContain('<link rel="stylesheet" href="site.css">');
    const adr = fs.readFileSync(path.join(out, 'docs/adr/0001-first.html'), 'utf8');
    expect(adr).toContain('<a href="../guide.html#setup">setup</a>');
    expect(adr).toContain('<link rel="stylesheet" href="../../site.css">');
    const guide = fs.readFileSync(path.join(out, 'docs/guide.html'), 'utf8');
    expect(guide).toContain('<a href="https://github.com/acme/acme/blob/HEAD/lib/index.js">lib</a>');
    expect(guide).toContain('<a href="https://example.org">Ext</a>');
    // The map around the page: what links to it, what it links to
    expect(guide).toMatch(/Linked from<\/h2><ul><li><a href="..\/index.html">Acme<\/a><\/li><li><a href="adr\/0001-first.html">ADR 0001: First<\/a><\/li>/);
    const map = fs.readFileSync(path.join(out, 'map.html'), 'utf8');
    expect(map).toContain('4 pages and 5 links');
    expect(map).toContain('<svg class="map"');
    // A rebuild empties its own folder; a folder of other files is refused
    expect((await buildSite({ config, derivers: [], out })).pages).toBe(4);
    await expect(buildSite({ config, derivers: [], out: path.join(root, 'docs') })).rejects.toThrow(/not a site cornfield built/);
    await expect(buildSite({ config, derivers: [], out: path.dirname(root) })).rejects.toThrow(/must not hold the repo/);
    expect(fs.existsSync(path.join(root, 'docs/guide.md'))).toBe(true);
  });

  it('points repo files at the forge only when there is one', () => {
    expect(sourceUrlOf({ forge: { type: 'github', url: 'https://github.com', repo: 'a/b' } })).toBe('https://github.com/a/b/blob/HEAD');
    expect(sourceUrlOf({ forge: { type: 'forgejo', url: 'https://git.example.org/', repo: 'a/b' } })).toBe('https://git.example.org/a/b/src/branch/main');
    expect(sourceUrlOf({ forge: null })).toBe(null);
  });

  it("builds cornfield's own docs with no broken link", async () => {
    const config = await loadConfig(CORNFIELD, { env: {} });
    const derivers = await loadDerivers(config);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-own-site-'));
    try {
      const res = await buildSite({ config, derivers, out });
      expect(res.problems).toEqual([]);
      expect(res.pages).toBeGreaterThan(15);
      expect(res.files).toContain('docs/derivers.html');
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});
