/**
 * @vitest-environment node
 *
 * The links the docs site writes itself (plugins/docs/site.js): a doc's file name or a config value must never
 * become a script link, and an ordinary site's links stay as they were.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSite, siteFiles } from '../../plugins/docs/site.js';
import { loadConfig } from '../../core/config.js';
import { docOutput, docRoute, docPageId } from '../../plugins/docs/index.js';

const page = (file, title = file) => ({ id: docPageId(file), file, route: docRoute(file), output: docOutput(file), title, anchors: [], text: '' });
const build = (files, opts = {}) => {
  const pages = files.map((f) => page(f));
  const nodes = pages.map((p) => ({ id: p.id, type: 'page', label: p.route, file: p.file }));
  const edges = pages.flatMap((p) => pages.filter((q) => q !== p).map((q) => ({ from: p.id, to: q.id, dashed: true })));
  return siteFiles({ title: 'T', pages, nodes, edges, read: () => '# x\n', exists: () => true, isDir: () => false, ...opts });
};
const hrefs = (html) => [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1]);

describe('the site: links made from file names', () => {
  it('reads a first segment with a colon as a path, at the top level and in a folder', () => {
    const files = build(['README.md', 'docs/guide.md', 'javascript:alert(1).md', 'docs/javascript:alert(1).md']);
    expect(files['docs/guide.html']).toContain('<a href="../javascript:alert(1).html">');
    expect(files['docs/guide.html']).toContain('<a href="./javascript:alert(1).html">');
    expect(files['index.html']).toContain('<a href="./javascript:alert(1).html">');
    expect(files['index.html']).toContain('<a href="docs/javascript:alert(1).html">');
    expect(files['docs/javascript:alert(1).html']).toContain('<a href="./javascript:alert(1).html" aria-current="page">');
    // the map page, in the drawing and in the table
    expect(files['map.html']).toContain('<a href="./javascript:alert(1).html">');
    for (const [name, html] of Object.entries(files)) {
      if (!name.endsWith('.html')) continue;
      for (const h of hrefs(html)) expect(h, `${name}: ${h}`).not.toMatch(/^[^/]*:/);
    }
  });

  it('keeps a mixed-case scheme, a tab and a leading space in a name from being read as one', () => {
    const files = build(['README.md', 'JaVaScRiPt:x.md', 'java\tscript:x.md', ' javascript:x.md']);
    expect(files['index.html']).toContain('<a href="./JaVaScRiPt:x.html">');
    expect(files['index.html']).toContain('<a href="./java%09script:x.html">');
    expect(files['index.html']).toContain('<a href="./%20javascript:x.html">');
  });

  it('writes a name with a backslash, #, ? or % so the link names that file', () => {
    const files = build(['README.md', 'docs/a\\b.md', 'docs/c#d.md', 'docs/e?f.md', 'docs/100%.md', '\\\\evil.example\\x.md']);
    const links = hrefs(files['index.html']);
    expect(links).toContain('docs/a%5Cb.html');
    expect(links).toContain('docs/c%23d.html');
    expect(links).toContain('docs/e%3Ff.html');
    expect(links).toContain('docs/100%25.html');
    expect(links).toContain('%5C%5Cevil.example%5Cx.html');
    expect(links.some((h) => h.startsWith('//') || h.includes('\\'))).toBe(false);
  });

  it('never starts a link with // (a path relative to another file cannot)', () => {
    const files = build(['README.md', '/x.md', '//x.md', 'docs/guide.md']);
    for (const html of Object.values(files)) for (const h of hrefs(String(html))) expect(h.startsWith('//')).toBe(false);
  });

  it("leaves an ordinary site's links as they were", () => {
    const files = build(['README.md', 'docs/guide.md', 'docs/adr/0001-first.md', 'docs/adr/README.md'], { sourceUrl: 'https://github.com/acme/acme/blob/HEAD' });
    expect(hrefs(files['docs/adr/0001-first.html'])).toEqual(['../../site.css', '../../index.html', '../../map.html', 'https://github.com/acme/acme', '../../index.html', '../guide.html', 'index.html', '0001-first.html', '#x', 'https://github.com/acme/acme/blob/HEAD/docs/adr/0001-first.md', '../../index.html', '../guide.html', 'index.html', '../../index.html', '../guide.html', 'index.html', '../../map.html']);
  });
});

describe('the site: links made from config', () => {
  const hostile = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', ' javascript:alert(1)',
    '\u0001javascript:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example', '/relative', 'ftp://x.example',
  ];
  it.each(hostile)('writes no link for the source URL %j', (sourceUrl) => {
    const files = build(['README.md', 'docs/guide.md'], { sourceUrl });
    for (const html of Object.values(files)) {
      // as a browser reads a link: no tab or newline, no leading control or space; a scheme is then only http(s)
      for (const h of hrefs(String(html))) {
        const read = h.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+/, '');
        expect(/^[a-z][a-z0-9+.-]*:/i.test(read) ? /^https?:/i.test(read) : true, h).toBe(true);
        expect(h.startsWith('//')).toBe(false);
      }
    }
    expect(files['index.html']).not.toContain('>Source<');
    expect(files['index.html']).not.toContain('alert');
  });

  it('writes the Source and file links for a good one', () => {
    const sourceUrl = 'HTTPS://git.example.org/a/b/blob/HEAD';
    const files = build(['README.md', 'docs/guide.md'], { sourceUrl });
    expect(files['index.html']).toContain('<a href="HTTPS://git.example.org/a/b">Source</a>');
    expect(files['index.html']).toContain('<a href="HTTPS://git.example.org/a/b/blob/HEAD/README.md">README.md</a>');
  });

  it('writes a node\'s file under the source URL only', () => {
    const pages = [page('README.md'), page('docs/guide.md')];
    const nodes = [...pages.map((p) => ({ id: p.id, type: 'page', label: p.route, file: p.file })), { id: 'c', type: 'module', label: 'c', file: 'javascript:alert(1)' }];
    const edges = [{ from: pages[0].id, to: 'c', dashed: true }];
    const files = siteFiles({ title: 'T', pages, nodes, edges, read: () => '', exists: () => true, isDir: () => false, sourceUrl: 'https://x.example/r/blob/HEAD' });
    expect(files['index.html']).toContain('<a href="https://x.example/r/blob/HEAD/javascript%3Aalert(1)"><code>javascript:alert(1)</code></a>');
  });
});

describe('the site: the files it writes', () => {
  it('writes a doc named with a colon beside the others, and nothing outside the output folder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-sitelinks-'));
    try {
      fs.mkdirSync(path.join(root, 'docs'));
      fs.writeFileSync(path.join(root, 'README.md'), '# Home\n\n[x](docs/javascript:alert(1).md)\n');
      fs.writeFileSync(path.join(root, 'docs/javascript:alert(1).md'), '# Hostile\n\n[home](../README.md)\n');
      const config = await loadConfig(root, { env: {} });
      config.forge = { type: 'github', url: 'javascript:alert(1)//', repo: 'a/b' };
      const out = path.join(root, '_site');
      const res = await buildSite({ config, derivers: [], out });
      expect(res.files).toContain('docs/javascript:alert(1).html');
      const readme = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
      expect(readme).toContain('<a href="docs/javascript:alert(1).html">Hostile</a>');
      expect(readme).not.toContain('>Source<');
      const doc = fs.readFileSync(path.join(out, 'docs/javascript:alert(1).html'), 'utf8');
      expect(doc).toContain('<a href="./javascript:alert(1).html" aria-current="page">Hostile</a>');
      expect(doc).toContain('<a href="../index.html">Home</a>');
      for (const rel of res.files) expect(path.relative(out, path.resolve(out, rel)).startsWith('..')).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
