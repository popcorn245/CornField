/**
 * @vitest-environment node
 *
 * The explorer is buildless, so nothing compiles it before the browser does. This is the compile step: the
 * page loads its one module and its stylesheets from this origin, has no inline script and nothing from
 * outside, and every module parses and imports only files that exist. And the sources the config names
 * load in the browser through explorer/plugins.js.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { EXPLORER, CORNFIELD, explorerPage } from '../helpers.js';
import { loadSources, combineSources, NO_SOURCE } from '../../explorer/plugins.js';
import { create, HOUSE_PATH } from '../../plugins/house/browser.js';

const BROWSER_DIRS = [EXPLORER, path.join(CORNFIELD, 'plugins/house')];
const modules = () => BROWSER_DIRS.flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.js')).map((f) => path.join(d, f)));

describe('the page', () => {
  const html = explorerPage();
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];

  it('loads explorer/main.js as its one module, and its stylesheets, from this origin', () => {
    // theme-boot.js is the one classic script, in the head: it puts the theme on <html> before the first paint (MAP-01)
    expect(scripts.map(([, attrs]) => attrs.trim())).toEqual(['src="/explorer/theme-boot.js"', 'type="module" src="/explorer/main.js"']);
    expect(html.indexOf('/explorer/theme-boot.js')).toBeLessThan(html.indexOf('/explorer/explorer.css'));
    expect(html).toMatch(/<link rel="stylesheet" href="\/explorer\/explorer\.css" \/>/);
    expect(html).toMatch(/<link rel="stylesheet" href="\/explorer\/house\.css" \/>/);
    expect(html).toContain('<!--@importmap-->');
  });

  it('has no inline script, and loads nothing from outside', () => {
    for (const [, attrs, body] of scripts) expect(/\bsrc=/.test(attrs) || !body.trim()).toBe(true);
    for (const [, tag, url] of html.matchAll(/<(script|link|img|iframe)\b[^>]*\b(?:src|href)="([^"]+)"/gi)) expect(url, `<${tag}> ${url}`).not.toMatch(/^(?:[a-z]+:)?\/\//i);
  });
});

describe('every browser module', () => {
  it('parses as a module and imports only files that exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-parse-'));
    try {
      for (const file of modules()) {
        const source = fs.readFileSync(file, 'utf8');
        const copy = path.join(tmp, `${path.basename(file, '.js')}.mjs`);
        fs.writeFileSync(copy, source);
        const check = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
        expect(check.status, `${file}: ${check.stderr}`).toBe(0);
        for (const [, spec] of source.matchAll(/(?:^|\s)(?:import|export)\b[^'"`;]*?\bfrom\s+['"]([^'"]+)['"]/g)) {
          expect(spec.startsWith('.'), `${file} imports ${spec} by name: the browser has no import map for it`).toBe(true);
          expect(fs.existsSync(path.resolve(path.dirname(file), spec)), `${file} imports ${spec}`).toBe(true);
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('names no URL outside this origin: the explorer never reaches the internet', () => {
    for (const file of modules()) {
      const code = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const outside = [...code.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)].map((m) => m[1]).filter((h) => h !== 'www.w3.org');
      expect(outside, file).toEqual([]);
    }
  });
});

describe('explorer/plugins.js: the sources a config names', () => {
  it('with none, the live layer has a source that says so, and there is no floor hook or checker', async () => {
    const out = await loadSources({ sources: { live: null, house: null } });
    expect(out).toEqual({ liveSource: NO_SOURCE, floorRenderer: null, checker: null });
    await expect(NO_SOURCE.load()).rejects.toMatchObject({ reason: 'unavailable', hint: expect.stringMatching(/no live source is set/) });
  });

  it('imports each source, calls its create(options), and takes the house\'s floor hook and the checker\'s checker', async () => {
    const importer = vi.fn(async (url) => ({
      '/plugins/house/browser.js': { create: (o) => ({ liveSource: { name: `house ${o.file}`, load: async () => ({ nodes: [], edges: [] }) }, floorRenderer: { render: () => '' } }) },
      '/repo/tools/check.js': { checker: { name: 'mine', check: async () => [] } },
    })[url]);
    const out = await loadSources({ sources: { house: { module: '/plugins/house/browser.js', options: { file: 'h.json' } }, checker: { module: '/repo/tools/check.js', options: {} } } }, importer);
    expect(out.liveSource.name).toBe('house h.json');
    expect(out.floorRenderer).toBeTruthy();
    expect(out.checker.name).toBe('mine');
  });

  it('leaves out a source that does not load, with one warning, and never imports an outside URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const importer = vi.fn(async () => { throw new Error('404'); });
    const out = await loadSources({ sources: { live: { module: '/repo/gone.js' }, devices: { module: 'https://cdn.example.org/x.js' } } }, importer);
    expect(out.liveSource).toBe(NO_SOURCE);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('lays two live answers over each other, and one that fails becomes a note', async () => {
    const a = { name: 'a', load: async () => ({ at: '2026-01-01T00:00:00.000Z', nodes: [{ id: 'live-room-a' }], edges: [], accounts: [{ role: 'admin', count: 1 }], notes: ['from a'], plan: { floors: [] } }) };
    const b = { name: 'b', load: async () => ({ at: '2026-01-02T00:00:00.000Z', nodes: [{ id: 'live-room-b' }], edges: [{ from: 'x', to: 'y' }], notes: [] }) };
    const c = { name: 'c', load: async () => { throw Object.assign(new Error('down'), { hint: 'c is down' }); } };
    const both = await combineSources([a, b, c]).load({});
    expect(both.nodes.map((n) => n.id)).toEqual(['live-room-a', 'live-room-b']);
    expect(both.at).toBe('2026-01-02T00:00:00.000Z');
    expect(both.notes).toEqual(['from a', 'A source did not answer: c is down']);
    expect(both.plan).toEqual({ floors: [] });
    await expect(combineSources([c, c]).load({})).rejects.toMatchObject({ hint: 'c is down' });
    expect(combineSources([a])).toBe(a);
  });
});

describe('the built-in house source', () => {
  it('reads the repo\'s house file from this origin, with no token', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: { at: '2026-10-11T18:00:00.000Z', house: { floors: [{ id: 'g', name: 'Ground', level: 0 }], rooms: [] } } }) }));
    const { liveSource, floorRenderer } = create({ file: 'cornfield.house.json' });
    vi.stubGlobal('fetch', fetch);
    try {
      const answer = await liveSource.load({ groups: [] });
      expect(answer.nodes.map((n) => n.id)).toEqual(['live-floor-g']);
      expect(fetch.mock.calls[0][0]).toBe(HOUSE_PATH);
      expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(floorRenderer.defaultPlan().floors.length).toBe(2);
  });
});
