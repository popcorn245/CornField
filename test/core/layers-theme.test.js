/**
 * @vitest-environment node
 *
 * The theme's part of project layers and finer kinds (spec 0009 D6): the token and icon-key names, which fill wins, the contrast check of
 * the kind and project-layer tokens a theme sets, and the warnings about a kind or a layer a theme names that is not there.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mapKindToken, mapGroupToken, parseKindToken, iconKeyShape, iconKeysFor } from '../../core/layers.js';
import { TOKENS_FILE, contrastProblems, checkSheets, describeFinding, mapExtraTokens, projectGroupOf } from '../../core/contrast.js';
import { layerTokenWarnings } from '../../core/map-tokens.js';
import { configProblems } from '../../core/config.js';
// @ts-expect-error plain JS modules, no declarations
import * as M from '../../explorer/map-style.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene } from '../../explorer/scene.js';
import { CORNFIELD } from '../helpers.js';

const tokens = fs.readFileSync(TOKENS_FILE, 'utf8');
const dirs = [];
const repoWith = (css, extra = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-layer-tokens-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'theme'));
  fs.writeFileSync(path.join(dir, 'theme', 'theme.css'), css);
  return { root: dir, theme: { css: 'theme/theme.css' }, ...extra };
};
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('the names', () => {
  it('a kind token reads one way: types never hold a "-"', () => {
    expect(mapKindToken('service', 'timer')).toBe('--corn-map-kind-service-timer');
    expect(mapKindToken('service', 'web-hook')).toBe('--corn-map-kind-service-web-hook');
    expect(parseKindToken('--corn-map-kind-service-web-hook')).toEqual({ type: 'service', kind: 'web-hook' });
    expect(parseKindToken('--corn-map-kind-service-timer')).toEqual({ type: 'service', kind: 'timer' });
  });
  it('a kind that cannot be a part of a name has no token, and a hostile one never reaches a name', () => {
    for (const kind of ['Timer', 'a b', 'a_b', '</script>', 'a"b', 'url(x)', 'a;b', '', 'a'.repeat(33), '-a', 'a--b', 7, null]) expect(mapKindToken('service', kind), String(kind)).toBeNull();
    expect(mapKindToken('widget', 'timer')).toBeNull();
    expect(parseKindToken('--corn-map-kind-widget-timer')).toBeNull();
    expect(parseKindToken('--corn-map-kind-service-')).toBeNull();
  });
  it('a group token for a layer key that passes the key pattern', () => {
    expect(mapGroupToken('edge-stack')).toBe('--corn-map-group-edge-stack');
    for (const key of ['Edge', 'a b', 'a)', '</script>', '', 'a'.repeat(33)]) expect(mapGroupToken(key), key).toBeNull();
    expect(projectGroupOf('--corn-map-group-timers')).toBe('timers');
    expect(projectGroupOf('--corn-map-group-service')).toBeNull(); // a starting group
    expect(projectGroupOf('--corn-map-group-cloud')).toBeNull();
  });
  it('an icon key is a type, a kind of one or a layer, in that order of precedence kind, layer, type', () => {
    expect(iconKeyShape('service')).toEqual({ type: 'service' });
    expect(iconKeyShape('service:timer')).toEqual({ type: 'service', kind: 'timer' });
    expect(iconKeyShape('layer:timers')).toEqual({ layer: 'timers' });
    for (const k of ['widget', 'widget:x', 'layer:', 'layer:A', 'service:A', 'service:', '', 3, null, 'a:b:c']) expect(iconKeyShape(k), String(k)).toBeNull();
    expect(iconKeysFor('service', 'timer', 'timers')).toEqual(['service:timer', 'layer:timers', 'service']);
    expect(iconKeysFor('service', undefined, null)).toEqual(['service']);
    expect(iconKeysFor('service', 'Bad Kind', 'timers')).toEqual(['layer:timers', 'service']);
  });
});

describe('which fill wins: the kind, the project layer, the type, the starting layer, then auto', () => {
  const node = (id, type, extra = {}) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, ...extra });
  const nodes = [node('root', 'root'), node('t', 'service', { kind: 'timer' }), node('h', 'service', { kind: 'hook' }), node('p', 'page'), node('q', 'page')];
  const scene = () => buildScene({ nodes, edges: [], view: 'orbit', flow: null, rings: { rings: [], clusters: [] }, selectedNode: null, searchQuery: '', isFreeform: false, activeLayers: {}, scenario: null, sceneVersion: 1, theme: 'dark', projectLayers: [{ key: 'jobs', label: 'Jobs', match: { type: 'service', kind: ['timer', 'hook'] } }, { key: 'home', label: 'Home', match: { type: 'page' } }] });
  const style = (values) => ({ version: 1, values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, M.cssColor(v)])), strokeWidth: 1.5, icons: null, pixelated: false, plain: false });
  const fillOf = (values, id) => M.styledScene(scene(), style(values)).nodes.find((n) => n.id === id).color;

  it('the kind beats the layer, which beats the type, which beats the starting layer', () => {
    const all = { '--corn-map-kind-service-timer': '#010101', '--corn-map-group-jobs': '#020202', '--corn-map-node-service': '#030303', '--corn-map-group-service': '#040404' };
    expect(fillOf(all, 't')).toBe('#010101');
    delete all['--corn-map-kind-service-timer'];
    expect(fillOf(all, 't')).toBe('#020202');
    delete all['--corn-map-group-jobs'];
    expect(fillOf(all, 't')).toBe('#030303');
    delete all['--corn-map-node-service'];
    expect(fillOf(all, 't')).toBe('#040404');
    delete all['--corn-map-group-service'];
    expect(fillOf(all, 't')).toBe('#336699'); // auto: the node's own colour
  });
  it('a kind\'s token reaches only that kind, a layer\'s only its nodes', () => {
    const v = { '--corn-map-kind-service-timer': '#010101', '--corn-map-group-home': '#050505' };
    expect(fillOf(v, 'h')).toBe('#336699');
    expect(fillOf(v, 'p')).toBe('#050505');
    expect(fillOf(v, 'q')).toBe('#050505');
  });
  it('a theme that names none of them leaves every node its type\'s colour', () => {
    expect(M.styledScene(scene(), style({})).nodes.map((n) => n.color)).toEqual(scene().nodes.map((n) => n.color));
  });
});

describe('the map reads the tokens of the kinds and layers on the map, and no others', () => {
  it('reads a kind token only once the kind is on the map, and a group token once the layer is in the config', () => {
    const table = { '--corn-map-kind-service-timer': '#112233', '--corn-map-group-jobs': '#223344', '--corn-map-kind-service-other': '#334455' };
    const read = (name) => table[name] ?? '';
    expect(M.readMapTokens(read).values).toEqual({});
    expect(M.readMapTokens(read, ['--corn-map-kind-service-timer', '--corn-map-group-jobs']).values).toEqual({ '--corn-map-kind-service-timer': '#112233', '--corn-map-group-jobs': '#223344' });
  });
});

describe('the contrast check holds a kind token and a project layer token a theme sets', () => {
  const FLAT = ':root[data-theme="light"], :root { --corn-ground-image: none; } :root[data-theme="light"] { --corn-ground: #fdf3dc; }';
  const check = (brand) => contrastProblems([{ theme: 'standard', sheets: [tokens, brand] }]);
  it('says nothing about a theme that sets none (the standard tokens are as they were)', () => {
    expect(mapExtraTokens([tokens])).toEqual([]);
    expect(check('').fails.filter((f) => /map-(kind|group-(?!app|pkg|page|atom|molecule|token|tool|table|rom|service|cloud|web|stack|machine|container|device|house|persona))/.test(f.fg))).toEqual([]);
  });
  it('fails a kind fill under 3:1 on the ground, naming the token, the type and the kind, light and dark', () => {
    const fails = check(`${FLAT} :root[data-theme="light"] { --corn-map-kind-service-timer: #f2f0a0; } :root[data-theme="dark"] { --corn-map-kind-service-hook: #101018; }`).fails;
    const light = fails.find((f) => f.fg.startsWith('--corn-map-kind-service-timer'));
    expect(light.mode).toBe('light');
    expect(describeFinding(light)).toMatch(/standard theme \(light\): --corn-map-kind-service-timer \(the fill of a service node of the kind "timer".*\) \(#f2f0a0\) on --corn-ground .* below 3:1/);
    expect(fails.some((f) => f.mode === 'dark' && f.fg.startsWith('--corn-map-kind-service-hook'))).toBe(true);
  });
  it('fails a project layer fill under 3:1, and passes one at 3:1', () => {
    const fails = check(`${FLAT} :root[data-theme="light"] { --corn-map-group-timers: #f2f0a0; --corn-map-group-calls: #1a4d8f; }`).fails;
    expect(describeFinding(fails.find((f) => f.fg.startsWith('--corn-map-group-timers')))).toMatch(/\(the fill of a node in the "timers" layer.*\)/);
    expect(fails.some((f) => f.fg.startsWith('--corn-map-group-calls'))).toBe(false);
    expect(checkSheets([{ theme: 'standard', sheets: [tokens, ':root { --corn-map-group-calls: #1a4d8f; }'] }]).some((f) => f.fg === '--corn-map-group-calls' && f.ratio >= 3)).toBe(true);
  });
  it('accepts a low fill the outline carries, as it does for a type', () => {
    const css = `${FLAT} :root[data-theme="light"] { --corn-map-kind-service-timer: #f2f0a0; --corn-map-stroke: #1a1a1a; }`;
    expect(check(css).fails.filter((f) => /kind-service-timer/.test(f.fg + f.use))).toEqual([]);
  });
  it('lines the two system settings up when a token is set on one only', () => {
    const css = '@media (prefers-color-scheme: dark) { :root { --corn-map-kind-service-timer: #202030; } }';
    expect(() => check(css)).not.toThrow();
  });
  it('reads a token that is not a colour as unresolved, naming it', () => {
    const { unresolved } = check(':root { --corn-map-group-timers: oklch(70% 0.1 200); }');
    expect(unresolved.some((f) => f.fg === '--corn-map-group-timers' && /oklch/.test(f.problem))).toBe(true);
  });
});

describe('warnings for a kind or a layer a theme names that is not there', () => {
  const map = { nodes: [{ id: 'a', type: 'service', kind: 'timer' }, { id: 'b', type: 'service', kind: 'job' }, { id: 'c', type: 'page' }] };
  const layers = { add: [{ key: 'timers' }] };
  it('a kind token for a kind not on the map, or not shaped like a kind token', () => {
    const w = layerTokenWarnings({ ...repoWith(':root { --corn-map-kind-service-timr: #123456; --corn-map-kind-service-timer: #123456; --corn-map-kind-widget-x: #123456; --corn-map-kind-service-Bad: #123456; }'), layers }, map);
    expect(w).toHaveLength(3);
    expect(w.find((l) => l.includes('service-timr'))).toMatch(/names a kind no service on the map has \(service kinds on the map: job, timer\)/);
    expect(w.filter((l) => /is not a kind token/.test(l))).toHaveLength(2);
    expect(w.some((l) => l.includes('service-timer:'))).toBe(false);
  });
  it('a group token for a layer the config does not have, and not for a starting group or a layer it has', () => {
    const w = layerTokenWarnings({ ...repoWith(':root { --corn-map-group-timrs: #123456; --corn-map-group-timers: #123456; --corn-map-group-service: #123456; }'), layers }, map);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/--corn-map-group-timrs in the standard theme names a layer the config does not have \(project layers: timers\)/);
  });
  it('an icon for a kind not on the map, or a layer not in the config', () => {
    const cfg = { ...repoWith(':root {}'), layers, theme: { css: 'theme/theme.css', icons: { 'service:timr': './a.svg', 'service:timer': './a.svg', 'layer:nope': './a.svg', 'layer:timers': './a.svg', service: './a.svg', 'junk key': './a.svg' } } };
    const w = layerTokenWarnings(cfg, map);
    expect(w).toHaveLength(2);
    expect(w[0]).toContain('theme.icons "service:timr" names a kind no service on the map has');
    expect(w[1]).toContain('theme.icons "layer:nope" names a layer the config does not have (project layers: timers)');
  });
  it('is quiet for the standard theme with no layers and a map of any kinds', () => {
    expect(layerTokenWarnings({ root: CORNFIELD, theme: {} }, map)).toEqual([]);
    expect(layerTokenWarnings({ root: CORNFIELD, theme: { css: 'test/fixtures/themes/retro/theme.css' } }, map)).toEqual([]);
  });
  it('the config check takes the new icon keys', () => {
    expect(configProblems({ theme: { names: { a: './tools/t/a.css' }, icons: { 'service:timer': './tools/t/i.svg', 'layer:x': './tools/t/i.svg' } } })).toEqual([]);
  });
});
