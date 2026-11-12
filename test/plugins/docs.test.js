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
import { renderMarkdown, markdownLinks, slugify, plainText } from '../../plugins/docs/markdown.js';
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

describe('a heading anchor, as GitHub makes it from the rendered text', () => {
  const ids = (...headings) => renderMarkdown(headings.map((h) => `## ${h}`).join('\n\n')).headings.map((h) => h.id);

  it('keeps the name of a tag written in backticks, and drops its brackets', () => {
    expect(ids('`<corn-review>`: the one-tag review')).toEqual(['corn-review-the-one-tag-review']);
  });

  it('keeps two tags in code, and a tag beside other inline code', () => {
    expect(ids('`<corn-a>` and `<corn-b>`')).toEqual(['corn-a-and-corn-b']);
    expect(ids('`<corn-scope>` and `src`: reading a cornfield server')).toEqual(['corn-scope-and-src-reading-a-cornfield-server']);
  });

  it('keeps only the inner text of a real inline HTML tag outside code, and the text of emphasis and links', () => {
    expect(ids('Press <kbd>Ctrl</kbd> and <em>go</em>')).toEqual(['press-ctrl-and-go']);
    expect(ids('A **bold**, *em* and [linked](x.md) word, snake_case_word and `<kbd>` raw')).toEqual(['a-bold-em-and-linked-word-snake_case_word-and-kbd-raw']);
  });

  it('reads a character reference as its character, which the anchor then drops', () => {
    expect(ids('Use &lt;x&gt; here')).toEqual(['use-x-here']);
    expect(ids('Fish &amp; chips')).toEqual(['fish--chips']);
    expect(ids('Written `&lt;x&gt;` in code')).toEqual(['written-ltxgt-in-code']);
  });

  it('numbers a repeated heading, whatever its markup', () => {
    expect(ids('`<corn-x>` notes', '`<corn-x>` notes', 'Corn-x notes', '<b>corn-x</b> notes')).toEqual(['corn-x-notes', 'corn-x-notes-1', 'corn-x-notes-2', 'corn-x-notes-3']);
  });

  it('keeps the heading text a reader sees (the tag in code stays)', () => {
    expect(renderMarkdown('## `<corn-review>`: the review').headings[0].text).toBe('<corn-review>: the review');
  });

  it('reads a backslash inside code as written, and an escaped backtick outside code as text', () => {
    const h = renderMarkdown('## The `a\\*b` and `\\\\` marks\n\n## Not \\`code` here').headings;
    expect(h.map((x) => x.text)).toEqual(['The a\\*b and \\\\ marks', 'Not `code` here']);
    expect(h.map((x) => x.id)).toEqual(['the-ab-and--marks', 'not-code-here']);
  });

  it('cannot be made to swap in text it set aside, whatever characters the heading holds', () => {
    const h = renderMarkdown('## `<x>` and \u00000\u0000 and \u00007\u0000').headings[0];
    expect(h.text).toBe('<x> and �0� and �7�');
    expect(h.id).toBe('x-and-0-and-7');
  });

  it('gives an image no text in the anchor, keeps marks on letters, and drops a no-break space or a tab', () => {
    expect(ids('![logo](logo.png) CornField', 'Build ![CI](ci.svg)', 'हिन्दी शीर्षक', 'A&nbsp;B', 'Tab\there')).toEqual(['-cornfield', 'build-', 'हिन्दी-शीर्षक', 'ab', 'tabhere']);
    expect(renderMarkdown('# ![logo](logo.png) CornField').title).toBe('logo CornField');
  });

  it('reads an autolink as its address, a link with a title as its text, and the common arrows as characters', () => {
    expect(ids('See <https://example.com/a_b_c>', '[Link](x.md "a (note)") here', 'Before &rarr; after')).toEqual(['see-httpsexamplecoma_b_c', 'link-here', 'before--after']);
  });

  it('reads a huge or hostile heading in linear time', () => {
    const t = performance.now();
    for (const s of ['`'.repeat(300000) + 'a', ' _a'.repeat(100000), ' __a'.repeat(100000), '[a]('.repeat(100000), '[a](' + ' '.repeat(300000), '<!--'.repeat(100000), '['.repeat(300000)]) plainText(s);
    expect(performance.now() - t).toBeLessThan(5000);
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

  it('finds a heading with a tag in code, and still warns on one that is not there', async () => {
    fs.writeFileSync(path.join(root, 'docs/guide.md'), '# The guide\n\n## `<corn-review>`: the one-tag review\n\n[ok](#corn-review-the-one-tag-review) [ok too](adr/0001-first.md#the-first-decision) [gone](#corn-review)\n');
    fs.writeFileSync(path.join(root, 'docs/adr/0001-first.md'), '# 0001\n\n## The `<first>` decision\n');
    const out = await deriveTopology({ root, derivers: [{ deriver: docs }] });
    expect(out.warnings).toEqual(['docs: docs/guide.md links to "#corn-review", but docs/guide.md has no heading "#corn-review".']);
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

  it('keeps a title that holds a tag (written in code, or as a character reference) as text on every page and in the map', async () => {
    fs.writeFileSync(path.join(root, 'docs/guide.md'), '# `<script>alert(1)</script>` &lt;img src=x onerror=alert(2)&gt;\n\n[home](../README.md)\n');
    try {
      const config = await loadConfig(root, { env: {} });
      const derived = await deriveTopology({ root, derivers: [{ deriver: docs }] });
      expect(derived.nodes.find((n) => n.file === 'docs/guide.md').summary).toBe('<script>alert(1)</script> <img src=x onerror=alert(2)>');
      const out = path.join(root, '_site');
      await buildSite({ config, derivers: [], out });
      const html = ['index.html', 'docs/guide.html', 'map.html'].map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(2)&gt;');
      expect(html).not.toMatch(/<script|<img src=x/i);
    } finally {
      writeRepo(root);
    }
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

describe('inline Markdown', () => {
  const html = (line) => renderMarkdown(line).html;

  // What main rendered for each of these lines before the inline reader was made linear (nothing here may change)
  it('renders legitimate but tricky lines as it always has', () => {
    const cases = [
    ["plain *em* and **strong** and ***both*** and _u_ and __uu__",
      "<p>plain <em>em</em> and <strong>strong</strong> and <strong>*both</strong>* and <em>u</em> and <strong>uu</strong></p>"],
    ["nested **bold *inner em* more** and *a **b** c*",
      "<p>nested <strong>bold <em>inner em</em> more</strong> and <em>a <strong>b</strong> c</em></p>"],
    ["[link](http://a.com/x_(y)_z \"ti(tle)\") and [b](<a b> 'x') and [c]( d  \"t\"  )",
      "<p><a href=\"http://a.com/x_(y)_z\" title=\"ti(tle)\">link</a> and <a href=\"a b\" title=\"x\">b</a> and <a href=\"d\" title=\"t\">c</a></p>"],
    ["`code [x](y) *a*` and ``a ` b`` and ` a ` and `unclosed",
      "<p><code>code [x](y) *a*</code> and <code>a ` b</code> and <code>a</code> and `unclosed</p>"],
    ["[a [nested] b](u) and [a](u(v(w))x) and [a](u(v) y",
      "<p><a href=\"u\">a [nested] b</a> and <a href=\"u(v(w))x\">a</a> and [a](u(v) y</p>"],
    ["![alt *x*](i.png \"t\") and [![img](i.png)](http://l.com) and ![a](<b c>)",
      "<p><img src=\"i.png\" alt=\"alt x\" title=\"t\" loading=\"lazy\"> and <a href=\"http://l.com\"><img src=\"i.png\" alt=\"img\" loading=\"lazy\"></a> and <img src=\"b c\" alt=\"a\" loading=\"lazy\"></p>"],
    ["\\*not em\\* \\[x\\](y) \\\\ \\` \\_ \\a end\\",
      "<p>*not em* [x](y) \\ ` _ \\a end\\</p>"],
    ["snake_case_name and _a_b_ and a_b_ and __init__ and _ a _ and * a *",
      "<p>snake_case_name and <em>a_b</em> and a_b_ and <strong>init</strong> and _ a _ and * a *</p>"],
    ["unbalanced ** and * and _ and __ and [x and x] and ](y) and [x](y",
      "<p>unbalanced ** and * and _ and __ and [x and x] and ](y) and [x](y</p>"],
    ["<http://a.com/b?c=d> <mailto:a@b.c> <notaurl> a < b > c <b>x</b> <!-- c -->",
      "<p><a href=\"http://a.com/b?c=d\">http://a.com/b?c=d</a> <a href=\"mailto:a@b.c\">a@b.c</a> &lt;notaurl&gt; a &lt; b &gt; c &lt;b&gt;x&lt;/b&gt; &lt;!-- c --&gt;</p>"],
    ["[a](u \"t\" x) [a](u 't') [a]() [a]( ) [](u) ![](u) [a](  )",
      "<p>[a](u &quot;t&quot; x) <a href=\"u\" title=\"t\">a</a> a a <a href=\"u\"></a> <img src=\"u\" alt=\"\" loading=\"lazy\"> a</p>"],
    ["[`a]`](u) [a\\]b](u) [a](u\\)v)",
      "<p><a href=\"u\"><code>a]</code></a> <a href=\"u\">a]b</a> <a href=\"u)v\">a</a></p>"],
    ["[[a]](u) [a][b] [a]: u",
      "<p><a href=\"u\">[a]</a> [a][b] [a]: u</p>"],
    ["*a*b *a*  *a *b* c* **a**b __a__b __a __b__ c__",
      "<p><em>a</em>b <em>a</em>  <em>a *b</em> c* <strong>a</strong>b <strong>a__b __a __b</strong> c__</p>"],
    ];
    for (const [line, expected] of cases) expect(html(line), line).toBe(expected);
  });

  it('never lets a link, an image or a tag written in a doc become script', () => {
    const cases = [
    ["[x](javascript:alert(1))",
      "<p>x</p>"],
    ["[x](JaVaScRiPt:alert(1))",
      "<p>x</p>"],
    ["[x](data:text/html,<b>a</b>)",
      "<p>x</p>"],
    ["![x](javascript:alert(1))",
      "<p>x</p>"],
    ["![x](data:image/svg+xml,<svg onload=alert(1)>)",
      "<p>![x](data:image/svg+xml,&lt;svg onload=alert(1)&gt;)</p>"],
    ["[x](u \"a' onerror='alert(1)\")",
      "<p><a href=\"u\" title=\"a&#39; onerror=&#39;alert(1)\">x</a></p>"],
    ["[x](u '\" onerror=\"alert(1)')",
      "<p><a href=\"u\" title=\"&quot; onerror=&quot;alert(1)\">x</a></p>"],
    ["[x](\"onerror=alert(1))",
      "<p><a href=\"&quot;onerror=alert(1)\">x</a></p>"],
    ["[<script>alert(1)</script>](u)",
      "<p><a href=\"u\">&lt;script&gt;alert(1)&lt;/script&gt;</a></p>"],
    ["[<img src=x onerror=alert(1)>](u)",
      "<p><a href=\"u\">&lt;img src=x onerror=alert(1)&gt;</a></p>"],
    ["![<b>a</b> \"q\"](u \"<i>t</i>\")",
      "<p><img src=\"u\" alt=\"a &quot;q&quot;\" title=\"&lt;i&gt;t&lt;/i&gt;\" loading=\"lazy\"></p>"],
    ["<http://a.com/\"onmouseover=\"alert(1)>",
      "<p><a href=\"http://a.com/&quot;onmouseover=&quot;alert(1)\">http://a.com/&quot;onmouseover=&quot;alert(1)</a></p>"],
    ["[x](vbscript:a) [y](  javascript:a)",
      "<p>x y</p>"],
    ["[x](&#106;avascript:alert(1))",
      "<p><a href=\"&amp;#106;avascript:alert(1)\">x</a></p>"],
    ["[x](mailto:a@b.c) [y](https://a.com/?a=1&b=2) [z](#top) [w](../a.md)",
      "<p><a href=\"mailto:a@b.c\">x</a> <a href=\"https://a.com/?a=1&amp;b=2\">y</a> <a href=\"#top\">z</a> <a href=\"../a.md\">w</a></p>"],
    ["<p onclick=\"alert(1)\"><a href=\"javascript:alert(1)\" onclick=\"x\">t</a><img src=\"data:a\" onerror=\"x\"><img src=\"ok.png\" onerror=\"x\"><script>alert(1)</script></p>",
      "<p><a>t</a><img loading=\"lazy\"><img src=\"ok.png\" loading=\"lazy\">alert(1)</p>"],
    ];
    for (const [line, expected] of cases) expect(html(line), line).toBe(expected);
    // and the site's own link function still decides each target (null: the text without a link)
    expect(renderMarkdown('[a](x.md) ![b](y.png)', { link: (h, { image }) => (image ? null : `/site/${h}`) }).html).toBe('<p><a href="/site/x.md">a</a> b</p>');
  });

  it('keeps links, emphasis, lists and quotes nested 16 deep, and writes a deeper one as text', () => {
    const links = (n, inner) => '['.repeat(n) + inner + '](u)'.repeat(n);
    const count = (s, re) => (s.match(re) || []).length;
    expect(count(html(links(16, 'a')), /<a href="u">/g)).toBe(16);
    // The seventeenth stays as written, its marks and any tag in it escaped
    const deep = html(links(17, '<b>x</b>'));
    expect(count(deep, /<a href="u">/g)).toBe(16);
    expect(deep).toContain('<a href="u">[&lt;b&gt;x&lt;/b&gt;](u)</a>');
    // Emphasis counts as a level too: inside fifteen links it is read, inside sixteen it is text
    expect(html(links(15, '*a* __b__'))).toContain('<a href="u"><em>a</em> <strong>b</strong></a>');
    expect(html(links(16, '*a* __<i>b</i>__'))).toContain('<a href="u">*a* __&lt;i&gt;b&lt;/i&gt;__</a>');
    expect(count(html('- '.repeat(16) + 'a'), /<ul>/g)).toBe(16);
    expect(html('- '.repeat(17) + '<b>a')).toMatch(/<li>- &lt;b&gt;a<\/li>/);
    expect(count(html('>'.repeat(16) + ' a'), /<blockquote>/g)).toBe(16);
    expect(html('>'.repeat(17) + ' <b>a')).toMatch(/<blockquote>\n<p>&gt; &lt;b&gt;a<\/p>\n<\/blockquote>/);
  });

  it('reads a line of a hundred thousand nested marks, lists or quotes without running out of stack', () => {
    for (const line of ['- '.repeat(100000) + 'a', '>'.repeat(200000) + 'a', '> 1. '.repeat(50000) + 'a', '['.repeat(50000) + 'a' + '](u)'.repeat(50000), '*'.repeat(200000) + 'a' + '*'.repeat(200000)]) {
      expect(() => renderMarkdown(line)).not.toThrow();
      expect(() => markdownLinks(line)).not.toThrow();
    }
  });
});

/** The best of a few runs of `fn`, in ms */
const best = (fn, runs = 3) => {
  let min = Infinity;
  for (let r = 0; r < runs; r++) { const t = performance.now(); fn(); min = Math.min(min, performance.now() - t); }
  return min;
};

describe('Markdown in linear time', () => {
  // A line of one pattern over and over, at 64 KB and then 1 MB. Linear, each takes a few tens of milliseconds; the
  // limits are far above that (a slow machine passes), and far below what a quadratic reader needs: it fails at 64 KB,
  // and the 1 MB run (hours for it) is not reached
  const SIZES = [[64 * 1024, 1000], [1024 * 1024, 5000]];
  const PATTERNS = {
    'a link that never ends': '[a](', 'an underscore run': '__a', 'a star run': '*a', 'an image start': '![', 'one backtick': '`',
    'a code span that never ends': '`a', 'a longer backtick run': '``a`', 'a lone angle bracket': '<', 'an autolink that never ends': '<http://a',
    'a backslash': '\\', 'an open bracket': '[', 'a close bracket': ']', 'a link and its destination, no text': '](', 'a destination in angle brackets': '[a](<',
    'a destination with a parenthesis': '[a](x(', 'a title that never ends': '[a](u "', 'a bracket and a code span': '[`', 'a lone underscore': '_a ',
    'a hard line break': 'a  \nb ', 'spaces after a link': '[a]( ',
  };
  const render = (s) => renderMarkdown(s).html;
  for (const [what, unit] of Object.entries(PATTERNS)) {
    it(`reads ${what} repeated to 1 MB in linear time`, () => {
      for (const [size, limit] of SIZES) {
        const s = unit.repeat(Math.ceil(size / unit.length));
        const t = performance.now();
        render(s);
        expect(performance.now() - t, `${what} at ${size} bytes`).toBeLessThan(limit);
      }
    }, 60000);
  }

  it('reads brackets, parentheses, spaces and every mark mixed in linear time', () => {
    const MIXED = {
      'brackets open then closed': (n) => '['.repeat(n / 2) + ']'.repeat(n / 2),
      'links nested': (n) => '[a'.repeat(n / 8) + '](u)'.repeat(n / 8),
      'a little of everything': (n) => '[a](u) *b* _c_ `d` <e> \\f ![g](h) '.repeat(n / 36),
      'parentheses around a link': (n) => '('.repeat(n / 2) + '[a]' + ')'.repeat(n / 2),
      'a link then spaces': (n) => '[a](' + ' '.repeat(n),
      'many links then spaces': (n) => '[a]('.repeat(n / 8) + ' '.repeat(n / 2),
    };
    for (const [what, make] of Object.entries(MIXED)) {
      for (const [size, limit] of SIZES) {
        const s = make(size);
        const t = performance.now();
        render(s);
        expect(performance.now() - t, what).toBeLessThan(limit);
      }
    }
  });

  it('reads an HTML block with many tags, comments or fence lines in linear time', () => {
    const lines = {
      'tags that never end': '<p>' + '<a b'.repeat(300000), 'tags that end in a slash and a space': '<p>' + '<a b'.repeat(250000) + '/ >',
      'comments that never end': '<p>' + '<!--'.repeat(250000), 'attributes with an open quote': '<p>' + '<img a="'.repeat(130000),
      'a fence line with spaces and a backtick': '```' + ' '.repeat(1000000) + '`',
    };
    for (const [what, text] of Object.entries(lines)) {
      for (const [size, limit] of SIZES) {
        const t = performance.now();
        renderMarkdown(text.slice(0, size));
        expect(performance.now() - t, what).toBeLessThan(limit);
      }
    }
  });

  it('takes about four times as long for four times as much, over runs of the special characters', () => {
    const marks = '[]()_*`\\<>!ab  \n"\'';
    let seed = 20260513;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let k = 0; k < 30; k++) {
      let unit = '';
      for (let len = 1 + rnd(6); len > 0; len--) unit += marks[rnd(marks.length)];
      const at = (size) => unit.repeat(Math.ceil(size / unit.length));
      const small = best(() => render(at(20000)));
      const large = best(() => render(at(80000)), 2);
      // Four times the text; a quadratic reader takes sixteen times as long
      expect(large, JSON.stringify(unit)).toBeLessThan(small * 9 + 150);
    }
  });
});
