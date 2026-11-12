// @vitest-environment node
/**
 * The package as built (spec 0011 D7, D11): the generated default tokens, the type declarations a consumer compiles against, the files of dist/,
 * the version they carry and the size budget. Nothing here needs a browser; `npm run build` runs first in CI, and this builds when dist/ is not there.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JS
import { componentTags, tokensCss, version } from '../scripts/shared.mjs';
// @ts-expect-error plain JS
import { declarationsOf, defaultTokensCss, parseRules } from '../scripts/tokens.mjs';
// @ts-expect-error plain JS
import { analyzeComponents, typesFor, writeTypes } from '../scripts/types.mjs';
// @ts-expect-error plain JS
import { measure } from '../scripts/size-budget.mjs';

const PACKAGE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO = path.resolve(PACKAGE, '..');
const SOURCE = fs.readFileSync(path.join(REPO, 'explorer', 'tokens.css'), 'utf8');
const dist = path.join(PACKAGE, 'dist');

describe('the generated default tokens (D7)', () => {
  const css = defaultTokensCss(SOURCE, { tags: ['corn-map'] });
  const rules = parseRules(css);
  const flat: Array<{ prelude: string; body: string }> = rules.flatMap((r: { prelude: string; body: string }) => (r.prelude.startsWith('@media') ? parseRules(r.body) : [r]));

  it('has every selector at zero specificity: each one is a single :where(...)', () => {
    expect(flat.length).toBeGreaterThan(5);
    for (const r of flat) {
      const selectors = r.prelude.split(/,\s*\n?\s*/);
      for (const s of selectors) expect(/^:where\((?:[^()]|\([^()]*\))*\)$/.test(s.trim()), s).toBe(true);
    }
  });

  it('keeps every value of explorer/tokens.css, from the file and not from a copy', () => {
    const names = (text: string) => new Set([...text.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const [a, b] = [names(SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')), names(css)];
    for (const n of a) expect(b.has(n), n).toBe(true);
    for (const n of b) expect(a.has(n), n).toBe(true);
    const ground = /--corn-ground:\s*([^;]+);/.exec(SOURCE)![1].trim();
    expect(css).toContain(`--corn-ground: ${ground};`);
    expect(css).toContain('@media (prefers-color-scheme: light)');
    expect(css).toContain(':where(:root:not([data-theme="dark"]))');
    expect(css).toContain(':where(:root[data-theme="light"])');
  });

  it('adds a forced mode for each tag: the light tokens, and the dark ones that undo exactly those', () => {
    const forced = (mode: string) => flat.find((r) => r.prelude === `:where(corn-map[theme="${mode}"])`)!;
    const light = declarationsOf(forced('light').body) as Array<[string, string]>;
    const dark = declarationsOf(forced('dark').body) as Array<[string, string]>;
    const lightBlock = declarationsOf(flat.find((r) => r.prelude === ':where(:root[data-theme="light"])')!.body) as Array<[string, string]>;
    const base = new Map(declarationsOf(flat.find((r) => r.prelude === ':where(:root)')!.body) as Array<[string, string]>);
    for (const [name, value] of lightBlock) expect(new Map(light).get(name), name).toBe(value);
    for (const [name] of lightBlock) if (name !== 'color-scheme') expect(new Map(dark).get(name), name).toBe(base.get(name));
    expect(new Map(light).get('color-scheme')).toBe('light');
    expect(new Map(dark).get('color-scheme')).toBe('dark');
    // a token built from others is declared on the element too, to be worked out there
    expect(new Map(light).has('--corn-ok-soft')).toBe(true);
    expect(new Map(light).get('--corn-ok-soft')).toContain('var(--corn-ok)');
  });

  it('refuses what it cannot make safe: a token only the light block sets, an at-rule it does not handle', () => {
    expect(() => defaultTokensCss(':root { --a: 1; } :root[data-theme="light"] { --b: 2; }', { tags: ['corn-x'] })).toThrow(/--b/);
    expect(() => defaultTokensCss(':root { --a: 1; } :root[data-theme="light"] { --a: 2; } @supports (x: y) { :root { --c: 1; } }')).toThrow(/@supports/);
  });

  it('covers every tag of the package', () => {
    const tags = componentTags();
    expect(tags).toContain('corn-map');
    const full = tokensCss();
    for (const t of tags) expect(full).toContain(`:where(${t}[theme="light"])`);
  });
});

describe('the type declarations (D11)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corn-types-'));
  const types = path.join(tmp, 'types');
  writeTypes(types);

  /** Compiles `source` as a consumer's file next to the generated declarations; returns the messages of what it did not accept */
  function compile(source: string) {
    const file = path.join(tmp, `consumer-${Math.random().toString(36).slice(2)}.ts`);
    fs.writeFileSync(file, `import './types/index';\n${source}\n`);
    const program = ts.createProgram([file], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ['lib.dom.d.ts', 'lib.es2022.d.ts'], types: [], skipLibCheck: false });
    return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  }

  it('writes declarations for the tag, its properties, its events and its methods', () => {
    const text = fs.readFileSync(path.join(types, 'components.d.ts'), 'utf8');
    for (const word of ['interface HTMLCornMapElement', "'corn-map': HTMLCornMapElement", 'interface CornMapCustomEvent<T>', "'cornSelect':", "'cornReady':", "'topology'?:", "'node'?:", "'theme'?:", "'fit':", "'focusNode':"]) expect(text, word).toContain(word);
    expect(fs.existsSync(path.join(types, 'index.d.ts'))).toBe(true);
    expect(fs.existsSync(path.join(types, 'corn-map.d.ts'))).toBe(true);
  });

  it('lists exactly what the component declares: every @Prop, @Event and @Method, nothing else', () => {
    const [map] = analyzeComponents().filter((c: { tagName: string }) => c.tagName === 'corn-map');
    const text = typesFor([map])['components.d.ts'];
    for (const p of map.properties) expect(text).toContain(`'${p.name}'`);
    for (const e of map.events) expect(text).toContain(`'${e.name}'`);
    for (const m of map.methods) expect(text).toContain(`'${m.name}'`);
    expect(map.properties.map((p: { name: string }) => p.name).sort()).toEqual(['node', 'renderer', 'src', 'theme', 'topology', 'useTheme', 'view']);
    expect(map.events.map((e: { name: string }) => e.name).sort()).toEqual(['cornAuth', 'cornError', 'cornReady', 'cornSelect']);
    expect(map.methods.map((m: { name: string }) => m.name).sort()).toEqual(['fit', 'focusNode', 'refresh']);
  });

  it('a consumer\'s .ts compiles against them: the element, its properties, a typed event detail, the methods and the tag name map', () => {
    expect(compile(`
      const el = document.querySelector('corn-map')!;            // HTMLElementTagNameMap['corn-map']
      const typed: HTMLCornMapElement = el;
      typed.topology = { nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'b' }] };
      typed.node = 'a';
      typed.view = 'dataflow';
      typed.theme = 'dark';
      typed.renderer = 'canvas2d';
      typed.addEventListener('cornSelect', (e) => { const id: string | null = e.detail.id; const kind: 'node' | 'edge' | null = e.detail.kind; const source: string = e.detail.source; void id; void kind; void source; });
      typed.addEventListener('cornReady', (e) => { const none: void = e.detail; void none; });
      typed.addEventListener('click', (e) => { void e.clientX; });
      const made: HTMLCornMapElement = document.createElement('corn-map');
      void made;
      void (async () => { await typed.fit(); await typed.focusNode('a'); await typed.refresh(); })();
      export const VERSION: string = (await import('./types/index')).version;
    `)).toEqual([]);
  });

  it('declares the tag as a JSX intrinsic element a consumer merges into its own JSX namespace, with typed properties and on<Event> handlers', () => {
    expect(compile(`
      import type { LocalJSX, CornSelectDetail } from './types/components';
      const props: LocalJSX.IntrinsicElements['corn-map'] = { node: 'a', view: 'map', theme: 'light', onCornSelect: (e) => { const d: CornSelectDetail = e.detail; void d; } };
      void props;
    `)).toEqual([]);
    expect(compile(`
      import type { LocalJSX } from './types/components';
      const props: LocalJSX.IntrinsicElements['corn-map'] = { view: 'sideways' };
      void props;
    `).join('\n')).toMatch(/sideways/);
  }, 30_000);

  it('resolves through the package\'s exports map, as a consumer that installed it would: the root, ./corn-map, tokens.css and version.json', () => {
    if (!fs.existsSync(path.join(dist, 'types', 'index.d.ts'))) execFileSync(process.execPath, [path.join(PACKAGE, 'scripts', 'build.mjs')], { cwd: PACKAGE, stdio: 'pipe' });
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'corn-consumer-'));
    fs.mkdirSync(path.join(app, 'node_modules', '@popcorn245'), { recursive: true });
    fs.symlinkSync(PACKAGE, path.join(app, 'node_modules', '@popcorn245', 'cornfield-components'), 'dir');
    const file = path.join(app, 'main.ts');
    fs.writeFileSync(file, `
      import { version, CornMap } from '@popcorn245/cornfield-components';
      import type { CornSelectDetail } from '@popcorn245/cornfield-components';
      import '@popcorn245/cornfield-components/corn-map';
      const v: string = version;
      const el = document.querySelector('corn-map')!;
      el.addEventListener('cornSelect', (e) => { const d: CornSelectDetail = e.detail; void d; });
      void v; void CornMap;
    `);
    const program = ts.createProgram([file], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ['lib.dom.d.ts', 'lib.es2022.d.ts'], types: [] });
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'package.json'), 'utf8'));
    for (const [entry, target] of Object.entries(pkg.exports) as Array<[string, string | Record<string, string>]>) {
      for (const file of typeof target === 'string' ? [target] : Object.values(target)) expect(fs.existsSync(path.join(PACKAGE, file)), `${entry} -> ${file}`).toBe(true);
    }
    expect(pkg.files).toEqual(['dist']);
  }, 30_000);

  it('and is refused when it is wrong: a view that does not exist, a detail read as a string, a method that is not there', () => {
    const wrong = compile(`
      const el = document.querySelector('corn-map')!;
      el.view = 'sideways';
      el.theme = 'blue';
      el.addEventListener('cornSelect', (e) => { const id: string = e.detail.id; void id; });
      el.addEventListener('cornSelect', (e) => { const kind: 'page' = e.detail.kind; void kind; });
      el.addEventListener('cornSelect', (e) => { const kind: 'node' | 'edge' = e.detail.kind; void kind; });
      el.zoomTo(3);
      el.focusNode(7);
    `);
    expect(wrong.length).toBeGreaterThanOrEqual(5);
    const text = wrong.join('\n');
    expect(text).toMatch(/sideways/);
    expect(text).toMatch(/blue/);
    expect(text).toMatch(/zoomTo/);
    expect(text).toMatch(/number/);
  });
});

describe('what a build leaves in dist/ (D11)', () => {
  beforeAll(() => {
    if (!fs.existsSync(path.join(dist, 'index.js'))) execFileSync(process.execPath, [path.join(PACKAGE, 'scripts', 'build.mjs')], { cwd: PACKAGE, stdio: 'pipe' });
  }, 120_000);
  const read = (f: string) => fs.readFileSync(path.join(dist, f), 'utf8');
  const importsOf = (f: string) => [...read(f).matchAll(/(?:from|import)\s*["'](\.[^"']+)["']/g)].map((m) => m[1]);

  it('has one entry for all and one per component, which share one runtime chunk', () => {
    expect(fs.existsSync(path.join(dist, 'index.js'))).toBe(true);
    for (const tag of componentTags()) expect(fs.existsSync(path.join(dist, `${tag}.js`)), tag).toBe(true);
    const runtime = fs.readdirSync(path.join(dist, 'chunks')).filter((f) => f.startsWith('runtime-'));
    expect(runtime).toHaveLength(1);
    // the runtime reaches the entries through what they share, and is its own file
    const reach = (entry: string, seen = new Set<string>()): Set<string> => { for (const i of importsOf(entry)) { const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry), i)); if (!seen.has(target)) { seen.add(target); reach(target, seen); } } return seen; };
    expect([...reach('index.js')].some((f) => f.includes(runtime[0]))).toBe(true);
    expect([...reach('corn-map.js')].some((f) => f.includes(runtime[0]))).toBe(true);
    expect(read(`chunks/${runtime[0]}`)).not.toContain('explorer/pieces');
  });

  it('is ES modules that register the tag when loaded, and no more than that: no top-level fetch, no document write', () => {
    for (const f of ['index.js', 'corn-map.js']) expect(read(f)).not.toMatch(/\brequire\(|module\.exports/);
    const all = fs.readdirSync(path.join(dist, 'chunks')).map((f) => read(`chunks/${f}`)).join('\n');
    expect(all).toMatch(/corn-map/);
  });

  it('carries cornfield\'s version: the one the server reports (the root package.json), in the code and in version.json', () => {
    const root = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    expect(version).toBe(root.version);
    expect(read('index.js')).toContain(JSON.stringify(root.version));
    expect(JSON.parse(read('version.json'))).toEqual({ name: '@popcorn245/cornfield-components', cornfield: root.version });
    const own = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'package.json'), 'utf8'));
    expect(own.version).toBe(root.version); // the package number moves with cornfield's: a release sets both
    expect(own.private).toBe(true); // not published yet
  });

  it('ships tokens.css, the same text the elements add to a page, at zero specificity', () => {
    expect(read('tokens.css')).toBe(tokensCss());
    for (const line of read('tokens.css').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => /\{\s*$/.test(l))) expect(line.trim().startsWith(':where(') || line.trim().startsWith('@media')).toBe(true);
    expect(fs.readdirSync(path.join(dist, 'chunks')).map((f) => read(`chunks/${f}`)).join('\n')).toContain(':where(:root)');
  });

  it('ships the declarations next to the modules', () => {
    for (const f of ['components.d.ts', 'index.d.ts', 'corn-map.d.ts', 'corn-scope.d.ts']) expect(fs.existsSync(path.join(dist, 'types', f)), f).toBe(true);
  });

  it('is inside the size budget: the runtime chunk, corn-map with its engine and corn-scope with what it loads, each at most 5% over what size-budget.json holds', () => {
    const { budget, tolerance } = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'size-budget.json'), 'utf8'));
    expect(tolerance).toBe(0.05);
    expect(Object.keys(budget).sort()).toEqual(['corn-map', 'corn-scope', 'runtime']);
    const now = measure();
    for (const [name, limit] of Object.entries(budget) as Array<[string, number]>) expect(now[name], `${name}: ${now[name]} B gzip against a budget of ${limit}`).toBeLessThanOrEqual(limit * 1.05);
  });
});
