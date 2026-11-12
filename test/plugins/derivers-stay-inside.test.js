/**
 * @vitest-environment node
 *
 * No deriver reads outside the repo (core/repo.js, every plugin under plugins/): not through a symlink, not through a
 * path in config, not through the starter's own walk; a config path that leaves the repo is a problem `validate` fails
 * on; a folder reached through a symlink that stays in the repo gives nodes `validate` accepts. Real symlinks on disk,
 * in a temporary folder, skipped only where the machine cannot make one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import starter from '../../plugins/starter/index.js';
import compose from '../../plugins/compose/index.js';
import cloud from '../../plugins/cloud/index.js';
import openapi from '../../plugins/openapi/index.js';
import world from '../../plugins/world/index.js';
import docs from '../../plugins/docs/index.js';
import { deriveTopology } from '../../core/derive.js';
import { repoReader, leavesRepo, outsideProblem, reachable } from '../../core/repo.js';
import { missingPaths } from '../../core/sync.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'cornfield.js');
const MARKER = 'OUTSIDE-MARKER-c41e9b';
const HOST = 'outside-marker-c41e9b.io';

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
const derive = (derivers, root = repo) => deriveTopology({ root, config: { title: 'T' }, derivers });
const noMarker = (value) => { const text = JSON.stringify(value); expect(text).not.toContain(MARKER); expect(text).not.toContain(HOST); expect(text).not.toContain('outside-marker'); };
const cli = (command, root = repo) => spawnSync(process.execPath, [CLI, command, '--repo', root], { encoding: 'utf8' });

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-inside-'));
  repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  put('m.py', `${MARKER} = 1\n`, outside());
  put('Caddyfile', `${HOST} {\n  reverse_proxy app:80\n}\n`, outside());
  put('page.html', `<script src="https://${HOST}/x.js"></script>\n`, outside());
  put('openapi.json', JSON.stringify({ openapi: '3.0.0', info: { title: MARKER }, paths: { '/leak': { get: {} } } }), outside());
  put('world.json', JSON.stringify({ version: 1, hosts: { [HOST]: {} } }), outside());
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('the repo reader', () => {
  it('refuses a path that climbs out with ..', () => {
    const io = repoReader(repo);
    expect(io.exists('../outside/m.py')).toBe(false);
    expect(io.isDir('../outside')).toBe(false);
    expect(io.list('../outside')).toEqual([]);
    expect(() => io.read('../outside/m.py')).toThrow(/is outside the repo/);
    expect(() => io.read('../outside/m.py')).not.toThrow(new RegExp(MARKER));
  });

  linked('refuses a symlink to a file or a folder outside, and a file reached through one', () => {
    fs.symlinkSync(outside('m.py'), path.join(repo, 'f.py'));
    fs.symlinkSync(outside(), path.join(repo, 'dir'));
    const io = repoReader(repo);
    expect(io.exists('f.py')).toBe(false);
    expect(io.exists('dir')).toBe(false);
    expect(io.exists('dir/m.py')).toBe(false);
    expect(io.isDir('dir')).toBe(false);
    expect(io.list('dir')).toEqual([]);
    expect(() => io.read('f.py')).toThrow(/is outside the repo/);
    expect(() => io.read('dir/m.py')).toThrow(/is outside the repo/);
  });

  linked('does not take /x/repo-other for a folder of /x/repo', () => {
    put('o.txt', MARKER, path.join(base, 'repo-other'));
    fs.symlinkSync(path.join(base, 'repo-other'), path.join(repo, 'sib'));
    const io = repoReader(repo);
    expect(io.exists('sib/o.txt')).toBe(false);
    expect(io.inside('sib/o.txt')).toBe(false);
    expect(io.inside('../repo-other/o.txt')).toBe(false);
    expect(io.walk('', () => true)).toEqual([]);
  });

  linked('refuses a link out written with a trailing slash, and keeps ./ for the root', () => {
    fs.symlinkSync(outside(), path.join(repo, 'dir'));
    put('a.txt', 'a\n');
    const io = repoReader(repo);
    for (const p of ['dir/', 'dir//', 'dir/.', './dir/']) {
      expect(io.exists(p)).toBe(false);
      expect(io.isDir(p)).toBe(false);
      expect(io.list(p)).toEqual([]);
    }
    expect(io.list('./')).toEqual(['a.txt', 'dir']);
    expect(io.isDir('./')).toBe(true);
  });

  linked('does not take a path a caller adds to what walk gave it for a file the walk found', () => {
    put('src/a.js', 'a\n');
    fs.symlinkSync(outside('m.py'), path.join(repo, 'f.py'));
    const io = repoReader(repo);
    const found = io.walk('src');
    found.push('f.py', '../outside/m.py');
    expect(io.read('src/a.js')).toBe('a\n');
    expect(() => io.read('f.py')).toThrow(/is outside the repo/);
    expect(() => io.read('../outside/m.py')).toThrow(/is outside the repo/);
  });

  linked('works on a repo reached through a symlink, and on links that stay inside', () => {
    put('real/a/x.txt', 'ok\n');
    fs.symlinkSync('real/a', path.join(repo, 'in'));
    fs.symlinkSync('real/a/x.txt', path.join(repo, 'x.txt'));
    const door = path.join(base, 'door');
    fs.symlinkSync(repo, door);
    for (const root of [repo, door]) {
      const io = repoReader(root);
      expect(io.read('in/x.txt')).toBe('ok\n');
      expect(io.read('x.txt')).toBe('ok\n');
      expect(io.exists('in')).toBe(true);
      expect(io.isDir('in')).toBe(true);
      expect(io.list('in')).toEqual(['x.txt']);
      expect(io.inside('in/x.txt')).toBe(true);
    }
  });
});

describe('the starter deriver\'s own walk', () => {
  const py = () => { put('svc/pyproject.toml', '[project]\nname = "svc"\n'); put('svc/app/m.py', 'x = 1\n'); };
  const files = (res) => res.nodes.filter((n) => n.type === 'core').map((n) => n.file);
  const run = (options = {}) => derive([{ deriver: starter, options: { packages: ['svc'], modules: true, ...options } }]);

  linked('does not follow a loop of links', async () => {
    py();
    fs.symlinkSync('..', path.join(repo, 'svc/app/loop'));
    expect(files(await run())).toEqual(['svc/app/m.py']);
  });

  linked('does not follow a link out of the repo', async () => {
    py();
    fs.symlinkSync(outside(), path.join(repo, 'svc/app/out'));
    fs.symlinkSync(outside('m.py'), path.join(repo, 'svc/app/o.py'));
    const res = await run();
    expect(files(res)).toEqual(['svc/app/m.py']);
    noMarker(res);
  });

  linked('follows a link that stays in the repo, once', async () => {
    py();
    put('common/c.py', 'y = 2\n');
    fs.symlinkSync('../../common', path.join(repo, 'svc/app/common'));
    fs.symlinkSync('.', path.join(repo, 'svc/app/self')); // to a folder the walk is in
    expect(files(await run())).toEqual(['svc/app/common/c.py', 'svc/app/m.py']);
  });

  it('still leaves out the folders a language prunes', async () => {
    py();
    put('svc/.venv/lib/v.py', 'z = 3\n');
    put('svc/app/__pycache__/p.py', 'z = 3\n');
    put('svc/pkg.egg-info/e.py', 'z = 3\n');
    expect(files(await run())).toEqual(['svc/app/m.py']);
  });
});

describe('a config path that leaves the repo', () => {
  const outsideWritten = (who, p) => `${who}: ${JSON.stringify(p)} is outside the repo; only files and folders of the repo are read.`;
  const stack = () => put('compose.yml', 'services:\n  app:\n    image: x\n');
  const same = (p, who) => expect(outsideProblem(who, p)).toBe(outsideWritten(who, p));

  it('is the docs deriver\'s wording, from one helper', async () => {
    same('../x', 'docs');
    expect((await derive([{ deriver: docs, options: { paths: ['../outside'] } }])).problems).toEqual([outsideWritten('docs', '../outside')]);
    expect(leavesRepo({ inside: () => true }, '../a')).toBe(true);
    expect(leavesRepo({ inside: () => true }, 'a/../b')).toBe(false);
    expect(leavesRepo({ inside: () => true }, '/etc')).toBe(true);
  });

  it('is refused by compose: caddyfiles and files', async () => {
    stack();
    for (const p of ['../outside/Caddyfile', outside('Caddyfile'), 'a/../../outside/Caddyfile']) {
      const res = await derive([{ deriver: compose, options: { caddyfiles: [p] } }]);
      expect(res.problems).toEqual([outsideWritten('compose', p)]);
      expect(res.nodes.map((n) => n.id)).not.toContain('app-outside-marker-c41e9b.io');
      noMarker(res);
    }
    const res = await derive([{ deriver: compose, options: { files: ['compose.yml', '../outside/Caddyfile'] } }]);
    expect(res.problems).toEqual([outsideWritten('compose', '../outside/Caddyfile')]);
    expect(res.nodes.some((n) => n.type === 'stack')).toBe(true);
  });

  it('is refused by starter: packages', async () => {
    put('src/a.js', 'export const a = 1;\n');
    put('p/q.py', 'x = 1\n', outside());
    put('p/pyproject.toml', `[project]\nname = "${MARKER}"\n`, outside());
    for (const p of ['../outside/p', outside('p'), '../outside/*']) {
      const res = await derive([{ deriver: starter, options: { packages: ['src', p], modules: true } }]);
      expect(res.problems).toEqual([outsideWritten('starter', p)]);
      expect(res.nodes.filter((n) => n.type === 'pkg').map((n) => n.file)).toEqual(['src']);
      noMarker(res);
    }
  });

  it('is refused by cloud: code and caddyfiles', async () => {
    put('topology.cloud.json', JSON.stringify({ version: 1, services: [{ id: 'leak', label: 'Leak', roles: ['runtime'], desc: 'd', breaks: 'b', plan: { tier: 'free' }, match: { hosts: [HOST] }, uses: [{ from: 'root', label: 'x', why: 'w' }] }] }));
    put('src/a.js', 'export const a = 1;\n');
    const starterDeriver = { deriver: starter, options: { packages: ['src'] } };
    for (const options of [{ code: ['../outside', 'src'] }, { code: [outside()] }, { caddyfiles: [{ file: '../outside/Caddyfile', from: 'root' }] }]) {
      const res = await derive([starterDeriver, { deriver: cloud, options }]);
      const written = options.code ? options.code.find((c) => c !== 'src') : options.caddyfiles[0].file;
      expect(res.problems).toEqual([outsideWritten('cloud', written)]);
      noMarker(res);
    }
  });

  it('is refused by openapi: file and specs', async () => {
    for (const options of [{ file: '../outside/openapi.json' }, { specs: [{ file: outside('openapi.json'), app: 'app-leak' }] }]) {
      const res = await derive([{ deriver: openapi, options }]);
      expect(res.problems).toEqual([outsideWritten('openapi', options.file || options.specs[0].file)]);
      expect(res.nodes).toEqual([]);
      noMarker(res);
    }
  });

  linked('is a warning for a CI workflow file that links out, and the sync goes on', async () => {
    put('src/a.js', 'export const a = 1;\n');
    fs.mkdirSync(path.join(repo, '.github/workflows'), { recursive: true });
    fs.symlinkSync(outside('Caddyfile'), path.join(repo, '.github/workflows/out.yml'));
    fs.symlinkSync('gone.yml', path.join(repo, '.github/workflows/none.yml'));
    const res = await derive([{ deriver: starter, options: { packages: ['src'] } }, { deriver: cloud, options: {} }]);
    expect(res.warnings).toContain('cloud: .github/workflows/out.yml is a link to somewhere outside the repo; it is not read.');
    expect(res.warnings).toContain('cloud: .github/workflows/none.yml is a link to nothing; it is not read.');
    noMarker(res);
  });

  it('is refused by world: file', async () => {
    const res = await derive([{ deriver: world, options: { file: '../outside/world.json' } }]);
    expect(res.problems).toEqual([outsideWritten('world', '../outside/world.json')]);
    expect(res.nodes).toEqual([]);
    noMarker(res);
  });

  linked('is refused when a symlink on its way leads out', async () => {
    stack();
    fs.symlinkSync(outside(), path.join(repo, 'ext'));
    const res = await derive([{ deriver: compose, options: { caddyfiles: ['ext/Caddyfile'] } }]);
    expect(res.problems).toEqual([outsideWritten('compose', 'ext/Caddyfile')]);
    noMarker(res);
  });

  it('prints the path as a JSON string and never where it leads or what is there', async () => {
    stack();
    const odd = '../outside/Caddyfile\n"evil"';
    const res = await derive([{ deriver: compose, options: { caddyfiles: [odd] } }]);
    expect(res.problems).toEqual([`compose: ${JSON.stringify(odd)} is outside the repo; only files and folders of the repo are read.`]);
    expect(res.problems[0]).not.toContain('\n');
    expect(res.problems.join()).not.toContain(base);
  });

  it('makes validate fail, and sync still writes the map', () => {
    put('cornfield.config.js', "export default { derivers: [{ use: 'compose', options: { caddyfiles: ['../outside/Caddyfile'] } }] };\n");
    put('compose.yml', 'services:\n  app:\n    image: x\n');
    const sync = cli('sync');
    const validate = cli('validate');
    expect(validate.status).not.toBe(0);
    expect(validate.stdout + validate.stderr).toContain('compose: "../outside/Caddyfile" is outside the repo; only files and folders of the repo are read.');
    expect(validate.stdout + validate.stderr).not.toContain(base);
    expect(fs.readFileSync(path.join(repo, 'topology.json'), 'utf8')).not.toContain(HOST);
  });
});

describe('a symlink that stays in the repo', () => {
  const link = (target, at) => { fs.mkdirSync(path.dirname(path.join(repo, at)), { recursive: true }); fs.symlinkSync(target, path.join(repo, at)); };

  linked('still works for every deriver that reads a file or walks a folder', async () => {
    put('shared/compose.yml', 'services:\n  web:\n    image: x\n');
    put('shared/Caddyfile', 'site.example.com {\n  reverse_proxy web:80\n}\n');
    put('shared/api.json', JSON.stringify({ openapi: '3.0.0', info: { title: 'Api' }, paths: { '/ping': { get: {} } } }));
    put('shared/world.json', JSON.stringify({ version: 1, hosts: { 'box-1': {} } }));
    put('shared/m.js', "export const m = () => fetch('https://cdn.in-repo-marker.io/x');\n");
    put('topology.cloud.json', JSON.stringify({ version: 1, services: [{ id: 'cdn', label: 'Cdn', roles: ['runtime'], desc: 'd', breaks: 'b', plan: { tier: 'free' }, match: { hosts: ['cdn.in-repo-marker.io'] } }] }));
    for (const name of ['compose.yml', 'Caddyfile', 'api.json', 'world.json']) link(`../shared/${name}`, `app/${name}`);
    link('../shared', 'app/lib');

    const c = await derive([{ deriver: compose, options: { files: ['app/compose.yml'], caddyfiles: ['app/Caddyfile'] } }]);
    expect(c.problems).toEqual([]);
    expect(c.nodes.map((n) => n.type).sort()).toEqual(['app', 'container', 'stack']);

    const o = await derive([{ deriver: openapi, options: { file: 'app/api.json' } }]);
    expect(o.problems).toEqual([]);
    expect(o.nodes.map((n) => n.label)).toContain('/ping');

    const w = await derive([{ deriver: world, options: { file: 'app/world.json' } }]);
    expect(w.problems).toEqual([]);
    expect(w.nodes.map((n) => n.type)).toEqual(['machine']);

    const st = await derive([{ deriver: starter, options: { packages: ['app'], modules: true } }, { deriver: cloud, options: { code: ['app'] } }]);
    expect(st.problems).toEqual([]);
    expect(st.nodes.filter((n) => n.type === 'core').map((n) => n.file)).toEqual(['app/lib/m.js']);
    expect(st.nodes.some((n) => n.type === 'external')).toBe(true);
  });
});

describe('a page from a symlinked folder that stays in the repo', () => {
  const setup = () => {
    put('README.md', '# Home\n');
    put('shared/y.md', '# Y\n');
    put('docs/a.md', '# A\n');
    put('cornfield.config.js', "export default { derivers: [{ use: 'docs', options: { paths: ['README.md', 'docs'] } }] };\n");
    fs.symlinkSync('../shared', path.join(repo, 'docs/team'));
  };

  linked('is accepted by validate', () => {
    setup();
    const sync = cli('sync');
    expect(sync.status).toBe(0);
    expect(fs.readFileSync(path.join(repo, 'topology.json'), 'utf8')).toContain('"docs/team/y.md"');
    const validate = cli('validate');
    expect(validate.stdout + validate.stderr).not.toContain('is not in the repo');
    expect(validate.status).toBe(0);
  });

  it('is no help to a node file in a repo without links: validate holds it to the repo\'s own paths', () => {
    put('docs/a.md', '# A\n');
    put('README.md', '# R\n');
    const io = repoReader(repo);
    const files = ['.', './', 'docs/', 'docs//a.md', './docs/a.md', 'docs/./a.md', 'docs/a.md/', 'README.md/x', 'node_modules', 'a\u0000b'];
    const errors = missingPaths({ nodes: files.map((file, i) => ({ id: `n${i}`, file })), edges: [] }, new Set(['docs', 'docs/a.md', 'README.md']), reachable(io));
    expect(errors).toHaveLength(files.length);
  });

  linked('keeps validate from reading the cloud or personas file through a link out', () => {
    put('README.md', '# R\n');
    put('cornfield.config.js', "export default { derivers: ['docs', 'personas', 'cloud'] };\n");
    put('topology.cloud.json', JSON.stringify({ version: 1, services: [{ id: MARKER.toLowerCase(), label: MARKER, roles: ['runtime'], desc: MARKER, breaks: 'b', plan: { tier: 'free' }, match: { hosts: [HOST] } }] }), outside());
    put('topology.personas.json', JSON.stringify({ version: 1, personas: [{ id: 'p', label: MARKER, role: MARKER }] }), outside());
    fs.symlinkSync(outside('topology.cloud.json'), path.join(repo, 'topology.cloud.json'));
    fs.symlinkSync(outside('topology.personas.json'), path.join(repo, 'topology.personas.json'));
    const sync = cli('sync');
    const validate = cli('validate');
    expect(sync.status).toBe(0);
    expect(validate.status).toBe(0);
    for (const out of [sync.stdout, sync.stderr, validate.stdout, validate.stderr, fs.readFileSync(path.join(repo, 'topology.json'), 'utf8')]) {
      expect(out).not.toContain(MARKER);
      expect(out).not.toContain('outside-marker');
    }
  });

  linked('still fails validate for a node file that is gone, or that a link takes out of the repo', () => {
    const topology = { nodes: [{ id: 'a', file: 'docs/team/gone.md' }, { id: 'b', file: 'ext/m.py' }, { id: 'c', file: '../outside/m.py' }, { id: 'd', file: 'docs/team/y.md' }, { id: 'e', file: 'docs/team/../../outside/m.py' }], edges: [] };
    put('shared/y.md', '# Y\n');
    fs.mkdirSync(path.join(repo, 'docs'));
    fs.symlinkSync('../shared', path.join(repo, 'docs/team'));
    fs.symlinkSync(outside(), path.join(repo, 'ext'));
    const io = repoReader(repo);
    const errors = missingPaths(topology, new Set(['shared', 'shared/y.md', 'docs', 'docs/team', 'ext']), reachable(io));
    expect(errors.map((e) => /Node "(\w)"/.exec(e)[1])).toEqual(['a', 'b', 'c', 'e']);
  });
});
