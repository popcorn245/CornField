/**
 * @vitest-environment node
 *
 * What `validate` and `sync` read from the repo goes through the repo reader (core/repo.js): a proposal, a mockup, the
 * map or a package.json that is a link out of the repo is not read, and no message quotes from it. A config value that
 * names a folder where a file is wanted, or one place twice, is a problem (or read once), not a crash. `sync` writes the
 * map only where it really lies in the repo, and a FIFO is not waited on. A config path a message prints is quoted, so a
 * line break in it cannot forge a line. Real symlinks on disk, in a temporary folder, skipped only where the machine
 * cannot make one.
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
import { deriveTopology } from '../../core/derive.js';
import { loadConfig } from '../../core/config.js';
import { outsideError, eachPlaceOnce } from '../../core/repo.js';
import { quote } from '../../core/text.js';
import { readTopology, validateProposalFiles } from '../../core/validate.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'cornfield.js');
const MARKER = 'OUTSIDE-MARKER-7f3a1d';
/** What of the marker would show: a JSON parse error quotes only the first characters of a token */
const SEEN = MARKER.slice(0, 8);

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
const link = (target, at) => { fs.mkdirSync(path.dirname(path.join(repo, at)), { recursive: true }); fs.symlinkSync(target, path.join(repo, at)); };
const derive = (derivers) => deriveTopology({ root: repo, config: { title: 'T' }, derivers });
const cli = (command, root = repo) => spawnSync(process.execPath, [CLI, command, '--repo', root], { encoding: 'utf8' });
const said = (run) => run.stdout + run.stderr;
const PROPOSALS = 'docs/specs/proposals';
const map = { version: '1.0.0', nodes: [{ id: 'root', type: 'root', label: 'T' }], edges: [] };

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-vreads-'));
  repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  put('broken.json', `{ "title": ${MARKER}`, outside());
  put('mock.html', `<p>${MARKER}</p>`, outside());
  put('topology.json', JSON.stringify({ ...map, nodes: [{ id: 'root', type: 'root', label: MARKER }] }), outside());
  put('package.json', JSON.stringify({ name: MARKER }), outside());
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('validate reads proposals through the repo reader', () => {
  linked('does not read a proposal file that is a link out, and quotes nothing from it', () => {
    link(outside('broken.json'), `${PROPOSALS}/a.json`);
    const problems = validateProposalFiles(map, path.join(repo, PROPOSALS), repo);
    expect(problems).toEqual([`${PROPOSALS}/a.json is not valid JSON: "${PROPOSALS}/a.json" is outside the repo.`]);
    expect(problems.join()).not.toContain(SEEN);
    expect(problems.join()).not.toContain(base);
  });

  linked('does not read one through a chain of links, a link to a folder, or a folder whose name only starts like the repo', () => {
    put('broken.json', `{ "title": ${MARKER}`, path.join(base, 'repo-other'));
    link(outside('broken.json'), 'l/hop');
    link('../../../l/hop', `${PROPOSALS}/a.json`);
    link(outside(), `${PROPOSALS}/b.json`);
    link(path.join(base, 'repo-other', 'broken.json'), `${PROPOSALS}/c.json`);
    const problems = validateProposalFiles(map, path.join(repo, PROPOSALS), repo);
    expect(problems).toEqual(['a', 'b', 'c'].map((n) => `${PROPOSALS}/${n}.json is not valid JSON: "${PROPOSALS}/${n}.json" is outside the repo.`));
  });

  linked('does not take a mockup that is a link out for a file beside the proposal', () => {
    put(`${PROPOSALS}/p.json`, JSON.stringify({ mockups: [{ node: 'root', path: 'm.html', title: 'M' }, { node: 'root', path: 'n.html', title: 'N' }] }));
    put(`${PROPOSALS}/n.html`, '<p>mine</p>');
    link(outside('mock.html'), `${PROPOSALS}/m.html`);
    const problems = validateProposalFiles(map, path.join(repo, PROPOSALS), repo).filter((p) => p.includes('.path:'));
    expect(problems).toEqual([`${PROPOSALS}/p.json: mockups[0].path: "m.html" is not a file in ${PROPOSALS}.`]);
  });

  linked('refuses a proposals folder that is a link out, and names it as written', () => {
    put('x.json', `{ ${MARKER}`, outside('props'));
    link(outside('props'), PROPOSALS);
    const problems = validateProposalFiles(map, path.join(repo, PROPOSALS), repo);
    expect(problems).toEqual([`proposals: "${PROPOSALS}" is outside the repo; only files and folders of the repo are read.`]);
  });

  linked('keeps the whole of validate from printing a line of an outside proposal', () => {
    put('package.json', '{"name":"t","type":"module"}');
    put('src/a.js', 'export const a = 1;\n');
    expect(cli('sync').status).toBe(0);
    link(outside('broken.json'), `${PROPOSALS}/a.json`);
    const run = cli('validate');
    expect(run.status).toBe(1);
    expect(said(run)).toContain(`${PROPOSALS}/a.json is not valid JSON`);
    expect(said(run)).not.toContain(SEEN);
    expect(said(run)).not.toContain(base);
  });

  it('says what it said for a proposal that is a plain file', () => {
    put(`${PROPOSALS}/a.json`, '{ "title": nope');
    put(`${PROPOSALS}/b.json`, '[]');
    put(`${PROPOSALS}/c.json`, JSON.stringify({ mockups: [{ node: 'root', path: 'gone.html', title: 'G' }] }));
    const problems = validateProposalFiles(map, path.join(repo, PROPOSALS), repo);
    expect(problems.filter((p) => p.startsWith(`${PROPOSALS}/a.json`))).toEqual([expect.stringMatching(new RegExp(`^${PROPOSALS}/a.json is not valid JSON: Unexpected token`))]);
    expect(problems).toContain(`${PROPOSALS}/b.json: (file): A proposal is a JSON object.`);
    expect(problems).toContain(`${PROPOSALS}/c.json: mockups[0].path: "gone.html" is not a file in ${PROPOSALS}.`);
    expect(validateProposalFiles(map, path.join(repo, 'no-such'), repo)).toEqual([]);
  });
});

describe('the map and the config are read through the repo reader', () => {
  linked('does not read a map that is a link out: readTopology refuses it, and sync does not write through it', () => {
    link(outside('topology.json'), 'topology.json');
    let error;
    try { readTopology({ root: repo, topology: 'topology.json' }); } catch (err) { error = err; }
    expect(error.message).toBe('"topology.json" is outside the repo.');
    expect(error.message).not.toContain(SEEN);
    const before = fs.readFileSync(outside('topology.json'), 'utf8');
    const sync = cli('sync');
    expect(sync.status).toBe(1);
    expect(said(sync)).not.toContain(SEEN);
    expect(said(sync)).not.toContain(base);
    expect(fs.readFileSync(outside('topology.json'), 'utf8')).toBe(before);
  });

  it('reads a real map as it did, and says null for none', () => {
    expect(readTopology({ root: repo, topology: 'topology.json' })).toBeNull();
    put('topology.json', JSON.stringify(map));
    expect(readTopology({ root: repo, topology: 'topology.json' })).toEqual(map);
    put('topology.json', '{ "nodes": [');
    expect(() => readTopology({ root: repo, topology: 'topology.json' })).toThrow(SyntaxError);
  });

  linked('does not take the name from a package.json that is a link out', async () => {
    link(outside('package.json'), 'package.json');
    const config = await loadConfig(repo, { env: {} });
    expect(config.title).toBe(path.basename(repo));
    expect(config.title).not.toContain(SEEN);
    put('src/a.js', 'export const a = 1;\n');
    const sync = cli('sync');
    expect(said(sync)).not.toContain(SEEN);
    expect(fs.readFileSync(path.join(repo, 'topology.json'), 'utf8')).not.toContain(SEEN);
  });
});

describe('sync writes the map only where it really lies in the repo', () => {
  const code = () => { put('package.json', '{"name":"t","type":"module"}'); put('src/a.js', 'export const a = 1;\n'); };

  linked('does not make a file through a map that is a link to nothing outside the repo', () => {
    code();
    link(outside('new.json'), 'topology.json');
    const sync = cli('sync');
    expect(sync.status).toBe(1);
    expect(sync.stderr).toContain('"topology.json" leads outside the repo or to nothing; the map is not written.');
    expect(said(sync)).not.toContain(base);
    expect(fs.existsSync(outside('new.json'))).toBe(false);
  });

  linked('writes through a map that is a link inside the repo, as before', () => {
    code();
    put('maps/topology.json', JSON.stringify(map));
    link('maps/topology.json', 'topology.json');
    expect(cli('sync').status).toBe(0);
    expect(fs.lstatSync(path.join(repo, 'topology.json')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(repo, 'maps/topology.json'), 'utf8')).nodes.map((n) => n.id)).toContain('pkg-src');
    expect(cli('validate').status).toBe(0);
  });

  linked('works on a repo reached through a symlink, as before', () => {
    code();
    fs.symlinkSync(repo, path.join(base, 'alias'));
    const alias = path.join(base, 'alias');
    expect(cli('sync', alias).status).toBe(0);
    expect(cli('validate', alias).status).toBe(0);
    expect(cli('status', alias).status).toBe(0);
  });
});

describe('a FIFO where a file is wanted is not waited on', () => {
  const fifo = (rel) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); return spawnSync('mkfifo', [path.join(repo, rel)]).status === 0; };

  it('is not read as a proposal or as the map', () => {
    if (!fifo(`${PROPOSALS}/a.json`)) return; // a machine without mkfifo has no FIFO to wait on
    expect(validateProposalFiles(map, path.join(repo, PROPOSALS), repo)).toEqual([`${PROPOSALS}/a.json is not valid JSON: "${PROPOSALS}/a.json" is not a file.`]);
    fifo('topology.json');
    expect(() => readTopology({ root: repo, topology: 'topology.json' })).toThrow('"topology.json" is not a file.');
    const run = spawnSync(process.execPath, [CLI, 'sync', '--repo', repo], { encoding: 'utf8', timeout: 20000 });
    expect(run.signal).toBeNull();
    expect(run.status).toBe(1);
  });
});

describe('a folder where a file is wanted', () => {
  const stack = () => { put('compose.yml', 'services:\n  web:\n    image: nginx\n'); put('src/Caddyfile', 'x.test {\n  reverse_proxy web:80\n}\n'); put('world.json', JSON.stringify({ version: 1, hosts: { s1: {} } })); };
  const options = [
    ['compose', compose, 'files', (v) => ({ files: [v] })],
    ['compose', compose, 'caddyfiles', (v) => ({ caddyfiles: [v] })],
    ['openapi', openapi, 'file', (v) => ({ file: v })],
    ['openapi', openapi, 'specs[].file', (v) => ({ specs: [{ file: v }] })],
    ['world', world, 'file', (v) => ({ file: v })],
    ['cloud', cloud, 'caddyfiles[].file', (v) => ({ caddyfiles: [{ file: v, from: 'root' }] })],
  ];
  for (const [who, deriver, option, make] of options) {
    for (const value of ['.', '', 'src', 'src/'].filter((v) => !(who === 'world' && v === ''))) { // world takes '' for its default file
      it(`is a problem for ${who} ${option} ${JSON.stringify(value)}, not a crash`, async () => {
        stack();
        const run = await derive([{ deriver, options: make(value) }]);
        expect(run.problems).toEqual([`${who}: options.${option} ${JSON.stringify(value)} is a folder, not a file.`]);
      });
    }
  }

  it('fails validate and leaves sync to finish', () => {
    stack();
    put('cornfield.config.js', "export default { derivers: [{ use: 'compose', options: { caddyfiles: ['src/'] } }] };\n");
    const sync = cli('sync');
    expect(sync.status).toBe(0);
    expect(said(sync)).not.toContain('EISDIR');
    const validate = cli('validate');
    expect(validate.status).toBe(1);
    expect(said(validate)).toContain('compose: options.caddyfiles "src/" is a folder, not a file.');
  });
});

describe('one place named twice', () => {
  it('is one package for the starter, however it is spelled', async () => {
    put('package.json', '{"name":"t"}');
    put('a/index.js', 'export const a = 1;\n');
    for (const packages of [['', '.'], ['.', ''], ['a', './a', 'a/', 'a/../a', './a/.'], ['a', 'a']]) {
      const run = await derive([{ deriver: starter, options: { packages } }]);
      expect(run.problems).toEqual([]);
      const pkgs = run.nodes.filter((n) => n.type === 'pkg');
      expect(pkgs).toHaveLength(1);
    }
  });

  it('is read once by compose, a stack and a route each', async () => {
    put('a/compose.yml', 'services:\n  web:\n    image: nginx\n');
    put('a/Caddyfile', 'x.test {\n  reverse_proxy web:80\n}\n');
    const run = await derive([{ deriver: compose, options: { files: ['a/compose.yml', './a/compose.yml'], caddyfiles: ['a/Caddyfile', './a/Caddyfile', 'a/Caddyfile'] } }]);
    expect(run.nodes.filter((n) => n.type === 'stack')).toHaveLength(1);
    const edge = run.edges.find((e) => e.kind === 'runs-on');
    expect(edge.mappings).toHaveLength(1);
  });

  it('is told apart from two places', () => {
    expect(eachPlaceOnce(['a', 'b', './a', 'b/'])).toEqual(['a', 'b']);
    expect(eachPlaceOnce(['', '.', './'])).toEqual(['']);
    expect(eachPlaceOnce(['a/b', 'a//b', 'a/c'])).toEqual(['a/b', 'a/c']);
    expect(eachPlaceOnce([{ file: 'a' }, { file: './a' }, { file: 'b' }], (e) => e.file)).toEqual([{ file: 'a' }, { file: 'b' }]);
  });
});

describe('a path a message prints', () => {
  const ODD = 'x\n  - forged: a line of its own\u001b[31m\u009b\u202e';
  const SAID = '"x\\n  - forged: a line of its own\\u001b[31m\\u009b\\u202e"';

  it('is one helper: JSON, with the controls JSON leaves alone written too', () => {
    expect(quote('a/b')).toBe('"a/b"');
    expect(quote(ODD)).toBe(SAID);
    expect(quote(2)).toBe('2');
    expect(outsideError('a\nb').message).toBe('"a\\nb" is outside the repo.');
  });

  it('leaves the letters of any script, emoji and a non-breaking space as they are', () => {
    for (const name of ['docs/\u0645\u0644\u0641.md', 'docs/\u05e7\u05d5\u05d1\u05e5.md', 'docs/caf\u00e9/na\u00efve.md', 'docs/e\u0301te\u0301.md', 'docs/\u65e5\u672c\u8a9e.md', 'docs/\u{1f33d}.md', 'docs/a\u00a0b.md']) expect(quote(name)).toBe(`"${name}"`);
    expect(quote('a\u2067b\u2069')).toBe('"a\\u2067b\\u2069"'); // a bidirectional isolate is not a letter
  });

  it('keeps a compose file or an API description from forging a line', async () => {
    put('compose.yml', 'services:\n  web:\n    image: nginx\n');
    await expect(derive([{ deriver: compose, options: { files: [ODD] } }])).rejects.toThrow(`compose file ${SAID} does not exist.`);
    await expect(derive([{ deriver: openapi, options: { file: ODD } }])).rejects.toThrow(`API description ${SAID} does not exist.`);
    const run = await derive([{ deriver: compose, options: { caddyfiles: [ODD] } }]);
    expect(run.warnings).toContain(`compose: caddyfile ${SAID} does not exist.`);
    for (const m of run.warnings) expect(m).not.toMatch(/[\n\u001b\u009b\u202e]/);
  });

  it('keeps a parse error that spans lines on its lines: the snippet and its caret are the tool\'s own', async () => {
    put('compose.yml', 'services:\n  web:\n  - [broken\n  image: x\n');
    const error = await derive([{ deriver: compose, options: {} }]).catch((err) => err);
    expect(error.message).toMatch(/compose.yml is not valid YAML: .*\n\n 1 \| services:\n/);
  });
});
