/**
 * @vitest-environment node
 *
 * What the docs build reads and writes (core/repo.js, plugins/docs): nothing it reads lies outside the repo, nothing
 * it writes lies outside the output folder, a symlink that stays in the repo still works, and a page never lands on a
 * file the site writes itself. Real symlinks on disk, in a temporary folder.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSite } from '../../plugins/docs/site.js';
import docs from '../../plugins/docs/index.js';
import { loadConfig } from '../../core/config.js';
import { deriveTopology } from '../../core/derive.js';
import { repoReader } from '../../core/repo.js';

const MARKER = 'OUTSIDE-FILE-MARKER-7f3a';

/** Whether this machine lets a test make a symlink (Linux and macOS always; Windows only with the right) */
const canSymlink = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-canlink-'));
  try { fs.symlinkSync(dir, path.join(dir, 'l')); return true; } catch { return false; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})();
const linked = canSymlink ? it : it.skip;

let base;
let repo;
const put = (rel, text, dir = repo) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const outside = (rel = '') => path.join(base, 'outside', rel);
const everything = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile());
const build = async (paths, derivers) => {
  const config = await loadConfig(repo, { env: {} });
  const out = path.join(base, 'site');
  const res = await buildSite({ config, derivers: derivers || [{ deriver: docs, options: { paths } }], out });
  return { ...res, out };
};
const derive = (paths) => deriveTopology({ root: repo, derivers: [{ deriver: docs, options: { paths } }] });

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-filesafe-'));
  repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  put('README.md', '# Home\n');
  put('secret.md', `# Secret\n\n${MARKER}\n`, outside());
  put('s.png', MARKER, outside());
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('a docs path that leaves the repo', () => {
  it('is not read, becomes no node, and writes nothing beside the output folder', async () => {
    put('docs/a.md', '# A\n');
    for (const paths of [['README.md', '../outside'], ['README.md', 'docs/../../outside/secret.md'], ['README.md', outside()], ['README.md', outside('secret.md')]]) {
      const out = await derive(paths);
      expect(out.nodes.map((n) => n.id)).toEqual(['app-docs', 'page-doc-readme']);
      expect(out.problems).toHaveLength(1);
      expect(out.problems[0]).toMatch(/is outside the repo/);
      expect(out.problems[0]).toContain(`"${paths[1]}"`); // the path as written
    }
    const res = await build(['README.md', '../outside']);
    expect(res.problems.join('\n')).toContain('"../outside" is outside the repo');
    expect(fs.existsSync(path.join(base, 'out'))).toBe(false);
    expect(fs.readdirSync(base).sort()).toEqual(['outside', 'repo', 'site']);
    for (const f of everything(res.out)) expect(fs.readFileSync(f, 'utf8')).not.toContain(MARKER);
  });

  linked('is refused when it is a symlink to a folder or a file outside', async () => {
    fs.symlinkSync(outside(), path.join(repo, 'ext'));
    fs.symlinkSync(outside('secret.md'), path.join(repo, 'ext.md'));
    const out = await derive(['README.md', 'ext', 'ext.md']);
    expect(out.nodes.map((n) => n.id)).toEqual(['app-docs', 'page-doc-readme']);
    expect(out.problems).toHaveLength(2);
  });
});

describe('a symlink in the docs that leads outside', () => {
  linked('does not copy a symlinked image, and says so', async () => {
    put('docs/d.md', '# D\n\n![p](pic.png)\n');
    fs.symlinkSync(outside('s.png'), path.join(repo, 'docs/pic.png'));
    const res = await build(['docs']);
    expect(everything(res.out).map((f) => path.relative(res.out, f))).not.toContain('docs/pic.png');
    for (const f of everything(res.out)) expect(fs.readFileSync(f, 'utf8')).not.toContain(MARKER);
    expect(res.warnings).toContain('docs: docs/d.md links to "pic.png", which leads outside the repo.');
    expect(res.warnings.join('\n')).not.toContain(base);
  });

  linked('does not read a symlinked doc, folder, or a link inside a symlinked folder', async () => {
    put('docs/d.md', '# D\n\n[s](ext/secret.md)\n');
    fs.symlinkSync(outside('secret.md'), path.join(repo, 'docs/doc.md'));
    fs.symlinkSync(outside(), path.join(repo, 'docs/ext'));
    // a symlink inside an in-repo symlinked folder, leading out
    put('shared/x.md', '# X\n');
    fs.symlinkSync(outside(), path.join(repo, 'shared/out'));
    fs.symlinkSync('../shared', path.join(repo, 'docs/shared'));
    const res = await build(['docs']);
    expect(res.files.sort()).toEqual(['.cornfield-site', 'docs/d.html', 'docs/shared/x.html', 'map.html', 'site.css']);
    for (const f of everything(res.out)) expect(fs.readFileSync(f, 'utf8')).not.toContain(MARKER);
    const map = (await derive(['docs'])).warnings.join('\n');
    expect(map).toContain('docs/doc.md is a link to somewhere outside the repo');
    expect(map).toContain('docs/ext is a link to somewhere outside the repo');
    expect(map).toContain('docs/shared/out is a link to somewhere outside the repo');
    expect(map).toContain('docs/d.md links to "ext/secret.md", which leads outside the repo');
    expect(map).not.toContain(base);
  });

  it('does not let a link or an image climb out of the repo with ..', async () => {
    put('docs/d.md', '# D\n\n[s](../../outside/secret.md) ![i](../../outside/s.png)\n');
    const res = await build(['docs']);
    expect(res.warnings.some((w) => w.includes('outside the repo'))).toBe(true);
    for (const f of everything(res.out)) expect(fs.readFileSync(f, 'utf8')).not.toContain(MARKER);
    expect(res.files).not.toContain('outside/s.png');
  });
});

describe('a symlink loop', () => {
  linked('is walked once', async () => {
    put('docs/d.md', '# D\n');
    fs.symlinkSync('..', path.join(repo, 'docs/loop'));
    const out = await derive(['docs']);
    // the doc once, and the repo's root through the link once (README.md), not the doc forty-one times
    expect(out.nodes.filter((n) => n.type === 'page').map((n) => n.file)).toEqual(['docs/d.md', 'docs/loop/README.md']);
    expect(out.warnings.join('\n')).toContain('docs/loop/docs leads to a folder already read');
  });

  linked('stops the walk every deriver uses', () => {
    put('a/f.txt', 'x');
    fs.symlinkSync('..', path.join(repo, 'a/up'));
    const skipped = [];
    const found = repoReader(repo).walk('a', () => true, (p, why) => skipped.push([p, why]));
    expect(found).toEqual(['a/f.txt', 'a/up/README.md']);
    expect(skipped).toEqual([['a/up/a', 'walked']]);
  });
});

describe('a symlink that stays in the repo', () => {
  linked('keeps working: a doc, an image and a folder', async () => {
    put('docs/real.md', '# Real\n');
    put('assets/p.png', 'PNGDATA');
    put('shared/y.md', '# Y\n');
    put('docs/d.md', '# D\n\n![p](pic.png) [y](team/y.md)\n');
    fs.symlinkSync('real.md', path.join(repo, 'docs/alias.md'));
    fs.symlinkSync('../assets/p.png', path.join(repo, 'docs/pic.png'));
    fs.symlinkSync('../shared', path.join(repo, 'docs/team'));
    const res = await build(['docs']);
    expect(res.files).toEqual(expect.arrayContaining(['docs/alias.html', 'docs/pic.png', 'docs/team/y.html']));
    expect(fs.readFileSync(path.join(res.out, 'docs/pic.png'), 'utf8')).toBe('PNGDATA');
    expect(res.warnings).toEqual([]);
    expect(res.problems).toEqual([]);
  });

  linked('walks a real folder once, whichever way it is reached', () => {
    put('shared/y.md', '# Y\n');
    put('docs/d.md', '# D\n');
    fs.symlinkSync('../shared', path.join(repo, 'docs/team'));
    const all = repoReader(repo).walk('', (f) => f.endsWith('.md'));
    // by its own name: a link to a folder the walk reaches anyway is left to the folder, whatever the order
    expect(all.filter((f) => f.endsWith('y.md'))).toEqual(['shared/y.md']);
    expect(repoReader(repo).walk('docs', (f) => f.endsWith('.md'))).toEqual(['docs/d.md', 'docs/team/y.md']);
  });

  linked('is read once when two paths reach one folder, and a plain overlap is not a warning', async () => {
    put('docs/d.md', '# D\n');
    fs.symlinkSync('docs', path.join(repo, 'manual'));
    const out = await derive(['README.md', 'docs', 'manual', '.', 'docs']);
    expect(out.nodes.filter((n) => n.type === 'page').map((n) => n.file)).toEqual(['README.md', 'docs/d.md']);
    expect(out.warnings).toEqual(['docs: manual leads to a folder already read; it is not read again.']);
  });

  linked('counts the repo as inside when its own path is a link to it', async () => {
    put('docs/d.md', '# D\n\n![p](p.png) [r](../README.md)\n');
    put('docs/p.png', 'PNGDATA');
    fs.symlinkSync('repo', path.join(base, 'via'));
    const config = await loadConfig(path.join(base, 'via'), { env: {} });
    const res = await buildSite({ config, derivers: [{ deriver: docs, options: { paths: ['README.md', 'docs'] } }], out: path.join(base, 'site') });
    expect(res.files).toEqual(['.cornfield-site', 'docs/d.html', 'docs/p.png', 'index.html', 'map.html', 'site.css']);
    expect(res.warnings).toEqual([]);
    expect(res.problems).toEqual([]);
    expect(repoReader(path.join(base, 'via')).inside('docs/d.md')).toBe(true);
  });
});

describe('a folder beside the repo whose name starts with the repo\'s', () => {
  linked('is outside, by path and by symlink', async () => {
    put('o.md', `# Other\n\n${MARKER}\n`, path.join(base, 'repo-other'));
    fs.symlinkSync('../repo-other', path.join(repo, 'other'));
    put('docs/d.md', '# D\n\n[o](../other/o.md)\n');
    const io = repoReader(repo);
    expect(io.inside('../repo-other/o.md')).toBe(false);
    expect(io.inside('other/o.md')).toBe(false);
    expect(io.inside('other')).toBe(false);
    expect(io.walk('', () => true)).not.toContain('other/o.md');
    const res = await build(['README.md', 'docs', 'other', '../repo-other']);
    expect(res.problems).toEqual([
      'docs: "other" is outside the repo; only files and folders of the repo are read.',
      'docs: "../repo-other" is outside the repo; only files and folders of the repo are read.',
    ]);
    expect(res.warnings).toEqual(['docs: docs/d.md links to "../other/o.md", which leads outside the repo.']);
    for (const f of everything(res.out)) expect(fs.readFileSync(f, 'utf8')).not.toContain(MARKER);
  });
});

describe('a link to nothing', () => {
  linked('is left out with a warning, a loop of links too, and does not stop the build', async () => {
    put('docs/d.md', '# D\n\n[x](gone.md) [y](../README.md/x)\n');
    fs.symlinkSync('../outside/none.md', path.join(repo, 'docs/gone.md'));
    fs.symlinkSync('round.md', path.join(repo, 'docs/round.md'));
    const out = await derive(['README.md', 'docs']);
    expect(out.nodes.filter((n) => n.type === 'page').map((n) => n.file)).toEqual(['README.md', 'docs/d.md']);
    expect(out.warnings).toEqual(['docs: docs/gone.md is a link to nothing; it is not read.', 'docs: docs/round.md is a link to nothing; it is not read.']);
    // a link to something that is not there stays a broken link, which fails validate
    expect(out.problems).toEqual([
      'docs: docs/d.md links to "gone.md", but docs/gone.md is not in the repo.',
      'docs: docs/d.md links to "../README.md/x", but README.md/x is not in the repo.',
    ]);
  });
});

describe('a page and the files the site writes itself', () => {
  it('keeps a root map.md as a page of its own, beside the map', async () => {
    put('map.md', '# My map notes\n\nNOTES-BODY\n');
    put('docs/g.md', '# G\n\n[m](../map.md)\n');
    const res = await build(['README.md', 'map.md', 'docs']);
    const mapPage = fs.readFileSync(path.join(res.out, 'map.html'), 'utf8');
    expect(mapPage).toContain('Map of the docs');
    expect(mapPage).not.toContain('NOTES-BODY');
    expect(fs.readFileSync(path.join(res.out, 'map-doc.html'), 'utf8')).toContain('NOTES-BODY');
    // a link to it follows the page
    expect(fs.readFileSync(path.join(res.out, 'docs/g.html'), 'utf8')).toContain('href="../map-doc.html"');
    expect(res.warnings).toContain('docs: map.md would be page map.html, which the site writes itself; it is written to map-doc.html.');
  });

  it('keeps an index.md beside a README, and every page of a site with no clash where it was', async () => {
    put('docs/README.md', '# Docs home\n');
    put('docs/index.md', '# Index notes\n');
    put('docs/b.md', '# B\n');
    const res = await build(['README.md', 'docs']);
    expect(res.files.sort()).toEqual(['.cornfield-site', 'docs/b.html', 'docs/index-doc.html', 'docs/index.html', 'index.html', 'map.html', 'site.css']);
    expect(fs.readFileSync(path.join(res.out, 'docs/index.html'), 'utf8')).toContain('Docs home');
    expect(res.warnings.join('\n')).toContain('docs/index.md would be page docs/index.html, which docs/README.md has');
  });

  it('leaves a name alone when nothing is in its way', async () => {
    put('docs/map-notes.md', '# M\n');
    put('docs/site.css.md', '# S\n');
    const res = await build(['README.md', 'docs']);
    expect(res.files).toEqual(expect.arrayContaining(['docs/map-notes.html', 'docs/site.css.html']));
    expect(res.warnings).toEqual([]);
  });
});
