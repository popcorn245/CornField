/**
 * @vitest-environment node
 *
 * cornfield.config.js: what a repo may say, the defaults, env vars over the file, the derivers and the
 * browser sources it names.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configProblems, loadConfig, loadDerivers, browserSources, DEFAULTS } from '../../core/config.js';
import { CORNFIELD, SAMPLE } from '../helpers.js';

const made = [];
const repo = (configText) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-config-'));
  made.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', type: 'module' }));
  if (configText !== undefined) fs.writeFileSync(path.join(root, 'cornfield.config.js'), configText);
  return root;
};
afterAll(() => { for (const r of made) fs.rmSync(r, { recursive: true, force: true }); });

describe('configProblems', () => {
  it('accepts an empty config and the sample repo\'s', async () => {
    expect(configProblems({})).toEqual([]);
    const mod = await import(pathToFileURL(path.join(SAMPLE, 'cornfield.config.js')).href);
    expect(configProblems(mod.default)).toEqual([]);
  });

  it('names what is wrong: unknown keys, a bad port, a deriver or source that is neither built in nor a path, a path out of the repo', () => {
    const out = configProblems({
      colour: 'red', port: 70000, derivers: ['nope', './../x.js', { use: 'starter', options: 3 }],
      sources: { live: 'mystery', radio: null, house: { use: './house.js', options: { fn: undefined } } },
      forge: { type: 'gitlab', repo: 'no-slash' }, worktrees: '../elsewhere', links: [{ label: 'x', href: 'javascript:alert(1)' }],
      proxy: { '/cornfield/': 'http://x', api: 'ftp://y' }, importMap: { a: 'https://cdn.example/a.js' }, personas: { roles: [1] },
    });
    const text = out.join('\n');
    for (const want of ['unknown key "colour"', '"port"', 'derivers[0] "nope"', 'derivers[1] "./../x.js" leaves the repo', 'derivers[2].options', 'sources.live "mystery"', 'sources.radio', 'forge.type', 'forge.repo', '"worktrees"', 'links[0]', 'proxy "/cornfield/" is cornfield', 'proxy "api"', '"importMap"', '"personas"']) {
      expect(text, want).toContain(want);
    }
  });
});

describe('loadConfig', () => {
  it('fills the defaults, names the title from package.json, and keeps the data folder out of the repo', async () => {
    const root = repo();
    const c = await loadConfig(root, { env: {} });
    expect(c).toMatchObject({ title: 'demo', port: 3350, host: '127.0.0.1', derivers: DEFAULTS.derivers, proposals: 'docs/specs/proposals', worktrees: '.claude/worktrees', root, configFile: null });
    expect(path.relative(root, c.dataDir).startsWith('..')).toBe(true);
    expect(c.dataDir).toContain('.cornfield');
  });

  it('reads the file, and env vars win over it for what differs per machine', async () => {
    const root = repo("export default { title: 'From the file', port: 4000, links: [{ label: 'Docs', href: '/docs' }] };");
    const c = await loadConfig(root, { env: { CORNFIELD_PORT: '4100', CORNFIELD_HOST: '::1', CORNFIELD_PUBLIC_URL: 'https://dash.example.org', CORNFIELD_DATA: '/tmp/cf' } });
    expect(c).toMatchObject({ title: 'From the file', port: 4100, host: '::1', publicUrl: 'https://dash.example.org', dataDir: '/tmp/cf', links: [{ label: 'Docs', href: '/docs' }] });
  });

  it('refuses a config with problems, naming the file', async () => {
    const root = repo('export default { port: "eighty" };');
    await expect(loadConfig(root, { env: {} })).rejects.toThrow(/cornfield\.config\.js:\n {2}"port"/);
  });
});

describe('loadDerivers and browserSources', () => {
  it('loads the built-in derivers by name, and a repo\'s own by path, each with its options', async () => {
    const root = repo("export default { derivers: ['starter', { use: './tools/mine.js', options: { a: 1 } }] };");
    fs.mkdirSync(path.join(root, 'tools'));
    fs.writeFileSync(path.join(root, 'tools/mine.js'), "export default { name: 'mine', contract: 1, derive: () => ({ nodes: [], edges: [] }) };");
    const loaded = await loadDerivers(await loadConfig(root, { env: {} }));
    expect(loaded.map((d) => d.deriver.name)).toEqual(['starter', 'mine']);
    expect(loaded[1].options).toEqual({ a: 1 });
  });

  it('says which deriver file is missing', async () => {
    const root = repo("export default { derivers: ['./tools/gone.js'] };");
    await expect(loadDerivers(await loadConfig(root, { env: {} }))).rejects.toThrow(/gone\.js does not exist/);
  });

  it('serves a built-in source from cornfield and a repo\'s own under /repo/, with its options', async () => {
    const c = await loadConfig(SAMPLE, { env: {} });
    expect(browserSources(c)).toEqual({ live: null, house: { module: '/plugins/house/browser.js', options: { file: 'cornfield.house.json' } }, devices: null, checker: null });
    const own = browserSources({ sources: { live: { use: './tools/live.js', options: { url: '/api/world' } } } });
    expect(own.live).toEqual({ module: '/repo/tools/live.js', options: { url: '/api/world' } });
    expect(fs.existsSync(path.join(CORNFIELD, 'plugins/house/browser.js'))).toBe(true);
  });
});
