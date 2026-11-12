/**
 * @vitest-environment node
 *
 * The server's file routes judge a file by where it really is (server/files.js `inside`): a symlink in the repo that leads outside it
 * is a plain 404, the same as a file that is not there, and says nothing of where it leads. Real links in the test's own temporary
 * folder; the outside file holds a made-up marker that no response may contain.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
// @ts-expect-error plain JS modules, no declarations
import { createCornfieldServer } from '../../server/server.js';
// @ts-expect-error plain JS modules, no declarations
import { inside, isUnder, listProposalFiles, readMap, readPlain } from '../../server/files.js';
// @ts-expect-error plain JS modules, no declarations
import { loadConfig } from '../../core/config.js';
import { CORNFIELD, freePort } from '../helpers.js';

const MARK = 'OUTSIDE-MARKER-4c81d0e7';
const MAP = JSON.stringify({ nodes: [], edges: [], note: MARK });
const SCRIPT = `export const note = '${MARK}';`;

/** Whether this machine can make a symlink at all (Windows without the right may not) */
const canLink = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-canlink-'));
  try { fs.writeFileSync(path.join(d, 'a'), ''); fs.symlinkSync(path.join(d, 'a'), path.join(d, 'b')); return true; } catch { return false; } finally { fs.rmSync(d, { recursive: true, force: true }); }
})();

function ask(port, target, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const made = [];
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

/** A fresh folder holding `repo/`, `repo-other/` (a sibling whose name starts with the repo's) and `outside/`, each with a marker file */
function world() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cf-real-')));
  made.push(base);
  for (const d of ['repo/web', 'repo-other', 'outside']) fs.mkdirSync(path.join(base, d), { recursive: true });
  for (const d of ['repo-other', 'outside']) { fs.writeFileSync(path.join(base, d, 'x.json'), MAP); fs.writeFileSync(path.join(base, d, 'x.js'), SCRIPT); fs.writeFileSync(path.join(base, d, 'x.css'), `a{} /* ${MARK} */`); }
  fs.writeFileSync(path.join(base, 'repo/web/live.js'), 'export const create = () => ({});');
  fs.writeFileSync(path.join(base, 'repo/topology.json'), JSON.stringify({ nodes: [], edges: [], note: 'inside' }));
  return { base, repo: path.join(base, 'repo'), link: (name, target) => { fs.mkdirSync(path.dirname(path.join(base, 'repo', name)), { recursive: true }); fs.rmSync(path.join(base, 'repo', name), { force: true }); fs.symlinkSync(target, path.join(base, 'repo', name)); } };
}

/** The server for the repo at `root` (a path that may itself be a link), with `house` as the config's house source */
async function serve(root, { house = { use: 'house', options: { file: 'house.json' } }, theme } = {}) {
  fs.writeFileSync(path.join(root, 'cornfield.config.js'), `export default { title: 't', derivers: [], importMap: { lib: '/repo/web/lib.js' }, sources: { live: './web/live.js', house: ${JSON.stringify(house)} }${theme ? `, theme: ${JSON.stringify(theme)}` : ''} };`);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-real-data-'));
  made.push(data);
  const config = await loadConfig(root, { env: { CORNFIELD_DATA: data } });
  const server = createCornfieldServer(config, { env: {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  return { port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }) };
}

const everything = (res) => `${res.body}\n${JSON.stringify(res.headers)}`;

describe.skipIf(!canLink)('a link in the repo that leads outside it', () => {
  it('is not served on any file route: the repo\'s modules, the map, the cloud file, the House file', async () => {
    const w = world();
    w.link('web/helper.js', path.join(w.base, 'outside/x.js'));
    w.link('web/lib.js', path.join(w.base, 'outside/x.js'));
    w.link('topology.json', path.join(w.base, 'outside/x.json'));
    w.link('topology.cloud.json', path.join(w.base, 'outside/x.json'));
    w.link('house.json', path.join(w.base, 'outside/x.json'));
    const s = await serve(w.repo);
    try {
      for (const p of ['/repo/web/helper.js', '/repo/web/lib.js', '/topology.json', '/topology.cloud.json', '/cornfield/house.json']) {
        const res = await ask(s.port, p);
        expect(res.status, p).toBe(404);
        expect(everything(res), p).not.toContain(MARK);
      }
    } finally { await s.close(); }
  });

  it('is not served as the Home Assistant file either (the answer is made without it)', async () => {
    const w = world();
    w.link('ha.json', path.join(w.base, 'outside/x.json'));
    const s = await serve(w.repo, { house: { use: 'home-assistant', options: { file: 'ha.json' } } });
    try {
      const res = await ask(s.port, '/cornfield/house.json');
      expect(everything(res)).not.toContain(MARK);
    } finally { await s.close(); }
  });

  it('is refused when the folder it leads to only starts with the repo\'s name (/x/repo-other is outside /x/repo)', async () => {
    const w = world();
    w.link('web/helper.js', path.join(w.base, 'repo-other/x.js'));
    w.link('topology.cloud.json', path.join(w.base, 'repo-other/x.json'));
    const s = await serve(w.repo);
    try {
      for (const p of ['/repo/web/helper.js', '/topology.cloud.json']) {
        const res = await ask(s.port, p);
        expect(res.status, p).toBe(404);
        expect(everything(res), p).not.toContain(MARK);
      }
    } finally { await s.close(); }
    expect(isUnder('/x/repo', '/x/repo-other/a')).toBe(false);
    expect(isUnder('/x/repo', '/x/repo/a')).toBe(true);
    expect(isUnder('/x/repo', '/x/repo')).toBe(false);
  });

  it('is refused through a folder that is a link, and through a link to a link', async () => {
    const w = world();
    w.link('web/dir', path.join(w.base, 'outside'));
    w.link('hop.js', path.join(w.base, 'outside/x.js'));
    w.link('web/hop.js', path.join(w.repo, 'hop.js'));
    const s = await serve(w.repo);
    try {
      for (const p of ['/repo/web/dir/x.js', '/repo/web/hop.js']) {
        const res = await ask(s.port, p);
        expect(res.status, p).toBe(404);
        expect(everything(res), p).not.toContain(MARK);
      }
    } finally { await s.close(); }
  });

  it('is a 404 byte for byte like a file that is not there: status, headers and body, on every route', async () => {
    const w = world();
    w.link('web/helper.js', path.join(w.base, 'outside/x.js'));
    w.link('topology.cloud.json', path.join(w.base, 'outside/x.json'));
    w.link('house.json', path.join(w.base, 'outside/x.json'));
    const s = await serve(w.repo);
    const w2 = world();
    const s2 = await serve(w2.repo); // the same, with nothing at those names
    try {
      for (const p of ['/repo/web/helper.js', '/topology.cloud.json', '/cornfield/house.json']) {
        const refused = await ask(s.port, p);
        const missing = await ask(s2.port, p);
        expect(refused.status, p).toBe(404);
        expect(refused, p).toEqual(missing);
      }
      // a topology that is a link out answers as a topology that is not there yet
      fs.rmSync(path.join(w.repo, 'topology.json'));
      fs.rmSync(path.join(w2.repo, 'topology.json'));
      w.link('topology.json', path.join(w.base, 'outside/x.json'));
      expect(await ask(s.port, '/topology.json')).toEqual(await ask(s2.port, '/topology.json'));
      expect((await ask(s.port, '/topology.json')).status).toBe(404);
      // and the one 404 whose text names the path asked for differs from a missing file's only by that name
      const a = await ask(s.port, '/repo/web/helper.js');
      const b = await ask(s.port, '/repo/web/nothing.js');
      expect(a.body.replace('helper.js', 'X')).toBe(b.body.replace('nothing.js', 'X'));
      expect({ ...a.headers, date: 0 }).toEqual({ ...b.headers, date: 0 });
    } finally { await s.close(); await s2.close(); }
  });

  it('is refused as a theme file, and a theme file that is a look-alike sibling\'s link too', async () => {
    const w = world();
    w.link('theme.css', path.join(w.base, 'repo-other/x.css'));
    w.link('out.css', path.join(w.base, 'outside/x.css'));
    const s = await serve(w.repo, { theme: { css: 'theme.css', names: { out: 'out.css' } } });
    try {
      for (const p of ['/cornfield/theme.css', '/cornfield/theme/out.css']) {
        const res = await ask(s.port, p);
        expect(res.status, p).toBe(404);
        expect(everything(res), p).not.toContain(MARK);
      }
    } finally { await s.close(); }
  });
});

describe.skipIf(!canLink)('a link that stays in the repo, and a repo reached through a link', () => {
  it('is still served, typed by the name asked for', async () => {
    const w = world();
    fs.mkdirSync(path.join(w.repo, 'data'));
    fs.writeFileSync(path.join(w.repo, 'data/map.json'), JSON.stringify({ nodes: [], edges: [], note: 'in-repo' }));
    fs.writeFileSync(path.join(w.repo, 'data/lib.txt'), 'export const a = 1;');
    fs.writeFileSync(path.join(w.repo, 'data/house.json'), JSON.stringify({ at: '2026-01-01T00:00:00.000Z', rooms: ['kitchen'] }));
    w.link('web/alias.js', path.join(w.repo, 'web/live.js'));
    w.link('web/lib.js', path.join(w.repo, 'data/lib.txt'));
    fs.rmSync(path.join(w.repo, 'topology.json'));
    w.link('topology.json', 'data/map.json'); // a relative link
    w.link('house.json', path.join(w.repo, 'data/house.json'));
    const s = await serve(w.repo);
    try {
      expect((await ask(s.port, '/repo/web/alias.js')).body).toContain('create');
      const lib = await ask(s.port, '/repo/web/lib.js');
      expect(lib.body).toBe('export const a = 1;');
      expect(lib.headers['content-type']).toBe('application/javascript; charset=utf-8');
      expect((await ask(s.port, '/topology.json')).body).toContain('in-repo');
      expect(JSON.parse((await ask(s.port, '/cornfield/house.json')).body).data.rooms).toEqual(['kitchen']);
    } finally { await s.close(); }
  });

  it('serves a repo whose own path is a link, and still refuses a link out of it', async () => {
    const w = world();
    w.link('web/helper.js', path.join(w.base, 'outside/x.js'));
    const through = path.join(w.base, 'through');
    fs.symlinkSync(w.repo, through);
    fs.writeFileSync(path.join(w.repo, 'house.json'), JSON.stringify({ rooms: ['hall'] }));
    const s = await serve(through);
    try {
      expect((await ask(s.port, '/topology.json')).body).toContain('inside');
      expect((await ask(s.port, '/repo/web/live.js')).status).toBe(200);
      expect(JSON.parse((await ask(s.port, '/cornfield/house.json')).body).data.rooms).toEqual(['hall']);
      expect((await ask(s.port, '/explorer/main.js')).status).toBe(200);
      const out = await ask(s.port, '/repo/web/helper.js');
      expect(out.status).toBe(404);
      expect(everything(out)).not.toContain(MARK);
    } finally { await s.close(); }
  });

  it('serves cornfield\'s own files when cornfield itself is reached through a link', async () => {
    const w = world();
    const linked = path.join(w.base, 'linked-cornfield');
    fs.symlinkSync(CORNFIELD, linked);
    const port = await freePort();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-real-data-'));
    made.push(data);
    const child = spawn(process.execPath, [path.join(linked, 'cli', 'cornfield.js'), 'serve', '--repo', w.repo, '--port', String(port)], { env: { ...process.env, CORNFIELD_DATA: data }, stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code) => reject(new Error(`cornfield serve exited with ${code}`)));
        child.stdout.on('data', (d) => { if (String(d).includes('http://')) resolve(undefined); });
      });
      for (const p of ['/', '/explorer/main.js', '/explorer/css/base.css', '/core/schema.js', '/plugins/house/browser.js']) expect((await ask(port, p)).status, p).toBe(200);
    } finally { child.kill(); }
  });

  it('judges a folder by its own real path: a link inside a linked folder that stays in it works, one that leaves it does not', () => {
    const w = world();
    const own = path.join(w.base, 'own');
    fs.mkdirSync(path.join(own, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(own, 'sub/a.js'), 'a');
    fs.symlinkSync(path.join(own, 'sub/a.js'), path.join(own, 'same.js'));
    fs.symlinkSync(path.join(w.base, 'outside/x.js'), path.join(own, 'out.js'));
    const entry = path.join(w.base, 'entry');
    fs.symlinkSync(own, entry);
    expect(inside(entry, 'same.js')).toBe(path.join(own, 'sub/a.js'));
    expect(inside(entry, '/sub/a.js')).toBe(path.join(own, 'sub/a.js'));
    expect(inside(entry, 'out.js')).toBeNull();
    expect(inside(entry, '../outside/x.js')).toBeNull();
    expect(inside(entry, 'missing.js')).toBeNull();
    expect(inside(entry, '')).toBeNull();
    expect(inside(entry, 'a\0.js')).toBeNull();
  });
});

describe.skipIf(!canLink)('what is checked is what is served', () => {
  it('does not give one name\'s cached ETag to another file: a link moved to a file of the same size and time is a new answer', async () => {
    const w = world();
    fs.writeFileSync(path.join(w.repo, 'web/one.js'), 'export const n = 1;');
    fs.writeFileSync(path.join(w.repo, 'web/two.js'), 'export const n = 2;');
    const when = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(path.join(w.repo, 'web/one.js'), when, when);
    fs.utimesSync(path.join(w.repo, 'web/two.js'), when, when);
    w.link('web/alias.js', path.join(w.repo, 'web/one.js'));
    const s = await serve(w.repo);
    try {
      const first = await ask(s.port, '/repo/web/alias.js');
      expect(first.body).toBe('export const n = 1;');
      const same = await ask(s.port, '/repo/web/live.js');
      expect(same.headers.etag).not.toBe(first.headers.etag);
      // two names for one file: one answer, and a 304 for either one's ETag
      w.link('web/second.js', path.join(w.repo, 'web/one.js'));
      expect((await ask(s.port, '/repo/web/second.js')).headers.etag).toBe(first.headers.etag);
      w.link('web/alias.js', path.join(w.repo, 'web/two.js'));
      const moved = await ask(s.port, '/repo/web/alias.js', { 'If-None-Match': first.headers.etag });
      expect(moved.status).toBe(200);
      expect(moved.body).toBe('export const n = 2;');
      expect(moved.headers.etag).not.toBe(first.headers.etag);
      expect((await ask(s.port, '/repo/web/alias.js', { 'If-None-Match': moved.headers.etag })).status).toBe(304);
    } finally { await s.close(); }
  });

  it('does not follow a link put in place of the checked file (the open refuses a link at the last step)', () => {
    if (fs.constants.O_NOFOLLOW === undefined) return;
    const w = world();
    const target = path.join(w.base, 'outside/x.json');
    const swapped = path.join(w.repo, 'swapped.json');
    fs.symlinkSync(target, swapped);
    expect(readPlain(swapped)).toBeNull();
    expect(readPlain(path.join(w.base, 'outside/x.json'))?.body.toString('utf8')).toContain(MARK); // the helper is for paths `inside` gave
    expect(readPlain(path.join(w.base, 'outside'))).toBeNull(); // a folder is not a file
  });

  it('reads the map only from inside the repo', () => {
    const w = world();
    const config = { root: w.repo, topology: 'topology.json' };
    expect(readMap(config).note).toBe('inside');
    fs.rmSync(path.join(w.repo, 'topology.json'));
    w.link('topology.json', path.join(w.base, 'outside/x.json'));
    expect(readMap(config)).toBeNull();
    expect(readMap({ root: w.repo, topology: '../outside/x.json' })).toBeNull();
  });
});

describe.skipIf(!canLink)('proposals found through a link', () => {
  const doc = JSON.stringify({ version: 1, title: 'P', summary: 's' });
  const where = (root) => ({ root, proposals: 'docs/specs/proposals', worktrees: '.claude/worktrees', topology: 'topology.json', dataDir: path.join(root, '.data') });

  it('are not listed when the proposals folder, the worktrees folder or a worktree\'s proposals folder leads out of the repo', async () => {
    const w = world();
    const out = path.join(w.base, 'outside/props');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, '0001-out.json'), doc);
    fs.mkdirSync(path.join(w.repo, 'docs/specs'), { recursive: true });
    fs.symlinkSync(out, path.join(w.repo, 'docs/specs/proposals'));
    expect(await listProposalFiles(where(w.repo))).toEqual([]);

    const w2 = world();
    fs.mkdirSync(path.join(w2.base, 'outside/wts/w1/docs/specs/proposals'), { recursive: true });
    fs.writeFileSync(path.join(w2.base, 'outside/wts/w1/docs/specs/proposals/0001-out.json'), doc);
    fs.mkdirSync(path.join(w2.repo, '.claude'), { recursive: true });
    fs.symlinkSync(path.join(w2.base, 'outside/wts'), path.join(w2.repo, '.claude/worktrees'));
    expect(await listProposalFiles(where(w2.repo))).toEqual([]);

    const w3 = world();
    fs.mkdirSync(path.join(w3.repo, '.claude/worktrees/w1/docs/specs'), { recursive: true });
    fs.symlinkSync(out, path.join(w3.repo, '.claude/worktrees/w1/docs/specs/proposals'));
    expect(await listProposalFiles(where(w3.repo))).toEqual([]);
  });

  it('are listed from a repo reached through a link, and from a folder that is a link inside it', async () => {
    const w = world();
    fs.mkdirSync(path.join(w.repo, 'real-props'), { recursive: true });
    fs.writeFileSync(path.join(w.repo, 'real-props/0001-in.json'), doc);
    fs.mkdirSync(path.join(w.repo, 'docs/specs'), { recursive: true });
    fs.symlinkSync(path.join(w.repo, 'real-props'), path.join(w.repo, 'docs/specs/proposals'));
    const through = path.join(w.base, 'through');
    fs.symlinkSync(w.repo, through);
    const found = await listProposalFiles(where(through));
    expect(found.map((e) => e.slug)).toEqual(['0001-in']);
    expect(found[0].file).toBe(path.join(w.repo, 'real-props/0001-in.json'));
  });
});
